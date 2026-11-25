// #113 写入风险评级与确认卡：归一化、卡片数据形状、改判、动作落点。
// 全部只断言纯函数，不启动 Electron、不读盘、不联网。
// 界面（四个动作、判据可展开、改判后出现新卡）在 scripts/e2e/desktop-risk-card.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const risk = require('../desktop/risk-card.cjs');
const blocks = require('../desktop/shell-blocks.cjs');

/** 一份完整、合法的评估器输出；各用例按需删字段或改值。 */
const VALID = Object.freeze({
  level: 'medium',
  impact: 'project',
  reversibility: 'rebuild',
  leavesMachine: false,
  criteria: ['会写进被观察的项目目录', '回退提交可以撤掉', '本次不含删除'],
  whyNotOthers: '项目级且需重建，够不上高风险的不可逆；也不是只写自有目录的低风险。'
});

const copy = (value) => JSON.parse(JSON.stringify(value));

test('正常输入保持：等级、三轴、判据一字不改，判据展开后至少四条', () => {
  const model = risk.normalizeRisk(copy(VALID));
  assert.equal(model.level, 'medium');
  assert.equal(model.levelLabel, '中风险');
  assert.equal(model.impact, 'project');
  assert.equal(model.reversibility, 'rebuild');
  assert.equal(model.leavesMachine, false);
  assert.deepEqual(model.criteria, VALID.criteria);
  assert.deepEqual(model.originalCriteria, VALID.criteria);
  assert.equal(model.whyNotOthers, VALID.whyNotOthers);
  assert.equal(model.degraded, false);
  assert.equal(model.escalated, false);
  assert.ok(model.basis.length >= 4, `判据展开至少四条，实际 ${model.basis.length}`);
  assert.ok(model.basis.some((line) => line.startsWith('为什么不是别的等级：')), '要有为什么不是别的等级');
  assert.equal(model.axes.length, 3);
  assert.deepEqual(model.axes.map((axis) => axis.key), ['impact', 'reversibility', 'leavesMachine']);
});

test('缺字段一律降为高风险，并把缺的是哪一项写进原因', () => {
  const cases = [
    ['level', '等级'],
    ['impact', '影响面'],
    ['reversibility', '可逆性'],
    ['leavesMachine', '是否离开本机'],
    ['criteria', '判据'],
    ['whyNotOthers', '为什么不是别的等级']
  ];
  for (const [field, label] of cases) {
    const raw = copy(VALID);
    delete raw[field];
    const model = risk.normalizeRisk(raw);
    assert.equal(model.level, 'high', `缺 ${field} 应当是高风险`);
    assert.equal(model.degraded, true, `缺 ${field} 应当标为降级`);
    assert.match(model.degradedReason, new RegExp(label, 'u'), `缺 ${field} 的原因要写出 ${label}`);
    assert.equal(model.levelLabel, '高风险');
    assert.ok(model.basis.some((line) => line.includes('为什么不是别的等级')),
      '降级卡也要有一句「为什么不是别的等级」');
  }
});

test('未知等级与未知轴值都降为高风险，不猜也不夹在中间', () => {
  for (const level of ['critical', 'urgent', '低风险?', 'MEDIUM-HIGH']) {
    const model = risk.normalizeRisk({ ...copy(VALID), level });
    assert.equal(model.level, 'high', `未知等级 ${level}`);
    assert.equal(model.degraded, true);
    assert.match(model.degradedReason, /未知等级/u);
  }
  const badAxis = risk.normalizeRisk({ ...copy(VALID), impact: 'worldwide' });
  assert.equal(badAxis.level, 'high');
  assert.match(badAxis.degradedReason, /影响面/u);

  const badLeaves = risk.normalizeRisk({ ...copy(VALID), leavesMachine: 'maybe' });
  assert.equal(badLeaves.level, 'high');
  assert.match(badLeaves.degradedReason, /是否离开本机/u);
});

test('空判据 / 非对象 / 超时：一律高风险，原因可读', () => {
  for (const criteria of [[], ['  '], ['', '   '], null]) {
    const model = risk.normalizeRisk({ ...copy(VALID), criteria });
    assert.equal(model.level, 'high', `空判据 ${JSON.stringify(criteria)}`);
    assert.equal(model.degraded, true);
    assert.match(model.degradedReason, /判据/u);
  }
  for (const raw of [null, undefined, 42, 'nope', []]) {
    const model = risk.normalizeRisk(raw);
    assert.equal(model.level, 'high');
    assert.equal(model.degraded, true);
    assert.match(model.degradedReason, /高风险/u);
  }
  const timeout = risk.normalizeRisk(null, { timeout: true });
  assert.equal(timeout.level, 'high');
  assert.equal(timeout.degraded, true);
  assert.match(timeout.degradedReason, /超时/u);
  const marker = risk.normalizeRisk({ status: 'timeout' });
  assert.equal(marker.level, 'high');
  assert.match(marker.degradedReason, /超时/u);
  const flag = risk.normalizeRisk({ timeout: true });
  assert.equal(flag.level, 'high');
  assert.match(flag.degradedReason, /超时/u);
  const errored = risk.normalizeRisk({ error: '模型不可用' });
  assert.equal(errored.level, 'high');
  assert.match(errored.degradedReason, /模型不可用/u);
});

