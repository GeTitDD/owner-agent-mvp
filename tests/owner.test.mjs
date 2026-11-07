import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp,rm,readFile,stat } from 'node:fs/promises';
import { OwnerStore } from '../src/owner-store.mjs';
import { OwnerAgent } from '../src/owner-agent.mjs';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { registerOwnerPiEvents } from '../adapters/pi/owner-extension.mjs';
import { createWorkbenchServer } from '../src/workbench-server.mjs';

const withStore=async cb=>{const dir=await mkdtemp(path.join(os.tmpdir(),'owner-agent-test-'));
  const dbPath=path.join(dir,'knowledge.sqlite');const store=new OwnerStore(dbPath);
  try{const a=store.registerProject({id:'research-a',name:'Pi Research',root:dir,primaryDomain:'pi-sdk',domains:['pi-sdk','context-engineering'],goal:'Study Context hooks'});
    const other=await mkdtemp(path.join(os.tmpdir(),'owner-project-b-'));
    try{const b=store.registerProject({id:'research-b',name:'Project B',root:other,primaryDomain:'pi-sdk'});return await cb({store,dbPath,dir,other,a,b});}
    finally{await rm(other,{recursive:true,force:true});}
  }finally{store.close();await rm(dir,{recursive:true,force:true});}};
const exampleKnowledge=(extra={})=>({title:'Verified context composition',content:'Stable prefixes can be reused under specified constraints',kind:'claim',layer:'applied',scope:'domain',projectId:null,domains:['pi-sdk'],tags:['cache'],verificationStatus:'verified',evidenceRefs:['experiment:cache-prefix-v1'],relations:{},...extra});

