// #121 卡片壳的装配层：把顶栏、输入区、对话流三块接起来。
//
// 分层（按职责拆开，行为零变化）：
// - shell-header.cjs：顶栏——会话胶囊与列表、项目胶囊与切换确认、写范围状态位、全局只读区；
// - shell-at.cjs：`@@` 方法菜单与方法卡容器——触发判定、方法列表数据、菜单 ↔ 方法卡迁移；
// - shell-at-project.cjs：#124 关联项目——项目 → 资料的层级、胶囊与「## 关联项目」段；
// - shell-compose.cjs：输入区——输入框与发送、`/` 技能面板、`@@` 面板开合、占位文案与锁定；
// - shell-stream.cjs：对话流——消息渲染、块挂载、悬停复制、提问 / 确认卡动作、导出。
// 规则模块仍是 shell-thread / shell-sessions / shell-projects / shell-skills / shell-blocks /
// shell-blocks-view / shell-copy / risk-card；这里只做装配与事件接线：检查模块、建立共享回执
// （toast）与刷新路径、按启动顺序读一次库。持久化走主进程的 owner_chat_sessions：
// 会话、置顶、软删除、当前选择（last_opened_at）、正在看的项目（view_project_id）都在库里，
// 重启后原样回来。全局模式的聚合由主进程按项目库同一口径算好，这里只画。
(() => {
  const headerApi = window.OwnerShellHeader;
  const composeApi = window.OwnerShellCompose;
  const atApi = window.OwnerShellAt;
  const atProjectApi = window.OwnerShellAtProject;
  const streamApi = window.OwnerShellStream;
  if (!headerApi) throw new Error('shell-header.cjs 未加载');
  if (!atApi) throw new Error('shell-at.cjs 未加载');
  if (!atProjectApi) throw new Error('shell-at-project.cjs 未加载');
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

  const listApi = window.OwnerShellSessions;
  const store = window.companion?.cardSessions ?? null;
  const toastNode = document.getElementById('toast');

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
  // #122：`@@` 面板要在输入区之后建（它打开时会收起 `/` 面板），
  // 输入区在运行期才取 ui.at，所以两块不锁构造顺序。
  ui.at = atApi.create(ctx);
  // #124：关联胶囊栏独立于 `@@` 面板：面板收起后胶囊仍留在输入框上方。
  ui.atProject = atProjectApi.create(ctx);
  ui.stream = streamApi.create(ctx);

  /** 发完一条消息之后要刷的几件事：列表（标题/轮数/排序）、当前流、顶栏与输入框。 */
  ctx.refreshThread = async () => {
    await ui.header.loadSessions();
    await ui.stream.load();
    ui.stream.render();
    ui.header.render();
    ui.header.renderScope();
  };

  // Esc 先收最上面的一层：顶栏的确认弹窗 > 项目浮层 > 会话浮层，
  // 然后是 `@@` 方法面板（与 `/` 面板不会同时开），最后才是 `/` 面板。
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
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
      await ui.header.selectSession(listApi.pickInitialSession(ui.header.sessions()), {
        remember: false
      });
      ui.header.renderScope();
      // 没有会话时就是全局：直接把跨项目聚合读出来，用户第一眼看到的是「全局 · 只读」。
      if (!ui.header.viewProjectId()) await ui.header.loadGlobal();
      ui.compose.focus();
    });
  };

  boot();
})();
