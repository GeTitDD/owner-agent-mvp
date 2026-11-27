// 领域模型核对的反例：证据独立性、历史误标，以及对话引用与任务收益的隔离。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { recordCompletedChatReferences } from '../src/knowledge/chat-references.mjs';
import { createWorkbenchServer } from '../src/workbench-server.mjs';
import { canonical, sha256 } from '../src/utils.mjs';
const { sameDraftContent } = createRequire(import.meta.url)('../desktop/shell-compose.cjs');

test('关联资料元数据不阻止清空已发送草稿，但不能清空后来输入或其他会话的草稿', () => {
  const current={id:'chat',projectId:'a',text:'完整问题',skillId:''};
  const sent={...current,linkedProjects:[{id:'b'}],sourceSeq:5};
  assert.equal(sameDraftContent(current,sent),true);
  for (const changed of [{text:'后来的输入'},{projectId:'b'},{id:'another'},{skillId:'new'}]) {
    assert.equal(sameDraftContent({...current,...changed},sent),false);
  }
});

const lesson = (db, projectId, { recordId = `sandbox:${projectId}`, kind = 'record', countermeasure = '串行短写入' } = {}) =>
  db.recordLessonOrDispute({ projectId, sourceRecordId:recordId, phenomenon:'状态被旧快照覆盖',
    mechanism:'并行读改写', countermeasure, scope:{layer:'project',projectId,domainIds:[]},
    verificationStatus:kind === 'idea' ? 'inferred' : 'unverified', evidenceRefs:[recordId] },
  {evidence:[{recordId,ref:recordId,kind,excerpt:'可追溯来源'}]});
const withStore = fn => { const db = new PersonalKnowledgeStore(':memory:'); try { return fn(db); } finally { db.close(); } };

test('同一执行记录跨项目复制不算独立复现，新增真实独立来源后才恢复', () => withStore(db => {
  const a=lesson(db,'a',{recordId:'sandbox:copied'}), b=lesson(db,'b',{recordId:'sandbox:copied'});
  assert.equal(db.getLesson(a.id).reproduced,false); assert.equal(db.getLesson(b.id).supportProjects,0);
  lesson(db,'a',{recordId:'sandbox:independent-a'}); lesson(db,'b',{recordId:'sandbox:independent-b'});
  assert.equal(db.getLesson(a.id).reproduced,true); assert.equal(db.getLesson(b.id).supportProjects,2);
}));

test('同项目重复的灵感来源只累加出处，不把推断提升为待验证', () => withStore(db => {
  const first=lesson(db,'a',{recordId:'idea:first',kind:'idea'});
  const second=lesson(db,'a',{recordId:'idea:second',kind:'idea'});
  assert.equal(first.id,second.id); assert.equal(second.verificationStatus,'inferred');
  assert.equal(db.getLesson(first.id).supportProjects,0); assert.equal(db.lessonEvidence(first.id).length,2);
}));

test('复现只支持现象；不同对策、归档、取代和升域不提高验证状态', () => withStore(db => {
  const a=lesson(db,'a'), b=lesson(db,'b',{countermeasure:'跨进程 CAS'});
  assert.equal(db.getLesson(a.id).reproduced,true);
  assert.equal(db.getLesson(a.id).verificationStatus,'unverified');
  db.archiveSyncRecord({kind:'lesson',id:b.id,expectedStateHash:sha256(canonical(db.getLesson(b.id)))});
  assert.equal(db.getLesson(a.id).reproduced,false);
  assert.equal(db.getLesson(a.id).supportProjects,1);
  const domain=db.promoteLessonToDomain(a.id,{domainIds:['software-engineering']});
  assert.equal(domain.reproduced,false); assert.equal(domain.verificationStatus,'unverified');
  const c=lesson(db,'c'); assert.equal(db.getLesson(a.id).reproduced,true);
  db.db.prepare("UPDATE knowledge_lessons SET verification_status='superseded' WHERE id=?").run(c.id);
  assert.equal(db.getLesson(a.id).reproduced,false);
}));

test('历史与同步中的灵感误标读取即纠正，原始内容不被后台改写，重启后相同', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'owner-evidence-repair-'));
  const file=path.join(root,'knowledge.sqlite'); let db=new PersonalKnowledgeStore(file);
  try {
    const a=lesson(db,'a',{recordId:'idea:a',kind:'idea'}); lesson(db,'b',{recordId:'idea:b',kind:'idea'});
    const raw=JSON.parse(db.db.prepare('SELECT payload FROM knowledge_lessons WHERE id=?').get(a.id).payload);
    const stale=canonical({...raw,reproduced:true,reproducedAt:'2026-11-01T00:00:00Z',supportProjects:2});
    db.db.prepare('UPDATE knowledge_lessons SET payload=?,payload_hash=? WHERE id=?').run(stale,sha256(stale),a.id);
    assert.equal(db.getLesson(a.id).reproduced,false); assert.equal(db.getLesson(a.id).reproducedAt,undefined);
    assert.equal(db.lessonSources(a.id).reproduced,false);
    assert.equal(db.db.prepare('SELECT payload FROM knowledge_lessons WHERE id=?').get(a.id).payload,stale);
    db.close(); db=new PersonalKnowledgeStore(file);
    assert.equal(db.getLesson(a.id).reproduced,false);
    const incoming={...db.getLesson(a.id),id:'imported-idea',reproduced:true,supportProjects:99};
    assert.equal(db.importSyncRecord({kind:'lesson',id:incoming.id,payload:incoming,expectedStateHash:null}).reproduced,false);
  } finally {db.close();fs.rmSync(root,{recursive:true,force:true});}
});

