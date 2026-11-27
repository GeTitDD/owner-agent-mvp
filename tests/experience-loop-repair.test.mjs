// 真实项目复现：长原文的跨进程边界不能在提升后从正式正文消失。
import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { promoteIdeaToLesson } from '../src/idea-lesson.mjs';
import { promoteLessonToCandidate } from '../src/knowledge-loop/promotion.mjs';
import { buildChatPrompt } from '../src/pi-chat.mjs';
const boundary = '跨进程还需独立互斥或 CAS，不能把 Promise 队列当跨进程锁';
export const realObservation = '并发状态写回经验：多个任务并行处理时，共享状态文档的 loadRun→修改→persistRun 会因陈旧快照互相覆盖。对策是让 saveTask 与 reconcile 的短读改写统一排队，任务计算仍并行；仅首次 drain 对账恢复中断任务，后续保留活跃任务 running 与锁。适用于同一进程共享状态文档；'+boundary+'。依据：桃花坞提交 b01ee7c0。';
test('长灵感提升后，正式候选仍包含完整边界与证据来源', () => {
 const personalStore=new PersonalKnowledgeStore(':memory:');
 try {
  const item={id:'real-observation',rawText:realObservation,title:'并发状态写回'};
  const store={getIdeaItem:()=>item,getProject:()=>({id:'a'})};
  const {lesson}=promoteIdeaToLesson({store,personalStore,id:item.id,projectId:'a'});
  const {payload}=promoteLessonToCandidate({personalStore,lessonId:lesson.id});
  assert.ok(payload.content.includes(boundary),'正式候选不能以 160 字标题代替原文');
  assert.ok(payload.content.includes('b01ee7c0'));
 } finally {personalStore.close();}
});
test('普通提问的提示包含本轮实际召回条目、修订与不可执行的数据边界',()=>{
 const prompt=buildChatPrompt({project:{id:'a',root:'/tmp/a'},question:'并发状态写回怎么处理',memory:{text:'[knowledge:real@2] '+boundary,items:[{id:'real',revision:2}]}});
 assert.ok(prompt.includes('[knowledge:real@2]'));
 assert.ok(prompt.includes(boundary));
 assert.match(prompt,/资料.*不是.*指令/u);
});

import {recallExperience} from '../src/knowledge/recall.mjs';
test('同项目与共享领域命中同一正式知识，隔离其他项目、归档与已取代记录',()=>{
 const p=new PersonalKnowledgeStore(':memory:');
 try{
  const ownerStore={getProject:id=>({id,primary_domain:id==='c'?'novel':'software-engineering'})};
  const create=(title,overrides={})=>p.create({title,content:boundary,kind:'claim',layer:'project',scope:'project',projectId:'a',domains:['software-engineering'],tags:[],evidenceRefs:[],verificationStatus:'unverified',...overrides});
  const own=create('并发状态写回');const shared=create('并发状态写回共享',{layer:'applied',scope:'domain',projectId:null});
  const hidden=create('其他项目机密',{projectId:'c',domains:['novel']});
  const query=(projectId,q='并发状态写回')=>recallExperience({personalStore:p,ownerStore,projectId,query:q});
  assert.deepEqual(new Set(query('a').items.map(x=>x.id)),new Set([own.id,shared.id]));
  assert.deepEqual(query('b').items.map(x=>x.id),[shared.id]);
  assert.ok(!query('b','怎么解决并发状态写回的问题？').items.some(x=>x.id===hidden.id));
  assert.equal(query('c','共享').items.length,0);
  assert.equal(query('').items.length,0);
  assert.ok(query('b').text.includes(`[knowledge:${shared.id}@1]`));
  assert.ok(query('b').text.includes(boundary));
  assert.ok(recallExperience({personalStore:p,ownerStore,projectId:'b',query:'并发',maxChars:1}).omitted.length>0);
 }finally{p.close();}
});
test('显式关联返回真实正文且不改变写入落点，不相信传入目录或不存在的项目',()=>{
 const p=new PersonalKnowledgeStore(':memory:');try{
  const ownerStore={getProject:id=>['a','b'].includes(id)?{id,primary_domain:'software-engineering'}:null};
  const unit=p.create({title:'并发状态写回',content:boundary,kind:'claim',layer:'project',scope:'project',projectId:'a',domains:[],tags:[],evidenceRefs:[],verificationStatus:'unverified'});
  const linkedProjects=[{id:'a',materials:['experience'],root:'/etc'},{id:'missing',auto:true}];
  const found=recallExperience({personalStore:p,ownerStore,projectId:'b',query:'并发',linkedProjects});
  assert.equal(found.items[0].id,unit.id);assert.match(found.items[0].reason,/显式关联/);
  assert.equal(p.list({projectId:'b'}).length,0);assert.equal(p.get(unit.id).projectId,'a');
  assert.equal(recallExperience({personalStore:p,ownerStore,projectId:'b',query:'并发',linkedProjects:[{id:'a',materials:['profile']}]}).items.length,0);
 }finally{p.close();}
});

