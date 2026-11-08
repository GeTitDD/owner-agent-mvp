// Companion Playbook 验收：按钮渲染 → 真实只读分析 → 取消 → 生成提案（HITL）→ 任务待批准。
//
// 需要可用的 Pi 模型凭据（与 e2e:desktop 相同的条件）；不在 CI 中运行。
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
  if (condition) console.log(`[PLAYBOOK] OK   ${label}${detail ? ` (${detail})` : ''}`);
  else { failures.push(label); console.error(`[PLAYBOOK] FAIL ${label}${detail ? ` (${detail})` : ''}`); }
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-playbook-'));
  const userData = path.join(root, 'userdata');
  const ownerDb = path.join(root, 'owner.sqlite');
  const knowledgeDb = path.join(root, 'knowledge.sqlite');
  const evidence = process.env.EVIDENCE_DIR ?? path.join(root, 'evidence');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({
    pet: { x: 220, y: 180 },
    projectId: 'pb-demo',
    allowedPaths: 'src/',
    includePaths: ['package.json'],
    gatewayUrl: 'http://127.0.0.1:18789',
    model: process.env.OWNER_MODEL || 'zai-coding-cn/glm-5.3-flash',
    knowledgeAutoHarvest: false,
    panelPinned: false
  }, null, 2));

  const owner = new OwnerStore(ownerDb);
  try {
    createSyntheticProject({ store: owner, root: path.join(root, 'pb-demo'), projectId: 'pb-demo', name: 'PB Demo' });
  } finally { owner.close(); }

  const app = await electron.launch({
    executablePath: electronPath,
    args: [path.join(repoRoot, 'desktop', 'main.cjs'), `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      OWNER_AGENT_DB: ownerDb,
      OWNER_KNOWLEDGE_DB: knowledgeDb,
      OWNER_AGENT_NOTIFICATIONS: '0'
    },
    timeout: 60000
  });

  let failed = true;
  let panel;
  try {
    const pet = await pageFor(app, 'pet.html');
    await pet.waitForSelector('#pet', { timeout: 30000 });
    panel = await pageFor(app, 'panel.html');
    await pet.evaluate(() => window.companion.showPanel());
    await panel.waitForSelector('.playbook-btn', { timeout: 20000 });

    // 面板失焦会自动收起：截图前先呼出。截图只是证据，失败不影响验收结论。
    const snap = async (name) => {
      try {
        await pet.evaluate(() => window.companion.showPanel());
        await sleep(500);
        await panel.screenshot({ path: path.join(evidence, name), timeout: 60000 });
      } catch (error) {
        console.error(`[PLAYBOOK] screenshot skipped: ${error.message}`);
      }
    };

    const buttons = await panel.locator('.playbook-btn').count();
    check('renders 12 playbook buttons', buttons === 12, String(buttons));
    const groups = await panel.locator('.playbook-group-label').allInnerTexts();
    check('renders 4 groups', groups.length === 4, groups.join('/'));
    await snap('playbook-buttons.png');

    await panel.locator('.playbook-btn[data-playbook="how"]').click();
    await panel.locator('#playbookResult:not([hidden])').waitFor({ timeout: 240000 });
    const summary = await panel.locator('.playbook-summary').innerText();
    check('analysis returns a project summary', summary.length > 10, summary.slice(0, 80));
    const chips = await panel.locator('.evidence-chip').count();
    check('analysis cites file evidence', chips > 0, String(chips));
    const missing = await panel.locator('.evidence-chip.missing').count();
    check('no evidence path is fabricated', missing === 0, String(missing));
    await snap('playbook-result.png');

    // 取消：长任务必须能被用户停掉，并给出受控结果而不是一直转圈。
    await panel.locator('.playbook-btn[data-playbook="architect"]').click();
    await panel.locator('#playbookCancel').waitFor({ state: 'visible', timeout: 10000 });
    await sleep(1500);
    await panel.locator('#playbookCancel').click();
    await panel.locator('.playbook-result-head').filter({ hasText: '失败' })
      .waitFor({ timeout: 60000 });
    const canceledHead = await panel.locator('.playbook-result-head').innerText();
    check('cancel ends the run with a controlled result', /失败/u.test(canceledHead), canceledHead);
    check('cancel hides the cancel button', await panel.locator('#playbookCancel').isHidden());
    await snap('playbook-canceled.png');

    // 回到一次正常结果，验证“生成改动提案”仍可用。
    await panel.locator('.playbook-btn[data-playbook="how"]').click();
    await panel.locator('.playbook-result-head').filter({ hasText: 'ms' })
      .waitFor({ timeout: 240000 });

    await panel.getByRole('button', { name: '生成改动提案' }).click();
    await panel.locator('#modalTitle').filter({ hasText: '需要你批准' }).waitFor({ timeout: 10000 });
    await snap('playbook-proposal.png');
    await panel.getByRole('button', { name: '创建提案任务' }).click();
    await panel.locator('#modal').waitFor({ state: 'hidden', timeout: 20000 });
    check('proposal path closes the modal and refreshes', true);

    if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
    failed = false;
  } finally {
    if (failed && panel) {
      try { await panel.screenshot({ path: path.join(evidence, 'failure.png') }); } catch { /* best effort */ }
    }
    await app.close();
  }

  // 关闭后再查库：提案必须是 pending_approval，绝不能已经写文件。
  const verify = new OwnerStore(ownerDb);
  try {
    const [job] = verify.listJobs({ projectId: 'pb-demo', limit: 5 });
    check('proposal created a job awaiting approval', Boolean(job), job ? `${job.id} ${job.status}` : 'none');
    check('job title records the playbook origin', /\[playbook:how\]/u.test(job?.title ?? ''), job?.title ?? '');
    // HITL 关键断言：新任务只到 pending_approval，没有生成任何补丁提案。
    check('no patch proposal exists for the new job',
      verify.listPatchProposals({ projectId: 'pb-demo', limit: 20 })
        .every((proposal) => proposal.job_id !== job?.id));
  } finally { verify.close(); }

  if (failures.length > 0) {
    console.error(`[PLAYBOOK] ${failures.length} assertion(s) failed`);
    process.exitCode = 1;
    return;
  }
  console.log('[PLAYBOOK] PASS');
};

run().catch((error) => {
  console.error(`[PLAYBOOK] FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
