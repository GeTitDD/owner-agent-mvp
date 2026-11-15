// 桌宠外壳验收：位置恢复、不抢焦点、隐藏/召回、面板显隐、重启后任务不丢。
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
  if (condition) console.log(`[SHELL] OK   ${label}${detail ? ` (${detail})` : ''}`);
  else { failures.push(label); console.error(`[SHELL] FAIL ${label}${detail ? ` (${detail})` : ''}`); }
};

const launch = async (userData) => electron.launch({
  executablePath: electronPath,
  args: [path.join(repoRoot, 'desktop', 'main.cjs'), `--user-data-dir=${userData}`],
  env: {
    ...process.env,
    OWNER_AGENT_DB: path.join(userData, 'owner.sqlite'),
    OWNER_AGENT_NOTIFICATIONS: '0',
      OWNER_AGENT_E2E_OFFSCREEN: '1'
  },
  timeout: 60000
});

const pageFor = async (app, file) => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const page = app.windows().find((item) => item.url().includes(file));
    if (page) return page;
    await sleep(300);
  }
  throw new Error(`${file} window was not created`);
};

const makeAddProjectFixture = (root) => {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'),
    '{"name":"added-project","private":true,"type":"module"}\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'index.js'), 'export const value = 1;\n', 'utf8');
  fs.writeFileSync(path.join(root, 'tests', 'sandbox-smoke.test.mjs'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('smoke',()=>assert.equal(1,1));\n", 'utf8');
  const git = (args) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
  git(['init', '-q', '-b', 'main']);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'user.email', 'added@example.invalid']);
  git(['config', 'user.name', 'Added Fixture']);
  git(['add', '.']);
  git(['commit', '-qm', 'added base']);
};

const windowInfo = (app) => app.evaluate(({ BrowserWindow }) => {
  const windows = BrowserWindow.getAllWindows();
  const pet = windows.find((win) => win.webContents.getURL().includes('pet.html'));
  const panel = windows.find((win) => win.webContents.getURL().includes('panel.html'));
  return {
    pet: pet ? {
      bounds: pet.getBounds(),
      visible: pet.isVisible(),
      focusable: pet.isFocusable(),
      focused: pet.isFocused()
    } : null,
    panel: panel ? { visible: panel.isVisible(), focused: panel.isFocused() } : null
  };
});

const run = async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-shell-'));
  const evidence = process.env.EVIDENCE_DIR ?? path.join(userData, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({
    pet: { x: 220, y: 180 },
    projectId: '',
    includePaths: ['package.json'],
    gatewayUrl: 'http://127.0.0.1:18789',
    model: ''
  }, null, 2));

  // 预置一个待审批 Job，用于验证「关掉桌宠再打开，任务还在」。
  execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'e2e', 'seed-p31.mjs')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OWNER_AGENT_DB: path.join(userData, 'owner.sqlite'),
      OWNER_E2E_ROOT: path.join(userData, 'p31')
    },
    stdio: 'ignore'
  });

  let app = await launch(userData);
  try {
    const petPage = await pageFor(app, 'pet.html');
    await petPage.waitForSelector('#pet', { timeout: 30000 });
    await sleep(2500);
    const first = await windowInfo(app);
    check('pet restored at saved position', first.pet?.bounds.x === 220 && first.pet?.bounds.y === 180,
      JSON.stringify(first.pet?.bounds));
    check('pet does not focus steal', first.pet?.focusable === false && first.pet?.focused === false);
    check('panel starts hidden', first.panel?.visible === false);
    await petPage.screenshot({ path: path.join(evidence, 'shell-pet.png') });

    await petPage.evaluate(() => window.companion.hidePet());
    await sleep(500);
    const hidden = await windowInfo(app);
    check('pet can hide', hidden.pet?.visible === false);

    await petPage.evaluate(() => window.companion.showPet());
    await sleep(500);
    const shown = await windowInfo(app);
    check('pet can be recalled', shown.pet?.visible === true);

    await petPage.evaluate(() => window.companion.showPanel());
    await sleep(1000);
    const withPanel = await windowInfo(app);
    check('panel opens on demand', withPanel.panel?.visible === true);
    const panelPage = await pageFor(app, 'panel.html');
    await panelPage.getByText('批准任务', { exact: true }).waitFor({ timeout: 15000 });
    check('pending job visible before restart', true);
    const modelResult = await panelPage.evaluate(() => window.companion.settings.set({
      model: 'test/companion-model'
    }));
    check('model change applies while idle',
      modelResult?.modelChanged === true && modelResult?.modelApplied === true
      && modelResult?.modelPending === false,
      JSON.stringify({
        changed: modelResult?.modelChanged,
        applied: modelResult?.modelApplied,
        pending: modelResult?.modelPending
      }));

    // 首次配置路径：通过受控目录选择器注册新项目（曾经误用不存在的 sidecar POST）。
    const addedRoot = path.join(userData, 'added-project');
    makeAddProjectFixture(addedRoot);
    await app.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
    }, addedRoot);
    const added = await panelPage.evaluate(() => window.companion.settings.addProject());
    check('add project registers through the owner store', added?.name === 'added-project',
      JSON.stringify(added));
    await panelPage.waitForTimeout(3500);
    const projectCount = await panelPage.locator('#projectSelect option').count();
    check('added project appears in the project selector', projectCount === 2, String(projectCount));
    await panelPage.screenshot({ path: path.join(evidence, 'shell-panel.png') });

    // 重启：同一个 userData / SQLite，任务与位置都应保持。
    await app.close();
    app = await launch(userData);
    const petAgain = await pageFor(app, 'pet.html');
    await petAgain.waitForSelector('#pet', { timeout: 30000 });
    await sleep(2500);
    const restarted = await windowInfo(app);
    check('pet position survives restart',
      restarted.pet?.bounds.x === 220 && restarted.pet?.bounds.y === 180,
      JSON.stringify(restarted.pet?.bounds));
    check('pet still does not focus steal',
      restarted.pet?.focusable === false && restarted.pet?.focused === false);
    await petAgain.evaluate(() => window.companion.showPanel());
    await sleep(1200);
    const panelAgain = await pageFor(app, 'panel.html');
    await panelAgain.getByText('批准任务', { exact: true }).waitFor({ timeout: 15000 });
    check('pending job survives restart', true);
    await panelAgain.screenshot({ path: path.join(evidence, 'shell-panel-after-restart.png') });

    if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
    console.log('[SHELL] PASS');
  } finally {
    try { await app.close(); } catch { /* best effort */ }
    if (failures.length > 0) console.error(`[SHELL] kept state: ${userData}`);
    else fs.rmSync(userData, { recursive: true, force: true });
  }
};

run().catch((error) => {
  console.error(`[SHELL] FAIL: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
