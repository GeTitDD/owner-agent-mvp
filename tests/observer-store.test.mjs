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

test('同一指纹再次命中：不新增行，但更新证据字段与 updated_at', () => withDb(async (dbPath) => {
  const store = new ObserverStore(dbPath);
  try {
    const first = store.recordEvent(event({ daysStale: 4, detectedAt: '2026-11-24T01:00:00.000Z' }));
    // 冷却窗口内再次命中：落后更深、积压更多，但指纹不变。
    const second = store.recordEvent(event({
      daysStale: 9,
      behindTrunk: 12,
      trunkRef: 'main',
      uncommittedFiles: 25,
      detectedAt: '2026-11-24T05:00:00.000Z'
    }));

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.id, first.id);

    const events = store.listEvents({ projectId: 'obs-a' });
    assert.equal(events.length, 1);
    assert.equal(events[0].daysStale, 9);
    assert.equal(events[0].behindTrunk, 12);
    assert.equal(events[0].uncommittedFiles, 25);
    assert.equal(events[0].detectedAt, '2026-11-24T01:00:00.000Z', '首次发生时间保留');
    assert.equal(events[0].updatedAt, '2026-11-24T05:00:00.000Z', '证据刷新时间更新');
  } finally { store.close(); }
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

test('lastSentAt 只认成功投递，且跨进程重开数据库后仍能读到（重启恢复）', () => withDb(async (dbPath) => {
  const first = new ObserverStore(dbPath);
  const { id } = first.recordEvent(event());
  assert.equal(first.lastSentAt({ fingerprint: 'a'.repeat(64) }), null);

  first.recordDelivery({
    eventId: id, fingerprint: 'a'.repeat(64), status: 'failed', detail: 'http 500',
    at: '2026-11-24T01:00:00.000Z'
  });
  first.recordDelivery({
    eventId: id, fingerprint: 'a'.repeat(64), status: 'skipped', detail: 'webhook not configured',
    at: '2026-11-24T02:00:00.000Z'
  });
  assert.equal(first.lastSentAt({ fingerprint: 'a'.repeat(64) }), null, 'failed / skipped 不占用冷却');

  first.recordDelivery({
    eventId: id, fingerprint: 'a'.repeat(64), status: 'sent', detail: 'feishu code 0',
    at: '2026-11-24T03:00:00.000Z'
  });
  assert.equal(first.lastSentAt({ fingerprint: 'a'.repeat(64) }), '2026-11-24T03:00:00.000Z');
  first.close();

  const reopened = new ObserverStore(dbPath);
  try {
    assert.equal(reopened.lastSentAt({ fingerprint: 'a'.repeat(64) }), '2026-11-24T03:00:00.000Z');
    // 指纹与渠道都参与定位：换个渠道或指纹不应该读到这条记录。
    assert.equal(reopened.lastSentAt({ fingerprint: 'a'.repeat(64), channel: 'telegram' }), null);
    assert.equal(reopened.lastSentAt({ fingerprint: 'c'.repeat(64) }), null);
  } finally { reopened.close(); }
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
