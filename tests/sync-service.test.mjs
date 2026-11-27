// 端到端连接两份真实应用知识库与 bare Git 远端；不伪造传输成功。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { GitMemoryTransport } from '../src/memory/sync-git.mjs';
import { MemorySyncService } from '../src/memory/sync-service.mjs';
import { decodeSyncDocument } from '../src/memory/sync-documents.mjs';

const note=(content='初始内容',overrides={})=>({title:'中文同步记忆',content,kind:'note',layer:'project',scope:'project',projectId:'demo',...overrides});
const git=(args,cwd)=>execFileSync('git',['-c',`core.hooksPath=${path.join(cwd,'.no-hooks')}`,'-c','commit.gpgsign=false','-c','push.gpgSign=false',...args],
  {cwd,encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(cwd,'.no-config'),GIT_TERMINAL_PROMPT:'0',
    GIT_AUTHOR_NAME:'Sync Fixture',GIT_AUTHOR_EMAIL:'fixture@localhost',GIT_COMMITTER_NAME:'Sync Fixture',GIT_COMMITTER_EMAIL:'fixture@localhost'}}).trim();
const fixture=()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'owner-real-sync-'));const remote=path.join(root,'remote.git');git(['init','--quiet','--bare',remote],root);
  const make=side=>{
    const store=new PersonalKnowledgeStore(path.join(root,`${side}.sqlite`),{logger:{log(){},warn(){}}});
    const transport=new GitMemoryTransport({root:path.join(root,side),repo:'fixture/private',testRemote:remote,env:{...process.env,GH_TOKEN:'',GITHUB_TOKEN:''}});
    return {store,transport,service:new MemorySyncService({store,transport,stateFile:path.join(root,`${side}-sync.json`)})};
  };
  const f={root,remote,make,a:make('a'),b:make('b')};f.close=()=>{f.a.store.close();f.b.store.close();fs.rmSync(root,{recursive:true,force:true});};return f;
};
const sync=async(side,choices={})=>{const p=await side.service.prepare();const r=await side.service.execute({id:p.id,choices,confirmed:true});assert.equal(r.status,'ok',r.text);return {plan:p,result:r};};
const remoteRecord=async(f,id)=>decodeSyncDocument((await f.b.transport.read()).documents.find(doc=>doc.path.endsWith(`/${id}.md`))).record;
const baseConflict=async(f)=>{
  const row=f.a.store.create(note());await sync(f.a);await sync(f.b);
  f.a.store.update(row.id,note('本机已修改的内容'),{expectedRevision:f.a.store.get(row.id).revision});
  f.b.store.update(row.id,note('另一台机器修改的内容'),{expectedRevision:f.b.store.get(row.id).revision});await sync(f.b);return row;
};

test('实际知识和经验通过 Git 进入另一份应用存储，预览和取消不会写远端',async()=>{
  const f=fixture();try{
    const unit=f.a.store.create(note());const lesson=f.a.store.addLesson({projectId:'demo',sourceRecordId:'record:1',phenomenon:'循环漏掉末次重试',mechanism:'边界少一次',countermeasure:'显式测试次数',scope:{layer:'project',projectId:'demo'},verificationStatus:'inferred'});
    const p=await f.a.service.prepare();assert.equal(p.counts.upload,2);assert.equal((await f.b.transport.read()).head,'');
    await assert.rejects(f.a.service.execute({id:p.id}),{code:'sync-confirmation-required'});
    f.a.service.cancel(p.id);await assert.rejects(f.a.service.execute({id:p.id,confirmed:true}),{code:'sync-plan-expired'});
    await sync(f.a);const received=await sync(f.b);assert.equal(received.plan.counts.download,2);
    assert.equal(f.b.store.get(unit.id).content,unit.content);assert.equal(f.b.store.getLesson(lesson.id).countermeasure,lesson.countermeasure);
    assert.equal(f.a.service.dirtyCount().count,0);assert.equal(f.b.service.dirtyCount().count,0);
    const count=git(['--git-dir',f.remote,'rev-list','--count','main'],f.root);await sync(f.a);await sync(f.b);
    assert.equal(git(['--git-dir',f.remote,'rev-list','--count','main'],f.root),count);
  }finally{f.close();}
});

