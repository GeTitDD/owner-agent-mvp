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
  decide: (input) => invoke('companion:decide', input),
  patchDetail: (input) => invoke('companion:patch-detail', input),
  result: (input) => invoke('companion:result', input),
  openExternal: (url) => invoke('companion:open-external', { url }),
  projectBrief: Object.freeze({
    local: (input) => invoke('companion:project-brief-local', input)
  }),
  queue: Object.freeze({
    add: (input) => invoke('companion:queue-add', input),
    update: (input) => invoke('companion:queue-update', input),
    remove: (input) => invoke('companion:queue-remove', input),
    move: (input) => invoke('companion:queue-move', input),
    dispatch: (input) => invoke('companion:queue-dispatch', input)
  }),
  // #95 灵感收件箱：列表随快照下发（view.ideas），这里只有捕获与状态流转两条写路径。
  ideas: Object.freeze({
    capture: (input) => invoke('companion:idea-capture', input),
    status: (input) => invoke('companion:idea-status', input)
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
