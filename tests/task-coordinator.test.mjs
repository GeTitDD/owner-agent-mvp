import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp,rm } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { OwnerStore } from '../src/owner-store.mjs';
import { OwnerAgent } from '../src/owner-agent.mjs';
import { FakeWorker,FakeWorkerCrash } from '../src/job-worker.mjs';
import { createWorkbenchServer } from '../src/workbench-server.mjs';

// Deterministic fake clock: every lease/expiry assertion uses injected timestamps, never sleep().
const clock=(start='2026-06-01T00:00:00.000Z')=>{let t=Date.parse(start);
  return {now:()=>new Date(t).toISOString(),advanceMs:(ms)=>{t+=ms;return new Date(t).toISOString();}};};

const withStore=async cb=>{const dir=await mkdtemp(path.join(os.tmpdir(),'task-coord-test-'));
  const dbPath=path.join(dir,'knowledge.sqlite');const store=new OwnerStore(dbPath);
  try{store.registerProject({id:'project-a',name:'Project A',root:dir,primaryDomain:'pi-sdk'});
    const other=await mkdtemp(path.join(os.tmpdir(),'task-coord-b-'));
    try{store.registerProject({id:'project-b',name:'Project B',root:other,primaryDomain:'pi-sdk'});
      return await cb({store,dbPath,dir,other,clock:clock()});
    }finally{await rm(other,{recursive:true,force:true});}
  }finally{try{store.close();}catch{/* reopen tests may already have closed it */}await rm(dir,{recursive:true,force:true});}};

test('jobs start as pending_approval and are never scheduled without explicit approval; rejection is final',()=>withStore(async({store,clock})=>{
  const job=store.createJob({projectId:'project-a',jobType:'noop',title:'Unapproved work',idempotencyKey:'k-001'});
  assert.equal(job.status,'pending_approval');
  assert.deepEqual(store.claimNextJob('project-a','worker-a',{now:clock.now()}),{claimed:false,reason:'no-queued-job'});
  const rejected=store.rejectJob(job.id,{reason:'wrong task type'});
  assert.equal(rejected.status,'rejected');assert.equal(rejected.reject_reason,'wrong task type');
  assert.throws(()=>store.rejectJob(job.id,{reason:'again'}),/cannot be rejected/);
  assert.throws(()=>store.approveJob(job.id),/cannot be approved/);
  assert.deepEqual(store.claimNextJob('project-a','worker-a',{now:clock.now()}),{claimed:false,reason:'no-queued-job'});
  assert.equal(store.listJobs({projectId:'project-a',status:'rejected'}).length,1);
}));

test('approval queues a job; the per-project active limit blocks concurrent approvals until the pipeline frees up',()=>withStore(async({store,clock})=>{
  const first=store.createJob({projectId:'project-a',jobType:'noop',title:'First',idempotencyKey:'k-1'});
  const second=store.createJob({projectId:'project-a',jobType:'noop',title:'Second',idempotencyKey:'k-2'});
  const approved=store.approveJob(first.id,{now:clock.now()});
  assert.equal(approved.status,'queued');
  assert.throws(()=>store.approveJob(second.id,{now:clock.now()}),/per-project limit blocks approval/);
  const claim=store.claimNextJob('project-a','worker-a',{now:clock.now(),leaseMs:60000});
  store.startJob(first.id,claim.attempt.attempt,{workerId:'worker-a',now:clock.now()});
  store.reportJobResult(first.id,claim.attempt.attempt,{workerId:'worker-a',outcome:'succeeded',now:clock.now()});
  assert.equal(store.approveJob(second.id,{now:clock.now()}).status,'queued');
  assert.throws(()=>store.approveJob(first.id,{now:clock.now()}),/cannot be approved/);
}));

test('idempotency: identical resubmission returns the same job; key reuse with different payload conflicts; keys are project-scoped',()=>withStore(async({store})=>{
  const payload={note:'hello',attempt:1};
  const first=store.createJob({projectId:'project-a',jobType:'noop',title:'Report',payload,idempotencyKey:'idem-1'});
  const again=store.createJob({projectId:'project-a',jobType:'noop',title:'Report (retry)',payload,idempotencyKey:'idem-1'});
  assert.equal(again.id,first.id);assert.equal(again.duplicate,true);assert.equal(store.listJobs({projectId:'project-a'}).length,1);
  assert.throws(()=>store.createJob({projectId:'project-a',jobType:'noop',title:'Different',payload:{note:'changed'},idempotencyKey:'idem-1'}),/reused with a different request payload/);
  const otherProject=store.createJob({projectId:'project-b',jobType:'noop',title:'Other project, same key',payload,idempotencyKey:'idem-1'});
  assert.notEqual(otherProject.id,first.id,'the same key in a different project is a distinct job');
  assert.equal(store.listJobs({projectId:'project-b'}).length,1);
}));

