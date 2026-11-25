// #105 卡片壳的渲染层：只负责把 OwnerShellThread 的结果画出来。
// 纯逻辑（能不能发、发完流里有什么、哪条是占位回复）在 shell-thread.cjs，
// 这里不重复判定，也不碰 IPC、不持久化——本轮状态只在内存里，刷新即回到空态。
(() => {
  const api = window.OwnerShellThread;
  if (!api) throw new Error('shell-thread.cjs 未加载');

  const $ = (id) => document.getElementById(id);
  const messagesNode = $('messages');
  const emptyNode = $('emptyState');
  const threadNode = $('thread');
  const form = $('composer');
  const input = $('input');
  const sendButton = $('send');

  // 流就是这份数组；每次发送拿新数组回来（纯函数不改旧值），旧帧可以直接比对。
  let messages = api.createThread();

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  /** 一条消息：谁说的 + 气泡；占位回复额外挂一个常驻徽章。 */
  const renderMessage = (message) => {
    const item = el('li', `msg ${message.role === 'user' ? 'user' : 'agent'}`);
    item.dataset.role = message.role;
    if (message.role === 'agent' && api.isPlaceholder(message)) {
      item.classList.add('is-placeholder');
      item.dataset.placeholder = 'true';
    }
    const who = el('span', 'who', message.role === 'user' ? '我' : 'Companion');
    if (item.dataset.placeholder === 'true') who.append(el('span', 'badge', api.PLACEHOLDER_PREFIX));
    item.append(who, el('p', 'bubble', message.text));
    return item;
  };

  const render = () => {
    messagesNode.replaceChildren(...messages.map(renderMessage));
    emptyNode.hidden = messages.length > 0;
    // 新消息在底部：画完再滚，避免停在上一屏。
    threadNode.scrollTop = threadNode.scrollHeight;
  };

  /** 输入框高度跟着内容走，上限三行（CSS 里 max-height 兜底）。 */
  const resizeInput = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 84)}px`;
  };

  const syncSendButton = () => {
    sendButton.disabled = !api.canSend(input.value);
  };

  const send = () => {
    const next = api.sendTurn(messages, input.value);
    // 空输入时纯函数原样返回同一个数组：不重画、也不清空正在敲的字。
    if (next === messages) return;
    messages = next;
    input.value = api.draftAfterSend();
    resizeInput();
    syncSendButton();
    render();
    input.focus();
  };

  input.addEventListener('input', () => {
    resizeInput();
    syncSendButton();
  });

  input.addEventListener('keydown', (event) => {
    // 组字中的回车属于输入法，不能当发送。
    if (event.isComposing || event.keyCode === 229) return;
    // 回车发送；Shift+回车换行交给浏览器默认行为，所以只在「要发送」时 preventDefault。
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    send();
  });

  resizeInput();
  syncSendButton();
  render();
  input.focus();
})();
