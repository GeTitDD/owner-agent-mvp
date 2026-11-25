// #118 心跳只做「发现」：给上次水位与一次快照，算出新增 / 修改 / 删除，写进变更队列，
// 并出一张变化卡。不读文件内容、不调模型、不写项目目录。
//
// 测的都是接缝：纯函数只看「这两个输入算出什么」，编排只看「先后顺序」与「队列只入一次」。
// 快照全部是假数据（本轮只接本地 git 提交列表这一种来源），时钟与时间点全部注入。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  diffHeartbeat,
  heartbeatCard,
  HEARTBEAT_EMPTY_TEXT
} from '../src/watch/heartbeat.mjs';
import { runHeartbeat } from '../src/watch/heartbeat-run.mjs';
import { WatchStateStore, WATCH_DB_NAME } from '../src/watch/store.mjs';

const withTemp = async (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-heartbeat-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
};

/** 上次水位：写死一个时刻，边界测试才好读。 */
const WATERMARK = '2026-11-20T10:00:00.000Z';
const project = (projectId = 'alpha') => ({ type: 'project', projectId });

/** 一条提交：快照里最普通的条目，没有声明状态，出现即「新增」。 */
const commitOf = (sha, at, subject = '') => ({ sha, at, subject });

/** 一条带 git 状态的条目：A/M/D 是「这次快照自己声明的类」。 */
const entryOf = (id, at, status) => ({ id, at, status });

/** 混合快照：三类各一条，另加一条已看过、一条重复。 */
const mixedSnapshot = () => ({
  at: '2026-11-20T11:00:00.000Z',
  commits: [commitOf('aaaaaaaa1111', '2026-11-20T10:30:00.000Z', '补上心跳')],
  entries: [
    entryOf('src/a.mjs', '2026-11-20T10:40:00.000Z', 'M'),
    entryOf('src/b.mjs', '2026-11-20T10:50:00.000Z', 'D'),
    // 恰好等于水位 / 早于水位：都已看过，不算变化。
    entryOf('src/old.mjs', WATERMARK, 'A'),
    entryOf('src/ancient.mjs', '2026-11-19T09:00:00.000Z', 'M')
  ]
});

test('三类各一条：提交算新增，带状态的条目按声明的类落桶', () => {
  const diff = diffHeartbeat(WATERMARK, mixedSnapshot());
  assert.equal(diff.status, 'ok');
  assert.equal(diff.empty, false);
  assert.equal(diff.emptyText, '');
  assert.deepEqual(diff.added.map((item) => item.id), ['aaaaaaaa1111']);
  assert.deepEqual(diff.modified.map((item) => item.id), ['src/a.mjs']);
  assert.deepEqual(diff.deleted.map((item) => item.id), ['src/b.mjs']);
  assert.deepEqual(diff.unknown, []);
  assert.deepEqual(diff.counts, {
    added: 1, modified: 1, deleted: 1, unknown: 0, total: 3, seen: 2, duplicates: 0
  });
  // 条目带得上「是什么、什么时候」：变化卡要用，整理阶段也用。
  const [added] = diff.added;
  assert.equal(added.kind, 'added');
  assert.equal(added.at, '2026-11-20T10:30:00.000Z');
  assert.match(added.label, /aaaaaaaa 补上心跳/u);
});

test('水位边界：恰好等于水位的事件算已看过，不晚于水位的一律不算变化', () => {
  const diff = diffHeartbeat(WATERMARK, mixedSnapshot());
  const everything = [...diff.added, ...diff.modified, ...diff.deleted, ...diff.unknown]
    .map((item) => item.id);
  assert.equal(everything.includes('src/old.mjs'), false);
  assert.equal(everything.includes('src/ancient.mjs'), false);
  assert.equal(diff.counts.seen, 2);
});

test('空窗口给明确空态，不是「返回空数组」了事', () => {
  const diff = diffHeartbeat(WATERMARK, {
    commits: [commitOf('seen-1', '2026-11-20T09:00:00.000Z', '早就看过')]
  });
  assert.equal(diff.status, 'ok');
  assert.equal(diff.empty, true);
  assert.equal(diff.emptyText, HEARTBEAT_EMPTY_TEXT);
  assert.equal(diff.unknownText, '');
  assert.equal(diff.counts.total, 0);
  assert.deepEqual([diff.added, diff.modified, diff.deleted], [[], [], []]);
});