test('unregistered projects, non-whitelisted types and unsafe payloads are rejected',()=>withStore(async({store})=>{
  assert.throws(()=>store.createJob({projectId:'ghost',jobType:'noop',title:'x',idempotencyKey:'k'}),/Unknown project/);
  assert.throws(()=>store.createJob({projectId:'project-a',jobType:'shell',title:'x',idempotencyKey:'k'}),/whitelisted/);
  assert.throws(()=>store.createJob({projectId:'project-a',jobType:'noop',title:'x',payload:{nested:{deep:true}},idempotencyKey:'k'}),/Invalid payload value for nested/);
  assert.throws(()=>store.createJob({projectId:'project-a',jobType:'noop',title:'x',payload:{big:'x'.repeat(301)},idempotencyKey:'k'}),/Invalid payload value/);
  assert.throws(()=>store.createJob({projectId:'project-a',jobType:'noop',title:'x',idempotencyKey:'bad key!'}),/Invalid idempotency key/);
  assert.throws(()=>store.claimNextJob('ghost','worker-a'),/Unknown project/);
}));

test('claim is atomic: one winner per project, different projects run concurrently',()=>withStore(async({store,clock,dbPath})=>{
  const job=store.createJob({projectId:'project-a',jobType:'noop',title:'A work',idempotencyKey:'ka'});
  const jobB=store.createJob({projectId:'project-b',jobType:'noop',title:'B work',idempotencyKey:'kb'});
  store.approveJob(job.id,{now:clock.now()});store.approveJob(jobB.id,{now:clock.now()});
  // Second connection on the same DB simulates an independent process/worker.
  const second=new OwnerStore(dbPath);
  try{
    const winner=second.claimNextJob('project-a','worker-a',{now:clock.now(),leaseMs:60000});
    assert.equal(winner.claimed,true);assert.equal(winner.job.id,job.id);assert.equal(winner.attempt.attempt,1);
    const loser=store.claimNextJob('project-a','worker-b',{now:clock.now(),leaseMs:60000});
    assert.deepEqual(loser,{claimed:false,reason:'project-active-job',activeJobId:job.id});
    const otherWinner=second.claimNextJob('project-b','worker-b',{now:clock.now(),leaseMs:60000});
    assert.equal(otherWinner.claimed,true);assert.equal(otherWinner.job.id,jobB.id);
    assert.equal(store.getJob(job.id).attempts[0].worker_id,'worker-a');
  }finally{second.close();}
}));

test('state machine rejects unauthorized transitions and late worker results',()=>withStore(async({store,clock})=>{
  const job=store.createJob({projectId:'project-a',jobType:'noop',title:'Guarded',idempotencyKey:'g1'});
  store.approveJob(job.id,{now:clock.now()});
  const claim=store.claimNextJob('project-a','worker-a',{now:clock.now(),leaseMs:60000});
  assert.throws(()=>store.startJob(job.id,1,{workerId:'worker-b',now:clock.now()}),/different worker/);
  assert.throws(()=>store.heartbeatJob(job.id,1,{workerId:'worker-x',now:clock.now()}),/different worker/);
  assert.throws(()=>store.reportJobResult(job.id,1,{workerId:'worker-a',outcome:'succeeded',now:clock.now()}),/cannot report a result/);
  store.startJob(job.id,1,{workerId:'worker-a',now:clock.now()});
  assert.throws(()=>store.startJob(job.id,1,{workerId:'worker-a',now:clock.now()}),/cannot start/);
  assert.throws(()=>store.reportJobResult(job.id,2,{workerId:'worker-a',outcome:'succeeded',now:clock.now()}),/Unknown attempt/);
  store.reportJobResult(job.id,1,{workerId:'worker-a',outcome:'succeeded',note:'done once',now:clock.now()});
  assert.equal(store.getJob(job.id).status,'succeeded');
  assert.throws(()=>store.reportJobResult(job.id,1,{workerId:'worker-a',outcome:'failed',now:clock.now()}),/cannot report a result/);
  assert.throws(()=>store.heartbeatJob(job.id,1,{workerId:'worker-a',now:clock.now()}),/cannot heartbeat/);
  assert.deepEqual(store.claimNextJob('project-a','worker-a',{now:clock.now()}),{claimed:false,reason:'no-queued-job'});
}));

