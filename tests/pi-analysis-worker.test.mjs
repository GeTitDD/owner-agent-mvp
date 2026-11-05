import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp,rm,realpath } from 'node:fs/promises';
import fs from 'node:fs';
import { OwnerStore } from '../src/owner-store.mjs';
import { OwnerAgent } from '../src/owner-agent.mjs';
import { PiAnalysisWorker } from '../src/pi-analysis-worker.mjs';
import { DefaultPiSessionFactory } from '../src/pi-session-factory.mjs';

// Condition-based wait: async fs (realpath etc.) is real I/O, so a single setImmediate
// is not enough. Poll until the expected state appears; bounded by a real timeout.
const waitFor=(fn,label,ms=2000)=>new Promise((resolve,reject)=>{
  const start=Date.now();
  const timer=setInterval(()=>{try{if(fn()){clearInterval(timer);resolve();return;}}catch{/* retry */}if(Date.now()-start>ms){clearInterval(timer);reject(new Error('waitFor timeout: '+label));}},5);
});
// Deterministic fake clock — lease/expiry assertions use injected timestamps, no sleeps.
const clock=(start='2026-07-01T00:00:00.000Z')=>{let t=Date.parse(start);
  return {now:()=>new Date(t).toISOString(),advanceMs:(ms)=>{t+=ms;return new Date(t).toISOString();}};};

// Manual timers: the worker registers its watchdog/timeout handles through this object;
// tests fire ticks explicitly, so lease renewal and cancel handling are deterministic.
const manualTimers=()=>{const handles=new Map();let next=1;
  return {handles,
    interval:(fn,ms)=>{const id=next++;handles.set(id,{fn,ms});return id;},
    timeout:(fn,ms)=>{const id=next++;handles.set(id,{fn,ms});return id;},
    clear:(id)=>handles.delete(id),
    fire:(id)=>{const h=handles.get(id);if(h)h.fn();}};};

// Fake Pi session + factory implementing the PiSessionFactory adapter contract.
const makeFakeSession=({text='结构化分析：重试路径风险可控，建议补充幂等回归。',tools=[],model='fake/glm-x',sessionId='sess-fake',hang=false,hangAbort=false,promptError=null,failToolEnum=false}={})=>{
  const s={prompts:[],aborts:0,disposed:false,_resolve:null,tools:tools.slice(),
    sessionId:()=>sessionId,
    // failToolEnum simulates an SDK without tool enumeration: unknown, NOT empty.
    activeTools:failToolEnum?()=>null:()=>s.tools.slice(),
    prompt:(t)=>{s.prompts.push(t);if(promptError)return Promise.reject(promptError);if(hang)return new Promise(r=>{s._resolve=r;});return Promise.resolve();},
    abort(){s.aborts++;if(!hangAbort)try{s._resolve?.();}catch{/* already settled */}},
    getLastText:()=>text,
    model,
    dispose(){s.disposed=true;}};
  return s;
};
const makeFactory=({text,tools,model,hang,hangAbort,promptError,failToolEnum}={})=>{const f={createCalls:[],sessions:[],
  async create({cwd,model:m}){f.createCalls.push({cwd,model:m});
    const resolvedText=typeof text==='function'?text({cwd,model:m}):text;
    const s=makeFakeSession({text:resolvedText,tools,model:model??'fake/glm-x',hang,hangAbort,promptError,failToolEnum});
    s.cwd=cwd;
    f.sessions.push(s);return s;}};
  return f;};

const withStore=async cb=>{const dir=await mkdtemp(path.join(os.tmpdir(),'pi-worker-test-'));
  const dbPath=path.join(dir,'knowledge.sqlite');const store=new OwnerStore(dbPath);
  try{store.registerProject({id:'proj-a',name:'Project A',root:dir,primaryDomain:'pi-sdk'});
    const other=await mkdtemp(path.join(os.tmpdir(),'pi-worker-b-'));
    try{store.registerProject({id:'proj-b',name:'Project B',root:other,primaryDomain:'pi-sdk'});
      return await cb({store,dbPath,dir,other,clock:clock()});
    }finally{await rm(other,{recursive:true,force:true});}
  }finally{store.close();await rm(dir,{recursive:true,force:true});}};

const submitPiJob=(store,{projectId,taskTitle='分析重试实现',taskNote='检查 idempotency 与 lease 恢复',key,taskId}={})=>{
  const id=taskId??store.createTask({projectId,title:taskTitle,note:taskNote}).id;
  return store.createJob({projectId,jobType:'pi-analysis',title:'只读分析',payload:{focus:'重试与幂等'},idempotencyKey:key,ownerTaskId:id});
};

