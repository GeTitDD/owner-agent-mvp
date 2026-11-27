// 显式查询、普通聊天与关联资料共用同一只读入口；权限、状态、正文和引用不在视图各算一遍。
import { lessonContent } from './lesson-content.mjs';
import { decisionStatusOf } from '../memory/decision-status.mjs';
const statusLabels={verified:'已验证',unverified:'待验证',inferred:'推断',needs_reverification:'需重新验证',disputed:'有争议',active:'生效中'};
const stop=new Set(['这个','那个','我们','项目','经验','知识','之前','已经','怎么','如何','处理','是否','需要','请问','根据','帮我','告诉','相关','一下','什么','本轮','使用','提供','保存','接受']);
const segmenter=new Intl.Segmenter('zh',{granularity:'word'});
const termsOf=query=>[...new Set([...segmenter.segment(String(query).toLowerCase())].filter(x=>x.isWordLike&&x.segment.length>1&&!stop.has(x.segment)).map(x=>x.segment))];
const clean=value=>typeof value==='string'?value.trim():'';
const projectDomains=p=>[...new Set([p?.primary_domain,p?.primaryDomain,...(Array.isArray(p?.domains)?p.domains:[])].filter(Boolean))];

/** 不复制事实到目标项目；关联只能由已登记项目 ID 与已选择的资料类型放行。 */
export function recallExperience({personalStore,ownerStore,projectId='',query='',linkedProjects=[],limit=5,includeAll=false,maxChars=28000}={}) {
 const current=projectId?ownerStore?.getProject?.(projectId):null;const domains=projectDomains(current);
 const linked=new Map();
 for(const selection of Array.isArray(linkedProjects)?linkedProjects.slice(0,10):[]){
  const project=ownerStore?.getProject?.(selection?.id);
  if(project&&(selection.materials?.includes('experience')||selection.auto===true))linked.set(project.id,project);
 }
 const records=personalStore?.syncRecords?.()??[];const q=clean(query).toLowerCase();const terms=termsOf(q);const excluded={superseded:0,archived:0};
 const visible=[];
 for(const {kind,row} of records){
  if(row.syncArchivedAt){excluded.archived++;continue;}
  const isLesson=kind==='lesson';const owner=isLesson?(row.scope?.projectId||row.projectId):row.projectId;
  const shared=isLesson?row.scope?.layer==='domain':row.scope==='domain';
  const rowDomains=isLesson?(row.scope?.domainIds??[]):(row.domains??[]);
  const fromLink=!!owner&&linked.has(owner);
  const sharedForLink=shared&&[...linked.values()].some(p=>projectDomains(p).some(d=>rowDomains.includes(d)));
  if(!(owner&&owner===current?.id)&&!(shared&&domains.some(d=>rowDomains.includes(d)))&&!fromLink&&!sharedForLink)continue;
  const status=row.kind==='decision'?decisionStatusOf(row):row.verificationStatus;
  if(status==='superseded'||(row.kind==='decision'&&status!=='active')){excluded.superseded++;continue;}
  const body=isLesson?lessonContent(row,{ownerStore}):clean(row.content);
  const title=isLesson?row.phenomenon:row.title;
  const hay=[title,body,...(row.tags??[])].join(' ').toLowerCase();
  const matched=terms.filter(term=>hay.includes(term));
  const exact=!!q&&hay.includes(q);
  if(q&&!includeAll&&!exact&&!matched.length&&!fromLink&&!sharedForLink)continue;
  const ref=isLesson?`lesson:${row.id}`:`knowledge:${row.id}@${row.revision}`;
  const same=owner===current?.id;const layer=shared?'domain':'project';
  visible.push({id:row.id,kind:isLesson?'lesson':'knowledge',revision:isLesson?null:row.revision,ref,title,content:body,
   mechanism:isLesson?row.mechanism:'',countermeasure:isLesson?row.countermeasure:'',
   status,statusLabel:statusLabels[status]||'状态未知',scope:layer,projectId:owner||null,domains:rowDomains,
   sourceRef:row.sourceRef||(isLesson?`record:${row.sourceRecordId}`:''),
   evidenceRefs:[...new Set([...(row.evidenceRefs??[]),...(row.evidence??[]).map(e=>e.ref)])],
   reason:fromLink&&!same?'显式关联项目的只读资料':shared?'与当前/关联项目领域一致':'当前项目记录',
   matchReason:exact?'完整关键词命中':matched.length?`命中：${matched.join('、')}`:'最近记录',
   score:(exact?100:0)+matched.length*5+((fromLink||sharedForLink)?20:0),updatedAt:row.updatedAt||row.createdAt||'',
   sourceLessonId:!isLesson&&clean(row.sourceRef).startsWith('knowledge-loop:lesson:')?row.sourceRef.slice('knowledge-loop:lesson:'.length):'',
   lesson:isLesson?row:null});
 }
 // 正式知识已经提供同一事实时，不再把旧的空结构经验作为另一份建议；域级经验覆盖同现象项目经验。
 const upgraded=new Set(visible.filter(x=>x.kind==='knowledge').map(x=>x.sourceLessonId).filter(Boolean));
 const sharedPhenomena=new Set(visible.filter(x=>x.kind==='lesson'&&x.scope==='domain').map(x=>clean(x.title).toLowerCase()));
 const rows=visible.filter(x=>!upgraded.has(x.id)&&!(x.kind==='lesson'&&x.scope==='project'&&sharedPhenomena.has(clean(x.title).toLowerCase())));
 rows.sort((a,b)=>(a.status==='disputed')-(b.status==='disputed')||b.score-a.score||(a.kind==='lesson')-(b.kind==='lesson')||(a.status!=='verified')-(b.status!=='verified')||b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
 const cap=Math.min(50,Math.max(1,Number.isSafeInteger(limit)?limit:5));const items=[];const omitted=[];let text='';
 for(const item of rows){
  if(items.length>=cap)break;
  const refs=item.evidenceRefs.slice(0,8).join('；')||'未提供证据引用';
  const part=`[${item.ref}] ${item.title}\n类型：${item.kind==='knowledge'?'知识':'经验（只读参考）'} · ${item.statusLabel}${item.status==='disputed'?'，有争议，不能作定论':''}\n范围：${item.scope==='domain'?`领域 ${item.domains.join('、')}`:`项目 ${item.projectId}`} · ${item.reason} · ${item.matchReason}\n正文：\n${item.content}\n来源：${item.sourceRef||'未记录'}\n证据：${refs}${item.evidenceRefs.length>8?'；另有证据引用未注入':''}\n`;
  if(text.length+part.length>maxChars){omitted.push({id:item.id,ref:item.ref,title:item.title,reason:'正文超出本轮引用容量，未截断后当成完整依据'});continue;}
  items.push(item);text+=(text?'\n':'')+part;
 }
 return {projectId,items,total:rows.length,omitted,excluded,text,reason:items.length?'':omitted.length?'相关正文过长，未带入本轮；请在工作台核对或缩小范围。':q?`没有匹配「${clean(query)}」的经验或知识。`:'当前项目与领域还没有可引用的经验或知识。'};
}