test('heartbeat extends the lease; expired leases need explicit reconciliation and never auto re-execute',()=>withStore(async({store,clock})=>{
  const job=store.createJob({projectId:'project-a',jobType:'noop',title:'Long work',idempotencyKey:'lease'});
  store.approveJob(job.id,{now:clock.now()});
  const claim=store.claimNextJob('project-a','worker-a',{now:clock.now(),leaseMs:5000});
  const t0=clock.now();
  const beat=store.heartbeatJob(job.id,claim.attempt.attempt,{workerId:'worker-a',now:clock.advanceMs(4000),leaseMs:5000});
  assert.equal(beat.lease_until,new Date(Date.parse(t0)+9000).toISOString());
  assert.deepEqual(store.reconcileExpiredLeases({now:clock.advanceMs(1000)}),[]);
  clock.advanceMs(6000);
  assert.throws(()=>store.heartbeatJob(job.id,claim.attempt.attempt,{workerId:'worker-a',now:clock.now(),leaseMs:5000}),/Lease already expired/);
  assert.deepEqual(store.reconcileExpiredLeases({now:clock.now()}),[job.id]);
  const quarantined=store.getJob(job.id);
  assert.equal(quarantined.status,'needs_reconciliation');
  assert.equal(quarantined.attempts[0].status,'orphaned');
  assert.throws(()=>store.reportJobResult(job.id,1,{workerId:'worker-a',outcome:'succeeded',now:clock.now()}),/cannot report a result/);
  assert.deepEqual(store.claimNextJob('project-a','worker-a',{now:clock.now()}),{claimed:false,reason:'project-quarantined',quarantinedJobId:job.id},'quarantine fences the project, not just the job');
}));

test('reconcile decisions requeue (fresh attempt), cancel or fail; history is preserved',()=>withStore(async({store,clock})=>{
  const job=store.createJob({projectId:'project-a',jobType:'noop',title:'Recoverable',idempotencyKey:'rec'});
  store.approveJob(job.id,{now:clock.now()});
  store.claimNextJob('project-a','worker-a',{now:clock.now(),leaseMs:1000});
  store.reconcileExpiredLeases({now:clock.advanceMs(2000)});
  const requeued=store.reconcileJob(job.id,{decision:'requeue',reason:'safe to rerun',now:clock.now()});
  assert.equal(requeued.status,'queued');assert.equal(requeued.last_attempt,1);
  const claim=store.claimNextJob('project-a','worker-a',{now:clock.now(),leaseMs:60000});
  assert.equal(claim.attempt.attempt,2);
  store.startJob(job.id,2,{workerId:'worker-a',now:clock.now()});
  const done=store.reportJobResult(job.id,2,{workerId:'worker-a',outcome:'succeeded',note:'second attempt ok',now:clock.now()});
  assert.equal(done.status,'succeeded');
  const full=store.getJob(job.id);
  assert.equal(full.attempts.length,2);
  assert.equal(full.attempts[0].status,'orphaned');assert.equal(full.attempts[1].status,'succeeded');
  assert.ok(full.events.some(e=>e.action==='lease_expired')&&full.events.some(e=>e.action==='requeued'));
  const job2=store.createJob({projectId:'project-b',jobType:'noop',title:'Quarantined',idempotencyKey:'rec2'});
  store.approveJob(job2.id,{now:clock.now()});
  store.claimNextJob('project-b','worker-a',{now:clock.now(),leaseMs:1000});
  store.reconcileExpiredLeases({now:clock.advanceMs(2000)});
  assert.equal(store.reconcileJob(job2.id,{decision:'cancel',now:clock.now()}).status,'cancelled');
  const job3=store.createJob({projectId:'project-b',jobType:'noop',title:'Quarantined 2',idempotencyKey:'rec3'});
  store.approveJob(job3.id,{now:clock.now()});
  store.claimNextJob('project-b','worker-a',{now:clock.now(),leaseMs:1000});
  store.reconcileExpiredLeases({now:clock.advanceMs(2000)});
  assert.equal(store.reconcileJob(job3.id,{decision:'fail',reason:'unsafe to rerun',now:clock.now()}).status,'failed');
  assert.throws(()=>store.reconcileJob(job.id,{decision:'requeue',now:clock.now()}),/does not need reconciliation/);
  assert.throws(()=>store.reconcileJob(job2.id,{decision:'requeue',now:clock.now()}),/does not need reconciliation/);
}));

