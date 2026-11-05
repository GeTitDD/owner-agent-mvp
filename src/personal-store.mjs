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
    `);
    // In-place migration for databases created before proposal revision pinning.
    // Legacy proposals with unknown base revision intentionally fail closed on approval.
    const proposalColumns = this.db.prepare('PRAGMA table_info(personal_proposals)').all().map(x => x.name);
    if (!proposalColumns.includes('target_revision')) {
      this.db.exec('ALTER TABLE personal_proposals ADD COLUMN target_revision INTEGER');
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
  submitProposal({targetId=null,payload,actor='agent',note=''}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = targetId === null ? null : this.get(targetId);
      valid(targetId === null || !!existing, 'Proposal target not found');
      const normalized = normalize(payload, existing);
      // Changing scope or project ownership needs an explicit user edit, not an Agent proposal.
      if (existing && (normalized.scope !== existing.scope || normalized.projectId !== existing.projectId)) {
        throw new KnowledgeValidationError('Proposal cannot change target scope or project ownership');
      }
      const id = randomUUID(), stamp = now();
      this.db.prepare(`INSERT INTO personal_proposals(id,target_id,target_revision,payload,status,actor,note,created_at)
        VALUES(?,?,?,?,'pending',?,?,?)`).run(id,targetId,existing?.revision ?? null,canonical(normalized),
          safeText(actor,80,'actor',true),safeText(note,500,'note'),stamp);
      this.db.exec('COMMIT');
      return this.proposal(id);
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  proposal(id) { const row=this.db.prepare('SELECT * FROM personal_proposals WHERE id=?').get(id); return row ? {...row,payload:JSON.parse(row.payload)} : null; }
  proposals(status='') { return this.db.prepare('SELECT * FROM personal_proposals ORDER BY created_at DESC,id DESC').all().map(r=>({...r,payload:JSON.parse(r.payload)})).filter(r=>!status||r.status===status); }
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
}
