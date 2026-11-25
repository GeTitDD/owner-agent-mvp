// #84 水位存储：按项目隔离、重启后仍在、老库平滑升级。
// 用临时库断言，不碰真实 ~/.domain-context 或 %APPDATA%。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryWatermarkStore, WATERMARK_TABLE } from '../src/memory/watermark.mjs';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'watermark-test-'));

const withDb = async (fn) => {
  const dir = makeTempDir();
  try {
    return await fn(path.join(dir, 'owner.sqlite'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
};

test('水位按项目隔离：写 A 不影响 B，B 没有记录时是 null', () => withDb(async (dbPath) => {
  const store = new MemoryWatermarkStore({ dbPath });
  try {
    assert.equal(store.get('alpha'), null);
    store.put('alpha', '2026-11-01T10:00:00.000Z');
    store.put('beta', '2026-11-02T10:00:00.000Z');
    assert.equal(store.get('alpha').at, '2026-11-01T10:00:00.000Z');
    assert.equal(store.get('beta').at, '2026-11-02T10:00:00.000Z');
    assert.deepEqual(store.list().map((row) => row.projectId), ['alpha', 'beta']);
    // 推进 A 只改 A。
    store.put('alpha', '2026-11-03T10:00:00.000Z');
    assert.equal(store.get('alpha').at, '2026-11-03T10:00:00.000Z');
    assert.equal(store.get('beta').at, '2026-11-02T10:00:00.000Z');
  } finally { store.close(); }
}));

test('重启后水位仍在：关库再开，同一个项目读到同一个时间点', () => withDb(async (dbPath) => {
  const first = new MemoryWatermarkStore({ dbPath });
  first.put('alpha', '2026-11-05T08:30:00.000Z');
  first.close();

  const reopened = new MemoryWatermarkStore({ dbPath });
  try {
    assert.equal(reopened.get('alpha').at, '2026-11-05T08:30:00.000Z');
  } finally { reopened.close(); }
}));

test('老库平滑升级：打开只多一张空表，旧表与旧数据一行不动', () => withDb(async (dbPath) => {
  // 模拟 #84 之前就存在的库：已经有 owner_projects 与一行真实数据，但没有水位表。
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`CREATE TABLE owner_projects(
    id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL
  )`);
  legacy.prepare('INSERT INTO owner_projects(id,name,root) VALUES(?,?,?)')
    .run('alpha', 'Alpha Repo', 'C:/repo/alpha');
  const tablesBefore = legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map((row) => row.name);
  assert.equal(tablesBefore.includes(WATERMARK_TABLE), false);
  legacy.close();

  const store = new MemoryWatermarkStore({ dbPath });
  try {
    // 升级只建表，不删列、不重写别的表。
    assert.equal(store.get('alpha'), null);
    store.put('alpha', '2026-11-06T09:00:00.000Z');
    assert.equal(store.get('alpha').at, '2026-11-06T09:00:00.000Z');
  } finally { store.close(); }

  const check = new DatabaseSync(dbPath);
  try {
    const row = check.prepare('SELECT id,name,root FROM owner_projects WHERE id=?').get('alpha');
    assert.deepEqual({ ...row }, { id: 'alpha', name: 'Alpha Repo', root: 'C:/repo/alpha' });
  } finally { check.close(); }
}));

test('复用外部连接时不越权关库；时间接受 Date / 毫秒并归一成 UTC ISO', () => withDb(async (dbPath) => {
  const shared = new DatabaseSync(dbPath);
  const store = new MemoryWatermarkStore({ db: shared });
  store.put('alpha', new Date('2026-11-07T01:02:03.000Z'));
  assert.equal(store.get('alpha').at, '2026-11-07T01:02:03.000Z');
  store.put('alpha', Date.parse('2026-11-08T01:02:03.000Z'));
  assert.equal(store.get('alpha').at, '2026-11-08T01:02:03.000Z');
  store.close();
  // close() 不该关掉外部连接：还能继续查。
  assert.equal(shared.prepare(`SELECT COUNT(*) AS n FROM ${WATERMARK_TABLE}`).get().n, 1);
  shared.close();
}));

test('非法输入直接拒绝，不在库里留下脏行', () => withDb(async (dbPath) => {
  const store = new MemoryWatermarkStore({ dbPath });
  try {
    assert.throws(() => store.get(''), /缺少项目 id/);
    assert.throws(() => store.put('alpha', 'not-a-time'), /Invalid watermark time/);
    assert.throws(() => store.put('a'.repeat(91), new Date()), /项目 id 过长/);
    assert.deepEqual(store.list(), []);
  } finally { store.close(); }
}));
