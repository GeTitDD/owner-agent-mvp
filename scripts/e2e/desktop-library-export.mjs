// 项目库导出验收（#90）：发布后固定目录里出现 snapshot.json 与 report.html。
//
// 用 scripts/e2e/lib/cdp.mjs 的共用客户端：临时 userData + 临时 owner/知识库；
// 导出根就是 <临时 userData>/exports，不碰真实 %APPDATA%。
// 断言三件事：路径可预测且界面上看得到；人读物两节逐条与快照一致、缺图写明缺；
// 同一快照重复导出逐字节相同。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OwnerStore } from '../../src/owner-store.mjs';
import { PersonalKnowledgeStore } from '../../src/personal-store.mjs';
import { ProjectSnapshotStore } from '../../src/project-snapshots.mjs';
import { createSyntheticProject } from '../knowledge-loop/fixtures.mjs';
import { capture, consoleErrors, createChecker, sleep, startApp, waitFor } from './lib/cdp.mjs';

const { check, failures } = createChecker('[EXPORT]');

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/** 解析人读物里的两节：条目按 data-ref 取，标题与证据引用留给逐条核对。 */
const reportSections = (html) => {
  const out = {};
  for (const key of ['verified', 'observing']) {
    const body = html.match(
      new RegExp(`<section class="report-section" data-section="${key}">([\\s\\S]*?)</section>`, 'u')
    )?.[1] ?? '';
    out[key] = [...body.matchAll(/<li class="item" data-ref="([^"]*)">([\s\S]*?)<\/li>/gu)].map((match) => ({
      ref: match[1],
      title: match[2].match(/<p class="item-title">([^<]*)<\/p>/u)?.[1] ?? ''
    }));
  }
  return out;
};

const countOf = (html, key) => Number(html.match(
  new RegExp(`data-count="${key}"><span class="label">[^<]*</span><span class="value">([^<]*)</span>`, 'u')
)?.[1] ?? NaN);

const libraryState = (panel) => panel.evaluate(`(() => {
  const section = document.getElementById('librarySection');
  const exportBox = document.getElementById('libraryExport');
  return {
    hidden: Boolean(section?.hidden),
    blocks: [...document.querySelectorAll('#librarySections .library-block')].map((block) => ({
      key: block.className.match(/library-(verified|observing)/)?.[1] ?? '',
      count: block.querySelector('.library-block-count')?.textContent?.trim() ?? '',
      items: [...block.querySelectorAll('.library-item-title')].map((node) => node.textContent.trim())
    })),
    versions: [...document.querySelectorAll('#libraryVersions .library-version')].map((node) => node.textContent.trim()),
    exportHidden: Boolean(exportBox?.hidden),
    exportText: exportBox?.textContent?.trim() ?? '',
    openLabel: exportBox?.querySelector('button')?.textContent?.trim() ?? ''
  };
})()`);

const focusAlpha = async (panel, projectId = 'alpha') => {
  await waitFor(panel, `typeof window.companion?.snapshot === 'function'`);
  const focusShown = await waitFor(panel, `(() => {
    document.querySelector('#modeBar button[data-mode="focus"]')?.click();
    const mode = document.getElementById('modeA');
    return mode && !mode.hidden;
  })()`);
  if (!focusShown) throw new Error('focus mode did not open');
  const tabbed = await waitFor(panel, `document.querySelector('#fdTabs .fd-tab[data-project="${projectId}"]')`);
  if (!tabbed) throw new Error(`project tab ${projectId} not found`);
  await panel.evaluate(`document.querySelector('#fdTabs .fd-tab[data-project="${projectId}"]').click()`);
  const ready = await waitFor(panel, `(() => {
    const section = document.getElementById('librarySection');
    return section && !section.hidden
      && document.querySelectorAll('#librarySections .library-block').length === 2;
  })()`);
  if (!ready) throw new Error('library section did not render');
  await panel.evaluate("document.getElementById('librarySection').scrollIntoView({ block: 'center' })");
  await sleep(400);
};

const shotSection = async (panel, file) => {
  await panel.evaluate(`(() => {
    const section = document.getElementById('librarySection');
    const container = document.querySelector('.a-wrap');
    if (!section || !container) return;
    container.scrollTop += section.getBoundingClientRect().top - container.getBoundingClientRect().top - 58;
  })()`);
  await sleep(350);
  await capture(panel, file);
};

