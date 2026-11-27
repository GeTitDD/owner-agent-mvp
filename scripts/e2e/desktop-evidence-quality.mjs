// 真实 Electron / 工作台 / SQLite / SDK；只用隔离数据与本机模型协议验证证据和计量边界。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { OwnerStore } from '../../src/owner-store.mjs';
import { PersonalKnowledgeStore } from '../../src/personal-store.mjs';
import { ChatSessionStore } from '../../src/chat-sessions.mjs';
import { promoteIdeaToLesson } from '../../src/idea-lesson.mjs';
import { createWorkbenchServer } from '../../src/workbench-server.mjs';
import { startApp, waitFor, capture, sleep, consoleErrors } from './lib/cdp.mjs';
import { startModelFixture, seedModelFixture } from './lib/model-fixture.mjs';

const repo=path.resolve(import.meta.dirname,'../..');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'owner-evidence-quality-'));
const shots=path.resolve(process.env.SHOTS_DIR||path.join(repo,'.verify/evidence-quality'));fs.mkdirSync(shots,{recursive:true});
// 每次重放只保留本轮失败截图，避免前一次失败混入成功验收清单。
fs.rmSync(path.join(shots,'failure.png'),{force:true});
const ownerDb=path.join(root,'owner.sqlite'),knowledgeDb=path.join(root,'knowledge.sqlite'),userData=path.join(root,'data');fs.mkdirSync(userData);
const owner=new OwnerStore(ownerDb),personal=new PersonalKnowledgeStore(knowledgeDb),chats=new ChatSessionStore({db:owner.db});
for(const id of ['a','b']){const cwd=path.join(root,id);fs.mkdirSync(cwd);fs.writeFileSync(path.join(cwd,'README.md'),'# 只读验收项目\n');owner.registerProject({id,name:`项目 ${id} · 并发状态写回与跨进程适用边界的中文长名称`,root:cwd,primaryDomain:'software-engineering'});}
const sessionId=chats.createSession({projectId:'a',title:'证据与引用计量'}).id;chats.markOpened(sessionId);
const ideaLessons=[];
for(const projectId of ['a','b']){
 const idea=owner.addIdeaItem({projectId,title:'同一人工想法',rawText:`项目 ${projectId}：人工观察被重复记录不能变成事实复现`});
 const result=promoteIdeaToLesson({store:owner,personalStore:personal,id:idea.id,projectId,edits:{phenomenon:'相同人工观察',mechanism:'尚未独立核验',countermeasure:'先查证据'}});
 assert.ok(result.ok,result.reason);ideaLessons.push(result.lesson.id);
 // 模拟历史版本写入的错误徽章；应用必须在读取时纠正，不能要求人逐条重建经验。
 personal.db.prepare("UPDATE knowledge_lessons SET payload=json_set(payload,'$.reproduced',json('true'),'$.supportProjects',2) WHERE id=?").run(result.lesson.id);
}
const factLessons=[];
for(const projectId of ['a','b'])factLessons.push(personal.recordLessonOrDispute({projectId,sourceRecordId:`sandbox:fixture-${projectId}`,
 phenomenon:'独立执行观察到同一现象',mechanism:'各项目独立失败',countermeasure:projectId==='a'?'同进程排队':'跨进程 CAS',
 scope:{layer:'project',projectId,domainIds:[]},verificationStatus:'unverified',evidenceRefs:[`sandbox:fixture-${projectId}`]},
 {evidence:[{recordId:`sandbox:fixture-${projectId}`,ref:`sandbox:fixture-${projectId}`,kind:'record',excerpt:'隔离夹具中的独立终态执行摘要'}]}).id);
const boundary='跨进程还需独立互斥或 CAS，不能把 Promise 队列当跨进程锁';
const unit=personal.create({title:'并发状态写回：长中文标题保留进程内串行与跨进程互斥的不同适用边界',content:'同进程短读改写排队；'+boundary,
 kind:'claim',layer:'project',scope:'project',projectId:'a',domains:[],tags:[],evidenceRefs:[],verificationStatus:'unverified'});
