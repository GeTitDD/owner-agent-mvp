// #131 同步状态：只测状态模型与落盘，不碰网络、不碰 git、不读真时钟（时刻都传固定值）。
//
// 断言五件事：
// 1. 三态迁移：synced → unsynced → synced，且最后成功时间跟着刷新；
// 2. 「从未同步」与「第一次就失败」可区分（同是 unknown，但 failure 一空一有）；
// 3. 失败时保留上次成功时间与原因，成功后清掉原因；
// 4. 非 synced 的界面语气永远不是绿色（ok）；
// 5. 状态落盘后重启（新建 store）读回来一致，坏文件退回「从未成功同步」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SYNC_STATES,
  SYNC_TONES,
  applySyncAttempt,
  emptySyncStatus,
  formatSyncTime,
  normalizeSyncStatus,
  syncAttemptText,
  syncBadge,
  syncStatusLine
} from '../src/memory/sync-status.mjs';
import { SyncStatusStore } from '../src/memory/sync-status-store.mjs';

const AT_1 = '2026-11-26T10:00:00.000Z';
const AT_2 = '2026-11-26T10:05:00.000Z';
const AT_3 = '2026-11-26T10:10:00.000Z';

const OK = Object.freeze({ status: 'ok', step: 'done', text: '同步完成：拉取 2 篇，推送 1 篇。' });
const OFFLINE = Object.freeze({
  status: 'error',
  step: 'pull',
  code: 'pull-failed',
  message: 'network unreachable（断网）'
});

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sync-status-'));

test('空状态：三态里的 unknown，且没有失败原因（= 从未同步过）', () => {
  const empty = emptySyncStatus();
  assert.equal(empty.state, 'unknown');
  assert.equal(empty.lastSuccessAt, '');
  assert.equal(empty.failure, null);
  assert.deepEqual(normalizeSyncStatus(empty), empty);
  assert.deepEqual(SYNC_STATES, ['synced', 'unsynced', 'unknown']);
});

test('没有成功时间时绝不认「已同步」（旧文件写错也不认）', () => {
  assert.equal(normalizeSyncStatus({ state: 'synced' }).state, 'unknown');
  assert.equal(normalizeSyncStatus({ state: 'synced', failure: null }).state, 'unknown');
});

test('状态迁移：synced → unsynced → synced，时间与原因各归各位', () => {
  const first = applySyncAttempt(emptySyncStatus(), OK, AT_1);
  assert.equal(first.state, 'synced');
  assert.equal(first.lastSuccessAt, AT_1);
  assert.equal(first.lastAttemptAt, AT_1);
  assert.equal(first.failure, null);

  const offline = applySyncAttempt(first, OFFLINE, AT_2);
  assert.equal(offline.state, 'unsynced');
  // 上次成功时间保留：断网时要能说「最后一次成功同步是几点」。
  assert.equal(offline.lastSuccessAt, AT_1);
  assert.equal(offline.lastAttemptAt, AT_2);
  assert.equal(offline.failure.code, 'pull-failed');
  assert.equal(offline.failure.message, OFFLINE.message);
  assert.equal(offline.failure.step, 'pull');
  assert.equal(offline.failure.at, AT_2);

  const recovered = applySyncAttempt(offline, OK, AT_3);
  assert.equal(recovered.state, 'synced');
  assert.equal(recovered.lastSuccessAt, AT_3);
  assert.equal(recovered.lastAttemptAt, AT_3);
  // 恢复后失败原因要清掉，不能留着旧原因吓人。
  assert.equal(recovered.failure, null);
});

test('从未同步与第一次就失败可区分：同是 unknown，failure 一空一有', () => {
  const never = emptySyncStatus();
  const firstFailure = applySyncAttempt(never, OFFLINE, AT_1);

  assert.equal(never.state, 'unknown');
  assert.equal(firstFailure.state, 'unknown');
  assert.equal(never.failure, null);
  assert.equal(firstFailure.failure.code, 'pull-failed');

  // 界面文案也不同：一个说「从未成功同步过」，另一个要带出原因。
  const neverBadge = syncBadge(never);
  const failedBadge = syncBadge(firstFailure);
  assert.match(neverBadge.detail, /从未成功同步过/u);
  assert.doesNotMatch(neverBadge.detail, /network unreachable/u);
  assert.match(failedBadge.detail, /连接失败，请联网后重试/u);
  assert.match(failedBadge.hint, /network unreachable/u);
  assert.doesNotMatch(failedBadge.detail, /pull：|network unreachable/u);
  assert.equal(failedBadge.label, '未同步');
});

