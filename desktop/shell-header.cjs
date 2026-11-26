// #121 卡片壳的顶栏：会话胶囊与列表、项目胶囊与切换确认、写范围状态位、定位屏。
//
// 边界：这一块只画顶栏与挂在顶栏胶囊上的浮层 / 确认弹窗；对话流在 shell-stream.cjs，
// 输入区在 shell-compose.cjs。跨块刷新通过 ctx.ui 调它们的 render / sync，不在这里重写。
// 会话、项目、定位屏数据仍全部走主进程那几张表；本文件不自己存一份。
// 双份导出：浏览器当普通脚本加载（挂到 window.OwnerShellHeader），Node 测试用 require 读纯函数。
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerShellHeader = api;
})(typeof globalThis === 'undefined' ? null : globalThis, () => {
  /**
   * 已经登记的项目才算有效范围；指向已删除项目的旧视图退回全局。
   * 纯状态迁移：项目表还没读到时（空数组）不否认证，保持原值。
   */
  const knownScope = (projects, id) => {
    const key = String(id ?? '').trim();
    if (!key) return '';
    const list = Array.isArray(projects) ? projects : [];
    if (!list.length) return key;
    return list.some((project) => project.id === key) ? key : '';
  };

  /** 建立顶栏这一块：查 DOM、绑事件，返回给装配层用的入口。 */
  const create = (ctx) => {
    const listApi = ctx.listApi;
    const projectsApi = ctx.projectsApi;
    const store = ctx.store;
    // #107：项目列表是只读通道；拿不到就当没有登记项目（顶栏只剩「全局」）。
    const projectStore = window.companion?.cardProjects ?? null;
    // #139：定位屏只读取数；切换项目仍走会话的 view 通道，不经过这里。
    const locateStore = window.companion?.locate ?? null;
    // 写范围判定来自 card-scope-host.mjs（模块脚本晚于本脚本），挂载前用静态兜底文案。
    let scopeApi = window.OwnerCardScope ?? null;

    const $ = (id) => document.getElementById(id);
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
    const locateView = $('locateView');
    const locateTitle = $('locateTitle');
    const locateHint = $('locateHint');
    const locateStatus = $('locateStatus');
    const locateList = $('locateList');
    const locateEmpty = $('locateEmpty');
    const locateRefresh = $('locateRefresh');
    const confirmBackdrop = $('projectConfirm');
    const confirmTarget = $('confirmTarget');
    const confirmItems = $('confirmItems');
    const confirmInSession = $('confirmInSession');
    const confirmNewSession = $('confirmNewSession');
    const confirmCancel = $('confirmCancel');
    // #131 同步这一行：三态（已同步 / 未同步 / 从未成功同步）+ 补同步入口。
    const syncRow = $('syncRow');
    const syncEntry = $('syncEntry');
    const syncStateNode = $('syncState');
    const syncDetailNode = $('syncDetail');
    const syncRetry = $('syncRetry');

    // 会话（已排序）、归档（已删除）、项目列表、当前选择；query / 归档视图 / 待确认删除都是纯界面状态。
    let sessions = [];
    let archived = [];
    let projects = [];
    let currentId = '';
    let query = '';
    let showArchive = false;
    let pendingDelete = '';
    let renamingId = '';
    // #107：正在看的项目（空串 = 全局）。它跟着当前会话的 view_project_id 走，
    // 与 session.projectId（历史归属）分开；两者不一致就是跨项目会话。
    let viewProjectId = '';
    // #139 定位屏：进入全局（不选项目）时读一次，点「刷新」再读；不参与轮询，也不推进水位。
    let locateData = null;
    let locateBusy = false;
    // #140 标记已读的回执：留在状态行里说明「这次做了什么」，刷新或换范围时清掉。
    let locateReceipt = '';
    // 切项目确认弹窗：null = 关着；'' 是合法目标（切回全局），所以不能用假值判断。
    let pendingTarget = null;
    // #131 同步状态：null = 还没读到（按「从未成功同步」显示）；busy 只挡重复点击。
    let syncStatus = null;
    let syncBusy = false;

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

    const report = async (label, action) => {
      try {
        setError('');
        await action();
      } catch (error) {
        // 不往控制台丢错误：界面上一行字就够说明这次动作没成。
        setError(`${label}失败：${error?.message ?? error}`);
      }
    };

    const currentSession = () => sessions.find((item) => item.id === currentId) ?? null;

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

    /** 视图范围跟着当前会话走；没有会话就是全局。 */
    const applySessionScope = () => {
      viewProjectId = knownScope(projects, projectsApi.viewProjectIdOf(currentSession()));
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

    /**
     * 同步这一行（#131）：标签、语气、说明全部来自 src/memory/sync-status.mjs 的 syncBadge，
     * 这里只负责改 DOM。判定模块是晚加载的 module 脚本，读不到时先写静态的「未同步」——
     * 宁可说少了，也不能在没同步时写成「已同步」。
     * 最后成功时间与失败原因直接写在说明里（不靠悬停），离线也能一眼看到「上次存好是几点」。
     */
    const renderSync = () => {
      const api = window.OwnerSyncStatus ?? null;
      const badge = api?.syncBadge
        ? api.syncBadge(syncStatus)
        : {
          state: 'unknown',
          tone: 'unknown',
          label: '未同步',
          detail: '从未成功同步过',
          hint: '同步状态还没读出来。',
          retry: true
        };
      syncStateNode.textContent = badge.label;
      syncStateNode.dataset.tone = badge.tone;
      syncStateNode.dataset.state = badge.state;
      syncEntry.dataset.state = badge.state;
      syncDetailNode.textContent = badge.detail || '';
      syncRow.setAttribute('title', badge.hint ?? '');
      syncEntry.setAttribute('title', badge.hint ?? '');
      syncRetry.hidden = !badge.retry;
      syncRetry.disabled = syncBusy;
      syncRetry.textContent = syncBusy ? '同步中…' : (badge.retryLabel ?? '补同步');
    };

    /** 读一次同步状态；没有主进程接口时保持「未同步 / 未知」，不写默认已同步。 */
    const loadSyncStatus = async () => {
      const syncStore = window.companion?.syncStatus ?? null;
      if (!syncStore?.get) {
        renderSync();
        return;
      }
      try {
        syncStatus = await syncStore.get();
      } catch (error) {
        setError(`读取同步状态失败：${error?.message ?? error}`);
      }
      renderSync();
    };

    /**
     * 手动补同步：触发后按执行器返回的结果更新状态，并把结果说出来（成功给时间、失败给原因）。
     * 本地读写不经过这里，所以断网时点它只会更新标记，不会挡住任何本地动作。
     */
    const attemptSync = async () => {
      if (syncBusy) return;
      const syncStore = window.companion?.syncStatus ?? null;
      if (!syncStore?.attempt) {
        ctx.notify?.('补同步不可用：这个窗口没有拿到主进程接口。', 'error');
        return;
      }
      syncBusy = true;
      renderSync();
      try {
        const outcome = await syncStore.attempt();
        syncStatus = outcome?.status ?? syncStatus;
        const ok = outcome?.result?.status === 'ok';
        const text = window.OwnerSyncStatus?.syncAttemptText
          ? window.OwnerSyncStatus.syncAttemptText(outcome)
          : (ok ? '同步完成。' : '补同步未完成。');
        ctx.notify?.(text, ok ? 'ok' : 'error');
      } catch (error) {
        ctx.notify?.(`补同步失败：${error?.message ?? error}`, 'error');
        // 连结果都拿不到：重新读盘，别把界面留在「同步中」。
        await loadSyncStatus();
      } finally {
        syncBusy = false;
        renderSync();
      }
    };

    /**
     * 定位屏的一行：项目名、待确认、三类未读、上次看过、最近决策。
     * 排序、档位与文案全部来自 src/memory/locate-screen.mjs，这里只把字段写成 DOM。
     * 读不到的未读带 `data-known="false"`：样式上按「未知」处理，不混成 0。
     */
    const renderLocateRow = (row) => {
      const item = el('li', 'locate-row');
      item.dataset.project = row.projectId;
      item.dataset.tier = row.tier;

      const head = el('div', 'locate-row-head');
      const name = el('button', 'locate-row-name', row.name);
      name.type = 'button';
      name.dataset.project = row.projectId;
      name.title = `切到「${row.name}」`;
      head.append(name);
      if (row.tierLabel) {
        const tag = el('span', 'locate-tier', row.tierLabel);
        tag.dataset.tier = row.tier;
        head.append(tag);
      }
      // #140 行内「标记已读」：只清这一行的未读。已知没有未读时置灰，
      // 免得点了没有反应；真正的空操作回执由主进程给。
      const mark = el('button', 'locate-mark-read', '标记已读');
      mark.type = 'button';
      mark.dataset.markRead = row.projectId;
      const alreadyRead = row.unread.known === true && row.unread.total === 0;
      mark.disabled = locateBusy || alreadyRead;
      mark.setAttribute('aria-label', `标记「${row.name}」为已读`);
      mark.title = alreadyRead
        ? '这个项目没有未读变化'
        : `把「${row.name}」的未读清零（不打开 /变化，也不影响其他项目）`;
      head.append(mark);

      const counts = el('p', 'locate-counts');
      const pending = el('span', 'locate-pending', row.pendingLabel);
      pending.dataset.known = row.pending.total > 0 ? 'true' : 'false';
      const unread = el('span', 'locate-unread', row.unreadLabel);
      unread.dataset.known = row.unread.known ? 'true' : 'false';
      unread.title = row.unread.known ? '' : (row.unread.unknownText ?? '');
      counts.append(pending, unread);

      const meta = el('p', 'locate-meta', row.lastReadLabel);
      const decision = el('p', 'locate-decision', row.decisionLabel);
      item.append(head, counts, meta, decision);
      return item;
    };

    /**
     * 定位屏：只在没有选项目时出现。它替换了原来的全局聚合数字（ADR-0014），
     * 数据由主进程算好（src/memory/locate-screen.mjs），这里不自己拼计数、不排序。
     */
    const renderLocate = () => {
      const global = !viewProjectId;
      locateView.hidden = !global;
      if (!global) return;
      locateTitle.textContent = locateData?.title ?? '先看哪个';
      locateHint.textContent = locateData?.hint
        ?? '排序：待确认候选 > 有未读变化 > 超过 7 天未看 > 其余。切换项目不会清零未读。';
      locateStatus.textContent = locateBusy
        ? '正在读取各项目的关注顺序…'
        : (locateReceipt || (locateData ? '' : '还没有读到定位屏数据，点「刷新」重试。'));
      if (!locateData) {
        locateList.replaceChildren();
        locateEmpty.hidden = true;
        return;
      }
      locateList.replaceChildren(...(locateData.projects ?? []).map(renderLocateRow));
      const empty = locateData.empty;
      locateEmpty.hidden = !empty;
      locateEmpty.textContent = empty ? `${empty.title}：${empty.detail}` : '';
    };

    /**
     * 读一次定位屏。只在进入全局模式或点「刷新」时调用，不轮询。
     * 这条通道是只读的：不推进水位、不扫描，所以在这里来回切换项目不会清零任何未读。
     */
    const loadLocate = async () => {
      if (locateBusy) return;
      if (!locateStore?.attention) {
        locateStatus.textContent = '定位屏不可用：这个窗口没有拿到主进程接口。';
        return;
      }
      locateBusy = true;
      locateReceipt = '';
      renderLocate();
      try {
        locateData = await locateStore.attention() ?? null;
      } catch (error) {
        setError(`读取定位屏失败：${error?.message ?? error}`);
      } finally {
        locateBusy = false;
      }
      renderLocate();
    };

    /**
     * #140 行内「标记已读」：唯一的定位屏写动作，只清被点的那一个项目。
     * 主进程推进水位后返回刷新好的定位屏；这里只替换数据、显示回执，不自己算未读。
     * 不打开 `/变化`：切换项目与刷新仍走只读通道。
     */
    const markLocateRead = async (projectId) => {
      const id = String(projectId ?? '').trim();
      if (!id || locateBusy) return;
      if (!locateStore?.markRead) {
        locateStatus.textContent = '标记已读不可用：这个窗口没有拿到主进程接口。';
        return;
      }
      locateBusy = true;
      locateReceipt = '';
      renderLocate();
      try {
        setError('');
        const result = await locateStore.markRead({ projectId: id }) ?? null;
        if (result?.view) locateData = result.view;
        const message = String(result?.mark?.message ?? '已标记已读。');
        // 回执留在状态行：读屏与「点完就消失的 toast」各有各的用处。
        locateReceipt = message;
        ctx.notify?.(message, 'ok');
      } catch (error) {
        setError(`标记已读失败：${error?.message ?? error}`);
      } finally {
        locateBusy = false;
      }
      renderLocate();
    };

    /** 顶栏与定位屏一起重画：凡是改「正在看的项目」的地方都只调这一个。 */
    const renderScope = () => {
      renderProject();
      renderCapsule();
      renderWriteScope();
      renderLocate();
      ctx.ui.compose.sync();
    };

    /** 范围变了：回到全局要读定位屏，项目下直接收起定位屏。 */
    const applyScopeChange = () => {
      applySessionScope();
      // 上一行的标记回执不该跟着换项目继续挂着。
      locateReceipt = '';
      renderScope();
      if (!viewProjectId) {
        // 定位屏在流的最上面：进全局先把它露出来，而不是停在最后一条消息上。
        ctx.ui.stream.resetScroll();
        void loadLocate();
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
      await ctx.ui.stream.load();
      ctx.ui.stream.render();
      renderSessions();
      applyScopeChange();
    };

    // ── 动作：新建 / 切换 / 重命名 / 置顶 / 删除 / 找回 ──────────────

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
        .map((project) => ({
          id: String(project?.id ?? ''),
          name: String(project?.name ?? ''),
          // #124：关联项目的 prompt 段要写「项目名（来源 · 路径）」，路径随项目一起读。
          root: String(project?.root ?? '')
        }))
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

    // ── 会话浮层 ──────────────────────────────────────────────────────

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

    const closePopoverIfOpen = () => {
      if (!popover.hidden) setPopover(false);
    };

    /**
     * Esc 的顶栏一层：确认弹窗 > 项目浮层 > 会话浮层。关掉哪层就返回 true，
     * 由装配层决定还要不要往输入区的 `/` 面板走。
     */
    const dismissOverlay = () => {
      if (!confirmBackdrop.hidden) {
        closeConfirm();
        return true;
      }
      if (!projectPopover.hidden) {
        setProjectPopover(false);
        return true;
      }
      if (!popover.hidden) {
        setPopover(false);
        return true;
      }
      return false;
    };

    // ── 事件 ──────────────────────────────────────────────────────────

    // 窗口的唯一出口：收起，不退出。退出留在托盘菜单，避免误点带走后台的心跳与同步。
    $('windowHide')?.addEventListener('click', () => window.companion?.hidePanel?.());

    capsule.addEventListener('click', () => setPopover(popover.hidden));

    // #107 项目胶囊：一个浮层装「全局 + 已登记项目」；选择本身不直接改范围，先走确认。
    projectToggle.addEventListener('click', () => setProjectPopover(projectPopover.hidden));

    projectList.addEventListener('click', (event) => {
      const button = event.target.closest?.('button[data-project]');
      if (!button) return;
      void chooseScope(button.dataset.project ?? '');
    });

    // 定位屏的一行就是切换入口：走与项目胶囊同一个确认流程，不清零未读（ADR-0014）。
    // #140「标记已读」是这一屏唯一的写动作，先认它，避免落进下面的切换确认。
    locateList.addEventListener('click', (event) => {
      const mark = event.target.closest?.('button[data-mark-read]');
      if (mark) {
        void markLocateRead(mark.dataset.markRead ?? '');
        return;
      }
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

    locateRefresh.addEventListener('click', () => {
      locateData = null;
      locateReceipt = '';
      void loadLocate();
    });

    // 判定模块晚于本脚本：挂载后补画写范围这一格（与旧面板读 write-gate 同一套时序，钩子仍叫 card-scope）。
    window.addEventListener('owner-card-scope-ready', () => {
      scopeApi = window.OwnerCardScope ?? scopeApi;
      renderWriteScope();
    });

    // #131：同步状态判定模块同样是晚加载的 module 脚本；挂载后补画这一格。
    // 「补同步」是显式动作：只有人点了才尝试，轮询与启动都不会自己推。
    window.addEventListener('owner-sync-status-ready', renderSync);
    syncRetry.addEventListener('click', () => void attemptSync());

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

    // 启动就读一次同步状态：默认是「从未成功同步过」，读到成功记录也不会先亮成已同步。
    void loadSyncStatus();

    return {
      report,
      setError,
      currentId: () => currentId,
      currentSession,
      viewProjectId: () => viewProjectId,
      projects: () => projects,
      sessions: () => sessions,
      render: renderSessions,
      renderScope,
      loadProjects,
      loadSessions,
      selectSession,
      loadLocate,
      loadSyncStatus,
      attemptSync,
      syncStatus: () => syncStatus,
      closePopoverIfOpen,
      dismissOverlay
    };
  };

  return { knownScope, create };
});
