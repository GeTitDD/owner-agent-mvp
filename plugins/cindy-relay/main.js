// Relay 的电子脑：订阅对话钩子、保存消息流水、给出转交卡。
//
// 真正发送由页面（relay.js）通过 cindy.targets 完成：Agent 和本文件都没有发送入口，
// 保证「人看过、点过才发」。
const CHANNEL = 'cindy-relay';
const channel = new BroadcastChannel(CHANNEL);
const NODE_TIMEOUT_MS = 20000;

const forward = async (method, params = {}) => {
  const response = await cindy.node.request({ method, params, timeoutMs: NODE_TIMEOUT_MS });
  if (!response || response.ok === false) {
    throw new Error(String(response?.message ?? '本地服务没有响应'));
  }
  return response.result;
};

// 页面 → worker 的转发（页面没有 Node 能力，只能走这里）。
// `cindy/` 开头的方法由电子脑直接调宿主能力（targets / tasks）。
const cindyMethods = {
  async 'cindy/targets/list'(params) {
    if (!cindy.targets?.list) throw new Error('当前 Cindy 版本不支持 targets');
    return cindy.targets.list({ targetKind: String(params?.targetKind || 'project') });
  },
  async 'cindy/targets/send'(params) {
    if (!cindy.targets?.send) throw new Error('当前 Cindy 版本不支持 targets');
    return cindy.targets.send({
      target: params?.target,
      requestKey: String(params?.requestKey || ''),
      text: String(params?.text || ''),
      context: String(params?.context || ''),
      ...(params?.title ? { title: String(params.title) } : {}),
      ...(params?.route ? { route: params.route } : {}),
      ...(params?.permissionMode ? { permissionMode: params.permissionMode } : {})
    });
  },
  async 'cindy/tasks/models'() {
    if (!cindy.tasks?.models) return { models: [] };
    return cindy.tasks.models();
  },
  async 'cindy/tasks/create'(params) {
    if (!cindy.tasks?.create) throw new Error('当前 Cindy 版本不支持创建任务');
    return cindy.tasks.create({
      requestKey: String(params?.requestKey || ''),
      title: String(params?.title || '转交任务'),
      ...(params?.route ? { route: params.route } : {}),
      ...(params?.permissionMode ? { permissionMode: params.permissionMode } : {})
    });
  },
  async 'cindy/tasks/send'(params) {
    if (!cindy.tasks?.send) throw new Error('当前 Cindy 版本不支持任务投递');
    return cindy.tasks.send({
      taskId: String(params?.taskId || ''),
      requestKey: String(params?.requestKey || ''),
      text: String(params?.text || ''),
      context: String(params?.context || ''),
      ...(Number.isFinite(params?.expectedRevision) ? { expectedRevision: params.expectedRevision } : {})
    });
  },
  async 'cindy/tasks/get'(params) {
    if (!cindy.tasks?.get) throw new Error('当前 Cindy 版本不支持读取任务');
    return cindy.tasks.get({ taskId: String(params?.taskId || '') });
  }
};

channel.onmessage = async (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'req' || !msg.reqId) return;
  try {
    const local = msg.method?.startsWith('cindy/') ? cindyMethods[msg.method] : null;
    const result = local ? await local(msg.params ?? {}) : await forward(msg.method, msg.params ?? {});
    channel.postMessage({ type: 'res', reqId: msg.reqId, ok: true, result });
  } catch (error) {
    channel.postMessage({ type: 'res', reqId: msg.reqId, ok: false, error: String(error?.message ?? error) });
  }
};

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

const clip = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const CARD_TEXT = 'var(--text-primary, #1a1a1a)';
const CARD_MUTED = 'var(--text-secondary, #6b6b6b)';
const CARD_BORDER = 'var(--border-default, #e4e4e0)';
const CARD_SURFACE = 'var(--surface, #f7f7f5)';

