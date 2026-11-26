// #126「分享到飞书」：目标选择、原文 + 出处组装、确认被取消时零发送、失败后内容仍在、
// 未配置 webhook 的提示。这里只喂纯数据，不起 Electron；卡片 DOM 与流内回执由 e2e 覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const share = require('../desktop/shell-at-share.cjs');
const at = require('../desktop/shell-at.cjs');

const USER = (text) => ({ role: 'user', text });
const AGENT = (text) => ({ role: 'agent', text });

const MESSAGES = [
  USER('第一问：周五能交付吗？'),
  AGENT('第一答：能，周五下午。'),
  USER('第二问：验收谁来？'),
  AGENT('   ')
];

const CONTEXT = { project: '示例项目', session: '交付对话', time: '2026-11-26T08:00:00.000Z' };

// ── 目标选择：只有飞书可选，其它平台可见但置灰 ──────────────────────

test('目标列表：飞书可选，其它平台可见但标「暂不支持」', () => {
  const targets = share.shareTargets();
  assert.deepEqual(targets.map((item) => item.key), ['feishu', 'wecom', 'slack']);
  assert.equal(targets.filter((item) => item.supported).length, 1);
  assert.equal(targets[0].label, '飞书');
  for (const item of targets.slice(1)) {
    assert.equal(item.supported, false);
    assert.equal(item.note, '暂不支持');
  }
});

test('目标选择：置灰项点了不生效，落点永远是一个能发的平台', () => {
  assert.equal(share.selectTarget('feishu', 'wecom'), 'feishu');
  assert.equal(share.selectTarget('feishu', 'slack'), 'feishu');
  assert.equal(share.selectTarget('feishu', 'nope'), 'feishu');
  assert.equal(share.selectTarget('wecom', 'feishu'), 'feishu');
  // 不认识的值不产生半截状态：退回飞书。
  assert.equal(share.selectTarget('nope', undefined), 'feishu');
  assert.equal(share.selectTarget(undefined, undefined), 'feishu');
});

test('计数文案沿用 #123 的同一句', () => {
  assert.equal(share.countText(0), '已选 0 条');
  assert.equal(share.countText(2), '已选 2 条');
  assert.equal(share.countText(undefined), '已选 0 条');
});

// ── 正文：原文 + 出处，不改写、不摘要 ──────────────────────────────

test('组装分享正文：出处三行在前，勾选的原文逐条引用在后', () => {
  const text = share.buildShareText({
    context: CONTEXT,
    messages: MESSAGES,
    selected: new Set([0, 1])
  });
  assert.ok(text.startsWith('【分享自 Companion】'), text.slice(0, 40));
  assert.ok(text.includes('- 项目：示例项目'));
  assert.ok(text.includes('- 会话：交付对话'));
  assert.ok(text.includes('- 时间：2026-11-26T08:00:00.000Z'));
  // 引用标签沿用 #123 的编号，原文逐字引用。
  assert.ok(text.includes('**我的第 1 句**\n\n> 第一问：周五能交付吗？'), text);
  assert.ok(text.includes('**第 1 条回复**\n\n> 第一答：能，周五下午。'), text);
  // 没勾的不出现；空正文与越界下标被忽略。
  assert.ok(!text.includes('第二问'));
  assert.ok(!text.includes('第 2 条回复'));
  const filtered = share.buildShareText({
    context: CONTEXT,
    messages: MESSAGES,
    selected: [2, 3, 99, -1, 'x']
  });
  assert.ok(filtered.includes('我的第 2 句'));
  assert.equal(filtered.match(/> /gu)?.length, 1);
});

test('组装分享正文：没有任何可分享原文时只留下处，不造空引用', () => {
  const text = share.buildShareText({ context: CONTEXT, messages: MESSAGES, selected: [3] });
  assert.ok(text.includes('【分享自 Companion】'));
  assert.ok(text.includes('- 会话：交付对话'));
  assert.ok(!text.includes('>'));
});

// ── 草稿：发送那一刻定下来，失败 / 取消后内容还在 ──────────────────

test('草稿：没有可分享原文就不造草稿', () => {
  assert.equal(share.draftOf({ messages: MESSAGES, selected: [] }), null);
  assert.equal(share.draftOf({ messages: MESSAGES, selected: [3] }), null);
});

test('草稿：记下会话、条数、下标与组装好的正文', () => {
  const draft = share.draftOf({
    id: 'share-1',
    target: 'feishu',
    sessionId: 's1',
    session: '交付对话',
    project: '示例项目',
    time: '2026-11-26T08:00:00.000Z',
    messages: MESSAGES,
    selected: new Set([1, 0]),
    at: '2026-11-26T09:00:00.000Z'
  });
  assert.equal(draft.id, 'share-1');
  assert.equal(draft.target, 'feishu');
  assert.equal(draft.count, 2);
  assert.deepEqual(draft.indexes, [0, 1]);
  assert.deepEqual(draft.entries.map((entry) => entry.label), ['我的第 1 句', '第 1 条回复']);
  assert.ok(draft.text.includes('> 第一问：周五能交付吗？'));
  assert.ok(draft.text.includes('- 项目：示例项目'));
});