test('没有水位：一律未知，绝不拿空水位把历史当成新增', () => {
  const diff = diffHeartbeat(null, mixedSnapshot());
  assert.equal(diff.status, 'unknown');
  assert.equal(diff.empty, false);
  assert.equal(diff.emptyText, '');
  assert.equal(diff.counts.total, 0);
  assert.equal(diff.unknown.length, 5);
  assert.deepEqual([...new Set(diff.unknown.map((item) => item.reason))], ['no-watermark']);
  assert.match(diff.unknownText, /没有上次水位/u);
});

test('条目没有可解析的时间：标未知，不当成看过也不当成新变化', () => {
  const diff = diffHeartbeat(WATERMARK, {
    entries: [entryOf('src/no-time.mjs', '', 'M'), entryOf('src/fine.mjs', '2026-11-20T10:30:00.000Z', 'A')]
  });
  const [unknown] = diff.unknown;
  assert.equal(unknown.id, 'src/no-time.mjs');
  assert.equal(unknown.reason, 'no-time');
  assert.equal(diff.status, 'unknown');
  assert.match(diff.unknownText, /1 条条目认不出时间或形状/u);
  // 同批里能算的照常算，不会被一条坏条目拖成整批丢弃。
  assert.deepEqual(diff.added.map((item) => item.id), ['src/fine.mjs']);
  assert.equal(diff.counts.total, 1);
});

test('同一批变化不重复计数：同 kind + id + 时间只算一条，重复的只报个数', () => {
  const diff = diffHeartbeat(WATERMARK, {
    entries: [
      entryOf('src/a.mjs', '2026-11-20T10:30:00.000Z', 'M'),
      entryOf('src/a.mjs', '2026-11-20T10:30:00.000Z', 'M'),
      // 同一个文件在另一刻又改了一次：两次是真变化，不能被压成一条。
      entryOf('src/a.mjs', '2026-11-20T10:40:00.000Z', 'M')
    ]
  });
  assert.equal(diff.counts.modified, 2);
  assert.equal(diff.counts.duplicates, 1);
  assert.deepEqual(diff.modified.map((item) => item.at), [
    '2026-11-20T10:40:00.000Z',
    '2026-11-20T10:30:00.000Z'
  ]);
});

test('形状读不懂的条目进未知：没 id、没时间、没声明类都算', () => {
  const diff = diffHeartbeat(WATERMARK, {
    entries: [
      { at: '2026-11-20T10:30:00.000Z' },
      entryOf('src/x.mjs', '2026-11-20T10:30:00.000Z', 'Q')
    ]
  });
  assert.deepEqual(diff.unknown.map((item) => item.reason).sort(), ['malformed', 'unknown-kind']);
  assert.equal(diff.counts.unknown, 2);
});

test('快照拿不到：算不全，不能压成「没有变化」', () => {
  for (const snapshot of [null, {}, { complete: false }]) {
    const diff = diffHeartbeat(WATERMARK, snapshot);
    assert.equal(diff.status, 'unknown', `snapshot=${JSON.stringify(snapshot)}`);
    assert.equal(diff.empty, false);
    assert.equal(diff.probe.ok, false);
    assert.match(diff.unknownText, /不能当成「没有变化」/u);
  }
  // 快照声明「这次没取全」，即使带了条目也不能当真。
  const partial = diffHeartbeat(WATERMARK, { ...mixedSnapshot(), complete: false });
  assert.equal(partial.counts.total, 0);
  assert.equal(partial.probe.reason, 'snapshot-unavailable');
});

test('变化卡的数据形状：对象、时间、三类计数与条目都在，且不含 HTML', () => {
  const diff = diffHeartbeat(WATERMARK, mixedSnapshot());
  const card = heartbeatCard({ target: project(), at: '2026-11-20T11:05:00.000Z', diff });

  assert.equal(card.kind, 'change');
  assert.equal(card.target.ref, 'project:alpha');
  assert.equal(card.target.type, 'project');
  assert.equal(card.target.label, 'alpha');
  assert.equal(card.at, '2026-11-20T11:05:00.000Z');
  assert.equal(card.since, WATERMARK);
  assert.deepEqual(card.counts, diff.counts);
  assert.deepEqual(card.blocks.map((block) => block.key), ['added', 'modified', 'deleted']);
  assert.deepEqual(card.blocks.map((block) => block.count), [1, 1, 1]);
  assert.deepEqual(card.blocks[0].items.map((item) => item.id), ['aaaaaaaa1111']);
  assert.equal(card.empty, false);
  // 数据形状只给结构化字段：UI 由 #109/#111 画，这一张不产出 HTML。
  assert.equal(JSON.stringify(card).includes('<'), false);
});

