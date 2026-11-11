// Owner Companion 的电子脑：只做页面 ↔ Node worker 的转发。
//
// 页面没有直连网络；所有数据请求都经 cindy.node.request 交给 node/worker.cjs，
// 由它在 Node 里访问本机 mobile bridge（默认 http://127.0.0.1:47831）。
const CHANNEL = 'owner-companion';
const channel = new BroadcastChannel(CHANNEL);

const timeoutFor = (method) => (method === 'owner/chat' ? 210000 : 30000);

const forward = async (msg) => {
  const response = await cindy.node.request({
    method: msg.method,
    params: msg.params ?? {},
    timeoutMs: timeoutFor(msg.method)
  });
  if (!response || response.ok === false) {
    throw new Error(String(response?.message ?? '本地服务没有响应'));
  }
  return response.result;
};

channel.onmessage = async (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'req' || !msg.reqId) return;
  try {
    const result = await forward(msg);
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
