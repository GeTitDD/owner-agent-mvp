// 项目查找验收：顶部按来源主机分组、每项显示最近进展与时间、可搜索/折叠/切换。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { OwnerStore } from '../../src/owner-store.mjs';
import { PersonalKnowledgeStore } from '../../src/personal-store.mjs';
import { createSyntheticProject } from '../knowledge-loop/fixtures.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const pluginDir = path.join(repoRoot, 'integrations', 'openclaw-plugin');
const { _electron: electron } = createRequire(path.join(pluginDir, 'package.json'))('playwright-core');
const electronPath = createRequire(path.join(repoRoot, 'package.json'))('electron');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const check = (label, condition, detail = '') => {
  if (condition) console.log(`[PROJECTS] OK   ${label}${detail ? ` (${detail})` : ''}`);
  else { failures.push(label); console.error(`[PROJECTS] FAIL ${label}${detail ? ` (${detail})` : ''}`); }
};

const run = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-projects-'));
  const userData = path.join(root, 'userdata');
  const ownerDb = path.join(root, 'owner.sqlite');
  const knowledgeDb = path.join(root, 'knowledge.sqlite');
  const evidence = process.env.EVIDENCE_DIR ?? path.join(root, 'evidence');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });

  const owner = new OwnerStore(ownerDb);
  try {
    const alphaSeed = createSyntheticProject({
      store: owner, root: path.join(root, 'alpha'), projectId: 'alpha', name: 'Alpha Repo'
    });
    owner.saveProjectBrief({
      projectId: 'alpha',
      basedOnCommit: alphaSeed.baseSha,
      sourceRunId: 'pb_test',
      payload: {
        oneLiner: '一个用于验收的零依赖 Node 项目',
        whatItIs: 'Alpha Repo 是测试夹具，包含 format 与 retry 两个模块。',
        howToRun: ['npm test'],
        modules: [{ name: 'retry', role: '重试循环', paths: ['src/retry.js'] }],
        conventions: ['写操作先提案'],
        verify: { commands: ['npm test'], criteria: ['退出码为 0'] },
        risks: ['没有 CI'],
        unknowns: [],
        evidence: ['package.json', 'src/retry.js'],
        confidence: '中'
      }
    });
    createSyntheticProject({
      store: owner, root: path.join(root, 'beta'), projectId: 'beta', name: 'Beta Repo'
    });
    execFileSync('git', [
      '-C', path.join(root, 'alpha'),
      'remote', 'add', 'origin', 'https://github.com/example/alpha.git'
    ]);
    // 直接插入一个 UNC 根路径的项目，验证“按来源主机分组”的远端分组。
    owner.db.prepare(`INSERT INTO owner_projects(
      id,name,root,primary_domain,domains,imports,goal,status,owner_note,created_at,updated_at,root_identity
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'remote-demo', 'Remote Demo', '\\\\build01\\share\\demo', 'software-engineering',
      '[]', '[]', '', 'planned', '', new Date().toISOString(), new Date().toISOString(), ''
    );
  } finally { owner.close(); }

  // 给 alpha 预置项目知识：一条已验证 + 一条未验证 + 一条经验，验证摘要排序与计数。
  const personal = new PersonalKnowledgeStore(knowledgeDb);
  try {
    personal.addExperience({
      contract: 'experience/v1',
      sourceRunId: 'run-a', projectId: 'alpha', taskId: 'task-a',
      domainIds: ['software-engineering'],
      observedProblem: 'retry loop dropped the last attempt',
      actionSummary: 'changed the loop bound and re-ran the smoke test',
      observedOutcome: { status: 'repaired', testStatus: 'pass' },
      evidenceRefs: ['sandbox:run-a'],
      environment: { primaryDomain: 'software-engineering' },
      facts: ['test passed after repair'], inferences: [], unknowns: [],
      createdAt: new Date().toISOString(), collectorVersion: '1.0.0'
    });
    personal.create({
      title: 'Retry loop bound',
      content: 'Use i < attempts so the final retry executes.',
      kind: 'claim', layer: 'project', scope: 'project', projectId: 'alpha',
      domains: ['software-engineering'], tags: ['retry', 'off-by-one'],
      evidenceRefs: ['sandbox:run-a'], verificationStatus: 'verified', sourceRef: 'test'
    });
    personal.create({
      title: 'Run node smoke before patching',
      content: 'Run the node smoke profile before proposing a patch.',
      kind: 'procedure', layer: 'project', scope: 'project', projectId: 'alpha',
      domains: ['software-engineering'], tags: ['sandbox'],
      evidenceRefs: [], verificationStatus: 'unverified', sourceRef: 'test'
    });
  } finally { personal.close(); }

  fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({
    pet: { x: 240, y: 190 }, projectId: 'alpha', mascotSkin: 'erika',
    gatewayUrl: 'http://127.0.0.1:18789', model: '', includePaths: ['package.json']
  }, null, 2));

  const app = await electron.launch({
    executablePath: electronPath,
    args: [path.join(repoRoot, 'desktop', 'main.cjs'), `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      OWNER_AGENT_DB: ownerDb,
      OWNER_KNOWLEDGE_DB: knowledgeDb,
      OWNER_AGENT_NOTIFICATIONS: '0',
      OWNER_AGENT_E2E_OFFSCREEN: '1'
    },
    timeout: 60000
  });

  let failed = true;
  let panel;
  try {
    const deadline = Date.now() + 30000;
    while (!panel && Date.now() < deadline) {
      panel = app.windows().find((page) => page.url().includes('panel.html')) ?? null;
      if (!panel) await sleep(300);
    }
    if (!panel) throw new Error('panel window missing');
    await panel.waitForSelector('#taskInput', { timeout: 20000 });
    await panel.evaluate(() => window.companion.showPanel());
    await panel.waitForSelector('#projectList .project-row', { timeout: 20000 });
    await sleep(1200);
    await panel.evaluate(() => { document.querySelector('.scroll').scrollTop = 0; });
    await sleep(300);
    await panel.screenshot({ path: path.join(evidence, 'panel-zones.png') });

    const groups = await panel.evaluate(() => [...document.querySelectorAll('#projectList .project-group')].map((group) => ({
      host: group.querySelector('.group-name')?.textContent,
      count: group.querySelector('.group-count')?.textContent,
      rows: [...group.querySelectorAll('.project-row')].map((row) => ({
        id: row.dataset.project,
        name: row.querySelector('.row-name')?.textContent,
        progress: row.querySelector('.row-progress')?.textContent,
        time: row.querySelector('.row-time')?.textContent,
        selected: row.classList.contains('selected'),
        badge: row.querySelector('.row-badge')?.textContent ?? ''
      }))
    })));
    const local = groups.find((group) => String(group.host).startsWith('本机'));
    const remote = groups.find((group) => String(group.host).includes('build01'));
    const alpha = local?.rows.find((row) => row.id === 'alpha');
    check('groups projects by source host', Boolean(local) && Boolean(remote), JSON.stringify(groups.map((g) => g.host)));
    check('local group lists both local projects', local?.rows.length === 2, String(local?.rows.length));
    check('unc project goes to the remote group', remote?.rows.length === 1 && remote.rows[0].id === 'remote-demo', JSON.stringify(remote));
    check('project shows its latest progress', Boolean(alpha?.progress) && !alpha.progress.includes('还没有任务记录'), alpha?.progress);
    check('latest progress has a relative time', /刚刚|分钟前|小时前|天前/u.test(alpha?.time ?? ''), alpha?.time);
    check('active project is highlighted', alpha?.selected === true, String(alpha?.selected));
    const briefText = await panel.evaluate(() => document.getElementById('projectBrief')?.innerText ?? '');
    check('project brief renders user-friendly fields',
      briefText.includes('一个用于验收的零依赖 Node 项目')
      && briefText.includes('怎么跑')
      && briefText.includes('怎么验收'),
      briefText.slice(0, 120));
    await panel.locator('#projectBrief').scrollIntoViewIfNeeded();
    await sleep(300);
    await panel.screenshot({ path: path.join(evidence, 'panel-brief.png') });
    const nextText = await panel.evaluate(() => document.getElementById('nextActionCard')?.innerText ?? '');
    check('next action suggests the most useful next step', nextText.length > 0, nextText);
    await panel.fill('#queueInput', 'Queue item A');
    await panel.locator('#queueAdd').click();
    await sleep(500);
    await panel.fill('#queueInput', 'Queue item B');
    await panel.locator('#queueAdd').click();
    await sleep(700);
    const queue = await panel.evaluate(() => [...document.querySelectorAll('#queueList .queue-item')]
      .map((row) => ({ title: row.querySelector('.queue-title')?.textContent, status: row.dataset.status })));
    check('queue supports adding items', queue.length === 2 && queue[0].title === 'Queue item A', JSON.stringify(queue));
    await panel.locator('#queueSection').scrollIntoViewIfNeeded();
    await sleep(300);
    await panel.screenshot({ path: path.join(evidence, 'panel-queue.png') });
    await panel.locator('#queueList .queue-item').first().getByRole('button', { name: '完成' }).click();
    await sleep(600);
    const queueDone = await panel.evaluate(() => ({
      count: document.querySelectorAll('#queueList .queue-item').length,
      done: [...document.querySelectorAll('#queueList .queue-item')].filter((row) => row.dataset.status === 'done').length
    }));
    check('queue item can be completed', queueDone.count === 2 && queueDone.done === 1, JSON.stringify(queueDone));
    await panel.locator('#queueList .queue-item[data-status="todo"]').last().getByRole('button', { name: '×' }).click();
    await sleep(600);
    const queueAfterDelete = await panel.evaluate(() => document.querySelectorAll('#queueList .queue-item').length);
    check('queue item can be removed', queueAfterDelete === 1, String(queueAfterDelete));
    await panel.locator('#tidyKnowledge').click();
    await panel.waitForSelector('#modal:not([hidden])', { timeout: 10000 });
    const tidyText = await panel.locator('#modalBody').innerText();
    check('knowledge tidy scans duplicates and keeps changes manual',
      tidyText.includes('重复') && tidyText.includes('整理只做扫描'), tidyText.slice(0, 120));
    await panel.keyboard.press('Escape');
    await sleep(300);
    await panel.locator('#nextActionCard').scrollIntoViewIfNeeded();
    await sleep(300);
    await panel.screenshot({ path: path.join(evidence, 'panel-brief-next.png') });
    const github = await panel.evaluate(() => {
      const row = document.querySelector('#projectList .project-row[data-project="alpha"]');
      const chip = row?.parentElement?.querySelector('.project-gh');
      const betaRow = document.querySelector('#projectList .project-row[data-project="beta"]');
      return {
        chip: chip ? { text: chip.textContent, title: chip.title } : null,
        betaChip: Boolean(betaRow?.parentElement?.querySelector('.project-gh'))
      };
    });
    check('github repo is linked from git remote',
      Boolean(github.chip) && /example\/alpha/u.test(github.chip.title),
      JSON.stringify(github.chip));
    check('projects without a github remote show no badge', github.betaChip === false);
    await panel.waitForSelector('#githubPanel .github-head', { timeout: 20000 });
    await panel.waitForFunction(() => {
      const text = document.getElementById('githubPanel')?.innerText ?? '';
      return /仓库|无权|没有打开|Issues \d/u.test(text) && !text.includes('正在读取');
    }, { timeout: 20000 });
    const githubPanel = await panel.evaluate(() => ({
      text: document.getElementById('githubPanel')?.innerText ?? '',
      hidden: document.getElementById('githubPanel')?.hidden
    }));
    check('github panel shows the linked repo and gh error',
      githubPanel.hidden === false
      && githubPanel.text.includes('example/alpha')
      && /仓库|无权|gh/iu.test(githubPanel.text),
      JSON.stringify(githubPanel.text));
    const prButton = await panel.locator('#resultCard button', { hasText: '创建 PR' }).count();
    check('tested-pass result offers a PR action', prButton === 1, String(prButton));
    const prGuard = await panel.evaluate(async () => {
      try {
        await window.companion.github.prPreview({ cycleId: 'cycle-alpha' });
        return '';
      } catch (error) {
        return String(error?.message ?? error);
      }
    });
    check('PR preview is blocked when the GitHub repo is unreadable',
      /GitHub 仓库不可用|没有关联/u.test(prGuard), prGuard);
    check('needs section is hidden when nothing is pending',
      await panel.evaluate(() => document.getElementById('needsSection').hidden) === true);

    // 知识摘要：计数、已验证优先、标签、点击打开详情。
    await panel.waitForSelector('#projectSummary .summary-chip', { timeout: 15000 });
    const summary = await panel.evaluate(() => ({
      hidden: document.getElementById('projectSummary').hidden,
      title: document.querySelector('#projectSummary .summary-title')?.textContent,
      chips: [...document.querySelectorAll('#projectSummary .summary-chip')].map((node) => node.textContent),
      items: [...document.querySelectorAll('#projectSummary .summary-item-text')].map((node) => node.textContent),
      tags: [...document.querySelectorAll('#projectSummary .summary-tag')].map((node) => node.textContent)
    }));
    check('project summary is visible under the list', summary.hidden === false && summary.title === '知识摘要', JSON.stringify(summary.title));
    const chipValue = (chips, label) => Number(
      (chips.find((chip) => chip.startsWith(label)) ?? '').replace(/\D+/gu, '')
    ) || 0;
    check('summary shows experience and knowledge counts',
      chipValue(summary.chips, '经验') >= 1 && chipValue(summary.chips, '知识') >= 2
      && chipValue(summary.chips, '已验证') === 1,
      summary.chips.join(' '));
    check('verified knowledge is listed first',
      summary.items[0] === 'Retry loop bound', JSON.stringify(summary.items));
    check('summary shows knowledge tags', summary.tags.includes('#retry'), summary.tags.join(' '));
    await panel.locator('#projectSummary .summary-item').first().click();
    await panel.waitForSelector('#modal:not([hidden])', { timeout: 10000 });
    const detailTitle = await panel.locator('#modalTitle').textContent();
    check('clicking a summary item opens knowledge detail', String(detailTitle).includes('知识详情'), detailTitle);
    await panel.keyboard.press('Escape');
    await sleep(300);
    await panel.screenshot({ path: path.join(evidence, 'panel-project-summary.png') });

    // 搜索过滤
    await panel.fill('#projectSearch', 'beta');
    await sleep(300);
    const filtered = await panel.evaluate(() => [...document.querySelectorAll('#projectList .project-row')]
      .map((row) => row.dataset.project));
    check('search filters the project list', filtered.length === 1 && filtered[0] === 'beta', filtered.join(','));
    await panel.fill('#projectSearch', '');
    await sleep(300);

    // 折叠分组
    const localHead = panel.locator('#projectList .project-group-head', { hasText: '本机' }).first();
    await localHead.click();
    await sleep(200);
    const collapsed = await panel.evaluate(() => document.querySelectorAll('#projectList .project-row').length);
    check('group header collapses its rows', collapsed === 1, String(collapsed));
    await localHead.click();
    await sleep(200);

    // 点击项目行切换
    await panel.locator('#projectList .project-row[data-project="beta"]').click();
    await sleep(1600);
    const switched = await panel.evaluate(async () => ({
      fromApi: (await window.companion.settings.get()).projectId,
      selected: document.querySelector('#projectList .project-row.selected')?.dataset.project
    }));
    check('clicking a project row switches the active project',
      switched.fromApi === 'beta' && switched.selected === 'beta', JSON.stringify(switched));

    await panel.waitForSelector('#projectSummary .summary-chip', { timeout: 15000 });
    await sleep(500);
    const betaSummary = await panel.evaluate(() => ({
      chips: [...document.querySelectorAll('#projectSummary .summary-chip')].map((node) => node.textContent),
      items: [...document.querySelectorAll('#projectSummary .summary-item-text')].map((node) => node.textContent),
      empty: document.querySelector('#projectSummary .summary-empty')?.textContent ?? '',
      harvestDisabled: document.querySelector('#projectSummary .summary-foot button')?.disabled
    }));
    check('summary follows the selected project',
      chipValue(betaSummary.chips, '经验') >= 1
      && chipValue(betaSummary.chips, '已验证') === 0
      && !betaSummary.items.includes('Retry loop bound'),
      betaSummary.chips.join(' '));
    check('project without knowledge lists its collected experiences',
      betaSummary.items.length >= 1, JSON.stringify(betaSummary.items));
    check('harvest entry reflects pending experiences', betaSummary.harvestDisabled === false);

    await panel.screenshot({ path: path.join(evidence, 'panel-projects.png') });
    if (failures.length) throw new Error(`${failures.length} assertion(s) failed`);
    failed = false;
    console.log('[PROJECTS] PASS');
  } finally {
    if (failed && panel) {
      try { await panel.screenshot({ path: path.join(evidence, 'panel-projects-failure.png') }); } catch { /* best effort */ }
    }
    await app.close();
    if (!failures.length) fs.rmSync(root, { recursive: true, force: true });
    else console.error(`[PROJECTS] kept state: ${root}`);
  }
};

run().catch((error) => {
  console.error(`[PROJECTS] FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
