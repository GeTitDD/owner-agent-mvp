const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('ownerDesktop',Object.freeze({
  resize:expanded=>ipcRenderer.send('owner:resize',expanded===true),
  openWorkbench:()=>ipcRenderer.send('owner:open-workbench')
}));
