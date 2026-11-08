// PiSessionFactory contract + production adapter for the installed Pi SDK.
//
//   factory.create({cwd, model?}) -> session adapter:
//     { sessionId(): string, prompt(text): Promise<void>, abort(): void|Promise,
//       activeTools(): string[]|null, getLastText(): string, model: string, dispose(): void }
//
// Isolation policy (verified empirically against SDK 1.5.0):
// - The DEFAULT resource loader pulls in the user's global agent directory AND discovers
//   project-local `.pi/extensions` from cwd; on this machine the global dir alone loaded
//   21 extension tools into a noTools:true session. We therefore build every session with
//   an explicitly disabled loader (noExtensions/noSkills/noPromptTemplates/noThemes/
//   noContextFiles) AND a fresh empty per-attempt agentDir; measured active tool set is [].
// - activeTools() returns null when the SDK offers no way to enumerate tools; the worker
//   must treat null as "unknown" and fail closed.
// - Model credentials still resolve through the SDK default auth chain (env / global auth
//   store). They are required for billing/auth only and carry no behavioral configuration.
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync,rmSync } from 'node:fs';
import { resolvePiModel } from './pi-model-catalog.mjs';

export const DefaultPiSessionFactory={
  async create({cwd,model,signal}={}){
    const sdk=await import('@earendil-works/pi-coding-agent');
    // Per-attempt empty agentDir: no global extensions, skills, settings or MCP servers.
    const agentDir=mkdtempSync(path.join(os.tmpdir(),'owner-pi-agent-'));
    const created=(async()=>{
      // Explicitly disable ALL resource discovery (global + project-local):
      // extensions, skills, prompt templates, themes and context files (AGENTS.md etc.).
      const loader=new sdk.DefaultResourceLoader({
        cwd,agentDir,
        noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true
      });
      try{
        await loader.reload();
        const {session}=await sdk.createAgentSession({
          cwd,
          noTools:true,
          sessionManager:sdk.SessionManager.inMemory(),
          resourceLoader:loader,
          ...(model?{model:resolvePiModel(model)}:{})
        });
        let disposed=false;
        return {
          sessionId:()=>String(session.sessionId??''),
          prompt:(text)=>session.prompt(text),
          abort:()=>session.abort?.(),
          // null = the SDK offers no tool enumeration: unknown, NOT empty (fail closed).
          activeTools:()=>typeof session.getActiveToolNames==='function'?[...session.getActiveToolNames()]:null,
          getLastText:()=>String(session.getLastAssistantText?.()??''),
          get model(){return session.model?`${session.model.provider}/${session.model.id}`:'unknown';},
          dispose(){if(disposed)return;disposed=true;try{session.dispose?.();}finally{try{rmSync(agentDir,{recursive:true,force:true});}catch{/* best effort cleanup */}}}
        };
      }catch(e){
        // Error path (loader.reload / createAgentSession rejects): the temp agentDir must
        // be cleaned up too, not only on the success path.
        try{rmSync(agentDir,{recursive:true,force:true});}catch{/* ignore */}
        throw e;
      }
    })();
    // Cancellable creation: when the caller aborts (e.g. a create-phase deadline), any
    // session that is eventually produced must be aborted+disposed and never prompted.
    if(signal){
      const disposeLate=()=>{created.then(a=>{try{a.abort?.();}catch{/* ignore */}a.dispose();}).catch(()=>{try{rmSync(agentDir,{recursive:true,force:true});}catch{/* ignore */}});};
      if(signal.aborted)disposeLate();
      else signal.addEventListener('abort',disposeLate,{once:true});
    }
    return created;
  }
};
