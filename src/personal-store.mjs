import { knowledgeReviewEdits, proposalReviewHash } from './knowledge/experience-review.mjs';
// Personal Knowledge Workbench storage. Editable data lives alongside, but never overwrites,
// the versioned domain package files. Every mutation appends an immutable revision.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { canonical, flatText, requireId, sha256 } from './utils.mjs';
import { CREATABLE_LESSON_STATUSES, LESSON_STATUSES, lessonStatusOf as readLessonStatus } from './lesson-status.mjs';
import {
  DECISION_KIND,
  DECISION_STATUSES,
  DEFAULT_DECISION_STATUS,
  decisionStatusChange,
  isEndedDecisionStatus,
  normalizeDecisionStatus
} from './memory/decision-status.mjs';
import { defaultDbPath } from './storage.mjs';
import { rejectObviousSecrets } from './evolution.mjs';

export class KnowledgeConflict extends Error { constructor(message) { super(message); this.status = 409; } }
export class KnowledgeValidationError extends Error { constructor(message) { super(message); this.status = 400; } }
const valid = (condition, message) => { if (!condition) throw new KnowledgeValidationError(message); };
const own = (obj, name) => Object.prototype.hasOwnProperty.call(obj, name);
const now = () => new Date().toISOString();
// 灵感与任意文字引用只能追溯来源，不能充当独立执行的事实证据。
const executionEvidence = (item) => Boolean(item.recordId && item.ref
  && !/^idea[:_-]/iu.test(item.recordId) && !/^idea:/iu.test(item.ref)
  && ((item.kind === 'record' && item.ref === item.recordId)
    || (['sandbox-run','stdout','stderr','patch','job'].includes(item.kind)
      && /^(?:sandbox|evidence|patch|job):/u.test(item.ref))));
const SCOPES = new Set(['personal','domain','project']);
const LAYERS = new Set(['domain','applied','project']);
const KINDS = new Set(['note','concept','claim','hypothesis','procedure','experiment',DECISION_KIND]);
const VERIFY = new Set(['unverified','verified','needs_reverification','disputed']);
const RELATIONS = new Set(['depends_on','specializes','implements','validated_by','contradicts','related_to']);
const safeText = (text,max,label,required=false) => {
  valid(typeof text === 'string' && text.length <= max && (!required || text.trim()), `${label} must be text of at most ${max} chars`);
  valid(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text), `${label} contains control characters`);
  return text.trim();
};
/**
 * 落库前剥掉状态字段（P0-2）：状态只存 knowledge_lessons.verification_status 一列。
 * 争议的裁决过程（payload.dispute）保留，但「当前状态」不在那里重复一份。
 */
function lessonPayloadBody(lesson) {
  if (!lesson || typeof lesson !== 'object') return {};
  const { verificationStatus: _verification, status: _status, ...rest } = lesson;
  if (rest.dispute && typeof rest.dispute === 'object') {
    const { status: _disputeStatus, ...dispute } = rest.dispute;
    rest.dispute = dispute;
  }
  return rest;
}
function stringArray(value, max, itemMax, label) {
  valid(Array.isArray(value) && value.length <= max, `Invalid ${label}`);
  const output = value.map(item => safeText(item,itemMax,label,true));
  valid(new Set(output).size === output.length, `Duplicate ${label}`);
  return output;
}
/**
 * 落库前剥掉决策状态字段：当前状态只存 personal_units.decision_status 一列。
 * 决策的来源、理由、交接记录仍在 payload.decision 里，那部分是内容不是当前状态。
 */
function unitPayloadBody(item) {
  if (!item || typeof item !== 'object') return {};
  const { decisionStatus: _decisionStatus, ...rest } = item;
  return rest;
}
/**
 * 决策附加信息（payload.decision）：理由、来源、原话、时间与状态变更台账。
 * 理由允许为空，但 reasonMissing 必须显式给出——空串不代表「这条没有理由位」。
 */
