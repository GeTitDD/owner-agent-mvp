const $=selector=>document.querySelector(selector);
const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const state={tab:'owner',selected:null,domain:'',items:[],domains:[],projects:[],project:null,mode:'view',proposals:[],isNew:false};
async function api(route,method='GET',body) {
  const res=await fetch(route,{method,headers:{...(method==='GET'?{}:{'content-type':'application/json','x-workbench-request':'1'})},body:body===undefined?undefined:JSON.stringify(body)});
  const payload=await res.json();if(!res.ok)throw Error(payload.error||`HTTP ${res.status}`);return payload;
}
let toastTimer;
function toast(message){const e=$('#toast');e.textContent=message;e.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>e.classList.remove('show'),4000);}
function hintError(e){toast(`操作失败：${e.message}`);}
function tag(content,kind=''){return `<span class="tag ${kind}">${esc(content)}</span>`;}
function nameScope(scope){return ({personal:'个人',domain:'工作区领域',project:'项目',package:'版本包', 'example-project':'示例项目'})[scope]||scope;}
function nameLayer(layer){return ({domain:'L1 原理',applied:'L2 实践',project:'L3 项目'})[layer]||layer;}
function nameStatus(status){return ({verified:'已验证',unverified:'未验证',needs_reverification:'待重新验证',disputed:'有争议'})[status]||status;}
function setView(tab){state.tab=tab;for(const button of document.querySelectorAll('[data-tab]'))button.classList.toggle('active',button.dataset.tab===tab);
  for(const name of ['owner','knowledge','review','projects'])$(`#${name}View`).hidden=tab!==name;
  $('#pageTitle').textContent=({owner:'Owner Agent · 项目总览',knowledge:'我的领域知识',review:'知识审核中心',projects:'知识组合实验室'})[tab];
  $('#newBtn').hidden=tab!=='knowledge';$('#exportBtn').hidden=tab!=='knowledge';
  if(tab==='review')void loadProposals();if(tab==='projects')renderProjects();if(tab==='owner')void loadOwner();
}
async function loadSummary(){const [stats,domains,projects]=await Promise.all([api('/api/stats'),api('/api/domains'),api('/api/projects')]);
  state.domains=domains;state.projects=projects;
  $('#stats').innerHTML=[['个人知识',stats.personal,'可编辑与修订'],['领域版本',stats.packages,'不可变发布包'],['共享知识',stats.packageKnowledge,'附带版本来源'],['审核队列',stats.pendingProposals,'待人工确认']]
    .map(v=>`<div class="stat"><label>${esc(v[0])}</label><strong>${esc(v[1])}</strong><small>${esc(v[2])}</small></div>`).join('');
  $('#pendingBadge').hidden=!stats.pendingProposals;$('#pendingBadge').textContent=stats.pendingProposals;
  $('#domainList').innerHTML=`<button class="domain-item ${!state.domain?'active':''}" data-domain=""><span>全部领域</span><small>${domains.reduce((a,d)=>a+d.knowledgeCount,0)}</small></button>`+
    domains.map(d=>`<button class="domain-item ${state.domain===d.id?'active':''}" data-domain="${esc(d.id)}"><span>${esc(d.label)}</span><small>${d.knowledgeCount}</small></button>`).join('');
  $('#domainList').querySelectorAll('[data-domain]').forEach(button=>button.addEventListener('click',()=>{state.domain=button.dataset.domain;void refresh();}));
}
async function refresh(){await loadSummary();const query=new URLSearchParams({q:$('#searchInput').value.trim(),domain:state.domain,scope:$('#scopeFilter').value,layer:$('#layerFilter').value});
  state.items=await api(`/api/knowledge?${query}`);renderList();
  if(state.selected && !state.isNew && !state.items.find(x=>x.id===state.selected.id)){
    // Keep detail visible when filtered away, as in normal knowledge apps.
  }
}
function renderList(){const list=$('#knowledgeList');$('#resultCount').textContent=`${state.items.length} 条知识`;
  list.innerHTML=state.items.length?state.items.map(item=>`<button class="knowledge-item ${item.id===state.selected?.id?'active':''}" data-id="${esc(item.id)}"><div class="item-top"><h3>${esc(item.title)}</h3><small>${item.readOnly?'只读':`r${item.revision}`}</small></div><p>${esc(item.excerpt)}</p><div class="tags">${tag(nameLayer(item.layer))}${tag(nameScope(item.scope),'dim')}${item.verificationStatus==='needs_reverification'?tag('需重新验证','warn'):''}${item.domains.slice(0,2).map(x=>tag(x,'dim')).join('')}</div></button>`).join(''):
    '<div class="empty-state" style="margin:40px auto"><p>没有匹配的知识。尝试改变筛选条件，或者新建一条。</p></div>';
  list.querySelectorAll('button[data-id]').forEach(btn=>btn.addEventListener('click',()=>void selectKnowledge(btn.dataset.id)));
}
const defaultKnowledge=()=>({title:'',content:'',kind:'note',layer:'applied',scope:'personal',projectId:null,domains:state.domain?[state.domain]:[],tags:[],evidenceRefs:[],verificationStatus:'unverified',relations:{},sourceRef:null});
async function selectKnowledge(id){try {state.selected=await api(`/api/knowledge/${encodeURIComponent(id)}`);state.isNew=false;renderList();renderEditor();}catch(e){hintError(e);}}
function newKnowledge(){state.selected=defaultKnowledge();state.isNew=true;state.mode='edit';setView('knowledge');renderList();renderEditor();}
function optionList(items,value){return items.map(([v,title])=>`<option value="${esc(v)}" ${value===v?'selected':''}>${esc(title)}</option>`).join('');}
function field(label,id,value,{multiline=false,rows=4,readonly=false,help='',placeholder=''}={}){
  return `<div class="field"><label for="${id}">${esc(label)}</label>${multiline?`<textarea id="${id}" rows="${rows}" ${readonly?'disabled':''} placeholder="${esc(placeholder)}">${esc(value)}</textarea>`:
  `<input id="${id}" value="${esc(value)}" ${readonly?'disabled':''} placeholder="${esc(placeholder)}"/>`}${help?`<small class="help">${esc(help)}</small>`:''}</div>`;
}
function selectField(label,id,value,options,readonly=false){return `<div class="field"><label for="${id}">${esc(label)}</label><select id="${id}" ${readonly?'disabled':''}>${optionList(options,value)}</select></div>`;}
function renderEditor(){const item=state.selected;if(!item)return;
  const readOnly=!!item.readOnly;
  $('#detailPanel').innerHTML=`
    <div class="detail-heading"><div><div class="eyebrow">${state.isNew?'CREATE KNOWLEDGE':readOnly?'IMMUTABLE PACKAGE':'PERSONAL KNOWLEDGE'} ${item.revision?` · REV ${esc(item.revision)}`:''}</div>
    <h2>${state.isNew?'新建知识条目':esc(item.title)}</h2></div>${readOnly?tag('版本锁定'):tag(item.verificationStatus?'● '+nameStatus(item.verificationStatus):'草稿','dim')}</div>
    ${readOnly?'<div class="notice">已发布的领域包和示例项目文件只读。你可以派生一份个人知识进行编辑，不会破坏源版本。</div>':''}
    <form id="knowledgeForm" class="detail-form">
    ${field('知识标题','editTitle',item.title,{readonly:readOnly})}
    ${field('知识正文 / 研究结论','editContent',item.content,{multiline:true,rows:8,readonly:readOnly})}
    <div class="field-grid">
      ${selectField('内容类型','editKind',item.kind,[['note','个人笔记'],['concept','概念'],['claim','知识主张'],['hypothesis','研究假设'],['procedure','实验流程'],['experiment','实验记录']],readOnly)}
      ${selectField('知识抽象层级','editLayer',item.layer,[['domain','L1 · 原理'],['applied','L2 · 跨项目实践'],['project','L3 · 项目实例']],readOnly)}
    </div>
    <div class="field-grid">
      ${selectField('访问范围','editScope',item.scope,[['personal','个人'],['domain','工作区领域'],['project','项目专用'],['package','不可变版本包'],['example-project','示例项目']],readOnly)}
      ${selectField('验证状态','editVerification',item.verificationStatus,[['unverified','未验证'],['verified','已验证（需证据）'],['needs_reverification','需要重新验证'],['disputed','存在争议']],readOnly)}
    </div>
    ${field('项目 ID（仅项目级知识）','editProject',item.projectId??'',{readonly:readOnly,help:'L3 项目知识只能绑定一个项目；跨项目层级不允许配置项目 ID。'})}
    ${field('领域（逗号分隔，可关联多个）','editDomains',(item.domains??[]).join(', '),{readonly:readOnly,placeholder:'pi-sdk, context-engineering'})}
    ${field('标签（逗号分隔）','editTags',(item.tags??[]).join(', '),{readonly:readOnly})}
    ${field('证据引用（每行一条）','editEvidence',(item.evidenceRefs??[]).join('\n'),{multiline:true,rows:3,readonly:readOnly,help:'修改已验证结论后，旧证据会从当前修订移除；历史版本仍保留。'})}
    ${field('知识关系 JSON','editRelations',JSON.stringify(item.relations??{},null,2),{multiline:true,rows:3,readonly:readOnly,help:'例如 {"depends_on":["some-knowledge-id"]}'})}
    ${item.sourceRef?`<p class="detail-summary">来源：${esc(item.sourceRef)}</p>`:''}
    <div class="detail-actions">
      ${readOnly?'<button type="button" id="forkBtn" class="button primary">派生为个人知识</button>':`<button type="submit" class="button primary">${state.isNew?'创建知识':'保存新修订'}</button><button type="button" id="proposalBtn" class="button ghost">作为提案提交</button>`}
    </div></form>
    ${!readOnly&&!state.isNew?'<div class="divider"></div><h3 style="font-size:14px">修订历史</h3><div id="revisionHistory" class="history"></div>':''}`;
  if(readOnly){$('#forkBtn').addEventListener('click',async()=>{try{const fork=await api(`/api/knowledge/${encodeURIComponent(item.id)}/fork`,'POST',{scope:'personal'});toast('已派生个人知识');await refresh();await selectKnowledge(fork.id);}catch(e){hintError(e);}});return;}
  $('#knowledgeForm').addEventListener('submit',event=>{event.preventDefault();void saveKnowledge();});
  $('#proposalBtn').addEventListener('click',()=>void submitProposal());
  $('#editScope').addEventListener('change',()=>{
    if($('#editScope').value==='project'){$('#editLayer').value='project';}
    else if($('#editLayer').value==='project'){$('#editLayer').value='applied';}
  });
  if(!state.isNew)void loadHistory(item.id);
}
function editorPayload(){let relations;
  try{relations=JSON.parse($('#editRelations').value||'{}');}catch{throw Error('知识关系必须是有效 JSON');}
  const splitComma=s=>s.split(',').map(x=>x.trim()).filter(Boolean);
  return {title:$('#editTitle').value.trim(),content:$('#editContent').value.trim(),kind:$('#editKind').value,layer:$('#editLayer').value,
    scope:$('#editScope').value,projectId:$('#editScope').value==='project'?$('#editProject').value.trim():null,
    verificationStatus:$('#editVerification').value,domains:splitComma($('#editDomains').value),tags:splitComma($('#editTags').value),
    evidenceRefs:$('#editEvidence').value.split('\n').map(x=>x.trim()).filter(Boolean),relations,sourceRef:state.selected?.sourceRef??null};
}
async function saveKnowledge(){try{
  const p=editorPayload();const result=state.isNew?await api('/api/knowledge','POST',p):
    await api(`/api/knowledge/${encodeURIComponent(state.selected.id)}`,'PATCH',{...p,expectedRevision:state.selected.revision,note:'Web Workbench edit'});
  toast(state.isNew?'知识已创建':'已保存新修订');await refresh();await selectKnowledge(result.id);
}catch(e){hintError(e);}}
async function submitProposal(){try{const payload=editorPayload();await api('/api/proposals','POST',{targetId:state.isNew?null:state.selected.id,payload,actor:'user',note:'Workbench 提交的待审修改'});toast('提案已提交，尚未修改知识');await loadSummary();}catch(e){hintError(e);}}
async function loadHistory(id){try{const revisions=await api(`/api/knowledge/${encodeURIComponent(id)}/revisions`);
  const box=$('#revisionHistory');if(!box)return;
  box.innerHTML=revisions.map(rev=>`<div class="history-item"><div><strong>修订 r${rev.revision}</strong><small>${esc(rev.note)} · ${esc(rev.timestamp.slice(0,16))}</small></div>${rev.revision===state.selected.revision?'':`<button class="button small ghost" data-revert="${rev.revision}">恢复</button>`}</div>`).join('');
  box.querySelectorAll('[data-revert]').forEach(btn=>btn.addEventListener('click',async()=>{
    if(!confirm(`恢复到 r${btn.dataset.revert} 的内容？这会创建一个新修订。`))return;
    try{await api(`/api/knowledge/${encodeURIComponent(id)}/revert`,'POST',{revision:Number(btn.dataset.revert),expectedRevision:state.selected.revision});toast('已恢复历史内容');await refresh();await selectKnowledge(id);}catch(e){hintError(e);}
  }));
}catch(e){hintError(e);}}
async function loadProposals(){try{state.proposals=await api('/api/proposals');
  $('#reviewList').innerHTML=state.proposals.length?state.proposals.map(x=>`<div class="review-card"><div class="item-top"><h3>${esc(x.payload.title)}</h3>${tag(x.status,x.status==='pending'?'warn':'dim')}</div>
    <div class="review-meta"><span>提议者：${esc(x.actor)}</span><span>${esc(x.created_at?.slice(0,16))}</span><span>${x.target_id?'基于修订 r'+esc(x.target_revision??'?'):'创建新知识'}</span></div>
    <p>${esc(x.payload.content)}</p><div class="tags">${tag(nameLayer(x.payload.layer))}${x.payload.domains.map(d=>tag(d,'dim')).join('')}</div>
    ${x.status==='pending'?`<div class="review-actions" style="margin-top:14px"><button data-approve="${esc(x.id)}" class="button primary small">接受提案</button><button data-reject="${esc(x.id)}" class="button danger small">拒绝</button></div>`:''}
  </div>`).join(''):'<div class="empty-state"><h2>暂无提案</h2><p>Agent 可以通过本地 API 提交知识变更建议，等待你审核。</p></div>';
  $('#reviewList').querySelectorAll('[data-approve],[data-reject]').forEach(button=>button.addEventListener('click',async()=>{
    const id=button.dataset.approve??button.dataset.reject;
    const proposal=state.proposals.find(x=>x.id===id);
    try{let expectedRevision=null;
      if(proposal.target_id){expectedRevision=proposal.target_revision;}
      await api(`/api/proposals/${id}/review`,'POST',{decision:button.dataset.approve?'approved':'rejected',reviewer:'local-user',expectedRevision});
      toast('提案已处理');await loadProposals();await refresh();
    }catch(e){hintError(e);}
  }));
}catch(e){hintError(e);}}
function renderProjects(){if(!state.project&&state.projects.length)state.project=state.projects[0].id;
  $('#projectList').innerHTML=state.projects.map(x=>`<button class="project-option ${x.id===state.project?'active':''}" data-project="${esc(x.id)}"><strong>${esc(x.id)}</strong><small>主要领域：${esc(x.primaryDomain??'未设置')} · 导入 ${x.imports?.length??0} 个显式领域</small></button>`).join('');
  $('#projectList').querySelectorAll('[data-project]').forEach(btn=>btn.addEventListener('click',()=>{state.project=btn.dataset.project;renderProjects();$('#previewResult').textContent='';}));
}
async function preview(){try{$('#previewBtn').disabled=true;const p=await api('/api/context-preview','POST',{projectId:state.project,task:$('#taskInput').value});
  $('#previewResult').innerHTML=`<h3>Context Snapshot</h3><div class="tags">${tag('共享 '+p.sharedSnapshotId.slice(0,12))}${tag('项目 '+p.projectSnapshotId.slice(0,12))}${tag('估算 '+p.estimatedTokens+' tokens')}</div>
    <h3>引用知识 (${p.knowledgeRefs.length})</h3><pre>${esc(p.knowledgeRefs.join('\n'))}</pre>
    <h3>稳定上下文</h3><pre>${esc(p.stableContext)}</pre><h3>动态上下文</h3><pre>${esc(p.dynamicContext)}</pre>`;
}catch(e){hintError(e);}finally{$('#previewBtn').disabled=false;}}
async function addDomain(){const id=prompt('新领域 ID（英文、数字、短横线，例如 my-research）：');if(!id)return;
  const label=prompt('领域显示名称：',id);if(!label)return;
  try{await api('/api/domains','POST',{id:id.trim(),label:label.trim()});toast('领域已创建');await refresh();}catch(e){hintError(e);}}
