// #116 外发 / 删除确认卡：卡片必填内容、动作表、取消无副作用、删除回执与剩余项。
// 只断言纯函数（desktop/confirm-cards.cjs），界面与截图另由 scripts/e2e/desktop-confirm-cards.mjs 验收。
import test from 'node:test';
import assert from 'node:assert/strict';
import cards from '../desktop/confirm-cards.cjs';

const {
  externalCardModelOf,
  deleteCardModelOf,
  normalizeConfirmCard,
  confirmAction,
  parseCommand,
  isCommand
} = cards;

const EXTERNAL_ITEMS = [
  { label: 'ADR 0012 摘要', path: 'D:\\work\\integration\\docs\\adr\\0012.md' },
  { label: '导出快照', path: 'C:\\Users\\Owner\\.owner-agent\\knowledge\\exports\\snapshot-index.md' }
];

const DELETE_ITEMS = [
  { label: '0014-export-policy.md', path: 'D:\\work\\integration\\docs\\adr\\0014.md' },
  { label: '0013-write-by-destination.md', path: 'D:\\work\\integration\\docs\\adr\\0013.md' },
  { label: '导出目录 v3', path: 'C:\\Users\\Owner\\.owner-agent\\exports\\cmp-demo\\v3' }
];

const rowValue = (block, key) => block.rows.find((row) => row[0] === key)?.[1] ?? '';

test('外发卡：明确「发出即收不回」，只有发出 / 取消，没有免问', () => {
  const card = externalCardModelOf({
    id: 'external-sample',
    target: '飞书 · Companion 群',
    items: EXTERNAL_ITEMS
  });
  assert.equal(card.type, 'confirm');
  assert.equal(card.kind, 'external');
  assert.equal(card.headline, '发出即收不回');
  assert.match(card.conclusion, /收不回/u);
  assert.equal(card.target, '飞书 · Companion 群');
  assert.deepEqual(card.actions.map((action) => action.id), ['send-once', 'cancel']);
  assert.deepEqual(card.actions.map((action) => action.label), ['发出这一次', '取消']);
  // 「以后不用问」必须是「不存在」，不是「禁用」。
  assert.equal(card.actions.some((action) => /免问|不用再问|不必再问/u.test(action.label)), false);
  assert.equal(card.actions.some((action) => action.id === 'defer-low'), false);
  assert.match(card.notices.join('\n'), /没有「以后不用问」/u);
  assert.deepEqual(card.items.map((item) => item.path), EXTERNAL_ITEMS.map((item) => item.path));
});

test('外发卡归一化：存储里伪造的 defer-low 不会复活', () => {
  const forged = normalizeConfirmCard({
    kind: 'external',
    id: 'forged',
    items: EXTERNAL_ITEMS,
    actions: [{ id: 'defer-low', label: '以后不用问' }, { id: 'allow-all', label: '全部发出' }]
  });
  assert.deepEqual(forged.actions.map((action) => action.id), ['send-once', 'cancel']);
  assert.match(forged.headline, /收不回/u);
  assert.match(forged.notices.join('\n'), /没有「以后不用问」/u);
});

test('删除卡：逐条列出对象，每项一个按钮，没有批量入口', () => {
  const card = deleteCardModelOf({ id: 'delete-sample', items: DELETE_ITEMS });
  assert.equal(card.type, 'confirm');
  assert.equal(card.kind, 'delete');
  assert.equal(card.items.length, 3);
  assert.deepEqual(card.items.map((item) => item.path), DELETE_ITEMS.map((item) => item.path));
  // 每项一个 delete-item + 一个取消，没有任何「全部 / 批量」动作。
  assert.equal(card.actions.filter((action) => action.id === 'delete-item').length, 3);
  assert.deepEqual(card.actions.filter((action) => action.id === 'delete-item')
    .map((action) => action.index), [0, 1, 2]);
  assert.equal(card.actions.filter((action) => action.id === 'cancel').length, 1);
  assert.equal(card.actions.some((action) => /全部|批量|所有/u.test(action.label)), false);
  assert.equal(card.actions.some((action) => action.id === 'defer-low'), false);
  assert.match(card.notices.join('\n'), /没有批量放行/u);
});

test('删除卡归一化：存储里伪造的批量动作会被丢掉', () => {
  const forged = normalizeConfirmCard({
    kind: 'delete',
    id: 'forged-delete',
    items: DELETE_ITEMS,
    actions: [{ id: 'delete-all', label: '全部删除' }]
  });
  assert.equal(forged.actions.some((action) => action.id === 'delete-all'), false);
  assert.equal(forged.actions.filter((action) => action.id === 'delete-item').length, 3);
});

test('看不懂的确认卡不给任何动作', () => {
  const card = normalizeConfirmCard({ kind: 'mystery', items: DELETE_ITEMS });
  assert.equal(card.kind, 'unknown');
  assert.deepEqual(card.actions, []);
  assert.match(card.headline, /不放行/u);
});