test('非 synced 一律不是绿色；只有 synced 用 ok 语气', () => {
  const synced = syncBadge(applySyncAttempt(emptySyncStatus(), OK, AT_1));
  const unsynced = syncBadge(applySyncAttempt(applySyncAttempt(emptySyncStatus(), OK, AT_1), OFFLINE, AT_2));
  const never = syncBadge(emptySyncStatus());

  assert.equal(synced.tone, 'ok');
  assert.equal(synced.label, '已同步');
  assert.equal(synced.retry, false);

  for (const badge of [unsynced, never]) {
    assert.notEqual(badge.tone, 'ok');
    assert.notEqual(badge.label, '已同步');
    assert.equal(badge.label, '未同步');
    assert.equal(badge.retry, true, '未同步时要给补同步入口');
    assert.equal(badge.retryLabel, '补同步');
  }
  assert.equal(unsynced.tone, SYNC_TONES.unsynced);
  assert.equal(never.tone, SYNC_TONES.unknown);
  // 断网时仍要能回答「最后一次成功同步是几点」。
  assert.match(unsynced.detail, /最后同步/u);
  assert.match(unsynced.detail, /2026-11-26 10:00 UTC/u);
});

test('冲突停在确认也算未同步（本次没有推送完）', () => {
  const synced = applySyncAttempt(emptySyncStatus(), OK, AT_1);
  const stopped = applySyncAttempt(synced, {
    status: 'conflict',
    step: 'conflict',
    code: 'awaiting-choice',
    text: '同步停在冲突确认：还有 1 篇没有选择。'
  }, AT_2);

  assert.equal(stopped.state, 'unsynced');
  assert.equal(stopped.failure.conflict, true);
  assert.equal(stopped.failure.code, 'awaiting-choice');
  assert.equal(stopped.lastSuccessAt, AT_1);
  assert.notEqual(syncBadge(stopped).tone, 'ok');
});

test('没给原因时如实写「没有给出原因」，不编一个成功的理由', () => {
  const failed = applySyncAttempt(emptySyncStatus(), { status: 'error' }, AT_1);
  assert.equal(failed.failure.code, 'error-failed');
  assert.equal(failed.failure.message, '同步没有完成，也没有给出原因。');

  const noResult = applySyncAttempt(emptySyncStatus(), null, AT_1);
  assert.equal(noResult.state, 'unknown');
  assert.equal(noResult.failure.code, 'attempt-failed');
});

test('旧失败早于最后一次成功 = 已恢复，不压着成功状态（防乱序写入）', () => {
  const recovered = normalizeSyncStatus({
    state: 'unsynced',
    lastSuccessAt: AT_2,
    lastAttemptAt: AT_2,
    failure: { code: 'pull-failed', message: '旧失败', at: AT_1 }
  });
  assert.equal(recovered.state, 'synced');
  assert.equal(recovered.failure, null);
});

test('时间固定按 UTC 展示，不受机器时区影响', () => {
  assert.equal(formatSyncTime(AT_1), '2026-11-26 10:00 UTC');
  assert.equal(formatSyncTime(''), '');
  assert.equal(formatSyncTime('不是时间'), '');
  assert.match(syncStatusLine(emptySyncStatus()), /从未成功同步过/u);
});

test('补同步回执：成功说完成，失败说原因，不把失败写成完成', () => {
  const ok = applySyncAttempt(emptySyncStatus(), OK, AT_1);
  assert.equal(syncAttemptText({ status: ok, result: OK }), OK.text);

  const failed = applySyncAttempt(emptySyncStatus(), OFFLINE, AT_1);
  const text = syncAttemptText({ status: failed, result: OFFLINE });
  assert.match(text, /未完成/u);
  assert.match(text, /连接失败，请联网后重试/u);
  assert.doesNotMatch(text, /同步完成/u);
});

