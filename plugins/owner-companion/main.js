// Owner Companion 的电子脑：只做页面 ↔ Node worker 的转发。
//
// 页面没有直连网络；所有数据请求都经 cindy.node.request 交给 node/worker.cjs，
// 由它在 Node 里访问本机 mobile bridge（默认 http://127.0.0.1:47831）。
const CHANNEL = 'owner-companion';
const channel = new BroadcastChannel(CHANNEL);

// 单次 Node RPC 上限 20 秒，聊天要拆成 start + poll。
const NODE_TIMEOUT_MS = 20000;
const CHAT_DEADLINE_MS = 210000;
const CHAT_POLL_MS = 2500;

const forward = async (method, params = {}) => {
  const response = await cindy.node.request({
    method,
    params,
    timeoutMs: NODE_TIMEOUT_MS
  });
  if (!response || response.ok === false) {
    throw new Error(String(response?.message ?? '本地服务没有响应'));
  }
  return response.result;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chat = async (params) => {
  const started = await forward('owner/chat/start', params);
  const jobId = started?.jobId;
  if (!jobId) throw new Error('分析没有启动');
  const deadline = Date.now() + CHAT_DEADLINE_MS;
  while (Date.now() < deadline) {
    await sleep(CHAT_POLL_MS);
    const state = await forward('owner/chat/poll', { jobId });
    if (state?.status === 'done') return state.result;
    if (state?.status === 'error') throw new Error(String(state.error || '分析失败'));
  }
  throw new Error('分析超时，请重试');
};

channel.onmessage = async (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'req' || !msg.reqId) return;
  try {
    const result = msg.method === 'owner/chat'
      ? await chat(msg.params ?? {})
      : await forward(msg.method, msg.params ?? {});
    channel.postMessage({ type: 'res', reqId: msg.reqId, ok: true, result });
  } catch (error) {
    channel.postMessage({
      type: 'res',
      reqId: msg.reqId,
      ok: false,
      error: String(error?.message ?? error)
    });
  }
};

// 页面用 fetch('/wake') 唤醒电子脑；唤醒后广播即可收到回执。
cindy.onHostMessage(() => {});
