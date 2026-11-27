// #107 验收：项目与全局模式；#139 起不选项目时的主内容是定位屏（不再是聚合数字）。
//
// 面板层没有单测先例，这里用离屏 Electron + CDP 走真实路径；纯函数与存储层在
// tests/card-projects.test.mjs 与 tests/locate-screen.test.mjs。全程用本 worktree 专属临时
// userData + 临时 owner / 知识库，不碰真实 %APPDATA%。
//   第一次：空态（定位屏，只读）→ 选项目（无会话时直接开一条绑定它的会话）
//           → 切项目出确认四条 → 取消不改任何状态 → 在本会话切换（跨项目标 + 说明）
//           → 切回全局（定位屏回来、写入被拦）→ 新开会话并切换（无跨项目标）；
//   第二次（同一 userData / 同一库）：当前会话的范围还在；切回跨项目会话仍带标。
// 截图：定位屏、确认弹窗、跨项目标记、新开会话。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { OwnerStore } from '../../src/owner-store.mjs';
import { PersonalKnowledgeStore } from '../../src/personal-store.mjs';
import {
  capture, consoleErrors, createChecker, startApp, waitFor
} from './lib/cdp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const shotsDir = process.env.SHOTS_DIR
  ?? path.resolve(repoRoot, '..', '..', 'mm-notes', 'shots-107');
const tempBase = process.env.TMP_107 ?? path.resolve(shotsDir, '..', 'tmp-107');
const { check, failures } = createChecker('[CARD-PROJECTS-#107]');

/** 界面上所有可断言的形状：顶栏、定位屏、确认弹窗、对话流、会话列表。 */
const readUi = (panel) => panel.evaluate(`(() => {
  const text = (id) => document.getElementById(id)?.textContent?.trim() ?? '';
  return {
    projectLabel: text('projectLabel'),
    projectScope: document.getElementById('projectToggle')?.dataset.scope ?? '',
    projectTitle: document.getElementById('projectToggle')?.title ?? '',
    writeLabel: text('writeScope'),
    writeScope: document.getElementById('writeScope')?.dataset.scope ?? '',
    writeHint: document.getElementById('writeScope')?.closest('.slot')?.title ?? '',
    sessionLabel: text('sessionLabel'),
    crossHidden: document.getElementById('sessionCross')?.hidden !== false,
    crossText: text('sessionCross'),
    projectPopoverHidden: document.getElementById('projectPopover')?.hidden !== false,
    projectOptions: [...document.querySelectorAll('#projectList .project-row')].map((row) => ({
      id: row.dataset.project,
      label: row.querySelector('.project-title')?.textContent?.trim() ?? '',
      current: row.dataset.current === 'true'
    })),
    locateHidden: document.getElementById('locateView')?.hidden !== false,
    locateBadge: document.querySelector('#locateView .locate-badge')?.textContent?.trim() ?? '',
    locateTitle: text('locateTitle'),
    locateHint: text('locateHint'),
    locateStatus: text('locateStatus'),
    locateRows: [...document.querySelectorAll('#locateList .locate-row')].map((row) => ({
      project: row.dataset.project,
      tier: row.dataset.tier,
      name: row.querySelector('.locate-row-name')?.textContent?.trim() ?? '',
      pending: row.querySelector('.locate-pending')?.textContent?.trim() ?? '',
      unread: row.querySelector('.locate-unread')?.textContent?.trim() ?? '',
      unreadKnown: row.querySelector('.locate-unread')?.dataset.known ?? '',
      meta: row.querySelector('.locate-meta')?.textContent?.trim() ?? '',
      decision: row.querySelector('.locate-decision')?.textContent?.trim() ?? ''
    })),
    locateEmpty: document.getElementById('locateEmpty')?.hidden === false ? text('locateEmpty') : '',
    confirmHidden: document.getElementById('projectConfirm')?.hidden !== false,
    confirmTarget: text('confirmTarget'),
    confirmKeys: [...document.querySelectorAll('#confirmItems .confirm-item')]
      .map((row) => row.dataset.key),
    confirmLabels: [...document.querySelectorAll('#confirmItems .confirm-key')]
      .map((node) => node.textContent.trim()),
    confirmTexts: [...document.querySelectorAll('#confirmItems .confirm-text')]
      .map((node) => node.textContent.trim()),
    messages: [...document.querySelectorAll('#messages .msg .bubble')]
      .map((node) => node.textContent.trim()),
    messageCount: document.querySelectorAll('#messages .msg').length,
    blockRows: [...document.querySelectorAll('#messages .block-kv > div')].length,
    inputDisabled: document.getElementById('input')?.disabled === true,
    sessionPopoverHidden: document.getElementById('sessionPopover')?.hidden !== false,
    sessionRows: [...document.querySelectorAll('#sessionList .session-row')].map((row) => ({
      id: row.dataset.id,
      title: row.querySelector('.session-title')?.textContent?.trim() ?? ''
    }))
  };
})()`);

