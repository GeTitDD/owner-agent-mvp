// 体验优先第一批：真实 Electron、鼠标与键盘、真实 IPC/SQLite；目录选择器只在临时测试宿主中替代。
// 覆盖首次使用、取消/失败/重复添加、会话与项目草稿隔离、重启恢复、发送后清除。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { startApp, waitFor, capture, consoleErrors } from './lib/cdp.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const shots = path.resolve(process.env.SHOTS_DIR || path.join(repo, '.verify/first-use'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-ux-e2e-'));
const userData = path.join(root, 'userdata');
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
const projectA = path.join(root, '中文长项目名称用于验证首次添加与多行草稿的实际显示');
const projectB = path.join(root, 'notes-demo');
for (const dir of [projectA, projectB]) {
  fs.mkdirSync(dir);
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
}
const gitStatus = (dir) => execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
const entry = path.join(root, 'test-host.cjs');
fs.writeFileSync(entry, `
const { dialog, ipcMain } = require('electron');
const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => register(channel, async (event, input) => {
  if(channel === 'companion:chat-ask' && String(input?.question).includes('[slow-draft-test]')) {
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  return handler(event, input);
});
const picks = ${JSON.stringify([null, projectA, projectA, projectB, path.join(root, 'missing')])};
dialog.showOpenDialog = async () => {
  const next = picks.shift();
  return next ? { canceled: false, filePaths: [next] } : { canceled: true, filePaths: [] };
};
require(${JSON.stringify(path.join(repo, 'desktop/main.cjs'))});
`);
const options = {
  userData, ownerDb: path.join(root, 'owner.sqlite'), knowledgeDb: path.join(root, 'knowledge.sqlite'), entry,
  env: { OWNER_AGENT_CHAT_FAKE: '1', OWNER_AGENT_WATCH_DIR: path.join(root, 'watch') }
};
const checks = [];
const check = (label, condition) => { assert.ok(condition, label); checks.push(label); console.log(`OK ${label}`); };
let app;
let panel;
const evaluate = (code) => panel.evaluate(code);
const click = async (selector) => {
  const point = await evaluate(`(() => {
    const e=document.querySelector(${JSON.stringify(selector)});
    if(!e || e.disabled || !e.getClientRects().length) throw Error('按钮不可用: '+${JSON.stringify(selector)});
    e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`);
  await panel.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await panel.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
};
const fill = async (text) => {
  await click('#input');
  // 离屏 macOS 的系统快捷键不保证进入文本控件；原生选区配合输入事件稳定复现替换。
  await evaluate('document.getElementById("input").select()');
  if (text) await panel.send('Input.insertText', { text });
  else {
    await panel.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', windowsVirtualKeyCode: 8 });
    await panel.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', windowsVirtualKeyCode: 8 });
  }
  assert.equal(await draft(), text, '文本控件应包含本次输入，而不是把文字插进旧草稿');
};
const current = () => evaluate(`document.querySelector('#sessionList .session-row[data-current="true"]')?.dataset.id || ''`);
const draft = () => evaluate('document.getElementById("input").value');
const shot = async (name) => {
  await capture(panel, path.join(shots, `${name}.png`));
  const overflow = await evaluate(`(() => {
    const selectors=['.shell','#firstProjectAdd','#projectAdd','#projectAddStatus','#draftStatus','#input','#send'];
    return selectors.flatMap(s=>[...document.querySelectorAll(s)].filter(e=>e.getClientRects().length).filter(e=>{
      const r=e.getBoundingClientRect();return r.left < -1 || r.right > innerWidth+1 || r.bottom > innerHeight+1;
    }).map(e=>e.id||e.className));
  })()`);
  check(`${name}：关键控件位于窗口内`, overflow.length === 0);
  const feedback = await evaluate(`(() => {
    const toast=document.querySelector('#toast'), input=document.querySelector('#composer');
    const error=document.querySelector('#projectAddStatus');
    const projects=document.querySelector('#projectList');
    return { toastClear:toast.hidden || toast.getBoundingClientRect().bottom<=input.getBoundingClientRect().top,
      errorFits:(error.hidden || error.scrollWidth<=error.clientWidth+1)
        && (!projects.getClientRects().length || projects.scrollWidth<=projects.clientWidth+1) };
  })()`);
  check(`${name}：提示不遮挡输入且错误完整换行`, feedback.toastClear && feedback.errorFits);
};
const ready = async () => {
  check('应用会自动准备会话，输入框可用', await waitFor(panel, `document.querySelector('#input')?.disabled===false && !!document.querySelector('#sessionList .session-row[data-current="true"]')`, 15000));
};
const saved = async () => check('草稿已落库', await waitFor(panel, `document.querySelector('#draftStatus')?.textContent.startsWith('草稿已')`, 5000));
const openProjects = async () => {
  if (await evaluate('document.querySelector("#projectPopover").hidden')) await click('#projectToggle');
  check('项目选择器可见', await waitFor(panel, `!document.querySelector('#projectPopover').hidden`));
};
const selectSession = async (id) => {
  if (await evaluate('document.querySelector("#sessionPopover").hidden')) await click('#sessionToggle');
  await click(`.session-row[data-id="${id}"] [data-act="switch"]`);
  check('切到指定会话', await waitFor(panel, `document.querySelector('.session-row[data-id="${id}"]')?.dataset.current==='true' && !document.querySelector('#input').disabled`));
};
const switchProject = async (id, exit) => {
  await openProjects();
  await click(`#projectList button[data-project="${id}"][data-project-intent="in-session"]`);
  check('项目切换可取消', await waitFor(panel, `!document.querySelector('#projectConfirm').hidden`));
  await click(exit);
  if (exit !== '#confirmCancel') check('项目范围已更新', await waitFor(panel, `document.querySelector('#projectToggle').dataset.scope===${JSON.stringify(id)} && !document.querySelector('#input').disabled`));
};

