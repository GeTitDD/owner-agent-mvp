// 卡片壳的渲染层：#106 的会话入口 + #107 的项目/全局模式 + #109 的块渲染。
//
// 分层：
// - shell-thread.cjs：消息流规则（能不能发、占位回复、块与回答的挂载）；
// - shell-sessions.cjs：会话列表规则（排序 / 搜索 / 空态 / 删除落点）；
// - shell-projects.cjs：项目与全局模式的状态机（全局 / 项目 / 跨项目标 / 两个出口）；
// - shell-blocks.cjs / shell-blocks-view.js：块自身的归一化与绘制。
// 这里只做 DOM、IPC 与刷新时序。持久化走主进程的 owner_chat_sessions：
// 会话、置顶、软删除、当前选择（last_opened_at）、正在看的项目（view_project_id）都在库里，
// 重启后原样回来。全局模式的聚合由主进程按项目库同一口径算好，这里只画。
(() => {
  const threadApi = window.OwnerShellThread;
  const listApi = window.OwnerShellSessions;
  const projectsApi = window.OwnerShellProjects;
  const blocksApi = window.OwnerShellBlocks;
  const blocksView = window.OwnerShellBlocksView;
  if (!threadApi) throw new Error('shell-thread.cjs 未加载');
  if (!listApi) throw new Error('shell-sessions.cjs 未加载');
  if (!projectsApi) throw new Error('shell-projects.cjs 未加载');
  if (!blocksApi) throw new Error('shell-blocks.cjs 未加载');
  if (!blocksView) throw new Error('shell-blocks-view.js 未加载');
  const copyApi = window.OwnerShellCopy;
  if (!copyApi) throw new Error('shell-copy.cjs 未加载');

  const store = window.companion?.cardSessions ?? null;
  // #107：项目列表与全局聚合是两个只读通道；拿不到就当没有登记项目（顶栏只剩「全局」）。
  const projectStore = window.companion?.cardProjects ?? null;
  const scopeStore = window.companion?.cardScope ?? null;
  // 写范围判定来自 card-scope-host.mjs（模块脚本晚于本脚本），挂载前用静态兜底文案。
  let scopeApi = window.OwnerCardScope ?? null;

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
  const capsule = $('sessionToggle');
  const capsuleLabel = $('sessionLabel');
  const sessionCross = $('sessionCross');
  const popover = $('sessionPopover');
  const searchInput = $('sessionSearch');
  const newButton = $('sessionNew');
  const listNode = $('sessionList');
  const hintNode = $('sessionListHint');
  const errorNode = $('sessionError');
  const archiveButton = $('sessionArchive');
  const projectToggle = $('projectToggle');
  const projectLabel = $('projectLabel');
  const projectPopover = $('projectPopover');
  const projectList = $('projectList');
  const projectHint = $('projectHint');
  const writeScopeNode = $('writeScope');
  const globalView = $('globalView');
  const globalTitle = $('globalTitle');
  const globalHint = $('globalHint');
  const globalCounts = $('globalCounts');
  const globalStatus = $('globalStatus');
  const globalProjectsNode = $('globalProjects');
  const globalEntriesNode = $('globalEntries');
  const globalEmpty = $('globalEmpty');
  const globalRefresh = $('globalRefresh');
  const confirmBackdrop = $('projectConfirm');
  const confirmTarget = $('confirmTarget');
  const confirmItems = $('confirmItems');
  const confirmInSession = $('confirmInSession');
  const confirmNewSession = $('confirmNewSession');
  const confirmCancel = $('confirmCancel');

  // 会话（已排序）、归档（已删除）、项目列表、当前流；query / 归档视图 / 待确认删除都是纯界面状态。
  let sessions = [];
  let archived = [];
  let projects = [];
  let messages = [];
  let currentId = '';
  let query = '';
  let showArchive = false;
  let pendingDelete = '';
  let renamingId = '';
  let busy = false;
  // #107：正在看的项目（空串 = 全局）。它跟着当前会话的 view_project_id 走，
  // 与 session.projectId（历史归属）分开；两者不一致就是跨项目会话。
  let viewProjectId = '';
  // 全局聚合：进入全局模式时读一次，点「刷新」再读；不参与轮询。
  let globalData = null;
  let globalBusy = false;
  // 切项目确认弹窗：null = 关着；'' 是合法目标（切回全局），所以不能用假值判断。
  let pendingTarget = null;

  /**
   * 导出上下文头（#110）：项目、会话、时间、模型。
   * 会话来自 #106 的持久化记录：id / 标题 / 创建时间都在库里，重复导出不会改头。
   * 项目这一轮还没有选择入口（#107），全局会话如实写「未选项目」。
   */
  const sessionContext = () => {
    const current = currentSession();
    const projectId = String(current?.projectId ?? '').trim();
    return {
      project: projectId || '全局（未选项目）',
      session: current ? listApi.titleOf(current) : '',
      time: String(current?.createdAt ?? ''),
      model: '未接入（占位回复）'
    };
  };

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

  const setError = (message) => {
    errorNode.textContent = String(message ?? '');
    errorNode.hidden = !errorNode.textContent;
  };

  const currentSession = () => sessions.find((item) => item.id === currentId) ?? null;

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
    const hint = currentId
      ? (messages.length ? '' : '这个会话还没有消息，发第一句开始。')
      : listApi.EMPTY_SESSION_HINT;
    emptyNode.textContent = hint;
    emptyNode.hidden = !hint;
    // 新消息在底部：画完再滚，避免停在上一屏。
    threadNode.scrollTop = threadNode.scrollHeight;
  };

  /** 输入框高度跟着内容走，上限三行（CSS 里 max-height 兜底）。 */
  const resizeInput = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 84)}px`;
  };

  /** 没有会话就锁死输入框：不给「无会话却能发消息」留半截状态。 */
  const syncComposer = () => {
    const open = listApi.canCompose(currentId);
    input.disabled = !open;
    // 全局模式不是「不能说话」，而是「不写项目」：消息仍落本机自有库，所以输入框不锁；
    // 提示里说清落点为空，要写项目先选项目。
    input.placeholder = open
      ? (viewProjectId
        ? '说点什么。回车发送，Shift+回车换行'
        : '全局模式：读所有项目的记忆（只读）。先选项目才能写项目目录；回车发送。')
      : '没有会话时不能发消息：先在顶栏新建一个会话。';
    sendButton.disabled = !open || !threadApi.canSend(input.value);
  };

  // ── 会话列表 ──────────────────────────────────────────────────────

  const renderCapsule = () => {
    capsuleLabel.textContent = listApi.sessionLabel(currentSession());
    // #107：绑定与正在看的项目不一致 → 会话胶囊打「跨项目」标。
    // 用归一化后的视图范围参与判定：指向已删除项目的旧范围按全局显示，标也要跟着一致。
    const session = currentSession();
    const cross = session
      ? projectsApi.isCrossProject({ projectId: session.projectId, viewProjectId })
      : false;
    sessionCross.hidden = !cross;
    capsule.dataset.cross = cross ? 'true' : 'false';
    capsule.title = cross
      ? '跨项目会话：历史归属与正在看的项目不一致'
      : '会话';
  };

  // ── 项目与全局模式（#107） ────────────────────────────────────────

  /** 已经登记的项目才算有效范围；指向已删除项目的旧视图退回全局。 */
  const knownScope = (id) => {
    const key = String(id ?? '').trim();
    if (!key) return '';
    if (!projects.length) return key;
    return projects.some((project) => project.id === key) ? key : '';
  };

  /** 视图范围跟着当前会话走；没有会话就是全局。 */
  const applySessionScope = () => {
    viewProjectId = knownScope(projectsApi.viewProjectIdOf(currentSession()));
  };

  const renderProject = () => {
    projectLabel.textContent = projectsApi.scopeLabel(projects, viewProjectId);
    projectToggle.dataset.scope = viewProjectId || 'global';
    projectToggle.title = viewProjectId
      ? `项目：${projectsApi.scopeLabel(projects, viewProjectId)}（点击切换）`
      : '项目：全局（只读跨项目记忆，点击选择项目）';
    const options = projectsApi.projectOptions(projects, viewProjectId);
    projectList.replaceChildren(...options.map((option) => {
      const row = el('li', 'project-row');
      row.dataset.project = option.id;
      row.dataset.current = option.current ? 'true' : 'false';
      if (option.current) row.setAttribute('aria-current', 'true');
      const button = el('button', 'project-name');
      button.type = 'button';
      button.dataset.project = option.id;
      button.title = option.hint;
      button.append(el('span', 'project-title', option.label));
      if (option.current) button.append(el('span', 'pin-mark', '当前'));
      row.append(button, el('span', 'project-meta', option.hint));
      return row;
    }));
  };

  /** 写范围这一格：全局是独立形态（只读），项目下沿用 ADR-0012 的两句话。 */
  const renderWriteScope = () => {
    const payload = scopeApi
      ? scopeApi.writeScopeText({ viewProjectId })
      : {
        label: viewProjectId ? '写·自有' : '只读·全局',
        scope: viewProjectId ? 'own' : 'global',
        hint: viewProjectId ? '' : '全局模式只读项目记忆；要写项目目录先选项目。'
      };
    writeScopeNode.textContent = payload.label;
    writeScopeNode.dataset.scope = payload.scope;
    writeScopeNode.closest('.slot')?.setAttribute('title', payload.hint ?? '');
  };

  const renderGlobalProject = (project) => {
    const counts = project.counts ?? {};
    const row = el('li', 'global-project');
    row.dataset.project = project.id;
    row.append(
      el('span', 'global-project-name', project.name),
      el('span', 'global-project-counts',
        `条目 ${Number(counts.total) || 0} · 已验证 ${Number(counts.verified) || 0} · 观察中 ${Number(counts.observing) || 0}`)
    );
    return row;
  };

  const renderGlobalEntry = (entry) => {
    const row = el('li', 'global-entry');
    row.dataset.section = entry.section ?? '';
    row.dataset.kind = entry.kind ?? '';
    row.append(
      el('span', 'global-entry-title', entry.title ?? '未命名条目'),
      el('span', 'global-entry-meta',
        [entry.badge, entry.projectLabel].filter(Boolean).join(' · '))
    );
    return row;
  };

  /**
   * 全局聚合区：只在没有选项目时出现，并且永远带「只读」。
   * 数据由主进程按项目库同一口径算好（src/global-library.mjs），这里不自己拼计数。
   */
  const renderGlobal = () => {
    const global = !viewProjectId;
    globalView.hidden = !global;
    if (!global) return;
    globalTitle.textContent = globalData?.title ?? '全局 · 跨项目记忆';
    globalHint.textContent = globalData?.hint
      ?? '读所有项目的记忆（跨项目聚合，只读），不写入任何项目。';
    globalStatus.textContent = globalBusy
      ? '正在读取跨项目聚合…'
      : (globalData ? '' : '还没有读到聚合数据，点「刷新」重试。');
    if (!globalData) {
      globalCounts.textContent = '';
      globalProjectsNode.replaceChildren();
      globalEntriesNode.replaceChildren();
      globalEmpty.hidden = true;
      return;
    }
    const counts = globalData.counts ?? {};
    globalCounts.textContent = [
      `项目 ${Number(counts.projects) || 0}`,
      `条目 ${Number(counts.total) || 0}`,
      `已验证 ${Number(counts.verified) || 0}`,
      `观察中 ${Number(counts.observing) || 0}`,
      Number(counts.shared) > 0 ? `跨项目共用 ${counts.shared}` : ''
    ].filter(Boolean).join(' · ');
    globalProjectsNode.replaceChildren(...(globalData.projects ?? []).map(renderGlobalProject));
    globalEntriesNode.replaceChildren(...(globalData.entries ?? []).map(renderGlobalEntry));
    const empty = globalData.empty;
    globalEmpty.hidden = !empty;
    globalEmpty.textContent = empty ? `${empty.title}：${empty.detail}` : '';
  };

  /** 读一次跨项目聚合。只在进入全局模式或点「刷新」时调用，不轮询。 */
  const loadGlobal = async () => {
    if (globalBusy) return;
    if (!scopeStore?.globalLibrary) {
      globalStatus.textContent = '全局聚合不可用：这个窗口没有拿到主进程接口。';
      return;
    }
    globalBusy = true;
    renderGlobal();
    try {
      globalData = await scopeStore.globalLibrary({ limit: 6 }) ?? null;
    } catch (error) {
      setError(`读取全局聚合失败：${error?.message ?? error}`);
    } finally {
      globalBusy = false;
    }
    renderGlobal();
  };

  /** 顶栏与全局区一起重画：凡是改「正在看的项目」的地方都只调这一个。 */
  const renderScope = () => {
    renderProject();
    renderCapsule();
    renderWriteScope();
    renderGlobal();
    syncComposer();
  };

  /** 范围变了：全局要读聚合，项目下直接收起全局区。 */
  const applyScopeChange = () => {
    applySessionScope();
    renderScope();
    if (!viewProjectId) {
      // 全局区在流的最上面：进全局先把它露出来，而不是停在最后一条消息上。
      threadNode.scrollTop = 0;
      void loadGlobal();
    }
  };

  const renderRenameRow = (row, session) => {
    const renameInput = el('input', 'session-rename');
    renameInput.type = 'text';
    renameInput.value = listApi.titleOf(session);
    renameInput.setAttribute('aria-label', '重命名会话');
    const commit = () => {
      if (renamingId !== session.id) return;
      const value = renameInput.value;
      renamingId = '';
      void renameSession(session.id, value);
    };
    renameInput.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        renamingId = '';
        renderSessions();
      }
    });
    // 失焦保存；空标题由 renameSession 判为取消。
    renameInput.addEventListener('blur', commit);
    row.append(renameInput);
    // 画完再聚焦，避免 append 前拿不到焦点。
    queueMicrotask(() => {
      renameInput.focus();
      renameInput.select();
    });
    return row;
  };

  const renderConfirmRow = (row, session) => {
    row.classList.add('is-confirming');
    row.append(
      el('span', 'session-name', `删除「${listApi.titleOf(session)}」？`),
      el('span', 'session-meta', '删除后可从「已删除」找回')
    );
    const actions = el('span', 'session-actions');
    const confirm = el('button', 'session-action danger', '删除');
    confirm.type = 'button';
    confirm.dataset.act = 'confirm-delete';
    const cancel = el('button', 'session-action', '取消');
    cancel.type = 'button';
    cancel.dataset.act = 'cancel-delete';
    actions.append(confirm, cancel);
    row.append(actions);
    return row;
  };

  const renderSessionRow = (session) => {
    const row = el('li', 'session-row');
    row.dataset.id = session.id;
    row.dataset.pinned = session.pinned ? 'true' : 'false';
    row.dataset.current = session.id === currentId ? 'true' : 'false';
    if (session.id === currentId) row.setAttribute('aria-current', 'true');
    if (renamingId === session.id) return renderRenameRow(row, session);
    if (pendingDelete === session.id) return renderConfirmRow(row, session);

    const name = el('button', 'session-name');
    name.type = 'button';
    name.dataset.act = 'switch';
    name.title = '切到这个会话';
    name.append(el('span', 'session-title', listApi.titleOf(session)));
    if (session.pinned) name.append(el('span', 'pin-mark', '置顶'));

    row.append(name, el('span', 'session-meta', `${Number(session.turnCount) || 0} 轮`));

    const actions = el('span', 'session-actions');
    const pin = el('button', 'session-action', session.pinned ? '取消置顶' : '置顶');
    pin.type = 'button';
    pin.dataset.act = 'pin';
    const rename = el('button', 'session-action', '重命名');
    rename.type = 'button';
    rename.dataset.act = 'rename';
    const remove = el('button', 'session-action danger', '删除');
    remove.type = 'button';
    remove.dataset.act = 'delete';
    actions.append(pin, rename, remove);
    row.append(actions);
    return row;
  };

  const renderArchiveRow = (session) => {
    const row = el('li', 'session-row is-archived');
    row.dataset.id = session.id;
    row.append(
      el('span', 'session-name', listApi.titleOf(session)),
      el('span', 'session-meta', `${Number(session.turnCount) || 0} 轮 · 已删除`)
    );
    const actions = el('span', 'session-actions');
    const restore = el('button', 'session-action', '找回');
    restore.type = 'button';
    restore.dataset.act = 'restore';
    actions.append(restore);
    row.append(actions);
    return row;
  };

  const renderSessions = () => {
    const visible = showArchive ? archived : sessions;
    const rows = showArchive ? visible : listApi.filterSessions(visible, query);
    listNode.replaceChildren(...rows.map(showArchive ? renderArchiveRow : renderSessionRow));

    const hint = showArchive
      ? (archived.length ? '' : '没有已删除的会话。')
      : listApi.listHint(sessions, query);
    hintNode.textContent = hint;
    hintNode.hidden = !hint;
    hintNode.dataset.kind = !sessions.length
      ? 'no-session'
      : (query.trim() ? 'no-match' : 'empty');

    archiveButton.textContent = listApi.archiveLabel(archived.length);
    archiveButton.setAttribute('aria-pressed', showArchive ? 'true' : 'false');
    renderCapsule();
  };

  // ── 数据：全部经主进程那两张表，界面不自己存一份 ──────────────────

  const loadSessions = async () => {
    const [visible, withDeleted] = await Promise.all([
      store.list({}),
      store.list({ includeDeleted: true })
    ]);
    sessions = listApi.sortSessions(visible?.items);
    archived = listApi.sortSessions((withDeleted?.items ?? []).filter((item) => item.deletedAt));
    // 当前会话被别处删掉时不假装还在：退回第一条。
    if (currentId && !sessions.some((item) => item.id === currentId)) {
      currentId = sessions[0]?.id ?? '';
    }
  };

  const loadMessages = async () => {
    if (!currentId) {
      messages = [];
      return;
    }
    const detail = await store.get({ id: currentId });
    messages = threadApi.fromStored(detail?.messages);
  };

  /** 发完一条消息之后要刷的几件事：列表（标题/轮数/排序）、当前流、输入框。 */
  const refreshThread = async () => {
    await loadSessions();
    await loadMessages();
    renderThread();
    renderSessions();
    renderScope();
  };

  /**
   * 切换当前会话：记住它（last_opened_at），再把这一条的消息读回来。
   * boot 时不写 last_opened_at——启动只是「回到上次那条」，不是一次新的选择。
   * #107：正在看的项目跟着会话走，所以切换会话也要重画范围与全局区。
   */
  const selectSession = async (id, { remember = true } = {}) => {
    const next = String(id ?? '');
    currentId = sessions.some((item) => item.id === next) ? next : '';
    if (currentId && remember) {
      try {
        await store.touch({ id: currentId });
      } catch {
        // 记不住「上次选的哪条」不该挡住切换本身。
      }
    }
    await loadMessages();
    renderThread();
    renderSessions();
    applyScopeChange();
  };

  // ── 动作：新建 / 切换 / 重命名 / 置顶 / 删除 / 找回 / 发送 / 回答 ──

  const report = async (label, action) => {
    try {
      setError('');
      await action();
    } catch (error) {
      // 不往控制台丢错误：界面上一行字就够说明这次动作没成。
      setError(`${label}失败：${error?.message ?? error}`);
    }
  };

  const createSession = () => report('新建会话', async () => {
    const created = await store.create({ title: '' });
    query = '';
    searchInput.value = '';
    showArchive = false;
    pendingDelete = '';
    renamingId = '';
    await loadSessions();
    await selectSession(created.id);
    searchInput.focus();
  });

  const renameSession = (id, value) => report('重命名', async () => {
    const name = listApi.normalizeRename(value);
    // 空标题视为取消：不改库、不报错，列表照旧。
    if (!name) {
      renderSessions();
      return;
    }
    await store.rename({ id, title: name });
    await loadSessions();
    renderSessions();
  });

  const togglePin = (id) => report('置顶', async () => {
    const session = sessions.find((item) => item.id === id);
    if (!session) return;
    await store.pin({ id, pinned: !session.pinned });
    await loadSessions();
    renderSessions();
  });

  const confirmDelete = (id) => report('删除会话', async () => {
    const before = sessions;
    const wasCurrent = id === currentId;
    pendingDelete = '';
    // 落点规则在纯函数里：删的是当前就落到第一条，一条不剩就是空态。
    const landed = wasCurrent ? listApi.landingAfterDelete(before, id, id) : currentId;
    await store.remove({ id });
    await loadSessions();
    await selectSession(landed);
  });

  const restoreSession = (id) => report('找回会话', async () => {
    await store.restore({ id });
    await loadSessions();
    renderSessions();
  });

  // ── 项目与全局模式的动作：切范围先确认，两个出口各走各的 ─────────

  const loadProjects = async () => {
    if (!projectStore?.list) {
      projects = [];
      return;
    }
    const result = await projectStore.list({});
    projects = (Array.isArray(result?.items) ? result.items : [])
      .map((project) => ({ id: String(project?.id ?? ''), name: String(project?.name ?? '') }))
      .filter((project) => project.id);
  };

  const setProjectPopover = (open) => {
    projectPopover.hidden = !open;
    projectToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      // 列表每次打开都重画：别处登记/删了项目时不会展示过期项。
      renderProject();
      projectHint.textContent = currentId
        ? '不选项目就是全局：读所有项目的记忆，不写入任何项目。切换项目会先出四条后果。'
        : projectsApi.NO_SESSION_HINT;
    }
  };

  /** 切项目确认弹窗：四条后果固定顺序，目标项目点名，取消什么都不改。 */
  const openConfirm = (targetId) => {
    const session = currentSession();
    if (!session) return;
    const plan = projectsApi.switchConsequences({ session, projects, targetId });
    pendingTarget = String(targetId ?? '');
    confirmTarget.textContent = `从「${plan.from.label}」切到「${plan.target.label}」。四条后果：`;
    confirmItems.replaceChildren(...plan.items.map((item) => {
      const row = el('li', 'confirm-item');
      row.dataset.key = item.key;
      row.append(
        el('span', 'confirm-key', item.label),
        el('span', 'confirm-text', item.text)
      );
      return row;
    }));
    confirmBackdrop.hidden = false;
    confirmCancel.focus();
  };

  const closeConfirm = () => {
    confirmBackdrop.hidden = true;
    pendingTarget = null;
  };

  /**
   * 两个出口：
   * - 在本会话切换：只改视图范围（写入落点跟着走），绑定不动，流里追加一条说明，会打跨项目标；
   * - 新开会话并切换：新会话绑定目标项目，视图也跟着它，所以没有跨项目标。
   * 取消（pendingTarget 被清成 null）不改任何状态。
   */
  const runSwitch = (exit) => report('切换项目', async () => {
    if (pendingTarget === null) return;
    const target = pendingTarget;
    const session = currentSession();
    const plan = projectsApi.exitPlan({ session, targetId: target, exit });
    if (!plan || !session) return;
    closeConfirm();
    if (plan.kind === projectsApi.EXITS.newSession) {
      const created = await store.create({ title: '', projectId: plan.projectId });
      await loadSessions();
      await selectSession(created.id);
      return;
    }
    await store.view({ id: session.id, projectId: plan.viewProjectId });
    // 说明按普通消息落库：切走、重启后还在，不靠内存里的临时提示。
    await store.append({
      id: session.id,
      role: 'assistant',
      text: projectsApi.switchNote({ session, projects, targetId: plan.viewProjectId }),
      blocks: [projectsApi.switchNoteBlock({ session, projects, targetId: plan.viewProjectId })]
    });
    await loadSessions();
    await selectSession(session.id);
  });

  /** 点项目胶囊里的一项：同一项不动；没有会话就直接开一条绑定它的；否则先确认。 */
  const chooseScope = (targetId) => report('切换项目', async () => {
    const target = String(targetId ?? '');
    setProjectPopover(false);
    if (target === viewProjectId) return;
    if (!currentId) {
      setProjectPopover(false);
      const created = await store.create({ title: '', projectId: target });
      await loadSessions();
      await selectSession(created.id);
      return;
    }
    openConfirm(target);
  });

  const send = () => report('发送', async () => {
    if (busy || !listApi.canCompose(currentId)) return;
    const raw = input.value;
    if (!threadApi.canSend(raw)) return;
    // 这一版仍然没有真模型：普通输入回一条占位回复，/blocks 回一条脚本化样本。
    // 两者都按普通消息落库，所以切走再回来看到的是同一条流。
    const reply = blocksApi.isSampleCommand(raw)
      ? blocksApi.sampleReply()
      : { text: threadApi.placeholderText(raw), blocks: [] };
    busy = true;
    try {
      await store.append({ id: currentId, role: 'user', text: raw });
      await store.append({
        id: currentId,
        role: 'assistant',
        text: reply.text ?? '',
        blocks: Array.isArray(reply.blocks) ? reply.blocks : []
      });
      input.value = threadApi.draftAfterSend();
      resizeInput();
      await refreshThread();
      input.focus();
    } finally {
      busy = false;
    }
  });

  /**
   * 提问块按钮的唯一落点。按钮只声明「选了什么」（data-ask-*），
   * 这里用纯函数算出下一轮，再按两条普通消息落库：提问块不在块里执行动作。
   */
  const answerAsk = (button) => report('回答', async () => {
    if (!listApi.canCompose(currentId)) return;
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
      await store.answers({ id: currentId, seq: target.seq, answers });
    }
    await store.append({ id: currentId, role: 'user', text: action.userText });
    await store.append({
      id: currentId,
      role: 'assistant',
      text: action.reply?.text ?? '',
      blocks: Array.isArray(action.reply?.blocks) ? action.reply.blocks : []
    });
    await refreshThread();
    input.focus();
  });

  // ── 事件 ──────────────────────────────────────────────────────────

  const setPopover = (open) => {
    popover.hidden = !open;
    capsule.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      // 每次打开都重新读一遍库：别处删过会话时不会展示过期列表。
      void report('读取会话', async () => {
        await loadSessions();
        renderSessions();
      });
      searchInput.focus();
    } else {
      pendingDelete = '';
      renamingId = '';
    }
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
    if (!currentId) {
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
      const result = await window.companion.conversation.export({
        sessionId: currentId,
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

  capsule.addEventListener('click', () => setPopover(popover.hidden));

  // #107 项目胶囊：一个浮层装「全局 + 已登记项目」；选择本身不直接改范围，先走确认。
  projectToggle.addEventListener('click', () => setProjectPopover(projectPopover.hidden));

  projectList.addEventListener('click', (event) => {
    const button = event.target.closest?.('button[data-project]');
    if (!button) return;
    void chooseScope(button.dataset.project ?? '');
  });

  confirmInSession.addEventListener('click', () => void runSwitch(projectsApi.EXITS.inSession));
  confirmNewSession.addEventListener('click', () => void runSwitch(projectsApi.EXITS.newSession));
  confirmCancel.addEventListener('click', closeConfirm);
  // 点背板等于取消：取消不改变任何状态。
  confirmBackdrop.addEventListener('click', (event) => {
    if (event.target === confirmBackdrop) closeConfirm();
  });

  globalRefresh.addEventListener('click', () => {
    globalData = null;
    void loadGlobal();
  });

  // 判定模块晚于本脚本：挂载后补画写范围这一格（与 panel.js 读 write-gate 同一套时序）。
  window.addEventListener('owner-card-scope-ready', () => {
    scopeApi = window.OwnerCardScope ?? scopeApi;
    renderWriteScope();
  });

  searchInput.addEventListener('input', () => {
    query = searchInput.value;
    renderSessions();
  });

  newButton.addEventListener('click', createSession);

  archiveButton.addEventListener('click', () => {
    showArchive = !showArchive;
    pendingDelete = '';
    renamingId = '';
    renderSessions();
  });

  listNode.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    const row = button.closest('.session-row');
    const id = row?.dataset.id ?? '';
    if (!id) return;
    if (button.dataset.act === 'switch') {
      setPopover(false);
      void report('切换会话', () => selectSession(id));
    } else if (button.dataset.act === 'pin') {
      void togglePin(id);
    } else if (button.dataset.act === 'rename') {
      renamingId = id;
      pendingDelete = '';
      renderSessions();
    } else if (button.dataset.act === 'delete') {
      pendingDelete = id;
      renamingId = '';
      renderSessions();
    } else if (button.dataset.act === 'cancel-delete') {
      pendingDelete = '';
      renderSessions();
    } else if (button.dataset.act === 'confirm-delete') {
      void confirmDelete(id);
    } else if (button.dataset.act === 'restore') {
      void restoreSession(id);
    }
  });

  messagesNode.addEventListener('click', (event) => {
    const copyButton = event.target.closest?.('[data-copy-message], [data-copy-block]');
    if (copyButton) {
      copyFromButton(copyButton);
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
    const field = event.target.closest?.('[data-ask-free]');
    if (!field) return;
    event.preventDefault();
    const submit = field.closest('[data-block="ask"]')?.querySelector('[data-ask-free-submit]');
    if (submit) void answerAsk(submit);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // 先收最上面的一层：确认弹窗 > 项目浮层 > 会话浮层。
    if (!confirmBackdrop.hidden) {
      event.preventDefault();
      closeConfirm();
      return;
    }
    if (!projectPopover.hidden) {
      event.preventDefault();
      setProjectPopover(false);
      return;
    }
    if (!popover.hidden) {
      event.preventDefault();
      setPopover(false);
    }
  });

  // 点浮层外面就收起：顶栏只有一个入口，不能有「打开了收不回去」的状态。
  document.addEventListener('mousedown', (event) => {
    if (!projectPopover.hidden
      && !projectPopover.contains(event.target)
      && !projectToggle.contains(event.target)) {
      setProjectPopover(false);
    }
    if (popover.hidden) return;
    if (popover.contains(event.target) || capsule.contains(event.target)) return;
    setPopover(false);
  });

  input.addEventListener('input', () => {
    resizeInput();
    syncComposer();
  });

  input.addEventListener('keydown', (event) => {
    // 组字中的回车属于输入法，不能当发送。
    if (event.isComposing || event.keyCode === 229) return;
    // 回车发送；Shift+回车换行交给浏览器默认行为，所以只在「要发送」时 preventDefault。
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void send();
  });

  // ── 启动：先读库，再决定当前会话（上次打开的那条优先，否则第一条） ──

  const boot = () => {
    resizeInput();
    syncComposer();
    renderThread();
    renderSessions();
    renderScope();
    if (!store) {
      setError('会话存储不可用：这个窗口没有拿到主进程接口。');
      return;
    }
    void report('读取项目与会话', async () => {
      // 项目先读：会话的「正在看的项目」要按已登记项目校验，否则旧 id 会把顶栏写成不存在的项目。
      await loadProjects();
      await loadSessions();
      await selectSession(listApi.pickInitialSession(sessions), { remember: false });
      renderScope();
      // 没有会话时就是全局：直接把跨项目聚合读出来，用户第一眼看到的是「全局 · 只读」。
      if (!viewProjectId) await loadGlobal();
      input.focus();
    });
  };

  boot();
})();
