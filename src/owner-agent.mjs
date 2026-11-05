// Owner-facing read-only cognitive interface. LLM is optional and only invoked explicitly.
// Durable truth remains in OwnerStore; no chat transcript is treated as project state.
import { OwnerStore } from './owner-store.mjs';
import { DefaultPiSessionFactory } from './pi-session-factory.mjs';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync,rmSync } from 'node:fs';

export class OwnerAgent {
  constructor(store,{piSessionFactory}={}){this.store=store;this.piSessionFactory=piSessionFactory??DefaultPiSessionFactory;}
  inspect(){return this.store.summary();}
  attention(){
    const s=this.inspect();const items=[];
    for(const p of s.projects){
      const blocked=p.tasks.filter(t=>t.status==='blocked');
      if(blocked.length)items.push({kind:'blocker',projectId:p.id,priority:'high',title:`${p.name} 有 ${blocked.length} 项阻塞`,evidence:blocked.map(t=>`task:${t.id}`)});
      for(const run of p.runs.filter(r=>r.status==='settled'&&r.errors>0).slice(0,2))
        items.push({kind:'tool-errors',projectId:p.id,priority:'normal',title:`${p.name} 的一次 Pi 运行记录了 ${run.errors} 个工具错误`,evidence:[`session:${run.session_id}`]});
    }
    if(s.pendingSuggestions)items.push({kind:'review',priority:'normal',title:`${s.pendingSuggestions} 条跨项目知识迁移建议待审批`,evidence:this.store.listSuggestions('pending').map(x=>`suggestion:${x.id}`)});
    const counts=this.store.jobStatusCounts();const nowStamp=new Date().toISOString();
    const stuck=this.store.listJobs({status:'needs_reconciliation',limit:100});
    const stuckTotal=counts['needs_reconciliation']??0;
    if(stuckTotal)items.push({kind:'job-stuck',priority:'high',title:`${stuckTotal} 个执行 Job 租约过期，等待人工裁定`,evidence:stuck.map(j=>`job:${j.id}`)});
    const expiredTotal=this.store.countJobsWithExpiredLeases({now:nowStamp});
    if(expiredTotal)items.push({kind:'job-lease-expired',priority:'high',title:`${expiredTotal} 个执行 Job 租约已过期，尚未标记裁定`,evidence:this.store.listJobsWithExpiredLeases({now:nowStamp,limit:100}).map(j=>`job:${j.id}`)});
    const awaitingTotal=counts['pending_approval']??0;
    if(awaitingTotal)items.push({kind:'job-approval',priority:'normal',title:`${awaitingTotal} 个执行 Job 待审批`,evidence:this.store.listJobs({status:'pending_approval',limit:100}).map(j=>`job:${j.id}`)});
    return items;
  }
  answer(question){
    const q=String(question??'').trim();if(!q||q.length>1200)throw new Error('Question must be 1–1200 chars');
    const s=this.inspect();
    const project=s.projects.find(p=>q.toLowerCase().includes(p.id.toLowerCase())||q.includes(p.name));
    if(/(阻塞|卡住|blocked|风险)/i.test(q)){
      const blocked=s.projects.flatMap(p=>p.tasks.filter(t=>t.status==='blocked').map(t=>({p,t})));
      return {answer:blocked.length?blocked.map(({p,t})=>`${p.name}：${t.title}（${t.note||'未填写原因'}；task:${t.id}）`).join('\n'):'当前没有被明确标记为阻塞的任务。未上报的项目状态不在此结论范围内。',basis:blocked.map(({t})=>`task:${t.id}`),mode:'local-rules'};
    }
    if(/(知识|提案|复用|迁移|knowledge|suggestion)/i.test(q)){
      const suggestions=this.store.listSuggestions('pending');
      return {answer:suggestions.length?suggestions.map(x=>`${x.source_project_id} → ${x.target_project_id}：${x.rationale}（${x.status}，suggestion:${x.id}）`).join('\n'):'暂无待审核的跨项目知识迁移建议。',basis:suggestions.map(x=>`suggestion:${x.id}`),mode:'local-rules'};
    }
    if(/(执行|job|队列)/i.test(q)){
      const counts=this.store.jobStatusCounts();
      const active=['queued','leased','running','cancel_requested'].reduce((sum,st)=>sum+(counts[st]??0),0);
      const waiting=counts['pending_approval']??0;
      const stuck=counts['needs_reconciliation']??0;
      const total=Object.values(counts).reduce((sum,n)=>sum+n,0);
      const lines=[`共 ${total} 个执行 Job：管道中 ${active}，待审批 ${waiting}，待裁定 ${stuck}。`];
      for(const j of this.store.listJobs({limit:8}))lines.push(`${j.project_id} · ${j.job_type} · ${j.title}（job:${j.id}，状态 ${j.status}，已尝试 ${j.last_attempt} 次）`);
      lines.push('注意：Job 状态均来自持久化登记，不代表已检查项目源码或真实执行结果。');
      return {answer:lines.join('\n'),basis:this.store.listJobs({limit:10}).map(j=>`job:${j.id}`),mode:'local-rules'};
    }
    if(project){
      const projectJobs=project.jobs??[];const inPipeline=projectJobs.filter(j=>['queued','leased','running','cancel_requested'].includes(j.status)).length;
      return {answer:`${project.name}\n当前人工标记状态：${project.status}\n目标：${project.goal||'未登记'}\n任务：${project.tasks.length} 项（进行中 ${project.tasks.filter(x=>x.status==='doing').length}，阻塞 ${project.tasks.filter(x=>x.status==='blocked').length}）\n执行 Job：${projectJobs.length} 个（管道中 ${inPipeline}）\nPi 运行记录：${project.runs.length} 条（运行中 ${project.runs.filter(r=>r.status==='running').length}）\n最近事件：${project.last_event_at||'尚无'}`,basis:[`project:${project.id}`,...project.tasks.map(x=>`task:${x.id}`)],mode:'local-rules'};
    }
    return {answer:`已登记 ${s.projectCount} 个项目，当前记录中有 ${s.activeRuns} 个运行中 Pi Session、${s.blockedTasks} 项人工标记的阻塞任务、${s.pendingSuggestions} 条待审核知识建议、${s.activeJobs} 个管道中执行 Job（另有 ${s.pendingJobApprovals} 个待审批）。\n注意：这只是登记及事件数据，不代表我已检查项目源代码或真实任务结果。`,basis:s.projects.map(p=>`project:${p.id}`),mode:'local-rules'};
  }
  // Model-assisted reasoning is explicitly opt-in, ephemeral and tool-free.
  // Use noTools and a read-only snapshot so the model cannot alter a project.
  // The real path reuses the SAME isolated PiSessionFactory as the pi-analysis worker
  // (review r2: the owner cognitive entry must not leak global/project extensions either);
  // tool verification fails closed before any prompt.
  async askPi(question,{createSession=null}={}){
    const q=String(question??'').trim();if(!q||q.length>1200)throw new Error('Invalid question');
    const s=this.inspect();
    const snapshot={projects:s.projects.map(p=>({id:p.id,name:p.name,goal:p.goal,status:p.status,
      tasks:p.tasks.map(t=>({id:t.id,title:t.title,status:t.status})),
      lastEvent:p.last_event_at,runStatuses:p.runs.map(r=>({sessionId:r.session_id,status:r.status,errors:r.errors})),
      knowledgeLinks:p.knowledgeLinks.map(l=>({id:l.knowledge_id,revision:l.revision}))})),
      pendingSuggestions:this.store.listSuggestions('pending').map(x=>({id:x.id,source:x.source_project_id,target:x.target_project_id,knowledgeId:x.knowledge_id}))};
    const instructions=`你是以 Owner 为中心的只读项目管理助手。以下 JSON 是唯一已确认的数据来源。不得把未知状态表述为完成，不得声称已读取源码或运行测试。禁止提出未经证据支持的事实，逐条注明项目或任务 ID。无需调用工具，也不能执行任何修改。\n\n数据：${JSON.stringify(snapshot)}\n\nOwner 的问题：${q}`;
    if(createSession){
      const {session}=await createSession({noTools:true});
      try{
        await session.prompt(instructions);
        return {answer:session.getLastAssistantText(),mode:'pi-model',basis:s.projects.map(p=>`project:${p.id}`)};
      }finally{session.dispose();}
    }
    // Real path: isolated per-call work dir + empty agentDir + noTools; fail closed if the
    // active tool set is non-empty or unknown.
    let workDir=null,session=null,disposed=false;
    try{
      workDir=mkdtempSync(path.join(os.tmpdir(),'owner-askpi-'));
      session=await this.piSessionFactory.create({cwd:workDir});
      let tools=null;try{tools=session.activeTools();}catch{tools=null;}
      if(!Array.isArray(tools)||tools.length>0){
        session.abort?.();
        throw new Error('Pi tool isolation verification failed; refusing to prompt');
      }
      await session.prompt(instructions);
      return {answer:session.getLastText(),mode:'pi-model',basis:s.projects.map(p=>`project:${p.id}`)};
    }finally{
      if(session&&!disposed){disposed=true;session.dispose();}
      if(workDir){try{rmSync(workDir,{recursive:true,force:true});}catch{/* best effort */}}
    }
  }
}

export function openOwnerAgent({dbPath}={}){const store=new OwnerStore(dbPath);return {store,agent:new OwnerAgent(store),close(){store.close();}};}
