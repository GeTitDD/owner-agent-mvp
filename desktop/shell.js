// 卡片壳的渲染层：#106 的会话入口 + #109 的块渲染。
//
// 分层：
// - shell-thread.cjs：消息流规则（能不能发、占位回复、块与回答的挂载）；
// - shell-sessions.cjs：会话列表规则（排序 / 搜索 / 空态 / 删除落点）；
// - shell-blocks.cjs / shell-blocks-view.js：块自身的归一化与绘制。
// 这里只做 DOM、IPC 与刷新时序。持久化走主进程的 owner_chat_sessions：
// 会话、置顶、软删除、当前选择（last_opened_at）都在库里，重启后原样回来。
(() => {
  const threadApi = window.OwnerShellThread;
  const listApi = window.OwnerShellSessions;
  const skillsApi = window.OwnerShellSkills;
  const blocksApi = window.OwnerShellBlocks;
  const blocksView = window.OwnerShellBlocksView;
  if (!threadApi) throw new Error('shell-thread.cjs 未加载');
  if (!listApi) throw new Error('shell-sessions.cjs 未加载');
  if (!skillsApi) throw new Error('shell-skills.cjs 未加载');
  if (!blocksApi) throw new Error('shell-blocks.cjs 未加载');
  if (!blocksView) throw new Error('shell-blocks-view.js 未加载');

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
  // #108 技能面板的节点：面板本身、两段共用的滚动区、页脚提示与冲突提示。
  const slashPanel = $('skillPanel');
  const slashList = $('skillList');
  const slashCount = $('skillCount');
  const slashHint = $('skillHint');
  const slashConflict = $('skillConflict');
  const slashError = $('skillError');
  const slashToggle = $('skillAliasToggle');

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

  // `/` 面板：技能行来自扫描结果；数字别名只存「我改过的那几个」。
  let skillRows = [];
  let skillCatalogEmpty = null;
  let skillsLoaded = false;
  let skillsLoading = false;
  let slashOpen = false;
  let slashQuery = '';
  let slashSelection = 0;
  let slashCustomizing = false;
  let slashFlat = [];

  /** 本地只存覆盖项；读失败就当没改过，不阻塞面板。 */
  const readAliases = () => {
    try {
      const raw = localStorage.getItem(skillsApi.ALIAS_STORAGE_KEY);
      return skillsApi.normalizeOverrides(raw ? JSON.parse(raw) : {});
    } catch {
      return {};
    }
  };

  let aliasOverrides = readAliases();

  const saveAliases = () => {
    try {
      localStorage.setItem(skillsApi.ALIAS_STORAGE_KEY, JSON.stringify(aliasOverrides));
    } catch {
      // 本地记忆失败不该挡住一次调用；下次打开面板只是回到默认数字。
    }
  };

  const aliasModel = () => skillsApi.mergeAliases({ skills: skillRows, overrides: aliasOverrides });

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
    item.append(who);
    if (message.text) item.append(el('p', 'bubble', message.text));
    item.append(blocksView.renderReply(message));
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

  // ── `/` 技能面板：数字快捷 + 全部技能 ────────────────────────────
  // 数据只认 src/knowledge/skills.mjs 的扫描结果（经 skills.catalog 带回），
  // 名字与说明照原样显示，不翻译、不在这里另写一份。

  const setSlashError = (message) => {
    slashError.textContent = String(message ?? '');
    slashError.hidden = !slashError.textContent;
  };

  /** 冲突文案只在这个函数里生成，行内标记与页脚提示必须说同一件事。 */
  const syncConflictText = (conflicts) => {
    if (!conflicts.numbers.length) {
      slashConflict.textContent = '';
      slashConflict.hidden = true;
      return;
    }
    const detail = conflicts.numbers.map((number) => {
      const ids = conflicts.byNumber[String(number)] ?? [];
      return `${number}（${ids.join('、')}）`;
    }).join('；');
    slashConflict.textContent = `数字冲突：${detail}。两个命令用了同一个数字，按数字会命中排在前面的那个。`;
    slashConflict.hidden = false;
  };

  /** 技能目录只在第一次打开面板时读；失败就留在面板上，不写控制台。 */
  const loadSkills = () => {
    if (skillsLoaded || skillsLoading) return;
    const api = window.companion?.skills?.catalog;
    if (!api) {
      setSlashError('技能目录接口不可用：这个窗口没有拿到主进程桥。');
      return;
    }
    skillsLoading = true;
    slashCount.textContent = '读取中…';
    void Promise.resolve()
      .then(() => api({}))
      .then((data) => {
        skillRows = skillsApi.flattenCatalog(data);
        skillCatalogEmpty = data?.empty ?? null;
        skillsLoaded = true;
        setSlashError('');
        if (slashOpen) renderSlash();
      })
      .catch((error) => {
        setSlashError(`读取技能失败：${error?.message ?? error}`);
        if (slashOpen) renderSlash();
      })
      .finally(() => {
        skillsLoading = false;
        if (slashOpen) renderSlash();
      });
  };

  const ensureSkills = () => {
    if (skillsLoaded || skillsLoading) return;
    loadSkills();
  };

  /**
   * 一行技能。数字行与技能行只在左侧号码与记录文案上不同，
   * 名字 / 说明 / 来源徽章完全一样——来源徽章来自扫描，不在这里猜。
   */
  const slashRow = (skill, { kind, index, slot, conflictIds }) => {
    const row = el('div', 'slash-item');
    row.dataset.kind = kind;
    row.dataset.skillRow = skill.id;
    row.dataset.index = String(index);
    if (index === slashSelection) row.classList.add('is-on');
    if (conflictIds.has(skill.id)) row.classList.add('is-conflict');
    if (skill.missing) row.title = skill.reason || '扫描缺失';
    if (kind === 'command') {
      if (slashCustomizing) {
        const field = el('input', 'slash-num-input');
        field.type = 'text';
        field.inputMode = 'numeric';
        field.maxLength = 1;
        field.dataset.aliasFor = skill.id;
        field.value = String(slot?.number ?? '');
        field.setAttribute('aria-label', `技能 ${skill.id} 的快捷键数字`);
        if (conflictIds.has(skill.id)) field.classList.add('is-conflict');
        row.append(field);
      } else {
        row.append(el('span', 'slash-num', String(slot?.number ?? '·')));
      }
    } else {
      // 全部技能这一段的行没有数字：留一个空位对齐，不用假数字。
      row.append(el('span', 'slash-num is-empty', '·'));
    }
    const cmd = el('span', 'slash-cmd', `/${skill.id}`);
    // 长 id（域包带版本）在行内会截断；悬停仍能看到完整 id。
    cmd.title = skill.id;
    row.append(cmd);
    const text = el('span', 'slash-text');
    // 说明原样显示，不翻译；名称已经包含在 /id 里，不再多占一行。
    text.append(el('span', 'slash-desc', skill.description || '（扫描没有读到说明）'));
    row.append(text);
    if (skill.missing) row.append(el('span', 'slash-src is-missing', '缺失'));
    row.append(el('span', `slash-src src-${skill.source}`, skill.sourceLabel));
    return row;
  };

  const renderSlash = () => {
    if (!slashOpen) return;
    const model = aliasModel();
    const byId = new Map(skillRows.map((skill) => [skill.id, skill]));
    const quickAll = model.slots
      .map((slot) => ({ ...slot, skill: byId.get(slot.id) }))
      .filter((slot) => slot.skill);
    const quick = skillsApi.filterSlots(quickAll, slashQuery);
    const quickIds = new Set(quickAll.map((slot) => slot.id));
    // 纯数字只指数字快捷：这时下半段不再按 id 里的数字捞人，否则打 /2
    // 会把 alpha-12 之类也带出来，和「按数字调用」的语义打架。
    const numericQuery = /^[0-9]+$/u.test(skillsApi.normalizeQuery(slashQuery));
    // 两段合起来覆盖扫描到的每一条技能：数字快捷里的不再在下面重复一遍。
    const rest = numericQuery ? [] : skillsApi.searchSkills(
      skillRows.filter((skill) => !quickIds.has(skill.id)),
      slashQuery
    );
    const conflictIds = new Set(model.conflicts.ids);
    slashFlat = [
      ...quick.map((slot) => ({ id: slot.id, kind: 'command' })),
      ...rest.map((skill) => ({ id: skill.id, kind: 'skill' }))
    ];
    if (slashSelection >= slashFlat.length) slashSelection = Math.max(0, slashFlat.length - 1);

    slashList.replaceChildren();
    slashList.append(el('div', 'slash-group',
      `数字快捷 · ${quick.length}${slashCustomizing ? '（改数字 1-9，空着回默认）' : ''}`));
    quick.forEach((slot, index) => {
      slashList.append(slashRow(slot.skill, { kind: 'command', index, slot, conflictIds }));
    });
    const filtered = Boolean(skillsApi.normalizeQuery(slashQuery));
    slashList.append(el('div', 'slash-group', `全部技能 · ${rest.length}${filtered ? '（已过滤）' : ''}`));
    rest.forEach((skill, offset) => {
      slashList.append(slashRow(skill, {
        kind: 'skill', index: quick.length + offset, slot: null, conflictIds
      }));
    });

    if (slashFlat.length === 0) {
      const message = !skillsLoaded && skillsLoading
        ? '正在读取技能目录…'
        : (skillCatalogEmpty?.detail
          || (skillRows.length
            ? `没有匹配「${skillsApi.normalizeQuery(slashQuery)}」的技能。换个词，或者只打一个 / 看全部。`
            : '扫描没有找到技能：检查 PSTACK_DIR / MATT_SKILLS_DIR / 域包 manifest / 插件 ghost.json。'));
      slashList.append(el('p', 'slash-empty', message));
    }

    slashCount.textContent = skillsLoaded
      ? `共 ${skillRows.length} 个技能 · ${model.slots.length} 个数字快捷`
      : (slashError.hidden ? '读取中…' : '读取失败');
    slashToggle.textContent = slashCustomizing ? '完成' : '自定义';
    slashToggle.setAttribute('aria-pressed', slashCustomizing ? 'true' : 'false');
    slashHint.textContent = slashCustomizing
      ? '数字只认 1-9；改成默认数字或清空即回到默认。改完点「完成」。'
      : '↑↓ 选择 · Enter 调用 · 点任意一行即调用 · Esc 关闭';
    syncConflictText(model.conflicts);
    // 键盘移动后把选中行带进视野；初始选中第一行时等于不滚动。
    slashList.querySelector('.slash-item.is-on')?.scrollIntoView({ block: 'nearest' });
  };

  /** 改数字时不重画整段：重画会让输入框丢焦点，只更新冲突标记。 */
  const refreshSlashConflicts = () => {
    const model = aliasModel();
    const conflictIds = new Set(model.conflicts.ids);
    slashList.querySelectorAll('[data-alias-for]').forEach((field) => {
      field.classList.toggle('is-conflict', conflictIds.has(field.dataset.aliasFor));
    });
    slashList.querySelectorAll('.slash-item').forEach((row) => {
      row.classList.toggle('is-conflict', conflictIds.has(row.dataset.skillRow));
    });
    syncConflictText(model.conflicts);
  };

  const setSlashOpen = (open) => {
    if (open === slashOpen) {
      if (open) renderSlash();
      return;
    }
    slashOpen = open;
    slashPanel.hidden = !open;
    if (!open) {
      slashCustomizing = false;
      slashSelection = 0;
      slashToggle.setAttribute('aria-pressed', 'false');
      return;
    }
    // 打开技能面板先收起会话浮层：两个浮层不该同时压着。
    if (!popover.hidden) setPopover(false);
    slashSelection = 0;
    slashQuery = input.value.startsWith('/') ? input.value.slice(1) : '';
    ensureSkills();
    renderSlash();
  };

  const closeSlashPanel = () => {
    setSlashOpen(false);
    input.focus();
  };

  const toggleSlashCustomizing = () => {
    if (!slashOpen) return;
    slashCustomizing = !slashCustomizing;
    slashToggle.setAttribute('aria-pressed', slashCustomizing ? 'true' : 'false');
    renderSlash();
    if (slashCustomizing) queueMicrotask(() => slashList.querySelector('[data-alias-for]')?.focus());
    else input.focus();
  };

  const moveSlashSelection = (delta) => {
    if (!slashFlat.length) return;
    slashSelection = (slashSelection + delta + slashFlat.length) % slashFlat.length;
    renderSlash();
  };

  /**
   * `/` 面板开关：后面的字都当查询，空查询看全部。
   *
   * 例外：#109 的 `/blocks` 是块全览的临时命令，仍按普通发送走。
   * 它只是样本入口，随 sampleReply 一起删除；删掉后这个例外也一起删。
   */
  const syncSlashFromInput = () => {
    const value = input.value;
    const legacySample = value.trim() === blocksApi.SAMPLE_COMMAND;
    if (!value.startsWith('/') || legacySample) {
      if (slashOpen) setSlashOpen(false);
      return;
    }
    if (!slashOpen) {
      setSlashOpen(true);
      return;
    }
    const next = value.slice(1);
    if (next !== slashQuery) {
      slashQuery = next;
      slashSelection = 0;
    }
    renderSlash();
  };

  /**
   * 点一行 / 按 Enter：数字行是「命令」，技能行是「调用技能」，
   * 两条都按普通消息落库，所以切走再回来记录与结果卡都还在。
   */
  const invokeSkill = (id, kind) => report('调用技能', async () => {
    const skill = skillRows.find((item) => item.id === id);
    if (!skill || !listApi.canCompose(currentId)) return;
    const model = aliasModel();
    const slot = model.slots.find((item) => item.id === id);
    const number = kind === 'command' ? (slot?.number ?? null) : null;
    const record = skillsApi.invocationFor(skill, { kind, number });
    await store.append({ id: currentId, role: 'user', text: record.userText });
    await store.append({
      id: currentId,
      role: 'assistant',
      text: record.reply.text,
      blocks: Array.isArray(record.reply.blocks) ? record.reply.blocks : []
    });
    input.value = threadApi.draftAfterSend();
    resizeInput();
    setSlashOpen(false);
    await refreshThread();
    input.focus();
  });

  const invokeSlashSelection = () => {
    const chosen = slashFlat[slashSelection];
    if (!chosen) return;
    void invokeSkill(chosen.id, chosen.kind);
  };

  /** 没有会话就锁死输入框：不给「无会话却能发消息」留半截状态。 */
  const syncComposer = () => {
    const open = listApi.canCompose(currentId);
    if (!open && slashOpen) setSlashOpen(false);
    input.disabled = !open;
    input.placeholder = open
      ? '说点什么，或打 / 调技能。回车发送，Shift+回车换行'
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

  /** 发完一条消息之后要刷的几件事：列表（标题/轮数/排序）、当前流、输入框。 */
  const refreshThread = async () => {
    await loadSessions();
    await loadMessages();
    renderThread();
    syncComposer();
    renderSessions();
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

  messagesNode.addEventListener('click', (event) => {
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
    if (!popover.hidden) {
      event.preventDefault();
      setPopover(false);
      return;
    }
    if (slashOpen) {
      event.preventDefault();
      setSlashOpen(false);
    }
  });

  // 点浮层外面就收起：顶栏只有一个入口，不能有「打开了收不回去」的状态。
  document.addEventListener('mousedown', (event) => {
    if (popover.hidden) return;
    if (popover.contains(event.target) || capsule.contains(event.target)) return;
    setPopover(false);
  });

  // `/` 面板也一样：点别处收起，但点输入框本身不算「别处」。
  document.addEventListener('mousedown', (event) => {
    if (!slashOpen) return;
    if (slashPanel.contains(event.target) || form.contains(event.target)) return;
    setSlashOpen(false);
  });

  input.addEventListener('input', () => {
    resizeInput();
    syncComposer();
    syncSlashFromInput();
  });

  input.addEventListener('keydown', (event) => {
    // 组字中的回车属于输入法，不能当发送。
    if (event.isComposing || event.keyCode === 229) return;
    // 改数字时先把面板的编辑状态收掉，不误抢 Enter/Esc。
    if (slashOpen && slashCustomizing) {
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault();
        slashCustomizing = false;
        renderSlash();
        return;
      }
    }
    // 面板打开时，上下选、Enter 调用、Esc 关闭；都不能落成一次普通发送。
    if (slashOpen) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setSlashOpen(false);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveSlashSelection(1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveSlashSelection(-1);
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        invokeSlashSelection();
        return;
      }
    }
    // 回车发送；Shift+回车换行交给浏览器默认行为，所以只在「要发送」时 preventDefault。
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  });

  // 面板里的点击：改数字 / 关闭 / 点一行调用。改数字时点行不触发调用。
  slashPanel.addEventListener('click', (event) => {
    if (event.target.closest('#skillAliasToggle')) {
      toggleSlashCustomizing();
      return;
    }
    if (event.target.closest('#skillClose')) {
      closeSlashPanel();
      return;
    }
    if (slashCustomizing) return;
    const row = event.target.closest?.('[data-skill-row]');
    if (!row) return;
    void invokeSkill(row.dataset.skillRow, row.dataset.kind === 'command' ? 'command' : 'skill');
  });

  // 数字输入就地生效：不重画列表，否则每敲一位就丢焦点。
  slashList.addEventListener('input', (event) => {
    const field = event.target.closest?.('[data-alias-for]');
    if (!field) return;
    const raw = field.value.replace(/[^0-9]/gu, '').slice(0, 1);
    if (field.value !== raw) field.value = raw;
    aliasOverrides = skillsApi.applyAliasEdit(
      aliasOverrides, aliasModel().slots, field.dataset.aliasFor, raw
    );
    saveAliases();
    refreshSlashConflicts();
  });

  // 改数字的输入框里 Enter/Esc 都是「完成」，不把焦点困在面板里。
  slashList.addEventListener('keydown', (event) => {
    if (event.isComposing || !event.target.closest?.('[data-alias-for]')) return;
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    event.preventDefault();
    slashCustomizing = false;
    renderSlash();
    input.focus();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (slashOpen) {
      invokeSlashSelection();
      return;
    }
    void send();
  });

  // ── 启动：先读库，再决定当前会话（上次打开的那条优先，否则第一条） ──

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
      await selectSession(listApi.pickInitialSession(sessions), { remember: false });
      input.focus();
    });
  };

  boot();
})();
