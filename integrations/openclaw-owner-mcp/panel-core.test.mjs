// panel-core 的单元测试：这些逻辑决定翻页、状态流转和二次确认是否可靠。
// 运行：node --test integrations/openclaw-owner-mcp

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIRM_TTL_MS,
  formatFileList,
  isConfirmFresh,
  nextIdeaStatus,
  paginate,
  parseCallback,
  selectNewCandidates,
  summarizeDiff
} from './panel-core.mjs';

test('paginate 按页切片并给出翻页信息', () => {
  const items = Array.from({ length: 12 }, (_, index) => index);
  const first = paginate(items, 0, 5);
  assert.deepEqual(first.items, [0, 1, 2, 3, 4]);
  assert.equal(first.pages, 3);
  assert.equal(first.hasPrev, false);
  assert.equal(first.hasNext, true);

  const last = paginate(items, 2, 5);
  assert.deepEqual(last.items, [10, 11]);
  assert.equal(last.hasNext, false);
});

test('paginate 页码越界时夹紧，不会给空页', () => {
  const items = [1, 2, 3];
  assert.deepEqual(paginate(items, 99, 5).items, [1, 2, 3]);
  assert.equal(paginate(items, 99, 5).page, 0);
  assert.deepEqual(paginate(items, -3, 5).items, [1, 2, 3]);
  // 空列表也应该有一页，按钮不会算出 0/0。
  assert.equal(paginate([], 0, 5).pages, 1);
});

test('nextIdeaStatus 在四种状态间循环', () => {
  assert.equal(nextIdeaStatus('todo'), 'doing');
  assert.equal(nextIdeaStatus('doing'), 'blocked');
  assert.equal(nextIdeaStatus('blocked'), 'done');
  assert.equal(nextIdeaStatus('done'), 'todo');
  // 未知状态回到起点，避免卡死。
  assert.equal(nextIdeaStatus('???'), 'todo');
  assert.equal(nextIdeaStatus(undefined), 'todo');
});

test('parseCallback 拆出动作和参数', () => {
  assert.deepEqual(parseCallback('owner:overview:cultivation-agent'), {
    action: 'overview',
    arg: 'cultivation-agent'
  });
  // 参数里再带冒号要原样保留（draw 用 kind:projectId）。
  assert.deepEqual(parseCallback('owner:draw:state:cultivation-agent'), {
    action: 'draw',
    arg: 'state:cultivation-agent'
  });
  assert.deepEqual(parseCallback('owner:menu'), { action: 'menu', arg: '' });
  // 不是面板回调就当空，避免误触发。
  assert.deepEqual(parseCallback('hello'), { action: '', arg: '' });
});

test('isConfirmFresh 只在有效期内认可', () => {
  const now = 1_000_000;
  assert.equal(isConfirmFresh({ type: 'apply', id: 'x', at: now - 1000 }, now), true);
  assert.equal(isConfirmFresh({ type: 'apply', id: 'x', at: now - CONFIRM_TTL_MS - 1 }, now), false);
  assert.equal(isConfirmFresh(null, now), false);
  assert.equal(isConfirmFresh({ type: 'apply' }, now), false);
});

test('summarizeDiff 统计文件和增删行', () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,2 +1,3 @@',
    '-old line',
    '+new line',
    '+another line',
    'diff --git a/src/b.js b/src/b.js',
    '--- a/src/b.js',
    '+++ b/src/b.js',
    '+only add'
  ].join('\n');
  const summary = summarizeDiff(diff);
  assert.deepEqual(summary.files, ['src/a.js', 'src/b.js']);
  assert.equal(summary.fileCount, 2);
  assert.equal(summary.added, 3);
  assert.equal(summary.removed, 1);
});

test('summarizeDiff 超长时截断预览', () => {
  const diff = 'diff --git a/x b/x\n' + '+line\n'.repeat(2000);
  const summary = summarizeDiff(diff);
  assert.ok(summary.preview.length <= 2600);
  assert.ok(summary.preview.endsWith('…'));
});

test('formatFileList 文件名太多时省略', () => {
  assert.equal(formatFileList([]), '（无文件）');
  assert.equal(formatFileList(['a.js', 'b.js']), 'a.js、b.js');
  assert.equal(formatFileList(['a', 'b', 'c'], 2), 'a、b 等 3 个文件');
});

test('selectNewCandidates 首次运行只建基线', () => {
  const proposed = [{ id: 'a' }, { id: 'b' }];
  const result = selectNewCandidates(proposed, [], { baseline: true });
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.nextSeen, ['a', 'b']);
});

test('selectNewCandidates 只挑没见过的候选', () => {
  const proposed = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const result = selectNewCandidates(proposed, ['a', 'c']);
  assert.deepEqual(result.items.map((item) => item.id), ['b']);
});

test('selectNewCandidates 已处理掉的候选会被淘汰', () => {
  // a 已被接受、c 是新出现的；基线里还留着 a 和 b。
  const result = selectNewCandidates([{ id: 'b' }, { id: 'c' }], ['a', 'b']);
  assert.deepEqual(result.items.map((item) => item.id), ['c']);
  assert.deepEqual(result.nextSeen, ['b', 'c']);
});

test('selectNewCandidates 容忍空数据', () => {
  assert.deepEqual(selectNewCandidates(null, null), { items: [], nextSeen: [] });
  assert.deepEqual(selectNewCandidates([{ title: '没有 id' }], []), { items: [], nextSeen: [] });
});