test('空窗口的变化卡带明确空态文案', () => {
  const diff = diffHeartbeat(WATERMARK, { commits: [] });
  const card = heartbeatCard({ target: project(), at: WATERMARK, diff });
  assert.equal(card.empty, true);
  assert.equal(card.emptyText, HEARTBEAT_EMPTY_TEXT);
  assert.deepEqual(card.blocks.map((block) => block.empty), [true, true, true]);
  assert.equal(card.blocks[0].items.length, 0);
});

test('心跳跑一次：三类变化入队，轮末才把水位与心跳时间推到快照时刻', () => withTemp(async (root) => {
  const store = new WatchStateStore({ dir: path.join(root, 'watch') });
  const target = project();
  try {
    store.setWatermark(target, WATERMARK);
    const result = runHeartbeat({
      store, target, snapshot: mixedSnapshot(), at: '2026-11-20T11:05:00.000Z'
    });
    assert.deepEqual(result.queued.map((row) => [row.kind, row.ref]), [
      ['added', 'aaaaaaaa1111'],
      ['modified', 'src/a.mjs'],
      ['deleted', 'src/b.mjs']
    ]);
    assert.deepEqual(store.listChanges(target).map((row) => row.kind), ['added', 'modified', 'deleted']);
    // 水位推到快照时刻（11:00），不是心跳时刻（11:05）：拍完快照之后落地的提交不能被算成看过。
    assert.equal(result.watermark.at, '2026-11-20T11:00:00.000Z');
    assert.equal(store.getWatermark(target).at, '2026-11-20T11:00:00.000Z');
    assert.equal(store.getHeartbeat(target).at, '2026-11-20T11:05:00.000Z');
    assert.equal(result.card.at, '2026-11-20T11:05:00.000Z');
    assert.equal(result.card.queuedCount, 3);
  } finally { store.close(); }
}));

test('先算后推：推进后再跑同一份快照，结果为空、队列不再增长', () => withTemp(async (root) => {
  const store = new WatchStateStore({ dir: path.join(root, 'watch') });
  const target = project();
  try {
    store.setWatermark(target, WATERMARK);
    const first = runHeartbeat({
      store, target, snapshot: mixedSnapshot(), at: '2026-11-20T11:05:00.000Z'
    });
    assert.equal(first.diff.counts.total, 3);
    assert.equal(first.queued.length, 3);
    assert.equal(first.advanced.at, '2026-11-20T11:00:00.000Z');

    const second = runHeartbeat({
      store, target, snapshot: mixedSnapshot(), at: '2026-11-20T11:10:00.000Z'
    });
    assert.equal(second.diff.empty, true, '水位推进后同一批变化应该算已看过');
    assert.equal(second.diff.counts.total, 0);
    assert.deepEqual(second.queued, []);
    assert.deepEqual(store.listChanges(target).map((row) => row.kind), ['added', 'modified', 'deleted']);
  } finally { store.close(); }
}));

test('不推进水位时重跑：同一批变化只入队一次', () => withTemp(async (root) => {
  const store = new WatchStateStore({ dir: path.join(root, 'watch') });
  const target = project();
  try {
    store.setWatermark(target, WATERMARK);
    const first = runHeartbeat({
      store, target, snapshot: mixedSnapshot(), at: '2026-11-20T11:05:00.000Z', advance: false
    });
    const second = runHeartbeat({
      store, target, snapshot: mixedSnapshot(), at: '2026-11-20T11:06:00.000Z', advance: false
    });
    assert.equal(first.queued.length, 3);
    assert.deepEqual(second.queued, []);
    assert.equal(second.card.counts.total, 3, '卡说的是这次发现了几条');
    assert.equal(second.card.queuedCount, 0, '但这次一条也没新入队');
    assert.equal(store.listChanges(target).length, 3);
    assert.equal(store.getWatermark(target).at, WATERMARK);
  } finally { store.close(); }
}));

