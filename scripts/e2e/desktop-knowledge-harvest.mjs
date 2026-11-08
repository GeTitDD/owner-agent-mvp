// Companion 手动提炼验收：项目隔离的待提炼计数 → 一键提炼 → 只生成待审核候选。
//
// 需要可用的 Pi 模型（默认 supergpt-deepseek/deepseek-v4.1-flash）；不在 CI 中运行。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { OwnerStore } from '../../src/owner-store.mjs';
import { PersonalKnowledgeStore } from '../../src/personal-store.mjs';
import { ExperienceCollector } from '../../src/knowledge-loop/experience.mjs';
import { createSyntheticProject } from '../knowledge-loop/fixtures.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const pluginDir = path.join(repoRoot, 'integrations', 'openclaw-plugin');
const { _electron: electron } = createRequire(path.join(pluginDir, 'package.json'))('playwright-core');
const electronPath = createRequire(path.join(repoRoot, 'package.json'))('electron');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const check = (label, condition, detail = '') => {
  if (condition) console.log(`[HARVEST] OK   ${label}${detail ? ` (${detail})` : ''}`);
  else { failures.push(label); console.error(`[HARVEST] FAIL ${label}${detail ? ` (${detail})` : ''}`); }
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-harvest-'));
  const userData = path.join(root, 'userdata');
  const ownerDb = path.join(root, 'owner.sqlite');
  const knowledgeDb = path.join(root, 'knowledge.sqlite');
  const evidence = process.env.EVIDENCE_DIR ?? path.join(root, 'evidence');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({
    pet: { x: 220, y: 180 },
    projectId: 'hv-demo',
    allowedPaths: 'src/',
    includePaths: ['package.json'],
    gatewayUrl: 'http://127.0.0.1:18789',
    model: process.env.OWNER_MODEL || 'supergpt-deepseek/deepseek-v4.1-flash',
    knowledgeAutoHarvest: false,
    panelPinned: false
  }, null, 2));

  // 1. 两个终态 Run → 两条经验（当前项目）
  const owner = new OwnerStore(ownerDb);
  const personal = new PersonalKnowledgeStore(knowledgeDb);
  try {
    createSyntheticProject({ store: owner, root: path.join(root, 'hv-demo'), projectId: 'hv-demo', name: 'HV Demo' });
    const collector = new ExperienceCollector(owner, personal);
    collector.collectSandboxRun('run-hv-demo-source');
    collector.collectSandboxRun('run-hv-demo-repair');
    // 另一个项目的经验：用于验证“待提炼”按项目隔离，不计入当前项目。
    personal.addExperience({
      contract: 'experience/v1', sourceRunId: 'run-other', projectId: 'other-project', taskId: null,
      domainIds: ['software-engineering'], observedProblem: 'other project problem',
      actionSummary: 'other', observedOutcome: { status: 'failed', source: 'owner-store', testStatus: 'fail' },
      evidenceRefs: ['sandbox:run-other'], environment: { primaryDomain: 'software-engineering', runtime: 'node' },
      facts: [], inferences: [], unknowns: [], createdAt: new Date().toISOString()
    });
  } finally { owner.close(); personal.close(); }

  const app = await electron.launch({
    executablePath: electronPath,
    args: [path.join(repoRoot, 'desktop', 'main.cjs'), `--user-data-dir=${userData}`],
    env: { ...process.env, OWNER_AGENT_DB: ownerDb, OWNER_KNOWLEDGE_DB: knowledgeDb, OWNER_AGENT_NOTIFICATIONS: '0' },
    timeout: 60000
  });

  let failed = true;
  let panel;
  try {
    const pet = await pageFor(app, 'pet.html');
    await pet.waitForSelector('#pet', { timeout: 30000 });
    panel = await pageFor(app, 'panel.html');
    await pet.evaluate(() => window.companion.showPanel());
    await panel.waitForSelector('#harvestNow', { timeout: 20000 });
    await panel.waitForTimeout(3000);

    const summary = await panel.locator('#knowledgeSummaryText').innerText();
    check('summary is scoped to the current project', /待提炼 2/u.test(summary), summary.replace(/\n/u, ' | '));
    check('other project experience is not counted', !/待提炼 3/u.test(summary));
    check('harvest button is enabled when pending > 0', await panel.locator('#harvestNow').isEnabled());

    await panel.locator('#harvestNow').click();
    await panel.locator('#modalTitle').filter({ hasText: '提炼经验' }).waitFor({ timeout: 10000 });
    await panel.screenshot({ path: path.join(evidence, 'harvest-confirm.png') });
    await panel.getByRole('button', { name: '开始提炼' }).click();
    await panel.locator('#modalTitle').filter({ hasText: '提炼完成' }).waitFor({ timeout: 300000 });
    const done = await panel.locator('#modal').innerText();
    check('harvest reports processed experiences', /已处理 2 条经验/u.test(done), done.slice(0, 120));
    check('harvest result states candidates still need review', /待审核/u.test(done));
    await panel.screenshot({ path: path.join(evidence, 'harvest-result.png') });
    await panel.getByRole('button', { name: '去知识库审核' }).count();
    check('result offers a path to review', await panel.getByRole('button', { name: '去知识库审核' }).count() > 0);

    if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
    failed = false;
  } finally {
    if (failed && panel) {
      try { await panel.screenshot({ path: path.join(evidence, 'harvest-failure.png') }); } catch { /* best effort */ }
    }
    await app.close();
  }

  // 2. 关库后确认：只产生 pending 候选，没有知识单元、没有 verified。
  const verify = new PersonalKnowledgeStore(knowledgeDb);
  try {
    const proposals = verify.proposals('pending').filter((item) => item.meta?.contract === 'knowledge-candidate/v1');
    const hv = proposals.filter((item) => item.payload?.projectId === 'hv-demo');
    check('pending candidates were created for the project', hv.length > 0, String(hv.length));
    check('no knowledge unit was written automatically', verify.list({ limit: 100 }).length === 0);
    const harvestRuns = verify.listHarvestRuns(10);
    check('harvest run recorded the two experiences', harvestRuns[0]?.experienceIds?.length === 2, String(harvestRuns[0]?.experienceIds?.length));
  } finally { verify.close(); }

  if (failures.length > 0) {
    console.error(`[HARVEST] ${failures.length} assertion(s) failed`);
    process.exitCode = 1;
    return;
  }
  console.log('[HARVEST] PASS');
};

run().catch((error) => {
  console.error(`[HARVEST] FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
