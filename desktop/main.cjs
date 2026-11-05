// Optional Electron desktop host. Runs loopback Workbench; starts no model.
// No remote pages, no node integration in the renderer, no project access without registration.
const {app,BrowserWindow,Tray,Menu,screen,ipcMain,nativeImage}=require('electron');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
let workbench,pet,tray,mainWindow,monitor,closing=false;
let baseUrl='';
function safeWindow(win){
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith(baseUrl+'/'))event.preventDefault();});
  win.webContents.on('will-attach-webview',event=>event.preventDefault());
}
function movePet(expanded){
  if(!pet||pet.isDestroyed())return;
  const {workArea}=screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const w=expanded?486:134,h=expanded?390:112;
  const x=Math.floor(workArea.x+workArea.width-w-20),y=Math.floor(workArea.y+workArea.height-h-26);
  pet.setBounds({x,y,width:w,height:h},true);
}
function openWorkbench(){
  if(mainWindow&&!mainWindow.isDestroyed()){mainWindow.show();mainWindow.focus();return;}
  mainWindow=new BrowserWindow({width:1140,height:800,minWidth:780,minHeight:580,title:'Owner Knowledge Workbench',
    webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,devTools:false}});
  safeWindow(mainWindow);mainWindow.loadURL(baseUrl+'/');
  mainWindow.on('closed',()=>{mainWindow=null;});
}
async function init(){
  const {createWorkbenchServer}=await import(pathToFileURL(path.resolve(__dirname,'../src/workbench-server.mjs')).href);
  workbench=await createWorkbenchServer({port:0,dbPath:process.env.OWNER_AGENT_DB});const address=await workbench.listen();baseUrl=`http://127.0.0.1:${address.port}`;
  pet=new BrowserWindow({width:134,height:112,frame:false,transparent:true,alwaysOnTop:true,skipTaskbar:true,
    resizable:false,hasShadow:false,backgroundColor:'#00000000',
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,devTools:false}});
  safeWindow(pet);movePet(false);pet.loadURL(baseUrl+'/companion.html');
  pet.on('close',event=>{if(!closing){event.preventDefault();pet.hide();}});
  const image=nativeImage.createFromPath(path.join(__dirname,'tray.png'));
  tray=new Tray(image);
  tray.setToolTip('Owner Agent · 个人项目与知识管理');
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:'显示桌宠',click:()=>pet?.show()},
    {label:'打开知识工作台',click:openWorkbench},
    {type:'separator'},{label:'退出',click:()=>{closing=true;app.quit();}}
  ]));
  tray.on('double-click',()=>pet?.show());
  const {OwnerStore}=await import(pathToFileURL(path.resolve(__dirname,'../src/owner-store.mjs')).href);
  const {OwnerResidentRuntime}=await import(pathToFileURL(path.resolve(__dirname,'../src/owner-resident.mjs')).href);
  const {Notification}=require('electron');
  const owner=new OwnerStore(process.env.OWNER_AGENT_DB);
  monitor=new OwnerResidentRuntime(owner,{onAttention:item=>{
    tray.setToolTip(`Owner Agent · ${item.title.slice(0,90)}`);
    if(process.env.OWNER_AGENT_NOTIFICATIONS==='1'&&Notification.isSupported())
      new Notification({title:'Owner Agent',body:item.title}).show();
  }});
  monitor.start();
  app.on('will-quit',()=>{monitor?.stop();owner.close();});
  ipcMain.on('owner:resize',(evt,value)=>{if(evt.sender===pet?.webContents)movePet(value===true);});
  ipcMain.on('owner:open-workbench',evt=>{if(evt.sender===pet?.webContents)openWorkbench();});
}
app.whenReady().then(init).catch(err=>{console.error('Owner desktop failed:',err);app.quit();});
app.on('window-all-closed',()=>{}); // Tray keeps resident runtime alive.
app.on('before-quit',()=>{closing=true;});
app.on('will-quit',()=>{if(workbench)void workbench.close();tray?.destroy();});
