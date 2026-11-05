// PiAnalysisWorker — first real execution loop: an owner-approved, manually triggered,
// tool-free, read-only analysis session bound to one registered project.
//
// Invariants preserved from v0.6 (Issue #1):
// - claim → start → heartbeat → report / confirmCancel / fenced-silence, identical state machine.
// - A settled model call is NOT a completed owner task; success means "bounded analysis
//   artifact stored with a content hash".
// - Cancel is two-phase: request → session.abort() → worker confirms after the prompt settles.
// - A worker that loses its lease stops silently (no report) and goes through reconciliation.
// Storage minimization: prompts/answers/keys never enter jobs, attempts or audit events;
// the answer lives in owner_job_results (project-private), referenced by id/hash/chars only.
import { DefaultPiSessionFactory } from './pi-session-factory.mjs';
import { realpath } from 'node:fs/promises';

const buildAnalysisPrompt=({projectId,title,note,focus})=>[
  `你是项目 ${projectId} 的只读分析器。禁止执行任何操作：不写文件、不运行命令、不访问网络、不修改任何状态。`,
  '仅依据下方材料输出一份简洁的结构化分析（概要 / 关键发现 / 风险 / 建议下一步），不得编造未提供的事实。',
  `任务标题：${title}`,
  `任务说明：${note||'（无）'}`,
  `分析要点：${focus||'（未指定）'}`
].join('\n');

const classifyError=(e)=>{
  const name=String(e?.name??'Error');
  const msg=String(e?.message??'').replace(/\s+/g,' ').slice(0,120);
  return `${name}: ${msg}`;
};