test('另一台的编辑可以返回原应用，不因为本机修订号或时间不同而循环更新',async()=>{
  const f=fixture();try{
    const row=f.a.store.create(note());await sync(f.a);await sync(f.b);
    f.b.store.update(row.id,note('Beta 的第二版'),{expectedRevision:f.b.store.get(row.id).revision});await sync(f.b);await sync(f.a);
    assert.equal(f.a.store.get(row.id).content,'Beta 的第二版');assert.equal(f.a.store.revisions(row.id).length,2);
    assert.equal((await f.a.service.prepare()).empty,true);assert.equal((await f.b.service.prepare()).empty,true);
  }finally{f.close();}
});

test('双方都改了先逐篇选择，缺少选择不应用文档，也不推送',async()=>{
  const f=fixture();try{
    const row=await baseConflict(f);const p=await f.a.service.prepare();assert.equal(p.counts.conflict,1);
    const detail=f.a.service.detail(p.id,`knowledge:${row.id}`);assert.ok(detail.local.text.includes('本机已修改'));assert.ok(detail.remote.text.includes('另一台机器'));
    const waiting=await f.a.service.execute({id:p.id,confirmed:true});assert.equal(waiting.code,'awaiting-choice');
    assert.equal(f.a.store.get(row.id).content,'本机已修改的内容');assert.equal((await remoteRecord(f,row.id)).payload.content,'另一台机器修改的内容');
    const done=await f.a.service.execute({id:p.id,confirmed:true,choices:{[`knowledge:${row.id}`]:'remote'}});
    assert.equal(done.status,'ok',done.text);assert.equal(f.a.store.get(row.id).content,'另一台机器修改的内容');assert.equal(f.a.store.revisions(row.id).length,3);
  }finally{f.close();}
});

test('明确选择本地版本才覆盖远端，两段都留会标明来源并保留完整正文',async()=>{
  for(const choice of ['local','both']){
    const f=fixture();try{
      const row=await baseConflict(f);const p=await f.a.service.prepare();
      const done=await f.a.service.execute({id:p.id,confirmed:true,choices:{[`knowledge:${row.id}`]:choice}});assert.equal(done.status,'ok',done.text);
      const result=(await remoteRecord(f,row.id)).payload.content;
      assert.ok(result.includes('本机已修改'));
      if(choice==='both'){assert.ok(result.includes('另一台机器'));assert.ok(result.includes('来源：本地'));assert.ok(result.includes('来源：远端'));}
      else assert.equal(result,'本机已修改的内容');
      await sync(f.b);assert.equal(f.b.store.get(row.id).content,result);
    }finally{f.close();}
  }
});

test('跳过只跳该篇，其余真实推送；重启后仍是未解决，不能显示完全成功',async()=>{
  const f=fixture();try{
    const row=await baseConflict(f);const other=f.a.store.create(note('另一篇应照常传输',{title:'另一篇'}));const p=await f.a.service.prepare();
    const result=await f.a.service.execute({id:p.id,confirmed:true,choices:{[`knowledge:${row.id}`]:'skip'}});
    assert.equal(result.status,'conflict');assert.equal(result.code,'unresolved');assert.equal(result.pushed.length,1);
    assert.equal((await remoteRecord(f,other.id)).payload.content,'另一篇应照常传输');assert.equal(f.a.service.dirtyCount().unresolved,1);
    f.a.store.close();f.a=f.make('a');const reopened=await f.a.service.prepare();assert.equal(reopened.counts.conflict,1);assert.equal(reopened.counts.upload,0);
    const done=await f.a.service.execute({id:reopened.id,confirmed:true,choices:{[`knowledge:${row.id}`]:'remote'}});assert.equal(done.status,'ok');assert.equal(f.a.service.dirtyCount().unresolved,0);
  }finally{f.close();}
});

