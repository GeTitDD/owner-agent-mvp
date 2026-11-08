const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('companion', Object.freeze({
  snapshot: () => invoke('companion:snapshot'),
  createJob: (input) => invoke('companion:create-job', input),
  decide: (input) => invoke('companion:decide', input),
  patchDetail: (input) => invoke('companion:patch-detail', input),
  result: (input) => invoke('companion:result', input),
  createSandbox: (input) => invoke('companion:create-sandbox', input),
  knowledge: Object.freeze({
    summary: () => invoke('companion:knowledge-summary'),
    ask: (input) => invoke('companion:knowledge-ask', input),
    detail: (input) => invoke('companion:knowledge-detail', input),
    open: () => invoke('companion:knowledge-open')
  }),
  settings: Object.freeze({
    get: () => invoke('companion:settings:get'),
    set: (input) => invoke('companion:settings:set', input),
    addProject: () => invoke('companion:add-project')
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
