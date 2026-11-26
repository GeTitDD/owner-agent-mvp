// 监控状态（#117）：水位、变更队列、上次心跳，按监控对象隔离，全部落在自有配置根的 watch/ 下。
// 定时整理的运行记录（#119：计划时刻、实际时刻、是否迟到）也放在同一份库里——状态只有一处。
//
// 为什么不写项目目录：父 spec #102 的硬规矩是「项目目录一个文件都不留」，`git status` 永远干净；
// 心跳阶段因此零写入项目目录，也就不需要确认（ADR-0012：写自有目录默认允许）。
// 也不改 .gitignore、不建隐藏目录——状态只此一处。
//
// 为什么是 SQLite 而不是散落的 JSON：这三样都是「机器要查、要计数、要按对象 join」的状态，
// 按 ADR-0002 归 SQLite 存内容。一条 MySQL 里的水位与这里的 watch 水位不是同一条事实：
// 前者是「人上次打开项目看到哪」（memory/watermark），后者是「上次心跳发现到哪」，
// 两个时刻各自推进，共用一列会互相冒充，所以分开存（ADR-0002：一条事实只存一处）。
//
// 隔离维度是描述符的 ref（见 target.mjs）：每条语句都带 target_key，A 的水位/队列/心跳
// 不会扫到 B。ref 里不含 focus，所以同一个仓库换关注面仍共用一份水位。
//
// 升级路径两条都不需要手工脚本：
// - 目录不存在：mkdir -p，首次打开只多一个空库；
// - 老库缺列：CREATE TABLE IF NOT EXISTS 先兜住缺表，再按 PRAGMA table_info 补列，
//   旧行一行不动（写法沿用 owner-store.mjs 的补列迁移）。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeWatchTarget } from './target.mjs';

/** 状态库文件名：目录里只有它，没有第二类状态文件。 */
export const WATCH_DB_NAME = 'watch.sqlite';

/** 表名写一份：迁移、测试与报告都指它。 */
export const WATCH_TABLES = Object.freeze({
  watermarks: 'watch_watermarks',
  heartbeats: 'watch_heartbeats',
  changes: 'watch_changes',
  tidies: 'watch_tidies'
});

/** 变更条目的三种「发现」动作：只记录那一刻看到了什么，不解释内容（心跳的职责）。 */
export const CHANGE_KINDS = Object.freeze(['added', 'modified', 'deleted']);

/** 队列一次最多读这么多条：整理阶段按批取，界面只看头部。 */
const DEFAULT_QUEUE_LIMIT = 200;
const MAX_REF_LENGTH = 400;
const MAX_NOTE = 500;
const MAX_DETAIL = 4000;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u;

/**
 * 自有配置根下的 watch 目录。默认与其它自有数据同根（~/.owner-agent），
 * 可用 OWNER_AGENT_WATCH_DIR 整体改指（与沙箱、工作区的覆盖变量同名式样）。
 *
 * @param {{env?:object, homeDir?:string}} [options]
 * @returns {string}
 */
export function defaultWatchDir({ env = process.env, homeDir = os.homedir() } = {}) {
  const override = typeof env?.OWNER_AGENT_WATCH_DIR === 'string' ? env.OWNER_AGENT_WATCH_DIR.trim() : '';
  if (override) return path.resolve(override);
  return path.join(homeDir, '.owner-agent', 'watch');
}

/**
 * 时间归一化成 UTC ISO。Date、毫秒数、ISO 串都认；解析不了抛错。
 * 不把空值当默认时间：那会把全部历史算成「看过了」（与 memory/watermark 同一条规矩）。
 */
const toIso = (value, label = 'watch time') => {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) throw new Error(`Invalid ${label}`);
    return value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value.trim());
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  throw new Error(`Invalid ${label}`);
};

const msOf = (iso) => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * 变更条目的 detail：只收「对象」或「装着对象的合法 JSON 字符串」。
 * 数字/布尔/数组这类标量不是一批字段，存进去读回来会变成空对象——那等于悄悄丢数据，
 * 所以在写入时就拒绝，而不是等到整理时才发现。
 */
