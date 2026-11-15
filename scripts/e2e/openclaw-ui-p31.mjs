// P3.1 浏览器 E2E：完整客户端闭环。
//
// Job(待审批) -> 审批 -> Advance -> Patch -> 审批/应用 -> Sandbox -> 审批 -> Advance
// -> fail -> Create repair -> 审批 -> Advance -> 真实 Pi 修复补丁 -> 审批/应用
// -> Sandbox -> 审批 -> Advance -> pass -> 结果展示
//
// 源补丁用确定性 Fake（只加注释，保留 bug），修复补丁走真实 Pi。
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { OwnerStore } from '../../src/owner-store.mjs';
import { WorkspaceBroker } from '../../src/workspace-broker.mjs';
import { DockerSandboxProvider } from '../../src/sandbox-provider.mjs';
import { FakePatchProposalAgent, PatchProposalAgent } from '../../src/patch-proposal-agent.mjs';
import { OwnerWorker } from '../../src/worker-agent.mjs';
import {
  resolveApprovalToken,
  resolveSidecarToken,
  startSidecar
} from '../../src/sidecar-server.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const pluginDir = path.join(repoRoot, 'integrations', 'openclaw-plugin');
const requireFromPlugin = createRequire(path.join(pluginDir, 'package.json'));
const { chromium } = requireFromPlugin('playwright-core');

const runtime = process.env.OPENCLAW_RUNTIME ?? '';
const nodeBin = process.env.OPENCLAW_NODE ?? process.execPath;
const profile = process.env.OPENCLAW_PROFILE ?? 'ownerpoc';
const gatewayPort = Number(process.env.OPENCLAW_PORT ?? '19791');
const channel = process.env.PLAYWRIGHT_CHANNEL ?? 'msedge';
const repairTimeout = Math.max(60000, Number(process.env.REPAIR_TIMEOUT ?? '300000'));
const gatewayEntry = path.join(runtime, 'node_modules', 'openclaw', 'openclaw.mjs');

const BUGGY = `export function withRetry(fn, { attempts = 3 } = {}) {
  let lastError;
  // 真实 bug：off-by-one，只尝试 attempts - 1 次。
  for (let i = 0; i < attempts - 1; i += 1) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
`;
const COMMENTED = `${BUGGY}\n// touched by p31 source patch\n`;