test('[pi#1] an unapproved pi-analysis job can never reach the session factory',()=>withStore(async({store,clock})=>{
  const factory=makeFactory();
  const worker=new PiAnalysisWorker(store,{sessionFactory:factory,clock:clock.now,leaseMs:30000,timers:manualTimers()});
  const job=submitPiJob(store,{projectId:'proj-a',key:'u1'});
  assert.equal(job.status,'pending_approval');
  const r=await worker.runOnce({projectId:'proj-a'});
  assert.deepEqual(r,{claimed:false,reason:'no-queued-job'});
  assert.equal(factory.createCalls.length,0,'no session without approval');
  store.rejectJob(job.id,{reason:'not needed'});
  assert.equal(factory.createCalls.length,0);
}));

test('[pi#2] the real default factory is refused before claiming unless --allow-model is given',()=>withStore(async({store,clock})=>{
  const job=submitPiJob(store,{projectId:'proj-a',key:'g1'});
  store.approveJob(job.id,{now:clock.now()});
  const worker=new PiAnalysisWorker(store,{sessionFactory:DefaultPiSessionFactory,clock:clock.now,timers:manualTimers()});
  const r=await worker.runOnce({projectId:'proj-a'});
  assert.deepEqual(r,{claimed:false,reason:'model-disabled'});
  assert.equal(store.getJob(job.id).status,'queued','no claim, no attempt, no model call');
  assert.equal(store.getJob(job.id).attempts.length,0);
  assert.equal(store.listJobResults(job.id).length,0);
}));

test('[pi#3] pi-analysis submission requires an owner task reference (input source discipline)',()=>withStore(async({store})=>{
  assert.throws(()=>store.createJob({projectId:'proj-a',jobType:'pi-analysis',title:'no task',idempotencyKey:'nt1'}),/owner task reference/);
}));

test('[pi#4] happy path: registered cwd, empty tools, bounded hashed result, task untouched',()=>withStore(async({store,clock})=>{
  const task=store.createTask({projectId:'proj-a',title:'分析重试实现',note:'检查 idempotency'});
  const job=store.createJob({projectId:'proj-a',jobType:'pi-analysis',title:'只读分析',payload:{focus:'重试与幂等'},idempotencyKey:'p1',ownerTaskId:task.id});
  store.approveJob(job.id,{now:clock.now()});
  const factory=makeFactory({text:'分析结论：重试风险可控。'});
  const timers=manualTimers();
  const worker=new PiAnalysisWorker(store,{sessionFactory:factory,clock:clock.now,leaseMs:30000,timers});
  const r=await worker.runOnce({projectId:'proj-a'});
  assert.deepEqual(r,{claimed:true,jobId:job.id,attempt:1,outcome:'succeeded',resultId:r.resultId,resultHash:r.resultHash});
  // session created against the canonical realpath of the registered project root
  assert.equal(factory.createCalls.length,1);
  assert.equal(factory.createCalls[0].cwd,await realpath(store.getProject('proj-a').root));
  // prompt carries ONLY this project's task material, bounded
  const prompt=factory.sessions[0].prompts[0];
  assert.match(prompt,/分析重试实现/);assert.match(prompt,/检查 idempotency/);assert.match(prompt,/proj-a/);
  assert.doesNotMatch(prompt,/Project B/);
  // result asset: hash matches content, metadata recorded, usage honest
  const result=store.getJobResult(r.resultId);
  assert.ok(result);assert.equal(result.content,'分析结论：重试风险可控。');
  assert.equal(result.project_id,'proj-a');assert.equal(result.attempt,1);
  assert.equal(result.session_id,factory.sessions[0].sessionId());
  assert.equal(result.model,'fake/glm-x');assert.equal(result.usage,'unknown');
  const {sha256}=await import('../src/utils.mjs');
  assert.equal(result.content_hash,sha256(result.content));
  // attempt + job state
  const full=store.getJob(job.id);
  assert.equal(full.status,'succeeded');assert.equal(full.attempts[0].session_id,factory.sessions[0].sessionId());
  assert.match(full.attempts[0].result_note,/chars:/);assert.match(full.attempts[0].result_note,/usage:unknown/);
  // no prompt/answer text leaks into job rows or audit events
  const blob=JSON.stringify(full)+JSON.stringify(store.listEvents());
  assert.doesNotMatch(blob,/分析结论：重试风险可控/);
  assert.doesNotMatch(blob,/检查 idempotency 与 lease 恢复/);
  // owner task untouched by model success
  assert.equal(store.getTask(task.id).status,'todo');
}));

