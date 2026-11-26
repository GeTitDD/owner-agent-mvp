// #140 定位屏行内「标记已读」：只推进一个项目的水位，浏览 / 切换 / 刷新都不清零。
//
// 测在公开边界上：src/memory/since-last-seen.mjs 的 markProjectRead 是除 `/变化`
// （computeSinceLastSeen）之外唯一允许推进水位的入口；locate-screen.mjs 只吃算好的数据。
// 桌面端接线（IPC / preload / 顶栏）用静态断言锁住，避免行内动作绕开这条入口。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryWatermarkStore } from '../src/memory/watermark.mjs';
import {
  computeSinceLastSeen,
  markProjectRead,
  previewSinceLastSeen
} from '../src/memory/since-last-seen.mjs';
import { locateScreenView, unreadCountsOf } from '../src/memory/locate-screen.mjs';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'locate-mark-read-test-'));

const withDb = async (fn) => {
  const dir = makeTempDir();
  try { return await fn(path.join(dir, 'owner.sqlite')); } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
};

const OLD = '2026-11-01T00:00:00.000Z';
const NOW = '2026-11-26T12:00:00.000Z';
const LATER = '2026-11-26T12:05:00.000Z';
const FUTURE = '2027-01-01T00:00:00.000Z';

const project = (id, name = id) => ({ id, name });

const commits = [
  { sha: 'old', subject: '看过了', at: '2026-10-20T00:00:00.000Z' },
  { sha: 'new1', subject: '新的提交', at: '2026-11-05T00:00:00.000Z' }
];

/** 只读预览一个项目的未读；与主进程定位屏用的是同一个入口。 */
const previewUnread = (store, projectId) => {
  const preview = previewSinceLastSeen({
    projectId, store, commits, dirty: [], events: []
  });
  return unreadCountsOf(preview.view);
};

/** 把两个项目的注意力数据拼成定位屏视图（与主进程同构）。 */
const locateViewOf = (store, ids, now = NOW) => {
  const attention = {};
  for (const id of ids) {
    const preview = previewSinceLastSeen({
      projectId: id, store, commits, dirty: [], events: []
    });
    attention[id] = {
      unread: unreadCountsOf(preview.view),
      lastReadAt: preview.lastReadAt,
      latestDecision: null
    };
  }
  return locateScreenView({ projects: ids.map((id) => project(id)), attention, now });
};

const rowOf = (view, id) => view.projects.find((row) => row.projectId === id);

test('#140 行内标记已读：只清一个项目，其他项目的未读与水位原样', () => withDb(async (dbPath) => {
  const store = new MemoryWatermarkStore({ dbPath });
  try {
    store.put('alpha', OLD);
    store.put('beta', OLD);
    const before = locateViewOf(store, ['alpha', 'beta']);
    assert.equal(rowOf(before, 'alpha').unread.total, 1);
    assert.equal(rowOf(before, 'beta').unread.total, 1);

    const mark = markProjectRead({
      projectId: 'alpha',
      store,
      unread: previewUnread(store, 'alpha'),
      now: NOW
    });
    assert.equal(mark.changed, true);
    assert.equal(mark.projectId, 'alpha');
    assert.equal(mark.at, NOW);
    assert.match(mark.message, /已标记已读/u);

    // 只有 alpha 的水位动了；beta 还是旧水位。
    assert.equal(store.get('alpha').at, NOW);
    assert.equal(store.get('beta').at, OLD);
    assert.deepEqual(store.list().map((row) => [row.projectId, row.at]), [['alpha', NOW], ['beta', OLD]]);

    const after = locateViewOf(store, ['alpha', 'beta']);
    assert.equal(rowOf(after, 'alpha').unread.total, 0, '标记后该项目未读清零');
    assert.equal(rowOf(after, 'alpha').unreadLabel, '没有未读变化');
    assert.equal(rowOf(after, 'beta').unread.total, 1, '其他项目不受影响');
    // 排序随之更新：还有未读的 beta 排到前面，而不是被浏览动作一起清掉。
    assert.deepEqual(after.projects.map((row) => row.projectId), ['beta', 'alpha']);
  } finally { store.close(); }
}));

test('#140 重复标记同一行是空操作：不再推水位，回执说清「已经没有未读」', () => withDb(async (dbPath) => {
  const store = new MemoryWatermarkStore({ dbPath });
  try {
    store.put('alpha', OLD);
    const first = markProjectRead({
      projectId: 'alpha', store, unread: previewUnread(store, 'alpha'), now: NOW
    });
    assert.equal(first.changed, true);

    // 同一行再点一次（时间已经往前走）：已知没有未读 → 不写库。
    const second = markProjectRead({
      projectId: 'alpha', store, unread: previewUnread(store, 'alpha'), now: LATER
    });
    assert.equal(second.changed, false);
    assert.equal(second.reason, 'nothing-unread');
    assert.equal(second.at, NOW);
    assert.match(second.message, /没有未读/u);
    assert.equal(store.get('alpha').at, NOW, '重复标记不能把水位继续推后');

    // 未读读不到（null）但水位已在目标时刻之后：同样不往前写，回执说明已是已读。
    store.put('beta', FUTURE);
    const guarded = markProjectRead({
      projectId: 'beta', store, unread: unreadCountsOf({}), now: NOW
    });
    assert.equal(guarded.changed, false);
    assert.equal(guarded.reason, 'already-read');
    assert.equal(store.get('beta').at, FUTURE);
  } finally { store.close(); }
}));

