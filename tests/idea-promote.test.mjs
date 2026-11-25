// #97 灵感提升：已整理的条目 → 知识候选（假设类）或项目队列任务。
//
// 全部用临时库：OwnerStore 建在临时目录，PersonalKnowledgeStore 用内存库。
// 不联网、不调用模型；候选审核走既有的 reviewProposal，不另造状态。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OwnerStore } from '../src/owner-store.mjs';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { CANDIDATE_CONTRACT } from '../src/knowledge-loop/contracts.mjs';
import { startSidecar } from '../src/sidecar-server.mjs';
import {
  IDEA_TASK_MARKER,
  promoteIdeaToKnowledge,
  promoteIdeaToTask
} from '../src/idea-promote.mjs';

const TOKEN = 'idea-promote-token-0123456789';
const ORIGIN = {
  gatewayInstanceId: 'gw-idea-promote',
  sessionKey: 'agent:main:idea-promote',
  runId: 'run-idea-promote',
  operatorId: 'owner'
};

const SECTIONS = [
  { key: 'problem', label: '问题', text: '灵感存下来只有一句话。', missing: false, reason: '' },
  { key: 'idea', label: '想法', text: '整理后提升为知识或任务。', missing: false, reason: '' },
  { key: 'benefit', label: '预期收益', text: '决定去留时能直接对照。', missing: false, reason: '' },
  { key: 'risk', label: '风险', text: '提升不改原文，候选被拒也不回滚。', missing: false, reason: '' }
];

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'owner-idea-promote-'));

const setup = () => {
  const root = tempRoot();
  const projectRoot = path.join(root, 'alpha');
  fs.mkdirSync(projectRoot, { recursive: true });
  const store = new OwnerStore(path.join(root, 'owner.sqlite'));
  store.registerProject({ id: 'alpha', name: 'Alpha Repo', root: projectRoot });
  const personal = new PersonalKnowledgeStore(':memory:');
  return { root, store, personal };
};

const cleanup = ({ root, store, personal }) => {
  try { personal.close(); } catch { /* ignore */ }
  try { store.close(); } catch { /* ignore */ }
  fs.rmSync(root, { recursive: true, force: true });
};

/** 建一条「已整理」的灵感：四段齐全，可选带项目 / 链接。 */
const sortedIdea = (store, {
  title = '把整理结果提升为知识或任务',
  rawText = '收件箱整理后没有去处，所以没人用。',
  projectId = null,
  link = ''
} = {}) => {
  const item = store.addIdeaItem({
    title,
    rawText,
    projectId,
    captureSource: link ? 'link' : 'paste',
    link
  });
  store.updateIdeaItem(item.id, {
    sorted: {
      version: 1,
      at: '2026-11-25T00:00:00.000Z',
      source: link ? 'link' : 'text',
      link,
      sections: SECTIONS,
      missing: [],
      complete: true,
      note: '',
      fetch: null
    }
  });
  return store.setIdeaStatus(item.id, 'sorted');
};

/** 提升不该动的四个字段：原文、整理结果、来源、链接。 */
const frozenFields = (item) => ({
  rawText: item.rawText,
  sortedResult: JSON.stringify(item.sorted),
  captureSource: item.captureSource,
  link: item.link
});

test('提升为知识：假设类候选带来源指针，灵感变 adopted，四个字段一字不改', () => {
  const env = setup();
  try {
    const link = 'https://example.com/ideas/97-knowledge';
    const item = sortedIdea(env.store, { projectId: 'alpha', link });
    const before = frozenFields(item);

    const result = promoteIdeaToKnowledge({
      store: env.store, personalStore: env.personal, id: item.id
    });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.created, true);
    assert.equal(result.item.ideaStatus, 'adopted');
    // 状态更新不重写整理时间：sortedAt 还是整理那一次。
    assert.equal(result.item.sortedAt, item.sortedAt);

    const proposal = env.personal.proposal(result.proposal.id);
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.payload.kind, 'hypothesis', '落成假设类');
    assert.equal(proposal.payload.layer, 'project');
    assert.equal(proposal.payload.projectId, 'alpha');
    assert.equal(proposal.payload.verificationStatus, 'unverified');
    assert.equal(proposal.meta.contract, CANDIDATE_CONTRACT);
    assert.equal(proposal.meta.sourceIdeaId, item.id, '来源指针指向灵感 id');
    assert.equal(proposal.payload.sourceRef, `knowledge-loop:idea:${item.id}`);
    // 四段摘要与原文引用都在 claim 里。
    for (const label of ['问题', '想法', '预期收益', '风险']) {
      assert.match(proposal.payload.content, new RegExp(label, 'u'));
    }
    assert.match(proposal.payload.content, /原文：收件箱整理后没有去处/u);
    assert.ok(env.personal.proposals('pending').some((row) => row.id === proposal.id),
      '候选队列里能查到这一条');

    const after = env.store.getIdeaItem(item.id);
    assert.deepEqual(frozenFields(after), before, '提升不改动原文 / 整理结果 / 来源 / 链接');
  } finally {
    cleanup(env);
  }
});

