// 项目库验收（#89）：工作区里的「项目库」段——两节、计数、生成草稿、发布版本、空库空态。
//
// 用 scripts/e2e/lib/cdp.mjs 的共用客户端：临时 userData + 临时 owner/知识库，
// 不碰真实 %APPDATA%。截图写到 EVIDENCE_DIR（默认临时目录，本仓库验收时指到 shots-89）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OwnerStore } from '../../src/owner-store.mjs';
import { PersonalKnowledgeStore } from '../../src/personal-store.mjs';
import { createSyntheticProject } from '../knowledge-loop/fixtures.mjs';
import { capture, consoleErrors, createChecker, sleep, startApp, waitFor } from './lib/cdp.mjs';

const { check, failures } = createChecker('[LIBRARY]');

/** 读工作区里库段的可见状态；所有断言都基于这份 DOM 事实，不猜内部模型。 */
const libraryState = (panel) => panel.evaluate(`(() => {
  const section = document.getElementById('librarySection');
  const blockOf = (block) => ({
    key: block.className.match(/library-(verified|observing)/)?.[1] ?? '',
    label: block.querySelector('.library-block-name')?.textContent?.trim() ?? '',
    count: block.querySelector('.library-block-count')?.textContent?.trim() ?? '',
    empty: block.querySelector('.library-block-empty')?.textContent?.trim() ?? '',
    items: [...block.querySelectorAll('.library-item-title')].map((node) => node.textContent.trim())
  });
  return {
    hidden: Boolean(section?.hidden),
    badge: document.getElementById('libraryBadge')?.textContent?.trim() ?? '',
    blocks: [...document.querySelectorAll('#librarySections .library-block')].map(blockOf),
    emptyHidden: Boolean(document.getElementById('libraryEmpty')?.hidden),
    emptyText: document.getElementById('libraryEmpty')?.textContent?.trim() ?? '',
    assets: document.getElementById('libraryAssets')?.textContent?.trim() ?? '',
    status: document.getElementById('libraryStatus')?.textContent?.trim() ?? '',
    publishLabel: document.getElementById('libraryPublish')?.textContent?.trim() ?? '',
    publishDisabled: document.getElementById('libraryPublish')?.disabled === true,
    draftDisabled: document.getElementById('libraryDraft')?.disabled === true,
    versions: [...document.querySelectorAll('#libraryVersions .library-version')].map((node) => node.textContent.trim())
  };
})()`);

const snapshotState = (panel, projectId) => panel.evaluate(`(async () => {
  const snapshot = await window.companion.snapshot({ projectId: '${projectId}' });
  const library = snapshot.library;
  return {
    projectId: snapshot.config?.projectId ?? '',
    counts: library?.counts ?? {},
    snapshot: library?.snapshot ?? null,
    hasGroups: Object.prototype.hasOwnProperty.call(library ?? {}, 'groups')
  };
})()`);

const focusAlpha = async (panel) => {  await waitFor(panel, `typeof window.companion?.snapshot === 'function'`);
  // 面板刚加载时按钮监听可能还没绑好：轮询里重复点，直到专注页真正显示出来。
  const focusShown = await waitFor(panel, `(() => {
    document.querySelector('#modeBar button[data-mode="focus"]')?.click();
    const mode = document.getElementById('modeA');
    return mode && !mode.hidden;
  })()`);
  if (!focusShown) throw new Error('focus mode did not open');
  const tabbed = await waitFor(panel, `document.querySelector('#fdTabs .fd-tab[data-project="alpha"]')`);
  if (!tabbed) {
    const tabs = await panel.evaluate(
      "[...document.querySelectorAll('#fdTabs .fd-tab')].map((tab) => tab.dataset.project)"
    );
    throw new Error(`project tab alpha not found (${JSON.stringify(tabs)})`);
  }
  await panel.evaluate("document.querySelector('#fdTabs .fd-tab[data-project=\"alpha\"]').click()");
  const ready = await waitFor(panel, `(() => {
    const section = document.getElementById('librarySection');
    return section && !section.hidden
      && document.querySelectorAll('#librarySections .library-block').length === 2
      && document.querySelectorAll('#librarySections .library-item').length > 0;
  })()`);
  if (!ready) {
    const state = await panel.evaluate(`(async () => {
      const snapshot = await window.companion.snapshot({ projectId: 'alpha' });
      return {
        configProjectId: snapshot.config?.projectId,
        library: snapshot.library ? {
          counts: snapshot.library.counts,
          sections: snapshot.library.sections?.map((section) => section.key)
        } : null
      };
    })()`);
    throw new Error(`library section did not render (${JSON.stringify(state)})`);
  }
  await panel.evaluate("document.getElementById('librarySection').scrollIntoView({ block: 'center' })");
  await sleep(400);
};

