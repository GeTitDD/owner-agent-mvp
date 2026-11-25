// #110 复制与导出：块/消息/会话 → Markdown 的纯函数断言。
// 入参都是 shell-blocks 归一化后的模型（与界面渲染同一份），不启动 Electron。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const blocks = require('../desktop/shell-blocks.cjs');
const copy = require('../desktop/shell-copy.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

/** 造一个归一化后的块；测试只碰模型，不碰原始字段的容错（那部分归 #109 的测试）。 */
const model = (raw, index = 0) => blocks.normalizeBlock(raw, index);

test('十二种块都能写成 Markdown：每种都保留自己的形状', () => {
  const sample = blocks.normalizeReply(blocks.sampleReply());
  const expected = {
    card: /### 项目库概览/u,
    table: /\| 提交 \| 说明 \| 时间 \|/u,
    kpi: /- \*\*提交\*\*：12 次/u,
    line: /- 第 7 点：33s/u,
    donut: /- 域包：6（50%）/u,
    timeline: /- 14:02 · 拍快照 — 把当前库压成一份只读快照/u,
    kv: /- 项目：Companion Demo/u,
    code: /```js\nconst reply/u,
    diff: /```diff\n function renderMessage/u,
    tool: /\*\*调用 knowledge\.search\("retry 上限"\)\*\*/u,
    badges: /- 提问（warn）/u,
    ask: /### 这条经验要归到哪个项目？/u
  };
  sample.blocks.forEach((block, index) => {
    const markdown = copy.blockToMarkdown(block);
    assert.ok(markdown.length > 0, `块为空：${block.type}`);
    const pattern = expected[block.type];
    assert.ok(pattern, `没有为 ${block.type} 写断言`);
    assert.match(markdown, pattern);
    // 每种块都只写自己：别的块的标题不该串进来。
    if (index !== sample.blocks.length - 1) assert.doesNotMatch(markdown, /这条经验要归到哪个项目/u);
  });
});

test('表格：头行、分隔行、每一条数据行都在，竖线被转义', () => {
  const markdown = copy.blockToMarkdown(model({
    type: 'table',
    title: '耗时',
    head: ['项', '值'],
    rows: [['a|b', '1'], ['c']]
  }));
  const lines = markdown.split('\n');
  assert.equal(lines[0], '### 耗时');
  assert.equal(lines[2], '| 项 | 值 |');
  assert.equal(lines[3], '| --- | --- |');
  assert.equal(lines[4], '| a\\|b | 1 |', '竖线必须转义，否则表格会多一列');
  assert.equal(lines[5], '| c |  |', '短行补空单元格');
});

test('表格空字段：没有头行也留空表头；没有数据不画半张表', () => {
  const noHead = copy.blockToMarkdown(model({ type: 'table', rows: [['x', 'y']] }));
  assert.match(noHead, /\|  \|  \|\n\| --- \| --- \|/u, '没有头行时留空表头，不拿第一行冒充');
  assert.match(noHead, /\| x \| y \|/u);

  const empty = copy.blockToMarkdown(model({ type: 'table' }));
  assert.doesNotMatch(empty, /\|/u, '没有数据就不该出现管道符号');
  assert.match(empty, /没有数据/u);
});

test('键值/时间线/徽章：都退成列表，空值保留键', () => {
  const kv = copy.blockToMarkdown(model({ type: 'kv', rows: [['只有键'], { key: '空', value: '' }] }));
  assert.match(kv, /- 只有键：$/mu);
  assert.match(kv, /- 空：$/mu);

  const timeline = copy.blockToMarkdown(model({
    type: 'timeline',
    steps: [{ title: '开始', at: '09:00' }, { title: '结束', meta: '完成' }]
  }));
  assert.match(timeline, /- 09:00 · 开始/u);
  assert.match(timeline, /- 结束 — 完成/u);

  const badges = copy.blockToMarkdown(model({ type: 'badges', items: [{ text: '好' }, { text: '坏', tone: 'warn' }] }));
  assert.deepEqual(badges.split('\n'), ['- 好', '- 坏（warn）']);
});

test('图表退化：折线每个数据点一行，环形保留数值与占比，绝不出现 svg', () => {
  const line = copy.blockToMarkdown(model({
    type: 'line', title: '构建', points: [42, 39, 44], unit: 's'
  }));
  assert.doesNotMatch(line, /<svg|polyline/u);
  [42, 39, 44].forEach((value) => assert.match(line, new RegExp(`\\b${value}s`, 'u')));
  assert.equal((line.match(/^- 第 \d+ 点：/gmu) ?? []).length, 3);

  const donut = copy.blockToMarkdown(model({
    type: 'donut',
    items: [{ label: 'a', value: 6 }, { label: 'b', value: 4 }]
  }));
  assert.match(donut, /- a：6（60%）/u);
  assert.match(donut, /- b：4（40%）/u);

  // 总量为 0 时画不出环，但原始数字不能跟着消失。
  const zero = copy.blockToMarkdown(model({ type: 'donut', items: [{ label: 'a', value: 0 }] }));
  assert.match(zero, /- a：0/u);
  assert.doesNotMatch(zero, /NaN%/u);
});

test('代码与 diff：围栏语言正确；代码里已有反引号时围栏自动加长', () => {
  const code = copy.blockToMarkdown(model({
    type: 'code', title: '入口', lang: 'js', code: 'const a = 1;\nconst b = 2;'
  }));
  assert.match(code, /```js\nconst a = 1;\nconst b = 2;\n```/u);

  const nested = copy.blockToMarkdown(model({ type: 'code', code: '```\ninner\n```' }));
  assert.match(nested, /````\n```\ninner\n```\n````/u, '围栏要比内容里最长的反引号更长');

  const emptyCode = copy.blockToMarkdown(model({ type: 'code' }));
  assert.doesNotMatch(emptyCode, /```/u, '空代码块不该画一对空围栏');

  const diff = copy.blockToMarkdown(model({
    type: 'diff',
    rows: [{ kind: 'ctx', text: 'a' }, { kind: 'del', text: 'b' }, { kind: 'add', text: 'c' }]
  }));
  assert.match(diff, /```diff\n a\n-b\n\+c\n```/u);
});

test('卡片：空分组、空字段都有可读落点；标签写成行内代码', () => {
  const empty = copy.blockToMarkdown(model({ type: 'card' }));
  assert.match(empty, /这个卡片没有分组/u);

  const markdown = copy.blockToMarkdown(model({
    type: 'card',
    sections: [{ label: '组', empty: '', items: [] }]
  }));
  assert.match(markdown, /\*\*组\*\*/u);
  assert.match(markdown, /- 这一组还没有条目/u, '空分组要有兜底文案');

  const tags = copy.blockToMarkdown(model({
    type: 'card',
    sections: [{ items: [{ title: '条目', tags: ['已验证'] }] }]
  }));
  assert.match(tags, /- 条目 · `已验证`/u);
});

test('未知块：保留模型自己的说明，不静默丢内容', () => {
  const unknown = blocks.normalizeBlock({ type: 'chart', title: '旧图' }, 2);
  const markdown = copy.blockToMarkdown(unknown);
  assert.match(markdown, /未知块/u);
  assert.match(markdown, /旧图/u);
});

test('消息 → Markdown：文字在前、块按顺序、块之间恰好一个空行', () => {
  const message = {
    role: 'agent',
    text: '这是正文',
    blocks: [
      { type: 'kv', rows: [['a', '1']] },
      { type: 'code', code: 'x' },
      { type: 'badges', items: [{ text: '好' }] }
    ]
  };
  const markdown = copy.messageToMarkdown(message);
  assert.ok(markdown.startsWith('这是正文\n\n'));
  const sections = markdown.split('\n\n');
  assert.ok(sections.some((part) => part.includes('- a：1')));
  assert.ok(sections.some((part) => part.includes('```\nx\n```')));
  assert.ok(sections.some((part) => part.includes('- 好')));
  assert.doesNotMatch(markdown, /\n{3,}/u, '块与块之间只留一个空行');

  assert.equal(copy.messageToMarkdown({ role: 'user', text: '   ' }), '', '空消息不产出空气泡');
  assert.equal(copy.messageToMarkdown({ role: 'user', text: '只有我' }), '只有我');
});

test('会话导出：四个头字段齐全，正文按角色分段且可重复', () => {
  const context = {
    project: 'Companion Demo',
    session: '把今天的待办整理成三条',
    time: '2026-11-25T10:00:00.000Z',
    model: '未接入（占位回复）'
  };
  const messages = [
    { role: 'user', text: '你好' },
    { role: 'agent', text: '收到', blocks: [{ type: 'table', head: ['a'], rows: [['1']] }] }
  ];
  const markdown = copy.conversationToMarkdown({ context, messages });
  assert.match(markdown, /^# 会话导出 · 把今天的待办整理成三条$/mu);
  assert.match(markdown, /^- 项目：Companion Demo$/mu);
  assert.match(markdown, /^- 会话：把今天的待办整理成三条$/mu);
  assert.match(markdown, /^- 时间：2026-11-25T10:00:00\.000Z$/mu);
  assert.match(markdown, /^- 模型：未接入（占位回复）$/mu);
  assert.match(markdown, /## 我\n\n你好/u);
  assert.match(markdown, /## Companion\n\n收到\n\n\| a \|/u);
  assert.equal(copy.conversationToMarkdown({ context, messages }), markdown, '同一份输入必须逐字节相同');
  assert.notEqual(
    copy.conversationToMarkdown({ context: { ...context, time: '2026-11-25T11:00:00.000Z' }, messages }),
    markdown,
    '时间属于会话上下文，换时间就该换头'
  );
});

test('会话头缺字段：有稳定默认值，不写 undefined', () => {
  const markdown = copy.conversationToMarkdown({
    context: {},
    messages: [{ role: 'agent', text: '只有一句' }]
  });
  assert.match(markdown, /- 项目：全局（未选项目）/u);
  assert.match(markdown, /- 会话：当前会话/u);
  assert.match(markdown, /- 时间：未记录/u);
  assert.match(markdown, /- 模型：未接入/u);
  assert.doesNotMatch(markdown, /undefined|null/u);
});

test('壳引用的是同一份复制实现：按钮声明在两层，写入点可注入', () => {
  const html = read('desktop/shell.html');
  const shell = read('desktop/shell.js');
  const view = read('desktop/shell-blocks-view.js');
  // 顺序：块模型 → 复制实现 → 块渲染 → 壳。复制实现必须先于使用它的脚本。
  assert.ok(html.indexOf('shell-blocks.cjs') < html.indexOf('shell-copy.cjs'));
  assert.ok(html.indexOf('shell-copy.cjs') < html.indexOf('shell-blocks-view.js'));
  assert.ok(html.indexOf('shell-blocks-view.js') < html.indexOf('shell.js'));
  assert.match(shell, /OwnerShellCopy/u);
  assert.match(shell, /window\.OwnerShellClipboard/u, '剪贴板必须留一个可注入的写入点');
  assert.match(shell, /copyMessage = '1'/u);
  assert.match(view, /copyBlock = '1'/u);
  assert.match(shell, /data-copy-active/u, '同一时刻只亮一个的规则在壳里');
});

test('新文件都在 npm run check 的清单里', () => {
  const check = JSON.parse(read('package.json')).scripts.check;
  [
    'desktop/shell-copy.cjs',
    'src/conversation-exports.mjs',
    'scripts/e2e/desktop-copy-export.mjs'
  ].forEach((file) => assert.ok(check.includes(file), `check 清单缺：${file}`));
});
