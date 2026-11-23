import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rm } from 'node:fs/promises';
import { runProjectCheck } from '../src/observer/service.mjs';
import { ObserverStore } from '../src/observer/store.mjs';
import { DEFAULT_THRESHOLDS } from '../src/observer/thresholds.mjs';
import {
  addUntrackedFiles,
  makeBehindRepo,
  makeRepo,
  makeTempDir
} from './helpers/observer-fixture.mjs';

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

test('一次项目检查同时产出停滞、漂移、积压三类事件，走同一条投递链路', () => withContext(async ({
  dir, store, requests, webhookUrl
}) => {
  const root = makeBehindRepo({ root: path.join(dir, 'all'), behind: 12, commitAt: FOUR_DAYS_AGO });
  addUntrackedFiles(root, 25);

  const result = await runProjectCheck({
    project: { id: 'obs-three', name: 'Three Events', root },
    store,
    webhookUrl,
    now: NOW
  });

  assert.deepEqual(result.events.map((event) => event.type).sort(), ['backlog', 'drift', 'stale']);
  assert.equal(result.deliveries.length, 3);
  assert.ok(result.deliveries.every((delivery) => delivery.status === 'sent'));
  assert.equal(requests.length, 3);

  const texts = requests.map((body) => JSON.parse(body).content.text);
  assert.ok(texts.some((text) => /【停滞】Three Events/.test(text)));
  assert.ok(texts.some((text) => /【漂移】Three Events/.test(text) && /12 个提交/.test(text)));
  assert.ok(texts.some((text) => /【积压】Three Events/.test(text) && /25 个未提交文件/.test(text)));

  const events = store.listEvents({ projectId: 'obs-three' });
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((event) => event.type).sort(), ['backlog', 'drift', 'stale']);
  const drift = events.find((event) => event.type === 'drift');
  assert.equal(drift.trunkRef, 'main');
  assert.equal(drift.behindTrunk, 12);
  const backlog = events.find((event) => event.type === 'backlog');
  assert.equal(backlog.uncommittedFiles, 25);
  for (const event of events) {
    const [delivery] = store.listDeliveries({ eventId: event.id });
    assert.equal(delivery.status, 'sent');
    assert.equal(delivery.channel, 'feishu');
    assert.equal(delivery.fingerprint, event.fingerprint);
  }
}));

test('阈值配置决定产出哪些事件：抬高漂移与积压阈值后只剩停滞', () => withContext(async ({
  dir, store, requests, webhookUrl
}) => {
  const root = makeBehindRepo({ root: path.join(dir, 'all'), behind: 12, commitAt: FOUR_DAYS_AGO });
  addUntrackedFiles(root, 25);

  const result = await runProjectCheck({
    project: { id: 'obs-raised', name: 'Raised', root },
    store,
    webhookUrl,
    now: NOW,
    thresholds: { ...DEFAULT_THRESHOLDS, driftCommits: 20, backlogFiles: 30 }
  });

  assert.deepEqual(result.events.map((event) => event.type), ['stale']);
  assert.equal(requests.length, 1);
  assert.equal(store.listEvents({ projectId: 'obs-raised' }).length, 1);
}));

test('没有任何事件时不写审计、不投递', () => withContext(async ({ dir, store, requests, webhookUrl }) => {
  const root = makeRepo({ root: path.join(dir, 'fresh'), commitAt: NOW.toISOString() });

  const result = await runProjectCheck({
    project: { id: 'obs-clean', name: 'Clean', root },
    store,
    webhookUrl,
    now: NOW
  });

  assert.deepEqual(result.events, []);
  assert.deepEqual(result.deliveries, []);
  assert.equal(requests.length, 0);
  assert.equal(store.listEvents({ projectId: 'obs-clean' }).length, 0);
}));

test('#27 建的审计库缺漂移 / 积压列时就地补列，旧事件仍可读', async () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'observer.sqlite');
  try {
    // 复刻 #27 的表结构：没有 trunk_ref / behind_trunk / uncommitted_files。
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE observer_events(
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      project_id TEXT NOT NULL,
      project_name TEXT NOT NULL DEFAULT '',
      branch TEXT,
      branch_label TEXT NOT NULL,
      last_commit_sha TEXT NOT NULL DEFAULT '',
      last_commit_at TEXT,
      days_stale INTEGER NOT NULL DEFAULT 0,
      detected_at TEXT NOT NULL
    );`);
    legacy.prepare(`INSERT INTO observer_events(
      id,fingerprint,type,project_id,project_name,branch,branch_label,
      last_commit_sha,last_commit_at,days_stale,detected_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      'legacy-1', 'c'.repeat(64), 'stale', 'obs-legacy', 'Legacy', 'main', 'main',
      'd'.repeat(40), FOUR_DAYS_AGO, 4, NOW.toISOString()
    );
    legacy.close();

    const store = new ObserverStore(dbPath);
    try {
      const [existing] = store.listEvents({ projectId: 'obs-legacy' });
      assert.equal(existing.type, 'stale');
      assert.equal(existing.daysStale, 4);
      assert.equal(existing.behindTrunk, 0);

      const saved = store.recordEvent({
        type: 'drift',
        fingerprint: 'e'.repeat(64),
        projectId: 'obs-legacy',
        branchLabel: 'feature',
        trunkRef: 'main',
        behindTrunk: 12,
        detectedAt: NOW.toISOString()
      });
      assert.equal(saved.duplicate, false);
      const drift = store.listEvents({ projectId: 'obs-legacy' }).find((event) => event.type === 'drift');
      assert.equal(drift.behindTrunk, 12);
      assert.equal(drift.trunkRef, 'main');
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
