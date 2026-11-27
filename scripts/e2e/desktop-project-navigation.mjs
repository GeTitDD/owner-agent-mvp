// 项目导航与诚实的同步反馈：真实 Electron/IPC/SQLite；只注入读取失败、延迟和已有同步假执行器。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { OwnerStore } from '../../src/owner-store.mjs';
import { ChatSessionStore } from '../../src/chat-sessions.mjs';
import { applySyncAttempt, emptySyncStatus } from '../../src/memory/sync-status.mjs';
import { MemoryWatermarkStore } from '../../src/memory/watermark.mjs';
import { startApp, capture, consoleErrors, waitFor, sleep } from './lib/cdp.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-project-navigation-'));
const userData = path.join(root, 'data'); fs.mkdirSync(userData);
const shots = path.resolve(process.env.SHOTS_DIR || path.join(repo, '.verify/project-navigation'));
fs.mkdirSync(shots, { recursive: true });
fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({ model: '', gatewayUrl: 'http://127.0.0.1:1' }));
const ownerDb = path.join(root, 'owner.sqlite');
const owner = new OwnerStore(ownerDb); const chats = new ChatSessionStore({ db: owner.db });
const watermarks = new MemoryWatermarkStore({ db: owner.db });
const unreadAt = '2026-11-25T10:00:00.000Z';
for (const id of ['alpha', 'beta', 'gamma']) {
  const dir = path.join(root, id); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'README.md'), `# ${id}\n`);
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  owner.registerProject({ id, root: dir, name: id === 'beta' ? '中文超长项目名称 Beta：切回时应继续独立会话与多行草稿' : `${id}（独立上下文验收）`, primaryDomain: 'software-engineering' });
  watermarks.put(id, unreadAt);
}
const a = chats.createSession({ projectId: 'alpha', title: 'Alpha 最近的工作会话' }).id;
const b = chats.createSession({ projectId: 'beta', title: 'Beta 最近的工作会话：阅读上下文与继续输入' }).id;
const pinned = chats.createSession({ projectId: 'beta', title: 'Beta 陈旧置顶会话，不应被默认打开' }).id;
chats.setPinned(pinned, true);
const cross = chats.createSession({ projectId: 'alpha', title: '跨项目查看 Beta，不应代替 Beta 独立会话' }).id;
chats.setViewProject(cross, 'beta');
const g = chats.createSession({ title: '全局定位与草稿' }).id;
for (const [id, text] of [[a, 'Alpha 专属工作记录'], [b, 'Beta 专属工作记录'], [pinned, '陈旧置顶历史'], [cross, '跨项目历史不能混用'], [g, '全局会话记录']]) {
  chats.appendMessage({ sessionId: id, role: 'assistant', text });
}
for (const [id, stamp] of [[b, '2026-11-25T11:00:00Z'], [pinned, '2026-11-01T11:00:00Z'], [cross, '2026-11-25T12:00:00Z']]) {
  owner.db.prepare('UPDATE owner_chat_sessions SET last_opened_at=? WHERE id=?').run(stamp, id);
}
const aDraft = 'Alpha 尚未发送的草稿\n切走后应原样恢复。';
const bDraft = 'Beta 尚未发送的草稿\n这里不能出现 Alpha 的内容。';
chats.saveDraft({ id: a, projectId: 'alpha', text: aDraft });
chats.saveDraft({ id: b, projectId: 'beta', text: bDraft });
chats.saveDraft({ id: g, text: '全局草稿始终保留。' });
chats.markOpened(a);
const control = path.join(root, 'control.json'); const calls = path.join(root, 'calls.jsonl');
const controls = (flags = {}) => fs.writeFileSync(control, JSON.stringify(flags)); controls({ failSyncGet: true });
const entry = path.join(root, 'test-host.cjs');
fs.writeFileSync(entry, `
const {ipcMain}=require('electron');const fs=require('node:fs');const register=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,handler)=>register(channel,async(event,input)=>{
  if(channel==='companion:sync-status-get'){
    const f=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));
    if(f.failSyncGet){fs.writeFileSync(${JSON.stringify(control)},JSON.stringify({...f,failSyncGet:false}));throw Error('验收：状态读取暂时失败');}
  }
  if(channel==='companion:decision-scan'||channel==='companion:session-scan'){
    fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({channel})+'\\n');throw Error('验收禁止自动扫描个人会话');
  }
  if(['companion:card-sessions','companion:card-session-get','companion:card-session-create','companion:sync-attempt'].includes(channel)){
    fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({channel,id:input?.id||'',projectId:input?.projectId||''})+'\\n');
    const f=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));
    if(channel==='companion:card-session-get'&&f.failGetId===input?.id){fs.writeFileSync(${JSON.stringify(control)},JSON.stringify({...f,failGetId:''}));throw Error('验收：目标历史暂时不可用');}
    if(channel==='companion:card-sessions'&&f.failList){fs.writeFileSync(${JSON.stringify(control)},JSON.stringify({...f,failList:false}));throw Error('验收：会话列表暂时不可用');}
    if(channel==='companion:card-sessions'&&f.delayList)await new Promise(r=>setTimeout(r,f.delayList));
    if(channel==='companion:sync-attempt'&&f.delaySync)await new Promise(r=>setTimeout(r,f.delaySync));
  }
  return handler(event,input);
});require(${JSON.stringify(path.join(repo, 'desktop/main.cjs'))});
`);
const options = { userData, ownerDb, knowledgeDb: path.join(root, 'knowledge.sqlite'), entry,
  env: { OWNER_AGENT_CHAT_FAKE: '1', OWNER_AGENT_PI_HOME: path.join(root, 'pi'), OWNER_AGENT_WATCH_DIR: path.join(root, 'watch') } };
