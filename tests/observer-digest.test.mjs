import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
import {
  DEFAULT_QUIET_HOURS,
  digestFingerprint,
  eventSeverity,
  formatDigestMessage,
  inQuietHours,
  localDayKey,
  nextLocalDayKey,
  normalizeQuietHours,
  rankDigestEvents
} from '../src/observer/digest.mjs';
import { runDigestScan } from '../src/observer/service.mjs';
import { ObserverStore } from '../src/observer/store.mjs';
import { OwnerStore } from '../src/owner-store.mjs';
import {
  addUntrackedFiles,
  makeBehindRepo,
  makeRepo,
  makeTempDir
} from './helpers/observer-fixture.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'bin', 'observerctl.mjs');
const FOUR_DAYS_AGO = '2026-11-20T09:00:00+08:00';
const runCli = promisify(execFile);

/** 用本地时间构造时钟：静默窗口按本地小时判断，测试不能依赖机器时区。 */
const at = (year, month, day, hour, minute = 0) => new Date(year, month - 1, day, hour, minute, 0, 0);

const event = (overrides = {}) => ({
  type: 'stale',
  fingerprint: 'a'.repeat(64),
  projectId: 'obs-a',
  projectName: 'Project A',
  branch: 'main',
  branchLabel: 'main',
  head: 'b'.repeat(40),
  lastCommitAt: FOUR_DAYS_AGO,
  daysStale: 4,
  detectedAt: '2026-11-24T01:00:00.000Z',
  ...overrides
});

/**
 * 起一个假飞书 webhook。replies 是响应码队列，用完后一律 200；
 * store 由调用方按需在同一个审计库上开关，用来模拟进程重启。
 */