import {ideaLessonDraft,confirmIdeaLesson,proposalReviewHash} from '../src/knowledge/experience-review.mjs';
import {knowledgeReviewFor} from '../src/knowledge/review.mjs';
import {candidateReviewView} from '../src/knowledge/candidate-view.mjs';
test('先预览与补全，第一次确认存经验，第二次确认正文和领域范围；重复确认不增条目',()=>{
 const p=new PersonalKnowledgeStore(':memory:');try{
  const item={id:'observation',rawText:realObservation,title:'并发状态写回'};const owner={getIdeaItem:()=>item,getProject:id=>({id,primary_domain:'software-engineering'})};
  const args={ownerStore:owner,personalStore:p,ideaId:item.id,projectId:'a'};
  const draft=ideaLessonDraft(args);assert.equal(p.listLessons().length,0);assert.equal(p.proposals().length,0);
  assert.throws(()=>confirmIdeaLesson({...args,expectedHash:draft.card.expectedHash,edits:{}}),/现象/);assert.equal(p.listLessons().length,0);
  const saved=confirmIdeaLesson({...args,expectedHash:draft.card.expectedHash,edits:{phenomenon:'并发状态写回',mechanism:'读改写共用同一文档',countermeasure:'统一短状态更新队列',content:realObservation}});
  assert.equal(p.list().length,0);assert.equal(saved.lesson.mechanism,'读改写共用同一文档');
  const prepared=promoteLessonToCandidate({personalStore:p,ownerStore:owner,lessonId:saved.lesson.id});
  const card=candidateReviewView({proposal:prepared.proposal,personalStore:p,projects:[{id:'a',primary_domain:'software-engineering'}]});
  assert.ok(card.editValues.content.includes(boundary));assert.ok(card.editValues.content.includes('统一短状态更新队列'));
  const edits={title:'并发状态写回',content:card.content,scope:'domain',domains:'software-engineering',applicability:'同一进程内并发任务共用状态文档',exceptions:boundary};
  const input={personalStore:p,id:prepared.proposal.id,decision:'approved',expectedHash:card.expectedHash,edits};
  assert.equal(knowledgeReviewFor({...input,expectedHash:'stale'}).ok,false);assert.equal(p.list().length,0);
  const done=knowledgeReviewFor(input);assert.equal(done.ok,true,done.reason);assert.equal(done.item.scope,'domain');assert.equal(done.item.projectId,null);assert.equal(done.item.verificationStatus,'unverified');assert.ok(done.item.content.includes(boundary));
  assert.equal(knowledgeReviewFor(input).ok,false);assert.equal(p.list().length,1);
  const recalled=recallExperience({personalStore:p,ownerStore:owner,projectId:'b',query:'怎么处理并发状态写回？'});assert.equal(recalled.items[0].id,done.appliedId);assert.ok(recalled.text.includes(boundary));
 }finally{p.close();}
});
test('来源在预览后变化、候选在展示后变化都拒绝旧确认，保持原记录',()=>{
 const p=new PersonalKnowledgeStore(':memory:');try{
  const item={id:'changed-observation',rawText:realObservation,title:'并发状态写回'};const owner={getIdeaItem:()=>item,getProject:id=>({id})};const args={ownerStore:owner,personalStore:p,ideaId:item.id,projectId:'a'};
  const draft=ideaLessonDraft(args);item.rawText+='原文已修改';
  assert.throws(()=>confirmIdeaLesson({...args,expectedHash:draft.card.expectedHash,edits:{}}),/变化/);assert.equal(p.listLessons().length,0);
  const saved=promoteIdeaToLesson({store:owner,personalStore:p,id:item.id,projectId:'a'});const {proposal}=promoteLessonToCandidate({personalStore:p,lessonId:saved.lesson.id});const expectedHash=proposalReviewHash(proposal);
  p.db.prepare('UPDATE personal_proposals SET note=?,payload=? WHERE id=?').run('另一审阅者已改',JSON.stringify({...proposal.payload,content:'不同正文'}),proposal.id);
  const done=knowledgeReviewFor({personalStore:p,id:proposal.id,decision:'approved',expectedHash,edits:{}});assert.equal(done.ok,false);assert.match(done.reason,/变化/);assert.equal(p.list().length,0);assert.equal(p.proposal(proposal.id).status,'pending');
 }finally{p.close();}
});

