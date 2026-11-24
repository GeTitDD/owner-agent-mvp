// #72 验收：删除只读详情卡，把它原来的四个计数（知识 / 测试 / 补丁 / 运行）搬进工作区。
//
// 断言六件事：
//   ① 详情卡的容器与正文容器都不在 DOM 里；
//   ② 工作区里的四个入口带着与快照一致的计数（并按视图项目取数）；
//   ③ 切到另一个项目后计数跟着换（入口仍只影响视图项目）；
//   ④ 四个入口各自点一次仍落在原来的位置（知识页 / 运行账本 / 待办）；
//   ⑤ 没有任何项目时入口整段收起，工作区显示空态、不崩；
//   ⑥ 控制台无错误（也覆盖「script 标签漏删导致 404」这种页面看起来正常的故障）。
// 全程用临时 userData + 临时 owner / 知识库，不碰真实 %APPDATA%。
// 截图与探针写到 SHOTS_DIR（缺省 focus-notes/shots-72）。
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { OwnerStore } from '../../src/owner-store.mjs';
import { PersonalKnowledgeStore } from '../../src/personal-store.mjs';
import { createPassingProject, createSyntheticProject } from '../knowledge-loop/fixtures.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const electronPath = createRequire(path.join(repoRoot, 'package.json'))('electron');
const shotsDir = process.env.SHOTS_DIR
  ?? path.resolve(repoRoot, '..', '..', 'focus-notes', 'shots-72');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const check = (label, condition, detail = '') => {
  if (condition) console.log(`[FOCUS-#72] OK   ${label}${detail ? ` (${detail})` : ''}`);
  else {
    failures.push(label);
    console.error(`[FOCUS-#72] FAIL ${label}${detail ? ` (${detail})` : ''}`);
  }
};

const freePort = async () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

/** 极简 CDP 客户端：只用 Node 自带的 WebSocket，不新增依赖。 */
const connectCdp = async (url) => {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = (event) => reject(new Error(`cdp socket error: ${event?.message ?? 'unknown'}`));
  });
  let seq = 0;
  const pending = new Map();
  const events = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id === undefined) {
      events.push(message);
      return;
    }
    const slot = pending.get(message.id);
    if (!slot) return;
    pending.delete(message.id);
    if (message.error) slot.reject(new Error(`${message.error.code}: ${message.error.message}`));
    else slot.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = (seq += 1);
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
    }
    return result.result.value;
  };
  return { send, evaluate, events, close: () => socket.close() };
};

const findPanelTarget = async (port) => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const panel = targets.find((target) => String(target.url).includes('panel.html'));
      if (panel?.webSocketDebuggerUrl) return panel.webSocketDebuggerUrl;
    } catch {
      // 端口还没起来：继续等。
    }
    await sleep(500);
  }
  throw new Error('panel target not found');
};

const waitFor = async (panel, expression, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await panel.evaluate(`Boolean(${expression})`)) return true;
    await sleep(250);
  }
  return false;
};

const startApp = async ({ ownerDb, knowledgeDb, userData }) => {
  const port = await freePort();
  const child = spawn(electronPath, [
    path.join(repoRoot, 'desktop', 'main.cjs'),
    `--user-data-dir=${userData}`,
    `--remote-debugging-port=${port}`
  ], {
    env: {
      ...process.env,
      OWNER_AGENT_DB: ownerDb,
      OWNER_KNOWLEDGE_DB: knowledgeDb,
      OWNER_AGENT_NOTIFICATIONS: '0',
      OWNER_AGENT_E2E_OFFSCREEN: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const log = [];
  child.stdout.on('data', (chunk) => log.push(String(chunk)));
  child.stderr.on('data', (chunk) => log.push(String(chunk)));
  const wsUrl = await findPanelTarget(port);
  const panel = await connectCdp(wsUrl);
  await panel.send('Runtime.enable');
  await panel.send('Log.enable');
  await panel.send('Page.enable');
  await panel.evaluate('window.companion.showPanel()');
  return {
    panel,
    log,
    stop: async () => {
      try { panel.close(); } catch { /* ignore */ }
      child.kill();
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(10000)
      ]);
    }
  };
};

const shot = async (panel, file) => {
  const result = await panel.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shotsDir, file), Buffer.from(result.data, 'base64'));
};

