// 长会话真实旅程：真实 Electron/IPC/SQLite，历史读取只注入可控失败和延迟，模型使用已有假流。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { OwnerStore } from '../../src/owner-store.mjs';
import { ChatSessionStore } from '../../src/chat-sessions.mjs';
import { startApp, capture, consoleErrors, waitFor, sleep } from './lib/cdp.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-chat-history-'));
const userData = path.join(root, 'data');
const shots = path.resolve(process.env.SHOTS_DIR || path.join(repo, '.verify/chat-history'));
fs.mkdirSync(userData); fs.mkdirSync(shots, { recursive: true });
fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({ model: '', gatewayUrl: 'http://127.0.0.1:1' }));
const ownerDb = path.join(root, 'owner.sqlite');
const owner = new OwnerStore(ownerDb);
for (const id of ['alpha', 'beta']) {
  const dir = path.join(root, id); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'README.md'), `# ${id}\n`);
  owner.registerProject({ id, root: dir, name: id === 'alpha' ? '多行中文与长会话体验验收项目 Alpha' : 'Beta 独立草稿', primaryDomain: 'software-engineering' });
}
const chats = new ChatSessionStore({ db: owner.db });
const a = chats.createSession({ projectId: 'alpha', title: '长会话：连续 520 条消息的工作记录与恢复' }).id;
const b = chats.createSession({ projectId: 'beta', title: 'Beta 的独立会话' }).id;
const firstQuestion = '最初的问题：怎样保证长会话中的上下文完整？\n请同时解释历史读取、重试与完整导出。';
owner.db.exec('BEGIN');
let sourceSeq;
for (let i = 0; i < 520; i += 1) {
  const message = chats.appendMessage({ sessionId: a, role: i % 2 ? 'assistant' : 'user',
    text: i === 0 ? firstQuestion : `工作记录 ${String(i + 1).padStart(3, '0')}：${i % 2 ? '已核对保存结果，可以继续下一步。' : '请核对这条中文记录，保留完整上下文。'}${i % 11 ? '' : '\n第二行说明：旧消息加载时，正在阅读的位置应保持稳定。'}` });
  if (!i) sourceSeq = message.seq;
}
chats.appendMessage({ sessionId: a, role: 'assistant', text: '最新记录：原问题之前未完成，可以从这里重试。', status: 'error',
  blocks: [{ type: 'chat-recovery', category: 'network-error', sourceSeq, projectId: 'alpha' }] });
chats.appendMessage({ sessionId: b, role: 'assistant', text: 'Beta 专属消息，不应混入 Alpha。' });
const initialDraft = '长会话下一条草稿\n加载历史和重试时不能覆盖。';
chats.saveDraft({ id: a, projectId: 'alpha', text: initialDraft });
chats.saveDraft({ id: b, projectId: 'beta', text: 'Beta 草稿始终独立。' });
chats.markOpened(a); owner.db.exec('COMMIT');
const control = path.join(root, 'history-control.json');
const calls = path.join(root, 'history-calls.jsonl');
const controls = (value) => fs.writeFileSync(control, JSON.stringify(value));
controls({ delayOlder: 0 });
const entry = path.join(root, 'test-host.cjs');
fs.writeFileSync(entry, `
const {ipcMain}=require('electron');const fs=require('node:fs');
const register=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,handler)=>register(channel,async(event,input)=>{
  if(channel==='companion:card-session-get'){
    fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({id:input?.id,beforeSeq:input?.beforeSeq||0})+'\\n');
    if(input?.beforeSeq){
      const flags=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));
      if(flags.failOlder){fs.writeFileSync(${JSON.stringify(control)},JSON.stringify({...flags,failOlder:false}));throw Error('模拟历史读取暂时不可用');}
      const result=await handler(event,input);
      if(flags.delayOlder)await new Promise(r=>setTimeout(r,flags.delayOlder));
      return result;
    }
  }
  return handler(event,input);
});
require(${JSON.stringify(path.join(repo, 'desktop/main.cjs'))});
`);
const options = { userData, ownerDb, knowledgeDb: path.join(root, 'knowledge.sqlite'), entry,
  env: { OWNER_AGENT_CHAT_FAKE: '1', OWNER_AGENT_WATCH_DIR: path.join(root, 'watch') } };