test('[pi#5] fail-closed: a non-empty active tool set aborts the attempt before any prompt',()=>withStore(async({store,clock})=>{
  const job=submitPiJob(store,{projectId:'proj-a',key:'fc1'});
  store.approveJob(job.id,{now:clock.now()});
  const factory=makeFactory({tools:['web_search','fetch_content']});
  const worker=new PiAnalysisWorker(store,{sessionFactory:factory,clock:clock.now,timers:manualTimers()});
  const r=await worker.runOnce({projectId:'proj-a'});
  assert.equal(r.outcome,'failed');
  assert.equal(factory.sessions[0].prompts.length,0,'no prompt sent to an unsafe session');
  assert.ok(factory.sessions[0].aborts>=1);
  assert.equal(factory.sessions[0].disposed,true);
  assert.equal(store.getJob(job.id).status,'failed');
  assert.match(store.getJob(job.id).attempts[0].result_note,/tool isolation verification failed \(2 active tools\)/);
  assert.equal(store.listJobResults(job.id).length,0);
}));

test('[pi#6] stop request during a long analysis aborts the session and lands cancelled',()=>withStore(async({store,clock})=>{
  const job=submitPiJob(store,{projectId:'proj-a',key:'c1'});
  store.approveJob(job.id,{now:clock.now()});
  const factory=makeFactory({hang:true});
  const timers=manualTimers();
  const worker=new PiAnalysisWorker(store,{sessionFactory:factory,clock:clock.now,leaseMs:30000,timers});
  const pending=worker.runOnce({projectId:'proj-a'});
  await waitFor(()=>factory.sessions.length===1,'session created');
  const session=factory.sessions[0];
  assert.equal(session.prompts.length,1,'analysis in flight');
  store.requestCancelJob(job.id,{now:clock.now()});
  const tickId=[...timers.handles.entries()].find(([,h])=>h.ms===10000)?.[0]; // leaseMs/3 tick
  timers.fire(tickId);
  assert.ok(session.aborts>=1,'watchdog forwarded the stop request to the session');
  session._resolve?.(); // SDK settles the aborted prompt
  const r=await pending;
  assert.equal(r.outcome,'cancelled');
  assert.equal(store.getJob(job.id).status,'cancelled');
  assert.equal(session.disposed,true);
  assert.equal(store.getTask(job.owner_task_id).status,'todo');
}));

test('[pi#7] analysis timeout aborts the session and reports failure, never success',()=>withStore(async({store,clock})=>{
  const job=submitPiJob(store,{projectId:'proj-a',key:'t1'});
  store.approveJob(job.id,{now:clock.now()});
  const factory=makeFactory({hang:true});
  // Real timers here: the 40ms timeout must actually fire for a never-resolving prompt.
  const worker=new PiAnalysisWorker(store,{sessionFactory:factory,clock:clock.now,leaseMs:30000,timeoutMs:40});
  const r=await worker.runOnce({projectId:'proj-a'});
  assert.equal(r.outcome,'failed');
  assert.equal(store.getJob(job.id).status,'failed');
  assert.match(store.getJob(job.id).attempts[0].result_note,/analysis timeout after 40ms/);
  assert.equal(store.listJobResults(job.id).length,0);
  assert.equal(factory.sessions[0].disposed,true);
}));

test('[pi#8] a fenced worker stops silently; reconcile quarantines; late results are rejected',()=>withStore(async({store,clock})=>{
  const job=submitPiJob(store,{projectId:'proj-a',key:'f1'});
  store.approveJob(job.id,{now:clock.now()});
  const factory=makeFactory({hang:true});
  const timers=manualTimers();
  const worker=new PiAnalysisWorker(store,{sessionFactory:factory,clock:clock.now,leaseMs:1000,timers});
  const pending=worker.runOnce({projectId:'proj-a'});
  await waitFor(()=>factory.sessions.length===1,'session created');
  clock.advanceMs(5000); // lease gone; worker unaware until its next tick
  const tickId=[...timers.handles.entries()].find(([,h])=>h.ms===333)?.[0];
  timers.fire(tickId); // heartbeat fails silently inside the guard
  factory.sessions[0]._resolve?.();
  const r=await pending;
  assert.equal(r.outcome,'fenced','fenced workers do not report');
  assert.equal(store.getJob(job.id).status,'running','no silent status rewrite');
  store.reconcileExpiredLeases({now:clock.now()});
  assert.equal(store.getJob(job.id).status,'needs_reconciliation');
  assert.equal(store.getJob(job.id).attempts[0].status,'orphaned');
  assert.throws(()=>store.reportJobResult(job.id,1,{workerId:'pi-analysis-worker',outcome:'succeeded',now:clock.now()}),/cannot report a result/);
  assert.throws(()=>store.reconcileJob(job.id,{decision:'requeue',now:clock.now()}),/reconcile reason/);
}));

