// #73 验收：设置向导搬进设置面板、答案/会话/结果落到操作区下钻位置、
// 选项目只剩工作区顶部一处（「添加项目」挂在切换行尾）。
//
// 做法与 desktop-ops-proposals.mjs 相同：临时 userData + 临时库 + 离屏 Electron，
// 用 Node 自带的 WebSocket 走 CDP，不联网、不起真实模型、不碰 %APPDATA%。
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { OwnerStore } from '../../src/owner-store.mjs';
import { createSyntheticProject } from '../knowledge-loop/fixtures.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const electronPath = createRequire(path.join(repoRoot, 'package.json'))('electron');
const shotsDir = process.env.SHOTS_DIR
  ?? path.join(repoRoot, '..', '..', 'focus-notes', 'shots-73');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const check = (label, condition, detail = '') => {
  if (condition) console.log(`[FOCUS-#73] OK   ${label}${detail ? ` (${detail})` : ''}`);
  else {
    failures.push(label);
    console.error(`[FOCUS-#73] FAIL ${label}${detail ? ` (${detail})` : ''}`);
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
    // 单次 CDP 调用给个上限：离屏窗口偶尔不回包，卡死会毁掉整次验收。
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`cdp timeout: ${method}`));
    }, 20000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); }
    });
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
      OWNER_AGENT_E2E_OFFSCREEN: '1',
      // 测试环境没有真实模型：让只读分诊快速超时，答案卡就是「这次操作的结果」。
      OWNER_TRIAGE_TIMEOUT_MS: '4000'
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
  return {
    panel,
    log,
    stop: async () => {
      panel.close();
      child.kill();
      await sleep(500);
      if (!child.killed) child.kill('SIGKILL');
    }
  };
};

const shot = async (panel, file) => {
  const result = await panel.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shotsDir, file), Buffer.from(result.data, 'base64'));
};

/** 只收集渲染进程的异常与 error 级日志：控制台干净与否看这个。 */
const consoleErrors = (panel) => panel.events
  .filter((event) => event.method === 'Runtime.exceptionThrown'
    || (event.method === 'Runtime.consoleAPICalled' && event.params?.type === 'error')
    || (event.method === 'Log.entryAdded' && event.params?.entry?.level === 'error'))
  .map((event) => event.method === 'Log.entryAdded'
    ? String(event.params.entry.text)
    : String(event.params?.exceptionDetails?.text
      ?? event.params?.args?.map((arg) => arg.value ?? arg.description).join(' ')));

const waitFor = async (panel, expression, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await panel.evaluate(`Boolean(${expression})`)) return true;
    } catch (error) {
      console.error(`[FOCUS-#73] waitFor 失败：${error?.message ?? error}`);
      return false;
    }
    await sleep(250);
  }
  return false;
};

const makeRoot = () => {
  const base = process.env.TMP_73 ?? path.join(os.tmpdir());
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'focus-relocate-'));
  const userData = path.join(root, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  return { root, userData, ownerDb: path.join(root, 'owner.sqlite'), knowledgeDb: path.join(root, 'knowledge.sqlite') };
};