test('恰好边界：等级低于三轴允许的档位时抬到高（或中）', () => {
  const boundary = [
    { impact: 'cross-project' },
    { reversibility: 'irreversible' },
    { leavesMachine: true }
  ];
  for (const patch of boundary) {
    const model = risk.normalizeRisk({ ...copy(VALID), level: 'low', ...patch });
    assert.equal(model.level, 'high', JSON.stringify(patch));
    assert.equal(model.escalated, true);
    assert.match(model.escalationReason, /至少是高风险/u);
  }
  // 项目目录 + 需重建：低风险不够，但不必抬到高。
  const medium = risk.normalizeRisk({ ...copy(VALID), level: 'low' });
  assert.equal(medium.level, 'medium');
  assert.equal(medium.escalated, true);
  assert.match(medium.escalationReason, /至少是中风险/u);

  // 评估器给高就是高，不会被三轴降回去。
  const high = risk.normalizeRisk({ ...copy(VALID), level: 'high' });
  assert.equal(high.level, 'high');
  assert.equal(high.escalated, false);
});

test('中文与 key 两种写法都能归一化；严格按固定文案输出三轴', () => {
  const model = risk.normalizeRisk({
    level: '高',
    impact: '项目级',
    reversibility: '不可逆',
    leavesMachine: '否',
    criteria: ['写项目目录', '删除后不可还原', '不离开本机'],
    whyNotOthers: '不可逆且影响项目，只能是高风险。'
  });
  assert.equal(model.level, 'high');
  assert.deepEqual(model.axes.map((axis) => axis.valueLabel), ['项目级', '不可逆', '否']);
});

test('四轴动作固定：四个都在，低风险免问只对低风险可点', () => {
  const low = risk.riskCardModelOf(risk.normalizeRisk({
    ...copy(VALID), level: 'low', impact: 'machine', reversibility: 'reversible'
  }), { paths: ['C:\\tmp\\a.md'] });
  assert.deepEqual(low.actions.map((action) => action.label), [
    '允许这一次', '低风险免问', '我的判断不同', '取消'
  ]);
  assert.equal(low.actions.find((action) => action.id === 'defer-low').enabled, true);

  const high = risk.riskCardModelOf(risk.normalizeRisk({
    ...copy(VALID), level: 'high', reversibility: 'irreversible'
  }), { paths: ['D:\\work\\a.md'] });
  assert.equal(high.actions.length, 4);
  const defer = high.actions.find((action) => action.id === 'defer-low');
  assert.equal(defer.enabled, false);
  assert.match(defer.reason, /只对低风险生效/u);
});

test('卡片数据形状：标题 / 等级徽章 / 结论 / 三轴 / 逐条路径 / 判据 / 四动作', () => {
  const card = risk.riskCardModelOf(risk.normalizeRisk(copy(VALID)), {
    id: 'risk-shape',
    title: '写入项目目录的一份 ADR',
    conclusion: '会新增一份 ADR，影响项目但不离开本机。',
    paths: ['D:\\work\\integration\\docs\\adr\\0014.md', 'D:\\work\\integration\\README.md'],
    destination: 'project'
  });
  for (const key of [
    'type', 'id', 'title', 'level', 'levelLabel', 'conclusion', 'axes',
    'paths', 'criteria', 'basis', 'whyNotOthers', 'originalCriteria',
    'overrides', 'overridden', 'actions', 'degraded', 'degradedReason'
  ]) {
    assert.ok(Object.hasOwn(card, key), `卡片缺字段 ${key}`);
  }
  assert.equal(card.type, 'risk');
  assert.equal(card.level, 'medium');
  assert.equal(card.levelLabel, '中风险');
  assert.equal(card.axes.length, 3);
  assert.deepEqual(card.paths, [
    'D:\\work\\integration\\docs\\adr\\0014.md',
    'D:\\work\\integration\\README.md'
  ], '路径要逐条保留，不合并、不省略');
  assert.ok(card.basis.length >= 4);
  assert.equal(card.overrides.length, 0);
  assert.equal(card.overridden, false);
});