async function exportKnowledge(){try{const data={format:'domain-knowledge-personal-export-v1',exportedAt:new Date().toISOString(),knowledge:await api('/api/knowledge?scope=personal'),domainKnowledge:await api('/api/knowledge?scope=domain'),projectKnowledge:await api('/api/knowledge?scope=project'),domains:await api('/api/domains'),proposals:await api('/api/proposals')};
  // List API is a summary: retrieve full content + revisions for reliable archive.
  for(const group of [data.knowledge,data.domainKnowledge,data.projectKnowledge])for(let i=0;i<group.length;i++){
    const item=await api(`/api/knowledge/${encodeURIComponent(group[i].id)}`);group[i]={...item,revisions:await api(`/api/knowledge/${encodeURIComponent(item.id)}/revisions`)};
  }
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='domain-knowledge-backup.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}catch(e){hintError(e);}}
async function init(){try{document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.tab)));
  $('#searchInput').addEventListener('input',()=>void refresh());$('#scopeFilter').addEventListener('change',()=>void refresh());$('#layerFilter').addEventListener('change',()=>void refresh());
  $('#newBtn').addEventListener('click',newKnowledge);$('#addDomain').addEventListener('click',()=>void addDomain());$('#exportBtn').addEventListener('click',()=>void exportKnowledge());
  $('#previewBtn').addEventListener('click',()=>void preview());
  $('#ownerRegisterForm').addEventListener('submit',event=>{event.preventDefault();void registerOwnerProject();});
  $('#ownerTaskForm').addEventListener('submit',event=>{event.preventDefault();void createOwnerTask();});
  $('#ownerSuggestForm').addEventListener('submit',event=>{event.preventDefault();void createOwnerSuggestion();});
  $('#companionToggle').addEventListener('click',()=>{$('#companionPanel').hidden=!$('#companionPanel').hidden;});
  $('#companionClose').addEventListener('click',()=>{$('#companionPanel').hidden=true;});
  $('#companionChat').addEventListener('submit',event=>{event.preventDefault();void ownerAsk();});
  setView('owner');await refresh();renderProjects();await loadOwner();
  setInterval(()=>{if(state.tab==='owner')void loadOwner(true);},15000);
}catch(e){hintError(e);}}
void init();


