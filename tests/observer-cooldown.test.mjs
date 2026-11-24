import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { evaluateCooldown } from '../src/observer/cooldown.mjs';
import { runStaleCheck, runProjectCheck } from '../src/observer/service.mjs';
import { ObserverStore } from '../src/observer/store.mjs';
import {
  addUntrackedFiles,
  git,
  makeBehindRepo,
  makeRepo,
  makeTempDir
} from './helpers/observer-fixture.mjs';

const NOW = new Date('2026-11-24T09:00:00+08:00');
const FOUR_DAYS_AGO = '2026-11-20T09:00:00+08:00';
const HOUR_MS = 60 * 60 * 1000;

/** 起一个假飞书 webhook；store 由调用方在同一个审计库上开关，用来模拟进程重启。 */
const withWebhook = async (fn) => {
  const dir = makeTempDir();
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0, msg: 'success' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn({
      dir,
      dbPath: path.join(dir, 'observer.sqlite'),
      requests,
      webhookUrl: `http://127.0.0.1:${port}/open-apis/bot/v2/hook/test`
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
};

/** 在同一个审计库上新开一个存储句柄，模拟一次进程重启。 */
const reopen = async (dbPath, fn) => {
  const store = new ObserverStore(dbPath);
  try { return await fn(store); } finally { store.close(); }
};

test('从未投递过的事件不在冷却中', () => {
  const result = evaluateCooldown({ lastSentAt: null, now: NOW });

  assert.equal(result.coolingDown, false);
  assert.equal(result.lastSentAt, null);
  assert.equal(result.resumesAt, null);
  assert.equal(result.remainingMs, 0);
});

test('上次投递在 23.5 小时内：正在冷却，并给出恢复时间', () => {
  // NOW = 2026-11-24T01:00:00Z；上次投递 2026-11-23T01:30:00Z，还差 30 分钟满 24 小时。
  const result = evaluateCooldown({ lastSentAt: '2026-11-23T01:30:00.000Z', now: NOW });

  assert.equal(result.coolingDown, true);
  assert.equal(result.lastSentAt, '2026-11-23T01:30:00.000Z');
  assert.equal(result.resumesAt, '2026-11-24T01:30:00.000Z');
  assert.equal(result.remainingMs, 30 * 60 * 1000);
});

test('上次投递正好满 24 小时：冷却结束，可以再次推送', () => {
  const result = evaluateCooldown({ lastSentAt: '2026-11-23T01:00:00.000Z', now: NOW });

  assert.equal(result.coolingDown, false);
  assert.equal(result.remainingMs, 0);
});

test('冷却窗口可注入，非法时间与窗口在边界被拒绝', () => {
  const result = evaluateCooldown({ lastSentAt: '2026-11-24T00:00:00.000Z', now: NOW, cooldownMs: 60 * 60 * 1000 });
  assert.equal(result.coolingDown, false);

  assert.throws(() => evaluateCooldown({ lastSentAt: 'not-a-time', now: NOW }), /Invalid last sent time/);
  assert.throws(() => evaluateCooldown({ lastSentAt: null, now: new Date('nope') }), /Invalid cooldown clock/);
  assert.throws(() => evaluateCooldown({ lastSentAt: null, now: NOW, cooldownMs: -1 }), /Invalid cooldown window/);
});

test('同一停滞事件连续运行三次：飞书只收到一条，后两次记为冷却跳过', () => withWebhook(async ({ dir, dbPath, requests, webhookUrl }) => {
  const root = makeRepo({ root: path.join(dir, 'stale'), commitAt: FOUR_DAYS_AGO });
  const project = { id: 'obs-cool', name: 'Cool', root };

  await reopen(dbPath, async (store) => {
    const results = [];
    for (let i = 0; i < 3; i += 1) {
      results.push(await runStaleCheck({ project, store, webhookUrl, now: NOW }));
    }

    assert.deepEqual(results.map((r) => r.delivery.status), ['sent', 'skipped', 'skipped']);
    assert.equal(results[1].cooldown.coolingDown, true);
    assert.equal(results[1].cooldown.resumesAt, '2026-11-25T01:00:00.000Z');
    assert.match(results[1].delivery.detail, /cooldown/);
    // 三次得到的是同一个事件：指纹稳定，事件表里只有一行。
    assert.equal(new Set(results.map((r) => r.event.fingerprint)).size, 1);
    assert.equal(store.listEvents({ projectId: 'obs-cool' }).length, 1);
  });

  assert.equal(requests.length, 1);
}));

test('杀掉进程重启后再运行：冷却状态从审计库恢复，不重复推送', () => withWebhook(async ({ dir, dbPath, requests, webhookUrl }) => {
  const root = makeRepo({ root: path.join(dir, 'stale'), commitAt: FOUR_DAYS_AGO });
  const project = { id: 'obs-restart', name: 'Restart', root };

  await reopen(dbPath, async (store) => {
    const first = await runStaleCheck({ project, store, webhookUrl, now: NOW });
    assert.equal(first.delivery.status, 'sent');
  });
  // 进程「退出」后重新打开同一个审计库，第二次运行不应再发消息。
  await reopen(dbPath, async (store) => {
    const second = await runStaleCheck({ project, store, webhookUrl, now: new Date(NOW.getTime() + 2 * HOUR_MS) });
    assert.equal(second.delivery.status, 'skipped');
    assert.equal(second.cooldown.coolingDown, true);
    assert.equal(second.duplicate, true);
    // 重启不补发历史：事件表仍只有一条，投递表是 sent + 一次冷却跳过。
    assert.equal(store.listEvents({ projectId: 'obs-restart' }).length, 1);
  });

  assert.equal(requests.length, 1);
}));

test('超过 24 小时后同一事件可以再次推送', () => withWebhook(async ({ dir, dbPath, requests, webhookUrl }) => {
  const root = makeRepo({ root: path.join(dir, 'stale'), commitAt: FOUR_DAYS_AGO });
  const project = { id: 'obs-expire', name: 'Expire', root };
  const later = new Date(NOW.getTime() + 25 * HOUR_MS);

  await reopen(dbPath, async (store) => {
    const first = await runStaleCheck({ project, store, webhookUrl, now: NOW });
    const after24h = await runStaleCheck({ project, store, webhookUrl, now: later });

    assert.equal(first.delivery.status, 'sent');
    assert.equal(after24h.delivery.status, 'sent');
    assert.equal(after24h.cooldown.coolingDown, false);
    assert.equal(after24h.event.fingerprint, first.event.fingerprint);
    assert.equal(store.listEvents({ projectId: 'obs-expire' }).length, 1);
    assert.deepEqual(
      store.listDeliveries({ fingerprint: first.event.fingerprint }).map((d) => d.status),
      ['sent', 'sent']
    );
  });

  assert.equal(requests.length, 2);
}));

test('不同项目、不同分支的同类事件各自独立计算冷却', () => withWebhook(async ({ dir, dbPath, requests, webhookUrl }) => {
  const rootA = makeRepo({ root: path.join(dir, 'a'), commitAt: FOUR_DAYS_AGO });
  const rootB = makeRepo({ root: path.join(dir, 'b'), commitAt: FOUR_DAYS_AGO });

  await reopen(dbPath, async (store) => {
    const projectA = { id: 'obs-iso-a', name: 'A', root: rootA };

    const a1 = await runStaleCheck({ project: projectA, store, webhookUrl, now: NOW });
    // 另一个项目即使 HEAD、提交时间与分支都相同，也单独通知。
    const projectB = { id: 'obs-iso-b', name: 'B', root: rootB };
    const b1 = await runStaleCheck({ project: projectB, store, webhookUrl, now: NOW });
    // 同一仓库换分支：新分支是独立事件，第一次照样通知。
    git(rootA, ['checkout', '-q', '-b', 'feature']);
    const a2 = await runStaleCheck({ project: projectA, store, webhookUrl, now: NOW });
    // 回到原分支：仍在自己的冷却里，不再通知。
    git(rootA, ['checkout', '-q', 'main']);
    const a3 = await runStaleCheck({ project: projectA, store, webhookUrl, now: NOW });

    assert.deepEqual([a1, b1, a2, a3].map((r) => r.delivery.status), ['sent', 'sent', 'sent', 'skipped']);
    assert.notEqual(a1.event.fingerprint, b1.event.fingerprint);
    assert.equal(a1.event.branchLabel, 'main');
    assert.equal(a2.event.branchLabel, 'feature');
    assert.notEqual(a1.event.fingerprint, a2.event.fingerprint);
    assert.equal(a3.event.fingerprint, a1.event.fingerprint);
  });

  assert.equal(requests.length, 3);
}));

// #28 验收：指纹不含 HEAD，同分支新提交不能绕过冷却。
test('同分支出现新提交且仍然停滞：24 小时内不重复通知', () => withWebhook(async ({ dir, dbPath, requests, webhookUrl }) => {
  const root = makeRepo({ root: path.join(dir, 'stale'), commitAt: FOUR_DAYS_AGO });
  const project = { id: 'obs-new-commit', name: 'New Commit', root };

  await reopen(dbPath, async (store) => {
    const first = await runStaleCheck({ project, store, webhookUrl, now: NOW });
    assert.equal(first.delivery.status, 'sent');

    // 新提交本身也已经是 3 天前，停滞条件依旧成立；只换 HEAD，不换项目/分支。
    git(root, ['commit', '-q', '--allow-empty', '-m', 'next'],
      { GIT_AUTHOR_DATE: '2026-11-21T09:00:00+08:00', GIT_COMMITTER_DATE: '2026-11-21T09:00:00+08:00' });
    const again = await runStaleCheck({
      project, store, webhookUrl, now: new Date(NOW.getTime() + HOUR_MS)
    });

    assert.equal(again.delivery.status, 'skipped');
    assert.equal(again.cooldown.coolingDown, true);
    assert.equal(again.event.fingerprint, first.event.fingerprint);
    assert.notEqual(again.event.head, first.event.head);
  });

  assert.equal(requests.length, 1);
}));

// 冷却窗口内证据会变（积压更多文件）：不新增事件、不重复发消息，但审计里的证据要更新，
// 否则观察台会一直显示第一次测到的 25 个文件，风险排序失真。
test('冷却窗口内再次命中有新证据：不新增事件、不重复投递，但证据字段更新', () => withWebhook(async ({
  dir, dbPath, requests, webhookUrl
}) => {
  const root = makeBehindRepo({ root: path.join(dir, 'all'), behind: 12, commitAt: FOUR_DAYS_AGO });
  addUntrackedFiles(root, 25);
  const project = { id: 'obs-evidence', name: 'Evidence', root };

  await reopen(dbPath, async (store) => {
    const first = await runProjectCheck({ project, store, webhookUrl, now: NOW });
    assert.equal(requests.length, 3);

    addUntrackedFiles(root, 5, 'extra');
    const second = await runProjectCheck({
      project, store, webhookUrl, now: new Date(NOW.getTime() + HOUR_MS)
    });

    assert.ok(second.deliveries.every((delivery) => delivery.status === 'skipped'));
    assert.equal(requests.length, 3, '冷却期内不得再发消息');
    assert.equal(store.listEvents({ projectId: 'obs-evidence' }).length, 3, '不新增事件行');
    const backlog = store.listEvents({ projectId: 'obs-evidence' }).find((event) => event.type === 'backlog');
    assert.equal(backlog.uncommittedFiles, 30, '积压证据刷新为本次观测值');
    assert.equal(backlog.updatedAt, new Date(NOW.getTime() + HOUR_MS).toISOString());
    assert.equal(first.events.find((event) => event.type === 'backlog').uncommittedFiles, 25);
  });
  assert.equal(requests.length, 3);
}));

// #28 × #29：三类事件在同一条链路上各自冷却，互不占用对方的窗口。
test('全量检查的三类事件各自冷却：第二次全部跳过，24 小时后各自再推送', () => withWebhook(async ({ dir, dbPath, requests, webhookUrl }) => {
  const root = makeBehindRepo({ root: path.join(dir, 'all'), behind: 12, commitAt: FOUR_DAYS_AGO });
  addUntrackedFiles(root, 25);
  const project = { id: 'obs-three-cool', name: 'Three Cool', root };

  await reopen(dbPath, async (store) => {
    const first = await runProjectCheck({ project, store, webhookUrl, now: NOW });
    assert.deepEqual(first.events.map((event) => event.type).sort(), ['backlog', 'drift', 'stale']);
    assert.ok(first.deliveries.every((delivery) => delivery.status === 'sent'));
    assert.equal(requests.length, 3);

    const second = await runProjectCheck({
      project, store, webhookUrl, now: new Date(NOW.getTime() + HOUR_MS)
    });
    assert.ok(second.deliveries.every((delivery) => delivery.status === 'skipped'));
    assert.ok(second.results.every((item) => item.cooldown.coolingDown));
    assert.equal(requests.length, 3, '冷却期内不应再发请求');

    const third = await runProjectCheck({
      project, store, webhookUrl, now: new Date(NOW.getTime() + 25 * HOUR_MS)
    });
    assert.ok(third.deliveries.every((delivery) => delivery.status === 'sent'));
    assert.equal(requests.length, 6);
  });
}));