const checks = [];
const check = (label, condition) => { assert.ok(condition, label); checks.push(label); console.log(`OK ${label}`); };
let app; let panel; let passed = false;
const evaluate = (code) => panel.evaluate(code);
const click = async (selector) => {
  const point = await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.getClientRects().length)throw Error('不可点击：'+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await panel.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await panel.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
};
const fill = async (text) => { await click('#input'); await evaluate('document.querySelector("#input").select()'); await panel.send('Input.insertText', { text }); };
const draft = () => evaluate('document.querySelector("#input").value');
const count = () => evaluate('document.querySelectorAll("#messages .msg").length');
const sequences = () => evaluate('[...document.querySelectorAll("#messages .msg")].map(e=>Number(e.dataset.seq))');
const text = () => evaluate('document.querySelector("#messages").innerText');
const select = async (id) => {
  if (await evaluate('document.querySelector("#sessionPopover").hidden')) await click('#sessionToggle');
  await click(`.session-row[data-id="${id}"] [data-act="switch"]`);
  check('目标会话已恢复', await waitFor(panel, `document.querySelector('.session-row[data-id="${id}"]')?.dataset.current==='true'&&!document.querySelector('#input').disabled`));
  if (!(await evaluate('document.querySelector("#sessionPopover").hidden'))) await click('#sessionToggle');
};
const shot = async (name) => {
  await capture(panel, path.join(shots, `${name}.png`));
  check(`${name}：窗口和消息无横向溢出`, await evaluate(`document.documentElement.scrollWidth<=innerWidth+1&&[...document.querySelectorAll('.bubble,.history-nav')].filter(e=>e.getClientRects().length).every(e=>e.scrollWidth<=e.clientWidth+1)`));
};
const atTop = () => evaluate('document.querySelector("#thread").scrollTop=0');
const exportAll = async () => {
  await click('#exportConversation');
  check('导出展示真实落点', await waitFor(panel, `!document.querySelector('#exportPath').hidden`));
  const file = await evaluate('document.querySelector("#exportPath").textContent');
  return fs.readFileSync(file, 'utf8');
};