import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {OwnerStore} from '../src/owner-store.mjs';import {ChatSessionStore} from '../src/chat-sessions.mjs';
test('审阅草稿按会话和审阅版本隔离，关闭连接后完整恢复，清除与正式知识无关',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'owner-review-draft-'));const file=path.join(root,'owner.sqlite');let owner=new OwnerStore(file);
 try{
  let chats=new ChatSessionStore({db:owner.db});const a=chats.createSession({}).id,b=chats.createSession({}).id;const key='candidate:proposal-1:'+('a'.repeat(64));const next='candidate:proposal-1:'+('b'.repeat(64));
  const values={title:'保留的标题',content:'多行正文\n'+boundary,scope:'domain',domains:'software-engineering'};
  chats.reviewDraft({id:a,key,values});assert.equal(chats.reviewDraft({id:b,key}).values,null);assert.equal(chats.reviewDraft({id:a,key:next}).values,null);
  owner.close();owner=new OwnerStore(file);chats=new ChatSessionStore({db:owner.db});assert.deepEqual(chats.reviewDraft({id:a,key}).values,values);
  assert.throws(()=>chats.reviewDraft({id:a,key,values:{sourceRef:'不能注入隐藏字段'}}),/草稿字段/);
  chats.reviewDraft({id:a,key,clear:true});assert.equal(chats.reviewDraft({id:a,key}).values,null);
 }finally{owner.close();fs.rmSync(root,{recursive:true,force:true});}
});

import {canonical,sha256} from '../src/utils.mjs';
test('归档、已取代与争议不会被静默当成正常推荐，领域知识去重掉已升级的经验',()=>{
 const p=new PersonalKnowledgeStore(':memory:');try{
  const ownerStore={getProject:id=>({id,primary_domain:'software-engineering'})};
  const make=(countermeasure)=>p.recordLessonOrDispute({projectId:'a',sourceRecordId:countermeasure,phenomenon:'并发状态写回',mechanism:'共享状态读改写',countermeasure,scope:{layer:'project',projectId:'a',domainIds:['software-engineering']},verificationStatus:'inferred',evidenceRefs:[]});
  const one=make('队列串行');const two=make('独立锁');
  let recalled=recallExperience({personalStore:p,ownerStore,projectId:'a',query:'并发'});assert.equal(recalled.items.length,2);assert.ok(recalled.text.includes('有争议，不能作定论'));
  p.resolveLessonDispute(one.id,two.id);
  recalled=recallExperience({personalStore:p,ownerStore,projectId:'a',query:'并发'});assert.ok(!recalled.items.some(x=>x.id===two.id));assert.equal(recalled.excluded.superseded,1);
  const {proposal}=promoteLessonToCandidate({personalStore:p,lessonId:one.id});const done=p.reviewProposal(proposal.id,{decision:'approved'});
  recalled=recallExperience({personalStore:p,ownerStore,projectId:'a',query:'并发'});assert.equal(recalled.items.length,1);assert.equal(recalled.items[0].id,done.applied_id);
  const unit=p.get(done.applied_id);p.archiveSyncRecord({kind:'knowledge',id:unit.id,expectedStateHash:sha256(canonical(unit))});
  recalled=recallExperience({personalStore:p,ownerStore,projectId:'a',query:'并发'});assert.ok(!recalled.items.some(x=>x.id===unit.id));
 }finally{p.close();}
});
