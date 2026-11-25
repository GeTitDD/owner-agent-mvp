// 同步计划（#129）：表驱动覆盖新增 / 更新 / 归档 / 无变化 / 冲突 / 混合 / 空输入，
// 外加两条边界：只有一边改过不得判冲突；版本相同但时间不同不得判更新。
// 只测纯函数；不碰 Electron、不读盘、不联网。
import test from 'node:test';
import assert from 'node:assert/strict';
import { syncPlan } from '../src/memory/sync-plan.mjs';

const DEFAULT_AT = '2026-11-20T00:00:00.000Z';

const doc = (id, version, updatedAt = DEFAULT_AT, extra = {}) => ({ id, version, updatedAt, ...extra });
const ids = (list) => list.map((entry) => entry.id);
const buckets = (plan) => ({
  added: ids(plan.added),
  updated: ids(plan.updated),
  archived: ids(plan.archived),
  conflicts: ids(plan.conflicts)
});

const CASES = [
  {
    name: '只在本地：新增，待推送',
    local: [doc('a', 1)],
    remote: [],
    expected: { added: ['a'], ahead: 1, behind: 0 }
  },
  {
    name: '只在远端：归档，待拉取',
    local: [],
    remote: [doc('b', 1)],
    expected: { archived: ['b'], ahead: 0, behind: 1 }
  },
  {
    name: '两边同版本：无变化，时间不同也不算更新',
    local: [doc('c', 2, '2026-11-20T00:00:00.000Z')],
    remote: [doc('c', 2, '2026-11-25T08:00:00.000Z')],
    expected: {
      unchanged: 1,
      empty: true,
      emptyText: '两边一致，没有要同步的变化。'
    }
  },
  {
    name: '只有本地版本更高：更新并推送',
    local: [doc('d', 3)],
    remote: [doc('d', 2)],
    expected: { updated: ['d'], ahead: 1, behind: 0, direction: 'push', reason: 'local-version-ahead' }
  },
  {
    name: '只有远端版本更高：更新并拉取',
    local: [doc('e', 2)],
    remote: [doc('e', 5)],
    expected: { updated: ['e'], ahead: 0, behind: 1, direction: 'pull', reason: 'remote-version-ahead' }
  },
  {
    name: '两边都改过：冲突，不自动合并',
    local: [doc('f', 4, DEFAULT_AT, { dirty: true })],
    remote: [doc('f', 3, '2026-11-25T08:00:00.000Z', { dirty: true })],
    expected: { conflicts: ['f'], ahead: 0, behind: 0 }
  },
  {
    name: '两边都改过同一篇且版本相同：仍判冲突，不能当成无变化',
    local: [doc('g', 1, DEFAULT_AT, { dirty: true })],
    remote: [doc('g', 1, '2026-11-25T08:00:00.000Z', { dirty: true })],
    expected: { conflicts: ['g'], unchanged: 0 }
  },
  {
    name: '只有本地改过：可直接合并，不判冲突',
    local: [doc('h', 2, DEFAULT_AT, { dirty: true })],
    remote: [doc('h', 1)],
    expected: { updated: ['h'], conflicts: [], ahead: 1, direction: 'push', reason: 'local-changed' }
  },
  {
    name: '只有远端改过：可直接拉取，不判冲突',
    local: [doc('i', 1)],
    remote: [doc('i', 2, DEFAULT_AT, { dirty: true })],
    expected: { updated: ['i'], conflicts: [], behind: 1, direction: 'pull', reason: 'remote-changed' }
  },
  {
    name: '注入 baseVersion：两边都偏离基线 → 冲突',
    local: [doc('j', 2)],
    remote: [doc('j', 2)],
    options: { baseVersion: 1 },
    expected: { conflicts: ['j'], unchanged: 0 }
  },
  {
    name: 'baseVersion 按 id 注入：只有本地偏离 → 推送',
    local: [doc('k', 2)],
    remote: [doc('k', 1)],
    options: { baseVersion: { k: 1 } },
    expected: { updated: ['k'], ahead: 1, direction: 'push', reason: 'local-changed' }
  },
  {
    name: '条目自带 baseVersion：只有远端偏离 → 拉取',
    local: [doc('l', 1, DEFAULT_AT, { baseVersion: 1 })],
    remote: [doc('l', 3, DEFAULT_AT, { baseVersion: 1 })],
    expected: { updated: ['l'], behind: 1, direction: 'pull', reason: 'remote-changed' }
  },
  {
    name: '版本按数字比较而不是字符串：10 高于 9',
    local: [doc('m', '10')],
    remote: [doc('m', '9')],
    expected: { updated: ['m'], ahead: 1, direction: 'push', reason: 'local-version-ahead' }
  },
  {
    name: '同版本但只有本地有未同步改动：推送这一篇',
    local: [doc('n', 1, DEFAULT_AT, { dirty: true })],
    remote: [doc('n', 1)],
    expected: { updated: ['n'], ahead: 1, direction: 'push', reason: 'local-changed' }
  }
];

for (const entry of CASES) {
  test(`表驱动：${entry.name}`, () => {
    const plan = syncPlan({ local: entry.local, remote: entry.remote, ...(entry.options ?? {}) });
    assert.equal(plan.status, 'ok');
    assert.deepEqual(buckets(plan), {
      added: entry.expected.added ?? [],
      updated: entry.expected.updated ?? [],
      archived: entry.expected.archived ?? [],
      conflicts: entry.expected.conflicts ?? []
    });
    assert.equal(plan.counts.unchanged, entry.expected.unchanged ?? 0);
    assert.equal(plan.ahead, entry.expected.ahead ?? 0);
    assert.equal(plan.behind, entry.expected.behind ?? 0);
    assert.equal(plan.empty, entry.expected.empty ?? false);
    if ('emptyText' in entry.expected) assert.equal(plan.emptyText, entry.expected.emptyText);
    if (entry.expected.direction) assert.equal(plan.updated[0].direction, entry.expected.direction);
    if (entry.expected.reason) assert.equal(plan.updated[0].reason, entry.expected.reason);
  });
}

