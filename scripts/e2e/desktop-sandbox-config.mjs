// 目标回归：补丁应用后自动创建 Sandbox 失败时，必须如实提示并可重试。
//
// 场景：项目缺少快照测试配置 → 补丁仍可应用，但“测试创建”必须失败；
// 补齐配置后，用同一面板的“重试创建测试”创建出待批准的 Sandbox。
// 不运行 Docker，不调用模型（使用 fake source patch）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const pluginDir = path.join(repoRoot, 'integrations', 'openclaw-plugin');
const { _electron: electron } = createRequire(path.join(pluginDir, 'package.json'))('playwright-core');
const electronPath = createRequire(path.join(repoRoot, 'package.json'))('electron');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const check = (label, condition, detail = '') => {
  if (condition) console.log(`[SANDBOX-CONFIG] OK   ${label}${detail ? ` (${detail})` : ''}`);
  else { failures.push(label); console.error(`[SANDBOX-CONFIG] FAIL ${label}${detail ? ` (${detail})` : ''}`); }
};

const pageFor = async (app, file) => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const page = app.windows().find((item) => item.url().includes(file));
    if (page) return page;
    await sleep(300);
  }
  throw new Error(`${file} window was not created`);
};

const run = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-sandbox-config-'));
  const userData = path.join(root, 'userdata');
  const dbPath = path.join(root, 'owner.sqlite');
  const evidenceDir = process.env.EVIDENCE_DIR ?? path.join(root, 'evidence');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({
    pet: { x: 220, y: 180 },
    projectId: 'p31',
    includePaths: ['package.json'],
    gatewayUrl: 'http://127.0.0.1:18789',
    model: ''
  }, null, 2));

  // 预置一个待批准 Job；Composer 现在先走只读分诊，测试环境没有模型，因此直接从 store 预置。
  execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'e2e', 'seed-p31.mjs')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OWNER_AGENT_DB: dbPath,
      OWNER_E2E_ROOT: path.join(root, 'p31')
    },
    stdio: 'ignore'
  });

  const app = await electron.launch({
    executablePath: electronPath,
    args: [path.join(repoRoot, 'desktop', 'main.cjs'), `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      OWNER_AGENT_DB: dbPath,
      OWNER_COMPANION_FAKE_SOURCE: '1',
      OWNER_AGENT_NOTIFICATIONS: '0'
    },
    timeout: 60000
  });

  let failed = true;
  let panel;
  try {
    const pet = await pageFor(app, 'pet.html');
    await pet.waitForSelector('#pet', { timeout: 30000 });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      panel = app.windows().find((page) => page.url().includes('panel.html'));
      if (panel) break;
      await sleep(300);
    }
    if (!panel) throw new Error('panel window was not created');
    await pet.evaluate(() => window.companion.showPanel());
    await panel.waitForSelector('#composeSection', { timeout: 15000 });
    await panel.waitForTimeout(1200);

    // 配置一个不存在的快照文件，模拟陌生项目缺少测试配置。
    await panel.evaluate(() => window.companion.settings.set({
      includePaths: 'missing/project-test.js'
    }));
    await panel.waitForTimeout(800);
    check('snapshot config warning is visible',
      await panel.locator('#testWarning').isVisible(),
      await panel.locator('#testWarningText').innerText());

    await panel.waitForSelector('#pendingList .pending-card', { timeout: 30000 });
    check('seeded job is visible in the needs-you queue',
      (await panel.locator('#pendingList .pending-card').count()) >= 1);

    const approveInModal = async (label) => {
      const modal = panel.locator('#modal');
      await modal.locator('input[type=checkbox]').check();
      await modal.getByRole('button', { name: label, exact: true }).click();
      await panel.waitForTimeout(1200);
    };

    await panel.getByRole('button', { name: '批准任务', exact: true }).click();
    await approveInModal('批准写请求');
    await panel.getByRole('button', { name: '审阅 Diff', exact: true }).waitFor({ timeout: 30000 });
    await panel.getByRole('button', { name: '审阅 Diff', exact: true }).click();
    await panel.locator('#modal pre.diff').waitFor({ timeout: 15000 });
    await approveInModal('批准补丁');
    await panel.getByRole('button', { name: '应用并请求测试', exact: true }).waitFor({ timeout: 20000 });
    await panel.getByRole('button', { name: '应用并请求测试', exact: true }).click();
    await approveInModal('应用并请求测试');

    // 关键断言：补丁已应用，但测试没有创建，并且能看到缺少哪些文件。
    await panel.getByText('补丁已应用，但测试未创建', { exact: true }).waitFor({ timeout: 15000 });
    const failureText = await panel.locator('#modal').innerText();
    check('sandbox failure is shown as failure', true);
    check('failure explains the fixed node-smoke path', /tests\/sandbox-smoke\.test\.mjs/u.test(failureText), failureText);
    check('failure names the custom missing path', /missing\/project-test\.js/u.test(failureText), failureText);
    check('failure never claims the test was requested', !/已请求测试/u.test(failureText));
    await panel.screenshot({ path: path.join(evidenceDir, 'sandbox-config-failure.png') });

    // 补齐配置后，用同一个弹窗重试创建 Sandbox。
    await panel.evaluate(() => window.companion.settings.set({ includePaths: 'package.json' }));
    await panel.getByRole('button', { name: '重试创建测试', exact: true }).click();
    await panel.getByRole('button', { name: '批准测试', exact: true }).waitFor({ timeout: 30000 });
    check('retry creates the pending sandbox run', true);
    check('retry closes the failure dialog', await panel.locator('#modal').isHidden());
    await panel.screenshot({ path: path.join(evidenceDir, 'sandbox-config-retry.png') });

    if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
    failed = false;
    console.log('[SANDBOX-CONFIG] PASS');
  } finally {
    if (failed && panel) {
      try {
        await panel.screenshot({ path: path.join(evidenceDir, 'failure.png') });
      } catch { /* best effort */ }
    }
    try { await app.close(); } catch { /* best effort */ }
    if (failed || failures.length > 0) console.error(`[SANDBOX-CONFIG] kept state: ${root}`);
    else fs.rmSync(root, { recursive: true, force: true });
  }
};

run().catch((error) => {
  console.error(`[SANDBOX-CONFIG] FAIL: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
