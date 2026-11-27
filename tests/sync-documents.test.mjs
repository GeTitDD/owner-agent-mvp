import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { canonical, sha256 } from '../src/utils.mjs';
import { syncRecordOf, encodeSyncDocument, decodeSyncDocument, syncDocumentVersion, restoreSyncLocalFields } from '../src/memory/sync-documents.mjs';

const store = () => new PersonalKnowledgeStore(':memory:', { logger: { log() {}, warn() {} } });
const note = (overrides = {}) => ({ title:'中文记忆：测试标题', content:'第一段\n\n## 标题\n正文可包含结构标记\n\n---\n还有分隔线与 🧭。',
  kind:'note',layer:'project',scope:'project',projectId:'demo',domains:['software-engineering'],verificationStatus:'unverified',...overrides });
const lesson = (overrides={}) => ({projectId:'demo',sourceRecordId:'record:1',phenomenon:'重试漏掉最后一次',mechanism:'循环边界不完整',countermeasure:'明确最大次数',
  scope:{layer:'project',projectId:'demo'},verificationStatus:'inferred',evidenceRefs:['record:1'],...overrides});
const state = row => row ? sha256(canonical(row)) : null;
const importDoc = (target, doc) => {
  const {record}=decodeSyncDocument(doc);const current=record.kind==='knowledge'?target.get(record.id):target.getLesson(record.id);
  return target.importSyncRecord({...record,payload:restoreSyncLocalFields(record.payload,current),expectedStateHash:state(current)});
};

test('知识正文只存一份，可读 Markdown 的任意段落和标题都可完整往返', () => {
  const s=store();try{
    const row=s.create(note());const record=syncRecordOf('knowledge',row);const doc=encodeSyncDocument(record);
    assert.ok(doc.content.includes('## 内容\n第一段'));assert.equal(doc.content.split('正文可包含结构标记').length-1,1);
    assert.deepEqual(decodeSyncDocument(doc).record,record);
    assert.equal(doc.version,syncDocumentVersion(record));
    assert.equal(encodeSyncDocument({...record,updatedAt:'2026-11-27T11:00:00.000Z'}).version,doc.version);
  }finally{s.close();}
});

test('篡改正文、身份、路径、段落长度与追加隐藏内容都会拒绝', () => {
  const s=store();try{
    const doc=encodeSyncDocument(syncRecordOf('knowledge',s.create(note())));
    for(const changed of [
      {...doc,content:doc.content.replace('第一段','已被篡改')}, {...doc,path:doc.path.replace('.md','-other.md')},
      {...doc,content:doc.content+'追加数据'}, {...doc,content:doc.content.replace(/sections: .+/u,'sections: [["title",999999999999],["content",0]]')},
      {...doc,content:doc.content.replace('format: "owner-memory/v1"','format: "unknown/v2"')}
    ])assert.throws(()=>decodeSyncDocument(changed),/同步/);
  }finally{s.close();}
});

test('运行机器路径不上传，本机已有的来源路径和稳定引用在回读时保留', () => {
  const s=store();try{
    const row=s.create(note({kind:'decision',decisionStatus:'active',decision:{intent:'选择 A',reason:'更容易验证',source:{kind:'manual',sessionPath:'/Users/fixture/private/session.jsonl'},quote:null},evidenceRefs:['/Users/fixture/project/test.log']}));
    const doc=encodeSyncDocument(syncRecordOf('knowledge',row));
    assert.ok(!doc.content.includes('/Users/fixture'));assert.ok(doc.content.includes('local-reference:'));
    const decoded=decodeSyncDocument(doc).record;
    const restored=restoreSyncLocalFields(decoded.payload,row);
    assert.equal(restored.decision.source.sessionPath,row.decision.source.sessionPath);
    assert.deepEqual(restored.evidenceRefs,row.evidenceRefs);
    assert.equal(decoded.payload.decision.source.sessionPath,undefined);
  }finally{s.close();}
});

test('疑似凭据字段和正文被拒绝，不能通过嵌套 JSON 或 metadata 绕过', () => {
  for(const extra of [{source:{api_key:'FICTIONAL-LONG-VALUE'}},{mechanism:'api_key=FICTIONAL-LONG-VALUE'},
    {evidence:[{recordId:'r',ref:'r',kind:'test',excerpt:'ghp_SYNTHETIC_FAKE_CREDENTIAL_123456'}]}]) {
    assert.throws(()=>encodeSyncDocument(syncRecordOf('lesson',{id:'lesson_fixture',...lesson(),...extra})),/凭据|credential/u);
  }
});

test('两份真实知识存储之间导入保留身份、关系、正文和修订；重复接收幂等', () => {
  const a=store(),b=store();try{
    const first=a.create(note());const second=a.create(note({title:'引用前一条',relations:{related_to:[first.id]}}));
    for(const row of [first,second])importDoc(b,encodeSyncDocument(syncRecordOf('knowledge',row)));
    assert.equal(b.get(first.id).content,first.content);assert.deepEqual(b.get(second.id).relations,second.relations);
    const old=b.get(first.id);importDoc(b,encodeSyncDocument(syncRecordOf('knowledge',first)));
    assert.equal(b.get(first.id).revision,old.revision);
    const revised=a.update(first.id,note({content:'修改后的真实正文'}),{expectedRevision:first.revision});
    importDoc(b,encodeSyncDocument(syncRecordOf('knowledge',revised)));
    assert.equal(b.get(first.id).revision,2);assert.equal(b.revisions(first.id).length,2);
    assert.equal(b.revisions(first.id).at(-1).payload.content,first.content);
    assert.equal(syncDocumentVersion(syncRecordOf('knowledge',b.get(first.id))),syncDocumentVersion(syncRecordOf('knowledge',revised)));
  }finally{a.close();b.close();}
});

