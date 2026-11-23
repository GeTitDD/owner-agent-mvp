import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { ObserverStore } from '../src/observer/store.mjs';
import { makeTempDir } from './helpers/observer-fixture.mjs';

const withDb = async (fn) => {
  const dir = makeTempDir();
  try { return await fn(path.join(dir, 'observer.sqlite')); } finally { await rm(dir, { recursive: true, force: true }); }
};

const event = (overrides = {}) => ({
  type: 'stale',
  fingerprint: 'a'.repeat(64),
  projectId: 'obs-a',
  projectName: 'Project A',
  branch: 'main',
  branchLabel: 'main',
  head: 'b'.repeat(40),
  lastCommitAt: '2026-11-20T09:00:00+08:00',
  daysStale: 4,
  detectedAt: '2026-11-24T01:00:00.000Z',
  ...overrides
});

test('停滞事件写入审计库，含指纹、项目、分支与发生时间', () => withDb(async (dbPath) => {
  const store = new ObserverStore(dbPath);
  try {
    const saved = store.recordEvent(event());
    assert.equal(saved.duplicate, false);

    const [row] = store.listEvents({ projectId: 'obs-a' });
    assert.equal(row.fingerprint, 'a'.repeat(64));
    assert.equal(row.projectId, 'obs-a');
    assert.equal(row.branch, 'main');
    assert.equal(row.detectedAt, '2026-11-24T01:00:00.000Z');
    assert.equal(row.lastCommitAt, '2026-11-20T09:00:00+08:00');
    assert.equal(row.daysStale, 4);
  } finally { store.close(); }
}));

test('同一指纹重复写入不产生新行，跨进程重开数据库仍然可见', () => withDb(async (dbPath) => {
  const first = new ObserverStore(dbPath);
  const original = first.recordEvent(event());
  const again = first.recordEvent(event({ detectedAt: '2026-11-25T01:00:00.000Z' }));
  assert.equal(again.duplicate, true);
  assert.equal(again.id, original.id);
  assert.equal(first.listEvents({ projectId: 'obs-a' }).length, 1);
  first.close();

  const reopened = new ObserverStore(dbPath);
  try {
    assert.equal(reopened.listEvents({ projectId: 'obs-a' }).length, 1);
    assert.equal(reopened.listEvents({ projectId: 'obs-a' })[0].fingerprint, 'a'.repeat(64));
  } finally { reopened.close(); }
}));

test('投递结果写入审计库：sent / failed / skipped 都留痕', () => withDb(async (dbPath) => {
  const store = new ObserverStore(dbPath);
  try {
    const { id } = store.recordEvent(event());
    store.recordDelivery({ eventId: id, fingerprint: 'a'.repeat(64), status: 'sent', detail: 'code=0' });
    store.recordDelivery({ eventId: id, fingerprint: 'a'.repeat(64), status: 'failed', detail: 'http 500' });
    store.recordDelivery({ eventId: id, fingerprint: 'a'.repeat(64), status: 'skipped', detail: 'webhook not configured' });

    const deliveries = store.listDeliveries({ eventId: id });
    assert.deepEqual(deliveries.map((d) => d.status), ['sent', 'failed', 'skipped']);
    assert.deepEqual(deliveries.map((d) => d.detail), ['code=0', 'http 500', 'webhook not configured']);
    assert.equal(deliveries[0].channel, 'feishu');
    assert.ok(deliveries.every((d) => d.at));
  } finally { store.close(); }
}));

test('非法事件与投递状态在存储边界被拒绝', () => withDb(async (dbPath) => {
  const store = new ObserverStore(dbPath);
  try {
    assert.throws(() => store.recordEvent(event({ fingerprint: 'not-hex' })), /Invalid fingerprint/);
    assert.throws(() => store.recordEvent(event({ projectId: '' })), /Invalid project id/);
    const { id } = store.recordEvent(event());
    assert.throws(() => store.recordDelivery({ eventId: id, fingerprint: 'a'.repeat(64), status: 'lost' }), /Invalid delivery status/);
  } finally { store.close(); }
}));
