// v1.1 浏览器 E2E：真实 OpenClaw Control UI + 已安装插件 + 真实 Owner sidecar。
//
// 覆盖：Owner 页面加载 → Job 审批 → Patch Diff 查看 → Sandbox 失败结果 → Repair 审批。
// 需要：OPENCLAW_RUNTIME / OPENCLAW_NODE / 已安装并启用 owner-agent 的 profile。
//
// 运行：
//   OPENCLAW_RUNTIME=... OPENCLAW_NODE=... node scripts/e2e/openclaw-ui.mjs
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { OwnerStore } from '../../src/owner-store.mjs';
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
const gatewayPort = Number(process.env.OPENCLAW_PORT ?? '19790');
const channel = process.env.PLAYWRIGHT_CHANNEL ?? 'msedge';
const gatewayEntry = path.join(runtime, 'node_modules', 'openclaw', 'openclaw.mjs');

const failures = [];
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`[E2E] OK   ${label}${detail ? ` (${detail})` : ''}`);
  } else {
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

const run = async () => {
  if (!runtime || !fs.existsSync(gatewayEntry)) {
    throw new Error('OPENCLAW_RUNTIME is not set or openclaw.mjs is missing');
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-ui-e2e-'));
  const dbPath = path.join(root, 'owner.sqlite');
  const evidenceDir = process.env.EVIDENCE_DIR ?? root;

  // 1) 真实链路数据：Job -> Patch -> Sandbox(fail) -> Repair(pending)
  execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'e2e', 'seed-owner.mjs')], {
    cwd: repoRoot,
    env: { ...process.env, OWNER_AGENT_DB: dbPath, OWNER_E2E_ROOT: path.join(root, 'loop') },
    stdio: 'inherit'
  });

  const store = new OwnerStore(dbPath);
  const readToken = resolveSidecarToken({ dbPath });
  const approvalToken = resolveApprovalToken({ dbPath });
  const sidecar = await startSidecar({
    store,
    brokerFactory: () => { throw new Error('broker is not used by the UI E2E'); },
    token: readToken,
    approvalToken,
    port: 0,
    version: '1.1.0-ui-e2e'
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

  const profileDir = path.join(os.homedir(), `.openclaw-${profile}`);
  const browserRoot = path.join(root, 'browser');
  let context;

  try {
    await waitForHttp(`http://127.0.0.1:${gatewayPort}/`);

    const list = execFileSync(nodeBin, [
      gatewayEntry, '--profile', profile, 'plugins', 'list', '--json'
    ], { cwd: runtime, encoding: 'utf8' });
    const plugins = JSON.parse(list.slice(list.indexOf('{')));
    const plugin = (plugins.plugins ?? []).find((entry) => entry.id === 'owner-agent');
    check('owner-agent installed and enabled', Boolean(plugin?.enabled));

    const config = JSON.parse(fs.readFileSync(path.join(profileDir, 'openclaw.json'), 'utf8'));
    check(
      'custom plugin UI enabled',
      config?.gateway?.controlUi?.experimental?.customPlugins === true
    );

    fs.mkdirSync(browserRoot, { recursive: true });
    context = await chromium.launchPersistentContext(browserRoot, {
      channel,
      headless: true,
      viewport: { width: 1440, height: 1000 }
    });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`http://127.0.0.1:${gatewayPort}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(6000);

    // 首次启动会跳到模型设置；回到应用即可。
    const back = page.locator('button').filter({ hasText: /返回应用|Back to app/ }).first();
    if (await back.count()) {
      await back.click({ force: true });
      await page.waitForTimeout(4000);
    }

    // 打开「页面」菜单 → Owner
    const pagesButton = page.locator(
      'nav button[aria-label="页面"], nav button[aria-label="Pages"], '
      + 'nav button[title="页面"], nav button[title="Pages"]'
    ).first();
    if (!(await pagesButton.count())) throw new Error('could not find the Pages navigation button');
    await pagesButton.click({ force: true });
    await page.waitForTimeout(1200);
    await page.getByText('Owner', { exact: true }).first().click({ force: true });
    await page.waitForTimeout(5000);

    check('Owner page mounted', await page.getByText('Owner Agent', { exact: true }).count() > 0);
    const bodyText = await page.locator('body').innerText();
    check('patch proposal visible', /Patch proposals[\s\S]*applied/u.test(bodyText));
    check('sandbox failure visible', /completed\s+completed\s+fail/u.test(bodyText));

    // 审批令牌
    await page.locator('input[placeholder*="approval.token"]').fill(approvalToken);
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    // Job 审批
    await page.getByRole('button', { name: 'Review', exact: true }).first().click();
    await page.waitForTimeout(800);
    const jobDialog = await page.locator('dialog').innerText();
    check('job review shows the job id', /Job id/u.test(jobDialog));
    check('approve is disabled before review',
      await page.getByRole('button', { name: 'Approve job', exact: true }).isDisabled());
    await page.locator('dialog input[type=checkbox]').check();
    await page.getByRole('button', { name: 'Approve job', exact: true }).click();
    await page.waitForTimeout(3000);
    check('job approval notice', /approved/u.test(await page.locator('.owner-notice').innerText()));

    // Patch Diff
    await page.getByRole('button', { name: 'View diff', exact: true }).first().click();
    await page.waitForTimeout(800);
    const patchDialog = await page.locator('dialog').innerText();
    check('patch review shows the frozen diff', patchDialog.includes('Frozen diff'));
    check('patch review shows the proposal hash', patchDialog.includes('6185af42'));
    await page.getByRole('button', { name: 'Close', exact: true }).click();

    // Repair 审批
    await page.getByRole('button', { name: 'Review', exact: true }).last().click();
    await page.waitForTimeout(800);
    const repairDialog = await page.locator('dialog').innerText();
    check('repair review shows the source run', /Source run/u.test(repairDialog));
    check('repair review shows the scope', /Repair scope/u.test(repairDialog));
    await page.locator('dialog input[type=checkbox]').check();
    await page.getByRole('button', { name: 'Approve repair', exact: true }).click();
    await page.waitForTimeout(3000);
    check('repair approval notice', /approved/u.test(await page.locator('.owner-notice').innerText()));
    const after = await page.locator('body').innerText();
    check('repair cycle is queued', /queued/u.test(after));

    fs.mkdirSync(evidenceDir, { recursive: true });
    const shot = path.join(evidenceDir, 'owner-ui-e2e.png');
    await page.screenshot({ path: shot, fullPage: true });
    console.log(`[E2E] screenshot: ${shot}`);

    if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
    console.log('[E2E] PASS');
  } finally {
    if (context) await context.close();
    gateway.kill();
    await sidecar.close();
    store.close();
    if (failures.length > 0) {
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