// Owner dashboard and browser-based desktop-companion preview.
let ownerSnapshot=null;
async function loadOwner(silent=false){try{
  const [summary,attention,suggestions,events]=await Promise.all([
    api('/api/owner/summary'),api('/api/owner/attention'),api('/api/owner/suggestions?status=pending'),api('/api/owner/events?limit=12')]);
  ownerSnapshot=summary;
  $('#ownerCounters').innerHTML=[['项目',summary.projectCount,'已登记'],['运行中的 Pi Session',summary.activeRuns,'来源于已授权事件'],['阻塞任务',summary.blockedTasks,'由 Owner 明确标记'],['知识建议',summary.pendingSuggestions,'等待审核']]
    .map(x=>`<div class="stat"><label>${esc(x[0])}</label><strong>${esc(x[1])}</strong><small>${esc(x[2])}</small></div>`).join('');
  $('#ownerProjects').innerHTML=summary.projects.length?summary.projects.map(p=>`<div class="owner-record"><div><strong>${esc(p.name)}</strong>${tag(p.status,'dim')}</div><small>${esc(p.id)} · ${esc(p.primary_domain)} · ${esc(p.root)}</small><p>${esc(p.goal||'尚未设定目标')}</p><small>任务 ${p.tasks.length} · 运行中 ${p.runs.filter(r=>r.status==='running').length} · 最新事件 ${esc(p.last_event_at||'无')}</small>
    <label class="owner-state-select">人工登记状态 <select data-owner-project-status="${esc(p.id)}">${[['planned','规划中'],['active','进行中'],['blocked','阻塞'],['paused','暂停'],['done','完成'],['archived','归档']].map(([v,n])=>`<option value="${v}" ${p.status===v?'selected':''}>${n}</option>`).join('')}</select></label></div>`).join(''):'<p class="owner-muted">尚无项目，请登记一个本地项目目录。</p>';
  $('#ownerProjects').querySelectorAll('[data-owner-project-status]').forEach(b=>b.addEventListener('change',async()=>{try{await api(`/api/owner/projects/${encodeURIComponent(b.dataset.ownerProjectStatus)}`,'PATCH',{status:b.value});await loadOwner();}catch(e){hintError(e);}}));
  const projectOptions=summary.projects.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  $('#ownerSourceProject').innerHTML=projectOptions;$('#ownerTargetProject').innerHTML=projectOptions;
  if(summary.projects.length>1)$('#ownerTargetProject').selectedIndex=1;
  $('#ownerAttention').innerHTML=attention.length?attention.map(a=>`<div class="owner-record"><strong>${esc(a.title)}</strong><small>${esc(a.projectId||'跨项目')} · ${esc(a.evidence.join(' · '))}</small></div>`).join(''):'<p class="owner-muted">当前没有明确登记的待关注事项。</p>';
  $('#ownerSuggestions').innerHTML=suggestions.length?suggestions.map(x=>`<div class="owner-record"><strong>${esc(x.source_project_id)} → ${esc(x.target_project_id)}</strong><p>${esc(x.rationale)}</p><small>${esc(x.knowledge_id)} · r${esc(x.knowledge_revision)} · ${x.evidenceRefs.length} 条证据</small><div class="review-actions"><button class="button primary small" data-owner-review="${esc(x.id)}" data-decision="approved">批准知识关联</button><button class="button ghost small" data-owner-review="${esc(x.id)}" data-decision="rejected">拒绝</button></div></div>`).join(''):'<p class="owner-muted">暂无待审核的迁移建议。</p>';
  $('#ownerSuggestions').querySelectorAll('[data-owner-review]').forEach(b=>b.addEventListener('click',async()=>{try{
    await api(`/api/owner/suggestions/${encodeURIComponent(b.dataset.ownerReview)}/review`,'POST',{decision:b.dataset.decision,reviewer:'local-owner'});
    toast('知识关联提案已审核；不会自动更改目标项目代码');await loadOwner();
  }catch(e){hintError(e);}}));
  $('#ownerTaskProject').innerHTML=projectOptions;
  $('#ownerTasks').innerHTML=summary.projects.flatMap(p=>p.tasks.map(t=>`<div class="owner-task"><small>${esc(p.id)}</small><strong>${esc(t.title)}</strong><select data-task-status="${esc(t.id)}" aria-label="任务状态">${[['todo','待办'],['doing','进行中'],['blocked','阻塞'],['done','完成'],['cancelled','取消']].map(([v,name])=>`<option value="${v}" ${t.status===v?'selected':''}>${name}</option>`).join('')}</select></div>`)).join('')||'<p class="owner-muted">尚无任务。</p>';
  $('#ownerTasks').querySelectorAll('[data-task-status]').forEach(b=>b.addEventListener('change',async()=>{try{await api(`/api/owner/tasks/${encodeURIComponent(b.dataset.taskStatus)}`,'PATCH',{status:b.value});await loadOwner();}catch(e){hintError(e);}}));
  const sharedVerified=await api('/api/knowledge?scope=domain&status=verified');
  $('#ownerKnowledge').innerHTML=sharedVerified.length?sharedVerified.map(k=>`<option value="${esc(k.id)}">${esc(k.title)}</option>`).join(''):'<option value="">没有可用的已验证领域知识</option>';
  $('#ownerEvents').innerHTML=events.map(e=>`<div class="owner-event"><small>${esc(e.received_at.slice(0,19))}</small> <strong>${esc(e.project_id)}</strong> · ${esc(e.kind)}${e.payload.toolName?' · '+esc(e.payload.toolName):''}</div>`).join('')||'<p class="owner-muted">尚无事件。Pi 适配器需要单独启用。</p>';
}catch(e){if(!silent)hintError(e);}}
async function registerOwnerProject(){try{
  const form=new FormData($('#ownerRegisterForm'));
  await api('/api/owner/projects','POST',{id:String(form.get('id')),name:String(form.get('name')),root:String(form.get('root')),primaryDomain:String(form.get('primaryDomain')),goal:String(form.get('goal'))});
  $('#ownerRegisterForm').reset();toast('项目已注册');await loadOwner();
}catch(e){hintError(e);}}
async function createOwnerTask(){try{await api('/api/owner/tasks','POST',{projectId:$('#ownerTaskProject').value,title:$('#ownerTaskTitle').value.trim()});$('#ownerTaskTitle').value='';await loadOwner();toast('任务已创建');}catch(e){hintError(e);}}
async function ownerAsk(){const q=$('#companionQuery').value.trim();if(!q)return;
  const holder=$('#companionMessages');holder.insertAdjacentHTML('beforeend',`<div class="companion-bubble user">${esc(q)}</div>`);$('#companionQuery').value='';
  try{const response=await api('/api/owner/ask','POST',{question:q});holder.insertAdjacentHTML('beforeend',`<div class="companion-bubble">${esc(response.answer)}<small>依据：${esc(response.basis.join(', ')||'无')} · ${esc(response.mode)}</small></div>`);}catch(e){holder.insertAdjacentHTML('beforeend',`<div class="companion-bubble">${esc(e.message)}</div>`);}holder.scrollTop=holder.scrollHeight;
}

async function createOwnerSuggestion(){try{
  await api('/api/owner/suggestions','POST',{sourceProjectId:$('#ownerSourceProject').value,targetProjectId:$('#ownerTargetProject').value,
    knowledgeId:$('#ownerKnowledge').value,rationale:$('#ownerRationale').value.trim()});
  $('#ownerRationale').value='';toast('迁移建议已提交，尚未关联目标项目');await loadOwner();
}catch(e){hintError(e);}}