const shotExport = async (panel, file) => {
  await panel.evaluate("document.getElementById('libraryExport')?.scrollIntoView({ block: 'center' })");
  await sleep(350);
  await capture(panel, file);
};

const run = async () => {
  const base = process.env.TMP_EXPORT ?? os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'companion-export-'));
  const userData = path.join(root, 'userdata');
  const ownerDb = path.join(root, 'owner.sqlite');
  const knowledgeDb = path.join(root, 'knowledge.sqlite');
  // 导出根与主进程同一口径：<userData>/exports/<projectId>/vN。
  const exportsRoot = path.join(userData, 'exports');
  const evidence = process.env.EVIDENCE_DIR ?? path.join(root, 'evidence');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });

  // alpha：一条已验证经验 + 一条待验证经验 + 两条领域知识 + 画像 + 一张依赖图。
  // 其余四类图谱不生成：人读物必须逐类写「缺」。
  const owner = new OwnerStore(ownerDb);
  try {
    const alpha = createSyntheticProject({
      store: owner, root: path.join(root, 'alpha'), projectId: 'alpha', name: 'Alpha Repo'
    });
    owner.saveProjectBrief({
      projectId: 'alpha',
      basedOnCommit: alpha.baseSha,
      sourceRunId: 'pb_export',
      payload: {
        oneLiner: '一个用于验收导出的零依赖 Node 项目',
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
    owner.saveProjectDiagram({
      projectId: 'alpha',
      kind: 'dependency',
      title: '依赖图',
      summary: 'format 与 retry 互不依赖，测试依赖两者',
      mermaid: 'graph TD; test-->format; test-->retry',
      data: { summary: 'format 与 retry 互不依赖，测试依赖两者' },
      basedOnCommit: alpha.baseSha,
      source: 'acceptance',
      now: '2026-11-22T00:00:00.000Z'
    });
    // beta：不同领域、没有任何条目 / 画像 / 图谱 → 空库也要能导出。
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
      evidenceRefs: ['sandbox:run-alpha-hypothesis'], verificationStatus: 'unverified', sourceRef: 'acceptance'
    });
    personal.recordLesson({
      projectId: 'alpha',
      sourceRecordId: 'sandbox:run-alpha-ok',
      phenomenon: 'retry 在最后一次失败后没有抛错',
      mechanism: '错误被 catch 后吞掉，没有重新抛出',
      countermeasure: 'catch 里记录后原样 rethrow，并用同一条断言复跑',
      scope: { layer: 'project', projectId: 'alpha', domainIds: ['software-engineering'] },
      // 新写经验不能直接是「已验证」（CREATABLE_LESSON_STATUSES）：两节都靠领域知识补。
      verificationStatus: 'unverified',
      evidenceRefs: ['sandbox:run-alpha-ok']
    }, { evidence: [{ ref: 'sandbox:run-alpha-ok', recordId: 'sandbox:run-alpha-ok', kind: 'record' }] });
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

    // 1) 生成草稿 → 发布 v1：导出目录必须已经出现，界面上能看到路径。
    await panel.evaluate("document.getElementById('libraryDraft').click()");
    const draftReady = await waitFor(panel, `!document.getElementById('libraryPublish')?.disabled`);
    check('生成草稿后可以发布', draftReady);
    await panel.evaluate("document.getElementById('libraryPublish').click()");
    const published = await waitFor(panel, `(() => {
      const box = document.getElementById('libraryExport');
      return document.querySelectorAll('#libraryVersions .library-version').length === 1
        && box && !box.hidden && /v1/u.test(box.textContent ?? '');
    })()`);
    check('发布后库段出现导出路径', published);

    const expectedDir = path.join(exportsRoot, 'alpha', 'v1');
    const snapshotFile = path.join(expectedDir, 'snapshot.json');
    const reportFile = path.join(expectedDir, 'report.html');
    check('导出目录按「项目 / 版本」可预测',
      fs.existsSync(path.dirname(path.dirname(expectedDir))) && path.basename(path.dirname(expectedDir)) === 'alpha');
    check('两个文件都在固定目录里', fs.existsSync(snapshotFile) && fs.existsSync(reportFile),
      `${fs.existsSync(snapshotFile)} / ${fs.existsSync(reportFile)}`);

    let state = await libraryState(panel);
    check('界面显示的路径就是真正写出的目录',
      state.exportText.includes(expectedDir), state.exportText);
    check('导出路径旁有「打开目录」动作', state.openLabel === '打开目录', state.openLabel);
    check('路径之外仍保留 v1 版本与时间', /^v1 · /u.test(state.versions[0] ?? ''), state.versions[0] ?? '');
    await shotExport(panel, path.join(evidence, '01-export-path.png'));
    shots.push('01-export-path.png');

    // 2) snapshot.json 是那一版的原样字节：和库里存的 TEXT / 发布记录哈希一致。
    const store = new ProjectSnapshotStore(ownerDb);
    let raw = null;
    try {
      raw = store.getVersionRaw('alpha', 1);
    } finally {
      store.close();
    }
    const snapshotBytes = fs.readFileSync(snapshotFile);
    check('snapshot.json 与库里那一版逐字节相同', snapshotBytes.toString('utf8') === raw.contentText);
    check('snapshot.json 哈希等于发布记录', sha256(snapshotBytes) === raw.contentHash, sha256(snapshotBytes));
    check('snapshot.json 是合法 JSON 且是快照本身',
      JSON.parse(snapshotBytes.toString('utf8')).format === 'project-snapshot/v1');

    // 3) 人读物：两节逐条等于快照（不是只看条数）；四类计数与缺图都写出来。
    const html = fs.readFileSync(reportFile, 'utf8');
    const sections = reportSections(html);
    const snapshotContent = JSON.parse(raw.contentText);
    for (const key of ['verified', 'observing']) {
      const expected = snapshotContent.sections.find((section) => section.key === key);
      const actual = sections[key];
      check(`人读物「${expected.label}」条数与快照一致`, actual.length === expected.items.length,
        `${actual.length}/${expected.items.length}`);
      check(`人读物「${expected.label}」逐条引用与快照一致`,
        actual.map((item) => item.ref).join('|') === expected.items.map((item) =>
          `${item.ref.kind}:${item.ref.id}${item.ref.revision ? `（修订 ${item.ref.revision}）` : ''}`).join('|'));
      check(`人读物「${expected.label}」标题与快照一致`,
        actual.every((item, index) => item.title === expected.items[index].title.replace(/&/gu, '&amp;')
          .replace(/</gu, '&lt;').replace(/>/gu, '&gt;')));
    }
    check('两节互斥且合计等于总数',
      sections.verified.length + sections.observing.length === snapshotContent.counts.total,
      `${sections.verified.length}+${sections.observing.length}/${snapshotContent.counts.total}`);
    check('人读物四类计数与快照一致',
      countOf(html, 'experiences') === snapshotContent.counts.experiences
        && countOf(html, 'domainKnowledge') === snapshotContent.counts.domainKnowledge
        && countOf(html, 'contributedKnowledge') === snapshotContent.counts.contributedKnowledge,
      `${countOf(html, 'experiences')}/${countOf(html, 'domainKnowledge')}/${countOf(html, 'contributedKnowledge')}`);
    check('人读物写明项目名、版本号与发布时间',
      html.includes('Alpha Repo') && html.includes('v1') && html.includes(raw.publishedAt),
      raw.publishedAt);
    check('人读物含一句话现状（画像）', html.includes('一个用于验收导出的零依赖 Node 项目'));
    check('有图的图谱给出快照里的引用',
      /data-diagram="dependency" data-available="true"/u.test(html) && html.includes('format 与 retry 互不依赖'));
    const missingKinds = (html.match(/data-diagram="[^"]+" data-available="false"/gu) ?? []).length;
    check('缺的图谱逐类写明缺（四类）', missingKinds === 4 && html.includes('缺：还没有生成控制流图'),
      String(missingKinds));
    check('证据引用进人读物', html.includes('sandbox:run-alpha-ok') && /data-section="evidence"/u.test(html));
    await shotSection(panel, path.join(evidence, '02-library-after-publish.png'));
    shots.push('02-library-after-publish.png');

    // 4) 重复导出：两次 IPC 导出后两个文件逐字节不变（含人读物，没有导出时间）。
    const reportBefore = fs.readFileSync(reportFile);
    const runExport = () => panel.evaluate(`window.companion.library.export({ projectId: 'alpha', version: 1 })`);
    const firstExport = await runExport();
    const secondExport = await runExport();
    check('重复导出返回同一个目录', firstExport?.exported?.dir === expectedDir
      && secondExport?.exported?.dir === expectedDir);
    check('内容没变时不重写文件', Array.isArray(secondExport?.exported?.changed)
      && secondExport.exported.changed.length === 0, JSON.stringify(secondExport?.exported?.changed));
    check('snapshot.json 重复导出逐字节相同',
      sha256(fs.readFileSync(snapshotFile)) === sha256(snapshotBytes));
    check('人读物重复导出逐字节相同',
      sha256(fs.readFileSync(reportFile)) === sha256(reportBefore));

    // 5) 「打开目录」只认导出根之内的路径（不真的拉起文件管理器，验证守卫即可）。
    const guard = await panel.evaluate(`window.companion.library.openExport({ path: '${path.join(root, '..').replace(/\\/gu, '\\\\')}' })
      .then(() => 'opened').catch((error) => String(error.message ?? error))`);
    check('打开目录拒绝导出根之外的路径', /只能打开导出目录里的路径/u.test(String(guard)), String(guard));

    // 6) 空库也能导出：beta 没有条目 / 画像 / 图谱，两节计数为 0，缺图逐类写明。
    await focusAlpha(panel, 'beta');
    await panel.evaluate("document.getElementById('libraryDraft').click()");
    const betaDraft = await waitFor(panel, `!document.getElementById('libraryPublish')?.disabled`);
    check('空库能生成草稿', betaDraft);
    await panel.evaluate("document.getElementById('libraryPublish').click()");
    const betaPublished = await waitFor(panel, `(() => {
      const box = document.getElementById('libraryExport');
      return box && !box.hidden && /beta/u.test(box.textContent ?? '');
    })()`);
    check('空库发布后同样出现导出路径', betaPublished);
    const betaReport = path.join(exportsRoot, 'beta', 'v1', 'report.html');
    const betaSnapshot = path.join(exportsRoot, 'beta', 'v1', 'snapshot.json');
    check('空库两个文件都在', fs.existsSync(betaReport) && fs.existsSync(betaSnapshot));
    const betaHtml = fs.readFileSync(betaReport, 'utf8');
    const betaSections = reportSections(betaHtml);
    check('空库两节各给空说明、不假装有条目',
      betaSections.verified.length === 0 && betaSections.observing.length === 0
        && betaHtml.includes('这个项目还没有已验证的条目。') && betaHtml.includes('没有观察中的条目。'));
    check('空库头像 / 图谱写明缺',
      betaHtml.includes('缺：还没有生成项目画像')
        && (betaHtml.match(/data-diagram="[^"]+" data-available="false"/gu) ?? []).length === 5);
    check('空库读数与快照一致（合计 0）',
      countOf(betaHtml, 'experiences') === 0
        && JSON.parse(fs.readFileSync(betaSnapshot, 'utf8')).counts.total === 0);
    await shotExport(panel, path.join(evidence, '03-empty-export.png'));
    shots.push('03-empty-export.png');

    const errors = consoleErrors(panel);
    check('控制台无报错', errors.length === 0, errors.slice(0, 3).join(' | '));

    if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
    failed = false;
    console.log(`[EXPORT] PASS screenshots: ${shots.join(', ')}`);
    console.log(`[EXPORT] export root: ${exportsRoot}`);
  } finally {
    if (failed && panel) {
      try { await capture(panel, path.join(evidence, 'failure.png')); } catch { /* best effort */ }
    }
    try { await app.stop(); } catch { /* best effort */ }
    if (failed || failures.length > 0) console.error(`[EXPORT] kept state: ${root}`);
    else {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 下偶发占用，留给系统清理 */ }
    }
  }
};

run().catch((error) => {
  console.error(`[EXPORT] FAIL: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