test('jobs, attempts, approvals and leases survive a crash and database reopen',()=>withStore(async({store,dbPath,clock})=>{
  const job=store.createJob({projectId:'project-a',jobType:'noop',title:'Durable',idempotencyKey:'d1'});
  store.approveJob(job.id,{now:clock.now(),actor:'owner'});
  const claim=store.claimNextJob('project-a','worker-a',{now:clock.now(),leaseMs:600000});
  store.close();
  const reopened=new OwnerStore(dbPath);
  try{
    const persisted=reopened.getJob(job.id);
    assert.equal(persisted.status,'leased');
    assert.equal(persisted.approved_by,'owner');
    assert.equal(persisted.attempts.length,1);
    assert.equal(persisted.attempts[0].worker_id,'worker-a');
    assert.equal(persisted.lease_until,claim.job.lease_until);
    const result=reopened.startJob(job.id,1,{workerId:'worker-a',now:clock.now()});
    assert.equal(result.status,'running');
    const done=reopened.reportJobResult(job.id,1,{workerId:'worker-a',outcome:'succeeded',note:'after reopen',now:clock.now()});
    assert.equal(done.status,'succeeded');
    assert.ok(reopened.getJob(job.id).events.some(e=>e.action==='succeeded'));
  }finally{reopened.close();}
}));

test('cancellation distinguishes stop-request from actual stop; worker cannot cancel without a request',()=>withStore(async({store,clock})=>{
  // queued job cancels immediately and can never be claimed
  const queued=store.createJob({projectId:'project-a',jobType:'noop',title:'Cancel me early',idempotencyKey:'c1'});
  store.approveJob(queued.id,{now:clock.now()});
  assert.equal(store.requestCancelJob(queued.id,{now:clock.now()}).status,'cancelled');
  assert.deepEqual(store.claimNextJob('project-a','worker-a',{now:clock.now()}),{claimed:false,reason:'no-queued-job'});
  // pending_approval job also cancels directly
  const pending=store.createJob({projectId:'project-a',jobType:'noop',title:'Never approved',idempotencyKey:'c0'});
  assert.equal(store.requestCancelJob(pending.id,{now:clock.now()}).status,'cancelled');
  assert.throws(()=>store.approveJob(pending.id),/cannot be approved/);
  // leased attempt: owner requests stop, worker confirms without running
  const leased=store.createJob({projectId:'project-a',jobType:'noop',title:'Cancel while leased',idempotencyKey:'c4'});
  store.approveJob(leased.id,{now:clock.now()});
  store.claimNextJob('project-a','worker-a',{now:clock.now(),leaseMs:60000});
  assert.equal(store.requestCancelJob(leased.id,{now:clock.now()}).status,'cancel_requested');
  assert.equal(store.confirmJobCancelled(leased.id,1,{workerId:'worker-a',note:'never started',now:clock.now()}).status,'cancelled');
  assert.throws(()=>store.confirmJobCancelled(leased.id,1,{workerId:'worker-a',now:clock.now()}),/cannot confirm cancellation|not awaiting cancellation/);
  // running job: owner cancels mid-execution, complying worker reports cancellation
  const running=store.createJob({projectId:'project-a',jobType:'noop',title:'Complying worker',idempotencyKey:'c2'});
  store.approveJob(running.id,{now:clock.now()});
  const worker=new FakeWorker(store,{workerId:'worker-a',clock:clock.now,behaviors:{[running.id]:({job})=>{
    store.requestCancelJob(job.id,{actor:'owner',now:clock.now()}); // stop request arrives mid-run
    return {outcome:'cancelled',note:'stopped safely'};
  }}});
  const outcome=await worker.runOnce({projectId:'project-a'});
  assert.equal(outcome.outcome,'cancelled');
  assert.equal(store.getJob(running.id).status,'cancelled');
  assert.equal(store.getJob(running.id).attempts[0].status,'cancelled');
  // a running worker finishing despite the stop request still records a real outcome
  const finishes=store.createJob({projectId:'project-a',jobType:'noop',title:'Finishes despite request',idempotencyKey:'c5'});
  store.approveJob(finishes.id,{now:clock.now()});
  const workerC=new FakeWorker(store,{workerId:'worker-c',clock:clock.now,behaviors:{[finishes.id]:({job})=>{
    store.requestCancelJob(job.id,{actor:'owner',now:clock.now()});
    return {outcome:'succeeded',note:'completed before observing the request'};
  }}});
  const done=await workerC.runOnce({projectId:'project-a'});
  assert.equal(done.outcome,'succeeded');
  assert.equal(store.getJob(finishes.id).status,'succeeded');
  // worker aborting without an owner stop request is recorded as failure, not cancellation
  const stubborn=store.createJob({projectId:'project-b',jobType:'noop',title:'Aborting worker',idempotencyKey:'c3'});
  store.approveJob(stubborn.id,{now:clock.now()});
  const workerB=new FakeWorker(store,{workerId:'worker-b',clock:clock.now,behaviors:{[stubborn.id]:()=>({outcome:'cancelled'})}});
  const aborted=await workerB.runOnce({projectId:'project-b'});
  assert.equal(aborted.outcome,'failed');
  assert.equal(store.getJob(stubborn.id).status,'failed');
  assert.match(store.getJob(stubborn.id).attempts[0].result_note,/without a cancel request/);
}));