const checks = [];
const check = (label, condition) => { assert.ok(condition, label); checks.push(label); console.log(`OK ${label}`); };
let app; let panel; let passed = false;
const evaluate = (code) => panel.evaluate(code);
const click = async (selector) => {
  const point = await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.getClientRects().length)throw Error('不可点击：'+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);if(!e.contains(hit))throw Error('被遮挡：'+${JSON.stringify(selector)});return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await panel.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await panel.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
};
const current = () => evaluate('document.querySelector("#sessionList [data-current=true]")?.dataset.id');
const draft = () => evaluate('document.querySelector("#input").value');
const text = () => evaluate('document.querySelector("#messages").innerText');
const ready = async (id, content) => check('目标会话与输入上下文一致', await waitFor(panel, `document.querySelector('#sessionList [data-current=true]')?.dataset.id===${JSON.stringify(id)}&&document.querySelector('#input').value===${JSON.stringify(content)}&&!document.querySelector('#projectToggle').disabled&&!document.querySelector('#input').disabled`));
const open = async () => { if (await evaluate('document.querySelector("#projectPopover").hidden')) await click('#projectToggle'); };
const choose = async (id, keyboard = false) => {
  await open(); const selector = `#projectList .project-name[data-project="${id}"]`;
  if (!keyboard) await click(selector);
  else {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await panel.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await panel.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  }
};
const select = async (id) => {
  if (await evaluate('document.querySelector("#sessionPopover").hidden')) await click('#sessionToggle');
  await click(`.session-row[data-id="${id}"] [data-act="switch"]`);
  check('显式选择会话成功', await waitFor(panel, `document.querySelector('#sessionList [data-current=true]')?.dataset.id===${JSON.stringify(id)}`));
};
const crossView = async (id, exit) => {
  await open(); await click(`#projectList [data-project="${id}"][data-project-intent="in-session"]`);
  check('跨项目查看保留明确确认', await waitFor(panel, '!document.querySelector("#projectConfirm").hidden'));
  if (exit) await click(exit);
};
const shot = async (name) => {
  await capture(panel, path.join(shots, `${name}.png`));
  check(`${name}：窗口与可见浮层无溢出`, await evaluate(`document.documentElement.scrollWidth<=innerWidth+1&&[...document.querySelectorAll('#projectPopover,#syncRow,.cfg-group')].filter(e=>e.getClientRects().length).every(e=>e.scrollWidth<=e.clientWidth+1&&e.getBoundingClientRect().right<=innerWidth+1&&e.getBoundingClientRect().left>=-1)`));
};
const readCalls = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const fill = async (content) => { await click('#input'); await evaluate('document.querySelector("#input").select()'); await panel.send('Input.insertText', { text: content }); };

