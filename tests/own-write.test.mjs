// #114 自有目录写入：判定 → 执行 → 回执，全部是纯函数。
//
// 只断言三件事：自己的动作全部放行、不放行的一律不执行、成功与失败都留可复制的回执。
// 真实写库与「全程无确认卡」由 scripts/e2e/desktop-own-write.mjs 验收；这里不启动 Electron。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  OWN_WRITE_ACTIONS,
  OWN_WRITE_KINDS,
  ownWriteAction,
  ownWriteDecision,
  ownWriteReceipt,
  parseOwnWriteCommand,
  runOwnWrite
} from '../src/own-write.mjs';

const require = createRequire(import.meta.url);
const blocks = require('../desktop/shell-blocks.cjs');
const copy = require('../desktop/shell-copy.cjs');

const NO_GRANT = Object.freeze({ project: false });
const GRANTED = Object.freeze({ project: true });
const AT = '2026-11-26T10:00:00.000Z';

test('动作登记表覆盖 ADR-0012 的五类自有目录写入', () => {
  assert.deepEqual([...OWN_WRITE_KINDS], ['idea', 'draft', 'watermark', 'enqueue', 'export']);
  for (const kind of OWN_WRITE_KINDS) {
    const action = ownWriteAction(kind);
    assert.equal(action.key, kind);
    assert.ok(action.label.length > 0, kind);
    assert.ok(action.writeTo.length > 0, kind);
  }
  assert.equal(OWN_WRITE_ACTIONS.idea.needsText, true);
  assert.equal(ownWriteAction('nope'), null);
  assert.equal(ownWriteAction(undefined), null);
});

test('表驱动：自有目录的每个动作都放行，项目目录授权也不改变判定', () => {
  for (const kind of OWN_WRITE_KINDS) {
    for (const granted of [NO_GRANT, GRANTED]) {
      const decision = ownWriteDecision({ kind, deletes: false, granted });
      const label = `${kind}/granted=${granted.project}`;
      assert.equal(decision.allowed, true, label);
      assert.equal(decision.needsConfirm, false, label);
      assert.equal(decision.denied, false, label);
      assert.equal(decision.gate.outcome, 'allow', label);
      assert.equal(decision.gate.scope, 'own', label);
    }
  }
});

test('声明删除回到确认路径：不执行、不留回执（那是 #116）', async () => {
  for (const kind of OWN_WRITE_KINDS) {
    const decision = ownWriteDecision({ kind, deletes: true, granted: GRANTED });
    assert.equal(decision.allowed, false, kind);
    assert.equal(decision.needsConfirm, true, kind);
    assert.match(decision.gate.reason, /删除/u, kind);
  }
  let called = 0;
  const result = await runOwnWrite({
    kind: 'idea',
    text: '删除也算自有目录吗',
    deletes: true,
    granted: GRANTED,
    execute: async () => { called += 1; return { wrote: '不该发生' }; }
  });
  assert.equal(called, 0, '需要确认的动作不能被执行');
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.needsConfirm, true);
  assert.equal(result.receipt, null, '不由这条路伪造回执');
});

test('未知动作一律拒绝，也不执行', async () => {
  const decision = ownWriteDecision({ kind: 'publish-to-project' });
  assert.equal(decision.allowed, false);
  assert.equal(decision.denied, true);
  assert.equal(decision.gate.scope, 'unknown');
  assert.match(decision.gate.reason, /未知/u);

  let called = 0;
  const result = await runOwnWrite({ kind: 'publish-to-project', execute: async () => { called += 1; } });
  assert.equal(called, 0);
  assert.equal(result.receipt, null);
});

