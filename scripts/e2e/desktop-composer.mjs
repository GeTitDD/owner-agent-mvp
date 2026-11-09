// Companion 主界面验收：Cindy 式活动流、会话时间线、Composer 行为。
//
// 覆盖：活动行、消息列表、模型 chip、Shift+Enter 列表接续、Enter 直接交办、
// 只读分析结果、草稿清理；没有「写入」开关，写入只能由分诊后生成 HITL 写请求。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { OwnerStore } from '../../src/owner-store.mjs';
import { createSyntheticProject } from '../knowledge-loop/fixtures.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const pluginDir = path.join(repoRoot, 'integrations', 'openclaw-plugin');
const { _electron: electron } = createRequire(path.join(pluginDir, 'package.json'))('playwright-core');
const electronPath = createRequire(path.join(repoRoot, 'package.json'))('electron');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const check = (label, condition, detail = '') => {
  if (condition) console.log(`[UI] OK   ${label}${detail ? ` (${detail})` : ''}`);
  else { failures.push(label); console.error(`[UI] FAIL ${label}${detail ? ` (${detail})` : ''}`); }
};

const run = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-ui-'));
  const userData = path.join(root, 'userdata');
  const ownerDb = path.join(root, 'owner.sqlite');
  const knowledgeDb = path.join(root, 'knowledge.sqlite');
  const evidence = process.env.EVIDENCE_DIR ?? path.join(root, 'evidence');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({
    pet: { x: 220, y: 180 }, projectId: 'ui-demo', allowedPaths: 'src/',
    includePaths: ['package.json'], gatewayUrl: 'http://127.0.0.1:18789',
    model: 'test/companion-model', knowledgeAutoHarvest: false, panelPinned: false
  }, null, 2));

  const owner = new OwnerStore(ownerDb);
  let seededJobIds = new Set();
  try {
    createSyntheticProject({ store: owner, root: path.join(root, 'ui-demo'), projectId: 'ui-demo', name: 'UI Demo' });
    seededJobIds = new Set(owner.listJobs({ projectId: 'ui-demo', limit: 100 }).map((job) => job.id));
  } finally { owner.close(); }

  const app = await electron.launch({
    executablePath: electronPath,
    args: [path.join(repoRoot, 'desktop', 'main.cjs'), `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      OWNER_AGENT_DB: ownerDb,
      OWNER_KNOWLEDGE_DB: knowledgeDb,
      OWNER_AGENT_NOTIFICATIONS: '0',
      OWNER_AGENT_E2E_OFFSCREEN: '1',
      // 测试环境没有真实模型：让只读分诊快速超时，验证“失败不伪造写请求”的 UI 路径。
      OWNER_TRIAGE_TIMEOUT_MS: '4000'
    },
    timeout: 60000
  });

  let failed = true;
  let panel;
  try {
    const deadline = Date.now() + 30000;
    let pet = null;
    while ((!pet || !panel) && Date.now() < deadline) {
      pet = app.windows().find((page) => page.url().includes('pet.html')) ?? null;
      panel = app.windows().find((page) => page.url().includes('panel.html')) ?? null;
      if (!pet || !panel) await sleep(300);
    }
    if (!pet || !panel) throw new Error('windows missing');
    await pet.evaluate(() => window.companion.showPanel());
    await panel.waitForSelector('#timeline', { timeout: 20000 });
    await sleep(2500);

    const info = await panel.evaluate(() => ({
      activity: [...document.querySelectorAll('.activity-line')].length,
      messages: document.querySelectorAll('#timeline .msg').length,
      model: document.getElementById('composerModel')?.textContent ?? ''
    }));
    check('activity stream shows lifecycle lines', info.activity >= 2, String(info.activity));
    check('timeline renders messages and tool cards', info.messages >= 3, String(info.messages));
    check('composer shows the current model', info.model.includes('test/companion-model'), info.model);

    const input = panel.locator('#taskInput');
    await input.click();
    await input.type('1. 第一条');
    await input.press('Shift+Enter');
    const listValue = await input.inputValue();
    check('Shift+Enter continues the list', listValue === '1. 第一条\n2. ', JSON.stringify(listValue));

    await input.fill('回归：Enter 直接交办');
    await input.press('Enter');
    // 先只读分析；没有可用模型时应如实显示失败，而不是伪造成写请求。
    await panel.waitForSelector('#answerSection:not([hidden])', { timeout: 30000 });
    const answer = await panel.evaluate(() => ({
      badge: document.getElementById('answerBadge')?.textContent ?? '',
      text: document.getElementById('answerCard')?.innerText ?? ''
    }));
    check('composer no longer shows a write toggle', await panel.locator('#writeMode').count() === 0);
    check('submit renders a read-only analysis result', answer.text.trim().length > 0, answer.badge);
    const draft = await panel.evaluate(() => localStorage.getItem('owner-companion-draft'));
    check('draft is cleared after send', draft === null, String(draft));

    if (answer.badge === '写请求') {
      const pending = await panel.locator('#pendingList .pending-card').count();
      check('write request creates a pending job', pending >= 1, String(pending));
    }

    await panel.screenshot({ path: path.join(evidence, 'panel-composer.png') });

    await panel.screenshot({ path: path.join(evidence, 'panel-composer.png') });

    await panel.locator('#diagnostics').click();
    await panel.locator('#modalTitle').filter({ hasText: '运行诊断' }).waitFor({ timeout: 10000 });
    const diag = await panel.locator('#modal').innerText();
    check('diagnostics shows environment and sandbox plan',
      /userData/u.test(diag) && /沙箱/u.test(diag) && /Playbook/u.test(diag), diag.slice(0, 120));
    await panel.getByRole('button', { name: '关闭', exact: true }).click();

    if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
    failed = false;
  } finally {
    if (failed && panel) {
      try { await panel.screenshot({ path: path.join(evidence, 'panel-failure.png') }); } catch { /* best effort */ }
    }
    await app.close();
  }

  const verify = new OwnerStore(ownerDb);
  try {
    const jobs = verify.listJobs({ projectId: 'ui-demo', limit: 100 });
    const created = jobs.filter((job) => !seededJobIds.has(job.id));
    check('composer never creates legacy code-patch jobs', created.every((job) => job.job_type !== 'code-patch'));
    const pendingJobs = created.filter((job) => job.status === 'pending_approval');
    if (pendingJobs.length) {
      check('write request uses code-write', pendingJobs.every((job) => job.job_type === 'code-write'));
    }
  } finally { verify.close(); }

  if (failures.length > 0) {
    console.error(`[UI] ${failures.length} assertion(s) failed`);
    process.exitCode = 1;
    return;
  }
  console.log('[UI] PASS');
};

run().catch((error) => {
  console.error(`[UI] FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