const cardStamp = new Map();
const sendCard = async (payload) => {
  const last = cardStamp.get(payload.callId) ?? 0;
  const gap = Date.now() - last;
  if (gap < 1100) await new Promise((resolve) => setTimeout(resolve, 1100 - gap));
  cardStamp.set(payload.callId, Date.now());
  cindy.send(payload);
};

const button = (action, label, primary = false) => `<button data-ghost-action="${esc(action)}"`
  + `${primary ? ' data-ghost-primary' : ''}`
  + ` style="display:inline-flex;align-items:center;padding:6px 12px;border-radius:8px;`
  + `border:1px solid ${CARD_BORDER};background:${primary ? CARD_SURFACE : 'transparent'};`
  + `color:${CARD_TEXT};font:${primary ? 600 : 500} 12.5px/1.2 inherit;cursor:pointer">${esc(label)}</button>`;

const relayCard = ({ sessionId, pending = 0, pendingChars = 0, lastRelayAt = '', note = '', message = '' }) => {
  const last = lastRelayAt ? new Date(lastRelayAt) : null;
  const lastText = last && !Number.isNaN(last.getTime())
    ? `${last.getMonth() + 1} 月 ${last.getDate()} 日 ${String(last.getHours()).padStart(2, '0')}:${String(last.getMinutes()).padStart(2, '0')}`
    : '';
  const body = pending > 0
    ? `自上次转交以来 <b>${pending}</b> 条 · 约 ${pendingChars} 字`
    : '还没有新的对话需要转交。';
  const lastLine = lastText ? `<div style="font-size:12px;color:${CARD_MUTED};margin-top:2px">上次转交：${esc(lastText)}</div>` : '';
  const noteLine = note ? `<div style="margin-top:8px;font-size:12.5px">备注：${esc(clip(note, 120))}</div>` : '';
  const messageLine = message ? `<div style="margin-top:8px;font-size:12px;color:${CARD_MUTED}">${esc(message)}</div>` : '';
  const action = sessionId
    ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">${button(`open:relay:${sessionId}`, '打开 Relay 页签', true)}</div>`
    : '';
  const html = `<div data-ghost-width="full" style="padding:14px 16px;color:${CARD_TEXT};font-size:13px;line-height:1.6">`
    + `<div style="font-size:15px;font-weight:600">转交当前任务</div>`
    + `<div style="margin-top:6px">${body}</div>`
    + lastLine + noteLine + messageLine + action
    + '</div>';
  const height = 92 + (lastLine ? 20 : 0) + (noteLine ? 24 : 0) + (messageLine ? 24 : 0) + (action ? 40 : 0);
  return { html, height: Math.min(420, Math.max(150, height)) };
};

const sessionOf = (args) => String(args?.session_context?.session_id ?? args?.sessionId ?? '');

// `$relay` 这一轮只是打开页签，不该出现在下一次转交的引用里。
const relayCommandSessions = new Set();

const appendMessage = (sessionId, role, text, model, messageId) => forward('relay/messages/append', {
  sessionId,
  role,
  text: String(text ?? ''),
  model: String(model ?? ''),
  messageId: String(messageId ?? '')
});

const tools = {
  async relay_status(args) {
    const sessionId = sessionOf(args);
    if (!sessionId) return { ok: false, reason: '当前任务没有会话 id' };
    const state = await forward('relay/sessions/state', { sessionId });
    return {
      ok: true,
      sessionId,
      pending: state.pending?.length ?? 0,
      pendingChars: state.pendingChars ?? 0,
      lastRelayAt: state.lastRelayAt ?? '',
      label: state.label ?? ''
    };
  },

  async relay_open(args) {
    const sessionId = sessionOf(args);
    if (!sessionId) return { ok: false, reason: '当前任务没有会话 id' };
    const state = await forward('relay/sessions/state', { sessionId });
    const note = String(args?.note ?? '');
    return {
      ok: true,
      sessionId,
      pending: state.pending?.length ?? 0,
      pendingChars: state.pendingChars ?? 0,
      lastRelayAt: state.lastRelayAt ?? '',
      note,
      hint: state.pending?.length ? '点卡片按钮打开 Relay 页签，选目标并确认发送。' : '还没有待转交内容。'
    };
  },

  async relay_history(args) {
    const result = await forward('relay/relays/list', { limit: Number(args?.limit) || 10 });
    return {
      relays: result.relays.map((relay) => ({
        at: relay.createdAt,
        from: relay.sessionLabel,
        target: relay.target?.label ?? '',
        chars: relay.chars,
        taskId: relay.taskId
      }))
    };
  }
};

