// 自带技能开箱即用：没有个人技能安装的 HOME，真实应用/IPC/SDK，仅模型回复为本机夹具。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startApp, waitFor, capture, consoleErrors } from './lib/cdp.mjs';
import { startModelFixture, seedModelFixture } from './lib/model-fixture.mjs';
import { skillBodyOf } from '../../src/knowledge/chat-catalog.mjs';
import { bundledPstackSkills, bundledMattSkills } from '../../src/bundled-skills.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'owner-bundled-skills-'));
const userData=path.join(root,'data');fs.mkdirSync(userData);
const shots=path.resolve(process.env.SHOTS_DIR||'.verify/bundled-skills');fs.mkdirSync(shots,{recursive:true});
const server=await startModelFixture();
const piHome=path.join(root,'pi');seedModelFixture(path.join(piHome,'agent'),server.baseUrl);
fs.writeFileSync(path.join(userData,'companion.json'),JSON.stringify({model:'fixture-local/check',gatewayUrl:'http://127.0.0.1:1'}));
const options={userData,ownerDb:path.join(root,'owner.sqlite'),knowledgeDb:path.join(root,'knowledge.sqlite'),
  ...(process.env.OWNER_BUNDLED_APP_ASAR?{entry:process.env.OWNER_BUNDLED_APP_ASAR}:{}),
  env:{OWNER_AGENT_PI_HOME:piHome,OWNER_AGENT_CHAT_FAKE:'0',OWNER_AGENT_LOCAL_SKILLS_DIR:'',
    HOME:path.join(root,'home-without-skills'),CODEX_HOME:path.join(root,'no-codex'),
    PSTACK_DIR:'',MATT_SKILLS_DIR:'',OWNER_AGENT_WATCH_DIR:path.join(root,'watch')}};