test('registry prevents duplicate identities and unregistered paths',()=>withStore(async({store,a,dir})=>{
  assert.equal(a.id,'research-a');assert.equal(store.listProjects().length,2);
  assert.throws(()=>store.registerProject({id:'research-a',name:'duplicate',root:dir}),/already registered/);
  assert.throws(()=>store.registerProject({id:'new',name:'none',root:path.join(dir,'not-found')}),/must already exist/);
  assert.equal(store.getProjectByRoot(dir).id,'research-a');
}));
test('tasks and project state are explicit owner-maintained records',()=>withStore(async({store})=>{
  const task=store.createTask({projectId:'research-a',title:'Reproduce context experiment'});
  assert.equal(store.getProject('research-a').status,'planned');
  store.updateTask(task.id,{status:'blocked',note:'Missing test environment'});
  assert.equal(store.summary().blockedTasks,1);
  assert.equal(store.getProject('research-a').status,'planned');
  store.updateProject('research-a',{status:'blocked',ownerNote:'Waiting for test environment'});
  assert.equal(store.getProject('research-a').status,'blocked');
  assert.throws(()=>store.createTask({projectId:'unregistered',title:'x'}),/Unknown project/);
}));
test('event ingestion is idempotent and metadata-only, settlement does not imply task success',()=>withStore(async({store})=>{
  const run={projectId:'research-a',sessionId:'session01',branchLeafId:'leaf01'};
  const first=store.recordEvent({...run,sourceEventId:'evt-001',kind:'run_started',prompt:'NEVER STORE THIS'});
  assert.equal(first.duplicate,false);
  assert.equal(store.recordEvent({...run,sourceEventId:'evt-001',kind:'run_started'}).duplicate,true);
  store.recordEvent({...run,sourceEventId:'evt-002',kind:'tool_finished',toolName:'bash',isError:true,durationMs:12,args:{token:'PRIVATE'}});
  store.recordEvent({...run,sourceEventId:'evt-003',kind:'run_settled',aborted:false});
  const rows=store.listEvents({projectId:'research-a'});
  assert.equal(rows.length,3);assert.doesNotMatch(JSON.stringify(rows),/NEVER STORE THIS|PRIVATE/);
  const current=store.listRuns('research-a')[0];assert.equal(current.status,'settled');assert.equal(current.errors,1);
  assert.equal(store.listTasks('research-a').length,0);
  assert.throws(()=>store.recordEvent({projectId:'missing',kind:'run_started',sessionId:'abc'}),/Unregistered/);
}));
test('tool metadata without a known running session cannot fabricate a run',()=>withStore(async({store})=>{
  store.recordEvent({projectId:'research-a',kind:'tool_finished',sessionId:'unknown',toolName:'bash'});
  assert.equal(store.listRuns('research-a').length,0);
}));
test('cross-project reuse requires verified shared domain knowledge and explicit review',()=>withStore(async({store,dbPath})=>{
  const personal=new PersonalKnowledgeStore(dbPath);
  try{
    const verified=personal.create(exampleKnowledge());
    const local=personal.create(exampleKnowledge({scope:'project',layer:'project',projectId:'research-a'}));
    assert.throws(()=>store.proposeReuse({sourceProjectId:'research-a',targetProjectId:'research-b',knowledgeId:local.id,rationale:'Reuse this'}),/Only evidence-backed/);
    const suggested=store.proposeReuse({sourceProjectId:'research-a',targetProjectId:'research-b',knowledgeId:verified.id,rationale:'Experiment may transfer'});
    assert.equal(suggested.status,'pending');assert.equal(store.knowledgeLinks('research-b').length,0);
    const approved=store.reviewSuggestion(suggested.id,{decision:'approved',reviewer:'owner'});
    assert.equal(approved.status,'approved');assert.equal(store.knowledgeLinks('research-b').length,1);
    assert.equal(store.getProject('research-b').status,'planned');
    assert.equal(store.listTasks('research-b').length,0);
    assert.throws(()=>store.reviewSuggestion(suggested.id,{decision:'approved'}),/already reviewed/);
  }finally{personal.close();}
}));
test('knowledge revision changes invalidate pending cross-project suggestion',()=>withStore(async({store,dbPath})=>{
  const knowledge=new PersonalKnowledgeStore(dbPath);
  try{
    const item=knowledge.create(exampleKnowledge());
    const candidate=store.proposeReuse({sourceProjectId:'research-a',targetProjectId:'research-b',knowledgeId:item.id,rationale:'Research result'});
    knowledge.update(item.id,{...exampleKnowledge(),content:'Modified conclusion'},{expectedRevision:1});
    assert.throws(()=>store.reviewSuggestion(candidate.id,{decision:'approved'}),/revision changed/);
    assert.equal(store.getSuggestion(candidate.id).status,'pending');assert.equal(store.knowledgeLinks('research-b').length,0);
    assert.equal(store.reviewSuggestion(candidate.id,{decision:'rejected'}).status,'rejected');
  }finally{knowledge.close();}
}));
test('OwnerAgent responds from project/task evidence without inventing status',()=>withStore(async({store})=>{
  store.createTask({projectId:'research-a',title:'Missing API sample',status:'blocked',note:'Need SDK evidence'});
  const agent=new OwnerAgent(store);
  const blockers=agent.answer('有哪些阻塞？');assert.match(blockers.answer,/Missing API sample/);assert.match(blockers.basis.join(','),/task:/);
  const summary=agent.answer('总体状态');assert.match(summary.answer,/已登记 2 个项目/);
  assert.match(agent.answer('research-a').answer,/Pi Research/);
  assert.equal(agent.answer('research-a').mode,'local-rules');
}));
test('Pi cognitive option is tool-free, opt-in and disposes session',()=>withStore(async({store})=>{
  const calls=[];
  const result=await new OwnerAgent(store).askPi('项目状态?',{createSession:async opts=>{
    calls.push(opts);return {session:{prompt:async p=>calls.push(p),getLastAssistantText:()=> '根据注册表，两个项目。',dispose:()=>calls.push('disposed')}};
  }});
  assert.equal(calls[0].noTools,true);assert.match(calls[1],/唯一已确认/);assert.equal(calls.at(-1),'disposed');
  assert.equal(result.mode,'pi-model');
}));
test('Pi extension only captures registered, trusted projects, never prompts or results',()=>withStore(async({store,dbPath,dir})=>{
  const handlers={};const pi={on:(name,fn)=>handlers[name]=fn};
  registerOwnerPiEvents(pi,{dbPath,enabled:true,logger:{warn:()=>{}}});
  const ctx={cwd:dir,isProjectTrusted:()=>true,sessionManager:{getSessionId:()=> 'sid-99',getLeafId:()=> 'leaf-x'}};
  await handlers.session_start({},ctx);await handlers.agent_start({},ctx);
  await handlers.tool_execution_end({toolName:'bash',isError:false,args:{password:'secret'},result:{text:'SECRET RESULT'},durationMs:33},ctx);
  await handlers.agent_settled({aborted:false},ctx);
  const events=store.listEvents({projectId:'research-a'});
  assert.deepEqual(events.map(x=>x.kind).sort(),['run_settled','run_started','tool_finished']);
  assert.doesNotMatch(JSON.stringify(events),/secret|SECRET RESULT/);
  handlers.session_shutdown();
  const untrusted={...ctx,isProjectTrusted:()=>false};await handlers.session_start({},untrusted);await handlers.agent_start({},untrusted);
  assert.equal(store.listEvents({projectId:'research-a'}).length,3);
}));
test('HTTP Owner dashboard APIs use same DB and reject wrong-origin mutation',()=>withStore(async({store,dbPath,dir})=>{
  const server=await createWorkbenchServer({port:0,dbPath});
  const {port}=await server.listen();const url=`http://127.0.0.1:${port}`;
  try{
    const sum=await (await fetch(url+'/api/owner/summary')).json();assert.equal(sum.projectCount,2);
    const headers={'content-type':'application/json','x-workbench-request':'1'};
    const accepted=await fetch(url+'/api/owner/tasks',{method:'POST',headers,body:JSON.stringify({projectId:'research-a',title:'Review Context docs'})});
    assert.equal(accepted.status,201);
    assert.equal((await (await fetch(url+'/api/owner/tasks')).json()).length,1);
    const rejected=await fetch(url+'/api/owner/tasks',{method:'POST',headers:{...headers,origin:'https://example.com'},body:JSON.stringify({projectId:'research-a',title:'Forged'})});
    assert.equal(rejected.status,403);
    const question=await fetch(url+'/api/owner/ask',{method:'POST',headers,body:JSON.stringify({question:'总体状态'})});
    assert.equal((await question.json()).mode,'local-rules');
  }finally{await server.close();}
}));

