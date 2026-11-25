// #121 卡片壳的对话流：消息渲染、块挂载、悬停复制、提问 / 确认卡动作、导出。
//
// 边界：这一块只管对话流本身（#messages 里的消息与块、悬停亮按钮、滚动），
// 复制与导出也从这里出去（Markdown 由 shell-copy.cjs 从同一份模型算）。
// 顶栏与输入区分别在 shell-header.cjs / shell-compose.cjs；这里不读输入框、不画顶栏。
// 双份导出：浏览器当普通脚本加载（挂到 window.OwnerShellStream），Node 测试用 require 读纯函数。
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerShellStream = api;
})(typeof globalThis === 'undefined' ? null : globalThis, () => {
  /**
   * 对话流的空态：一条会话都没有（不许发消息）与当前会话还没消息是两句话。
   * 纯状态迁移：只看「当前会话 id + 条数」，不读 DOM。
   */
  const emptyHint = ({ currentId, count, noSessionHint }) => {
    if (!currentId) return noSessionHint;
    return count ? '' : '这个会话还没有消息，发第一句开始。';
  };

  /**
   * 导出上下文头（#110）：项目、会话、时间、模型。
   * 纯函数：会话标题由调用方传入，测试不必读库。
   */
  const sessionContext = (session, title) => {
    const projectId = String(session?.projectId ?? '').trim();
    return {
      project: projectId || '全局（未选项目）',
      session: title,
      time: String(session?.createdAt ?? ''),
      model: '未接入（占位回复）'
    };
  };

  /** 建立对话流这一块：查 DOM、绑事件，返回给装配层用的入口。 */
  const create = (ctx) => {
    const threadApi = ctx.threadApi;
    const listApi = ctx.listApi;
    const blocksApi = ctx.blocksApi;
    const blocksView = ctx.blocksView;
    const riskApi = ctx.riskApi;
    const copyApi = ctx.copyApi;
    const store = ctx.store;
    const notify = ctx.notify;

    const $ = (id) => document.getElementById(id);
    const messagesNode = $('messages');
    const emptyNode = $('emptyState');
    const threadNode = $('thread');
    const exportButton = $('exportConversation');
    const exportPathNode = $('exportPath');

    let messages = [];
    // 悬停态只记一个节点：最后被指到的那一个（块或消息）亮按钮，另一个立刻收起。
    // 用属性而不是 :hover 叠加，是因为块本身也在消息里面，纯 CSS 会同时亮两个。
    let copyActive = null;

    /** 当前会话由顶栏持有：对话流只读，不另存一份。 */
    const currentId = () => ctx.ui.header.currentId();

    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    const setCopyActive = (node) => {
      if (copyActive === node) return;
      copyActive?.removeAttribute('data-copy-active');
      copyActive = node;
      copyActive?.setAttribute('data-copy-active', '1');
    };

    // ── 对话流 ────────────────────────────────────────────────────────

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
      if (message.role === 'agent' && threadApi.isPlaceholder(message)) {
        item.classList.add('is-placeholder');
        item.dataset.placeholder = 'true';
      }
      const who = el('span', 'who', message.role === 'user' ? '我' : 'Companion');
      if (item.dataset.placeholder === 'true') who.append(el('span', 'badge', threadApi.PLACEHOLDER_PREFIX));
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

    const renderThread = () => {
      // 重画会换掉旧节点：悬停态跟着旧节点一起作废，避免按钮挂在不存在的块上。
      setCopyActive(null);
      messagesNode.replaceChildren(...messages.map(renderMessage));
      // 空态分两种：一条会话都没有（不许发消息）与当前会话还没有消息。
      const hint = emptyHint({
        currentId: currentId(),
        count: messages.length,
        noSessionHint: listApi.EMPTY_SESSION_HINT
      });
      emptyNode.textContent = hint;
      emptyNode.hidden = !hint;
      // 新消息在底部：画完再滚，避免停在上一屏。
      threadNode.scrollTop = threadNode.scrollHeight;
    };

    /** 读当前会话的消息。切会话与刷新都只走这一条。 */
    const load = async () => {
      const id = currentId();
      if (!id) {
        messages = [];
        return;
      }
      const detail = await store.get({ id });
      messages = threadApi.fromStored(detail?.messages);
    };

    /** 回到流的顶部：进全局模式时用，别停在最后一条消息上。 */
    const resetScroll = () => {
      threadNode.scrollTop = 0;
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

    /**
     * 导出当前会话：正文与上下文头都交给主进程落盘，路径回填到按钮旁边。
     * 会话 id 用 #106 的持久化记录；没有会话就没有可导出的对话流。
     */
    const exportConversation = async () => {
      const id = currentId();
      if (!id) {
        notify('没有可导出的会话，先在顶栏新建一个', 'error');
        return;
      }
      if (messages.length === 0) {
        notify('这个会话还没有消息', 'error');
        return;
      }
      if (!window.companion?.conversation?.export) {
        notify('导出失败：主进程接口不可用', 'error');
        return;
      }
      try {
        const current = ctx.ui.header.currentSession();
        const result = await window.companion.conversation.export({
          sessionId: id,
          context: sessionContext(current, current ? listApi.titleOf(current) : ''),
          messages
        });
        exportPathNode.textContent = result.path;
        exportPathNode.hidden = false;
        notify(`已导出：${result.path}`, 'ok');
      } catch (error) {
        notify(`导出失败：${error?.message || '未知原因'}`, 'error');
      }
    };

    /**
     * 提问块按钮的唯一落点。按钮只声明「选了什么」（data-ask-*），
     * 这里用纯函数算出下一轮，再按两条普通消息落库：提问块不在块里执行动作。
     */
    const answerAsk = (button) => ctx.report('回答', async () => {
      if (!listApi.canCompose(currentId())) return;
      const askNode = button.closest('[data-block="ask"]');
      const item = button.closest('.msg');
      if (!askNode || !item) return;
      const question = askNode.dataset.askQuestion ?? '';
      const blockIndex = Number(askNode.dataset.blockIndex ?? -1);
      const messageIndex = Number(item.dataset.index);
      const target = messages[messageIndex];
      // 同一个提问块只回答一次：旧节点若被重复点到，不再追加第二轮。
      if (!target || target.answers?.[blockIndex] !== undefined) return;
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
      // 先记「这一块已经答过」，重画之后按钮不会再冒出来；再追加我问的一句与一条回复。
      const answered = threadApi.answerBlock(messages, messageIndex, blockIndex, action.answeredLabel);
      const answers = answered[messageIndex]?.answers ?? {};
      if (Number.isInteger(target.seq)) {
        await store.answers({ id: currentId(), seq: target.seq, answers });
      }
      await store.append({ id: currentId(), role: 'user', text: action.userText });
      await store.append({
        id: currentId(),
        role: 'assistant',
        text: action.reply?.text ?? '',
        blocks: Array.isArray(action.reply?.blocks) ? action.reply.blocks : []
      });
      await ctx.refreshThread();
      ctx.ui.compose.focus();
    });

    /**
     * 确认卡动作（#113）：四个动作都落到纯函数 riskAction，再按「我的 + 回复」两条消息落库。
     * 改判不覆盖原判据：新卡由 riskAction 生成，原卡只记一个 answers 标记。
     */
    const actRisk = (button) => ctx.report('确认卡', async () => {
      if (!listApi.canCompose(currentId())) return;
      const cardNode = button.closest('[data-block="risk"]');
      const item = button.closest('.msg');
      if (!cardNode || !item) return;
      const blockIndex = Number(cardNode.dataset.blockIndex ?? -1);
      const messageIndex = Number(item.dataset.index);
      const target = messages[messageIndex];
      const card = target?.blocks?.[blockIndex];
      if (!target || !card) return;
      // 同一个确认卡只选一次：旧节点若被重复点到，不再追加第二轮。
      if (target.answers?.[blockIndex] !== undefined) return;

      // 「我的判断不同」先展开表单，不改会话。
      if (button.dataset.riskAction === 'override') {
        const form = cardNode.querySelector('[data-risk-override-form]');
        if (!form) return;
        form.hidden = !form.hidden;
        if (!form.hidden) form.querySelector('[data-risk-override-level]')?.focus();
        return;
      }

      let action = null;
      if (button.dataset.riskOverrideSubmit !== undefined) {
        const form = button.closest('[data-risk-override-form]');
        const level = form?.querySelector('[data-risk-override-level]')?.value ?? '';
        const note = form?.querySelector('[data-risk-override-note]')?.value ?? '';
        action = riskApi.riskAction({ card, action: 'override', level, note });
      } else if (button.dataset.riskAction) {
        action = riskApi.riskAction({ card, action: button.dataset.riskAction });
      }
      // 非低风险点「低风险免问」、或未知动作：不改流，也不假装收到。
      if (!action) return;

      // 先记「这一张已经选过」，重画之后按钮不会再冒出来；再追加我问的一句与一条回复。
      const answered = threadApi.answerBlock(messages, messageIndex, blockIndex, action.answeredLabel);
      const answers = answered[messageIndex]?.answers ?? {};
      if (Number.isInteger(target.seq)) {
        await store.answers({ id: currentId(), seq: target.seq, answers });
      }
      await store.append({ id: currentId(), role: 'user', text: action.userText });
      await store.append({
        id: currentId(),
        role: 'assistant',
        text: action.reply?.text ?? '',
        blocks: Array.isArray(action.reply?.blocks) ? action.reply.blocks : []
      });
      await ctx.refreshThread();
      ctx.ui.compose.focus();
    });

    /**
     * 外发 / 删除确认卡（#116）的唯一落点：与风险卡同一套「我的 + 回复」两条消息。
     * 取消只留回执，不生成新卡；删除一项则给回执，并把剩余项做成下一张卡。
     */
    const actConfirm = (button) => ctx.report('确认卡', async () => {
      if (!listApi.canCompose(currentId())) return;
      const api = window.OwnerConfirmCards ?? window.OwnerConfirm;
      if (!api?.confirmAction) {
        notify('确认卡模块还没加载好，稍等一下再试。', 'error');
        return;
      }
      const cardNode = button.closest('[data-block="confirm"]');
      const item = button.closest('.msg');
      if (!cardNode || !item) return;
      const blockIndex = Number(cardNode.dataset.blockIndex ?? -1);
      const messageIndex = Number(item.dataset.index);
      const target = messages[messageIndex];
      const card = target?.blocks?.[blockIndex];
      if (!target || !card) return;
      // 同一张确认卡只选一次：旧节点若被重复点到，不再追加第二轮。
      if (target.answers?.[blockIndex] !== undefined) return;

      const index = button.dataset.confirmIndex === undefined
        ? -1
        : Number(button.dataset.confirmIndex);
      const action = api.confirmAction({
        card,
        action: button.dataset.confirmAction,
        index,
        at: new Date().toISOString()
      });
      // 不在动作表里的点击（伪造参数 / 存储里的旧动作）：不改流，也不假装收到。
      if (!action) return;

      // 先记「这一张已经选过」，重画之后按钮不会再冒出来；再追加我问的一句与一条回复。
      const answered = threadApi.answerBlock(messages, messageIndex, blockIndex, action.answeredLabel);
      const answers = answered[messageIndex]?.answers ?? {};
      if (Number.isInteger(target.seq)) {
        await store.answers({ id: currentId(), seq: target.seq, answers });
      }
      await store.append({ id: currentId(), role: 'user', text: action.userText });
      await store.append({
        id: currentId(),
        role: 'assistant',
        text: action.reply?.text ?? '',
        blocks: Array.isArray(action.reply?.blocks) ? action.reply.blocks : []
      });
      await ctx.refreshThread();
      ctx.ui.compose.focus();
    });

    // ── 事件 ──────────────────────────────────────────────────────────

    exportButton.addEventListener('click', () => { void exportConversation(); });

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
      // 确认卡的动作、复制/导出的按钮、提问块的回答是三套落点，但都只声明「点了什么」；
      // 真正的行为分别由 actConfirm / actRisk / copyFromButton / answerAsk 负责。
      const confirmButton = event.target.closest?.('[data-confirm-action]');
      if (confirmButton) {
        void actConfirm(confirmButton);
        return;
      }
      const riskButton = event.target.closest?.(
        '[data-risk-action], [data-risk-override-submit]'
      );
      if (riskButton) {
        void actRisk(riskButton);
        return;
      }
      const copyButton = event.target.closest?.('[data-copy-message], [data-copy-block]');
      if (copyButton) {
        void copyFromButton(copyButton);
        return;
      }
      const button = event.target.closest?.(
        '[data-ask-choice], [data-ask-skip], [data-ask-free-submit]'
      );
      if (button) void answerAsk(button);
    });

    // 自由回答框里的回车等同点「回答」；输入法组字中的回车照样交给输入法。
    messagesNode.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      // 确认卡的改判理由也支持回车提交；输入法组字中的回车照样交给输入法。
      const riskField = event.target.closest?.('[data-risk-override-note]');
      if (riskField) {
        event.preventDefault();
        const submit = riskField.closest('[data-risk-override-form]')
          ?.querySelector('[data-risk-override-submit]');
        if (submit) void actRisk(submit);
        return;
      }
      const field = event.target.closest?.('[data-ask-free]');
      if (!field) return;
      event.preventDefault();
      const submit = field.closest('[data-block="ask"]')?.querySelector('[data-ask-free-submit]');
      if (submit) void answerAsk(submit);
    });

    return {
      load,
      render: renderThread,
      resetScroll
    };
  };

  return { emptyHint, sessionContext, create };
});
