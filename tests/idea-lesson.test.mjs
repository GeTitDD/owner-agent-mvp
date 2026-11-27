// #137 灵感回执上的「提升为 Lesson」：回执带 id、只有一个动作；提升只写经验、不写知识库。
//
// 这里验纯函数与存储层：回执形状、原文 → 现象 / 证据的映射、重复提升、没有项目时拒绝。
// 界面上的点击（按钮只出现一次、点完出经验卡）由 dom 渲染与 e2e 覆盖；本文件只锁模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { promoteLessonToCandidate } from '../src/knowledge-loop/promotion.mjs';
import { promoteIdeaToLesson } from '../src/idea-lesson.mjs';
import { IDEA_LESSON_ACTION, runOwnWrite } from '../src/own-write.mjs';

const require = createRequire(import.meta.url);
const blocks = require('../desktop/shell-blocks.cjs');
const stream = require('../desktop/shell-stream.cjs');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const AT = '2026-11-26T10:00:00.000Z';

/** 一条普通的灵感：原文就是提升后的现象。 */
const IDEA = Object.freeze({
  id: 'idea-42',
  rawText: '收件箱空的时候应该有一句提示',
  title: '收件箱空态',
  ideaStatus: 'inbox',
  captureSource: 'paste',
  createdAt: '2026-11-26T09:00:00.000Z'
});

/** 只提供提升链路真正用到的两个只读方法，不启动真实 owner 库。 */
const owner = (idea = IDEA) => ({
  getIdeaItem: (id) => (id === idea.id ? idea : null),
  getProject: (id) => (id === 'p1' ? { id: 'p1', name: '项目一' } : null)
});

const withStore = (run) => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    return run(personal);
  } finally {
    personal.close();
  }
};

test('同一想法在两个项目整理成经验，不得仅凭灵感来源标为跨项目复现', () => withStore((personalStore) => {
  const items = ['a', 'b'].map((id) => ({ ...IDEA, id: `copied-${id}` }));
  const store = {
    getIdeaItem: (id) => items.find((item) => item.id === id),
    getProject: (id) => ({ id })
  };
  for (const id of ['a', 'b']) {
    const result = promoteIdeaToLesson({ store, personalStore, id: `copied-${id}`, projectId: id,
      edits: { phenomenon: '相同人工观察', mechanism: '尚未核验的机制', countermeasure: '尚未验证的对策' } });
    assert.equal(result.ok, true, result.reason);
  }
  for (const lesson of personalStore.listLessons()) {
    assert.equal(Boolean(lesson.reproduced), false, '两个灵感不等于两次事实复现');
    assert.equal(lesson.verificationStatus, 'inferred');
    assert.equal(lesson.scope.layer, 'project');
  }
}));

test('灵感回执带 id，并且只有一个「提升为 Lesson」动作', async () => {
  const result = await runOwnWrite({
    kind: 'idea',
    text: IDEA.rawText,
    at: AT,
    execute: async () => ({ wrote: 'ideas 表 · 1 条', result: IDEA.id, ideaId: IDEA.id })
  });
  assert.equal(result.ok, true);
  const block = result.receipt.blocks[0];
  assert.equal(block.type, 'kv');

  const rows = new Map(block.rows);
  assert.equal(rows.get('结果'), IDEA.id, '回执照旧带结果');
  assert.equal(rows.get('灵感'), IDEA.id, '回执另外写明这是哪条灵感');

  // 只出现一次：模型里恰好一个动作，就是「提升为 Lesson」。
  assert.deepEqual(block.actions, [IDEA_LESSON_ACTION]);
  const model = blocks.normalizeReply(result.receipt).blocks[0];
  assert.equal(model.type, 'kv');
  assert.equal(model.ideaId, IDEA.id);
  assert.deepEqual(model.actions, [IDEA_LESSON_ACTION]);
  assert.equal(model.actions.length, 1);
});

test('其他写入回执不带提升动作；灵感回执缺 id 时也不假装能提升', async () => {
  for (const kind of ['draft', 'watermark', 'enqueue', 'export']) {
    const result = await runOwnWrite({
      kind,
      at: AT,
      execute: async () => ({ wrote: '自有目录 · 1 处', result: 'not-an-idea' })
    });
    assert.equal(result.ok, true, kind);
    const block = result.receipt.blocks[0];
    assert.equal(block.actions, undefined, `${kind} 不应该出现提升动作`);
    assert.equal(block.ideaId, undefined, `${kind} 不应该带灵感 id`);
  }

  const missingId = await runOwnWrite({
    kind: 'idea',
    text: IDEA.rawText,
    at: AT,
    execute: async () => ({ wrote: 'ideas 表 · 1 条', result: '已记录' })
  });
  assert.equal(missingId.receipt.blocks[0].actions, undefined, '拿不到 id 就不给提升动作');
});

