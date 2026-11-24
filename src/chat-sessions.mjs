// 对话会话的本地持久化。
//
// 目标：让「对话」模式的多条会话留在本地 SQLite 里，重启后还能看到历史。
// 不变量：
// - 会话必须绑定已登记项目：写入前校验 owner_projects，表上另有外键兜底。
// - 只存消息文本与必要元数据（项目、标题、时间、角色、引用、状态），
//   不把聊天记录当项目状态，也不写回 owner_projects。
// - 只新增 owner_chat_sessions / owner_chat_messages 两张表，
//   老库通过 CREATE TABLE IF NOT EXISTS 平滑升级，不改旧表语义。
// - 删除会话只删自己与消息，项目数据不受影响。
import { randomUUID } from 'node:crypto';

/** 会话标题上限：面板一行能放下，也能从首个问题自动截取。 */
export const CHAT_TITLE_MAX = 60;
/** 没有标题也没有首个问题时的占位标题；首个问题到来时会被自动替换。 */
export const DEFAULT_CHAT_TITLE = '新会话';
/** 单条消息上限：回答本身限制 8000，这里留出引用提醒的余量。 */
export const CHAT_MESSAGE_MAX = 16000;
/** 一轮提问带给模型的上下文条数；只用于理解，不代替历史落库。 */
export const CHAT_HISTORY_LIMIT = 8;
/** 一次读取会话消息的上限，避免异常大的会话把渲染进程拖慢。 */
const MESSAGE_PAGE = 500;

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
function normalizeMessageText(value) {
  const text = String(value ?? '').trim();
  if (!text) fail('消息不能为空');
  if (text.length > CHAT_MESSAGE_MAX) fail(`消息最多 ${CHAT_MESSAGE_MAX} 字`);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(text)) fail('消息含有非法字符');
  return text;
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
    projectId: row.project_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: Number(row.message_count ?? 0)
  }
  : null;

const messageRow = (row) => ({
  seq: row.seq,
  sessionId: row.session_id,
  role: row.role,
  text: row.text,
  status: row.status,
  citations: safeParse(row.citations),
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
    // 只新增表；旧库升级不需要额外步骤。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS owner_chat_sessions(
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES owner_projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS owner_chat_sessions_project
        ON owner_chat_sessions(project_id,updated_at DESC);
      CREATE TABLE IF NOT EXISTS owner_chat_messages(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES owner_chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ok' CHECK(status IN ('ok','error')),
        citations TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS owner_chat_messages_session
        ON owner_chat_messages(session_id,seq);
    `);
  }

  /** 项目必须已登记：这是「新建会话绑定项目」的唯一入口校验。 */
  assertProject(projectId) {
    const id = String(projectId ?? '').trim();
    if (!id) fail('新建会话必须选择一个项目');
    const row = this.db.prepare('SELECT id,name FROM owner_projects WHERE id=?').get(id);
    if (!row) fail(`项目不存在：${id}`, 404);
    return row;
  }

  createSession({ projectId, title = '', sessionId = '' } = {}) {
    const project = this.assertProject(projectId);
    const id = String(sessionId ?? '').trim() || `chat_${randomUUID()}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/u.test(id)) fail('会话 ID 不合法');
    const now = this.now();
    const name = normalizeChatTitle(title, { fallback: DEFAULT_CHAT_TITLE });
    try {
      this.db.prepare(
        'INSERT INTO owner_chat_sessions(id,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?)'
      ).run(id, project.id, name, now, now);
    } catch (error) {
      if (/UNIQUE constraint/u.test(String(error?.message ?? ''))) fail('会话 ID 已存在', 409);
      throw error;
    }
    return this.getSession(id);
  }

  /** 列表按项目聚合所需的最小字段；排序交给面板按项目分组后处理。 */
  listSessions({ projectId = '' } = {}) {
    const where = projectId ? 'WHERE s.project_id=?' : '';
    const rows = this.db.prepare(`
      SELECT s.*, (SELECT COUNT(*) FROM owner_chat_messages m WHERE m.session_id=s.id) AS message_count
      FROM owner_chat_sessions s
      ${where}
      ORDER BY s.updated_at DESC,s.id
    `).all(...(projectId ? [String(projectId)] : []));
    return rows.map(sessionRow);
  }

  getSession(id, { limit = MESSAGE_PAGE } = {}) {
    const key = String(id ?? '').trim();
    if (!key) fail('缺少会话 ID');
    const row = this.db.prepare(`
      SELECT s.*, (SELECT COUNT(*) FROM owner_chat_messages m WHERE m.session_id=s.id) AS message_count
      FROM owner_chat_sessions s WHERE s.id=?
    `).get(key);
    if (!row) fail('会话不存在', 404);
    const safeLimit = Math.min(Math.max(1, Number(limit) || MESSAGE_PAGE), MESSAGE_PAGE);
    const messages = this.db.prepare(
      'SELECT * FROM owner_chat_messages WHERE session_id=? ORDER BY seq ASC LIMIT ?'
    ).all(key, safeLimit).map(messageRow);
    return { ...sessionRow(row), messages };
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

  /** 删除会话：先删消息再删会话，即使外键未开启也不会留下孤儿消息。 */
  deleteSession(id) {
    const key = String(id ?? '').trim();
    if (!key) fail('缺少会话 ID');
    const exists = this.db.prepare('SELECT id FROM owner_chat_sessions WHERE id=?').get(key);
    if (!exists) fail('会话不存在', 404);
    this.db.prepare('DELETE FROM owner_chat_messages WHERE session_id=?').run(key);
    this.db.prepare('DELETE FROM owner_chat_sessions WHERE id=?').run(key);
    return { id: key, deleted: true };
  }

  /**
   * 追加一条消息。首个用户问题会自动把默认标题换成问题摘要，
   * 这样「自动命名 + 可重命名」不需要额外的命名步骤。
   */
  appendMessage({ sessionId, role, text, status = 'ok', citations = [] } = {}) {
    const key = String(sessionId ?? '').trim();
    if (!key) fail('缺少会话 ID');
    if (role !== 'user' && role !== 'assistant') fail('消息角色不合法');
    if (status !== 'ok' && status !== 'error') fail('消息状态不合法');
    const body = normalizeMessageText(text);
    const session = this.db.prepare('SELECT * FROM owner_chat_sessions WHERE id=?').get(key);
    if (!session) fail('会话不存在', 404);
    const now = this.now();
    const result = this.db.prepare(`
      INSERT INTO owner_chat_messages(session_id,role,text,status,citations,created_at)
      VALUES(?,?,?,?,?,?)
    `).run(key, role, body, status, JSON.stringify(normalizeCitations(citations)), now);
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
      createdAt: now,
      title
    };
  }

  /**
   * 给模型的续聊上下文：只取最近几轮成功消息，逐条截断。
   * 失败的助手消息不进入上下文，避免把错误提示当成事实。
   */
  historyForPrompt(sessionId, { limit = CHAT_HISTORY_LIMIT } = {}) {
    const key = String(sessionId ?? '').trim();
    if (!key) return [];
    const safeLimit = Math.min(Math.max(1, Number(limit) || CHAT_HISTORY_LIMIT), 30);
    const rows = this.db.prepare(`
      SELECT role,text,status FROM owner_chat_messages
      WHERE session_id=? AND (role='user' OR status='ok')
      ORDER BY seq DESC LIMIT ?
    `).all(key, safeLimit);
    return rows.reverse().map((row) => ({
      role: row.role,
      text: String(row.text ?? '').slice(0, 600)
    }));
  }
}