test('正常宿主尚未接入执行器时如实显示仅本机，并提供说明而非无效补同步', () => {
  const stored = applySyncAttempt(emptySyncStatus(), OK, AT_1);
  const badge = syncBadge({ ...stored, availability: { available: false } });
  assert.equal(badge.state, 'local-only');
  assert.equal(badge.label, '仅本机');
  assert.notEqual(badge.tone, 'ok');
  assert.match(badge.detail, /尚未接入/);
  assert.equal(badge.action, 'info');
  assert.equal(badge.retryLabel, '了解同步');
  assert.match(badge.hint, /本机读写照常/);
  assert.match(badge.hint, /2026-11-26 10:00 UTC/);
  assert.equal(stored.state, 'synced', '界面能力说明不能篡改历史结果');
});

test('失败摘要说清下一步，完整技术原因保留在可查详情中', () => {
  for (const [message, expected] of [
    ['401 Bad credentials', /检查凭据/], ['ECONNREFUSED', /联网后重试/],
    ['network unreachable', /联网后重试/], ['非常长的底层堆栈内容', /查看详情/]
  ]) {
    const status = applySyncAttempt(emptySyncStatus(), { status: 'error', step: 'push', message }, AT_1);
    const badge = syncBadge(status);
    assert.match(badge.detail, expected);
    assert.ok(badge.hint.includes(message));
    assert.doesNotMatch(badge.detail, /push：/);
  }
});

test('落盘：写进临时文件后新开一个 store 仍读到同一份时间与原因', () => {
  const dir = tempDir();
  const file = path.join(dir, 'nested', 'sync-status.json');
  const store = new SyncStatusStore({ file });

  // 文件还不存在：按「从未成功同步」读，不抛错。
  assert.deepEqual(store.read(), emptySyncStatus());

  const failed = applySyncAttempt(applySyncAttempt(emptySyncStatus(), OK, AT_1), OFFLINE, AT_2);
  store.save(failed);

  const reopened = new SyncStatusStore({ file });
  const read = reopened.read();
  assert.equal(read.state, 'unsynced');
  assert.equal(read.lastSuccessAt, AT_1);
  assert.equal(read.failure.message, OFFLINE.message);

  // 成功后再读：原因清掉，但文件里仍留着新的成功时间。
  reopened.save(applySyncAttempt(read, OK, AT_3));
  const final = new SyncStatusStore({ file }).read();
  assert.equal(final.state, 'synced');
  assert.equal(final.lastSuccessAt, AT_3);
  assert.equal(final.failure, null);
});

test('坏文件 / 不存在的文件都退回「从未成功同步」，不挡住本地读写', () => {
  const dir = tempDir();
  const file = path.join(dir, 'sync-status.json');
  fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
  assert.deepEqual(new SyncStatusStore({ file }).read(), emptySyncStatus());
});

test('store 要求一个存储路径（不回退到会写用户目录的默认值）', () => {
  assert.throws(() => new SyncStatusStore({}), /缺少同步状态的存储路径/u);
  assert.throws(() => new SyncStatusStore({ file: '   ' }), /缺少同步状态的存储路径/u);
});

test('真实同步状态按目标、凭据、未解决和本机变化显示，成功历史不能掩盖新变化',()=>{
  const status={state:'synced',lastSuccessAt:'2026-11-27T10:00:00Z',availability:{available:true,mode:'manual-preview'},count:0,unresolved:0};
  assert.equal(syncBadge(status).label,'已同步');assert.equal(syncBadge({...status,count:2}).label,'待检查');
  assert.match(syncBadge({...status,unresolved:1}).detail,/冲突未解决/);
  assert.equal(syncBadge({...status,availability:{available:false,mode:'manual-preview',reason:'auth-missing'}}).label,'仅本机');
  assert.equal(syncBadge(status).retryLabel,'检查同步');
});

test('同步错误日常说明不带 IPC 通道或本机 Git 路径，仍可展开技术详情',async()=>{
  const {syncErrorView}=await import('../src/memory/sync-status.mjs');
  const error=syncErrorView(new Error("Error invoking remote method 'companion:memory-sync-prepare': SyncTransportError: Git 同步未完成：fatal: '/tmp/fixture/remote.git' does not appear to be a git repository"));
  assert.match(error.text,/检查网络/);assert.ok(!error.text.includes('companion:'));assert.ok(!error.text.includes('/tmp/'));assert.ok(error.detail.includes('/tmp/fixture/'));
  assert.match(syncErrorView(new Error("Error invoking remote method 'companion:memory-sync-execute': Error: 本机记忆在预览后已变化，请重新检查。")).text,/^本机记忆/);
});
