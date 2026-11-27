// 同步沿用配置箱内的一个操作区；这里只画清单和收集逐篇选择，所有写入判定都在主进程。
(function (root) {
  let host=null;let options=null;let plan=null;let receipt=null;let busy='';let notice='';let tone='';
  let choices={};let shown=40;let filter='';let confirmed=false;let generation=0;let archives=[];let archiveConfirm='';let errorDetail='';
  const details=new Map();const pending=new Set();
  const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
  const api=()=>window.companion.memorySync;
  const button=(label,action,disabled=false)=>{const node=el('button','review-action',label);node.type='button';node.disabled=disabled;node.addEventListener('click',action);return node;};
  const changed=()=>!host||['syncRepo','syncBranch'].some(key=>{
    const input=host.closest('[data-section="sync"]').querySelector(`[data-cfg="${key}"]`);
    return String(input?.value??'').trim()!==String(options.values[key]??(key==='syncBranch'?'main':''));
  });
  const notify=(text,state='')=>{notice=text;tone=state;render();};
  const refresh=()=>void options?.ctx.ui.header.loadSyncStatus();
  const errorText=error=>{const view=window.OwnerSyncStatus.syncErrorView(error);errorDetail=view.detail;return view.text;};
  const check=async()=>{
    if(busy||changed())return;
    options.onBegin?.();errorDetail='';
    const token=++generation;busy='check';plan=null;receipt=null;confirmed=false;choices={};details.clear();pending.clear();shown=40;
    notify('正在连接仓库，读取两侧清单…');
    try{const next=await api().prepare();if(token!==generation)return;plan=next;notice=next.empty?'两侧内容一致；确认本次检查后记录同步时间。':'检查完成。展开正文核对内容，并逐篇处理冲突。';tone='';}
    catch(error){if(token!==generation)return;notice=`检查未完成：${errorText(error)}。本机仍可照常使用。`;tone='error';}
    finally{if(token===generation){busy='';render();refresh();}}
  };
  const cancel=async()=>{
    if(busy==='cancel')return;
    const phase=busy;busy='cancel';render();
    try{
      await api().cancel({id:phase==='check'?'':plan?.id||''});
      if(phase!=='execute') {generation+=1;plan=null;confirmed=false;busy='';notify('已取消检查或预览，没有应用或推送记忆。');}
      // 传输取消后的实际落点由 execute 返回；不把已完成的拉取说成零写入。
    }catch(error){busy='';notify(`取消未完成：${errorText(error)}`,'error');}
  };
  const execute=async()=>{
    if(busy||!plan||!confirmed||changed())return;
    errorDetail='';busy='execute';notify(plan.empty?'正在复核两侧版本并记录检查结果，可停止后重新检查…':'正在按已确认清单传输，请等待；可停止后重新检查…');
    try{
      const result=await api().execute({id:plan.id,choices:{...choices},confirmed:true});
      receipt=result;plan=null;confirmed=false;
      const message=result.text||result.message||'同步未完成，请重新检查。';
      notice=result.status==='ok'||result.code==='unresolved'?message:errorText(new Error(message));tone=result.status==='ok'?'ok':result.code==='unresolved'?'warn':'error';
      if(result.status!=='ok'&&result.code!=='unresolved')notice+=` 已接收或归档 ${result.applied?.length||0} 篇；本机数据保留，请重新检查远端状态。`;
    }catch(error){plan=null;confirmed=false;notice=`同步未完成：${errorText(error)} 请重新检查清单后再选择。`;tone='error';}
    finally{busy='';render();refresh();}
  };
  const loadDetail=async(doc,body)=>{
    const key=doc.id;
    if(details.has(key)){drawDetail(body,details.get(key));return;}
    if(pending.has(key))return;
    const token=generation;pending.add(key);body.replaceChildren(el('p','','正在读取完整正文…'));
    try{
      const value=await api().detail({id:plan.id,documentId:key});
      if(token!==generation)return;details.set(key,value);if(body.isConnected)drawDetail(body,value);
    }catch(error){if(body.isConnected){body.replaceChildren(el('p','sync-error',`正文读取失败：${errorText(error)}`),button('重试读取',()=>loadDetail(doc,body)));}}
    finally{pending.delete(key);}
  };
  const drawDetail=(body,value)=>{
    body.replaceChildren();
    for(const [key,label] of [['local','本机版本'],['remote','远端版本']]){
      const side=el('section','sync-side');side.append(el('h5','',label));const data=value[key];
      if(!data)side.append(el('p','',key==='remote'&&value.remoteRemoved?'远端已移除；选择远端会把本机归档，可恢复。':'这一侧没有当前文档。'));
      else{
        const payload=data.payload;
        for(const [field,title] of [['title','标题'],['content','内容'],['phenomenon','现象'],['mechanism','机制'],['countermeasure','对策']]){
          if(payload[field]!==undefined){side.append(el('strong','',title),el('pre','sync-body',payload[field]));}
        }
        const meta=el('details','sync-metadata');meta.append(el('summary','','范围、状态、证据与其他字段'),el('pre','sync-body',JSON.stringify(Object.fromEntries(Object.entries(payload).filter(([key])=>!['title','content','phenomenon','mechanism','countermeasure'].includes(key))),null,2)));side.append(meta);
      }
      body.append(side);
    }
  };
  const rowOf=doc=>{
    const row=el('article','sync-document');row.dataset.documentId=doc.id;row.dataset.action=doc.action;
    const detail=el('details','sync-document-detail');const summary=el('summary','');
    const labels={upload:'传到远端',download:'接收到本机',archive:'归档到本机',conflict:'需要选择'};
    summary.append(el('span','sync-action',labels[doc.action]),el('span','sync-title',doc.title||doc.id));
    detail.append(summary,el('p','sync-project',`${doc.kind==='lesson'?'经验':'知识或决策'} · ${doc.projectId||'跨项目'} · ${doc.id}`));
    const body=el('div','sync-sides');detail.append(body);detail.addEventListener('toggle',()=>{if(detail.open)void loadDetail(doc,body);});row.append(detail);
    if(doc.action==='conflict'){
      const label=el('label','sync-choice-label','这一篇如何处理');const select=el('select','cfg-input sync-choice');
      select.setAttribute('aria-label',`冲突处理：${doc.title}`);select.append(new Option('请选择，不会自动覆盖',''));
      const deleted=doc.remoteRemoved;
      for(const [value,text] of [['remote',deleted?'按远端移除，将本机归档（可恢复）':'用远端版本替换本机'],['local','用本机版本更新远端'],['both',deleted?'保留本机，重新传到远端':'两段都留，注明来源（范围沿用本机）'],['skip','跳过这一篇，保留未解决标记']])select.append(new Option(text,value));
      select.value=choices[doc.id]||'';select.disabled=!!busy;select.addEventListener('change',()=>{if(select.value)choices[doc.id]=select.value;else delete choices[doc.id];confirmed=false;renderFooter();});label.append(select);row.append(label);
    }
    return row;
  };
  const renderFooter=()=>{
    const footer=host?.querySelector('.sync-confirm');if(!footer||!plan)return;
    const missing=plan.documents.filter(doc=>doc.action==='conflict'&&!choices[doc.id]).length;
    footer.replaceChildren(el('p','',missing?`还有 ${missing} 篇冲突未选择；可选“跳过”并继续其他文档。`:plan.empty?'本次没有待传输文档。确认会记录检查时间，不改变两侧记忆。':'请核对已选处理方式。确认会应用接收/归档并把所列文档发往此私有仓库。'));
    const label=el('label','sync-consent');const input=el('input','');input.type='checkbox';input.checked=confirmed;input.disabled=!!busy||!!missing||changed();input.dataset.syncConfirm='true';
    input.addEventListener('change',()=>{confirmed=input.checked;renderFooter();});
    label.append(input,document.createTextNode(plan.empty?`确认记录 ${plan.repo} · ${plan.branch} 本次检查结果。`:`我已核对 ${plan.repo} · ${plan.branch} 的清单，确认传输记忆正文与证据摘录。`));
    const write=button(plan.empty?'确认检查结果':'确认并同步',()=>void execute(),!!busy||!!missing||!confirmed||changed());write.dataset.syncExecute='true';footer.append(label,write);
  };
  const render=()=>{
    if(!host)return;host.replaceChildren();host.dataset.busy=busy;
    const dirty=changed();
    const toolbar=el('div','sync-toolbar');const inspect=button(busy==='check'?'正在检查…':'检查同步（只读预览）',()=>void check(),!!busy||dirty||!options.values.syncRepo);inspect.dataset.syncPrepare='true';toolbar.append(inspect);
    if(busy||plan){const stop=button(busy==='execute'?'停止传输':busy==='cancel'?'正在停止…':'取消检查 / 预览',()=>void cancel(),busy==='cancel');stop.dataset.syncCancel='true';toolbar.append(stop);}
    if(dirty){toolbar.append(button('先保存设置',()=>void options.onSave(),!!busy));}
    host.append(toolbar);
    const status=el('p','sync-notice',dirty?'仓库或分支有未保存更改。请先保存，再检查同步。':notice||'检查只读取两侧文档；没有确认就不会应用或推送。');status.setAttribute('role','status');status.dataset.tone=dirty?'warn':tone;host.append(status);
    if(errorDetail){const detail=el('details','sync-metadata');detail.append(el('summary','','查看技术详情'),el('pre','sync-body',errorDetail));host.append(detail);}
    if(plan){
      host.append(el('h4','',`本次清单 · ${plan.repo}`),el('p','sync-target',`分支 ${plan.branch} · 上传 ${plan.counts.upload} · 接收 ${plan.counts.download} · 归档 ${plan.counts.archive} · 冲突 ${plan.counts.conflict} · 无变化 ${plan.unchanged}`));
      if(plan.unmappedProjects?.length)host.append(el('p','sync-notice','以下项目尚未在本机登记：'+plan.unmappedProjects.join('、')+'。记忆保留原项目 ID；不会自动登记目录或修改项目归属。'));
      host.append(el('p','sync-target','不包含：'+plan.excluded.join('、')+'。结构化机器路径已省略；请展开正文检查自己写入的敏感内容。'));
      const search=el('input','cfg-input');search.type='search';search.placeholder='按标题、项目或文档 ID 查找清单';search.value=filter;search.setAttribute('aria-label','筛选同步清单');
      const list=el('div','sync-documents');const drawList=()=>{list.replaceChildren();const matched=plan.documents.filter(doc=>`${doc.title} ${doc.projectId} ${doc.id}`.toLowerCase().includes(filter.toLowerCase()));list.append(...matched.slice(0,shown).map(rowOf));if(matched.length>shown)list.append(button(`再显示 40 篇（剩余 ${matched.length-shown}）`,()=>{shown+=40;drawList();}));if(!matched.length)list.append(el('p','',plan.empty?'没有需要传输的文档。':'没有匹配文档；隐藏的文档仍属于本次清单。'));};
      search.addEventListener('input',()=>{filter=search.value;shown=40;drawList();});host.append(search,list);drawList();host.append(el('div','sync-confirm'));renderFooter();
    }
    if(receipt?.records?.length){const records=el('details','sync-metadata');records.append(el('summary','','本次逐篇处理记录'));const names={remote:'采用远端',local:'采用本机',both:'保留两侧',skip:'跳过，仍待处理'};records.append(el('pre','sync-body',receipt.records.map(item=>`${item.id}：${item.summary||names[item.choice]||item.choice}`).join('\n')));host.append(records);}
    const archiveBox=el('div','sync-archives');archiveBox.append(button('查看可恢复归档',async()=>{if(busy)return;try{archives=await api().archives();archiveConfirm=archives.length?'':'empty';render();}catch(error){notify(`读取归档失败：${errorText(error)}`,'error');}},!!busy||!options.values.syncRepo));
    if(archives.length===0&&archiveConfirm==='empty')archiveBox.append(el('p','','暂无归档。'));
    for(const doc of archives){const row=el('div','sync-archive-row');row.append(el('span','',doc.title));const restore=button(archiveConfirm===doc.id?'确认恢复到本机':'恢复',async()=>{
      if(archiveConfirm!==doc.id){archiveConfirm=doc.id;render();return;}
      busy='restore';render();
      try{await api().restore({documentId:doc.id,confirmed:true});archives=archives.filter(item=>item.id!==doc.id);plan=null;notify('已恢复到本机；重新检查后可传到远端。','ok');refresh();}catch(error){notify(`恢复失败：${errorText(error)}`,'error');}
      finally{busy='';render();refresh();}
    },!!busy);restore.dataset.restoreId=doc.id;row.append(restore);archiveBox.append(row);}
    host.append(archiveBox);
  };
  root.OwnerShellSync={
    mount(section,next){host=el('div','sync-workspace');options=next;section.append(host);for(const input of section.querySelectorAll('[data-cfg="syncRepo"],[data-cfg="syncBranch"]'))input.addEventListener('input',()=>{confirmed=false;render();});render();},
    detach(){host=null;},
    reset(){generation+=1;plan=null;receipt=null;choices={};confirmed=false;details.clear();archives=[];notice='设置已保存，请检查同步。';tone='';errorDetail='';},
  };
})(globalThis);
