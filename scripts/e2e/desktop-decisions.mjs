// #87 验收：决策确认与入库。
//
// 面板层没有自动化测试，这里用离屏 Electron + CDP 走真实路径，并留截图：
//   ① 扫描出的候选在确认前一行都不写库；
//   ② 缺理由的候选有明显标记；
//   ③ 确认时可补一句理由，确认后决策出现在项目库（知识层），带来源与时间；
//   ④ 不补理由时界面显示「缺理由」；
//   ⑤ 决策状态与验证状态并存、互不冒充；
//   ⑥ 标为「已被取代」后检索不再把它当现状，界面写明「不算现状」；
//   ⑦ 控制台无报错。
// 全程用本 worktree 专属临时 userData + 临时 owner / 知识库 + 临时 CODEX_HOME，
// 不碰真实 %APPDATA%、真实知识库与真实会话目录。
import fs from 'node:fs';
import path from 'node:path';
import { OwnerStore } from '../../src/owner-store.mjs';
import { PersonalKnowledgeStore } from '../../src/personal-store.mjs';
import {
  capture, consoleErrors, createChecker, sleep, startApp, waitFor
} from './lib/cdp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const shotsDir = process.env.SHOTS_DIR
  ?? path.resolve(repoRoot, '..', '..', 'mm-notes', 'shots-87');
const tempBase = process.env.TMP_87 ?? path.resolve(shotsDir, '..', 'tmp-87');
const { check, failures } = createChecker('[DECISION-#87]');

const AT = '2026-11-25T10:00:00.000Z';

/** 面板固定 440×640：先临时抬高视口，再截「知识」整段（扫描块 + 知识列表）。 */
const shotTall = async (panel, file, height = 1500) => {
  await panel.send('Emulation.setDeviceMetricsOverride', {
    width: 440, height, deviceScaleFactor: 1, mobile: false
  });
  await sleep(400);
  await capture(panel, path.join(shotsDir, file));
  await panel.send('Emulation.clearDeviceMetricsOverride');
  await sleep(200);
};

const makeRoot = () => {
  fs.mkdirSync(tempBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'decisions-87-'));
  const userData = path.join(root, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  return {
    root,
    userData,
    ownerDb: path.join(root, 'owner.sqlite'),
    knowledgeDb: path.join(root, 'knowledge.sqlite'),
    projectRoot: path.join(root, 'project'),
    codexHome: path.join(root, 'codex-home')
  };
};

const safeRemove = (target) => {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    console.warn(`[DECISION-#87] kept state: ${target}`);
  }
};

/** 造一段 Codex 会话：首行 session_meta 带项目根，对话是两对「用户取舍 + 助手确认」。 */
const writeCodexSession = (codexHome, projectRoot) => {
  const file = path.join(codexHome, 'sessions', '2026', '11', '25', 'rollout-t87.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = (role, text) => ({
    timestamp: AT,
    type: 'response_item',
    payload: {
      type: 'message',
      role,
      content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }]
    }
  });
  const lines = [
    { timestamp: AT, type: 'session_meta', payload: { id: 't87-session', cwd: projectRoot } },
    row('user', '构建太慢，改成 esbuild 打包'),
    row('assistant', '好，用 esbuild 替换 tsc，webpack 那条路不再走'),
    row('user', '测试框架不要再用 jest，统一换成 node:test'),
    row('assistant', '可以，jest 的配置一并删掉，用 node --test 跑')
  ];
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
};

/** 读面板当前画了什么：候选、知识条目、总数。 */
const readPanel = (panel) => panel.evaluate(`(() => ({
  modeBVisible: !document.getElementById('modeB').hidden,
  total: document.getElementById('kbTotal')?.textContent ?? '',
  scanHidden: document.getElementById('kbScan')?.hidden !== false,
  summary: document.getElementById('kbScanSummary')?.textContent ?? '',
  candidates: [...document.querySelectorAll('#kbScanCandidates .kb-scan-item')].map((row) => ({
    fingerprint: row.dataset.fingerprint ?? '',
    quote: row.querySelector('.kb-scan-quote')?.textContent ?? '',
    meta: row.querySelector('.kb-scan-item-meta')?.textContent ?? '',
    missing: row.classList.contains('missing-reason'),
    done: row.classList.contains('done'),
    hasReasonInput: Boolean(row.querySelector('[data-role="decision-reason"]')),
    hasConfirm: Boolean(row.querySelector('[data-role="decision-confirm"]'))
  })),
  items: [...document.querySelectorAll('#kbGroups .kb-item')].map((row) => ({
    id: row.querySelector('.kb-item-main')?.dataset.id ?? '',
    title: row.querySelector('.kb-item-title')?.textContent ?? '',
    meta: row.querySelector('.kb-item-meta')?.textContent ?? '',
    flags: [...row.querySelectorAll('.kb-item-flag')].map((flag) => flag.textContent ?? ''),
    canSupersede: Boolean(row.querySelector('[data-role="decision-supersede"]')),
    canAbandon: Boolean(row.querySelector('[data-role="decision-abandon"]'))
  }))
}))()`);

