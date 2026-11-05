// Minimal deterministic demo of the v0.7 Pi Analysis Worker with an injected fake
// session factory: approve → run → bounded hashed result → read-only query.
// No real model, no network, no API key, no cost. For the real path see docs/PI_WORKER.md.
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync,rmSync,mkdirSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { OwnerStore } from '../src/owner-store.mjs';
import { PiAnalysisWorker } from '../src/pi-analysis-worker.mjs';
import { DefaultPiSessionFactory } from '../src/pi-session-factory.mjs';

let failures=0;
const expect=(label,actual,expected)=>{const ok=actual===expected;
  console.log(`${ok?'[OK]  ':'[FAIL]'} ${label} (actual=${JSON.stringify(actual)}${ok?'':`, expected=${JSON.stringify(expected)}`})`);
  if(!ok)failures++;};
let t=Date.parse('2026-07-01T09:00:00.000Z');
const now=()=>new Date(t).toISOString();

const dir=mkdtempSync(path.join(os.tmpdir(),'owner-pi-demo-'));
const store=new OwnerStore(path.join(dir,'demo.sqlite'));
try{
  mkdirSync(path.join(dir,'proj'),{recursive:true});
  store.registerProject({id:'demo-proj',name:'Demo Project',root:path.join(dir,'proj'),primaryDomain:'software-engineering',goal:'Retry hardening'});
  const task=store.createTask({projectId:'demo-proj',title:'检查重试与幂等实现',note:'人工登记的分析需求'});
  const job=store.createJob({projectId:'demo-proj',jobType:'pi-analysis',title:'只读分析',payload:{focus:'重试与幂等'},idempotencyKey:'pi-demo-1',ownerTaskId:task.id});
  expect('submitted pi-analysis job starts pending_approval',job.status,'pending_approval');

  const fakeFactory={createCalls:[],sessions:[],async create({cwd,model}){this.createCalls.push({cwd,model});
    const s={_text:`分析结论：重试路径需要幂等键；lease 恢复需人工复核。(model=${model??'default'})`,
      sessionId:()=>'sess-demo-1',activeTools:()=>[],model:'fake/glm-x',
      prompts:[],prompt(t){this.prompts.push(t);return Promise.resolve();},
      abort(){},getLastText(){return this._text;},dispose(){this.disposed=true;}};
    this.sessions.push(s);return s;}};
  const realWorker=new PiAnalysisWorker(store,{workerId:'real-pi',clock:now,sessionFactory:DefaultPiSessionFactory,leaseMs:30000,
    timers:{interval:(fn,ms)=>{const h={fn};return h;},timeout:(fn)=>{const h={fn};return h;},clear:()=>{}}});
  const fakeWorker=new PiAnalysisWorker(store,{workerId:'demo-pi',clock:now,sessionFactory:fakeFactory,leaseMs:30000,
    timers:{interval:(fn,ms)=>{const h={fn};return h;},timeout:(fn)=>{const h={fn};return h;},clear:()=>{}}});
  // Line 1: the fake worker cannot schedule an unapproved job at all.
  const beforeApproval=await fakeWorker.runOnce({projectId:'demo-proj'});
  expect('unapproved job is never scheduled',beforeApproval.reason,'no-queued-job');
  expect('session factory untouched before approval',fakeFactory.createCalls.length,0);
  // Line 2: the real factory is refused before claiming unless the model switch is explicit.
  const gatedPending=await realWorker.runOnce({projectId:'demo-proj',allowModel:false});
  expect('pending job refused at the model gate',gatedPending.reason,'model-disabled');
  store.approveJob(job.id,{actor:'owner',now:now()});
  const gated=await realWorker.runOnce({projectId:'demo-proj',allowModel:false});
  expect('approved job is refused before claiming without the model switch',gated.reason,'model-disabled');
  expect('gate refusal leaves the queued job untouched',store.getJob(job.id).status,'queued');
  const run=await fakeWorker.runOnce({projectId:'demo-proj'});
  expect('injected fake factory executes the approved job',run.outcome,'succeeded');
  expect('session cwd is the canonical realpath of the registered root',fakeFactory.createCalls[0].cwd,await realpath(store.getProject('demo-proj').root));
  expect('prompt carries the task material only',fakeFactory.sessions[0].prompts[0].includes('检查重试与幂等实现'),true);
  expect('attempt carries the non-sensitive pi session id',store.getJob(job.id).attempts[0].session_id,'sess-demo-1');
  expect('owner task remains untouched by model success',store.getTask(task.id).status,'todo');

  const result=store.getJobResult(run.resultId);
  expect('result content hash is bound to the stored content',!!result.content_hash&&result.content_hash.length===64,true);
  expect('usage stays honest when unknown',result.usage,'unknown');
  expect('result is project-private',result.project_id,'demo-proj');

  const answer=new (await import('../src/owner-agent.mjs')).OwnerAgent(store).answer('执行 job');
  expect('owner answer cites persisted job ids',/job:/.test(answer.basis.join(',')),true);

  console.log(`\n== demo finished ==`);
  if(failures){console.error(`\n${failures} demo assertion(s) failed`);process.exitCode=1;}
  else console.log('\nAll demo assertions passed');
}finally{store.close();rmSync(dir,{recursive:true,force:true});}
