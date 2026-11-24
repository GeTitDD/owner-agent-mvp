// Personal Knowledge Workbench storage. Editable data lives alongside, but never overwrites,
// the versioned domain package files. Every mutation appends an immutable revision.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { canonical, requireId, sha256 } from './utils.mjs';
import { defaultDbPath } from './storage.mjs';
import { rejectObviousSecrets } from './evolution.mjs';

export class KnowledgeConflict extends Error { constructor(message) { super(message); this.status = 409; } }
export class KnowledgeValidationError extends Error { constructor(message) { super(message); this.status = 400; } }
const valid = (condition, message) => { if (!condition) throw new KnowledgeValidationError(message); };
const own = (obj, name) => Object.prototype.hasOwnProperty.call(obj, name);
const now = () => new Date().toISOString();
const SCOPES = new Set(['personal','domain','project']);
const LAYERS = new Set(['domain','applied','project']);
const KINDS = new Set(['note','concept','claim','hypothesis','procedure','experiment']);
const VERIFY = new Set(['unverified','verified','needs_reverification','disputed']);
const RELATIONS = new Set(['depends_on','specializes','implements','validated_by','contradicts','related_to']);
const safeText = (text,max,label,required=false) => {
  valid(typeof text === 'string' && text.length <= max && (!required || text.trim()), `${label} must be text of at most ${max} chars`);
  valid(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text), `${label} contains control characters`);
  return text.trim();
};
function stringArray(value, max, itemMax, label) {
  valid(Array.isArray(value) && value.length <= max, `Invalid ${label}`);
  const output = value.map(item => safeText(item,itemMax,label,true));
  valid(new Set(output).size === output.length, `Duplicate ${label}`);
  return output;
}
function normalize(payload, previous=null) {
  valid(payload && typeof payload === 'object' && !Array.isArray(payload), 'Knowledge must be an object');
  const item = {
    title: safeText(payload.title,200,'title',true),
    content: safeText(payload.content,25000,'content',true),
    kind: payload.kind ?? 'note',
    layer: payload.layer ?? 'applied',
    scope: payload.scope ?? 'personal',
    projectId: payload.projectId ?? null,
    domains: stringArray(payload.domains ?? [],20,80,'domains'),
    tags: stringArray(payload.tags ?? [],30,80,'tags'),
    evidenceRefs: stringArray(payload.evidenceRefs ?? [],40,500,'evidence references'),
    verificationStatus: payload.verificationStatus ?? 'unverified',
    relations: payload.relations ?? {},
    sourceRef: payload.sourceRef ?? null,
  };
  valid(KINDS.has(item.kind) && LAYERS.has(item.layer) && SCOPES.has(item.scope), 'Invalid knowledge kind/layer/scope');
  valid(VERIFY.has(item.verificationStatus), 'Invalid verification state');
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
  return {id:row.id,revision:row.revision,createdAt:row.created_at,updatedAt:row.updated_at,...JSON.parse(row.payload)};
}
export class PersonalKnowledgeStore {
  constructor(filename=defaultDbPath()) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
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
      CREATE TABLE IF NOT EXISTS knowledge_experiences (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT,
        source_run_id TEXT NOT NULL, outcome TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS knowledge_experiences_project ON knowledge_experiences(project_id,created_at DESC);
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
      CREATE TABLE IF NOT EXISTS knowledge_lessons (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_record_id TEXT NOT NULL,
        phenomenon TEXT NOT NULL, scope_layer TEXT NOT NULL CHECK(scope_layer IN ('project','domain')),
        verification_status TEXT NOT NULL CHECK(verification_status IN ('unverified','inferred')),
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
  }
  close() { this.db.close(); }
  list({q='',domain='',layer='',scope='',status='',projectId='',limit=500}={}) {
    const rows = this.db.prepare('SELECT * FROM personal_units ORDER BY updated_at DESC,id LIMIT ?').all(Math.min(Math.max(1,limit),2000));
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
  create(payload,{actor='user',note='Created'}={}) {
    const normalized=normalize(payload);
    const id=`personal.${randomUUID().replaceAll('-','').slice(0,24)}`;
    const timestamp=now();
    const body=canonical(normalized);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO personal_units(id,revision,payload,created_at,updated_at) VALUES(?,1,?,?,?)').run(id,body,timestamp,timestamp);
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
      if(existing.revision!==expectedRevision) throw new KnowledgeConflict(`Revision conflict: expected ${expectedRevision}, actual ${existing.revision}`);
      const normalized=normalize(payload,existing);
      const body=canonical(normalized),stamp=now(),next=existing.revision+1;
      this.db.prepare('UPDATE personal_units SET revision=?,payload=?,updated_at=? WHERE id=?').run(next,body,stamp,id);
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
        VALUES(?,?,?,?,'pending',?,?,?,?)`).run(id,targetId,existing?.revision ?? null,canonical(normalized),
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
  reviewProposal(id,{decision,reviewer='user',expectedRevision=null}) {
    valid(['approved','rejected'].includes(decision),'Invalid proposal decision');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const proposal=this.proposal(id);
      if(!proposal) throw new KnowledgeValidationError('Proposal not found');
      if(proposal.status!=='pending') throw new KnowledgeConflict('Proposal already reviewed');
      let appliedId=null;
      // We want a single atomic transaction. create/update use their own transactions,
      // so reproduce the minimal creation/revision operation here under the current lock.
      if(decision==='approved') {
        const existing=proposal.target_id ? this.get(proposal.target_id):null;
        if(proposal.target_id && !existing) throw new KnowledgeConflict('Target knowledge was removed');
        if (existing && (!Number.isSafeInteger(proposal.target_revision) ||
          existing.revision !== proposal.target_revision ||
          (expectedRevision !== null && existing.revision !== expectedRevision))) {
          throw new KnowledgeConflict('Target changed since proposal; review again');
        }
        if (existing && (proposal.payload.scope !== existing.scope || proposal.payload.projectId !== existing.projectId)) {
          throw new KnowledgeConflict('Proposal cannot change target scope or project ownership');
        }
        const normalized=normalize(proposal.payload,existing), body=canonical(normalized), stamp=now();
        const note=`Accepted proposal ${id}`;
        if(existing) {
          const rev=existing.revision+1;
          this.db.prepare('UPDATE personal_units SET revision=?,payload=?,updated_at=? WHERE id=?').run(rev,body,stamp,existing.id);
          this.db.prepare('INSERT INTO personal_revisions(unit_id,revision,payload,actor,note,timestamp,payload_hash) VALUES(?,?,?,?,?,?,?)').run(existing.id,rev,body,reviewer,note,stamp,sha256(body));
          appliedId=existing.id;
        } else {
          appliedId=`personal.${randomUUID().replaceAll('-','').slice(0,24)}`;
          this.db.prepare('INSERT INTO personal_units(id,revision,payload,created_at,updated_at) VALUES(?,1,?,?,?)').run(appliedId,body,stamp,stamp);
          this.db.prepare('INSERT INTO personal_revisions(unit_id,revision,payload,actor,note,timestamp,payload_hash) VALUES(?,1,?,?,?,?,?)').run(appliedId,body,reviewer,note,stamp,sha256(body));
        }
      }
      this.db.prepare('UPDATE personal_proposals SET status=?,reviewed_at=?,reviewer=?,applied_id=? WHERE id=?').run(decision,now(),safeText(reviewer,80,'reviewer',true),appliedId,id);
      this.db.exec('COMMIT');
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
    return this.proposal(id);
  }

  // ---- Knowledge Loop: Experience / Harvest / Usage / Feedback ----
  addExperience(record,{dedupeKey}={}) {
    valid(record && typeof record === 'object' && !Array.isArray(record),'Experience must be an object');
    const id = typeof record.id === 'string' && record.id ? record.id : `exp_${randomUUID().replaceAll('-','').slice(0,24)}`;
    const stamp = now();
    const body = canonical({...record,id,createdAt:record.createdAt ?? stamp});
    const key = dedupeKey ?? sha256(canonical({
      sourceRunId: record.sourceRunId, projectId: record.projectId,
      taskId: record.taskId ?? null, outcome: record.observedOutcome?.status ?? 'unknown',
      evidenceRefs: [...(record.evidenceRefs ?? [])].sort()
    }));
    try {
      this.db.prepare(`INSERT INTO knowledge_experiences(id,project_id,task_id,source_run_id,outcome,dedupe_key,created_at,payload,payload_hash)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id,record.projectId,record.taskId ?? null,record.sourceRunId,
          record.observedOutcome?.status ?? 'unknown',key,stamp,body,sha256(body));
    } catch (error) {
      if (/UNIQUE constraint/.test(error.message)) return this.experienceByDedupe(key);
      throw error;
    }
    return this.getExperience(id);
  }
  getExperience(id) {
    const row=this.db.prepare('SELECT * FROM knowledge_experiences WHERE id=?').get(id);
    return row ? {...JSON.parse(row.payload),payloadHash:row.payload_hash,dedupeKey:row.dedupe_key} : null;
  }
  experienceByDedupe(key) {
    const row=this.db.prepare('SELECT id FROM knowledge_experiences WHERE dedupe_key=?').get(key);
    return row ? this.getExperience(row.id) : null;
  }
  listExperiences({projectId='',outcome='',limit=100}={}) {
    const where=[];const params=[];
    if(projectId){where.push('project_id=?');params.push(projectId);}
    if(outcome){where.push('outcome=?');params.push(outcome);}
    const rows=this.db.prepare(`SELECT id FROM knowledge_experiences ${where.length?`WHERE ${where.join(' AND ')}`:''}
      ORDER BY created_at DESC,id DESC LIMIT ?`).all(...params,Math.min(Math.max(1,limit),1000));
    return rows.map(({id})=>this.getExperience(id));
  }
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
    valid(['unverified','inferred'].includes(verificationStatus),'Invalid lesson verification status');
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
    const payload = {...lesson,id,projectId,sourceRecordId,phenomenon,dedupeKey,createdAt:lesson.createdAt ?? stamp};
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
    return {...JSON.parse(row.payload),payloadHash:row.payload_hash,dedupeKey:row.dedupe_key,evidence:this.lessonEvidence(row.id)};
  }
  lessonEvidence(lessonId) {
    return this.db.prepare('SELECT * FROM knowledge_lesson_evidence WHERE lesson_id=? ORDER BY ref,id').all(lessonId)
      .map((row)=>({id:row.id,lessonId:row.lesson_id,recordId:row.record_id,ref:row.ref,kind:row.kind,
        excerpt:row.excerpt,contentHash:row.content_hash,createdAt:row.created_at}));
  }
  listLessons({projectId='',verificationStatus='',sourceRecordId='',limit=100}={}) {
    const where=[];const params=[];
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
    const row = this.db.prepare('SELECT id FROM knowledge_lessons WHERE dedupe_key=? ORDER BY created_at,id LIMIT 1').get(key);
    return row ? this.getLesson(row.id) : null;
  }

  /**
   * 经验沉淀的写入口（#55）：
   * - 首次提炼：照常插入一条经验行；
   * - 命中同一去重键：只追加证据行、重算计数，经验行本身不新增；
   * - 证据按 (经验, 引用) 幂等，同一条证据重复出现既不报错也不重复计数。
   * 返回值额外带 support，方便调用方直接读「被多少条执行记录支持」。
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
    const row = this.db.prepare('SELECT payload,verification_status FROM knowledge_lessons WHERE id=?').get(id);
    valid(Boolean(row),'Lesson not found');
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
      // 后来补上可追证据的推断，升级为待验证；已待验证的不会被这次合并降级。
      const previous = row.verification_status ?? payload.verificationStatus ?? 'inferred';
      const verificationStatus = previous === 'inferred' && Number(stats.evidence) > 0 ? 'unverified' : previous;
      const next = {
        ...payload,
        evidenceRefs: refs,
        verificationStatus,
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

  /** 这条经验被多少条执行记录支持：按证据指向的执行记录去重，不按被引用的次数。 */
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
}