try {
  app = await startApp(options); panel = app.panel; await ready(a, aDraft);
  check('同步状态读取失败有可见重试，不藏在会话菜单里', await waitFor(panel, `document.querySelector('#syncState').textContent==='状态未知'&&document.querySelector('#syncRetry').textContent==='重试读取'`));
  await shot('00-sync-status-read-error');
  await click('#syncRetry');
  check('正常版本明确标仅本机，不冒充跨设备同步可用', await waitFor(panel, `document.querySelector('#syncState').textContent==='仅本机'&&document.querySelector('#syncRetry').textContent==='设置同步'`));
  check('执行器可用性来自实际主进程', (await evaluate('window.companion.syncStatus.get()')).availability.available === false);
  const attempts = readCalls().filter(c => c.channel === 'companion:sync-attempt').length;
  await click('#syncRetry');
  check('设置同步直达真实能力说明', await waitFor(panel, `!document.querySelector('#configBox').hidden&&document.querySelector('.cfg-group[data-section="sync"]')?.innerText.includes('自己的私有 GitHub 仓库')`));
  check('了解说明不会执行无效同步请求', readCalls().filter(c => c.channel === 'companion:sync-attempt').length === attempts);
  await shot('01-local-only-explanation'); await click('#configClose');
  await open(); await shot('02-project-menu');
  await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await shot('03-project-menu-dark');
  await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  const total = chats.listSessions().length;
  await choose('beta'); await ready(b, bDraft);
  check('普通切项目不弹确认，不混入原项目消息', await evaluate('document.querySelector("#projectConfirm").hidden&&document.querySelector("#sessionCross").hidden') && (await text()).includes('Beta 专属') && !(await text()).includes('Alpha 专属'));
  check('恢复最近独立会话，忽略陈旧置顶与跨项目会话', await current() === b);
  check('普通切换不追加说明或创建重复会话', chats.getTranscript(a).messages.length === 1 && chats.getTranscript(b).messages.length === 1 && chats.listSessions().length === total);
  await shot('04-resumed-project-draft');
  await choose('alpha', true); await ready(a, aDraft);
  check('键盘切回也恢复原草稿与历史', (await text()).includes('Alpha 专属'));
  await choose(''); await ready(g, '全局草稿始终保留。');
  check('返回全局使用全局会话并显示定位屏', await evaluate('!document.querySelector("#locateView").hidden') && chats.getSession(a).viewProjectId === 'alpha');
  await choose('alpha'); await ready(a, aDraft);

  controls({ failList: true }); await choose('beta');
  check('列表读取失败在原菜单给出重试', await waitFor(panel, `!document.querySelector('#projectPopover').hidden&&!document.querySelector('#projectAddStatus').hidden&&!document.querySelector('#projectToggle').disabled`));
  check('读取失败没有改变原会话或草稿', await current() === a && await draft() === aDraft);
  await shot('05-read-error');
  controls({ failGetId: b }); await choose('beta');
  check('目标历史失败能够回退到原会话', await waitFor(panel, `!document.querySelector('#projectAddStatus').hidden&&!document.querySelector('#projectToggle').disabled`) && await current() === a && await draft() === aDraft && (await text()).includes('Alpha 专属'));
  controls(); await choose('beta'); await ready(b, bDraft); await choose('alpha'); await ready(a, aDraft);

  controls({ delayList: 1700 }); await choose('gamma');
  check('项目切换有明确加载态且禁止重复点击', await waitFor(panel, `document.querySelector('#projectToggle').disabled&&document.querySelector('#projectLabel').textContent==='正在打开…'`));
  await shot('06-opening-project');
  check('第一次进入无历史项目会准备独立会话', await waitFor(panel, `document.querySelector('#projectToggle').dataset.scope==='gamma'&&!document.querySelector('#projectToggle').disabled`));
  const c = await current(); check('新项目输入为空且原草稿仍在', await draft() === '' && chats.getDraft({ id: a, projectId: 'alpha' }).text === aDraft);
  controls(); await choose('alpha'); await ready(a, aDraft); await choose('gamma'); await ready(c, '');
  check('再次进入同项目不会重复创建会话', chats.listSessions().filter(s => s.projectId === 'gamma').length === 1);
  await choose('alpha'); await ready(a, aDraft);

  controls({ delayList: 2000 }); await choose('gamma');
  check('迟到测试的导航请求正在执行', await evaluate('document.querySelector("#projectToggle").disabled'));
  await select(b); controls(); await sleep(2300);
  await ready(b, bDraft);
  check('慢导航不会覆盖后来显式选择的会话', (await text()).includes('Beta 专属') && await evaluate('document.querySelector("#projectToggle").dataset.scope==="beta"'));

  await choose('alpha'); await ready(a, aDraft); await crossView('beta'); await shot('07-explicit-cross-project-confirm');
  check('长项目名确认框保持两列，说明标签不会挤成竖排', await evaluate(`[...document.querySelectorAll('#confirmItems .confirm-item')].every(e=>getComputedStyle(e).display==='grid'&&e.querySelector('.confirm-key').getBoundingClientRect().width>=60)`));
  await click('#confirmCancel'); await ready(a, aDraft);
  check('取消跨项目操作不改归属与消息', chats.getSession(a).viewProjectId === 'alpha' && chats.getTranscript(a).messages.length === 1);
  await crossView('beta', '#confirmInSession');
  check('显式跨项目查看仍保留旧能力和范围草稿隔离', await waitFor(panel, `document.querySelector('#projectToggle').dataset.scope==='beta'&&!document.querySelector('#sessionCross').hidden&&document.querySelector('#input').value===''`));
  check('跨项目说明留在原会话，绑定与目标独立会话未变', chats.getSession(a).projectId === 'alpha' && chats.getTranscript(a).messages.at(-1).text.includes('切换项目') && chats.getTranscript(b).messages.length === 1);
  await choose('beta'); await ready(b, bDraft);
  check('当前视图虽已在 Beta，点主入口仍回 Beta 独立上下文', chats.getSession(a).viewProjectId === 'beta' && await current() === b);
  await select(a); await crossView('alpha', '#confirmInSession'); await ready(a, aDraft);
  await shot('08-returned-to-original-context');
  check('所有观察项目仓库保持不变', ['alpha', 'beta', 'gamma'].every(id => execFileSync('git', ['status', '--porcelain'], { cwd: path.join(root, id), encoding: 'utf8' }).trim() === '?? README.md'));
  check('项目进出和跨项目查看均不清零未读', ['alpha', 'beta', 'gamma'].every(id => watermarks.get(id).at === unreadAt));
  check('项目导航没有触发个人会话扫描', !readCalls().some(call => /decision-scan|session-scan/u.test(call.channel)));
  check('正常宿主渲染无异常', consoleErrors(panel).length === 0);
  await app.stop(); app = await startApp(options); panel = app.panel; await ready(a, aDraft);
  check('重启后仍恢复原项目会话和草稿', await evaluate('document.querySelector("#projectToggle").dataset.scope==="alpha"'));

  // 本套件只用显式假执行器验证旧协议的状态反馈；真实传输见 desktop-memory-sync。
  await app.stop();
  const success = applySyncAttempt(emptySyncStatus(), { status: 'ok' }, '2026-11-25T10:00:00Z');
  const offline = { status: 'error', step: 'pull', code: 'pull-failed', message: 'network unreachable：验收断网' };
  fs.writeFileSync(path.join(userData, 'sync-status.json'), JSON.stringify(applySyncAttempt(success, offline, '2026-11-26T10:00:00Z')));
  fs.writeFileSync(path.join(userData, 'sync-fake.json'), JSON.stringify({ result: offline }));
  const fakeOptions = { ...options, env: { ...options.env, OWNER_AGENT_SYNC_FAKE: '1' } };
  app = await startApp(fakeOptions); panel = app.panel; await ready(a, aDraft);
  check('离线摘要说清恢复动作并保留最后成功时间', await waitFor(panel, `document.querySelector('#syncDetail').textContent.includes('联网后重试')&&document.querySelector('#syncDetail').textContent.includes('2026-11-25 10:00 UTC')`));
  check('技术错误可查而不混入日常摘要', await evaluate(`document.querySelector('#syncRow').title.includes('network unreachable')&&!document.querySelector('#syncDetail').textContent.includes('pull：')`));
  await shot('09-offline-status');
  await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }); await shot('10-offline-dark');
  await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  controls({ delaySync: 1400 }); await click('#syncRetry');
  check('补同步显示加载状态并防重复', await waitFor(panel, 'document.querySelector("#syncRetry").disabled&&document.querySelector("#syncRetry").textContent==="同步中…"'));
  check('断网尝试后明确未完成，草稿仍可编辑', await waitFor(panel, `!document.querySelector('#syncRetry').disabled&&document.querySelector('#toast').textContent.includes('联网后重试')`) && await draft() === aDraft);
  await fill('断网时照常编辑的下一句\n不能因同步错误丢失。');
  controls(); fs.writeFileSync(path.join(userData, 'sync-fake.json'), JSON.stringify({ result: { status: 'ok', text: '同步完成：本机验收假执行器。' } }));
  await click('#syncRetry');
  check('恢复后基于执行器真实返回标已同步并清掉旧失败', await waitFor(panel, `document.querySelector('#syncState').textContent==='已同步'&&document.querySelector('#syncState').dataset.tone==='ok'`) && !await evaluate('document.querySelector("#syncRow").title.includes("network unreachable")'));
  await shot('11-sync-recovered');
  check('模拟执行器渲染无异常', consoleErrors(panel).length === 0);
  await app.stop(); app = await startApp(options); panel = app.panel;
  check('退出验收注入后不以旧成功记录冒充当前执行器可用', await waitFor(panel, 'document.querySelector("#syncState").textContent==="仅本机"&&document.querySelector("#syncRetry").textContent==="设置同步"'));
  check('最终草稿经过重启仍在', await waitFor(panel, `document.querySelector('#input').value===${JSON.stringify('断网时照常编辑的下一句\n不能因同步错误丢失。')}`));
  check('最终渲染控制台无异常', consoleErrors(panel).length === 0);
  fs.writeFileSync(path.join(shots, 'acceptance.json'), JSON.stringify({ date: '2026-11-27', platform: process.platform, assertions: checks.length, checks,
    backend: 'real Electron/IPC/SQLite; controlled read failures/delays; sync fake explicitly separated from normal host',
    paidModelRequests: 0, realRemoteSync: false, limitations: ['Windows 未验收', '本套件不覆盖真实传输，见 memory-sync 套件'] }, null, 2));
  passed = true; console.log(`PASS ${checks.length} assertions; screenshots: ${shots}`);
} catch (error) {
  if (panel) { await capture(panel, path.join(shots, 'FAILED.png')).catch(() => {}); console.error(await evaluate('document.body.innerText').catch(() => '')); console.error(JSON.stringify(consoleErrors(panel))); }
  console.error(app?.log?.join('').slice(-1800)); console.error(`验收现场保留：${root}`); throw error;
} finally {
  await app?.stop(); owner.close();
  if (passed) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