const memory={text:'[knowledge:k@1] 同进程短写入；跨进程仍需独立互斥。',items:[{kind:'knowledge',id:'k',revision:1}],omitted:[{id:'omitted'}]};
const success={ok:true,status:'ok',answer:'未采纳资料的普通回答'};
test('已完成对话引用按轮次和修订持久化去重，不创建 Usage 或收益', () => withStore(personalStore => {
  const input={personalStore,memory,result:success,turnId:'t1',sessionId:'s1',projectId:'b'};
  assert.deepEqual(recordCompletedChatReferences(input),{status:'recorded',count:1});
  recordCompletedChatReferences(input);
  let refs=personalStore.listChatReferences({knowledgeId:'k'}); assert.equal(refs.length,1);
  assert.equal(refs[0].projectId,'b'); assert.equal(refs[0].revision,1);
  recordCompletedChatReferences({...input,turnId:'t2',memory:{...memory,items:[{kind:'knowledge',id:'k',revision:2}]}});
  refs=personalStore.listChatReferences({knowledgeId:'k'}); assert.equal(refs.length,2);
  assert.equal(personalStore.listChatReferences({knowledgeId:'omitted'}).length,0);
  assert.deepEqual(personalStore.listUsages({knowledgeId:'k'}),[]);
  assert.deepEqual(personalStore.listFeedback(),[]);
  const changed=recordCompletedChatReferences({...input,memory:{...memory,text:'其他上下文'}});
  assert.equal(changed.status,'failed'); assert.equal(personalStore.listChatReferences().length,2);
}));

test('未注入、失败、取消与计量故障不伪造成功引用，也不丢原回答', () => withStore(personalStore => {
  const input={personalStore,memory,result:success,turnId:'t',sessionId:'s'};
  for (const result of [{ok:false,status:'error'},{ok:false,status:'aborted'},{ok:false,status:'no-model'}]) {
    assert.equal(recordCompletedChatReferences({...input,result}).status,'not-recorded');
  }
  assert.equal(recordCompletedChatReferences({...input,memory:{text:'',items:[],omitted:[{id:'k'}]}}).status,'empty');
  assert.equal(personalStore.listChatReferences().length,0);
  const result={...success};
  assert.equal(recordCompletedChatReferences({...input,result,personalStore:{recordChatReferences(){throw Error('disk full');}}}).status,'failed');
  assert.equal(result.answer,success.answer);
}));

test('完成对话引用关闭后仍可读取，并允许全局会话只读关联', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'owner-chat-reference-')); const file=path.join(root,'knowledge.sqlite');
  let db=new PersonalKnowledgeStore(file);
  try {
    recordCompletedChatReferences({personalStore:db,memory,result:success,turnId:'global-turn',sessionId:'global-session'});
    db.close(); db=new PersonalKnowledgeStore(file);
    assert.equal(db.listChatReferences({knowledgeId:'k'})[0].projectId,'');
    assert.equal(db.listChatReferences({knowledgeId:'k'})[0].revision,1);
  } finally {db.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('工作台 HTTP 分别返回完成对话引用与任务 Usage，不将引用当作收益', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'owner-reference-api-')); const file=path.join(root,'knowledge.sqlite');
  const db=new PersonalKnowledgeStore(file); let server;
  try {
    recordCompletedChatReferences({personalStore:db,memory,result:success,turnId:'api-turn',sessionId:'api-session',projectId:'b'});
    server=await createWorkbenchServer({port:0,personalDbPath:file,ownerDbPath:path.join(root,'owner.sqlite')});
    const {port}=await server.listen();const base=`http://127.0.0.1:${port}`;
    const response=await fetch(base+'/api/knowledge/chat-references?knowledgeId=k');
    assert.equal(response.status,200); const refs=await response.json();
    assert.equal(refs.length,1);assert.equal(refs[0].turnId,'api-turn');assert.equal(refs[0].revision,1);
    assert.deepEqual(await (await fetch(base+'/api/knowledge/usages?knowledgeId=k')).json(),[]);
    assert.deepEqual(await (await fetch(base+'/api/knowledge/chat-references?knowledgeId=other')).json(),[]);
  } finally {if(server)await server.close();db.close();fs.rmSync(root,{recursive:true,force:true});}
});
