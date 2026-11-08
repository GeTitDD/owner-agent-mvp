// Lightweight event-driven monitor. Keeps no LLM session alive and performs no mutations.
import { OwnerAgent } from './owner-agent.mjs';
export class OwnerResidentRuntime {
  constructor(store,{intervalMs=15000,onEvent=()=>{},onAttention=()=>{},knowledgeRuntime=null}={}){
    if(!Number.isSafeInteger(intervalMs)||intervalMs<1000)throw new Error('Minimum polling interval is 1000ms');
    this.store=store;this.agent=new OwnerAgent(store);this.intervalMs=intervalMs;
    this.onEvent=onEvent;this.onAttention=onAttention;this.timer=null;
    this.knowledgeRuntime=knowledgeRuntime;this.knowledgeBusy=false;this.lastKnowledge=null;
    this.cursor=0;this.alerts=new Set();
  }
  start(){
    if(this.timer)return;
    this.cursor=this.store.listEvents({limit:1})[0]?.seq??0;
    this.alerts=new Set(this.agent.attention().map(a=>this.key(a)));
    this.timer=setInterval(()=>this.tick(),this.intervalMs);
    this.timer.unref?.();
  }
  key(a){return `${a.kind}:${a.projectId??''}:${a.evidence.join('|')}`;}
  tick(){
    const events=this.store.listEvents({afterSeq:this.cursor,limit:500}).reverse();
    for(const event of events){this.cursor=Math.max(this.cursor,event.seq);this.onEvent(event);}
    const attention=this.agent.attention();const present=new Set(attention.map(a=>this.key(a)));
    for(const item of attention)if(!this.alerts.has(this.key(item)))this.onAttention(item);
    this.alerts=present;
    if(this.knowledgeRuntime&&!this.knowledgeBusy){
      this.knowledgeBusy=true;
      Promise.resolve()
        .then(()=>this.knowledgeRuntime.tick())
        .then(result=>{this.lastKnowledge=result;})
        .catch(()=>{/* 知识采集失败不应阻断 owner 监控 */})
        .finally(()=>{this.knowledgeBusy=false;});
    }
    return {events:events.length,attention:attention.length,cursor:this.cursor};
  }
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
}
