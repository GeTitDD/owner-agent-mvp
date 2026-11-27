// GitHub 添加只负责来源核对、显式下载和本机登记；不更改已有远端，不运行项目脚本。
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parseGitHubRemote } from './github.mjs';
import { samePath, rootIdentityOf, verifyProjectRoot } from './project-identity.mjs';

export class GitHubProjectError extends Error {
  constructor(message, code = 'github-project-error') { super(message); this.code = code; }
}
const fail = (message, code) => { throw new GitHubProjectError(message, code); };

/** 添加入口只接受仓库本身；旧的展示解析器允许深层链接，不能直接当下载目标使用。 */
export function normalizeProjectRepository(input) {
  const value = String(input ?? '').trim();
  if (!value || value.length > 500 || /[\s\x00-\x1f\x7f?#]/u.test(value)) fail('请输入 GitHub 仓库链接或 用户名/仓库名，不要包含分支路径、查询参数或凭据。','invalid-repository');
  let pair = value; let ssh = false;
  if (value.includes('://')) {
    let url; try { url = new URL(value); } catch { fail('仓库链接格式不正确，请重新粘贴。','invalid-repository'); }
    if (url.hostname.toLowerCase() !== 'github.com' || url.port || url.password
      || !['https:','ssh:'].includes(url.protocol) || (url.protocol === 'https:' && url.username)
      || (url.protocol === 'ssh:' && url.username !== 'git')) fail('这里只接受不含凭据的 github.com 仓库链接。','invalid-repository');
    pair = url.pathname.replace(/^\//u,''); ssh = url.protocol === 'ssh:';
  } else if (value.startsWith('git@github.com:')) { pair = value.slice(15); ssh = true; }
  pair = pair.replace(/\/$/u,'').replace(/\.git$/iu,'');
  const match = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/u.exec(pair);
  if (!match || ['.','..'].includes(match[2])) fail('请填写仓库主页链接，例如 https://github.com/用户名/仓库名。','invalid-repository');
  const nameWithOwner = `${match[1]}/${match[2]}`;
  return { owner:match[1], repo:match[2], nameWithOwner, key:nameWithOwner.toLowerCase(),
    url:`https://github.com/${nameWithOwner}`, cloneUrl:ssh ? `git@github.com:${nameWithOwner}.git` : `https://github.com/${nameWithOwner}.git` };
}

export function projectFolderName(value) {
  const name = String(value ?? '').trim();
  if(name.length>100||Buffer.byteLength(name,'utf8')>240)fail('新文件夹名称过长，请缩短后重试。','invalid-folder');
  if (!name || /[<>:"/\\|?*\x00-\x1f\x7f]/u.test(name) || /[. ]$/u.test(name)
    || ['.','..','.git'].includes(name.toLowerCase()) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) {
    fail('文件夹名称不可为空，不能包含路径分隔符或系统保留名称。','invalid-folder');
  }
  return name;
}

export function githubProjectFailure(error) {
  if (error instanceof GitHubProjectError) return {ok:false,code:error.code,message:error.message};
  if (['EACCES','EPERM','EROFS'].includes(error?.code)) return {ok:false,code:'directory-permission',message:'无法写入所选位置，请选择有写入权限的文件夹。'};
  if (error?.code === 'ENOSPC') return {ok:false,code:'disk-full',message:'磁盘空间不足，请释放空间或换一个下载位置后重试。'};
  return {ok:false,code:'github-project-error',message:'这次没有完成项目添加。链接和位置已保留，请检查目录与网络后重试。'};
}

/** 参数始终独立传递；进度只发阶段和百分比，不把远端任意文本或凭据显示在界面。 */
export function runProjectGit({args,cwd,signal,onProgress,timeoutMs=10000}) {
  return new Promise((resolve,reject) => {
    if (signal?.aborted) { reject(new GitHubProjectError('已取消下载，没有添加项目。','canceled')); return; }
    const child = spawn('git',args,{cwd,windowsHide:true,detached:process.platform!=='win32',
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never',GH_PROMPT_DISABLED:'1',GH_NO_UPDATE_NOTIFIER:'1',
        GIT_SSH_COMMAND:'ssh -oBatchMode=yes -oStrictHostKeyChecking=yes'},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',timedOut=false,killTimer;
    const stop = () => {
      if (!child.pid || child.exitCode !== null) return;
      if (process.platform === 'win32') { const killer=spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('error',()=>{try{child.kill();}catch{}}); }
      else { try {process.kill(-child.pid,'SIGTERM');} catch {try{child.kill();}catch{}} }
      killTimer=setTimeout(()=>{try{if(process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}},2000);killTimer.unref();
    };
    const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);timer.unref();
    const abort=()=>stop();signal?.addEventListener('abort',abort,{once:true});
    const cleanup=()=>{clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);};
    child.stdout.on('data',chunk=>{stdout=(stdout+chunk).slice(-131072);});
    child.stderr.on('data',chunk=>{
      stderr=(stderr+chunk).slice(-16384);
      const text=String(chunk);const percent=/(\d{1,3})%/u.exec(text)?.[1];
      const phase=/Receiving objects/iu.test(text)?'正在下载对象':/Resolving deltas/iu.test(text)?'正在整理文件':/Updating files/iu.test(text)?'正在写入文件':null;
      if(phase){try{onProgress?.({phase,percent:percent?Math.min(100,Number(percent)):null});}catch{}}
    });
    child.on('error',error=>{cleanup();reject(new GitHubProjectError(error.code==='ENOENT'?'未找到 Git，请安装 Git 后重试。':'无法启动 Git，请检查本机 Git 是否可用。','git-unavailable'));});
    child.on('close',code=>{
      cleanup();
      if(signal?.aborted)return reject(new GitHubProjectError('已取消下载，没有添加项目。','canceled'));
      if(timedOut)return reject(new GitHubProjectError('下载超时，链接和位置已保留，请检查网络后重试。','download-timeout'));
      if(code===0)return resolve(stdout.trim());
      reject(new GitHubProjectError(/auth|denied|not found|could not read Username|publickey/iu.test(stderr)
        ?'无法访问这个仓库。请核对地址、仓库权限和本机 Git/GitHub 登录后重试。'
        :'Git 操作未完成，请检查仓库地址、网络或本机 Git 后重试。','git-failed'));
    });
  });
}

const exists = async target => { try {return await fs.lstat(target);} catch(error) {if(error.code==='ENOENT')return null;throw error;} };
const inside = (root,target) => {const relative=path.relative(root,target);return !relative || (!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative));};

/** 登记本身不产生项目文件；来源与目录检查完成后才调用原有项目存储。 */
export function registerImportedProject(store,root,name=path.basename(root)) {
  const existing=store.getProjectByRoot(root);if(existing)return existing;
  const base=name.toLowerCase().replace(/[^a-z0-9._-]+/gu,'-').replace(/^-+|-+$/gu,'').slice(0,40)||'project';
  const id=store.getProject(base)?`${base.slice(0,30)}-${randomUUID().slice(0,8)}`:base;
  return store.registerProject({id,name:name.slice(0,160),root,primaryDomain:'software-engineering'});
}

export class GitHubProjectService {
  constructor({store,run=runProjectGit}={}) {this.store=store;this.run=run;this.active=null;}
  async remote(root,{signal}={}) {
    try {return parseGitHubRemote(await this.run({args:['-C',root,'config','--get','remote.origin.url'],signal,timeoutMs:3000}));} catch(error) {if(signal?.aborted)fail('已取消下载，没有添加项目。','canceled');return null;}
  }
  async inspect(source,{signal}={}) {
    const repository=normalizeProjectRepository(source);const projects=this.store.listProjects();const existingProjects=[];
    for(const project of projects){if(signal?.aborted)fail('已取消下载，没有添加项目。','canceled');if(!verifyProjectRoot(project).ok)continue;const remote=await this.remote(project.root,{signal});if(remote?.nameWithOwner.toLowerCase()===repository.key)existingProjects.push({id:project.id,name:project.name,root:project.root});}
    return {repository,existingProjects};
  }
  async link({source,root}) {
    const repository=normalizeProjectRepository(source);let local;
    try {local=await fs.realpath(root);}catch{fail('所选目录不存在，请重新选择已下载的仓库。','local-missing');}
    const top=await this.run({args:['-C',local,'rev-parse','--show-toplevel']}).catch(()=>fail('所选目录不是可读取的 Git 仓库。','local-not-git'));
    if(!samePath(await fs.realpath(top),local))fail('请选择 Git 仓库的根目录。','local-not-root');
    const remote=await this.remote(local);
    if(remote?.nameWithOwner.toLowerCase()!==repository.key)fail('这个目录的 origin 与所填 GitHub 仓库不一致，未改动远端或添加项目。','repository-mismatch');
    const prior=this.store.getProjectByRoot(local);if(prior)return prior;
    if((await this.inspect(source)).existingProjects.length)fail('这个 GitHub 仓库已经添加过，请打开上方的已有项目。','repository-exists');
    return registerImportedProject(this.store,local);
  }
  cancel(requestId) {
    if(!this.active||this.active.requestId!==requestId)return {canceled:false};
    if(this.active.phase==='finishing')return {canceled:false,finishing:true};
    this.active.controller.abort();return {canceled:true};
  }
  async clone({source,parent,folderName,requestId,onProgress=()=>{}}) {
    if(this.active)fail('已有一个项目正在下载，请等待完成或先取消。','import-busy');
    const repository=normalizeProjectRepository(source);const name=projectFolderName(folderName||repository.repo);
    if(typeof requestId!=='string'||!requestId||requestId.length>120)fail('下载请求已失效，请重新打开添加表单。','invalid-request');
    const active={requestId,controller:new AbortController(),phase:'preparing'};this.active=active;
    let settle;active.done=new Promise(resolve=>{settle=resolve;});
    let staging='',stagingIdentity='',destination='',reservationIdentity='',published=false;const moved=[];
    try {
      const found=await this.inspect(source,{signal:active.controller.signal});
      if(found.existingProjects.length)fail('这个 GitHub 仓库已经添加过，请检查链接后打开已有项目。','repository-exists');
      let realParent;try{realParent=await fs.realpath(parent);if(!(await fs.stat(realParent)).isDirectory())throw Error();}catch{fail('请先选择用于保存项目的本机文件夹。','invalid-parent');}
      destination=path.join(realParent,name);
      if(destination.length>1500)fail('保存路径过长，请选择较短的位置或文件夹名称。','invalid-parent');
      if(this.store.listProjects().some(p=>inside(p.root,destination)))fail('请在已登记项目之外选择下载位置，避免改动现有项目。','inside-project');
      if(await exists(destination))fail('目标文件夹已经存在，未覆盖。可关联已有目录，或换一个文件夹名称。','destination-exists');
      if(active.controller.signal.aborted)fail('已取消下载，没有添加项目。','canceled');
      staging=await fs.mkdtemp(path.join(realParent,'.owner-project-'));stagingIdentity=rootIdentityOf(staging);
      const checkout=path.join(staging,'checkout');const hooks=path.join(staging,'disabled-hooks');await fs.mkdir(hooks);
      active.phase='downloading';onProgress({phase:'正在连接 GitHub',percent:null});
      await this.run({args:['-c',`core.hooksPath=${hooks}`,'-c','submodule.recurse=false','-c','credential.helper=!gh auth git-credential',
        'clone','--progress','--no-recurse-submodules','--',repository.cloneUrl,checkout],signal:active.controller.signal,onProgress,timeoutMs:600000});
      if(active.controller.signal.aborted)fail('已取消下载，没有添加项目。','canceled');
      const remote=await this.remote(checkout,{signal:active.controller.signal});
      if(remote?.nameWithOwner.toLowerCase()!==repository.key)fail('下载后的仓库来源不一致，没有登记项目。','repository-mismatch');
      if((await this.inspect(source,{signal:active.controller.signal})).existingProjects.length)fail('下载期间这个仓库已被添加，请检查链接后打开已有项目。','repository-exists');
      if(active.controller.signal.aborted)fail('已取消下载，没有添加项目。','canceled');
      active.phase='finishing';onProgress({phase:'下载完成，正在登记项目',percent:100});
      // 原子预留新目录，绝不将 rename 覆盖到用户已经创建的同名目录上。
      try{await fs.mkdir(destination);}catch(error){if(error.code==='EEXIST')fail('目标文件夹刚刚被创建，未覆盖。请换一个名称重试。','destination-exists');throw error;}
      reservationIdentity=rootIdentityOf(destination);
      for(const entry of await fs.readdir(checkout)){
        if(rootIdentityOf(destination)!==reservationIdentity||await exists(path.join(destination,entry)))fail('下载位置在操作期间发生变化，已停止登记并保留现有文件。','destination-changed');
        await fs.rename(path.join(checkout,entry),path.join(destination,entry));moved.push(entry);
      }
      // 移动 .git 后取消临时禁用钩子的命令级设置不会遗留到项目配置。
      const project=registerImportedProject(this.store,destination,name);published=true;return project;
    } finally {
      // 只移除本次创建且身份未变的目录；若用户新增了其他内容则保留，避免清理越界。
      if(!published&&reservationIdentity&&rootIdentityOf(destination)===reservationIdentity){
        const current=await fs.readdir(destination).catch(()=>[]);
        if(current.every(entry=>moved.includes(entry)))await fs.rm(destination,{recursive:true,force:true}).catch(()=>{});
      }
      if(staging&&rootIdentityOf(staging)===stagingIdentity)await fs.rm(staging,{recursive:true,force:true}).catch(()=>{});
      if(this.active===active)this.active=null;
      settle();
    }
  }
}
