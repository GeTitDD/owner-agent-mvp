import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
import { OwnerStore } from '../src/owner-store.mjs';
import { ObserverStore } from '../src/observer/store.mjs';
import { makeRepo, makeTempDir, statusText, treeDigest } from './helpers/observer-fixture.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'bin', 'observerctl.mjs');
const FOUR_DAYS_AGO = '2026-11-20T09:00:00+08:00';
// 必须用异步子进程：execFileSync 会阻塞事件循环，测试内嵌的 HTTP stub 将无法回复。
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

// 子进程环境：显式清空真实 webhook 环境变量，并用 --config 指向临时路径，
// 保证测试永远不会读到或写入本机 ~/.owner-agent/feishu.json。
const childEnv = (dbPath) => ({
  ...process.env,
  OWNER_AGENT_DB: dbPath,
  OWNER_OBSERVER_FEISHU_WEBHOOK: '',
  // 显式指向不存在的阈值文件，避免读到本机 ~/.owner-agent/thresholds.json。
  OWNER_OBSERVER_THRESHOLDS: path.join(path.dirname(dbPath), 'missing-thresholds.json')
});

test('命令行单项目停滞检查：不启动 Electron，飞书收到通知，被观察仓库保持不变', () => withContext(async ({ dir, requests, webhookUrl }) => {
  const dbPath = path.join(dir, 'observer.sqlite');
  const root = makeRepo({ root: path.join(dir, 'stale'), commitAt: FOUR_DAYS_AGO });
  registerProject(dbPath, root, 'obs-cli', 'CLI Project');

  const beforeTree = treeDigest(root);
  const beforeStatus = statusText(root);

  const { stdout: output } = await runCli(process.execPath, [
    CLI, 'stale',
    '--project', 'obs-cli',
    '--db', dbPath,
    '--config', path.join(dir, 'missing-feishu.json'),
    '--webhook', webhookUrl,
    '--json'
  ], { cwd: ROOT, encoding: 'utf8', env: childEnv(dbPath) });
  const summary = JSON.parse(output);

  assert.equal(summary.projectId, 'obs-cli');
  assert.equal(summary.event.type, 'stale');
  assert.equal(summary.delivery.status, 'sent');
  assert.equal(requests.length, 1);
  const payload = JSON.parse(requests[0]);
  assert.match(payload.content.text, /CLI Project/);
  assert.match(payload.content.text, /main/);
  assert.match(payload.content.text, /2026-11-20T09:00:00\+08:00/);

  const store = new ObserverStore(dbPath);
  try {
    const [event] = store.listEvents({ projectId: 'obs-cli' });
    assert.equal(event.fingerprint, summary.event.fingerprint);
    assert.equal(event.branch, 'main');
    assert.ok(event.detectedAt);
  } finally { store.close(); }

  assert.equal(statusText(root), beforeStatus);
  assert.equal(treeDigest(root), beforeTree);
}));

test('未配置 webhook 时命令行正常退出，事件入审计库且投递记为 skipped', () => withContext(async ({ dir, requests }) => {
  const dbPath = path.join(dir, 'observer.sqlite');
  const root = makeRepo({ root: path.join(dir, 'stale'), commitAt: FOUR_DAYS_AGO });
  registerProject(dbPath, root, 'obs-cli-skip', 'CLI Skip');

  const { stdout: output } = await runCli(process.execPath, [
    CLI, 'stale',
    '--project', 'obs-cli-skip',
    '--db', dbPath,
    '--config', path.join(dir, 'missing-feishu.json'),
    '--json'
  ], { cwd: ROOT, encoding: 'utf8', env: childEnv(dbPath) });
  const summary = JSON.parse(output);

  assert.equal(summary.delivery.status, 'skipped');
  assert.equal(requests.length, 0);
  const store = new ObserverStore(dbPath);
  try {
    assert.equal(store.listEvents({ projectId: 'obs-cli-skip' }).length, 1);
  } finally { store.close(); }
}));

test('未登记的项目让命令行以非零码退出并给出明确错误', () => withContext(async ({ dir }) => {
  const dbPath = path.join(dir, 'observer.sqlite');
  const result = spawnSync(process.execPath, [
    CLI, 'stale', '--project', 'nope', '--db', dbPath, '--config', path.join(dir, 'missing-feishu.json')
  ], { cwd: ROOT, encoding: 'utf8', env: childEnv(dbPath) });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not registered|unknown project/i);
}));
