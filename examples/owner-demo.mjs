// Fully isolated, deterministic demo; no Pi/model credentials and no production DB writes.
import { mkdtemp,mkdir,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OwnerStore } from '../src/owner-store.mjs';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { OwnerAgent } from '../src/owner-agent.mjs';
const root=await mkdtemp(path.join(tmpdir(),'owner-agent-demo-'));
const dbPath=path.join(root,'owner.sqlite');
let store,knowledge;
try{
  const a=path.join(root,'pi-research'),b=path.join(root,'context-compiler');
  await mkdir(a);await mkdir(b);
  store=new OwnerStore(dbPath);knowledge=new PersonalKnowledgeStore(dbPath);
  store.registerProject({id:'pi-research',name:'Pi SDK Research',root:a,primaryDomain:'pi-sdk',domains:['pi-sdk'],goal:'Verify Pi context lifecycle'});
  store.registerProject({id:'context-compiler',name:'Context Compiler',root:b,primaryDomain:'context-engineering',domains:['context-engineering'],goal:'Compose cross-domain knowledge'});
  const task=store.createTask({projectId:'pi-research',title:'Confirm structured system sections',status:'doing'});
  store.recordEvent({sourceEventId:'demo-start',projectId:'pi-research',kind:'run_started',sessionId:'pi-session-1'});
  store.recordEvent({sourceEventId:'demo-tool',projectId:'pi-research',kind:'tool_finished',sessionId:'pi-session-1',toolName:'test',durationMs:30});
  store.recordEvent({sourceEventId:'demo-settle',projectId:'pi-research',kind:'run_settled',sessionId:'pi-session-1'});
  store.updateTask(task.id,{status:'done',note:'Demo: owner explicitly confirms completion'});
  const unit=knowledge.create({title:'Stable prefix design',content:'Cache-friendly system prefixes require stable serialized content and model settings.',kind:'claim',scope:'domain',layer:'applied',projectId:null,
    domains:['pi-sdk','context-engineering'],tags:['context','cache'],verificationStatus:'verified',evidenceRefs:['demo:fixture-test:pass'],relations:{}});
  const suggestion=store.proposeReuse({sourceProjectId:'pi-research',targetProjectId:'context-compiler',knowledgeId:unit.id,rationale:'Evaluate the stable prefix design in Compiler'});
  console.log('Pending proposal:',suggestion.status,'; target links before approval:',store.knowledgeLinks('context-compiler').length);
  store.reviewSuggestion(suggestion.id,{decision:'approved'});
  console.log('Approved links:',store.knowledgeLinks('context-compiler').length);
  console.log('Owner summary:',JSON.stringify(store.summary(),null,2));
  console.log('Owner reply:',new OwnerAgent(store).answer('现在有哪些项目？'));
  console.log('Demo evidence is synthetic and does not validate any production Pi behavior.');
}finally{knowledge?.close();store?.close();await rm(root,{recursive:true,force:true});}
