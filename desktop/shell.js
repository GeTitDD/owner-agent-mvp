// #106 会话入口：顶栏胶囊 + 会话列表 + 每会话一条对话流。
//
// 分层与 #105 一致：纯规则在 shell-thread.cjs（消息与占位回复）和 shell-sessions.cjs
// （排序 / 搜索 / 空态 / 删除落点）里，这里只做 DOM、IPC 和刷新时序。
// 持久化走主进程的 owner_chat_sessions（src/chat-sessions.mjs）：会话、置顶、软删除，
// 连「当前选的是哪条」也落在会话行的 last_opened_at 上，重启后回到同一条。
(() => {
  const threadApi = window.OwnerShellThread;
  const listApi = window.OwnerShellSessions;
  if (!threadApi) throw new Error('shell-thread.cjs 未加载');
  if (!listApi) throw new Error('shell-sessions.cjs 未加载');

  const store = window.companion?.cardSessions ?? null;

  const $ = (id) => document.getElementById(id);
  const messagesNode = $('messages');
  const emptyNode = $('emptyState');
  const threadNode = $('thread');
  const form = $('composer');
  const input = $('input');
  const sendButton = $('send');
  const capsule = $('sessionToggle');
  const capsuleLabel = $('sessionLabel');
  const popover = $('sessionPopover');
  const searchInput = $('sessionSearch');
  const newButton = $('sessionNew');
  const listNode = $('sessionList');
  const hintNode = $('sessionListHint');
  const errorNode = $('sessionError');
  const archiveButton = $('sessionArchive');

  // 会话（已排序）、归档（已删除）、当前流；query / 归档视图 / 待确认删除都是纯界面状态。
  let sessions = [];
  let archived = [];
  let messages = [];
  let currentId = '';
  let query = '';
  let showArchive = false;
  let pendingDelete = '';
  let renamingId = '';
  let busy = false;

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const setError = (message) => {
    errorNode.textContent = String(message ?? '');
    errorNode.hidden = !errorNode.textContent;
  };

  const currentSession = () => sessions.find((item) => item.id === currentId) ?? null;

  // ── 对话流 ────────────────────────────────────────────────────────

  /** 一条消息：谁说的 + 气泡；占位回复额外挂一个常驻徽章。 */
  const renderMessage = (message) => {
    const item = el('li', `msg ${message.role === 'user' ? 'user' : 'agent'}`);
    item.dataset.role = message.role;
    if (message.role === 'agent' && threadApi.isPlaceholder(message)) {
      item.classList.add('is-placeholder');
      item.dataset.placeholder = 'true';
    }
    const who = el('span', 'who', message.role === 'user' ? '我' : 'Companion');
    if (item.dataset.placeholder === 'true') who.append(el('span', 'badge', threadApi.PLACEHOLDER_PREFIX));
    item.append(who, el('p', 'bubble', message.text));
    return item;
  };

  const renderThread = () => {
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
    input.placeholder = open
      ? '说点什么。回车发送，Shift+回车换行'
      : '没有会话时不能发消息：先在顶栏新建一个会话。';
    sendButton.disabled = !open || !threadApi.canSend(input.value);
  };

  // ── 会话列表 ──────────────────────────────────────────────────────

  const renderCapsule = () => {
    capsuleLabel.textContent = listApi.sessionLabel(currentSession());
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

  /**
   * 切换当前会话：记住它（last_opened_at），再把这一条的消息读回来。
   * boot 时不写 last_opened_at——启动只是「回到上次那条」，不是一次新的选择。
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
    syncComposer();
    renderSessions();
  };

  // ── 动作：新建 / 切换 / 重命名 / 置顶 / 删除 / 找回 ────────────────

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

  const send = () => report('发送', async () => {
    if (busy || !listApi.canCompose(currentId)) return;
    const text = input.value;
    if (!threadApi.canSend(text)) return;
    busy = true;
    try {
      // 这一版仍然只有占位回复：问题与占位回复都落库，切回来还能看到同一条流。
      await store.append({ id: currentId, role: 'user', text });
      await store.append({ id: currentId, role: 'assistant', text: threadApi.placeholderText(text) });
      input.value = threadApi.draftAfterSend();
      resizeInput();
      await loadSessions();
      await loadMessages();
      renderThread();
      syncComposer();
      renderSessions();
      input.focus();
    } finally {
      busy = false;
    }
  });

  // ── 事件 ──────────────────────────────────────────────────────────

  const setPopover = (open) => {
    popover.hidden = !open;
    capsule.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      // 每次打开都重新读一遍库：别处删过会话时不会展示过期列表。
      report('读取会话', async () => {
        await loadSessions();
        renderSessions();
      });
      searchInput.focus();
    } else {
      pendingDelete = '';
      renamingId = '';
    }
  };

  capsule.addEventListener('click', () => setPopover(popover.hidden));

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

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!popover.hidden) {
      event.preventDefault();
      setPopover(false);
    }
  });

  // 点浮层外面就收起：顶栏只有一个入口，不能有「打开了收不回去」的状态。
  document.addEventListener('mousedown', (event) => {
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

  // ── 启动：先读库，再决定当前会话（记住的那条优先，否则第一条） ────

  const boot = () => {
    resizeInput();
    syncComposer();
    renderThread();
    renderSessions();
    if (!store) {
      setError('会话存储不可用：这个窗口没有拿到主进程接口。');
      return;
    }
    void report('读取会话', async () => {
      await loadSessions();
      // 上次打开过的那条优先（last_opened_at），没有就第一条，一条都没有就是空态。
      await selectSession(listApi.pickInitialSession(sessions), { remember: false });
      input.focus();
    });
  };

  boot();
})();