test('[pi#9] two projects are fully isolated: cwd, prompt material and result assets',()=>withStore(async({store,clock})=>{
  const taskA=store.createTask({projectId:'proj-a',title:'A 的机密分析',note:'alpha 独有上下文'});
  const taskB=store.createTask({projectId:'proj-b',title:'B 的分析',note:'beta 独有上下文'});
  const jobA=store.createJob({projectId:'proj-a',jobType:'pi-analysis',title:'A job',payload:{},idempotencyKey:'i-a',ownerTaskId:taskA.id});
  const jobB=store.createJob({projectId:'proj-b',jobType:'pi-analysis',title:'B job',payload:{},idempotencyKey:'i-b',ownerTaskId:taskB.id});
  store.approveJob(jobA.id,{now:clock.now()});store.approveJob(jobB.id,{now:clock.now()});
  const rootA=await realpath(store.getProject('proj-a').root);
  const factory=makeFactory({text:({cwd})=>cwd===rootA?'A 专属结论':'B 专属结论'});
  const worker=new PiAnalysisWorker(store,{sessionFactory:factory,clock:clock.now,timers:manualTimers()});
  const ra=await worker.runOnce({projectId:'proj-a'});
  const rb=await worker.runOnce({projectId:'proj-b'});
  assert.equal(ra.outcome,'succeeded');assert.equal(rb.outcome,'succeeded');
  assert.equal(factory.createCalls[0].cwd,await realpath(store.getProject('proj-a').root));
  assert.equal(factory.createCalls[1].cwd,await realpath(store.getProject('proj-b').root));
  const pa=factory.sessions[0].prompts[0],pb=factory.sessions[1].prompts[0];
  assert.match(pa,/A 的机密分析/);assert.doesNotMatch(pa,/beta 独有上下文/);
  assert.match(pb,/B 的分析/);assert.doesNotMatch(pb,/alpha 独有上下文/);
  const resA=store.getJobResult(ra.resultId),resB=store.getJobResult(rb.resultId);
  assert.equal(resA.project_id,'proj-a');assert.equal(resB.project_id,'proj-b');
  assert.notEqual(resA.content_hash,resB.content_hash);
  assert.deepEqual(store.listJobResults(jobA.id).map(x=>x.id),[ra.resultId]);
}));

test('[pi#10] heartbeat keeps cancel_requested leases alive during the abort wait',()=>withStore(async({store,clock})=>{
  const job=submitPiJob(store,{projectId:'proj-a',key:'hb1'});
  store.approveJob(job.id,{now:clock.now()});
  store.claimNextJob('proj-a','w',{now:clock.now(),leaseMs:1000});
  store.startJob(job.id,1,{workerId:'w',now:clock.now()});
  store.requestCancelJob(job.id,{now:clock.now()});
  const beat=store.heartbeatJob(job.id,1,{workerId:'w',now:clock.now(),leaseMs:60000});
  assert.equal(beat.lease_until,new Date(Date.parse(clock.now())+60000).toISOString(),'cancel_requested still renews its lease');
  assert.equal(store.getJob(job.id).status,'cancel_requested');
}));

test('[pi#11] cross-project result query is impossible via another project job',()=>withStore(async({store,clock})=>{
  const task=store.createTask({projectId:'proj-a',title:'private'});
  const job=store.createJob({projectId:'proj-a',jobType:'pi-analysis',title:'j',payload:{},idempotencyKey:'x1',ownerTaskId:task.id});
  store.approveJob(job.id,{now:clock.now()});
  const factory=makeFactory({text:'proj-a private conclusions'});
  const worker=new PiAnalysisWorker(store,{sessionFactory:factory,clock:clock.now,timers:manualTimers()});
  const r=await worker.runOnce({projectId:'proj-a'});
  const result=store.getJobResult(r.resultId);
  assert.equal(result.project_id,'proj-a');
  const jobB=store.getJob(store.createJob({projectId:'proj-b',jobType:'noop',title:'b',idempotencyKey:'x2'}).id);
  assert.equal(store.listJobResults(jobB.id).length,0);
}));

