const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('companion', Object.freeze({
  snapshot: () => invoke('companion:snapshot'),
  submit: (input) => invoke('companion:submit', input),
  createJob: (input) => invoke('companion:create-job', input),
  decide: (input) => invoke('companion:decide', input),
  patchDetail: (input) => invoke('companion:patch-detail', input),
  result: (input) => invoke('companion:result', input),
  openExternal: (url) => invoke('companion:open-external', { url }),
  github: Object.freeze({
    activity: (input) => invoke('companion:github-activity', input),
    prPreview: (input) => invoke('companion:github-pr-preview', input),
    prCreate: (input) => invoke('companion:github-pr-create', input)
  }),
  createSandbox: (input) => invoke('companion:create-sandbox', input),
  knowledge: Object.freeze({
    summary: (input) => invoke('companion:knowledge-summary', input),
    tidy: (input) => invoke('companion:knowledge-tidy', input),
    harvest: (input) => invoke('companion:knowledge-harvest', input),
    ask: (input) => invoke('companion:knowledge-ask', input),
    detail: (input) => invoke('companion:knowledge-detail', input),
    open: () => invoke('companion:knowledge-open')
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
