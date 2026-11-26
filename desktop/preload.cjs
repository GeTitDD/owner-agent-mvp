const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('companion', Object.freeze({
  snapshot: (input) => invoke('companion:snapshot', input),
  // #84：进入项目时算「自上次看过」并推进水位（有副作用，不要放进轮询）。
  sinceLastSeen: (input) => invoke('companion:since-last-seen', input),
  submit: (input) => invoke('companion:submit', input),
  chat: Object.freeze({
    ask: (input) => invoke('companion:chat-ask', input),
    sessions: Object.freeze({
      list: (input) => invoke('companion:chat-sessions', input),
      get: (input) => invoke('companion:chat-session-get', input),
      create: (input) => invoke('companion:chat-session-create', input),
      append: (input) => invoke('companion:chat-session-append', input),
      rename: (input) => invoke('companion:chat-session-rename', input),
      remove: (input) => invoke('companion:chat-session-delete', input)
    })
  }),
  createJob: (input) => invoke('companion:create-job', input),
  // #110 复制：沙箱里的渲染进程不能直接写系统剪贴板，走主进程。
  writeClipboard: (text) => invoke('companion:clipboard-write', { text: String(text ?? '') }),
  // #110 会话导出：正文 + 上下文头落到 <userData>/conversations/<sessionId>.md。
  conversation: Object.freeze({
    export: (input) => invoke('companion:conversation-export', input)
  }),
  // #106 卡片壳：会话列表 / 切换 / 新建 / 重命名 / 置顶 / 软删除 / 找回。
  // 与 chat.sessions 分开，是因为卡片壳允许「不绑项目的会话」且删除是软删除。
  // #107 起多两个：#107 的「正在看的项目」是会话上的视图状态；项目列表与全局聚合只读。
  cardProjects: Object.freeze({
    list: () => invoke('companion:card-projects')
  }),
  cardScope: Object.freeze({
    globalLibrary: (input) => invoke('companion:card-global-library', input),
    // #124 关联项目：按项目读一份只读库摘要（四类资料计数），用于方法卡就地展开。
    projectLibrary: (input) => invoke('companion:card-project-library', input)
  }),
  // #131 同步状态：get 是只读；attempt 是一次显式补同步，返回 {status, result}。
  // 断网时 attempt 只更新状态，不阻塞本地读写（本地写入不经过这条通道）。
  syncStatus: Object.freeze({
    get: () => invoke('companion:sync-status-get'),
    attempt: () => invoke('companion:sync-attempt')
  }),
  cardSessions: Object.freeze({
    list: (input) => invoke('companion:card-sessions', input),
    get: (input) => invoke('companion:card-session-get', input),
    create: (input) => invoke('companion:card-session-create', input),
    rename: (input) => invoke('companion:card-session-rename', input),
    pin: (input) => invoke('companion:card-session-pin', input),
    remove: (input) => invoke('companion:card-session-soft-delete', input),
    restore: (input) => invoke('companion:card-session-restore', input),
    touch: (input) => invoke('companion:card-session-touch', input),
    view: (input) => invoke('companion:card-session-view', input),
    append: (input) => invoke('companion:card-session-append', input),
    answers: (input) => invoke('companion:card-session-answer', input)
  }),
  decide: (input) => invoke('companion:decide', input),
  patchDetail: (input) => invoke('companion:patch-detail', input),
  result: (input) => invoke('companion:result', input),
  openExternal: (url) => invoke('companion:open-external', { url }),
  projectBrief: Object.freeze({
    local: (input) => invoke('companion:project-brief-local', input)
  }),
  // #89 项目库：生成草稿与发布是两个显式动作；读取随 snapshot 一起回来。
  // #90 导出：发布时自动导出；这两个入口用于补导某一版与打开导出目录。
  // #91 发布卡片：发布时发一条飞书文本卡片；「重新发送」只有人点才发，不自动重试。
  // #92 版本浏览：只读打开某一版，diff 随详情一起回来。
  library: Object.freeze({
    draft: (input) => invoke('companion:library-draft', input),
    publish: (input) => invoke('companion:library-publish', input),
    version: (input) => invoke('companion:library-version', input),
    export: (input) => invoke('companion:library-export', input),
    openExport: (input) => invoke('companion:library-export-open', input),
    resend: (input) => invoke('companion:library-resend', input)
  }),
  // #93 删除项目：先 plan（只读列清单），确认后 run（confirm 必须为 true）。
  projectDelete: Object.freeze({
    plan: (input) => invoke('companion:project-delete-plan', input),
    run: (input) => invoke('companion:project-delete', input)
  }),
  queue: Object.freeze({
    add: (input) => invoke('companion:queue-add', input),
    update: (input) => invoke('companion:queue-update', input),
    remove: (input) => invoke('companion:queue-remove', input),
    move: (input) => invoke('companion:queue-move', input),
    dispatch: (input) => invoke('companion:queue-dispatch', input)
  }),
  // #95 灵感收件箱：列表随快照下发（view.ideas），这里只有捕获与状态流转两条写路径。
  // #96 补一条整理：抓一次链接正文并写四段，抓取结果缓存在条目上。
  // #97 补一条提升：已整理的条目 → 知识候选（假设类）或项目队列任务。
  ideas: Object.freeze({
    capture: (input) => invoke('companion:idea-capture', input),
    status: (input) => invoke('companion:idea-status', input),
    sort: (input) => invoke('companion:idea-sort', input),
    promote: (input) => invoke('companion:idea-promote', input)
  }),
  // #114 自有目录写入：判定与回执在渲染层（src/own-write.mjs），这里只提供真正写库的一步。
  // 走这条路的动作不弹确认卡；删除 / 项目目录 / 外发不从这里走（#115 / #116）。
  ownWrite: (input) => invoke('companion:own-write', input),
  // #115 项目目录同步：先算清单（只读，返回完整路径与字节数给确认卡），确认后再写。
  // 判定与会话授权在渲染层（src/project-write.mjs + write-gate）；主进程只做落盘与越界校验。
  projectSync: Object.freeze({
    plan: (input) => invoke('companion:project-sync-plan', input),
    write: (input) => invoke('companion:project-sync-write', input)
  }),
  diagrams: Object.freeze({
    dependency: (input) => invoke('companion:diagram-dependency', input),
    generate: (input) => invoke('companion:diagram-generate', input)
  }),
  github: Object.freeze({
    activity: (input) => invoke('companion:github-activity', input),
    prPreview: (input) => invoke('companion:github-pr-preview', input),
    prCreate: (input) => invoke('companion:github-pr-create', input)
  }),
  createSandbox: (input) => invoke('companion:create-sandbox', input),
  knowledge: Object.freeze({
    summary: (input) => invoke('companion:knowledge-summary', input),
    browse: (input) => invoke('companion:knowledge-browse', input),
    review: (input) => invoke('companion:knowledge-review', input),
    tidy: (input) => invoke('companion:knowledge-tidy', input),
    ask: (input) => invoke('companion:knowledge-ask', input),
    // 对话取经验：按项目再补域，只读；渲染与提示词不在这里改。
    lessons: (input) => invoke('companion:lesson-retrieve', input),
    // #58：未提炼执行记录的提议信号；#61：按项目取经验 / 一键提为候选。
    distillProposals: (input) => invoke('companion:knowledge-distill-proposals', input),
    lessonList: (input) => invoke('companion:lesson-list', input),
    promoteLesson: (input) => invoke('companion:lesson-promote', input),
    detail: (input) => invoke('companion:knowledge-detail', input),
    open: () => invoke('companion:knowledge-open')
  }),
  skills: Object.freeze({
    catalog: (input) => invoke('companion:skill-catalog', input)
  }),
  // #86 会话扫描：显式点击才跑；只读本机会话文件，不写库。
  // #87 决策：确认才入库；状态只写决策自己那一列（生效中 / 已被取代 / 已放弃）。
  memory: Object.freeze({
    scanSessions: () => invoke('companion:session-scan'),
    confirmDecision: (input) => invoke('companion:decision-confirm', input),
    setDecisionStatus: (input) => invoke('companion:decision-status', input),
    decisions: (input) => invoke('companion:decision-retrieve', input)
  }),
  playbooks: Object.freeze({
    list: (input) => invoke('companion:playbooks', input),
    run: (input) => invoke('companion:playbook-run', input),
    distill: (input) => invoke('companion:playbook-distill', input),
    cancel: (input) => invoke('companion:playbook-cancel', input),
    report: (input) => invoke('companion:playbook-report', input),
    propose: (input) => invoke('companion:playbook-propose', input)
  }),
  settings: Object.freeze({
    get: () => invoke('companion:settings:get'),
    set: (input) => invoke('companion:settings:set', input),
    addProject: () => invoke('companion:add-project')
  }),
  mobile: Object.freeze({
    info: () => invoke('companion:mobile-info'),
    refresh: () => invoke('companion:mobile-refresh')
  }),
  mascots: Object.freeze({
    list: () => invoke('companion:mascots:list'),
    set: (input) => invoke('companion:mascots:set', input),
    import: () => invoke('companion:mascots:import')
  }),
  openSkinPicker: () => ipcRenderer.send('companion:open-skin-picker'),
  diagnostics: () => invoke('companion:diagnostics'),
  sandbox: Object.freeze({
    detect: (input) => invoke('companion:sandbox-detect', input)
  }),
  openFull: () => invoke('companion:open-full'),
  showPanel: () => ipcRenderer.send('companion:show-panel'),
  hidePanel: () => ipcRenderer.send('companion:hide-panel'),
  hidePet: () => ipcRenderer.send('companion:hide-pet'),
  showPet: () => ipcRenderer.send('companion:show-pet'),
  quit: () => ipcRenderer.send('companion:quit'),
  dragStart: (input) => ipcRenderer.send('companion:drag-start', input),
  dragEnd: () => ipcRenderer.send('companion:drag-end'),
  onOpenSettings: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('companion:open-settings', listener);
    return () => ipcRenderer.removeListener('companion:open-settings', listener);
  }
}));