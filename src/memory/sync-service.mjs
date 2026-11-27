// 同步服务冻结预览的两侧版本；确认后再复核、拉取、推送，任何一侧变化都不能沿用旧选择。
import fs from 'node:fs';
import { SYNC_DOCUMENT_MAX, SYNC_TOTAL_MAX } from './sync-git.mjs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, sha256 } from '../utils.mjs';
import { syncPlan } from './sync-plan.mjs';
import { runSync, mergeConflictText, SYNC_CHOICES } from './sync-run.mjs';
import { syncRecordOf, encodeSyncDocument, decodeSyncDocument, restoreSyncLocalFields } from './sync-documents.mjs';

const fail = (message, code) => { const error = new Error(message); error.code = code; throw error; };
const keyOf = (kind,id) => `${kind}:${id}`;
const hashState = value => value ? sha256(canonical(value)) : null;
const titleOf = doc => String(doc?.record.payload.title ?? doc?.record.payload.phenomenon ?? doc?.record.id ?? '');
const bodyOf = doc => doc ? Object.entries(doc.record.payload).map(([key,value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join('\n\n') : '这一侧没有当前文档。';
const fingerprint = entries => sha256(canonical([...entries].map(([id,doc]) => [id,doc.stateHash]).sort(([a],[b])=>a.localeCompare(b))));
const clone = value => JSON.parse(JSON.stringify(value));

export class MemorySyncService {
  constructor({ store, transport, stateFile, now = () => Date.now(), ttlMs = 15 * 60 * 1000 } = {}) {
    if (!store || !transport || !stateFile || !path.isAbsolute(stateFile)) fail('同步服务缺少明确的存储、传输或状态路径。', 'sync-service-invalid');
    this.store=store;this.transport=transport;this.stateFile=stateFile;this.now=now;this.ttlMs=ttlMs;
    this.plans=new Map();this.active=null;
  }

  readState() {
    let raw;
    try { raw=JSON.parse(fs.readFileSync(this.stateFile,'utf8')); }
    catch(error) {
      if(error.code==='ENOENT')return {format:1,target:{repo:this.transport.target.repo,branch:this.transport.target.branch},bases:{},unresolved:[]};
      fail('本机同步基线无法读取，请保留状态文件并恢复后重试。','sync-state-invalid');
    }
    if(raw.format!==1||String(raw.target?.repo??'').toLowerCase()!==this.transport.target.repo.toLowerCase()
      ||raw.target?.branch!==this.transport.target.branch||!raw.bases||typeof raw.bases!=='object'||Array.isArray(raw.bases)||!Array.isArray(raw.unresolved)) {
      fail('本机同步基线与目标不一致，请重新检查设置。','sync-state-invalid');
    }
    for(const [id,base] of Object.entries(raw.bases)) {
      if(!/^(knowledge|lesson):[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(id)||!base||!/^[a-f0-9]{64}$/u.test(base.version)||typeof base.remotePresent!=='boolean') {
        fail('本机同步基线有损坏，未推送任何内容。','sync-state-invalid');
      }
    }
    if(raw.unresolved.some(entry=>!entry||typeof entry!=='object'||!/^(knowledge|lesson):[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(entry.id??''))) {
      fail('本机待处理同步记录有损坏，请恢复后重试。','sync-state-invalid');
    }
    return raw;
  }

  saveState(state) {
    fs.mkdirSync(path.dirname(this.stateFile),{recursive:true,mode:0o700});
    const temp=`${this.stateFile}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temp,JSON.stringify(state,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temp,this.stateFile); }
    finally { try{fs.unlinkSync(temp);}catch{} }
  }

  snapshot() {
    const entries=new Map();
    for(const {kind,row} of this.store.syncRecords({includeArchived:true})) {
      try {
        const doc=encodeSyncDocument(syncRecordOf(kind,row));
        entries.set(doc.id,{...doc,stateHash:hashState(row),archived:!!row.syncArchivedAt});
      } catch(error) { fail(`记忆条目 ${kind}:${row.id} 无法同步：${error.message}`,'sync-local-document-invalid'); }
    }
    return entries;
  }

  dirtyCount() {
    const state=this.readState();const local=this.snapshot();let count=0;
    for(const [id,doc] of local) {
      if(doc.archived)continue;
      if(!state.bases[id]?.remotePresent||state.bases[id].version!==doc.version)count+=1;
    }
    return {count,unresolved:state.unresolved.length,archived:[...local.values()].filter(doc=>doc.archived).length};
  }

  archives() {
    return [...this.snapshot().values()].filter(doc=>doc.archived).map(doc=>({id:doc.id,title:titleOf(doc),kind:doc.record.kind,projectId:doc.record.payload.projectId||''}));
  }

  restoreArchived({documentId,confirmed=false}={}) {
    if(!confirmed)fail('请确认恢复这篇归档记忆。','sync-confirmation-required');
    if(this.active)fail('请等当前同步结束后再恢复归档。','sync-busy');
    const doc=this.snapshot().get(documentId);
    if(!doc?.archived)fail('这篇记忆已不在归档中，请刷新后重试。','sync-archive-unavailable');
    const row=doc.record.kind==='knowledge'?this.store.get(doc.record.id):this.store.getLesson(doc.record.id);
    this.store.importSyncRecord({...doc.record,payload:restoreSyncLocalFields(doc.record.payload,row),expectedStateHash:doc.stateHash});
    return {restored:true,id:documentId,text:'记忆已恢复到本机；检查同步后可以重新传到远端。'};
  }

  async locked(operation,id,run) {
    if(this.active)fail('已有同步正在进行，请等待或取消后再试。','sync-busy');
    const active={operation,id,controller:new AbortController()};this.active=active;
    try{return await run(active.controller.signal);}finally{if(this.active===active)this.active=null;}
  }

  cancel(id='') {
    if(!id||this.active?.id===id)this.active?.controller.abort();
    if(id)this.plans.delete(id);else this.plans.clear();
    return {cancelled:true};
  }

  planOf(id) {
    const plan=this.plans.get(String(id??''));
    if(!plan||this.now()>plan.expiresAt){this.plans.delete(id);fail('这份同步预览已过期，请重新检查后再选择。','sync-plan-expired');}
    return plan;
  }

  async prepare() {
    return this.locked('prepare','',async signal=>{
      const state=this.readState();const remoteRead=await this.transport.read({signal});
      const remote=new Map();
      for(const input of remoteRead.documents){const doc=decodeSyncDocument(input);if(remote.has(doc.id))fail('远端有重复的记忆身份，未进行同步。','sync-duplicate-record');remote.set(doc.id,doc);}
      const allLocal=this.snapshot();const local=new Map([...allLocal].filter(([,doc])=>!doc.archived));
      const union=new Map([...remote,...local]);
      if(union.size>SYNC_DOCUMENT_MAX||[...union.values()].reduce((sum,doc)=>sum+Buffer.byteLength(doc.content),0)>SYNC_TOTAL_MAX) {
        fail('本机与远端的完整记忆清单超过同步限制，未应用或推送任何文档。','sync-total-limit');
      }
      const descriptor=(id,doc,other)=>({id,version:doc.version,updatedAt:doc.record.updatedAt,
        baseVersion:other?.version===doc.version?doc.version:state.bases[id]?.version??null,
        dirty:!!other&&other.version!==doc.version&&!state.bases[id]});
      const plan=syncPlan({local:[...local].map(([id,doc])=>descriptor(id,doc,remote.get(id))),remote:[...remote].map(([id,doc])=>descriptor(id,doc,local.get(id)))});
      const removed=new Set();
      const ensureConflict=(id,reason)=>{
        for(const name of ['added','updated','archived'])plan[name]=plan[name].filter(row=>row.id!==id);
        if(!plan.conflicts.some(row=>row.id===id))plan.conflicts.push({id,reason,local:local.has(id)?{version:local.get(id).version}:null,remote:remote.has(id)?{version:remote.get(id).version}:null});
      };
      for(const [id,doc] of local){
        const base=state.bases[id];
        if(!remote.has(id)&&base?.remotePresent){
          removed.add(id);plan.added=plan.added.filter(row=>row.id!==id);
          if(doc.version===base.version)plan.archived.push({id,remoteRemoved:true});else ensureConflict(id,'remote-removed-local-changed');
        }
      }
      const unresolved=state.unresolved.filter(entry=>{
        const l=local.get(entry.id);const r=remote.get(entry.id);
        return (l||r)&&l?.version!==r?.version;
      }).map(entry=>({...entry,local:local.has(entry.id)?{version:local.get(entry.id).version}:null,remote:remote.has(entry.id)?{version:remote.get(entry.id).version}:null}));
      for(const entry of unresolved)ensureConflict(entry.id,'previously-skipped');
      const actions=new Map();
      for(const item of plan.added)actions.set(item.id,'upload');
      for(const item of plan.updated)actions.set(item.id,item.direction==='push'?'upload':'download');
      for(const item of plan.archived)actions.set(item.id,removed.has(item.id)?'archive':'download');
      for(const item of plan.conflicts)actions.set(item.id,'conflict');
      const counts={upload:0,download:0,archive:0,conflict:0};for(const action of actions.values())counts[action]+=1;
      const id=randomUUID();const createdAt=this.now();
      const documents=[...actions].sort(([a],[b])=>a.localeCompare(b)).map(([docId,action])=>{
        const doc=local.get(docId)||remote.get(docId)||allLocal.get(docId);
        return {id:docId,action,kind:doc.record.kind,title:titleOf(doc),projectId:doc.record.payload.projectId||'',
          localVersion:local.get(docId)?.version||'',remoteVersion:remote.get(docId)?.version||'',remoteRemoved:removed.has(docId)};
      });
      const view={id,createdAt,expiresAt:createdAt+this.ttlMs,repo:this.transport.target.repo,branch:this.transport.target.branch,
        counts,documents,unchanged:plan.counts.unchanged,empty:actions.size===0,excluded:['应用配置与凭据','原始聊天和执行审计','被观察仓库文件']};
      const prepared={id,expiresAt:view.expiresAt,head:remoteRead.head,local,allLocal,remote,removed,plan,view,state,unresolved,fingerprint:fingerprint(allLocal)};
      // 只保留最新预览，避免多份完整记忆快照累积，也不让旧卡片沿用过期版本。
      this.plans.clear();this.plans.set(id,prepared);return clone(view);
    });
  }

  detail(id,documentId) {
    const plan=this.planOf(id);
    if(!plan.view.documents.some(doc=>doc.id===documentId))fail('这篇文档不属于当前同步预览。','sync-document-unavailable');
    const side=doc=>doc?{title:titleOf(doc),version:doc.version,text:bodyOf(doc),payload:clone(doc.record.payload)}:null;
    return {id:documentId,local:side(plan.local.get(documentId)),remote:side(plan.remote.get(documentId)),remoteRemoved:plan.removed.has(documentId)};
  }

  merge(local,remote,at) {
    const record=clone(local.record);const left=record.payload;const right=remote.record.payload;
    const text=key=>mergeConflictText({id:local.id,local:String(left[key]??''),remote:String(right[key]??''),at});
    if(record.kind==='knowledge'){
      const meta=value=>Object.fromEntries(Object.entries(value).filter(([key])=>!['title','content'].includes(key)));
      const remoteMetadata=canonical(meta(left))!==canonical(meta(right))?`\n\n远端条目信息（合并后范围沿用本机）：\n\n\`\`\`json\n${JSON.stringify(meta(right),null,2)}\n\`\`\``:'';
      left.content=mergeConflictText({id:local.id,local:left.content,remote:`${left.title!==right.title?`# ${right.title}\n\n`:''}${right.content}${remoteMetadata}`,at});
      left.domains=[...new Set([...(left.domains??[]),...(right.domains??[])])];left.tags=[...new Set([...(left.tags??[]),...(right.tags??[])])];
      for(const [kind,ids] of Object.entries(right.relations??{}))left.relations[kind]=[...new Set([...(left.relations[kind]??[]),...ids])];
      if(left.verificationStatus==='verified'){left.verificationStatus='needs_reverification';left.evidenceRefs=[];}
      else left.evidenceRefs=[...new Set([...(left.evidenceRefs??[]),...(right.evidenceRefs??[])])];
    }else{
      const meta=value=>({...Object.fromEntries(Object.entries(value).filter(([key])=>!['phenomenon','mechanism','countermeasure','evidence','evidenceRefs','verificationStatus','supportCount','recordIds'].includes(key))),evidence:(value.evidence??[]).map(({excerpt,...fields})=>fields)});
      const remoteMetadata=canonical(meta(left))!==canonical(meta(right))?`\n\n远端经验信息（合并后范围沿用本机）：\n\n\`\`\`json\n${JSON.stringify(meta(right),null,2)}\n\`\`\``:'';
      left.mechanism=text('mechanism')+remoteMetadata;left.countermeasure=text('countermeasure');
      if(left.phenomenon!==right.phenomenon)left.mechanism=`远端现象：${right.phenomenon}\n\n${left.mechanism}`;
      const evidence=new Map((left.evidence??[]).map(entry=>[entry.ref,entry]));
      for(const entry of right.evidence??[]){
        const prior=evidence.get(entry.ref);
        if(prior&&prior.excerpt!==entry.excerpt){const excerpt=mergeConflictText({id:entry.ref,local:prior.excerpt,remote:entry.excerpt,at});evidence.set(entry.ref,{...prior,excerpt,contentHash:sha256(excerpt)});}
        else if(!prior)evidence.set(entry.ref,entry);
      }
      left.evidence=[...evidence.values()].sort((a,b)=>a.ref.localeCompare(b.ref));
      left.evidenceRefs=[...new Set([...(left.evidenceRefs??[]),...(right.evidenceRefs??[])])];left.verificationStatus='disputed';
      if('supportCount' in left||'supportCount' in right)left.supportCount=new Set(left.evidence.map(entry=>entry.recordId)).size;
      if('recordIds' in left||'recordIds' in right)left.recordIds=[...new Set(left.evidence.map(entry=>entry.recordId))].sort();
    }
    record.updatedAt=at;return encodeSyncDocument(record);
  }

  async execute({id,choices={},confirmed=false}={}) {
    if(!confirmed)fail('请先检查同步清单并确认，本次未传输记忆。','sync-confirmation-required');
    return this.locked('execute',id,async signal=>{
      const p=this.planOf(id);let retain=false;const applied=[];const state=clone(p.state);let stateChanged=false;
      try{
        if(!choices||typeof choices!=='object'||Array.isArray(choices))fail('冲突选择格式无效。','sync-choice-invalid');
        const choiceIds=Object.keys(choices);
        if(choiceIds.some(key=>!p.plan.conflicts.some(item=>item.id===key)||!SYNC_CHOICES.includes(choices[key])))fail('冲突选择不属于当前预览，未执行。','sync-choice-invalid');
        const missing=p.plan.conflicts.filter(item=>!Object.hasOwn(choices,item.id)).map(item=>item.id);
        if(missing.length){retain=true;return {status:'conflict',code:'awaiting-choice',missing,plan:clone(p.view),text:`还有 ${missing.length} 篇需要选择，本次未应用或推送。`};}
        const fresh=await this.transport.read({signal});
        if(fresh.head!==p.head)fail('远端在预览后已变化，请重新检查，原选择尚未执行。','remote-changed');
        if(fingerprint(this.snapshot())!==p.fingerprint)fail('本机记忆在预览后已变化，请重新检查。','local-changed');
        const tasks=new Map();const at=new Date(this.now()).toISOString();
        for(const item of p.view.documents){
          let doc=null;let archive=false;
          if(item.action==='download')doc=p.remote.get(item.id);
          if(item.action==='archive')archive=true;
          if(item.action==='conflict'){
            const choice=choices[item.id];
            if(choice==='skip'||choice==='local')continue;
            if(p.removed.has(item.id)){archive=choice==='remote';if(choice==='both')continue;}
            else if(choice==='remote')doc=p.remote.get(item.id);
            else{
              if(!p.local.has(item.id)||!p.remote.has(item.id))fail('其中一个版本已不存在，请重新检查后选择。','sync-side-unavailable');
              doc=this.merge(p.local.get(item.id),p.remote.get(item.id),at);
            }
          }
          if(doc){
            const current=p.allLocal.get(item.id);const raw=current?(doc.record.kind==='knowledge'?this.store.get(doc.record.id):this.store.getLesson(doc.record.id)):null;
            const input={...doc.record,payload:restoreSyncLocalFields(doc.record.payload,raw),expectedStateHash:current?.stateHash??null};
            const normalized=this.store.importSyncRecord({...input,validateOnly:true});
            const normalizedDoc=encodeSyncDocument(syncRecordOf(doc.record.kind,normalized));
            if(normalizedDoc.version!==doc.version)fail(`「${item.title}」需要按本机规则重新复核，未应用或推送。`,'sync-normalization-required');
            tasks.set(item.id,{input,doc,archive:false});
          }else if(archive)tasks.set(item.id,{archive:true,doc:p.allLocal.get(item.id)});
        }
        const acknowledge=(docId)=>{
          const remote=p.remote.get(docId);const local=p.local.get(docId);
          state.bases[docId]={version:remote?.version||local?.version,remotePresent:!!remote};stateChanged=true;
        };
        const apply=(docId)=>{
          signal.throwIfAborted();const task=tasks.get(docId);if(!task)return;
          if(task.archive)this.store.archiveSyncRecord({kind:task.doc.record.kind,id:task.doc.record.id,expectedStateHash:p.allLocal.get(docId).stateHash});
          else this.store.importSyncRecord(task.input);
          applied.push(docId);acknowledge(docId);
        };
        const outcome=await runSync({plan:p.plan,choices,at,deps:{
          env:this.transport.localTest?{GH_TOKEN:'ISOLATED-LOCAL-GIT-TEST'}:this.transport.env,
          loadUnresolved:async()=>p.unresolved,
          saveUnresolved:async entries=>{state.unresolved=entries;stateChanged=true;},
          pull:async({pull,archived})=>{
            const done=[];for(const docId of [...pull,...archived]){apply(docId);done.push(docId);if(done.length%25===0)await new Promise(resolve=>setImmediate(resolve));}
            return {pulled:done};
          },
          readLocal:async docId=>bodyOf(p.local.get(docId)),readRemote:async docId=>bodyOf(p.remote.get(docId)),
          writeLocal:async docId=>{apply(docId);},
          push:async({ids})=>{
            try{
              const outgoing=[];
              for(const docId of ids){
                const original=tasks.get(docId)?.doc||p.local.get(docId);
                if(!original)fail('本机版本已不存在，请重新检查。','local-changed');
                const row=original.record.kind==='knowledge'?this.store.get(original.record.id):this.store.getLesson(original.record.id);
                const current=encodeSyncDocument(syncRecordOf(original.record.kind,row));
                if(current.version!==original.version||row.syncArchivedAt)fail('本机内容在同步期间发生变化，未推送旧副本。','local-changed');
                outgoing.push(current);
                if(choices[docId]&&choices[docId]!=='skip')acknowledge(docId);
              }
              const result=await this.transport.publish({head:p.head,documents:outgoing,signal});
              for(const doc of outgoing)state.bases[doc.id]={version:doc.version,remotePresent:true};
              stateChanged=true;return {pushed:ids,head:result.head};
            }catch(error){return {ok:false,code:error.code||'push-failed',message:error.message};}
          }
        }});
        outcome.records=(outcome.records??[]).map(entry=>p.removed.has(entry.id)?{...entry,
          summary:entry.choice==='remote'?'按远端移除，已将本机归档':entry.choice==='skip'?'跳过移除，仍待处理':'远端已移除，保留本机并重新上传'}:entry);
        if(outcome.status==='ok'){
          state.unresolved=outcome.unresolved;
          for(const [docId,local] of p.local){const remote=p.remote.get(docId);if(remote?.version===local.version)state.bases[docId]={version:remote.version,remotePresent:true};}
          stateChanged=true;
        }
        const changes=(()=>{const local=this.snapshot();let count=0;for(const [docId,doc] of local)if(!doc.archived&&(!state.bases[docId]?.remotePresent||state.bases[docId].version!==doc.version))count+=1;return count;})();
        if(signal.aborted&&outcome.status!=='ok')return {...outcome,status:'error',code:'aborted',applied,text:`同步已停止。本机已接收或归档 ${applied.length} 篇；重新检查可确认远端状态。`};
        if(outcome.status==='ok'&&outcome.unresolved.length)return {...outcome,status:'conflict',code:'unresolved',applied,text:`其他文档已同步，仍有 ${outcome.unresolved.length} 篇留待处理。`};
        if(outcome.status==='ok'&&changes)return {...outcome,status:'error',code:'local-changes-pending',applied,text:`已完成本次传输，但还有 ${changes} 篇本机变化，请重新检查后继续。`};
        return {...outcome,applied,archived:applied.filter(docId=>tasks.get(docId)?.archive)};
      }finally{
        // 即使推送失败，已接收的远端基线与已确认的选择仍保留；重试不会把它们当成未知冲突。
        if(stateChanged)this.saveState(state);
        if(!retain)this.plans.delete(id);
      }
    });
  }
}
