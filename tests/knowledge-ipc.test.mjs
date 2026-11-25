// #58 / #61 的界面接口（P0-3）：三个 IPC 都接上了，且面板有对应入口。
//
// Electron 主进程不能在 node:test 里起，所以这里分两段验：
// 1) 静态接线：main.cjs 注册了三个频道、preload 暴露了对应方法、面板有「提升为候选」入口；
// 2) 处理器体：用真实 store 跑一遍 IPC 处理器里调用的那些函数，断言返回形状与效果
//    （提议只提示不提炼；经验列表按项目；提升走既有候选审核流）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { listDistillProposals, DISTILL_PROPOSAL_THRESHOLD } from '../src/knowledge-loop/on-demand.mjs';
import { promoteLessonToCandidate } from '../src/knowledge-loop/promotion.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const CHANNELS = [
  'companion:knowledge-distill-proposals',
  'companion:lesson-list',
  'companion:lesson-promote'
];

test('主进程注册了提议 / 经验列表 / 提升三个 IPC 频道', () => {
  const main = read('desktop/main.cjs');
  for (const channel of CHANNELS) {
    assert.ok(main.includes(`ipcMain.handle('${channel}'`), `main.cjs 缺少 ${channel}`);
  }
  // 提议只读：处理器里不调用 distill（任何自动提炼）。
  const handler = main.slice(main.indexOf("ipcMain.handle('companion:knowledge-distill-proposals'"));
  const body = handler.slice(0, handler.indexOf('});'));
  assert.equal(/distillOnDemand|\.distill\(/u.test(body), false, '提议信号不能顺带触发提炼');
});

test('preload 暴露了对应方法，面板有「提升为候选」入口', () => {
  const preload = read('desktop/preload.cjs');
  for (const name of ['distillProposals', 'lessonList', 'promoteLesson']) {
    assert.ok(preload.includes(`${name}:`), `preload 缺少 ${name}`);
  }
  const panel = read('desktop/panel.js');
  assert.ok(panel.includes('提升为候选'), '经验条目上要有提升入口');
  // #71 是「搬到操作区」：知识页不再渲染同一份提议（不再有 kbProposals 提示位）。
  assert.equal(panel.includes('kbProposals'), false, '提议只在操作区出现，知识页不重复');
  assert.ok(panel.includes('distillProposals'), '面板（操作区）要读提议信号');
  // 知识页只做三层浏览；按项目取经验留给 IPC 的调用方，不在面板里重复读。
  assert.equal(panel.includes('knowledge.lessonList'), false, '知识页不再为提议文案多读一次经验列表');
});

test('提议处理器：按项目统计未提炼记录，只提示不写库', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    // 提炼器只用到 queue()：给它 owner store 的两个只读列表接口就够。
    const records = Array.from({ length: 3 }, (_, index) => ({
      id: `sandbox:run${index + 1}`, projectId: 'p1', status: 'failed', testStatus: 'fail', evidenceRefs: []
    }));
    const distiller = {
      owner: { listProjects: () => [{ id: 'p1' }] },
      queue: ({ projectId }) => ({
        projectId,
        records: records.filter((record) => record.projectId === projectId),
        total: records.filter((record) => record.projectId === projectId).length,
        truncated: false
      })
    };
    const proposals = listDistillProposals({ distiller, projectId: 'p1' });
    assert.deepEqual(proposals, [{ projectId: 'p1', count: 3 }]);
    assert.equal(proposals[0].count >= DISTILL_PROPOSAL_THRESHOLD, true);
    // 只读：经验表还是空的，没有偷偷写一条。
    assert.equal(personal.listLessons().length, 0);
  } finally { personal.close(); }
});

test('提升处理器：一条经验进待审队列，重复点击不再造第二条', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const lesson = personal.addLesson({
      projectId: 'p1', sourceRecordId: 'sandbox:run1',
      phenomenon: 'retry 循环少跑一次，最后一次重试不执行',
      mechanism: 'for 循环写成 i < attempts - 1',
      countermeasure: '改成 i < attempts，并用同一条断言复跑测试',
      scope: { layer: 'project', projectId: 'p1', domainIds: [] },
      verificationStatus: 'unverified', evidenceRefs: ['sandbox:run1']
    }, { evidence: [{ ref: 'sandbox:run1', recordId: 'sandbox:run1', kind: 'record', excerpt: 'test=fail' }] });

    // 与 IPC 处理器同一份调用。
    const first = promoteLessonToCandidate({ personalStore: personal, lessonId: lesson.id, actor: 'local-user' });
    assert.equal(first.created, true);
    assert.equal(personal.proposals('pending').length, 1);
    const again = promoteLessonToCandidate({ personalStore: personal, lessonId: lesson.id, actor: 'local-user' });
    assert.equal(again.created, false);
    assert.equal(again.reason, 'pending');
    assert.equal(personal.proposals('pending').length, 1);
  } finally { personal.close(); }
});