test('灵感原文映射为现象；机制 / 对策留空；来源与证据指回这条灵感', () => withStore((personal) => {
  const result = promoteIdeaToLesson({
    store: owner(), personalStore: personal, id: IDEA.id, projectId: 'p1'
  });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);

  const lesson = result.lesson;
  assert.equal(lesson.projectId, 'p1');
  assert.equal(lesson.sourceRecordId, IDEA.id, '来源记录 id 就是灵感');
  assert.equal(lesson.phenomenon, IDEA.rawText, '现象就是灵感原文');
  assert.equal(lesson.mechanism, '', '机制留空，不编');
  assert.equal(lesson.countermeasure, '', '对策留空，不编');
  assert.equal(lesson.verificationStatus, 'inferred', '只允许推断，绝不自动 verified');
  assert.deepEqual(lesson.scope, { layer: 'project', projectId: 'p1', domainIds: [] });
  assert.deepEqual(lesson.evidenceRefs, [`idea:${IDEA.id}`]);

  const evidence = personal.lessonEvidence(lesson.id);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].ref, `idea:${IDEA.id}`);
  assert.equal(evidence[0].recordId, IDEA.id);
  assert.match(evidence[0].excerpt, new RegExp(IDEA.rawText, 'u'), '证据片段带原文');

  // 提升只写经验：候选队列仍然为空，知识库没有被自动写入。
  assert.equal(personal.listLessons().length, 1);
  assert.equal(personal.proposals('pending').length, 0);
  assert.equal(personal.proposals('approved').length, 0);
}));

test('同一条灵感重复提升不产生第二条经验，并说明已有', () => withStore((personal) => {
  const first = promoteIdeaToLesson({
    store: owner(), personalStore: personal, id: IDEA.id, projectId: 'p1'
  });
  const second = promoteIdeaToLesson({
    store: owner(), personalStore: personal, id: IDEA.id, projectId: 'p1'
  });

  assert.equal(first.created, true);
  assert.equal(second.ok, true);
  assert.equal(second.created, false);
  assert.equal(second.reason, 'existing');
  assert.equal(second.lesson.id, first.lesson.id, '返回已有的那一条经验');
  assert.equal(personal.listLessons({ sourceRecordId: IDEA.id }).length, 1);
  assert.equal(personal.listLessons().length, 1);
  assert.equal(personal.lessonEvidence(first.lesson.id).length, 1, '重复提升不重复追加证据');
}));

test('没有当前项目时明确拒绝；什么都没写', () => withStore((personal) => {
  for (const projectId of ['', '   ']) {
    const result = promoteIdeaToLesson({
      store: owner(), personalStore: personal, id: IDEA.id, projectId
    });
    assert.equal(result.ok, false, JSON.stringify(projectId));
    assert.equal(result.code, 'needs-project');
    assert.match(result.reason, /选一个项目/u);
  }
  assert.equal(personal.listLessons().length, 0, '拒绝时一条经验都不写');
  assert.equal(personal.proposals('pending').length, 0);
}));

test('项目不存在或灵感不存在时同样拒绝，不落库', () => withStore((personal) => {
  const unknownProject = promoteIdeaToLesson({
    store: owner(), personalStore: personal, id: IDEA.id, projectId: 'p-missing'
  });
  assert.equal(unknownProject.ok, false);
  assert.equal(unknownProject.code, 'project');

  const missingIdea = promoteIdeaToLesson({
    store: owner(), personalStore: personal, id: 'idea-missing', projectId: 'p1'
  });
  assert.equal(missingIdea.ok, false);
  assert.equal(missingIdea.code, 'missing');

  assert.equal(personal.listLessons().length, 0);
}));

test('提升后的经验卡还是普通审核卡：只带「提升为候选」，不会自动入库', () => withStore((personal) => {
  const { lesson } = promoteIdeaToLesson({
    store: owner(), personalStore: personal, id: IDEA.id, projectId: 'p1'
  });
  const card = stream.ideaLessonReview(lesson);
  assert.equal(card.type, 'review');
  assert.equal(card.kind, 'lesson');
  assert.equal(card.lessonId, lesson.id);
  assert.equal(card.title, IDEA.rawText);
  assert.equal(card.rows[0][1], '（未记录）');
  assert.deepEqual(card.actions, [{ id: 'promote', label: '审阅并沉淀' }]);
  assert.match(card.note, /不会|只生成候选/u);

  const model = blocks.normalizeBlock(card);
  assert.equal(model.kind, 'lesson');
  assert.deepEqual(model.actions, [{ id: 'promote', label: '审阅并沉淀' }]);

  // 候选仍要人再点一次；提升为 Lesson 本身没有写知识库。
  assert.equal(personal.proposals('pending').length, 0);
  const promoted = promoteLessonToCandidate({ personalStore: personal, lessonId: lesson.id });
  assert.equal(promoted.created, true);
  assert.equal(personal.proposals('pending').length, 1);
}));

test('主进程 / preload / 回执按钮都接上了，动作只由回执块声明', () => {
  const main = read('desktop/main.cjs');
  assert.ok(main.includes("ipcMain.handle('companion:idea-lesson'"), 'main.cjs 缺少提升通道');
  const handler = main.slice(main.indexOf("ipcMain.handle('companion:idea-lesson'"));
  const body = handler.slice(0, handler.indexOf('});'));
  assert.equal(/submitProposal|promoteLessonToCandidate/u.test(body), false,
    '提升为 Lesson 不能顺带写候选');

  const preload = read('desktop/preload.cjs');
  assert.ok(preload.includes('toLesson:'), 'preload 缺少 ideas.toLesson');

  const streamSource = read('desktop/shell-stream.cjs');
  assert.ok(streamSource.includes('data-receipt-action'), '对话流缺少回执动作落点');
  assert.ok(streamSource.includes('toLesson'), '对话流没有调用提升通道');

  const view = read('desktop/shell-blocks-view.js');
  assert.ok(view.includes('dataset.receiptAction'), '键值块没有画回执动作按钮');
});
