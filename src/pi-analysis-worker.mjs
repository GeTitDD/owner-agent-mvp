// PiAnalysisWorker — first real execution loop: an owner-approved, manually triggered,
// tool-free, read-only analysis session bound to one registered project.
//
// Invariants preserved from v0.6 (Issue #1):
// - claim → start → heartbeat → report / confirmCancel / fenced-silence, identical state machine.
// - A settled model call is NOT a completed owner task; success means "bounded analysis
//   artifact stored atomically with its final state".
// - Cancel is two-phase: request → session.abort() → wait for settle → worker confirms.
// - A worker that loses its lease (or cannot confirm a stop) stops silently (no report,
//   no artifact) and goes through reconciliation. Late results are rejected by the store.
// Storage minimization: prompts/answers/keys never enter jobs, attempts or audit events;
// error notes use fixed categories (never raw upstream messages); the answer lives in
// owner_job_results (project-private), referenced by id/hash/chars only.
import { DefaultPiSessionFactory } from './pi-session-factory.mjs';
import { realpath } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { sha256 } from './utils.mjs';

// Controlled error taxonomy: fixed summaries only. Upstream error messages may contain
// endpoints, headers or other sensitive material and are never persisted.
const classifyError=(e)=>{
  const name=String(e?.name??'');
  if(/abort/i.test(name))return 'session-aborted';
  if(/timeout/i.test(name))return 'timeout';
  if(/auth|permission|forbidden/i.test(name))return 'auth-error';
  if(/network|fetch|connection|socket|dns/i.test(name))return 'network-error';
  return 'session-error';
};

const buildAnalysisPrompt=({projectId,title,note,focus})=>[
  `你是项目 ${projectId} 的只读分析器。禁止执行任何操作：不写文件、不运行命令、不访问网络、不修改任何状态。`,
  '仅依据下方材料输出一份简洁的结构化分析（概要 / 关键发现 / 风险 / 建议下一步），不得编造未提供的事实。',
  `任务标题：${title}`,
  `任务说明：${note||'（无）'}`,
  `分析要点：${focus||'（未指定）'}`
].join('\n');

