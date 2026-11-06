#!/usr/bin/env node
import { resolve } from 'node:path';
import { OwnerStore } from '../src/owner-store.mjs';
import { OwnerAgent } from '../src/owner-agent.mjs';
import { FakeWorker, FakeWorkerCrash } from '../src/job-worker.mjs';
import { PiAnalysisWorker } from '../src/pi-analysis-worker.mjs';
import { PatchCodingWorker } from '../src/patch-coding-worker.mjs';
import { WorkspaceBroker } from '../src/workspace-broker.mjs';
import { defaultDbPath } from '../src/storage.mjs';
const store=new OwnerStore(process.env.OWNER_AGENT_DB??defaultDbPath());
const args=process.argv.slice(2);const command=args.shift();
const read=(flag,defaultValue='')=>{const i=args.indexOf(flag);return i===-1?defaultValue:args[i+1];};
const checkRecord=(record)=>{if(!record)throw new Error('workspace not found for this job/attempt');};
const checkVerify=(verify)=>{if(!verify||!verify.ok)throw new Error(`confirm-applied verification failed: ${verify?.reason??'worktree does not match the proposal'}`);};
const parsePayload=(text)=>{try{const v=JSON.parse(text||'{}');return v&&typeof v==='object'&&!Array.isArray(v)?v:(()=>{throw new Error('Payload must be a JSON object');})();}catch(e){throw new Error(`Invalid payload JSON: ${e.message}`);}};
const demoBehavior=(name)=>({
  succeeded:()=>({outcome:'succeeded',note:'demo behavior: succeeded'}),
  failed:()=>({outcome:'failed',note:'demo behavior: failed'}),
  cancelled:()=>({outcome:'cancelled',note:'demo behavior: complied with stop request'}),
  crash:()=>{throw new FakeWorkerCrash();}
}[name]);
const broker=()=>new WorkspaceBroker(store,{workspacesRoot:read('--workspaces-dir','')||process.env.OWNER_AGENT_WORKSPACES_DIR});
const showProposal=(id)=>{
  const proposal=store.getPatchProposal(id);
  if(!proposal)throw new Error('Unknown proposal');
  const includeContent=read('--content')==='1';
  return {...proposal,
    proposal_diff:store.getPatchArtifactContent(id,'proposal_diff'),
    applied_diff:store.getPatchArtifactContent(id,'applied_diff'),
    ...(includeContent?{proposal_content:store.getPatchArtifactContent(id,'proposal')}:{})};
};
try {
  // A fresh CLI process holding an `applying` proposal means a previous apply was
  // interrupted: fail closed into owner reconciliation before serving any command.
  store.recoverInterruptedPatchApplies();
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
  else if(command==='result')result=store.getJobResult(read('--id'));
  else if(command==='results')result=store.listJobResults(read('--job'));
  // ---- v0.8 patch-first coding worker ----
  else if(command==='code-submit')result=store.createJob({projectId:read('--project'),jobType:'code-patch',title:read('--title','代码补丁提案'),
    payload:{baseSha:read('--base'),allowedPaths:read('--paths'),focus:read('--focus','')},idempotencyKey:read('--key'),ownerTaskId:read('--task'),actor:'ownerctl'});
  else if(command==='patches')result=store.listPatchProposals({projectId:read('--project'),status:read('--status'),limit:100});
  else if(command==='patch-show')result=showProposal(read('--id'));
  else if(command==='patch-approve'){
    const id=read('--id');
    store.approvePatchProposal(id,{expectedHash:read('--hash'),reviewer:read('--reviewer','owner')});
    const proposal=store.getPatchProposal(id);
    const record=store.getWorkspaceForAttempt(proposal.job_id,proposal.attempt);
    checkRecord(record);
    result=await broker().applyProposal(record,proposal);
    if(result.outcome!=='applied')process.exitCode=2;
  }
  else if(command==='patch-reject')result=store.rejectPatchProposal(read('--id'),{reason:read('--reason'),reviewer:read('--reviewer','owner')});
  else if(command==='patch-reconcile'){
    const id=read('--id');
    const decision=read('--decision');
    const proposal=store.getPatchProposal(id);
    if(!proposal)throw new Error('Unknown proposal');
    const record=store.getWorkspaceForAttempt(proposal.job_id,proposal.attempt);
    checkRecord(record);
    if(decision==='confirm-applied'){
      const verify=await broker().verifyApplied(record,proposal);
      checkVerify(verify);
      result=store.reconcilePatch(id,{decision,reason:read('--reason'),diffContent:verify.diff,actor:'ownerctl'});
    }else{
      result=store.reconcilePatch(id,{decision,reason:read('--reason'),actor:'ownerctl'});
      await broker().quarantine(record.id,{reason:'owner discarded the interrupted apply'});
    }
  }
  else if(command==='patch-recover')result={recoveredProposalIds:store.recoverInterruptedPatchApplies()};
  else if(command==='workspaces')result=store.listWorkspaces({projectId:read('--project'),status:read('--status'),limit:100});
  else if(command==='workspace-inspect')result=await broker().inspect(read('--id'));
  else if(command==='workspace-quarantine')result=await broker().quarantine(read('--id'),{reason:read('--reason')});
  else if(command==='workspace-cleanup'){
    if(read('--confirm')!=='1')throw new Error('workspace-cleanup requires --confirm 1 (Owner explicit consent)');
    result=await broker().cleanup(read('--id'),{confirm:true});
  }
  else if(command==='run-once'){
    const workerName=read('--worker','fake');
    if(workerName==='patch'){
      const worker=new PatchCodingWorker(store,{broker:broker(),workerId:read('--worker-name','patch-coding-worker'),
        model:read('--model',''),timeoutMs:Math.max(5000,Number(read('--timeout','120000'))||120000)});
      result=await worker.runOnce({projectId:read('--project'),allowModel:read('--allow-model')==='1'});
    }else if(workerName==='pi'){
      const worker=new PiAnalysisWorker(store,{workerId:read('--worker-name','pi-analysis-worker'),model:read('--model',''),timeoutMs:Math.max(5000,Number(read('--timeout','120000'))||120000)});
      result=await worker.runOnce({projectId:read('--project'),allowModel:read('--allow-model')==='1'});
    }else{
      result=await new FakeWorker(store,{workerId:read('--worker-name','fake-worker')}).runOnce({projectId:read('--project'),behavior:demoBehavior(read('--behavior','succeeded'))});
    }
  }
  else if(command==='ask')result=new OwnerAgent(store).answer(args.join(' '));
  else if(command==='ask-pi')result=await new OwnerAgent(store).askPi(args.join(' '));
  else if(command==='events')result=store.listEvents({projectId:read('--project')});
  else throw new Error('Use: register --id --name --root | projects | summary | attention | task --project --title | task-status --id --status | project-status --id --status | suggest --from --to --knowledge --why | suggestions | review --id --decision approved/rejected | note --project --text | ask QUESTION | ask-pi QUESTION | events | job-submit --project --type --title --payload --key [--task] | job-approve --id | job-reject --id --reason | jobs [--project] [--status] | job --id | job-cancel --id | jobs-reconcile | job-reconcile --id --decision requeue/cancel/fail [--reason] | run-once --worker fake/pi/patch ... | result --id | results --job | code-submit --project --task --base --paths --key | patches [--project] [--status] | patch-show --id [--content 1] | patch-approve --id --hash | patch-reject --id --reason | patch-reconcile --id --decision confirm-applied/discard [--reason] | patch-recover | workspaces [--project] [--status] | workspace-inspect --id | workspace-quarantine --id --reason | workspace-cleanup --id --confirm 1');
  console.log(JSON.stringify(result,null,2));
}catch(e){console.error(e.message);process.exitCode=1;}
finally{store.close();}