const clickScan = (panel) => panel.evaluate("document.getElementById('kbScanSessions').click()");

/** 确认一条候选；reason 传空串就是「不补理由」。 */
const confirmCandidate = (panel, fingerprint, reason) => panel.evaluate(`(() => {
  const row = [...document.querySelectorAll('#kbScanCandidates .kb-scan-item')]
    .find((item) => item.dataset.fingerprint === ${JSON.stringify(fingerprint)});
  if (!row) return 'missing-row';
  const input = row.querySelector('[data-role="decision-reason"]');
  if (input) input.value = ${JSON.stringify(reason)};
  row.querySelector('[data-role="decision-confirm"]').click();
  return 'clicked';
})()`);

const clickDecisionAction = (panel, id, role) => panel.evaluate(`(() => {
  const row = [...document.querySelectorAll('#kbGroups .kb-item')]
    .find((item) => item.querySelector('.kb-item-main')?.dataset.id === ${JSON.stringify(id)});
  const button = row?.querySelector('[data-role="${role}"]');
  if (!button) return false;
  button.click();
  return true;
})()`);

const run = async () => {
  const { root, userData, ownerDb, knowledgeDb, projectRoot, codexHome } = makeRoot();
  fs.mkdirSync(shotsDir, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  writeCodexSession(codexHome, projectRoot);

  // 已登记项目：会话按工作目录精确匹配到它；决策确认也落在它下面。
  const owner = new OwnerStore(ownerDb);
  try {
    owner.registerProject({
      id: 'demo', name: 'Demo', root: projectRoot, primaryDomain: 'software-engineering'
    });
  } finally { owner.close(); }
  fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({
    projectId: 'demo', gatewayUrl: 'http://127.0.0.1:18789', model: '', includePaths: ['package.json']
  }, null, 2));

  let app = null;
  let failed = true;
  try {
    app = await startApp({
      userData,
      ownerDb,
      knowledgeDb,
      // HOME/USERPROFILE 一起指到临时目录：会话根（~/.claude、~/.codex）也跟着落到临时目录，
      // 扫描不会读到这台机器上真实用户的会话，验收因此是自洽的。
      env: { CODEX_HOME: codexHome, HOME: root, USERPROFILE: root },
      showPanel: true
    });
    const { panel } = app;
    await waitFor(panel, "document.getElementById('kbScanSessions')");
    await waitFor(panel, "!document.getElementById('modeB').hidden");

    const before = await readPanel(panel);
    check('确认前知识库是空的（候选不写库）', before.total === '0', before.total);

    await clickScan(panel);
    const scanned = await waitFor(panel, "document.querySelectorAll('#kbScanCandidates .kb-scan-item').length >= 2");
    check('扫描出两条候选', scanned);

    const afterScan = await readPanel(panel);
    check('扫描本身仍不写库', afterScan.total === '0', afterScan.total);
    check('候选带确认按钮与理由输入', afterScan.candidates.every((row) => row.hasConfirm && row.hasReasonInput));
    check('缺理由的候选有明显标记',
      afterScan.candidates.every((row) => row.missing && /缺理由/u.test(row.meta)),
      JSON.stringify(afterScan.candidates.map((row) => row.meta)));
    check('扫描结果说明了候选条数', /候选 2 条/u.test(afterScan.summary), afterScan.summary);

    const esbuild = afterScan.candidates.find((row) => row.quote.includes('esbuild'));
    const nodetest = afterScan.candidates.find((row) => row.quote.includes('node:test'));
    check('两条候选按原话区分得开', Boolean(esbuild && nodetest));

    // ① 补一句理由再确认。
    await confirmCandidate(panel, esbuild.fingerprint, '构建速度决定我一天能迭代几次');
    check('确认后候选标为已入库',
      await waitFor(panel, `[...document.querySelectorAll('#kbScanCandidates .kb-scan-item')]
        .some((row) => row.dataset.fingerprint === ${JSON.stringify(esbuild.fingerprint)} && row.classList.contains('done'))`));
    check('确认后知识层出现一条', await waitFor(panel, "document.getElementById('kbTotal').textContent === '1'"));

    const withReason = await readPanel(panel);
    const decision = withReason.items.find((item) => item.title.includes('esbuild'));
    check('决策出现在项目库（知识层）', Boolean(decision), decision?.title);
    check('决策带状态徽章「生效中」', /生效中/u.test(decision?.meta ?? ''), decision?.meta);
    check('决策写明来源与确认时间',
      /Codex 会话/u.test(decision?.meta ?? '') && /确认于/u.test(decision?.meta ?? ''), decision?.meta);
    check('补了理由就不标缺理由', !(decision?.flags ?? []).includes('缺理由'), JSON.stringify(decision?.flags));
    check('生效中的决策可标为已被取代 / 已放弃', decision?.canSupersede && decision?.canAbandon);
    await shotTall(panel, 'decision-confirmed.png');

    // ② 不补理由再确认：界面显示「缺理由」。
    await confirmCandidate(panel, nodetest.fingerprint, '');
    check('第二条候选确认后入库', await waitFor(panel, "document.getElementById('kbTotal').textContent === '2'"));
    const second = await readPanel(panel);
    const missing = second.items.find((item) => item.title.includes('node:test'));
    check('不补理由的决策标出「缺理由」', (missing?.flags ?? []).includes('缺理由'), JSON.stringify(missing));
    check('缺理由的决策仍算现状', /生效中/u.test(missing?.meta ?? ''), missing?.meta);
    await shotTall(panel, 'decision-missing-reason.png');

    // ③ 两套状态并存：决策状态是生效中，验证状态仍是待验证。
    const detailBefore = await panel.evaluate(
      `window.companion.knowledge.detail({ id: ${JSON.stringify(decision.id)} })`
    );
    check('决策状态与验证状态并存、互不冒充',
      detailBefore?.item?.decisionStatus === 'active' && detailBefore?.item?.verificationStatus === 'unverified',
      JSON.stringify({ decisionStatus: detailBefore?.item?.decisionStatus, verificationStatus: detailBefore?.item?.verificationStatus }));

    // ④ 标为已被取代：检索不再把它当现状，界面写明「不算现状」。
    check('点得到「已被取代」', await clickDecisionAction(panel, decision.id, 'decision-supersede'));
    check('界面出现「已被取代」与「不算现状」', await waitFor(panel, `(() => {
      const row = [...document.querySelectorAll('#kbGroups .kb-item')]
        .find((item) => item.querySelector('.kb-item-main')?.dataset.id === ${JSON.stringify(decision.id)});
      return Boolean(row && /已被取代/u.test(row.textContent) && /不算现状/u.test(row.textContent));
    })()`));

    const afterEnd = await readPanel(panel);
    const ended = afterEnd.items.find((item) => item.id === decision.id);
    check('结束状态带「不算现状」标记', (ended?.flags ?? []).includes('不算现状'), JSON.stringify(ended));
    check('结束的决策不再显示状态动作', ended?.canSupersede === false);
    await shotTall(panel, 'decision-superseded.png');

    const retrieval = await panel.evaluate(
      "window.companion.memory.decisions({ projectId: 'demo' })"
    );
    check('检索只返回生效中的决策',
      retrieval?.items?.length === 1 && !retrieval.items.some((item) => item.id === decision.id),
      JSON.stringify(retrieval?.items?.map((item) => item.id)));
    check('已被取代的决策单独列在 ended',
      retrieval?.ended?.some((item) => item.id === decision.id && item.status === 'superseded'),
      JSON.stringify(retrieval?.ended?.map((item) => [item.id, item.status])));

    const detailAfter = await panel.evaluate(
      `window.companion.knowledge.detail({ id: ${JSON.stringify(decision.id)} })`
    );
    check('改决策状态不动验证状态',
      detailAfter?.item?.decisionStatus === 'superseded' && detailAfter?.item?.verificationStatus === 'unverified',
      JSON.stringify({ decisionStatus: detailAfter?.item?.decisionStatus, verificationStatus: detailAfter?.item?.verificationStatus }));
    check('状态变更新增一版修订', detailAfter?.item?.revision === 2, String(detailAfter?.item?.revision));

    const errors = consoleErrors(panel);
    check('控制台无报错', errors.length === 0, errors.join(' | ').slice(0, 400));

    if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
    failed = false;
    console.log(`[DECISION-#87] PASS; shots → ${shotsDir}`);
  } finally {
    if (failed && app?.panel) {
      try {
        await capture(app.panel, path.join(shotsDir, 'decision-failure.png'));
      } catch { /* best effort */ }
    }
    if (app) await app.stop();
    // 应用退出后在同一个临时库上再核对一遍：库里确实是两条决策，状态一活一终。
    if (!failed) {
      const store = new PersonalKnowledgeStore(knowledgeDb, { logger: null });
      try {
        const decisions = store.listDecisions({ includeEnded: true });
        check('临时库里两条决策都落了库', decisions.length === 2, String(decisions.length));
        check('库里一条生效中、一条已被取代',
          decisions.filter((row) => row.decisionStatus === 'active').length === 1
          && decisions.filter((row) => row.decisionStatus === 'superseded').length === 1,
          JSON.stringify(decisions.map((row) => [row.title, row.decisionStatus])));
      } finally { store.close(); }
    }
    if (failed || failures.length > 0) {
      console.error(`[DECISION-#87] kept state: ${root}`);
    } else {
      safeRemove(root);
    }
    if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
  }
};

run().catch((error) => {
  console.error(`[DECISION-#87] FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