const click = (panel, selector) => panel.evaluate(`(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) return false;
  node.click();
  return true;
})()`);

const setProjectPopover = async (panel, opened) => {
  const hidden = await panel.evaluate("document.getElementById('projectPopover').hidden");
  if (hidden === opened) await click(panel, '#projectToggle');
  return waitFor(panel, `document.getElementById('projectPopover').hidden === ${!opened}`, 5000);
};

const chooseProject = async (panel, projectId) => {
  await setProjectPopover(panel, true);
  return click(panel, `#projectList button[data-project="${projectId}"]`);
};

const setSessionPopover = async (panel, opened) => {
  const hidden = await panel.evaluate("document.getElementById('sessionPopover').hidden");
  if (hidden === opened) await click(panel, '#sessionToggle');
  return waitFor(panel, `document.getElementById('sessionPopover').hidden === ${!opened}`, 5000);
};

/** 等确认弹窗真的出现，并返回它此刻的四条后果。 */
const openConfirmFor = async (panel, projectId) => {
  await setProjectPopover(panel, true);
  await click(panel, `#projectList button[data-project="${projectId}"][data-project-intent="in-session"]`);
  const shown = await waitFor(panel, "document.getElementById('projectConfirm').hidden === false", 5000);
  return shown ? readUi(panel) : null;
};

const safeRemove = (target) => {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    console.warn(`[CARD-PROJECTS-#107] kept state: ${target}`);
  }
};

/**
 * 项目根各自包一层干净的 git 仓库。
 *
 * 临时目录常落在开发仓库内部；不隔离的话 `git status` 会一路找到外层仓库，
 * 把几千个无关改动算进「未提交」。那样 #139 的定位屏会如实把这些已知未读排进
 * 「有未读」档，用来验「没有未读 → 陈旧」的夹具就失真了。
 * git 不可用时保持原样：探测会返回未知，陈旧档的断言同样成立。
 */
const initCleanRepo = (dir) => {
  const run = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (run(['init', '-q']).status !== 0) return false;
  run(['add', '-A']);
  const commit = run([
    '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid',
    'commit', '-q', '-m', 'seed'
  ]);
  return commit.status === 0;
};

