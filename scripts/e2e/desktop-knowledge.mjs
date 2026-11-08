// Companion 知识入口验收：摘要、四个知识请求、知识详情与复用证据。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PersonalKnowledgeStore } from '../../src/personal-store.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const pluginDir = path.join(repoRoot, 'integrations', 'openclaw-plugin');
const { _electron: electron } = createRequire(path.join(pluginDir, 'package.json'))('playwright-core');
const electronPath = createRequire(path.join(repoRoot, 'package.json'))('electron');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const check = (label, condition, detail = '') => {
  if (condition) console.log(`[KNOWLEDGE] OK   ${label}${detail ? ` (${detail})` : ''}`);
  else { failures.push(label); console.error(`[KNOWLEDGE] FAIL ${label}${detail ? ` (${detail})` : ''}`); }
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-knowledge-'));
  const userData = path.join(root, 'userdata');
  const knowledgeDb = path.join(root, 'knowledge.sqlite');
  const ownerDb = path.join(root, 'owner.sqlite');
  const evidence = process.env.EVIDENCE_DIR ?? path.join(root, 'evidence');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({
    pet: { x: 220, y: 180 }, projectId: 'demo', includePaths: ['package.json'],
    gatewayUrl: 'http://127.0.0.1:18789', model: ''
  }, null, 2));

  const personal = new PersonalKnowledgeStore(knowledgeDb);
  let unit;
  try {
    const experience = personal.addExperience({
      contract: 'experience/v1',
      sourceRunId: 'run-a', projectId: 'demo', taskId: 'task-a', domainIds: ['software-engineering'],
      observedProblem: 'retry loop dropped the last attempt',
      actionSummary: 'changed the loop bound and re-ran the smoke test',
      observedOutcome: { status: 'repaired', source: 'owner-store', testStatus: 'pass', executionStatus: 'completed', repairStatus: 'tested_pass' },
      evidenceRefs: ['sandbox:run-a', 'patch:patch-a'],
      environment: { primaryDomain: 'software-engineering', profileId: 'node-smoke', runtime: 'node' },
      facts: ['test passed after repair'], inferences: [], unknowns: [],
      createdAt: new Date().toISOString(), collectorVersion: '1.0.0'
    });
    unit = personal.create({
      title: 'Retry loop bound', content: 'Use i < attempts so the final retry executes.',
      kind: 'claim', layer: 'applied', scope: 'domain', domains: ['software-engineering'],
      tags: ['retry', 'off-by-one'], evidenceRefs: ['sandbox:run-a'],
      verificationStatus: 'verified', sourceRef: 'test'
    });
    personal.addUsage({
      knowledgeId: unit.id, revision: unit.revision, targetRunId: 'run-b', projectId: 'demo-b',
      retrievalReason: 'retry helper fix', applicabilityResult: 'applicable', contextSnapshotId: 'ctx-1',
      outcome: 'succeeded', observedBenefit: 'positive'
    });
    personal.submitProposal({
      targetId: null,
      payload: {
        title: 'Candidate from retry experience', content: 'Consider reading the test contract before changing the loop.',
        kind: 'claim', layer: 'project', scope: 'project', projectId: 'demo',
        domains: ['software-engineering'], tags: ['retry'], evidenceRefs: [`experience:${experience.id}`],
        verificationStatus: 'unverified', relations: {}, sourceRef: 'test'
      },
      meta: { contract: 'knowledge-candidate/v1', sourceExperienceIds: [experience.id], confidence: 0.6 }
    });
  } finally { personal.close(); }

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
    await panel.waitForSelector('#knowledgeSummaryText', { timeout: 15000 });
    await panel.waitForTimeout(1500);
    const summary = await panel.locator('#knowledgeSummaryText').innerText();
    check('knowledge summary shows verified knowledge', /已验证知识 1 条/u.test(summary), summary);
    check('knowledge summary shows candidates', /候选 1 条/u.test(summary), summary);

    await panel.locator('[data-knowledge="verified"]').click();
    await panel.locator('#modalTitle').filter({ hasText: '验证与复用' }).waitFor({ timeout: 10000 });
    await panel.locator('#modal .knowledge-item').first().waitFor({ timeout: 10000 });
    check('verified knowledge is listed', (await panel.locator('#modal .knowledge-item').count()) > 0);
    await panel.screenshot({ path: path.join(evidence, 'knowledge-list.png') });

    await panel.locator('#modal .knowledge-item').first().click();
    await panel.getByText('Use i < attempts so the final retry executes.', { exact: true }).waitFor({ timeout: 10000 });
    const detail = await panel.locator('#modal').innerText();
    check('knowledge detail shows verification', /verified/u.test(detail), detail.slice(0, 120));
    check('knowledge detail shows reuse', /demo-b/u.test(detail), detail.slice(0, 120));
    await panel.screenshot({ path: path.join(evidence, 'knowledge-detail.png') });

    await panel.getByRole('button', { name: '关闭', exact: true }).click();
    await panel.locator('[data-knowledge="today"]').click();
    await panel.locator('#modalTitle').filter({ hasText: '今天学到了什么' }).waitFor({ timeout: 10000 });
    const today = await panel.locator('#modal').innerText();
    check('today view includes the collected experience', /retry loop dropped the last attempt/u.test(today), today.slice(0, 160));
    await panel.getByRole('button', { name: '关闭', exact: true }).click();

    if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
    failed = false;
    console.log('[KNOWLEDGE] PASS');
  } finally {
    if (failed && panel) {
      try { await panel.screenshot({ path: path.join(evidence, 'failure.png') }); } catch { /* best effort */ }
    }
    try { await app.close(); } catch { /* best effort */ }
    if (failed || failures.length > 0) console.error(`[KNOWLEDGE] kept state: ${root}`);
    else fs.rmSync(root, { recursive: true, force: true });
  }
};

run().catch((error) => {
  console.error(`[KNOWLEDGE] FAIL: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
