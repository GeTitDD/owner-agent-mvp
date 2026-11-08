// 目标回归：多项目时，任务链/阶段/成果只关联当前项目；全局待办明确标注项目。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { OwnerStore } from '../../src/owner-store.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const pluginDir = path.join(repoRoot, 'integrations', 'openclaw-plugin');
const { _electron: electron } = createRequire(path.join(pluginDir, 'package.json'))('playwright-core');
const electronPath = createRequire(path.join(repoRoot, 'package.json'))('electron');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const check = (label, condition, detail = '') => {
  if (condition) console.log(`[MULTI] OK   ${label}${detail ? ` (${detail})` : ''}`);
  else { failures.push(label); console.error(`[MULTI] FAIL ${label}${detail ? ` (${detail})` : ''}`); }
};

const git = (cwd, args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
}).trim();

const makeSecondFixture = (root) => {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'),
    '{"name":"p32-fixture","private":true,"type":"module"}\n', 'utf8');
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.owner-root-identity\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'index.js'), 'export const value = 1;\n', 'utf8');
  fs.writeFileSync(path.join(root, 'tests', 'sandbox-smoke.test.mjs'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('p32 smoke',()=>assert.equal(1,1));\n", 'utf8');
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'user.email', 'p32@example.invalid']);
  git(root, ['config', 'user.name', 'P32 Fixture']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'p32 base']);
  return git(root, ['rev-parse', 'HEAD']);
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-multi-'));
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

  // p31：只有项目，没有任务；p32：有一个待审批 Job。
  execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'e2e', 'seed-p31.mjs')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OWNER_AGENT_DB: dbPath,
      OWNER_E2E_ROOT: path.join(root, 'p31'),
      P31_SKIP_JOB: '1'
    },
    stdio: 'ignore'
  });
  const p32Root = path.join(root, 'p32', 'repo');
  const p32Base = makeSecondFixture(p32Root);
  const store = new OwnerStore(dbPath);
  try {
    store.registerProject({
      id: 'p32',
      name: 'P3.2 Fixture',
      root: p32Root,
      primaryDomain: 'software-engineering'
    });
    const task = store.createTask({ projectId: 'p32', title: 'P3.2 pending task' });
    store.createJob({
      projectId: 'p32',
      jobType: 'code-patch',
      title: 'P3.2 pending job',
      payload: { baseSha: p32Base, allowedPaths: 'src/', focus: 'pending' },
      idempotencyKey: 'p32-job-1',
      ownerTaskId: task.id
    });
  } finally {
    store.close();
  }

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
    await panel.waitForSelector('#pendingList', { timeout: 15000 });
    await panel.waitForTimeout(1800);

    const pendingText = await panel.locator('#pendingList').innerText();
    const stage31 = await panel.locator('#stage').innerText();
    check('global pending shows the other project label', /其他项目 · P3\.2 Fixture/iu.test(pendingText), pendingText);
    check('current project stage ignores the other project job',
      stage31 === '暂时没有进行中的任务', stage31);
    await panel.screenshot({ path: path.join(evidenceDir, 'multi-project-p31.png') });

    await panel.evaluate(() => window.companion.settings.set({ projectId: 'p32' }));
    await panel.waitForTimeout(2600);
    const pendingText32 = await panel.locator('#pendingList').innerText();
    const stage32 = await panel.locator('#stage').innerText();
    check('selected project pending is labelled current', /当前项目 · P3\.2 Fixture/iu.test(pendingText32), pendingText32);
    check('selected project stage follows its own job', stage32 === '任务等你的批准', stage32);
    await panel.screenshot({ path: path.join(evidenceDir, 'multi-project-p32.png') });

    if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
    failed = false;
    console.log('[MULTI] PASS');
  } finally {
    if (failed && panel) {
      try {
        await panel.screenshot({ path: path.join(evidenceDir, 'failure.png') });
      } catch { /* best effort */ }
    }
    try { await app.close(); } catch { /* best effort */ }
    if (failed || failures.length > 0) console.error(`[MULTI] kept state: ${root}`);
    else fs.rmSync(root, { recursive: true, force: true });
  }
};

run().catch((error) => {
  console.error(`[MULTI] FAIL: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