let app,p;let passed=false;const checks=[];
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('OK '+name);};
const evaluate=code=>p.evaluate(code);
const click=async selector=>{
  const point=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.getClientRects().length)throw Error('不可点击');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('被遮挡');return{x,y};})()`);
  await p.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
  await p.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
};
const fill=async text=>{await click('#input');await evaluate("document.querySelector('#input').select()");await p.send('Input.insertText',{text});};
const shot=async name=>{await capture(p,path.join(shots,name+'.png'));check(name+' 无横向溢出',await evaluate("document.documentElement.scrollWidth<=innerWidth+1&&[...document.querySelectorAll('.slash-item,#skillChip,#composer')].filter(e=>e.getClientRects().length).every(e=>e.scrollWidth<=e.clientWidth+1)"));};
try{
  app=await startApp(options);p=app.panel;
  check('没有个人技能安装仍能启动',await waitFor(p,"!document.querySelector('#input').disabled"));
  const catalog=await evaluate('window.companion.skills.catalog({refresh:true})');
  const pstack=catalog.items.filter(i=>i.source==='pstack'&&i.callable);
  const matt=catalog.items.filter(i=>i.source==='matt'&&i.callable);
  check('pstack 53 项技能全部来自随包资源',pstack.length===53&&pstack.every(i=>i.distribution==='bundled'));
  check('Matt Pocock 39 项技能全部来自随包资源',matt.length===39&&matt.every(i=>i.distribution==='bundled'));
  check('没有自动扫描本机技能',!catalog.items.some(i=>i.source==='local'));
  check('不把技能包路径保存为用户机器绝对路径',!JSON.parse(fs.readFileSync(path.join(userData,'companion.json'),'utf8')).pstackSkills);
  if(process.env.OWNER_BUNDLED_APP_ASAR)check('打包后的资源从 app.asar 内加载',pstack.every(i=>i.path.includes('app.asar'))&&matt.every(i=>i.path.includes('app.asar')));

  await fill('/');
  check('内置命令与技能有不同分区',await waitFor(p,"document.querySelector('#skillList').textContent.includes('应用命令')&&document.querySelector('#skillList').textContent.includes('全部技能')"));
  check('默认收起中文命令，优先看到真实技能',await evaluate("!document.querySelector('.slash-item[data-kind=builtin]')&&document.querySelector('[data-builtin-toggle]').getAttribute('aria-expanded')==='false'"));
  await shot('01-commands-and-skills');
  await click('[data-builtin-toggle]');
  check('可展开应用命令，类型标注明确',await evaluate("document.querySelectorAll('.slash-item[data-kind=builtin]').length===13&&[...document.querySelectorAll('.slash-item[data-kind=builtin] .slash-src')].every(e=>e.textContent==='应用命令')"));
  await shot('01b-expanded-commands');
  await fill('/tdd');
  check('同名技能保留两个来源',await waitFor(p,"!!document.querySelector('[data-skill-row=\"pstack:tdd\"]')&&!!document.querySelector('[data-skill-row=\"matt:engineering/tdd\"]')"));
  check('来源与应用内置状态可见',await evaluate("document.querySelector('[data-skill-row=\"pstack:tdd\"]').textContent.includes('应用内置')&&document.querySelector('[data-skill-row=\"matt:engineering/tdd\"]').textContent.includes('Matt Pocock')"));
  await shot('02-sources-same-name');
  await fill('/tdd 不可猜测来源');await click('#send');
  check('同名短名不猜测、不发模型请求',server.requests.length===0&&await evaluate("document.querySelector('#input').value==='/tdd 不可猜测来源'"));

  const targets=[
    {id:'pstack:tdd',source:'pstack',file:path.join(bundledPstackSkills,'tdd','SKILL.md')},
    {id:'matt:engineering/domain-modeling',source:'Matt Pocock',file:path.join(bundledMattSkills,'engineering','domain-modeling','SKILL.md')}
  ];
  for(const [index,target] of targets.entries()){
    await fill('/'+target.id);
    check(target.source+' 技能可在 slash 中找到',await waitFor(p,`!!document.querySelector('[data-skill-row="${target.id}"]')`));
    await click(`[data-skill-row="${target.id}"]`);
    check(target.source+' 选择后高亮且不自动发送',await evaluate(`!document.querySelector('#skillChip').hidden&&document.querySelector('#skillChipLabel').title===${JSON.stringify(target.id)}`)&&server.requests.length===index);
    await fill('请按这个技能的方法分析问题。\n保留中文多行问题。');
    await shot(index===0?'03-pstack-selected':'04-matt-selected');
    if(index===1){await p.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]});await shot('05-matt-dark');await p.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});}
    await click('#send');
    check(target.source+' 经真实 SDK 完成请求',await waitFor(p,`document.querySelector('#send').textContent==='发送'&&document.querySelector('#messages').textContent.includes(${JSON.stringify('技能：'+target.id)})`,15000));
    const message=server.requests.at(-1)?.body.messages.filter(m=>m.role==='user').at(-1);
    const body=typeof message?.content==='string'?message.content:(message?.content||[]).map(part=>part.text||'').join('\n');
    const marker=skillBodyOf(fs.readFileSync(target.file,'utf8')).slice(0,120);
    check(target.source+' 请求包含确切身份与随包正文',body.includes('【指定技能 '+target.id+'】')&&body.includes(marker));
    check(target.source+' 发送后的消息保留来源标签',await evaluate(`!!document.querySelector('.skill-message-chip[data-skill-id="${target.id}"]')`));
  }
  check('只发生两次本机协议请求，没有后台自动调用',server.requests.length===2);
  await shot('06-sent-bundled-skills');
  check('无渲染错误',consoleErrors(p).length===0);
  passed=true;
}finally{
  await app?.stop();await server.close();
  fs.writeFileSync(path.join(shots,'acceptance.json'),JSON.stringify({passed,checks,root,requests:server.requests.length,realProvider:false,packaged:!!process.env.OWNER_BUNDLED_APP_ASAR,screenshots:fs.readdirSync(shots).filter(f=>f.endsWith('.png'))},null,2));
  console.log(`${passed?'PASS':'FAIL'} ${checks.length} checks; ${shots}`);
}