test('预览后知识被编辑，旧同步选择无法覆盖新内容', () => {
  const s=store();try{
    const old=s.create(note());const expected=state(old);
    s.update(old.id,note({content:'用户在等待时的新编辑'}),{expectedRevision:old.revision});
    assert.throws(()=>s.importSyncRecord({kind:'knowledge',id:old.id,payload:note({content:'旧选择'}),expectedStateHash:expected}),/预览后已变化/);
    assert.equal(s.get(old.id).content,'用户在等待时的新编辑');
    assert.throws(()=>s.importSyncRecord({kind:'knowledge',id:old.id,payload:note()}),/预览状态/);
  }finally{s.close();}
});

test('经验、状态和证据实际进入另一份应用存储，重复接收不新增导入审计', () => {
  const a=store(),b=store();try{
    const row=a.addLesson(lesson(),{evidence:[{recordId:'record:1',ref:'record:1',kind:'test',excerpt:'最后一次测试已执行'}]});
    const doc=encodeSyncDocument(syncRecordOf('lesson',row));importDoc(b,doc);
    const received=b.getLesson(row.id);assert.equal(received.phenomenon,row.phenomenon);assert.equal(received.verificationStatus,row.verificationStatus);
    assert.equal(received.evidence[0].excerpt,row.evidence[0].excerpt);
    assert.equal(encodeSyncDocument(syncRecordOf('lesson',received)).version,doc.version);
    importDoc(b,doc);
    assert.equal(b.db.prepare('SELECT COUNT(*) AS count FROM knowledge_sync_imports').get().count,1);
    assert.equal(b.lessonEvidence(row.id).length,1);
  }finally{a.close();b.close();}
});

test('经验的状态或证据在预览后变化，也会阻止覆盖；不只比较 payload_hash', () => {
  const a=store();try{
    const row=a.addLesson(lesson(),{evidence:[{recordId:'record:1',ref:'record:1',kind:'test',excerpt:'证据'}]});
    const record=syncRecordOf('lesson',row);
    a.db.prepare("UPDATE knowledge_lessons SET verification_status='disputed' WHERE id=?").run(row.id);
    assert.throws(()=>a.importSyncRecord({...record,expectedStateHash:state(row)}),/预览后已变化/);
    assert.equal(a.getLesson(row.id).verificationStatus,'disputed');
  }finally{a.close();}
});

test('完整同步枚举不受知识 2000 条与经验 1000 条的界面上限截断', () => {
  const a=store();try{
    for(let i=0;i<2005;i+=1)a.create(note({title:`知识 ${i}`}));
    for(let i=0;i<1005;i+=1)a.addLesson(lesson({phenomenon:`经验 ${i}`}));
    assert.equal(a.list({limit:99999}).length,2000);assert.equal(a.listLessons({limit:99999}).length,1000);
    const records=a.syncRecords();assert.equal(records.filter(r=>r.kind==='knowledge').length,2005);assert.equal(records.filter(r=>r.kind==='lesson').length,1005);
  }finally{a.close();}
});

test('无效导入完整回滚，不留下半条经验或证据', () => {
  const a=store();try{
    assert.throws(()=>a.importSyncRecord({kind:'lesson',id:'lesson_invalid',payload:lesson({dedupeKey:'fixture-dedupe',verificationStatus:'verified',evidence:[]}),expectedStateHash:null}),/保留证据/);
    assert.equal(a.getLesson('lesson_invalid'),null);assert.equal(a.db.prepare('SELECT COUNT(*) AS count FROM knowledge_lesson_evidence').get().count,0);
  }finally{a.close();}
});

test('归档经验退出当前检索和去重，新证据不会悄悄写入隐藏条目',()=>{
  const s=store();try{
    const row=s.recordLesson(lesson());s.archiveSyncRecord({kind:'lesson',id:row.id,expectedStateHash:state(s.getLesson(row.id))});
    assert.equal(s.lessonByDedupe(row.dedupeKey),null);assert.equal(s.lessonByPhenomenon(row.phenomenon),null);assert.deepEqual(s.lessonsByPhenomenon(row.phenomenon),[]);
    const next=s.recordLesson(lesson({sourceRecordId:'record:2'}));assert.notEqual(next.id,row.id);assert.equal(s.listLessons().length,1);assert.ok(s.getLesson(row.id).syncArchivedAt);
  }finally{s.close();}
});

test('旧卡片不能修改隐藏的归档知识或经验，项目检索不再召回归档经验',()=>{
  const s=store();try{
    const unit=s.create(note());const proposal=s.submitProposal({targetId:unit.id,payload:note({content:'待审修改'})});s.archiveSyncRecord({kind:'knowledge',id:unit.id,expectedStateHash:state(unit)});
    assert.throws(()=>s.reviewProposal(proposal.id,{decision:'approved'}),/已归档/);assert.equal(s.proposal(proposal.id).status,'pending');
    assert.throws(()=>s.update(unit.id,note({content:'不应写入'}),{expectedRevision:unit.revision}),/已归档/);
    const row=s.recordLesson(lesson());s.archiveSyncRecord({kind:'lesson',id:row.id,expectedStateHash:state(s.getLesson(row.id))});
    assert.deepEqual(s.listLessonsForProject('demo'),[]);
    assert.throws(()=>s.appendLessonEvidence(row.id,lesson({sourceRecordId:'record:new'})),/已归档/);
    assert.throws(()=>s.promoteLessonToDomain(row.id,{domainIds:['test']}),/已归档/);
  }finally{s.close();}
});
