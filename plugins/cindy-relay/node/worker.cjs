// Relay 插件的 Node 工作进程：JSON-RPC stdio。
//
// 只处理本地消息流水与转交记录；发消息给其他任务由页面通过 cindy.targets 完成，
// 这里不接触 Cindy 的会话或网络。
const path = require('node:path');
const readline = require('node:readline');
const { pathToFileURL } = require('node:url');

const PKG_VERSION = '0.1.5';

const libUrl = (name) => pathToFileURL(path.join(__dirname, 'lib', name)).href;
let store = null;
let storeModule = null;

const getStore = async () => {
  if (store) return store;
  storeModule ??= import(libUrl('store.mjs'));
  const libs = await storeModule;
  store = libs.openStore();
  return store;
};

const methods = {
  async 'relay/status'() {
    const data = await getStore();
    return { ok: true, version: PKG_VERSION, ...data.stats() };
  },

  async 'relay/messages/append'(params) {
    const data = await getStore();
    return data.appendMessage({
      sessionId: String(params?.sessionId || ''),
      role: String(params?.role || 'user'),
      text: String(params?.text || ''),
      model: String(params?.model || ''),
      messageId: String(params?.messageId || '')
    });
  },

  async 'relay/sessions/state'(params) {
    const data = await getStore();
    return data.getSessionState(String(params?.sessionId || ''));
  },

  /** 「全部记录」用：返回该任务保留的所有消息。 */
  async 'relay/sessions/all'(params) {
    const data = await getStore();
    const state = data.getSessionState(String(params?.sessionId || ''));
    return { sessionId: state.sessionId, messages: data.listMessages(String(params?.sessionId || '')) };
  },

  async 'relay/sessions/list'() {
    const data = await getStore();
    return { sessions: data.listSessions() };
  },

  async 'relay/sessions/clear'(params) {
    const data = await getStore();
    return data.clearSession(String(params?.sessionId || ''));
  },

  async 'relay/relays/mark'(params) {
    const data = await getStore();
    return data.markRelayed({
      sessionId: String(params?.sessionId || ''),
      target: params?.target ?? null,
      note: String(params?.note || ''),
      chars: Number(params?.chars) || 0,
      taskId: String(params?.taskId || ''),
      requestKey: String(params?.requestKey || '')
    });
  },

  async 'relay/relays/list'(params) {
    const data = await getStore();
    return { relays: data.listRelays(Number(params?.limit) || 20) };
  },

  async 'relay/prefs/get'() {
    const data = await getStore();
    return { prefs: data.getPrefs() };
  },

  async 'relay/prefs/set'(params) {
    const data = await getStore();
    return { prefs: data.setPrefs(params?.patch && typeof params.patch === 'object' ? params.patch : {}) };
  }
};

const reply = (id, payload) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...payload })}\n`);
};

const handle = async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const id = message?.id;
  const method = message?.method;
  if (!id || typeof method !== 'string') return;
  const handler = methods[method];
  if (!handler) {
    reply(id, { error: { code: -32601, message: `未知方法：${method}` } });
    return;
  }
  try {
    const result = await handler(message.params ?? {});
    reply(id, { result });
  } catch (error) {
    reply(id, {
      error: { code: -32000, message: String(error?.message ?? error) }
    });
  }
};

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => { void handle(line.trim()); });