/** 全貌截图：面板是 440×640 的固定窗口，先临时把视口抬高再截，才能一屏看到两区。 */
const shotTall = async (panel, file, height = 1240) => {
  await panel.send('Emulation.setDeviceMetricsOverride', {
    width: 440, height, deviceScaleFactor: 1, mobile: false
  });
  await sleep(400);
  await shot(panel, file);
  await panel.send('Emulation.clearDeviceMetricsOverride');
  await sleep(200);
};

/** 只收集「错误或异常」，用来给验收报告里「控制台是否干净」下结论。 */
const consoleErrors = (panel) => panel.events
  .filter((event) => event.method === 'Runtime.exceptionThrown'
    || (event.method === 'Runtime.consoleAPICalled' && event.params?.type === 'error')
    || (event.method === 'Log.entryAdded' && event.params?.entry?.level === 'error'))
  .map((event) => event.method === 'Log.entryAdded'
    ? String(event.params.entry.text)
    : String(event.params?.exceptionDetails?.text
      ?? event.params?.args?.map((arg) => arg.value ?? arg.description).join(' ')));

const makeRoot = (label) => {
  const base = process.env.TMP_72 ?? os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, `focus-entries-${label}-`));
  const userData = path.join(root, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  return {
    root,
    userData,
    ownerDb: path.join(root, 'owner.sqlite'),
    knowledgeDb: path.join(root, 'knowledge.sqlite')
  };
};