const withContext = async (fn, { replies = [] } = {}) => {
  const dir = makeTempDir();
  const queue = [...replies];
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push(Buffer.concat(chunks).toString('utf8'));
      const status = queue.length ? queue.shift() : 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(status === 200 ? JSON.stringify({ code: 0, msg: 'success' }) : JSON.stringify({ code: 19001 }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const dbPath = path.join(dir, 'observer.sqlite');
  const store = new ObserverStore(dbPath);
  try {
    return await fn({
      dir,
      dbPath,
      store,
      requests,
      webhookUrl: `http://127.0.0.1:${port}/open-apis/bot/v2/hook/test`
    });
  } finally {
    try { store.close(); } catch { /* 已关闭时忽略 */ }
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
};

const staleProjects = (dir, ids) => ids.map((id) => {
  const root = makeRepo({ root: path.join(dir, id), commitAt: FOUR_DAYS_AGO });
  return { id, name: id.toUpperCase(), root };
});

test('#30 三个项目同时命中：一次扫描每个项目一条聚合，同日重复扫描不再发', () => withContext(async ({
  dir, store, requests, webhookUrl
}) => {
  const projects = staleProjects(dir, ['dig-a', 'dig-b', 'dig-c']);
  const now = at(2026, 11, 24, 10);

  const first = await runDigestScan({ projects, store, webhookUrl, now });

  assert.equal(first.quiet, false);
  assert.equal(first.targetDay, '2026-11-24');
  assert.equal(requests.length, 3, '三个项目各一条，而不是一类事件一条');
  const texts = requests.map((body) => JSON.parse(body).content.text);
  for (const project of projects) {
    const text = texts.find((item) => item.includes(project.id));
    assert.ok(text, `缺少 ${project.id} 的聚合消息`);
    assert.match(text, /【每日聚合】/);
    assert.match(text, /停滞 1 · 漂移 0 · 积压 0/);
  }

  for (const text of texts) {
    assert.match(text, /最严重 \d+ 条/);
    assert.doesNotMatch(text, /【漂移】/);
  }

  const digests = store.listDigests({ day: '2026-11-24' });
  assert.equal(digests.length, 3);
  assert.ok(digests.every((digest) => digest.status === 'sent' && digest.attempts === 1));

  // 同一天再扫一次：事件照常入审计，但额度已用，不再发消息。
  const second = await runDigestScan({ projects, store, webhookUrl, now });
  assert.equal(requests.length, 3);
  assert.ok(second.projects.every((item) => item.skipped));
  assert.equal(store.listDigests({ day: '2026-11-24' }).length, 3);
  for (const project of projects) {
    assert.equal(store.listEvents({ projectId: project.id }).length, 1);
  }
}));

test('#30 零事件项目不入聚合、不发消息；其余项目照常聚合', () => withContext(async ({
  dir, store, requests, webhookUrl
}) => {
  const now = at(2026, 11, 24, 10);
  const freshRoot = makeRepo({ root: path.join(dir, 'fresh'), commitAt: '2026-11-24T09:00:00+08:00' });
  const staleRoot = makeRepo({ root: path.join(dir, 'stale'), commitAt: FOUR_DAYS_AGO });
  const projects = [
    { id: 'dig-fresh', name: 'Fresh', root: freshRoot },
    { id: 'dig-stale', name: 'Stale', root: staleRoot }
  ];

  const first = await runDigestScan({ projects, store, webhookUrl, now });

  assert.equal(requests.length, 1, '只有真正有事件的项目才发消息');
  const text = JSON.parse(requests[0]).content.text;
  assert.match(text, /dig-stale/);
  assert.doesNotMatch(text, /dig-fresh/);
  assert.deepEqual(store.listDigests({ day: '2026-11-24' }).map((digest) => digest.projectId), ['dig-stale']);
  assert.deepEqual(store.listDigests({ projectId: 'dig-fresh' }), [], '零事件项目不建空聚合');

  const fresh = first.projects.find((item) => item.projectId === 'dig-fresh');
  assert.deepEqual(fresh.events, []);
  assert.equal(fresh.hasEvents, false);
  assert.equal(fresh.digestId, null);

  // 第二天 fresh 仍然没有事件：依然不发；stale 继续按当日额度发一条。
  const next = await runDigestScan({ projects, store, webhookUrl, now: at(2026, 11, 25, 10) });
  assert.equal(requests.length, 2);
  assert.deepEqual(store.listDigests({ projectId: 'dig-fresh' }), []);
  assert.equal(next.projects.find((item) => item.projectId === 'dig-fresh').digestId, null);
}));

test('#30 聚合消息含三类事件计数与最严重 3 条摘要', () => withContext(async ({
  dir, store, requests, webhookUrl
}) => {
  const root = makeBehindRepo({ root: path.join(dir, 'all'), behind: 12, commitAt: FOUR_DAYS_AGO });
  addUntrackedFiles(root, 25);

  const result = await runDigestScan({
    projects: [{ id: 'dig-three', name: 'Three Types', root }],
    store,
    webhookUrl,
    now: at(2026, 11, 24, 10)
  });

  assert.deepEqual(result.deliveries.map((delivery) => delivery.status), ['sent']);
  assert.equal(requests.length, 1);
  const text = JSON.parse(requests[0]).content.text;
  assert.match(text, /Three Types/);
  assert.match(text, /2026-11-24/);
  assert.match(text, /停滞 1 · 漂移 1 · 积压 1/);
  assert.match(text, /最严重 3 条/);
  assert.match(text, /【停滞】停滞 \d+ 天 · 分支 feature/);
  assert.match(text, /【漂移】落后主干 12 个提交/);
  assert.match(text, /【积压】积压 25 个未提交文件/);
}));

test('#30 严重度排序：不同单位按超过阈值的倍数比较，只保留前 3 条', () => {
  const events = [
    event({ id: 'e1', fingerprint: '1'.repeat(64), daysStale: 9, branchLabel: 'main' }),
    event({ id: 'e2', fingerprint: '2'.repeat(64), daysStale: 3, branchLabel: 'feature' }),
    event({ id: 'e3', fingerprint: '3'.repeat(64), type: 'drift', behindTrunk: 40, branchLabel: 'feature' }),
    event({ id: 'e4', fingerprint: '4'.repeat(64), type: 'drift', behindTrunk: 10, branchLabel: 'main' }),
    event({ id: 'e5', fingerprint: '5'.repeat(64), type: 'backlog', uncommittedFiles: 21, branchLabel: 'main' })
  ];

  assert.equal(eventSeverity(events[0]).ratio, 3);
  assert.equal(eventSeverity(events[2]).ratio, 4);
  const ranked = rankDigestEvents(events);
  assert.deepEqual(ranked.map((item) => item.id), ['e3', 'e1', 'e5']);

  const text = formatDigestMessage({ projectId: 'p1', projectName: 'P1', day: '2026-11-24', events });
  assert.match(text, /停滞 2 · 漂移 2 · 积压 1/);
  const rows = text.split('\n').filter((line) => /^\d\./.test(line));
  assert.equal(rows.length, 3);
  assert.match(rows[0], /漂移.*40 个提交/);
  assert.match(rows[1], /停滞 9 天/);
  assert.match(rows[2], /积压 21 个未提交文件/);
});

test('#30 22:00–08:00 不投递：夜间事件顺延到次日早晨合并发送，重启不丢', () => withContext(async ({
  dir, store: firstStore, requests, webhookUrl
}) => {
  const root = makeRepo({ root: path.join(dir, 'night'), commitAt: FOUR_DAYS_AGO });
  const projects = [{ id: 'dig-night', name: 'Night', root }];

  const night = await runDigestScan({ projects, store: firstStore, webhookUrl, now: at(2026, 11, 24, 23) });
  assert.equal(night.quiet, true);
  assert.equal(night.targetDay, '2026-11-25');
  assert.equal(requests.length, 0, '静默窗口内不得发请求');
  const [pending] = firstStore.listDigests({ day: '2026-11-25' });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.items, 1);

  // 模拟进程退出：关掉存储，再用同一个库新开一个句柄。
  const dbPath = path.join(dir, 'observer.sqlite');
  firstStore.close();
  const store = new ObserverStore(dbPath);
  try {
    const beforeEight = await runDigestScan({ projects, store, webhookUrl, now: at(2026, 11, 25, 7, 59) });
    assert.equal(beforeEight.quiet, true);
    assert.equal(requests.length, 0, '07:59 仍在静默窗口');

    const morning = await runDigestScan({ projects, store, webhookUrl, now: at(2026, 11, 25, 8) });
    assert.equal(morning.quiet, false);
    assert.equal(requests.length, 1, '08:00 之后补发，且不丢失');
    assert.deepEqual(morning.deliveries.map((delivery) => delivery.status), ['sent']);
    const text = JSON.parse(requests[0]).content.text;
    assert.match(text, /Night/);
    assert.match(text, /2026-11-25/);
    assert.match(text, /停滞 1/);

    // 同一天再扫：夜间事件与早晨事件合并成一条，不再发第二条。
    const later = await runDigestScan({ projects, store, webhookUrl, now: at(2026, 11, 25, 9) });
    assert.equal(requests.length, 1);
    assert.deepEqual(later.deliveries, []);
    assert.equal(store.listDigests({ day: '2026-11-25' }).length, 1);
  } finally {
    store.close();
  }
}));

test('#30 静默窗口边界与可配置：默认 22–8，跨午夜窗口也按本地小时判断', () => {
  assert.equal(inQuietHours(at(2026, 11, 24, 21, 59)), false);
  assert.equal(inQuietHours(at(2026, 11, 24, 22)), true);
  assert.equal(inQuietHours(at(2026, 11, 24, 23, 30)), true);
  assert.equal(inQuietHours(at(2026, 11, 25, 0)), true);
  assert.equal(inQuietHours(at(2026, 11, 25, 7, 59)), true);
  assert.equal(inQuietHours(at(2026, 11, 25, 8)), false);
  assert.equal(inQuietHours(at(2026, 11, 25, 12)), false);

  const custom = { startHour: 23, endHour: 6 };
  assert.equal(inQuietHours(at(2026, 11, 24, 22, 30), custom), false);
  assert.equal(inQuietHours(at(2026, 11, 24, 23, 30), custom), true);
  assert.equal(inQuietHours(at(2026, 11, 25, 5, 59), custom), true);
  assert.equal(inQuietHours(at(2026, 11, 25, 6), custom), false);

  assert.deepEqual(normalizeQuietHours(undefined), { ...DEFAULT_QUIET_HOURS });
  assert.throws(() => normalizeQuietHours({ startHour: 22, endHour: 22 }), /must differ/);
  assert.throws(() => normalizeQuietHours({ startHour: 24, endHour: 8 }), /0-23/);
  assert.throws(() => normalizeQuietHours({ startHour: 22.5, endHour: 8 }), /0-23/);
  assert.throws(() => inQuietHours(new Date('nope')), /Invalid quiet clock/);

  assert.equal(localDayKey(at(2026, 11, 24, 23)), '2026-11-24');
  assert.equal(nextLocalDayKey(at(2026, 12, 31, 23)), '2027-01-01');
});

test('#30 投递失败重试一次，失败原因写入审计库，当日不再重复重试', () => withContext(async ({
  dir, store, requests, webhookUrl
}) => {
  const root = makeRepo({ root: path.join(dir, 'fail'), commitAt: FOUR_DAYS_AGO });
  const projects = [{ id: 'dig-fail', name: 'Fail', root }];
  const now = at(2026, 11, 24, 10);

  const first = await runDigestScan({ projects, store, webhookUrl, now });

  assert.equal(requests.length, 2, '失败后只重试一次');
  assert.equal(first.deliveries[0].status, 'failed');
  const [digest] = store.listDigests({ projectId: 'dig-fail', day: '2026-11-24' });
  assert.equal(digest.status, 'failed');
  assert.equal(digest.attempts, 2);
  assert.match(digest.detail, /attempt 1: feishu http 500/);
  assert.match(digest.detail, /attempt 2: feishu http 500/);
  const attempts = store.listDigestAttempts({ digestId: digest.id });
  assert.deepEqual(attempts.map((item) => item.status), ['failed', 'failed']);
  assert.ok(attempts.every((item) => /http 500/.test(item.detail)));

  // failed 是当日终态：再扫一次不再重试，事件与原因仍可查。
  const second = await runDigestScan({ projects, store, webhookUrl, now });
  assert.equal(requests.length, 2);
  assert.deepEqual(second.deliveries, []);
  assert.equal(store.listDigests({ projectId: 'dig-fail', day: '2026-11-24' })[0].status, 'failed');
}, { replies: [500, 500] }));

test('#30 第一次失败、重试成功：只算一次成功投递', () => withContext(async ({
  dir, store, requests, webhookUrl
}) => {
  const root = makeRepo({ root: path.join(dir, 'retry'), commitAt: FOUR_DAYS_AGO });

  const result = await runDigestScan({
    projects: [{ id: 'dig-retry', name: 'Retry', root }],
    store,
    webhookUrl,
    now: at(2026, 11, 24, 10)
  });

  assert.equal(requests.length, 2);
  assert.equal(result.deliveries[0].status, 'sent');
  const [digest] = store.listDigests({ day: '2026-11-24' });
  assert.equal(digest.status, 'sent');
  assert.deepEqual(store.listDigestAttempts({ digestId: digest.id }).map((item) => item.status), ['failed', 'sent']);
}, { replies: [500, 200] }));

test('#30 未配置 webhook：聚合保持待发，配置好后同一日仍能补发', () => withContext(async ({
  dir, store, requests, webhookUrl
}) => {
  const root = makeRepo({ root: path.join(dir, 'skip'), commitAt: FOUR_DAYS_AGO });
  const projects = [{ id: 'dig-skip', name: 'Skip', root }];
  const now = at(2026, 11, 24, 10);

  const skipped = await runDigestScan({ projects, store, webhookUrl: '', now });
  assert.deepEqual(skipped.deliveries.map((delivery) => delivery.status), ['skipped']);
  assert.equal(requests.length, 0);
  let [digest] = store.listDigests({ day: '2026-11-24' });
  assert.equal(digest.status, 'pending');
  assert.equal(digest.sentAt, null);

  const sent = await runDigestScan({ projects, store, webhookUrl, now });
  assert.deepEqual(sent.deliveries.map((delivery) => delivery.status), ['sent']);
  assert.equal(requests.length, 1);
  [digest] = store.listDigests({ day: '2026-11-24' });
  assert.equal(digest.status, 'sent');
  assert.ok(digest.sentAt);
}));

test('#30 待发聚合跨天顺延：旧日聚合并入新日，旧行标记 merged 且内容不丢', async () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'observer.sqlite');
  const store = new ObserverStore(dbPath);
  try {
    const day = '2026-11-23';
    const saved = store.recordEvent(event({ projectId: 'dig-roll', fingerprint: '9'.repeat(64) }));
    const old = store.ensureDigest({
      projectId: 'dig-roll',
      day,
      fingerprint: digestFingerprint({ projectId: 'dig-roll', day }),
      now: at(2026, 11, 23, 23)
    });
    store.addDigestEvents({ digestId: old.id, eventIds: [saved.id], now: at(2026, 11, 23, 23) });

    const rolled = store.rollPendingDigests({ toDay: '2026-11-24', now: at(2026, 11, 24, 9) });
    assert.equal(rolled.length, 1);
    assert.equal(rolled[0].day, day);

    const merged = store.getDigest(old.id);
    assert.equal(merged.status, 'merged');
    assert.match(merged.detail, new RegExp(`merged into ${rolled[0].targetDigestId}`));
    assert.equal(store.listDigestEvents(old.id).length, 1, '旧聚合的事件链接保留，审计内容不丢');

    const [target] = store.listDigests({ projectId: 'dig-roll', day: '2026-11-24' });
    assert.equal(target.status, 'pending');
    assert.deepEqual(store.listDigestEvents(target.id).map((item) => item.id), [saved.id]);
    // 已经顺延过一次：再跑一次不会重复搬移。
    assert.deepEqual(store.rollPendingDigests({ toDay: '2026-11-24', now: at(2026, 11, 24, 10) }), []);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('#30 单个仓库不可读不阻断整轮：其余项目照常聚合，错误带在返回值里', () => withContext(async ({
  dir, store, requests, webhookUrl
}) => {
  const root = makeRepo({ root: path.join(dir, 'good'), commitAt: FOUR_DAYS_AGO });

  const result = await runDigestScan({
    projects: [
      { id: 'dig-broken', name: 'Broken', root: path.join(dir, 'missing-directory') },
      { id: 'dig-good', name: 'Good', root }
    ],
    store,
    webhookUrl,
    now: at(2026, 11, 24, 10)
  });

  const broken = result.projects.find((item) => item.projectId === 'dig-broken');
  assert.ok(broken.error);
  assert.deepEqual(broken.events, []);
  assert.equal(result.projects.find((item) => item.projectId === 'dig-good').events.length, 1);
  assert.equal(requests.length, 1);
  assert.deepEqual(result.deliveries.map((delivery) => delivery.status), ['sent']);
}));

test('#30 投递租约：两个进程只有一个能抢到，租约过期后可重新抢占', async () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'observer.sqlite');
  const store = new ObserverStore(dbPath);
  try {
    const digest = store.ensureDigest({
      projectId: 'dig-lease',
      day: '2026-11-24',
      fingerprint: digestFingerprint({ projectId: 'dig-lease', day: '2026-11-24' }),
      now: at(2026, 11, 24, 10)
    });

    assert.equal(store.claimDigest({ id: digest.id, now: at(2026, 11, 24, 10) }), true);
    assert.equal(store.claimDigest({ id: digest.id, now: at(2026, 11, 24, 10, 1) }), false,
      '租约未过期时第二个进程不得重复发');
    // 租约 2 分钟：3 分钟后视为前一个进程崩溃，允许重新抢占。
    assert.equal(store.claimDigest({ id: digest.id, now: at(2026, 11, 24, 10, 3) }), true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('#30 命令行 digest：--now 注入时钟，夜间静默不投递，上午补发', async () => {
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
  const dbPath = path.join(dir, 'observer.sqlite');
  const webhookUrl = `http://127.0.0.1:${port}/open-apis/bot/v2/hook/test`;
  const env = {
    ...process.env,
    OWNER_AGENT_DB: dbPath,
    OWNER_OBSERVER_FEISHU_WEBHOOK: '',
    OWNER_OBSERVER_THRESHOLDS: path.join(dir, 'missing-thresholds.json')
  };
  const invoke = async (nowArg) => JSON.parse((await runCli(process.execPath, [
    CLI, 'digest', '--db', dbPath, '--config', path.join(dir, 'missing-feishu.json'),
    '--webhook', webhookUrl, '--now', nowArg, '--json'
  ], { cwd: ROOT, encoding: 'utf8', env })).stdout);

  try {
    const owner = new OwnerStore(dbPath);
    try {
      for (const id of ['cli-a', 'cli-b', 'cli-c']) {
        const root = makeRepo({ root: path.join(dir, id), commitAt: FOUR_DAYS_AGO });
        owner.registerProject({ id, name: id.toUpperCase(), root });
      }
    } finally { owner.close(); }

    const night = await invoke('2026-11-24T23:00:00');
    assert.equal(night.quiet, true);
    assert.equal(night.targetDay, '2026-11-25');
    assert.deepEqual(night.deliveries, []);
    assert.equal(requests.length, 0);

    const morning = await invoke('2026-11-25T08:30:00');
    assert.equal(morning.quiet, false);
    assert.equal(morning.deliveries.length, 3);
    assert.ok(morning.deliveries.every((delivery) => delivery.status === 'sent'));
    assert.equal(requests.length, 3);

    const later = await invoke('2026-11-25T10:00:00');
    assert.deepEqual(later.deliveries, []);
    assert.equal(requests.length, 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