test('本机在预览后编辑或新增条目，旧计划不会应用远端或覆盖新输入',async()=>{
  const f=fixture();try{
    const row=f.a.store.create(note());await sync(f.a);await sync(f.b);
    f.b.store.update(row.id,note('远端更新'),{expectedRevision:f.b.store.get(row.id).revision});await sync(f.b);
    const p=await f.a.service.prepare();f.a.store.update(row.id,note('预览后的本机新编辑'),{expectedRevision:f.a.store.get(row.id).revision});
    await assert.rejects(f.a.service.execute({id:p.id,confirmed:true}),{code:'local-changed'});assert.equal(f.a.store.get(row.id).content,'预览后的本机新编辑');
  }finally{f.close();}
});

test('远端在预览后变化，已选的覆盖操作失效，必须重新检查',async()=>{
  const f=fixture();try{
    const row=await baseConflict(f);const p=await f.a.service.prepare();f.b.store.create(note('远端又新增一篇'));await sync(f.b);
    await assert.rejects(f.a.service.execute({id:p.id,confirmed:true,choices:{[`knowledge:${row.id}`]:'local'}}),{code:'remote-changed'});
    assert.equal((await remoteRecord(f,row.id)).payload.content,'另一台机器修改的内容');
  }finally{f.close();}
});

test('推送失败保留已合并的本机内容和已确认基线，重试不会重复合并或重复追问',async()=>{
  const f=fixture();try{
    const row=await baseConflict(f);const p=await f.a.service.prepare();const publish=f.a.transport.publish.bind(f.a.transport);
    f.a.transport.publish=async()=>{const e=new Error('隔离验收：暂时离线');e.code='offline';throw e;};
    const failed=await f.a.service.execute({id:p.id,confirmed:true,choices:{[`knowledge:${row.id}`]:'both'}});assert.equal(failed.status,'error');assert.equal(failed.code,'offline');
    const merged=f.a.store.get(row.id);assert.ok(merged.content.includes('本机已修改'));assert.ok(merged.content.includes('另一台机器'));
    f.a.transport.publish=publish;const retry=await f.a.service.prepare();assert.equal(retry.counts.conflict,0);assert.equal(retry.counts.upload,1);
    const done=await f.a.service.execute({id:retry.id,confirmed:true});assert.equal(done.status,'ok',done.text);assert.equal(f.a.store.get(row.id).revision,merged.revision);
  }finally{f.close();}
});

test('远端删除变成本机可恢复归档，不真删、也不在下一次检查时悄悄复活远端',async()=>{
  const f=fixture();try{
    const row=f.a.store.create(note());await sync(f.a);
    const checkout=path.join(f.root,'human');git(['clone','--quiet','--branch','main',f.remote,checkout],f.root);
    git(['rm','--quiet',`owner-memory/v1/knowledge/${row.id}.md`],checkout);git(['commit','--quiet','-m','Archive remote document'],checkout);git(['push','--quiet',f.remote,'HEAD:main'],checkout);
    const p=await f.a.service.prepare();assert.equal(p.counts.archive,1);assert.equal(p.counts.upload,0);
    const result=await f.a.service.execute({id:p.id,confirmed:true});assert.equal(result.status,'ok',result.text);assert.equal(result.archived.length,1);
    assert.ok(f.a.store.get(row.id).syncArchivedAt);assert.equal(f.a.store.get(row.id).content,row.content);assert.equal(f.a.store.list().length,0);assert.equal(f.a.service.archives().length,1);
    const again=await f.a.service.prepare();assert.equal(again.empty,true);await f.a.service.execute({id:again.id,confirmed:true});assert.equal((await f.b.transport.read()).documents.length,0);
    f.a.service.restoreArchived({documentId:`knowledge:${row.id}`,confirmed:true});assert.equal(f.a.store.list().length,1);assert.equal(f.a.service.archives().length,0);
    const restored=await f.a.service.prepare();assert.equal(restored.counts.upload,1);
  }finally{f.close();}
});