const detailTextOf = (value) => {
  if (value === undefined || value === null) return '{}';
  if (typeof value !== 'string' && (typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('变更条目的 detail 必须是对象或 JSON 字符串');
  }
  const textValue = typeof value === 'string' ? value : JSON.stringify(value);
  if (textValue.length > MAX_DETAIL) throw new Error(`变更条目的 detail 过长（最多 ${MAX_DETAIL} 字符）`);
  let parsed;
  try {
    parsed = JSON.parse(textValue);
  } catch {
    throw new Error('变更条目的 detail 不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('变更条目的 detail 必须是 JSON 对象');
  }
  return textValue;
};

const detailOf = (textValue) => {
  try {
    const parsed = JSON.parse(textValue);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const refTextOf = (value, field) => {
  const textValue = typeof value === 'string' ? value.trim() : '';
  if (!textValue) throw new Error(`变更条目的 ${field} 不能为空`);
  if (textValue.length > MAX_REF_LENGTH) throw new Error(`变更条目的 ${field} 过长（最多 ${MAX_REF_LENGTH} 字符）`);
  if (CONTROL_CHARS.test(textValue)) throw new Error(`变更条目的 ${field} 含控制字符`);
  return textValue;
};

const kindOf = (value) => {
  const kind = typeof value === 'string' ? value.trim() : '';
  if (!CHANGE_KINDS.includes(kind)) {
    throw new Error(`未知的变更类型：${kind || '(空)'}（只支持 ${CHANGE_KINDS.join(' / ')}）`);
  }
  return kind;
};

const noteOf = (value) => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('心跳附注必须是字符串');
  const note = value.trim();
  if (note.length > MAX_NOTE) throw new Error(`心跳附注过长（最多 ${MAX_NOTE} 字符）`);
  if (CONTROL_CHARS.test(note)) throw new Error('心跳附注含控制字符');
  return note;
};

const limitOf = (value) => (Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_QUEUE_LIMIT);

const watermarkRowOf = (row) => (row ? {
  key: row.target_key,
  type: row.target_type,
  at: row.watermark_at,
  ms: msOf(row.watermark_at),
  updatedAt: row.updated_at
} : null);

const heartbeatRowOf = (row) => (row ? {
  key: row.target_key,
  type: row.target_type,
  at: row.last_at,
  ms: msOf(row.last_at),
  updatedAt: row.updated_at,
  note: row.note ?? ''
} : null);

const tidyRowOf = (row) => (row ? {
  key: row.target_key,
  type: row.target_type,
  // plannedAt 是「本该什么时候跑」，ranAt 是「实际什么时候跑」：两个都留，迟到的判断才可复算。
  plannedAt: row.planned_at ?? '',
  ranAt: row.ran_at,
  ms: msOf(row.ran_at),
  late: Number(row.late) === 1,
  note: row.note ?? '',
  updatedAt: row.updated_at
} : null);

const changeRowOf = (row) => ({
  seq: row.seq,
  key: row.target_key,
  type: row.target_type,
  kind: row.kind,
  ref: row.ref,
  at: row.at,
  ms: msOf(row.at),
  detail: detailOf(row.detail ?? '{}')
});

/**
 * 早期版本可能留下的 watch.sqlite 缺这些列；补列而不是重建，旧行一条不丢。
 * 表本身缺失由上面的 CREATE TABLE IF NOT EXISTS 兜住。
 */
const ADDITIVE_COLUMNS = Object.freeze([
  [WATCH_TABLES.watermarks, 'target_type', "TEXT NOT NULL DEFAULT ''"],
  [WATCH_TABLES.watermarks, 'updated_at', "TEXT NOT NULL DEFAULT ''"],
  [WATCH_TABLES.heartbeats, 'target_type', "TEXT NOT NULL DEFAULT ''"],
  [WATCH_TABLES.heartbeats, 'updated_at', "TEXT NOT NULL DEFAULT ''"],
  [WATCH_TABLES.heartbeats, 'note', "TEXT NOT NULL DEFAULT ''"],
  [WATCH_TABLES.changes, 'target_type', "TEXT NOT NULL DEFAULT ''"],
  [WATCH_TABLES.changes, 'detail', "TEXT NOT NULL DEFAULT '{}'"],
  [WATCH_TABLES.tidies, 'target_type', "TEXT NOT NULL DEFAULT ''"],
  [WATCH_TABLES.tidies, 'planned_at', "TEXT NOT NULL DEFAULT ''"],
  [WATCH_TABLES.tidies, 'ran_at', "TEXT NOT NULL DEFAULT ''"],
  [WATCH_TABLES.tidies, 'late', 'INTEGER NOT NULL DEFAULT 0'],
  [WATCH_TABLES.tidies, 'note', "TEXT NOT NULL DEFAULT ''"],
  [WATCH_TABLES.tidies, 'updated_at', "TEXT NOT NULL DEFAULT ''"]
]);

/** 建表 + 补列。可重复执行：同一份库打开几次结果一样。 */
function ensureSchema(db) {
  // busy_timeout 与 owner 库一致：界面另开连接只读时，撞上写锁不该直接报错。
  db.exec(`PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS ${WATCH_TABLES.watermarks}(
      target_key TEXT PRIMARY KEY,
      target_type TEXT NOT NULL DEFAULT '',
      watermark_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS ${WATCH_TABLES.heartbeats}(
      target_key TEXT PRIMARY KEY,
      target_type TEXT NOT NULL DEFAULT '',
      last_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS ${WATCH_TABLES.changes}(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      target_key TEXT NOT NULL,
      target_type TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      ref TEXT NOT NULL,
      at TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS ${WATCH_TABLES.tidies}(
      target_key TEXT PRIMARY KEY,
      target_type TEXT NOT NULL DEFAULT '',
      planned_at TEXT NOT NULL DEFAULT '',
      ran_at TEXT NOT NULL DEFAULT '',
      late INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS ${WATCH_TABLES.changes}_target ON ${WATCH_TABLES.changes}(target_key,seq)`);
  for (const [table, column, ddl] of ADDITIVE_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((info) => info.name);
    if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

export class WatchStateStore {
  /**
   * @param {{dir?:string, db?:object, env?:object, homeDir?:string}} [options]
   *   dir：watch 目录（测试用临时目录）；省略时用 defaultWatchDir()；
   *   db：复用已打开的 DatabaseSync（桌面端与 OwnerStore 共用连接时少开句柄）；
   *   env/homeDir：只影响默认目录解析，便于测试不碰真实 ~/.owner-agent。
   */
  constructor({ dir = '', db = null, env = process.env, homeDir = os.homedir() } = {}) {
    this.ownsDb = !db;
    this.dir = dir ? path.resolve(String(dir)) : (db ? '' : path.resolve(defaultWatchDir({ env, homeDir })));
    this.dbPath = this.ownsDb ? path.join(this.dir, WATCH_DB_NAME) : '';
    if (this.ownsDb) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.db = db ?? new DatabaseSync(this.dbPath);
    ensureSchema(this.db);
  }

  /** 读某个对象的水位；没有记录返回 null（调用方按「首次心跳」处理，不拿 0 顶替）。 */
  getWatermark(target) {
    const { ref } = normalizeWatchTarget(target);
    return watermarkRowOf(this.db.prepare(
      `SELECT target_key,target_type,watermark_at,updated_at FROM ${WATCH_TABLES.watermarks} WHERE target_key=?`
    ).get(ref));
  }

  /**
   * 写入/覆盖水位。存储层不判断「只能前进」：先算差异再推进由调用方保证（ADR-0008），
   * 在这里再比一次就是第二套比较逻辑。
   *
   * @param {object} target 监控对象描述符
   * @param {string|number|Date} [at] 默认当前时间
   */
  setWatermark(target, at = new Date()) {
    const { ref, type } = normalizeWatchTarget(target);
    const iso = toIso(at);
    const stamp = new Date().toISOString();
    this.db.prepare(`INSERT INTO ${WATCH_TABLES.watermarks}(target_key,target_type,watermark_at,updated_at)
      VALUES(?,?,?,?)
      ON CONFLICT(target_key) DO UPDATE SET
        target_type=excluded.target_type, watermark_at=excluded.watermark_at, updated_at=excluded.updated_at`
    ).run(ref, type, iso, stamp);
    return this.getWatermark(target);
  }

  /** 上次心跳时间；没有记录返回 null。心跳只读水位（父 spec），不改它。 */
  getHeartbeat(target) {
    const { ref } = normalizeWatchTarget(target);
    return heartbeatRowOf(this.db.prepare(
      `SELECT target_key,target_type,last_at,updated_at,note FROM ${WATCH_TABLES.heartbeats} WHERE target_key=?`
    ).get(ref));
  }

  /**
   * 上次定时整理；没有记录返回 null（调用方按「从没整理过」处理）。
   * 计划时刻与实际时刻一起存：判断迟到不该靠事后猜，也让状态卡能说清「本该跑的那次」。
   */
  getTidy(target) {
    const { ref } = normalizeWatchTarget(target);
    return tidyRowOf(this.db.prepare(
      `SELECT target_key,target_type,planned_at,ran_at,late,note,updated_at
        FROM ${WATCH_TABLES.tidies} WHERE target_key=?`
    ).get(ref));
  }

  /**
   * 记一次成功的整理：计划时刻、实际时刻、是否迟到、一句附注。
   * 只在整理成功（候选已提交）之后调用——失败时什么都没写成，下次仍会判定「该跑」，这是可重试的实现方式。
   *
   * @param {object} target 监控对象描述符
   * @param {{plannedAt?:string|number|Date, ranAt?:string|number|Date, late?:boolean, note?:string}} [options]
   */
  markTidy(target, { plannedAt = '', ranAt = new Date(), late = false, note = '' } = {}) {
    const { ref, type } = normalizeWatchTarget(target);
    const planned = plannedAt === '' || plannedAt === undefined || plannedAt === null
      ? ''
      : toIso(plannedAt, '计划整理时间');
    const ran = toIso(ranAt, '实际整理时间');
    const textValue = noteOf(note);
    const stamp = new Date().toISOString();
    this.db.prepare(`INSERT INTO ${WATCH_TABLES.tidies}(target_key,target_type,planned_at,ran_at,late,note,updated_at)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(target_key) DO UPDATE SET
        target_type=excluded.target_type, planned_at=excluded.planned_at, ran_at=excluded.ran_at,
        late=excluded.late, note=excluded.note, updated_at=excluded.updated_at`
    ).run(ref, type, planned, ran, late ? 1 : 0, textValue, stamp);
    return this.getTidy(target);
  }

  /**
   * 记一次心跳时间。note 只放一句人话（例如「读不到仓库」），正文与结论不在这里存。
   *
   * @param {object} target 监控对象描述符
   * @param {{at?:string|number|Date, note?:string}} [options]
   */
  markHeartbeat(target, { at = new Date(), note = '' } = {}) {
    const { ref, type } = normalizeWatchTarget(target);
    const iso = toIso(at);
    const textValue = noteOf(note);
    const stamp = new Date().toISOString();
    this.db.prepare(`INSERT INTO ${WATCH_TABLES.heartbeats}(target_key,target_type,last_at,updated_at,note)
      VALUES(?,?,?,?,?)
      ON CONFLICT(target_key) DO UPDATE SET
        target_type=excluded.target_type, last_at=excluded.last_at,
        updated_at=excluded.updated_at, note=excluded.note`
    ).run(ref, type, iso, stamp, textValue);
    return this.getHeartbeat(target);
  }

  /**
   * 往变更队列尾部追加一条「发现」。只记条目与时间，不解析内容。
   *
   * @param {object} target 监控对象描述符
   * @param {{kind:'added'|'modified'|'deleted', ref:string,
   *   at?:string|number|Date, detail?:object|string}} change
   * @returns {object} 落库后的那一行（带 seq）
   */
  appendChange(target, { kind, ref = '', at = new Date(), detail = null } = {}) {
    const { ref: key, type } = normalizeWatchTarget(target);
    const kindValue = kindOf(kind);
    const refValue = refTextOf(ref, 'ref');
    const iso = toIso(at);
    const result = this.db.prepare(`INSERT INTO ${WATCH_TABLES.changes}(target_key,target_type,kind,ref,at,detail)
      VALUES(?,?,?,?,?,?)`).run(key, type, kindValue, refValue, iso, detailTextOf(detail));
    const row = this.db.prepare(
      `SELECT seq,target_key,target_type,kind,ref,at,detail FROM ${WATCH_TABLES.changes} WHERE seq=?`
    ).get(result.lastInsertRowid);
    return changeRowOf(row);
  }

  /**
   * 批量追加「发现」：先整批校验，再一个事务写完；同一批里重复的、以及队列里已经有的
   * （同 kind + ref + at）都跳过，只留一条。心跳因此可以放心重跑：同一批变化跑两次
   * 只入队一次（#118 的「不重复计数」），不会因为上次推进失败而把队列翻倍。
   *
   * 不做唯一索引：老库里可能已经有重复行，建唯一索引会让升级直接失败；
   * WHERE NOT EXISTS 只在写入时判重，旧行一行不动。
   *
   * @param {object} target 监控对象描述符
   * @param {Array<object>} changes 与 appendChange 同形状的批次
   * @returns {object[]} 这次真正新入队的行（重复的、坏的不在其中）
   */
  appendChanges(target, changes = []) {
    const { ref: key, type } = normalizeWatchTarget(target);
    if (!Array.isArray(changes)) throw new Error('变更批次必须是数组');
    // 整批先校验：一条坏的不该让前面几条悄悄落库，也不该留下半批。
    const prepared = changes.map((change) => {
      const source = change ?? {};
      return {
        kind: kindOf(source.kind),
        ref: refTextOf(source.ref, 'ref'),
        at: toIso(source.at ?? new Date()),
        detail: detailTextOf(source.detail ?? null)
      };
    });
    const insert = this.db.prepare(`INSERT INTO ${WATCH_TABLES.changes}(target_key,target_type,kind,ref,at,detail)
      SELECT ?,?,?,?,?,? WHERE NOT EXISTS (
        SELECT 1 FROM ${WATCH_TABLES.changes}
          WHERE target_key=? AND kind=? AND ref=? AND at=?
      )`);
    const read = this.db.prepare(
      `SELECT seq,target_key,target_type,kind,ref,at,detail FROM ${WATCH_TABLES.changes} WHERE seq=?`
    );
    const appended = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of prepared) {
        const result = insert.run(key, type, row.kind, row.ref, row.at, row.detail, key, row.kind, row.ref, row.at);
        if (Number(result.changes) > 0) appended.push(changeRowOf(read.get(result.lastInsertRowid)));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return appended;
  }

  /**
   * 读某个对象的变更队列：先进先出（按 seq 升序），limit 只截断尾部。
   *
   * @param {object} target 监控对象描述符
   * @param {{limit?:number}} [options]
   */
  listChanges(target, { limit = DEFAULT_QUEUE_LIMIT } = {}) {
    const { ref } = normalizeWatchTarget(target);
    return this.db.prepare(
      `SELECT seq,target_key,target_type,kind,ref,at,detail FROM ${WATCH_TABLES.changes}
        WHERE target_key=? ORDER BY seq ASC LIMIT ?`
    ).all(ref, limitOf(limit)).map(changeRowOf);
  }

  /** 清空某个对象的队列（整理推进水位时用）。只删这个对象的行，返回删了几条。 */
  clearChanges(target) {
    const { ref } = normalizeWatchTarget(target);
    return Number(this.db.prepare(`DELETE FROM ${WATCH_TABLES.changes} WHERE target_key=?`).run(ref).changes);
  }

  /** 一个对象的运行状态：水位、上次心跳、队列长度。界面状态卡与整理阶段都用这一份。 */
  status(target) {
    const { ref, type } = normalizeWatchTarget(target);
    return {
      key: ref,
      type,
      watermark: this.getWatermark(target),
      heartbeat: this.getHeartbeat(target),
      queued: Number(this.db.prepare(
        `SELECT COUNT(*) AS n FROM ${WATCH_TABLES.changes} WHERE target_key=?`
      ).get(ref).n)
    };
  }

  /**
   * 全部对象的状态摘要，按 ref 排序，保证同一份库每次读出顺序一致。
   * 只按库里已有的 key 汇总，不反解 ref 揣测对象类型（那会把键当成描述符）。
   */
  list() {
    const watermarks = new Map(this.db.prepare(
      `SELECT target_key,target_type,watermark_at FROM ${WATCH_TABLES.watermarks}`
    ).all().map((row) => [row.target_key, row]));
    const heartbeats = new Map(this.db.prepare(
      `SELECT target_key,target_type,last_at FROM ${WATCH_TABLES.heartbeats}`
    ).all().map((row) => [row.target_key, row]));
    const queued = new Map(this.db.prepare(
      `SELECT target_key,COUNT(*) AS n,MAX(target_type) AS target_type FROM ${WATCH_TABLES.changes} GROUP BY target_key`
    ).all().map((row) => [row.target_key, row]));

    const keys = [...new Set([...watermarks.keys(), ...heartbeats.keys(), ...queued.keys()])]
      .sort((a, b) => a.localeCompare(b));
    return keys.map((key) => {
      const watermark = watermarks.get(key);
      const heartbeat = heartbeats.get(key);
      return {
        key,
        // 类型只在写入时记下的那一列里，三张表都可能有；取第一个非空的。
        type: watermark?.target_type || heartbeat?.target_type || queued.get(key)?.target_type || '',
        watermarkAt: watermark?.watermark_at ?? null,
        heartbeatAt: heartbeat?.last_at ?? null,
        queued: Number(queued.get(key)?.n ?? 0)
      };
    });
  }

  /** 只关闭自己开的连接；复用外部 db 时不越权关别人的。 */
  close() {
    if (this.ownsDb) this.db.close();
  }
}

