// #105 卡片壳的渲染层：只负责把 OwnerShellThread 的结果画出来。
// #109 起回复可以带块：块自身的归一化与绘制在 shell-blocks.cjs / shell-blocks-view.js，
// 这里只决定「文字气泡画不画、块挂在哪、点块里的按钮算哪一轮」。
// 纯逻辑（能不能发、发完流里有什么、哪条是占位回复）在 shell-thread.cjs，
// 这里不重复判定，也不碰 IPC、不持久化——本轮状态只在内存里，刷新即回到空态。
(() => {
  const api = window.OwnerShellThread;
  if (!api) throw new Error('shell-thread.cjs 未加载');
  const blocksApi = window.OwnerShellBlocks;
  if (!blocksApi) throw new Error('shell-blocks.cjs 未加载');
  const blocksView = window.OwnerShellBlocksView;
  if (!blocksView) throw new Error('shell-blocks-view.js 未加载');

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

  /**
   * 一条消息：谁说的 + 文字气泡 + 块。
   * 气泡只在有文字时画（只有块的回复不该多一个空气泡）；
   * 块由 view 挂在同一个 li 里，所以块是长在对话流里的，不是另一个容器。
   */
  const renderMessage = (message, index) => {
    const item = el('li', `msg ${message.role === 'user' ? 'user' : 'agent'}`);
    item.dataset.role = message.role;
    // 块内按钮的点击要能找回「哪条消息的哪个提问块」，序号跟着消息走。
    item.dataset.index = String(index);
    if (message.role === 'agent' && api.isPlaceholder(message)) {
      item.classList.add('is-placeholder');
      item.dataset.placeholder = 'true';
    }
    const who = el('span', 'who', message.role === 'user' ? '我' : 'Companion');
    if (item.dataset.placeholder === 'true') who.append(el('span', 'badge', api.PLACEHOLDER_PREFIX));
    item.append(who);
    if (message.text) item.append(el('p', 'bubble', message.text));
    item.append(blocksView.renderReply(message));
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
    const raw = input.value;
    if (!api.canSend(raw)) return;
    // 块全览是临时入口（真模型接入时与 sampleReply 一起删）：
    // 它只是在占位回复的位置放一条带十二种块的脚本化回复。
    const next = blocksApi.isSampleCommand(raw)
      ? api.addReply(api.addUserMessage(messages, raw), blocksApi.sampleReply())
      : api.sendTurn(messages, raw);
    if (next === messages) return;
    messages = next;
    input.value = api.draftAfterSend();
    resizeInput();
    syncSendButton();
    render();
    input.focus();
  };

  /**
   * 提问块按钮的唯一落点。按钮只声明「选了什么」（data-ask-*），
   * 这里用纯函数算出下一轮，再按普通消息追加：提问块不在块里执行动作。
   */
  const answerAsk = (button) => {
    const askNode = button.closest('[data-block="ask"]');
    const item = button.closest('.msg');
    if (!askNode || !item) return;
    const question = askNode.dataset.askQuestion ?? '';
    const blockIndex = Number(askNode.dataset.blockIndex ?? -1);
    const messageIndex = Number(item.dataset.index);
    // 同一个提问块只回答一次：旧节点若被重复点到，不再追加第二轮。
    if (messages[messageIndex]?.answers?.[blockIndex] !== undefined) return;
    let action = null;
    if (button.dataset.askChoice !== undefined) {
      action = blocksApi.askAction({ question, kind: 'option', value: button.dataset.askChoice });
    } else if (button.dataset.askSkip !== undefined) {
      action = blocksApi.askAction({ question, kind: 'skip' });
    } else if (button.dataset.askFreeSubmit !== undefined) {
      const field = askNode.querySelector('[data-ask-free]');
      action = blocksApi.askAction({ question, kind: 'free', value: field?.value ?? '' });
    }
    // 自由回答为空：不改流，也不假装收到。
    if (!action) return;
    messages = api.answerBlock(messages, messageIndex, blockIndex, action.answeredLabel);
    messages = api.addReply(api.addUserMessage(messages, action.userText), action.reply);
    render();
    input.focus();
  };

  messagesNode.addEventListener('click', (event) => {
    const button = event.target.closest?.(
      '[data-ask-choice], [data-ask-skip], [data-ask-free-submit]'
    );
    if (button) answerAsk(button);
  });

  // 自由回答框里的回车等同点「回答」；输入法组字中的回车照样交给输入法。
  messagesNode.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    const field = event.target.closest?.('[data-ask-free]');
    if (!field) return;
    event.preventDefault();
    const submit = field.closest('[data-block="ask"]')?.querySelector('[data-ask-free-submit]');
    if (submit) answerAsk(submit);
  });

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
