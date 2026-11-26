// #116 判定表：外发恒 confirm、删除恒 confirm、二者叠加时拆两次，顺序固定。
// 只断言纯函数；卡片结构与回执在 tests/confirm-cards.test.mjs，界面另由 e2e 验收。
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIRM_ORDER, ORDER_REASON, planConfirmations } from '../src/confirm-plan.mjs';
import { writeGate } from '../src/write-gate.mjs';

const NO_GRANT = Object.freeze({ project: false });
const GRANTED = Object.freeze({ project: true });
const SEND = Object.freeze([{ label: 'ADR 摘要', path: 'D:\\work\\integration\\docs\\adr\\0012.md' }]);
const DELETE = Object.freeze([
  { label: '旧 ADR', path: 'D:\\work\\integration\\docs\\adr\\0014.md' },
  { label: '导出目录 v3', path: 'C:\\Users\\Owner\\.owner-agent\\exports\\cmp-demo\\v3' }
]);

const kindsOf = (plan) => plan.confirmations.map((item) => item.kind);

test('外发恒 confirm：任何目的地、任何授权、声明删除与否都不放行', () => {
  for (const destination of ['own', 'project', 'external']) {
    for (const granted of [NO_GRANT, GRANTED]) {
      const plan = planConfirmations({ destination, sends: SEND, granted });
      const label = `${destination}/granted=${granted.project}`;
      assert.deepEqual(kindsOf(plan), ['external'], label);
      assert.equal(plan.confirmations[0].outcome, 'confirm', label);
      assert.equal(plan.confirmations[0].gate.outcome, 'confirm', label);
      assert.match(plan.confirmations[0].reason, /外发/u, label);
      assert.deepEqual(plan.blocked, [], label);
    }
  }
  // 只给目的地 external（没有 sends）也算外发一件事。
  assert.deepEqual(kindsOf(planConfirmations({ destination: 'external', granted: GRANTED })), ['external']);
});

test('删除恒 confirm：自有目录已授权也不解除，未知目的地则直接拒绝', () => {
  for (const destination of ['own', 'project']) {
    for (const granted of [NO_GRANT, GRANTED]) {
      // deletes 布尔与 deleteItems 清单两种调用方式都要成立。
      for (const input of [{ deletes: true }, { deleteItems: DELETE }]) {
        const plan = planConfirmations({ destination, granted, ...input });
        const label = `${destination}/granted=${granted.project}/${JSON.stringify(input).slice(0, 30)}`;
        assert.deepEqual(kindsOf(plan), ['delete'], label);
        assert.equal(plan.confirmations[0].outcome, 'confirm', label);
        assert.match(plan.confirmations[0].reason, /删除/u, label);
      }
    }
  }
  // 未知目的地在删除判定之前就被 write-gate 拒绝：不能借「反正要确认」过关。
  const blocked = planConfirmations({ destination: 'nowhere', deleteItems: DELETE });
  assert.deepEqual(kindsOf(blocked), []);
  assert.equal(blocked.blocked.length, 1);
  assert.equal(blocked.blocked[0].kind, 'delete');
  assert.match(blocked.blocked[0].reason, /未知/u);
});

test('外发与删除叠加：拆两次，先删后发，两个都单独确认', () => {
  const plan = planConfirmations({
    destination: 'external',
    deletes: true,
    deleteItems: DELETE,
    sends: SEND,
    granted: GRANTED
  });
  assert.equal(plan.confirmations.length, 2);
  assert.deepEqual(kindsOf(plan), ['delete', 'external']);
  assert.equal(plan.order.join('>'), 'delete>external');
  // 两份确认的判据各自来自 write-gate，不合并、不互相顶替。
  assert.match(plan.confirmations[0].reason, /删除/u);
  assert.match(plan.confirmations[1].reason, /外发/u);
  assert.deepEqual(plan.confirmations[0].items, [...DELETE]);
  assert.deepEqual(plan.confirmations[1].items, [...SEND]);
});

test('既有写入又有外发：拆两次，顺序固定为先写后发并给出理由', () => {
  const plan = planConfirmations({
    destination: 'project',
    writes: ['D:\\work\\integration\\docs\\adr\\0012.md'],
    sends: SEND,
    granted: NO_GRANT
  });
  assert.equal(plan.confirmations.length, 2);
  assert.deepEqual(kindsOf(plan), ['write', 'external']);
  assert.equal(plan.order.join('>'), 'write>external');
  assert.match(plan.orderReason, /先写/u);
  assert.match(plan.orderReason, /收不回/u);
  assert.equal(ORDER_REASON, plan.orderReason);
  assert.deepEqual(CONFIRM_ORDER, ['write', 'delete', 'external']);
});

test('项目目录已授权时写入不再问，但外发仍然单独一张卡', () => {
  const plan = planConfirmations({
    destination: 'project',
    writes: ['D:\\work\\integration\\docs\\adr\\0012.md'],
    sends: SEND,
    granted: GRANTED
  });
  assert.deepEqual(kindsOf(plan), ['external']);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].kind, 'write');
  assert.equal(plan.skipped[0].outcome, 'allow');
});

test('判定复用 write-gate：每一步的 gate 与直接调用完全一致', () => {
  const plan = planConfirmations({
    destination: 'project',
    writes: ['D:\\work\\integration\\docs\\adr\\0012.md'],
    deleteItems: DELETE,
    sends: SEND,
    granted: NO_GRANT
  });
  const byKind = Object.fromEntries(plan.confirmations.map((item) => [item.kind, item.gate]));
  assert.deepEqual(byKind.write, writeGate({
    destination: 'project', deletes: false, granted: NO_GRANT
  }));
  assert.deepEqual(byKind.delete, writeGate({
    destination: 'project', deletes: true, granted: NO_GRANT
  }));
  assert.deepEqual(byKind.external, writeGate({
    destination: 'external', deletes: false, granted: NO_GRANT
  }));
});

test('空动作不出卡：没有写入、没有删除、没有外发时确认列表为空', () => {
  const plan = planConfirmations({ destination: 'own' });
  assert.deepEqual(plan.confirmations, []);
  assert.deepEqual(plan.order, []);
  assert.equal(plan.orderReason, ORDER_REASON);
});
