// 真实本机 Git 覆盖登记边界，不联网、不读取凭据、不运行项目安装脚本。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OwnerStore } from '../src/owner-store.mjs';
import { GitHubProjectService,normalizeProjectRepository,projectFolderName,runProjectGit,githubProjectFailure } from '../src/github-project.mjs';
import { verifyProjectRoot } from '../src/project-identity.mjs';
import { createGitHubProjectFixture,FIXTURE_GITHUB_SOURCE as source } from '../scripts/e2e/lib/github-project-fixture.mjs';

const setup=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'owner-github-project-'));const fixture=createGitHubProjectFixture(root);
 const store=new OwnerStore(path.join(root,'owner.sqlite'));const parent=path.join(root,'downloads');fs.mkdirSync(parent);
 const service=new GitHubProjectService({store,run:fixture.run});t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});return {root,fixture,store,parent,service};};

test('GitHub 添加只接受完整仓库身份，HTTPS/SSH/短名统一去重',()=>{
 for(const value of ['fixture-owner/owner-demo',source,'https://github.com/fixture-owner/owner-demo/','git@github.com:fixture-owner/owner-demo.git','ssh://git@github.com/fixture-owner/owner-demo.git']){
  assert.equal(normalizeProjectRepository(value).key,'fixture-owner/owner-demo');
 }
 for(const value of ['', 'https://evil.example/o/r','file:///tmp/repo','https://token@github.com/o/r','https://github.com/o/r?token=secret','https://github.com/o/r#readme','https://github.com/o/r/tree/main','https://github.com/o/../r','--upload-pack=bad','o/..','o/.git','https://github.com:443/o/r/issues/1'])assert.throws(()=>normalizeProjectRepository(value),value);
});

test('下载文件夹名称拒绝越界与 Windows 保留名称',()=>{
 assert.equal(projectFolderName('中文项目'),'中文项目');
 for(const name of ['../other','..','.','x/y','x\\y','CON','aux.txt','LPT1','name.','a:b'])assert.throws(()=>projectFolderName(name),name);
 assert.throws(()=>projectFolderName('长'.repeat(90)),/过长/);
});

test('链接已下载目录只登记且来源必须匹配，重复添加复用原项目',async t=>{
 const {fixture,store,service}=setup(t);const before=fixture.git(['-C',fixture.seed,'status','--porcelain']);
 const project=await service.link({source,root:fixture.seed});const repeated=await service.link({source,root:fixture.seed});
 assert.equal(repeated.id,project.id);assert.equal(store.listProjects().length,1);assert.ok(verifyProjectRoot(project).ok);
 assert.equal(fixture.git(['-C',fixture.seed,'status','--porcelain']),before);
 assert.equal(fixture.git(['-C',fixture.seed,'remote','get-url','origin']),source);
 assert.equal((await service.inspect('FIXTURE-OWNER/OWNER-DEMO')).existingProjects[0].id,project.id);
 await assert.rejects(service.link({source:'https://github.com/other/project',root:fixture.seed}),e=>e.code==='repository-mismatch');
 assert.equal(store.listProjects().length,1);
});

test('真实 Git 下载成功后才登记，项目可继续读取且不执行安装脚本',async t=>{
 const {fixture,store,service,parent}=setup(t);const phases=[];
 const project=await service.clone({source,parent,folderName:'中文长名称项目',requestId:'clone-ok',onProgress:p=>phases.push(p.phase)});
 assert.equal(project.root,fs.realpathSync(path.join(parent,'中文长名称项目')));assert.ok(verifyProjectRoot(project).ok);
 assert.equal(fixture.git(['-C',project.root,'status','--porcelain']),'');assert.equal(fixture.git(['-C',project.root,'remote','get-url','origin']),source);
 assert.ok(fs.existsSync(path.join(project.root,'README.md')));assert.ok(!fs.existsSync(path.join(project.root,'must-not-run')));
 assert.equal(store.listProjects().length,1);assert.equal(service.active,null);assert.ok(phases.includes('下载完成，正在登记项目'));
 assert.deepEqual(fs.readdirSync(parent),['中文长名称项目']);
 await assert.rejects(service.clone({source,parent,requestId:'duplicate'}),e=>e.code==='repository-exists');
 assert.equal(fixture.calls.filter(args=>args.includes('clone')).length,1);
});

