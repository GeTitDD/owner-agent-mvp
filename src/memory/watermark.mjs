// 「上次看到哪」的水位存储：每个项目记一个时间点，落本地 SQLite，重启后仍在。
//
// 为什么单独一张表：ADR-0008 的后果一节把「每项目的水位」列为新的持久化需求。它是界面状态，
// 不是审计记录，所以不塞进 observer_events，也不复用 owner_projects 的 updated_at——
// 后者说的是登记信息变了，不是人看过。一张新表 + CREATE TABLE IF NOT EXISTS 就是老库的
// 升级路径：旧库第一次打开只多一张空表，已有行一行不动，不需要手工迁移脚本。
//
// 这里只负责「读/写一个时间点」。哪些提交、事件算新，全部由 change-window.mjs 判断，
// 存储层不重复第二套比较逻辑；推进时机（先算差异、后推水位）由 since-last-seen.mjs 保证。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { defaultDbPath } from '../storage.mjs';

/** 表名写一份：迁移、测试与最终报告都指它。 */
export const WATERMARK_TABLE = 'memory_watermarks';

// 与 observer 库一致的项目 id 上限；越界直接拒绝，不在库里留下脏行。
const MAX_PROJECT_ID = 90;

const projectIdOf = (value) => {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id) throw new Error('缺少项目 id');
  if (id.length > MAX_PROJECT_ID) throw new Error('项目 id 过长');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(id)) throw new Error('项目 id 含控制字符');
  return id;
};

/**
 * 时间归一化成 UTC ISO。Date、毫秒数、ISO 串都认；解析不了抛错。
 * 不把 0 或空串当默认值：那会把全部历史算成「上次看过」。
 */
const atOf = (value) => {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) throw new Error('Invalid watermark time');
    return value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value.trim());
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  throw new Error('Invalid watermark time');
};

const rowOf = (row) => (row ? {
  projectId: row.project_id,
  at: row.last_seen_at,
  ms: Date.parse(row.last_seen_at),
  updatedAt: row.updated_at
} : null);

export class MemoryWatermarkStore {
  /**
   * @param {{db?:object, dbPath?:string}} [options]
   *   db：复用已打开的 DatabaseSync（桌面端与 OwnerStore 共用一条连接，少开一个句柄）；
   *   dbPath：需要独立连接时给路径（测试用临时库）。
   *   两者都省略时用默认库（DOMAIN_CONTEXT_DB 或 ~/.domain-context/index.sqlite）。
   */
  constructor({ db = null, dbPath = '' } = {}) {
    this.ownsDb = !db;
    this.dbPath = db ? '' : String(dbPath || defaultDbPath());
    if (this.ownsDb && this.dbPath !== ':memory:') {
      mkdirSync(path.dirname(this.dbPath), { recursive: true, mode: 0o700 });
    }
    this.db = db ?? new DatabaseSync(this.dbPath);
    // 老库升级就这一句：表不存在就建，表已存在什么都不做。
    // busy_timeout 与 OwnerStore 一致：验收脚本/诊断会另开连接只读，不能一撞锁就报错。
    this.db.exec(`PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS ${WATERMARK_TABLE}(
      project_id TEXT PRIMARY KEY,
      last_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  }

  /**
   * 读某个项目的水位；没有记录返回 null（调用方据此按「首次查看」处理）。
   * @param {string} projectId
   * @returns {{projectId:string, at:string, ms:number, updatedAt:string}|null}
   */
  get(projectId) {
    const id = projectIdOf(projectId);
    return rowOf(this.db.prepare(
      `SELECT project_id,last_seen_at,updated_at FROM ${WATERMARK_TABLE} WHERE project_id=?`
    ).get(id));
  }

  /**
   * 写入/覆盖水位。同一事务里没有别的事要做，单条 upsert 本身就原子。
   * @param {string} projectId
   * @param {string|number|Date} [at] 默认当前时间
   * @returns {{projectId:string, at:string, ms:number, updatedAt:string}}
   */
  put(projectId, at = new Date()) {
    const id = projectIdOf(projectId);
    const iso = atOf(at);
    const stamp = new Date().toISOString();
    this.db.prepare(`INSERT INTO ${WATERMARK_TABLE}(project_id,last_seen_at,updated_at)
      VALUES(?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET last_seen_at=excluded.last_seen_at, updated_at=excluded.updated_at`
    ).run(id, iso, stamp);
    return this.get(id);
  }

  /** 全部水位（诊断与测试用），按项目 id 排序，保证同一份库每次读出顺序一致。 */
  list() {
    return this.db.prepare(
      `SELECT project_id,last_seen_at,updated_at FROM ${WATERMARK_TABLE} ORDER BY project_id ASC`
    ).all().map(rowOf);
  }

  /** 只关闭自己开的连接；复用外部 db 时不越权关别人的。 */
  close() {
    if (this.ownsDb) this.db.close();
  }
}
