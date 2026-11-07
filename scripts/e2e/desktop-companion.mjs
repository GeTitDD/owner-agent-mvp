// Owner Companion 桌面 E2E：真实 Electron 窗口 + 真实 Docker + 真实 Pi 修复。
//
// 覆盖：桌宠点击展开 → SOP-1（已有待审批 Job）→ SOP-2 审批 →
// Patch 审阅/应用 → Sandbox 审批/失败 → SOP-3 创建修复/批准 →
// 真实 Pi 修复 → 复测 pass → SOP-4 结果查看。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const pluginDir = path.join(repoRoot, 'integrations', 'openclaw-plugin');
const requireFromPlugin = createRequire(path.join(pluginDir, 'package.json'));
const { _electron: electron } = requireFromPlugin('playwright-core');
const electronPath = createRequire(path.join(repoRoot, 'package.json'))('electron');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const check = (label, condition) => {
  if (condition) console.log(`[DESKTOP] OK   ${label}`);
  else { failures.push(label); console.error(`[DESKTOP] FAIL ${label}`); }
};

const run = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-e2e-'));
  const dbPath = path.join(root, 'owner.sqlite');
  const evidenceDir = process.env.EVIDENCE_DIR ?? path.join(root, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });

  // 预置：一个待审批的 code-patch Job（SOP-1 的“任务已存在”侧）。
  execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'e2e', 'seed-p31.mjs')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OWNER_AGENT_DB: dbPath,
      OWNER_E2E_ROOT: path.join(root, 'p31'),
      P31_SKIP_JOB: '1'
    },
    stdio: 'inherit'
  });

  const app = await electron.launch({
    executablePath: electronPath,
    args: [path.join(repoRoot, 'desktop', 'main.cjs')],
    env: {
      ...process.env,
      OWNER_AGENT_DB: dbPath,
      OWNER_COMPANION_FAKE_SOURCE: '1',
      OWNER_AGENT_NOTIFICATIONS: '0'
    },
    timeout: 60000
  });

  app.process().stdout?.on('data', (chunk) => process.stdout.write(`[app] ${chunk}`));
  app.process().stderr?.on('data', (chunk) => process.stderr.write(`[app] ${chunk}`));

  let panel;
  let failed = true;
  try {
    const pet = await app.firstWindow();
    await pet.waitForSelector('#pet', { timeout: 30000 });
    check('pet window loads', true);

    // 等面板窗口创建（隐藏状态），再通过桌宠接口展开。
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      panel = app.windows().find((page) => page.url().includes('panel.html'));
      if (panel) break;
      await sleep(500);
    }
    if (!panel) throw new Error('panel window was not created');
    await pet.evaluate(() => window.companion.showPanel());
    await panel.waitForSelector('#pendingList', { timeout: 15000 });
    await panel.waitForTimeout(1500);
    check('panel opens with a project', await panel.locator('#composeSection').isVisible());

    const shot = async (name) => {
      await panel.screenshot({ path: path.join(evidenceDir, `${name}.png`) });
    };

    // SOP-1：从桌宠输入创建第一条 Coding Job（不需要 CLI）。
    await panel.locator('#taskInput').fill('Fix the failing retry test');
    await panel.locator('#submitTask').click();
    await panel.getByRole('button', { name: '批准任务', exact: true }).waitFor({ timeout: 30000 });
    check('SOP-1 job created from the pet', true);
    await shot('01-pending');

    const approveInModal = async (label) => {
      const modal = panel.locator('#modal');
      await modal.locator('input[type=checkbox]').check();
      await modal.getByRole('button', { name: label, exact: true }).click();
      await panel.waitForTimeout(1200);
    };

    // SOP-2：批准 Job
    await panel.getByRole('button', { name: '批准任务', exact: true }).click();
    await approveInModal('批准');
    await panel.getByText('审阅 Diff', { exact: true }).waitFor({ timeout: 30000 });
    check('worker produced the source patch', true);
    await shot('02-patch-proposed');

    // 审阅并批准补丁
    await panel.getByRole('button', { name: '审阅 Diff', exact: true }).click();
    await panel.locator('#modal pre.diff').waitFor({ timeout: 15000 });
    check('patch modal shows the frozen diff', true);
    await approveInModal('批准补丁');
    await panel.getByRole('button', { name: '应用并请求测试', exact: true }).waitFor({ timeout: 20000 });

    // 应用 + 自动创建 Sandbox
    await panel.getByRole('button', { name: '应用并请求测试', exact: true }).click();
    await approveInModal('应用并请求测试');
    await panel.getByRole('button', { name: '批准测试', exact: true }).waitFor({ timeout: 30000 });
    check('patch applied and sandbox requested', true);
    await shot('03-sandbox-pending');

    // 批准测试
    await panel.getByRole('button', { name: '批准测试', exact: true }).click();
    await approveInModal('批准测试');
    await panel.getByRole('button', { name: '创建修复周期', exact: true }).waitFor({ timeout: 120000 });
    check('source sandbox failed', true);
    await shot('04-sandbox-failed');

    // SOP-3：创建并批准修复
    await panel.getByRole('button', { name: '创建修复周期', exact: true }).click();
    await approveInModal('创建');
    await panel.getByRole('button', { name: '批准修复', exact: true }).waitFor({ timeout: 20000 });
    await panel.getByRole('button', { name: '批准修复', exact: true }).click();
    await approveInModal('批准修复');
    check('repair cycle approved', true);

    // 真实 Pi 生成修复补丁
    await panel.getByText('审阅 Diff', { exact: true }).waitFor({ timeout: 420000 });
    check('real Pi produced the repair patch', true);
    await shot('05-repair-patch');

    // 批准/应用修复补丁
    await panel.getByRole('button', { name: '审阅 Diff', exact: true }).click();
    await panel.locator('#modal pre.diff').waitFor({ timeout: 15000 });
    await approveInModal('批准补丁');
    await panel.getByRole('button', { name: '应用并请求测试', exact: true }).waitFor({ timeout: 20000 });
    await panel.getByRole('button', { name: '应用并请求测试', exact: true }).click();
    await approveInModal('应用并请求测试');
    await panel.getByRole('button', { name: '批准测试', exact: true }).waitFor({ timeout: 30000 });
    await panel.getByRole('button', { name: '批准测试', exact: true }).click();
    await approveInModal('批准测试');

    // 复测 pass + 结果卡
    await panel.getByRole('button', { name: '查看结果', exact: true }).waitFor({ timeout: 180000 });
    check('repair retest passed', true);
    await shot('06-result-card');

    await panel.getByRole('button', { name: '查看结果', exact: true }).click();
    await panel.locator('#modal .detail-rows').waitFor({ timeout: 15000 });
    const resultText = await panel.locator('#modal').innerText();
    check('result modal shows tested_pass', /tested_pass/u.test(resultText));
    check('result modal shows test output', /修复测试输出|源测试输出/u.test(resultText));
    await shot('07-result-detail');

    if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
    failed = false;
    console.log('[DESKTOP] PASS');
  } finally {
    if (failed && panel) {
      try {
        await panel.screenshot({ path: path.join(evidenceDir, 'failure.png') });
        console.error(`[DESKTOP] failure screenshot: ${path.join(evidenceDir, 'failure.png')}`);
      } catch { /* best effort */ }
    }
    try { await app.close(); } catch { /* best effort */ }
    if (failed || failures.length > 0) {
      console.error(`[DESKTOP] kept state: ${root}`);
    } else {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
};

run().catch((error) => {
  console.error(`[DESKTOP] FAIL: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
