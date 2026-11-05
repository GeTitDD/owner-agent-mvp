// Local, owner-centric project/event registry. All durable facts are explicit records,
// not summaries inferred from an LLM conversation. No source code or prompt capture.
import { DatabaseSync } from 'node:sqlite';
import { realpathSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultDbPath } from './storage.mjs';
import { PersonalKnowledgeStore } from './personal-store.mjs';

export class OwnerInputError extends Error { constructor(message,status=400){super(message);this.status=status;} }
const check=(ok,msg,status=400)=>{if(!ok)throw new OwnerInputError(msg,status);};
const stamp=()=>new Date().toISOString();
const txt=(v,label,max=400,required=true)=>{check(typeof v==='string'&&v.length<=max&&(!required||!!v.trim())&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v),`Invalid ${label}`);return v.trim();};
const ident=(v,label='id')=>{const s=txt(v,label,90);check(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(s),`Invalid ${label}`);return s;};
const json= v=>JSON.stringify(v);
const parse=v=>JSON.parse(v);
const statuses=new Set(['planned','active','blocked','paused','done','archived']);
const taskStatuses=new Set(['todo','doing','blocked','done','cancelled']);
const kinds=new Set(['run_started','tool_finished','run_settled','project_note','test_result']);
// Job coordination (P0 control plane): explicit state machine, whitelisted job types only.
const jobStatuses=new Set(['pending_approval','queued','leased','running','cancel_requested','succeeded','failed','cancelled','rejected','needs_reconciliation']);
const activeJobStatuses=new Set(['queued','leased','running','cancel_requested']);
const jobTypes=new Set(['noop','status-note','fake-analysis']);
const attemptStatuses=new Set(['claimed','running','succeeded','failed','cancelled','orphaned']);
const jobFilterStatuses=new Set([...jobStatuses]);
const safeArray=(v,label)=>{check(Array.isArray(v)&&v.length<=30&&v.every(x=>typeof x==='string'&&x.length<=80&&/^[\w.-]+$/.test(x)),`Invalid ${label}`);return [...new Set(v)].sort();};
const entry=row=>row?{...row,domains:parse(row.domains),imports:parse(row.imports)}:null;
const suggestion=row=>row?{...row,evidenceRefs:parse(row.evidence_refs)}:null;
const jobRow=row=>row?{...row,payload:parse(row.payload)}:null;
// Flat primitive-only payload: no nested structures, no unbounded strings, control chars rejected.
const cleanPayload=v=>{check(v!==null&&typeof v==='object'&&!Array.isArray(v),'Payload must be a flat JSON object');
  const keys=Object.keys(v);check(keys.length<=10,'Too many payload keys');const out={};
  for(const key of keys){check(/^[\w.-]{1,60}$/.test(key),'Invalid payload key');const val=v[key];const type=typeof val;
    check(type==='boolean'||(type==='number'&&Number.isFinite(val))||(type==='string'&&val.length<=300&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(val)),`Invalid payload value for ${key}`);
    out[key]=val;}
  return out;};
const canonical=v=>JSON.stringify(v,Object.keys(v).sort());