/** Windows 上 Electron 刚退出时 userData 里还有句柄：删不掉就留着，别把验收判失败。 */
const safeRemove = (target) => {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    return true;
  } catch {
    console.warn(`[FOCUS-#72] kept state: ${target}`);
    return false;
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

/** 知识库夹具：两个项目知识（其中一条已验证）+ 一条经验 + 一条候选。 */
const seedKnowledge = (knowledgeDb, projectId) => {
  const store = new PersonalKnowledgeStore(knowledgeDb);
  try {
    store.create({
      title: '沙箱失败的证据先冻结',
      content: '失败的标准输出与快照哈希一起冻结，修复提案引用同一份证据。',
      kind: 'claim', layer: 'project', scope: 'project', projectId,
      domains: ['software-engineering'], tags: ['sandbox'], evidenceRefs: ['sandbox:seed'],
      verificationStatus: 'verified'
    });
    store.create({
      title: '应用补丁前先核 hash',
      content: '应用前核对批准时的 hash，避免批准后文件被换掉。',
      kind: 'claim', layer: 'project', scope: 'project', projectId,
      domains: ['software-engineering'], tags: ['patch'], evidenceRefs: ['patch:seed'],
      verificationStatus: 'unverified'
    });
    store.create({
      title: '项目入口的计数要跟视图项目走',
      content: '入口计数取自按视图项目取回的快照，切项目就换数字。',
      kind: 'claim', layer: 'project', scope: 'project', projectId,
      domains: ['software-engineering'], tags: ['panel'], evidenceRefs: ['panel:seed'],
      verificationStatus: 'unverified'
    });
    store.addLesson({
      projectId,
      sourceRecordId: 'sandbox:seed',
      phenomenon: '修复复测仍失败',
      mechanism: '沙箱只重建补丁碰过的文件',
      countermeasure: '把测试依赖一起纳入快照',
      scope: { layer: 'project', projectId, domainIds: ['software-engineering'] },
      verificationStatus: 'unverified',
      evidenceRefs: ['sandbox:seed']
    }, { evidence: [{ ref: 'sandbox:seed', recordId: 'seed', kind: 'log', excerpt: 'fixture' }] });
    store.submitProposal({
      payload: {
        title: '候选：入口计数别另取一份快照',
        content: '详情卡删除后，入口计数直接读主快照，避免同一件事两处取数。',
        kind: 'claim', layer: 'project', scope: 'project', projectId,
        domains: ['software-engineering'], tags: ['panel'], evidenceRefs: [],
        verificationStatus: 'unverified'
      },
      meta: { contract: 'knowledge-candidate/v1', sourceLessonIds: [], confidence: 0.6 }
    });
  } finally {
    store.close();
  }
};

/** 有项目的场景：alpha 有 2 个任务 / 1 个补丁 / 1 次测试 / 3 条知识；beta 数字不同。 */
const scenarioWithProjects = async (probe) => {
  const { root, userData, ownerDb, knowledgeDb } = makeRoot('projects');
  const owner = new OwnerStore(ownerDb);
  try {
    createPassingProject({ store: owner, root: path.join(root, 'alpha'), projectId: 'alpha', name: 'Alpha Repo' });
    const beta = createSyntheticProject({ store: owner, root: path.join(root, 'beta'), projectId: 'beta', name: 'Beta Repo' });
    probe.betaFixture = { cycleId: beta.cycleId, baseSha: beta.baseSha };
  } finally {
    owner.close();
  }
  seedKnowledge(knowledgeDb, 'alpha');
  writeCompanionConfig(userData, 'alpha');

  const app = await startApp({ ownerDb, knowledgeDb, userData });
  const { panel } = app;
  try {
    await waitFor(panel, "document.querySelector('#modeBar button[data-mode=\"focus\"]')");
    await waitFor(panel, 'window.OwnerFocusOps');
    await panel.evaluate("document.querySelector('#modeBar button[data-mode=\"focus\"]').click()");
    // 等快照到达并画出工作区（项目名 + 四个入口）。
    await waitFor(panel, "document.getElementById('workProjectName').textContent.trim() !== ''");
    await waitFor(panel, "!document.getElementById('workEntries').hidden");
    await sleep(600);

    const dom = await panel.evaluate(`(() => ({
      hasDetailCard: Boolean(document.getElementById('focusDetail') || document.getElementById('fdBody')),
      entriesHidden: document.getElementById('workEntries').hidden,
      entries: [...document.querySelectorAll('#workEntries .work-entry')].map((node) => ({
        key: node.dataset.entry,
        label: node.querySelector('.work-entry-label')?.textContent ?? '',
        count: node.querySelector('.work-entry-count')?.textContent ?? '',
        note: node.querySelector('.work-entry-note')?.textContent ?? ''
      })),
      projectName: document.getElementById('workProjectName').textContent,
      tabs: [...document.querySelectorAll('#fdTabs .fd-tab')].map((node) => ({
        project: node.dataset.project, on: node.classList.contains('on')
      })),
      entriesInWorkspace: document.getElementById('workZone').contains(document.getElementById('workEntries'))
    }))()`);
    probe.withProjects = dom;
    check('详情卡的容器不在 DOM 里', dom.hasDetailCard === false);
    check('四个入口在工作区里且可见', dom.entriesInWorkspace === true && dom.entriesHidden === false);
    check('四个入口的顺序是 知识 / 测试 / 补丁 / 运行',
      JSON.stringify(dom.entries.map((entry) => entry.key))
        === JSON.stringify(['knowledge', 'tests', 'patches', 'runs']), JSON.stringify(dom.entries.map((e) => e.key)));

    const expected = await panel.evaluate(`(async () => {
      const tab = document.querySelector('#fdTabs .fd-tab.on')?.dataset.project ?? '';
      const snapshot = await window.companion.snapshot({ projectId: tab });
      const knowledge = snapshot.knowledge?.counts ?? {};
      const testStatus = snapshot.chain?.sandbox?.testStatus ?? '';
      const patchStatus = snapshot.chain?.patch?.status ?? '';
      const pendingPatches = (snapshot.pending ?? []).filter((item) =>
        item.projectId === tab && (item.kind === 'patch' || item.kind === 'patch-apply')).length;
      return {
        project: snapshot.config?.projectId ?? '',
        tab,
        name: (snapshot.projects ?? []).find((item) => item.id === tab)?.name ?? '',
        jobs: snapshot.counts?.jobs ?? 0,
        patches: snapshot.counts?.patches ?? 0,
        tests: snapshot.counts?.tests ?? 0,
        knowledge: knowledge.knowledge ?? 0,
        candidates: knowledge.candidates ?? 0,
        verified: knowledge.verified ?? 0,
        testNote: testStatus === 'pass' ? '最近通过'
          : testStatus === 'fail' ? '最近未通过'
            : snapshot.chain?.sandbox ? '最近未完成' : '还没跑过',
        patchNote: pendingPatches > 0
          ? \`待审 \${pendingPatches}\`
          : patchStatus === 'applied' ? '最近已应用'
            : patchStatus ? \`最近 \${patchStatus}\` : '还没有补丁'
      };
    })()`);
    probe.expectedInitial = expected;
    const countOf = (key) => Number(dom.entries.find((entry) => entry.key === key)?.count ?? NaN);
    check('知识计数与快照一致', countOf('knowledge') === expected.knowledge,
      `${countOf('knowledge')} vs ${expected.knowledge}`);
    check('测试计数与快照一致', countOf('tests') === expected.tests, `${countOf('tests')} vs ${expected.tests}`);
    check('补丁计数与快照一致', countOf('patches') === expected.patches, `${countOf('patches')} vs ${expected.patches}`);
    check('运行计数与快照一致', countOf('runs') === expected.jobs, `${countOf('runs')} vs ${expected.jobs}`);
    check('每个入口都有一句状态（不含正在读取）',
      dom.entries.every((entry) => entry.note.trim() !== '' && !entry.note.includes('正在读取')),
      JSON.stringify(dom.entries.map((entry) => entry.note)));
    const noteOf = (key) => dom.entries.find((entry) => entry.key === key)?.note ?? '';
    check('测试入口的状态句与快照一致', noteOf('tests') === expected.testNote,
      `${noteOf('tests')} vs ${expected.testNote}`);
    check('补丁入口的状态句与快照一致', noteOf('patches') === expected.patchNote,
      `${noteOf('patches')} vs ${expected.patchNote}`);
    check('工作区顶部写着当前视图项目', dom.projectName === expected.name, `${dom.projectName} vs ${expected.name}`);
    check('切换标签高亮当前视图项目', dom.tabs.find((tab) => tab.on)?.project === expected.tab);

    await shotTall(panel, 'focus-workspace.png');
    await shot(panel, 'focus-workspace-viewport.png');

    // 切到另一个项目：计数应换成那个项目的数字（入口跟随视图项目）。
    const otherId = await panel.evaluate(`(async () => {
      const tab = [...document.querySelectorAll('#fdTabs .fd-tab')]
        .find((node) => !node.classList.contains('on'));
      tab?.click();
      return tab?.dataset.project ?? '';
    })()`);
    await waitFor(panel, `document.querySelector('#fdTabs .fd-tab.on')?.dataset.project === '${otherId}'`);
    await sleep(1200);
    const otherDom = await panel.evaluate(`(async () => {
      const snapshot = await window.companion.snapshot({ projectId: '${otherId}' });
      return {
        projectName: document.getElementById('workProjectName').textContent,
        expectedName: (snapshot.projects ?? [])
          .find((item) => item.id === snapshot.config?.projectId)?.name ?? '',
        counts: Object.fromEntries([...document.querySelectorAll('#workEntries .work-entry')]
          .map((node) => [node.dataset.entry, Number(node.querySelector('.work-entry-count')?.textContent ?? -1)])),
        snapshot: {
          jobs: snapshot.counts?.jobs ?? 0,
          patches: snapshot.counts?.patches ?? 0,
          tests: snapshot.counts?.tests ?? 0,
          knowledge: snapshot.knowledge?.counts?.knowledge ?? 0
        },
        tabOn: document.querySelector('#fdTabs .fd-tab.on')?.dataset.project ?? ''
      };
    })()`);
    probe.switched = { otherId, ...otherDom };
    check('切项目后工作区写着新项目', otherDom.projectName === otherDom.expectedName,
      `${otherDom.projectName} vs ${otherDom.expectedName}`);
    check('切项目后切换标签跟着高亮', otherDom.tabOn === otherId, otherDom.tabOn);
    check('切项目后四个计数换成新项目的数字',
      otherDom.counts.runs === otherDom.snapshot.jobs
      && otherDom.counts.patches === otherDom.snapshot.patches
      && otherDom.counts.tests === otherDom.snapshot.tests
      && otherDom.counts.knowledge === otherDom.snapshot.knowledge,
      JSON.stringify(otherDom));
    await shot(panel, 'focus-workspace-switched.png');

    // 回到最初那个项目再点四个入口：落点与删除前一致。
    await panel.evaluate(`(async () => {
      const tab = [...document.querySelectorAll('#fdTabs .fd-tab')]
        .find((node) => node.dataset.project === '${expected.tab}');
      tab?.click();
    })()`);
    await waitFor(panel, `document.querySelector('#fdTabs .fd-tab.on')?.dataset.project === '${expected.tab}'`);
    await sleep(900);

    const jumps = [];
    for (const key of ['knowledge', 'tests', 'patches', 'runs']) {
      const result = await panel.evaluate(`(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        document.querySelector('#modeBar button[data-mode="focus"]')?.click();
        await wait(500);
        const entry = document.querySelector('#workEntries .work-entry[data-entry="${key}"]');
        if (!entry) return { key: '${key}', error: 'entry-not-rendered' };
        entry.click();
        await wait(1200);
        const views = { focus: 'modeA', knowledge: 'modeB', chat: 'modeC' };
        const visible = Object.entries(views)
          .find(([, id]) => !document.getElementById(id).hidden)?.[0] ?? '';
        const node = document.getElementById('${key === 'knowledge' ? 'knowledgeBrowse' : key === 'patches' ? 'opsZone' : 'runningSection'}');
        const rect = node?.getBoundingClientRect();
        return {
          key: '${key}',
          visible,
          target: node?.id ?? '',
          targetVisible: Boolean(node) && rect ? rect.height > 0 : false,
          top: rect ? Math.round(rect.top) : null
        };
      })()`);
      jumps.push(result);
      await shot(panel, `focus-entry-${key}.png`);
    }
    probe.jumps = jumps;
    const expect = (key) => ({
      knowledge: ['knowledge', 'knowledgeBrowse'],
      tests: ['focus', 'runningSection'],
      patches: ['focus', 'opsZone'],
      runs: ['focus', 'runningSection']
    }[key]);
    for (const jump of jumps) {
      const [mode, target] = expect(jump.key);
      check(`入口 ${jump.key} 落在 ${mode}/${target}`,
        jump.visible === mode && jump.target === target && jump.targetVisible === true,
        JSON.stringify(jump));
    }

    // 目标被移走时退回模式顶部：临时摘掉 runningSection 的 id，点「运行」不应报错。
    const fallback = await panel.evaluate(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      document.querySelector('#modeBar button[data-mode="focus"]')?.click();
      await wait(500);
      const wrap = document.querySelector('#modeA .a-wrap');
      // 先滚到工作区深处，再看「找不到目标」时是否真的回到顶部。
      document.getElementById('runningSection').scrollIntoView({ block: 'start' });
      await wait(600);
      const before = wrap.scrollTop;
      const node = document.getElementById('runningSection');
      node.id = 'runningSection-detached';
      document.querySelector('#workEntries .work-entry[data-entry="runs"]')?.click();
      await wait(900);
      node.id = 'runningSection';
      return {
        before,
        after: wrap.scrollTop,
        stillFocus: !document.getElementById('modeA').hidden
      };
    })()`);
    probe.fallback = fallback;
    check('目标不存在时退回模式顶部且不报错',
      fallback.stillFocus === true && fallback.before > 0 && fallback.after === 0,
      JSON.stringify(fallback));

    const errors = consoleErrors(panel);
    probe.consoleErrors = errors;
    check('控制台无错误', errors.length === 0, errors.join(' | ').slice(0, 300));
  } finally {
    await app.stop();
  }
  safeRemove(root);
};

/** 没有项目的场景：入口整段收起，工作区不留假计数，也不崩。 */
const scenarioWithoutProjects = async (probe) => {
  const { root, userData, ownerDb, knowledgeDb } = makeRoot('empty');
  const personal = new PersonalKnowledgeStore(knowledgeDb);
  personal.close();
  writeCompanionConfig(userData, '');
  const app = await startApp({ ownerDb, knowledgeDb, userData });
  const { panel } = app;
  try {
    await waitFor(panel, "document.querySelector('#modeBar button[data-mode=\"focus\"]')");
    // 等面板自己的首次刷新把项目列表画出来，再切模式：否则点的是一个还没绑定事件的按钮。
    await waitFor(panel, "document.getElementById('projectList').textContent.trim() !== ''");
    await panel.evaluate("document.querySelector('#modeBar button[data-mode=\"focus\"]').click()");
    await waitFor(panel, "!document.getElementById('modeA').hidden");
    await sleep(1200);
    const dom = await panel.evaluate(`(() => ({
      entriesHidden: document.getElementById('workEntries').hidden,
      entriesText: document.getElementById('workEntries').textContent.trim(),
      projectBarHidden: document.getElementById('workProjectBar').hidden,
      workspacePresent: Boolean(document.getElementById('workWorkspace')),
      projectRows: document.querySelectorAll('#projectList .project-row').length,
      projectListText: (document.getElementById('projectList').textContent || '').slice(0, 80),
      setupHidden: document.getElementById('setup').hidden,
      focusVisible: !document.getElementById('modeA').hidden
    }))()`);
    probe.withoutProjects = dom;
    check('没有项目时四个入口整段收起', dom.entriesHidden === true, dom.entriesText);
    check('没有项目时工作区仍在、项目条收起', dom.workspacePresent === true && dom.projectBarHidden === true);
    check('没有项目时显示空态文案', /还没有项目/u.test(dom.projectListText), dom.projectListText);
    check('没有项目时不崩、仍停在专注页', dom.focusVisible === true);
    await shotTall(panel, 'focus-no-project.png', 900);
    const errors = consoleErrors(panel);
    probe.consoleErrorsEmpty = errors;
    check('没有项目时控制台无错误', errors.length === 0, errors.join(' | ').slice(0, 300));
  } finally {
    await app.stop();
  }
  safeRemove(root);
};

const run = async () => {
  fs.mkdirSync(shotsDir, { recursive: true });
  const probe = { shotsDir };
  await scenarioWithProjects(probe);
  await scenarioWithoutProjects(probe);
  fs.writeFileSync(path.join(shotsDir, 'focus-entries-probe.json'), JSON.stringify(probe, null, 2));
  if (failures.length) throw new Error(`${failures.length} assertion(s) failed`);
  console.log('[FOCUS-#72] PASS');
};

run().catch((error) => {
  console.error(`[FOCUS-#72] FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
