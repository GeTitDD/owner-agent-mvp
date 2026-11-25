// 项目库历史版本与自动 diff 验收（#92）。
//
// 用 scripts/e2e/lib/cdp.mjs 的共用客户端：临时 userData + 临时 owner/知识库，
// 截图落到 EVIDENCE_DIR（默认临时目录），不碰真实 %APPDATA%。
//
// 场景：库里有三条知识（保留 / 会被改 / 新增）；先直接落一版 v1，其中「会被改」
// 还是旧标题且待验证，「会被删」只存在于 v1。随后在界面上生成草稿、写一句说明、
// 发布 v2。断言：
// 1) 版本列表倒序，带版本号与发布时间；
// 2) v2 的 diff 三类齐全（新增 / 变更 / 消失），变更写明字段与旧新值；
// 3) 说明与 diff 并列显示；v1 没有说明时不留空引号或占位；
// 4) v1 明说「首版，无可比对象」，不是「0 变化」；
// 5) 打开历史版本只读：没有编辑控件，已发布数据与草稿都不变；
// 6) 控制台无报错。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OwnerStore } from '../../src/owner-store.mjs';
import { PersonalKnowledgeStore } from '../../src/personal-store.mjs';
import { ProjectSnapshotStore, snapshotContentOf } from '../../src/project-snapshots.mjs';
import { projectLibraryView } from '../../src/project-library.mjs';
import { createSyntheticProject } from '../knowledge-loop/fixtures.mjs';
import { capture, consoleErrors, createChecker, sleep, startApp, waitFor } from './lib/cdp.mjs';

const { check, failures } = createChecker('[VERSIONS]');

const focusAlpha = async (panel) => {
  await waitFor(panel, `typeof window.companion?.snapshot === 'function'`);
  const focusShown = await waitFor(panel, `(() => {
    document.querySelector('#modeBar button[data-mode="focus"]')?.click();
    const mode = document.getElementById('modeA');
    return mode && !mode.hidden;
  })()`);
  if (!focusShown) throw new Error('focus mode did not open');
  const tabbed = await waitFor(panel, `document.querySelector('#fdTabs .fd-tab[data-project="alpha"]')`);
  if (!tabbed) throw new Error('project tab alpha not found');
  await panel.evaluate(`document.querySelector('#fdTabs .fd-tab[data-project="alpha"]').click()`);
  const ready = await waitFor(panel, `(() => {
    const section = document.getElementById('librarySection');
    return section && !section.hidden
      && document.querySelectorAll('#librarySections .library-block').length === 2;
  })()`);
  if (!ready) throw new Error('library section did not render');
  await panel.evaluate("document.getElementById('librarySection').scrollIntoView({ block: 'center' })");
  await sleep(400);
};

/** 版本列表：顺序、选中态、文案。 */
const versionList = (panel) => panel.evaluate(`[...document.querySelectorAll('#libraryVersions .library-version')]
  .map((node) => ({
    version: Number(node.dataset.version),
    text: node.textContent.trim(),
    on: node.classList.contains('on'),
    pressed: node.getAttribute('aria-pressed')
  }))`);

/** 只读详情：说明、diff 三类、两节内容，以及「有没有编辑入口」。 */
const versionDetail = (panel) => panel.evaluate(`(() => {
  const detail = document.getElementById('libraryVersionDetail');
  if (!detail) return null;
  return {
    hidden: Boolean(detail.hidden),
    label: detail.querySelector('.library-version-detail-label')?.textContent ?? '',
    readonly: detail.querySelector('.library-version-readonly')?.textContent ?? '',
    hasNoteBlock: Boolean(detail.querySelector('.library-version-note')),
    note: detail.querySelector('.library-version-note-text')?.textContent ?? '',
    headline: detail.querySelector('.library-diff-headline')?.textContent ?? '',
    groups: [...(detail.querySelectorAll('.library-diff-group') ?? [])].map((group) => ({
      key: [...group.classList].find((name) => /^library-diff-(added|changed|removed)$/u.test(name)) ?? '',
      name: group.querySelector('.library-diff-group-name')?.textContent ?? '',
      count: group.querySelector('.library-diff-group-count')?.textContent ?? '',
      titles: [...group.querySelectorAll('.library-diff-item-title')].map((node) => node.textContent),
      changes: [...group.querySelectorAll('.library-diff-change')].map((node) => node.textContent.trim())
    })),
    sections: [...(detail.querySelectorAll('.library-version-sections .library-block') ?? [])].map((block) => ({
      key: [...block.classList].find((name) => /^library-(verified|observing)$/u.test(name)) ?? '',
      count: block.querySelector('.library-block-count')?.textContent ?? '',
      items: [...block.querySelectorAll('.library-item-title')].map((node) => node.textContent)
    })),
    counts: detail.querySelector('.library-version-counts')?.textContent ?? '',
    controls: detail.querySelectorAll('input, textarea, select, button, [contenteditable="true"]').length
  };
})()`);