function normalizeDecision(decision, { required }) {
  if (decision === null || decision === undefined) {
    valid(!required, '决策必须有理由与来源信息');
    return null;
  }
  valid(typeof decision === 'object' && !Array.isArray(decision), 'Decision info must be an object');
  const text = (value, max, label) => (typeof value === 'string' ? safeText(value, max, label) : '');
  const source = decision.source === null || decision.source === undefined ? null : decision.source;
  if (source !== null) {
    valid(typeof source === 'object' && !Array.isArray(source), 'Invalid decision source');
    safeText(source.kind ?? '', 40, 'decision source kind');
    safeText(source.source ?? '', 40, 'decision source');
    safeText(source.sessionId ?? '', 200, 'decision session id');
    safeText(source.sessionPath ?? '', 500, 'decision session path');
    safeText(source.projectName ?? '', 120, 'decision project name');
  }
  const quote = decision.quote === null || decision.quote === undefined ? null : decision.quote;
  if (quote !== null) {
    valid(typeof quote === 'object' && !Array.isArray(quote), 'Invalid decision quote');
    safeText(quote.user ?? '', 2000, 'decision quote');
    safeText(quote.assistant ?? '', 2000, 'decision quote');
  }
  const history = Array.isArray(decision.history) ? decision.history : [];
  valid(history.length <= 20, 'Decision history is too long');
  const normalizedHistory = history.map((entry) => {
    valid(entry && typeof entry === 'object' && !Array.isArray(entry), 'Invalid decision history entry');
    const to = normalizeDecisionStatus(entry.to);
    valid(DECISION_STATUSES.includes(to), 'Invalid decision history status');
    const from = entry.from === null || entry.from === undefined ? '' : normalizeDecisionStatus(entry.from);
    valid(from === '' || DECISION_STATUSES.includes(from), 'Invalid decision history status');
    return {
      from,
      to,
      at: safeText(entry.at ?? '', 40, 'decision history time'),
      actor: safeText(entry.actor ?? '', 80, 'decision history actor'),
      note: safeText(entry.note ?? '', 500, 'decision history note')
    };
  });
  const reason = text(decision.reason, 2000, 'decision reason');
  return {
    fingerprint: text(decision.fingerprint, 128, 'decision fingerprint'),
    reason,
    // 缺理由 = 理由为空；由这里统一算，避免调用方各写一份判断。
    reasonMissing: reason === '',
    intent: text(decision.intent, 2000, 'decision intent'),
    abandoned: text(decision.abandoned, 2000, 'decision abandoned option'),
    quote,
    source,
    decidedAt: text(decision.decidedAt, 40, 'decision time'),
    history: normalizedHistory,
    ...(decision.supersededAt ? { supersededAt: safeText(decision.supersededAt, 40, 'decision time') } : {}),
    ...(decision.abandonedAt ? { abandonedAt: safeText(decision.abandonedAt, 40, 'decision time') } : {})
  };
}
function normalize(payload, previous=null) {
  valid(payload && typeof payload === 'object' && !Array.isArray(payload), 'Knowledge must be an object');
  const kind = payload.kind ?? 'note';
  const isDecision = kind === DECISION_KIND;
  const item = {
    title: safeText(payload.title,200,'title',true),
    content: safeText(payload.content,25000,'content',true),
    kind,
    layer: payload.layer ?? 'applied',
    scope: payload.scope ?? 'personal',
    projectId: payload.projectId ?? null,
    domains: stringArray(payload.domains ?? [],20,80,'domains'),
    tags: stringArray(payload.tags ?? [],30,80,'tags'),
    evidenceRefs: stringArray(payload.evidenceRefs ?? [],40,500,'evidence references'),
    verificationStatus: payload.verificationStatus ?? 'unverified',
    relations: payload.relations ?? {},
    sourceRef: payload.sourceRef ?? null,
    // 决策状态单独一列：只认三种值；非决策条目必须为空，免得「生效中的知识」这种混用。
    decisionStatus: isDecision
      ? (normalizeDecisionStatus(payload.decisionStatus ?? previous?.decisionStatus) || DEFAULT_DECISION_STATUS)
      : null,
    decision: isDecision ? normalizeDecision(payload.decision ?? previous?.decision ?? null, { required: false }) : null,
    // 升域来源台账：升域后项目级归属被清空，靠这两项仍能解释「最初来自哪个项目」。
    // 只在有值时才写进 payload，普通知识条目的形状不受影响。
    ...(payload.originProjectId ?? previous?.originProjectId
      ? { originProjectId: payload.originProjectId ?? previous?.originProjectId } : {}),
    ...(payload.promotedFrom ?? previous?.promotedFrom
      ? { promotedFrom: payload.promotedFrom ?? previous?.promotedFrom } : {}),
    ...(payload.promotedAt ?? previous?.promotedAt
      ? { promotedAt: payload.promotedAt ?? previous?.promotedAt } : {})
  };
  valid(item.originProjectId === undefined || (typeof item.originProjectId === 'string' && item.originProjectId.length <= 90),
    'Invalid origin project ID');
  valid(item.promotedFrom === undefined || (typeof item.promotedFrom === 'object' && !Array.isArray(item.promotedFrom)),
    'Invalid promotion source');
  valid(item.promotedAt === undefined || (typeof item.promotedAt === 'string' && item.promotedAt.length <= 40),
    'Invalid promotion time');
  valid(KINDS.has(item.kind) && LAYERS.has(item.layer) && SCOPES.has(item.scope), 'Invalid knowledge kind/layer/scope');
  valid(VERIFY.has(item.verificationStatus), 'Invalid verification state');
  valid(!isDecision || item.decision !== null, '决策必须带来源、理由与时间信息');
  valid(item.domains.every(x => { try { requireId(x); return true; } catch { return false; } }), 'Invalid domain ID');
  if (item.projectId !== null) { try { requireId(item.projectId,'project id'); } catch { throw new KnowledgeValidationError('Invalid project ID'); } }
  valid(item.scope === 'project' ? item.projectId !== null && item.layer === 'project' : item.projectId === null && item.layer !== 'project', 'Project scope requires projectId and project layer; other scopes cannot use them');
  valid(item.sourceRef === null || typeof item.sourceRef === 'string' && item.sourceRef.length <= 500, 'Invalid source reference');
  valid(item.relations && typeof item.relations === 'object' && !Array.isArray(item.relations), 'Invalid knowledge relations');
  for (const [type, ids] of Object.entries(item.relations)) {
    valid(RELATIONS.has(type), `Unknown relation: ${type}`);
    stringArray(ids,40,200,`relation ${type}`);
  }
  // A revised claim invalidates the former claim's verification (and its attached evidence).
  if (previous && item.content !== previous.content && previous.verificationStatus === 'verified') {
    item.verificationStatus = 'needs_reverification';
    item.evidenceRefs = [];
  }
  valid(item.verificationStatus !== 'verified' || item.evidenceRefs.length > 0, 'Verified knowledge requires evidence references');
  rejectObviousSecrets({content:item.content,evidenceRefs:item.evidenceRefs});
  return item;
}
function rowToItem(row) {
  if (!row) return null;
  return {
    id:row.id,revision:row.revision,createdAt:row.created_at,updatedAt:row.updated_at,
    ...JSON.parse(row.payload),
    // 当前决策状态只从列上读：payload 里不再存第二份（非决策条目这一列为空）。
    decisionStatus: row.decision_status ?? null,
    ...(row.sync_archived_at ? { syncArchivedAt: row.sync_archived_at } : {})
  };
}
export class PersonalKnowledgeStore {
  constructor(filename=defaultDbPath(),{logger=console}={}) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
    this.logger = logger ?? console;
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS personal_units (
        id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK (revision>0),
        payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS personal_revisions (
        unit_id TEXT NOT NULL REFERENCES personal_units(id), revision INTEGER NOT NULL,
        payload TEXT NOT NULL, actor TEXT NOT NULL, note TEXT NOT NULL, timestamp TEXT NOT NULL,
        payload_hash TEXT NOT NULL, PRIMARY KEY(unit_id,revision)
      );
      CREATE TABLE IF NOT EXISTS personal_domains (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, description TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS personal_proposals (
        id TEXT PRIMARY KEY, target_id TEXT, target_revision INTEGER, payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
        actor TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL,
        reviewed_at TEXT, reviewer TEXT, applied_id TEXT
      );
      CREATE INDEX IF NOT EXISTS personal_revisions_unit ON personal_revisions(unit_id,revision DESC);
      CREATE INDEX IF NOT EXISTS personal_proposals_status ON personal_proposals(status,created_at DESC);
      CREATE TABLE IF NOT EXISTS knowledge_harvest_runs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, experience_ids TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE, model TEXT NOT NULL, status TEXT NOT NULL,
        candidate_ids TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_usages (
        id TEXT PRIMARY KEY, knowledge_id TEXT NOT NULL, revision INTEGER NOT NULL,
        target_run_id TEXT NOT NULL, project_id TEXT NOT NULL, context_snapshot_id TEXT NOT NULL,
        outcome TEXT NOT NULL DEFAULT 'unknown', observed_benefit TEXT NOT NULL DEFAULT 'unknown',
        created_at TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL,
        UNIQUE(knowledge_id,revision,target_run_id,context_snapshot_id)
      );
      CREATE INDEX IF NOT EXISTS knowledge_usages_target ON knowledge_usages(target_run_id,created_at DESC);
      -- 对话引用是提供资料的回执，不冒充执行 Usage，也不参与收益与升级计算。
      CREATE TABLE IF NOT EXISTS knowledge_chat_references (
        turn_id TEXT NOT NULL, session_id TEXT NOT NULL, project_id TEXT NOT NULL,
        context_hash TEXT NOT NULL, item_id TEXT NOT NULL, kind TEXT NOT NULL,
        revision INTEGER NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(turn_id,kind,item_id,revision)
      );
      CREATE INDEX IF NOT EXISTS knowledge_chat_references_item ON knowledge_chat_references(item_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS knowledge_feedback (
        id TEXT PRIMARY KEY, usage_id TEXT NOT NULL UNIQUE REFERENCES knowledge_usages(id),
        outcome TEXT NOT NULL, observed_benefit TEXT NOT NULL, proposed_evolution TEXT NOT NULL,
        created_at TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_eval_runs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT,
        knowledge_id TEXT, knowledge_revision INTEGER, task TEXT NOT NULL, model TEXT NOT NULL,
        mode TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
        payload TEXT NOT NULL, payload_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS knowledge_eval_runs_project ON knowledge_eval_runs(project_id,created_at DESC);
      -- 三层沉淀：经验（现象/机制/对策 + 作用域）与它引用的证据。
      -- 证据行必须指回一条具体的执行记录；执行记录本身不落表，所以不会留下指向已删项目的孤儿经验行。
      -- 状态只有这一列（P0-2）：争议与已被取代也写在这里，payload 里不再存第二份状态。
      CREATE TABLE IF NOT EXISTS knowledge_lessons (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_record_id TEXT NOT NULL,
        phenomenon TEXT NOT NULL, scope_layer TEXT NOT NULL CHECK(scope_layer IN ('project','domain')),
        verification_status TEXT NOT NULL CHECK(verification_status IN ('unverified','inferred','verified','disputed','superseded')),
        dedupe_key TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS knowledge_lessons_project ON knowledge_lessons(project_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS knowledge_lessons_source ON knowledge_lessons(source_record_id);
      CREATE INDEX IF NOT EXISTS knowledge_lessons_dedupe ON knowledge_lessons(dedupe_key);
      CREATE TABLE IF NOT EXISTS knowledge_lesson_evidence (
        id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL REFERENCES knowledge_lessons(id), record_id TEXT NOT NULL,
        ref TEXT NOT NULL, kind TEXT NOT NULL, excerpt TEXT NOT NULL, content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(lesson_id,ref)
      );
      CREATE INDEX IF NOT EXISTS knowledge_lesson_evidence_record ON knowledge_lesson_evidence(record_id);
    `);
    // In-place migration for databases created before proposal revision pinning.
    // Legacy proposals with unknown base revision intentionally fail closed on approval.
    const proposalColumns = this.db.prepare('PRAGMA table_info(personal_proposals)').all().map(x => x.name);
    if (!proposalColumns.includes('target_revision')) {
      this.db.exec('ALTER TABLE personal_proposals ADD COLUMN target_revision INTEGER');
    }
    if (!proposalColumns.includes('meta_json')) {
      this.db.exec("ALTER TABLE personal_proposals ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}'");
    }
    // 三层沉淀（ADR-0007 / #62）：旧 experience/v1 表已停写、读路径已摘除。
    // 这里在建表之后退役旧表，结果留在 lastExperienceRetirement 上，方便调用方与测试核对。
    this.lastExperienceRetirement = this.retireLegacyExperiences();
    // 状态列升级（P0-2）：旧建表语句只允许 unverified/inferred，需要换成五态 CHECK。
    // 只在这一种条件下重建，重复初始化是空操作；结果留在 lastLessonStatusMigration 上。
    this.lastLessonStatusMigration = this.rebuildLessonStatusColumn();
    // 决策状态列（#87）：决策的「生效中 / 已被取代 / 已放弃」单独一列，
    // 与 payload.verificationStatus 分开。老库没有这一列时补上，已有行留空（它们本来就不是决策）。
    this.lastDecisionStatusMigration = this.addDecisionStatusColumn();
    // 远端移除只归档，内容和修订仍留在本机；普通列表不再把归档记忆作为当前结论。
    for (const table of ['personal_units', 'knowledge_lessons']) {
      if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'sync_archived_at')) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN sync_archived_at TEXT`);
      }
    }
  }
  close() { this.db.close(); }

  /**
   * 补 decision_status 列（#87）：老库平滑升级。
   *
   * 用 ALTER TABLE ADD COLUMN 而不是重建表：新增列对已有行没有值要回填（非决策条目本来就该为空），
   * 重建表反而多一次搬数据的风险。重复初始化是空操作；失败时留下明确日志并继续用旧表，
   * 绝不静默：没有这一列时决策仍会写库，只是读不到当前状态。
   */
  addDecisionStatusColumn() {
    let columns;
    try {
      columns = this.db.prepare('PRAGMA table_info(personal_units)').all().map((x) => x.name);
    } catch (error) {
      this.logger?.warn?.(`[personal-store] 检查决策状态列失败，本次跳过升级：${error.message}`);
      return { added: false, reason: 'check-failed', error: error.message };
    }
    if (columns.includes('decision_status')) return { added: false, reason: 'current' };
    let rows = 0;
    try {
      rows = Number(this.db.prepare('SELECT COUNT(*) AS total FROM personal_units').get()?.total ?? 0);
    } catch (error) {
      this.logger?.warn?.(`[personal-store] 统计知识行数失败，仍尝试补决策状态列：${error.message}`);
    }
    try {
      this.db.exec('ALTER TABLE personal_units ADD COLUMN decision_status TEXT');
    } catch (error) {
      this.logger?.warn?.(`[personal-store] 补决策状态列失败，决策状态暂时读不到：${error.message}`);
      return { added: false, reason: 'alter-failed', rows, error: error.message };
    }
    this.logger?.info?.(`[personal-store] 知识表已补 decision_status 列（#87），${rows} 行保持为空。`);
    return { added: true, reason: 'legacy', rows };
  }

  /**
   * 经验状态列升级（P0-2）：把 CHECK 从两态扩到五态，状态只存这一列。
   *
   * 幂等守卫：只有现存建表语句里不含 'verified' 时才重建；重建过程是
   * 「建新表 → 拷数据 → 删旧表 → 改名 → 重建索引」，全程在一个事务里。
   * 失败一律回滚并留下明确日志，绝不静默：宁可继续用旧表，也不留一张半成品。
   * 该表是本次 spec 新建的，真实库里没有数据；这里仍按有数据的情况处理，避免误删。
   */
  rebuildLessonStatusColumn() {
    let row;
    try {
      row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_lessons'").get();
    } catch (error) {
      this.logger?.warn?.(`[personal-store] 检查经验状态列失败，本次跳过升级：${error.message}`);
      return { rebuilt: false, reason: 'check-failed', rows: 0, error: error.message };
    }
    if (!row) return { rebuilt: false, reason: 'absent', rows: 0 };
    // 只认「建表语句已包含 verified」这一种已升级形态；其余一律按旧表处理。
    if (String(row.sql ?? '').includes("'verified'")) return { rebuilt: false, reason: 'current', rows: 0 };
    const columns = 'id,project_id,source_record_id,phenomenon,scope_layer,verification_status,dedupe_key,created_at,payload,payload_hash';
    const foreignKeys = Number(this.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys ?? 1);
    let rows = 0;
    try {
      rows = Number(this.db.prepare('SELECT COUNT(*) AS total FROM knowledge_lessons').get()?.total ?? 0);
    } catch (error) {
      this.logger?.warn?.(`[personal-store] 统计经验行数失败，保留旧表不升级：${error.message}`);
      return { rebuilt: false, reason: 'count-failed', rows: 0, error: error.message };
    }
    try {
      // 证据表用外键指向经验表：删旧表前必须先关掉外键（SQLite 不能在事务里切）。
      if (foreignKeys) this.db.exec('PRAGMA foreign_keys=OFF');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(`
          CREATE TABLE knowledge_lessons_next (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_record_id TEXT NOT NULL,
            phenomenon TEXT NOT NULL, scope_layer TEXT NOT NULL CHECK(scope_layer IN ('project','domain')),
            verification_status TEXT NOT NULL CHECK(verification_status IN ('unverified','inferred','verified','disputed','superseded')),
            dedupe_key TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL
          );
        `);
        this.db.exec(`INSERT INTO knowledge_lessons_next(${columns}) SELECT ${columns} FROM knowledge_lessons`);
        this.db.exec('DROP TABLE knowledge_lessons');
        this.db.exec('ALTER TABLE knowledge_lessons_next RENAME TO knowledge_lessons');
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS knowledge_lessons_project ON knowledge_lessons(project_id,created_at DESC);
          CREATE INDEX IF NOT EXISTS knowledge_lessons_source ON knowledge_lessons(source_record_id);
          CREATE INDEX IF NOT EXISTS knowledge_lessons_dedupe ON knowledge_lessons(dedupe_key);
        `);
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* 回滚失败时下面的日志仍要说清楚 */ }
        throw error;
      }
    } catch (error) {
      this.logger?.warn?.(`[personal-store] 经验状态列升级失败，保留旧表（状态仍只有两态）：${error.message}`);
      return { rebuilt: false, reason: 'rebuild-failed', rows, error: error.message };
    } finally {
      if (foreignKeys) this.db.exec('PRAGMA foreign_keys=ON');
    }
    this.logger?.info?.(`[personal-store] 经验状态列已扩为五态（P0-2），迁移 ${rows} 行。`);
    return { rebuilt: true, reason: 'legacy-check', rows };
  }

  /**
   * 退役旧经验表（#62）。旧 experience/v1 记录本质是执行记录性质的旧数据，不是 ADR-0007 的「经验」。
   *
   * 只删「表存在且为空」的旧表；非空一律保留并留下明确日志，避免误删仍有数据的历史库。
   * 删除是不可逆动作，所以这里宁可留表也不猜。反复初始化是幂等的：删掉之后再进来就是
   * 「不存在」的空操作。检查与删除都包在 try/catch 里：退役失败不应该让知识库打不开。
   */
  retireLegacyExperiences() {
    let table;
    try {
      table = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_experiences'").get();
    } catch (error) {
      this.logger?.warn?.(`[personal-store] 检查旧经验表失败，本次跳过退役：${error.message}`);
      return { dropped: false, reason: 'check-failed', rows: 0, error: error.message };
    }
    if (!table) return { dropped: false, reason: 'absent', rows: 0 };
    let rows = 0;
    try {
      rows = Number(this.db.prepare('SELECT COUNT(*) AS total FROM knowledge_experiences').get()?.total ?? 0);
    } catch (error) {
      this.logger?.warn?.(`[personal-store] 统计旧经验表行数失败，保留不删：${error.message}`);
      return { dropped: false, reason: 'count-failed', rows: 0, error: error.message };
    }
    if (rows > 0) {
      this.logger?.warn?.(`[personal-store] 旧经验表 knowledge_experiences 仍有 ${rows} 行，已保留不删除；`
        + '确认不再需要后请先导出存档，再手动删除该表。');
      return { dropped: false, reason: 'not-empty', rows };
    }
    try {
      this.db.exec('DROP TABLE knowledge_experiences');
      this.logger?.info?.('[personal-store] 旧经验表 knowledge_experiences 为空，已在初始化时删除（幂等）。');
      return { dropped: true, reason: 'empty', rows: 0 };
    } catch (error) {
      this.logger?.warn?.(`[personal-store] 删除空旧经验表失败，保留原表：${error.message}`);
      return { dropped: false, reason: 'drop-failed', rows: 0, error: error.message };
    }
  }
  list({q='',domain='',layer='',scope='',status='',projectId='',limit=500}={}) {
    const rows = this.db.prepare('SELECT * FROM personal_units WHERE sync_archived_at IS NULL ORDER BY updated_at DESC,id LIMIT ?').all(Math.min(Math.max(1,limit),2000));
    const query=q.trim().toLocaleLowerCase();
    return rows.map(rowToItem).filter(x=>(!query || [x.title,x.content,...x.tags,...x.domains].join(' ').toLocaleLowerCase().includes(query))
      && (!domain || x.domains.includes(domain)) && (!layer || x.layer===layer)
      && (!scope || x.scope===scope) && (!status || x.verificationStatus===status)
      && (!projectId || x.projectId===projectId));
  }
  get(id) { return rowToItem(this.db.prepare('SELECT * FROM personal_units WHERE id=?').get(id)); }
  revisions(id) {
    return this.db.prepare('SELECT revision,actor,note,timestamp,payload_hash,payload FROM personal_revisions WHERE unit_id=? ORDER BY revision DESC').all(id).map(row=>({...row,payload:JSON.parse(row.payload)}));
  }

  /** 同步需要完整事实清单，不能复用为界面设计的 500/1000 条窗口。这里只读，不包含候选、对话或执行审计。 */
  syncRecords({ includeArchived = false } = {}) {
    const where = includeArchived ? '' : 'WHERE sync_archived_at IS NULL';
    return [
      ...this.db.prepare(`SELECT id FROM personal_units ${where} ORDER BY id`).all().map(({ id }) => ({ kind: 'knowledge', row: this.get(id) })),
      ...this.db.prepare(`SELECT id FROM knowledge_lessons ${where} ORDER BY id`).all().map(({ id }) => ({ kind: 'lesson', row: this.getLesson(id) }))
    ];
  }

  archiveSyncRecord({ kind, id, expectedStateHash } = {}) {
    valid(kind === 'knowledge' || kind === 'lesson', '不支持的归档条目类型');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = kind === 'knowledge' ? this.get(id) : this.getLesson(id);
      if (!existing || sha256(canonical(existing)) !== expectedStateHash) throw new KnowledgeConflict('条目在预览后已变化，未归档。');
      if (!existing.syncArchivedAt) this.db.prepare(`UPDATE ${kind === 'knowledge' ? 'personal_units' : 'knowledge_lessons'} SET sync_archived_at=? WHERE id=?`).run(now(),id);
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
    return kind === 'knowledge' ? this.get(id) : this.getLesson(id);
  }

  /** 使用预览时的完整状态做比较交换；导入保留身份与修订，不能覆盖检查后发生的本机编辑。 */
  importSyncRecord({ kind, id, payload, expectedStateHash, createdAt = '', updatedAt = '', validateOnly = false } = {}) {
    valid(kind === 'knowledge' || kind === 'lesson', '不支持的同步条目类型');
    valid(expectedStateHash === null || typeof expectedStateHash === 'string' && /^[a-f0-9]{64}$/u.test(expectedStateHash), '同步导入缺少预览状态');
    valid(payload && typeof payload === 'object' && !Array.isArray(payload), '同步条目正文无效');
    requireId(id, 'sync record id');
    const stamp = now();
    const date = value => {
      if (!value) return stamp;
      valid(typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)), '同步条目时间无效');
      return new Date(value).toISOString();
    };
    const created = date(createdAt); const updated = date(updatedAt);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = kind === 'knowledge' ? this.get(id) : this.getLesson(id);
      const actual = existing ? sha256(canonical(existing)) : null;
      if (actual !== expectedStateHash) throw new KnowledgeConflict('本机条目在预览后已变化，请重新检查同步。');
      if (kind === 'knowledge') {
        const normalized = normalize(payload, existing);
        const body = canonical(unitPayloadBody(normalized));
        if (existing && !existing.syncArchivedAt && body === canonical(unitPayloadBody(normalize(existing))) && normalized.decisionStatus === existing.decisionStatus) {
          this.db.exec(validateOnly ? 'ROLLBACK' : 'COMMIT'); return this.get(id);
        }
        const revision = (existing?.revision ?? 0) + 1;
        if (existing) this.db.prepare('UPDATE personal_units SET revision=?,payload=?,updated_at=?,decision_status=?,sync_archived_at=NULL WHERE id=?')
          .run(revision, body, updated, normalized.decisionStatus ?? null, id);
        else this.db.prepare('INSERT INTO personal_units(id,revision,payload,created_at,updated_at,decision_status) VALUES(?,?,?,?,?,?)')
          .run(id, revision, body, created, updated, normalized.decisionStatus ?? null);
        this.db.prepare('INSERT INTO personal_revisions(unit_id,revision,payload,actor,note,timestamp,payload_hash) VALUES(?,?,?,?,?,?,?)')
          .run(id, revision, body, 'sync', '由确认的跨设备同步导入', stamp, sha256(body));
      } else {
        const lesson = JSON.parse(JSON.stringify(payload));
        const evidence = lesson.evidence; delete lesson.evidence;
        valid(Array.isArray(evidence) && evidence.length <= 2000, '经验同步证据无效');
        const projectId = safeText(lesson.projectId, 90, 'lesson project id', true);
        const sourceRecordId = safeText(lesson.sourceRecordId, 200, 'lesson source record id', true);
        const phenomenon = safeText(lesson.phenomenon, 200, 'lesson phenomenon', true);
        safeText(lesson.mechanism, 25000, 'lesson mechanism'); safeText(lesson.countermeasure, 25000, 'lesson countermeasure');
        valid(['project', 'domain'].includes(lesson.scope?.layer), '经验同步范围无效');
        valid(LESSON_STATUSES.includes(lesson.verificationStatus), '经验同步状态无效');
        const dedupeKey = safeText(lesson.dedupeKey, 128, 'lesson dedupe key', true);
        const cleanEvidence = evidence.map(entry => {
          valid(entry && typeof entry === 'object' && !Array.isArray(entry), '经验同步证据结构无效');
          const ref = safeText(entry.ref, 500, 'lesson evidence ref', true);
          const excerpt = safeText(entry.excerpt ?? '', 2000, 'lesson evidence excerpt');
          rejectObviousSecrets(excerpt);
          return { recordId: safeText(entry.recordId, 200, 'lesson evidence record', true), ref,
            kind: safeText(entry.kind, 40, 'lesson evidence kind', true), excerpt,
            contentHash: safeText(entry.contentHash ?? sha256(excerpt), 128, 'lesson evidence hash', true) };
        });
        valid(new Set(cleanEvidence.map(e => e.ref)).size === cleanEvidence.length, '经验同步证据有重复引用');
        if (['unverified', 'verified'].includes(lesson.verificationStatus)) valid(cleanEvidence.length > 0, '有验证状态的经验须保留证据');
        for (const field of ['phenomenon', 'mechanism', 'countermeasure']) rejectObviousSecrets(lesson[field]);
        const next = { ...lessonPayloadBody(lesson), id, projectId, sourceRecordId, phenomenon, dedupeKey,
          createdAt: existing?.createdAt || created };
        const body = canonical(next);
        if (existing && !existing.syncArchivedAt && body === canonical(lessonPayloadBody(Object.fromEntries(Object.entries(existing).filter(([key]) => !['evidence','payloadHash','syncArchivedAt'].includes(key)))))
          && lesson.verificationStatus === existing.verificationStatus
          && canonical(cleanEvidence) === canonical(this.lessonEvidence(id).map(({recordId,ref,kind:evidenceKind,excerpt,contentHash}) => ({recordId,ref,kind:evidenceKind,excerpt,contentHash})))) {
          this.db.exec(validateOnly ? 'ROLLBACK' : 'COMMIT'); return this.getLesson(id);
        }
        // 经验原来没有通用修订表；同步覆盖前保留完整旧状态，便于检查与恢复。
        this.db.exec(`CREATE TABLE IF NOT EXISTS knowledge_sync_imports(
          seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,record_id TEXT NOT NULL,
          before_json TEXT,after_json TEXT NOT NULL,created_at TEXT NOT NULL)`);
        this.db.prepare('INSERT INTO knowledge_sync_imports(kind,record_id,before_json,after_json,created_at) VALUES(?,?,?,?,?)')
          .run(kind,id,existing ? canonical(existing) : null,canonical({ ...next,verificationStatus:lesson.verificationStatus,evidence:cleanEvidence }),stamp);
        if (existing) this.db.prepare(`UPDATE knowledge_lessons SET project_id=?,source_record_id=?,phenomenon=?,scope_layer=?,
          verification_status=?,dedupe_key=?,payload=?,payload_hash=?,sync_archived_at=NULL WHERE id=?`)
          .run(projectId,sourceRecordId,phenomenon,lesson.scope.layer,lesson.verificationStatus,dedupeKey,body,sha256(body),id);
        else this.db.prepare(`INSERT INTO knowledge_lessons(id,project_id,source_record_id,phenomenon,scope_layer,verification_status,dedupe_key,created_at,payload,payload_hash)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,projectId,sourceRecordId,phenomenon,lesson.scope.layer,lesson.verificationStatus,dedupeKey,created,body,sha256(body));
        this.db.prepare('DELETE FROM knowledge_lesson_evidence WHERE lesson_id=?').run(id);
        const insert = this.db.prepare(`INSERT INTO knowledge_lesson_evidence(id,lesson_id,record_id,ref,kind,excerpt,content_hash,created_at) VALUES(?,?,?,?,?,?,?,?)`);
        for (const entry of cleanEvidence) insert.run(`le_${randomUUID().replaceAll('-','').slice(0,24)}`,id,entry.recordId,entry.ref,entry.kind,entry.excerpt,entry.contentHash,stamp);
      }
      const result = kind === 'knowledge' ? this.get(id) : this.getLesson(id);
      this.db.exec(validateOnly ? 'ROLLBACK' : 'COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  create(payload,{actor='user',note='Created'}={}) {
    const normalized=normalize(payload);
    const id=`personal.${randomUUID().replaceAll('-','').slice(0,24)}`;
    const timestamp=now();
    // 当前决策状态只进列，payload 里不留第二份（非决策条目该列为空）。
    const body=canonical(unitPayloadBody(normalized));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO personal_units(id,revision,payload,created_at,updated_at,decision_status) VALUES(?,1,?,?,?,?)').run(id,body,timestamp,timestamp,normalized.decisionStatus ?? null);
      this.db.prepare('INSERT INTO personal_revisions(unit_id,revision,payload,actor,note,timestamp,payload_hash) VALUES(?,1,?,?,?,?,?)').run(id,body,safeText(actor,80,'actor',true),safeText(note,500,'note'),timestamp,sha256(body));
      this.db.exec('COMMIT');
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
    return this.get(id);
  }
  update(id,payload,{expectedRevision,actor='user',note='Edited'}={}) {
    valid(Number.isSafeInteger(expectedRevision) && expectedRevision>0,'expectedRevision required');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing=this.get(id);
      if(!existing) throw new KnowledgeValidationError('Knowledge not found');
      valid(!existing.syncArchivedAt,'这条记忆已归档，请先从同步设置恢复后再编辑。');
      if(existing.revision!==expectedRevision) throw new KnowledgeConflict(`Revision conflict: expected ${expectedRevision}, actual ${existing.revision}`);
      const normalized=normalize(payload,existing);
      const body=canonical(unitPayloadBody(normalized)),stamp=now(),next=existing.revision+1;
      this.db.prepare('UPDATE personal_units SET revision=?,payload=?,updated_at=?,decision_status=? WHERE id=?').run(next,body,stamp,normalized.decisionStatus ?? null,id);
      this.db.prepare('INSERT INTO personal_revisions(unit_id,revision,payload,actor,note,timestamp,payload_hash) VALUES(?,?,?,?,?,?,?)').run(id,next,body,safeText(actor,80,'actor',true),safeText(note,500,'note'),stamp,sha256(body));
      this.db.exec('COMMIT');
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
    return this.get(id);
  }
  revert(id, revision,expectedRevision) {
    valid(Number.isSafeInteger(revision) && revision>0,'Invalid revision');
    const row=this.db.prepare('SELECT payload FROM personal_revisions WHERE unit_id=? AND revision=?').get(id,revision);
    if(!row) throw new KnowledgeValidationError('Revision not found');
    return this.update(id,JSON.parse(row.payload),{expectedRevision,note:`Restored content from revision ${revision}`});
  }
  createDomain({id,label,description=''}) {
    try { requireId(id,'domain ID'); } catch { throw new KnowledgeValidationError('Invalid domain ID'); }
    const name=safeText(label,120,'domain label',true),desc=safeText(description,1000,'domain description');
    this.db.prepare('INSERT INTO personal_domains(id,label,description,created_at) VALUES(?,?,?,?)').run(id,name,desc,now());
    return {id,label:name,description:desc};
  }
  domains() { return this.db.prepare('SELECT * FROM personal_domains ORDER BY label,id').all(); }
  submitProposal({targetId=null,payload,actor='agent',note='',meta={}}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = targetId === null ? null : this.get(targetId);
      valid(targetId === null || !!existing, 'Proposal target not found');
      const normalized = normalize(payload, existing);
      // Changing scope or project ownership needs an explicit user edit, not an Agent proposal.
      if (existing && (normalized.scope !== existing.scope || normalized.projectId !== existing.projectId)) {
        throw new KnowledgeValidationError('Proposal cannot change target scope or project ownership');
      }
      valid(meta && typeof meta === 'object' && !Array.isArray(meta), 'Proposal meta must be an object');
      rejectObviousSecrets(meta);
      const metaJson = canonical(meta);
      valid(metaJson.length <= 20000, 'Proposal meta is too large');
      const id = randomUUID(), stamp = now();
      this.db.prepare(`INSERT INTO personal_proposals(id,target_id,target_revision,payload,status,actor,note,created_at,meta_json)
        VALUES(?,?,?,?,'pending',?,?,?,?)`).run(id,targetId,existing?.revision ?? null,canonical(unitPayloadBody(normalized)),
          safeText(actor,80,'actor',true),safeText(note,500,'note'),stamp,metaJson);
      this.db.exec('COMMIT');
      return this.proposal(id);
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  proposal(id) {
    const row=this.db.prepare('SELECT * FROM personal_proposals WHERE id=?').get(id);
    return row ? {...row,payload:JSON.parse(row.payload),meta:JSON.parse(row.meta_json??'{}')} : null;
  }
  proposals(status='') {
    return this.db.prepare('SELECT * FROM personal_proposals ORDER BY created_at DESC,id DESC').all()
      .map(r=>({...r,payload:JSON.parse(r.payload),meta:JSON.parse(r.meta_json??'{}')}))
      .filter(r=>!status||r.status===status);
  }
  reviewProposal(id,{decision,reviewer='user',expectedRevision=null,edits=null,expectedProposalHash=''}) {
    valid(['approved','rejected'].includes(decision),'Invalid proposal decision');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const proposal=this.proposal(id);
      if(!proposal) throw new KnowledgeValidationError('Proposal not found');
      if(proposal.status!=='pending') throw new KnowledgeConflict('Proposal already reviewed');
      if(expectedProposalHash && proposalReviewHash(proposal)!==expectedProposalHash)throw new KnowledgeConflict('候选在打开后已变化，未接受。请重新打开最新候选；当前输入可复制保留。');
      if(edits && !expectedProposalHash)throw new KnowledgeConflict('缺少审阅版本，请重新打开候选。');
      if(decision==='approved' && proposal.meta?.sourceLessonHash){
        const lesson=this.getLesson(proposal.meta.sourceLessonIds?.[0]);
        if(!lesson || lesson.syncArchivedAt || lesson.payloadHash!==proposal.meta.sourceLessonHash || lesson.verificationStatus==='superseded')throw new KnowledgeConflict('来源经验在准备候选后已变化或被取代，未接受；请拒绝旧候选，再从经验重新准备。原输入保留。');
        if(edits && lesson.verificationStatus==='disputed')throw new KnowledgeConflict('来源经验仍有争议，请先裁决，不把争议自动升级为知识。');
      }
      let appliedId=null;
      // We want a single atomic transaction. create/update use their own transactions,
      // so reproduce the minimal creation/revision operation here under the current lock.
      if(decision==='approved') {
        const existing=proposal.target_id ? this.get(proposal.target_id):null;
        if(proposal.target_id && !existing) throw new KnowledgeConflict('Target knowledge was removed');
        if(existing?.syncArchivedAt) throw new KnowledgeConflict('这条记忆已归档，请先恢复后重新审核。');
        if (existing && (!Number.isSafeInteger(proposal.target_revision) ||
          existing.revision !== proposal.target_revision ||
          (expectedRevision !== null && existing.revision !== expectedRevision))) {
          throw new KnowledgeConflict('Target changed since proposal; review again');
        }
        if (existing && (proposal.payload.scope !== existing.scope || proposal.payload.projectId !== existing.projectId)) {
          throw new KnowledgeConflict('Proposal cannot change target scope or project ownership');
        }
        if(edits && existing){const next=knowledgeReviewEdits(proposal,edits);if(next.scope!==existing.scope||next.projectId!==existing.projectId)throw new KnowledgeConflict('目标知识的归属不能通过旧候选改变。');}
        const reviewedPayload=edits?knowledgeReviewEdits(proposal,edits):proposal.payload;
        const normalized=normalize(reviewedPayload,existing), body=canonical(unitPayloadBody(normalized)), stamp=now();
        if(edits)this.db.prepare('UPDATE personal_proposals SET payload=? WHERE id=?').run(body,id);
        const note=`Accepted proposal ${id}`;
        if(existing) {
          const rev=existing.revision+1;
          this.db.prepare('UPDATE personal_units SET revision=?,payload=?,updated_at=?,decision_status=? WHERE id=?').run(rev,body,stamp,normalized.decisionStatus ?? null,existing.id);
          this.db.prepare('INSERT INTO personal_revisions(unit_id,revision,payload,actor,note,timestamp,payload_hash) VALUES(?,?,?,?,?,?,?)').run(existing.id,rev,body,reviewer,note,stamp,sha256(body));
          appliedId=existing.id;
        } else {
          appliedId=`personal.${randomUUID().replaceAll('-','').slice(0,24)}`;
          this.db.prepare('INSERT INTO personal_units(id,revision,payload,created_at,updated_at,decision_status) VALUES(?,1,?,?,?,?)').run(appliedId,body,stamp,stamp,normalized.decisionStatus ?? null);
          this.db.prepare('INSERT INTO personal_revisions(unit_id,revision,payload,actor,note,timestamp,payload_hash) VALUES(?,1,?,?,?,?,?)').run(appliedId,body,reviewer,note,stamp,sha256(body));
        }
      }
      this.db.prepare('UPDATE personal_proposals SET status=?,reviewed_at=?,reviewer=?,applied_id=? WHERE id=?').run(decision,now(),safeText(reviewer,80,'reviewer',true),appliedId,id);
      this.db.exec('COMMIT');
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
    return this.proposal(id);
  }

  // ---- Knowledge Loop: Harvest / Usage / Feedback ----
  // 旧的 experience/v1 读写方法已随 knowledge_experiences 表退役（ADR-0007 / #62）；
  // 新链路的「经验」是 lesson/v1，写在类末尾的 knowledge_lessons 上。
  addHarvestRun(input) {
    const id = input.id ?? `harvest_${randomUUID().replaceAll('-','').slice(0,24)}`;
    const stamp=now();
    const payload={...input,id,createdAt:input.createdAt ?? stamp};
    const body=canonical(payload);
    try {
      this.db.prepare(`INSERT INTO knowledge_harvest_runs(id,project_id,experience_ids,dedupe_key,model,status,candidate_ids,created_at,payload,payload_hash)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,input.projectId,canonical(input.experienceIds),input.dedupeKey,
          safeText(input.model ?? 'unknown',120,'model',true),input.status,canonical(input.candidateIds ?? []),stamp,body,sha256(body));
    } catch (error) {
      if (/UNIQUE constraint/.test(error.message)) return this.harvestRunByDedupe(input.dedupeKey);
      throw error;
    }
    return this.getHarvestRun(id);
  }
  getHarvestRun(id) {
    const row=this.db.prepare('SELECT * FROM knowledge_harvest_runs WHERE id=?').get(id);
    if(!row)return null;
    return {...JSON.parse(row.payload),candidateIds:JSON.parse(row.candidate_ids),experienceIds:JSON.parse(row.experience_ids),payloadHash:row.payload_hash};
  }
  harvestRunByDedupe(key) {
    const row=this.db.prepare('SELECT id FROM knowledge_harvest_runs WHERE dedupe_key=?').get(key);
    return row ? this.getHarvestRun(row.id) : null;
  }
  listHarvestRuns(limit=100) {
    return this.db.prepare('SELECT id FROM knowledge_harvest_runs ORDER BY created_at DESC,id DESC LIMIT ?')
      .all(Math.min(Math.max(1,limit),1000)).map(({id})=>this.getHarvestRun(id));
  }
  addUsage(input) {
    const stamp=now();
    const id = input.id ?? `usage_${randomUUID().replaceAll('-','').slice(0,24)}`;
    const payload={...input,id,createdAt:input.createdAt ?? stamp};
    const body=canonical(payload);
    try {
      this.db.prepare(`INSERT INTO knowledge_usages(id,knowledge_id,revision,target_run_id,project_id,context_snapshot_id,outcome,observed_benefit,created_at,payload,payload_hash)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.knowledgeId,input.revision,input.targetRunId,input.projectId,
          input.contextSnapshotId,input.outcome ?? 'unknown',input.observedBenefit ?? 'unknown',stamp,body,sha256(body));
    } catch (error) {
      if (/UNIQUE constraint/.test(error.message)) {
        return this.usageByKey(input.knowledgeId,input.revision,input.targetRunId,input.contextSnapshotId);
      }
      throw error;
    }
    return this.getUsage(id);
  }
  getUsage(id) {
    const row=this.db.prepare('SELECT * FROM knowledge_usages WHERE id=?').get(id);
    if(!row)return null;
    return {...JSON.parse(row.payload),outcome:row.outcome,observedBenefit:row.observed_benefit,payloadHash:row.payload_hash};
  }
  usageByKey(knowledgeId,revision,targetRunId,contextSnapshotId) {
    const row=this.db.prepare('SELECT id FROM knowledge_usages WHERE knowledge_id=? AND revision=? AND target_run_id=? AND context_snapshot_id=?')
      .get(knowledgeId,revision,targetRunId,contextSnapshotId);
    return row ? this.getUsage(row.id) : null;
  }
  listUsages({targetRunId='',projectId='',knowledgeId='',limit=100}={}) {
    const where=[];const params=[];
    if(targetRunId){where.push('target_run_id=?');params.push(targetRunId);}
    if(projectId){where.push('project_id=?');params.push(projectId);}
    if(knowledgeId){where.push('knowledge_id=?');params.push(knowledgeId);}
    const rows=this.db.prepare(`SELECT id FROM knowledge_usages ${where.length?`WHERE ${where.join(' AND ')}`:''}
      ORDER BY created_at DESC,id DESC LIMIT ?`).all(...params,Math.min(Math.max(1,limit),1000));
    return rows.map(({id})=>this.getUsage(id));
  }
  /** 仅保存已完成对话的引用身份，不复制正文；同一轮重试落盘不会重复计数。 */
  recordChatReferences({ turnId, sessionId, projectId = '', contextHash, items = [] } = {}) {
    safeText(turnId, 200, 'chat turn id', true); safeText(sessionId, 200, 'chat session id', true);
    safeText(projectId, 90, 'chat project id');
    valid(/^[a-f0-9]{64}$/u.test(contextHash), 'Invalid chat context hash');
    valid(Array.isArray(items) && items.length <= 50, 'Invalid chat references');
    const references = items.map(item => {
      valid(['knowledge','lesson'].includes(item?.kind), 'Invalid chat reference kind');
      safeText(item.id, 200, 'chat reference id', true);
      valid(item.kind === 'lesson' ? item.revision === null : Number.isSafeInteger(item.revision) && item.revision > 0,
        'Invalid chat reference revision');
      return { ...item, revision: item.revision ?? 0 };
    });
    const stamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db.prepare('SELECT session_id,project_id,context_hash FROM knowledge_chat_references WHERE turn_id=? LIMIT 1').get(turnId);
      valid(!prior || (prior.session_id === sessionId && prior.project_id === projectId && prior.context_hash === contextHash),
        '该轮引用身份已存在，未覆盖原记录');
      const insert = this.db.prepare(`INSERT OR IGNORE INTO knowledge_chat_references
        (turn_id,session_id,project_id,context_hash,item_id,kind,revision,created_at) VALUES(?,?,?,?,?,?,?,?)`);
      for (const item of references) insert.run(turnId,sessionId,projectId,contextHash,item.id,item.kind,item.revision,stamp);
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
    return { count: new Set(references.map(item => `${item.kind}:${item.id}@${item.revision}`)).size };
  }
  listChatReferences({ knowledgeId = '', kind = 'knowledge', limit = 200 } = {}) {
    valid(['knowledge','lesson'].includes(kind), 'Invalid chat reference kind');
    const params = [kind]; let where = 'kind=?';
    if (knowledgeId) { where += ' AND item_id=?'; params.push(knowledgeId); }
    const cap = Number.isSafeInteger(limit) ? Math.min(1000, Math.max(1,limit)) : 200;
    return this.db.prepare(`SELECT * FROM knowledge_chat_references WHERE ${where} ORDER BY created_at DESC,turn_id DESC LIMIT ?`)
      .all(...params,cap).map(row => ({ turnId:row.turn_id, sessionId:row.session_id, projectId:row.project_id,
        contextHash:row.context_hash, id:row.item_id, kind:row.kind, revision:row.revision || null, createdAt:row.created_at }));
  }
  updateUsageOutcome(id,{outcome,observedBenefit,outcomeEvidenceRefs,benefitEvidenceRefs}={}) {
    const usage=this.getUsage(id);
    if(!usage)throw new KnowledgeValidationError('Usage not found');
    const next={...usage,outcome:outcome??usage.outcome,observedBenefit:observedBenefit??usage.observedBenefit,
      outcomeEvidenceRefs:outcomeEvidenceRefs??usage.outcomeEvidenceRefs,
      benefitEvidenceRefs:benefitEvidenceRefs??usage.benefitEvidenceRefs??[]};
    delete next.payloadHash;
    const body=canonical(next);
    this.db.prepare('UPDATE knowledge_usages SET outcome=?,observed_benefit=?,payload=?,payload_hash=? WHERE id=?')
      .run(next.outcome,next.observedBenefit,body,sha256(body),id);
    return this.getUsage(id);
  }
  addFeedback(input) {
    const stamp=now();
    const id=input.id ?? `feedback_${randomUUID().replaceAll('-','').slice(0,24)}`;
    const payload={...input,id,createdAt:input.createdAt ?? stamp};
    const body=canonical(payload);
    try {
      this.db.prepare(`INSERT INTO knowledge_feedback(id,usage_id,outcome,observed_benefit,proposed_evolution,created_at,payload,payload_hash)
        VALUES(?,?,?,?,?,?,?,?)`).run(id,input.usageId,input.outcome,input.observedBenefit,
          input.proposedEvolution ?? 'none',stamp,body,sha256(body));
    } catch (error) {
      if (/UNIQUE constraint/.test(error.message)) return this.feedbackForUsage(input.usageId);
      throw error;
    }
    return this.getFeedback(id);
  }
  getFeedback(id) {
    const row=this.db.prepare('SELECT * FROM knowledge_feedback WHERE id=?').get(id);
    return row ? {...JSON.parse(row.payload),payloadHash:row.payload_hash} : null;
  }
  feedbackForUsage(usageId) {
    const row=this.db.prepare('SELECT id FROM knowledge_feedback WHERE usage_id=?').get(usageId);
    return row ? this.getFeedback(row.id) : null;
  }
  listFeedback({usageId='',limit=100}={}) {
    const rows=usageId
      ? this.db.prepare('SELECT id FROM knowledge_feedback WHERE usage_id=? ORDER BY created_at DESC LIMIT ?').all(usageId,Math.min(Math.max(1,limit),1000))
      : this.db.prepare('SELECT id FROM knowledge_feedback ORDER BY created_at DESC,id DESC LIMIT ?').all(Math.min(Math.max(1,limit),1000));
    return rows.map(({id})=>this.getFeedback(id));
  }
  addEvalRun(input) {
    valid(input && typeof input === 'object' && !Array.isArray(input),'Eval run must be an object');
    const id = input.id ?? `eval_${randomUUID().replaceAll('-','').slice(0,24)}`;
    requireId(input.projectId,'project id');
    const stamp = now();
    const payload = {...input,id,createdAt:input.createdAt ?? stamp};
    const body = canonical(payload);
    try {
      this.db.prepare(`INSERT INTO knowledge_eval_runs(id,project_id,task_id,knowledge_id,knowledge_revision,task,model,mode,status,created_at,payload,payload_hash)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id,input.projectId,input.taskId ?? null,input.knowledgeId ?? null,
        Number.isSafeInteger(input.knowledgeRevision) ? input.knowledgeRevision : null,
        safeText(input.task,2000,'task',true),safeText(input.model ?? 'unknown',120,'model',true),
        safeText(input.mode ?? 'ab',40,'mode',true),safeText(input.status ?? 'completed',40,'status',true),
        stamp,body,sha256(body)
      );
    } catch (error) {
      if (/UNIQUE constraint/.test(error.message)) return this.getEvalRun(id);
      throw error;
    }
    return this.getEvalRun(id);
  }
  getEvalRun(id) {
    const row=this.db.prepare('SELECT * FROM knowledge_eval_runs WHERE id=?').get(id);
    return row ? {...JSON.parse(row.payload),payloadHash:row.payload_hash} : null;
  }
  listEvalRuns({projectId='',knowledgeId='',limit=100}={}) {
    const where=[];const params=[];
    if(projectId){where.push('project_id=?');params.push(projectId);}
    if(knowledgeId){where.push('knowledge_id=?');params.push(knowledgeId);}
    const rows=this.db.prepare(`SELECT id FROM knowledge_eval_runs ${where.length?`WHERE ${where.join(' AND ')}`:''}
      ORDER BY created_at DESC,id DESC LIMIT ?`).all(...params,Math.min(Math.max(1,limit),1000));
    return rows.map(({id})=>this.getEvalRun(id));
  }

  // ---- 三层沉淀：经验（Lesson）与证据 ----
  // 只在本类末尾追加，不改上面已有的方法与建表语句（后续票会继续在同一处追加）。

  addLesson(lesson,{evidence=[]}={}) {
    valid(lesson && typeof lesson === 'object' && !Array.isArray(lesson),'Lesson must be an object');
    valid(Array.isArray(evidence),'Lesson evidence must be an array');
    const id = typeof lesson.id === 'string' && lesson.id ? lesson.id : `lesson_${randomUUID().replaceAll('-','').slice(0,24)}`;
    const projectId = safeText(lesson.projectId,90,'lesson project id',true);
    const sourceRecordId = safeText(lesson.sourceRecordId,200,'lesson source record id',true);
    const phenomenon = safeText(lesson.phenomenon,200,'lesson phenomenon',true);
    const scopeLayer = lesson.scope?.layer ?? 'project';
    valid(['project','domain'].includes(scopeLayer),'Invalid lesson scope layer');
    const verificationStatus = lesson.verificationStatus ?? 'inferred';
    // 新建时只允许「待验证 / 推断 / 争议」：已验证与已被取代只能由裁决或人工确认写出。
    valid(CREATABLE_LESSON_STATUSES.includes(verificationStatus),'Invalid lesson verification status');
    const evidenceRefs = Array.isArray(lesson.evidenceRefs) ? lesson.evidenceRefs : [];
    // 追不到证据的结论只能算推断：没有证据行就不可能成为待验证。
    valid(verificationStatus !== 'unverified' || evidenceRefs.length > 0,'Lesson evidence is required before it can be marked unverified');
    // 去重键由 contracts.lessonDedupeKey 提供（规范化现象 + 作用域）；缺失时按同一公式回退。
    const dedupeKey = safeText(
      lesson.dedupeKey
        ?? sha256(canonical({contract:'lesson/v1',phenomenon:phenomenon.toLowerCase(),layer:scopeLayer,projectId})),
      128,'lesson dedupe key',true
    );
    const rows = evidence.map((item)=>{
      valid(item && typeof item === 'object' && !Array.isArray(item),'Lesson evidence must be objects');
      const ref = safeText(item.ref,500,'lesson evidence reference',true);
      const excerpt = item.excerpt ?? '';
      return {
        id:`le_${randomUUID().replaceAll('-','').slice(0,24)}`,
        recordId:safeText(item.recordId ?? sourceRecordId,200,'lesson evidence record id',true),
        ref,
        kind:safeText(item.kind ?? 'other',40,'lesson evidence kind',true),
        excerpt:safeText(excerpt,2000,'lesson evidence excerpt'),
        contentHash:safeText(item.contentHash ?? sha256(String(excerpt)),128,'lesson evidence hash',true)
      };
    });
    valid(new Set(rows.map((row)=>row.ref)).size === rows.length,'Duplicate lesson evidence reference');
    const stamp = now();
    // 状态不进 payload（P0-2）：同一概念只存一列，写库时把调用方可能带来的状态字段剥掉。
    const payload = { ...lessonPayloadBody(lesson),id,projectId,sourceRecordId,phenomenon,dedupeKey,createdAt:lesson.createdAt ?? stamp };
    const body = canonical(payload);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO knowledge_lessons(id,project_id,source_record_id,phenomenon,scope_layer,verification_status,dedupe_key,created_at,payload,payload_hash)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,projectId,sourceRecordId,phenomenon,scopeLayer,verificationStatus,dedupeKey,stamp,body,sha256(body));
      const insert = this.db.prepare(`INSERT INTO knowledge_lesson_evidence(id,lesson_id,record_id,ref,kind,excerpt,content_hash,created_at)
        VALUES(?,?,?,?,?,?,?,?)`);
      for(const row of rows) insert.run(row.id,id,row.recordId,row.ref,row.kind,row.excerpt,row.contentHash,stamp);
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
    return this.getLesson(id);
  }
  getLesson(id) {
    const row = this.db.prepare('SELECT * FROM knowledge_lessons WHERE id=?').get(id);
    if(!row) return null;
    // 状态只认列（P0-2）：payload 里的旧状态字段一律以列上的当前值为准。
    const { reproducedAt: _oldReproducedAt, ...payload } = JSON.parse(row.payload);
    return {
      ...payload,
      // 旧库与同步导入可能携带误标；读取时从当前证据重算，绝不把旧徽章当证据。
      ...this.lessonReproductionState(row.phenomenon, row.project_id),
      verificationStatus: row.verification_status,
      status: row.verification_status,
      payloadHash: row.payload_hash,
      ...(row.sync_archived_at ? { syncArchivedAt: row.sync_archived_at } : {}),
      dedupeKey: row.dedupe_key,
      evidence: this.lessonEvidence(row.id)
    };
  }
  lessonEvidence(lessonId) {
    return this.db.prepare('SELECT * FROM knowledge_lesson_evidence WHERE lesson_id=? ORDER BY ref,id').all(lessonId)
      .map((row)=>({id:row.id,lessonId:row.lesson_id,recordId:row.record_id,ref:row.ref,kind:row.kind,
        excerpt:row.excerpt,contentHash:row.content_hash,createdAt:row.created_at}));
  }
  listLessons({projectId='',verificationStatus='',sourceRecordId='',limit=100}={}) {
    const where=['sync_archived_at IS NULL'];const params=[];
    if(projectId){where.push('project_id=?');params.push(projectId);}
    if(verificationStatus){where.push('verification_status=?');params.push(verificationStatus);}
    if(sourceRecordId){where.push('source_record_id=?');params.push(sourceRecordId);}
    const rows=this.db.prepare(`SELECT id FROM knowledge_lessons ${where.length?`WHERE ${where.join(' AND ')}`:''}
      ORDER BY created_at DESC,id DESC LIMIT ?`).all(...params,Math.min(Math.max(1,limit),1000));
    return rows.map(({id})=>this.getLesson(id));
  }
  /** 已提炼过的执行记录 ID：执行记录不落表，待提炼队列只能靠这张表反推。 */
  lessonedRecordIds({projectId=''}={}) {
    const rows = projectId
      ? this.db.prepare('SELECT DISTINCT source_record_id AS record_id FROM knowledge_lessons WHERE project_id=?').all(projectId)
      : this.db.prepare('SELECT DISTINCT source_record_id AS record_id FROM knowledge_lessons').all();
    return rows.map((row)=>row.record_id);
  }

  // ---- 三层沉淀：去重与证据累加 ----
  // 同一现象在同一作用域再次被提炼时，不新建经验，只把新证据追加到已有经验上。
  // 比较用的是提炼时产出的规范化现象短句（contracts.lessonDedupeKey），不是整段文本。

  /** 按去重键找已有经验：键 = 规范化现象 + 作用域层 + 项目，由 contracts.lessonDedupeKey 产出。 */
  lessonByDedupe(dedupeKey) {
    const key = safeText(dedupeKey,128,'lesson dedupe key',true);
    const row = this.db.prepare('SELECT id FROM knowledge_lessons WHERE dedupe_key=? AND sync_archived_at IS NULL ORDER BY created_at,id LIMIT 1').get(key);
    return row ? this.getLesson(row.id) : null;
  }

  /**
   * 经验沉淀的底层写入口（#55）：按项目去重键做「插入或追加证据」，不处理争议与跨项目复现。
   * - 首次提炼：照常插入一条经验行；
   * - 命中同一去重键：只追加证据行、重算计数，经验行本身不新增；
   * - 证据按 (经验, 引用) 幂等，同一条证据重复出现既不报错也不重复计数。
   *
   * 提炼链路统一走 recordLessonOrDispute（它在本方法之上补争议与复现）；本方法保留给
   * 「已知同一作用域、只要把证据写进去」的调用方与测试。返回值带 support。
   */
  recordLesson(lesson, { evidence = [] } = {}) {
    valid(lesson && typeof lesson === 'object' && !Array.isArray(lesson),'Lesson must be an object');
    valid(Array.isArray(evidence),'Lesson evidence must be an array');
    const projectId = safeText(lesson.projectId,90,'lesson project id',true);
    const phenomenon = safeText(lesson.phenomenon,200,'lesson phenomenon',true);
    const scopeLayer = lesson.scope?.layer ?? 'project';
    valid(['project','domain'].includes(scopeLayer),'Invalid lesson scope layer');
    // 去重键沿用 contracts.lessonDedupeKey 的公式（规范化现象 + 作用域层 + 项目），这里不另造一套。
    const dedupeKey = safeText(
      lesson.dedupeKey
        ?? sha256(canonical({contract:'lesson/v1',phenomenon:phenomenon.toLowerCase(),layer:scopeLayer,projectId})),
      128,'lesson dedupe key',true
    );
    const existing = this.lessonByDedupe(dedupeKey);
    const stored = existing
      ? this.appendLessonEvidence(existing.id, lesson, evidence)
      : this.addLesson({ ...lesson, dedupeKey }, { evidence });
    return { ...stored, support: this.lessonSupport(stored.id) };
  }

  /**
   * 把新证据追加到已有经验上：现象/机制/对策保留第一次提炼的措辞，只更新证据与计数。
   * 计数按证据表重算而不是逐次累加，所以重复提交不会把数字抬高。
   */
  appendLessonEvidence(lessonId, lesson, evidence = []) {
    const id = safeText(lessonId,90,'lesson id',true);
    const sourceRecordId = safeText(lesson?.sourceRecordId,200,'lesson source record id',true);
    valid(Array.isArray(evidence),'Lesson evidence must be an array');
    const row = this.db.prepare('SELECT payload,verification_status,sync_archived_at FROM knowledge_lessons WHERE id=?').get(id);
    valid(Boolean(row),'Lesson not found');
    valid(!row.sync_archived_at,'这条经验已归档，请先恢复后再修改。');
    const payload = JSON.parse(row.payload);
    const stamp = now();
    const known = new Set(this.db.prepare('SELECT ref FROM knowledge_lesson_evidence WHERE lesson_id=?').all(id)
      .map((item)=>item.ref));
    const insert = this.db.prepare(`INSERT OR IGNORE INTO knowledge_lesson_evidence(id,lesson_id,record_id,ref,kind,excerpt,content_hash,created_at)
      VALUES(?,?,?,?,?,?,?,?)`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for(const item of evidence) {
        valid(item && typeof item === 'object' && !Array.isArray(item),'Lesson evidence must be objects');
        const ref = safeText(item.ref,500,'lesson evidence reference',true);
        // 同一条证据已经在库里：幂等跳过，不报错、不新增行、不抬高计数。
        if(known.has(ref)) continue;
        const excerpt = item.excerpt ?? '';
        const inserted = insert.run(
          `le_${randomUUID().replaceAll('-','').slice(0,24)}`,id,
          safeText(item.recordId ?? sourceRecordId,200,'lesson evidence record id',true),
          ref,
          safeText(item.kind ?? 'other',40,'lesson evidence kind',true),
          safeText(excerpt,2000,'lesson evidence excerpt'),
          safeText(item.contentHash ?? sha256(String(excerpt)),128,'lesson evidence hash',true),
          stamp
        );
        if(Number(inserted?.changes) > 0) known.add(ref);
      }
      const stats = this.db.prepare(`SELECT COUNT(*) AS evidence,COUNT(DISTINCT record_id) AS records
        FROM knowledge_lesson_evidence WHERE lesson_id=?`).get(id);
      const refs = this.db.prepare('SELECT ref FROM knowledge_lesson_evidence WHERE lesson_id=? ORDER BY ref,id').all(id)
        .map((item)=>item.ref);
      // 合并进来的执行记录也要记下来：待提炼队列靠它判断「这条记录已经提炼过」。
      const recordIds = [...new Set([
        ...(Array.isArray(payload.recordIds) ? payload.recordIds : []),
        payload.sourceRecordId ?? null,
        sourceRecordId
      ].filter(Boolean))];
      // 后来补上可追证据的推断，升级为待验证；其余状态（待验证 / 争议 / 已验证 / 已被取代）不因合并而变。
      const previous = row.verification_status ?? 'inferred';
      const hasExecutionEvidence = this.lessonEvidence(id).some(executionEvidence);
      const verificationStatus = previous === 'inferred' && hasExecutionEvidence ? 'unverified' : previous;
      // payload 里不带状态（P0-2）：状态只写列，读的时候由 getLesson 覆盖回来。
      const next = {
        ...lessonPayloadBody(payload),
        evidenceRefs: refs,
        // 累加计数：证据条数与支持它的执行记录条数，两处都从证据表重算。
        evidenceCount: Number(stats.evidence),
        supportCount: Number(stats.records),
        recordIds,
        lastMergedAt: stamp
      };
      const body = canonical(next);
      this.db.prepare('UPDATE knowledge_lessons SET payload=?,payload_hash=?,verification_status=? WHERE id=?')
        .run(body,sha256(body),verificationStatus,id);
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
    return this.getLesson(id);
  }

  /** 追溯这条经验的来源记录数；包含灵感来源，不作为独立执行复现的计数。 */
  lessonSupport(lessonId) {
    const id = safeText(lessonId,90,'lesson id',true);
    const row = this.db.prepare('SELECT id,project_id,created_at FROM knowledge_lessons WHERE id=?').get(id);
    if(!row) return null;
    const stats = this.db.prepare(`SELECT COUNT(*) AS evidence,COUNT(DISTINCT record_id) AS records,
      MAX(created_at) AS latest_at FROM knowledge_lesson_evidence WHERE lesson_id=?`).get(id);
    const recordIds = this.db.prepare('SELECT DISTINCT record_id FROM knowledge_lesson_evidence WHERE lesson_id=? ORDER BY record_id').all(id)
      .map((item)=>item.record_id);
    return {
      lessonId:id, projectId:row.project_id,
      records:Number(stats.records) || 0, evidence:Number(stats.evidence) || 0,
      latestAt:stats.latest_at ?? row.created_at, recordIds
    };
  }

  /**
   * 已提炼的执行记录 ID：来源记录 + 合并进来的证据所属记录。
   * 合并后经验行仍只有一条，只靠 source_record_id 会把后续记录一直留在待提炼队列里。
   */
  distilledRecordIds({projectId=''}={}) {
    const rows = projectId
      ? this.db.prepare('SELECT id,source_record_id,payload FROM knowledge_lessons WHERE project_id=?').all(projectId)
      : this.db.prepare('SELECT id,source_record_id,payload FROM knowledge_lessons').all();
    const ids = new Set();
    for(const row of rows) {
      ids.add(row.source_record_id);
      let payload = {};
      try { payload = JSON.parse(row.payload); } catch { payload = {}; }
      for(const recordId of (Array.isArray(payload.recordIds) ? payload.recordIds : [])) ids.add(recordId);
      for(const item of this.lessonEvidence(row.id)) ids.add(item.recordId);
    }
    return [...ids];
  }

  // ---- 三层沉淀：跨项目复现与作用域升级（#56 / P0-1） ----
  // 同一规范化现象按项目各自成行；只有不同项目的独立事实证据才支持「已复现」。
  // 来源台账保留灵感等出处，但 supportProjects 只计独立执行证据，二者不能混用。
  //
  // 为什么不合并成一行（P0-1 的修正）：如果两个项目共用一行，行上的 project_id 只能指向最早
  // 那个项目，listLessons({projectId:'第二个项目'}) 会返回空——#59 的「按项目过滤命中项目级
  // 经验」在第二个项目直接失效，界面显示「这个项目还没提炼过」。跨项目复现因此只作为属性
  // 体现（reproduced / supportProjects / supportedByProjects / sources），不吞掉另一个项目的行。
  //
  // 升域仍只能由人显式调用 promoteLessonToDomain；复现只打标记，系统不替人把经验升为已验证。

  /** 来源项目与独立事实支持分别计算；共享同一执行记录的多个项目不算独立复现。 */
  lessonReproductionState(phenomenon, originProjectId) {
    const rows = this.db.prepare(`SELECT id,project_id,verification_status,payload,created_at FROM knowledge_lessons
      WHERE lower(phenomenon)=lower(?) AND sync_archived_at IS NULL ORDER BY created_at,id`).all(phenomenon);
    const evidence = this.db.prepare(`SELECT e.lesson_id,e.record_id AS recordId,e.ref,e.kind,e.created_at AS createdAt
      FROM knowledge_lesson_evidence e JOIN knowledge_lessons l ON l.id=e.lesson_id
      WHERE lower(l.phenomenon)=lower(?) AND l.sync_archived_at IS NULL AND l.verification_status!='superseded'`).all(phenomenon);
    const projects = new Map(rows.map(row => [row.id, row.project_id]));
    const sources = new Map();
    for (const row of rows) {
      const payload = JSON.parse(row.payload);
      // 升域不能抹掉历史来源，但来源台账的项目数不是事实支持项目数。
      for (const source of [...(Array.isArray(payload.sources) ? payload.sources : []),
        { projectId: row.project_id, recordIds: [], firstAt: row.created_at, lastAt: row.created_at }]) {
        if (typeof source?.projectId !== 'string' || !source.projectId.trim()) continue;
        const prior = sources.get(source.projectId);
        sources.set(source.projectId, { projectId: source.projectId,
          recordIds: [...new Set([...(prior?.recordIds ?? []), ...(Array.isArray(source.recordIds) ? source.recordIds.filter(id => typeof id === 'string') : [])])].sort(),
          firstAt: [prior?.firstAt, source.firstAt, row.created_at].filter(Boolean).sort()[0],
          lastAt: [prior?.lastAt, source.lastAt, row.created_at].filter(Boolean).sort().at(-1) });
      }
    }
    const owners = new Map();
    const facts = evidence.filter(executionEvidence);
    for (const item of facts) {
      for (const key of [`record:${item.recordId}`, `ref:${item.ref}`]) {
        if (!owners.has(key)) owners.set(key, new Set());
        owners.get(key).add(projects.get(item.lesson_id));
      }
    }
    const supported = new Map();
    for (const item of evidence) {
      const source = sources.get(projects.get(item.lesson_id));
      if (source) source.recordIds = [...new Set([...source.recordIds, item.recordId])].sort();
    }
    for (const item of facts) {
      if (owners.get(`record:${item.recordId}`).size !== 1 || owners.get(`ref:${item.ref}`).size !== 1) continue;
      const project = projects.get(item.lesson_id);
      const stamp = item.createdAt;
      if (!supported.has(project) || stamp < supported.get(project)) supported.set(project, stamp);
    }
    const reproduced = supported.size >= 2 && supported.has(originProjectId);
    return { sources: [...sources.values()].sort((a,b) => a.projectId.localeCompare(b.projectId)),
      supportedByProjects: [...supported.keys()].sort(), supportProjects: supported.size, reproduced,
      ...(reproduced ? { reproducedAt: [...supported.values()].sort()[1] } : {}) };
  }

  /** 同一现象的项目级经验行：按项目各自成行后，同现象会有多行（每个项目一行）。 */
  lessonsByPhenomenon(phenomenon, { layer = 'project' } = {}) {
    const flat = safeText(phenomenon,400,'lesson phenomenon',true);
    valid(['project','domain'].includes(layer),'Invalid lesson scope layer');
    return this.db.prepare(`SELECT id FROM knowledge_lessons
      WHERE lower(phenomenon)=lower(?) AND scope_layer=? AND sync_archived_at IS NULL ORDER BY created_at,id`).all(flat,layer)
      .map((row)=>this.getLesson(row.id));
  }

  /** 按规范化现象找最早的一条经验：读路径用（例如「这条现象以前出现过吗」）。 */
  lessonByPhenomenon(phenomenon, { layer = '' } = {}) {
    const flat = safeText(phenomenon,400,'lesson phenomenon',true);
    const where = ['lower(phenomenon)=lower(?)', 'sync_archived_at IS NULL'];
    const params = [flat];
    if (layer) {
      valid(['project','domain'].includes(layer),'Invalid lesson scope layer');
      where.push('scope_layer=?');
      params.push(layer);
    }
    const row = this.db.prepare(`SELECT id FROM knowledge_lessons WHERE ${where.join(' AND ')}
      ORDER BY created_at,id LIMIT 1`).get(...params);
    return row ? this.getLesson(row.id) : null;
  }

  /**
   * 复现台账（写，P0-1）：把同一现象的项目级经验行归成一组，每一行都写上同一份
   * sources / supportProjects / reproduced。不合并、不删除经验正文；来源和当前支持证据
   * 分别派生，让任一项目都能查回整组来源，又不会把复制的灵感计为复现。
   *
   * 每个项目自己的记录 ID 从该行证据表推出（按项目聚合、去重），不把别的项目的证据复制过来。
   */
  syncLessonReproduction(phenomenon, { layer = 'project' } = {}) {
    const peers = this.lessonsByPhenomenon(phenomenon, { layer });
    if (!peers.length) return [];
    const write = this.db.prepare('UPDATE knowledge_lessons SET payload=?,payload_hash=? WHERE id=?');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for(const peer of peers) {
        let payload = {};
        try { payload = JSON.parse(this.db.prepare('SELECT payload,sync_archived_at FROM knowledge_lessons WHERE id=?').get(peer.id)?.payload ?? '{}') ?? {}; } catch { payload = {}; }
        const { reproducedAt: _oldReproducedAt, ...current } = payload;
        const next = {
          ...current,
          ...this.lessonReproductionState(phenomenon, peer.projectId)
        };
        const body = canonical(next);
        write.run(body,sha256(body),peer.id);
      }
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
    return peers.map((peer)=>this.getLesson(peer.id));
  }

  /**
   * 把项目级经验升为域级（#56）：显式操作，不自动发生。
   * - scope.layer 变 domain、scope.projectId 清空；行上的 project_id 仍保留最早来源项目；
   * - 来源项目台账（payload.sources）原样保留，升域不丢「它来自哪些项目」；
   * - 去重键按合约公式换成域级键（现象 + domain + 无项目），域层不会被认成项目级那条；
   * - 不碰 verificationStatus：升域不等于验证，验证仍由人确认。
   */
  promoteLessonToDomain(lessonId, { domainIds = [] } = {}) {
    const id = safeText(lessonId,90,'lesson id',true);
    valid(Array.isArray(domainIds),'Lesson domain ids must be an array');
    const row = this.db.prepare('SELECT payload,project_id,scope_layer,sync_archived_at FROM knowledge_lessons WHERE id=?').get(id);
    valid(Boolean(row),'Lesson not found');
    valid(!row.sync_archived_at,'这条经验已归档，请先恢复后再修改。');
    let payload = {};
    try { payload = JSON.parse(row.payload) ?? {}; } catch { payload = {}; }
    const stamp = now();
    // 来源台账缺失时按行上的来源项目补一条：升级不能把唯一的来源信息洗掉。
    const rawSources = Array.isArray(payload.sources) ? payload.sources.filter((source) => source && typeof source.projectId === 'string') : [];
    const sources = rawSources.length
      ? rawSources.map((source) => ({
          projectId: source.projectId,
          recordIds: [...new Set((Array.isArray(source.recordIds) ? source.recordIds : []).map(String))],
          firstAt: source.firstAt ?? payload.createdAt ?? stamp,
          lastAt: source.lastAt ?? source.firstAt ?? payload.createdAt ?? stamp
        }))
      : [{
          projectId: row.project_id,
          recordIds: payload.sourceRecordId ? [String(payload.sourceRecordId)] : [],
          firstAt: payload.createdAt ?? stamp,
          lastAt: payload.createdAt ?? stamp
        }];
    sources.sort((a,b)=>a.projectId.localeCompare(b.projectId));
    const existingDomains = Array.isArray(payload.scope?.domainIds) ? payload.scope.domainIds : [];
    const mergedDomains = [...new Set([...existingDomains, ...domainIds])];
    valid(mergedDomains.length <= 20,'Invalid lesson scope domainIds');
    for (const domain of mergedDomains) requireId(domain,'domain ID');
    const dedupeKey = sha256(canonical({
      contract:'lesson/v1',
      phenomenon:String(payload.phenomenon ?? '').toLowerCase(),
      layer:'domain',
      projectId:null
    }));
    const reproduction = this.lessonReproductionState(payload.phenomenon, row.project_id);
    const { reproducedAt: _oldReproducedAt, ...current } = payload;
    const next = {
      ...current,
      scope: { layer:'domain', projectId:null, domainIds:mergedDomains },
      originProjectId: payload.originProjectId ?? payload.projectId ?? row.project_id,
      // 记下升级前的作用域，事后仍能解释这条经验最初来自哪个项目。
      promotedFrom: payload.promotedFrom ?? { layer: row.scope_layer ?? 'project', projectId: row.project_id },
      promotedAt: payload.promotedAt ?? stamp,
      ...reproduction,
      sources
    };
    const body = canonical(next);
    this.db.prepare(`UPDATE knowledge_lessons SET payload=?,payload_hash=?,scope_layer='domain',dedupe_key=? WHERE id=?`)
      .run(body,sha256(body),dedupeKey,id);
    return this.getLesson(id);
  }

  /** 这条经验的来源项目台账：升域后仍从这里查「它来自哪些项目」。 */
  lessonSources(lessonId) {
    const id = safeText(lessonId,90,'lesson id',true);
    const row = this.db.prepare('SELECT project_id,payload,scope_layer FROM knowledge_lessons WHERE id=?').get(id);
    if(!row) return null;
    let payload = {};
    try { payload = JSON.parse(row.payload) ?? {}; } catch { payload = {}; }
    const raw = Array.isArray(payload.sources) ? payload.sources : [];
    const sources = raw.length
      ? raw.map((source)=>({
          projectId: String(source.projectId),
          recordIds: (Array.isArray(source.recordIds) ? source.recordIds : []).map(String),
          firstAt: source.firstAt ?? null,
          lastAt: source.lastAt ?? null
        }))
      : [{
          projectId: row.project_id,
          recordIds: payload.sourceRecordId ? [String(payload.sourceRecordId)] : [],
          firstAt: payload.createdAt ?? null,
          lastAt: null
        }];
    const current = this.getLesson(id);
    return {
      lessonId: id,
      projects: sources.map((source)=>source.projectId),
      projectCount: sources.length,
      sources,
      reproduced: current.reproduced,
      supportProjects: current.supportProjects,
      scopeLayer: payload.scope?.layer ?? row.scope_layer
    };
  }

  /**
   * 按项目查经验：除行上的 project_id 外，也认来源台账里的项目。
   * 跨项目合并后经验行只挂在最早项目下，第二个项目（以及升域后的所有来源项目）靠这里反查。
   */
  listLessonsForProject(projectId, { limit = 100 } = {}) {
    const project = safeText(projectId,90,'project id',true);
    if(!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new KnowledgeValidationError('limit must be an integer between 1 and 500');
    }
    // 经验是本地几百条的规模，整表读一遍再按来源台账过滤；不额外加索引也不用 JSON 函数。
    const rows = this.db.prepare(`SELECT id,project_id,payload FROM knowledge_lessons WHERE sync_archived_at IS NULL
      ORDER BY created_at DESC,id DESC LIMIT ?`).all(500);
    return rows.map(row => this.getLesson(row.id)).filter(lesson => lesson.projectId === project
      || lesson.sources.some(source => source.projectId === project)).slice(0,limit);
  }

  // ---- 三层沉淀：冲突与争议（#57） ----
  // 冲突判定看三个字段：规范化现象、作用域（层 + 项目或域集合）、对策。
  // 同一现象 + 同一作用域 + 对策不同 → 争议（disputed），两条都留着等人裁决；
  // 域级与项目级并列时默认查询以域级为准，项目级仍可单查，不删不藏。
  // P0-2 之后状态只存 verification_status 一列（含 disputed / superseded），
  // payload.dispute 只记裁决过程（谁和谁争、谁裁的、裁决前是什么状态）。

  /** 冲突判定用的文本规范化：压平空白、去首尾引号与句尾标点、小写。 */
  lessonConflictText(value) {
    return flatText(value)
      .replace(/^["'“”‘’「」『』]+/u, '')
      .replace(/["'“”‘’「」『』。．.，,；;：:、]+$/u, '')
      .toLowerCase();
  }

  /** 经验的作用域层：只有显式 domain 才算域级，其余一律按项目级。 */
  lessonScopeLayer(lesson) {
    return lesson?.scope?.layer === 'domain' ? 'domain' : 'project';
  }

  /** 作用域身份：项目级按项目，域级按域集合；跨层的两条不互为「同级冲突」。 */
  lessonScopeKey(lesson) {
    if(this.lessonScopeLayer(lesson) === 'domain') {
      const domains = (lesson?.scope?.domainIds ?? []).map(String).sort();
      return `domain|${domains.join(',')}`;
    }
    return `project|${String(lesson?.scope?.projectId ?? lesson?.projectId ?? '')}`;
  }

  /**
   * 经验的有效状态（P0-2）：只有一列，读也只认这一处。
   * 争议与已被取代也是这一列上的取值，不再从 payload.dispute 里推。
   */
  lessonStatusOf(lesson) {
    return readLessonStatus(lesson);
  }

  /** 按 ID 读一条经验的有效状态（含争议 / 已被取代）。 */
  lessonStatus(lessonId) {
    const id = safeText(lessonId,90,'lesson id',true);
    const lesson = this.getLesson(id);
    valid(Boolean(lesson),'Lesson not found');
    return this.lessonStatusOf(lesson);
  }

  /**
   * 争议状态（读）：人能据此看到「谁和谁有争议、裁决到哪一步」。
   * status ∈ none / disputed / resolved / superseded。
   * 当前状态取自那一列；「resolved」表示裁决过且赢家已回到裁决前的状态。
   */
  lessonDispute(lessonId) {
    const id = safeText(lessonId,90,'lesson id',true);
    const lesson = this.getLesson(id);
    valid(Boolean(lesson),'Lesson not found');
    const dispute = lesson.dispute && typeof lesson.dispute === 'object' ? lesson.dispute : {};
    const current = this.lessonStatusOf(lesson);
    const status = current === 'superseded'
      ? 'superseded'
      : current === 'disputed'
        ? 'disputed'
        : dispute.resolution
          ? 'resolved'
          : 'none';
    return {
      lessonId:id,
      status,
      disputed:status === 'disputed',
      reason:dispute.reason ?? '',
      actor:dispute.actor ?? null,
      openedAt:dispute.openedAt ?? null,
      resolvedAt:dispute.resolvedAt ?? null,
      peerIds:Array.isArray(dispute.peerIds) ? [...dispute.peerIds] : [],
      winnerId:dispute.resolution?.winnerId ?? dispute.winnerId ?? null,
      supersededBy:lesson.supersededBy ?? null,
      supersededAt:lesson.supersededAt ?? null
    };
  }

  /**
   * 冲突分组（读）：同一现象 + 同一作用域 + 对策不同的经验归成一组。
   * 已被取代的不参与分组（它们已经裁决过）；未标争议的也会被列出来，供人一键标争议。
   */
  lessonConflicts({ projectId = '', domainIds = [], limit = 200 } = {}) {
    const project = projectId ? safeText(projectId,90,'project id',true) : '';
    valid(Array.isArray(domainIds),'Lesson domain ids must be an array');
    const wantedDomains = [...new Set(domainIds.map((domain)=>safeText(String(domain),80,'domain id',true)))];
    const cap = Math.min(Math.max(1,Number(limit) || 200),1000);
    const groups = new Map();
    for(const lesson of this.listLessons({ limit: cap })) {
      if(this.lessonStatusOf(lesson) === 'superseded') continue;
      const layer = this.lessonScopeLayer(lesson);
      const domains = (lesson.scope?.domainIds ?? []).map(String);
      if(project && layer === 'project' && (lesson.scope?.projectId ?? lesson.projectId) !== project) continue;
      if(layer === 'domain' && wantedDomains.length && !domains.some((domain)=>wantedDomains.includes(domain))) continue;
      const key = `${this.lessonScopeKey(lesson)}|${this.lessonConflictText(lesson.phenomenon)}`;
      const group = groups.get(key) ?? { scopeLayer:layer, lessons:[], countermeasures:[] };
      group.lessons.push(lesson);
      const countermeasure = this.lessonConflictText(lesson.countermeasure);
      if(countermeasure && !group.countermeasures.includes(countermeasure)) group.countermeasures.push(countermeasure);
      groups.set(key,group);
    }
    return [...groups.values()]
      .filter((group)=>group.countermeasures.length > 1)
      .map((group)=>({
        phenomenon:group.lessons[0].phenomenon,
        scope:{
          layer:group.scopeLayer,
          projectId:group.scopeLayer === 'project' ? (group.lessons[0].scope?.projectId ?? group.lessons[0].projectId ?? null) : null,
          domainIds:[...(group.lessons[0].scope?.domainIds ?? [])]
        },
        lessonIds:group.lessons.map((lesson)=>lesson.id),
        countermeasures:group.lessons.map((lesson)=>lesson.countermeasure),
        lessons:group.lessons,
        disputed:group.lessons.every((lesson)=>this.lessonStatusOf(lesson) === 'disputed')
      }));
  }

  /**
   * 标争议（写）：只接受同一现象、同一作用域、对策确实不同的经验。
   * 状态写进 verification_status 列（disputed），payload.dispute 只留裁决过程与
   * 「争议前是什么状态」，把两条原样留着等人裁决。
   */
  markLessonsDisputed(lessonIds, { reason = '', actor = 'user' } = {}) {
    valid(Array.isArray(lessonIds) && lessonIds.length >= 1 && lessonIds.length <= 20,
      'Lesson ids must be an array of 1 to 20 ids');
    const ids = [...new Set(lessonIds.map((id)=>safeText(id,90,'lesson id',true)))];
    const rows = ids.map((id)=>{
      const row = this.db.prepare('SELECT payload,verification_status,sync_archived_at FROM knowledge_lessons WHERE id=?').get(id);
      valid(Boolean(row),'Lesson not found');
    valid(!row.sync_archived_at,'这条经验已归档，请先恢复后再修改。');
      let payload = {};
      try { payload = JSON.parse(row.payload) ?? {}; } catch { payload = {}; }
      return { id, payload, status: row.verification_status ?? 'inferred' };
    });
    valid(rows.length >= 2,'A dispute needs at least two lessons');
    const scopeKey = this.lessonScopeKey(rows[0].payload);
    const phenomenon = this.lessonConflictText(rows[0].payload.phenomenon);
    for(const row of rows) {
      valid(this.lessonScopeKey(row.payload) === scopeKey,'Disputed lessons must share one scope');
      valid(this.lessonConflictText(row.payload.phenomenon) === phenomenon,'Disputed lessons must share one phenomenon');
    }
    valid(new Set(rows.map((row)=>this.lessonConflictText(row.payload.countermeasure))).size > 1,
      'Disputed lessons must differ in countermeasure');
    const stamp = now();
    const text = reason ? safeText(reason,500,'dispute reason') : '同一现象、同一作用域出现不同对策';
    const who = safeText(String(actor ?? 'user'),90,'dispute actor',true);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for(const row of rows) {
        const previous = row.payload.dispute && typeof row.payload.dispute === 'object' ? row.payload.dispute : {};
        const next = lessonPayloadBody({
          ...row.payload,
          dispute:{
            reason:text,
            actor:who,
            openedAt:previous.openedAt ?? stamp,
            // 裁决后要恢复到的状态：争议本身不是一次验证，定位只是「暂挂」。
            priorStatus:previous.priorStatus ?? row.status,
            peerIds:rows.filter((item)=>item.id !== row.id).map((item)=>item.id)
          }
        });
        const body = canonical(next);
        this.db.prepare('UPDATE knowledge_lessons SET payload=?,payload_hash=?,verification_status=? WHERE id=?')
          .run(body,sha256(body),'disputed',row.id);
      }
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
    return ids.map((id)=>this.getLesson(id));
  }

  /**
   * 裁决入口（写）：人标某条为准，另一条落为「已被取代」。
   * - 赢家状态回到争议前的值（裁决不等于验证，不会顺手升为 verified）；
   * - 输家状态写 superseded，留下 supersededBy，payload 与证据都在，仍可单独查到；
   * - 两条都还在库里，只是默认检索不再把输家当建议。
   */
  resolveLessonDispute(winnerId, loserId, { actor = 'user', note = '' } = {}) {
    const winner = safeText(winnerId,90,'lesson id',true);
    const loser = safeText(loserId,90,'lesson id',true);
    valid(winner !== loser,'A lesson cannot supersede itself');
    const load = (id)=>{
      const row = this.db.prepare('SELECT payload,sync_archived_at FROM knowledge_lessons WHERE id=?').get(id);
      valid(Boolean(row),'Lesson not found');
    valid(!row.sync_archived_at,'这条经验已归档，请先恢复后再修改。');
      try { return JSON.parse(row.payload) ?? {}; } catch { return {}; }
    };
    const winnerPayload = load(winner);
    const loserPayload = load(loser);
    valid(this.lessonScopeKey(winnerPayload) === this.lessonScopeKey(loserPayload),'Resolved lessons must share one scope');
    valid(this.lessonConflictText(winnerPayload.phenomenon) === this.lessonConflictText(loserPayload.phenomenon),
      'Resolved lessons must share one phenomenon');
    valid(this.lessonConflictText(winnerPayload.countermeasure) !== this.lessonConflictText(loserPayload.countermeasure),
      'Resolved lessons do not conflict');
    const stamp = now();
    const who = safeText(String(actor ?? 'user'),90,'dispute actor',true);
    const memo = note ? safeText(note,500,'dispute note') : '';
    const winnerPrior = winnerPayload.dispute && typeof winnerPayload.dispute === 'object' ? winnerPayload.dispute : {};
    const loserPrior = loserPayload.dispute && typeof loserPayload.dispute === 'object' ? loserPayload.dispute : {};
    // 争议前的状态记在 dispute.priorStatus；旧数据没有这个字段时按最保守的 inferred 恢复。
    const winnerStatus = readLessonStatus({ verificationStatus: winnerPrior.priorStatus });
    const winnerNext = lessonPayloadBody({
      ...winnerPayload,
      dispute:{
        reason:winnerPrior.reason ?? '同一现象、同一作用域出现不同对策',
        actor:who,
        openedAt:winnerPrior.openedAt ?? stamp,
        resolvedAt:stamp,
        priorStatus:winnerStatus,
        peerIds:[loser],
        resolution:{ winnerId:winner, loserId:loser, note:memo }
      }
    });
    const loserNext = lessonPayloadBody({
      ...loserPayload,
      dispute:{
        reason:loserPrior.reason ?? winnerPrior.reason ?? '同一现象、同一作用域出现不同对策',
        actor:who,
        openedAt:loserPrior.openedAt ?? stamp,
        resolvedAt:stamp,
        priorStatus:loserPrior.priorStatus ?? loserPrior.status ?? 'inferred',
        peerIds:[winner],
        winnerId:winner
      },
      supersededBy:winner,
      supersededAt:stamp
    });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const write = this.db.prepare('UPDATE knowledge_lessons SET payload=?,payload_hash=?,verification_status=? WHERE id=?');
      for(const [id,payload,status] of [[winner,winnerNext,winnerStatus],[loser,loserNext,'superseded']]) {
        const body = canonical(payload);
        write.run(body,sha256(body),status,id);
      }
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
    return { winner:this.getLesson(winner), loser:this.getLesson(loser) };
  }

  /**
   * 冲突感知的写入口（#57）：提炼统一走这里。
   * - 同现象同作用域但对策不同：单独成行，双方都标争议，等裁决；
   * - 对策相同：照旧并进已有经验（#55 的证据累加 / #56 的跨项目复现合并）；
   * - 没有同现象同作用域的经验：照旧新建。
   */
  recordLessonOrDispute(lesson, { evidence = [] } = {}) {
    valid(lesson && typeof lesson === 'object' && !Array.isArray(lesson),'Lesson must be an object');
    valid(Array.isArray(evidence),'Lesson evidence must be an array');
    const projectId = safeText(lesson.projectId,90,'lesson project id',true);
    const phenomenon = safeText(lesson.phenomenon,200,'lesson phenomenon',true);
    const layer = lesson.scope?.layer ?? 'project';
    valid(['project','domain'].includes(layer),'Invalid lesson scope layer');
    const candidate = {
      ...lesson,
      projectId,
      phenomenon,
      scope:{
        layer,
        projectId:layer === 'domain' ? null : (lesson.scope?.projectId ?? projectId),
        domainIds:Array.isArray(lesson.scope?.domainIds) ? [...lesson.scope.domainIds] : []
      }
    };
    // 同级 = 同一现象 + 同一作用域（层 + 项目 / 域集合）；跨项目复现交给 syncLessonReproduction。
    const scopeKey = this.lessonScopeKey(candidate);
    const phenomenonKey = this.lessonConflictText(phenomenon);
    const peers = this.listLessons({ limit:1000 }).filter((item)=>
      this.lessonStatusOf(item) !== 'superseded'
      && this.lessonScopeKey(item) === scopeKey
      && this.lessonConflictText(item.phenomenon) === phenomenonKey);
    const sameCountermeasure = peers.filter((item)=>
      this.lessonConflictText(item.countermeasure) === this.lessonConflictText(lesson.countermeasure));
    // 已有同对策的经验：先把证据并进去；同级若已有别的对策，整个作用域标争议。
    if(sameCountermeasure.length) {
      const stored = this.appendLessonEvidence(sameCountermeasure[0].id, lesson, evidence);
      const contested = new Set(peers.map((item)=>this.lessonConflictText(item.countermeasure)));
      if(peers.length > 1 && contested.size > 1) {
        this.markLessonsDisputed(peers.map((item)=>item.id),
          { reason:'同一现象、同一作用域出现不同对策', actor:'system' });
      }
      const synced = this.syncLessonReproduction(phenomenon)
        .find((item)=>item.id === stored.id) ?? stored;
      return { ...synced, support:this.lessonSupport(synced.id) };
    }
    // 没有同级经验：按项目新建（或命中本项目的去重键后追加证据），再同步跨项目复现台账。
    if(peers.length === 0) {
      const stored = this.recordLesson(lesson, { evidence });
      const synced = this.syncLessonReproduction(phenomenon)
        .find((item)=>item.id === stored.id) ?? stored;
      return { ...synced, support:this.lessonSupport(synced.id) };
    }
    // 同级出现新对策：另起一行、双方标争议，不自动覆盖、不自动合并。
    const stored = this.addLesson(candidate, { evidence });
    this.syncLessonReproduction(phenomenon);
    this.markLessonsDisputed([...peers.map((item)=>item.id), stored.id],
      { reason:'同一现象、同一作用域出现不同对策', actor:'system' });
    const merged = this.getLesson(stored.id);
    return { ...merged, support:this.lessonSupport(merged.id) };
  }

  /**
   * 默认查询（#57）：域级覆盖项目级。
   * - 同一现象在域级与项目级同时存在时，effective 只给域级；
   * - 被覆盖的项目级不删不藏，原样放进 overridden（也仍可用 listLessons / listLessonsForProject 单查）；
   * - 已被取代（superseded）不进 effective，单独列在 superseded；
   * - 争议（disputed）留在 effective，由检索排到最后。
   */
  listEffectiveLessons({ projectId = '', domainIds = [], limit = 200 } = {}) {
    const project = projectId ? safeText(projectId,90,'project id',true) : '';
    valid(Array.isArray(domainIds),'Lesson domain ids must be an array');
    const wantedDomains = [...new Set(domainIds.map((domain)=>safeText(String(domain),80,'domain id',true)))];
    const cap = Math.min(Math.max(1,Number(limit) || 200),1000);
    const projectLessons = project
      ? this.listLessons({ projectId:project, limit:cap }).filter((item)=>this.lessonScopeLayer(item) === 'project')
      : [];
    const domainLessons = wantedDomains.length
      ? this.listLessons({ limit:cap }).filter((item)=>this.lessonScopeLayer(item) === 'domain'
        && (item.scope?.domainIds ?? []).some((domain)=>wantedDomains.includes(String(domain))))
      : [];
    const superseded = [...projectLessons, ...domainLessons]
      .filter((item)=>this.lessonStatusOf(item) === 'superseded');
    const supersededIds = new Set(superseded.map((item)=>item.id));
    const domainIndex = new Map();
    const effective = [];
    for(const item of domainLessons) {
      if(supersededIds.has(item.id)) continue;
      effective.push({ ...item, effectiveStatus:this.lessonStatusOf(item) });
      const key = this.lessonConflictText(item.phenomenon);
      if(!domainIndex.has(key)) domainIndex.set(key,item);
    }
    const overridden = [];
    for(const item of projectLessons) {
      if(supersededIds.has(item.id)) continue;
      const peer = domainIndex.get(this.lessonConflictText(item.phenomenon));
      if(peer) {
        overridden.push({
          ...item,
          overriddenBy:peer.id,
          overriddenReason:'domain-precedence',
          sameCountermeasure:this.lessonConflictText(peer.countermeasure) === this.lessonConflictText(item.countermeasure)
        });
        continue;
      }
      effective.push({ ...item, effectiveStatus:this.lessonStatusOf(item) });
    }
    return { project:projectLessons, domain:domainLessons, effective, overridden, superseded };
  }

  // ---- 决策（#87）：知识的一种，状态单独一列 ----
  // 决策沿用知识表（personal_units），但它的状态机是「生效中 / 已被取代 / 已放弃」，
  // 与「待验证 / 已验证」分开存在 decision_status 列上。下面这些方法只读/只写这一列，
  // 绝不把决策状态写进 verificationStatus（那会出现「生效中的知识」这种自相矛盾的值）。

  /** 按项目读决策；默认连结束状态一起返回（界面要能看见「这条已不算现状」）。 */
  listDecisions({ projectId = '', includeEnded = true, limit = 200 } = {}) {
    const project = projectId ? safeText(projectId,90,'project id',true) : '';
    const cap = Math.min(Math.max(1, Number(limit) || 200), 2000);
    return this.db.prepare('SELECT * FROM personal_units WHERE sync_archived_at IS NULL ORDER BY updated_at DESC,id LIMIT ?').all(2000)
      .map(rowToItem)
      .filter((row) => row.kind === DECISION_KIND)
      // 项目级决策按项目过滤；域级决策对所有项目可见（升域是显式动作，见下）。
      .filter((row) => !project || row.scope !== 'project' || row.projectId === project)
      .filter((row) => includeEnded || !isEndedDecisionStatus(row.decisionStatus))
      .slice(0, cap);
  }

  /** 按指纹找已确认的决策：确认是幂等的，同一句话不会写第二条。 */
  decisionByFingerprint(fingerprint) {
    const key = safeText(fingerprint,128,'decision fingerprint',true);
    const row = this.db.prepare('SELECT * FROM personal_units ORDER BY created_at,id LIMIT 2000').all()
      .map(rowToItem)
      .find((item) => item.kind === DECISION_KIND && item.decision?.fingerprint === key);
    return row ?? null;
  }

  /** 已确认决策的指纹：会话扫描据此跳过已入库的那条，不再反复提议。 */
  decisionFingerprints() {
    return [...new Set(this.db.prepare('SELECT * FROM personal_units LIMIT 2000').all()
      .map(rowToItem)
      .filter((row) => row.kind === DECISION_KIND)
      .map((row) => row.decision?.fingerprint)
      .filter((value) => typeof value === 'string' && value))];
  }

  /**
   * 结束一条生效中的决策：标为「已被取代 / 已放弃」。
   * - 只改 decision_status 列，verificationStatus 原样不动；
   * - 状态变更记进 payload.decision.history，并追加一版修订，事后能解释什么时候改的；
   * - 结束状态是终态，不提供改回生效中（要重新采用请另记一条新决策）。
   */
  setDecisionStatus(id, status, { actor = 'user', note = '' } = {}) {
    const existing = this.get(id);
    valid(Boolean(existing),'Knowledge not found');
    valid(!existing.syncArchivedAt,'这条记忆已归档，请先恢复后再修改。');
    valid(existing.kind === DECISION_KIND,'Only decision knowledge carries a decision status');
    const from = normalizeDecisionStatus(existing.decisionStatus) || DEFAULT_DECISION_STATUS;
    const verdict = decisionStatusChange(from, status);
    valid(verdict.ok, verdict.message || 'Invalid decision status change');
    const stamp = now();
    const who = safeText(String(actor ?? 'user'),80,'actor',true);
    const memo = note ? safeText(note,500,'note') : '';
    const previous = existing.decision && typeof existing.decision === 'object' ? existing.decision : {};
    const nextDecision = {
      ...previous,
      history:[...(Array.isArray(previous.history) ? previous.history : []),
        { from, to:status, at:stamp, actor:who, note:memo }],
      ...(status === 'superseded' ? { supersededAt:stamp } : {}),
      ...(status === 'abandoned' ? { abandonedAt:stamp } : {})
    };
    // 走同一套 normalize：内容字段与证据不变，只换状态与决策信息。
    const normalized = normalize({ ...existing, decisionStatus:status, decision:nextDecision }, existing);
    const body = canonical(unitPayloadBody(normalized));
    const rev = existing.revision + 1;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE personal_units SET revision=?,payload=?,updated_at=?,decision_status=? WHERE id=?')
        .run(rev,body,stamp,normalized.decisionStatus,id);
      this.db.prepare('INSERT INTO personal_revisions(unit_id,revision,payload,actor,note,timestamp,payload_hash) VALUES(?,?,?,?,?,?,?)')
        .run(id,rev,body,who,memo || `决策状态：${from} → ${status}`,stamp,sha256(body));
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
    return this.get(id);
  }

  /**
   * 把项目级决策升为域级（沿用 ADR-0007 的「项目级 → 域级」升级路径）：
   * - scope 变 domain、projectId 清空、layer 变 domain；行上的来源项目写进 originProjectId；
   * - 状态不因升域而变（升域不是验证，也不是裁决）；
   * - 只是显式动作，不自动发生。
   */
  promoteDecisionToDomain(id, { domainIds = [] } = {}) {
    const existing = this.get(id);
    valid(Boolean(existing),'Knowledge not found');
    valid(!existing.syncArchivedAt,'这条记忆已归档，请先恢复后再修改。');
    valid(existing.kind === DECISION_KIND,'Only decision knowledge can be promoted to a domain decision');
    valid(Array.isArray(domainIds),'Decision domain ids must be an array');
    const domains = [...new Set(domainIds.map((domain)=>safeText(String(domain),80,'domain id',true)))];
    valid(domains.length <= 20,'Invalid decision domains');
    const stamp = now();
    const next = {
      ...existing,
      scope:'domain',
      layer:'domain',
      projectId:null,
      domains,
      originProjectId: existing.originProjectId ?? existing.projectId ?? null,
      promotedFrom: existing.promotedFrom ?? { scope:existing.scope, projectId:existing.projectId ?? null },
      promotedAt: existing.promotedAt ?? stamp
    };
    return this.update(id, next, {
      expectedRevision: existing.revision,
      actor: 'user',
      note: `决策升为域级：${domains.join(', ') || '未命名域'}`
    });
  }
}
