// #117 监控状态外置：水位、变更队列、上次心跳全部落在自有配置根的 watch/ 下，
// 按对象隔离，重开仍在，老库与「目录还不存在」都能直接起来，项目目录一个文件都不留。
// 只用临时目录 + 临时库，不碰真实 ~/.owner-agent 或任何项目。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  WatchStateStore,
  WATCH_DB_NAME,
  WATCH_TABLES,
  CHANGE_KINDS,
  defaultWatchDir
} from '../src/watch/store.mjs';
import { WatchTargetError } from '../src/watch/target.mjs';

const makeTempDir = (prefix = 'watch-test-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** 每个用例一个临时根，结束后删干净（Windows 上句柄释放慢，给几次重试）。 */
const withTemp = async (fn) => {
  const dir = makeTempDir();
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
};

const alpha = { type: 'project', projectId: 'alpha' };
const beta = { type: 'project', projectId: 'beta' };
const session = { type: 'session', source: 'codex', sessionId: 's-1' };
const repo = { type: 'github', owner: 'owner', repo: 'repo', focus: ['commits'] };

test('状态目录不存在也能起来：自己建 watch/，里面只有自己的库', () => withTemp(async (root) => {
  const dir = path.join(root, 'own', 'watch');
  assert.equal(fs.existsSync(dir), false);
  const store = new WatchStateStore({ dir });
  try {
    store.setWatermark(alpha, '2026-11-01T10:00:00.000Z');
    assert.equal(store.getWatermark(alpha).at, '2026-11-01T10:00:00.000Z');
  } finally { store.close(); }
  // 目录由自己创建，且只有一份状态库：没有散落的缓存、日志、临时文件。
  assert.deepEqual(fs.readdirSync(dir), [WATCH_DB_NAME]);
}));

test('三类对象都写得进：水位、心跳、队列各按 ref 归档', () => withTemp(async (root) => {
  const store = new WatchStateStore({ dir: path.join(root, 'watch') });
  const expected = new Map([
    ['project:alpha', alpha],
    ['session:codex:s-1', session],
    ['github:owner/repo', repo]
  ]);
  try {
    for (const [ref, target] of expected) {
      store.setWatermark(target, '2026-11-02T08:00:00.000Z');
      store.markHeartbeat(target, { at: '2026-11-02T08:05:00.000Z', note: '只记发现，不读内容' });
      store.appendChange(target, { kind: 'added', ref: 'item-1', at: '2026-11-02T08:06:00.000Z' });
      const status = store.status(target);
      assert.equal(status.key, ref);
      assert.equal(status.type, target.type);
      assert.equal(status.watermark.at, '2026-11-02T08:00:00.000Z');
      assert.equal(status.heartbeat.at, '2026-11-02T08:05:00.000Z');
      assert.equal(status.queued, 1);
    }
    assert.deepEqual(store.list().map((row) => row.key), [...expected.keys()].sort((a, b) => a.localeCompare(b)));
  } finally { store.close(); }
}));

test('按对象隔离：A 的心跳、水位、队列都不影响 B', () => withTemp(async (root) => {
  const store = new WatchStateStore({ dir: path.join(root, 'watch') });
  try {
    store.setWatermark(alpha, '2026-11-03T09:00:00.000Z');
    store.markHeartbeat(alpha, { at: '2026-11-03T09:01:00.000Z' });
    store.appendChange(alpha, { kind: 'modified', ref: 'src/a.mjs', at: '2026-11-03T09:02:00.000Z' });

    // B 还是空的：没有水位、没有心跳、没有队列。
    assert.equal(store.getWatermark(beta), null);
    assert.equal(store.getHeartbeat(beta), null);
    assert.deepEqual(store.listChanges(beta), []);
    assert.deepEqual({ ...store.status(beta) }, { key: 'project:beta', type: 'project', watermark: null, heartbeat: null, queued: 0 });

    // 推进 B 之后 A 原封不动。
    store.setWatermark(beta, '2026-11-04T09:00:00.000Z');
    store.markHeartbeat(beta, { at: '2026-11-04T09:01:00.000Z' });
    store.appendChange(beta, { kind: 'deleted', ref: 'src/b.mjs', at: '2026-11-04T09:02:00.000Z' });
    assert.equal(store.getWatermark(alpha).at, '2026-11-03T09:00:00.000Z');
    assert.equal(store.getHeartbeat(alpha).at, '2026-11-03T09:01:00.000Z');
    assert.deepEqual(store.listChanges(alpha).map((row) => row.ref), ['src/a.mjs']);
    assert.deepEqual(store.listChanges(beta).map((row) => row.ref), ['src/b.mjs']);

    // 清 A 的队列也不动 B。
    assert.equal(store.clearChanges(alpha), 1);
    assert.deepEqual(store.listChanges(beta).map((row) => row.ref), ['src/b.mjs']);
  } finally { store.close(); }
}));

test('关掉再重开：水位、队列、心跳都还在', () => withTemp(async (root) => {
  const dir = path.join(root, 'watch');
  const first = new WatchStateStore({ dir });
  first.setWatermark(repo, '2026-11-05T07:00:00.000Z');
  first.markHeartbeat(repo, { at: '2026-11-05T07:02:00.000Z' });
  first.appendChange(repo, { kind: 'added', ref: 'pr#12', at: '2026-11-05T07:03:00.000Z', detail: { title: '修好探针' } });
  first.close();

  const reopened = new WatchStateStore({ dir });
  try {
    assert.equal(reopened.getWatermark(repo).at, '2026-11-05T07:00:00.000Z');
    assert.equal(reopened.getHeartbeat(repo).at, '2026-11-05T07:02:00.000Z');
    const [change] = reopened.listChanges(repo);
    assert.equal(change.kind, 'added');
    assert.equal(change.ref, 'pr#12');
    assert.deepEqual(change.detail, { title: '修好探针' });
  } finally { reopened.close(); }
}));

test('老库平滑升级：只补列，旧行与旧表一行不动', () => withTemp(async (root) => {
  const dir = path.join(root, 'watch');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, WATCH_DB_NAME);

  // 模拟早期版本留下的 watch.sqlite：三张表都在，但少了后来加的列。
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE ${WATCH_TABLES.watermarks}(target_key TEXT PRIMARY KEY, watermark_at TEXT NOT NULL);
    CREATE TABLE ${WATCH_TABLES.heartbeats}(target_key TEXT PRIMARY KEY, last_at TEXT NOT NULL);
    CREATE TABLE ${WATCH_TABLES.changes}(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      target_key TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, at TEXT NOT NULL
    );
    INSERT INTO ${WATCH_TABLES.watermarks}(target_key,watermark_at) VALUES('project:alpha','2026-10-01T00:00:00.000Z');
    INSERT INTO ${WATCH_TABLES.heartbeats}(target_key,last_at) VALUES('project:alpha','2026-10-01T00:01:00.000Z');
    INSERT INTO ${WATCH_TABLES.changes}(target_key,kind,ref,at) VALUES('project:alpha','modified','old.mjs','2026-10-01T00:02:00.000Z');
  `);
  legacy.close();

  const store = new WatchStateStore({ dir });
  try {
    // 旧数据照常读出来：升级只建列/补默认值，不重写。
    assert.equal(store.getWatermark(alpha).at, '2026-10-01T00:00:00.000Z');
    assert.equal(store.getHeartbeat(alpha).at, '2026-10-01T00:01:00.000Z');
    const [old] = store.listChanges(alpha);
    assert.equal(old.ref, 'old.mjs');
    assert.deepEqual(old.detail, {});
    // 新列可用。
    store.setWatermark(alpha, '2026-10-02T00:00:00.000Z');
    store.appendChange(alpha, { kind: 'added', ref: 'new.mjs', at: '2026-10-02T00:01:00.000Z' });
    assert.equal(store.getWatermark(alpha).at, '2026-10-02T00:00:00.000Z');
  } finally { store.close(); }

  const check = new DatabaseSync(dbPath);
  try {
    const columnsOf = (table) => check.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
    assert.deepEqual(columnsOf(WATCH_TABLES.watermarks).sort(), ['target_key', 'target_type', 'updated_at', 'watermark_at']);
    assert.deepEqual(columnsOf(WATCH_TABLES.heartbeats).sort(), ['last_at', 'note', 'target_key', 'target_type', 'updated_at']);
    assert.deepEqual(columnsOf(WATCH_TABLES.changes).sort(), ['at', 'detail', 'kind', 'ref', 'seq', 'target_key', 'target_type']);
  } finally { check.close(); }
}));

test('项目目录一个文件都不留：状态只写自有 watch/', () => withTemp(async (root) => {
  const projectRoot = path.join(root, 'repo');
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'README.md'), '# alpha\n');
  fs.writeFileSync(path.join(projectRoot, 'src', 'a.mjs'), 'export const a = 1;\n');
  const before = fs.readdirSync(projectRoot, { recursive: true }).sort();

  const watchDir = path.join(root, 'own', 'watch');
  const store = new WatchStateStore({ dir: watchDir });
  try {
    const target = { type: 'project', projectId: 'alpha', root: projectRoot };
    store.setWatermark(target, '2026-11-06T06:00:00.000Z');
    store.markHeartbeat(target, { at: '2026-11-06T06:01:00.000Z' });
    store.appendChange(target, { kind: 'modified', ref: 'src/a.mjs', at: '2026-11-06T06:02:00.000Z' });
  } finally { store.close(); }

  assert.deepEqual(fs.readdirSync(projectRoot, { recursive: true }).sort(), before);
  // 状态全在自有目录下：项目根之外的那一处。
  assert.equal(fs.existsSync(path.join(watchDir, WATCH_DB_NAME)), true);
}));

test('非法输入直接拒绝：坏对象、未知变更类型、解析不了的时间都不入库', () => withTemp(async (root) => {
  const store = new WatchStateStore({ dir: path.join(root, 'watch') });
  try {
    assert.throws(() => store.getWatermark({ type: 'repo' }), WatchTargetError);
    assert.throws(() => store.setWatermark(null, new Date()), WatchTargetError);
    assert.throws(() => store.appendChange(alpha, { kind: 'renamed', ref: 'x' }), /未知的变更类型：renamed/u);
    assert.throws(() => store.appendChange(alpha, { kind: 'added', ref: '  ' }), /变更条目的 ref 不能为空/u);
    assert.throws(() => store.setWatermark(alpha, 'not-a-time'), /Invalid watch time/u);
    assert.throws(() => store.markHeartbeat(alpha, { at: 'not-a-time' }), /Invalid watch time/u);
    // 一次都没写成功，所以库里没有这一行的任何痕迹。
    assert.equal(store.getWatermark(alpha), null);
    assert.deepEqual(store.listChanges(alpha), []);
    assert.equal(store.status(alpha).queued, 0);
  } finally { store.close(); }
}));

test('队列按先进先出给，limit 只截断队列尾部，不重排', () => withTemp(async (root) => {
  const store = new WatchStateStore({ dir: path.join(root, 'watch') });
  try {
    for (const [index, kind] of CHANGE_KINDS.entries()) {
      store.appendChange(alpha, { kind, ref: `item-${index}`, at: `2026-11-07T0${index}:00:00.000Z` });
    }
    assert.deepEqual(store.listChanges(alpha).map((row) => row.kind), [...CHANGE_KINDS]);
    assert.deepEqual(store.listChanges(alpha, { limit: 2 }).map((row) => row.ref), ['item-0', 'item-1']);
  } finally { store.close(); }
}));

test('批量入队按 kind + ref + at 去重：同一批写两次只入队一次（#118）', () => withTemp(async (root) => {
  const store = new WatchStateStore({ dir: path.join(root, 'watch') });
  try {
    const batch = [
      { kind: 'added', ref: 'src/a.mjs', at: '2026-11-08T01:00:00.000Z' },
      { kind: 'added', ref: 'src/a.mjs', at: '2026-11-08T01:00:00.000Z' },
      { kind: 'modified', ref: 'src/a.mjs', at: '2026-11-08T02:00:00.000Z' }
    ];
    assert.equal(store.appendChanges(alpha, batch).length, 2);
    // 同一批重跑（例如上次推进失败后重试）不再入队，返回空数组。
    assert.deepEqual(store.appendChanges(alpha, batch), []);
    assert.deepEqual(store.listChanges(alpha).map((row) => row.ref), ['src/a.mjs', 'src/a.mjs']);
    // 只按 kind + ref + at 判重：同一个文件换个时刻仍是新的一条。
    assert.equal(store.appendChanges(alpha, [
      { kind: 'modified', ref: 'src/a.mjs', at: '2026-11-08T03:00:00.000Z' }
    ]).length, 1);
  } finally { store.close(); }
}));

test('批量入队先整批校验：批次里有一条坏的，前面几条也不落库', () => withTemp(async (root) => {
  const store = new WatchStateStore({ dir: path.join(root, 'watch') });
  try {
    assert.throws(() => store.appendChanges(alpha, [
      { kind: 'added', ref: 'src/ok.mjs', at: '2026-11-09T01:00:00.000Z' },
      { kind: 'renamed', ref: 'src/bad.mjs', at: '2026-11-09T01:01:00.000Z' }
    ]), /未知的变更类型：renamed/u);
    assert.deepEqual(store.listChanges(alpha), []);
    // 事务回滚后库还能照常写。
    assert.equal(store.appendChanges(alpha, [
      { kind: 'added', ref: 'src/ok.mjs', at: '2026-11-09T01:00:00.000Z' }
    ]).length, 1);
  } finally { store.close(); }
}));

test('默认位置是自有配置根的 watch/，可用环境变量整体改指', () => {
  const home = path.join(os.tmpdir(), 'watch-home');
  assert.equal(defaultWatchDir({ env: {}, homeDir: home }), path.join(home, '.owner-agent', 'watch'));
  assert.equal(
    defaultWatchDir({ env: { OWNER_AGENT_WATCH_DIR: path.join(home, 'elsewhere') }, homeDir: home }),
    path.join(home, 'elsewhere')
  );
});
