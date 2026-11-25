// #84 「自上次看过」：先算差异、再推水位（顺序是这张票的核心），以及面板那一段的形态
// （首次查看 / 三类全空压成一行 / 算不全保留原因）。纯函数 + 临时库，不碰 Electron。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryWatermarkStore } from '../src/memory/watermark.mjs';
import { computeSinceLastSeen, sinceSeenSection } from '../src/memory/since-last-seen.mjs';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'since-seen-test-'));

const withDb = async (fn) => {
  const dir = makeTempDir();
  try { return await fn(path.join(dir, 'owner.sqlite')); } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
};

const commit = ({ sha, subject, at }) => ({ sha, subject, at });
const dirty = (filePath, status = 'M') => ({ path: filePath, status });
const event = ({ id, at, type = 'stale', projectId = 'alpha' }) => ({ id, type, detectedAt: at, projectId });

const OLD = '2026-11-01T00:00:00.000Z';
const NOW = '2026-11-10T00:00:00.000Z';

const FACTS = {
  commits: [
    commit({ sha: 'old11111', subject: '水位之前', at: '2026-10-20T10:00:00.000Z' }),
    commit({ sha: 'edge0000', subject: '正好在水位上', at: OLD }),
    commit({ sha: 'new22222', subject: '新的提交', at: '2026-11-05T10:00:00.000Z' })
  ],
  dirty: [dirty('src/a.mjs')],
  events: [event({ id: 'e1', at: '2026-11-06T00:00:00.000Z' })]
};

test('先算后推：差异用的是旧水位，推完之后同一批事实算不出变化', () => withDb(async (dbPath) => {
  const store = new MemoryWatermarkStore({ dbPath });
  try {
    store.put('alpha', OLD);
    const calls = [];
    const spy = {
      get: (id) => { calls.push(['get', id]); return store.get(id); },
      put: (id, at) => { calls.push(['put', id, at]); return store.put(id, at); }
    };

    const first = computeSinceLastSeen({ projectId: 'alpha', store: spy, ...FACTS, now: NOW });
    // ① 差异按旧水位算：两个新条目（1 提交 + 1 未提交），正好落在水位上的那条不算新。
    assert.equal(first.view.since, OLD);
    assert.equal(first.previousAt, OLD);
    assert.equal(first.view.counts.commits, 1);
    assert.equal(first.view.commits[0].sha, 'new22222');
    assert.equal(first.view.counts.dirty, 1);
    assert.equal(first.view.counts.events, 1);
    // ② 返回前才推进：store 已经是 NOW，而 view 用的仍是 OLD。
    assert.equal(store.get('alpha').at, NOW);
    assert.equal(first.advanced.at, NOW);
    // ③ 顺序就是 get → put；中间没有提前推进。
    assert.deepEqual(calls.map((call) => call[0]), ['get', 'put']);
    assert.equal(first.view.checkedAt, NOW);

    // ④ 再进来（同一批事实、水位已推到 NOW）：提交与事件都不算新了，空态文案。
    // 未提交改动没有时间戳，工作区里还在就算变化（#83 的既定规则），所以这里给它空清单。
    const second = computeSinceLastSeen({
      projectId: 'alpha',
      store,
      commits: FACTS.commits,
      dirty: [],
      events: FACTS.events,
      now: NOW
    });
    assert.equal(second.view.since, NOW);
    assert.equal(second.view.status, 'ok');
    assert.equal(second.view.empty, true);
    assert.equal(second.view.counts.total, 0);

    // ⑤ 工作区还脏时不算空：这是有意的——文件确实还没提交，不能说「都看过了」。
    const stillDirty = computeSinceLastSeen({
      projectId: 'alpha',
      store,
      commits: FACTS.commits,
      dirty: FACTS.dirty,
      events: FACTS.events,
      now: NOW
    });
    assert.equal(stillDirty.view.empty, false);
    assert.equal(stillDirty.view.counts.dirty, 1);
    assert.equal(stillDirty.view.counts.commits, 0);
  } finally { store.close(); }
}));

test('水位按项目隔离：看过 A 不改变 B 的窗口', () => withDb(async (dbPath) => {
  const store = new MemoryWatermarkStore({ dbPath });
  try {
    store.put('beta', OLD);
    computeSinceLastSeen({ projectId: 'alpha', store, ...FACTS, now: NOW });
    assert.equal(store.get('alpha').at, NOW);
    assert.equal(store.get('beta').at, OLD);
    // B 还是旧水位：同一批事实对 B 仍算变化，虽然事件里标的是 alpha，事件会被归到别的项目。
    const beta = computeSinceLastSeen({
      projectId: 'beta',
      store,
      commits: FACTS.commits,
      dirty: FACTS.dirty,
      events: [],
      now: NOW
    });
    assert.equal(beta.view.counts.commits, 1);
  } finally { store.close(); }
}));

