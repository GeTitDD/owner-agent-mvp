// 对话会话的本地持久化。
//
// 目标：让「对话」模式的多条会话留在本地 SQLite 里，重启后还能看到历史。
// 不变量：
// - 会话绑定的项目必须已登记：写入前校验 owner_projects，表上另有外键兜底。
// - 会话可以不绑项目（#106 的全局会话）：project_id 可空，空即「还没绑项目」。
// - 只存消息文本与必要元数据（项目、标题、时间、角色、引用、状态、置顶、删除时间、
//   正在看的项目），不把聊天记录当项目状态，也不写回 owner_projects。
// - 会话、消息与按范围隔离的草稿各存一张自有表，
//   老库通过 CREATE TABLE IF NOT EXISTS + 列迁移平滑升级，不改旧表语义。
// - 删除会话只动自己与消息，项目数据不受影响；#106 的软删除只写 deleted_at，
//   记录与消息都留着，按 id 能找回。
import { randomUUID } from 'node:crypto';

/** 会话标题上限：面板一行能放下，也能从首个问题自动截取。 */
export const CHAT_TITLE_MAX = 60;
/** 没有标题也没有首个问题时的占位标题；首个问题到来时会被自动替换。 */
export const DEFAULT_CHAT_TITLE = '新会话';
/** 单条消息上限：回答本身限制 8000，这里留出引用提醒的余量。 */
export const CHAT_MESSAGE_MAX = 16000;
/** 单条消息的块数据上限：十二种块的全量样本约 4KB，留足余量。 */
const CHAT_BLOCKS_MAX = 64 * 1024;
/** 一轮提问带给模型的上下文条数；只用于理解，不代替历史落库。 */
export const CHAT_HISTORY_LIMIT = 8;
/** 一次读取会话消息的上限，避免异常大的会话把渲染进程拖慢。 */
const MESSAGE_PAGE = 500;

/**
 * 会话表的两套形状：#106 之前 project_id 是 NOT NULL（会话必须绑项目），
 * #106 起允许全局会话，所以要放宽成可空。SQLite 改不了列的 NOT NULL，
 * 只能重建表——和 owner-store 里 #94 队列迁移同一套写法：按列名搬运，一行不丢。
 */
const SESSION_COLUMNS = [
  'id', 'project_id', 'title', 'created_at', 'updated_at',
  'pinned', 'deleted_at', 'last_opened_at', 'view_project_id'
];
// view_project_id：正在看的项目（#107）。空串即全局；与 project_id（会话绑定 / 历史归属）
// 分开存，两者不一致时会话打「跨项目」标。不加外键：项目删掉后视图退回全局，
// 不该反过来把会话一起级联删掉。
const SESSION_TABLE_DDL = `(
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES owner_projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  last_opened_at TEXT,
  view_project_id TEXT NOT NULL DEFAULT ''
)`;

export class ChatSessionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ChatSessionError';
    this.status = status;
  }
}

const fail = (message, status = 400) => {
  throw new ChatSessionError(message, status);
};

/** 标题：压掉换行，截断到固定长度；空串交给调用方决定默认值。 */
export function normalizeChatTitle(value, { fallback = '' } = {}) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, CHAT_TITLE_MAX);
  if (text) return text;
  return fallback;
}

/** 从首个问题自动命名：只取第一句，过长截断并加省略号。 */
export function titleFromQuestion(question) {
  const text = String(question ?? '').replace(/\s+/gu, ' ').trim();
  if (!text) return DEFAULT_CHAT_TITLE;
  if (text.length <= 24) return text;
  return `${text.slice(0, 24)}…`;
}

