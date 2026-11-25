// #83 变化窗口视图模型：给一份项目的 git 事实与上次水位，断言三类变化、空态与时间边界。
// 只断言模型，不断言 DOM；不读盘、不读库、不碰 Electron。
import test from 'node:test';
import assert from 'node:assert/strict';
import { changeWindowView } from '../src/memory/change-window.mjs';

const SINCE = '2026-11-01T00:00:00.000Z';
const BLOCK_KEYS = ['commits', 'dirty', 'events'];
const BLOCK_TITLES = ['新提交', '未提交改动', '观察员事件'];

const commit = ({ sha, subject = '', at }) => ({ sha, subject: subject || `提交 ${sha}`, committedAt: at });
const dirtyFile = ({ path, status = 'M' }) => ({ path, status });
const event = ({ id, type = 'stale', at, projectId }) => ({ id, type, detectedAt: at, projectId });

const blocksByKey = (view) => Object.fromEntries(view.blocks.map((block) => [block.key, block]));

test('三类变化各自可见，计数只算水位之后的', () => {
  const view = changeWindowView({
    projectId: 'alpha',
    since: SINCE,
    commits: [
      commit({ sha: 'old11111', subject: '水位之前', at: '2026-10-20T10:00:00.000Z' }),
      commit({ sha: 'new22222', subject: '新的提交', at: '2026-11-02T10:00:00.000Z' }),
      commit({ sha: 'new33333', subject: '更新的提交', at: '2026-11-05T10:00:00.000Z' })
    ],
    dirty: [dirtyFile({ path: 'src/a.mjs' })],
    events: [
      event({ id: 'e1', type: 'stale', at: '2026-11-03T00:00:00.000Z' }),
      event({ id: 'e2', type: 'drift', at: '2026-10-25T00:00:00.000Z' }),
      event({ id: 'e3', type: 'stale', at: '2026-11-04T00:00:00.000Z' })
    ]
  });

  assert.equal(view.projectId, 'alpha');
  assert.equal(view.status, 'ok');
  assert.equal(view.since, SINCE);
  assert.equal(view.empty, false);
  assert.equal(view.emptyText, '');
  assert.deepEqual(view.blocks.map((block) => block.key), BLOCK_KEYS);
  assert.deepEqual(view.blocks.map((block) => block.title), BLOCK_TITLES);
  assert.deepEqual(view.counts, { commits: 2, dirty: 1, events: 2, total: 5 });

  const blocks = blocksByKey(view);
  for (const key of BLOCK_KEYS) {
    assert.equal(blocks[key].count, view[key].length);
    assert.equal(blocks[key].empty, false);
    assert.deepEqual(blocks[key].items, view[key]);
  }
  // 时间倒序：同一份输入每次渲染顺序一致。
  assert.deepEqual(view.commits.map((item) => item.sha), ['new33333', 'new22222']);
  assert.deepEqual(view.events.map((item) => item.id), ['e3', 'e1']);
  assert.equal(view.commits[0].title, '更新的提交');
  assert.equal(view.events[0].typeLabel, '停滞');

  // 水位之前的不算变化，但保留条目与原因，不静默丢弃。
  assert.deepEqual(view.ignored.counts, { commits: 1, dirty: 0, events: 1, total: 2 });
  assert.deepEqual(view.ignored.items.map((item) => item.reason), ['before-watermark', 'before-watermark']);
  assert.deepEqual(view.unknown.counts, { commits: 0, dirty: 0, events: 0, total: 0 });
});

test('窗口为空：明确空态与一句文案，不返回空数组让人猜', () => {
  const view = changeWindowView({ projectId: 'alpha', since: SINCE, commits: [], dirty: [], events: [] });

  assert.equal(view.status, 'ok');
  assert.equal(view.empty, true);
  assert.ok(view.emptyText.length > 0);
  assert.equal(view.unknownText, '');
  assert.deepEqual(view.counts, { commits: 0, dirty: 0, events: 0, total: 0 });
  for (const block of view.blocks) {
    assert.equal(block.empty, true);
    assert.equal(block.count, 0);
    assert.deepEqual(block.items, []);
    assert.ok(block.emptyHint);
    assert.equal(block.probe.ok, true);
  }
});

test('水位边界：等于水位的已看过，晚一毫秒的才算变化', () => {
  const view = changeWindowView({
    since: SINCE,
    commits: [
      commit({ sha: 'exact000', at: SINCE }),
      commit({ sha: 'later000', at: '2026-11-01T00:00:00.001Z' })
    ],
    dirty: [],
    events: [
      event({ id: 'exact', at: SINCE }),
      event({ id: 'later', at: '2026-11-01T00:00:01.000Z' })
    ]
  });

  assert.deepEqual(view.commits.map((item) => item.sha), ['later000']);
  assert.deepEqual(view.events.map((item) => item.id), ['later']);
  assert.deepEqual(view.ignored.counts, { commits: 1, dirty: 0, events: 1, total: 2 });
  assert.equal(view.empty, false);
});

test('时间认不出来的条目进「未知」，不当成没有变化', () => {
  const view = changeWindowView({
    since: SINCE,
    commits: [{ sha: 'no-time0', subject: '没有时间' }],
    dirty: [],
    events: [{ id: 'e-time', type: 'drift' }]
  });

  assert.equal(view.counts.total, 0);
  assert.equal(view.status, 'unknown');
  assert.equal(view.empty, false, '有认不出的条目时不能报空窗口');
  assert.match(view.unknownText, /认不出时间/);
  assert.deepEqual(view.unknown.counts, { commits: 1, dirty: 0, events: 1, total: 2 });
  assert.deepEqual(view.unknown.items.map((item) => item.category).sort(), ['commits', 'events']);
  assert.ok(view.unknown.items.every((item) => item.reason === 'no-time'));
  // 条目本身仍然可见，只是没算进「变化」。
  assert.equal(view.unknown.items.find((item) => item.category === 'commits').title, '没有时间');
});

