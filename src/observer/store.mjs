// 观察事件的审计存储。
//
// 审计只生不灭：事件与投递记录都写在这里，观察台与冷却逻辑只读这里（ADR-0002）。
// 三类事件（停滞 / 漂移 / 积压）共用一张表；指纹唯一索引保证同一事件重复写入不会产生新行。
// 投递记录同时是冷却的唯一依据（lastSentAt）：同一指纹 24 小时内不再通知（#28）。
//
// #30 增加每日聚合：observer_digests 按「项目 + 本地日历日」唯一，observer_digest_items
// 记录聚合包含哪些事件，observer_digest_attempts 逐次记录投递尝试与失败原因。
// 聚合状态落库而不是留在进程内，因此重启后既不重复发、也不丢待发；claimDigest 用一次
// 条件 UPDATE 抢占租约，避免两个进程同时把同一条聚合发出去。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultDbPath } from '../storage.mjs';
import { digestFingerprint } from './digest.mjs';

const EVENT_TYPES = new Set(['stale', 'drift', 'backlog']);
const DELIVERY_STATUSES = new Set(['sent', 'failed', 'skipped']);
const DIGEST_STATUSES = new Set(['pending', 'sending', 'sent', 'failed', 'merged']);
const DIGEST_ATTEMPT_STATUSES = new Set(['sent', 'failed', 'skipped']);

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
// 允许调用方直接传 Date；统一落成 UTC ISO，便于按字符串比较租约时间。
const atIso = (value, label) => (value instanceof Date ? value.toISOString() : iso(value, label));
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
const digestRow = (row) => row && {
  id: row.id,
  projectId: row.project_id,
  day: row.day,
  fingerprint: row.fingerprint,
  status: row.status,
  detail: row.detail,
  items: row.items,
  attempts: row.attempts,
  leaseUntil: row.lease_until ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  sentAt: row.sent_at ?? null
};
const digestAttemptRow = (row) => row && {
  seq: row.seq,
  digestId: row.digest_id,
  attempt: row.attempt,
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
      CREATE TABLE IF NOT EXISTS observer_digests(
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        day TEXT NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','merged')),
        detail TEXT NOT NULL DEFAULT '',
        items INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_until TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT,
        UNIQUE(project_id,day)
      );
      CREATE INDEX IF NOT EXISTS observer_digests_day ON observer_digests(day,status);
      CREATE TABLE IF NOT EXISTS observer_digest_items(
        digest_id TEXT NOT NULL REFERENCES observer_digests(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL REFERENCES observer_events(id) ON DELETE CASCADE,
        added_at TEXT NOT NULL,
        PRIMARY KEY(digest_id,event_id)
      );
      CREATE INDEX IF NOT EXISTS observer_digest_items_event ON observer_digest_items(event_id);
      CREATE TABLE IF NOT EXISTS observer_digest_attempts(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        digest_id TEXT NOT NULL REFERENCES observer_digests(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('sent','failed','skipped')),
        detail TEXT NOT NULL DEFAULT '',
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS observer_digest_attempts_digest ON observer_digest_attempts(digest_id,seq);
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

  // ── 每日聚合（#30）───────────────────────────────────────────────────────────

  /**
   * 取「项目 + 本地日历日」的聚合；不存在就以 pending 新建。
   * (project_id, day) 唯一，重复调用返回同一行，天然幂等。
   * @param {{projectId:string, day:string, fingerprint:string, now?:Date|string}} options
   * @returns {object} digestRow
   */
  ensureDigest({ projectId, day, fingerprint, now = new Date() } = {}) {
    const pid = text(projectId, 'project id', 90);
    const d = text(day, 'digest day', 10);
    check(/^\d{4}-\d{2}-\d{2}$/.test(d), 'Invalid digest day');
    const fp = text(fingerprint, 'fingerprint', 64);
    check(/^[0-9a-f]{64}$/.test(fp), 'Invalid fingerprint');
    const at = atIso(now, 'digest time');
    this.db.prepare(`INSERT OR IGNORE INTO observer_digests(
      id,project_id,day,fingerprint,status,created_at,updated_at
    ) VALUES(?,?,?,?,'pending',?,?)`).run(randomUUID(), pid, d, fp, at, at);
    return digestRow(this.db.prepare('SELECT * FROM observer_digests WHERE project_id=? AND day=?').get(pid, d));
  }

  getDigest(id) {
    return digestRow(this.db.prepare('SELECT * FROM observer_digests WHERE id=?').get(String(id)));
  }

  /**
   * 把事件挂到聚合上；同一事件重复挂载不新增行（PK 去重）。
   * 事件必须属于该聚合的项目，避免跨项目串内容。
   * @returns {{digest:object, added:number}}
   */
  addDigestEvents({ digestId, eventIds = [], now = new Date() } = {}) {
    const digest = this.getDigest(digestId);
    check(!!digest, 'Unknown observer digest');
    check(Array.isArray(eventIds) && eventIds.length <= 500, 'Invalid digest events');
    const at = atIso(now, 'digest time');
    const insert = this.db.prepare('INSERT OR IGNORE INTO observer_digest_items(digest_id,event_id,added_at) VALUES(?,?,?)');
    let added = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const eventId of eventIds) {
        const event = this.getEvent(eventId);
        check(!!event, 'Unknown observer event');
        check(event.projectId === digest.projectId, 'Digest event belongs to a different project');
        added += Number(insert.run(digest.id, event.id, at).changes);
      }
      this.db.prepare(`UPDATE observer_digests
        SET items=(SELECT COUNT(*) FROM observer_digest_items WHERE digest_id=?), updated_at=?
        WHERE id=?`).run(digest.id, at, digest.id);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* 回滚失败时保留原始异常 */ }
      throw error;
    }
    return { digest: this.getDigest(digest.id), added };
  }

  /** 聚合内的事件，按发生时间倒序；内容在投递时现读，避免消息与审计不一致。 */
  listDigestEvents(digestId) {
    const rows = this.db.prepare(`SELECT e.* FROM observer_digest_items i
      JOIN observer_events e ON e.id=i.event_id
      WHERE i.digest_id=? ORDER BY e.detected_at DESC,e.id DESC`).all(String(digestId));
    return rows.map(eventRow);
  }

  listDigests({ projectId = '', day = '', status = '', limit = 50 } = {}) {
    check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 500, 'Invalid limit');
    const clauses = [];
    const params = [];
    if (projectId) { clauses.push('project_id=?'); params.push(text(projectId, 'project id', 90)); }
    if (day) {
      const d = text(day, 'digest day', 10);
      check(/^\d{4}-\d{2}-\d{2}$/.test(d), 'Invalid digest day');
      clauses.push('day=?');
      params.push(d);
    }
    if (status) {
      check(DIGEST_STATUSES.has(status), 'Invalid digest status');
      clauses.push('status=?');
      params.push(status);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit);
    return this.db.prepare(`SELECT * FROM observer_digests${where} ORDER BY day DESC,created_at DESC LIMIT ?`)
      .all(...params).map(digestRow);
  }

  /** 该投递日及更早、仍待发的聚合；停机跨天后靠这一步补发，不丢失。 */
  listDueDigests({ day = '', limit = 200 } = {}) {
    check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 500, 'Invalid limit');
    const d = text(day, 'digest day', 10);
    check(/^\d{4}-\d{2}-\d{2}$/.test(d), 'Invalid digest day');
    return this.db.prepare(`SELECT * FROM observer_digests
      WHERE day<=? AND status IN ('pending','sending')
      ORDER BY day ASC,created_at ASC LIMIT ?`).all(d, limit).map(digestRow);
  }

  /**
   * 把待发聚合顺延到新的投递日（夜间静默、进程停机都走这里）。
   * 目标日仍有待发聚合力就并入它；旧行标记 merged 保留事件链接，审计不丢内容。
   * 目标日已经 sent / failed 时不并入（否则内容会被静默吞掉），旧聚合留到下一个投递日。
   * @returns {object[]} 本次实际顺延的记录
   */
  rollPendingDigests({ toDay, now = new Date() } = {}) {
    const d = text(toDay, 'digest day', 10);
    check(/^\d{4}-\d{2}-\d{2}$/.test(d), 'Invalid digest day');
    const at = atIso(now, 'digest time');
    const stale = this.db.prepare(`SELECT * FROM observer_digests
      WHERE day<? AND status='pending' ORDER BY day ASC,created_at ASC`).all(d).map(digestRow);
    const rolled = [];
    for (const digest of stale) {
      // 目标日用自己的指纹：旧行指纹绑定旧日期，不能顺手带过去。
      const target = this.ensureDigest({
        projectId: digest.projectId,
        day: d,
        fingerprint: digestFingerprint({ projectId: digest.projectId, day: d }),
        now: at
      });
      // 目标日已经发过（或当日终态失败）就不再并进去：并进 sent 行等于静默丢弃内容。
      // 旧聚合保持 pending，明天再顺延合并，宁可晚一天也不丢。
      if (target.status === 'sent' || target.status === 'failed') continue;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare(`INSERT OR IGNORE INTO observer_digest_items(digest_id,event_id,added_at)
          SELECT ?,event_id,? FROM observer_digest_items WHERE digest_id=?`).run(target.id, at, digest.id);
        this.db.prepare(`UPDATE observer_digests
          SET items=(SELECT COUNT(*) FROM observer_digest_items WHERE digest_id=?), updated_at=?
          WHERE id=?`).run(target.id, at, target.id);
        this.db.prepare(`UPDATE observer_digests
          SET status='merged', detail=?, lease_until=NULL, updated_at=? WHERE id=?`)
          .run(optionalText(`merged into ${target.id}`, 'digest detail', 1000), at, digest.id);
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* 回滚失败时保留原始异常 */ }
        throw error;
      }
      rolled.push({ digestId: digest.id, day: digest.day, targetDigestId: target.id });
    }
    return rolled;
  }

  /**
   * 抢占一条聚合的投递租约：一次条件 UPDATE，两个进程只有一个能拿到。
   * 租约过期（进程崩溃）后可以被下一次扫描重新抢占。
   * @returns {boolean} 是否抢到
   */
  claimDigest({ id, now = new Date(), leaseMs = 120_000 } = {}) {
    check(Number.isSafeInteger(leaseMs) && leaseMs >= 1_000 && leaseMs <= 3_600_000, 'Invalid lease duration');
    const at = atIso(now, 'digest time');
    const leaseUntil = new Date(Date.parse(at) + leaseMs).toISOString();
    const result = this.db.prepare(`UPDATE observer_digests
      SET status='sending', lease_until=?, updated_at=?
      WHERE id=? AND (status='pending' OR (status='sending' AND (lease_until IS NULL OR lease_until<=?)))`)
      .run(leaseUntil, at, String(id), at);
    return Number(result.changes) === 1;
  }

  /** 逐次记录投递尝试；失败原因必须留痕（#30）。 */
  recordDigestAttempt({ digestId, attempt, status, detail = '', at = new Date().toISOString() } = {}) {
    const digest = this.getDigest(digestId);
    check(!!digest, 'Unknown observer digest');
    check(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= 10, 'Invalid digest attempt');
    check(DIGEST_ATTEMPT_STATUSES.has(status), 'Invalid digest attempt status');
    const when = atIso(at, 'digest attempt time');
    const result = this.db.prepare(`INSERT INTO observer_digest_attempts(digest_id,attempt,status,detail,at)
      VALUES(?,?,?,?,?)`).run(digest.id, attempt, status,
      optionalText(detail, 'digest attempt detail', 1000), when);
    this.db.prepare(`UPDATE observer_digests
      SET attempts=(SELECT COUNT(*) FROM observer_digest_attempts WHERE digest_id=?), updated_at=?
      WHERE id=?`).run(digest.id, when, digest.id);
    return { seq: Number(result.lastInsertRowid) };
  }

  /**
   * 结束一次投递：sent / failed / pending（未配置 webhook 时退回待发）。
   * failed 是当日终态，不会被下一次扫描重复重试；原因写在 detail 里。
   */
  finishDigest({ id, status, detail = '', now = new Date() } = {}) {
    check(status === 'sent' || status === 'failed' || status === 'pending', 'Invalid digest outcome');
    const digest = this.getDigest(id);
    check(!!digest, 'Unknown observer digest');
    const at = atIso(now, 'digest time');
    this.db.prepare(`UPDATE observer_digests
      SET status=?, detail=?, lease_until=NULL, updated_at=?, sent_at=?
      WHERE id=?`).run(status, optionalText(detail, 'digest detail', 1000), at,
      status === 'sent' ? at : digest.sentAt, digest.id);
    return this.getDigest(digest.id);
  }

  listDigestAttempts({ digestId, limit = 50 } = {}) {
    check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 500, 'Invalid limit');
    return this.db.prepare('SELECT * FROM observer_digest_attempts WHERE digest_id=? ORDER BY seq ASC LIMIT ?')
      .all(String(digestId), limit).map(digestAttemptRow);
  }
}