/** 消息文本校验：保留换行与制表符，拒绝 NUL 等控制字符。 */
function normalizeMessageText(value, { allowEmpty = false } = {}) {
  const text = String(value ?? '').trim();
  if (!text && !allowEmpty) fail('消息不能为空');
  if (text.length > CHAT_MESSAGE_MAX) fail(`消息最多 ${CHAT_MESSAGE_MAX} 字`);
  if (text && /[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(text)) fail('消息含有非法字符');
  return text;
}

/**
 * 块原样落库：存储层不解释块结构（归一化在 shell-blocks.cjs），
 * 只保证是对象数组并且不会把库撑爆。#109 的十二种块都在这个上限之内。
 */
function normalizeBlocks(value) {
  if (!Array.isArray(value)) return [];
  const blocks = value.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
  const json = JSON.stringify(blocks);
  if (json.length > CHAT_BLOCKS_MAX) fail(`块数据过大（上限 ${CHAT_BLOCKS_MAX} 字节）`);
  return blocks;
}

/** 引用只存路径与行号，避免把模型输出的任意结构写进库。 */
function normalizeCitations(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value.slice(0, 20)) {
    const path = String(item?.path ?? '').trim().slice(0, 500);
    if (!path) continue;
    const line = Number.isInteger(item?.line) && item.line > 0 ? item.line : 0;
    out.push({ path, line });
  }
  return out;
}

const sessionRow = (row) => row
  ? {
    id: row.id,
    projectId: row.project_id ?? '',
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // 置顶与删除：界面只看这两个布尔/时间，不再自己拼 SQL 判定。
    pinned: Number(row.pinned ?? 0) === 1,
    deletedAt: row.deleted_at ?? '',
    // 最近打开时间：#106 用它记住「当前选的是哪条」，重启后回到同一条。
    lastOpenedAt: row.last_opened_at ?? '',
    // #107：正在看的项目（空 = 全局）。它是视图状态，和会话绑定的 projectId 分开；
    // 两者不一致时界面打「跨项目」标。
    viewProjectId: row.view_project_id ?? '',
    messageCount: Number(row.message_count ?? 0),
    // 轮数 = 我问过几句；助手回复条数与它成对出现，但没回复时轮数也要能数对。
    turnCount: Number(row.turn_count ?? 0)
  }
  : null;

const messageRow = (row) => ({
  seq: Number(row.seq),
  sessionId: row.session_id,
  role: row.role,
  text: row.text,
  status: row.status,
  citations: safeParse(row.citations),
  // #109 的块与提问回答：原样存取，存储层不解释块的结构。
  blocks: safeParse(row.blocks),
  answers: safeParseObject(row.answers),
  createdAt: row.created_at
});