test('确认卡输入：目的地写飞书，逐条列出勾选的原文，顺序固定', () => {
  const draft = share.draftOf({
    id: 'share-2', session: '交付对话', messages: MESSAGES, selected: [0, 1]
  });
  const spec = share.confirmSpecOf(draft, { id: 'share-feishu-share-2-1' });
  assert.equal(spec.id, 'share-feishu-share-2-1');
  assert.equal(spec.target, '飞书');
  assert.equal(spec.items.length, 2);
  assert.equal(spec.items[0].label, '我的第 1 句');
  assert.ok(spec.items[0].note.includes('第一问'));
  assert.ok(spec.sequence.includes('外发单独一档'));
});

// ── 一次投递：取消零发送、失败可重试、成功丢草稿 ──────────────────

const fakeDeliver = (results) => {
  const calls = [];
  const deliver = async (input) => {
    calls.push(input);
    return results.shift() ?? { status: 'sent', detail: 'feishu code 0' };
  };
  return { calls, deliver };
};

const draftFixture = () => share.draftOf({
  id: 'share-9',
  session: '交付对话',
  project: '示例项目',
  messages: MESSAGES,
  selected: [0, 1],
  at: '2026-11-26T09:00:00.000Z'
});

test('确认卡取消：一次都不发，草稿原样保留，回执说清取消', async () => {
  const { calls, deliver } = fakeDeliver([]);
  const outcome = await share.actShare({ action: 'cancel', draft: draftFixture(), deliver });
  assert.equal(calls.length, 0, '取消不得触发任何投递');
  assert.equal(outcome.kind, 'cancel');
  assert.equal(outcome.effects.length, 0);
  assert.equal(outcome.clearDraft, false, '取消不丢内容');
  assert.equal(outcome.reply.blocks[0].status, 'cancelled');
  assert.ok(outcome.reply.blocks[0].canRetry);
  assert.ok(outcome.reply.text.includes('什么都没发'));
  assert.ok(outcome.reply.text.includes('还留着'));
});

test('确认卡允许：只调一次 deliverFeishu，成功回执带会话与条数，草稿被清掉', async () => {
  const { calls, deliver } = fakeDeliver([{ status: 'sent', detail: 'feishu code 0' }]);
  const outcome = await share.actShare({ action: 'send-once', draft: draftFixture(), deliver });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text.includes('> 第一问：周五能交付吗？'), true);
  assert.equal(calls[0].target, 'feishu');
  assert.equal(outcome.kind, 'sent');
  assert.equal(outcome.clearDraft, true);
  assert.ok(outcome.reply.text.includes('已分享 2 条'));
  assert.ok(outcome.reply.text.includes('交付对话'));
  const block = outcome.reply.blocks[0];
  assert.equal(block.status, 'sent');
  assert.equal(block.count, 2);
  assert.equal(block.canRetry, false);
});

test('投递失败：回执带原因，草稿保留，给重试（不会自动重试）', async () => {
  const { calls, deliver } = fakeDeliver([{ status: 'failed', detail: 'feishu http 500' }]);
  const outcome = await share.actShare({ action: 'send-once', draft: draftFixture(), deliver });
  assert.equal(calls.length, 1, '一次点击只投一次');
  assert.equal(outcome.kind, 'failed');
  assert.equal(outcome.clearDraft, false, '失败后内容不丢');
  assert.ok(outcome.reply.text.includes('feishu http 500'));
  assert.ok(outcome.reply.text.includes('不会自动重试'));
  const block = outcome.reply.blocks[0];
  assert.equal(block.status, 'failed');
  assert.equal(block.detail, 'feishu http 500');
  assert.equal(block.draftId, 'share-9');
  assert.ok(block.canRetry);
});

test('投递抛错：按失败收口，不只留一个空白原因', async () => {
  const deliver = async () => { throw new Error('桥断了'); };
  const outcome = await share.actShare({ action: 'send-once', draft: draftFixture(), deliver });
  assert.equal(outcome.kind, 'failed');
  assert.ok(outcome.reply.blocks[0].detail.includes('桥断了'));
  assert.equal(outcome.clearDraft, false);
});

