// #123「生成 prompt」：勾选状态迁移、引用标签编号、四段组装。
// 这里只喂纯数据，不起 Electron；卡片 DOM 与流内点击由 e2e 覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const prompt = require('../desktop/shell-at-prompt.cjs');
const at = require('../desktop/shell-at.cjs');

const USER = (text) => ({ role: 'user', text });
const AGENT = (text) => ({ role: 'agent', text });

// ── 勾选：增删都返回新集合，不污染上一次 ────────────────────────────

test('勾选集合：点一次加入、再点一次取消，入参不被改', () => {
  const empty = prompt.emptySelection();
  const one = prompt.toggleSelection(empty, 2);
  assert.equal(empty.size, 0);
  assert.deepEqual([...one], [2]);
  const two = prompt.toggleSelection(one, 0);
  assert.deepEqual([...two].sort(), [0, 2]);
  const back = prompt.toggleSelection(two, 2);
  assert.deepEqual([...back], [0]);
  // 不合法下标：原样返回一份副本，不产生半个勾选。
  assert.deepEqual([...prompt.toggleSelection(one, -1)], [2]);
  assert.deepEqual([...prompt.toggleSelection(one, 'x')], [2]);
});

test('计数文案只有数字与单位', () => {
  assert.equal(prompt.countText(0), '已选 0 条');
  assert.equal(prompt.countText(2), '已选 2 条');
  assert.equal(prompt.countText(undefined), '已选 0 条');
});

test('没有文字的消息不可勾选：引用的是原文，空正文引不出东西', () => {
  assert.equal(prompt.isSelectable(USER('你好')), true);
  assert.equal(prompt.isSelectable(AGENT('   ')), false);
  assert.equal(prompt.isSelectable({ role: 'agent', text: '' }), false);
  assert.equal(prompt.isSelectable(null), false);
});

// ── 编号：提问与回复各自独立计数 ────────────────────────────────────

test('引用标签：我的第 N 句与第 N 条回复分别编号', () => {
  const messages = [
    USER('第一问'),
    AGENT('第一答'),
    USER('第二问'),
    AGENT('第二答')
  ];
  assert.deepEqual(prompt.referenceLabels(messages), [
    '我的第 1 句',
    '第 1 条回复',
    '我的第 2 句',
    '第 2 条回复'
  ]);
  // 连续两条回复不会把「我的」编号顶掉；反过来也一样。
  assert.deepEqual(prompt.referenceLabels([AGENT('a'), AGENT('b'), USER('q')]), [
    '第 1 条回复',
    '第 2 条回复',
    '我的第 1 句'
  ]);
});

// ── 组装：固定顺序、空段省略、引用原文 ─────────────────────────────

const HEADINGS = ['# 指令', '# 上下文', '## 引用对话（原文）', '# 我需要你'];

const headingOrder = (text) => HEADINGS
  .map((heading) => ({ heading, at: text.indexOf(heading) }))
  .filter((row) => row.at >= 0)
  .sort((a, b) => a.at - b.at)
  .map((row) => row.heading);

test('填了指令、选了消息：四段按固定顺序出现', () => {
  const messages = [USER('把 A 换成 B 吗？'), AGENT('可以，但要先补测试。')];
  const text = prompt.buildPrompt({
    instruction: '整理成一条决策记录',
    context: { project: '示例项目', session: '取舍讨论', time: '2026-11-26T08:00:00.000Z' },
    messages,
    selected: new Set([0, 1])
  });
  assert.deepEqual(headingOrder(text), HEADINGS);
  assert.ok(text.startsWith('# 指令\n\n整理成一条决策记录'));
  assert.ok(text.includes('- 项目：示例项目'));
  assert.ok(text.includes('- 会话：取舍讨论'));
  assert.ok(text.includes('- 时间：2026-11-26T08:00:00.000Z'));
  assert.ok(text.includes('**我的第 1 句**\n\n> 把 A 换成 B 吗？'));
  assert.ok(text.includes('**第 1 条回复**\n\n> 可以，但要先补测试。'));
  // 「我需要你」只复述同一句指令，不扩写。
  assert.ok(text.endsWith('# 我需要你\n\n整理成一条决策记录'));
});

test('空段整段不出现：没有指令、没有上下文、没有勾选就得到空串', () => {
  const text = prompt.buildPrompt({ instruction: '   ', context: {}, messages: [USER('x')], selected: new Set() });
  assert.equal(text, '');
  assert.equal(prompt.buildPrompt(), '');
});

test('空指令只省略「指令 / 我需要你」，上下文与引用照常', () => {
  const text = prompt.buildPrompt({
    instruction: '',
    context: { session: '只留会话' },
    messages: [USER('原样引用')],
    selected: new Set([0])
  });
  assert.deepEqual(headingOrder(text), ['# 上下文', '## 引用对话（原文）']);
  assert.ok(!text.includes('# 指令'));
  assert.ok(!text.includes('# 我需要你'));
  // 上下文只写有值的那一行。
  assert.ok(text.includes('# 上下文\n\n- 会话：只留会话'));
  assert.ok(!text.includes('- 项目：'));
});

test('引用保持原文：Markdown 符号、缩进与换行都不改写', () => {
  const raw = '# 标题不是指令\n第二行 | 表格竖线 | `代码`\n  缩进行';
  const text = prompt.buildPrompt({
    messages: [USER(raw)],
    selected: new Set([0])
  });
  // 原文每一行按行加引用符，内容本身一字不动。
  assert.ok(text.includes([
    '> # 标题不是指令',
    '> 第二行 | 表格竖线 | `代码`',
    '>   缩进行'
  ].join('\n')));
});

test('选中的下标按消息顺序输出；越界与无文字的条目被忽略', () => {
  const messages = [USER('第一条'), { role: 'agent', text: '' }, AGENT('第三块内容')];
  const text = prompt.buildPrompt({ messages, selected: new Set([2, 0, 1, 99]) });
  const first = text.indexOf('**我的第 1 句**');
  // 中间那条空回复仍然占「第 1 条回复」的编号，所以第三条是「第 2 条回复」。
  const second = text.indexOf('**第 2 条回复**');
  assert.ok(first >= 0 && second > first);
  assert.equal(text.match(/\*\*第 2 条回复\*\*/gu)?.length, 1);
  // 空正文没有被引成空引用。
  assert.equal(text.match(/> /gu)?.length, 2);
});

// ── 与 #122 容器的接缝：prompt 与 session 都带 mount ────────────────

test('方法卡注册表：prompt 与 session 都带 mount，菜单数据不变', () => {
  assert.equal(typeof at.atContent('prompt').mount, 'function');
  assert.equal(typeof at.atContent('session').mount, 'function');
  // 菜单数据没有因为这一票变动。
  assert.deepEqual(at.atMethods().map((method) => method.key), ['prompt', 'session']);
});