test('混合：四类齐全，ahead / behind 各算各的', () => {
  const plan = syncPlan({
    local: [
      doc('a', 1),
      doc('b', 2, DEFAULT_AT, { dirty: true }),
      doc('c', 1),
      doc('d', 3),
      doc('e', 1),
      doc('h', 2, DEFAULT_AT, { dirty: true, baseVersion: 1 })
    ],
    remote: [
      doc('b', 1),
      doc('c', 2),
      doc('d', 2),
      doc('e', 1, DEFAULT_AT, { dirty: true }),
      doc('g', 1),
      doc('h', 3, DEFAULT_AT, { dirty: true, baseVersion: 1 })
    ]
  });

  assert.deepEqual(buckets(plan), {
    added: ['a'],
    updated: ['b', 'c', 'd', 'e'],
    archived: ['g'],
    conflicts: ['h']
  });
  assert.deepEqual(plan.counts, {
    added: 1,
    updated: 4,
    archived: 1,
    conflicts: 1,
    unchanged: 0,
    total: 7
  });
  assert.equal(plan.ahead, 3, 'a 新增 + b、d 推送');
  assert.equal(plan.behind, 3, 'g 归档 + c、e 拉取');
  assert.equal(plan.empty, false);
  assert.equal(plan.emptyText, '');
  assert.equal(plan.headline, '新增 1 · 更新 4 · 归档 1 · 冲突 1');
});

test('冲突条目带两边版本、时间与标记，供人判断该留哪边', () => {
  const plan = syncPlan({
    local: [doc('x', 4, '2026-11-24T10:00:00.000Z', { dirty: true, baseVersion: 3 })],
    remote: [doc('x', 5, '2026-11-25T10:00:00.000Z', { dirty: true, baseVersion: 3 })]
  });

  assert.equal(plan.conflicts.length, 1);
  const conflict = plan.conflicts[0];
  assert.equal(conflict.id, 'x');
  assert.equal(conflict.reason, 'both-changed');
  assert.deepEqual(conflict.local, {
    version: '4',
    updatedAt: '2026-11-24T10:00:00.000Z',
    dirty: true,
    baseVersion: '3'
  });
  assert.deepEqual(conflict.remote, {
    version: '5',
    updatedAt: '2026-11-25T10:00:00.000Z',
    dirty: true,
    baseVersion: '3'
  });
});

test('空输入：两份清单都为空时明确说「没有内容」', () => {
  const plan = syncPlan({ local: [], remote: [] });
  assert.equal(plan.status, 'ok');
  assert.equal(plan.empty, true);
  assert.equal(plan.emptyText, '两边都没有文档，没有要同步的内容。');
  assert.equal(plan.headline, plan.emptyText);
  assert.deepEqual(plan.counts, { added: 0, updated: 0, archived: 0, conflicts: 0, unchanged: 0, total: 0 });
  assert.equal(plan.ahead, 0);
  assert.equal(plan.behind, 0);
});

test('完全一致的清单：空态是「两边一致」，不是「两边都没文档」', () => {
  const list = [doc('a', 1), doc('b', 2)];
  const plan = syncPlan({ local: list, remote: structuredClone(list) });
  assert.equal(plan.status, 'ok');
  assert.equal(plan.empty, true);
  assert.equal(plan.emptyText, '两边一致，没有要同步的变化。');
  assert.equal(plan.counts.unchanged, 2);
});

test('缺一份清单：不把「读不到」说成「没有变化」', () => {
  const plan = syncPlan({ local: [doc('a', 1)] });
  assert.equal(plan.status, 'unavailable');
  assert.equal(plan.empty, false);
  assert.equal(plan.emptyText, '');
  assert.match(plan.unavailableText, /缺少本地或远端文档清单/);
  assert.equal(plan.headline, '');
  assert.deepEqual(plan.counts, { added: 0, updated: 0, archived: 0, conflicts: 0, unchanged: 0, total: 0 });
});

test('认不出 id 的条目计入 skipped，重复 id 保留后者并记录', () => {
  const plan = syncPlan({
    local: [null, { version: 2 }, { id: 'dup', version: 1 }, { id: 'dup', version: 2 }, 'solo'],
    remote: [doc('dup', 2)]
  });

  assert.equal(plan.skipped.local, 2);
  assert.equal(plan.skipped.remote, 0);
  assert.deepEqual(plan.duplicateIds, ['dup']);
  assert.equal(plan.counts.total, 2, '去重后的身份数');
  assert.deepEqual(buckets(plan), { added: ['solo'], updated: [], archived: [], conflicts: [] });
  // 重复 id 保留后者：本地 dup 是 v2，与远端 v2 一致，不算变化。
  assert.equal(plan.empty, false);
  assert.equal(plan.counts.unchanged, 1);
});

test('输出顺序只由 id 决定，输入顺序变化不改变结果', () => {
  const local = [doc('c', 1), doc('a', 2, DEFAULT_AT, { dirty: true }), doc('b', 1)];
  const remote = [doc('b', 2), doc('d', 1), doc('a', 1)];
  const forward = syncPlan({ local, remote });
  const reversed = syncPlan({ local: [...local].reverse(), remote: [...remote].reverse() });
  assert.deepEqual(forward, reversed);
  assert.deepEqual(buckets(forward), {
    added: ['c'],
    updated: ['a', 'b'],
    archived: ['d'],
    conflicts: []
  });
});