/** 截图前把库段滚到指定位置，并收起上一动作的 toast，图上只留库本身。 */
const shot = async (panel, file, target = 'librarySection', block = 'center') => {
  await panel.evaluate(`document.getElementById('${target}').scrollIntoView({ block: '${block}' })`);
  await panel.evaluate("(() => { const toast = document.getElementById('toast'); if (toast) toast.hidden = true; })()");
  await sleep(350);
  await capture(panel, file);
};

/** 让库段标题落在吸顶「工作区」头下方，避免标题被盖住。 */
const shotSection = async (panel, file) => {
  await panel.evaluate(`(() => {
    const section = document.getElementById('librarySection');
    const container = document.querySelector('.a-wrap');
    if (!section || !container) return;
    const delta = section.getBoundingClientRect().top - container.getBoundingClientRect().top - 58;
    container.scrollTop += delta;
  })()`);
  await panel.evaluate("(() => { const toast = document.getElementById('toast'); if (toast) toast.hidden = true; })()");
  await sleep(350);
  await capture(panel, file);
};

const run = async () => {
  const base = process.env.TMP_LIBRARY ?? os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'companion-library-'));
  const userData = path.join(root, 'userdata');
  const ownerDb = path.join(root, 'owner.sqlite');
  const knowledgeDb = path.join(root, 'knowledge.sqlite');
  const evidence = process.env.EVIDENCE_DIR ?? path.join(root, 'evidence');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });

  // alpha：有画像、有已验证/待验证的领域知识、有一条本项目经验 → 两节都有内容。
  const owner = new OwnerStore(ownerDb);
  try {
    const alpha = createSyntheticProject({
      store: owner, root: path.join(root, 'alpha'), projectId: 'alpha', name: 'Alpha Repo'
    });
    owner.saveProjectBrief({
      projectId: 'alpha',
      basedOnCommit: alpha.baseSha,
      sourceRunId: 'pb_library',
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
    // beta：换一个领域、没有任何知识/画像/图谱 → 库必须是空态，且不能借到 alpha 的领域知识。
    const betaRoot = path.join(root, 'beta');
    fs.mkdirSync(betaRoot, { recursive: true });
    owner.registerProject({
      id: 'beta', name: 'Beta Repo', root: betaRoot,
      primaryDomain: 'data-pipeline', domains: ['data-pipeline']
    });
  } finally {
    owner.close();
  }

  const personal = new PersonalKnowledgeStore(knowledgeDb);
  try {
    personal.create({
      title: 'Retry loop bound',
      content: 'Use i < attempts so the final retry executes.',
      kind: 'claim', layer: 'applied', scope: 'domain',
      domains: ['software-engineering'], tags: ['retry'],
      evidenceRefs: ['sandbox:run-alpha-verified'], verificationStatus: 'verified', sourceRef: 'acceptance'
    });
    personal.create({
      title: 'Retry jitter is optional',
      content: 'Jitter helps under contention but has not been confirmed here.',
      kind: 'hypothesis', layer: 'applied', scope: 'domain',
      domains: ['software-engineering'], tags: ['retry'],
      evidenceRefs: [], verificationStatus: 'unverified', sourceRef: 'acceptance'
    });
    personal.recordLesson({
      projectId: 'alpha',
      sourceRecordId: 'sandbox:run-alpha-lesson',
      phenomenon: 'retry 循环少跑一次，最后一次重试不执行',
      mechanism: 'for 循环写成 i < attempts - 1',
      countermeasure: '改成 i < attempts，并用同一条断言复跑测试',
      scope: { layer: 'project', projectId: 'alpha', domainIds: ['software-engineering'] },
      verificationStatus: 'inferred'
    }, { evidence: [{ ref: 'sandbox:run-alpha-lesson', recordId: 'sandbox:run-alpha-lesson', kind: 'record' }] });
  } finally {
    personal.close();
  }

  fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({
    pet: { x: 240, y: 190 }, projectId: 'alpha', mascotSkin: 'erika',
    gatewayUrl: 'http://127.0.0.1:18789', model: '', includePaths: ['package.json']
  }, null, 2));

  let app = await startApp({ ownerDb, knowledgeDb, userData, showPanel: true });
  let panel = app.panel;
  const shots = [];
  let failed = true;
  try {
    await waitFor(panel, "document.querySelector('#modeBar button[data-mode=\"focus\"]')");
    await focusAlpha(panel);

    // 1) 库段本身：两节 + 计数 + 空态不出现。
    let state = await libraryState(panel);
    check('工作区里出现「项目库」段', state.hidden === false);
    check('库段固定两节：已验证 / 观察中',
      state.blocks.map((block) => block.label).join('/') === '已验证/观察中',
      state.blocks.map((block) => `${block.label}:${block.count}`).join(' '));
    check('两节互斥且合计等于总数',
      Number(String(state.badge)) === Number(state.blocks[0]?.count?.replace(/\D/gu, ''))
        + Number(state.blocks[1]?.count?.replace(/\D/gu, '')),
      `badge=${state.badge}`);
    check('有数据时两节都不空', state.blocks.every((block) => block.items.length > 0),
      state.blocks.map((block) => block.items.length).join('/'));
    check('有数据时不显示空库空态', state.emptyHidden === true, state.emptyText);
    check('库里能看到画像与图谱摘要', /画像：/u.test(state.assets) && /图谱：/u.test(state.assets), state.assets);
    check('没有草稿时发布按钮禁用且写「发布 v1」',
      state.publishDisabled === true && state.publishLabel === '发布 v1',
      `${state.publishLabel} disabled=${state.publishDisabled}`);
    await shotSection(panel, path.join(evidence, '01-library.png'));
    shots.push('01-library.png');

    // 2) 生成草稿：只有一份、没有版本号；视图本身不落库。
    const beforeDraft = await snapshotState(panel, 'alpha');
    check('只读快照不生成草稿', beforeDraft.snapshot?.hasDraft === false);
    check('渲染载荷不携带全量 groups（不占轮询带宽）', beforeDraft.hasGroups === false);

    await panel.evaluate("document.getElementById('libraryDraft').click()");
    const draftReady = await waitFor(panel,
      `(!document.getElementById('libraryPublish')?.disabled) && /草稿：/u.test(document.getElementById('libraryStatus')?.textContent ?? '')`);
    check('点「生成草稿」后出现草稿且发布按钮可用', draftReady);
    state = await libraryState(panel);
    check('草稿状态写明两节计数且注「没有版本号」',
      /已验证 \d+ 条 · 观察中 \d+ 条/u.test(state.status) && /没有版本号/u.test(state.status), state.status);
    check('生成草稿不产生版本', state.versions.length === 0, state.versions.join(','));
    const afterDraft = await snapshotState(panel, 'alpha');
    check('草稿在快照摘要里，且没有版本号字段',
      afterDraft.snapshot?.hasDraft === true && !('version' in (afterDraft.snapshot.draft ?? {})),
      JSON.stringify(afterDraft.snapshot?.draft ?? {}));
    await shot(panel, path.join(evidence, '02-draft.png'), 'libraryStatus', 'center');
    shots.push('02-draft.png');

    // 3) 发布 v1：版本号与时间进入库里，草稿还在。
    await panel.evaluate("document.getElementById('libraryPublish').click()");
    const published = await waitFor(panel,
      `document.querySelectorAll('#libraryVersions .library-version').length === 1`);
    check('发布后库里出现版本号与时间', published);
    state = await libraryState(panel);
    check('第一版标为 v1', /^v1 · /u.test(state.versions[0] ?? ''), state.versions[0] ?? '');
    check('发布 v1 后下一版按钮写「发布 v2」',
      state.publishLabel === '发布 v2', state.publishLabel);
    const afterPublish = await snapshotState(panel, 'alpha');
    check('版本号从 v1 单调起步且草稿保留',
      afterPublish.snapshot?.latestVersion === 1 && afterPublish.snapshot?.hasDraft === true,
      JSON.stringify(afterPublish.snapshot));
    await shot(panel, path.join(evidence, '03-publish-v1.png'), 'libraryVersions');
    shots.push('03-publish-v1.png');

    // 4) 再生成一次草稿并发布：版本递增到 v2，旧版本仍在。
    await panel.evaluate("document.getElementById('libraryDraft').click()");
    const draftAgain = await waitFor(panel,
      `(!document.getElementById('libraryPublish')?.disabled) && /草稿：/u.test(document.getElementById('libraryStatus')?.textContent ?? '')`);
    check('再生成草稿后发布按钮可用', draftAgain);
    await panel.evaluate("document.getElementById('libraryPublish').click()");
    const second = await waitFor(panel,
      `document.querySelectorAll('#libraryVersions .library-version').length === 2`);
    check('第二次发布分配 v2，旧版本仍在', second);
    state = await libraryState(panel);
    check('版本列表从新到旧：v2、v1',
      state.versions.map((text) => text.split(' ')[0]).join(',') === 'v2,v1',
      state.versions.join(' | '));
    await shot(panel, path.join(evidence, '04-publish-v2.png'), 'libraryVersions');
    shots.push('04-publish-v2.png');

    // 5) 重启后版本与草稿都还在（同一个临时库与 userData）。
    await app.stop();
    // Windows 上单实例锁释放有延迟：稍等再拉第二次，避免新进程直接退。
    await sleep(2500);
    let relaunchError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        app = await startApp({ ownerDb, knowledgeDb, userData, showPanel: true });
        panel = app.panel;
        relaunchError = null;
        break;
      } catch (error) {
        relaunchError = error;
        await sleep(2500);
      }
    }
    if (relaunchError) throw relaunchError;
    await waitFor(panel, "document.querySelector('#modeBar button[data-mode=\"focus\"]')");
    await focusAlpha(panel);
    const restarted = await waitFor(panel,
      `document.querySelectorAll('#libraryVersions .library-version').length === 2`);
    check('重启后版本仍在', restarted);
    state = await libraryState(panel);
    check('重启后草稿仍在（发布按钮还能发 v3）',
      /草稿：/u.test(state.status) && state.publishLabel === '发布 v3',
      `${state.status} / ${state.publishLabel}`);
    await shot(panel, path.join(evidence, '05-after-restart.png'), 'libraryStatus');
    shots.push('05-after-restart.png');

    // 6) 空库：切到 beta（不同领域、无知识）→ 空态出现，两节各 0；空库也能走完发布链路。
    const betaTab = await waitFor(panel, `document.querySelector('#fdTabs .fd-tab[data-project="beta"]')`);
    if (!betaTab) throw new Error('project tab beta not found');
    await panel.evaluate("document.querySelector('#fdTabs .fd-tab[data-project=\"beta\"]').click()");
    const emptyReady = await waitFor(panel, `(() => {
      const empty = document.getElementById('libraryEmpty');
      return empty && !empty.hidden;
    })()`);
    check('空库显示空态', emptyReady);
    state = await libraryState(panel);
    check('空库两节计数为 0 且分别给空说明',
      state.blocks.every((block) => block.count.startsWith('0') && block.empty.length > 0),
      state.blocks.map((block) => `${block.count}:${block.empty}`).join(' | '));
    check('空库没有版本、发布按钮禁用',
      state.versions.length === 0 && state.publishDisabled === true);
    await shot(panel, path.join(evidence, '06-empty-library.png'), 'libraryEmpty', 'center');
    shots.push('06-empty-library.png');

    await panel.evaluate("document.getElementById('libraryDraft').click()");
    const emptyDraft = await waitFor(panel, `!document.getElementById('libraryPublish')?.disabled`);
    check('空库也能生成草稿', emptyDraft);
    await panel.evaluate("document.getElementById('libraryPublish').click()");
    const emptyPublish = await waitFor(panel,
      `document.querySelectorAll('#libraryVersions .library-version').length === 1`);
    check('空库也能发布 v1（链路不依赖有数据）', emptyPublish);
    state = await libraryState(panel);
    check('空库发布后版本号是 v1', /^v1 · /u.test(state.versions[0] ?? ''), state.versions[0] ?? '');
    await shot(panel, path.join(evidence, '07-empty-publish.png'), 'libraryVersions');
    shots.push('07-empty-publish.png');

    // 7) 控制台无报错。
    const errors = consoleErrors(panel);
    check('控制台无报错', errors.length === 0, errors.slice(0, 3).join(' | '));

    if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
    failed = false;
    console.log(`[LIBRARY] PASS screenshots: ${shots.join(', ')}`);
  } finally {
    if (failed && panel) {
      try { await capture(panel, path.join(evidence, 'failure.png')); } catch { /* best effort */ }
    }
    try { await app.stop(); } catch { /* best effort */ }
    if (failed || failures.length > 0) console.error(`[LIBRARY] kept state: ${root}`);
    else {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 下偶发占用，留给系统清理 */ }
    }
  }
};

run().catch((error) => {
  console.error(`[LIBRARY] FAIL: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