test('FakeWorker end-to-end: succeeded and injected-failure behaviors report through the store',()=>withStore(async({store,clock})=>{
  const ok=store.createJob({projectId:'project-a',jobType:'noop',title:'Will succeed',idempotencyKey:'e1'});
  store.approveJob(ok.id,{now:clock.now()});
  const worker=new FakeWorker(store,{workerId:'worker-a',clock:clock.now});
  const result=await worker.runOnce({projectId:'project-a'});
  assert.deepEqual(result,{claimed:true,jobId:ok.id,attempt:1,outcome:'succeeded'});
  assert.equal(store.getJob(ok.id).status,'succeeded');
  const bad=store.createJob({projectId:'project-b',jobType:'fake-analysis',title:'Will fail',idempotencyKey:'e2'});
  store.approveJob(bad.id,{now:clock.now()});
  const workerB=new FakeWorker(store,{workerId:'worker-b',clock:clock.now,behaviors:{'fake-analysis':()=>({outcome:'failed',note:'injected failure'})}});
  const failed=await workerB.runOnce({projectId:'project-b'});
  assert.equal(failed.outcome,'failed');
  assert.equal(store.getJob(bad.id).status,'failed');
  assert.equal(store.getJob(bad.id).attempts[0].result_note,'injected failure');
}));

test('worker success and Pi settlement never complete the linked owner task',()=>withStore(async({store,clock})=>{
  const task=store.createTask({projectId:'project-a',title:'Human-owned goal'});
  const job=store.createJob({projectId:'project-a',jobType:'noop',title:'Attempt the goal',idempotencyKey:'t1',ownerTaskId:task.id});
  assert.throws(()=>store.createJob({projectId:'project-b',jobType:'noop',title:'Cross',idempotencyKey:'t2',ownerTaskId:task.id}),/different project/);
  store.approveJob(job.id,{now:clock.now()});
  const worker=new FakeWorker(store,{workerId:'worker-a',clock:clock.now});
  await worker.runOnce({projectId:'project-a'});
  assert.equal(store.getJob(job.id).status,'succeeded');
  assert.equal(store.getTask(task.id).status,'todo');
  store.recordEvent({projectId:'project-a',kind:'run_settled',sessionId:'s1'});
  assert.equal(store.getTask(task.id).status,'todo');
}));

test('cross-project records never leak; job state surfaces in owner summary, attention and answers',()=>withStore(async({store,clock})=>{
  const a=store.createJob({projectId:'project-a',jobType:'noop',title:'A only',idempotencyKey:'x1'});
  store.createJob({projectId:'project-b',jobType:'noop',title:'B only',idempotencyKey:'x2'});
  const listA=store.listJobs({projectId:'project-a'});
  assert.equal(listA.length,1);assert.equal(listA[0].id,a.id);
  const summary=store.summary();
  assert.equal(summary.pendingJobApprovals,2);assert.equal(summary.activeJobs,0);
  const agent=new OwnerAgent(store);
  assert.ok(agent.attention().some(x=>x.kind==='job-approval'));
  const reply=agent.answer('现在有哪些执行 job？');
  assert.match(reply.answer,/待审批 2/);assert.match(reply.basis.join(','),/job:/);
  assert.equal(reply.mode,'local-rules');
  store.approveJob(a.id,{now:clock.now()});
  store.claimNextJob('project-a','worker-a',{now:clock.now(),leaseMs:1000});
  store.reconcileExpiredLeases({now:clock.advanceMs(5000)});
  assert.ok(agent.attention().some(x=>x.kind==='job-stuck'));
  const after=store.summary();
  assert.equal(after.stuckJobs,1);assert.equal(after.activeJobs,0);assert.equal(after.pendingJobApprovals,1);
  const jobReply=agent.answer('project-b 执行情况');
  assert.match(jobReply.answer,/管道中 0/);
}));

test('HTTP owner summary exposes durable job fields on the same DB',()=>withStore(async({store,dbPath})=>{
  const job=store.createJob({projectId:'project-a',jobType:'noop',title:'HTTP visible',idempotencyKey:'h1'});
  const server=await createWorkbenchServer({port:0,dbPath});
  const {port}=await server.listen();
  try{
    const sum=await (await fetch(`http://127.0.0.1:${port}/api/owner/summary`)).json();
    assert.equal(sum.pendingJobApprovals,1);
    const project=sum.projects.find(p=>p.id==='project-a');
    assert.equal(project.jobs.length,1);assert.equal(project.jobs[0].id,job.id);
  }finally{await server.close();}
}));

