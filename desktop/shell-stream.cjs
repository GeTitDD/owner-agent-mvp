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

  /**
   * 灵感提升后的经验卡（#137）：与 /经验 的经验卡同一形状，动作只有「提升为候选」。
   * 现象来自灵感原文，机制 / 对策为空时照实写「未记录」；这张卡只声明动作，
   * 真正的提升仍走 actReview（HITL 2），不会自动写知识库。
   */
  const ideaLessonReview = (lesson) => ({
    type: 'review',
    kind: 'lesson',
    lessonId: String(lesson?.id ?? ''),
    title: String(lesson?.phenomenon ?? ''),
    rows: [
      ['机制', String(lesson?.mechanism ?? '') || '（未记录）'],
      ['对策', String(lesson?.countermeasure ?? '') || '（未记录）'],
      ['状态', String(lesson?.verificationStatus ?? '')]
    ],
    actions: [{ id: 'promote', label: '提升为候选' }],
    note: '提升只生成候选；接受后才会写进知识库。'
  });

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
    // #123 勾选态：只在「生成 prompt」方法卡打开时存在；selected 存消息下标。
    // 计数监听给方法卡用，卡片关掉就退订，流这边不保留任何界面引用。
    let selectMode = false;
    let selected = new Set();
    const selectionListeners = new Set();

    /** 当前会话由顶栏持有：对话流只读，不另存一份。 */
    const currentId = () => ctx.ui.header.currentId();

    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    // Markdown 渲染统一从这里走：模块没加载时退回纯文本，不丢内容。
    const markdownApi = window.OwnerShellMarkdown ?? null;
    const renderMarkdown = (node, text) => {
      if (markdownApi?.renderInto) markdownApi.renderInto(node, text);
      else node.textContent = String(text ?? '');
      return node;
    };

    const setCopyActive = (node) => {
      if (copyActive === node) return;
      copyActive?.removeAttribute('data-copy-active');
      copyActive = node;
      copyActive?.setAttribute('data-copy-active', '1');
    };

    // ── #123 勾选态 ──────────────────────────────────────────────────
    // 状态只有「开没开 + 选中了哪几个下标」；标签编号与 prompt 组装在 shell-at-prompt.cjs。
    // 没有文字的消息不参与勾选：引用的是原文，空正文引不出东西。

    const canSelect = (message) => String(message?.text ?? '').trim().length > 0;

    const selectionSnapshot = () => ({
      count: selected.size,
      indexes: [...selected].sort((a, b) => a - b)
    });

    const emitSelection = () => {
      const snapshot = selectionSnapshot();
      selectionListeners.forEach((listener) => {
        try {
          listener(snapshot);
        } catch {
          // 订阅方自己的错误不影响流的状态；下一次点击仍会重新广播。
        }
      });
    };

    /** 把勾选态刷到现有节点上：不重画消息，滚动位置与正在看的块都不跳。 */
    const applySelection = () => {
      messagesNode.classList.toggle('selecting', selectMode);
      messagesNode.querySelectorAll('.msg').forEach((item) => {
        const on = selectMode && selected.has(Number(item.dataset.index));
        if (on) item.dataset.selected = 'true';
        else item.removeAttribute('data-selected');
        item.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    };

    const setSelectMode = (on) => {
      selectMode = on === true;
      // 每次进出勾选态都清空：上一次的勾选不能被下一次方法悄悄带上。
      selected = new Set();
      applySelection();
      emitSelection();
    };

    const toggleMessageSelection = (index) => {
      if (!selectMode) return;
      const key = Number(index);
      if (!Number.isInteger(key) || key < 0 || key >= messages.length) return;
      if (!canSelect(messages[key])) return;
      if (selected.has(key)) selected.delete(key);
      else selected.add(key);
      applySelection();
      emitSelection();
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
      // #123：有没有可勾选的原文；勾选态是否显形由 .messages.selecting 统一给样式。
      item.dataset.selectable = canSelect(message) ? 'true' : 'false';
      item.setAttribute('aria-selected', 'false');
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
      // 撤回只给最后一条助手消息：一次只退一轮，避免把更早的对话误删。
      if (message.role === 'agent' && index === messages.length - 1) {
        const rewind = el('button', 'rewind-affordance', '撤回');
        rewind.type = 'button';
        rewind.dataset.rewind = '1';
        rewind.setAttribute('aria-label', '撤回上一轮对话');
        rewind.addEventListener('click', () => { void ctx.rewindLast?.(); });
        who.append(rewind);
      }
      item.append(who);
      if (message.text) {
        const bubble = el('div', 'bubble');
        renderMarkdown(bubble, message.text);
        item.append(bubble);
      }
      item.append(blocksView.renderReply(message));
      return item;
    };

    const renderThread = () => {
      // 重画会换掉旧节点：悬停态跟着旧节点一起作废，避免按钮挂在不存在的块上。
      setCopyActive(null);
      messagesNode.replaceChildren(...messages.map(renderMessage));
      // 重画会换掉旧节点：勾选态与选中标记要跟着新节点重新穿上。
      applySelection();
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
      } else {
        const detail = await store.get({ id });
        messages = threadApi.fromStored(detail?.messages);
      }
      // 换了一批消息，旧下标不再指同一条：勾选态下重新开始，不留下错位的选中。
      if (selectMode) {
        selected = new Set();
        emitSelection();
      }
    };

    /** 回到流的顶部：进全局模式时用，别停在最后一条消息上。 */
    const resetScroll = () => {
      threadNode.scrollTop = 0;
    };

    // ── 流式输出：临时气泡 ────────────────────────────────────────────
    //
    // 这一块不落库：只在当前会话里画一条「生成中」的消息，增量更新；
    // 结束后由调用方落库并 renderThread，临时节点随之移除。
    // 思考默认折叠：只露一行「思考中…」，展开才看内容；不写进会话（结束即丢弃）。
    let streamNode = null;
    let streamBubble = null;
    let streamText = '';
    let streamThinking = null;
    let streamThinkingText = '';
    let streamToolLine = null;
    let streamStartedAt = 0;
    let streamTimer = null;

    /** 只有用户已经在底部时才跟随；上滚就停，避免抢滚动条。 */
    const pinnedToBottom = () => {
      const gap = threadNode.scrollHeight - threadNode.scrollTop - threadNode.clientHeight;
      return gap < 24;
    };

    const tickStream = () => {
      if (!streamNode) return;
      const seconds = Math.max(1, Math.round((Date.now() - streamStartedAt) / 1000));
      const summary = streamThinking?.querySelector('summary');
      if (summary) summary.textContent = `思考中…（${seconds}s）`;
    };

    const beginStream = () => {
      if (streamNode) return;
      streamText = '';
      streamThinkingText = '';
      streamStartedAt = Date.now();
      const item = el('li', 'msg agent is-streaming');
      item.dataset.role = 'agent';
      item.dataset.streaming = 'true';
      const who = el('div', 'who');
      who.append(el('span', 'who-name', 'Companion'), el('span', 'badge', '生成中'));
      item.append(who);
      streamBubble = el('div', 'bubble', '思考中…');
      item.append(streamBubble);
      streamThinking = el('details', 'stream-thinking');
      streamThinking.hidden = true;
      streamThinking.append(el('summary', '', '思考中…（0s）'));
      streamThinking.append(el('pre', 'stream-thinking-body'));
      item.append(streamThinking);
      streamToolLine = el('p', 'stream-tool');
      streamToolLine.hidden = true;
      item.append(streamToolLine);
      messagesNode.append(item);
      streamNode = item;
      emptyNode.hidden = true;
      threadNode.scrollTop = threadNode.scrollHeight;
      if (streamTimer) clearInterval(streamTimer);
      streamTimer = setInterval(tickStream, 1000);
    };

    const appendText = (text) => {
      const chunk = String(text ?? '');
      if (!chunk) return;
      if (!streamNode) beginStream();
      streamText += chunk;
      scheduleStreamRender();
    };

    /** 流式中每 100ms 重画一次 Markdown，避免每个 token 都重排。 */
    let streamRenderTimer = null;
    const scheduleStreamRender = () => {
      if (streamRenderTimer) return;
      streamRenderTimer = setTimeout(() => {
        streamRenderTimer = null;
        if (!streamBubble) return;
        const pinned = pinnedToBottom();
        renderMarkdown(streamBubble, streamText);
        if (pinned) threadNode.scrollTop = threadNode.scrollHeight;
      }, 100);
    };

    const appendThinking = (text) => {
      const chunk = String(text ?? '');
      if (!chunk) return;
      if (!streamNode) beginStream();
      streamThinkingText += chunk;
      streamThinking.hidden = false;
      const body = streamThinking.querySelector('pre');
      if (body) body.textContent = streamThinkingText;
    };

    const appendTool = (event) => {
      if (!streamNode) beginStream();
      const name = String(event?.name ?? '');
      if (!name) return;
      const label = event?.phase === 'end' ? `完成 ${name}` : `读取 ${event?.summary || name}`;
      streamToolLine.hidden = false;
      streamToolLine.textContent = label;
    };

    const endStream = () => {
      if (streamTimer) { clearInterval(streamTimer); streamTimer = null; }
      if (streamRenderTimer) { clearTimeout(streamRenderTimer); streamRenderTimer = null; }
      streamNode?.remove();
      streamNode = null;
      streamBubble = null;
      streamThinking = null;
      streamToolLine = null;
      streamText = '';
      streamThinkingText = '';
    };

    /** 流式中插入的一句：插在临时气泡前面，保证「先我后它」的顺序。 */
    const appendSteerMessage = (text) => {      const value = String(text ?? '').trim();
      if (!value) return;
      const item = el('li', 'msg user');
      item.dataset.role = 'user';
      const who = el('div', 'who');
      who.append(el('span', 'who-name', '我'));
      item.append(who);
      item.append(el('p', 'bubble', value));
      if (streamNode?.parentNode === messagesNode) messagesNode.insertBefore(item, streamNode);
      else messagesNode.append(item);
      threadNode.scrollTop = threadNode.scrollHeight;
    };

    /** steer 会打断当前回答：把已经流出来的旧文字清掉，新的从空开始。 */
    const resetStreamText = () => {
      streamText = '';
      if (streamRenderTimer) { clearTimeout(streamRenderTimer); streamRenderTimer = null; }
      if (streamBubble) renderMarkdown(streamBubble, '');
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
      // #135：缺理由的决策追问。跳过 = 仍缺理由；自由回答 = 补一句再确认。
      // 走主进程的 acceptDecision：按待办记录写库，不把候选字段放在消息里。
      const decisionProjectId = askNode.dataset.decisionProjectId ?? '';
      const decisionFingerprint = askNode.dataset.decisionFingerprint ?? '';
      if (decisionProjectId && decisionFingerprint) {
        const memory = window.companion?.memory;
        if (typeof memory?.acceptDecision !== 'function') {
          notify('决策接口还没加载好，稍等一下再试。', 'error');
          return;
        }
        const skipped = button.dataset.askSkip !== undefined;
        const submitted = button.dataset.askFreeSubmit !== undefined;
        if (!skipped && !submitted) return;
        const reason = submitted
          ? String(askNode.querySelector('[data-ask-free]')?.value ?? '').trim()
          : '';
        // 自由回答为空：不改流，也不假装收到。
        if (submitted && !reason) return;
        const result = await memory.acceptDecision({
          projectId: decisionProjectId,
          fingerprint: decisionFingerprint,
          reason
        });
        const answerLabel = result?.ok
          ? (result.missingReason ? '接受（缺理由）' : '接受')
          : (skipped ? '跳过失败' : '接受失败');
        const answered = threadApi.answerBlock(messages, messageIndex, blockIndex, answerLabel);
        const answers = answered[messageIndex]?.answers ?? {};
        if (Number.isInteger(target.seq)) {
          await store.answers({ id: currentId(), seq: target.seq, answers });
        }
        await store.append({
          id: currentId(),
          role: 'user',
          text: skipped ? '跳过理由，保持缺理由' : reason
        });
        await store.append({
          id: currentId(),
          role: 'assistant',
          text: result?.ok
            ? `已接受这条决策${reason ? `，理由：${reason}` : '，理由保持「缺理由」'}。${result.created ? '写入一条决策' : '库里已有同一指纹的决策，没有重复写'}，来源可回查。`
            : `没接受成：${result?.reason || '原因未知'}。待办还在，可以稍后再试。`,
          blocks: []
        });
        await ctx.refreshThread();
        ctx.ui.compose.focus();
        return;
      }
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
     * #115：项目目录同步的卡带着写入清单，动作交给 project-write-host 处理——「允许这一次」
     * 在那条路上是真的写文件，并回一条带路径与字节数的回执。
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

      const overrideSubmit = button.dataset.riskOverrideSubmit !== undefined;
      const overrideArgs = () => {
        const form = button.closest('[data-risk-override-form]');
        return {
          level: form?.querySelector('[data-risk-override-level]')?.value ?? '',
          note: form?.querySelector('[data-risk-override-note]')?.value ?? ''
        };
      };

      let action = null;
      const projectSync = window.OwnerProjectWrite;
      if (projectSync?.knowsCard?.(card.id) === true) {
        // 项目目录同步：清单在 project-write-host 里，允许才写，取消只留「未写入」回执。
        action = await projectSync.act({
          card,
          action: overrideSubmit ? 'override' : (button.dataset.riskAction ?? ''),
          ...overrideArgs(),
          sessionId: currentId()
        });
      } else if (overrideSubmit) {
        action = riskApi.riskAction({ card, action: 'override', ...overrideArgs() });
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
     * 经验 / 候选审核卡（第 2 张票）：提升为候选、接受、拒绝。
     * 与确认卡同一套「点过留 answers」：动作只执行一次，回执落成普通消息。
     */
    const actReview = (button) => ctx.report('审核经验', async () => {
      if (!listApi.canCompose(currentId())) return;
      const cardNode = button.closest('[data-block="review"]');
      const item = button.closest('.msg');
      if (!cardNode || !item) return;
      const blockIndex = Number(cardNode.dataset.blockIndex ?? -1);
      const messageIndex = Number(item.dataset.index);
      const target = messages[messageIndex];
      const card = target?.blocks?.[blockIndex];
      if (!target || !card) return;
      if (target.answers?.[blockIndex] !== undefined) return;
      const knowledge = window.companion?.knowledge;
      const action = button.dataset.reviewAction ?? '';
      let answerLabel = '';
      let reply = null;

      if (card.kind === 'lesson' && action === 'promote') {
        if (typeof knowledge?.promoteLesson !== 'function') {
          notify('提升接口还没加载好，稍等一下再试。', 'error');
          return;
        }
        const result = await knowledge.promoteLesson({
          lessonId: cardNode.dataset.lessonId || card.lessonId
        });
        if (!result?.ok) {
          answerLabel = '提升失败';
          reply = { text: `没提升成：${result?.reason || '原因未知'}`, blocks: [] };
        } else if (!result.created) {
          answerLabel = '已有候选';
          const why = result.reason === 'approved'
            ? '这条经验已经被接受过，不会重复提交。'
            : '这条经验已经有一条待审候选，直接在上面审就行。';
          reply = { text: `没有新建候选：${why}`, blocks: [] };
        } else {
          answerLabel = '已提升为候选';
          reply = {
            text: '已生成候选：接受后才会写进知识库。',
            blocks: [{
              type: 'review',
              kind: 'candidate',
              proposalId: result.proposalId,
              title: card.title,
              rows: [['来源', '经验提升'], ['状态', '待审核']],
              actions: [{ id: 'approve', label: '接受' }, { id: 'reject', label: '拒绝' }],
              note: '接受会写入知识库；拒绝只留记录。'
            }]
          };
        }
      } else if (card.kind === 'candidate' && (action === 'approve' || action === 'reject')) {
        if (typeof knowledge?.review !== 'function') {
          notify('审核接口还没加载好，稍等一下再试。', 'error');
          return;
        }
        const decision = action === 'approve' ? 'approved' : 'rejected';
        const result = await knowledge.review({
          id: cardNode.dataset.proposalId || card.proposalId,
          decision
        });
        if (!result?.ok) {
          answerLabel = action === 'approve' ? '接受失败' : '拒绝失败';
          reply = { text: `没审核成：${result?.reason || '原因未知'}`, blocks: [] };
        } else {
          answerLabel = action === 'approve' ? '接受' : '拒绝';
          reply = {
            text: action === 'approve'
              ? `已接受：${card.title}。这条候选已写入知识库。`
              : `已拒绝：${card.title}。只留记录，没有写入知识库。`,
            blocks: []
          };
        }
      } else if (card.kind === 'decision' && (action === 'accept' || action === 'reject')) {
        // #135：决策候选走主进程的待办——接受才写库，拒绝只记指纹。
        // 主进程按项目 + 指纹找记录，不信任渲染层带来的候选字段。
        const memory = window.companion?.memory;
        const projectId = cardNode.dataset.projectId || card.projectId || '';
        const fingerprint = cardNode.dataset.fingerprint || card.fingerprint || '';
        if (action === 'reject') {
          if (typeof memory?.rejectDecision !== 'function') {
            notify('决策接口还没加载好，稍等一下再试。', 'error');
            return;
          }
          const result = await memory.rejectDecision({ projectId, fingerprint });
          if (!result?.ok) {
            answerLabel = '拒绝失败';
            reply = { text: `没拒绝成：${result?.reason || '原因未知'}`, blocks: [] };
          } else {
            answerLabel = '拒绝';
            reply = {
              text: `已拒绝：${card.title}。只记了指纹，同一个内容以后不再提。`,
              blocks: []
            };
          }
        } else if (cardNode.dataset.missingReason === '1' || card.missingReason === true) {
          // 缺理由：先问一句，可跳过；跳过仍保持「缺理由」，不编占位词。
          answerLabel = '接受 · 待补理由';
          reply = {
            text: '这条决策缺理由：补一句为什么这样选，也可以跳过；跳过就保持「缺理由」。',
            blocks: [{
              type: 'ask',
              question: '这条决策的理由',
              why: String(card.title ?? ''),
              free: { label: '写一句理由', placeholder: '例如：反馈速度比包体积更重要' },
              skip: { label: '跳过，保持「缺理由」', note: '跳过不会编理由：决策仍会写库，但明确标成缺理由。' },
              decision: { projectId, fingerprint }
            }]
          };
        } else {
          if (typeof memory?.acceptDecision !== 'function') {
            notify('决策接口还没加载好，稍等一下再试。', 'error');
            return;
          }
          const result = await memory.acceptDecision({ projectId, fingerprint });
          if (!result?.ok) {
            answerLabel = '接受失败';
            reply = { text: `没接受成：${result?.reason || '原因未知'}`, blocks: [] };
          } else {
            answerLabel = '接受';
            const trace = [result.source, result.sessionId].filter(Boolean).join(' · ');
            reply = {
              text: `已接受：${card.title}。${result.created ? '写入一条决策' : '这条决策已经在库里，没有重复写'}${trace ? `（来源 ${trace}）` : ''}，可回查。${result.missingReason ? ' 这条仍标为「缺理由」。' : ''}`,
              blocks: []
            };
          }
        }
      } else {
        return;
      }

      const answered = threadApi.answerBlock(messages, messageIndex, blockIndex, answerLabel);
      const answers = answered[messageIndex]?.answers ?? {};
      if (Number.isInteger(target.seq)) {
        await store.answers({ id: currentId(), seq: target.seq, answers });
      }
      await store.append({ id: currentId(), role: 'user', text: answerLabel });
      await store.append({
        id: currentId(),
        role: 'assistant',
        text: reply.text,
        blocks: Array.isArray(reply.blocks) ? reply.blocks : []
      });
      await ctx.refreshThread();
      ctx.ui.compose.focus();
    });

    /**
     * 灵感回执上的「提升为 Lesson」（#137）：把这条灵感提升成当前项目的一条经验，
     * 随后把普通的经验卡追加进流里，人可以继续「提升为候选」。
     *
     * 没有选项目时当场拒绝、一个字都不写；同一条灵感点第二次返回已有经验，
     * 不新建第二条。动作只执行一次：点过之后按 answers 收起按钮。
     */
    const actReceiptAction = (button) => ctx.report('提升为 Lesson', async () => {
      if (!listApi.canCompose(currentId())) return;
      const cardNode = button.closest('[data-block="kv"]');
      const item = button.closest('.msg');
      if (!cardNode || !item) return;
      const blockIndex = Number(cardNode.dataset.blockIndex ?? -1);
      const messageIndex = Number(item.dataset.index);
      const target = messages[messageIndex];
      const block = target?.blocks?.[blockIndex];
      const ideaId = String(cardNode.dataset.ideaId || block?.ideaId || '');
      if (!target || !block || !ideaId) return;
      if (target.answers?.[blockIndex] !== undefined) return;
      if ((button.dataset.receiptAction ?? '') !== 'promote-lesson') return;

      let answerLabel = '';
      let reply = { text: '', blocks: [] };
      const projectId = String(ctx.ui.header.viewProjectId?.() ?? '');
      if (!projectId) {
        // 没有当前项目：明确说先选项目，不拿灵感自己的项目偷偷兜底。
        answerLabel = '未选项目';
        reply = { text: '提升为 Lesson 要先在顶栏选一个项目：这次什么都没写。', blocks: [] };
      } else {
        const ideas = window.companion?.ideas;
        if (typeof ideas?.toLesson !== 'function') {
          notify('提升接口还没加载好，稍等一下再试。', 'error');
          return;
        }
        const result = await ideas.toLesson({ ideaId, projectId });
        if (!result?.ok) {
          answerLabel = '提升失败';
          reply = { text: `没提升成：${result?.reason || '原因未知'}`, blocks: [] };
        } else if (result.created === false) {
          answerLabel = '已有经验';
          reply = {
            text: `没有新建经验：这条灵感已经提升过（已有 ${result.lesson?.id ?? '这条经验'}）。`,
            blocks: [ideaLessonReview(result.lesson)]
          };
        } else {
          answerLabel = '已提升为 Lesson';
          reply = {
            text: '已生成经验：现象是灵感原文，来源与证据都指回这条灵感。提升为候选要再点一次，不会自动入库。',
            blocks: [ideaLessonReview(result.lesson)]
          };
        }
      }

      const answered = threadApi.answerBlock(messages, messageIndex, blockIndex, answerLabel);
      const answers = answered[messageIndex]?.answers ?? {};
      if (Number.isInteger(target.seq)) {
        await store.answers({ id: currentId(), seq: target.seq, answers });
      }
      await store.append({ id: currentId(), role: 'user', text: answerLabel });
      await store.append({
        id: currentId(),
        role: 'assistant',
        text: reply.text,
        blocks: Array.isArray(reply.blocks) ? reply.blocks : []
      });
      await ctx.refreshThread();
      ctx.ui.compose.focus();
    });

    /**
     * 外发 / 删除确认卡（#116）的唯一落点：与风险卡同一套「我的 + 回复」两条消息。
     * 取消只留回执，不生成新卡；删除一项则给回执，并把剩余项做成下一张卡。
     * #126：分享到飞书的外发卡由 ui.atShare 投递（真正发飞书的那一步在它里面），
     * 本函数只负责把动作交出去、把回执与「已选择」标记落进流。
     */
    const actConfirm = (button) => ctx.report('确认卡', async () => {
      if (!listApi.canCompose(currentId())) return;
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

      const share = ctx.ui.atShare;
      const api = window.OwnerConfirmCards ?? window.OwnerConfirm;
      const shareCard = share?.knowsCard?.(card.id) === true;
      if (!shareCard && !api?.confirmAction) {
        notify('确认卡模块还没加载好，稍等一下再试。', 'error');
        return;
      }

      const index = button.dataset.confirmIndex === undefined
        ? -1
        : Number(button.dataset.confirmIndex);
      const action = shareCard
        ? await share.act({
          cardId: card.id,
          action: button.dataset.confirmAction,
          at: new Date().toISOString()
        })
        : api.confirmAction({
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

    /**
     * 分享回执上的「重试」（#126）：不直接发送，只用同一份草稿再出一张外发确认卡。
     * 旧回执按「点过就留记录」的口径收起按钮，重试也只能由人再点一次。
     */
    const retryShare = (button) => ctx.report('重试分享', async () => {
      if (!listApi.canCompose(currentId())) return;
      const share = ctx.ui.atShare;
      if (typeof share?.retry !== 'function') {
        notify('分享模块还没加载好，稍等一下再试。', 'error');
        return;
      }
      const cardNode = button.closest('[data-block="share"]');
      const item = button.closest('.msg');
      if (!cardNode || !item) return;
      const blockIndex = Number(cardNode.dataset.blockIndex ?? -1);
      const messageIndex = Number(item.dataset.index);
      const target = messages[messageIndex];
      if (!target || target.answers?.[blockIndex] !== undefined) return;

      const reply = share.retry({ draftId: button.dataset.shareRetry ?? '' });
      if (!reply) return;

      const answered = threadApi.answerBlock(messages, messageIndex, blockIndex, '重试');
      const answers = answered[messageIndex]?.answers ?? {};
      if (Number.isInteger(target.seq)) {
        await store.answers({ id: currentId(), seq: target.seq, answers });
      }
      await store.append({ id: currentId(), role: 'user', text: '重试分享到飞书' });
      await store.append({
        id: currentId(),
        role: 'assistant',
        text: reply.text ?? '',
        blocks: Array.isArray(reply.blocks) ? reply.blocks : []
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
      // #126 分享回执的「重试」：只再出一次外发确认，不绕过确认直接发。
      const shareRetry = event.target.closest?.('[data-share-retry]');
      if (shareRetry) {
        void retryShare(shareRetry);
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
      if (button) {
        void answerAsk(button);
        return;
      }
      // #137 灵感回执上的「提升为 Lesson」：块内按钮只声明动作，提升在 actReceiptAction 一处。
      const receiptButton = event.target.closest?.('[data-receipt-action]');
      if (receiptButton) {
        void actReceiptAction(receiptButton);
        return;
      }
      // 经验 / 候选审核：提升、接受、拒绝都走这一条，动作只执行一次。
      const reviewButton = event.target.closest?.('[data-review-action]');
      if (reviewButton) {
        void actReview(reviewButton);
        return;
      }
      // #123 勾选：先让块内按钮 / 输入框拿到点击，其余位置（气泡、块正文）才算「选这条」。
      if (!selectMode) return;
      if (event.target.closest?.('button, a, input, textarea, select')) return;
      const item = event.target.closest?.('.msg');
      if (!item) return;
      toggleMessageSelection(item.dataset.index);
    });

    // 勾选态下点流里的消息是「选它」，不是「点别处」：别让 @@ 卡片把这次按下当成外部点击收起来。
    threadNode.addEventListener('mousedown', (event) => {
      if (selectMode) event.stopPropagation();
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
      resetScroll,
      // 流式：先画一个临时气泡，增量更新；结束时移除，由落库后的正式消息接管。
      beginStream,
      appendText,
      appendThinking,
      appendTool,
      appendSteerMessage,
      resetStreamText,
      endStream,
      isStreaming: () => Boolean(streamNode),
      // #123：勾选态与选中集合由对话流持有，方法卡只读计数、只发「开/关」。
      setSelectMode,
      isSelecting: () => selectMode,
      selectionCount: () => selected.size,
      selectedIndexes: () => selectionSnapshot().indexes,
      onSelectionChange: (listener) => {
        if (typeof listener !== 'function') return () => {};
        selectionListeners.add(listener);
        return () => selectionListeners.delete(listener);
      },
      messages: () => messages
    };
  };

  return { emptyHint, sessionContext, ideaLessonReview, create };
});
