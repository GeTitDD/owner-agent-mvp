// #84 验收：「自上次看过」（水位）。
//
// 面板层没有自动化测试，这里用离屏 Electron + CDP 走真实路径，并留截图：
//   ① 没有水位时显示「首次查看」，不是「没有变化」；
//   ② 第一次进入后水位落库（表 memory_watermarks）；
//   ③ 有新提交 / 未提交改动 / 观察员事件时，再进来看到差异（先算后推：这次还能看到）；
//   ④ 2 秒轮询刷新不重算、不推进水位（同一批变化不会在刷新时被自己吃掉）；
//   ⑤ 清干净工作区再进来，三类全空压成一行（.compact，没有卡片外框）；
//   ⑥ 重启客户端后水位仍在，窗口按上次水位算（不是重新从「首次查看」开始）。
// 全程用临时 userData + 临时 owner / 知识库，不碰真实 %APPDATA%。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { OwnerStore } from '../../src/owner-store.mjs';
import { PersonalKnowledgeStore } from '../../src/personal-store.mjs';
import { ObserverStore } from '../../src/observer/store.mjs';
import { MemoryWatermarkStore } from '../../src/memory/watermark.mjs';
import { createSyntheticProject } from '../knowledge-loop/fixtures.mjs';
import {
  capture, consoleErrors, createChecker, sleep, startApp, waitFor
} from './lib/cdp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const shotsDir = process.env.SHOTS_DIR
  ?? path.resolve(repoRoot, '..', '..', 'mm-notes', 'shots-84');
const tempBase = process.env.TMP_84 ?? path.resolve(shotsDir, '..', 'tmp-84');
const { check, failures } = createChecker('[SINCE-SEEN-#84]');

const shot = async (panel, file) => capture(panel, path.join(shotsDir, file));

/** 全貌截图：面板固定 440×640，先临时抬高视口再截，工作区那一整段才进得来。 */
const shotTall = async (panel, file, height = 1280) => {
  await panel.send('Emulation.setDeviceMetricsOverride', {
    width: 440, height, deviceScaleFactor: 1, mobile: false
  });
  await sleep(400);
  await shot(panel, file);
  await panel.send('Emulation.clearDeviceMetricsOverride');
  await sleep(200);
};

const makeRoot = (label) => {
  fs.mkdirSync(tempBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, `since-seen-${label}-`));
  const userData = path.join(root, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  return {
    root,
    userData,
    ownerDb: path.join(root, 'owner.sqlite'),
    knowledgeDb: path.join(root, 'knowledge.sqlite')
  };
};

const safeRemove = (target) => {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    console.warn(`[SINCE-SEEN-#84] kept state: ${target}`);
  }
};

const writeCompanionConfig = (userData, projectId) => {
  fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({
    projectId,
    gatewayUrl: 'http://127.0.0.1:18789',
    model: '',
    includePaths: ['package.json'],
    mascotSkin: 'erika'
  }, null, 2));
};

const git = (cwd, args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
}).trim();

/** 读面板上「自上次看过」这一段当前画了什么。 */
const readSection = (panel) => panel.evaluate(`(() => {
  const holder = document.getElementById('sinceLastSeen');
  const groups = [...document.querySelectorAll('#sinceSeenGroups .since-seen-group')].map((group) => ({
    title: group.querySelector('.since-seen-group-head')?.textContent ?? '',
    items: [...group.querySelectorAll('.since-seen-item')].map((item) => ({
      text: item.querySelector('.since-seen-item-text')?.textContent ?? '',
      at: item.querySelector('.since-seen-item-at')?.textContent ?? ''
    }))
  }));
  const line = document.getElementById('sinceSeenLine');
  const note = document.getElementById('sinceSeenNote');
  return {
    hidden: holder ? holder.hidden : true,
    compact: holder ? holder.classList.contains('compact') : false,
    title: document.getElementById('sinceSeenTitle')?.textContent ?? '',
    meta: document.getElementById('sinceSeenMeta')?.textContent ?? '',
    line: line && !line.hidden ? line.textContent : '',
    note: note && !note.hidden ? note.textContent : '',
    groups,
    renderedHeight: holder ? Math.round(holder.getBoundingClientRect().height) : 0,
    bordered: holder ? getComputedStyle(holder).borderTopWidth !== '0px' : false
  };
})()`);