// ---- Review round 1 regression tests ----

test('[review r1 #1] the created audit event carries a valid, traceable creation timestamp',()=>withStore(async({store,clock})=>{
  const at=clock.now();
  const job=store.createJob({projectId:'project-a',jobType:'noop',title:'Audited creation',idempotencyKey:'audit-1',now:at});
  const created=store.getJob(job.id).events.find(e=>e.action==='created');
  assert.ok(created,'created audit event exists');
  assert.equal(job.created_at,at,'createJob honors the injected now for created_at');
  assert.equal(created.at,at,'audit time equals the injected creation timestamp');
  assert.match(created.at,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,'audit time is a real ISO timestamp, not an empty string');
  assert.equal(created.detail,'noop');
}));

test('[review r1 #2] expired leases block start and cancel-confirm before the reconcile scan; timely workers are unaffected',()=>withStore(async({store,clock})=>{
  // start after lease expiry but before the scan: rejected, must go through reconciliation
  const jobA=store.createJob({projectId:'project-a',jobType:'noop',title:'Late starter',idempotencyKey:'lease-s1'});
  store.approveJob(jobA.id,{now:clock.now()});
  store.claimNextJob('project-a','worker-a',{now:clock.now(),leaseMs:1000});
  clock.advanceMs(2000);
  assert.throws(()=>store.startJob(jobA.id,1,{workerId:'worker-a',now:clock.now()}),/Lease already expired/);
  assert.throws(()=>store.heartbeatJob(jobA.id,1,{workerId:'worker-a',now:clock.now(),leaseMs:5000}),/Lease already expired/);
  // cancel-confirm after lease expiry: rejected as well
  const jobB=store.createJob({projectId:'project-b',jobType:'noop',title:'Late canceller',idempotencyKey:'lease-s2'});
  store.approveJob(jobB.id,{now:clock.now()});
  store.claimNextJob('project-b','worker-b',{now:clock.now(),leaseMs:1000});
  store.requestCancelJob(jobB.id,{now:clock.now()});
  clock.advanceMs(2000);
  assert.throws(()=>store.confirmJobCancelled(jobB.id,1,{workerId:'worker-b',now:clock.now()}),/Lease already expired/);
  assert.equal(store.getJob(jobB.id).status,'cancel_requested','still awaiting human reconciliation, not silently stopped');
  // freeing the pipeline goes through the human path: scan → explicit decision
  const scanned=store.reconcileExpiredLeases({now:clock.now()});
  assert.ok(scanned.includes(jobA.id)&&scanned.includes(jobB.id),'both expired leases are quarantined');
  assert.equal(store.reconcileJob(jobB.id,{decision:'fail',reason:'worker unreachable after lease expiry',now:clock.now()}).status,'failed');
  // timely workers on a valid lease are unaffected
  const jobC=store.createJob({projectId:'project-b',jobType:'noop',title:'Timely worker',idempotencyKey:'lease-s3'});
  store.approveJob(jobC.id,{now:clock.now()});
  store.claimNextJob('project-b','worker-b',{now:clock.now(),leaseMs:60000});
  store.requestCancelJob(jobC.id,{now:clock.now()});
  assert.equal(store.confirmJobCancelled(jobC.id,1,{workerId:'worker-b',now:clock.now(),}).status,'cancelled');
  const jobD=store.createJob({projectId:'project-b',jobType:'noop',title:'Timely starter',idempotencyKey:'lease-s4'});
  store.approveJob(jobD.id,{now:clock.now()});
  store.claimNextJob('project-b','worker-b',{now:clock.now(),leaseMs:60000});
  assert.equal(store.startJob(jobD.id,1,{workerId:'worker-b',now:clock.now()}).status,'running');
}));

test('[review r1 #3] the idempotency identity includes the target owner task; title stays display-only',()=>withStore(async({store})=>{
  const taskA=store.createTask({projectId:'project-a',title:'Goal A'});
  const taskB=store.createTask({projectId:'project-a',title:'Goal B'});
  const first=store.createJob({projectId:'project-a',jobType:'noop',title:'First title',payload:{note:'x'},idempotencyKey:'task-key',ownerTaskId:taskA.id});
  // same key+type+payload but a different target task must conflict, not silently re-point
  assert.throws(()=>store.createJob({projectId:'project-a',jobType:'noop',title:'Other title',payload:{note:'x'},idempotencyKey:'task-key',ownerTaskId:taskB.id}),/different target owner task/);
  assert.equal(store.getJob(first.id).owner_task_id,taskA.id,'original binding is unchanged');
  // a different title alone is still an idempotent duplicate: title is display-only
  const sameEverything=store.createJob({projectId:'project-a',jobType:'noop',title:'Renamed title',payload:{note:'x'},idempotencyKey:'task-key',ownerTaskId:taskA.id});
  assert.equal(sameEverything.id,first.id);assert.equal(sameEverything.duplicate,true);
  assert.equal(store.getJob(first.id).title,'First title','duplicate submission does not rewrite the stored title');
  // resubmission without any task against a task-bound key also conflicts
  assert.throws(()=>store.createJob({projectId:'project-a',jobType:'noop',title:'No task',payload:{note:'x'},idempotencyKey:'task-key'}),/different target owner task/);
}));

