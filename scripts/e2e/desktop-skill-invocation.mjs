// 回归手输 slash 未绑定技能：真实界面、IPC、存储、SDK；仅模型回复为本机夹具。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { OwnerStore } from '../../src/owner-store.mjs';
import { ChatSessionStore } from '../../src/chat-sessions.mjs';
import { startApp, capture, consoleErrors, waitFor } from './lib/cdp.mjs';
import { startModelFixture, seedModelFixture } from './lib/model-fixture.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-skill-invocation-'));
const shots = path.resolve(process.env.SHOTS_DIR || '.verify/skill-invocation');
fs.mkdirSync(shots, { recursive: true });
const userData = path.join(root, 'data');
fs.mkdirSync(userData);
const local = path.join(root, 'agents-skills');
const other = path.join(root, 'codex-skills');
const writeSkill = (dir, name, body) => {
  const folder = path.join(dir, name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: 本机验收技能，保留完整来源。\n---\n${body}`);
};
writeSkill(local, 'domain-modeling', '# 领域建模\nLOCAL-DOMAIN-SENTINEL\n按领域术语核对当前问题。');
writeSkill(local, 'same', '# 本机来源 A\nONLY-A-SENTINEL');
writeSkill(other, 'same', '# 本机来源 B\nONLY-B-SENTINEL');
writeSkill(local, 'unavailable', '');
const longName = 'long-local-skill-name-for-multiline-chinese-layout-acceptance';
writeSkill(local, longName, '# 长名称方法\nLONG-SKILL-SENTINEL');
const model = await startModelFixture();
const piHome = path.join(root, 'pi');
seedModelFixture(path.join(piHome, 'agent'), model.baseUrl);
fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({ model: 'fixture-local/check', gatewayUrl: 'http://127.0.0.1:1', pstackSkills:path.join(root,'empty-pstack'), mattSkills:path.join(root,'empty-matt') }));
const ownerDb = path.join(root, 'owner.sqlite');
const owner = new OwnerStore(ownerDb);
const chats = new ChatSessionStore({ db: owner.db });
const a = chats.createSession({ title: '手输技能验收 Alpha' }).id;
const b = chats.createSession({ title: '独立草稿 Beta' }).id;
chats.markOpened(a);
// 仅延迟真实目录响应，稳定重现「刚输入就发送」时两个异步入口的竞争。
const delayFile = path.join(root, 'catalog-delay.json');
fs.writeFileSync(delayFile, '0');
const entry = path.join(root, 'host.cjs');
fs.writeFileSync(entry, `const {ipcMain}=require('electron');const fs=require('node:fs');const handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(name,handler)=>handle(name,async(event,input)=>{if(name==='companion:skill-catalog'){const delay=JSON.parse(fs.readFileSync(${JSON.stringify(delayFile)},'utf8'));if(delay){fs.writeFileSync(${JSON.stringify(delayFile)},'0');await new Promise(resolve=>setTimeout(resolve,delay));}}return handler(event,input);});require(${JSON.stringify(path.resolve(import.meta.dirname,'../../desktop/main.cjs'))});`);
const options = { userData, ownerDb, entry, knowledgeDb: path.join(root, 'knowledge.sqlite'), env: {
  OWNER_AGENT_CHAT_FAKE: '0', OWNER_AGENT_PI_HOME: piHome,
  OWNER_AGENT_LOCAL_SKILLS_DIR: [local, other].join(path.delimiter), OWNER_AGENT_WATCH_DIR: path.join(root, 'watch')
} };
let app; let p; let passed = false;
const checks = [];
const check = (label, condition) => { assert.ok(condition, label); checks.push(label); console.log('OK ' + label); };
const evaluate = code => p.evaluate(code);
const click = async selector => {
  const point = await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.getClientRects().length)throw Error('不可点击');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('按钮被遮挡');return{x,y};})()`);
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
};
const fill = async text => { await click('#input'); await evaluate("document.querySelector('#input').select()"); await p.send('Input.insertText', { text }); };
const key = async value => {
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code: value, ...(value === 'Enter' ? {text:'\r',windowsVirtualKeyCode:13} : {}) });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code: value });
};
const chip = () => evaluate("document.querySelector('#skillChipLabel').title");
const text = () => evaluate("document.querySelector('#input').value");
const ready = async () => check('输入区就绪', await waitFor(p, "!document.querySelector('#input').disabled"));
const selectSession = async id => {
  if (await evaluate("document.querySelector('#sessionPopover').hidden")) await click('#sessionToggle');
  await click(`.session-row[data-id="${id}"] [data-act="switch"]`);
  check('切换到指定会话', await waitFor(p, `document.querySelector('#sessionList [data-current=true]')?.dataset.id===${JSON.stringify(id)}&&!document.querySelector('#input').disabled`));
  if (!await evaluate("document.querySelector('#sessionPopover').hidden")) await click('#sessionToggle');
};
const shot = async name => {
  await capture(p, path.join(shots, name + '.png'));
  check(name + '：高亮与取消按钮可见，无横向溢出', await evaluate("document.documentElement.scrollWidth<=innerWidth+1&&[...document.querySelectorAll('#skillChip,#composer,.skill-message-chip')].filter(e=>e.getClientRects().length).every(e=>e.scrollWidth<=e.clientWidth+1)"));
};
const latestRequest = () => {
  const message = model.requests.at(-1)?.body.messages.filter(item => item.role === 'user').at(-1);
  return typeof message?.content === 'string' ? message.content : (message?.content || []).map(item => item.text || '').join('\n');
};
const send = async id => {
  const count = model.requests.length;
  await click('#send');
  check('请求经真实 SDK 返回', await waitFor(p, `document.querySelector('#send').textContent==='发送'&&!![...document.querySelectorAll('.skill-message-chip')].find(e=>e.dataset.skillId===${JSON.stringify(id)})`, 15000));
  check('明确发送只发一次模型请求', model.requests.length === count + 1);
  check('请求包含所选技能的完整身份', latestRequest().includes('【指定技能 ' + id + '】'));
};
try {
  app = await startApp(options); p = app.panel; await ready();
  await fill('/domain-modeling 第一行中文问题\n第二行保留原文');
  check('冷启动粘贴命令自动选中并高亮', await waitFor(p, "!document.querySelector('#skillChip').hidden&&document.querySelector('#skillChipLabel').textContent.includes('/domain-modeling')"));
  const id = await chip();
  check('绑定本机完整身份，正文保留多行', id.startsWith('local:') && await text() === '第一行中文问题\n第二行保留原文');
  check('选择不自动请求模型', model.requests.length === 0);
  check('技能标签颜色区别于普通正文', await evaluate("getComputedStyle(document.querySelector('#skillChipLabel')).color!==getComputedStyle(document.querySelector('#input')).color"));
  await shot('01-typed-skill-light');
  await p.send('Emulation.setEmulatedMedia', { features: [{name:'prefers-color-scheme',value:'dark'}] });
  await shot('02-typed-skill-dark');
  await p.send('Emulation.setEmulatedMedia', { features: [{name:'prefers-color-scheme',value:'light'}] });
  await send(id);
  check('请求包含正确的本机正文与多行问题', latestRequest().includes('LOCAL-DOMAIN-SENTINEL') && latestRequest().includes('第二行保留原文'));
  check('技能标记持久化到用户消息', chats.getSession(a).messages.find(m=>m.role==='user').blocks.some(block=>block.title==='本轮指定技能'));
  check('消息中技能与普通正文分离显示', await evaluate("document.querySelector('.msg.user .bubble').textContent.includes('第一行中文问题')&&!document.querySelector('.msg.user .bubble').textContent.includes('/domain-modeling')"));
  await shot('03-sent-skill');

  await fill('/domain-modeling');
  check('菜单列出本机可用技能', await waitFor(p, `!!document.querySelector('[data-skill-row="${id}"]')`));
  await key('Enter');
  check('回车选择只显示标签，不发空问题', await chip() === id && await text() === '' && model.requests.length === 1);
  await fill('取消技能后应作为普通文字保留\n第二行');
  await click('#skillChipClear');
  check('取消技能只移除标签，保留问题', await chip() === '' && (await text()).includes('第二行'));
  await fill('/domain-modeling');
  await p.send('Input.insertText', { text: ' ' });
  check('逐步手输空格也自动高亮', await waitFor(p, "!document.querySelector('#skillChip').hidden&&document.querySelector('#input').value===''"));
  await fill('Alpha 选中技能的独立草稿\n多行内容');
  await selectSession(b);
  check('技能不会串入另一会话', await chip() === '');
  await fill('Beta 普通草稿');
  await selectSession(a);
  check('原会话恢复技能及原文', await chip() === id && (await text()).includes('Alpha 选中技能'));
  await app.stop(); app = await startApp(options); p = app.panel; await ready();
  check('重启后恢复技能身份与草稿', await waitFor(p, "!document.querySelector('#skillChip').hidden") && await chip() === id && (await text()).includes('Alpha 选中技能'));
  check('重放消息仍然高亮原技能', await evaluate(`!!document.querySelector('.skill-message-chip[data-skill-id="${id}"]')`));
  await click('#skillChipClear');

  await fill('');
  await evaluate("(()=>{const e=document.querySelector('#input');e.value='/domain-modeling 组字未提交';e.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,inputType:'insertCompositionText'}));})()");
  check('中文组字期间不搬动正文或错误绑定', await chip() === '' && (await text()).startsWith('/domain-modeling'));
  await evaluate("document.querySelector('#input').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))");
  check('组字提交后再绑定技能，正文不丢', await chip() === id && await text() === '组字未提交');
  await click('#skillChipClear');

  const before = model.requests.length;
  await fill('/no-such-local-skill 问题不能丢'); await click('#send');
  check('未知 slash 不静默变成普通模型问题', model.requests.length === before && await text() === '/no-such-local-skill 问题不能丢');
  check('未知命令有明确提示', await evaluate("!document.querySelector('#toast').hidden&&document.querySelector('#toast').textContent.includes('没有找到')"));
  await shot('04-unknown-skill');
  await fill('/same 同名技能不能猜测'); await click('#send');
  check('同名来源未明确时保留正文且不发送', await chip() === '' && model.requests.length === before && (await text()).startsWith('/same'));
  await fill('/unavailable 不能使用空正文'); await click('#send');
  check('禁用技能不能显示成已选高亮或调用模型', await chip() === '' && model.requests.length === before);

  const catalog = await evaluate('window.companion.skills.catalog({})');
  const target = catalog.items.find(item=>item.commandName==='same'&&item.path.startsWith(local));
  await fill('/' + target.id + '\n按精确来源调用');
  check('完整身份加换行绑定精确来源', await waitFor(p, `document.querySelector('#skillChipLabel').title===${JSON.stringify(target.id)}`));
  check('选中有效技能后撤下上一条技能错误提示', await evaluate("document.querySelector('#toast').hidden"));
  await send(target.id);
  check('只注入指定来源，不混入同名另一正文', latestRequest().includes('ONLY-A-SENTINEL') && !latestRequest().includes('ONLY-B-SENTINEL'));

  await fill('/'+longName+' 多行中文布局验收\n第二行不能被技能标签遮住');
  check('长技能名可绑定', await waitFor(p, `document.querySelector('#skillChipLabel').textContent.includes(${JSON.stringify(longName)})`));
  await p.send('Emulation.setDeviceMetricsOverride', {width:380,height:560,deviceScaleFactor:1,mobile:false});
  await shot('05-small-window-long-name');
  check('长技能名仍可取消', await evaluate("(()=>{const e=document.querySelector('#skillChipClear');const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;})()"));
  await click('#skillChipClear');
  check('小窗口取消保留多行原文', (await text()).includes('第二行不能被技能标签遮住'));
  await p.send('Emulation.clearDeviceMetricsOverride');
  await selectSession(b); await fill('');
  await p.send('Page.reload'); await ready();
  fs.writeFileSync(delayFile, '2000');
  await fill('/domain-modeling 刚输入后立即发送，不应误判草稿变化');
  await send(id);
  check('冷目录下立即发送仍携带指定正文', latestRequest().includes('LOCAL-DOMAIN-SENTINEL')&&latestRequest().includes('刚输入后立即发送'));
  check('无渲染异常', consoleErrors(p).length === 0);
  passed = true;
} catch(error) {
  if (p) await capture(p,path.join(shots,'failure.png')).catch(()=>{});
  throw error;
} finally {
  await app?.stop(); await model.close(); owner.close();
  fs.writeFileSync(path.join(shots,'acceptance.json'),JSON.stringify({passed,checks,root,requests:model.requests.length,realProvider:false,screenshots:fs.readdirSync(shots).filter(n=>n.endsWith('.png'))},null,2));
  console.log(`${passed?'PASS':'FAIL'} ${checks.length} checks; ${shots}`);
}