test('已存在目录、符号链接与受观察项目内部均不能成为下载落点',async t=>{
 const {parent,root,service,store,fixture}=setup(t);fs.mkdirSync(path.join(parent,'exists'));fs.writeFileSync(path.join(parent,'exists','keep'),'original');
 await assert.rejects(service.clone({source,parent,folderName:'exists',requestId:'exists'}),e=>e.code==='destination-exists');
 assert.equal(fs.readFileSync(path.join(parent,'exists','keep'),'utf8'),'original');
 fs.symlinkSync(fixture.seed,path.join(parent,'linked'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(service.clone({source,parent,folderName:'linked',requestId:'symlink'}),e=>e.code==='destination-exists');
 const watched=path.join(root,'watched');fs.mkdirSync(watched);store.registerProject({id:'watched',name:'原有项目',root:watched});
 await assert.rejects(service.clone({source,parent:watched,requestId:'nested'}),e=>e.code==='inside-project');
 assert.deepEqual(fs.readdirSync(watched),[]);
});

test('取消与权限失败不生成空项目，清理本次临时下载后可以重试',async t=>{
 const {parent,service,fixture,store}=setup(t);fixture.setMode('slow');let started;const ready=new Promise(resolve=>{started=resolve;});
 const pending=service.clone({source,parent,requestId:'cancel',onProgress:()=>started()});await ready;
 assert.equal(service.cancel('other').canceled,false);assert.equal(service.cancel('cancel').canceled,true);
 await assert.rejects(pending,e=>e.code==='canceled');assert.equal(store.listProjects().length,0);assert.deepEqual(fs.readdirSync(parent),[]);
 fixture.setMode('failed');await assert.rejects(service.clone({source,parent,requestId:'fail'}),e=>e.code==='git-failed');
 assert.equal(store.listProjects().length,0);assert.deepEqual(fs.readdirSync(parent),[]);
 fixture.setMode('ok');assert.ok((await service.clone({source,parent,requestId:'retry'})).id);
});

test('下载完成时出现同名目录不能被覆盖，来源异常也不会登记',async t=>{
 const {parent,store,fixture}=setup(t);const target=path.join(parent,'race');
 const service=new GitHubProjectService({store,run:async input=>{const result=await fixture.run(input);if(input.args.includes('clone'))fs.mkdirSync(target);return result;}});
 await assert.rejects(service.clone({source,parent,folderName:'race',requestId:'race'}),e=>e.code==='destination-exists');
 assert.ok(fs.statSync(target).isDirectory());assert.deepEqual(fs.readdirSync(target),[]);assert.equal(store.listProjects().length,0);
 fixture.setMode('wrong-remote');const mismatch=new GitHubProjectService({store,run:fixture.run});
 await assert.rejects(mismatch.clone({source,parent,requestId:'mismatch'}),e=>e.code==='repository-mismatch');assert.equal(store.listProjects().length,0);
 assert.deepEqual(fs.readdirSync(parent),['race']);
});

test('真实 Git 子进程可被取消，且公开错误不回传任意异常或凭据',async()=>{
 const controller=new AbortController();const promise=runProjectGit({args:['-c','alias.owner-wait=!node -e "setInterval(()=>{},1000)"','owner-wait'],signal:controller.signal,timeoutMs:5000});
 const timer=setTimeout(()=>controller.abort(),100);
 try{await assert.rejects(promise,e=>e.code==='canceled');}finally{clearTimeout(timer);}
 const result=githubProjectFailure(new Error('secret-token=must-not-leak'));assert.ok(!result.message.includes('must-not-leak'));
});