test('[review r1 #5] job counts and attention stay SQL-accurate far beyond default listing limits',()=>withStore(async({store,clock})=>{
  // 220 pending approvals: default listJobs limit (50) and old attention cap (200) must not hide any of them
  for(let i=0;i<220;i++)store.createJob({projectId:i%2?'project-a':'project-b',jobType:'noop',title:`bulk ${i}`,idempotencyKey:`bulk-${i}`});
  assert.equal(store.listJobs({limit:50}).length,50,'default listing stays capped');
  const s=store.summary();
  assert.equal(s.totalJobs,220,'summary counts the full table');
  assert.equal(s.pendingJobApprovals,220,'pending approvals are not under-reported');
  assert.equal(s.activeJobs,0);
  const agent=new OwnerAgent(store);
  const attention=agent.attention();
  const approvalItem=attention.find(x=>x.kind==='job-approval');
  assert.ok(approvalItem,'attention reports pending job approvals');
  assert.match(approvalItem.title,/220/,'attention title carries the true count');
  assert.equal(approvalItem.evidence.length,100,'evidence list is explicitly capped at 100');
  // status filtering happens in SQL: a filtered listing only contains that status
  const pendingOnly=store.listJobs({status:'pending_approval',limit:500});
  assert.equal(pendingOnly.length,220);
  assert.ok(pendingOnly.every(j=>j.status==='pending_approval'));
  const projectOnly=store.listJobs({projectId:'project-a',status:'pending_approval',limit:500});
  assert.equal(projectOnly.length,110);
  assert.ok(projectOnly.every(j=>j.project_id==='project-a'));
  // approve one: counts move without listing caps interfering
  store.approveJob(pendingOnly[0].id,{now:clock.now()});
  const after=store.summary();
  assert.equal(after.pendingJobApprovals,219);assert.equal(after.activeJobs,1);
}));

test('[review r1 #6] requeue requires an explicit safety-review reason; cancel/fail stay optional-reason',()=>withStore(async({store,clock})=>{
  const setup=async(key,project)=>{const job=store.createJob({projectId:project,jobType:'noop',title:'Quarantined',idempotencyKey:key});
    store.approveJob(job.id,{now:clock.now()});
    store.claimNextJob(project,'worker-a',{now:clock.now(),leaseMs:1000});
    store.reconcileExpiredLeases({now:clock.advanceMs(2000)});
    return job;};
  const job=await setup('rr1','project-a');
  assert.throws(()=>store.reconcileJob(job.id,{decision:'requeue',now:clock.now()}),/reconcile reason/,'empty reason is rejected');
  assert.throws(()=>store.reconcileJob(job.id,{decision:'requeue',reason:'   ',now:clock.now()}),/reconcile reason/,'whitespace-only reason is rejected');
  const requeued=store.reconcileJob(job.id,{decision:'requeue',reason:'verified no external side effects occurred',actor:'owner',now:clock.now()});
  assert.equal(requeued.status,'queued');
  assert.equal(store.getJob(job.id).events.find(e=>e.action==='requeued').detail,'verified no external side effects occurred','reason is recorded in the audit trail');
  const job2=await setup('rr2','project-b');
  assert.equal(store.reconcileJob(job2.id,{decision:'cancel',now:clock.now()}).status,'cancelled');
  const job3=await setup('rr3','project-b');
  assert.equal(store.reconcileJob(job3.id,{decision:'fail',now:clock.now()}).status,'failed');
}));

// ---- Review round 2 regression tests ----

