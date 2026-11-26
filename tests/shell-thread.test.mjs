// #105 卡片壳：消息流的状态迁移用纯函数断言，渲染只验「引用了哪份实现」。
// 不联网、不起 Electron；DOM 层的行为交给 scripts/e2e/desktop-card-shell.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const thread = require('../desktop/shell-thread.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('空会话：一开始没有消息', () => {
  const messages = thread.createThread();
  assert.ok(Array.isArray(messages));
  assert.equal(messages.length, 0);
});

test('能不能发送只看有没有正文，空白与换行算空', () => {
  assert.equal(thread.canSend('你好'), true);
  assert.equal(thread.canSend('  前后有空格  '), true);
  assert.equal(thread.canSend(''), false);
  assert.equal(thread.canSend('   '), false);
  assert.equal(thread.canSend('\n\t '), false);
  assert.equal(thread.canSend(undefined), false);
});

test('发送一条：先我的消息，再一条占位回复', () => {
  const next = thread.sendTurn(thread.createThread(), '整理一下今天的待办');
  assert.equal(next.length, 2);
  assert.equal(next[0].role, 'user');
  assert.equal(next[0].text, '整理一下今天的待办');
  assert.equal(next[1].role, 'agent');
  assert.equal(thread.isPlaceholder(next[1]), true);
  assert.match(next[1].text, /占位/, '占位回复必须自己说清楚是假的');
  assert.ok(next[1].text.includes('整理一下今天的待办'), '占位回复要能对上是哪一句');
});

test('占位回复不算真实回复：不是 placeholder 的消息一律判假', () => {
  assert.equal(thread.isPlaceholder({ role: 'agent', text: '真的回复' }), false);
  assert.equal(thread.isPlaceholder({ role: 'user', text: '我' }), false);
  assert.equal(thread.isPlaceholder(null), false);
});

test('连发两条：顺序是 我/占位/我/占位，长度按 2 递增', () => {
  const once = thread.sendTurn(thread.createThread(), '第一句');
  const twice = thread.sendTurn(once, '第二句');
  assert.equal(twice.length, 4);
  assert.deepEqual(twice.map((item) => item.role), ['user', 'agent', 'user', 'agent']);
  assert.deepEqual(twice.filter((item) => item.role === 'user').map((item) => item.text), ['第一句', '第二句']);
  assert.deepEqual(twice.map((item) => item.text.split('\n')[0]).slice(2, 3), ['第二句']);
});

test('空输入不产生消息，也不改原数组', () => {
  const before = thread.createThread();
  assert.equal(thread.sendTurn(before, '   '), before);
  assert.equal(thread.sendTurn(before, ''), before);
  assert.equal(before.length, 0);
});

test('发送不改旧数组：上一帧的流可以拿去比对', () => {
  const before = thread.sendTurn(thread.createThread(), '保住这一帧');
  const snapshot = before.map((item) => item.text);
  const after = thread.sendTurn(before, '再来一条');
  assert.equal(before.length, 2);
  assert.deepEqual(before.map((item) => item.text), snapshot);
  assert.equal(after.length, 4);
});

test('长度有上限：过长的句子在占位回复里截断，但不影响我那条原样保存', () => {
  const long = '这是一句很长的话'.repeat(20);
  const next = thread.sendTurn(thread.createThread(), long);
  assert.equal(next[0].text, long);
  assert.ok(next[1].text.length < long.length, '占位回复不该把整段再抄一遍');
  assert.match(next[1].text, /…/);
});

test('发送后输入框要清空：清空规则是纯函数', () => {
  assert.equal(thread.draftAfterSend(), '');
});

test('新壳引用的是自己那份实现，没有拉旧面板进来', () => {
  const html = read('desktop/shell.html');
  const js = read('desktop/shell.js');
  assert.match(html, /shell\.css/);
  assert.match(html, /shell-thread\.cjs/);
  assert.match(html, /shell-sessions\.cjs/);
  assert.match(html, /shell\.js/);
  assert.doesNotMatch(html, /panel\.(html|js|css)/, '新壳不能引用旧面板文件');
  assert.match(js, /OwnerShellThread/);
  assert.match(js, /OwnerShellSessions/);
  // 旧面板功能的特征名一个都不该出现在新壳里（三档、两区）。
  assert.doesNotMatch(js, /modeBar|opsZone|handoffProjectId/);
});

test('顶栏只放开三个入口：#106 的会话、#107 的项目、#127 的配置，其余三位仍是状态位', () => {
  const html = read('desktop/shell.html');
  for (const slot of ['session', 'project', 'write', 'monitor', 'export']) {
    assert.match(html, new RegExp(`data-slot="${slot}"`), `缺顶栏状态位：${slot}`);
  }
  const header = html.slice(html.indexOf('id="shellHeader"'), html.indexOf('</header>'));
  assert.equal((header.match(/class="capsule"/gu) ?? []).length, 2, '顶栏只有会话与项目两个胶囊');
  // 两个胶囊入口之外（胶囊与它们自己的浮层）只允许 #127 的齿轮：它打开的是全窗口覆盖层，
  // 不是第二套菜单；除它之外不再有按钮、输入框或链接。
  const entriesStart = header.indexOf('<div class="session-entry">');
  const entriesEnd = header.indexOf('<span class="slot" data-slot="write">');
  assert.ok(entriesStart > 0 && entriesEnd > entriesStart, '入口与状态位的顺序变了');
  const outsideEntries = header.slice(0, entriesStart) + header.slice(entriesEnd);
  const configEntry = /<span class="config-entry">[\s\S]*?<\/span>/u.exec(outsideEntries);
  assert.ok(configEntry, '缺少配置入口（#127 的齿轮）');
  assert.equal((outsideEntries.match(/<span class="config-entry">/gu) ?? []).length, 1, '配置入口只能有一个');
  assert.match(configEntry[0], /<button[^>]*id="configToggle"/u, '配置入口应是一个按钮');
  // 配置箱本体挂在顶栏之外（全窗口覆盖层），别塞进 header。
  assert.doesNotMatch(header, /id="configBox"/u, '配置箱不应塞进顶栏');
  const withoutConfig = outsideEntries.replace(configEntry[0], '');
  assert.doesNotMatch(withoutConfig, /<button|<select|<input|<a /u, '顶栏入口之外只放这一个齿轮');
});