export class PiAnalysisWorker {
  // sessionFactory is injectable: production uses DefaultPiSessionFactory (real SDK +
  // isolated per-attempt agentDir); tests/demo inject deterministic fakes. The allow-model
  // gate applies ONLY to the default real factory, so fake-based flows stay free and dry.
  // timers and abortConfirmMs are injectable for deterministic tests.
  constructor(store,{workerId='pi-analysis-worker',leaseMs=30000,clock=()=>new Date().toISOString(),sessionFactory=DefaultPiSessionFactory,model='',timeoutMs=120000,createTimeoutMs=30000,abortConfirmMs=5000,maxOutputChars=20000,timers={interval:(fn,ms)=>setInterval(fn,ms),timeout:(fn,ms)=>setTimeout(fn,ms),clear:(h)=>{clearInterval(h);clearTimeout(h);}}}={}){
    this.store=store;this.workerId=workerId;this.leaseMs=leaseMs;this.clock=clock;
    this.sessionFactory=sessionFactory;this.model=model;this.timeoutMs=timeoutMs;
    this.createTimeoutMs=createTimeoutMs;this.abortConfirmMs=abortConfirmMs;
    this.maxOutputChars=maxOutputChars;this.timers=timers;
  }
  async runOnce({projectId,allowModel=false}={}){
    if(this.sessionFactory===DefaultPiSessionFactory&&!allowModel){
      // Refused before claiming: no state change, no model call, no cost.
      return {claimed:false,reason:'model-disabled'};
    }
    const project=this.store.getProject(projectId);
    if(!project)return {claimed:false,reason:'unknown-project'};
    let root;
    try{root=await realpath(project.root);}catch{return {claimed:false,reason:'project-root-missing'};}
    // Path-drift rejection: a replaced root (e.g. swapped for a symlink to another
    // directory) has a different file identity than the registered one.
    const drift=(()=>{try{const st=statSync(project.root,{bigint:true});
      const identity=sha256(`${st.dev}:${st.ino}`).slice(0,32);
      if(project.root_identity&&project.root_identity!==identity)return 'moved';
      return null;}catch{return 'missing';}})();
    if(drift)return {claimed:false,reason:drift==='moved'?'project-root-moved':'project-root-missing'};
    // Workers claim only the types they are built to execute (review r2: queue consistency).
    const claim=this.store.claimNextJob(projectId,this.workerId,{now:this.clock(),leaseMs:this.leaseMs,allowedTypes:['pi-analysis']});
    if(!claim.claimed)return claim;
    const {job,attempt}=claim;
    const guard=(fn)=>{try{return fn();}catch{return false;}};
    try{
      if(this.store.getJob(job.id).status==='cancel_requested'){
        this.store.confirmJobCancelled(job.id,attempt.attempt,{workerId:this.workerId,note:'cancelled before session start',now:this.clock()});
        return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:'cancelled'};
      }
      this.store.startJob(job.id,attempt.attempt,{workerId:this.workerId,now:this.clock()});
      // Watchdog covers the WHOLE active window, including sessionFactory.create():
      // renewing the lease while creation is slow, and forwarding stop requests.
      let session=null,abortRequested=false,fenced=false,createSettled=false,createTimedOut=false;
      const tick=()=>{
        try{this.store.heartbeatJob(job.id,attempt.attempt,{workerId:this.workerId,now:this.clock(),leaseMs:this.leaseMs});}
        catch{fenced=true;if(session)session.abort?.();return;}
        try{if(this.store.getJob(job.id).status==='cancel_requested'){abortRequested=true;session?.abort?.();}}catch{/* next tick re-checks */}
      };
      const tickMs=Math.max(1000,Math.floor(this.leaseMs/3));
      const tickTimer=this.timers.interval(tick,tickMs);
      try{
        // Creation phase has its own deadline: a hung sessionFactory.create() must not keep
        // the job running/cancel_requested forever. On deadline we stop renewing the lease
        // (so reconcile can quarantine), and any late session is aborted+disposed, never prompted.
        const createController=new AbortController();
        const created=Promise.resolve(this.sessionFactory.create({cwd:root,model:this.model||undefined,signal:createController.signal}))
          .then(s=>{createSettled=true;return {session:s};})
          .catch(e=>({createError:e}));
        created.then((r)=>{
          if(!r||!r.session)return;
          if(createTimedOut||fenced){try{r.session.abort?.();}catch{}r.session.dispose();}
        }).catch(()=>{});
        const createResult=await Promise.race([
          created,
          new Promise(resolve=>{this.createTimer=this.timers.timeout(()=>{createTimedOut=true;createController.abort();resolve({createTimedOut:true});},this.createTimeoutMs);})
        ]);
        if(createResult.createTimedOut){
          // Stop renewing the lease so the attempt converges into needs_reconciliation.
          this.timers.clear(tickTimer);
          return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:'fenced',createTimedOut:true};
        }
        if(createResult.createError)throw createResult.createError;
        session=createResult.session;
        // Fail-closed permission checks: unknown tool set is treated as unsafe, and an
        // empty set is required before any prompt is sent.
        let tools=null;
        try{tools=session.activeTools();}catch{tools=null;}
        if(!Array.isArray(tools)){
          session.abort?.();
          this.store.reportJobResult(job.id,attempt.attempt,{workerId:this.workerId,outcome:'failed',note:'tool isolation verification unavailable; refusing to prompt',now:this.clock()});
          return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:'failed'};
        }
        if(tools.length>0){
          session.abort?.();
          this.store.reportJobResult(job.id,attempt.attempt,{workerId:this.workerId,outcome:'failed',note:`tool isolation verification failed (${tools.length} active tools); attempt refused`,now:this.clock()});
          return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:'failed'};
        }
        this.store.attachAttemptSession(job.id,attempt.attempt,{workerId:this.workerId,sessionId:session.sessionId(),now:this.clock()});
        // Re-validate before prompting: lease renewal + cancel/stop handling + fenced check.
        {
          let stillValid=true;
          try{this.store.heartbeatJob(job.id,attempt.attempt,{workerId:this.workerId,now:this.clock(),leaseMs:this.leaseMs});}catch{fenced=true;stillValid=false;}
          const current=this.store.getJob(job.id);
          if(current.status==='cancel_requested'){abortRequested=true;session.abort?.();}
          if(fenced)return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:'fenced'};
          if(current.status==='cancel_requested'){
            this.store.confirmJobCancelled(job.id,attempt.attempt,{workerId:this.workerId,note:'cancelled before prompt',now:this.clock()});
            return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:'cancelled'};
          }
          if(!stillValid)return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:'fenced'};
        }
        // The approved input snapshot (fixed at approval time) is the only task material used.
        let snapshot={title:job.title,note:''};
        try{const parsed=JSON.parse(job.input_snapshot||'');if(parsed&&typeof parsed==='object')snapshot=parsed;}catch{/* malformed snapshot falls back to job title */}
        const prompt=buildAnalysisPrompt({projectId:job.project_id,title:String(snapshot.title??job.title).slice(0,200),note:String(snapshot.note??'').slice(0,500),focus:String(job.payload.focus??'').slice(0,300)});
        let promptError=null,timedOut=false;
        let timeoutHandle=null;
        // The settlement promise is retained so a stop request can be CONFIRMED: after
        // abort() we wait (bounded) for the prompt to settle before reporting anything.
        const settled=session.prompt(prompt).then(()=>({settled:true})).catch(e=>({settled:false,error:e}));
        try{
          const result=await Promise.race([
            settled,
            new Promise(resolve=>{timeoutHandle=this.timers.timeout(()=>resolve({timeout:true}),this.timeoutMs);})
          ]);
          if(result?.timeout)timedOut=true;
          else if(result&&!result.settled)promptError=result.error;
        }finally{
          if(timeoutHandle!==null)this.timers.clear(timeoutHandle);
        }
        // The watchdog keeps renewing through the confirm window; it is stopped further down
        // once the outcome is decided (review r2: do not let a short lease expire mid-stop).
        if(fenced){this.timers.clear(tickTimer);return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:'fenced'};}
        if(timedOut){
          // Ask the session to stop, renew the lease once, then wait (bounded) for the stop
          // to CONFIRM before deciding the outcome.
          session.abort?.();
          guard(()=>this.store.heartbeatJob(job.id,attempt.attempt,{workerId:this.workerId,now:this.clock(),leaseMs:this.leaseMs}));
          const confirmed=await Promise.race([
            settled.then(()=>true),
            new Promise(resolve=>this.timers.timeout(()=>resolve(false),this.abortConfirmMs))
          ]);
          this.timers.clear(tickTimer);
          if(confirmed){
            const reported=guard(()=>this.store.reportJobResult(job.id,attempt.attempt,{workerId:this.workerId,outcome:'failed',note:`analysis timeout after ${this.timeoutMs}ms; session stopped`,now:this.clock()}));
            return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:reported?'failed':'fenced'};
          }
          // Stop could not be confirmed: the session may still be running — do not release
          // the project; stop renewing and leave the attempt for explicit reconciliation.
          return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:'fenced',unconfirmedStop:true};
        }
        if(abortRequested&&this.store.getJob(job.id).status==='cancel_requested'){
          this.timers.clear(tickTimer);
          this.store.confirmJobCancelled(job.id,attempt.attempt,{workerId:this.workerId,note:'stopped via session abort',now:this.clock()});
          return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:'cancelled'};
        }
        this.timers.clear(tickTimer);
        if(promptError){
          const reported=guard(()=>this.store.reportJobResult(job.id,attempt.attempt,{workerId:this.workerId,outcome:'failed',note:`pi session error (${classifyError(promptError)})`,now:this.clock()}));
          return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:reported?'failed':'fenced'};
        }
        const raw=session.getLastText();
        if(!raw.trim()){
          const reported=guard(()=>this.store.reportJobResult(job.id,attempt.attempt,{workerId:this.workerId,outcome:'failed',note:'empty analysis output',now:this.clock()}));
          return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:reported?'failed':'fenced'};
        }
        const truncated=raw.length>this.maxOutputChars;
        const content=raw.slice(0,this.maxOutputChars);
        // Atomic commit: result INSERT + succeeded finalization in one store transaction,
        // validating worker/attempt/lease (v0.6 state machine) at the same moment.
        const committed=guard(()=>this.store.completeJobWithResult(job.id,attempt.attempt,{workerId:this.workerId,sessionId:session.sessionId(),model:session.model,content,truncated,usage:'unknown',note:`pi-analysis ok; chars:${content.length}; tools:0; usage:unknown`,now:this.clock()}));
        if(!committed||committed.outcome!=='succeeded')return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:'fenced'};
        return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:'succeeded',resultId:committed.result.id,resultHash:committed.result.hash};
      }finally{if(session)session.dispose();}
    }catch(e){
      // Session creation or an unexpected worker error: report a fixed-category summary
      // only if still authorized to; otherwise stay silent for reconciliation.
      const reported=guard(()=>this.store.reportJobResult(job.id,attempt.attempt,{workerId:this.workerId,outcome:'failed',note:`pi worker error (${classifyError(e)})`,now:this.clock()}));
      return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:reported?'failed':'fenced'};
    }
  }
}
