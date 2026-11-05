#!/usr/bin/env node
import { resolve } from 'node:path';
import { OwnerStore } from '../src/owner-store.mjs';
import { OwnerAgent } from '../src/owner-agent.mjs';
import { FakeWorker, FakeWorkerCrash } from '../src/job-worker.mjs';
import { PiAnalysisWorker } from '../src/pi-analysis-worker.mjs';
import { DefaultPiSessionFactory } from '../src/pi-session-factory.mjs';
import { defaultDbPath } from '../src/storage.mjs';
const store=new OwnerStore(process.env.OWNER_AGENT_DB??defaultDbPath());
const args=process.argv.slice(2);const command=args.shift();
const read=(flag,defaultValue='')=>{const i=args.indexOf(flag);return i===-1?defaultValue:args[i+1];};
const parsePayload=(text)=>{try{const v=JSON.parse(text||'{}');return v&&typeof v==='object'&&!Array.isArray(v)?v:(()=>{throw new Error('Payload must be a JSON object');})();}catch(e){throw new Error(`Invalid payload JSON: ${e.message}`);}};
const demoBehavior=(name)=>({
  succeeded:()=>({outcome:'succeeded',note:'demo behavior: succeeded'}),
  failed:()=>({outcome:'failed',note:'demo behavior: failed'}),
  cancelled:()=>({outcome:'cancelled',note:'demo behavior: complied with stop request'}),
  crash:()=>{throw new FakeWorkerCrash();}
}[name]);
try {
  let result;
  if(command==='register')result=store.registerProject({id:read('--id'),name:read('--name'),root:resolve(read('--root','.' )),primaryDomain:read('--domain','software-engineering'),domains:read('--domains').split(',').filter(Boolean),goal:read('--goal')});
  else if(command==='projects')result=store.listProjects();
  else if(command==='summary')result=store.summary();
  else if(command==='tasks')result=store.listTasks(read('--project'));
  else if(command==='project-status')result=store.updateProject(read('--id'),{status:read('--status')});
  else if(command==='task-status')result=store.updateTask(read('--id'),{status:read('--status')});
  else if(command==='attention')result=new OwnerAgent(store).attention();
  else if(command==='suggestions')result=store.listSuggestions(read('--status'));
  else if(command==='suggest')result=store.proposeReuse({sourceProjectId:read('--from'),targetProjectId:read('--to'),knowledgeId:read('--knowledge'),rationale:read('--why')});
  else if(command==='review')result=store.reviewSuggestion(read('--id'),{decision:read('--decision'),reviewer:'ownerctl'});
  else if(command==='task')result=store.createTask({projectId:read('--project'),title:read('--title'),status:read('--status','todo'),note:read('--note')});
  else if(command==='note')result=store.recordEvent({projectId:read('--project'),kind:'project_note',note:read('--text')});
  else if(command==='job-submit')result=store.createJob({projectId:read('--project'),jobType:read('--type','noop'),title:read('--title','Owner job'),payload:parsePayload(read('--payload','{}')),idempotencyKey:read('--key'),ownerTaskId:read('--task'),actor:'ownerctl'});
  else if(command==='job-approve')result=store.approveJob(read('--id'),{actor:'ownerctl'});
  else if(command==='job-reject')result=store.rejectJob(read('--id'),{actor:'ownerctl',reason:read('--reason')});
  else if(command==='jobs')result=store.listJobs({projectId:read('--project'),status:read('--status'),limit:100});
  else if(command==='job')result=store.getJob(read('--id'));
  else if(command==='job-cancel')result=store.requestCancelJob(read('--id'),{actor:'ownerctl'});
  else if(command==='jobs-reconcile')result={expiredJobIds:store.reconcileExpiredLeases()};
  else if(command==='job-reconcile')result=store.reconcileJob(read('--id'),{decision:read('--decision'),reason:read('--reason'),actor:'ownerctl'});
  else if(command==='run-once'){
    if(read('--worker','fake')==='pi'){
      const worker=new PiAnalysisWorker(store,{workerId:read('--worker-name','pi-analysis-worker'),model:read('--model',''),timeoutMs:Math.max(5000,Number(read('--timeout','120000'))||120000)});
      result=await worker.runOnce({projectId:read('--project'),allowModel:read('--allow-model')==='1'});
    }else{
      result=await new FakeWorker(store,{workerId:read('--worker-name','fake-worker')}).runOnce({projectId:read('--project'),behavior:demoBehavior(read('--behavior','succeeded'))});
    }
  }
  else if(command==='result')result=store.getJobResult(read('--id'));
  else if(command==='results')result=store.listJobResults(read('--job'));
  else if(command==='ask')result=new OwnerAgent(store).answer(args.join(' '));
  else if(command==='ask-pi')result=await new OwnerAgent(store).askPi(args.join(' '));
  else if(command==='events')result=store.listEvents({projectId:read('--project')});
  else throw new Error('Use: register --id --name --root | projects | summary | attention | task --project --title | task-status --id --status | project-status --id --status | suggest --from --to --knowledge --why | suggestions | review --id --decision approved/rejected | note --project --text | ask QUESTION | ask-pi QUESTION | events | job-submit --project --type --title --payload --key [--task] | job-approve --id | job-reject --id --reason | jobs [--project] [--status] | job --id | job-cancel --id | jobs-reconcile | job-reconcile --id --decision requeue/cancel/fail [--reason] | run-once --worker fake [--behavior succeeded/failed/cancelled/crash] | run-once --worker pi --project --allow-model 1 [--model M] [--timeout ms] [--worker-name W] | result --id | results --job');
  console.log(JSON.stringify(result,null,2));
}catch(e){console.error(e.message);process.exitCode=1;}
finally{store.close();}