test('改判：原判据不动，人工记录并列追加，新卡换 id', () => {
  const card = risk.riskCardModelOf(risk.normalizeRisk({
    ...copy(VALID), level: 'high', reversibility: 'irreversible'
  }), {
    id: 'risk-override',
    paths: ['D:\\work\\delete-me.md']
  });
  const first = risk.applyRiskOverride(card, {
    level: 'low', note: '只是一份旧草稿', at: '2026-11-26T00:00:00.000Z'
  });
  assert.notEqual(first.id, card.id);
  assert.equal(first.level, 'low');
  assert.equal(first.levelLabel, '低风险');
  assert.equal(first.overridden, true);
  assert.equal(first.originalLevelLabel, '高风险');
  assert.deepEqual(first.criteria, card.criteria, '原判据不能被覆盖');
  assert.deepEqual(first.originalCriteria, card.criteria);
  assert.equal(first.overrides.length, 1);
  assert.equal(first.overrides[0].level, 'low');
  assert.equal(first.overrides[0].note, '只是一份旧草稿');
  assert.ok(first.basis.includes(card.criteria[0]), '展开后的判据仍含原判据');
  assert.ok(first.basis.some((line) => line.includes('人工改判 1')), '人工记录要并列出现');

  const second = risk.applyRiskOverride(first, {
    level: 'low', note: '再确认一次', at: '2026-11-26T00:10:00.000Z'
  });
  assert.equal(second.overrides.length, 2);
  assert.deepEqual(second.criteria, card.criteria, '第二次改判也不覆盖原判据');
  assert.ok(second.basis.some((line) => line.includes('人工改判 1')));
  assert.ok(second.basis.some((line) => line.includes('人工改判 2')));
  assert.notEqual(second.id, first.id);
});

test('动作落点：允许 / 免问 / 改判 / 取消都返回要进会话的两条消息', () => {
  const highCard = risk.riskCardModelOf(risk.normalizeRisk({
    ...copy(VALID), level: 'high', reversibility: 'irreversible'
  }), { paths: ['D:\\work\\a.md'] });

  const allow = risk.riskAction({ card: highCard, action: 'allow-once' });
  assert.equal(allow.answeredLabel, '允许这一次');
  assert.equal(allow.userText, '允许这一次');
  assert.match(allow.reply.text, /不执行真实写入/u);
  assert.equal(allow.reply.blocks, undefined);

  const cancel = risk.riskAction({ card: highCard, action: 'cancel' });
  assert.equal(cancel.userText, '取消');
  assert.match(cancel.reply.text, /什么都没写/u);

  assert.equal(risk.riskAction({ card: highCard, action: 'defer-low' }), null,
    '非低风险点免问不能生效');

  const override = risk.riskAction({
    card: highCard, action: 'override', level: 'low', note: '我看过了',
    at: '2026-11-26T00:00:00.000Z'
  });
  assert.match(override.userText, /我的判断不同：改为低风险/u);
  assert.match(override.userText, /我看过了/u);
  assert.equal(override.reply.blocks.length, 1);
  assert.equal(override.reply.blocks[0].overridden, true);
  assert.equal(override.reply.blocks[0].level, 'low');

  const lowCard = risk.riskCardModelOf(risk.normalizeRisk({
    ...copy(VALID), level: 'low', impact: 'machine', reversibility: 'reversible'
  }), { paths: ['C:\\tmp\\a.md'] });
  const defer = risk.riskAction({ card: lowCard, action: 'defer-low' });
  assert.equal(defer.answeredLabel, '低风险免问');
  assert.match(defer.reply.text, /只作用于低风险/u);
  assert.equal(risk.riskAction({ card: lowCard, action: 'explode' }), null);
});

test('卡片不显示密钥或任何凭据：路径、判据、结论、改判备注都脱敏', () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz012345';
  const github = 'ghp_0123456789abcdefghij';
  const password = 'password=supersecret123';
  const card = risk.riskCardModelOf(risk.normalizeRisk({
    ...copy(VALID),
    criteria: [`评估器把 token 抄进了判据：${secret}`, `远端凭据 ${github}`, '正常判据']
  }), {
    id: 'risk-secret',
    title: `写入 ${secret}`,
    conclusion: `用 ${password} 连一下`,
    paths: [`D:\\work\\${github}.md`, 'D:\\work\\正常.md']
  });
  const text = JSON.stringify(card);
  assert.equal(text.includes(secret), false, '原始 sk- 密钥不能出现');
  assert.equal(text.includes(github), false, '原始 GitHub token 不能出现');
  assert.equal(text.includes('supersecret123'), false, '赋值型密码不能出现');
  assert.match(text, /<redacted:api-key>/u);
  assert.match(text, /<redacted:github-token>/u);

  const overridden = risk.applyRiskOverride(card, {
    level: 'low', note: `其实只是 ${secret} 这个测试密钥`, at: '2026-11-26T00:00:00.000Z'
  });
  assert.equal(JSON.stringify(overridden).includes(secret), false);
  assert.match(overridden.overrides[0].note, /<redacted:api-key>/u);
});

