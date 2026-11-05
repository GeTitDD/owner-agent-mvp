// Optional Pi event adapter, without raw prompts/arguments/outputs.
// Explicit opt-in: OWNER_AGENT_CAPTURE=1, registered project cwd, local SQLite.
import { randomUUID } from 'node:crypto';
import { OwnerStore } from '../../src/owner-store.mjs';

export function registerOwnerPiEvents(pi,{Store=OwnerStore,dbPath=process.env.OWNER_AGENT_DB,enabled=process.env.OWNER_AGENT_CAPTURE==='1',logger=console}={}){
  let store=null,project=null,sessionId=null;
  const submit=(kind,ctx,data={})=>{
    if(!store||!project)return;
    try{
      const s=ctx?.sessionManager?.getSessionId?.()??sessionId;
      if(!s)return;
      store.recordEvent({sourceEventId:randomUUID(),projectId:project.id,kind,sessionId:String(s),
        branchLeafId:String(ctx?.sessionManager?.getLeafId?.()??''),...data});
    }catch(e){logger.warn?.('Owner event capture skipped:',e.message);}
  };
  pi.on('session_start',async(_evt,ctx)=>{
    store?.close();store=null;project=null;sessionId=null;
    if(!enabled || (typeof ctx.isProjectTrusted==='function'&&!ctx.isProjectTrusted()))return;
    try{
      const candidate=new Store(dbPath);
      const found=candidate.getProjectByRoot(ctx.cwd);
      if(!found){candidate.close();return;}
      store=candidate;project=found;sessionId=ctx.sessionManager?.getSessionId?.()??null;
    }catch(e){logger.warn?.('Owner capture not available:',e.message);}
  });
  pi.on('agent_start',async(_evt,ctx)=>submit('run_started',ctx));
  pi.on('tool_execution_end',async(event,ctx)=>{
    if(!event?.toolName)return;
    submit('tool_finished',ctx,{toolName:String(event.toolName),isError:!!event.isError,
      durationMs:Number.isSafeInteger(event.durationMs)&&event.durationMs>=0?event.durationMs:null});
  });
  pi.on('agent_settled',async(event,ctx)=>submit('run_settled',ctx,{aborted:!!event?.aborted}));
  pi.on('session_shutdown',()=>{store?.close();store=null;project=null;sessionId=null;});
}
export default function ownerExtension(pi){registerOwnerPiEvents(pi);}
