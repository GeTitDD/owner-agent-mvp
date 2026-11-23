// 观察事件的审计存储。
//
// 审计只生不灭：事件与投递记录都写在这里，观察台与冷却逻辑只读这里（ADR-0002）。
// 三类事件（停滞 / 漂移 / 积压）共用一张表；指纹唯一索引保证同一事件重复写入不会产生新行。
// 投递记录同时是冷却的唯一依据（lastSentAt）：同一指纹 24 小时内不再通知（#28）。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultDbPath } from '../storage.mjs';

const EVENT_TYPES = new Set(['stale', 'drift', 'backlog']);
const DELIVERY_STATUSES = new Set(['sent', 'failed', 'skipped']);

const check = (ok, message) => { if (!ok) throw new Error(message); };
const text = (value, label, max = 500) => {
  check(typeof value === 'string' && value.length > 0 && value.length <= max, `Invalid ${label}`);
  check(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value), `Invalid ${label}`);
  return value;
};
const optionalText = (value, label, max = 500) => {
  if (value === null || value === undefined || value === '') return '';
  return text(String(value), label, max);
};
const iso = (value, label) => {
  check(typeof value === 'string' && Number.isFinite(Date.parse(value)), `Invalid ${label}`);
  return value;
};
const eventRow = (row) => row && {
  id: row.id,
  fingerprint: row.fingerprint,
  type: row.type,
  projectId: row.project_id,
  projectName: row.project_name,
  branch: row.branch ?? null,
  branchLabel: row.branch_label,
  head: row.last_commit_sha,
  lastCommitAt: row.last_commit_at ?? null,
  daysStale: row.days_stale,
  trunkRef: row.trunk_ref ?? null,
  behindTrunk: row.behind_trunk ?? 0,
  uncommittedFiles: row.uncommitted_files ?? 0,
  detectedAt: row.detected_at
};
const deliveryRow = (row) => row && {
  seq: row.seq,
  eventId: row.event_id,
  fingerprint: row.fingerprint,
  channel: row.channel,
  status: row.status,
  detail: row.detail,
  at: row.at
};

