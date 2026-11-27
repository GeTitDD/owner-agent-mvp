// GitHub 添加是单次明确动作；表单输入与原会话草稿分开，不用远端结果猜写入项目。
(function attach(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.OwnerShellGitHubProject=api;})(typeof globalThis==='undefined'?null:globalThis,()=>{
  const create=ctx=>{
    const bridge=window.companion?.githubProjects;
    const dialog=document.createElement('dialog');dialog.id='githubProjectDialog';dialog.className='github-project-dialog';
    dialog.setAttribute('aria-labelledby','githubProjectTitle');
    dialog.innerHTML=`<form id="githubProjectForm">
      <div class="github-project-heading"><h2 id="githubProjectTitle">从 GitHub 添加项目</h2><button type="button" id="githubProjectClose" aria-label="关闭添加窗口">×</button></div>
      <div class="github-project-body">
      <p class="github-project-hint">关联仓库与本机工作目录。项目仓库与记忆同步分别设置。</p>
      <label for="githubProjectSource">GitHub 仓库</label>
      <div class="github-project-source"><input id="githubProjectSource" maxlength="500" placeholder="https://github.com/用户名/仓库名" spellcheck="false" autocomplete="off"><button type="submit" id="githubProjectInspect">检查链接</button></div>
      <p id="githubProjectRepository" class="github-project-hint" hidden></p>
      <div id="githubProjectExisting" hidden><p class="github-project-hint">这个仓库已经添加过，选择要打开的本机项目。</p><div id="githubProjectExistingList"></div></div>
      <section id="githubProjectActions" hidden>
        <button type="button" id="githubProjectLink" class="github-project-link">已下载？关联本机已有目录</button>
        <div class="github-project-divider">或下载一份新的本机副本</div>
        <label for="githubProjectParent">保存位置</label>
        <div class="github-project-source"><input id="githubProjectParent" readonly placeholder="选择用于保存项目的文件夹"><button type="button" id="githubProjectChooseParent">选择位置</button></div>
        <label for="githubProjectFolder">新文件夹名称</label><input id="githubProjectFolder" maxlength="100" spellcheck="false" autocomplete="off">
        <p id="githubProjectDestination" class="github-project-hint"></p>
        <p class="github-project-hint">只下载和登记，不执行安装或项目脚本。使用本机已有 Git/GitHub 凭据，此处不填写 token。</p>
      </section>
      </div>
      <div class="github-project-state"><p id="githubProjectStatus" role="status" aria-live="polite" hidden></p><progress id="githubProjectProgress" max="100" hidden></progress></div>
      <div class="github-project-footer"><button type="button" id="githubProjectCancel">返回</button><button type="button" id="githubProjectClone" hidden>下载并添加</button></div>
    </form>`;
    document.body.append(dialog);
    const $=id=>dialog.querySelector('#'+id);const source=$('githubProjectSource'),parent=$('githubProjectParent'),folder=$('githubProjectFolder');
    let inspection=null,busy='',generation=0,requestId='',automaticFolder='',returnFocus=null,opening=false;
    const status=(text,tone='')=>{const e=$('githubProjectStatus');e.textContent=text;e.hidden=!text;e.dataset.tone=tone;};
    const destination=()=>{
      const target=$('githubProjectDestination');target.replaceChildren();if(!parent.value||!folder.value)return;
      const code=document.createElement('code');code.textContent=`${parent.value.replace(/[\\/]$/u,'')}${parent.value.includes('\\')?'\\':'/'}${folder.value}`;
      target.append(document.createTextNode('将新建：'),code);
    };
    const render=()=>{
      const existing=Boolean(inspection?.existingProjects?.length);
      $('githubProjectExisting').hidden=!existing;$('githubProjectActions').hidden=!inspection||existing;
      $('githubProjectClone').hidden=!inspection||existing;
      for(const e of dialog.querySelectorAll('input,#githubProjectInspect,#githubProjectChooseParent,#githubProjectLink,#githubProjectClone,[data-github-existing]'))e.disabled=Boolean(busy);
      $('githubProjectClone').disabled=Boolean(busy)||!parent.value||!folder.value.trim();
      $('githubProjectInspect').textContent=busy==='checking'?'正在检查…':'检查链接';
      $('githubProjectClone').textContent=busy==='downloading'?'正在下载…':'下载并添加';
      $('githubProjectCancel').textContent=busy==='downloading'?'取消下载':busy==='linking'||busy==='opening'?'正在完成…':'返回';
      $('githubProjectCancel').disabled=busy==='linking'||busy==='opening';
      $('githubProjectClose').disabled=busy==='linking'||busy==='opening';
      $('githubProjectProgress').hidden=busy!=='downloading';destination();
    };
    const unwrap=result=>{if(result?.ok===false)throw Object.assign(new Error(result.message),{code:result.code});return result;};
    const failure=error=>status(error?.message||'暂时无法添加，输入已保留，请重试。','error');
    const openProject=async project=>{
      if(!inspection?.existingProjects?.some(item=>item.id===project.id))inspection={...inspection,existingProjects:[project,...(inspection?.existingProjects??[])]};
      renderExisting();
      busy='opening';status('项目已保存，正在打开…');render();
      try{
        await ctx.ui.header.openProject(project.id);
        if(ctx.ui.header.viewProjectId()!==project.id)throw Error('项目已保存，但未能打开。请从项目菜单选择，或再次点击打开已有项目。');
        busy='';dialog.close();ctx.notify?.('已打开项目，GitHub 来源与本机目录已关联');ctx.ui.compose.focus();
      }catch(error){inspection={...inspection,existingProjects:[project]};renderExisting();failure(error);}
      finally{busy='';render();}
    };
    const renderExisting=()=>{
      const list=$('githubProjectExistingList');list.replaceChildren();
      for(const project of inspection?.existingProjects??[]){
        const button=document.createElement('button');button.type='button';button.dataset.githubExisting=project.id;
        const name=document.createElement('strong');name.textContent=project.name;const location=document.createElement('span');location.textContent=project.root;
        button.append(name,location);button.addEventListener('click',()=>{if(!busy)void openProject(project);});list.append(button);
      }
      render();
    };
    const close=async()=>{
      if(busy==='linking'||busy==='opening')return;
      if(busy==='downloading'){
        $('githubProjectCancel').disabled=true;$('githubProjectClose').disabled=true;status('正在取消，等待下载进程退出…');
        try{const result=await bridge.cancel({requestId});if(result?.finishing)status('下载已结束，正在完成登记，请稍候…');}catch{status('暂未确认取消，请稍候重试。','error');$('githubProjectCancel').disabled=false;$('githubProjectClose').disabled=false;}
        return;
      }
      generation++;if(busy==='checking')status('已取消检查，链接已保留，可重新检查后继续。');busy='';render();dialog.close();
    };
    const open=async()=>{
      if(dialog.open||opening)return;opening=true;
      try{await ctx.ui.compose.flushDraft();}catch{ctx.notify?.('当前草稿还未保存，请重试后再添加项目。','error');opening=false;return;}
      returnFocus=document.activeElement;ctx.ui.header.closePopoverIfOpen();ctx.ui.header.dismissOverlay();dialog.showModal();
      if(!bridge)status('添加接口不可用，请重新启动应用。','error');render();source.focus();
      opening=false;
    };
    for(const id of ['githubProjectAdd','firstGithubProjectAdd'])document.getElementById(id)?.addEventListener('click',()=>void open());
    source.addEventListener('input',()=>{generation++;inspection=null;$('githubProjectRepository').hidden=true;status('');render();});
    folder.addEventListener('input',render);
    $('githubProjectForm').addEventListener('submit',event=>{
      event.preventDefault();if(busy||!bridge)return;
      const token=++generation;busy='checking';status('正在检查链接与已添加项目…');render();
      void(async()=>{try{
        const result=unwrap(await bridge.inspect({source:source.value}));if(token!==generation)return;
        inspection=result;if(!folder.value||folder.value===automaticFolder)folder.value=result.repository.repo;automaticFolder=result.repository.repo;
        $('githubProjectRepository').textContent=`来源：${result.repository.url}`;$('githubProjectRepository').hidden=false;
        renderExisting();status(result.existingProjects.length?'找到已有项目，不需要重复下载。':'链接格式正确。可以关联已有目录，或选择位置下载。');
      }catch(error){if(token===generation){inspection=null;failure(error);}}
      finally{if(token===generation){busy='';render();}}})();
    });
    $('githubProjectChooseParent').addEventListener('click',()=>{if(busy)return;void bridge.directory({purpose:'download'}).then(value=>{if(value){parent.value=value;parent.title=value;status('');render();}}).catch(failure);});
    $('githubProjectLink').addEventListener('click',()=>{
      if(busy||!inspection)return;busy='linking';status('选择已下载的仓库目录，随后核对 origin…');render();
      void(async()=>{try{const root=await bridge.directory({purpose:'link'});if(!root){status('已取消目录选择，没有添加项目。');return;}
        const result=unwrap(await bridge.link({source:source.value,root}));await openProject(result.project);
      }catch(error){failure(error);}finally{busy='';render();}})();
    });
    $('githubProjectClone').addEventListener('click',()=>{
      if(busy||!inspection||!parent.value)return;requestId=globalThis.crypto.randomUUID();busy='downloading';status('准备下载到所选新目录…');$('githubProjectProgress').removeAttribute('value');render();
      void(async()=>{try{const result=unwrap(await bridge.clone({source:source.value,parent:parent.value,folderName:folder.value,requestId}));await openProject(result.project);}
        catch(error){if(error.code==='canceled')status(error.message);else failure(error);}
        finally{busy='';requestId='';render();}})();
    });
    bridge?.onProgress(event=>{
      if(busy!=='downloading'||event.requestId!==requestId)return;
      status(`${event.phase}${Number.isFinite(event.percent)?` · ${event.percent}%`:''}`);
      if(Number.isFinite(event.percent))$('githubProjectProgress').value=event.percent;else $('githubProjectProgress').removeAttribute('value');
      if(event.percent===100&&event.phase.includes('登记')){$('githubProjectCancel').disabled=true;$('githubProjectClose').disabled=true;}
    });
    $('githubProjectCancel').addEventListener('click',()=>void close());$('githubProjectClose').addEventListener('click',()=>void close());
    dialog.addEventListener('cancel',event=>{event.preventDefault();void close();});
    dialog.addEventListener('close',()=>{if(returnFocus?.isConnected&&returnFocus.getClientRects().length)returnFocus.focus();else ctx.ui.compose.focus();});
    return {dismiss:()=>{if(!dialog.open)return false;void close();return true;}};
  };
  return {create};
});
