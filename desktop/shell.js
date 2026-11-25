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
  const copyApi = window.OwnerShellCopy;
  if (!copyApi) throw new Error('shell-copy.cjs 未加载');

  const $ = (id) => document.getElementById(id);
  const messagesNode = $('messages');
  const emptyNode = $('emptyState');
  const threadNode = $('thread');
  const form = $('composer');
  const input = $('input');
  const sendButton = $('send');
  const toastNode = $('toast');
  const exportButton = $('exportConversation');
  const exportPathNode = $('exportPath');

  // 流就是这份数组；每次发送拿新数组回来（纯函数不改旧值），旧帧可以直接比对。
  let messages = api.createThread();

  // #110 会话身份：导出文件按会话 id 命名，时间取会话开始时间而不是「现在」。
  // 本轮壳还没有会话持久化（#106 那条线），所以把最小的身份写进 localStorage：
  // 同一台机器上重复打开仍是同一条会话，重复导出也落在同一个文件里。
  const SESSION_KEY = 'owner-shell-session';
  const loadSession = () => {
    try {
      const stored = JSON.parse(localStorage.getItem(SESSION_KEY) ?? '');
      if (stored && typeof stored.id === 'string' && stored.id) {
        return { id: stored.id, startedAt: String(stored.startedAt ?? '') };
      }
    } catch {
      // 存储里是坏值：当作没有，下一次写入会覆盖它。
    }
    const created = {
      id: globalThis.crypto?.randomUUID?.() ?? `session-${Date.now()}`,
      startedAt: new Date().toISOString()
    };
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(created));
    } catch {
      // 存储不可用也不影响复制；只是导出路径会随页面重载变化。
    }
    return created;
  };
  const session = loadSession();

  /** 导出/复制共用的上下文头；项目与模型这一轮还没有真来源，按实际状态写。 */
  const sessionContext = () => ({
    project: '全局（未选项目）',
    session: copyApi.sessionTitleOf(messages),
    time: session.startedAt,
    model: '未接入（占位回复）'
  });

  /** 可见回执：成功与失败都留 4 秒；不静默，也不弹窗打断。 */
  let toastTimer = null;
  const notify = (text, tone = 'ok') => {
    toastNode.textContent = text;
    toastNode.dataset.tone = tone;
    toastNode.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastNode.hidden = true;
      toastNode.textContent = '';
    }, 4000);
  };

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // 悬停态只记一个节点：最后被指到的那一个（块或消息）亮按钮，另一个立刻收起。
  // 用属性而不是 :hover 叠加，是因为块本身也在消息里面，纯 CSS 会同时亮两个。
  let copyActive = null;
  const setCopyActive = (node) => {
    if (copyActive === node) return;
    copyActive?.removeAttribute('data-copy-active');
    copyActive = node;
    copyActive?.setAttribute('data-copy-active', '1');
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
    // #110 悬停复制：每条消息一个，块另有自己的一个；同一时刻只亮一个（见下面 data-copy-active）。
    // 文案同样走 CSS 伪元素，消息的 who 文本保持「我 / Companion」。
    const copy = el('button', 'copy-affordance msg-copy');
    copy.type = 'button';
    copy.dataset.copyMessage = '1';
    copy.setAttribute('aria-label', '复制这条消息为 Markdown');
    who.append(copy);
    item.append(who);
    if (message.text) item.append(el('p', 'bubble', message.text));
    item.append(blocksView.renderReply(message));
    return item;
  };

  const render = () => {
    // 重画会换掉旧节点：悬停态跟着旧节点一起作废，避免按钮挂在不存在的块上。
    setCopyActive(null);
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

  /**
   * 剪贴板写入点：先用注入的 writer（e2e 与测试用），否则走主进程剪贴板，
   * 再退到 navigator.clipboard。三者都不可用就抛错，由调用方给可见提示。
   */
  const writeClipboard = async (text) => {
    const injected = window.OwnerShellClipboard;
    if (injected && typeof injected.write === 'function') {
      await injected.write(text);
      return;
    }
    if (window.companion && typeof window.companion.writeClipboard === 'function') {
      await window.companion.writeClipboard(text);
      return;
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return;
    }
    throw new Error('这个环境没有可用的剪贴板');
  };

  /**
   * 复制的唯一落点。按钮只声明「复制消息」或「复制块」，
   * Markdown 由 shell-copy 从「画这个节点用的同一份模型」里取，不重新读一遍 DOM。
   */
  const copyFromButton = async (button) => {
    const item = button.closest('.msg');
    const index = Number(item?.dataset.index);
    const message = messages[index];
    if (!message) return;
    const model = blocksApi.normalizeReply(message);
    let markdown = '';
    if (button.dataset.copyBlock !== undefined) {
      const blockIndex = Number(button.closest('[data-block]')?.dataset.blockIndex);
      markdown = copyApi.blockToMarkdown(model.blocks[blockIndex]);
    } else {
      markdown = copyApi.messageToMarkdown(message);
    }
    if (!markdown.trim()) {
      notify('这条内容没有可复制的 Markdown', 'error');
      return;
    }
    try {
      await writeClipboard(markdown);
      notify('已复制为 Markdown', 'ok');
    } catch (error) {
      // 失败必须看得见：不静默，也不假装复制成功。
      notify(`复制失败：${error?.message || '剪贴板不可用'}`, 'error');
    }
  };

  /** 导出当前会话：正文与上下文头都交给主进程落盘，路径回填到按钮旁边。 */
  const exportConversation = async () => {
    if (messages.length === 0) {
      notify('没有可导出的消息', 'error');
      return;
    }
    if (!window.companion?.conversation?.export) {
      notify('导出失败：主进程接口不可用', 'error');
      return;
    }
    try {
      const result = await window.companion.conversation.export({
        sessionId: session.id,
        context: sessionContext(),
        messages
      });
      exportPathNode.textContent = result.path;
      exportPathNode.hidden = false;
      notify(`已导出：${result.path}`, 'ok');
    } catch (error) {
      notify(`导出失败：${error?.message || '未知原因'}`, 'error');
    }
  };

  exportButton.addEventListener('click', () => { exportConversation(); });

  // 悬停时只亮最后指到的那一层：块在消息里面，块优先。
  messagesNode.addEventListener('mouseover', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const block = target.closest('[data-block]');
    if (block) {
      setCopyActive(block);
      return;
    }
    const item = target.closest('.msg');
    if (item) setCopyActive(item);
  });
  messagesNode.addEventListener('mouseleave', () => setCopyActive(null));

  messagesNode.addEventListener('click', (event) => {
    const copyButton = event.target.closest?.('[data-copy-message], [data-copy-block]');
    if (copyButton) {
      copyFromButton(copyButton);
      return;
    }
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
