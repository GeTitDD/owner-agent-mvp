// #109 生成式 UI 块：块的归一化、图表几何、提问块的下一轮规则，全部是纯函数，
// 直接断言「给这些数据，渲染模型长什么样」。DOM 与样式交给
// scripts/e2e/desktop-blocks.mjs；这里不启动 Electron。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const blocks = require('../desktop/shell-blocks.cjs');
const thread = require('../desktop/shell-thread.cjs');

test('回复形状：只有文字、只有块、两者都有都合法；非数组的块按没有块处理', () => {
  assert.deepEqual(blocks.normalizeReply('只说一句'), { text: '只说一句', blocks: [] });
  assert.deepEqual(blocks.normalizeReply(null), { text: '', blocks: [] });
  assert.deepEqual(blocks.normalizeReply(undefined), { text: '', blocks: [] });

  const textOnly = blocks.normalizeReply({ text: '  只有文字  ' });
  assert.equal(textOnly.text, '只有文字');
  assert.equal(textOnly.blocks.length, 0);

  const blockOnly = blocks.normalizeReply({ blocks: [{ type: 'kv', rows: [['a', '1']] }] });
  assert.equal(blockOnly.text, '');
  assert.equal(blockOnly.blocks.length, 1);

  const both = blocks.normalizeReply({
    text: '带块',
    blocks: [{ type: 'code', code: 'echo 1' }]
  });
  assert.equal(both.text, '带块');
  assert.equal(both.blocks[0].type, 'code');

  const junkBlocks = blocks.normalizeReply({ text: 'x', blocks: 'nope' });
  assert.equal(junkBlocks.blocks.length, 0, '块不是数组时不能把整条回复弄坏');
});

test('未知类型降级成纯文本：保留原类型与标题，块数不变', () => {
  const model = blocks.normalizeReply({
    blocks: [
      { type: 'chart', title: '旧版折线', points: [1, 2] },
      { type: 'kv', rows: [['键', '值']] }
    ]
  });
  assert.equal(model.blocks.length, 2, '未知块不能整条消失');
  assert.equal(model.blocks[0].type, 'unknown');
  assert.equal(model.blocks[0].sourceType, 'chart');
  assert.match(model.blocks[0].text, /未知块/u);
  assert.match(model.blocks[0].text, /chart/u);
  assert.match(model.blocks[0].text, /旧版折线/u);
  assert.equal(model.blocks[1].type, 'kv');
});

test('不是对象、缺类型、类型大小写：都落到可读的降级文字', () => {
  const model = blocks.normalizeReply({
    blocks: [null, '一段字符串', { title: '没有类型' }, { type: 'KPI', items: [] }]
  });
  assert.equal(model.blocks.length, 4);
  assert.equal(model.blocks[0].type, 'unknown');
  assert.match(model.blocks[0].text, /第 1 个/u);
  assert.match(model.blocks[1].text, /一段字符串/u);
  assert.match(model.blocks[2].text, /缺失/u);
  assert.equal(model.blocks[3].type, 'kpi', '类型大小写不该决定认不认识');
});

test('审核卡：kind 认 lesson / candidate / decision，行与动作都有上限且不吞空动作', () => {
  const lesson = blocks.normalizeBlock({
    type: 'review',
    lessonId: 'l1',
    title: '重试没有上限',
    rows: [['机制', 'm'], ['对策', 'c']],
    actions: [{ id: 'promote', label: '提升为候选' }, { id: '', label: '空' }]
  });
  assert.equal(lesson.kind, 'lesson');
  assert.equal(lesson.lessonId, 'l1');
  assert.deepEqual(lesson.actions, [{ id: 'promote', label: '提升为候选' }]);

  const candidate = blocks.normalizeBlock({
    type: 'review',
    kind: 'candidate',
    proposalId: 'p1',
    rows: Array.from({ length: 12 }, (_, index) => [`k${index}`, `v${index}`]),
    actions: [{ id: 'approve', label: '接受' }, { id: 'reject', label: '拒绝' }, { id: 'x', label: 'X' }, { id: 'y', label: 'Y' }]
  });
  assert.equal(candidate.kind, 'candidate');
  assert.equal(candidate.rows.length, 8);
  assert.equal(candidate.actions.length, 3);

  // #135：决策候选与经验候选是不同的 kind，项目与指纹要带到渲染层。
  const decision = blocks.normalizeBlock({
    type: 'review',
    kind: 'decision',
    projectId: 'alpha',
    fingerprint: 'fp-1',
    missingReason: true,
    rows: [['现象', '换 esbuild']],
    actions: [{ id: 'accept', label: '接受' }, { id: 'reject', label: '拒绝' }]
  });
  assert.equal(decision.kind, 'decision');
  assert.equal(decision.projectId, 'alpha');
  assert.equal(decision.fingerprint, 'fp-1');
  assert.equal(decision.missingReason, true);

  // 缺标题时给一个能读的默认值，不出现空标题。
  const bare = blocks.normalizeBlock({ type: 'review' });
  assert.equal(bare.title, '经验');
});

