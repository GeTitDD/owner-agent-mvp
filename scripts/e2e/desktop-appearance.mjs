// 外观回归：真实模板、原生 IPC、宠物渲染和持久化；只替代文件选择取消与错误注入。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {startApp,connectCdp,findPanelTarget,waitFor,capture,consoleErrors} from './lib/cdp.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'owner-appearance-'));
const userData=path.join(root,'data');fs.mkdirSync(userData);
fs.writeFileSync(path.join(userData,'companion.json'),JSON.stringify({model:'',gatewayUrl:'http://127.0.0.1:1'}));
const control=path.join(root,'control.json');fs.writeFileSync(control,'{}');
const entry=path.join(root,'host.cjs');
const mainEntry=process.env.OWNER_APPEARANCE_APP_ASAR?path.join(process.env.OWNER_APPEARANCE_APP_ASAR,'desktop/main.cjs'):path.resolve(import.meta.dirname,'../../desktop/main.cjs');
fs.writeFileSync(entry,`const{ipcMain,dialog}=require('electron');const fs=require('node:fs');dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});const handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(name,handler)=>handle(name,async(event,input)=>{const f=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));if(f[name]){fs.writeFileSync(${JSON.stringify(control)},'{}');throw Error('隔离验收：外观操作暂时失败');}return handler(event,input);});require(${JSON.stringify(mainEntry)});`);
const options={userData,ownerDb:path.join(root,'owner.sqlite'),knowledgeDb:path.join(root,'knowledge.sqlite'),entry,
 env:{OWNER_AGENT_CHAT_FAKE:'0',OWNER_AGENT_WATCH_DIR:path.join(root,'watch')}};
