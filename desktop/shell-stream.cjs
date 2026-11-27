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
    actions: [{ id: 'promote', label: '审阅并沉淀' }],
    note: '提升只生成候选；接受后才会写进知识库。'
  });

  /** 建立对话流这一块：查 DOM、绑事件，返回给装配层用的入口。 */
  const create = (ctx) => {
    const threadApi = ctx.threadApi;
    const listApi = ctx.listApi;
    const blocksApi = ctx.blocksApi;
    const blocksView = ctx.blocksView;
    const riskApi = ctx.riskApi;
    // #138 决策改写与 /记决策 的动作分发只在 desktop/decision-form.cjs（经典脚本，先于本文件加载）。
    const decisionForms = window.OwnerDecisionForm ?? null;
    const copyApi = ctx.copyApi;
    const store = ctx.store;
    const notify = ctx.notify;

    const $ = (id) => document.getElementById(id);
    const messagesNode = $('messages');
    const emptyNode = $('emptyState');
    const threadNode = $('thread');
    const exportButton = $('exportConversation');
    const exportPathNode = $('exportPath');
    const historyNav = $('historyNav');
    const historyOlder = $('historyOlder');
    const historyStatus = $('historyStatus');

    let messages = [];
    const historyPageSize = 100;
    let loadedId = '';
    let loadVersion = 0;
    let page = { hasMore: false, nextBeforeSeq: null };
    let messageCount = 0;
    let olderLoading = false;
    let historyError = '';
    let historyFailureDetail = '';
    let preserveOnRender = false;
    const reviewing = new Set();
    const recovering = new Set();
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
    // 渲染层只画表单；草稿持久化与异步恢复跟随对话流的会话身份。
    const bindExperienceDraft = (node,sessionId) => {
      const id=sessionId;
      const draftKey=node.dataset.experienceDraftKey;
      const form=node.querySelector('.experience-form'),error=node.querySelector('[data-experience-error]');
      const bridge=window.companion?.cardSessions?.reviewDraft;
      if(!listApi.canCompose(sessionId)){for(const input of node.querySelectorAll('input,textarea,select,button'))input.disabled=true;return;}
      let touched=false,closed=false,pending=Promise.resolve();
      const snapshot=()=>Object.fromEntries([...form.querySelectorAll('[data-experience-field]')].map(input=>[input.dataset.experienceField,input.value]));
      const save=()=>{
        touched=true;const next=snapshot();
        pending=pending.then(()=>{if(!closed){if(typeof bridge!=='function')throw Error('审阅草稿接口未就绪');return bridge({id,key:draftKey,values:next});}}).catch(()=>{error.textContent='本机草稿暂未保存，请保留当前窗口并复制输入后重试。';error.hidden=false;});
    };
      node.experienceDraft={flush:()=>pending,clear:async()=>{await pending;closed=true;await bridge?.({id,key:draftKey,clear:true});}};
      if(bridge)void bridge({id,key:draftKey}).then(result=>{
        if(touched||closed||!form.isConnected||!result?.values)return;
        for(const input of form.querySelectorAll('[data-experience-field]'))if(typeof result.values[input.dataset.experienceField]==='string')input.value=result.values[input.dataset.experienceField];
        form.querySelector('[data-experience-field=scope]')?.dispatchEvent(new Event('change',{bubbles:false}));
      }).catch(()=>{error.textContent='未能读取上次审阅草稿，请先核对当前内容。';error.hidden=false;});
      form.addEventListener('input',save);form.addEventListener('change',save);
    };


    const renderMessage = (message, index) => {
      const item = el('li', `msg ${message.role === 'user' ? 'user' : 'agent'}`);
      item.dataset.role = message.role;
      // 块内按钮的点击要能找回「哪条消息的哪个提问块」，序号跟着消息走。
      item.dataset.index = String(index);
      if (message.seq) item.dataset.seq = String(message.seq);
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
      const selection = ctx.skillsApi.messageSelection(message);
      if (selection) {
        const chip = el('span', 'skill-chip skill-message-chip', `技能 · ${selection.name} · ${selection.source}`);
        chip.dataset.skillId = selection.id;
        chip.title = selection.id;
        chip.setAttribute('aria-label', `本轮指定技能 ${selection.name}，来源 ${selection.source}`);
        item.append(chip);
      }
      const body = selection ? selection.body : message.text;
      if (body) {
        const bubble = el('div', 'bubble');
        renderMarkdown(bubble, body);
        item.append(bubble);
      }
      const content=blocksView.renderReply(selection ? {...message,blocks:message.blocks.filter(block=>block!==selection.block)} : message);
      item.append(content);
      for(const node of item.querySelectorAll('[data-experience-draft-key]'))bindExperienceDraft(node,currentId());
      return item;
    };

    const renderHistory = () => {
      historyNav.hidden = !page.hasMore && !olderLoading && !historyError && messageCount <= historyPageSize;
      historyOlder.hidden = !page.hasMore;
      historyOlder.disabled = olderLoading || Boolean(streamNode);
      historyOlder.textContent = olderLoading ? '正在加载…' : historyError ? '重试加载更早消息' : '加载更早消息';
      historyNav.dataset.error = historyError ? 'true' : 'false';
      historyNav.setAttribute('aria-busy', String(olderLoading));
      historyStatus.textContent = historyError || (page.hasMore
        ? `已显示 ${messages.length} / ${messageCount} 条消息` : '已到会话开头');
      historyStatus.title = historyError ? historyFailureDetail : '';
    };

    const renderThread = ({ preserveScroll = preserveOnRender } = {}) => {
      if (loadedId !== currentId()) return;
      preserveOnRender = false;
      // 用可见消息作锚，前插历史或更新卡片时保持阅读位置；不依赖新增内容的高度。
      const top = threadNode.getBoundingClientRect().top;
      const anchor = preserveScroll ? [...messagesNode.children].find((node) => node.getBoundingClientRect().bottom > top) : null;
      const anchorSeq = anchor?.dataset.seq;
      const offset = anchor ? anchor.getBoundingClientRect().top - top : 0;
      const oldScroll = threadNode.scrollTop;
      // 重画会换掉旧节点：悬停态跟着旧节点一起作废，避免按钮挂在不存在的块上。
      setCopyActive(null);
      messagesNode.replaceChildren(...messages.map(renderMessage));
      renderHistory();
      // 重画会换掉旧节点：勾选态与选中标记要跟着新节点重新穿上。
      applySelection();
      // 空态分两种：一条会话都没有（不许发消息）与当前会话还没有消息。
      const hint = emptyHint({
        currentId: currentId(),
        count: messages.length,
        noSessionHint: listApi.EMPTY_SESSION_HINT
      });
      emptyNode.textContent = hint;
      emptyNode.hidden = !hint || (!ctx.ui.header.viewProjectId() && !ctx.ui.header.projects().length);
      // 新消息在底部：画完再滚，避免停在上一屏。
      if (preserveScroll) {
        const next = anchorSeq && messagesNode.querySelector(`[data-seq="${anchorSeq}"]`);
        threadNode.scrollTop = next ? oldScroll + next.getBoundingClientRect().top - top - offset : oldScroll;
      } else threadNode.scrollTop = threadNode.scrollHeight;
    };

    /** 读当前会话的消息。切会话与刷新都只走这一条。 */
    const load = async () => {
      const id = currentId();
      const version = ++loadVersion;
      const sameSession = loadedId === id;
      const firstSeq = sameSession ? messages[0]?.seq : null;
      olderLoading = false;
      historyError = '';
      if (!id) {
        messages = [];
        page = { hasMore: false, nextBeforeSeq: null };
        messageCount = 0;
      } else {
        let detail = await store.get({ id, limit: historyPageSize });
        let rows = detail?.messages ?? [];
        // 已展开的历史继续留在流中；从最新快照向前补齐，也同步撤回和旧卡片的状态。
        while (sameSession && firstSeq && detail?.page?.hasMore && rows[0]?.seq > firstSeq) {
          if (version !== loadVersion || currentId() !== id) return;
          const older = await store.get({ id, limit: historyPageSize, beforeSeq: detail.page.nextBeforeSeq });
          rows = [...older.messages, ...rows];
          detail = { ...detail, page: older.page };
        }
        if (version !== loadVersion || currentId() !== id) return;
        if (sameSession && firstSeq) {
          const visible = rows.filter((row) => row.seq >= firstSeq);
          if (visible.length) {
            const trimmed = visible.length !== rows.length;
            rows = visible;
            detail = { ...detail, page: { hasMore: trimmed || detail.page.hasMore,
              nextBeforeSeq: rows[0]?.seq ?? null } };
          }
        }
        messages = threadApi.fromStored(rows);
        page = detail?.page ?? { hasMore: false, nextBeforeSeq: null };
        messageCount = detail?.messageCount ?? messages.length;
      }
      preserveOnRender = sameSession && !pinnedToBottom();
      if (!sameSession) {
        exportPathNode.textContent = '';
        exportPathNode.hidden = true;
      }
      loadedId = id;
      // 换了一批消息，旧下标不再指同一条：勾选态下重新开始，不留下错位的选中。
      if (selectMode) {
        selected = new Set();
        emitSelection();
      }
    };

    const loadOlder = async () => {
      if (olderLoading || streamNode || !page.hasMore || loadedId !== currentId()) return;
      const id = loadedId;
      const version = loadVersion;
      olderLoading = true;
      historyError = '';
      renderHistory();
      try {
        const detail = await store.get({ id, limit: historyPageSize, beforeSeq: page.nextBeforeSeq });
        if (version !== loadVersion || currentId() !== id || streamNode) return;
        const selectedSeqs = new Set([...selected].map((index) => messages[index]?.seq));
        const known = new Set(messages.map((message) => message.seq));
        messages = [...threadApi.fromStored(detail.messages).filter((message) => !known.has(message.seq)), ...messages];
        page = detail.page;
        messageCount = detail.messageCount;
        selected = new Set(messages.flatMap((message, index) => selectedSeqs.has(message.seq) ? [index] : []));
        olderLoading = false;
        renderThread({ preserveScroll: true });
        emitSelection();
      } catch (error) {
        if (version !== loadVersion || currentId() !== id) return;
        historyFailureDetail = String(error?.message || '历史读取暂时不可用');
        historyError = '暂时无法加载更早消息。当前消息和草稿已保留，请重试。';
      } finally {
        if (version === loadVersion && currentId() === id) {
          olderLoading = false;
          renderHistory();
        }
      }
    };
    historyOlder.addEventListener('click', () => { void loadOlder(); });

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
      renderHistory();
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
      renderHistory();
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
          context: sessionContext(current, current ? listApi.titleOf(current) : '')
        });
        if (currentId() === id) {
          exportPathNode.textContent = result.path;
          exportPathNode.hidden = false;
          notify(`已导出：${result.path}`, 'ok');
        }
      } catch (error) {
        notify(`导出失败：${error?.message || '未知原因'}`, 'error');
      }
    };

    /**
     * 提问块按钮的唯一落点。按钮只声明「选了什么」（data-ask-*），
     * 这里用纯函数算出下一轮，再按两条普通消息落库：提问块不在块里执行动作。
     */
    const answerAsk = (button) => ctx.report('回答', async () => {
      const sessionId = currentId();
      if (!listApi.canCompose(sessionId)) return;
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
      // 走主进程的 acceptDecision：按未处理候选记录写库，不把候选字段放在消息里。
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
        const answers = { ...(target.answers ?? {}), [blockIndex]: answerLabel };
        if (Number.isInteger(target.seq)) {
          await store.answers({ id: sessionId, seq: target.seq, answers });
        }
        await store.append({
          id: sessionId,
          role: 'user',
          text: skipped ? '跳过理由，保持缺理由' : reason
        });
        await store.append({
          id: sessionId,
          role: 'assistant',
          text: result?.ok
            ? `已接受这条决策${reason ? `，理由：${reason}` : '，理由保持「缺理由」'}。${result.created ? '写入一条决策' : '库里已有同一指纹的决策，没有重复写'}，来源可回查。`
            : `没接受成：${result?.reason || '原因未知'}。候选还在，可以稍后再试。`,
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
      const answers = { ...(target.answers ?? {}), [blockIndex]: action.answeredLabel };
      if (Number.isInteger(target.seq)) {
        await store.answers({ id: sessionId, seq: target.seq, answers });
      }
      await store.append({ id: sessionId, role: 'user', text: action.userText });
      await store.append({
        id: sessionId,
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
      const sessionId = currentId();
      if (!listApi.canCompose(sessionId)) return;
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
          sessionId
        });
      } else if (overrideSubmit) {
        action = riskApi.riskAction({ card, action: 'override', ...overrideArgs() });
      } else if (button.dataset.riskAction) {
        action = riskApi.riskAction({ card, action: button.dataset.riskAction });
      }
      // 非低风险点「低风险免问」、或未知动作：不改流，也不假装收到。
      if (!action) return;

      // 先记「这一张已经选过」，重画之后按钮不会再冒出来；再追加我问的一句与一条回复。
      const answers = { ...(target.answers ?? {}), [blockIndex]: action.answeredLabel };
      if (Number.isInteger(target.seq)) {
        await store.answers({ id: sessionId, seq: target.seq, answers });
      }
      await store.append({ id: sessionId, role: 'user', text: action.userText });
      await store.append({
        id: sessionId,
        role: 'assistant',
        text: action.reply?.text ?? '',
        blocks: Array.isArray(action.reply?.blocks) ? action.reply.blocks : []
      });
      await ctx.refreshThread();
      ctx.ui.compose.focus();
    });

    /**
     * 决策卡表单的四个字段（#138）：只认 data-decision-field，缺字段按空串。
     * 值只在点「保存并接受 / 确认写入」时读一次——改写本身不往会话里写东西。
     */
    const decisionFieldsOf = (cardNode) => {
      const read = (name) => {
        const field = cardNode?.querySelector?.(`[data-decision-field="${name}"]`) ?? null;
        return String(field?.value ?? '').trim();
      };
      return {
        phenomenon: read('phenomenon'),
        intent: read('intent'),
        abandoned: read('abandoned'),
        reason: read('reason')
      };
    };

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
      const sessionId = currentId();
      const sourceMessages = messages;
      const reviewKey = card.kind === 'candidate' ? `candidate:${card.proposalId}`
        : `${sessionId}:${card.fingerprint || `${target.seq}:${blockIndex}`}`;
      if (reviewing.has(reviewKey)) return;
      reviewing.add(reviewKey);
      notify.clear?.();
      button.disabled = true;
      try {
      const knowledge = window.companion?.knowledge;
      const action = button.dataset.reviewAction ?? '';
      let answerLabel = '';
      let reply = null;

      if (card.editKind && (action==='save-lesson'||action==='approve'||action==='reject'||action==='cancel-experience')) {
        const fail=error=>{const node=cardNode.querySelector('[data-experience-error]');if(node){node.hidden=false;node.textContent=error?.message||String(error);}else notify(error?.message||String(error),'error');};
        if(card.projectId && card.projectId!==ctx.ui.header.viewProjectId()){fail(Error('先切回这张卡的来源项目，再确认。输入已保留。'));return;}
        const fields=Object.fromEntries([...cardNode.querySelectorAll('[data-experience-field]')].map(input=>[input.dataset.experienceField,input.value]));
        try{
          if(action==='cancel-experience'){
            answerLabel='取消整理';reply={text:card.editKind==='candidate'?'已取消本次审阅，没有写入知识；经验和待审候选保留，可用 /经验 继续。':'已取消整理，没有写入经验或知识。原始灵感仍保留。',blocks:[]};
          }else if(action==='save-lesson'){
            const saved=await window.companion.ideas.toLesson({ideaId:card.ideaId,projectId:card.projectId,expectedHash:card.expectedHash,edits:fields});
            if(!saved?.ok)throw Error(saved?.reason||'经验未保存，请重试。');
            answerLabel=saved.created?'已确认保存经验':'已有经验';
            let prepared;
            try{prepared=await knowledge.promoteLesson({lessonId:saved.lesson.id});}catch(error){reply={text:`经验已保存，但下一步审阅未准备好：${error?.message||error}。可在这张经验卡继续。`,blocks:[ideaLessonReview(saved.lesson)]};}
            if(prepared)reply=prepared.reason==='approved'?{text:'这条经验已经沉淀过，没有重复写入。',blocks:[]}:{text:'第一次确认已保存经验。接下来核对知识正文和使用范围，第二次确认后才沉淀为知识。',blocks:[window.OwnerShellCompose.candidateReviewBlock(prepared.candidate)]};
          }else{
            const decision=action==='approve'?'approved':'rejected';
            const result=await knowledge.review({id:card.proposalId,decision,expectedHash:card.expectedHash,edits:action==='approve'?fields:null});
            if(!result?.ok)throw Error(result?.reason||'没有保存成功，请保留输入后重试。');
            answerLabel=action==='approve'?'已按改写内容确认（以下回执为准）':'拒绝';
            const item=result.item;
            reply=action==='approve'?{text:'已接受并沉淀为知识。写入的是本次审阅后的正文和范围，验证状态保持不变。',blocks:[{type:'kv',title:item?.title||'知识写入回执',rows:[['正文',item?.content||''],['范围',item?.scope==='domain'?`领域共享：${item.domains.join('、')}`:`仅项目：${item?.projectId||''}`],['状态',item?.verificationStatus==='verified'?'已验证':'待验证'],['引用',`[knowledge:${result.appliedId}@${item?.revision||1}]`]]}]}:{text:`已拒绝：${card.title}。没有写入知识，经验保留。`,blocks:[]};
          }
          try{await cardNode.experienceDraft?.clear?.();}catch{ /* 成功回执仍以数据库中的知识为准。 */ }
        }catch(error){fail(error);return;}
      } else if (card.kind === 'lesson' && action === 'promote') {
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
          reply = { text: `没有新建候选：${why}`, blocks: result.reason === 'pending' && result.candidate
            ? [window.OwnerShellCompose.candidateReviewBlock(result.candidate)] : result.knowledge ? [{type:'kv',title:'已沉淀的当前知识',rows:[['标题',result.knowledge.title],['正文',result.knowledge.content],['引用',`[knowledge:${result.knowledge.id}@${result.knowledge.revision}]`],['修订','需要修改时打开完整工作台，保留修订历史。']]}] : [] };
        } else {
          answerLabel = '已提升为候选';
          reply = {
            text: '已生成候选：接受后才会写进知识库。',
            blocks: [window.OwnerShellCompose.candidateReviewBlock(result.candidate)]
          };
        }
      } else if (card.kind === 'candidate' && action==='approve' && !card.editKind) {
        const fresh=await knowledge.candidateDraft({id:card.proposalId});
        answerLabel='已打开最新审阅';reply={text:'请核对最新正文和范围后再确认；本次尚未写入知识。',blocks:[window.OwnerShellCompose.candidateReviewBlock(fresh.candidate)]};
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
      } else if (card.kind === 'decision' && (action === 'accept' || action === 'reject' || action === 'rewrite'
        || action === 'save-accept' || action === 'cancel-edit' || action === 'confirm' || action === 'cancel')) {
        // #135 / #138：决策候选与 `/记决策` 共用一张卡。
        // 动作先由纯函数 reviewIntent 分发；改写只把本卡表单展开 / 收起，不写任何东西。
        // 接受仍走主进程的未处理候选（按项目 + 指纹找记录），改写字段只作为 edits 附过去。
        const memory = window.companion?.memory;
        if (!decisionForms) {
          notify('决策表单还没加载好，稍等一下再试。', 'error');
          return;
        }
        const projectId = cardNode.dataset.projectId || card.projectId || '';
        const fingerprint = cardNode.dataset.fingerprint || card.fingerprint || '';
        const mode = card.mode === 'compose' ? 'compose' : 'candidate';
        // 只有「保存并接受」与「记决策确认」才读表单：普通接受不能把改写后没保存的内容带进去。
        const fields = (mode === 'compose' || action === 'save-accept') ? decisionFieldsOf(cardNode) : null;
        const intent = decisionForms.reviewIntent({ mode, action, card, fields });
        if (intent.type === 'expand' || intent.type === 'collapse') {
          // 展开 / 收起只动 DOM：不改流、不写库、也不把这张卡标成已选择。
          cardNode.classList.toggle('editing', intent.type === 'expand');
          const form = cardNode.querySelector('[data-decision-form]');
          if (form) form.hidden = intent.type !== 'expand';
          return;
        }
        if (intent.type === 'none') return;
        if (intent.type === 'invalid') {
          // 现象空着就没有「当时发生了什么」：当场说清，不写半个决策。
          notify(intent.message, 'warn');
          return;
        }
        if (intent.type === 'cancel') {
          // `/记决策` 的取消：只回一条回执，知识库与未处理候选都不动。
          answerLabel = '取消';
          reply = { text: '已取消：没有写入任何决策。', blocks: [] };
        } else if (intent.type === 'reject') {
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
        } else if (intent.type === 'ask-reason') {
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
        } else if (intent.type === 'accept') {
          if (typeof memory?.acceptDecision !== 'function') {
            notify('决策接口还没加载好，稍等一下再试。', 'error');
            return;
          }
          const result = await memory.acceptDecision({
            projectId,
            fingerprint,
            reason: intent.reason,
            // 未改写时 edits 是 null：主进程按未处理候选里的原内容确认，与 #135 完全一致。
            edits: intent.edits
          });
          if (!result?.ok) {
            answerLabel = '接受失败';
            reply = { text: `没接受成：${result?.reason || '原因未知'}。候选还在，可以稍后再试。`, blocks: [] };
          } else {
            answerLabel = intent.edits ? '保存并接受' : '接受';
            const trace = [result.source, result.sessionId].filter(Boolean).join(' · ');
            reply = {
              text: `已接受：${card.title}。${intent.edits ? '写入的是改写后的内容，' : ''}${result.created ? '写入一条决策' : '库里已有同一指纹的决策，没有重复写'}${trace ? `（来源 ${trace}）` : ''}，可回查。${result.missingReason ? ' 这条仍标为「缺理由」。' : ''}`,
              blocks: []
            };
          }
        } else if (intent.type === 'confirm') {
          // `/记决策`：与候选卡同一张表单，但走既有的确认 API 写一条新决策。
          if (typeof memory?.confirmDecision !== 'function') {
            notify('决策接口还没加载好，稍等一下再试。', 'error');
            return;
          }
          if (!projectId) {
            notify('这条决策没有归属项目：先选一个项目再确认。', 'warn');
            return;
          }
          const result = await memory.confirmDecision({
            candidate: decisionForms.composeCandidate({
              projectId,
              projectName: card.projectName,
              fields: intent.fields
            }),
            reason: intent.fields.reason
          });
          if (!result?.ok) {
            answerLabel = '写入失败';
            reply = { text: `没写成：${result?.reason || '原因未知'}`, blocks: [] };
          } else {
            answerLabel = '已确认写入';
            reply = {
              text: result.created
                ? `已写入：${intent.fields.phenomenon}。写入一条决策${result.missingReason ? '，理由仍标为「缺理由」' : ''}。`
                : `没有重复写：库里已有同一现象与项目的决策（${intent.fields.phenomenon}）${result.missingReason ? '，那条仍标为「缺理由」' : ''}。`,
              blocks: []
            };
          }
        }
      } else {
        return;
      }

      // 失败不消耗审核动作；成功则同步收起本会话中同一候选的其他旧卡。
      if (!answerLabel.endsWith('失败')) {
        let answered = sourceMessages;
        for (let index = 0; index < sourceMessages.length; index += 1) {
          const message = sourceMessages[index];
          let changed = false;
          for (let bi = 0; bi < (message.blocks ?? []).length; bi += 1) {
            const block = message.blocks[bi];
            const same = (card.kind === 'candidate' && card.proposalId && block.kind === 'candidate' && block.proposalId === card.proposalId)
              || (card.kind === 'decision' && card.fingerprint && block.kind === 'decision'
                && block.fingerprint === card.fingerprint && block.projectId === card.projectId);
            if ((index === messageIndex && bi === blockIndex) || same) {
              answered = threadApi.answerBlock(answered, index, bi, answerLabel);
              changed = true;
            }
          }
          if (changed && Number.isInteger(message.seq)) {
            await store.answers({ id: sessionId, seq: message.seq, answers: answered[index]?.answers ?? {} });
          }
        }
        await store.append({ id: sessionId, role: 'user', text: answerLabel });
      }
      for (const part of window.OwnerShellCompose.replyParts(reply)) {
        await store.append({ id: sessionId, role: 'assistant', ...part });
      }
      await ctx.refreshThread();
      ctx.ui.compose.focus();
      } finally {
        reviewing.delete(reviewKey);
        if (button.isConnected) button.disabled = false;
      }
    });

    /**
     * 灵感回执上的「提升为 Lesson」（#137）：把这条灵感提升成当前项目的一条经验，
     * 随后把普通的经验卡追加进流里，人可以继续「提升为候选」。
     *
     * 没有选项目时当场拒绝、一个字都不写；同一条灵感点第二次返回已有经验，
     * 不新建第二条。动作只执行一次：点过之后按 answers 收起按钮。
     */
    const actReceiptAction = (button) => ctx.report('提升为 Lesson', async () => {
      const sessionId = currentId();
      if (!listApi.canCompose(sessionId)) return;
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
        const result = await ideas.toLesson({ ideaId, projectId, preview:true });
        if(result?.preview && result.card){
          await store.append({id:sessionId,role:'assistant',text:'先核对并补全经验，确认前不会写入经验或知识。',blocks:[result.card]});
          if(currentId()===sessionId)await ctx.refreshThread();
          return;
        }
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

      const answers = { ...(target.answers ?? {}), [blockIndex]: answerLabel };
      if (Number.isInteger(target.seq)) {
        await store.answers({ id: sessionId, seq: target.seq, answers });
      }
      await store.append({ id: sessionId, role: 'user', text: answerLabel });
      await store.append({
        id: sessionId,
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
      const sessionId = currentId();
      if (!listApi.canCompose(sessionId)) return;
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
      const answers = { ...(target.answers ?? {}), [blockIndex]: action.answeredLabel };
      if (Number.isInteger(target.seq)) {
        await store.answers({ id: sessionId, seq: target.seq, answers });
      }
      await store.append({ id: sessionId, role: 'user', text: action.userText });
      await store.append({
        id: sessionId,
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
      const sessionId = currentId();
      if (!listApi.canCompose(sessionId)) return;
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

      const answers = { ...(target.answers ?? {}), [blockIndex]: '重试' };
      if (Number.isInteger(target.seq)) {
        await store.answers({ id: sessionId, seq: target.seq, answers });
      }
      await store.append({ id: sessionId, role: 'user', text: '重试分享到飞书' });
      await store.append({
        id: sessionId,
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

    const recoverFromButton = (button) => ctx.report('恢复提问', async () => {
      const cardNode = button.closest('[data-block="chat-recovery"]');
      const item = button.closest('.msg');
      if (!cardNode || !item) return;
      const message = messages[Number(item.dataset.index)];
      const blockIndex = Number(cardNode.dataset.blockIndex);
      const raw = message?.blocks?.[blockIndex];
      if (!raw || message.answers?.[blockIndex]) return;
      const model = window.OwnerChatRecovery.normalize(raw);
      const action = button.dataset.chatRecovery;
      if (!model.actions.some((entry) => entry.id === action)) return;
      if (action === 'configure') {
        ctx.ui.config.openSection('model');
        return;
      }
      const sessionId = currentId();
      const key = `${sessionId}:${model.sourceSeq}`;
      if (recovering.has(key)) return;
      recovering.add(key);
      button.disabled = true;
      try {
        if (await ctx.ui.compose.recoverChat(model, action)) {
          const answers = { ...message.answers, [blockIndex]: '已重试' };
          await store.answers({ id: sessionId, seq: message.seq, answers });
          message.answers = answers;
          await ctx.refreshThread();
        }
      } finally {
        recovering.delete(key);
        if (button.isConnected) button.disabled = false;
      }
    });

    messagesNode.addEventListener('click', (event) => {
      const recovery = event.target.closest?.('[data-chat-recovery]');
      if (recovery) {
        void recoverFromButton(recovery);
        return;
      }
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
      // 定位打开的是一段内容：先露出本次回复开头，而不是一张长审核卡的最底部。
      revealLatestReply: () => {
        const lastUser = messages.findLastIndex((message) => message.role === 'user');
        messagesNode.querySelector(`.msg[data-index="${lastUser + 1}"]`)?.scrollIntoView({ block: 'start' });
      },
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