test('输入缺失不抛栈：降级为未知，而不是没有变化', () => {
  const view = changeWindowView();

  assert.equal(view.status, 'unknown');
  assert.equal(view.empty, false);
  assert.equal(view.emptyText, '');
  assert.equal(view.since, '');
  assert.equal(view.watermark.known, false);
  assert.match(view.unknownText, /算不全/);
  assert.deepEqual(view.counts, { commits: 0, dirty: 0, events: 0, total: 0 });
  for (const block of view.blocks) {
    assert.equal(block.probe.ok, false);
    assert.equal(block.count, 0);
    assert.ok(block.emptyHint, '读不到时也要有一句说明');
  }
  // 读不到提交清单时的空态文案不能是「没有新提交」。
  assert.match(blocksByKey(view).commits.emptyHint, /无法判断/);
});

test('形状异常不抛栈：非数组清单与畸形条目都归未知', () => {
  const view = changeWindowView({
    since: SINCE,
    commits: 'not-a-list',
    dirty: 42,
    events: {}
  });

  assert.equal(view.status, 'unknown');
  assert.equal(view.probes.commits.reason, 'unavailable');
  assert.equal(view.probes.dirty.reason, 'unavailable');
  assert.equal(view.probes.events.reason, 'unavailable');

  const mixed = changeWindowView({
    since: SINCE,
    commits: [null, 7, { sha: 'ok000000', subject: '正常', committedAt: '2026-11-02T00:00:00.000Z' }],
    dirty: [null, '', { path: 'src/b.mjs' }],
    events: [{ type: 'stale' }]
  });

  assert.deepEqual(mixed.commits.map((item) => item.sha), ['ok000000']);
  assert.deepEqual(mixed.dirty.map((item) => item.path), ['src/b.mjs']);
  // 四条形状读不懂（两个提交、两个改动），一条认不出时间（{ type } 没有发现时间）。
  assert.equal(mixed.unknown.counts.total, 5);
  assert.deepEqual(mixed.unknown.items.map((item) => item.reason).sort(),
    ['malformed', 'malformed', 'malformed', 'malformed', 'no-time']);
  assert.equal(mixed.status, 'unknown');
});

test('没有水位：提交与事件归未知，未提交改动仍然可见', () => {
  const view = changeWindowView({
    projectId: 'alpha',
    commits: [commit({ sha: 'abc00000', at: '2026-11-02T00:00:00.000Z' })],
    dirty: [dirtyFile({ path: 'src/a.mjs' })],
    events: [event({ id: 'e1', at: '2026-11-03T00:00:00.000Z' })]
  });

  assert.equal(view.status, 'unknown');
  assert.equal(view.since, '');
  assert.equal(view.probes.commits.reason, 'no-watermark');
  assert.equal(view.probes.dirty.ok, true);
  assert.deepEqual(view.dirty.map((item) => item.path), ['src/a.mjs']);
  assert.deepEqual(view.unknown.counts, { commits: 1, dirty: 0, events: 1, total: 2 });
  assert.ok(view.unknown.items.every((item) => item.reason === 'no-watermark'));
  assert.match(blocksByKey(view).commits.emptyHint, /水位/);
});

test('不接受的时间格式不猜：ISO / Date / 毫秒时间戳都认', () => {
  const view = changeWindowView({
    since: new Date('2026-11-01T00:00:00.000Z'),
    commits: [
      { sha: 'iso00000', subject: 'ISO', at: '2026-11-02T00:00:00.000Z' },
      { sha: 'date0000', subject: 'Date', committedAt: new Date('2026-11-03T00:00:00.000Z') },
      { sha: 'epoch000', subject: 'epoch', date: Date.parse('2026-11-04T00:00:00.000Z') }
    ],
    dirty: [],
    events: [{ id: 'e1', type: 'drift', occurred_at: '2026-11-05T00:00:00.000Z' }]
  });

  assert.equal(view.status, 'ok');
  assert.equal(view.since, SINCE);
  assert.deepEqual(view.commits.map((item) => item.sha), ['epoch000', 'date0000', 'iso00000']);
  assert.deepEqual(view.commits.map((item) => item.at), [
    '2026-11-04T00:00:00.000Z',
    '2026-11-03T00:00:00.000Z',
    '2026-11-02T00:00:00.000Z'
  ]);
  assert.deepEqual(view.events.map((item) => item.id), ['e1']);
});

test('其他项目的事件不算这个项目的变化，但计入忽略', () => {
  const view = changeWindowView({
    projectId: 'alpha',
    since: SINCE,
    commits: [],
    dirty: [],
    events: [
      event({ id: 'mine', at: '2026-11-02T00:00:00.000Z', projectId: 'alpha' }),
      event({ id: 'other', at: '2026-11-02T00:00:00.000Z', projectId: 'beta' })
    ]
  });

  assert.deepEqual(view.events.map((item) => item.id), ['mine']);
  assert.equal(view.counts.total, 1);
  assert.equal(view.ignored.counts.events, 1);
  assert.equal(view.ignored.items[0].reason, 'other-project');
  assert.equal(view.status, 'ok', '别的项目的事件不该把本项目的窗口标成未知');
});