test('卡片过期（草稿已不在）：零发送，明确说要重新勾选', async () => {
  const { calls, deliver } = fakeDeliver([]);
  const outcome = await share.actShare({ action: 'send-once', draft: null, deliver });
  assert.equal(calls.length, 0);
  assert.equal(outcome.kind, 'expired');
  assert.ok(outcome.reply.text.includes('过期'));
  assert.ok(outcome.reply.text.includes('分享到飞书'));
  assert.equal(outcome.reply.blocks.length, 0);
});

test('不认识的动作不产生消息', async () => {
  const { deliver } = fakeDeliver([]);
  assert.equal(await share.actShare({ action: 'defer-low', draft: draftFixture(), deliver }), null);
  assert.equal(await share.actShare({ action: '', draft: draftFixture(), deliver }), null);
});

// ── 回执块：成功不给重试，失败 / 取消才给 ──────────────────────────

test('回执块：状态只认三种，成功不给重试，缺草稿 id 也不给', () => {
  const sent = share.receiptBlockOf({ status: 'sent', session: 'S', count: 2, draftId: 'share-1' });
  assert.equal(sent.canRetry, false);
  const failed = share.receiptBlockOf({ status: 'failed', session: 'S', count: 2, draftId: 'share-1' });
  assert.equal(failed.canRetry, true);
  assert.equal(share.receiptBlockOf({ status: 'failed', count: 2 }).canRetry, false);
  const weird = share.receiptBlockOf({ status: 'bogus', count: 2, draftId: 'share-1' });
  assert.equal(weird.status, 'failed');
  // 条数不合法按 0：不写一句假统计。
  assert.equal(share.receiptBlockOf({ status: 'sent', count: -3 }).count, 0);
  assert.equal(share.receiptBlockOf({ status: 'sent', count: 'x' }).count, 0);
});

// ── 未配置 webhook：明确提示 + 去哪儿配，不静默失败 ────────────────

test('未配置：提示里写明「未配置」与环境变量名', () => {
  const hint = share.unconfiguredHint({
    ok: true, configured: false, env: 'OWNER_OBSERVER_FEISHU_WEBHOOK'
  });
  assert.ok(hint.includes('未配置'), hint);
  assert.ok(hint.includes('OWNER_OBSERVER_FEISHU_WEBHOOK'), hint);
  assert.ok(hint.includes('feishu.json'), hint);
  // 配好了就没有提示。
  assert.equal(share.unconfiguredHint({ ok: true, configured: true }), '');
});

test('读不到配置状态：也是可见的提示，不当作已配置', () => {
  const hint = share.unconfiguredHint({ ok: false, reason: '这个窗口没有拿到主进程接口' });
  assert.ok(hint.includes('读不到'));
  assert.ok(hint.includes('主进程接口'));
  assert.ok(hint.includes('OWNER_OBSERVER_FEISHU_WEBHOOK'), hint);
});

// ── 落进流之后的归一化：按钮只按状态重算，不信存储里的 canRetry ─────

test('回执块归一化：状态白名单、条数取整、canRetry 按状态与草稿 id 重算', () => {
  const blocks = require('../desktop/shell-blocks.cjs');
  const failed = blocks.normalizeBlock({
    type: 'share', status: 'failed', session: 'S', count: 2.7, detail: 'boom', draftId: 'share-1'
  });
  assert.equal(failed.type, 'share');
  assert.equal(failed.count, 2);
  assert.equal(failed.canRetry, true);
  const sent = blocks.normalizeBlock({
    type: 'share', status: 'sent', count: 2, draftId: 'share-1', canRetry: true
  });
  assert.equal(sent.canRetry, false, '成功不给重试，存储里写了也不画');
  const bogus = blocks.normalizeBlock({ type: 'share', status: 'what', count: 'x' });
  assert.equal(bogus.status, 'failed');
  assert.equal(bogus.count, 0);
  assert.equal(bogus.canRetry, false);
});

test('回执块归一化：answers 里记过「重试」就收起按钮，只留记录', () => {
  const blocks = require('../desktop/shell-blocks.cjs');
  const model = blocks.normalizeReply({
    text: '',
    blocks: [{
      type: 'share', status: 'failed', session: 'S', count: 1, draftId: 'share-1'
    }],
    answers: { 0: '重试' }
  });
  assert.equal(model.blocks[0].answered, '重试');
});

// ── 与 #122 容器的接缝：share 是第四条，顺序在 session 之后 ─────────

test('方法注册表：share 是第四条且自带 mount，菜单顺序在 session 之后', () => {
  assert.equal(typeof at.atContent('share').mount, 'function');
  assert.equal(at.atContent('share').todo, undefined);
  assert.deepEqual(
    at.atMethods().map((method) => method.key),
    ['prompt', 'project', 'session', 'share']
  );
  assert.equal(at.atMethod('share').title, '分享到飞书');
});
