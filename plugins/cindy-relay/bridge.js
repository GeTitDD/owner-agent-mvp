(() => {
  const CHANNEL = 'cindy-relay';
  const channel = new BroadcastChannel(CHANNEL);
  const pending = new Map();
  let seq = 0;

  channel.onmessage = (event) => {
    const message = event.data;
    if (!message || message.type !== 'res') return;
    const entry = pending.get(message.reqId);
    if (!entry) return;
    pending.delete(message.reqId);
    clearTimeout(entry.timer);
    clearInterval(entry.retry);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(String(message.error || '请求失败')));
  };

  const wake = async () => {
    try {
      await fetch('cindy-ghost://relay-handoff/wake');
    } catch {
      try { await fetch('/wake'); } catch { /* 已醒或宿主不支持 */ }
    }
  };

  const call = (method, params = {}, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const reqId = `${Date.now()}-${++seq}`;
    const send = () => channel.postMessage({ type: 'req', reqId, method, params });
    const timer = setTimeout(() => {
      pending.delete(reqId);
      clearInterval(retry);
      reject(new Error('本地服务没有响应，请重试'));
    }, timeoutMs);
    const retry = setInterval(() => {
      if (!pending.has(reqId)) { clearInterval(retry); return; }
      send();
    }, 400);
    pending.set(reqId, { resolve, reject, timer, retry });
    void wake().then(send, send);
  });

  window.RelayBridge = { call };
})();
