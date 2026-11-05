// PiSessionFactory contract + production adapter for the installed Pi SDK.
//
//   factory.create({cwd, model?}) -> session adapter:
//     { sessionId(): string, prompt(text): Promise<void>, abort(): void|Promise,
//       activeTools(): string[], getLastText(): string, model: string, dispose(): void }
//
// Isolation policy (verified empirically against SDK 1.5.0 on this machine):
// - The DEFAULT resource loader pulls in the user's global agent directory, which
//   loaded 21 extension tools (web_search, fetch_content, pstack_*) into a
//   noTools:true session. We therefore build every session against a fresh empty
//   per-attempt agentDir; measured active tool set is [].
// - Model credentials still resolve through the SDK default auth chain (env /
//   global auth store). They are required for billing/auth only and carry no
//   behavioral configuration; extensions/settings/skills stay isolated.
// - The worker FAILS CLOSED: it verifies activeTools() is empty after create and
//   aborts the attempt otherwise (see pi-analysis-worker.mjs).
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync,rmSync } from 'node:fs';

export const DefaultPiSessionFactory={
  async create({cwd,model}={}){
    const sdk=await import('@earendil-works/pi-coding-agent');
    // Per-attempt empty agentDir: no global extensions, skills, settings or MCP servers.
    const agentDir=mkdtempSync(path.join(os.tmpdir(),'owner-pi-agent-'));
    let loader;
    try{
      loader=new sdk.DefaultResourceLoader({cwd,agentDir});
      await loader.reload();
      const {session}=await sdk.createAgentSession({
        cwd,
        noTools:true,
        sessionManager:sdk.SessionManager.inMemory(),
        resourceLoader:loader,
        ...(model?{model}:{})
      });
      let disposed=false;
      return {
        sessionId:()=>String(session.sessionId??''),
        prompt:(text)=>session.prompt(text),
        abort:()=>session.abort?.(),
        activeTools:()=>[...(session.getActiveToolNames?.()??[])],
        getLastText:()=>String(session.getLastAssistantText?.()??''),
        get model(){return session.model?`${session.model.provider}/${session.model.id}`:'unknown';},
        dispose(){if(disposed)return;disposed=true;try{session.dispose?.();}finally{try{rmSync(agentDir,{recursive:true,force:true});}catch{/* best effort cleanup */}}}
      };
    }catch(e){
      try{rmSync(agentDir,{recursive:true,force:true});}catch{/* ignore */}
      throw e;
    }
  }
};