export class PiAnalysisWorker {
  // sessionFactory is injectable: production uses DefaultPiSessionFactory (real SDK +
  // isolated per-attempt agentDir); tests/demo inject deterministic fakes. The --allow-model
  // gate applies ONLY to the default real factory, so fake-based flows stay free and dry.
  constructor(store,{workerId='pi-analysis-worker',leaseMs=30000,clock=()=>new Date().toISOString(),sessionFactory=DefaultPiSessionFactory,model='',timeoutMs=120000,maxOutputChars=20000,timers={interval:(fn,ms)=>setInterval(fn,ms),timeout:(fn,ms)=>setTimeout(fn,ms),clear:(h)=>{clearInterval(h);clearTimeout(h);}}}={}){
    this.store=store;this.workerId=workerId;this.leaseMs=leaseMs;this.clock=clock;
    this.sessionFactory=sessionFactory;this.model=model;this.timeoutMs=timeoutMs;
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
    const claim=this.store.claimNextJob(projectId,this.workerId,{now:this.clock(),leaseMs:this.leaseMs});
    if(!claim.claimed)return claim;
    const {job,attempt}=claim;
    if(job.job_type!=='pi-analysis'){
      this.store.reportJobResult(job.id,attempt.attempt,{workerId:this.workerId,outcome:'failed',note:'non-pi-analysis job reached the pi worker',now:this.clock()});
      return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:'failed'};
    }
    const guard=(fn)=>{try{fn();return true;}catch{return false;}};
    try{
      if(this.store.getJob(job.id).status==='cancel_requested'){
        this.store.confirmJobCancelled(job.id,attempt.attempt,{workerId:this.workerId,note:'cancelled before session start',now:this.clock()});
        return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:'cancelled'};
      }
      this.store.startJob(job.id,attempt.attempt,{workerId:this.workerId,now:this.clock()});
      const session=await this.sessionFactory.create({cwd:root,model:this.model||undefined});
      let disposed=false;
      const dispose=()=>{if(!disposed){disposed=true;session.dispose();}};
      try{
        // Fail-closed permission check: the prompt saying "read-only" is not isolation.
        const tools=session.activeTools();
        if(tools.length>0){
          session.abort?.();
          this.store.reportJobResult(job.id,attempt.attempt,{workerId:this.workerId,outcome:'failed',note:`tool isolation verification failed (${tools.length} active tools); attempt refused`,now:this.clock()});
          return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:'failed'};
        }
        this.store.attachAttemptSession(job.id,attempt.attempt,{workerId:this.workerId,sessionId:session.sessionId(),now:this.clock()});
        const task=job.owner_task_id?this.store.getTask(job.owner_task_id):null;
        const prompt=buildAnalysisPrompt({projectId:job.project_id,title:task?.title??job.title,note:String(task?.note??'').slice(0,500),focus:String(job.payload.focus??'').slice(0,300)});
        // Watchdog: renew lease on every tick (also valid while cancel_requested) and
        // forward a stop request to the running session via abort(). A failed heartbeat
        // means the lease is lost: the worker is no longer authorized to run or to store
        // anything, so it aborts the session and goes silent (reconcile will quarantine).
        let abortRequested=false,fenced=false;
        const tick=()=>{
          try{this.store.heartbeatJob(job.id,attempt.attempt,{workerId:this.workerId,now:this.clock(),leaseMs:this.leaseMs});}
          catch{fenced=true;session.abort?.();return;}
          try{if(this.store.getJob(job.id).status==='cancel_requested'){abortRequested=true;session.abort?.();}}catch{/* job row may be transitioning; next tick re-checks */}
        };
        const tickMs=Math.max(1000,Math.floor(this.leaseMs/3));
        const tickTimer=this.timers.interval(tick,tickMs);
        let promptError=null,timedOut=false;
        let timeoutHandle=null;
        try{
          const result=await Promise.race([
            session.prompt(prompt).then(()=>({settled:true})).catch(e=>({settled:false,error:e})),
            new Promise(resolve=>{timeoutHandle=this.timers.timeout(()=>resolve({timeout:true}),this.timeoutMs);})
          ]);
          if(result?.timeout)timedOut=true;
          else if(result&&!result.settled)promptError=result.error;
        }finally{
          this.timers.clear(tickTimer);
          if(timeoutHandle!==null)this.timers.clear(timeoutHandle);
        }
        const status=this.store.getJob(job.id).status;
        if(fenced)return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:'fenced'};
        if(status==='cancel_requested'){
          this.store.confirmJobCancelled(job.id,attempt.attempt,{workerId:this.workerId,note:abortRequested?'stopped via session abort':'stopped on request',now:this.clock()});
          return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:'cancelled'};
        }
        if(timedOut){
          session.abort?.();
          const reported=guard(()=>this.store.reportJobResult(job.id,attempt.attempt,{workerId:this.workerId,outcome:'failed',note:`analysis timeout after ${this.timeoutMs}ms`,now:this.clock()}));
          return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:reported?'failed':'fenced'};
        }
        if(promptError){
          const reported=guard(()=>this.store.reportJobResult(job.id,attempt.attempt,{workerId:this.workerId,outcome:'failed',note:`pi session error: ${classifyError(promptError)}`,now:this.clock()}));
          return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:reported?'failed':'fenced'};
        }
        const raw=session.getLastText();
        if(!raw.trim()){
          const reported=guard(()=>this.store.reportJobResult(job.id,attempt.attempt,{workerId:this.workerId,outcome:'failed',note:'empty analysis output',now:this.clock()}));
          return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:reported?'failed':'fenced'};
        }
        const truncated=raw.length>this.maxOutputChars;
        const content=raw.slice(0,this.maxOutputChars);
        const stored=this.store.addJobResult({projectId:job.project_id,jobId:job.id,attempt:attempt.attempt,sessionId:session.sessionId(),model:session.model,status:truncated?'truncated':'completed',content,truncated});
        const reported=guard(()=>this.store.reportJobResult(job.id,attempt.attempt,{workerId:this.workerId,outcome:'succeeded',note:`pi-analysis ok; result:${stored.id} sha:${stored.hash.slice(0,8)} chars:${stored.chars}; tools:0; usage:unknown`,now:this.clock()}));
        if(!reported)return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:'fenced'};
        return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:'succeeded',resultId:stored.id,resultHash:stored.hash};
      }finally{dispose();}
    }catch(e){
      // Session creation or an unexpected worker error: report only if still authorized to.
      const reported=guard(()=>this.store.reportJobResult(job.id,attempt.attempt,{workerId:this.workerId,outcome:'failed',note:`pi worker error: ${classifyError(e)}`,now:this.clock()}));
      return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:reported?'failed':'fenced'};
    }
  }
}