try {
  app = await startApp(options); panel = app.panel;
  await ready();
  check('空库提供添加第一个项目的主操作', await waitFor(panel, `!document.querySelector('#firstProject').hidden`));
  await shot('01-first-use-light');
  await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await shot('02-first-use-dark');
  await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  const globalId = await current();
  await fill('全局尚未发送的草稿'); await saved();
  await click('#firstProjectAdd');
  check('取消添加保留原会话和草稿', await waitFor(panel, `!document.querySelector('#firstProjectAdd').disabled`) && await current() === globalId && await draft() === '全局尚未发送的草稿');
  await shot('03-add-cancelled');
  await click('#firstProjectAdd');
  check('添加后直接进入项目', await waitFor(panel, `document.querySelector('#projectToggle').dataset.scope!=='global' && !document.querySelector('#input').disabled`));
  const aId = await evaluate('document.querySelector("#projectToggle").dataset.scope');
  const aSession = await current();
  check('新项目不会带入全局草稿', await draft() === '');
  check('登记保持仓库干净', gitStatus(projectA) === '' && !fs.existsSync(path.join(projectA, '.owner-root-identity')));
  await shot('04-project-added-long-name');
  const aText = '这是项目 A 的未发送草稿。\n第二行：中文、标点与原始换行应该保留。';
  await fill(aText); await saved();
  await shot('05-draft-saved');
  await openProjects(); await click('#projectAdd');
  check('重复添加仍可进入同一项目的新会话', await waitFor(panel, `!document.querySelector('#projectAdd').disabled && document.querySelector('#projectPopover').hidden`) && await current() !== aSession);
  const projects = await evaluate('window.companion.cardProjects.list()');
  check('同一目录没有重复登记', projects.items.length === 1);
  check('同项目新会话不会带入旧草稿', await draft() === '');
  await selectSession(aSession);
  check('返回原会话恢复多行草稿', await draft() === aText);
  await openProjects(); await click('#projectAdd');
  check('第二个项目添加成功', await waitFor(panel, `document.querySelector('#projectToggle').dataset.scope==='notes-demo' && !document.querySelector('#input').disabled`));
  const bSession = await current();
  check('B 输入框不含 A 草稿', await draft() === '');
  const bText = '只属于知识笔记项目的未发送草稿';
  await fill(bText); await saved();
  await switchProject(aId, '#confirmNewSession');
  check('新开会话并切换不携带 B 草稿', await draft() === '');
  await shot('06-new-session-isolated');
  await selectSession(bSession); check('B 草稿仍然保留', await draft() === bText);
  await selectSession(aSession); check('A 草稿仍然保留', await draft() === aText);
  await switchProject('notes-demo', '#confirmInSession');
  check('同会话换项目也不会携带原范围草稿', await draft() === '');
  await fill('同一会话的 B 范围草稿'); await saved();
  await switchProject(aId, '#confirmInSession');
  check('同会话切回 A 恢复原草稿', await draft() === aText);
  await switchProject('notes-demo', '#confirmCancel');
  check('取消切换不改草稿和项目范围', await draft() === aText && await current() === aSession);
  await openProjects(); await click('#projectAdd');
  check('添加失败给出可见恢复信息', await waitFor(panel, `!document.querySelector('#projectAddStatus').hidden && !document.querySelector('#projectAdd').disabled`));
  check('添加失败保留当前草稿', await draft() === aText);
  await shot('07-add-error-preserves-draft');
  check('首轮无渲染异常', consoleErrors(panel).length === 0);
  await app.stop();
  app = await startApp(options); panel = app.panel; await ready();
  check('重启恢复当前会话和草稿', await current() === aSession && await draft() === aText);
  await shot('08-draft-restored-after-restart');
  await fill('/记灵感 首次使用验收：发送后不再恢复已发送正文');
  await saved();
  await click('#send');
  check('真实本地命令完成写入', await waitFor(panel, `document.querySelector('#messages').innerText.includes('写入回执') && document.querySelector('#input').value===''`, 10000));
  await shot('09-sent-draft-cleared');
  check('命令完成后仓库仍无变化', gitStatus(projectA) === '' && gitStatus(projectB) === '');
  await app.stop();
  app = await startApp(options); panel = app.panel; await ready();
  check('重启不恢复已发送草稿', await draft() === '');
  await fill('[slow-draft-test] 验证普通回复不会清空下一句草稿');
  await click('#send');
  check('普通回复进入等待状态', await waitFor(panel, `document.querySelector('#send').textContent==='停止'`));
  await fill('等待回复时输入的下一句草稿'); await saved();
  check('迟到回复结束', await waitFor(panel, `document.querySelector('#send').textContent==='发送'`, 10000));
  check('迟到回复没有清空下一句草稿', await draft() === '等待回复时输入的下一句草稿');
  await shot('10-reply-preserves-next-draft');
  await fill('[slow-draft-test] 验证切换后的项目不会收到另一会话的消息');
  await click('#send');
  check('跨项目回归的原会话正在回复', await waitFor(panel, `document.querySelector('#send').textContent==='停止'`));
  await switchProject('notes-demo', '#confirmNewSession');
  await fill('B 的新草稿不能作为 A 的引导发送'); await saved();
  check('其他会话回复时不展示错误的引导与停止动作', await evaluate(`document.querySelector('#send').disabled && document.querySelector('#send').textContent==='等待' && document.querySelector('#insertMode').hidden`));
  await panel.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13 });
  await panel.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13 });
  check('另一会话回复时明确保留新项目草稿', await waitFor(panel, `document.querySelector('#toast').textContent.includes('另一会话正在回复')`, 2000));
  await shot('11-cross-project-reply-protection');
  check('原回复结束后 B 草稿仍在', await waitFor(panel, `document.querySelector('#send').textContent==='发送'`, 10000) && await draft() === 'B 的新草稿不能作为 A 的引导发送');
  const bMessages = await evaluate(`window.companion.cardSessions.get({id:document.querySelector('#sessionList .session-row[data-current="true"]').dataset.id})`);
  check('B 会话没有被其他会话的消息或回复污染', bMessages.messageCount === 0);
  check('最后一轮无渲染异常', consoleErrors(panel).length === 0);
  fs.writeFileSync(path.join(shots, 'acceptance.json'), JSON.stringify({ status: 'pass', platform: process.platform, checks, fixtures: 'synthetic', picker: 'test-host stub; real application/IPC/storage', realModel: false }, null, 2));
  console.log(`PASS ${checks.length} checks · screenshots: ${shots}`);
} catch (error) {
  console.error(error.stack);
  if (panel) { try { await capture(panel, path.join(shots, 'failure.png')); } catch { /* 保留原始失败 */ } }
  console.error(`验收现场保留：${root}`);
  process.exitCode = 1;
} finally {
  if (app) await app.stop();
  if (!process.exitCode) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
