// 灵感采集：想法池的数据模型与识别规则。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { OwnerStore } from '../src/owner-store.mjs';
import { looksLikeIdea, ideaTitle } from '../src/idea-capture.mjs';

test('想法与任务分开存：过滤、去重、状态流转', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-ideas-'));
  const store = new OwnerStore(path.join(root, 'owner.sqlite'));
  try {
    store.registerProject({ id: 'demo', name: 'Demo', root });
    const task = store.addProjectQueueItem({ projectId: 'demo', title: '跑一次测试' });
    assert.equal(task.kind, 'task');

    const idea = store.addProjectQueueItem({
      projectId: 'demo', title: '可以加一个导出按钮', kind: 'idea', source: 'conversation'
    });
    assert.equal(idea.kind, 'idea');
    assert.equal(idea.status, 'todo');

    // 同一句话重复采集只保留一条。
    const duplicate = store.addProjectQueueItem({
      projectId: 'demo', title: '可以加一个导出按钮', kind: 'idea'
    });
    assert.equal(duplicate.id, idea.id);

    assert.deepEqual(store.listProjectQueue('demo', 'idea').map((item) => item.id), [idea.id]);
    assert.deepEqual(store.listProjectQueue('demo', 'task').map((item) => item.id), [task.id]);
    assert.equal(store.listProjectQueue('demo').length, 2);

    const adopted = store.updateProjectQueueItem(idea.id, { status: 'done' });
    assert.equal(adopted.status, 'done');
    const discussing = store.updateProjectQueueItem(idea.id, { status: 'doing' });
    assert.equal(discussing.status, 'doing');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('灵感识别：建议进池，明确动手和纯提问不进池', () => {
  assert.equal(looksLikeIdea('我觉得可以加一个导出按钮，方便分享给同事'), true);
  assert.equal(looksLikeIdea('是不是可以把设置页拆成两个标签页'), true);
  assert.equal(looksLikeIdea('帮我改一下登录逻辑'), false);
  assert.equal(looksLikeIdea('实现导出功能'), false);
  assert.equal(looksLikeIdea('这个项目现在进度怎么样？'), false);
  assert.equal(looksLikeIdea('好'), false);
});

test('想法标题保留原句并截断', () => {
  assert.equal(ideaTitle('  加一个导出按钮  '), '加一个导出按钮');
  const long = ideaTitle('改进'.repeat(100));
  assert.equal(long.endsWith('…'), true);
  assert.equal(long.length, 140);
});