test('缺字段的默认值：卡片没有分组、表格没有行、键值没有字段都不会报错', () => {
  const card = blocks.normalizeBlock({ type: 'card', title: '空卡片' });
  assert.deepEqual(card.sections, []);
  assert.equal(card.foot, null);

  const cardSection = blocks.normalizeBlock({ type: 'card', sections: [{ label: '组' }] });
  assert.deepEqual(cardSection.sections[0].items, []);
  assert.equal(cardSection.sections[0].empty, '');

  const table = blocks.normalizeBlock({ type: 'table' });
  assert.deepEqual(table.head, []);
  assert.deepEqual(table.rows, []);

  const kv = blocks.normalizeBlock({ type: 'kv', rows: [['只有键']] });
  assert.deepEqual(kv.rows[0], { key: '只有键', value: '' });

  const code = blocks.normalizeBlock({ type: 'code' });
  assert.deepEqual(code.lines, [], '没有代码就是零行，不画一个空行号');

  const badges = blocks.normalizeBlock({ type: 'badges', items: [{ text: '好', tone: '不是颜色' }] });
  assert.deepEqual(badges.items, [{ text: '好', tone: '' }], '不认识的色调按普通标签处理');
});

test('表格：短行补齐到头行长度，格子写成对象时取 text', () => {
  const table = blocks.normalizeBlock({
    type: 'table',
    head: ['a', 'b', 'c'],
    rows: [['1'], ['1', { text: '2' }, '3', '多出来的']]
  });
  assert.deepEqual(table.rows[0], ['1', '', '']);
  assert.deepEqual(table.rows[1], ['1', '2', '3', '多出来的']);
});

test('指标卡：涨跌方向由 delta 决定，缺 delta 时不硬编一个 0', () => {
  const kpi = blocks.normalizeBlock({
    type: 'kpi',
    items: [
      { label: '涨', value: 1, delta: '3' },
      { label: '跌', value: 2, delta: -2 },
      { label: '平', value: 3, delta: 0 },
      { label: '无', value: 4 }
    ]
  });
  assert.deepEqual(kpi.items.map((item) => item.direction), ['up', 'down', 'flat', 'flat']);
  assert.deepEqual(kpi.items.map((item) => item.deltaText), ['+3', '-2', '0', '']);
  assert.equal(kpi.items[0].value, '1');
});

test('折线几何：点都能落到 viewBox 里，末值取最后一个点', () => {
  const geometry = blocks.lineGeometry([42, 39, 44, 41]);
  assert.equal(geometry.ok, true);
  assert.equal(geometry.coords.length, 4);
  assert.equal(geometry.coords[0].x, 0);
  assert.equal(geometry.coords[3].x, 100);
  geometry.coords.forEach((point) => {
    assert.ok(point.y >= 2 && point.y <= 30, `y 超出 viewBox：${point.y}`);
  });
  assert.equal(geometry.last, 41);
  // 值越大越靠上：44 的 y 必须比 39 的 y 小。
  assert.ok(geometry.coords[2].y < geometry.coords[1].y);
});

test('折线退化：少于两个点、非数字混进来时只留有效点', () => {
  const one = blocks.lineGeometry([7]);
  assert.equal(one.ok, false);
  assert.match(one.reason, /两个/u);
  assert.equal(one.last, 7, '画不出图也要能说出末值');

  const filtered = blocks.normalizeBlock({ type: 'line', points: [1, 'x', null, 3] });
  assert.deepEqual(filtered.points, [1, 3]);
  assert.equal(blocks.lineGeometry([]).ok, false);
});

test('环形几何：百分比加起来是 100，偏移按顺序累加', () => {
  const geometry = blocks.donutGeometry([
    { label: 'a', value: 6 },
    { label: 'b', value: 4 }
  ]);
  assert.equal(geometry.ok, true);
  assert.equal(geometry.total, 10);
  assert.equal(geometry.arcs.length, 2);
  assert.equal(geometry.arcs[0].percent, 60);
  assert.equal(geometry.arcs[1].dashoffset, '-60.00');
  assert.ok(Math.abs(geometry.arcs.reduce((sum, arc) => sum + arc.percent, 0) - 100) < 0.001);

  const zero = blocks.donutGeometry([{ label: 'a', value: 0 }]);
  assert.equal(zero.ok, false);
  assert.match(zero.reason, /0/u);
});