const failures = [];
const check = (label, condition, detail = '') => {
  if (condition) console.log(`[E2E] OK   ${label}${detail ? ` (${detail})` : ''}`);
  else {
    failures.push(label);
    console.error(`[E2E] FAIL ${label}${detail ? ` (${detail})` : ''}`);
  }
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

const waitFor = async (label, predicate, timeoutMs = 120000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${label}`);
};

const run = async () => {
  if (!runtime || !fs.existsSync(gatewayEntry)) {
    throw new Error('OPENCLAW_RUNTIME is not set or openclaw.mjs is missing');
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-p31-'));
  const dbPath = path.join(root, 'owner.sqlite');
  const evidenceDir = process.env.EVIDENCE_DIR ?? root;

  execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'e2e', 'seed-p31.mjs')], {
    cwd: repoRoot,
    env: { ...process.env, OWNER_AGENT_DB: dbPath, OWNER_E2E_ROOT: path.join(root, 'p31') },
    stdio: 'inherit'
  });

  const store = new OwnerStore(dbPath);
  const broker = new WorkspaceBroker(store, { workspacesRoot: path.join(root, 'workspaces') });
  const realAgent = new PatchProposalAgent({ timeoutMs: repairTimeout });
  const fakeSource = new FakePatchProposalAgent({
    files: [{ path: 'src/retry.js', action: 'modify', content: COMMENTED }]
  });
  const worker = new OwnerWorker(store, {
    broker,
    provider: new DockerSandboxProvider({ requireRootless: false }),
    proposalAgent: {
      requiresModel: false,
      async generate(input) {
        if (String(input.repairContext ?? '').trim()) return realAgent.generate(input);
        return fakeSource.generate(input);
      }
    },
    allowModel: true,
    timeoutMs: repairTimeout,
    leaseMs: 180000
  });

  const repoDigest = execFileSync('docker', [
    'image', 'inspect', 'node:22-alpine', '--format', '{{index .RepoDigests 0}}'
  ], { encoding: 'utf8' }).trim();
  const imageDigest = repoDigest.split('@')[1];
  if (!/^sha256:[0-9a-f]{64}$/u.test(imageDigest ?? '')) {
    throw new Error(`could not resolve node:22-alpine digest from ${repoDigest}`);
  }

  const sidecar = await startSidecar({
    store,
    brokerFactory: () => broker,
    worker,
    token: resolveSidecarToken({ dbPath }),
    approvalToken: resolveApprovalToken({ dbPath }),
    imageDigest,
    sandboxRoot: path.join(root, 'sandbox'),
    port: 0,
    version: '1.2.0-p3-e2e'
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
      OWNER_AGENT_SIDECAR_URL: `http://127.0.0.1:${sidecar.port}`,
      OWNER_AGENT_SIDECAR_TOKEN_FILE: path.join(root, 'sidecar.token')
    }
  });
  let gatewayLog = '';
  gateway.stdout.on('data', (chunk) => { gatewayLog += chunk.toString(); });
  gateway.stderr.on('data', (chunk) => { gatewayLog += chunk.toString(); });

  const approvalToken = resolveApprovalToken({ dbPath });
  const browserRoot = path.join(root, 'browser');
  let context;
  let page;
  let failed = true;

  try {
    await waitForHttp(`http://127.0.0.1:${gatewayPort}/`);
    fs.mkdirSync(browserRoot, { recursive: true });
    context = await chromium.launchPersistentContext(browserRoot, {
      channel,
      headless: true,
      viewport: { width: 1440, height: 1000 }
    });
    page = context.pages()[0] ?? await context.newPage();
    page.on('dialog', (dialog) => {
      if (dialog.type() === 'prompt') {
        void dialog.accept('package.json,tests/sandbox-smoke.test.mjs');
      } else {
        void dialog.accept();
      }
    });

    await page.goto(`http://127.0.0.1:${gatewayPort}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(6000);
    const back = page.locator('button').filter({ hasText: /返回应用|Back to app/ }).first();
    if (await back.count()) {
      await back.click({ force: true });
      await page.waitForTimeout(4000);
    }
    const pagesButton = page.locator(
      'nav button[aria-label="页面"], nav button[aria-label="Pages"], '
      + 'nav button[title="页面"], nav button[title="Pages"]'
    ).first();
    await pagesButton.click({ force: true });
    await page.waitForTimeout(1200);
    await page.getByText('Owner', { exact: true }).first().click({ force: true });
    await page.waitForTimeout(5000);

    await page.locator('input[placeholder*="approval.token"]').fill(approvalToken);
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    const bodyHas = async (text) => {
      const body = await page.locator('body').innerText();
      return text instanceof RegExp ? text.test(body) : body.includes(text);
    };
    const advance = async () => {
      const button = page.getByRole('button', { name: 'Advance', exact: true });
      await button.waitFor({ state: 'visible' });
      await button.click();
      await page.waitForTimeout(1000);
    };

    // 1) 审批 Job
    const jobRow = page.locator('tr').filter({ hasText: 'Add a clarifying comment' }).first();
    await jobRow.getByRole('button', { name: 'Review', exact: true }).click();
    await page.locator('dialog input[type=checkbox]').check();
    await page.getByRole('button', { name: 'Approve job', exact: true }).click();
    await page.waitForTimeout(2500);
    check('job approved', await bodyHas(/Add a clarifying comment[\s\S]*queued/u));

    // 2) Advance -> 源补丁
    await advance();
    await waitFor('source patch proposed', async () => (await page.getByRole('button', { name: 'Review', exact: true }).count()) > 0, 60000);
    check('source patch proposed', true);

    // 3) 审批源补丁
    await page.locator('tbody tr').filter({ hasText: 'src/retry.js' }).first()
      .getByRole('button', { name: 'Review', exact: true }).click();
    await page.locator('dialog input[type=checkbox]').check();
    await page.getByRole('button', { name: 'Approve patch (no apply)', exact: true }).click();
    await page.waitForTimeout(2500);

    // 4) 应用源补丁
    await page.locator('tbody tr').filter({ hasText: 'src/retry.js' }).first()
      .getByRole('button', { name: 'Review & apply', exact: true }).click();
    await page.locator('dialog input[type=checkbox]').check();
    await page.getByRole('button', { name: 'Apply approved patch', exact: true }).click();
    await page.waitForTimeout(2500);

    // 5) 创建 Sandbox
    await page.getByRole('button', { name: 'Create sandbox run', exact: true }).first().click();
    await page.waitForTimeout(2000);

    // 6) 审批 Sandbox
    await page.locator('tbody tr').filter({ hasText: 'pending_approval' }).first()
      .getByRole('button', { name: 'Review', exact: true }).click();
    await page.locator('dialog input[type=checkbox]').check();
    await page.getByRole('button', { name: 'Approve sandbox', exact: true }).click();
    await page.waitForTimeout(2500);

    // 7) Advance -> 失败
    await advance();
    await waitFor('sandbox fail', () => bodyHas(/\bfail\b/u), 120000);
    check('source sandbox fails', true);

    // 8) 创建 Repair
    await page.getByRole('button', { name: 'Create repair', exact: true }).first().click();
    await page.waitForTimeout(2000);

    // 9) 审批 Repair
    await page.locator('tbody tr').filter({ hasText: 'pending_approval' }).last()
      .getByRole('button', { name: 'Review', exact: true }).click();
    await page.locator('dialog input[type=checkbox]').check();
    await page.getByRole('button', { name: 'Approve repair', exact: true }).click();
    await page.waitForTimeout(2500);

    // 10) Advance -> 真实 Pi 修复补丁
    await advance();
    await waitFor('repair patch proposed', async () => (await page.getByRole('button', { name: 'Review', exact: true }).count()) > 0, repairTimeout);
    check('repair patch proposed by real Pi', true);

    // 11) 审批/应用修复补丁（按状态定位，避免选到旧的 applied 补丁）
    await page.locator('tbody tr').filter({ hasText: 'proposed' }).first()
      .getByRole('button', { name: 'Review', exact: true }).click();
    await page.locator('dialog input[type=checkbox]').check();
    await page.getByRole('button', { name: 'Approve patch (no apply)', exact: true }).click();
    await page.waitForTimeout(2500);
    await page.locator('tbody tr').filter({ hasText: 'approved' }).first()
      .getByRole('button', { name: 'Review & apply', exact: true }).click();
    await page.locator('dialog input[type=checkbox]').check();
    await page.getByRole('button', { name: 'Apply approved patch', exact: true }).click();
    await page.waitForTimeout(2500);

    // 12) 修复后的 Sandbox
    await page.getByRole('button', { name: 'Create sandbox run', exact: true }).first().click();
    await page.waitForTimeout(2000);
    await page.locator('tbody tr').filter({ hasText: 'pending_approval' }).first()
      .getByRole('button', { name: 'Review', exact: true }).click();
    await page.locator('dialog input[type=checkbox]').check();
    await page.getByRole('button', { name: 'Approve sandbox', exact: true }).click();
    await page.waitForTimeout(2500);
    await advance();
    await waitFor('repair sandbox pass', () => bodyHas(/\bpass\b/u), 120000);
    check('repair sandbox passes', true);

    // 13) 结果展示
    const resultButton = page.getByRole('button', { name: 'View result', exact: true }).first();
    if (await resultButton.count()) {
      await resultButton.click();
      await page.waitForTimeout(1500);
      const dialogText = await page.locator('dialog').innerText();
      check('result shows tested pass', /tested_pass/u.test(dialogText));
      check('result shows test output', /Repair test output|Source test output/u.test(dialogText));
      await page.getByRole('button', { name: 'Close', exact: true }).click();
    } else {
      check('result button available', false);
    }

    fs.mkdirSync(evidenceDir, { recursive: true });
    const shot = path.join(evidenceDir, 'p31-loop.png');
    await page.screenshot({ path: shot, fullPage: true });
    console.log(`[E2E] screenshot: ${shot}`);

    if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
    failed = false;
    console.log('[E2E] PASS');
  } finally {
    if (failed && page) {
      try {
        fs.mkdirSync(evidenceDir, { recursive: true });
        await page.screenshot({ path: path.join(evidenceDir, 'p31-failure.png'), fullPage: true });
        console.error(`[E2E] failure screenshot: ${path.join(evidenceDir, 'p31-failure.png')}`);
      } catch { /* best effort */ }
    }
    if (context) await context.close();
    gateway.kill();
    await sidecar.close();
    store.close();
    if (failed || failures.length > 0) {
      console.error('[E2E] gateway log tail:');
      console.error(gatewayLog.slice(-3000));
      console.error(`[E2E] kept state for inspection: ${root}`);
    } else {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
};

run().catch((error) => {
  console.error(`[E2E] FAIL: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
