// Minimal deterministic demo of the v0.6 durable task coordinator (control plane + FakeWorker).
// Temporary DB, fake clock, no real executors, no network, no model calls.
// Every critical state transition is explicitly asserted; any failure exits non-zero.
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync,rmSync,mkdirSync } from 'node:fs';
import { OwnerStore } from '../src/owner-store.mjs';
import { OwnerAgent } from '../src/owner-agent.mjs';
import { FakeWorker,FakeWorkerCrash } from '../src/job-worker.mjs';

let failures=0;
const expect=(label,actual,expected)=>{const ok=actual===expected;
  console.log(`${ok?'[OK]  ':'[FAIL]'} ${label} (actual=${JSON.stringify(actual)}${ok?'':`, expected=${JSON.stringify(expected)}`})`);
  if(!ok)failures++;};
const show=(label,value)=>console.log(`\n== ${label} ==\n${JSON.stringify(value,null,1)}`);
let t=Date.parse('2026-06-01T09:00:00.000Z');
const now=()=>new Date(t).toISOString();
const advance=(ms)=>{t+=ms;return now();};

const dir=mkdtempSync(path.join(os.tmpdir(),'owner-jobs-demo-'));
const store=new OwnerStore(path.join(dir,'demo.sqlite'));
try{
  store.registerProject({id:'service-a',name:'Payment Service',root:dir,primaryDomain:'software-engineering',goal:'Harden retry paths'});
  const dirB=path.join(dir,'b');mkdirSync(dirB,{recursive:true});
  store.registerProject({id:'service-b',name:'Queue Worker',root:dirB,primaryDomain:'software-engineering',goal:'Lease recovery practice'});
  const task=store.createTask({projectId:'service-a',title:'Verify idempotency after refactor'});
  const job=store.createJob({projectId:'service-a',jobType:'noop',title:'Replay idempotency checks',payload:{scope:'retry-module'},idempotencyKey:'run-2026-06-01',ownerTaskId:task.id});
  expect('submitted job starts pending_approval',job.status,'pending_approval');
  expect('audit event for creation carries the created_at timestamp',store.getJob(job.id).events[0].at,job.created_at);
  const dup=store.createJob({projectId:'service-a',jobType:'noop',title:'Replay idempotency checks',payload:{scope:'retry-module'},idempotencyKey:'run-2026-06-01',ownerTaskId:task.id});
  expect('idempotent resubmission returns the same job id',dup.id,job.id);

  const workerA=new FakeWorker(store,{workerId:'fake-a',clock:now,leaseMs:30000});
  const beforeApproval=await workerA.runOnce({projectId:'service-a'});
  expect('claim before approval is refused',beforeApproval.claimed,false);

  store.approveJob(job.id,{actor:'owner',now:now()});
  const firstRun=await workerA.runOnce({projectId:'service-a'});
  expect('first approved run claims the submitted job',firstRun.jobId,job.id);
  expect('first approved run succeeds on attempt 1',`${firstRun.outcome}:${firstRun.attempt}`,'succeeded:1');
  const after=store.getJob(job.id);
  expect('job terminal state is succeeded',after.status,'succeeded');
  expect('owner task is untouched by worker success',store.getTask(task.id).status,'todo');

  const crash=store.createJob({projectId:'service-a',jobType:'fake-analysis',title:'Analysis that will crash',idempotencyKey:'run-crash'});
  store.approveJob(crash.id,{actor:'owner',now:now()});
  let crashed=false;
  try{await new FakeWorker(store,{workerId:'fake-a',clock:now}).runOnce({projectId:'service-a',behavior:()=>({outcome:'crash'})});}
  catch(e){crashed=e instanceof FakeWorkerCrash;}
  expect('crashing worker throws without reporting',crashed,true);
  advance(60000);
  const expired=store.reconcileExpiredLeases({now:now()});
  expect('reconcile scan quarantines the crashed job',expired.includes(crash.id),true);
  const noReasonRejected=(()=>{try{store.reconcileJob(crash.id,{decision:'requeue',now:now()});return false;}catch{return true;}})();
  expect('requeue without a safety-review reason is rejected',noReasonRejected,true);
  store.reconcileJob(crash.id,{decision:'requeue',reason:'analysis is side-effect free; safe to rerun',actor:'owner',now:now()});
  const retry=new FakeWorker(store,{workerId:'fake-a',clock:now,behaviors:{'fake-analysis':()=>({outcome:'failed',note:'injected failure'})}});
  const secondRun=await retry.runOnce({projectId:'service-a'});
  expect('requeued job runs on the same id with a fresh attempt 2',`${secondRun.jobId===crash.id}|${secondRun.attempt}`,`true|2`);
  expect('injected failure is recorded honestly',secondRun.outcome,'failed');

  // Project B: cancellation target is referenced explicitly by id, never via closure shadowing.
  const stoppable=store.createJob({projectId:'service-b',jobType:'status-note',title:'Cancellable job',idempotencyKey:'run-stop'});
  store.approveJob(stoppable.id,{actor:'owner',now:now()});
  const workerB=new FakeWorker(store,{workerId:'fake-b',clock:now,behaviors:{[stoppable.id]:({job})=>{
    if(job.id!==stoppable.id)throw new Error(`behavior bound to ${stoppable.id} but claimed ${job.id}`);
    store.requestCancelJob(stoppable.id,{actor:'owner',now:now()});
    return {outcome:'cancelled',note:'stopped safely on request'};
  }}});
  const cancelledRun=await workerB.runOnce({projectId:'service-b'});
  expect('mid-run stop request cancels exactly the target job',cancelledRun.jobId,stoppable.id);
  expect('worker outcome reflects compliance with the stop request',cancelledRun.outcome,'cancelled');
  expect('target job terminal state is cancelled',store.getJob(stoppable.id).status,'cancelled');
  expect('the earlier succeeded job stayed succeeded',store.getJob(job.id).status,'succeeded');
  const dupAgain=store.createJob({projectId:'service-b',jobType:'status-note',title:'Duplicate submit',idempotencyKey:'run-stop'});
  expect('duplicate submit after cancellation is still a no-op',dupAgain.duplicate,true);

  const s=store.summary();
  expect('summary counts every job with no active/stuck/pending leftovers',`${s.totalJobs}:${s.activeJobs}:${s.stuckJobs}:${s.pendingJobApprovals}`,'3:0:0:0');
  const answer=new OwnerAgent(store).answer('现在有哪些执行 job？');
  expect('owner answer cites persisted job ids',/job:/.test(answer.basis.join(',')),true);

  console.log('\n== demo finished ==');
  if(failures){console.error(`\n${failures} demo assertion(s) failed`);process.exitCode=1;}
  else console.log('\nAll demo assertions passed');
}finally{store.close();rmSync(dir,{recursive:true,force:true});}