test('没有水位时按「首次查看」：不写「没有变化」，未提交改动照常列', () => withDb(async (dbPath) => {
  const store = new MemoryWatermarkStore({ dbPath });
  try {
    const { view, previousAt } = computeSinceLastSeen({
      projectId: 'alpha', store, ...FACTS, now: NOW
    });
    assert.equal(previousAt, '');
    assert.equal(view.watermark.known, false);
    // change-window 不知道哪些提交/事件是新的，但不会说「都看过了」。
    assert.equal(view.status, 'unknown');
    assert.equal(view.empty, false);

    const section = sinceSeenSection(view);
    assert.equal(section.firstView, true);
    assert.equal(section.headline, '首次查看');
    assert.equal(section.compressed, false);
    assert.match(section.line, /首次查看/u);
    assert.doesNotMatch(section.line, /没有新变化|都看过了/u);
    assert.equal(section.note, '');
    // 未提交改动不依赖水位，是当下的工作区，照常列。
    assert.deepEqual(section.groups.map((group) => group.key), ['dirty']);
    assert.equal(section.groups[0].items[0].text, 'M src/a.mjs');
  } finally { store.close(); }
}));

test('三类全空压成一行：compressed 且不给分组，文案里不出现「算不全」', () => withDb(async (dbPath) => {
  const store = new MemoryWatermarkStore({ dbPath });
  try {
    store.put('alpha', NOW);
    const { view } = computeSinceLastSeen({
      projectId: 'alpha',
      store,
      commits: [commit({ sha: 'old11111', subject: '早看过了', at: '2026-10-20T10:00:00.000Z' })],
      dirty: [],
      events: [],
      now: NOW
    });
    assert.equal(view.status, 'ok');
    assert.equal(view.empty, true);

    const section = sinceSeenSection(view);
    assert.equal(section.compressed, true);
    assert.equal(section.firstView, false);
    assert.equal(section.headline, '自上次看过');
    assert.equal(section.groups.length, 0);
    assert.equal(section.total, 0);
    assert.match(section.compactLine, /^自上次看过 · /u);
    assert.match(section.compactLine, /没有新变化/u);
    assert.equal(section.note, '');
  } finally { store.close(); }
}));

test('算不全时不当成「没有变化」：保留原因，且不压成一行', () => withDb(async (dbPath) => {
  const store = new MemoryWatermarkStore({ dbPath });
  try {
    store.put('alpha', OLD);
    const { view } = computeSinceLastSeen({
      projectId: 'alpha',
      store,
      commits: FACTS.commits,
      dirty: [dirty('src/a.mjs')],
      events: null, // 观察员事件读不到
      now: NOW
    });
    assert.equal(view.status, 'unknown');
    assert.equal(view.empty, false);

    const section = sinceSeenSection(view);
    assert.equal(section.compressed, false);
    assert.equal(section.firstView, false);
    assert.match(section.note, /算不全/u);
    assert.match(section.note, /观察员事件/u);
    // 能算的照常列：提交与未提交改动都在。
    assert.deepEqual(section.groups.map((group) => group.key), ['commits', 'dirty']);
    assert.equal(section.groups[0].items[0].text, 'new22222 新的提交');
  } finally { store.close(); }
}));

test('分组最多列 8 条，剩下的只报数', () => {
  const section = sinceSeenSection({
    watermark: { known: true, at: OLD },
    status: 'ok',
    since: OLD,
    counts: { commits: 11, dirty: 0, events: 0, total: 11 },
    blocks: [{
      key: 'commits',
      title: '新提交',
      count: 11,
      empty: false,
      items: Array.from({ length: 11 }, (_, index) => ({
        kind: 'commit',
        id: `s${index}`,
        sha: `s${index}`,
        shortSha: `s${index}`,
        title: `提交 ${index}`,
        at: '2026-11-05T10:00:00.000Z'
      }))
    }],
    empty: false,
    emptyText: ''
  });
  assert.equal(section.groups[0].items.length, 8);
  assert.equal(section.groups[0].count, 11);
  assert.equal(section.groups[0].more, 3);
});

test('缺存储或项目 id 时明确报错，不静默写半个水位', () => withDb(async (dbPath) => {
  const store = new MemoryWatermarkStore({ dbPath });
  try {
    assert.throws(() => computeSinceLastSeen({ projectId: '', store }), /缺少项目 id/);
    assert.throws(() => computeSinceLastSeen({ projectId: 'alpha', store: null }), /缺少水位存储/);
    assert.deepEqual(store.list(), []);
  } finally { store.close(); }
}));