test('候选被拒属于后续审核：灵感保持 adopted，不回滚，也不改四字段', () => {
  const env = setup();
  try {
    const item = sortedIdea(env.store, { projectId: 'alpha' });
    const before = frozenFields(item);
    const promoted = promoteIdeaToKnowledge({
      store: env.store, personalStore: env.personal, id: item.id
    });
    assert.equal(promoted.ok, true);

    const reviewed = env.personal.reviewProposal(promoted.proposal.id, { decision: 'rejected' });
    assert.equal(reviewed.status, 'rejected');
    const after = env.store.getIdeaItem(item.id);
    assert.equal(after.ideaStatus, 'adopted', '候选被拒后灵感仍是 adopted');
    assert.deepEqual(frozenFields(after), before);
  } finally {
    cleanup(env);
  }
});

test('提升为任务：没项目先拦住；选了项目就落进那个项目，四字段不变', () => {
  const env = setup();
  try {
    const item = sortedIdea(env.store);
    const before = frozenFields(item);

    const blocked = promoteIdeaToTask({ store: env.store, id: item.id });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'needs-project');
    assert.match(blocked.reason, /还没有项目/u);
    assert.equal(env.store.getIdeaItem(item.id).ideaStatus, 'sorted', '被拦下时状态不变');
    assert.deepEqual(env.store.listProjectQueue('alpha', 'task'), [], '没有偷偷进默认项目');

    const result = promoteIdeaToTask({ store: env.store, id: item.id, projectId: 'alpha' });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.item.ideaStatus, 'adopted');
    assert.equal(result.task.projectId, 'alpha');
    assert.equal(result.task.kind, 'task');
    assert.equal(result.task.source, 'idea-promote');
    assert.match(result.task.body, new RegExp(IDEA_TASK_MARKER, 'u'));
    assert.match(result.task.body, new RegExp(item.id, 'u'));
    for (const label of ['问题', '想法', '预期收益', '风险']) {
      assert.match(result.task.body, new RegExp(label, 'u'));
    }
    assert.ok(env.store.listProjectQueue('alpha', 'task').some((row) => row.id === result.task.id),
      '项目队列里出现这条任务');

    const after = env.store.getIdeaItem(item.id);
    assert.deepEqual(frozenFields(after), before);
  } finally {
    cleanup(env);
  }
});

test('提升为任务：条目自带项目时直接进那个项目，不用再选', () => {
  const env = setup();
  try {
    const item = sortedIdea(env.store, { projectId: 'alpha' });
    const result = promoteIdeaToTask({ store: env.store, id: item.id });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.projectId, 'alpha');
    assert.equal(result.task.projectId, 'alpha');
  } finally {
    cleanup(env);
  }
});