/** 两个带夹具的项目 + 一个只有目录、没有任何记录的空项目（用来验证「没有结果时不占位」）。 */
const seed = (owner, root) => {
  createSyntheticProject({ store: owner, root: path.join(root, 'alpha'), projectId: 'alpha', name: 'Alpha Repo' });
  createSyntheticProject({ store: owner, root: path.join(root, 'beta'), projectId: 'beta', name: 'Beta Repo' });
  const gammaRoot = path.join(root, 'gamma');
  fs.mkdirSync(path.join(gammaRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(gammaRoot, 'package.json'),
    JSON.stringify({ name: 'gamma', version: '1.0.0' }, null, 2));
  fs.writeFileSync(path.join(gammaRoot, 'src', 'index.js'), 'export const noop = () => 1;\n');
  owner.registerProject({ id: 'gamma', name: 'Gamma 空项目', root: gammaRoot });
  const at = new Date().toISOString();
  for (let i = 1; i <= 3; i += 1) {
    const job = owner.createJob({
      projectId: 'alpha',
      jobType: 'noop',
      title: `整理首页文案 第 ${i} 次`,
      idempotencyKey: `t73-${i}`
    });
    owner.db.prepare("UPDATE owner_jobs SET status='succeeded', finished_at=?, updated_at=? WHERE id=?")
      .run(at, at, job.id);
  }
};

const run = async () => {
  fs.mkdirSync(shotsDir, { recursive: true });
  const step = (label) => console.log(`[FOCUS-#73] .. ${label}`);
  // 离屏 Electron + CDP 偶尔会卡在一次截图/求值上：给整体一个上限，别让脚本挂死。
  const watchdog = setTimeout(() => {
    console.error('[FOCUS-#73] 超时：脚本在 240 秒内没跑完');
    process.exit(2);
  }, 240000);
  watchdog.unref?.();
  const { root, userData, ownerDb, knowledgeDb } = makeRoot();
  fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({
    pet: { x: 220, y: 180 }, projectId: 'alpha', allowedPaths: 'src/',
    includePaths: ['package.json'], gatewayUrl: 'http://127.0.0.1:18789',
    model: 'test/focus-model', knowledgeAutoHarvest: false, panelPinned: false
  }, null, 2));
  const owner = new OwnerStore(ownerDb);
  try { seed(owner, root); } finally { owner.close(); }

  const probe = { shotsDir };
  const app = await startApp({ ownerDb, knowledgeDb, userData });
  const { panel } = app;
  try {
    await waitFor(panel, "document.querySelector('#modeBar button[data-mode=\"focus\"]')");
    await waitFor(panel, "window.OwnerFocusOps && window.OwnerPanelSelection");
    await panel.evaluate("document.querySelector('#modeBar button[data-mode=\"focus\"]').click()");
    await waitFor(panel, "!document.getElementById('modeA').hidden");
    // 等快照到齐（项目切换标签出现）再截图，否则截到的是还没取到数的空壳。
    const ready = await waitFor(panel, "document.querySelectorAll('#fdTabs .fd-tab').length >= 2");
    check('工作区顶部出现两个项目的切换标签', ready);

    // ---- 1) 工作区顶部：选项目只有这一处，添加项目挂在行尾 ----
    const structure = await panel.evaluate(`(() => {
      const modeA = document.getElementById('modeA');
      const settings = document.getElementById('settings');
      const work = document.getElementById('workZone');
      const ops = document.getElementById('opsZone');
      const bar = document.getElementById('workProjectBar');
      const add = document.getElementById('addProjectTop');
      const setup = document.getElementById('setup');
      return {
        legacyList: Boolean(document.getElementById('projectList')),
        legacySearch: Boolean(document.getElementById('projectSearch')),
        legacyZone: Boolean(document.querySelector('.general-zone')),
        barHasName: Boolean(document.getElementById('workProjectName')?.textContent?.trim()),
        tabs: [...document.querySelectorAll('#fdTabs .fd-tab')].map((tab) => tab.textContent.trim()),
        addInBar: Boolean(add && bar?.contains(add)),
        addVisible: add ? !add.hidden && add.getBoundingClientRect().height > 0 : false,
        addLabel: add?.textContent?.trim() ?? '',
        setupInSettings: Boolean(setup && settings?.contains(setup)),
        setupInModeA: Boolean(setup && modeA?.contains(setup)),
        answerInOps: Boolean(document.getElementById('answerSection') && ops?.contains(document.getElementById('answerSection'))),
        timelineInOps: Boolean(document.getElementById('timelineSection') && ops?.contains(document.getElementById('timelineSection'))),
        resultInOps: Boolean(document.getElementById('resultSection') && ops?.contains(document.getElementById('resultSection'))),
        answerInWork: Boolean(document.getElementById('answerSection') && work?.contains(document.getElementById('answerSection')))
      };
    })()`);
    probe.structure = structure;
    check('旧的项目列表/搜索框已删除', structure.legacyList === false && structure.legacySearch === false);
    check('旧的「通用管理」全局分区已删除', structure.legacyZone === false);
    check('工作区顶部写明项目名并给出切换标签', structure.barHasName
      && structure.tabs.length >= 2, structure.tabs.join(' / '));
    check('「添加项目」挂在切换行尾', structure.addInBar && structure.addVisible
      && structure.addLabel === '添加项目', structure.addLabel);
    check('设置向导在设置面板里、不在工作区', structure.setupInSettings === true && structure.setupInModeA === false);
    check('答案卡 / 会话 / 最近结果都在操作区',
      structure.answerInOps && structure.timelineInOps && structure.resultInOps && structure.answerInWork === false);

    // 没有任何操作结果的项目：下钻区整段不出现，不占位。
    await panel.evaluate(`(() => {
      const tab = document.querySelector('#fdTabs .fd-tab[data-project="gamma"]');
      tab?.click();
    })()`);
    const switched = await waitFor(panel,
      "document.querySelector('#fdTabs .fd-tab.on')?.dataset.project === 'gamma'");
    await sleep(2000);
    const emptyDrill = await panel.evaluate(
      "document.getElementById('opsDrill')?.hidden === true");
    probe.emptyProject = { switched, drillHidden: emptyDrill };
    check('没有任何结果时不占位（切到无记录的项目）', switched && emptyDrill === true);
    await panel.evaluate(`(() => {
      document.querySelector('#fdTabs .fd-tab[data-project="alpha"]')?.click();
    })()`);
    await waitFor(panel, "document.querySelector('#fdTabs .fd-tab.on')?.dataset.project === 'alpha'");
    await sleep(1200);

    await panel.evaluate("document.getElementById('workZone').scrollIntoView({ block: 'start' })");
    await sleep(400);
    await panel.evaluate("document.getElementById('toast').hidden = true");
    await sleep(300);
    await shot(panel, 'focus-work-top.png');

    // ---- 2) 交办一次：结果落在操作区下钻位置 ----
    step('选中交办目标并点发送');
    const picked = await panel.evaluate(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      document.getElementById('handoffTarget').click();
      await wait(300);
      const option = document.querySelector('#handoffTargetMenu .composer-project-option[data-project="alpha"]');
      option?.click();
      await wait(200);
      document.getElementById('taskInput').value = '回归：#73 结果应该落在操作区';
      document.getElementById('taskInput').dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('submitTask').click();
      return document.getElementById('handoffTarget').dataset.projectId ?? '';
    })()`);
    check('交办目标已显式选中 alpha', picked === 'alpha', picked);
    const answered = await waitFor(panel, "!document.getElementById('answerSection').hidden");
    check('操作产生结果：答案卡出现', answered);
    step('答案出现后读取下钻区');
    const drill = await panel.evaluate(`(() => {
      const ops = document.getElementById('opsZone');
      const drill = document.getElementById('opsDrill');
      const answer = document.getElementById('answerSection');
      return {
        drillHidden: drill.hidden,
        answerHidden: answer.hidden,
        answerInOps: ops.contains(answer),
        badge: document.getElementById('answerBadge')?.textContent ?? '',
        text: document.getElementById('answerCard')?.innerText?.trim() ?? ''
      };
    })()`);
    probe.drill = drill;
    check('结果出现在操作区的下钻位置', drill.answerInOps && drill.drillHidden === false);
    check('答案卡有内容', drill.text.length > 0, drill.badge);
    await panel.evaluate(`(() => {
      // 操作区区头是 sticky：把下钻区放到视口中段，区头和结果都看得见。
      document.getElementById('opsDrill').scrollIntoView({ block: 'center' });
    })()`);
    await sleep(500);
    // toast 会盖住操作区区头：截图前收掉，证据只看结构。
    await panel.evaluate("document.getElementById('toast').hidden = true");
    await sleep(300);
    await shot(panel, 'focus-ops-result.png');

    // ---- 3) 设置入口打开设置向导 ----
    step('打开设置面板');
    await panel.evaluate("document.getElementById('openSettings').click()");
    const settingsOpen = await waitFor(panel, "!document.getElementById('settings').hidden");
    check('设置入口打开设置面板', settingsOpen);
    const wizard = await panel.evaluate(`(() => {
      const setup = document.getElementById('setup');
      const add = document.getElementById('addProject');
      const rect = setup?.getBoundingClientRect();
      return {
        setupVisible: Boolean(setup && !setup.hidden && rect.width > 0 && rect.height > 0),
        title: setup?.querySelector('h3')?.textContent?.trim() ?? '',
        addVisible: Boolean(add && !add.hidden && add.getBoundingClientRect().height > 0),
        top: rect ? Math.round(rect.top) : null
      };
    })()`);
    probe.wizard = wizard;
    check('设置面板里能看到添加项目向导', wizard.setupVisible && wizard.addVisible, `${wizard.title} top=${wizard.top}`);
    await sleep(400);
    await shot(panel, 'focus-settings-wizard.png');

    // ---- 控制台 ----
    const errors = consoleErrors(panel);
    probe.consoleErrors = errors;
    check('控制台无报错', errors.length === 0, errors.join(' | ').slice(0, 400));
  } finally {
    await app.stop();
    fs.writeFileSync(path.join(shotsDir, 'focus-relocate-probe.json'), JSON.stringify(probe, null, 2));
    fs.writeFileSync(path.join(shotsDir, 'electron-log.txt'), app.log.join(''));
    if (process.env.KEEP_TMP !== '1') fs.rmSync(root, { recursive: true, force: true });
    else console.log(`[FOCUS-#73] tmp kept at ${root}`);
  }

  if (failures.length) {
    console.error(`[FOCUS-#73] ${failures.length} check(s) failed: ${failures.join(' | ')}`);
    process.exit(1);
  } else {
    console.log(`[FOCUS-#73] all checks passed; shots → ${shotsDir}`);
    process.exit(0);
  }
};

run().catch((error) => {
  console.error('[FOCUS-#73] fatal', error);
  process.exit(1);
});