test('取消外发：回执说「未发出」，副作用为空，不生成新卡', () => {
  const card = externalCardModelOf({ id: 'external', items: EXTERNAL_ITEMS });
  const action = confirmAction({ card, action: 'cancel', at: '2026-11-26T00:00:00.000Z' });
  assert.equal(action.kind, 'cancel');
  assert.deepEqual(action.effects, []);
  assert.equal(action.reply.blocks.length, 1);
  const receipt = action.reply.blocks[0];
  assert.equal(receipt.type, 'kv');
  assert.equal(rowValue(receipt, '结果'), '未发出（0 处）');
  assert.match(rowValue(receipt, '本地状态'), /未变/u);
  assert.match(action.reply.text, /没有发出/u);
});

test('发出这一次：本轮不执行真实外发，也不产生副作用', () => {
  const card = externalCardModelOf({ id: 'external', items: EXTERNAL_ITEMS });
  const action = confirmAction({ card, action: 'send-once' });
  assert.equal(action.kind, 'send-once');
  assert.deepEqual(action.effects, []);
  assert.match(action.reply.text, /不会真的发出/u);
});

test('删除一项：回执含已删与剩余项，并给出一张只含剩余项的新卡', () => {
  const card = deleteCardModelOf({ id: 'delete', items: DELETE_ITEMS });
  const action = confirmAction({ card, action: 'delete-item', index: 0, at: '2026-11-26T00:00:00.000Z' });
  assert.equal(action.kind, 'delete-item');
  assert.deepEqual(action.effects, [DELETE_ITEMS[0].path]);

  const receipt = action.reply.blocks[0];
  assert.equal(rowValue(receipt, '结果'), '已删除 1 项');
  assert.equal(rowValue(receipt, '已删除'), DELETE_ITEMS[0].path);
  assert.equal(rowValue(receipt, '剩余'), '2 项');
  assert.equal(rowValue(receipt, '剩余 1'), DELETE_ITEMS[1].path);
  assert.equal(rowValue(receipt, '剩余 2'), DELETE_ITEMS[2].path);

  // 剩余项单独成卡：下一项仍要单独确认，不存在「一次删完」。
  const next = action.reply.blocks[1];
  assert.equal(next.type, 'confirm');
  assert.equal(next.kind, 'delete');
  assert.deepEqual(next.items.map((item) => item.path), DELETE_ITEMS.slice(1).map((item) => item.path));
  assert.equal(next.actions.filter((entry) => entry.id === 'delete-item').length, 2);
  assert.match(action.answeredLabel, /0014-export-policy/u);
});

test('删除最后一项：只剩回执，不再生成空卡', () => {
  const card = deleteCardModelOf({ id: 'delete-last', items: DELETE_ITEMS.slice(0, 1) });
  const action = confirmAction({ card, action: 'delete-item', index: 0 });
  assert.equal(action.reply.blocks.length, 1);
  assert.equal(rowValue(action.reply.blocks[0], '剩余'), '0 项');
});

test('取消删除：回执说「未删除」，剩余项原样列出，副作用为空', () => {
  const card = deleteCardModelOf({ id: 'delete', items: DELETE_ITEMS });
  const action = confirmAction({ card, action: 'cancel' });
  assert.deepEqual(action.effects, []);
  assert.equal(action.reply.blocks.length, 1);
  const receipt = action.reply.blocks[0];
  assert.equal(rowValue(receipt, '结果'), '未删除（0 处）');
  assert.equal(rowValue(receipt, '剩余'), '3 项');
  assert.equal(rowValue(receipt, '剩余 3'), DELETE_ITEMS[2].path);
});

test('不在动作表里的点击不产生消息：伪造的序号与批量动作都拒绝', () => {
  const card = deleteCardModelOf({ id: 'delete', items: DELETE_ITEMS });
  assert.equal(confirmAction({ card, action: 'delete-item', index: 9 }), null);
  assert.equal(confirmAction({ card, action: 'delete-all' }), null);
  const external = externalCardModelOf({ id: 'external', items: EXTERNAL_ITEMS });
  assert.equal(confirmAction({ card: external, action: 'defer-low' }), null);
});

test('命令解析：/外发、/删除 与英文别名；其余输入不吃', () => {
  assert.deepEqual(parseCommand('/外发'), { kind: 'external', arg: '' });
  assert.deepEqual(parseCommand('/send 飞书'), { kind: 'external', arg: '飞书' });
  assert.deepEqual(parseCommand('/删除'), { kind: 'delete', arg: '' });
  assert.deepEqual(parseCommand('/delete'), { kind: 'delete', arg: '' });
  assert.equal(parseCommand('/外发一些东西'), null);
  assert.equal(parseCommand('/记灵感 外发'), null);
  assert.equal(isCommand('随便聊聊'), false);
});
