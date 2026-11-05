#!/usr/bin/env node
import { resolve } from 'node:path';
import { OwnerStore } from '../src/owner-store.mjs';
import { OwnerAgent } from '../src/owner-agent.mjs';
import { defaultDbPath } from '../src/storage.mjs';
const store=new OwnerStore(process.env.OWNER_AGENT_DB??defaultDbPath());
const args=process.argv.slice(2);const command=args.shift();
const read=(flag,defaultValue='')=>{const i=args.indexOf(flag);return i===-1?defaultValue:args[i+1];};
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
  else if(command==='ask')result=new OwnerAgent(store).answer(args.join(' '));
  else if(command==='ask-pi')result=await new OwnerAgent(store).askPi(args.join(' '));
  else if(command==='events')result=store.listEvents({projectId:read('--project')});
  else throw new Error('Use: register --id --name --root | projects | summary | attention | task --project --title | task-status --id --status | project-status --id --status | suggest --from --to --knowledge --why | suggestions | review --id --decision approved/rejected | note --project --text | ask QUESTION | ask-pi QUESTION | events');
  console.log(JSON.stringify(result,null,2));
}catch(e){console.error(e.message);process.exitCode=1;}
finally{store.close();}
