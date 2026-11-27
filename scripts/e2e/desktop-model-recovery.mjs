// 模型恢复真实旅程：Electron + SQLite + 已安装 SDK + 本机 HTTP/SSE 模拟服务。
// 不替代聊天 IPC，不用 OWNER_AGENT_CHAT_FAKE，不读取个人凭据或连接真实模型服务。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { OwnerStore } from '../../src/owner-store.mjs';
import { ChatSessionStore } from '../../src/chat-sessions.mjs';
import { startApp, capture, consoleErrors, waitFor } from './lib/cdp.mjs';
import { seedModelFixture, startModelFixture } from './lib/model-fixture.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-model-recovery-'));
const userData = path.join(root, 'data');
const shots = path.resolve(process.env.SHOTS_DIR || path.join(repo, '.verify/model-recovery'));
fs.mkdirSync(userData); fs.mkdirSync(shots, { recursive: true });
const server = await startModelFixture();
const piHome = path.join(root, 'pi');
seedModelFixture(path.join(piHome, 'agent'), server.baseUrl);
fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({ model: '', gatewayUrl: 'http://127.0.0.1:1' }));
const ownerDb = path.join(root, 'owner.sqlite');
const owner = new OwnerStore(ownerDb);
for (const id of ['alpha', 'beta']) {
  const dir = path.join(root, id); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'README.md'), `# ${id}\n`);
  owner.registerProject({ id, root: dir, name: id === 'alpha' ? '中文模型恢复验收项目 Alpha' : 'Beta 独立草稿项目', primaryDomain: 'software-engineering' });
}
const chats = new ChatSessionStore({ db: owner.db });
const a = chats.createSession({ projectId: 'alpha', title: 'Alpha 模型恢复' }).id;
const b = chats.createSession({ projectId: 'beta', title: 'Beta 独立草稿' }).id;
const g = chats.createSession({ title: '首次连接模型' }).id;
chats.markOpened(g);
const options = { userData, ownerDb, knowledgeDb: path.join(root, 'knowledge.sqlite'), env: {
  OWNER_AGENT_PI_HOME: piHome, OWNER_AGENT_CHAT_FAKE: '0', OWNER_AGENT_WATCH_DIR: path.join(root, 'watch')
} };
const checks = [];
const check = (label, condition) => { assert.ok(condition, label); checks.push(label); console.log(`OK ${label}`); };
let app; let panel; let passed = false;
const evaluate = (code) => panel.evaluate(code);
const click = async (selector) => {
  const point = await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.getClientRects().length)throw Error('不可点击：'+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await panel.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await panel.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
};
const fill = async (text, selector = '#input') => {
  await click(selector); await evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`);
  await panel.send('Input.insertText', { text });
};
const draft = () => evaluate('document.querySelector("#input").value');
const send = async (text) => { await fill(text); await click('#send'); };
const ready = async () => check('会话与输入框可用', await waitFor(panel, `!document.querySelector('#input').disabled&&document.querySelector('#sessionList [data-current="true"]')`, 15000));
const select = async (id) => {
  if (await evaluate('document.querySelector("#sessionPopover").hidden')) await click('#sessionToggle');
  await click(`.session-row[data-id="${id}"] [data-act="switch"]`);
  check('目标会话恢复', await waitFor(panel, `document.querySelector('.session-row[data-id="${id}"]')?.dataset.current==='true'&&!document.querySelector('#input').disabled`));
  if (!(await evaluate('document.querySelector("#sessionPopover").hidden'))) await click('#sessionToggle');
};
const error = (category) => `.type-chat-recovery[data-category="${category}"]`;
const action = (category, name) => `${error(category)} [data-chat-recovery="${name}"]`;
const waitError = async (category) => check(`${category} 有明确恢复卡`, await waitFor(panel, `!!document.querySelector(${JSON.stringify(error(category))})&&!document.querySelector('#send').textContent.includes('停止')`));
const shot = async (name, selector) => {
  if (selector) await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'start'})`);
  await capture(panel, path.join(shots, `${name}.png`));
  check(`${name}：无横向溢出且关键按钮留在窗口内`, await evaluate(`document.documentElement.scrollWidth<=innerWidth+1&&[...document.querySelectorAll('.recovery-actions,.cfg-group,.cfg-model-state')].filter(e=>e.getClientRects().length).every(e=>e.scrollWidth<=e.clientWidth+1)`));
  check(`${name}：凭据未出现在 DOM`, !await evaluate(`document.body.innerText.includes('FIXTURE-NOT-A-REAL-CREDENTIAL')||[...document.querySelectorAll('input')].some(e=>e.value.includes('FIXTURE-NOT-A-REAL-CREDENTIAL'))`));
};
const configure = async (id) => {
  const select = 'select[data-pick-for="model"]';
  check('配置箱主模型分区可用', await waitFor(panel, `!document.querySelector('#configBox').hidden&&!!document.querySelector(${JSON.stringify(select)})&&!document.querySelector('#configSave').disabled`));
  await fill(id, '[data-model-search="model"]');
  await evaluate(`(() => {const s=document.querySelector(${JSON.stringify(select)});s.value=${JSON.stringify(id)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  check('选择器把模型填进当前配置草稿', await evaluate(`document.querySelector('[data-cfg="model"]').value===${JSON.stringify(id)}`));
  await click('#configSave');
  check('模型保存成功', await waitFor(panel, `document.querySelector('#configStatus').textContent.includes('已保存')&&!document.querySelector('#configSave').disabled`));
};

try {
  app = await startApp(options); panel = app.panel; await ready();
  await send('这个应用怎样帮助我恢复项目上下文？');
  await waitError('no-model');
  check('未配置时不请求任何模型', server.requests.length === 0);
  check('失败以错误状态入库，原问题没有丢失', chats.getSession(g).messages.at(-1).status === 'error' && chats.getSession(g).messages.filter(m=>m.role==='user').length === 1);
  await shot('01-no-model-recovery', '#messages .msg:last-child');
  await click(action('no-model', 'configure'));
  check('恢复卡直接定位模型设置', await waitFor(panel, `!document.querySelector('#configBox').hidden&&!!document.querySelector('.cfg-model-state')`));
  check('空模型提示与实际一致，不再声称默认模型可用', await evaluate(`document.querySelector('[data-cfg="model"]').placeholder==='留空 = 暂不连接模型'&&document.querySelector('.cfg-model-state').textContent.includes('尚未选择')`));
  check('大目录默认仅展示有限选项', await evaluate(`document.querySelector('select[data-pick-for="model"]').options.length<=102`));
  await fill('fixture-local', '[data-model-search="model"]');
  check('模型可按关键词找到，而不必滚动千项清单', await evaluate(`document.querySelector('select[data-pick-for="model"]').options.length===2&&document.querySelector('.cfg-model-count').textContent.includes('匹配 1 个')`));
  await configure('fixture-local/check');
  check('只检测本地凭据，不冒充连接验证成功', await evaluate(`document.querySelector('.cfg-model-state').textContent.includes('尚未验证')`));
  await shot('02-model-configured-unverified', '.cfg-group[data-section="model"]');
  await click('#configClose');
  check('关闭设置后撤下保存提示，不遮挡流内恢复按钮', await evaluate(`document.querySelector('#toast').hidden`));
  const preserved = '下一条尚未发送的多行草稿\n重试上一题时不能清空';
  await fill(preserved);
  await click(action('no-model', 'retry'));
  check('重试经真实 SDK 与 HTTP 返回成功', await waitFor(panel, `document.querySelector('#messages').textContent.includes('这是一条本机协议验收回复')&&document.querySelector('#send').textContent==='发送'`, 15000));
  check('重试没有重复添加原问题，也没清空草稿', chats.getSession(g).messages.filter(m=>m.role==='user').length === 1 && await draft() === preserved);
  check('服务端收到原问题，不包含当前草稿', server.requests[0].body.messages.some(m=>JSON.stringify(m.content).includes('怎样帮助我恢复项目上下文')) && !JSON.stringify(server.requests[0].body).includes('下一条尚未发送'));
  await shot('03-retry-success-preserves-draft', '#messages .msg:last-child');
  await select(a); server.setMode('auth');
  await send('检查这份中文项目的运行方式。');
  await waitError('auth-error');
  await fill('Alpha 新草稿\n不能成为原问题的重试内容');
  await shot('04-auth-error-light', '#messages .msg:last-child');
  await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await shot('05-auth-error-dark', '#messages .msg:last-child');
  await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await app.stop(); app = await startApp(options); panel = app.panel; await ready();
  await waitError('auth-error');
  check('重启后错误卡、原问题与新草稿仍在', (await draft()).includes('Alpha 新草稿') && chats.getSession(a).messages.filter(m=>m.role==='user').length === 1);
  server.setMode('slow');
  await click(action('auth-error', 'retry'));
  check('重试出现真实流式内容', await waitFor(panel, `document.querySelector('.stream')?.textContent.includes('模型连接正常')||document.querySelector('#send').textContent==='停止'`));
  await select(b); await fill('Beta 独立草稿');
  check('另一会话的重试期间 Beta 保持等待和可编辑', await evaluate(`document.querySelector('#send').textContent==='等待'&&!document.querySelector('#input').disabled`));
  await shot('09-retry-in-progress');
  await click('#configToggle');
  check('回答中仍可打开模型设置', await waitFor(panel, `!!document.querySelector('[data-cfg="model"]')&&!document.querySelector('#configSave').disabled`));
  await fill('fixture-local/next-selection', '[data-cfg="model"]');
  check('保存设置时原回答仍在进行', await evaluate(`document.querySelector('#send').textContent==='等待'`)
    && !chats.getSession(a).messages.at(-1).text.includes('这是一条本机协议验收回复'));
  await click('#configSave');
  check('回答期间新模型设置保存成功', await waitFor(panel, `document.querySelector('#configStatus').textContent.includes('已保存')&&!document.querySelector('#configSave').disabled`));
  await click('#configClose');
  check('重试完成落在 Alpha，未污染 Beta', await waitFor(panel, `(async()=>{const s=await window.companion.cardSessions.get({id:${JSON.stringify(a)}});return s.messages.at(-1)?.text.includes('这是一条本机协议验收回复');})()`, 15000)
    && chats.getSession(b).messages.length === 0 && await draft() === 'Beta 独立草稿');
  check('保存新模型没有中断旧模型正在进行的真实 SDK 请求', chats.getSession(a).messages.at(-1).status === 'ok');
  await shot('06-cross-session-retry-protection');
  await select(a);
  check('返回 Alpha 后新草稿仍在，只有一个原问题', (await draft()).includes('Alpha 新草稿') && chats.getSession(a).messages.filter(m=>m.role==='user').length === 1);
  await shot('07-restart-retry-result', '#messages .msg:last-child');
  server.setMode('ok');
  await click('#configToggle');
  check('设置已加载', await waitFor(panel, `!!document.querySelector('[data-cfg="model"]')&&!document.querySelector('#configSave').disabled`));
  await fill('fixture-local/missing-model', '[data-cfg="model"]');
  check('不存在的模型有本地提示', await evaluate(`document.querySelector('.cfg-model-state').dataset.state==='unknown'`));
  await click('#configSave');
  check('手填设置已保存', await waitFor(panel, `document.querySelector('#configStatus').textContent.includes('已保存')&&!document.querySelector('#configSave').disabled`));
  await click('#configClose');
  const requestCount = server.requests.length;
  await send('未知模型需要能回到设置恢复。'); await waitError('unknown-model');
  check('未知模型在请求之前拒绝，没有发往默认服务', server.requests.length === requestCount);
  await shot('08-unknown-model', '#messages .msg:last-child');
  await click(action('unknown-model', 'configure')); await configure('fixture-local/check'); await click('#configClose');
  await click(action('unknown-model', 'restore'));
  check('取回原问题可编辑，不会自动发送', await waitFor(panel, `document.querySelector('#input').value==='未知模型需要能回到设置恢复。'`) && server.requests.length === requestCount);
  check('最终无渲染控制台异常', consoleErrors(panel).length === 0);
  fs.writeFileSync(path.join(shots, 'acceptance.json'), JSON.stringify({ date: '2026-11-27', platform: process.platform,
    assertions: checks.length, checks, backend: 'real installed SDK, real local HTTP/SSE, synthetic responses; no chat IPC stubs',
    realProvider: false, limitations: ['Windows 未验收', '真实提供商质量与凭据有效性未验收'] }, null, 2));
  passed = true; console.log(`PASS ${checks.length} assertions; screenshots: ${shots}`);
} catch (failure) {
  if (panel) { await capture(panel, path.join(shots, 'FAILED.png')).catch(()=>{}); console.error(await evaluate('document.body.innerText').catch(()=>'')); }
  console.error(app?.log?.join('').slice(-1800)); console.error(`验收现场保留：${root}`); throw failure;
} finally {
  await app?.stop(); await server.close(); owner.close();
  if (passed) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