/** 造两个项目 + 一份共享的领域知识 + 各一条项目经验。 */
const seedData = ({ root, ownerDb, knowledgeDb }) => {
  const alphaRoot = path.join(root, 'alpha');
  const betaRoot = path.join(root, 'beta');
  fs.mkdirSync(alphaRoot, { recursive: true });
  fs.mkdirSync(betaRoot, { recursive: true });
  for (const dir of [alphaRoot, betaRoot]) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: path.basename(dir), private: true, type: 'module', scripts: { test: 'node --test' }
    }, null, 2), 'utf8');
    initCleanRepo(dir);
  }
  const owner = new OwnerStore(ownerDb);
  try {
    owner.registerProject({
      id: 'alpha', name: 'Alpha Repo', root: alphaRoot,
      primaryDomain: 'software-engineering', domains: ['software-engineering']
    });
    owner.registerProject({
      id: 'beta', name: 'Beta Repo', root: betaRoot,
      primaryDomain: 'software-engineering', domains: ['software-engineering']
    });
  } finally {
    owner.close();
  }
  const personal = new PersonalKnowledgeStore(knowledgeDb);
  try {
    // 同领域知识：两个项目的库视图都会读到它（项目胶囊 / 关联项目仍用这份口径）。
    personal.create({
      title: 'Retry loop bound',
      content: 'Use i < attempts so the final retry executes.',
      kind: 'claim', layer: 'applied', scope: 'domain',
      domains: ['software-engineering'], tags: ['retry'],
      evidenceRefs: ['knowledge:retry'], verificationStatus: 'verified', sourceRef: 'acceptance-107'
    });
    personal.recordLesson({
      projectId: 'alpha',
      sourceRecordId: 'lesson-alpha-107',
      phenomenon: 'Alpha 的循环少跑一次',
      mechanism: '边界写成 attempts - 1',
      countermeasure: '改成 attempts 并用同一条断言复跑',
      scope: { layer: 'project', projectId: 'alpha', domainIds: ['software-engineering'] },
      verificationStatus: 'inferred'
    }, { evidence: [{ ref: 'lesson-alpha-107', recordId: 'lesson-alpha-107', kind: 'record' }] });
    personal.recordLesson({
      projectId: 'beta',
      sourceRecordId: 'lesson-beta-107',
      phenomenon: 'Beta 的重试在抖动下偶发失败',
      mechanism: '没有退避',
      countermeasure: '先记录，等复现再改',
      scope: { layer: 'project', projectId: 'beta', domainIds: ['software-engineering'] },
      verificationStatus: 'inferred'
    }, { evidence: [{ ref: 'lesson-beta-107', recordId: 'lesson-beta-107', kind: 'record' }] });
  } finally {
    personal.close();
  }
};