const safeParse = (value) => {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const safeParseObject = (value) => {
  try {
    const parsed = JSON.parse(String(value ?? '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

/**
 * 会话存储：复用 OwnerStore 已打开的 SQLite 连接，保持单一数据源。
 * 测试可传临时库连接，不联网、不调用模型。
 */
export class ChatSessionStore {
  constructor({ db, now = () => new Date().toISOString() } = {}) {
    if (!db || typeof db.prepare !== 'function') {
      fail('ChatSessionStore 需要一个已打开的 SQLite 连接', 500);
    }
    this.db = db;
    this.now = now;
    // 只新增表；旧库升级在下面按列补齐。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS owner_chat_sessions ${SESSION_TABLE_DDL};
      CREATE INDEX IF NOT EXISTS owner_chat_sessions_project
        ON owner_chat_sessions(project_id,updated_at DESC);
      CREATE TABLE IF NOT EXISTS owner_chat_messages(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES owner_chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ok' CHECK(status IN ('ok','error')),
        citations TEXT NOT NULL DEFAULT '[]',
        blocks TEXT NOT NULL DEFAULT '[]',
        answers TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS owner_chat_messages_session
        ON owner_chat_messages(session_id,seq);
    `);
    this.migrateSessionColumns();
    // 范围属于草稿键的一部分：同一会话跨项目时，也不把上一项目的未发送内容带过去。
    this.db.exec(`CREATE TABLE IF NOT EXISTS owner_review_drafts(
      session_id TEXT NOT NULL REFERENCES owner_chat_sessions(id) ON DELETE CASCADE,
      card_key TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(session_id,card_key)
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS owner_chat_drafts(
      session_id TEXT NOT NULL REFERENCES owner_chat_sessions(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      skill_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(session_id,project_id)
    )`);
  }

  /**
   * 老库升级（可重复执行）：
   * 1) project_id 还是 NOT NULL 的库要重建表放宽约束，否则 #106 的全局会话写不进去；
   * 2) 缺 pinned / deleted_at 的库直接补列。补列不丢行，重建按列名搬运。
   */
  migrateSessionColumns() {
    let columns = this.db.prepare('PRAGMA table_info(owner_chat_sessions)').all();
    if (columns.find((column) => column.name === 'project_id')?.notnull === 1) {
      const oldNames = new Set(columns.map((column) => column.name));
      const copyColumns = SESSION_COLUMNS.filter((name) => oldNames.has(name)).join(',');
      // 重建期间关外键：消息表按表名引用会话表，改名后自动指向新表。
      this.db.exec('PRAGMA foreign_keys=OFF');
      try {
        this.db.exec(`BEGIN IMMEDIATE;
          DROP TABLE IF EXISTS owner_chat_sessions_upgrade;
          CREATE TABLE owner_chat_sessions_upgrade ${SESSION_TABLE_DDL};
          INSERT INTO owner_chat_sessions_upgrade(${copyColumns})
            SELECT ${copyColumns} FROM owner_chat_sessions;
          DROP TABLE owner_chat_sessions;
          ALTER TABLE owner_chat_sessions_upgrade RENAME TO owner_chat_sessions;
          CREATE INDEX IF NOT EXISTS owner_chat_sessions_project
            ON owner_chat_sessions(project_id,updated_at DESC);
          COMMIT;`);
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* 回滚失败时保留原始错误 */ }
        throw error;
      } finally {
        this.db.exec('PRAGMA foreign_keys=ON');
      }
      columns = this.db.prepare('PRAGMA table_info(owner_chat_sessions)').all();
    }
    const names = new Set(columns.map((column) => column.name));
    if (!names.has('pinned')) {
      this.db.exec('ALTER TABLE owner_chat_sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
    }
    if (!names.has('deleted_at')) {
      this.db.exec('ALTER TABLE owner_chat_sessions ADD COLUMN deleted_at TEXT');
    }
    if (!names.has('last_opened_at')) {
      this.db.exec('ALTER TABLE owner_chat_sessions ADD COLUMN last_opened_at TEXT');
    }
    // #107：正在看的项目。旧记录按空串补，读出来就是全局；绑定项目仍在 project_id 上。
    if (!names.has('view_project_id')) {
      this.db.exec(`ALTER TABLE owner_chat_sessions ADD COLUMN view_project_id TEXT NOT NULL DEFAULT ''`);
    }
    // #109 的块与提问回答也落在消息行上：切会话/重启后，带块的回复还是原样。
    const messageColumns = new Set(
      this.db.prepare('PRAGMA table_info(owner_chat_messages)').all().map((column) => column.name)
    );
    if (!messageColumns.has('blocks')) {
      this.db.exec(`ALTER TABLE owner_chat_messages ADD COLUMN blocks TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!messageColumns.has('answers')) {
      this.db.exec(`ALTER TABLE owner_chat_messages ADD COLUMN answers TEXT NOT NULL DEFAULT '{}'`);
    }
  }

  /** 项目必须已登记：这是「会话绑定项目」的唯一入口校验（不绑项目时调用方不传）。 */
  assertProject(projectId) {
    const id = String(projectId ?? '').trim();
    if (!id) fail('新建会话必须选择一个项目');
    const row = this.db.prepare('SELECT id,name FROM owner_projects WHERE id=?').get(id);
    if (!row) fail(`项目不存在：${id}`, 404);
    return row;
  }

  /** 新建会话：projectId 留空即全局会话（#106），传了就必须是已登记项目。 */
  createSession({ projectId = '', title = '', sessionId = '', reuseEmptyGlobalId = '' } = {}) {
    const wanted = String(projectId ?? '').trim();
    const project = wanted ? this.assertProject(wanted) : null;
    // 首次选项目复用自动准备的空会话；存在输入、消息、置顶或自定义标题时保留原会话。
    if (project && reuseEmptyGlobalId) {
      const reused = this.db.prepare(`UPDATE owner_chat_sessions SET project_id=?,view_project_id=?
        WHERE id=? AND project_id IS NULL AND title=? AND pinned=0 AND deleted_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM owner_chat_messages WHERE session_id=owner_chat_sessions.id)
        AND NOT EXISTS(SELECT 1 FROM owner_chat_drafts WHERE session_id=owner_chat_sessions.id
          AND (text<>'' OR skill_id<>''))`).run(project.id, project.id, String(reuseEmptyGlobalId), DEFAULT_CHAT_TITLE);
      if (reused.changes) return this.getSession(String(reuseEmptyGlobalId));
    }
    const id = String(sessionId ?? '').trim() || `chat_${randomUUID()}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/u.test(id)) fail('会话 ID 不合法');
    const now = this.now();
    const name = normalizeChatTitle(title, { fallback: DEFAULT_CHAT_TITLE });
    try {
      this.db.prepare(
        `INSERT INTO owner_chat_sessions(id,project_id,title,created_at,updated_at,view_project_id)
         VALUES(?,?,?,?,?,?)`
      ).run(id, project ? project.id : null, name, now, now, project ? project.id : '');
    } catch (error) {
      if (/UNIQUE constraint/u.test(String(error?.message ?? ''))) fail('会话 ID 已存在', 409);
      throw error;
    }
    return this.getSession(id);
  }

  /**
   * 列表：默认只给未删除的会话，置顶在前、其余按最近更新排。
   * 面板按项目分组、卡片壳按搜索过滤，都在这一份结果上做，不各自查库。
   */
  listSessions({ projectId = '', includeDeleted = false } = {}) {
    const clauses = [];
    const params = [];
    if (!includeDeleted) clauses.push('s.deleted_at IS NULL');
    if (projectId) {
      clauses.push('s.project_id=?');
      params.push(String(projectId));
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM owner_chat_messages m WHERE m.session_id=s.id) AS message_count,
        (SELECT COUNT(*) FROM owner_chat_messages m WHERE m.session_id=s.id AND m.role='user') AS turn_count
      FROM owner_chat_sessions s
      ${where}
      ORDER BY s.pinned DESC,s.updated_at DESC,s.id
    `).all(...params);
    return rows.map(sessionRow);
  }

  getSession(id, { limit = MESSAGE_PAGE, beforeSeq = 0 } = {}) {
    const key = String(id ?? '').trim();
    if (!key) fail('缺少会话 ID');
    const row = this.db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM owner_chat_messages m WHERE m.session_id=s.id) AS message_count,
        (SELECT COUNT(*) FROM owner_chat_messages m WHERE m.session_id=s.id AND m.role='user') AS turn_count
      FROM owner_chat_sessions s WHERE s.id=?
    `).get(key);
    if (!row) fail('会话不存在', 404);
    const cursor = Number(beforeSeq);
    if (!Number.isSafeInteger(cursor) || cursor < 0) fail('历史消息游标无效');
    const safeLimit = Math.floor(Math.min(Math.max(1, Number(limit) || MESSAGE_PAGE), MESSAGE_PAGE));
    // 从最新一批向前读，多取一条判断是否仍有历史；展示仍按正序，游标不受新增消息影响。
    const messages = this.db.prepare(
      `SELECT * FROM owner_chat_messages WHERE session_id=? ${cursor ? 'AND seq<?' : ''} ORDER BY seq DESC LIMIT ?`
    ).all(key, ...(cursor ? [cursor] : []), safeLimit + 1);
    const hasMore = messages.length > safeLimit;
    if (hasMore) messages.pop();
    messages.reverse();
    return { ...sessionRow(row), messages: messages.map(messageRow),
      page: { hasMore, nextBeforeSeq: messages[0]?.seq ?? null } };
  }

  /** 原问题以会话和序号定位，不依赖界面当前加载到哪一页。 */
  getMessage(id, seq) {
    const key = this.draftSession(id).id;
    if (!Number.isSafeInteger(seq) || seq < 1) fail('消息序号无效');
    const row = this.db.prepare('SELECT * FROM owner_chat_messages WHERE session_id=? AND seq=?').get(key, seq);
    return row ? messageRow(row) : null;
  }

  /** 显式导出与同步读完整正文；单次 SELECT 保证不会把并发追加混入不同页。 */
  getTranscript(id) {
    const session = this.getSession(id, { limit: 1 });
    const messages = this.db.prepare('SELECT * FROM owner_chat_messages WHERE session_id=? ORDER BY seq ASC')
      .all(session.id).map(messageRow);
    const { page, ...detail } = session;
    return { ...detail, messages };
  }

  /** 草稿保留原始空白，不作为消息、进度或最近活动排序依据。 */
  draftSession(id) {
    const key = String(id ?? '').trim();
    if (!key) fail('缺少会话 ID');
    // 每次输入只需验证归属，不读取并解析整段聊天历史。
    const row = this.db.prepare('SELECT id,deleted_at FROM owner_chat_sessions WHERE id=?').get(key);
    if (!row) fail('会话不存在', 404);
    return row;
  }

  // 审阅草稿按会话、候选身份与展示版本隔离，SQLite 同步提交保证退出后也能恢复。
  reviewDraft({id,key,values,clear=false}={}) {
    const session=this.draftSession(id);
    if(session.deleted_at && (values!==undefined||clear))fail('会话已删除，请先找回',409);
    if(typeof key!=='string'||!/^(?:idea|candidate):[A-Za-z0-9._-]{1,90}:[a-f0-9]{64}$/u.test(key))fail('审阅草稿身份无效');
    if(clear){this.db.prepare('DELETE FROM owner_review_drafts WHERE session_id=? AND card_key=?').run(session.id,key);return {cleared:true};}
    if(values!==undefined){
      if(!values||typeof values!=='object'||Array.isArray(values))fail('审阅草稿必须是字段对象');
      const allowed=new Set(['phenomenon','mechanism','countermeasure','content','title','scope','domains','applicability','exceptions']);
      for(const [name,value]of Object.entries(values))if(!allowed.has(name)||typeof value!=='string'||value.length>20000||/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value))fail('审阅草稿字段无效或过长');
      const json=JSON.stringify(values);if(json.length>50000)fail('审阅草稿过长，未截断保存');
      this.db.prepare('INSERT INTO owner_review_drafts(session_id,card_key,payload) VALUES(?,?,?) ON CONFLICT(session_id,card_key) DO UPDATE SET payload=excluded.payload').run(session.id,key,json);
    }
    const row=this.db.prepare('SELECT payload FROM owner_review_drafts WHERE session_id=? AND card_key=?').get(session.id,key);
    return {values:row?JSON.parse(row.payload):null};
  }

  getDraft({ id, projectId = '' } = {}) {
    const session = this.draftSession(id);
    const project = String(projectId ?? '').trim();
    if (project) this.assertProject(project);
    const row = this.db.prepare(
      'SELECT text,skill_id FROM owner_chat_drafts WHERE session_id=? AND project_id=?'
    ).get(session.id, project);
    return { text: row?.text ?? '', skillId: row?.skill_id ?? '' };
  }

  saveDraft({ id, projectId = '', text = '', skillId = '' } = {}) {
    const session = this.draftSession(id);
    if (session.deleted_at) fail('会话已删除，请先找回', 409);
    const project = String(projectId ?? '').trim();
    if (project) this.assertProject(project);
    const body = String(text ?? '');
    if (body.length > CHAT_MESSAGE_MAX) fail(`草稿最多 ${CHAT_MESSAGE_MAX} 字`);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(body)) fail('草稿含有非法字符');
    const skill = String(skillId ?? '');
    if (skill.length > 300 || /[\x00-\x1f]/u.test(skill)) fail('草稿技能不合法');
    this.db.prepare(`INSERT INTO owner_chat_drafts(session_id,project_id,text,skill_id)
      VALUES(?,?,?,?) ON CONFLICT(session_id,project_id)
      DO UPDATE SET text=excluded.text,skill_id=excluded.skill_id`).run(session.id, project, body, skill);
    return { text: body, skillId: skill };
  }

  /** 发送完成只移除当时发送的版本；等待期间新写的草稿不能被迟到回执清空。 */
  clearDraft({ id, projectId = '', text = '', skillId = '' } = {}) {
    const changed = this.db.prepare(`DELETE FROM owner_chat_drafts
      WHERE session_id=? AND project_id=? AND text=? AND skill_id=?`)
      .run(String(id), String(projectId), String(text), String(skillId));
    return { cleared: Number(changed.changes) > 0 };
  }

  renameSession(id, title) {
    const key = String(id ?? '').trim();
    if (!key) fail('缺少会话 ID');
    const name = normalizeChatTitle(title);
    if (!name) fail('标题不能为空');
    const changed = this.db.prepare(
      'UPDATE owner_chat_sessions SET title=?,updated_at=? WHERE id=?'
    ).run(name, this.now(), key);
    if (!changed.changes) fail('会话不存在', 404);
    return this.getSession(key);
  }

  /**
   * 硬删除：先删消息再删会话，即使外键未开启也不会留下孤儿消息。
   * 卡片壳不用它——#106 的删除是软删除（见 softDeleteSession）。
   */
  deleteSession(id) {
    const key = String(id ?? '').trim();
    if (!key) fail('缺少会话 ID');
    const exists = this.db.prepare('SELECT id FROM owner_chat_sessions WHERE id=?').get(key);
    if (!exists) fail('会话不存在', 404);
    this.db.prepare('DELETE FROM owner_chat_messages WHERE session_id=?').run(key);
    this.db.prepare('DELETE FROM owner_chat_drafts WHERE session_id=?').run(key);
    this.db.prepare('DELETE FROM owner_review_drafts WHERE session_id=?').run(key);
    this.db.prepare('DELETE FROM owner_chat_sessions WHERE id=?').run(key);
    return { id: key, deleted: true };
  }

  /**
   * 软删除：只写 deleted_at，会话与消息都留着。
   * 列表默认看不到它（listSessions），用 includeDeleted 或按 id getSession 都能找回。
   * 不动 updated_at：找回后还按原来的时间排队，不会因为删过一次就跳到最后。
   */
  softDeleteSession(id) {
    const key = String(id ?? '').trim();
    if (!key) fail('缺少会话 ID');
    const exists = this.db.prepare('SELECT id,deleted_at FROM owner_chat_sessions WHERE id=?').get(key);
    if (!exists) fail('会话不存在', 404);
    if (exists.deleted_at) return { id: key, deleted: true, soft: true, deletedAt: exists.deleted_at };
    const at = this.now();
    this.db.prepare('UPDATE owner_chat_sessions SET deleted_at=? WHERE id=?').run(at, key);
    return { id: key, deleted: true, soft: true, deletedAt: at };
  }

  /** 找回：清掉 deleted_at；没被删过就原样返回，不报错。 */
  restoreSession(id) {
    const key = String(id ?? '').trim();
    if (!key) fail('缺少会话 ID');
    const exists = this.db.prepare('SELECT id,deleted_at FROM owner_chat_sessions WHERE id=?').get(key);
    if (!exists) fail('会话不存在', 404);
    if (exists.deleted_at) {
      this.db.prepare('UPDATE owner_chat_sessions SET deleted_at=NULL WHERE id=?').run(key);
    }
    return this.getSession(key);
  }

  /** 置顶：只改 pinned，不动 updated_at——置顶是排队规则，不是「刚聊过」。 */
  setPinned(id, pinned) {
    const key = String(id ?? '').trim();
    if (!key) fail('缺少会话 ID');
    const changed = this.db.prepare(
      'UPDATE owner_chat_sessions SET pinned=? WHERE id=?'
    ).run(pinned ? 1 : 0, key);
    if (!changed.changes) fail('会话不存在', 404);
    return this.getSession(key);
  }

  /**
   * 记「刚打开过这条」：当前选择是视图状态，但重启后要回到同一条，
   * 所以落在库里的 last_opened_at 上，而不是渲染进程里一份可能丢的副本。
   * 不动 updated_at：切换会话不该改变列表排队。
   */
  markOpened(id) {
    const key = String(id ?? '').trim();
    if (!key) fail('缺少会话 ID');
    const at = this.now();
    const changed = this.db.prepare(
      'UPDATE owner_chat_sessions SET last_opened_at=? WHERE id=?'
    ).run(at, key);
    if (!changed.changes) fail('会话不存在', 404);
    return { id: key, lastOpenedAt: at };
  }

  /**
   * 改「正在看的项目」（#107）：空串 = 全局。
   * 只动视图状态，不动 project_id（历史归属）与 updated_at（不重排列表）；
   * 目标项目必须已登记，和新建会话同一条校验，不做「找不到就退回全局」的静默兜底。
   */
  setViewProject(id, projectId = '') {
    const key = String(id ?? '').trim();
    if (!key) fail('缺少会话 ID');
    const wanted = String(projectId ?? '').trim();
    const project = wanted ? this.assertProject(wanted) : null;
    const changed = this.db.prepare(
      'UPDATE owner_chat_sessions SET view_project_id=? WHERE id=?'
    ).run(project ? project.id : '', key);
    if (!changed.changes) fail('会话不存在', 404);
    return this.getSession(key);
  }

  /**
   * 追加一条消息。首个用户问题会自动把默认标题换成问题摘要，
   * 这样「自动命名 + 可重命名」不需要额外的命名步骤。
   *
   * #109 起回复可以带块：块原样存成 JSON（存储层不解释块结构），
   * 所以「只有块、没有文字」的回复也合法；两样都没有才拒绝。
   */
  appendMessage({ sessionId, role, text, status = 'ok', citations = [], blocks = [] } = {}) {
    const key = String(sessionId ?? '').trim();
    if (!key) fail('缺少会话 ID');
    if (role !== 'user' && role !== 'assistant') fail('消息角色不合法');
    if (status !== 'ok' && status !== 'error') fail('消息状态不合法');
    const blockList = normalizeBlocks(blocks);
    const body = normalizeMessageText(text, { allowEmpty: blockList.length > 0 });
    const session = this.db.prepare('SELECT * FROM owner_chat_sessions WHERE id=?').get(key);
    if (!session) fail('会话不存在', 404);
    // 软删除的会话是只读的：要接着聊先找回，避免「删了还能写」的半截状态。
    if (session.deleted_at) fail('会话已删除，请先找回', 409);
    const now = this.now();
    const result = this.db.prepare(`
      INSERT INTO owner_chat_messages(session_id,role,text,status,citations,blocks,created_at)
      VALUES(?,?,?,?,?,?,?)
    `).run(key, role, body, status, JSON.stringify(normalizeCitations(citations)), JSON.stringify(blockList), now);
    let title = session.title;
    if (role === 'user' && (!title.trim() || title === DEFAULT_CHAT_TITLE)) {
      const firstUser = this.db.prepare(
        `SELECT COUNT(*) AS n FROM owner_chat_messages WHERE session_id=? AND role='user' AND seq<>?`
      ).get(key, result.lastInsertRowid).n;
      if (!firstUser) {
        title = titleFromQuestion(body);
        this.db.prepare('UPDATE owner_chat_sessions SET title=? WHERE id=?').run(title, key);
      }
    }
    this.db.prepare('UPDATE owner_chat_sessions SET updated_at=? WHERE id=?').run(now, key);
    return {
      seq: Number(result.lastInsertRowid),
      sessionId: key,
      role,
      text: body,
      status,
      citations: normalizeCitations(citations),
      blocks: blockList,
      answers: {},
      createdAt: now,
      title
    };
  }

  /**
   * 撤回最后一条用户消息及其之后的回复（一问一答）。
   * 返回被删掉的那条用户消息，界面把它放回输入框；没有用户消息就返回 null。
   * 只动本机会话表，不碰项目库与知识。
   */
  removeLastTurn({ sessionId } = {}) {
    const key = String(sessionId ?? '').trim();
    if (!key) fail('缺少会话 ID');
    const lastUser = this.db.prepare(
      "SELECT seq, text FROM owner_chat_messages WHERE session_id=? AND role='user' ORDER BY seq DESC LIMIT 1"
    ).get(key);
    if (!lastUser) return null;
    this.db.prepare('DELETE FROM owner_chat_messages WHERE session_id=? AND seq>=?')
      .run(key, lastUser.seq);
    this.db.prepare('UPDATE owner_chat_sessions SET updated_at=? WHERE id=?').run(this.now(), key);
    return { seq: Number(lastUser.seq), text: String(lastUser.text ?? '') };
  }

  /**
   * 记下某个提问块被怎么回答的：只写那一条消息的 answers。
   * 回答本身（我问的一句 + 一条回复）走 appendMessage，两条路径互不混。
   */
  answerMessage({ sessionId, seq, answers } = {}) {
    const key = String(sessionId ?? '').trim();
    if (!key) fail('缺少会话 ID');
    const rowSeq = Number(seq);
    if (!Number.isInteger(rowSeq) || rowSeq <= 0) fail('缺少消息序号');
    const map = answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : null;
    if (!map) fail('回答记录不合法');
    const clean = {};
    for (const [index, label] of Object.entries(map)) {
      if (!/^\d+$/u.test(index)) continue;
      const text = String(label ?? '').trim().slice(0, 200);
      if (text) clean[index] = text;
    }
    const changed = this.db.prepare(
      'UPDATE owner_chat_messages SET answers=? WHERE seq=? AND session_id=?'
    ).run(JSON.stringify(clean), rowSeq, key);
    if (!changed.changes) fail('消息不存在', 404);
    return { seq: rowSeq, sessionId: key, answers: clean };
  }

  /**
   * 给模型的续聊上下文：只取最近几轮成功消息，逐条截断。
   * 失败的助手消息不进入上下文，避免把错误提示当成事实。
   */
  historyForPrompt(sessionId, { limit = CHAT_HISTORY_LIMIT, beforeSeq = 0 } = {}) {
    const key = String(sessionId ?? '').trim();
    if (!key) return [];
    const safeLimit = Math.min(Math.max(1, Number(limit) || CHAT_HISTORY_LIMIT), 30);
    const before = Number.isSafeInteger(beforeSeq) && beforeSeq > 0 ? beforeSeq : 0;
    const rows = this.db.prepare(`
      SELECT role,text,status FROM owner_chat_messages
      WHERE session_id=? AND (role='user' OR status='ok')
        ${before ? 'AND seq < ?' : ''}
      ORDER BY seq DESC LIMIT ?
    `).all(...(before ? [key, before, safeLimit] : [key, safeLimit]));
    return rows.reverse().map((row) => ({
      role: row.role,
      text: String(row.text ?? '').slice(0, 600)
    }));
  }
}
