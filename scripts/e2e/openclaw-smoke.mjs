// v1.1 端到端冒烟：真实 Gateway + 真实 sidecar + 已安装的 Owner 插件。
//
// 目标（可审计、可进 CI）：
// 1. Control UI 由真实 Gateway 提供（HTTP 200）；
// 2. owner-agent 插件在独立 profile 中已安装、已启用、已加载；
// 3. 读取令牌不能审批，审批令牌可以；
// 4. 审批写入 owner_decision_audit。
//
// 需要：
// - OPENCLAW_RUNTIME：包含 node_modules/openclaw/openclaw.mjs 的目录；
// - OPENCLAW_NODE：启动 Gateway 的 Node 24 可执行文件（默认 process.execPath）；
// - 该 profile 已安装 owner-agent（见 README）。
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OwnerStore } from '../../src/owner-store.mjs';
import {
  approvalTokenPath,
  resolveApprovalToken,
  resolveSidecarToken,
  sidecarTokenPath,
  startSidecar
} from '../../src/sidecar-server.mjs';

const runtime = process.env.OPENCLAW_RUNTIME ?? '';
const nodeBin = process.env.OPENCLAW_NODE ?? process.execPath;
const profile = process.env.OPENCLAW_PROFILE ?? 'owner-e2e';
const gatewayPort = Number(process.env.OPENCLAW_PORT ?? '19790');
const gatewayEntry = path.join(runtime, 'node_modules', 'openclaw', 'openclaw.mjs');

const fail = (message) => {
  console.error(`[E2E] FAIL: ${message}`);
  process.exitCode = 1;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForHttp = async (url, timeoutMs = 120000) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (response.ok) return response;
      last = `status ${response.status}`;
    } catch (error) {
      last = error.message;
    }
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${url}: ${last}`);
};

const call = async (base, method, routePath, { token, approval, body } = {}) => {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (approval) headers['x-owner-approval-token'] = approval;
  if (method === 'POST') {
    headers['content-type'] = 'application/json';
    headers['x-owner-origin'] = JSON.stringify({
      gatewayInstanceId: 'e2e',
      sessionKey: 'agent:main:e2e',
      runId: 'run-e2e',
      operatorId: 'owner'
    });
  }
  const response = await fetch(`${base}${routePath}`, {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

const run = async () => {
  if (!runtime || !fs.existsSync(gatewayEntry)) {
    fail('OPENCLAW_RUNTIME is not set or openclaw.mjs is missing; see integrations/openclaw-plugin/README.md');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-e2e-'));
  const store = new OwnerStore(path.join(root, 'owner.sqlite'));
  store.registerProject({ id: 'e2e', name: 'E2E', root });
  const task = store.createTask({ projectId: 'e2e', title: 'E2E task' });
  const job = store.createJob({
    projectId: 'e2e',
    jobType: 'status-note',
    title: 'E2E job',
    payload: {},
    idempotencyKey: 'e2e-job-1',
    ownerTaskId: task.id
  });

  const readToken = resolveSidecarToken({ dbPath: store.dbPath });
  const approvalToken = resolveApprovalToken({ dbPath: store.dbPath });
  const sidecar = await startSidecar({
    store,
    brokerFactory: () => { throw new Error('broker is not used in this smoke'); },
    token: readToken,
    approvalToken,
    port: 0,
    version: '1.1.0-e2e'
  });

  const gateway = spawn(nodeBin, [
    gatewayEntry,
    '--profile', profile,
    'gateway',
    '--allow-unconfigured',
    '--auth', 'none',
    '--bind', 'loopback',
    '--port', String(gatewayPort)
  ], {
    cwd: runtime,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OWNER_AGENT_SIDECAR_URL: `http://127.0.0.1:${sidecar.port}`
    }
  });
  let gatewayLog = '';
  gateway.stdout.on('data', (chunk) => { gatewayLog += chunk.toString(); });
  gateway.stderr.on('data', (chunk) => { gatewayLog += chunk.toString(); });

  try {
    const page = await waitForHttp(`http://127.0.0.1:${gatewayPort}/`);
    const html = await page.text();
    console.log(`[E2E] Control UI HTTP ${page.status}, title=${/<title>([^<]*)<\/title>/u.exec(html)?.[1] ?? '?'}`);
    if (!/<title>[^<]*OpenClaw[^<]*<\/title>/u.test(html)) fail('Control UI title is unexpected');

    const list = spawnSyncJson(nodeBin, [
      gatewayEntry, '--profile', profile, 'plugins', 'list', '--json'
    ], runtime);
    const plugin = (list.plugins ?? []).find((entry) => entry.id === 'owner-agent');
    if (!plugin) fail('owner-agent is not installed in this profile');
    else {
      console.log(`[E2E] plugin enabled=${plugin.enabled} status=${plugin.status ?? '?'} source=${plugin.source ?? '?'}`);
      if (!plugin.enabled) fail('owner-agent is installed but not enabled');
    }

    const base = `http://127.0.0.1:${sidecar.port}`;
    const readOnly = await call(base, 'POST', `/owner/v1/jobs/${job.id}/approve`, { token: readToken });
    console.log(`[E2E] read token approve -> ${readOnly.status}`);
    if (readOnly.status !== 403) fail('read token must not approve');

    const approved = await call(base, 'POST', `/owner/v1/jobs/${job.id}/approve`, { approval: approvalToken });
    console.log(`[E2E] approval token approve -> ${approved.status}`);
    if (approved.status !== 200) fail('approval token should approve');

    const audit = store.listDecisionAudit({ subjectType: 'job', subjectId: job.id });
    console.log(`[E2E] decision audit rows=${audit.length} principal=${audit[0]?.principal_kind ?? '?'}`);
    if (audit.length !== 1 || audit[0].principal_kind !== 'approval-token') {
      fail('decision audit is missing or not bound to the approval token');
    }

    console.log('[E2E] PASS');
  } finally {
    gateway.kill();
    await sidecar.close();
    store.close();
    if (process.exitCode) {
      console.error('[E2E] gateway log tail:');
      console.error(gatewayLog.slice(-3000));
      console.error(`[E2E] kept state for inspection: ${root}`);
    } else {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
};

// 同步调用 CLI 并解析 JSON（避免额外依赖）。
const spawnSyncJson = (execPath, args, cwd) => {
  const output = execFileSync(execPath, args, { cwd, encoding: 'utf8' });
  const start = output.indexOf('{');
  return JSON.parse(output.slice(start));
};

run().catch((error) => {
  fail(error.stack ?? error.message);
});