/** 截图前把版本详情滚进视野：详情在库段下方，只截屏不滚动会拍不到 diff。 */
const shotDetail = async (panel, dir, name) => {
  await panel.evaluate(`(() => {
    const detail = document.getElementById('libraryVersionDetail');
    const container = document.querySelector('.a-wrap');
    if (!detail || !container) return;
    container.scrollTop += detail.getBoundingClientRect().top - container.getBoundingClientRect().top - 64;
  })()`);
  // toast 会盖住 diff；等它自己收起再拍，画面里只留功能与数据。
  await waitFor(panel, `document.getElementById('toast')?.hidden !== false`, 8000);
  await sleep(350);
  await capture(panel, path.join(dir, name));
};

const run = async () => {
  const base = process.env.TMP_VERSIONS ?? os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'companion-versions-'));
  const userData = path.join(root, 'userdata');
  const ownerDb = path.join(root, 'owner.sqlite');
  const knowledgeDb = path.join(root, 'knowledge.sqlite');
  const evidence = process.env.EVIDENCE_DIR ?? path.join(root, 'evidence');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });

  const project = { id: 'alpha', name: 'Alpha Repo', domains: ['software-engineering'] };

  // 先造真实知识库：保留 / 改过 / 新增三条；「会被删」只存在于 v1 快照里。
  let keepRow = null;
  let changedRow = null;
  const personal = new PersonalKnowledgeStore(knowledgeDb);
  try {
    const created = (title, status) => personal.create({
      title,
      content: `内容 ${title}`,
      kind: 'claim', layer: 'applied', scope: 'domain',
      domains: ['software-engineering'], tags: ['versions'],
      evidenceRefs: [`evidence:${title}`],
      verificationStatus: status, sourceRef: 'acceptance'
    });
    keepRow = created('保留的结论', 'verified');
    changedRow = created('改过的结论', 'verified');
    created('新增的结论', 'verified');
  } finally {
    personal.close();
  }

  const owner = new OwnerStore(ownerDb);
  try {
    createSyntheticProject({ store: owner, root: path.join(root, 'alpha'), projectId: 'alpha', name: 'Alpha Repo' });
    // 第二个项目只为让工作区的项目切换控件出现；本票只操作 alpha。
    const betaRoot = path.join(root, 'beta');
    fs.mkdirSync(betaRoot, { recursive: true });
    owner.registerProject({
      id: 'beta', name: 'Beta Repo', root: betaRoot,
      primaryDomain: 'data-pipeline', domains: ['data-pipeline']
    });
  } finally {
    owner.close();
  }

  fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({
    pet: { x: 240, y: 190 }, projectId: 'alpha', mascotSkin: 'erika',
    gatewayUrl: 'http://127.0.0.1:18789', model: '', includePaths: ['package.json']
  }, null, 2));

  // v1 直接落库：保留的条目按原样，被改的条目用旧标题且待验证，另加一条后来消失的条目。
  const v1View = projectLibraryView({
    project,
    knowledge: [
      keepRow,
      { ...changedRow, title: '会被改的结论', verificationStatus: 'unverified' },
      {
        ...keepRow,
        id: 'personal.gone0000000000000000',
        title: '会被删的结论',
        verificationStatus: 'unverified',
        evidenceRefs: ['evidence:gone']
      }
    ]
  });
  const v1Content = snapshotContentOf(v1View, { generatedAt: '2026-11-24T00:00:00.000Z', note: '' });
  const store = new ProjectSnapshotStore(ownerDb);
  let v1 = null;
  try {
    store.saveDraft({ projectId: 'alpha', content: v1Content, now: '2026-11-24T00:00:00.000Z' });
    v1 = store.publish({ projectId: 'alpha', note: '', now: '2026-11-24T00:00:00.000Z' });
  } finally {
    store.close();
  }
  check('v1 已落库且没有说明', v1?.version === 1 && v1.note === '', JSON.stringify(v1?.note));

  let app = null;
  let panel = null;
  let failed = true;
  try {
    app = await startApp({ ownerDb, knowledgeDb, userData, showPanel: true });
    panel = app.panel;
    await focusAlpha(panel);

    // 1) 首版：默认打开 v1，明说「首版，无可比对象」，没有三类计数，也没有空说明占位。
    const firstReady = await waitFor(panel, `/(首版，无可比对象)/u.test(
      document.getElementById('libraryVersionDetail')?.textContent ?? '')`);
    check('打开首版时明说「首版，无可比对象」', firstReady);
    let state = await versionDetail(panel);
    const firstList = await versionList(panel);
    check('首版只有一版，且选中 v1', firstList.length === 1
      && firstList[0].version === 1 && firstList[0].on === true, JSON.stringify(firstList));
    check('首版不显示三类计数', state.groups.length === 0, JSON.stringify(state.groups));
    check('首版不显示「0 变化」', !/0 变化|没有变化/u.test(state.headline), state.headline);
    check('v1 没有说明时不留空引号或占位', state.hasNoteBlock === false && state.note === '', state.note);
    check('首版详情标明只读且没有编辑控件', state.readonly === '只读' && state.controls === 0,
      `${state.readonly}/${state.controls}`);
    check('首版两节清单与计数都在', state.sections.length === 2 && /共 3 条/u.test(state.counts), state.counts);
    await shotDetail(panel, evidence, '01-first-version.png');

    // 2) 生成草稿 → 写说明 → 发布 v2：版本列表倒序，v2 自动选中。
    const draftResult = await panel.evaluate(`window.companion.library.draft({ projectId: 'alpha' })`);
    check('生成草稿不产生新版本', (draftResult?.snapshot?.versions ?? []).length === 1);
    await panel.evaluate("document.getElementById('libraryDraft').click()");
    const canPublish = await waitFor(panel, `!document.getElementById('libraryPublish')?.disabled`);
    check('生成草稿后可以发布', canPublish);
    const note = '这一版加了新增的结论，改了会被改的结论';
    await panel.evaluate(`(() => {
      const input = document.getElementById('libraryNote');
      input.value = ${JSON.stringify(note)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await panel.evaluate("document.getElementById('libraryPublish').click()");
    const published = await waitFor(panel, `(() => {
      const nodes = [...document.querySelectorAll('#libraryVersions .library-version')];
      return nodes.length === 2 && nodes[0].dataset.version === '2'
        && nodes[0].classList.contains('on')
        && /新增 1 条/u.test(document.getElementById('libraryVersionDetail')?.textContent ?? '');
    })()`);
    check('发布 v2 后版本列表倒序且自动选中', published);

    const list = await versionList(panel);
    check('版本列表 v2 在前、v1 在后', list.map((item) => item.version).join(',') === '2,1', JSON.stringify(list));
    check('每个版本都带版本号与发布时间', list.every((item) => /^v[12] · /u.test(item.text)), JSON.stringify(list));

    state = await versionDetail(panel);
    check('发布说明与 diff 并列显示', state.hasNoteBlock === true && state.note === note, state.note);
    check('diff 结论列出三类计数', state.headline === '与 v1 相比：新增 1 条 · 变更 1 条 · 消失 1 条', state.headline);
    check('三类都渲染出来', state.groups.map((group) => group.key).join(',') ===
      'library-diff-added,library-diff-changed,library-diff-removed',
    JSON.stringify(state.groups.map((group) => group.key)));
    const byKey = Object.fromEntries(state.groups.map((group) => [group.key, group]));
    check('新增一类指向新条目', byKey['library-diff-added']?.count === '1 条'
      && byKey['library-diff-added']?.titles.join('|') === '新增的结论', JSON.stringify(byKey['library-diff-added']));
    check('消失一类指向只存在于 v1 的条目', byKey['library-diff-removed']?.count === '1 条'
      && byKey['library-diff-removed']?.titles.join('|') === '会被删的结论',
    JSON.stringify(byKey['library-diff-removed']));
    check('变更一类指向被改的条目', byKey['library-diff-changed']?.count === '1 条'
      && byKey['library-diff-changed']?.titles.join('|') === '改过的结论',
    JSON.stringify(byKey['library-diff-changed']));
    check('变更写明字段与旧新值', (byKey['library-diff-changed']?.changes ?? []).some((line) =>
      line.includes('标题：') && line.includes('会被改的结论') && line.includes('改过的结论')),
    JSON.stringify(byKey['library-diff-changed']?.changes));
    check('v2 两节计数与内容都是只读快照', state.sections.length === 2
      && /共 3 条 · 已验证 3 条 · 观察中 0 条/u.test(state.counts), state.counts);
    check('v2 详情没有编辑入口', state.controls === 0 && state.readonly === '只读',
      `${state.controls}/${state.readonly}`);
    await shotDetail(panel, evidence, '02-v2-diff-and-note.png');

    // 3) 打开历史版本 v1：只读，且不改动已发布数据与草稿。
    const dbBefore = new ProjectSnapshotStore(ownerDb);
    let snapshotBefore = null;
    let draftStateBefore = null;
    try {
      snapshotBefore = dbBefore.getVersionRaw('alpha', 2);
      draftStateBefore = dbBefore.getDraftState('alpha');
    } finally {
      dbBefore.close();
    }
    await panel.evaluate(`document.querySelector('#libraryVersions .library-version[data-version="1"]').click()`);
    const backToFirst = await waitFor(panel, `/首版，无可比对象/u.test(
      document.getElementById('libraryVersionDetail')?.textContent ?? '')`);
    check('历史版本 v1 可以重新打开', backToFirst);
    state = await versionDetail(panel);
    check('打开历史版本后仍是只读、无编辑入口', state.controls === 0 && state.readonly === '只读');
    check('打开历史版本不显示空说明', state.hasNoteBlock === false && state.note === '', state.note);
    await shotDetail(panel, evidence, '03-history-readonly.png');

    const dbAfter = new ProjectSnapshotStore(ownerDb);
    let snapshotAfter = null;
    let draftStateAfter = null;
    try {
      snapshotAfter = dbAfter.getVersionRaw('alpha', 2);
      draftStateAfter = dbAfter.getDraftState('alpha');
    } finally {
      dbAfter.close();
    }
    check('查看历史版本不改已发布内容', snapshotAfter?.contentHash === snapshotBefore?.contentHash
      && snapshotAfter?.note === snapshotBefore?.note, `${snapshotAfter?.contentHash}`);
    check('查看历史版本不触发生成草稿', draftStateAfter?.generatedAt === draftStateBefore?.generatedAt
      && draftStateAfter?.contentHash === draftStateBefore?.contentHash, `${draftStateAfter?.generatedAt}`);

    const errors = consoleErrors(panel);
    check('控制台无报错', errors.length === 0, errors.slice(0, 3).join(' | '));

    if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
    failed = false;
    console.log('[VERSIONS] PASS screenshots: 01-first-version.png, 02-v2-diff-and-note.png, '
      + `03-history-readonly.png (${evidence})`);
  } finally {
    if (failed && panel) {
      try { await capture(panel, path.join(evidence, 'failure.png')); } catch { /* best effort */ }
    }
    try { await app?.stop(); } catch { /* best effort */ }
    if (failed || failures.length > 0) console.error(`[VERSIONS] kept state: ${root}`);
    else {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 下偶发占用，留给系统清理 */ }
    }
  }
};

run().catch((error) => {
  console.error(`[VERSIONS] FAIL: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