const shots=path.resolve(process.env.SHOTS_DIR||'.verify/appearance');fs.mkdirSync(shots,{recursive:true});
let app,p,pet;let passed=false;const checks=[];
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('OK '+name);};
const evaluate=code=>p.evaluate(code);
const click=async selector=>{
 const point=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.getClientRects().length)throw Error('不可点击 '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('被遮挡 '+${JSON.stringify(selector)});return{x,y};})()`);
 await p.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await p.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
};
const shot=async name=>{await capture(p,path.join(shots,name+'.png'));check(name+' 无横向溢出且操作区可见',await evaluate("document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('#appearanceDialog').scrollWidth<=document.querySelector('#appearanceDialog').clientWidth+1&&document.querySelector('#appearanceClose').getBoundingClientRect().bottom<=innerHeight"));};
const open=async()=>{await evaluate('window.companion.openSkinPicker()');check('桌宠的皮肤选择打开真实模板选择器',await waitFor(p,"document.querySelector('#appearanceDialog')?.open",5000));check('模板读取完成',await waitFor(p,"document.querySelectorAll('[data-mascot-skin]').length>=60&&!document.querySelector('#appearanceRefresh').disabled"));};
try{
 app=await startApp(options);p=app.panel;
 check('输入区就绪',await waitFor(p,"!document.querySelector('#input').disabled"));
 await open();
 if(process.env.OWNER_APPEARANCE_APP_ASAR)check('真实打包资源包含完整前50套动画',await evaluate("(async()=>{const c=await window.companion.mascots.list();return c.skins.filter(s=>s.collection==='petdex').length===50&&c.skins.filter(s=>s.collection==='petdex').every(s=>s.url.includes('app.asar'));})()"));
 check('应用图标可解码显示',await evaluate("document.querySelector('#appearanceIcon').complete&&document.querySelector('#appearanceIcon').naturalWidth===1024"));
 check('真实内置模板六十项且默认 Petdex Boba',await evaluate("document.querySelectorAll('[data-mascot-skin]').length===60&&document.querySelector('[data-mascot-skin=petdex-01-boba]').getAttribute('aria-pressed')==='true'"));
 check('模板图片均成功解码',await waitFor(p,"[...document.querySelectorAll('#appearanceGrid img')].every(e=>e.complete&&e.naturalWidth>0)"));
 await shot('01-templates-light');
 pet=await connectCdp(await findPanelTarget(app.port,'pet.html'));
 check('桌宠默认显示下载的 Boba 动画',await waitFor(pet,"document.querySelector('#pet').dataset.skin==='petdex-01-boba'&&!document.querySelector('#sprite').hidden"));
 await capture(pet,path.join(shots,'02a-boba-pet.png'));
 const positions=new Set();for(let i=0;i<4;i+=1){positions.add(await pet.evaluate("getComputedStyle(document.querySelector('#sprite')).backgroundPosition"));await new Promise(r=>setTimeout(r,180));}
 check('下载的 Boba 动画帧实际推进',positions.size>1);
 await evaluate("(()=>{const e=document.querySelector('#appearanceSearch');e.value='#50';e.dispatchEvent(new Event('input',{bubbles:true}));})()");
 check('可按排名精确查到第50项',await evaluate("document.querySelectorAll('[data-mascot-skin]').length===1&&!!document.querySelector('[data-mascot-skin=petdex-50-anya-2]')"));
 await click('[data-mascot-skin=petdex-50-anya-2]');
 check('第50项也是真实可播放动画',await waitFor(pet,"document.querySelector('#pet').dataset.skin==='petdex-50-anya-2'&&!document.querySelector('#sprite').hidden"));
 await shot('02b-rank50-search');await capture(pet,path.join(shots,'02c-anya-pet.png'));
 await evaluate("(()=>{const e=document.querySelector('#appearanceSearch');e.value='';e.dispatchEvent(new Event('input',{bubbles:true}));})()");

 await click('[data-mascot-skin=blackcat]');
 check('桌宠实际显示原始黑猫 PNG',await waitFor(pet,"document.querySelector('#pet').dataset.skin==='blackcat'&&document.querySelector('#mascot').src.endsWith('/blackcat.png')"));
 await capture(pet,path.join(shots,'02-blackcat-pet.png'));
 await click('[data-mascot-skin=erika]');
 check('切换即时生效并写入配置',await waitFor(p,"document.querySelector('[data-mascot-skin=erika]').getAttribute('aria-pressed')==='true'&&!document.querySelector('#appearanceRefresh').disabled")&&JSON.parse(fs.readFileSync(path.join(userData,'companion.json'),'utf8')).mascotSkin==='erika');
 check('宠物窗口同步切换 Erika 模板',await waitFor(pet,"document.querySelector('#pet').dataset.skin==='erika'&&document.querySelector('#mascot').src.endsWith('/erika.png')"));
 await capture(pet,path.join(shots,'03-erika-pet.png'));await shot('04-erika-selected');
 fs.writeFileSync(control,JSON.stringify({'companion:mascots:set':true}));await click('[data-mascot-skin=muffin]');
 check('切换失败保留已选模板并给原因',await waitFor(p,"document.querySelector('#appearanceStatus').dataset.tone==='error'&&!document.querySelector('#appearanceRefresh').disabled")&&await evaluate("document.querySelector('[data-mascot-skin=erika]').getAttribute('aria-pressed')==='true'"));
 await shot('05-selection-error');
 await click('#appearanceImport');
 check('取消导入保留原模板',await waitFor(p,"!document.querySelector('#appearanceRefresh').disabled")&&JSON.parse(fs.readFileSync(path.join(userData,'companion.json'),'utf8')).mascotSkin==='erika');
 fs.writeFileSync(control,JSON.stringify({'companion:mascots:list':true}));await click('#appearanceRefresh');
 check('读取失败可原位重试',await waitFor(p,"document.querySelector('#appearanceStatus').dataset.tone==='error'&&!document.querySelector('#appearanceRefresh').disabled"));
 await click('#appearanceRefresh');check('重试恢复模板列表',await waitFor(p,"document.querySelector('#appearanceStatus').dataset.tone!=='error'&&!document.querySelector('#appearanceRefresh').disabled"));
 await p.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]});await shot('06-templates-dark');
 await p.send('Emulation.setDeviceMetricsOverride',{width:380,height:560,deviceScaleFactor:1,mobile:false});await shot('07-small-window');
 await click('#appearanceClose');
 await evaluate("(()=>{const i=document.querySelector('#input');i.value='外观切换期间的多行草稿\\n不能丢';i.dispatchEvent(new Event('input',{bubbles:true}));})()");
 await click('#configToggle');await click('#appearanceOpen');
 check('配置箱也能打开模板选择',await waitFor(p,"document.querySelector('#appearanceDialog').open"));await click('#appearanceClose');check('关闭外观后底层配置仍保留',await waitFor(p,"!document.querySelector('#configBox').hidden&&!document.querySelector('#configClose').disabled"));await click('#configClose');
 check('打开关闭外观不丢草稿',await evaluate("document.querySelector('#input').value==='外观切换期间的多行草稿\\n不能丢'"));
 await app.stop();pet.close();pet=null;app=await startApp(options);p=app.panel;await open();
 check('重启保留选择与多行草稿',await evaluate("document.querySelector('[data-mascot-skin=erika]').getAttribute('aria-pressed')==='true'&&document.querySelector('#input').value.includes('不能丢')"));
 check('无渲染错误',consoleErrors(p).length===0);passed=true;
}finally{
 pet?.close();await app?.stop();fs.writeFileSync(path.join(shots,'acceptance.json'),JSON.stringify({passed,checks,root,modelCalls:0,screenshots:fs.readdirSync(shots).filter(f=>f.endsWith('.png'))},null,2));console.log(`${passed?'PASS':'FAIL'} ${checks.length} checks; ${shots}`);
}