test('评估器注入：假实现原样生效，抛错 / 超时 / 缺实现都降为高', async () => {
  let seen = null;
  const fake = (input) => {
    seen = input;
    return copy(VALID);
  };
  const input = { destination: 'project', paths: ['D:\\work\\a.md'] };
  const assessed = await risk.assessRisk({ evaluator: fake, input });
  assert.deepEqual(seen, input, '注入的评估器应当收到调用方输入');
  assert.equal(assessed.level, 'medium');

  const failed = await risk.assessRisk({
    evaluator: () => { throw new Error('模型挂了'); },
    input
  });
  assert.equal(failed.level, 'high');
  assert.match(failed.degradedReason, /模型挂了/u);

  const timedOut = await risk.assessRisk({
    evaluator: () => new Promise(() => {}),
    input,
    timeoutMs: 5
  });
  assert.equal(timedOut.level, 'high');
  assert.match(timedOut.degradedReason, /超时/u);

  const missing = await risk.assessRisk({ evaluator: null, input });
  assert.equal(missing.level, 'high');
  assert.match(missing.degradedReason, /没有注入/u);
});

test('/risk 样本：走注入评估器，高/中/低三档都有完整卡片；换成假实现就换结果', async () => {
  const high = await risk.buildRiskReply('/risk high');
  assert.equal(high.blocks.length, 1);
  assert.equal(high.blocks[0].type, 'risk');
  assert.equal(high.blocks[0].level, 'high');
  assert.equal(high.blocks[0].paths.length, 2, '逐条路径');
  assert.equal(high.blocks[0].actions.length, 4);
  assert.match(high.blocks[0].title, /删除/u);

  const low = await risk.buildRiskReply('/risk low');
  assert.equal(low.blocks[0].level, 'low');
  assert.equal(low.blocks[0].actions.find((action) => action.id === 'defer-low').enabled, true);

  const medium = await risk.buildRiskReply('/risk medium');
  assert.equal(medium.blocks[0].level, 'medium');

  // 注入一个「一律低风险」的假评估器：卡片必须跟着假实现走，证明评级不是写死的。
  const fakeLow = await risk.buildRiskReply('/risk high', {
    evaluator: () => ({
      ...copy(VALID), level: 'low', impact: 'machine', reversibility: 'reversible'
    })
  });
  assert.equal(fakeLow.blocks[0].level, 'low');

  assert.equal(risk.isRiskCommand('/risk'), true);
  assert.equal(risk.isRiskCommand('/risk high'), true);
  assert.equal(risk.isRiskCommand('  /risk low  '), true);
  assert.equal(risk.isRiskCommand('/risk urgent'), false);
  assert.equal(risk.isRiskCommand('/blocks'), false);
});

test('块层：type=risk 能归一化，答案收起动作，存储里的坏等级降为高', () => {
  const card = risk.riskCardModelOf(risk.normalizeRisk(copy(VALID)), {
    id: 'risk-block',
    paths: ['D:\\work\\a.md', 'D:\\work\\b.md']
  });
  const block = blocks.normalizeBlock(card);
  assert.equal(block.type, 'risk');
  assert.equal(block.index, 0);
  assert.equal(block.axes.length, 3);
  assert.equal(block.actions.length, 4);
  assert.deepEqual(block.paths, card.paths);

  const answered = blocks.normalizeReply({ blocks: [card], answers: { 0: '允许这一次' } });
  assert.equal(answered.blocks[0].type, 'risk');
  assert.equal(answered.blocks[0].answered, '允许这一次');

  const broken = blocks.normalizeBlock({
    ...card, level: 'critical', levelLabel: '超高风险'
  });
  assert.equal(broken.level, 'high');
  assert.equal(broken.levelLabel, '高风险');
  assert.equal(broken.degraded, true);
  assert.match(broken.degradedReason, /等级/u);

  const noCriteria = blocks.normalizeBlock({ ...card, criteria: [] });
  assert.equal(noCriteria.level, 'high');
  assert.match(noCriteria.degradedReason, /判据/u);

  // 降级过的卡不能靠存储里的 level 混成低风险；人工改判过的卡才允许保留人工档位。
  const degradedLow = blocks.normalizeBlock({ ...card, level: 'low', degraded: true });
  assert.equal(degradedLow.level, 'high');
  assert.match(degradedLow.degradedReason, /降级/u);
  const humanLow = blocks.normalizeBlock({
    ...card, level: 'low', degraded: true, overridden: true,
    overrides: [{ level: 'low', at: '2026-11-26T00:00:00.000Z', note: '我看过了' }]
  });
  assert.equal(humanLow.level, 'low');
});