test('#140 标记已读只写被点的那一个项目：store.put 只收到它的 id', () => withDb(async (dbPath) => {
  const store = new MemoryWatermarkStore({ dbPath });
  try {
    store.put('alpha', OLD);
    store.put('beta', OLD);
    const puts = [];
    const spy = {
      get: (id) => store.get(id),
      put: (id, at) => { puts.push(id); return store.put(id, at); }
    };
    markProjectRead({
      projectId: 'alpha', store: spy, unread: previewUnread(store, 'alpha'), now: NOW
    });
    assert.deepEqual(puts, ['alpha']);
  } finally { store.close(); }
}));

test('#140 浏览定位屏 / 切换 / 刷新都不推进水位，排序在依次浏览多行后不倒', () => withDb(async (dbPath) => {
  const store = new MemoryWatermarkStore({ dbPath });
  try {
    for (const id of ['alpha', 'beta', 'gamma']) store.put(id, OLD);
    const first = locateViewOf(store, ['alpha', 'beta', 'gamma']);
    const order = first.projects.map((row) => row.projectId);
    assert.deepEqual(order, ['alpha', 'beta', 'gamma']);

    // 依次「浏览」每一行（读注意力数据）并刷新整屏：水位一次都不能动。
    for (let i = 0; i < 5; i += 1) {
      const refreshed = locateViewOf(store, ['alpha', 'beta', 'gamma']);
      assert.deepEqual(refreshed.projects.map((row) => row.projectId), order, '刷新不能改排序');
      assert.deepEqual(refreshed.projects, first.projects, '同一份数据每次算出的行必须一致');
    }
    assert.deepEqual(store.list().map((row) => row.at), [OLD, OLD, OLD], '刷新与切换不清零未读');
  } finally { store.close(); }
}));

test('#140 `/变化` 仍然先算差异、再推水位：看完后同一批变化不会被自己吃掉', () => withDb(async (dbPath) => {
  const store = new MemoryWatermarkStore({ dbPath });
  try {
    store.put('alpha', OLD);
    const { view, advanced, previousAt } = computeSinceLastSeen({
      projectId: 'alpha', store, commits, dirty: [], events: [], now: NOW
    });
    // 清零点仍是「打开 /变化 并算完」：这次看到的仍是旧水位之后的 1 条提交。
    assert.equal(previousAt, OLD);
    assert.equal(view.counts.commits, 1);
    assert.equal(advanced.at, NOW);
    assert.equal(store.get('alpha').at, NOW);

    const next = computeSinceLastSeen({
      projectId: 'alpha', store, commits, dirty: [], events: [], now: LATER
    });
    assert.equal(next.previousAt, NOW);
    assert.equal(next.view.counts.commits, 0, '上一轮已经看过的提交不会再算新变化');
  } finally { store.close(); }
}));

test('#140 标记已读不需要读库之外的存储，也不会算差异：只碰水位', () => {
  // 最小替身：证明 markProjectRead 不要求 git / 观察员事件 / 候选表，只要求可写水位。
  const rows = new Map([['alpha', { projectId: 'alpha', at: OLD }]]);
  const store = {
    get: (id) => rows.get(id) ?? null,
    put: (id, at) => { const row = { projectId: id, at: String(at) }; rows.set(id, row); return row; }
  };
  const noUnread = { known: false, total: null };
  const mark = markProjectRead({ projectId: 'alpha', store, unread: noUnread, now: NOW });
  assert.equal(mark.changed, true);
  assert.equal(rows.size, 1);
  assert.equal(rows.get('alpha').at, NOW);
});

test('#140 桌面端接线：IPC 只暴露一个显式的标记已读动作，顶栏每行有入口', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const main = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'desktop/preload.cjs'), 'utf8');
  const header = fs.readFileSync(path.join(root, 'desktop/shell-header.cjs'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'desktop/shell.css'), 'utf8');

  assert.match(main, /companion:locate-mark-read/u);
  assert.match(main, /markProjectRead/u, '主进程必须走 since-last-seen 的显式推进入口');

  // 处理函数里不能借道 `/变化`（sinceLastSeenFor 会算差异），也不能写项目目录。
  const handler = main.match(/companion:locate-mark-read[\s\S]*?\n  \}\);/u)?.[0] ?? '';
  assert.ok(handler, '找不到标记已读的 IPC 处理函数');
  assert.equal(handler.includes('sinceLastSeenFor'), false, '标记已读不能打开 /变化 的推进路径');

  assert.match(preload, /locate: Object\.freeze\(\{[\s\S]*?markRead:[\s\S]*?companion:locate-mark-read/u);
  assert.match(header, /标记已读/u);
  assert.match(header, /markRead/u);
  assert.match(css, /\.locate-mark-read/u);
});