test('检查可取消、同一服务不能并行执行；取消之后可以重新检查',async()=>{
  const f=fixture();try{
    f.a.store.create(note());const read=f.a.transport.read.bind(f.a.transport);let began;const started=new Promise(r=>{began=r;});
    f.a.transport.read=({signal})=>new Promise((resolve,reject)=>{began();signal.addEventListener('abort',()=>reject(new DOMException('已取消','AbortError')),{once:true});});
    const pending=f.a.service.prepare();await started;await assert.rejects(f.a.service.prepare(),{code:'sync-busy'});
    f.a.service.cancel();await assert.rejects(pending,{name:'AbortError'});assert.equal(f.a.store.list().length,1);
    f.a.transport.read=read;assert.equal((await f.a.service.prepare()).counts.upload,1);
  }finally{f.close();}
});

test('损坏的基线不会被当成新设备并自动重建，避免复活已归档条目',async()=>{
  const f=fixture();try{
    f.a.store.create(note());fs.writeFileSync(f.a.service.stateFile,'{坏记录');
    await assert.rejects(f.a.service.prepare(),{code:'sync-state-invalid'});assert.equal((await f.b.transport.read()).head,'');
  }finally{f.close();}
});

test('真实桌面控制器只按当前目标报告成功，新增本机记忆会退出已同步',async()=>{
  const {MemorySyncController}=await import('../src/memory/sync-controller.mjs');const f=fixture();try{
    const make=repo=>new MemorySyncController({store:f.a.store,root:path.join(f.root,'controller'),repo,env:{...process.env,GH_TOKEN:'',GITHUB_TOKEN:''},testRemote:f.remote});
    const controller=make('fixture/private');assert.equal(controller.status().state,'unknown');
    f.a.store.create(note());const p=await controller.prepare();assert.equal((await controller.execute({id:p.id,confirmed:true})).status,'ok');
    assert.equal(controller.status().state,'synced');assert.equal(controller.status().count,0);
    { const second=f.b.store; const remote=new MemorySyncController({store:second,root:path.join(f.root,'other-controller'),repo:'fixture/private',env:{...process.env,GH_TOKEN:'',GITHUB_TOKEN:''},testRemote:f.remote});
      const q=await remote.prepare();await remote.execute({id:q.id,confirmed:true});
      second.update(f.a.store.list()[0].id,note('远端单独编辑'),{expectedRevision:second.list()[0].revision});const next=await remote.prepare();await remote.execute({id:next.id,confirmed:true});
      const incoming=await controller.prepare();assert.equal(incoming.counts.download,1);assert.equal(controller.status().state,'unsynced');controller.cancel({id:incoming.id});assert.equal(controller.status().state,'unsynced');
    }
    f.a.store.create(note('后来的修改'));assert.equal(controller.status().count,1);
    const other=make('fixture/another');assert.equal(other.status().state,'unknown');assert.equal(other.status().count,2);
    const offline=new MemorySyncController({store:f.a.store,root:path.join(f.root,'no-credential'),repo:'fixture/private',env:{...process.env,GH_TOKEN:'',GITHUB_TOKEN:''}});
    assert.equal(offline.status().availability.available,false);assert.equal(offline.status().availability.reason,'auth-missing');
  }finally{f.close();}
});

test('经验两段都留保留远端范围和证据元数据的来源，不默默丢弃差异',async()=>{
  const f=fixture();try{
    const row=f.a.store.addLesson({projectId:'demo',sourceRecordId:'fixture:1',phenomenon:'同一现象',mechanism:'本机机制',countermeasure:'本机对策',scope:{layer:'project',projectId:'demo'},verificationStatus:'inferred'});
    await sync(f.a);await sync(f.b);
    const left=f.a.service.snapshot().get(`lesson:${row.id}`);const right=structuredClone(left);
    right.record.payload.mechanism='远端机制';right.record.payload.countermeasure='远端对策';right.record.payload.scope={layer:'project',projectId:'other'};right.record.payload.sourceRecordId='remote:1';
    const merged=f.a.service.merge(left,right,'2026-11-27T12:00:00Z');
    assert.ok(merged.record.payload.mechanism.includes('远端机制'));assert.ok(merged.record.payload.mechanism.includes('remote:1'));assert.ok(merged.record.payload.mechanism.includes('other'));assert.equal(merged.record.payload.scope.projectId,'demo');
    assert.equal(merged.record.payload.verificationStatus,'disputed');
  }finally{f.close();}
});