test('[review r2 #1] an unsettled job fences its whole project: no approve/claim until explicit reconciliation',()=>withStore(async({store,clock})=>{
  const a=store.createJob({projectId:'project-a',jobType:'noop',title:'Crashed A',idempotencyKey:'q1'});
  store.approveJob(a.id,{now:clock.now()});
  store.claimNextJob('project-a','worker-a',{now:clock.now(),leaseMs:1000});
  store.startJob(a.id,1,{workerId:'worker-a',now:clock.now()});
  clock.advanceMs(5000);
  store.reconcileExpiredLeases({now:clock.now()});
  assert.equal(store.getJob(a.id).status,'needs_reconciliation');
  // the fence blocks BOTH scheduling paths of the same project while A is unresolved
  const b=store.createJob({projectId:'project-a',jobType:'noop',title:'B while quarantined',idempotencyKey:'q2'});
  assert.throws(()=>store.approveJob(b.id,{now:clock.now()}),/unresolved needs_reconciliation job/);
  const blocked=store.claimNextJob('project-a','worker-a',{now:clock.now(),leaseMs:60000});
  assert.deepEqual(blocked,{claimed:false,reason:'project-quarantined',quarantinedJobId:a.id});
  // other projects are untouched by the fence
  const c=store.createJob({projectId:'project-b',jobType:'noop',title:'C elsewhere',idempotencyKey:'q3'});
  store.approveJob(c.id,{now:clock.now()});
  assert.equal(store.claimNextJob('project-b','worker-c',{now:clock.now(),leaseMs:60000}).claimed,true);
  // explicit human reconciliation lifts the fence; the requeued job is then re-claimable
  store.reconcileJob(a.id,{decision:'requeue',reason:'verified no side effects',actor:'owner',now:clock.now()});
  const reclaim=store.claimNextJob('project-a','worker-a',{now:clock.now(),leaseMs:60000});
  assert.equal(reclaim.claimed,true);
  assert.equal(reclaim.job.id,a.id);assert.equal(reclaim.attempt.attempt,2);
  store.startJob(a.id,2,{workerId:'worker-a',now:clock.now()});
  store.reportJobResult(a.id,2,{workerId:'worker-a',outcome:'succeeded',now:clock.now()});
  // pipeline drained: B can finally flow
  assert.equal(store.approveJob(b.id,{now:clock.now()}).status,'queued');
  assert.equal(store.claimNextJob('project-a','worker-a',{now:clock.now(),leaseMs:60000}).claimed,true);
}));

test('[review r2 #2] expired-lease attention count is SQL-accurate beyond 100 concurrent leases',()=>withStore(async({store,clock,dir})=>{
  const t0=clock.now();
  for(let i=0;i<105;i++){
    const sub=path.join(dir,'lease-p'+i);mkdirSync(sub,{recursive:true});
    store.registerProject({id:'lp'+i,name:'Lease Project '+i,root:sub,primaryDomain:'pi-sdk'});
    const job=store.createJob({projectId:'lp'+i,jobType:'noop',title:'lease '+i,idempotencyKey:'k'});
    store.approveJob(job.id,{now:t0});
    store.claimNextJob('lp'+i,'worker',{now:t0,leaseMs:1000});
  }
  clock.advanceMs(5000);
  assert.equal(store.countJobsWithExpiredLeases({now:clock.now()}),105,'true count with the same filter as the listing');
  const agent=new OwnerAgent(store);
  const item=agent.attention().find(x=>x.kind==='job-lease-expired');
  assert.ok(item,'attention reports expired leases');
  assert.match(item.title,/105/,'title carries the true count, not the capped list length');
  assert.equal(item.evidence.length,100,'evidence stays explicitly capped at 100');
}));

test('[review r2 #4] claim honors maxActiveJobsPerProject instead of hard-coding a single busy job',()=>withStore(async({store,dbPath,clock})=>{
  const tuned=new OwnerStore(dbPath,{maxActiveJobsPerProject:2});
  try{
    const jobs=['m1','m2','m3'].map(k=>store.createJob({projectId:'project-a',jobType:'noop',title:k,idempotencyKey:k}));
    tuned.approveJob(jobs[0].id,{now:clock.now()});
    tuned.approveJob(jobs[1].id,{now:clock.now()});
    assert.throws(()=>tuned.approveJob(jobs[2].id,{now:clock.now()}),/per-project limit blocks approval/);
    const first=tuned.claimNextJob('project-a','w1',{now:clock.now(),leaseMs:60000});
    const second=tuned.claimNextJob('project-a','w2',{now:clock.now(),leaseMs:60000});
    assert.equal(first.claimed,true);assert.equal(second.claimed,true);
    assert.notEqual(first.job.id,second.job.id);
    const third=tuned.claimNextJob('project-a','w3',{now:clock.now(),leaseMs:60000});
    assert.equal(third.claimed,false);assert.equal(third.reason,'project-active-job');
    // default store still enforces strict serial execution
    const serial=new OwnerStore(dbPath);
    try{assert.equal(serial.claimNextJob('project-a','w4',{now:clock.now(),leaseMs:60000}).reason,'project-active-job');}
    finally{serial.close();}
  }finally{tuned.close();}
}));
