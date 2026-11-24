// #47 对话：交办开关——路由与一次性语义用纯函数验证，不联网、不起 Electron。
//
// 两条路径必须互斥：关＝只读会话只回答；开＝companion:submit 走既有审批链路建待批准任务。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const handoff = require('../desktop/chat-handoff.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const projects = [
  { id: 'alpha', name: 'Alpha Repo' },
  { id: 'beta', name: 'Beta Repo' }
];

test('默认关闭：没打开开关时发送只回答，不建任务', () => {
  assert.equal(handoff.DEFAULT_ARMED, false);
  assert.equal(handoff.routeOf(handoff.DEFAULT_ARMED), 'answer');
  // 任何非 true 的脏值都退回只回答，避免状态漏写变成偷偷建任务。
  assert.equal(handoff.routeOf(undefined), 'answer');
  assert.equal(handoff.routeOf('true'), 'answer');
  assert.equal(handoff.routeOf(false), 'answer');
});

test('只有显式打开才走交办', () => {
  assert.equal(handoff.routeOf(true), 'handoff');
});

test('交办目标沿用 #41：会话没绑定或项目已删都拦下，不回退第一个', () => {
  assert.equal(handoff.targetOf(projects, null), null);
  assert.equal(handoff.targetOf(projects, { projectId: '' }), null);
  assert.equal(handoff.targetOf(projects, { projectId: 'gone' }), null);
  assert.equal(handoff.targetOf([], { projectId: 'alpha' }), null);
  assert.equal(handoff.targetOf(projects, { projectId: 'beta' }).id, 'beta');
});

test('发送按钮文案：关闭是「发送」，打开是「交办」', () => {
  assert.equal(handoff.sendLabel(false), '发送');
  assert.equal(handoff.sendLabel(true), '交办');
});

test('开关是一次性动作：发送一次就复位', () => {
  assert.deepEqual(handoff.consume(true), { armed: false, consumed: true });
  // 本来就是关闭状态：复位不算消费，界面不用提示「已复位」。
  assert.deepEqual(handoff.consume(false), { armed: false, consumed: false });
});

test('结果只有真生成写请求才算建了任务', () => {
  assert.equal(handoff.resultKind({ mode: 'write-request', jobId: 'j1' }), 'task');
  // 分诊判断不需要改文件：只回答，没有任务。
  assert.equal(handoff.resultKind({ mode: 'answer' }), 'answer');
  // 分诊失败/超时：同样没有任务，不能显示成已交办。
  assert.equal(handoff.resultKind({ mode: 'triage-error', category: 'timeout' }), 'error');
  assert.equal(handoff.resultKind(null), 'error');
});

test('渲染层：关闭路径不调用 submit，两条路径都由 routeOf 分叉', () => {
  const panel = fs.readFileSync(path.join(root, 'desktop/panel.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'desktop/panel.html'), 'utf8');
  // 开关可见、默认 aria-pressed=false。
  assert.match(html, /id="cHandoff"[\s\S]{0,160}aria-pressed="false"/u);
  assert.match(panel, /routeOf\(chatHandoffArmed\)[\s\S]{0,40}=== 'handoff'/u);
  // 只读分支只调 chat.ask；交办分支只调 companion.submit。
  assert.match(panel, /window\.companion\.chat\.ask\(\{/u);
  assert.match(panel, /window\.companion\.submit\(\{\s*\n\s*text,/u);
  // 一次性动作不落盘：不写 localStorage / 不调 settings.set。
  assert.equal(/localStorage\.setItem\([^)]*handoff/iu.test(panel), false);
  assert.equal(/chatHandoffArmed[^\n]*localStorage/u.test(panel), false);
});

test('主进程：交办仍然复用 companion:submit，没有新增任务创建通道', () => {
  const main = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
  // 渲染层的交办走既有的 companion:submit → submitCompanionTask → createWriteRequest。
  assert.match(main, /ipcMain\.handle\('companion:submit'/u);
  assert.match(main, /const submitCompanionTask = async \(\{ text, projectId \}\)/u);
  assert.match(main, /createWriteRequest,/u);
  // 没有为对话开关新开一条「直接建任务」的 IPC。
  assert.equal(/companion:chat-handoff/u.test(main), false);
  assert.equal(/companion:handoff-submit/u.test(main), false);
});