test('成功：执行一次，回执写明写了什么与结果', async () => {
  const seen = [];
  const result = await runOwnWrite({
    kind: 'idea',
    text: '  收件箱空的时候应该有一句提示  ',
    at: AT,
    execute: async (payload) => {
      seen.push(payload);
      return { wrote: 'ideas 表 · 1 条', result: 'idea-42' };
    }
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].text, '收件箱空的时候应该有一句提示');
  assert.equal(result.ok, true);
  assert.equal(result.blocked, false);
  assert.equal(result.decision.action.label, '记灵感');

  const receipt = result.receipt;
  assert.deepEqual(Object.keys(receipt).sort(), ['blocks', 'text']);
  assert.match(receipt.text, /写入回执（自有目录）：记灵感已写入/u);
  assert.match(receipt.text, /ideas 表 · 1 条/u);
  assert.match(receipt.text, /idea-42/u);

  assert.equal(receipt.blocks.length, 1);
  const block = receipt.blocks[0];
  assert.equal(block.type, 'kv');
  assert.equal(block.title, '写入回执 · 记灵感');
  const rows = new Map(block.rows);
  assert.equal(rows.get('动作'), '记灵感');
  assert.equal(rows.get('判定'), '自有目录 · 不删除 → 直接放行');
  assert.equal(rows.get('写入'), 'ideas 表 · 1 条');
  assert.equal(rows.get('结果'), 'idea-42');
  assert.equal(rows.get('时间'), AT);
  assert.equal(rows.has('原因'), false);
  for (const row of block.rows) {
    assert.equal(row.length, 2, JSON.stringify(row));
    assert.equal(typeof row[0], 'string');
    assert.equal(typeof row[1], 'string');
  }
});

test('失败：写实现抛错时回执带原因，不静默', async () => {
  const result = await runOwnWrite({
    kind: 'idea',
    text: '这条写不进去',
    at: AT,
    execute: async () => { throw new Error('磁盘写满'); }
  });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, false);
  const receipt = result.receipt;
  assert.ok(receipt, '失败也要有回执');
  assert.match(receipt.text, /写入回执（自有目录）：记灵感没有写成/u);
  assert.match(receipt.text, /磁盘写满/u);
  assert.equal(receipt.blocks[0].title, '写入回执 · 记灵感（失败）');
  const rows = new Map(receipt.blocks[0].rows);
  assert.equal(rows.get('写入'), '未写入（0 处）');
  assert.equal(rows.get('结果'), '失败');
  assert.equal(rows.get('原因'), '磁盘写满');
});

test('缺正文与缺写实现都不执行，也给失败回执', async () => {
  let called = 0;
  const empty = await runOwnWrite({
    kind: 'idea',
    text: '   ',
    at: AT,
    execute: async () => { called += 1; }
  });
  assert.equal(called, 0);
  assert.equal(empty.ok, false);
  assert.match(new Map(empty.receipt.blocks[0].rows).get('原因'), /需要一句正文/u);

  const noExec = await runOwnWrite({ kind: 'draft', at: AT });
  assert.equal(noExec.ok, false);
  assert.match(new Map(noExec.receipt.blocks[0].rows).get('原因'), /没有可用的写入实现/u);
});

test('回执直接复用既有块与复制能力：键值块进流、复制成 Markdown', () => {
  const receipt = ownWriteReceipt({
    action: OWN_WRITE_ACTIONS.idea,
    ok: true,
    wrote: 'ideas 表 · 1 条',
    result: 'idea-7',
    at: AT
  });
  const model = blocks.normalizeReply(receipt);
  assert.equal(model.blocks.length, 1);
  assert.equal(model.blocks[0].type, 'kv');
  assert.equal(model.blocks[0].rows.length, 5);

  const markdown = copy.blockToMarkdown(model.blocks[0]);
  assert.match(markdown, /### 写入回执 · 记灵感/u);
  assert.match(markdown, /- 动作：记灵感/u);
  assert.match(markdown, /- 结果：idea-7/u);
  // 整条回执也能复制：文字在前，块在后。
  const whole = copy.messageToMarkdown(receipt);
  assert.match(whole, /写入回执（自有目录）/u);
  assert.ok(whole.indexOf('写入回执（自有目录）') < whole.indexOf('### 写入回执 · 记灵感'));
});

test('命令解析：/记灵感 与 /idea 都认，普通聊天不受影响', () => {
  assert.deepEqual(parseOwnWriteCommand('/记灵感 收件箱要有一句空态提示'),
    { kind: 'idea', text: '收件箱要有一句空态提示' });
  assert.deepEqual(parseOwnWriteCommand('  /idea   加一个重试上限  '),
    { kind: 'idea', text: '加一个重试上限' });
  // 缺正文也认：入口会回「需要一句正文」，比回一条占位回复说得清。
  assert.deepEqual(parseOwnWriteCommand('/记灵感'), { kind: 'idea', text: '' });
  // 其余输入不是这条命令。
  assert.equal(parseOwnWriteCommand('帮你记一条灵感'), null);
  assert.equal(parseOwnWriteCommand('/blocks'), null);
  assert.equal(parseOwnWriteCommand(''), null);
  assert.equal(parseOwnWriteCommand(null), null);
  assert.equal(parseOwnWriteCommand('/记灵感器 x'), null);
});
