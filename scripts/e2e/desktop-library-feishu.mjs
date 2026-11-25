// 项目库发布卡片验收（#91）：发布后发一条飞书文本卡片，失败可人工重发。
//
// 用 scripts/e2e/lib/cdp.mjs 的共用客户端：临时 userData + 临时 owner/知识库；
// 飞书侧不起外网请求，只在本机起一个桩服务（127.0.0.1），记录请求体并按需返回成功 / 失败。
// 断言：卡片文案含项目名、一句话现状、四个计数与本地导出路径；失败时快照与导出都在、
// 状态显示「未发送」且不自动重试；点「重新发送」才会再发一次；未配 webhook 时一次 fetch 都不发。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { OwnerStore } from '../../src/owner-store.mjs';
import { PersonalKnowledgeStore } from '../../src/personal-store.mjs';
import { ProjectSnapshotStore } from '../../src/project-snapshots.mjs';
import { createSyntheticProject } from '../knowledge-loop/fixtures.mjs';
import { capture, consoleErrors, createChecker, sleep, startApp, waitFor } from './lib/cdp.mjs';

const { check, failures } = createChecker('[CARD]');

/** 本机桩服务：mode 可在用例中途切换成失败，请求体逐条留下来核对。 */
const startWebhookStub = async () => {
  const state = { mode: 'ok', requests: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      state.requests.push(Buffer.concat(chunks).toString('utf8'));
      if (state.mode === 'fail') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 500, msg: 'stub failure' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0, msg: 'success' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    state,
    url: `http://127.0.0.1:${port}/open-apis/bot/v2/hook/test`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
};

const focusAlpha = async (panel, projectId = 'alpha') => {
  await waitFor(panel, `typeof window.companion?.snapshot === 'function'`);
  const focusShown = await waitFor(panel, `(() => {
    document.querySelector('#modeBar button[data-mode="focus"]')?.click();
    const mode = document.getElementById('modeA');
    return mode && !mode.hidden;
  })()`);
  if (!focusShown) throw new Error('focus mode did not open');
  // 只有一个项目时不渲染切换标签（见 renderWorkProjectBar）：先看有没有标签再决定点不点。
  const tabbed = await waitFor(panel, `document.querySelector('#fdTabs .fd-tab[data-project="${projectId}"]')`);
  if (tabbed) {
    await panel.evaluate(`document.querySelector('#fdTabs .fd-tab[data-project="${projectId}"]').click()`);
  }
  const ready = await waitFor(panel, `(() => {
    const section = document.getElementById('librarySection');
    return section && !section.hidden
      && document.querySelectorAll('#librarySections .library-block').length === 2;
  })()`);
  if (!ready) throw new Error('library section did not render');
  await panel.evaluate("document.getElementById('librarySection').scrollIntoView({ block: 'center' })");
  await sleep(400);
};

/** 只取库段的导出 / 卡片状态，避免读到别处的「飞书」字样。 */
const libraryState = (panel) => panel.evaluate(`(() => {
  const box = document.getElementById('libraryExport');
  return {
    hidden: Boolean(box?.hidden),
    text: box?.textContent?.trim() ?? '',
    delivery: document.querySelector('#libraryExport .library-delivery')?.textContent?.trim() ?? '',
    resend: [...(box?.querySelectorAll('button') ?? [])]
      .map((node) => node.textContent.trim()).includes('重新发送'),
    versions: [...document.querySelectorAll('#libraryVersions .library-version')]
      .map((node) => node.textContent.trim())
  };
})()`);

const shotExportBox = async (panel, file) => {
  await panel.evaluate("document.getElementById('libraryExport')?.scrollIntoView({ block: 'center' })");
  await sleep(350);
  await capture(panel, file);
};

const waitForDelivery = (panel, pattern) => waitFor(panel, `(() => {
  const text = document.querySelector('#libraryExport .library-delivery')?.textContent ?? '';
  return ${pattern}.test(text);
})()`, 20000);

const seed = ({ ownerDb, knowledgeDb, root }) => {
  const owner = new OwnerStore(ownerDb);
  try {
    const alpha = createSyntheticProject({
      store: owner, root: path.join(root, 'alpha'), projectId: 'alpha', name: 'Alpha Repo'
    });
    owner.saveProjectBrief({
      projectId: 'alpha',
      basedOnCommit: alpha.baseSha,
      sourceRunId: 'pb_card',
      payload: {
        oneLiner: '一个用于验收发布卡片的零依赖 Node 项目',
        whatItIs: 'Alpha Repo 是测试夹具，包含 format 与 retry 两个模块。',
        howToRun: ['npm test'],
        modules: [{ name: 'retry', role: '重试循环', paths: ['src/retry.js'] }],
        conventions: ['写操作先提案'],
        verify: { commands: ['npm test'], criteria: ['退出码为 0'] },
        risks: ['没有 CI'],
        unknowns: [],
        evidence: ['package.json'],
        confidence: '中'
      }
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
      evidenceRefs: ['sandbox:run-card-verified'], verificationStatus: 'verified', sourceRef: 'acceptance'
    });
    personal.create({
      title: 'Retry jitter is optional',
      content: 'Jitter helps under contention but has not been confirmed here.',
      kind: 'hypothesis', layer: 'applied', scope: 'domain',
      domains: ['software-engineering'], tags: ['retry'],
      evidenceRefs: ['sandbox:run-card-hypothesis'], verificationStatus: 'unverified', sourceRef: 'acceptance'
    });
    personal.recordLesson({
      projectId: 'alpha',
      sourceRecordId: 'sandbox:run-card-lesson',
      phenomenon: 'retry 循环少跑一次，最后一次重试不执行',
      mechanism: 'for 循环写成 i < attempts - 1',
      countermeasure: '改成 i < attempts，并用同一条断言复跑测试',
      scope: { layer: 'project', projectId: 'alpha', domainIds: ['software-engineering'] },
      verificationStatus: 'unverified',
      evidenceRefs: ['sandbox:run-card-lesson']
    }, { evidence: [{ ref: 'sandbox:run-card-lesson', recordId: 'sandbox:run-card-lesson', kind: 'record' }] });
  } finally {
    personal.close();
  }
};

const run = async () => {
  const base = process.env.TMP_EXPORT ?? os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'companion-card-'));
  const userData = path.join(root, 'userdata');
  const ownerDb = path.join(root, 'owner.sqlite');
  const knowledgeDb = path.join(root, 'knowledge.sqlite');
  const exportsRoot = path.join(userData, 'exports');
  const evidence = process.env.EVIDENCE_DIR ?? path.join(root, 'evidence');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });

  seed({ ownerDb, knowledgeDb, root });
  fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({
    pet: { x: 240, y: 190 }, projectId: 'alpha', mascotSkin: 'erika',
    gatewayUrl: 'http://127.0.0.1:18789', model: '', includePaths: ['package.json']
  }, null, 2));

  const stub = await startWebhookStub();
  let app = null;
  const shots = [];
  let failed = true;
  try {
    app = await startApp({
      ownerDb, knowledgeDb, userData, showPanel: true,
      env: { OWNER_OBSERVER_FEISHU_WEBHOOK: stub.url }
    });
    let panel = app.panel;
    await waitFor(panel, "document.querySelector('#modeBar button[data-mode=\"focus\"]')");
    await focusAlpha(panel);

    // 1) 发布 v1：卡片发出一条文本消息，四个计数与导出路径都在里面。
    await panel.evaluate("document.getElementById('libraryDraft').click()");
    check('生成草稿后可以发布', await waitFor(panel, `!document.getElementById('libraryPublish')?.disabled`));
    await panel.evaluate("document.getElementById('libraryPublish').click()");
    check('发布后库段显示卡片已发送', await waitForDelivery(panel, '/已发送/u'));
    check('发布只发一条卡片', stub.state.requests.length === 1, String(stub.state.requests.length));

    const payload = JSON.parse(stub.state.requests[0] ?? '{}');
    const card = String(payload?.content?.text ?? '');
    check('请求体是现有通道的文本消息', payload.msg_type === 'text' && Boolean(payload.content?.text), payload.msg_type);
    check('卡片含项目名与版本号', card.includes('Alpha Repo') && card.includes('v1'), card.split('\n')[0] ?? '');
    check('卡片含一句话现状', card.includes('一个用于验收发布卡片的零依赖 Node 项目'));

    const store = new ProjectSnapshotStore(ownerDb);
    let raw = null;
    let rawContent = null;
    let v2Exists = false;
    try {
      raw = store.getVersionRaw('alpha', 1);
      rawContent = JSON.parse(raw.contentText);
    } finally {
      store.close();
    }
    const dk = rawContent.counts.domainKnowledge;
    const ck = rawContent.counts.contributedKnowledge;
    const expectedCounts = `知识 ${dk + ck} 条 · 经验 ${rawContent.counts.experiences} 条 · ` +
      `观察中 ${rawContent.counts.observing} 条 · 共 ${rawContent.counts.total} 条`;
    check('卡片四个计数与快照一致', card.includes(expectedCounts), expectedCounts);
    const expectedDir = path.join(exportsRoot, 'alpha', 'v1');
    check('卡片里有本地导出路径', card.includes(`本地导出：${expectedDir}`), expectedDir);
    const ui1 = await libraryState(panel);
    check('界面显示导出路径与已发送状态', ui1.text.includes(expectedDir) && /已发送/u.test(ui1.delivery), ui1.text);
    check('已发送时不显示「重新发送」按钮', ui1.resend === false, String(ui1.resend));
    await shotExportBox(panel, path.join(evidence, '01-publish-card-sent.png'));
    shots.push('01-publish-card-sent.png');

    // 2) 发送失败：快照与导出都在，状态「未发送」+ 原因，且不自动重试。
    stub.state.mode = 'fail';
    const before = stub.state.requests.length;
    await panel.evaluate("document.getElementById('libraryPublish').click()");
    check('失败后库段显示未发送', await waitForDelivery(panel, '/未发送/u'));
    const ui2 = await libraryState(panel);
    check('未发送写明原因（HTTP 500）', /feishu http 500/u.test(ui2.delivery), ui2.delivery);
    check('失败时只投递一次、不自动重试', stub.state.requests.length === before + 1,
      `${stub.state.requests.length - before}`);

    const v2Dir = path.join(exportsRoot, 'alpha', 'v2');
    const v2Store = new ProjectSnapshotStore(ownerDb);
    try {
      v2Exists = Boolean(v2Store.getVersionRaw('alpha', 2)?.contentText);
    } finally {
      v2Store.close();
    }
    check('失败时快照仍在（v2 可读）', v2Exists);
    check('失败时导出文件仍在（snapshot.json + report.html）',
      fs.existsSync(path.join(v2Dir, 'snapshot.json')) && fs.existsSync(path.join(v2Dir, 'report.html')), v2Dir);
    check('失败时出现「重新发送」按钮', ui2.resend === true, String(ui2.resend));
    await shotExportBox(panel, path.join(evidence, '02-publish-card-unsent.png'));
    shots.push('02-publish-card-unsent.png');

    // 3) 等一轮面板轮询，确认失败没有被自动重发（请求数不变）。
    const afterFail = stub.state.requests.length;
    await sleep(3000);
    check('没有自动重试：轮询后请求数不变', stub.state.requests.length === afterFail,
      `${stub.state.requests.length}/${afterFail}`);

    // 4) 人点「重新发送」才再发一次；不新建版本。
    stub.state.mode = 'ok';
    await panel.evaluate(`(() => {
      const box = document.getElementById('libraryExport');
      [...box.querySelectorAll('button')].find((node) => node.textContent.trim() === '重新发送')?.click();
    })()`);
    check('点重新发送后变为已发送', await waitForDelivery(panel, '/已发送/u'));
    check('重新发送只多发一次', stub.state.requests.length === afterFail + 1,
      `${stub.state.requests.length}/${afterFail}`);
    const versions = await panel.evaluate(
      "[...document.querySelectorAll('#libraryVersions .library-version')].length"
    );
    check('重新发送不新建版本（仍只有 v1 / v2）', versions === 2, String(versions));
    await shotExportBox(panel, path.join(evidence, '03-resend-sent.png'));
    shots.push('03-resend-sent.png');

    let errors = consoleErrors(panel);
    check('控制台无报错（配置 webhook 的整段）', errors.length === 0, errors.slice(0, 3).join(' | '));
    await app.stop();
    app = null;

    // 5) 未配 webhook：重启到空 HOME + 空环境变量，一次 fetch 都不发，界面明确写「没配 webhook」。
    const emptyHome = path.join(root, 'home-empty');
    fs.mkdirSync(emptyHome, { recursive: true });
    app = await startApp({
      ownerDb, knowledgeDb, userData, showPanel: true,
      env: {
        OWNER_OBSERVER_FEISHU_WEBHOOK: '',
        USERPROFILE: emptyHome,
        HOME: emptyHome
      }
    });
    panel = app.panel;
    await waitFor(panel, "document.querySelector('#modeBar button[data-mode=\"focus\"]')");
    await focusAlpha(panel);
    const beforeNoWebhook = stub.state.requests.length;
    await panel.evaluate("document.getElementById('libraryDraft').click()");
    await waitFor(panel, `!document.getElementById('libraryPublish')?.disabled`);
    await panel.evaluate("document.getElementById('libraryPublish').click()");
    check('未配 webhook 时显示未发送', await waitForDelivery(panel, '/未发送/u'));
    const ui3 = await libraryState(panel);
    check('未配 webhook 的提示可见', /没配 webhook/u.test(ui3.delivery), ui3.delivery);
    check('未配 webhook 时一次都不调用 fetch', stub.state.requests.length === beforeNoWebhook,
      `${stub.state.requests.length}/${beforeNoWebhook}`);
    check('未配 webhook 时仍能点「重新发送」（配好后再试）', ui3.resend === true, String(ui3.resend));
    await shotExportBox(panel, path.join(evidence, '04-no-webhook.png'));
    shots.push('04-no-webhook.png');

    errors = consoleErrors(panel);
    check('控制台无报错（未配 webhook 的一段）', errors.length === 0, errors.slice(0, 3).join(' | '));

    if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
    failed = false;
    console.log(`[CARD] PASS screenshots: ${shots.join(', ')}`);
    console.log(`[CARD] export root: ${exportsRoot}`);
  } finally {
    if (failed && app?.panel) {
      try { await capture(app.panel, path.join(evidence, 'failure.png')); } catch { /* best effort */ }
    }
    if (failed) console.error(`[CARD] app log tail:\n${(app?.log ?? []).join('').slice(-3000)}`);
    try { await app?.stop(); } catch { /* best effort */ }
    await stub.close();
    if (failed || failures.length > 0) console.error(`[CARD] kept state: ${root}`);
    else {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 下偶发占用，留给系统清理 */ }
    }
  }
};

run().catch((error) => {
  console.error(`[CARD] FAIL: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