export class OwnerStore {
  constructor(dbPath=defaultDbPath(),{maxActiveJobsPerProject=1}={}){
    check(Number.isSafeInteger(maxActiveJobsPerProject)&&maxActiveJobsPerProject>=1,'Invalid maxActiveJobsPerProject');
    this.maxActiveJobsPerProject=maxActiveJobsPerProject;
    this.dbPath=dbPath;
    if(dbPath!==':memory:')mkdirSync(path.dirname(dbPath),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS owner_projects(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE,
        primary_domain TEXT NOT NULL, domains TEXT NOT NULL, imports TEXT NOT NULL,
        goal TEXT NOT NULL, status TEXT NOT NULL, owner_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_event_at TEXT
      );
      CREATE TABLE IF NOT EXISTS owner_events(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, source_event_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES owner_projects(id), kind TEXT NOT NULL,
        payload TEXT NOT NULL, received_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS owner_events_project ON owner_events(project_id,seq DESC);
      CREATE TABLE IF NOT EXISTS owner_runs(
        project_id TEXT NOT NULL REFERENCES owner_projects(id), session_id TEXT NOT NULL,
        branch_leaf_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
        started_at TEXT NOT NULL, settled_at TEXT, tools INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0, aborted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(project_id,session_id)
      );
      CREATE TABLE IF NOT EXISTS owner_tasks(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES owner_projects(id),
        title TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS owner_suggestions(
        id TEXT PRIMARY KEY, source_project_id TEXT NOT NULL REFERENCES owner_projects(id),
        target_project_id TEXT NOT NULL REFERENCES owner_projects(id),
        knowledge_id TEXT NOT NULL, knowledge_revision INTEGER NOT NULL,
        rationale TEXT NOT NULL, evidence_refs TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
        created_at TEXT NOT NULL, reviewed_at TEXT, reviewer TEXT
      );
      CREATE TABLE IF NOT EXISTS owner_project_knowledge_links(
        project_id TEXT NOT NULL REFERENCES owner_projects(id), knowledge_id TEXT NOT NULL,
        revision INTEGER NOT NULL, suggestion_id TEXT NOT NULL UNIQUE,
        approved_at TEXT NOT NULL, PRIMARY KEY(project_id,knowledge_id,revision)
      );
      CREATE INDEX IF NOT EXISTS owner_suggestions_target ON owner_suggestions(target_project_id,status);
      CREATE TABLE IF NOT EXISTS owner_jobs(
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES owner_projects(id),
        owner_task_id TEXT REFERENCES owner_tasks(id),
        job_type TEXT NOT NULL,
        title TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending_approval','queued','leased','running','cancel_requested','succeeded','failed','cancelled','rejected','needs_reconciliation')),
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        approved_at TEXT, approved_by TEXT,
        rejected_at TEXT, rejected_by TEXT, reject_reason TEXT NOT NULL DEFAULT '',
        cancel_requested_at TEXT, finished_at TEXT,
        last_attempt INTEGER NOT NULL DEFAULT 0,
        lease_until TEXT,
        UNIQUE(project_id,idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS owner_jobs_project ON owner_jobs(project_id,status,created_at);
      CREATE INDEX IF NOT EXISTS owner_jobs_status ON owner_jobs(status,created_at);
      CREATE TABLE IF NOT EXISTS owner_job_attempts(
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES owner_jobs(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL,
        worker_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('claimed','running','succeeded','failed','cancelled','orphaned')),
        claimed_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
        lease_until TEXT, result_note TEXT NOT NULL DEFAULT '',
        UNIQUE(job_id,attempt)
      );
      CREATE TABLE IF NOT EXISTS owner_job_events(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES owner_jobs(id) ON DELETE CASCADE,
        at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS owner_job_events_job ON owner_job_events(job_id,seq);
    `);
  }
  close(){this.db.close();}
  registerProject({id,name,root,primaryDomain='software-engineering',domains=[],imports=[],goal='',status='planned'}={}){
    id=ident(id,'project id'); name=txt(name,'project name',160);primaryDomain=ident(primaryDomain,'primary domain');
    check(statuses.has(status),'Invalid project status');
    check(typeof root==='string'&&root.length<=1500,'Invalid path');
    let resolved;try{resolved=realpathSync(root);}catch{throw new OwnerInputError('Project directory must already exist');}
    const cleanedDomains=safeArray(domains,'domains');
    const cleanedImports=safeArray(imports,'imports');
    check(cleanedDomains.length>0||!!primaryDomain,'Project needs at least one domain');
    const timestamp=stamp();
    try {this.db.prepare(`INSERT INTO owner_projects(id,name,root,primary_domain,domains,imports,goal,status,owner_note,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,name,resolved,primaryDomain,json(cleanedDomains),json(cleanedImports),txt(goal,'goal',2000,false),status,'',timestamp,timestamp);}
    catch(e){if(/UNIQUE constraint/.test(e.message))throw new OwnerInputError('Project ID or root already registered',409);throw e;}
    return this.getProject(id);
  }
  getProject(id){return entry(this.db.prepare('SELECT * FROM owner_projects WHERE id=?').get(id));}
  getProjectByRoot(root){let resolved;try{resolved=realpathSync(root);}catch{return null;}return entry(this.db.prepare('SELECT * FROM owner_projects WHERE root=?').get(resolved));}
  listProjects(){return this.db.prepare('SELECT * FROM owner_projects ORDER BY updated_at DESC,id').all().map(entry);}
  updateProject(id,{status,goal,ownerNote}={}){
    const p=this.getProject(id);check(!!p,'Unknown project',404);
    check(status===undefined||statuses.has(status),'Invalid status');
    this.db.prepare('UPDATE owner_projects SET status=?,goal=?,owner_note=?,updated_at=? WHERE id=?')
      .run(status??p.status,goal===undefined?p.goal:txt(goal,'goal',2000,false),ownerNote===undefined?p.owner_note:txt(ownerNote,'owner note',2000,false),stamp(),id);
    return this.getProject(id);
  }
  createTask({projectId,title,note='',status='todo'}={}){
    check(!!this.getProject(projectId),'Unknown project',404);check(taskStatuses.has(status),'Invalid task status');
    const id=randomUUID(),now=stamp();this.db.prepare('INSERT INTO owner_tasks VALUES(?,?,?,?,?,?,?)')
      .run(id,projectId,txt(title,'task title',200),status,txt(note,'task note',2000,false),now,now);
    return this.getTask(id);
  }
  getTask(id){return this.db.prepare('SELECT * FROM owner_tasks WHERE id=?').get(id)??null;}
  listTasks(projectId=''){return projectId?this.db.prepare('SELECT * FROM owner_tasks WHERE project_id=? ORDER BY updated_at DESC').all(projectId):
    this.db.prepare('SELECT * FROM owner_tasks ORDER BY updated_at DESC').all();}
  updateTask(id,{status,note}={}){
    const task=this.getTask(id);check(!!task,'Unknown task',404);check(status===undefined||taskStatuses.has(status),'Invalid task status');
    this.db.prepare('UPDATE owner_tasks SET status=?,note=?,updated_at=? WHERE id=?')
      .run(status??task.status,note===undefined?task.note:txt(note,'task note',2000,false),stamp(),id);
    return this.getTask(id);
  }
  // Only a strict whitelist of metadata may be persisted. Unknown keys are deliberately dropped.
  recordEvent({sourceEventId=randomUUID(),projectId,kind,sessionId='',branchLeafId='',toolName='',isError=false,aborted=false,durationMs=null,note='',passed=null}={}){
    ident(sourceEventId,'event id');check(!!this.getProject(projectId),'Unregistered project',404);check(kinds.has(kind),'Invalid event kind');
    const event={};
    if(['run_started','tool_finished','run_settled'].includes(kind)){
      event.sessionId=txt(sessionId,'session id',180);event.branchLeafId=txt(branchLeafId,'branch leaf',180,false);
    }
    if(kind==='tool_finished'){
      event.toolName=txt(toolName,'tool name',120);event.isError=!!isError;
      check(durationMs===null||(Number.isSafeInteger(durationMs)&&durationMs>=0&&durationMs<=86_400_000),'Invalid duration');
      event.durationMs=durationMs;
    }
    if(kind==='run_settled')event.aborted=!!aborted;
    if(kind==='project_note')event.note=txt(note,'note',1000);
    if(kind==='test_result'){
      event.note=txt(note,'test ref',500);check(typeof passed==='boolean','Test result must be boolean');event.passed=passed;
    }
    const now=stamp();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const exists=this.db.prepare('SELECT seq FROM owner_events WHERE source_event_id=?').get(sourceEventId);
      if(exists){this.db.exec('COMMIT');return {duplicate:true,seq:exists.seq};}
      const result=this.db.prepare('INSERT INTO owner_events(source_event_id,project_id,kind,payload,received_at) VALUES(?,?,?,?,?)')
        .run(sourceEventId,projectId,kind,json(event),now);
      if(kind==='run_started')this.db.prepare(`INSERT INTO owner_runs(project_id,session_id,branch_leaf_id,status,started_at)
        VALUES(?,?,?,?,?) ON CONFLICT(project_id,session_id) DO UPDATE SET branch_leaf_id=excluded.branch_leaf_id,status='running',started_at=excluded.started_at,settled_at=NULL,tools=0,errors=0,aborted=0`)
        .run(projectId,event.sessionId,event.branchLeafId,'running',now);
      if(kind==='tool_finished'){
        // Late tool events from an unknown session cannot fabricate an active run.
        this.db.prepare('UPDATE owner_runs SET tools=tools+1,errors=errors+? WHERE project_id=? AND session_id=? AND status=\'running\'')
          .run(event.isError?1:0,projectId,event.sessionId);
      }
      if(kind==='run_settled')this.db.prepare(`UPDATE owner_runs SET status='settled',settled_at=?,aborted=? WHERE project_id=? AND session_id=? AND status='running'`)
        .run(now,event.aborted?1:0,projectId,event.sessionId);
      this.db.prepare('UPDATE owner_projects SET last_event_at=?,updated_at=? WHERE id=?').run(now,now,projectId);
      this.db.exec('COMMIT');return {duplicate:false,seq:Number(result.lastInsertRowid)};
    } catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  listEvents({projectId='',limit=40,afterSeq=0}={}){
    check(Number.isSafeInteger(limit)&&limit>=1&&limit<=500,'Invalid limit');
    check(Number.isSafeInteger(afterSeq)&&afterSeq>=0,'Invalid cursor');
    const rows=projectId?this.db.prepare('SELECT * FROM owner_events WHERE project_id=? AND seq>? ORDER BY seq DESC LIMIT ?').all(projectId,afterSeq,limit):
      this.db.prepare('SELECT * FROM owner_events WHERE seq>? ORDER BY seq DESC LIMIT ?').all(afterSeq,limit);
    return rows.map(r=>({...r,payload:parse(r.payload)}));
  }
  listRuns(projectId=''){return projectId?this.db.prepare('SELECT * FROM owner_runs WHERE project_id=? ORDER BY started_at DESC').all(projectId):
    this.db.prepare('SELECT * FROM owner_runs ORDER BY started_at DESC').all();}
  proposeReuse({sourceProjectId,targetProjectId,knowledgeId,rationale}={}){
    check(sourceProjectId!==targetProjectId,'Source and target must differ');
    check(!!this.getProject(sourceProjectId)&&!!this.getProject(targetProjectId),'Both projects must be registered',404);
    const knowledge=new PersonalKnowledgeStore(this.dbPath);
    let item;try{item=knowledge.get(knowledgeId);}finally{knowledge.close();}
    check(!!item,'Knowledge does not exist',404);
    check(item.scope==='domain'&&item.layer!=='project'&&item.verificationStatus==='verified'&&item.evidenceRefs.length>0,
      'Only evidence-backed verified domain knowledge may be suggested across projects');
    const id=randomUUID();const now=stamp();
    this.db.prepare(`INSERT INTO owner_suggestions(id,source_project_id,target_project_id,knowledge_id,knowledge_revision,rationale,evidence_refs,status,created_at)
      VALUES(?,?,?,?,?,?,?,'pending',?)`).run(id,sourceProjectId,targetProjectId,knowledgeId,item.revision,txt(rationale,'rationale',1500),json(item.evidenceRefs),now);
    return this.getSuggestion(id);
  }
  getSuggestion(id){return suggestion(this.db.prepare('SELECT * FROM owner_suggestions WHERE id=?').get(id));}
  listSuggestions(status=''){check(!status||['pending','approved','rejected'].includes(status),'Invalid suggestion status');
    return this.db.prepare('SELECT * FROM owner_suggestions ORDER BY created_at DESC,id DESC').all().map(suggestion).filter(s=>!status||s.status===status);}
  reviewSuggestion(id,{decision,reviewer='owner'}={}){
    check(['approved','rejected'].includes(decision),'Invalid decision');reviewer=txt(reviewer,'reviewer',80);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const s=this.getSuggestion(id);check(!!s,'Unknown suggestion',404);check(s.status==='pending','Suggestion already reviewed',409);
      if(decision==='approved'){
        const row=this.db.prepare('SELECT revision,payload FROM personal_units WHERE id=?').get(s.knowledge_id);
        const item=row?{...parse(row.payload),revision:row.revision}:null;
        check(item&&item.revision===s.knowledge_revision&&item.scope==='domain'&&item.verificationStatus==='verified'&&item.evidenceRefs.length>0,
          'Evidence or knowledge revision changed; submit a new suggestion',409);
        try{this.db.prepare('INSERT INTO owner_project_knowledge_links VALUES(?,?,?,?,?)')
          .run(s.target_project_id,s.knowledge_id,s.knowledge_revision,s.id,stamp());}
        catch(e){if(/UNIQUE constraint/.test(e.message))throw new OwnerInputError('Knowledge already linked to target',409);throw e;}
      }
      this.db.prepare('UPDATE owner_suggestions SET status=?,reviewer=?,reviewed_at=? WHERE id=?').run(decision,reviewer,stamp(),id);
      this.db.exec('COMMIT');return this.getSuggestion(id);
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  knowledgeLinks(projectId){return this.db.prepare('SELECT * FROM owner_project_knowledge_links WHERE project_id=? ORDER BY approved_at DESC').all(projectId);}
  // ---- Durable task coordination (P0): every transition is transactional, audited and time-injectable. ----
  jobAudit(jobId,action,actor,detail='',at=stamp()){this.db.prepare('INSERT INTO owner_job_events(job_id,at,actor,action,detail) VALUES(?,?,?,?,?)').run(jobId,at,txt(actor,'actor',80),action,txt(detail,'detail',400,false));}
  createJob({projectId,jobType,title,payload={},idempotencyKey,ownerTaskId='',actor='owner',now=stamp()}={}){
    check(!!this.getProject(projectId),'Unknown project',404);
    check(jobTypes.has(jobType),'Unsupported job type; only whitelisted types are accepted');
    check(typeof idempotencyKey==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,88}$/.test(idempotencyKey),'Invalid idempotency key');
    const digest=canonical(cleanPayload(payload));
    if(ownerTaskId){const task=this.getTask(ownerTaskId);check(!!task,'Unknown owner task',404);check(task.project_id===projectId,'Owner task belongs to a different project');}
    actor=txt(actor,'actor',80);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const dup=this.db.prepare('SELECT * FROM owner_jobs WHERE project_id=? AND idempotency_key=?').get(projectId,idempotencyKey);
      if(dup){
        check(dup.job_type===jobType&&dup.payload===digest,'Idempotency key reused with a different request payload',409);
        // The target owner task is part of the idempotency identity: resubmitting the same
        // request against another task must conflict instead of silently re-pointing the job.
        check((dup.owner_task_id??null)===(ownerTaskId||null),'Idempotency key reused with a different target owner task',409);
        this.db.exec('COMMIT');return {...jobRow(dup),duplicate:true};
      }
      const id=randomUUID();
      this.db.prepare(`INSERT INTO owner_jobs(id,project_id,owner_task_id,job_type,title,payload,status,idempotency_key,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'pending_approval',?,?,?)`).run(id,projectId,ownerTaskId||null,jobType,txt(title,'job title',200),digest,idempotencyKey,now,now);
      this.jobAudit(id,'created',actor,jobType,now);
      this.db.exec('COMMIT');return this.getJob(id);
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  getJobRow(id){return this.db.prepare('SELECT * FROM owner_jobs WHERE id=?').get(id)??null;}
  getJob(id){const row=this.getJobRow(id);if(!row)return null;
    return {...jobRow(row),attempts:this.db.prepare('SELECT id,job_id,attempt,worker_id,status,claimed_at,started_at,finished_at,lease_until,result_note FROM owner_job_attempts WHERE job_id=? ORDER BY attempt').all(id),
      events:this.db.prepare('SELECT seq,at,actor,action,detail FROM owner_job_events WHERE job_id=? ORDER BY seq').all(id)};}
  listJobs({projectId='',status='',limit=50}={}){
    check(Number.isSafeInteger(limit)&&limit>=1&&limit<=500,'Invalid limit');
    check(!status||jobFilterStatuses.has(status),'Invalid job status filter');
    const where=[];const params=[];
    if(projectId){where.push('project_id=?');params.push(projectId);}
    if(status){where.push('status=?');params.push(status);}
    const sql=`SELECT * FROM owner_jobs ${where.length?`WHERE ${where.join(' AND ')}`:''} ORDER BY created_at DESC,id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...params,limit).map(jobRow);}
  // True full-table counts per status: summary and attention must not silently under-report
  // just because a listing was capped.
  jobStatusCounts(){const counts={};for(const r of this.db.prepare('SELECT status,COUNT(*) AS n FROM owner_jobs GROUP BY status').all())counts[r.status]=r.n;return counts;}
  listJobsWithExpiredLeases({now=stamp(),limit=100}={}){
    check(Number.isSafeInteger(limit)&&limit>=1&&limit<=500,'Invalid limit');
    return this.db.prepare(`SELECT * FROM owner_jobs WHERE status IN ('leased','running','cancel_requested') AND lease_until IS NOT NULL AND lease_until<? ORDER BY lease_until,id LIMIT ?`).all(now,limit).map(jobRow);}
  // True count with the same filter as listJobsWithExpiredLeases — attention titles must not
  // under-report just because the evidence list is capped.
  countJobsWithExpiredLeases({now=stamp()}={}){return this.db.prepare(`SELECT COUNT(*) AS n FROM owner_jobs WHERE status IN ('leased','running','cancel_requested') AND lease_until IS NOT NULL AND lease_until<?`).get(now).n;}
  listJobEvents(jobId,{limit=200}={}){
    check(Number.isSafeInteger(limit)&&limit>=1&&limit<=500,'Invalid limit');
    return this.db.prepare('SELECT seq,at,actor,action,detail FROM owner_job_events WHERE job_id=? ORDER BY seq LIMIT ?').all(jobId,limit);}
  approveJob(id,{actor='owner',now=stamp()}={}){
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const row=this.getJobRow(id);check(!!row,'Unknown job',404);check(row.status==='pending_approval',`Job in status ${row.status} cannot be approved`,409);
      // Scheduling fence: an unresolved job keeps the whole project quarantined.
      const stuck=this.db.prepare(`SELECT id FROM owner_jobs WHERE project_id=? AND status='needs_reconciliation' LIMIT 1`).get(row.project_id);
      check(!stuck,'Project has an unresolved needs_reconciliation job; reconcile it before approving new work',409);
      const active=this.db.prepare(`SELECT COUNT(*) AS n FROM owner_jobs WHERE project_id=? AND status IN ('queued','leased','running','cancel_requested')`).get(row.project_id).n;
      check(active<this.maxActiveJobsPerProject,'Project already has an active job; per-project limit blocks approval',409);
      const changed=this.db.prepare(`UPDATE owner_jobs SET status='queued',approved_at=?,approved_by=?,updated_at=? WHERE id=? AND status='pending_approval'`).run(now,txt(actor,'actor',80),now,id);
      check(changed.changes===1,'Job status changed concurrently',409);
      this.jobAudit(id,'approved',actor,'',now);
      this.db.exec('COMMIT');return this.getJob(id);
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  rejectJob(id,{actor='owner',reason='',now=stamp()}={}){
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const row=this.getJobRow(id);check(!!row,'Unknown job',404);check(row.status==='pending_approval',`Job in status ${row.status} cannot be rejected`,409);
      const changed=this.db.prepare(`UPDATE owner_jobs SET status='rejected',rejected_at=?,rejected_by=?,reject_reason=?,finished_at=?,updated_at=? WHERE id=? AND status='pending_approval'`)
        .run(now,txt(actor,'actor',80),txt(reason,'reject reason',400,false),now,now,id);
      check(changed.changes===1,'Job status changed concurrently',409);
      this.jobAudit(id,'rejected',actor,reason,now);
      this.db.exec('COMMIT');return this.getJob(id);
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  requestCancelJob(id,{actor='owner',now=stamp()}={}){
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const row=this.getJobRow(id);check(!!row,'Unknown job',404);actor=txt(actor,'actor',80);
      if(row.status==='cancel_requested'){this.db.exec('COMMIT');return this.getJob(id);}
      if(row.status==='pending_approval'||row.status==='queued'){
        const changed=this.db.prepare(`UPDATE owner_jobs SET status='cancelled',cancel_requested_at=?,finished_at=?,lease_until=NULL,updated_at=? WHERE id=? AND status IN ('pending_approval','queued')`).run(now,now,now,id);
        check(changed.changes===1,'Job status changed concurrently',409);
        this.jobAudit(id,'cancelled',actor,'cancelled before execution',now);
      }else if(row.status==='leased'||row.status==='running'){
        const changed=this.db.prepare(`UPDATE owner_jobs SET status='cancel_requested',cancel_requested_at=?,updated_at=? WHERE id=? AND status IN ('leased','running')`).run(now,now,id);
        check(changed.changes===1,'Job status changed concurrently',409);
        this.jobAudit(id,'cancel_requested',actor,'stop requested; awaiting worker confirmation',now);
      }else check(false,`Job in status ${row.status} cannot be cancelled`,409);
      this.db.exec('COMMIT');return this.getJob(id);
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  claimNextJob(projectId,workerId,{now=stamp(),leaseMs=30000}={}){
    check(!!this.getProject(projectId),'Unknown project',404);
    workerId=ident(workerId,'worker id');
    check(Number.isSafeInteger(leaseMs)&&leaseMs>=1000&&leaseMs<=3_600_000,'Invalid lease duration');
    const leaseUntil=new Date(Date.parse(now)+leaseMs).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try{
      // Quarantine fence: one unresolved attempt may still carry unknown external side effects,
      // so no other job of this project may be scheduled until the owner reconciles it.
      const stuck=this.db.prepare(`SELECT id FROM owner_jobs WHERE project_id=? AND status='needs_reconciliation' LIMIT 1`).get(projectId);
      if(stuck){this.db.exec('COMMIT');return {claimed:false,reason:'project-quarantined',quarantinedJobId:stuck.id};}
      const activeCount=this.db.prepare(`SELECT COUNT(*) AS n FROM owner_jobs WHERE project_id=? AND status IN ('leased','running','cancel_requested')`).get(projectId).n;
      if(activeCount>=this.maxActiveJobsPerProject){
        const busy=this.db.prepare(`SELECT id FROM owner_jobs WHERE project_id=? AND status IN ('leased','running','cancel_requested') LIMIT 1`).get(projectId);
        this.db.exec('COMMIT');return {claimed:false,reason:'project-active-job',activeJobId:busy.id};
      }
      const job=this.db.prepare(`SELECT * FROM owner_jobs WHERE project_id=? AND status='queued' ORDER BY created_at,id LIMIT 1`).get(projectId);
      if(!job){this.db.exec('COMMIT');return {claimed:false,reason:'no-queued-job'};}
      const attemptNo=job.last_attempt+1,attemptId=randomUUID();
      const changed=this.db.prepare(`UPDATE owner_jobs SET status='leased',lease_until=?,updated_at=?,last_attempt=? WHERE id=? AND status='queued'`).run(leaseUntil,now,attemptNo,job.id);
      check(changed.changes===1,'Job status changed concurrently',409);
      this.db.prepare(`INSERT INTO owner_job_attempts(id,job_id,attempt,worker_id,status,claimed_at,lease_until) VALUES(?,?,?,?,'claimed',?,?)`).run(attemptId,job.id,attemptNo,workerId,now,leaseUntil);
      this.jobAudit(job.id,'claimed',workerId,`attempt:${attemptNo}`,now);
      const attempt=this.db.prepare('SELECT id,job_id,attempt,worker_id,status,claimed_at,lease_until FROM owner_job_attempts WHERE id=?').get(attemptId);
      this.db.exec('COMMIT');
      return {claimed:true,job:jobRow(this.getJobRow(job.id)),attempt};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  startJob(jobId,attemptNo,{workerId,now=stamp()}={}){
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const row=this.getJobRow(jobId);check(!!row,'Unknown job',404);
      const att=this.db.prepare('SELECT * FROM owner_job_attempts WHERE job_id=? AND attempt=?').get(jobId,attemptNo);check(!!att,'Unknown attempt',404);
      check(att.worker_id===workerId,'Attempt belongs to a different worker',403);
      check(att.status==='claimed',`Attempt in status ${att.status} cannot start`,409);
      check(row.status==='leased',`Job in status ${row.status} cannot start`,409);
      // A worker whose lease expired must stop even before the reconcile scan quarantines the job.
      check(row.lease_until&&row.lease_until>=now,'Lease already expired; explicit reconciliation is required',409);
      this.db.prepare(`UPDATE owner_job_attempts SET status='running',started_at=? WHERE id=? AND status='claimed'`).run(now,att.id);
      const changed=this.db.prepare(`UPDATE owner_jobs SET status='running',updated_at=? WHERE id=? AND status='leased'`).run(now,jobId);
      check(changed.changes===1,'Job status changed concurrently',409);
      this.jobAudit(jobId,'started',workerId,`attempt:${attemptNo}`,now);
      this.db.exec('COMMIT');return this.getJob(jobId);
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  heartbeatJob(jobId,attemptNo,{workerId,now=stamp(),leaseMs=30000}={}){
    check(Number.isSafeInteger(leaseMs)&&leaseMs>=1000&&leaseMs<=3_600_000,'Invalid lease duration');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const row=this.getJobRow(jobId);check(!!row,'Unknown job',404);
      const att=this.db.prepare('SELECT * FROM owner_job_attempts WHERE job_id=? AND attempt=?').get(jobId,attemptNo);check(!!att,'Unknown attempt',404);
      check(att.worker_id===workerId,'Attempt belongs to a different worker',403);
      check(['claimed','running'].includes(att.status),`Attempt in status ${att.status} cannot heartbeat`,409);
      check(['leased','running'].includes(row.status),`Job in status ${row.status} cannot heartbeat`,409);
      check(row.lease_until&&row.lease_until>=now,'Lease already expired; explicit reconciliation is required',409);
      const leaseUntil=new Date(Date.parse(now)+leaseMs).toISOString();
      this.db.prepare('UPDATE owner_jobs SET lease_until=?,updated_at=? WHERE id=?').run(leaseUntil,now,jobId);
      this.db.prepare('UPDATE owner_job_attempts SET lease_until=? WHERE id=?').run(leaseUntil,att.id);
      this.jobAudit(jobId,'heartbeat',workerId,`attempt:${attemptNo}`,now);
      this.db.exec('COMMIT');return this.getJob(jobId);
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  reportJobResult(jobId,attemptNo,{workerId,outcome,note='',now=stamp()}={}){
    check(['succeeded','failed'].includes(outcome),'Invalid outcome');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const row=this.getJobRow(jobId);check(!!row,'Unknown job',404);
      const att=this.db.prepare('SELECT * FROM owner_job_attempts WHERE job_id=? AND attempt=?').get(jobId,attemptNo);check(!!att,'Unknown attempt',404);
      check(att.worker_id===workerId,'Attempt belongs to a different worker',403);
      check(att.attempt===row.last_attempt,'Only the latest attempt may report a result',409);
      check(att.status==='running',`Attempt in status ${att.status} cannot report a result`,409);
      check(['running','cancel_requested'].includes(row.status),`Job in status ${row.status} cannot accept a result`,409);
      check(row.lease_until&&row.lease_until>=now,'Lease expired; late result rejected pending reconciliation',409);
      const safeNote=txt(note,'result note',400,false);
      this.db.prepare(`UPDATE owner_job_attempts SET status=?,finished_at=?,result_note=? WHERE id=? AND status='running'`).run(outcome,now,safeNote,att.id);
      const changed=this.db.prepare(`UPDATE owner_jobs SET status=?,finished_at=?,lease_until=NULL,updated_at=? WHERE id=? AND status IN ('running','cancel_requested')`).run(outcome,now,now,jobId);
      check(changed.changes===1,'Job status changed concurrently',409);
      this.jobAudit(jobId,outcome,workerId,safeNote,now);
      this.db.exec('COMMIT');return this.getJob(jobId);
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  confirmJobCancelled(jobId,attemptNo,{workerId,note='',now=stamp()}={}){
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const row=this.getJobRow(jobId);check(!!row,'Unknown job',404);
      const att=this.db.prepare('SELECT * FROM owner_job_attempts WHERE job_id=? AND attempt=?').get(jobId,attemptNo);check(!!att,'Unknown attempt',404);
      check(att.worker_id===workerId,'Attempt belongs to a different worker',403);
      check(att.attempt===row.last_attempt,'Only the latest attempt may confirm cancellation',409);
      check(['claimed','running'].includes(att.status),`Attempt in status ${att.status} cannot confirm cancellation`,409);
      check(row.status==='cancel_requested',`Job in status ${row.status} is not awaiting cancellation`,409);
      // Confirmation after lease expiry goes through human reconciliation, not the old worker.
      check(row.lease_until&&row.lease_until>=now,'Lease already expired; explicit reconciliation is required',409);
      const safeNote=txt(note,'result note',400,false);
      this.db.prepare(`UPDATE owner_job_attempts SET status='cancelled',finished_at=?,result_note=? WHERE id=? AND status IN ('claimed','running')`).run(now,safeNote,att.id);
      const changed=this.db.prepare(`UPDATE owner_jobs SET status='cancelled',finished_at=?,lease_until=NULL,updated_at=? WHERE id=? AND status='cancel_requested'`).run(now,now,jobId);
      check(changed.changes===1,'Job status changed concurrently',409);
      this.jobAudit(jobId,'worker_cancelled',workerId,safeNote,now);
      this.db.exec('COMMIT');return this.getJob(jobId);
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  // Marks expired leases as needs_reconciliation. Never re-executes anything by itself.
  reconcileExpiredLeases({now=stamp()}={}){
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const expired=this.db.prepare(`SELECT id FROM owner_jobs WHERE status IN ('leased','running','cancel_requested') AND lease_until IS NOT NULL AND lease_until<?`).all(now);
      for(const {id} of expired){
        const changed=this.db.prepare(`UPDATE owner_jobs SET status='needs_reconciliation',lease_until=NULL,updated_at=? WHERE id=? AND status IN ('leased','running','cancel_requested')`).run(now,id);
        if(changed.changes===1){
          this.db.prepare(`UPDATE owner_job_attempts SET status='orphaned' WHERE job_id=? AND status IN ('claimed','running')`).run(id);
          this.jobAudit(id,'lease_expired','system','marked needs_reconciliation; no automatic re-execution',now);
        }
      }
      this.db.exec('COMMIT');return expired.map(r=>r.id);
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  reconcileJob(id,{decision,actor='owner',reason='',now=stamp()}={}){
    check(['requeue','cancel','fail'].includes(decision),'Invalid reconcile decision');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const row=this.getJobRow(id);check(!!row,'Unknown job',404);check(row.status==='needs_reconciliation',`Job in status ${row.status} does not need reconciliation`,409);
      actor=txt(actor,'actor',80);
      if(decision==='requeue'){
        // Crash recovery may repeat unknown external side effects; a recorded safety review is mandatory.
        const safeReason=txt(reason,'reconcile reason',400);
        const active=this.db.prepare(`SELECT COUNT(*) AS n FROM owner_jobs WHERE project_id=? AND status IN ('queued','leased','running','cancel_requested')`).get(row.project_id).n;
        check(active<this.maxActiveJobsPerProject,'Project already has an active job; per-project limit blocks requeue',409);
        const changed=this.db.prepare(`UPDATE owner_jobs SET status='queued',lease_until=NULL,cancel_requested_at=NULL,finished_at=NULL,updated_at=? WHERE id=? AND status='needs_reconciliation'`).run(now,id);
        check(changed.changes===1,'Job status changed concurrently',409);
        this.jobAudit(id,'requeued',actor,safeReason,now);
      }else{
        const safeReason=txt(reason,'reason',400,false);
        const target=decision==='cancel'?'cancelled':'failed';
        const changed=this.db.prepare(`UPDATE owner_jobs SET status=?,finished_at=?,lease_until=NULL,updated_at=? WHERE id=? AND status='needs_reconciliation'`).run(target,now,now,id);
        check(changed.changes===1,'Job status changed concurrently',409);
        this.jobAudit(id,decision==='cancel'?'reconcile_cancelled':'reconcile_failed',actor,safeReason,now);
      }
      this.db.exec('COMMIT');return this.getJob(id);
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  summary(){const projects=this.listProjects();const tasks=this.listTasks();const runs=this.listRuns();const pending=this.listSuggestions('pending');
    const counts=this.jobStatusCounts();
    return {projectCount:projects.length,activeRuns:runs.filter(r=>r.status==='running').length,
      blockedTasks:tasks.filter(t=>t.status==='blocked').length,pendingSuggestions:pending.length,
      activeJobs:['queued','leased','running','cancel_requested'].reduce((sum,st)=>sum+(counts[st]??0),0),
      pendingJobApprovals:counts['pending_approval']??0,
      stuckJobs:counts['needs_reconciliation']??0,
      totalJobs:Object.values(counts).reduce((sum,n)=>sum+n,0),
      projects:projects.map(p=>({...p,tasks:tasks.filter(t=>t.project_id===p.id),
        runs:runs.filter(r=>r.project_id===p.id).slice(0,8),knowledgeLinks:this.knowledgeLinks(p.id),
        jobs:this.listJobs({projectId:p.id,limit:8})}))};}
}