const openRelayTab = async (message, sessionId) => {
  let opened = { ok: false };
  try {
    opened = await cindy.taskView({ sessionId });
    if (!opened?.ok) opened = await cindy.taskView({ sessionId, focus: true });
  } catch {
    opened = { ok: false };
  }
  if (opened?.ok) return true;
  const card = relayCard({
    sessionId,
    message: '没能自动打开页签，点左侧导航的 Relay 即可。'
  });
  await sendCard({ type: 'card-update', callId: message.callId, v: 2, state: 'done', html: card.html, height: card.height });
  return false;
};

cindy.onHostMessage(async (message) => {
  // 入口钩子：3 秒内必须裁决，先放行再做后台记录。
  if (message?.type === 'event' && message.name === 'will-user-message') {
    cindy.send({ type: 'event-verdict', hookId: message.hookId, action: 'allow' });
    const data = message.data ?? {};
    const text = String(data.text ?? '');
    if (data.sessionId && /^\s*\$(relay|接力)\b/u.test(text)) {
      // 命令本身和它引出的那条回复都不入库。
      relayCommandSessions.add(String(data.sessionId));
      return;
    }
    if (data.sessionId && data.text) {
      void appendMessage(data.sessionId, 'user', data.text, data.model, data.messageId).catch(() => {});
    }
    return;
  }

  // 出口钩子：拿到 AI 全文，落库后再放行（窗口 5 分钟，写本地很快）。
  if (message?.type === 'event' && message.name === 'will-assistant-message') {
    const data = message.data ?? {};
    const sessionId = String(data.sessionId ?? '');
    if (sessionId && relayCommandSessions.has(sessionId)) {
      relayCommandSessions.delete(sessionId);
      cindy.send({ type: 'event-verdict', hookId: message.hookId, action: 'allow' });
      return;
    }
    try {
      if (data.sessionId && data.text) {
        await appendMessage(data.sessionId, 'assistant', data.text, data.model, message.messageId);
      }
    } catch {
      // 记录失败也必须放行，不能丢 AI 回复。
    }
    cindy.send({ type: 'event-verdict', hookId: message.hookId, action: 'allow' });
    return;
  }

  if (message?.type === 'event' && message.name === 'card-action') {
    const actionId = String(message.actionId ?? '');
    if (actionId.startsWith('open:relay:')) {
      await openRelayTab(message, actionId.slice('open:relay:'.length));
    }
    return;
  }

  if (message?.type !== 'tool-call') return;
  const handler = tools[message.tool];
  if (!handler) {
    cindy.send({ type: 'tool-result', callId: message.callId, ok: false, message: `未知工具：${message.tool}` });
    return;
  }
  const withCard = message.tool === 'relay_open';
  if (withCard) {
    await sendCard({
      type: 'card-update',
      callId: message.callId,
      state: 'working',
      html: `<div style="padding:14px 16px;color:${CARD_MUTED};font-size:13px">正在整理待转交内容…</div>`,
      height: 80
    });
  }
  try {
    const result = await handler(message.args ?? {});
    if (withCard && result.ok) {
      const card = relayCard(result);
      await sendCard({ type: 'card-update', callId: message.callId, v: 2, state: 'done', html: card.html, height: card.height });
    }
    cindy.send({ type: 'tool-result', callId: message.callId, ok: true, result });
  } catch (error) {
    cindy.send({ type: 'tool-result', callId: message.callId, ok: false, message: String(error?.message ?? error) });
  }
});
