// 真实 Electron 旅程：定位直达、完整审核、失败重试、跨会话保护与具体变化。
// 仅在临时宿主替代一次审核失败与延迟；候选、审核成功、决策和水位均走真实 IPC/SQLite。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { OwnerStore } from '../../src/owner-store.mjs';
import { ChatSessionStore } from '../../src/chat-sessions.mjs';
import { PersonalKnowledgeStore } from '../../src/personal-store.mjs';
import { MemoryWatermarkStore } from '../../src/memory/watermark.mjs';
import { DecisionScanStore } from '../../src/memory/decision-scan-store.mjs';
import { pendingRecordOf } from '../../src/memory/decision-scan.mjs';
import { confirmDecisionCandidate } from '../../src/memory/decision-confirm.mjs';
import { candidateToProposal } from '../../src/knowledge-loop/contracts.mjs';
import { startApp, waitFor, capture, consoleErrors } from './lib/cdp.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-locate-review-'));
const shots = path.resolve(process.env.SHOTS_DIR || path.join(repo, '.verify/locate-review'));
const userData = path.join(root, 'data');
const ownerDb = path.join(root, 'owner.sqlite');
const knowledgeDb = path.join(root, 'knowledge.sqlite');
fs.mkdirSync(userData); fs.mkdirSync(shots, { recursive: true });
const owner = new OwnerStore(ownerDb);
const personal = new PersonalKnowledgeStore(knowledgeDb);
const chats = new ChatSessionStore({ db: owner.db });
const watermarks = new MemoryWatermarkStore({ db: owner.db });
const OLD = '2026-11-01T00:00:00.000Z';
const nameA = '中文项目 Alpha：需要看清完整选择、范围与证据的长名称';
for (const [id, name] of [['alpha', nameA], ['beta', 'Beta 独立项目']]) {
  const dir = path.join(root, id); fs.mkdirSync(dir);
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${id}\n`);
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=UX Fixture', '-c', 'user.email=ux@example.invalid', 'commit', '--quiet', '-m', '修复最后一次重试并增加边界校验'], {
    cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: '2026-11-25T10:00:00Z', GIT_COMMITTER_DATE: '2026-11-25T10:00:00Z' }
  });
  owner.registerProject({ id, name, root: dir, primaryDomain: 'software-engineering', domains: ['software-engineering'] });
  watermarks.put(id, OLD);
}
fs.writeFileSync(path.join(root, 'alpha', '需要完整显示的中文文件名-retry.mjs'), 'export const attempts = 3;\n');
const sessionA = chats.createSession({ projectId: 'alpha', title: 'Alpha 既有上下文' }).id;
const sessionB = chats.createSession({ projectId: 'beta', title: 'Beta 独立上下文' }).id;
const sessionG = chats.createSession({ title: '全局定位' }).id;
chats.appendMessage({ sessionId: sessionA, role: 'user', text: 'Alpha 历史只属于 Alpha。' });
chats.appendMessage({ sessionId: sessionB, role: 'user', text: 'Beta 历史只属于 Beta。' });
chats.saveDraft({ id: sessionA, projectId: 'alpha', text: 'Alpha 未发送草稿\n不能被定位动作覆盖' });
chats.saveDraft({ id: sessionG, projectId: '', text: '全局草稿仍然保留' });
chats.markOpened(sessionG);

const recordLesson = (projectId, phenomenon, ref) => personal.recordLesson({
  projectId, sourceRecordId: ref, phenomenon, mechanism: '循环边界漏掉最后一次执行',
  countermeasure: '明确重试上限，并覆盖最后一次成功的测试',
  scope: { layer: 'project', projectId, domainIds: ['software-engineering'] },
  evidenceRefs: [ref], verificationStatus: 'unverified'
}, { evidence: [{ ref, recordId: ref, kind: 'record', excerpt: '第三次请求成功，状态码 200；断言通过。' }] });
const lessonA = recordLesson('alpha', 'Alpha 重试最后一次丢失', 'record:alpha');
const lessonNew = recordLesson('alpha', '新经验：高延迟网络下也需要保留最后一次重试', 'record:promote');
const makeProposal = (id, projectId, title, proposedLayer = 'project') => {
  const mapped = candidateToProposal({ draft: { title,
    claim: `${title}\n机制：循环边界漏掉最后一次执行。\n对策：明确重试上限，保留最后一次机会。\n完整正文结尾标记。`,
    proposedLayer, applicability: ['网络超时后可以安全重试的请求'], exceptions: ['无权限或重复写入风险时不可重试'],
    evidenceRefs: ['record:alpha'], facts: ['第三次请求成功'], inferences: ['边界条件导致重试缺失'], unknowns: ['高并发边界尚未验证'] },
  projectId, domainIds: ['software-engineering'], sourceExperienceIds: [], harvestRunId: `ux:${id}` });
  return personal.submitProposal({ payload: mapped.payload, actor: 'ux-fixture',
    meta: { ...mapped.meta, sourceLessonIds: proposedLayer === 'domain' || projectId === 'alpha' ? [lessonA.id] : [] } });
};
const a1 = makeProposal('a1', 'alpha', '知识 A1：重试必须保留最后一次执行');
const a2 = makeProposal('a2', null, '共享候选 A2：仅沿 Alpha 来源归属', 'domain');
const b1 = makeProposal('b1', 'beta', 'Beta 专属候选，不应出现在 Alpha');
const decision = { fingerprint: 'ux-existing-choice', projectId: 'alpha', projectName: nameA,
  phenomenon: '请求失败导致项目反复重试', intent: '最多重试 3 次，并采用退避', abandoned: '无限重试',
  reason: '避免请求雪崩，同时保留失败恢复机会', source: 'codex', sessionId: 'synthetic-session',
  quote: { user: '最多重试 3 次', assistant: '好，采用上限 3 次和退避。' } };
confirmDecisionCandidate({ personalStore: personal, candidate: decision, reason: decision.reason });
const scanStore = new DecisionScanStore({ file: path.join(userData, 'memory-scan.json') });
scanStore.write({ pending: [pendingRecordOf({ ...decision, fingerprint: 'ux-pending-choice', phenomenon: '待确认决策：改用有上限的退避策略' })] });
const entry = path.join(root, 'test-host.cjs');
const calls = path.join(root, 'scan-calls.log');
fs.writeFileSync(entry, `
const {ipcMain}=require('electron');const fs=require('node:fs');
const register=ipcMain.handle.bind(ipcMain);let failed=false;let readFailed=false;
ipcMain.handle=(channel,handler)=>register(channel,async(event,input)=>{
  if(channel==='companion:decision-scan'||channel==='companion:session-scan'){
    fs.appendFileSync(${JSON.stringify(calls)},channel+'\\n');throw Error('验收禁止扫描个人会话');
  }
  if(channel==='companion:knowledge-review'&&input?.id===${JSON.stringify(a1.id)}&&!failed){failed=true;return {ok:false,reason:'临时不可用，请重试；候选未改变'};}
  if(channel==='companion:knowledge-review'&&input?.id===${JSON.stringify(a2.id)})await new Promise(r=>setTimeout(r,2200));
  if(channel==='companion:pending-proposals'&&input?.projectId==='beta'&&!readFailed){readFailed=true;throw Error('临时读取失败');}
  return handler(event,input);
});
require(${JSON.stringify(path.join(repo, 'desktop/main.cjs'))});
`);
const options = { userData, ownerDb, knowledgeDb, entry, env: { OWNER_AGENT_CHAT_FAKE: '1', OWNER_AGENT_WATCH_DIR: path.join(root, 'watch') } };
const checks = [];
const check = (label, condition) => { assert.ok(condition, label); checks.push(label); console.log(`OK ${label}`); };
let app; let panel;
let passed = false;
const evaluate = (code) => panel.evaluate(code);
const click = async (selector) => {
  const point = await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.getClientRects().length)throw Error('不可点击：'+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await panel.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await panel.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
};
const session = () => evaluate(`document.querySelector('#sessionList [data-current="true"]')?.dataset.id`);
const draft = () => evaluate('document.querySelector("#input").value');
const select = async (id) => {
  if (await evaluate('document.querySelector("#sessionPopover").hidden')) await click('#sessionToggle');
  await click(`.session-row[data-id="${id}"] [data-act="switch"]`);
  check('切换到目标会话', await waitFor(panel, `document.querySelector('.session-row[data-id="${id}"]')?.dataset.current==='true'&&!document.querySelector('#input').disabled`));
  if (!(await evaluate('document.querySelector("#sessionPopover").hidden'))) await click('#sessionToggle');
};
const global = async () => {
  await select(sessionG);
  check('定位屏加载完成', await waitFor(panel, `!document.querySelector('#locateView').hidden&&document.querySelectorAll('#locateList .locate-row').length===2&&!document.querySelector('#locateStatus').textContent.includes('正在')`));
};
const open = async (id, intent) => {
  const target = id === 'alpha' ? sessionA : sessionB;
  const before = chats.getSession(target).messageCount;
  await click(`#locateList [data-project="${id}"] [data-locate-intent="${intent}"]`);
  check('定位直接进入项目，没有切换确认', await waitFor(panel, `document.querySelector('#projectToggle').dataset.scope===${JSON.stringify(id)}&&!document.querySelector('#input').disabled`) && await evaluate('document.querySelector("#projectConfirm").hidden'));
  if (intent !== 'project') check('定位内容已落进会话', await waitFor(panel, `document.querySelectorAll('#messages .msg').length>=${before + 2}&&document.querySelector('#messages')?.textContent.includes(${JSON.stringify(intent === 'since' ? '本次检查' : '只展示已有内容')})&&document.querySelector('#toast').hidden`));
};
const shot = async (name, selector) => {
  if (selector) await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'start'})`);
  await capture(panel, path.join(shots, `${name}.png`));
  check(`${name}：窗口与内容无横向溢出`, await evaluate(`document.documentElement.scrollWidth<=innerWidth+1&&[...document.querySelectorAll('.review-row dd,.locate-row,.block-kv')].filter(e=>e.getClientRects().length).every(e=>e.scrollWidth<=e.clientWidth+1)`));
};
const pendingLabel = (id) => evaluate(`document.querySelector('#locateList .locate-row[data-project="${id}"] .locate-pending')?.textContent`);
const card = (id) => `[data-review-kind="candidate"][data-proposal-id="${id}"]`;

try {
  app = await startApp(options); panel = app.panel;
  check('初始回到全局，草稿已恢复', await waitFor(panel, `document.querySelector('#input').value==='全局草稿仍然保留'`));
  check('定位屏按项目计数', await waitFor(panel, `document.querySelector('#locateList .locate-row[data-project="alpha"] .locate-pending')?.textContent.includes('待确认 3')`));
  check('最近决策显示选择和理由', await evaluate(`document.querySelector('#locateList').textContent.includes('最多重试 3 次，并采用退避')&&document.querySelector('#locateList').textContent.includes('避免请求雪崩')`));
  await shot('01-locate-choice-and-actions', '#locateView');
  await open('alpha', 'pending');
  check('恢复 Alpha 原会话', await session() === sessionA);
  check('定位打开保留 Alpha 多行草稿', await draft() === 'Alpha 未发送草稿\n不能被定位动作覆盖');
  check('候选范围隔离且完整显示正文/证据/条件/例外', await evaluate(`(() => {const t=document.querySelector('#messages').textContent;const v=[...document.querySelectorAll('[data-experience-field]')].map(e=>e.value).join('\\n');return v.includes('完整正文结尾标记')&&t.includes('第三次请求成功，状态码 200')&&t.includes('来源项目：${nameA}')&&v.includes('无权限或重复写入风险')&&!t.includes('Beta 专属候选');})()`));
  check('查看待确认不推进任何水位', watermarks.get('alpha').at === OLD && watermarks.get('beta').at === OLD);
  await shot('02-full-candidate-light', `${card(a1.id)} h4`);
  await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await shot('03-full-candidate-dark', `${card(a1.id)} h4`);
  await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await global();
  check('返回全局恢复全局草稿', await draft() === '全局草稿仍然保留');
  await open('alpha', 'pending');
  check('重复进入复用原会话，不污染历史归属', await session() === sessionA && chats.listSessions().length === 3);
  check('重复查看生成两张同一候选卡供状态同步验收', await evaluate(`document.querySelectorAll(${JSON.stringify(card(a1.id))}).length===2`));
  await click(`${card(a1.id)} [data-review-action="approve"]`);
  check('审核失败留有清楚回执', await waitFor(panel, `document.querySelector('#messages').textContent.includes('临时不可用，请重试')`));
  check('审核失败候选未变且按钮仍可重试', personal.proposal(a1.id).status === 'pending' && await evaluate(`!!document.querySelector(${JSON.stringify(`${card(a1.id)} [data-review-action="approve"]`)})`));
  await shot('04-review-failure-retry', '#messages .msg:last-child');
  await click(`${card(a1.id)} [data-review-action="approve"]`);
  check('重试接受成功', await waitFor(panel, `document.querySelector('#messages').textContent.includes('已接受并沉淀为知识')`));
  const approved = personal.proposal(a1.id);
  const applied = personal.get(approved.applied_id);
  check('入库正文、项目、验证状态与审核前一致', approved.status === 'approved' && applied.content === a1.payload.content+'\n\n适用条件：网络超时后可以安全重试的请求\n例外 / 边界：无权限或重复写入风险时不可重试' && applied.projectId === 'alpha' && applied.verificationStatus === 'unverified');
  check('同一会话重复卡片同时收起操作', await evaluate(`document.querySelectorAll(${JSON.stringify(`${card(a1.id)} [data-review-action]`)}).length===0`));
  await click(`${card(a2.id)} [data-review-action="reject"]`);
  await select(sessionB);
  check('切换项目不把 A 审核中回执显示到 B', await evaluate(`!document.querySelector('#messages').textContent.includes('共享候选 A2')`));
  check('延迟审核已落回原 Alpha 会话', await waitFor(panel, `(async()=>{const r=await window.companion.cardSessions.get({id:${JSON.stringify(sessionA)}});return r.messages.some(m=>m.text.includes('已拒绝：共享候选 A2'));})()`));
  check('Beta 历史没有混入 Alpha 审核结果', !chats.getSession(sessionB).messages.some((message) => message.text.includes('共享候选 A2')));
  await global();
  check('已处理后定位计数正确，其他项目不变', (await pendingLabel('alpha')).includes('待确认 1') && (await pendingLabel('beta')).includes('待确认 1'));
  await open('alpha', 'pending');
  await shot('05-existing-decision', '[data-review-kind="decision"] h4');
  await click('[data-review-kind="decision"] [data-review-action="reject"]');
  check('决策候选可直接拒绝', await waitFor(panel, `document.querySelector('#messages').textContent.includes('已拒绝')&&document.querySelector('[data-review-kind="decision"] .review-answered')`));
  await global();
  check('处理完成空态清楚且不可点击', (await pendingLabel('alpha')) === '没有待确认' && await evaluate(`document.querySelector('#locateList .locate-row[data-project="alpha"] .locate-pending').disabled`));
  await shot('06-pending-cleared', '#locateView');
  await open('alpha', 'since');
  check('变化展示提交标题与实际中文文件', await evaluate(`document.querySelector('#messages').textContent.includes('修复最后一次重试并增加边界校验')&&document.querySelector('#messages').textContent.includes('需要完整显示的中文文件名-retry.mjs')`));
  check('查看变化只推进 Alpha 水位，保留 Beta 水位', watermarks.get('alpha').at !== OLD && watermarks.get('beta').at === OLD);
  check('查看变化不清除草稿', await draft() === 'Alpha 未发送草稿\n不能被定位动作覆盖');
  await shot('07-specific-changes', '#messages .msg:last-child');
  await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await shot('08-specific-changes-dark', '#messages .msg:last-child');
  await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await global();
  await open('beta', 'pending');
  check('部分读取失败明确说明，不把失败当作没有候选', await evaluate(`document.querySelector('#messages').textContent.includes('知识候选读取失败，请返回重试')`) && personal.proposal(b1.id).status === 'pending');
  await shot('12-read-failure', '#messages .msg:last-child');
  await global(); await open('beta', 'pending');
  check('读取失败可以返回重试，恢复 Beta 自己的候选', await waitFor(panel, `!!document.querySelector(${JSON.stringify(card(b1.id))})`) && await evaluate(`!document.querySelector('#messages').textContent.includes('知识 A1')`));
  check('阅读或重试候选仍不推进 Beta 水位', watermarks.get('beta').at === OLD);
  await global();
  const afterChanges = watermarks.get('alpha').at;
  await open('alpha', 'project');
  check('点击项目名称只恢复会话，未读水位保持不动', await session() === sessionA && watermarks.get('alpha').at === afterChanges && watermarks.get('beta').at === OLD);
  await click('#input'); await evaluate('document.querySelector("#input").select()');
  await panel.send('Input.insertText', { text: '/经验' });
  check('技能面板不遮挡实际发送按钮', await waitFor(panel, `(() => {const p=document.querySelector('#skillPanel'),c=document.querySelector('#composer');return !p.hidden&&p.getBoundingClientRect().bottom<=c.getBoundingClientRect().top;})()`));
  await shot('09-slash-above-composer');
  await click('#send');
  check('经验列表加载完成', await waitFor(panel, `!!document.querySelector('[data-lesson-id="${lessonNew.id}"] [data-review-action="promote"]')`));
  await click(`[data-lesson-id="${lessonNew.id}"] [data-review-action="promote"]`);
  check('新提升候选立即含完整正文与证据', await waitFor(panel, `(() => {const e=[...document.querySelectorAll('[data-review-kind="candidate"]')].at(-1);return e?.textContent.includes('高延迟网络')&&e.textContent.includes('第三次请求成功，状态码 200');})()`));
  await shot('10-promote-full-review', '#messages .msg:last-child');
  check('所有定位旅程都未触发会话扫描', !fs.existsSync(calls));
  check('没有渲染控制台错误', consoleErrors(panel).length === 0);
  await app.stop(); app = await startApp(options); panel = app.panel;
  check('重启后审核结果仍在，待处理经验候选也保留', await waitFor(panel, `document.querySelector('#messages')?.textContent.includes('新经验：高延迟网络')`) && personal.proposal(a1.id).status === 'approved' && personal.proposal(a2.id).status === 'rejected');
  await shot('11-restarted-review', '#messages .msg:last-child');
  fs.writeFileSync(path.join(shots, 'acceptance.json'), JSON.stringify({ date: '2026-11-26', platform: process.platform, assertions: checks.length, checks,
    substitutions: ['一次审核失败、一次读取失败、一次延迟的临时测试宿主', '未调用模型'], limitations: ['macOS 验收，不代表 Windows 已验收'] }, null, 2));
  passed = true;
  console.log(`PASS ${checks.length} assertions; screenshots: ${shots}`);
} catch (error) {
  if (panel) { await capture(panel, path.join(shots, 'FAILED.png')).catch(() => {}); console.error(await evaluate('document.body.innerText').catch(() => '')); }
  console.error(app?.log?.join('').slice(-2000));
  console.error(`验收现场保留：${root}`);
  throw error;
} finally {
  await app?.stop(); personal.close(); owner.close();
  if (passed) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