test('顺序写死：读水位 → 算差异 → 入队 → 推进水位 → 记心跳', () => withTemp(async (root) => {
  const real = new WatchStateStore({ dir: path.join(root, 'watch') });
  const target = project();
  const calls = [];
  const watermarkSeenByQueue = [];
  const spy = {
    getWatermark: (t) => { calls.push('getWatermark'); return real.getWatermark(t); },
    appendChanges: (t, changes) => {
      calls.push('appendChanges');
      watermarkSeenByQueue.push(real.getWatermark(t)?.at ?? null);
      return real.appendChanges(t, changes);
    },
    setWatermark: (t, at) => { calls.push('setWatermark'); return real.setWatermark(t, at); },
    markHeartbeat: (t, options) => { calls.push('markHeartbeat'); return real.markHeartbeat(t, options); },
    listChanges: (t, options) => real.listChanges(t, options)
  };
  try {
    real.setWatermark(target, WATERMARK);
    runHeartbeat({ store: spy, target, snapshot: mixedSnapshot(), at: '2026-11-20T11:05:00.000Z' });
    assert.deepEqual(calls, ['getWatermark', 'appendChanges', 'setWatermark', 'markHeartbeat']);
    // 入队那一刻水位还是旧的：先算后推不是靠注释保证的。
    assert.deepEqual(watermarkSeenByQueue, [WATERMARK]);
  } finally { real.close(); }
}));

test('快照算不了时不推进水位、不入队：下次还得重新看这一段', () => withTemp(async (root) => {
  const store = new WatchStateStore({ dir: path.join(root, 'watch') });
  const target = project();
  try {
    store.setWatermark(target, WATERMARK);
    const result = runHeartbeat({
      store, target, snapshot: { complete: false }, at: '2026-11-20T11:05:00.000Z'
    });
    assert.equal(result.advanced, null);
    assert.deepEqual(result.queued, []);
    assert.equal(store.getWatermark(target).at, WATERMARK);
    assert.equal(result.card.status, 'unknown');
    assert.match(result.card.unknownText, /算不全/u);
    // 心跳时间照记：界面要知道「它跑过」，只是这一轮什么也没算成。
    assert.equal(store.getHeartbeat(target).at, '2026-11-20T11:05:00.000Z');
  } finally { store.close(); }
}));

test('心跳不读文件内容、不写项目目录：快照只带路径，项目根一个文件都不动', () => withTemp(async (root) => {
  const projectRoot = path.join(root, 'repo');
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'README.md'), '# alpha\n');
  fs.writeFileSync(path.join(projectRoot, 'src', 'a.mjs'), 'export const a = 1;\n');
  const before = fs.readdirSync(projectRoot, { recursive: true }).sort();
  const beforeStats = fs.statSync(path.join(projectRoot, 'src', 'a.mjs'));

  const watchDir = path.join(root, 'own', 'watch');
  const store = new WatchStateStore({ dir: watchDir });
  const target = { type: 'project', projectId: 'alpha', root: projectRoot };
  try {
    store.setWatermark(target, WATERMARK);
    // 快照里只有元数据（路径 + 时间 + 状态），路径指向哪里都无所谓：心跳不该去打开它。
    runHeartbeat({
      store,
      target,
      snapshot: {
        entries: [
          entryOf('src/a.mjs', '2026-11-20T10:30:00.000Z', 'M'),
          entryOf('src/missing.mjs', '2026-11-20T10:31:00.000Z', 'A')
        ]
      },
      at: '2026-11-20T11:05:00.000Z'
    });
  } finally { store.close(); }

  assert.deepEqual(fs.readdirSync(projectRoot, { recursive: true }).sort(), before);
  assert.equal(fs.statSync(path.join(projectRoot, 'src', 'a.mjs')).mtimeMs, beforeStats.mtimeMs);
  // 状态还是只落在自有目录那一份库里。
  assert.deepEqual(fs.readdirSync(watchDir), [WATCH_DB_NAME]);
}));

test('三类对象都能出卡：会话与 GitHub 用各自的显示名', () => {
  const diff = diffHeartbeat(WATERMARK, { commits: [commitOf('abcdef12', '2026-11-20T10:30:00.000Z')] });
  const session = heartbeatCard({
    target: { type: 'session', source: 'codex', sessionId: 's-1', ref: 'session:codex:s-1' },
    at: WATERMARK,
    diff
  });
  const repo = heartbeatCard({
    target: { type: 'github', owner: 'o', repo: 'r', ref: 'github:o/r', nameWithOwner: 'o/r' },
    at: WATERMARK,
    diff
  });
  assert.equal(session.target.label, 'codex:s-1');
  assert.equal(repo.target.label, 'o/r');
});