const empty=personal.create({...unit,title:'尚未引用的隔离样例',content:'此条没有引用或执行记录'});
// 用固定夹具覆盖“任务成功但收益未知”的展示，不把本机模型夹具当成收益实验。
personal.addUsage({knowledgeId:unit.id,revision:1,targetRunId:'fixture-task-success',projectId:'a',contextSnapshotId:'fixture-context',outcome:'succeeded',observedBenefit:'unknown'});
const model=await startModelFixture();const piHome=path.join(root,'pi');seedModelFixture(path.join(piHome,'agent'),model.baseUrl);
fs.writeFileSync(path.join(userData,'companion.json'),JSON.stringify({model:'fixture-local/check',gatewayUrl:'http://127.0.0.1:1',pstackSkills:path.join(root,'empty'),mattSkills:path.join(root,'empty')}));
const options={userData,ownerDb,knowledgeDb,env:{OWNER_AGENT_CHAT_FAKE:'0',OWNER_AGENT_PI_HOME:piHome,OWNER_AGENT_WATCH_DIR:path.join(root,'watch')}};
let app,p,web,workbench,passed=false;const checks=[];
const check=(label,value)=>{assert.ok(value,label);checks.push(label);console.log('OK '+label);};
const evaluate=expression=>p.evaluate(expression);
const click=async selector=>{const point=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.getClientRects().length)throw Error('不可点击 '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('被遮挡 '+${JSON.stringify(selector)});return{x,y};})()`);for(const type of ['mousePressed','mouseReleased'])await p.send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});};
const fill=async text=>{await click('#input');await evaluate("document.querySelector('#input').select()");await p.send('Input.insertText',{text});};
const send=async text=>{const before=await evaluate("document.querySelectorAll('#messages .msg').length");await fill(text);await click('#send');check('本轮完成或明确失败',await waitFor(p,`document.querySelectorAll('#messages .msg').length>${before+1}&&document.querySelector('#send').textContent==='发送'`,20000));};
const shot=async name=>{await sleep(150);await capture(p,path.join(shots,name+'.png'));check(name+' 无页面横向溢出',await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));};
const refs=()=>personal.listChatReferences({knowledgeId:unit.id});
try{
 app=await startApp(options);p=app.panel;check('桌面输入可用',await waitFor(p,"!document.querySelector('#input').disabled"));
 await send('/经验 并发状态');check('只检索不计完成对话引用',refs().length===0&&model.requests.length===0);await shot('01-retrieval-no-count');
 await send('并发状态写回怎么处理？');check('实际请求包含同版知识与适用边界',JSON.stringify(model.requests.at(-1).body.messages).includes(`[knowledge:${unit.id}@1]`)&&JSON.stringify(model.requests.at(-1).body.messages).includes(boundary));
 check('成功对话保存一条引用且不增加任务 Usage',refs().length===1&&refs()[0].revision===1&&personal.listUsages({knowledgeId:unit.id}).length===1);
 check('发送后清空本轮输入，不把原问题误当流式插入草稿',await evaluate("document.querySelector('#input').value===''") );
 check('界面明确引用不代表采纳或收益',await evaluate("document.querySelector('#messages').innerText.includes('已记录本轮完成对话引用')"));await shot('02-completed-reference');
 await p.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]});await shot('02b-completed-reference-dark');await p.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});
 await p.send('Page.reload');check('重载保留回执且不重复计数',await waitFor(p,"document.querySelector('#messages').innerText.includes('已记录本轮完成对话引用')")&&refs().length===1);
 model.setMode('auth');await send('并发状态写回再次核对');check('模型失败不增加引用',refs().length===1);await shot('03-model-error-no-count');
 model.setMode('slow');await fill('并发状态写回取消验收');await click('#send');check('回答中可以停止',await waitFor(p,"document.querySelector('#send').textContent==='停止'&&document.querySelector('#input').value===''&&document.querySelector('[data-streaming=true]')?.textContent.includes('模型连接正常')"));await click('#send');check('取消后可继续输入',await waitFor(p,"document.querySelector('#send').textContent==='发送'"));check('取消后仍保留本轮已流出的正文',await waitFor(p,"document.querySelector('#messages .msg:last-child')?.innerText.includes('模型连接正常')&&document.querySelector('#messages .msg:last-child')?.innerText.includes('已停止')"));check('取消不增加引用',refs().length===1);await shot('04-canceled-no-count');model.setMode('ok');
 personal.db.exec("CREATE TRIGGER fixture_reference_failure BEFORE INSERT ON knowledge_chat_references BEGIN SELECT RAISE(FAIL,'fixture disk failure'); END;");
 await send('并发状态写回记录故障验收');check('计量保存失败仍保留回答并诚实说明',await evaluate("document.querySelector('#messages .msg:last-child').innerText.includes('引用记录未保存')&&document.querySelector('#messages .msg:last-child').innerText.includes('模型连接正常')")&&refs().length===1);await shot('05-reference-save-error');
 personal.db.exec('DROP TRIGGER fixture_reference_failure');
 check('桌面控制台无异常',consoleErrors(p).length===0);await app.stop();app=null;
 app=await startApp(options);p=app.panel;check('重启仍只有一条完成引用',await waitFor(p,"!document.querySelector('#input').disabled")&&refs().length===1);await app.stop();app=null;
 workbench=await createWorkbenchServer({port:0,personalDbPath:knowledgeDb,ownerDbPath:ownerDb});const address=await workbench.listen();const base=`http://127.0.0.1:${address.port}`;
 // 仓库应用的完整工作台页面由隔离 Electron 正常加载，不以静态 HTML 代替实际渲染。
 const entry=path.join(root,'workbench-preview.cjs');fs.writeFileSync(entry,`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({width:1180,height:880,show:false,webPreferences:{contextIsolation:true,sandbox:true}});w.loadURL(${JSON.stringify(base)});});`);
 web=await startApp({...options,userData:path.join(root,'workbench-data'),entry,page:base});p=web.panel;
 check('工作台实际页面加载',await waitFor(p,"!!document.querySelector('[data-tab=knowledge]')"));await click('[data-tab=knowledge]');
 await waitFor(p,`!!document.querySelector('.knowledge-item[data-id="${unit.id}"]')`);await click(`.knowledge-item[data-id="${unit.id}"]`);
 check('知识详情异步读取完成后可操作',await waitFor(p,"!!document.querySelector('[data-detail-tab=usage]')"));await click('[data-detail-tab=usage]');
 check('工作台分开显示完成对话引用与任务记录',await waitFor(p,"document.querySelector('#usagePanel')?.innerText.includes('已完成对话引用 · 1 条')&&document.querySelector('#usagePanel')?.innerText.includes('任务上下文复用 · 1 条')"));
 check('成功任务仍显示收益未知',await evaluate("document.querySelector('#usagePanel').innerText.includes('任务结果：成功 · 复用收益：未知')"));await shot('06-workbench-reference-and-task');
 await p.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]});await shot('07-workbench-dark');
 await p.send('Emulation.setDeviceMetricsOverride',{width:900,height:900,deviceScaleFactor:1,mobile:false});await evaluate("document.querySelector('#usagePanel').scrollIntoView({block:'center'})");await shot('07b-workbench-narrow');await p.send('Emulation.clearDeviceMetricsOverride');
 await click(`.knowledge-item[data-id="${empty.id}"]`);check('空态解释哪些情况不计量',await waitFor(p,"document.querySelector('#usagePanel')?.innerText.includes('只检索、未注入、失败或取消均不计入')"));await shot('08-reference-empty');
 await p.send('Page.navigate',{url:base+'/lessons'});check('经验页面读取真实存储',await waitFor(p,`!!document.getElementById('lesson-${ideaLessons[0]}')`));
 check('历史灵感误标已消失，独立执行仍标已复现',await evaluate(`!document.getElementById('lesson-${ideaLessons[0]}').querySelector('.badge-reproduced')&&!document.getElementById('lesson-${ideaLessons[1]}').querySelector('.badge-reproduced')&&!!document.getElementById('lesson-${factLessons[0]}').querySelector('.badge-reproduced')&&!!document.getElementById('lesson-${factLessons[1]}').querySelector('.badge-reproduced')`));
 await p.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});await shot('09-reproduction-evidence');
 await evaluate(`document.getElementById('lesson-${ideaLessons[0]}').scrollIntoView({block:'center'})`);await shot('10-idea-provenance-no-reproduction');
 check('经验状态与范围未被复现标记改变',factLessons.every(id=>personal.getLesson(id).verificationStatus==='unverified'&&personal.getLesson(id).scope.layer==='project')&&ideaLessons.every(id=>personal.getLesson(id).verificationStatus==='inferred'));
 check('工作台控制台无异常',consoleErrors(p).length===0);passed=true;
}catch(error){if(p){await capture(p,path.join(shots,'failure.png')).catch(()=>{});console.error(await evaluate("JSON.stringify({input:document.querySelector('#input')?.value,button:document.querySelector('#send')?.textContent,stream:document.querySelector('[data-streaming=true]')?.innerText,last:document.querySelector('#messages .msg:last-child')?.innerText})").catch(()=>''));}throw error;}
finally{
 if(app)await app.stop();if(web)await web.stop();if(workbench)await workbench.close();
 fs.writeFileSync(path.join(shots,'acceptance.json'),JSON.stringify({passed,checks,root,model:'installed SDK + loopback HTTP/SSE; fixed answers; no adoption or benefit claim',screenshots:fs.readdirSync(shots).filter(x=>x.endsWith('.png'))},null,2));
 await model.close();owner.close();personal.close();console.log('Evidence '+shots);console.log('Isolated data '+root);
}