export class ObserverStore {
  constructor(dbPath = defaultDbPath()) {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS observer_events(
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project_name TEXT NOT NULL DEFAULT '',
        branch TEXT,
        branch_label TEXT NOT NULL,
        last_commit_sha TEXT NOT NULL DEFAULT '',
        last_commit_at TEXT,
        days_stale INTEGER NOT NULL DEFAULT 0,
        trunk_ref TEXT,
        behind_trunk INTEGER NOT NULL DEFAULT 0,
        uncommitted_files INTEGER NOT NULL DEFAULT 0,
        detected_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS observer_events_project ON observer_events(project_id,detected_at DESC);
      CREATE TABLE IF NOT EXISTS observer_deliveries(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL REFERENCES observer_events(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL,
        channel TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('sent','failed','skipped')),
        detail TEXT NOT NULL DEFAULT '',
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS observer_deliveries_event ON observer_deliveries(event_id,seq);
      CREATE INDEX IF NOT EXISTS observer_deliveries_fingerprint ON observer_deliveries(fingerprint,seq DESC);
    `);
    // #27 建的库没有漂移 / 积压列，就地补列，避免要求手工迁移。
    const columns = this.db.prepare('PRAGMA table_info(observer_events)').all().map((item) => item.name);
    const added = [
      ['trunk_ref', 'TEXT'],
      ['behind_trunk', 'INTEGER NOT NULL DEFAULT 0'],
      ['uncommitted_files', 'INTEGER NOT NULL DEFAULT 0']
    ];
    for (const [column, ddl] of added) {
      if (!columns.includes(column)) this.db.exec(`ALTER TABLE observer_events ADD COLUMN ${column} ${ddl}`);
    }
  }

  close() { this.db.close(); }

  /**
   * 写入一条观察事件。指纹唯一：同一事件重复写入返回已有行，不新增。
   * @param {object} event detectStaleEvent 的输出
   * @returns {{id:string, duplicate:boolean}}
   */
  recordEvent(event = {}) {
    const fingerprint = text(event.fingerprint, 'fingerprint', 64);
    check(/^[0-9a-f]{64}$/.test(fingerprint), 'Invalid fingerprint');
    check(EVENT_TYPES.has(event.type), 'Invalid event type');
    const projectId = text(event.projectId, 'project id', 90);
    const projectName = optionalText(event.projectName, 'project name', 200);
    const branch = event.branch === null || event.branch === undefined ? null : text(event.branch, 'branch', 300);
    const branchLabel = text(event.branchLabel ?? branch ?? '', 'branch label', 300);
    const head = optionalText(event.head, 'head', 64);
    const lastCommitAt = event.lastCommitAt === null || event.lastCommitAt === undefined
      ? null : iso(event.lastCommitAt, 'last commit time');
    const daysStale = Number.isSafeInteger(event.daysStale) && event.daysStale >= 0 ? event.daysStale : 0;
    const trunkRef = optionalText(event.trunkRef, 'trunk ref', 300) || null;
    const behindTrunk = Number.isSafeInteger(event.behindTrunk) && event.behindTrunk >= 0 ? event.behindTrunk : 0;
    const uncommittedFiles = Number.isSafeInteger(event.uncommittedFiles) && event.uncommittedFiles >= 0
      ? event.uncommittedFiles : 0;
    const detectedAt = iso(event.detectedAt, 'detected time');

    const existing = this.db.prepare('SELECT id FROM observer_events WHERE fingerprint=?').get(fingerprint);
    if (existing) return { id: existing.id, duplicate: true };

    const id = randomUUID();
    this.db.prepare(`INSERT INTO observer_events(
      id,fingerprint,type,project_id,project_name,branch,branch_label,
      last_commit_sha,last_commit_at,days_stale,trunk_ref,behind_trunk,uncommitted_files,detected_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, fingerprint, event.type, projectId, projectName, branch, branchLabel,
      head, lastCommitAt, daysStale, trunkRef, behindTrunk, uncommittedFiles, detectedAt
    );
    return { id, duplicate: false };
  }

  getEvent(id) {
    return eventRow(this.db.prepare('SELECT * FROM observer_events WHERE id=?').get(String(id)));
  }

  getEventByFingerprint(fingerprint) {
    return eventRow(this.db.prepare('SELECT * FROM observer_events WHERE fingerprint=?').get(String(fingerprint)));
  }

  listEvents({ projectId = '', limit = 50 } = {}) {
    check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 500, 'Invalid limit');
    const rows = projectId
      ? this.db.prepare('SELECT * FROM observer_events WHERE project_id=? ORDER BY detected_at DESC,id DESC LIMIT ?').all(projectId, limit)
      : this.db.prepare('SELECT * FROM observer_events ORDER BY detected_at DESC,id DESC LIMIT ?').all(limit);
    return rows.map(eventRow);
  }

  /**
   * 记录一次投递尝试。sent / failed / skipped 都必须留痕，失败不抛给调用方。
   * @returns {{seq:number}}
   */
  recordDelivery({ eventId, fingerprint, channel = 'feishu', status, detail = '', at = new Date().toISOString() } = {}) {
    const id = text(eventId, 'event id', 90);
    const event = this.getEvent(id);
    check(!!event, 'Unknown observer event');
    const fp = text(fingerprint, 'fingerprint', 64);
    check(/^[0-9a-f]{64}$/.test(fp), 'Invalid fingerprint');
    check(event.fingerprint === fp, 'Fingerprint does not match event');
    check(DELIVERY_STATUSES.has(status), 'Invalid delivery status');
    const result = this.db.prepare(`INSERT INTO observer_deliveries(event_id,fingerprint,channel,status,detail,at)
      VALUES(?,?,?,?,?,?)`).run(id, fp, text(channel, 'channel', 40), status,
      optionalText(detail, 'detail', 1000), iso(at, 'delivery time'));
    return { seq: Number(result.lastInsertRowid) };
  }

  /**
   * 某指纹在指定渠道上最后一次成功投递的时间；没有成功投递时返回 null。
   * 冷却判断只读这一个值，因此进程重启后状态自动恢复（ADR-0002：状态在审计库）。
   * 按 seq 倒序而不是按 at：seq 是插入顺序，不受时间字符串时区写法影响。
   * @param {{fingerprint:string, channel?:string}} options
   * @returns {string|null} ISO 时间
   */
  lastSentAt({ fingerprint, channel = 'feishu' } = {}) {
    const fp = text(fingerprint, 'fingerprint', 64);
    check(/^[0-9a-f]{64}$/.test(fp), 'Invalid fingerprint');
    const row = this.db.prepare(`SELECT at FROM observer_deliveries
      WHERE fingerprint=? AND channel=? AND status='sent' ORDER BY seq DESC LIMIT 1`)
      .get(fp, text(channel, 'channel', 40));
    return row?.at ?? null;
  }

  listDeliveries({ eventId = '', fingerprint = '', limit = 50 } = {}) {
    check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 500, 'Invalid limit');
    const rows = eventId
      ? this.db.prepare('SELECT * FROM observer_deliveries WHERE event_id=? ORDER BY seq ASC LIMIT ?').all(eventId, limit)
      : fingerprint
        ? this.db.prepare('SELECT * FROM observer_deliveries WHERE fingerprint=? ORDER BY seq ASC LIMIT ?').all(fingerprint, limit)
        : this.db.prepare('SELECT * FROM observer_deliveries ORDER BY seq ASC LIMIT ?').all(limit);
    return rows.map(deliveryRow);
  }
}
