// Minimal deterministic demo of the v0.6 durable task coordinator (control plane + FakeWorker).
// Temporary DB, fake clock, no real executors, no network, no model calls.
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync,rmSync,mkdirSync } from 'node:fs';
import { OwnerStore } from '../src/owner-store.mjs';
import { OwnerAgent } from '../src/owner-agent.mjs';
import { FakeWorker } from '../src/job-worker.mjs';

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
  show('submitted (pending_approval; owner approval required)',{id:job.id,status:job.status});
  show('idempotent resubmission returns the same job',{duplicate:store.createJob({projectId:'service-a',jobType:'noop',title:'Replay idempotency checks',payload:{scope:'retry-module'},idempotencyKey:'run-2026-06-01'}).duplicate});

  const workerA=new FakeWorker(store,{workerId:'fake-a',clock:now,leaseMs:30000});
  show('claim before approval is refused',await workerA.runOnce({projectId:'service-a'}));

  store.approveJob(job.id,{actor:'owner',now:now()});
  show('approved, claimed, executed once',await workerA.runOnce({projectId:'service-a'}));
  const after=store.getJob(job.id);
  show('job after success',{status:after.status,attempts:after.attempts.length});
  show('owner task untouched by worker success',{taskStatus:store.getTask(task.id).status});

  const crash=store.createJob({projectId:'service-a',jobType:'fake-analysis',title:'Analysis that will crash',idempotencyKey:'run-crash'});
  store.approveJob(crash.id,{actor:'owner',now:now()});
  try{await new FakeWorker(store,{workerId:'fake-a',clock:now}).runOnce({projectId:'service-a',behavior:()=>({outcome:'crash'})});}
  catch(e){show('worker crashed without reporting (lease will expire)',e.message);}
  advance(60000);
  show('explicit reconcile scan marks expired leases',store.reconcileExpiredLeases({now:now()}));
  store.reconcileJob(crash.id,{decision:'requeue',reason:'analysis is safe to rerun',actor:'owner',now:now()});
  const retry=new FakeWorker(store,{workerId:'fake-a',clock:now,behaviors:{'fake-analysis':()=>({outcome:'failed',note:'injected failure'})}});
  show('attempt 2 after requeue (injected failure)',await retry.runOnce({projectId:'service-a'}));

  const stoppable=store.createJob({projectId:'service-b',jobType:'status-note',title:'Cancellable job',idempotencyKey:'run-stop'});
  store.approveJob(stoppable.id,{actor:'owner',now:now()});
  const workerB=new FakeWorker(store,{workerId:'fake-b',clock:now,behaviors:{[stoppable.id]:({job})=>{
    store.requestCancelJob(job.id,{actor:'owner',now:now()});
    return {outcome:'cancelled',note:'stopped safely on request'};
  }}});
  show('cancellation requested mid-run, worker complies',await workerB.runOnce({projectId:'service-b'}));

  const dup=store.createJob({projectId:'service-b',jobType:'status-note',title:'Duplicate submit',idempotencyKey:'run-stop'});
  show('duplicate submit is a no-op',{duplicate:!!dup.duplicate});

  show('owner overview answer (deterministic, from persisted records)',new OwnerAgent(store).answer('现在有哪些执行 job？'));
  const s=store.summary();
  show('final summary',{activeJobs:s.activeJobs,stuckJobs:s.stuckJobs,pendingJobApprovals:s.pendingJobApprovals});
}finally{store.close();rmSync(dir,{recursive:true,force:true});}
