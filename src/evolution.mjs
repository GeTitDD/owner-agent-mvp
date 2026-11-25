// P2: local, auditable knowledge-evolution ledger. No raw prompts, arguments, or tool outputs are persisted.
import { randomUUID } from 'node:crypto';
import { canonical, requireId, sha256 } from './utils.mjs';

const now = () => new Date().toISOString();
const KINDS = new Set(['invariant', 'pattern', 'anti-pattern', 'experience']);
const EVIDENCE_KINDS = new Set(['test', 'review', 'observation']);
const OUTCOMES = new Set(['passed', 'failed', 'unknown']);
const MAX_SUMMARY = 1600;
const MAX_CLAIM = 2400;

const ensureText = (value, label, max = 240) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} must be non-empty and at most ${max} characters`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error(`${label} contains control characters`);
  return value.trim();
};

// Cheap tripwire, NOT a replacement for review / DLP. Never auto-share a suggested claim.
export function rejectObviousSecrets(value) {
  // #98：脱敏占位符是「已经换掉的秘密」，不是凭据本身。先剥掉再查，否则
  // `password=…<redacted:credential>` 会继续命中赋值规则，已脱敏的会话决策反而存不进去。
  // 剥离只认固定形状 `<redacted:类型>`，真实密钥没有这种包围，检测强度不变。
  const text = (typeof value === 'string' ? value : canonical(value))
    .replace(/<redacted:[a-z-]+>/gu, '');
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk-proj|sk-ant|ghp|github_pat)_[A-Za-z0-9_-]{10,}|\b(?:password|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*[^\s,;]{8,}/i.test(text)) {
    throw new Error('Potential credential detected; do not store/share this text');
  }
}

function requireArrayOfStrings(value, label, min = 0, max = 30) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`Invalid ${label}`);
  return [...new Set(value.map((v) => ensureText(v, label, 120)))];
}

export class EvolutionStore {
  constructor(db) {
    this.db = db;
    db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS evolution_runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, branch_leaf_id TEXT NOT NULL,
        project_id TEXT NOT NULL, project_root TEXT NOT NULL, snapshot_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','settled','aborted')),
        started_at TEXT NOT NULL, settled_at TEXT
      );
      CREATE INDEX IF NOT EXISTS evolution_runs_project ON evolution_runs(project_id,started_at);
      CREATE TABLE IF NOT EXISTS evolution_tool_events (
        run_id TEXT NOT NULL REFERENCES evolution_runs(id), tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL, parent_tool_call_id TEXT,
        is_error INTEGER NOT NULL, duration_ms INTEGER,
        PRIMARY KEY(run_id,tool_call_id)
      );
      CREATE TABLE IF NOT EXISTS evolution_evidence (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES evolution_runs(id),
        kind TEXT NOT NULL, outcome TEXT NOT NULL,
        summary TEXT NOT NULL, reference TEXT NOT NULL,
        sharing_consent INTEGER NOT NULL DEFAULT 0, verification_method TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evolution_candidates (
        id TEXT PRIMARY KEY, domain_id TEXT NOT NULL, base_version TEXT NOT NULL,
        knowledge_id TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('candidate','approved','rejected','published')),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evolution_reviews (
        candidate_id TEXT PRIMARY KEY REFERENCES evolution_candidates(id),
        decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
        reviewer TEXT NOT NULL, note TEXT NOT NULL, reviewed_at TEXT NOT NULL,
        candidate_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evolution_publications (
        candidate_id TEXT PRIMARY KEY REFERENCES evolution_candidates(id),
        domain_id TEXT NOT NULL, version TEXT NOT NULL, published_at TEXT NOT NULL,
        package_hash TEXT NOT NULL
      );
    `);
  }

  beginRun({ id = randomUUID(), sessionId, branchLeafId = 'unknown', projectId, projectRoot, snapshotId }) {
    ensureText(id, 'run id', 128);
    ensureText(sessionId, 'session id', 256);
    ensureText(branchLeafId, 'branch leaf id', 256);
    requireId(projectId, 'project id');
    ensureText(projectRoot, 'project root', 2048);
    ensureText(snapshotId, 'snapshot id', 128);
    const existing = this.getRun(id);
    if (existing) {
      if (existing.session_id !== sessionId || existing.project_root !== projectRoot || existing.snapshot_id !== snapshotId) throw new Error('Run ID collision');
      return id;
    }
    this.db.prepare(`INSERT INTO evolution_runs(id,session_id,branch_leaf_id,project_id,project_root,snapshot_id,status,started_at)
      VALUES(?,?,?,?,?,?,'running',?)`).run(id, sessionId, branchLeafId, projectId, projectRoot, snapshotId, now());
    return id;
  }

  getRun(id) { return this.db.prepare('SELECT * FROM evolution_runs WHERE id=?').get(id) ?? null; }

  listRuns(projectId, limit = 20) {
    if (projectId) return this.db.prepare('SELECT * FROM evolution_runs WHERE project_id=? ORDER BY started_at DESC,id DESC LIMIT ?').all(projectId, limit);
    return this.db.prepare('SELECT * FROM evolution_runs ORDER BY started_at DESC,id DESC LIMIT ?').all(limit);
  }

  recordTool({ runId, toolCallId, toolName, parentToolCallId = null, isError = false, durationMs = null }) {
    const run = this.getRun(runId);
    if (!run || run.status !== 'running') throw new Error('Cannot record tool event without a running run');
    ensureText(toolCallId, 'tool call id', 256);
    ensureText(toolName, 'tool name', 128);
    if (parentToolCallId !== null) ensureText(parentToolCallId, 'parent tool call id', 256);
    if (durationMs !== null && (!Number.isSafeInteger(durationMs) || durationMs < 0)) throw new Error('Invalid tool duration');
    // Upsert is idempotent on repeated callback delivery. No arguments/results are stored.
    this.db.prepare(`INSERT INTO evolution_tool_events(run_id,tool_call_id,tool_name,parent_tool_call_id,is_error,duration_ms)
      VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,tool_call_id) DO UPDATE SET
      is_error=excluded.is_error,duration_ms=excluded.duration_ms`).run(runId, toolCallId, toolName, parentToolCallId, isError ? 1 : 0, durationMs);
  }

  settleRun(runId, { aborted = false } = {}) {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    const expected = aborted ? 'aborted' : 'settled';
    if (run.status !== 'running' && run.status !== expected) throw new Error('Conflicting run outcome');
    if (run.status === expected) return run;
    this.db.prepare('UPDATE evolution_runs SET status=?,settled_at=? WHERE id=?').run(expected, now(), runId);
    return this.getRun(runId);
  }

  getRunTrace(runId) {
    const run = this.getRun(runId);
    if (!run) return null;
    return {
      ...run,
      tools: this.db.prepare('SELECT tool_call_id,tool_name,parent_tool_call_id,is_error,duration_ms FROM evolution_tool_events WHERE run_id=? ORDER BY tool_call_id').all(runId)
    };
  }

  addEvidence(input) {
    const run = this.getRun(input.runId);
    if (!run || run.status !== 'settled') throw new Error('Evidence requires a settled (non-aborted) run');
    if (!EVIDENCE_KINDS.has(input.kind)) throw new Error('Invalid evidence kind');
    if (!OUTCOMES.has(input.outcome)) throw new Error('Invalid evidence outcome');
    const summary = ensureText(input.summary, 'evidence summary', MAX_SUMMARY);
    const reference = ensureText(input.reference, 'verification reference', 320);
    rejectObviousSecrets({ summary, reference });
    const method = input.verificationMethod ?? 'manual';
    if (!['manual', 'node-test'].includes(method)) throw new Error('Invalid verification method');
    const id = input.id ?? randomUUID();
    ensureText(id, 'evidence id', 128);
    this.db.prepare('INSERT INTO evolution_evidence(id,run_id,kind,outcome,summary,reference,sharing_consent,verification_method,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, input.runId, input.kind, input.outcome, summary, reference, input.sharingConsent === true ? 1 : 0, method, now());
    return this.getEvidence(id);
  }

  getEvidence(id) { return this.db.prepare('SELECT * FROM evolution_evidence WHERE id=?').get(id) ?? null; }

  propose(input) {
    const domainId = requireId(input.domainId, 'domain id');
    const baseVersion = requireId(input.baseVersion, 'domain version');
    const knowledgeId = requireId(input.knowledgeId, 'knowledge id');
    if (!KINDS.has(input.kind)) throw new Error('Invalid knowledge kind');
    const title = ensureText(input.title, 'title', 200);
    const claim = ensureText(input.claim, 'claim', MAX_CLAIM);
    const keywords = requireArrayOfStrings(input.keywords, 'keywords', 1, 20);
    const evidenceIds = requireArrayOfStrings(input.evidenceIds, 'evidence ids', 1, 30);
    const applicability = requireArrayOfStrings(input.applicability ?? [], 'applicability', 0, 20);
    const exceptions = requireArrayOfStrings(input.exceptions ?? [], 'exceptions', 0, 20);
    rejectObviousSecrets({ title, claim, keywords, applicability, exceptions });
    const evidence = evidenceIds.map((id) => this.getEvidence(id));
    if (evidence.some((x) => !x)) throw new Error('Candidate references missing evidence');
    const payload = { domainId, baseVersion, knowledgeId, kind: input.kind, title, claim, keywords, evidenceIds, applicability, exceptions };
    const method = input.verificationMethod ?? 'manual';
    if (!['manual', 'node-test'].includes(method)) throw new Error('Invalid verification method');
    const id = input.id ?? randomUUID();
    ensureText(id, 'candidate id', 128);
    const payloadJson = canonical(payload);
    this.db.prepare('INSERT INTO evolution_candidates(id,domain_id,base_version,knowledge_id,payload_json,payload_hash,status,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, domainId, baseVersion, knowledgeId, payloadJson, sha256(payloadJson), 'candidate', now());
    return this.getCandidate(id);
  }

  getCandidate(id) {
    const item = this.db.prepare('SELECT * FROM evolution_candidates WHERE id=?').get(id);
    if (!item) return null;
    return { ...item, payload: JSON.parse(item.payload_json), review: this.db.prepare('SELECT * FROM evolution_reviews WHERE candidate_id=?').get(id) ?? null };
  }

  listCandidates(status, limit = 30) {
    const rows = status
      ? this.db.prepare('SELECT id FROM evolution_candidates WHERE status=? ORDER BY created_at DESC,id DESC LIMIT ?').all(status, limit)
      : this.db.prepare('SELECT id FROM evolution_candidates ORDER BY created_at DESC,id DESC LIMIT ?').all(limit);
    return rows.map(({ id }) => this.getCandidate(id));
  }

  readiness(candidateId) {
    const candidate = this.getCandidate(candidateId);
    if (!candidate) throw new Error('Candidate not found');
    const evidence = candidate.payload.evidenceIds.map((id) => this.getEvidence(id));
    const problems = [];
    if (evidence.some((e) => !e)) problems.push('Missing evidence');
    if (evidence.some((e) => e && e.sharing_consent !== 1)) problems.push('Source evidence not approved for cross-project sharing');
    if (!evidence.some((e) => e && e.kind === 'test' && e.outcome === 'passed')) problems.push('At least one explicitly referenced passed test is required');
    if (evidence.some((e) => e && e.outcome === 'failed')) problems.push('Unresolved failed evidence');
    if (evidence.some((e) => e && this.getRun(e.run_id)?.status !== 'settled')) problems.push('Evidence from unsettled or aborted run');
    return { ready: problems.length === 0, problems, evidence, candidate };
  }

  review({ candidateId, decision, reviewer, note = '' }) {
    if (!['approve', 'reject'].includes(decision)) throw new Error('Invalid review decision');
    reviewer = ensureText(reviewer, 'reviewer', 120);
    if (typeof note !== 'string' || note.length > 1600) throw new Error('Invalid review note');
    rejectObviousSecrets(note);
    const { candidate, ready, problems } = this.readiness(candidateId);
    if (candidate.status !== 'candidate') throw new Error('Candidate has already been reviewed');
    if (decision === 'approve' && !ready) throw new Error(`Candidate not ready: ${problems.join('; ')}`);
    const status = decision === 'approve' ? 'approved' : 'rejected';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO evolution_reviews(candidate_id,decision,reviewer,note,reviewed_at,candidate_hash) VALUES(?,?,?,?,?,?)')
        .run(candidateId, status, reviewer, note, now(), candidate.payload_hash);
      this.db.prepare('UPDATE evolution_candidates SET status=? WHERE id=?').run(status, candidateId);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return this.getCandidate(candidateId);
  }

  markPublished(candidateIds, { domainId, version, packageHash }) {
    const candidates = candidateIds.map((id) => this.getCandidate(id));
    if (candidates.some((c) => !c || c.status !== 'approved' || c.domain_id !== domainId)) throw new Error('Candidates must be approved for this domain');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const candidate of candidates) {
        this.db.prepare('INSERT INTO evolution_publications(candidate_id,domain_id,version,published_at,package_hash) VALUES(?,?,?,?,?)')
          .run(candidate.id, domainId, version, now(), packageHash);
        this.db.prepare("UPDATE evolution_candidates SET status='published' WHERE id=?").run(candidate.id);
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}
