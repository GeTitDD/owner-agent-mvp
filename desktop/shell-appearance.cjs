// 外观入口复用真实皮肤 API；配置、桌宠按钮和右键打开同一个选择器。
(function attach(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.OwnerShellAppearance=api;})(typeof globalThis==='undefined'?null:globalThis,()=>{
  const create=ctx=>{
    const $=id=>document.getElementById(id);
    const dialog=$('appearanceDialog');const grid=$('appearanceGrid');const status=$('appearanceStatus');
    const refresh=$('appearanceRefresh');const importButton=$('appearanceImport');const closeButton=$('appearanceClose');const search=$('appearanceSearch');
    const api=window.companion?.mascots;
    let busy=false;let mutating=false;let revision=0;let previousFocus=null;let catalog=null;
    const report=(text='',tone='')=>{status.textContent=text;status.dataset.tone=tone;};
    const setBusy=(value,write=false)=>{busy=value;mutating=value&&write;refresh.disabled=value;importButton.disabled=value;closeButton.disabled=mutating;for(const b of grid.querySelectorAll('button'))b.disabled=value;dialog.setAttribute('aria-busy',String(value));};
    const render=()=>{
      grid.replaceChildren();
      const query=search.value.trim().toLowerCase();
      const shown=(catalog?.skins||[]).filter(skin=>!query||[skin.id,skin.label,skin.collection,skin.rank?`#${String(skin.rank).padStart(2,'0')}`:'',skin.builtin?'内置':'导入'].join(' ').toLowerCase().includes(query));
      for(const skin of shown){
        const button=document.createElement('button');button.type='button';button.className='appearance-card';button.dataset.mascotSkin=skin.id;
        button.setAttribute('aria-pressed',String(skin.id===catalog.current));button.title=skin.label||skin.id;
        const preview=document.createElement('span');preview.className='appearance-preview';
        if(skin.kind==='sprite'&&!skin.thumb){
          preview.classList.add('appearance-sprite');preview.style.backgroundImage=`url(${JSON.stringify(skin.url)})`;
          preview.style.backgroundSize=`${(skin.sprite?.columns||8)*100}% ${(skin.sprite?.rows||9)*100}%`;
          preview.setAttribute('role','img');preview.setAttribute('aria-label',skin.label||skin.id);
        }else{
          const image=document.createElement('img');image.src=skin.thumb||skin.url;image.alt=skin.label||skin.id;image.draggable=false;preview.append(image);
        }
        const name=document.createElement('b');name.textContent=skin.label||skin.id;
        const source=document.createElement('span');source.className='appearance-source';source.textContent=(skin.collection==='petdex'?`Petdex · #${String(skin.rank).padStart(2,'0')}`:skin.builtin?'Cindy 内置':'导入模板')+(skin.kind==='sprite'?' · 动画':' · 静态');
        const selected=document.createElement('span');selected.className='appearance-selected';selected.textContent=skin.id===catalog.current?'使用中':'选择';
        button.append(preview,name,source,selected);button.disabled=busy;button.addEventListener('click',()=>void select(skin));grid.append(button);
      }
      if(!shown.length){const empty=document.createElement('p');empty.textContent=query?'没有匹配的模板，换个词试试。':'没有可用模板，请刷新或导入皮肤包。';grid.append(empty);}
    };
    const load=async()=>{
      if(busy)return;
      const token=++revision;setBusy(true);report('正在读取皮肤模板…');
      try{
        const next=await api.list();if(token!==revision||!dialog.open)return;
        catalog=next;render();report(`共 ${next.skins.length} 个模板；点击即可切换，重启后保留。`);
      }catch(error){if(token===revision&&dialog.open)report(`读取失败：${error?.message||error}。可以点击刷新重试。`,'error');}
      finally{if(token===revision)setBusy(false);}
    };
    const select=async skin=>{
      if(busy||skin.id===catalog?.current)return;
      const token=++revision;setBusy(true,true);report(`正在切换为 ${skin.label||skin.id}…`);
      try{
        const next=await api.set({skin:skin.id});if(token!==revision||!dialog.open)return;
        catalog=next;render();report(`已切换为 ${skin.label||skin.id}，已保存。`,'ok');
        grid.querySelector(`[data-mascot-skin="${CSS.escape(skin.id)}"]`)?.focus({preventScroll:true});
      }catch(error){if(token===revision&&dialog.open)report(`未能切换：${error?.message||error}。原模板仍保留。`,'error');}
      finally{if(token===revision)setBusy(false);}
    };
    const importSkin=async()=>{
      if(busy)return;
      const token=++revision;setBusy(true,true);report('请选择 pet.json、精灵图或皮肤目录…');
      try{
        const result=await api.import();if(token!==revision||!dialog.open)return;
        if(result.canceled){report('已取消导入，原模板未改变。');return;}
        catalog=result.catalog||await api.list();render();report('皮肤已导入并切换，已保存。','ok');
      }catch(error){if(token===revision&&dialog.open)report(`导入失败：${error?.message||error}。原模板仍保留。`,'error');}
      finally{if(token===revision)setBusy(false);}
    };
    const open=()=>{
      if(dialog.open){dialog.focus();return;}
      previousFocus=document.activeElement;dialog.showModal();void load();
    };
    $('appearanceOpen')?.addEventListener('click',open);
    refresh.addEventListener('click',()=>void load());importButton.addEventListener('click',()=>void importSkin());
    search.addEventListener('input',render);
    closeButton.addEventListener('click',()=>{if(!mutating)dialog.close();});
    dialog.addEventListener('cancel',event=>{if(mutating)event.preventDefault();});
    dialog.addEventListener('close',()=>{revision+=1;setBusy(false);previousFocus?.focus?.({preventScroll:true});});
    window.companion?.onOpenAppearance?.(open);
    return {open};
  };
  return {create};
});