// Optional REAL Pi smoke: only with OWNER_AGENT_REAL_PI_TEST=1 AND working credentials.
// Skipping never fails CI. Runs a pure read-only analysis against a temp controlled project.
const REAL_PI=process.env.OWNER_AGENT_REAL_PI_TEST==='1';
(REAL_PI?test:test.skip)('[pi-real] real Pi SDK smoke: approve → isolated session → bounded result',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'pi-worker-real-'));
  const dbPath=path.join(dir,'knowledge.sqlite');const store=new OwnerStore(dbPath);
  try{
    fs.mkdirSync(path.join(dir,'sub'),{recursive:true});
    store.registerProject({id:'real-p',name:'Real Project',root:path.join(dir,'sub'),primaryDomain:'pi-sdk'});
    const task=store.createTask({projectId:'real-p',title:'列出该目录的用途与风险',note:'只读检查'});
    const job=store.createJob({projectId:'real-p',jobType:'pi-analysis',title:'真实冒烟分析',payload:{focus:'目录结构'},idempotencyKey:'real-1',ownerTaskId:task.id});
    store.approveJob(job.id,{now:new Date().toISOString()});
    const worker=new PiAnalysisWorker(store,{workerId:'real-smoke',clock:()=>new Date().toISOString(),leaseMs:120000,timeoutMs:120000});
    const r=await worker.runOnce({projectId:'real-p',allowModel:true});
    assert.equal(r.outcome,'succeeded');
    const result=store.getJobResult(r.resultId);
    assert.ok(result.content.length>0);assert.equal(result.usage,'unknown');
    assert.ok(result.session_id.length>0);
    assert.match(result.model,/\//,'model identity recorded as provider/model');
    assert.equal(store.getJob(job.id).status,'succeeded');
    assert.equal(store.getTask(task.id).status,'todo');
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

// ---- Review round 1 (PR #4) regression tests ----

test('[pi-r2 #2] workers claim only their own job types in a mixed queue',()=>withStore(async({store,dbPath,clock})=>{
  // limit 2 so both jobs can sit in the pipeline simultaneously; the OLDEST job is the
  // wrong type for the pi worker — proving the type filter, not FIFO luck.
  const tuned=new OwnerStore(dbPath,{maxActiveJobsPerProject:2});
  try{
    const fakeJob=tuned.createJob({projectId:'proj-a',jobType:'fake-analysis',title:'fake job',idempotencyKey:'mix-fake'});
    const piJob=submitPiJob(tuned,{projectId:'proj-a',key:'mix-pi'});
    tuned.approveJob(fakeJob.id,{now:clock.now()});tuned.approveJob(piJob.id,{now:clock.now()});
    const piWorker=new PiAnalysisWorker(tuned,{sessionFactory:makeFactory(),clock:clock.now,timers:manualTimers()});
    const rPi=await piWorker.runOnce({projectId:'proj-a'});
    assert.equal(rPi.claimed,true);assert.equal(rPi.jobId,piJob.id,'oldest queued job was skipped as wrong type');
    const FakeWorker=(await import('../src/job-worker.mjs')).FakeWorker;
    const rFake=await new FakeWorker(tuned,{workerId:'fw',clock:clock.now}).runOnce({projectId:'proj-a'});
    assert.equal(rFake.claimed,true);assert.equal(rFake.jobId,fakeJob.id,'fake worker claims its own type, never the pi job');
    // store-level: an allowedTypes-filtered claim never hands out the wrong type
    const fake2=tuned.createJob({projectId:'proj-a',jobType:'fake-analysis',title:'fake2',idempotencyKey:'mix-fake2'});
    const piTask2=tuned.createTask({projectId:'proj-a',title:'pi2 task'});
    const pi2=tuned.createJob({projectId:'proj-a',jobType:'pi-analysis',title:'pi2',payload:{},idempotencyKey:'mix-pi2',ownerTaskId:piTask2.id});
    tuned.approveJob(fake2.id,{now:clock.now()});tuned.approveJob(pi2.id,{now:clock.now()});
    const piOnly=tuned.claimNextJob('proj-a','w',{now:clock.now(),leaseMs:60000,allowedTypes:['pi-analysis']});
    assert.equal(piOnly.claimed,true);assert.equal(piOnly.job.id,pi2.id,'older fake job skipped by the type filter');
    const fakeOnly=tuned.claimNextJob('proj-a','w2',{now:clock.now(),leaseMs:60000,allowedTypes:['fake-analysis']});
    assert.equal(fakeOnly.claimed,true);assert.equal(fakeOnly.job.id,fake2.id);
  }finally{tuned.close();}
}));

test('[pi-r2 #3] the watchdog covers session creation; cancel lands without ever prompting',()=>withStore(async({store,clock})=>{
  const job=submitPiJob(store,{projectId:'proj-a',key:'wd1'});
  store.approveJob(job.id,{now:clock.now()});
  const factory=makeFactory({hang:true});
  const timers=manualTimers();
  let resolveCreate;
  const slowFactory={createCalls:[],sessions:[],async create(opts){factory.createCalls.push(opts);
    const s=await new Promise(res=>{resolveCreate=res;});
    factory.sessions.push(s);return s;}};
  const worker=new PiAnalysisWorker(store,{sessionFactory:slowFactory,clock:clock.now,leaseMs:30000,timers});
  const pending=worker.runOnce({projectId:'proj-a'});
  await waitFor(()=>factory.createCalls.length===1,'create started');
  // a stop request arrives while creation is still in flight; the tick forwards it
  store.requestCancelJob(job.id,{now:clock.now()});
  const tickId=[...timers.handles.entries()].find(([,h])=>h.ms===10000)?.[0];
  timers.fire(tickId);
  assert.equal(store.getJob(job.id).status,'cancel_requested');
  resolveCreate(makeFakeSession({hang:true}));
  const r=await pending;
  assert.equal(r.outcome,'cancelled');
  assert.equal(store.getJob(job.id).status,'cancelled');
  assert.equal(factory.sessions[0].prompts.length,0,'no prompt after a stop request');
  assert.equal(factory.sessions[0].disposed,true);
}));

test('[pi-r2 #4] timeout without a confirmed stop goes to human reconciliation, not failed',()=>withStore(async({store,clock})=>{
  const job=submitPiJob(store,{projectId:'proj-a',key:'uc1'});
  store.approveJob(job.id,{now:clock.now()});
  // hangAbort: abort() does NOT settle the prompt — stop cannot be confirmed.
  // REAL default timers: both the 40ms timeout and the 60ms confirm window must fire.
  const factory=makeFactory({hang:true,hangAbort:true});
  const worker=new PiAnalysisWorker(store,{sessionFactory:factory,clock:clock.now,leaseMs:60000,timeoutMs:40,abortConfirmMs:60});
  const r=await worker.runOnce({projectId:'proj-a'});
  assert.equal(r.outcome,'fenced');assert.equal(r.unconfirmedStop,true);
  assert.equal(store.getJob(job.id).status,'running','not marked failed while the session may still run');
  assert.equal(store.listJobResults(job.id).length,0);
  store.reconcileExpiredLeases({now:clock.advanceMs(120000)});
  assert.equal(store.getJob(job.id).status,'needs_reconciliation');
}));

test('[pi-r2 #4b] a confirmed stop after timeout is reported as an honest failure',()=>withStore(async({store,clock})=>{
  const job=submitPiJob(store,{projectId:'proj-a',key:'uc2'});
  store.approveJob(job.id,{now:clock.now()});
  const factory=makeFactory({hang:true}); // abort() settles the prompt → stop confirmed
  // REAL timers: the 40ms timeout must fire, then the abort's settle confirms the stop.
  const worker=new PiAnalysisWorker(store,{sessionFactory:factory,clock:clock.now,leaseMs:60000,timeoutMs:40,abortConfirmMs:1000});
  const r=await worker.runOnce({projectId:'proj-a'});
  assert.equal(r.outcome,'failed');
  assert.match(store.getJob(job.id).attempts[0].result_note,/session stopped/);
}));

test('[pi-r2 #5] result and terminal state commit atomically; invalid commits create no orphan results',()=>withStore(async({store,clock})=>{
  const job=submitPiJob(store,{projectId:'proj-a',key:'at1'});
  store.approveJob(job.id,{now:clock.now()});
  store.claimNextJob('proj-a','worker-a',{now:clock.now(),leaseMs:60000});
  store.startJob(job.id,1,{workerId:'worker-a',now:clock.now()});
  // wrong worker → no result row
  assert.throws(()=>store.completeJobWithResult(job.id,1,{workerId:'other',content:'x',now:clock.now()}),/different worker/);
  assert.equal(store.listJobResults(job.id).length,0);
  // expired lease → no result row
  clock.advanceMs(120000);
  assert.throws(()=>store.completeJobWithResult(job.id,1,{workerId:'worker-a',content:'x',now:clock.now()}),/Lease expired/);
  assert.equal(store.listJobResults(job.id).length,0);
  store.reconcileExpiredLeases({now:clock.now()});
  store.reconcileJob(job.id,{decision:'requeue',reason:'safe',now:clock.now()});
  const claim=store.claimNextJob('proj-a','worker-a',{now:clock.now(),leaseMs:60000});
  assert.equal(claim.claimed,true);assert.equal(claim.attempt.attempt,2);
  store.startJob(job.id,2,{workerId:'worker-a',now:clock.now()});
  const ok=store.completeJobWithResult(job.id,2,{workerId:'worker-a',sessionId:'sess-a',model:'fake/m',content:'原子提交的结论',now:clock.now()});
  assert.equal(ok.outcome,'succeeded');
  assert.equal(store.getJob(job.id).status,'succeeded');
  assert.equal(store.listJobResults(job.id).length,1);
  const result=store.getJobResult(ok.result.id);
  const {sha256}=await import('../src/utils.mjs');
  assert.equal(result.content_hash,sha256('原子提交的结论'));
  assert.equal(result.attempt,2);
}));

test('[pi-r2 #6] error notes are fixed categories; upstream messages are never persisted',()=>withStore(async({store,clock})=>{
  const job=submitPiJob(store,{projectId:'proj-a',key:'e1'});
  store.approveJob(job.id,{now:clock.now()});
  const SECRET='SECRET https://internal.example.com?key=abc';
  const factory=makeFactory({promptError:Object.assign(new Error(`${SECRET} and more`),{name:'PiApiError'})});
  const worker=new PiAnalysisWorker(store,{sessionFactory:factory,clock:clock.now,timers:manualTimers()});
  const r=await worker.runOnce({projectId:'proj-a'});
  assert.equal(r.outcome,'failed');
  const blob=JSON.stringify(store.getJob(job.id))+JSON.stringify(store.listJobResults(job.id));
  assert.match(blob,/pi session error \(session-error\)/);
  assert.doesNotMatch(blob,/SECRET/);assert.doesNotMatch(blob,/internal\.example\.com/);
}));

test('[pi-r2 fail-closed] an SDK without tool enumeration is treated as unsafe, not as empty',()=>withStore(async({store,clock})=>{
  const job=submitPiJob(store,{projectId:'proj-a',key:'fe1'});
  store.approveJob(job.id,{now:clock.now()});
  const factory=makeFactory({failToolEnum:true});
  const worker=new PiAnalysisWorker(store,{sessionFactory:factory,clock:clock.now,timers:manualTimers()});
  const r=await worker.runOnce({projectId:'proj-a'});
  assert.equal(r.outcome,'failed');
  assert.match(store.getJob(job.id).attempts[0].result_note,/tool isolation verification unavailable/);
  assert.equal(factory.sessions[0].prompts.length,0);
}));

test('[pi-r2 snapshot] the approved input snapshot pins the analysis material against later task edits',()=>withStore(async({store,clock})=>{
  const task=store.createTask({projectId:'proj-a',title:'批准时的标题',note:'批准时的说明'});
  const job=store.createJob({projectId:'proj-a',jobType:'pi-analysis',title:'j',payload:{},idempotencyKey:'snap1',ownerTaskId:task.id});
  store.approveJob(job.id,{now:clock.now()});
  const approved=JSON.parse(store.getJob(job.id).input_snapshot||'{}');
  assert.equal(approved.note,'批准时的说明');
  store.updateTask(task.id,{note:'批准之后被篡改的说明',title:'篡改标题'});
  const factory=makeFactory();
  const worker=new PiAnalysisWorker(store,{sessionFactory:factory,clock:clock.now,timers:manualTimers()});
  await worker.runOnce({projectId:'proj-a'});
  const prompt=factory.sessions[0].prompts[0];
  assert.match(prompt,/批准时的说明/);assert.match(prompt,/批准时的标题/);
  assert.doesNotMatch(prompt,/批准之后被篡改/);assert.doesNotMatch(prompt,/篡改标题/);
}));

test('[pi-r2 create-deadline] a hung factory.create converges: silent fence, scan quarantines, cancel still lands',()=>withStore(async({store,clock})=>{
  const job=submitPiJob(store,{projectId:'proj-a',key:'cd1'});
  store.approveJob(job.id,{now:clock.now()});
  let resolveCreate=null;
  const slowFactory={createCalls:[],sessions:[],async create(opts){slowFactory.createCalls.push(opts);
    await new Promise(res=>{resolveCreate=res;});  // hangs until manually resolved
    const s=makeFakeSession({hang:true});slowFactory.sessions.push(s);return s;}};
  const timers=manualTimers();
  const worker=new PiAnalysisWorker(store,{sessionFactory:slowFactory,clock:clock.now,leaseMs:30000,createTimeoutMs:60,timers});
  const pending=worker.runOnce({projectId:'proj-a'});
  await waitFor(()=>slowFactory.createCalls.length===1,'create started');
  // Owner cancels while creation hangs; the tick records it (session still absent)
  store.requestCancelJob(job.id,{now:clock.now()});
  const deadlineId=[...timers.handles.entries()].find(([,h])=>h.ms===60)?.[0];
  timers.fire(deadlineId); // create deadline hits → worker stops renewing
  const r=await pending;
  assert.equal(r.outcome,'fenced');assert.equal(r.createTimedOut,true);
  assert.equal(store.getJob(job.id).status,'cancel_requested','stop requested but never confirmed (session hung)');
  // converge via human reconciliation
  clock.advanceMs(120000);
  store.reconcileExpiredLeases({now:clock.now()});
  assert.equal(store.getJob(job.id).status,'needs_reconciliation');
  store.reconcileJob(job.id,{decision:'cancel',reason:'creation hung',now:clock.now()});
  assert.equal(store.getJob(job.id).status,'cancelled');
  // LATE session: whatever the factory eventually returns must be aborted+disposed, never prompted
  resolveCreate(makeFakeSession({hang:true,text:'迟到的产物绝不能入库'}));
  await waitFor(()=>slowFactory.sessions.length===1&&slowFactory.sessions[0].disposed,'late session disposed');
  assert.equal(slowFactory.sessions[0].prompts.length,0);
  assert.equal(store.listJobResults(job.id).length,0);
}));

test('[pi-r2 drift] a swapped project root is refused as project-root-moved',()=>withStore(async({store,dir})=>{
  const real=path.join(dir,'drift-real');fs.mkdirSync(real,{recursive:true});
  store.registerProject({id:'drift',name:'Drift',root:real,primaryDomain:'pi-sdk'});
  const stored=store.getProject('drift');
  assert.ok(stored.root_identity&&stored.root_identity.length>0,'registration records the root identity');
  const real2=path.join(dir,'drift-real-2');fs.mkdirSync(real2,{recursive:true});
  // Replace the registered directory with a different one at the same path (the realistic
  // drift case — no symlink privileges required on any platform).
  fs.rmSync(real,{recursive:true,force:true});fs.mkdirSync(real,{recursive:true});
  const factory=makeFactory();
  const worker=new PiAnalysisWorker(store,{sessionFactory:factory,clock:clock.now,timers:manualTimers()});
  const r=await worker.runOnce({projectId:'drift'});
  assert.deepEqual(r,{claimed:false,reason:'project-root-moved'});
  assert.equal(factory.createCalls.length,0,'no session for a moved project');
}));

test('[askPi isolation] non-empty tools fail closed; the factory session is disposed and never prompted',()=>withStore(async({store})=>{
  let disposed=false,prompted=false;
  const factory={create:async()=>({sessionId:()=>'s1',activeTools:()=>['web_search'],
    prompt:async()=>{prompted=true;},abort(){},getLastText:()=>'x',model:'fake/m',
    dispose(){disposed=true;}})};
  const agent=new OwnerAgent(store,{piSessionFactory:factory});
  await assert.rejects(agent.askPi('有哪些项目？'),/tool isolation verification failed/);
  assert.equal(prompted,false,'no prompt reaches an unsafe session');
  assert.equal(disposed,true,'session disposed on refusal');
}));

test('[askPi isolation happy] a zero-tool adapter answers via getLastText and disposes',()=>withStore(async({store})=>{
  let last=null,disposed=false;
  const factory={create:async()=>({sessionId:()=>'s2',activeTools:()=>[],
    prompt:async t=>{last=t;},abort(){},getLastText:()=>'owner 答：2 个项目',model:'fake/m',
    dispose(){disposed=true;}})};
  const agent=new OwnerAgent(store,{piSessionFactory:factory});
  const r=await agent.askPi('有哪些项目？');
  assert.equal(r.mode,'pi-model');assert.equal(r.answer,'owner 答：2 个项目');
  assert.match(last,/Owner 的问题：有哪些项目/);
  assert.equal(disposed,true);
}));