try {
  app = await startApp(options); panel = app.panel;
  check('长会话启动后草稿恢复', await waitFor(panel, `document.querySelector('#input').value===${JSON.stringify(initialDraft)}&&document.querySelectorAll('#messages .msg').length===100`));
  check('首批只加载最新 100 条，最新回复可见', (await text()).includes('最新记录：') && !(await text()).includes(firstQuestion));
  check('最新消息实际处于可视区', await evaluate(`(() => {const r=document.querySelector('#messages .msg:last-child').getBoundingClientRect();const t=document.querySelector('#thread').getBoundingClientRect();return r.bottom<=t.bottom+1&&r.bottom>t.top;})()`));
  await shot('01-latest-reply');

  const markdown = await exportAll();
  check('尚未展开历史也能导出全部 521 条', (markdown.match(/^## (?:我|Companion)$/gm) ?? []).length === 521 && markdown.includes(firstQuestion) && markdown.includes('工作记录 520'));
  check('导出没有混入另一会话', !markdown.includes('Beta 专属消息'));
  check('重复导出逐字节一致', await exportAll() === markdown);
  check('完整导出不把全部消息强塞进界面', await count() === 100);

  await click('[data-chat-recovery="retry"]');
  check('原问题不在首批也可以重试成功', await waitFor(panel, `document.querySelector('#messages .msg:last-child').textContent.includes('（假回答）收到：最初的问题')&&document.querySelector('#send').textContent==='发送'`));
  check('重试只增加助手回复，原问题没被重复记录', chats.getTranscript(a).messages.length === 522 && chats.getTranscript(a).messages.filter(m => m.text === firstQuestion).length === 1);
  check('重试保留当前多行草稿', await draft() === initialDraft);
  check('刷新保留已加载消息，不平白多加载一整页', await count() === 101);

  controls({ failOlder: true, delayOlder: 1200 });
  await atTop(); await click('#historyOlder');
  check('历史读取失败有原地重试按钮', await waitFor(panel, `document.querySelector('#historyNav').dataset.error==='true'&&document.querySelector('#historyOlder').textContent.includes('重试')`));
  check('失败没有清空历史和草稿', await count() === 101 && await draft() === initialDraft);
  check('分页失败用明确中文反馈，隐藏 IPC 技术前缀', await evaluate(`document.querySelector('#historyStatus').textContent.includes('请重试')&&!document.querySelector('#historyStatus').textContent.includes('companion:')`));
  await waitFor(panel, 'document.querySelector("#toast").hidden');
  await shot('02-history-error');
  await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await shot('03-history-error-dark');
  await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await click('#historyOlder');
  check('加载时禁用重复点击并显示状态', await evaluate('document.querySelector("#historyOlder").disabled&&document.querySelector("#historyNav").getAttribute("aria-busy")==="true"'));
  const anchor = await evaluate(`(() => {const e=document.querySelector('#messages .msg');return {seq:e.dataset.seq,top:e.getBoundingClientRect().top};})()`);
  await shot('04-loading-history');
  check('重试成功追加更早的 100 条', await waitFor(panel, `document.querySelectorAll('#messages .msg').length===201&&!document.querySelector('#historyOlder').disabled`));
  const after = await evaluate(`document.querySelector('[data-seq="${anchor.seq}"]').getBoundingClientRect().top`);
  check('前插历史后正在阅读的消息位置稳定', Math.abs(after - anchor.top) <= 2);
  const seqs = await sequences();
  check('消息序号严格递增且无重复', seqs.every((seq, i) => !i || seq > seqs[i - 1]));
  check('加载后草稿仍在', await draft() === initialDraft);
  await shot('05-history-scroll-anchor');

  // 让旧会话分页请求迟到，验证切换后它不会覆盖另一会话。
  await atTop(); controls({ delayOlder: 2000 }); await click('#historyOlder');
  check('分页在切换前确实已经开始', await evaluate('document.querySelector("#historyOlder").disabled'));
  await select(b);
  check('另一会话保留独立草稿和消息', await draft() === 'Beta 草稿始终独立。' && (await text()).includes('Beta 专属消息'));
  check('切会话不显示上一会话的导出路径', await evaluate('document.querySelector("#exportPath").hidden&&document.querySelector("#exportPath").textContent===""'));
  await sleep(2300);
  check('迟到历史未污染新会话或重新显示分页', await count() === 1 && !(await text()).includes('工作记录') && await evaluate('document.querySelector("#historyNav").hidden'));
  await shot('06-stale-page-isolated');
  controls({ delayOlder: 0 }); await select(a);
  check('返回长会话回到最新一页', await count() === 100 && (await text()).includes('（假回答）收到：最初的问题'));

  await fill('@@');
  check('长会话可以进入引用消息的勾选模式', await waitFor(panel, `!document.querySelector('#atPanel').hidden&&!!document.querySelector('[data-at-method="prompt"]')`));
  await click('[data-at-method="prompt"]');
  check('引用方法已启用流内勾选', await waitFor(panel, `document.querySelector('#messages').classList.contains('selecting')`));
  await click('#messages .msg:first-child .bubble');
  const selectedSeq = await evaluate('document.querySelector("#messages .msg[data-selected=true]").dataset.seq');
  await atTop(); await evaluate('document.querySelector("#historyOlder").focus()');
  await panel.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await panel.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  check('键盘也能加载更早消息', await waitFor(panel, 'document.querySelectorAll("#messages .msg").length===200'));
  check('前插历史后仍选中原消息，索引没有错位', await evaluate(`[...document.querySelectorAll('#messages .msg[data-selected=true]')].map(e=>e.dataset.seq).join()===${JSON.stringify(selectedSeq)}&&document.querySelector('.at-prompt-count').textContent.includes('1')`));
  await panel.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 });
  await panel.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27 });
  await fill(initialDraft);

  let pages = 0;
  while (!(await evaluate('document.querySelector("#historyOlder").hidden'))) {
    const before = await count(); await atTop(); await click('#historyOlder');
    check('更早消息可继续分批展开', await waitFor(panel, `document.querySelectorAll('#messages .msg').length>${before}&&!document.querySelector('#historyOlder').disabled`));
    if (++pages > 8) throw Error('历史分页未能到达会话开头');
  }
  check('全部历史恰好 522 条，无丢失和重复', await count() === 522 && new Set(await sequences()).size === 522);
  await atTop();
  check('会话开头包含最初多行问题与完成提示', (await text()).includes(firstQuestion) && await evaluate('document.querySelector("#historyStatus").textContent==="已到会话开头"'));
  await shot('07-history-complete');

  await fill('第 523 条：继续讨论长会话。'); await click('#send');
  check('超过旧上限仍可发送并看到新回答', await waitFor(panel, `document.querySelector('#messages .msg:last-child').textContent.includes('（假回答）收到：第 523 条')&&document.querySelector('#send').textContent==='发送'`));
  check('新消息到来不收起已展开历史', await count() === 524 && (await text()).includes(firstQuestion));
  await fill(initialDraft);
  await click('#messages .msg:last-child [data-rewind]');
  check('撤回同步移除末轮但不丢较早历史', await waitFor(panel, `document.querySelectorAll('#messages .msg').length===522`) && chats.getTranscript(a).messages.length === 522);
  check('撤回没有覆盖后来编辑的草稿', await draft() === initialDraft);

  // 同步仍走已有确认卡；此处只检查传入正文的边界，不批准向项目目录写文件。
  await evaluate('window.OwnerProjectSyncDocs=async ({messages})=>{window.__syncHistory=messages;return [{path:"docs/notes/history.md",content:"隔离验收，不应写入项目"}];}');
  await fill('/同步到项目 长会话完整记录'); await click('#send');
  check('完整会话同步拿到全部正文', await waitFor(panel, 'window.__syncHistory?.length===522'));
  check('同步正文从第一条到最新条且无当前命令', await evaluate(`window.__syncHistory[0].text===${JSON.stringify(firstQuestion)}&&window.__syncHistory.at(-1).text.includes('（假回答）收到：最初的问题')`));
  check('未授权同步仍有确认卡', await waitFor(panel, `!!document.querySelector('#messages .msg:last-child [data-block="risk"]')`));
  check('同步提议未写入观察项目', !fs.existsSync(path.join(root, 'alpha/docs/notes/history.md')));
  await fill(initialDraft);
  const finalCount = chats.getTranscript(a).messages.length;
  check('最终导出包含全部历史和同步回执', (await exportAll()).match(/^## (?:我|Companion)$/gm).length === finalCount);
  check('渲染控制台无异常', consoleErrors(panel).length === 0);
  await app.stop(); app = await startApp(options); panel = app.panel;
  check('重启恢复最新页与原草稿', await waitFor(panel, `document.querySelectorAll('#messages .msg').length===100&&document.querySelector('#input').value===${JSON.stringify(initialDraft)}`));
  check('重启后仍有更早历史，未把显示窗口当成删除', await evaluate('!document.querySelector("#historyOlder").hidden') && chats.getTranscript(a).messages.length === finalCount);
  await atTop(); await shot('08-restart-latest-page');
  check('重启后控制台无异常', consoleErrors(panel).length === 0);
  fs.writeFileSync(path.join(shots, 'acceptance.json'), JSON.stringify({ date: '2026-11-27', platform: process.platform,
    assertions: checks.length, checks, backend: 'real Electron/IPC/SQLite; controlled history failure/delay; existing fake model stream',
    initialMessages: 521, finalMessages: finalCount, limitations: ['Windows 未验收', '不请求真实模型'] }, null, 2));
  passed = true; console.log(`PASS ${checks.length} assertions; screenshots: ${shots}`);
} catch (failure) {
  if (panel) {
    await capture(panel, path.join(shots, 'FAILED.png')).catch(() => {});
    console.error(await evaluate('document.body.innerText').catch(() => ''));
    console.error(JSON.stringify(consoleErrors(panel)));
    console.error(JSON.stringify(panel.events.filter(e=>e.method==='Runtime.exceptionThrown')));
  }
  console.error(app?.log?.join('').slice(-1800)); console.error(`验收现场保留：${root}`); throw failure;
} finally {
  await app?.stop(); owner.close();
  if (passed) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
