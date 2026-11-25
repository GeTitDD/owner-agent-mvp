// 三个新验收脚本（#72 / #73 / #71）共用的 CDP 客户端与 Electron 启动器。
//
// 为什么单独抽出来：这三个脚本原本各自抄了一份 freePort / connectCdp / findPanelTarget /
// startApp / check，约 60 行 × 3。同一份协议在三个文件里各写一遍，改超时或改选择器时
// 很容易只改一处。这里只保留一份，脚本只描述「验什么」。
//
// 只用 Node 自带的 WebSocket 与 child_process，不新增依赖、不联网。
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const electronPath = createRequire(path.join(repoRoot, 'package.json'))('electron');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 取一个空闲端口：Electron 的 --remote-debugging-port 不能固定写死。 */
export const freePort = async () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

/** 极简 CDP 客户端：只用 Node 自带的 WebSocket。 */
export const connectCdp = async (url) => {
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

/** 在 CDP 的 /json/list 里等 panel.html 的调试地址。 */
export const findPanelTarget = async (port) => {
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

/** 轮询一个页面内表达式，直到为真或超时。 */
export const waitFor = async (panel, expression, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await panel.evaluate(`Boolean(${expression})`)) return true;
    } catch {
      // 页面重载时 evaluate 会短暂失败：继续等，不把整次验收判死。
    }
    await sleep(250);
  }
  return false;
};

/**
 * 启动一个离屏 Electron（临时 userData + 临时库），返回已连上 CDP 的 panel。
 * @param {object} options
 * @param {string} options.userData 临时 userData 目录
 * @param {string} options.ownerDb 临时 owner 库
 * @param {string} options.knowledgeDb 临时知识库
 * @param {Record<string,string>} [options.env] 额外环境变量（如 OWNER_TRIAGE_TIMEOUT_MS）
 * @param {boolean} [options.showPanel] 启动后是否调用 companion.showPanel()
 */
export const startApp = async ({ userData, ownerDb, knowledgeDb, env = {}, showPanel = false }) => {
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
      ...env
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
  if (showPanel) await panel.evaluate('window.companion.showPanel()');
  return {
    panel,
    log,
    stop: async () => {
      try { panel.close(); } catch { /* ignore */ }
      try { child.kill(); } catch { /* ignore */ }
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(10000)
      ]);
      // 10 秒还没退：补一刀，避免残留 Electron 进程占着 userData。
      if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
    }
  };
};

/** 一个带前缀的断言器：三个脚本的 check 只差日志前缀。 */
export const createChecker = (prefix) => {
  const failures = [];
  const check = (label, condition, detail = '') => {
    if (condition) console.log(`${prefix} OK   ${label}${detail ? ` (${detail})` : ''}`);
    else {
      failures.push(label);
      console.error(`${prefix} FAIL ${label}${detail ? ` (${detail})` : ''}`);
    }
  };
  return { check, failures };
};

/** 只收集「错误或异常」，用来给验收报告里「控制台是否干净」下结论。 */
export const consoleErrors = (panel) => panel.events
  .filter((event) => event.method === 'Runtime.exceptionThrown'
    || (event.method === 'Runtime.consoleAPICalled' && event.params?.type === 'error')
    || (event.method === 'Log.entryAdded' && event.params?.entry?.level === 'error'))
  .map((event) => event.method === 'Log.entryAdded'
    ? String(event.params.entry.text)
    : String(event.params?.exceptionDetails?.text
      ?? event.params?.args?.map((arg) => arg.value ?? arg.description).join(' ')));

/** 截图：调用方给完整文件路径。 */
export const capture = async (panel, filePath) => {
  const result = await panel.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(filePath, Buffer.from(result.data, 'base64'));
};
