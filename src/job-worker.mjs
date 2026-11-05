// WorkerAdapter contract (P0): a worker is a stateless claimer/executor bound to one store.
//   { id: string, runOnce({projectId, behavior}): Promise<ClaimOutcome> }
// Workers only ever see the sanitized job row; they never receive owner credentials,
// never run payload strings as commands, and are never started automatically by the Resident.
export class FakeWorkerCrash extends Error {
  constructor(){super('FakeWorker crashed before reporting; its lease must expire and be reconciled manually');this.name='FakeWorkerCrash';}
}

const behaviorOutcome=(decision)=>{
  if(!decision||typeof decision!=='object')return {outcome:'failed',note:'invalid worker decision'};
  if(decision.outcome==='crash')throw new FakeWorkerCrash();
  if(decision.outcome==='succeeded'||decision.outcome==='failed'||decision.outcome==='cancelled')return decision;
  return {outcome:'failed',note:'worker returned an unknown outcome'};
};

export class FakeWorker {
  // behaviors: map of jobId | jobType -> ({job, attempt, worker}) => decision
  // decision: {outcome:'succeeded'|'failed'|'cancelled'|'crash', note?: string}
  constructor(store,{workerId='fake-worker',leaseMs=30000,clock=()=>new Date().toISOString(),behaviors={}}={}){
    this.store=store;this.workerId=workerId;this.leaseMs=leaseMs;this.clock=clock;this.behaviors=behaviors;
  }
  get id(){return this.workerId;}
  behaviorFor(job,override){
    if(override)return override;
    return this.behaviors[job.id]??this.behaviors[job.job_type]??(()=>({outcome:'succeeded',note:'fake-worker ok'}));
  }
  async runOnce({projectId='',behavior}={}){
    const claim=this.store.claimNextJob(projectId,this.workerId,{now:this.clock(),leaseMs:this.leaseMs,allowedTypes:['noop','status-note','fake-analysis']});
    if(!claim.claimed)return claim;
    const {job,attempt}=claim;
    // A stop request that arrived before start must win over execution.
    if(this.store.getJob(job.id).status==='cancel_requested'){
      this.store.confirmJobCancelled(job.id,attempt.attempt,{workerId:this.workerId,note:'cancelled before start',now:this.clock()});
      return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:'cancelled'};
    }
    this.store.startJob(job.id,attempt.attempt,{workerId:this.workerId,now:this.clock()});
    let decision;
    try{decision=behaviorOutcome(await this.behaviorFor(job,behavior)({job,attempt,worker:this}));}
    catch(e){
      if(e instanceof FakeWorkerCrash)throw e;
      decision={outcome:'failed',note:`worker error: ${String(e.message).slice(0,200)}`};
    }
    if(decision.outcome==='cancelled'){
      if(this.store.getJob(job.id).status==='cancel_requested'){
        this.store.confirmJobCancelled(job.id,attempt.attempt,{workerId:this.workerId,note:decision.note??'',now:this.clock()});
        return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:'cancelled'};
      }
      // Abandoning work without an owner stop request is a failure, not a cancellation.
      this.store.reportJobResult(job.id,attempt.attempt,{workerId:this.workerId,outcome:'failed',note:'worker aborted without a cancel request',now:this.clock()});
      return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:'failed'};
    }
    this.store.reportJobResult(job.id,attempt.attempt,{workerId:this.workerId,outcome:decision.outcome,note:decision.note??'',now:this.clock()});
    return {claimed:true,jobId:job.id,attempt:attempt.attempt,outcome:decision.outcome};
  }
}