test('提问块：选项最多四个，缺问题与缺文案都有默认值', () => {
  const ask = blocks.normalizeBlock({
    type: 'ask',
    options: ['1', '2', '3', '4', '5', '']
  });
  assert.equal(ask.options.length, blocks.ASK_OPTION_LIMIT);
  assert.equal(ask.question, '需要你确认一下');
  assert.ok(ask.free.placeholder.length > 0);
  assert.ok(ask.skip.label.length > 0);
  assert.match(ask.skip.note, /推断/u);
});

test('提问块的下一轮：选项、自由回答、跳过都有明确的用户话与脚本化回复', () => {
  const option = blocks.askAction({ question: '归到哪个项目？', kind: 'option', value: 'A' });
  assert.equal(option.userText, '选择：A');
  assert.equal(option.answeredLabel, 'A');
  assert.match(option.reply.text, /A/u);
  assert.match(option.reply.text, /脚本化/u);

  const free = blocks.askAction({ question: '归到哪个项目？', kind: 'free', value: '  新的项目  ' });
  assert.equal(free.userText, '新的项目', '自由回答就是我说的那句话');
  assert.equal(free.answeredLabel, '新的项目');

  const skip = blocks.askAction({ question: '归到哪个项目？', kind: 'skip' });
  assert.equal(skip.answeredLabel, '跳过');
  assert.match(skip.reply.text, /推断/u);

  assert.equal(blocks.askAction({ kind: 'free', value: '   ' }), null, '空回答不产生消息');
  assert.equal(blocks.askAction({ kind: 'option', value: '' }), null);
  assert.equal(blocks.askAction({ kind: 'what' }), null);
});

test('回答过的提问块：answerBlock 记在消息上，重新归一化时按钮能认出来', () => {
  const messages = thread.addReply(thread.createThread(), blocks.sampleReply());
  assert.equal(messages.length, 1);

  const answered = thread.answerBlock(messages, 0, 11, 'Companion Demo');
  assert.notEqual(answered, messages, '不能改旧帧');
  assert.equal(messages[0].answers, undefined);
  assert.deepEqual(answered[0].answers, { 11: 'Companion Demo' });

  const model = blocks.normalizeReply(answered[0]);
  assert.equal(model.blocks[11].type, 'ask');
  assert.equal(model.blocks[11].answered, 'Companion Demo');

  assert.equal(thread.answerBlock(messages, 0, 11, '   '), messages, '空选择不算回答');
  assert.equal(thread.answerBlock(messages, 5, 11, 'A'), messages, '消息序号越界不改流');
  assert.equal(thread.answerBlock(messages, 0, -1, 'A'), messages);
});

test('回复装配：只有文字、只有块、两者都有都追加；两样都没有不产生空气泡', () => {
  const base = thread.createThread();
  const textOnly = thread.addReply(base, { text: '只说一句' });
  assert.deepEqual(textOnly, [{ role: 'agent', text: '只说一句' }]);

  const blockOnly = thread.addReply(base, { blocks: [{ type: 'kv', rows: [['a', '1']] }] });
  assert.equal(blockOnly[0].text, '');
  assert.equal(blockOnly[0].blocks.length, 1);

  const both = thread.addReply(base, { text: '带块', blocks: [{ type: 'code', code: 'x' }] });
  assert.equal(both[0].text, '带块');
  assert.equal(both[0].blocks.length, 1);

  assert.equal(thread.addReply(base, { text: '   ' }), base);
  assert.equal(thread.addReply(base, { blocks: [] }), base);
  assert.equal(thread.addReply(base, null), base);
  assert.equal(thread.addReply(base, '裸字符串'), base, '回复必须是对象，字符串不该被猜成消息');
});

test('样本回复：十二种块各一条，顺序与清单一致，全部认得出来', () => {
  const reply = blocks.sampleReply();
  assert.ok(reply.text.length > 0, '样本本身也该示范「文字 + 块」');
  assert.deepEqual(
    reply.blocks.map((block) => block.type),
    blocks.BLOCK_TYPES,
    '样本要覆盖全部块类型'
  );
  const model = blocks.normalizeReply(reply);
  assert.equal(model.blocks.length, blocks.BLOCK_TYPES.length);
  model.blocks.forEach((block) => {
    assert.notEqual(block.type, 'unknown', `样本里不该有认不出的块：${block.sourceType}`);
  });
});

test('块全览的入口只认 /blocks 一条命令', () => {
  assert.equal(blocks.isSampleCommand('/blocks'), true);
  assert.equal(blocks.isSampleCommand('  /blocks  '), true);
  assert.equal(blocks.isSampleCommand('/blocks 后面还有字'), false);
  assert.equal(blocks.isSampleCommand('/Blocks'), false);
  assert.equal(blocks.isSampleCommand(''), false);
});