const firstRun = async ({ userData, ownerDb, knowledgeDb }) => {
  const app = await startApp({
    userData, ownerDb, knowledgeDb,
    showPanel: true,
    page: 'shell.html'
  });
  const { panel } = app;
  const seen = { crossSessionId: '', betaSessionId: '' };
  try {
    check('卡片壳在项目模式下仍能启动',
      await waitFor(panel, "document.querySelector('#projectToggle')", 30000));

    // ① 空态 = 全局：顶栏明说全局，写范围只读，中部是定位屏（不是聚合数字）。
    await waitFor(panel, "document.querySelectorAll('#locateList .locate-row').length === 2", 30000);
    let ui = await readUi(panel);
    check('没有会话时默认是全局', ui.projectLabel === '全局' && ui.projectScope === 'global',
      `${ui.projectLabel}/${ui.projectScope}`);
    check('全局模式明确标「只读」', ui.writeLabel === '只读·全局'
      && ui.writeScope === 'global'
      && /只读/u.test(ui.writeHint), `${ui.writeLabel} | ${ui.writeHint}`);
    check('不选项目时是定位屏，不再显示聚合数字',
      ui.locateHidden === false && ui.locateBadge === '只读' && /待确认候选/u.test(ui.locateHint),
      `${ui.locateBadge} | ${ui.locateHint}`);
    check('定位屏为每个项目给一行',
      ui.locateRows.map((row) => row.project).sort().join(',') === 'alpha,beta',
      ui.locateRows.map((row) => row.project).join(','));
    check('每行显示待确认 / 三类未读 / 上次看过 / 最近决策',
      ui.locateRows.every((row) => row.name
        && row.pending.length > 0
        && /未读/u.test(row.unread)
        && row.meta.length > 0
        && row.decision.length > 0),
      ui.locateRows.map((row) => `${row.name}|${row.pending}|${row.unread}|${row.meta}|${row.decision}`).join(' / '));
    // 两个项目都没有水位、工作树干净（各自独立仓库）：没有已知未读 → 陈旧档；列表不折叠。
    check('读不到变化的项目标「未知」，不写成 0',
      ui.locateRows.every((row) => row.unreadKnown === 'false' && /未知/u.test(row.unread)
        && !/\b0 提交/u.test(row.unread)),
      ui.locateRows.map((row) => row.unread).join(' | '));
    check('没有待确认也没有水位的项目排在陈旧档，列表不折叠',
      ui.locateRows.length === 2 && ui.locateRows.every((row) => row.tier === 'stale'),
      ui.locateRows.map((row) => row.tier).join(','));
    await capture(panel, path.join(shotsDir, 'projects-locate.png'));

    // 项目胶囊：全局第一项，当前项是全局。
    await setProjectPopover(panel, true);
    ui = await readUi(panel);
    check('项目胶囊含「全局」与已登记项目',
      ui.projectOptions[0]?.label === '全局'
      && ui.projectOptions.slice(1).map((option) => option.label).sort().join('/') === 'Alpha Repo/Beta Repo',
      ui.projectOptions.map((option) => option.label).join('/'));
    check('当前项标在「全局」上', ui.projectOptions[0]?.current === true);

    // ② 没有会话时选项目：直接开一条绑定它的会话（没有历史需要交代）。
    check('无会话时选项目能开新会话', await chooseProject(panel, 'alpha'));
    check('新会话与项目一致：定位屏收起、写范围回到自有',
      await waitFor(panel, "document.getElementById('projectLabel').textContent.trim() === 'Alpha Repo'"
        + " && document.getElementById('locateView').hidden === true", 10000));
    ui = await readUi(panel);
    check('绑项目的新会话不打跨项目标', ui.crossHidden === true, ui.crossText);
    check('绑项目后写范围不再是「只读·全局」', ui.writeLabel === '写·自有' && ui.writeScope === 'own',
      `${ui.writeLabel}/${ui.writeScope}`);
    check('有会话后输入框可用', ui.inputDisabled === false);

    // ③ 切项目必须先确认：四条后果 + 两个出口。
    ui = await openConfirmFor(panel, 'beta');
    check('切项目先出确认弹窗', Boolean(ui) && ui.confirmHidden === false);
    check('确认弹窗点名从哪个项目切到哪个项目',
      /Alpha Repo/u.test(ui.confirmTarget) && /Beta Repo/u.test(ui.confirmTarget), ui.confirmTarget);
    check('四条后果按固定顺序：历史归属 / 读取来源 / 写入落点 / 跨项目记号',
      ui.confirmKeys.join(',') === 'history,read,write,cross'
      && ui.confirmLabels.join(',') === '历史归属,读取来源,写入落点,跨项目记号',
      `${ui.confirmKeys.join(',')} | ${ui.confirmLabels.join(',')}`);
    check('四条都落到具体文案（点名项目与落点）',
      ui.confirmTexts.length === 4
      && ui.confirmTexts.every((text) => text.length > 8)
      && /Alpha Repo/u.test(ui.confirmTexts[0])
      && /Beta Repo/u.test(ui.confirmTexts[1])
      && /Beta Repo/u.test(ui.confirmTexts[2])
      && /跨项目/u.test(ui.confirmTexts[3]),
      ui.confirmTexts.join(' | '));
    await capture(panel, path.join(shotsDir, 'projects-confirm.png'));

    // ④ 取消不改变任何状态。
    const beforeCancel = await readUi(panel);
    await click(panel, '#confirmCancel');
    check('取消后弹窗收起', await waitFor(panel, "document.getElementById('projectConfirm').hidden === true", 5000));
    const afterCancel = await readUi(panel);
    check('取消不改项目范围', afterCancel.projectLabel === beforeCancel.projectLabel
      && afterCancel.writeLabel === beforeCancel.writeLabel);
    check('取消不改会话与对话流',
      afterCancel.crossHidden === beforeCancel.crossHidden
      && afterCancel.messageCount === beforeCancel.messageCount
      && afterCancel.sessionLabel === beforeCancel.sessionLabel);

    // ⑤ 在本会话切换：绑定不动、打跨项目标、流里追加一条说明。
    ui = await openConfirmFor(panel, 'beta');
    check('再次打开确认仍然可用', Boolean(ui) && ui.confirmKeys.length === 4);
    await click(panel, '#confirmInSession');
    check('在本会话切换后正在看 Beta',
      await waitFor(panel, "document.getElementById('projectLabel').textContent.trim() === 'Beta Repo'", 10000));
    ui = await readUi(panel);
    check('在本会话切换后打「跨项目」标', ui.crossHidden === false && ui.crossText === '跨项目',
      `${ui.crossHidden}/${ui.crossText}`);
    check('流里追加一条说明：历史属 Alpha、之后按 Beta 算',
      ui.messages.some((text) => /历史属于「Alpha Repo」/u.test(text))
      && ui.messages.some((text) => /按「Beta Repo」读、按「Beta Repo」写/u.test(text)),
      ui.messages.join(' | '));
    check('说明带结构化归属块（历史 / 读取 / 写入 / 记号）',
      ui.blockRows >= 4, String(ui.blockRows));
    check('切到项目后定位屏收起', ui.locateHidden === true);
    seen.crossSessionId = await panel.evaluate(
      "document.querySelector('#sessionList .session-row')?.dataset.id ?? ''"
    );
    await capture(panel, path.join(shotsDir, 'projects-cross.png'));

    // ⑥ 切回全局：仍打标（绑定还在 Alpha），写入被拦，定位屏重新出现。
    ui = await openConfirmFor(panel, '');
    check('切回全局也要确认', Boolean(ui) && ui.confirmKeys.length === 4
      && /全局/u.test(ui.confirmTarget), ui?.confirmTarget);
    await click(panel, '#confirmInSession');
    check('切回全局后顶栏写「全局」',
      await waitFor(panel, "document.getElementById('projectLabel').textContent.trim() === '全局'", 10000));
    ui = await readUi(panel);
    check('全局模式仍标「只读·全局」', ui.writeLabel === '只读·全局' && ui.writeScope === 'global');
    check('全局模式下仍保留跨项目标（绑定 Alpha ≠ 全局）', ui.crossHidden === false, ui.crossText);
    check('全局模式下定位屏重新出现', ui.locateHidden === false && ui.locateBadge === '只读');
    const gate = await panel.evaluate(`(async () => {
      const api = window.OwnerCardScope;
      if (!api) return null;
      return {
        denied: api.globalWriteOutcome({ viewProjectId: '', destination: 'project' }),
        own: api.globalWriteOutcome({ viewProjectId: '', destination: 'own' }),
        scoped: api.globalWriteOutcome({ viewProjectId: 'beta', destination: 'project' }),
        scope: api.writeScopeText({ viewProjectId: '' })
      };
    })()`);
    check('全局模式下写项目目录被拦，并要求先选项目',
      gate?.denied?.outcome === 'deny' && /先选一个项目/u.test(gate?.denied?.reason ?? ''),
      gate?.denied?.reason);
    check('全局模式不拦自有目录写入（消息仍能落库）', gate?.own?.outcome === 'allow',
      gate?.own?.reason);
    check('选了项目后回到 ADR-0012 的分级（未授权→确认）', gate?.scoped?.outcome === 'confirm',
      gate?.scoped?.reason);
    check('写范围文案与判定同源', gate?.scope?.label === '只读·全局', gate?.scope?.label);
    await capture(panel, path.join(shotsDir, 'projects-locate-session.png'));

    // ⑦ 新开会话并切换：会话与项目一致，没有跨项目标。
    ui = await openConfirmFor(panel, 'beta');
    check('新开会话前也要确认', Boolean(ui) && ui.confirmKeys.length === 4);
    await click(panel, '#confirmNewSession');
    check('新开会话后正在看 Beta',
      await waitFor(panel, "document.getElementById('projectLabel').textContent.trim() === 'Beta Repo'"
        + " && document.querySelectorAll('#messages .msg').length === 0", 15000));
    ui = await readUi(panel);
    check('新开会话与项目一致：无跨项目标', ui.crossHidden === true, ui.crossText);
    check('新开会话从零开始', ui.messageCount === 0, String(ui.messageCount));
    seen.betaSessionId = await panel.evaluate(
      "document.querySelector('#sessionList .session-row')?.dataset.id ?? ''"
    );
    await setSessionPopover(panel, true);
    ui = await readUi(panel);
    check('会话列表里现在有两条会话', ui.sessionRows.length === 2,
      ui.sessionRows.map((row) => row.title).join(' | '));
    seen.crossSessionId = ui.sessionRows.find((row) => row.id !== seen.betaSessionId)?.id ?? seen.crossSessionId;
    await setSessionPopover(panel, false);
    await capture(panel, path.join(shotsDir, 'projects-new-session.png'));

    const errors = consoleErrors(panel);
    check('第一次运行控制台干净', errors.length === 0, errors.slice(0, 3).join(' | '));
    return seen;
  } finally {
    await app.stop();
  }
};