const readWatermark = (ownerDb, projectId) => {
  const store = new MemoryWatermarkStore({ dbPath: ownerDb });
  try { return store.get(projectId)?.at ?? ''; } finally { store.close(); }
};

const enterFocus = async (panel) => {
  await waitFor(panel, "document.querySelector('#modeBar button[data-mode=\"focus\"]')");
  await panel.evaluate("document.querySelector('#modeBar button[data-mode=\"focus\"]').click()");
  await waitFor(panel, '!document.getElementById(\'modeA\').hidden');
};

/** 点另一个项目标签，等切换完成（视图项目与标题都换过去）。 */
const switchTo = async (panel, projectName) => {
  await waitFor(panel, `[...document.querySelectorAll('#fdTabs .fd-tab')]
    .some((tab) => tab.textContent.includes(${JSON.stringify(projectName)}))`);
  await panel.evaluate(`(() => {
    const tab = [...document.querySelectorAll('#fdTabs .fd-tab')]
      .find((node) => node.textContent.includes(${JSON.stringify(projectName)}));
    tab?.click();
  })()`);
  await waitFor(panel, `document.getElementById('workProjectName').textContent.includes(${JSON.stringify(projectName)})`);
  await sleep(500);
};

const runScenario = async (probe) => {
  const { root, userData, ownerDb, knowledgeDb } = makeRoot('flow');
  // 两个项目各一个真实 Git 仓库（fixtures 里已经 init + 首提交）。
  const owner = new OwnerStore(ownerDb);
  let alpha;
  let beta;
  try {
    // listProjects 按 updated_at DESC（后登记的在前），所以先登记 alpha、后登记 beta：
    // 启动默认进入 beta，「alpha 的首次查看」留给验收自己触发，结果可重放。
    alpha = createSyntheticProject({
      store: owner, root: path.join(root, 'alpha'), projectId: 'alpha', name: 'Alpha Repo'
    });
    await sleep(20);
    beta = createSyntheticProject({
      store: owner, root: path.join(root, 'beta'), projectId: 'beta', name: 'Beta Repo'
    });
  } finally {
    owner.close();
  }
  const personal = new PersonalKnowledgeStore(knowledgeDb);
  personal.close();
  writeCompanionConfig(userData, 'alpha');
  probe.fixtures = { alphaRoot: alpha.root, betaRoot: beta.root };

  let app = await startApp({ ownerDb, knowledgeDb, userData, showPanel: true });
  let { panel } = app;
  try {
    await waitFor(panel, 'window.OwnerSinceSeen');
    await enterFocus(panel);
    await waitFor(panel, "!document.getElementById('sinceLastSeen').hidden");
    await waitFor(panel, "document.getElementById('sinceSeenTitle').textContent.trim() !== ''");
    await sleep(400);

    // 启动默认进入 beta（fixtures 后登记）；alpha 还没进过，才有「首次查看」可验。
    const initialProject = await panel.evaluate('document.getElementById("workProjectName").textContent');
    probe.initialProject = initialProject;
    check('启动默认进入 beta（否则首次查看会被启动时吃掉）', initialProject.includes('Beta Repo'), initialProject);
    const betaAt1 = readWatermark(ownerDb, 'beta');
    check('启动进入 beta 后 beta 有水位', Boolean(betaAt1), betaAt1 || '(empty)');

    // 显式进入 alpha：这是 alpha 的第一次查看。
    await switchTo(panel, 'Alpha Repo');
    await waitFor(panel, "!document.getElementById('sinceLastSeen').hidden");
    await waitFor(panel, "document.getElementById('sinceSeenTitle').textContent.trim() !== ''");
    await sleep(300);

    // ① 没有水位：写「首次查看」，不写「没有变化」。
    const first = await readSection(panel);
    probe.firstView = first;
    check('第一次进入显示「首次查看」', first.title === '首次查看', first.title);
    check('首次查看不显示「没有变化」',
      !/没有新变化|都看过了/u.test(first.line + first.note), first.line);
    check('首次查看不压成一行卡片', first.compact === false && first.bordered === true);
    await shotTall(panel, '01-first-view.png');

    // ② 进入之后水位落库。
    const alphaAt1 = readWatermark(ownerDb, 'alpha');
    probe.watermarkAfterFirst = { alpha: alphaAt1, beta: betaAt1 };
    check('第一次进入后 alpha 的水位已落库', Boolean(alphaAt1), alphaAt1 || '(empty)');

    // ③ 做出三类变化：新提交、未提交文件、观察员事件（都发生在上次水位之后）。
    fs.appendFileSync(path.join(alpha.root, 'src', 'retry.js'), '\n// changed after last look\n');
    fs.writeFileSync(path.join(alpha.root, 'src', 'dirty-note.txt'), '未提交的改动\n');
    git(alpha.root, ['add', 'src/retry.js']);
    git(alpha.root, ['commit', '-qm', '新提交：改动 retry 注释']);
    const observer = new ObserverStore(ownerDb);
    try {
      observer.recordEvent({
        type: 'stale',
        fingerprint: 'c'.repeat(64),
        projectId: 'alpha',
        projectName: 'Alpha Repo',
        branch: 'main',
        branchLabel: 'main',
        head: git(alpha.root, ['rev-parse', 'HEAD']),
        lastCommitAt: new Date().toISOString(),
        daysStale: 5,
        detectedAt: new Date().toISOString()
      });
    } finally {
      observer.close();
    }

    // 换到 beta 再回来，算一次「重新进入 alpha」。顺带验水位按项目隔离：
    // 进 beta 只推 beta 的水位，alpha 的一动不动。
    await switchTo(panel, 'Beta Repo');
    await waitFor(panel, "!document.getElementById('sinceLastSeen').hidden");
    await sleep(300);
    const betaSection = await readSection(panel);
    const betaAt2 = readWatermark(ownerDb, 'beta');
    const alphaAfterBeta = readWatermark(ownerDb, 'alpha');
    probe.betaEntry = { section: betaSection, betaAt2, alphaAfterBeta };
    check('看 beta 不改变 alpha 的水位（按项目隔离）', alphaAfterBeta === alphaAt1,
      `${alphaAfterBeta} vs ${alphaAt1}`);
    check('进入 beta 推进的是 beta 自己的水位',
      Boolean(betaAt2) && Date.parse(betaAt2) >= Date.parse(betaAt1), `${betaAt2} vs ${betaAt1}`);
    check('beta 有水位后不再显示「首次查看」', betaSection.title === '自上次看过', betaSection.title);

    await switchTo(panel, 'Alpha Repo');
    await waitFor(panel, "document.querySelectorAll('#sinceSeenGroups .since-seen-group').length > 0");
    await sleep(400);
    const changes = await readSection(panel);
    probe.changes = changes;
    const itemText = changes.groups.flatMap((group) => group.items.map((item) => item.text)).join(' | ');
    const groupTitles = changes.groups.map((group) => group.title.trim());
    check('再进来看到新提交', /新提交：改动 retry 注释/u.test(itemText), itemText);
    check('再进来看到未提交改动', /dirty-note\.txt/u.test(itemText), itemText);
    check('再进来看到观察员事件', /停滞/u.test(itemText), itemText);
    check('三个类目都在（新提交 / 未提交改动 / 观察员事件）',
      ['新提交', '未提交改动', '观察员事件'].every((title) =>
        groupTitles.some((found) => found.startsWith(title))), JSON.stringify(groupTitles));
    check('有变化时是卡片、不压成一行', changes.compact === false && changes.bordered === true);
    await shotTall(panel, '02-changes.png');

    // ④ 2 秒轮询不重算：等两轮刷新，内容与水位的推进结果都不该变。
    const beforeRefresh = readWatermark(ownerDb, 'alpha');
    await sleep(5200);
    const afterRefresh = await readSection(panel);
    const afterRefreshAt = readWatermark(ownerDb, 'alpha');
    probe.refresh = { beforeRefresh, afterRefreshAt, section: afterRefresh };
    check('刷新不重算：同一批变化还在屏幕上',
      afterRefresh.groups.flatMap((group) => group.items.map((item) => item.text)).join(' | ') === itemText,
      JSON.stringify(afterRefresh.groups));
    check('刷新不推进水位', afterRefreshAt === beforeRefresh, `${afterRefreshAt} vs ${beforeRefresh}`);

    // ⑤ 清干净工作区再进来：三类全空 → 压成一行，无卡片外框。
    fs.rmSync(path.join(alpha.root, 'src', 'dirty-note.txt'), { force: true });
    await switchTo(panel, 'Beta Repo');
    await switchTo(panel, 'Alpha Repo');
    await waitFor(panel, "document.getElementById('sinceLastSeen').classList.contains('compact')");
    await sleep(300);
    const empty = await readSection(panel);
    probe.empty = empty;
    check('三类全空压成一行', empty.compact === true, JSON.stringify(empty));
    check('空态是一行文字、没有分组', empty.groups.length === 0 && empty.line.trim() !== '', empty.line);
    check('空态不占卡片（没有外框）', empty.bordered === false, `height=${empty.renderedHeight}`);
    await shotTall(panel, '03-empty-compact.png');

    // ⑥ 重启后水位仍在：alpha 在重启后没有被进入，库里的值应当一行不动；
    // 再显式进入 alpha，面板读持久化的水位，窗口为空且不是「首次查看」。
    const beforeRestart = {
      alpha: readWatermark(ownerDb, 'alpha'),
      beta: readWatermark(ownerDb, 'beta')
    };
    await app.stop();
    app = await startApp({ ownerDb, knowledgeDb, userData, showPanel: true });
    panel = app.panel;
    await waitFor(panel, 'window.OwnerSinceSeen');
    await enterFocus(panel);
    await waitFor(panel, "document.getElementById('workProjectName').textContent.trim() !== ''");
    await sleep(600);
    const afterRestartStorage = {
      alpha: readWatermark(ownerDb, 'alpha'),
      beta: readWatermark(ownerDb, 'beta')
    };
    check('重启后 alpha 的水位与重启前一致（没进过它，一行不动）',
      afterRestartStorage.alpha === beforeRestart.alpha,
      `${afterRestartStorage.alpha} vs ${beforeRestart.alpha}`);
    check('重启后 beta 的水位也还在', Boolean(afterRestartStorage.beta), afterRestartStorage.beta);

    await switchTo(panel, 'Alpha Repo');
    await waitFor(panel, "!document.getElementById('sinceLastSeen').hidden");
    await waitFor(panel, "document.getElementById('sinceSeenTitle').textContent.trim() !== ''");
    await sleep(500);
    const afterRestart = await readSection(panel);
    probe.restart = { beforeRestart, afterRestartStorage, section: afterRestart };
    check('重启后进入 alpha 不是「首次查看」', afterRestart.title === '自上次看过', afterRestart.title);
    check('重启后窗口为空（读的是持久化的水位，不是重新开始）',
      afterRestart.compact === true, `${afterRestart.title} / ${afterRestart.line}`);
    await shotTall(panel, '04-after-restart.png');

    const errors = consoleErrors(panel);
    probe.consoleErrors = errors;
    check('控制台无错误', errors.length === 0, errors.join(' | ').slice(0, 300));
  } finally {
    await app.stop();
  }
  safeRemove(root);
};

const run = async () => {
  fs.mkdirSync(shotsDir, { recursive: true });
  const probe = { shotsDir, tempBase };
  await runScenario(probe);
  fs.writeFileSync(path.join(shotsDir, 'since-seen-probe.json'), JSON.stringify(probe, null, 2));
  if (failures.length) throw new Error(`${failures.length} assertion(s) failed`);
  console.log('[SINCE-SEEN-#84] PASS');
};

run().catch((error) => {
  console.error(`[SINCE-SEEN-#84] FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
