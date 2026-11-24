import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
import { OwnerStore } from '../src/owner-store.mjs';
import { ObserverStore } from '../src/observer/store.mjs';
import {
  addUntrackedFiles,
  makeBehindRepo,
  makeTempDir,
  statusText,
  treeDigest
} from './helpers/observer-fixture.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'bin', 'observerctl.mjs');
const FOUR_DAYS_AGO = '2026-11-20T09:00:00+08:00';
const runCli = promisify(execFile);

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
  try {
    return await fn({ dir, requests, webhookUrl: `http://127.0.0.1:${port}/open-apis/bot/v2/hook/test` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
};

const registerProject = (dbPath, root, id, name) => {
  const owner = new OwnerStore(dbPath);
  try { return owner.registerProject({ id, name, root }); } finally { owner.close(); }
};

// 显式指向不存在的阈值文件，避免读到本机 ~/.owner-agent/thresholds.json。
const childEnv = (dbPath, dir) => ({
  ...process.env,
  OWNER_AGENT_DB: dbPath,
  OWNER_OBSERVER_FEISHU_WEBHOOK: '',
  OWNER_OBSERVER_THRESHOLDS: path.join(dir, 'missing-thresholds.json')
});

test('命令行 check 一次产出三类事件，被观察仓库保持不变', () => withContext(async ({ dir, requests, webhookUrl }) => {
  const dbPath = path.join(dir, 'observer.sqlite');
  const root = makeBehindRepo({ root: path.join(dir, 'all'), behind: 12, commitAt: FOUR_DAYS_AGO });
  addUntrackedFiles(root, 25);
  registerProject(dbPath, root, 'obs-cli-all', 'CLI All');

  const beforeTree = treeDigest(root);
  const beforeStatus = statusText(root);

  const { stdout: output } = await runCli(process.execPath, [
    CLI, 'check',
    '--project', 'obs-cli-all',
    '--db', dbPath,
    '--config', path.join(dir, 'missing-feishu.json'),
    '--webhook', webhookUrl,
    '--send',
    '--json'
  ], { cwd: ROOT, encoding: 'utf8', env: childEnv(dbPath, dir) });
  const summary = JSON.parse(output);

  assert.equal(summary.projectId, 'obs-cli-all');
  assert.deepEqual(summary.events.map((event) => event.type).sort(), ['backlog', 'drift', 'stale']);
  assert.equal(requests.length, 3);
  assert.ok(summary.deliveries.every((delivery) => delivery.status === 'sent'));

  assert.equal(statusText(root), beforeStatus);
  assert.equal(treeDigest(root), beforeTree);
}));

test('命令行阈值文件改变事件判定：抬高漂移阈值后不再报漂移', () => withContext(async ({ dir, requests, webhookUrl }) => {
  const dbPath = path.join(dir, 'observer.sqlite');
  const root = makeBehindRepo({ root: path.join(dir, 'all'), behind: 12, commitAt: FOUR_DAYS_AGO });
  addUntrackedFiles(root, 25);
  registerProject(dbPath, root, 'obs-cli-thresholds', 'CLI Thresholds');

  const thresholdsPath = path.join(dir, 'thresholds.json');
  fs.writeFileSync(thresholdsPath, JSON.stringify({ driftCommits: 20, backlogFiles: 30 }));

  const { stdout: output } = await runCli(process.execPath, [
    CLI, 'check',
    '--project', 'obs-cli-thresholds',
    '--db', dbPath,
    '--config', path.join(dir, 'missing-feishu.json'),
    '--thresholds', thresholdsPath,
    '--webhook', webhookUrl,
    '--send',
    '--json'
  ], { cwd: ROOT, encoding: 'utf8', env: childEnv(dbPath, dir) });
  const summary = JSON.parse(output);

  assert.deepEqual(summary.events.map((event) => event.type), ['stale']);
  assert.equal(requests.length, 1);
}));

// #4 修复：check 默认只写事件并打印「本应发送什么」，不会和 digest 重复投递。
test('命令行 check 默认只预览：事件入库、打印本应发送的内容、不发请求', () => withContext(async ({
  dir, requests, webhookUrl
}) => {
  const dbPath = path.join(dir, 'observer.sqlite');
  const root = makeBehindRepo({ root: path.join(dir, 'preview'), behind: 12, commitAt: FOUR_DAYS_AGO });
  addUntrackedFiles(root, 25);
  registerProject(dbPath, root, 'obs-cli-preview', 'CLI Preview');

  const { stdout: output } = await runCli(process.execPath, [
    CLI, 'check',
    '--project', 'obs-cli-preview',
    '--db', dbPath,
    '--config', path.join(dir, 'missing-feishu.json'),
    '--webhook', webhookUrl,
    '--json'
  ], { cwd: ROOT, encoding: 'utf8', env: childEnv(dbPath, dir) });
  const summary = JSON.parse(output);

  assert.equal(summary.preview, true);
  assert.ok(summary.deliveries.every((delivery) => delivery === null));
  assert.deepEqual(summary.events.map((event) => event.type).sort(), ['backlog', 'drift', 'stale']);
  assert.equal(requests.length, 0, '预览模式不得调用 webhook');

  // 事件照样入库，但没有任何投递记录。
  const db = new ObserverStore(dbPath);
  try {
    assert.equal(db.listEvents({ projectId: 'obs-cli-preview' }).length, 3);
    assert.deepEqual(db.listDeliveries({ limit: 10 }), []);
  } finally { db.close(); }

  // 人类可读输出明确说明「预览」而不是让人以为已经发过。
  const { stdout: text } = await runCli(process.execPath, [
    CLI, 'check',
    '--project', 'obs-cli-preview',
    '--db', dbPath,
    '--config', path.join(dir, 'missing-feishu.json'),
    '--webhook', webhookUrl
  ], { cwd: ROOT, encoding: 'utf8', env: childEnv(dbPath, dir) });
  assert.match(text, /【停滞】/);
  assert.match(text, /预览：未投递/);
  assert.match(text, /--send/);
  assert.equal(requests.length, 0);
}));