const secondRun = async ({ userData, ownerDb, knowledgeDb }, seen) => {
  const app = await startApp({
    userData, ownerDb, knowledgeDb,
    showPanel: true,
    page: 'shell.html'
  });
  const { panel } = app;
  try {
    check('重启后仍是卡片壳', await waitFor(panel, "document.querySelector('#projectToggle')", 30000));
    check('重启后回到上次的会话与项目',
      await waitFor(panel, "document.getElementById('projectLabel').textContent.trim() === 'Beta Repo'", 15000));
    let ui = await readUi(panel);
    check('新开会话重启后仍与项目一致（无跨项目标）', ui.crossHidden === true, ui.crossText);
    check('新开会话重启后仍是空的', ui.messageCount === 0, String(ui.messageCount));

    // 切回跨项目会话：视图范围跟着会话回来，标还在，说明还在。
    await setSessionPopover(panel, true);
    ui = await readUi(panel);
    const cross = ui.sessionRows.find((row) => row.id === seen.crossSessionId);
    check('跨项目会话仍在列表里', Boolean(cross), ui.sessionRows.map((row) => row.id).join(','));
    if (cross) await click(panel, `#sessionList .session-row[data-id="${cross.id}"] button[data-act="switch"]`);
    // 这条跨项目会话最后停在全局（第一次运行里又切回了全局）：范围本身也要跟着回来。
    check('切回跨项目会话后回到它上次的范围（全局）',
      await waitFor(panel, "document.getElementById('projectLabel').textContent.trim() === '全局'", 10000));
    ui = await readUi(panel);
    check('跨项目标跨重启保留', ui.crossHidden === false && ui.crossText === '跨项目', ui.crossText);
    check('定位屏也跟着会话回来', ui.locateHidden === false && ui.locateBadge === '只读');
    check('切换说明跨重启保留',
      ui.messages.some((text) => /历史属于「Alpha Repo」/u.test(text)), ui.messages.join(' | '));
    check('两次切换各留一条说明（历史归属从未被改写）',
      ui.messages.filter((text) => /切换项目/u.test(text)).length === 2
      && ui.messages.every((text) => !/历史属于「Beta Repo」/u.test(text)),
      ui.messages.join(' | '));

    const errors = consoleErrors(panel);
    check('重启后控制台干净', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await app.stop();
  }
};

const run = async () => {
  fs.mkdirSync(tempBase, { recursive: true });
  fs.mkdirSync(shotsDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'card-projects-107-'));
  const userData = path.join(root, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  const files = {
    userData,
    ownerDb: path.join(root, 'owner.sqlite'),
    knowledgeDb: path.join(root, 'knowledge.sqlite')
  };
  fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({
    projectId: '', gatewayUrl: 'http://127.0.0.1:1', model: '', includePaths: ['package.json']
  }, null, 2));
  seedData({ root, ...files });
  try {
    const seen = await firstRun(files);
    await secondRun(files, seen);
  } finally {
    if (failures.length === 0) safeRemove(root);
    else console.warn(`[CARD-PROJECTS-#107] kept state: ${root}`);
  }
  if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
  console.log(`[CARD-PROJECTS-#107] screenshots: ${shotsDir}`);
  console.log('[CARD-PROJECTS-#107] PASS');
};

run().catch((error) => {
  console.error(`[CARD-PROJECTS-#107] FAIL: ${error.stack ?? error.message}`);
  if (failures.length > 0) console.error(`[CARD-PROJECTS-#107] screenshots kept: ${shotsDir}`);
  process.exitCode = 1;
});
