import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { runStaleCheck } from '../src/observer/service.mjs';
import { ObserverStore } from '../src/observer/store.mjs';
import { makeRepo, makeTempDir } from './helpers/observer-fixture.mjs';

const NOW = new Date('2026-11-24T09:00:00+08:00');
const FOUR_DAYS_AGO = '2026-11-20T09:00:00+08:00';

const withContext = async (fn) => {
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
  const store = new ObserverStore(path.join(dir, 'observer.sqlite'));
  try {
    return await fn({
      dir,
      store,
      requests,
      webhookUrl: `http://127.0.0.1:${port}/open-apis/bot/v2/hook/test`
    });
  } finally {
    store.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
};

test('停滞项目跑一次：飞书收到通知，事件与投递都进入审计库', () => withContext(async ({ dir, store, requests, webhookUrl }) => {
  const root = makeRepo({ root: path.join(dir, 'stale'), commitAt: FOUR_DAYS_AGO });

  const result = await runStaleCheck({
    project: { id: 'obs-run', name: 'Run Project', root },
    store,
    webhookUrl,
    now: NOW
  });

  assert.equal(result.event.type, 'stale');
  assert.equal(result.delivery.status, 'sent');
  assert.equal(requests.length, 1);
  const payload = JSON.parse(requests[0]);
  assert.equal(payload.msg_type, 'text');
  assert.match(payload.content.text, /Run Project/);
  assert.match(payload.content.text, /main/);
  assert.match(payload.content.text, /2026-11-20T09:00:00\+08:00/);

  const [event] = store.listEvents({ projectId: 'obs-run' });
  assert.equal(event.fingerprint, result.event.fingerprint);
  assert.equal(event.branch, 'main');
  assert.equal(event.detectedAt, NOW.toISOString());
  const [delivery] = store.listDeliveries({ eventId: event.id });
  assert.equal(delivery.status, 'sent');
  assert.equal(delivery.channel, 'feishu');
}));

test('未配置 webhook 时事件照样入审计库，投递记为 skipped 且不发请求', () => withContext(async ({ dir, store, requests }) => {
  const root = makeRepo({ root: path.join(dir, 'stale'), commitAt: FOUR_DAYS_AGO });

  const result = await runStaleCheck({ project: { id: 'obs-skip', name: 'Skip', root }, store, webhookUrl: '', now: NOW });

  assert.equal(result.delivery.status, 'skipped');
  assert.equal(requests.length, 0);
  assert.equal(store.listEvents({ projectId: 'obs-skip' }).length, 1);
  assert.equal(store.listDeliveries({ fingerprint: result.event.fingerprint })[0].status, 'skipped');
}));

test('未越过阈值的项目不产生事件、不投递', () => withContext(async ({ dir, store, requests, webhookUrl }) => {
  const root = makeRepo({ root: path.join(dir, 'fresh'), commitAt: '2026-11-22T09:00:00+08:00' });

  const result = await runStaleCheck({ project: { id: 'obs-fresh', name: 'Fresh', root }, store, webhookUrl, now: NOW });

  assert.equal(result.event, null);
  assert.equal(result.delivery, null);
  assert.equal(requests.length, 0);
  assert.equal(store.listEvents({ projectId: 'obs-fresh' }).length, 0);
}));

test('#28 冷却：同一事件重复运行只投递一次，第二次记为冷却跳过', () => withContext(async ({ dir, store, requests, webhookUrl }) => {
  const root = makeRepo({ root: path.join(dir, 'stale'), commitAt: FOUR_DAYS_AGO });
  const project = { id: 'obs-repeat', name: 'Repeat', root };

  const first = await runStaleCheck({ project, store, webhookUrl, now: NOW });
  const second = await runStaleCheck({ project, store, webhookUrl, now: NOW });

  assert.equal(requests.length, 1);
  assert.equal(store.listEvents({ projectId: 'obs-repeat' }).length, 1);
  assert.equal(first.event.fingerprint, second.event.fingerprint);
  assert.equal(second.delivery.status, 'skipped');
  assert.match(second.delivery.detail, /cooldown/);
  assert.deepEqual(
    store.listDeliveries({ fingerprint: first.event.fingerprint }).map((d) => d.status),
    ['sent', 'skipped']
  );
}));
