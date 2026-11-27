// #121 卡片壳的装配层：把顶栏、输入区、对话流三块接起来。
//
// 分层（按职责拆开，行为零变化）：
// - shell-header.cjs：顶栏——会话胶囊与列表、项目胶囊与切换确认、写范围状态位、定位屏；
// - shell-at.cjs：`@@` 方法菜单与方法卡容器——触发判定、方法列表数据、菜单 ↔ 方法卡迁移；
// - shell-at-session.cjs：「关联会话」——来源切换、最近会话、线索、指针胶囊与发送段；
// - shell-at-project.cjs：#124 关联项目——项目 → 资料的层级、胶囊与「## 关联项目」段；
// - shell-at-share.cjs：#126 分享到飞书——目标选择、原文 + 出处、外发确认与重试；
// - shell-compose.cjs：输入区——输入框与发送、`/` 技能面板、`@@` 面板开合、占位文案与锁定；
// - shell-stream.cjs：对话流——消息渲染、块挂载、悬停复制、提问 / 确认卡动作、导出。
// 规则模块仍是 shell-thread / shell-sessions / shell-projects / shell-skills / shell-blocks /
// shell-blocks-view / shell-copy / risk-card；这里只做装配与事件接线：检查模块、建立共享回执
// （toast）与刷新路径、按启动顺序读一次库。持久化走主进程的 owner_chat_sessions：
// 会话、置顶、软删除、当前选择（last_opened_at）、正在看的项目（view_project_id）都在库里，
// 重启后原样回来。不选项目时的定位屏由主进程算好（关注顺序、待确认、未读），这里只画。
(() => {
  const headerApi = window.OwnerShellHeader;
  const composeApi = window.OwnerShellCompose;
  const atApi = window.OwnerShellAt;
  const atProjectApi = window.OwnerShellAtProject;
  const atShareApi = window.OwnerShellAtShare;
  const streamApi = window.OwnerShellStream;
  const configApi = window.OwnerShellConfig;
  if (!headerApi) throw new Error('shell-header.cjs 未加载');
  if (!atApi) throw new Error('shell-at.cjs 未加载');
  if (!window.OwnerShellAtSession) throw new Error('shell-at-session.cjs 未加载');
  if (!atProjectApi) throw new Error('shell-at-project.cjs 未加载');
  if (!atShareApi) throw new Error('shell-at-share.cjs 未加载');
  if (!composeApi) throw new Error('shell-compose.cjs 未加载');
  if (!streamApi) throw new Error('shell-stream.cjs 未加载');
  if (!window.OwnerShellThread) throw new Error('shell-thread.cjs 未加载');
  if (!window.OwnerShellSessions) throw new Error('shell-sessions.cjs 未加载');
  if (!window.OwnerShellSkills) throw new Error('shell-skills.cjs 未加载');
  if (!window.OwnerShellProjects) throw new Error('shell-projects.cjs 未加载');
  if (!window.OwnerShellBlocks) throw new Error('shell-blocks.cjs 未加载');
  if (!window.OwnerShellBlocksView) throw new Error('shell-blocks-view.js 未加载');
  if (!window.OwnerRiskCard) throw new Error('risk-card.cjs 未加载');
  if (!window.OwnerShellCopy) throw new Error('shell-copy.cjs 未加载');
  // #127 配置箱：画 DOM 的那一层必须在；分区数据模块晚到，打开时才读。
  if (!configApi) throw new Error('shell-config.cjs 未加载');

  const listApi = window.OwnerShellSessions;
  const store = window.companion?.cardSessions ?? null;
  const toastNode = document.getElementById('toast');

  /** 可见回执：成功与失败都留 4 秒；不静默，也不弹窗打断。 */
  let toastTimer = null;
  let toastVersion = 0;
  const positionToast = () => {
    const shell = document.querySelector('.shell');
    const shellBounds = shell.getBoundingClientRect();
    const shellBottom = shellBounds.bottom;

    // 面板跟随实际输入区和关联胶囊高度；固定 bottom 会在多行草稿时盖住发送按钮。
    const anchors = ['sessionPointers', 'projectLinks', 'skillChip', 'composer']
      .map((id) => document.getElementById(id)).filter((node) => node?.getClientRects().length);
    const anchorTop = Math.min(...anchors.map((node) => node.getBoundingClientRect().top));
    toastNode.style.bottom = `${shellBottom - anchorTop + 8}px`;
    shell.style.setProperty('--composer-bottom-offset', `${shellBottom - anchorTop + 6}px`);
    shell.style.setProperty('--composer-room', `${Math.max(100, anchorTop - shellBounds.top - 80)}px`);
  };
  // 多行输入和草稿状态会让输入区上移；布局变化后持续让提示避开输入区。
  const feedbackObserver = new ResizeObserver(positionToast);
  feedbackObserver.observe(document.getElementById('composer'));
  feedbackObserver.observe(document.getElementById('draftStatus'));
  for (const id of ['sessionPointers', 'projectLinks', 'skillChip']) feedbackObserver.observe(document.getElementById(id));
  const notify = (text, tone = 'ok') => {
    const version = ++toastVersion;
    toastNode.textContent = text;
    toastNode.dataset.tone = tone;
    // 输入框高度随草稿改变，提示定位在输入区上方，避免遮住正在编辑的正文。
    positionToast();
    toastNode.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastNode.hidden = true;
      toastNode.textContent = '';
    }, 4000);
    // 读取动作结束时可撤下自己的加载提示，不误清后来出现的成功/失败回执。
    return () => {
      if (version !== toastVersion) return;
      clearTimeout(toastTimer);
      toastNode.hidden = true;
      toastNode.textContent = '';
    };
  };

  notify.clear = () => { toastVersion += 1; clearTimeout(toastTimer); toastNode.hidden=true; toastNode.textContent=''; };

  // 三块界面的入口：构造时互相还不存在，运行期统一用 ui.* 取，所以顺序不锁死。
  const ui = {};
  const ctx = {
    store,
    listApi,
    threadApi: window.OwnerShellThread,
    skillsApi: window.OwnerShellSkills,
    atApi,
    projectsApi: window.OwnerShellProjects,
    blocksApi: window.OwnerShellBlocks,
    blocksView: window.OwnerShellBlocksView,
    riskApi: window.OwnerRiskCard,
    copyApi: window.OwnerShellCopy,
    ui,
    notify,
    // 动作失败统一落到会话浮层底部的错误行（只有顶栏有这条状态位）。
    report: (label, action) => ui.header.report(label, action)
  };

  ui.header = headerApi.create(ctx);
  ui.compose = composeApi.create(ctx);
  ui.githubProject = window.OwnerShellGitHubProject.create(ctx);
  // #127 配置箱：覆盖层挂在装配层，Esc 与保存回执都要用；它自己绑顶栏的 ⚙。
  ui.config = configApi.create(ctx);
  ui.appearance = window.OwnerShellAppearance.create(ctx);
  // #122：`@@` 面板要在输入区之后建（它打开时会收起 `/` 面板），
  // 输入区在运行期才取 ui.at，所以两块不锁构造顺序。
  ui.at = atApi.create(ctx);
  // #124：关联胶囊栏独立于 `@@` 面板：面板收起后胶囊仍留在输入框上方。
  ui.atProject = atProjectApi.create(ctx);
  ui.stream = streamApi.create(ctx);
  // #125：指针胶囊与「关联会话」卡片共用一份状态；方法卡关闭后胶囊仍在，发送后清空。
  ui.sessionPoints = window.OwnerShellAtSession.create(ctx);
  // #126：分享草稿与确认卡映射留在这里；确认卡关掉后回执上的「重试」靠它找回内容。
  ui.atShare = atShareApi.create(ctx);

  /** 发完一条消息之后要刷的几件事：列表（标题/轮数/排序）、当前流、顶栏与输入框。 */
  ctx.refreshThread = async () => {
    await ui.header.loadSessions();
    await ui.stream.load();
    ui.stream.render();
    ui.header.render();
    ui.header.renderScope();
    void ui.header.loadSyncStatus();
  };

  // Esc 先收最上面的一层：配置箱（全窗口覆盖层）> 顶栏的确认弹窗 > 项目浮层 > 会话浮层，
  // 然后是 `@@` 方法面板（与 `/` 面板不会同时开），最后才是 `/` 面板。
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // 原生外观弹窗位于配置箱之上，交给 dialog 自己取消，不能顺手关掉底层草稿。
    if (document.querySelector('#appearanceDialog')?.open) return;
    if (ui.githubProject.dismiss()) {
      event.preventDefault();
      return;
    }
    if (ui.config.dismiss()) {
      event.preventDefault();
      return;
    }
    if (ui.header.dismissOverlay()) {
      event.preventDefault();
      return;
    }
    if (ui.compose.dismissAt()) {
      event.preventDefault();
      return;
    }
    if (ui.compose.dismissSlash()) event.preventDefault();
  });

  // ── 启动：先读库，再决定当前会话（上次打开的那条优先，否则第一条） ──

  const boot = () => {
    ui.compose.resize();
    ui.compose.sync();
    ui.stream.render();
    ui.header.render();
    ui.header.renderScope();
    if (!store) {
      ui.header.setError('会话存储不可用：这个窗口没有拿到主进程接口。');
      return;
    }
    void ui.header.report('读取项目与会话', async () => {
      // 项目先读：会话的「正在看的项目」要按已登记项目校验，否则旧 id 会把顶栏写成不存在的项目。
      await ui.header.loadProjects();
      await ui.header.loadSessions();
      // 首次启动直接准备会话，用户可以先说一句，不需要学习「新建会话」的概念。
      let initial = listApi.pickInitialSession(ui.header.sessions());
      if (!initial) {
        const created = await store.create({ title: '' });
        initial = created.id;
        await ui.header.loadSessions();
      }
      await ui.header.selectSession(initial, {
        remember: false
      });
      ui.header.renderScope();
      // 没有会话时就是全局：直接把定位屏读出来，用户第一眼看到「先看哪个」。
      if (!ui.header.viewProjectId()) await ui.header.loadLocate();
      ui.compose.focus();
    });
  };

  boot();
})();