test('resident monitor emits only new events and newly relevant attention, without model calls',()=>withStore(async({store})=>{
  const {OwnerResidentRuntime}=await import('../src/owner-resident.mjs');
  const observed=[],alerts=[];
  const monitor=new OwnerResidentRuntime(store,{intervalMs:1000,onEvent:x=>observed.push(x.kind),onAttention:x=>alerts.push(x.kind)});
  monitor.start();
  assert.deepEqual(monitor.tick(),{events:0,attention:0,cursor:0});
  const item=store.createTask({projectId:'research-a',title:'API unavailable',status:'blocked'});
  store.recordEvent({projectId:'research-a',kind:'project_note',note:'Timeline check'});
  monitor.tick();assert.deepEqual(observed,['project_note']);assert.deepEqual(alerts,['blocker']);
  monitor.tick();assert.equal(alerts.length,1);assert.equal(observed.length,1);
  store.updateTask(item.id,{status:'done'});monitor.tick();
  store.updateTask(item.id,{status:'blocked'});monitor.tick();assert.equal(alerts.length,2);
  monitor.stop();
}));

test('unregistered project cwd is ignored by Pi adapter',()=>withStore(async({dbPath})=>{
  const other=await mkdtemp(path.join(os.tmpdir(),'owner-unregistered-'));
  try{
    const handlers={};registerOwnerPiEvents({on:(type,cb)=>handlers[type]=cb},{dbPath,enabled:true,logger:{warn:()=>{}}});
    const ctx={cwd:other,isProjectTrusted:()=>true,sessionManager:{getSessionId:()=> 'unknown'}};
    await handlers.session_start({},ctx);await handlers.agent_start({},ctx);handlers.session_shutdown();
    const s=new OwnerStore(dbPath);try{assert.equal(s.listEvents().length,0);}finally{s.close();}
  }finally{await rm(other,{recursive:true,force:true});}
}));

test('workbench serves only its own assets; the old companion chat is retired',()=>withStore(async({dbPath})=>{
  const wb=await createWorkbenchServer({dbPath,port:0});const {port}=await wb.listen();
  try{
    const base=`http://127.0.0.1:${port}`;
    const html=await fetch(base+'/');assert.equal(html.status,200);
    assert.match(await html.text(),/Workbench/i);
    for(const name of ['/app.js','/styles.css']){
      const asset=await fetch(base+name);assert.equal(asset.status,200);
    }
    // 旧的 companion.* 是第二套聊天入口，已删；必须 404，避免两套状态并存。
    for(const name of ['/companion.html','/companion.js','/companion.css']){
      const gone=await fetch(base+name);assert.equal(gone.status,404);
    }
  }finally{await wb.close();}
}));
