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
const safeArray=(v,label)=>{check(Array.isArray(v)&&v.length<=30&&v.every(x=>typeof x==='string'&&x.length<=80&&/^[\w.-]+$/.test(x)),`Invalid ${label}`);return [...new Set(v)].sort();};
const entry=row=>row?{...row,domains:parse(row.domains),imports:parse(row.imports)}:null;
const suggestion=row=>row?{...row,evidenceRefs:parse(row.evidence_refs)}:null;

export class OwnerStore {
  constructor(dbPath=defaultDbPath()) {
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
  summary(){const projects=this.listProjects();const tasks=this.listTasks();const runs=this.listRuns();const pending=this.listSuggestions('pending');
    return {projectCount:projects.length,activeRuns:runs.filter(r=>r.status==='running').length,
      blockedTasks:tasks.filter(t=>t.status==='blocked').length,pendingSuggestions:pending.length,
      projects:projects.map(p=>({...p,tasks:tasks.filter(t=>t.project_id===p.id),
        runs:runs.filter(r=>r.project_id===p.id).slice(0,8),knowledgeLinks:this.knowledgeLinks(p.id)}))};}
}