test('候选被服务端拒绝：状态不变并给出原因', () => {
  const env = setup();
  try {
    const item = sortedIdea(env.store);
    const before = frozenFields(item);
    const broken = {
      proposals: () => [],
      submitProposal: () => { throw new Error('服务端校验没过'); }
    };
    const result = promoteIdeaToKnowledge({
      store: env.store, personalStore: broken, id: item.id
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'candidate');
    assert.match(result.reason, /服务端校验没过/u);
    const after = env.store.getIdeaItem(item.id);
    assert.equal(after.ideaStatus, 'sorted');
    assert.deepEqual(frozenFields(after), before);
  } finally {
    cleanup(env);
  }
});

test('只有已整理的条目能提升：收件箱与终态都拒绝', () => {
  const env = setup();
  try {
    const inbox = env.store.addIdeaItem({ title: '还没整理', rawText: '还没整理' });
    const inboxKnowledge = promoteIdeaToKnowledge({
      store: env.store, personalStore: env.personal, id: inbox.id
    });
    assert.equal(inboxKnowledge.ok, false);
    assert.equal(inboxKnowledge.code, 'status');
    assert.match(inboxKnowledge.reason, /先点「整理」/u);
    assert.equal(env.store.getIdeaItem(inbox.id).ideaStatus, 'inbox');

    const done = sortedIdea(env.store, { title: '已经采纳过' });
    env.store.setIdeaStatus(done.id, 'adopted');
    const again = promoteIdeaToTask({ store: env.store, id: done.id, projectId: 'alpha' });
    assert.equal(again.ok, false);
    assert.equal(again.code, 'status');
    assert.equal(env.store.getIdeaItem(done.id).ideaStatus, 'adopted');

    const missing = promoteIdeaToKnowledge({
      store: env.store, personalStore: env.personal, id: 'nope'
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'missing');
  } finally {
    cleanup(env);
  }
});

const call = async (handle, method, routePath, { body, token = TOKEN } = {}) => {
  const headers = {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(method === 'POST' ? { 'x-owner-origin': JSON.stringify(ORIGIN) } : {})
  };
  const response = await fetch(`http://127.0.0.1:${handle.port}${routePath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

test('侧车提升路由：知识 / 任务各一条，没项目时 400 且不改状态', async () => {
  const env = setup();
  const handle = await startSidecar({
    store: env.store,
    brokerFactory: () => { throw new Error('broker must not be used in these tests'); },
    token: TOKEN,
    personalStore: env.personal,
    port: 0
  });
  try {
    const knowledge = await call(handle, 'POST', '/owner/v1/ideas', {
      body: { text: '侧车提升为知识：整理后没有去处。' }
    });
    await call(handle, 'PATCH', `/owner/v1/ideas/${encodeURIComponent(knowledge.body.item.id)}`, {
      body: { status: 'sorted' }
    });
    const knowledgeResult = await call(handle, 'POST',
      `/owner/v1/ideas/${encodeURIComponent(knowledge.body.item.id)}/promote`,
      { body: { to: 'knowledge' } });
    assert.equal(knowledgeResult.status, 200);
    assert.equal(knowledgeResult.body.item.ideaStatus, 'adopted');
    assert.equal(knowledgeResult.body.proposal.payload.kind, 'hypothesis');
    assert.equal(knowledgeResult.body.proposal.meta.sourceIdeaId, knowledge.body.item.id);

    const task = await call(handle, 'POST', '/owner/v1/ideas', {
      body: { text: '侧车提升为任务：整理后没有去处。' }
    });
    await call(handle, 'PATCH', `/owner/v1/ideas/${encodeURIComponent(task.body.item.id)}`, {
      body: { status: 'sorted' }
    });
    const noProject = await call(handle, 'POST',
      `/owner/v1/ideas/${encodeURIComponent(task.body.item.id)}/promote`,
      { body: { to: 'task' } });
    assert.equal(noProject.status, 400);
    assert.match(noProject.body.error, /还没有项目/u);
    assert.equal(env.store.getIdeaItem(task.body.item.id).ideaStatus, 'sorted');

    const taskResult = await call(handle, 'POST',
      `/owner/v1/ideas/${encodeURIComponent(task.body.item.id)}/promote`,
      { body: { to: 'task', projectId: 'alpha' } });
    assert.equal(taskResult.status, 200);
    assert.equal(taskResult.body.projectId, 'alpha');
    assert.equal(taskResult.body.task.kind, 'task');
    assert.equal(env.store.getIdeaItem(task.body.item.id).ideaStatus, 'adopted');

    const badTarget = await call(handle, 'POST',
      `/owner/v1/ideas/${encodeURIComponent(task.body.item.id)}/promote`,
      { body: { to: 'folder' } });
    assert.equal(badTarget.status, 400);
    assert.match(badTarget.body.error, /未知的提升去处/u);
  } finally {
    await handle.close();
    cleanup(env);
  }
});
