// #112 写入闸门：给定目的地、是否删除、当前会话授权，输出「放行 / 需确认 / 拒绝」。
// 只断言纯函数，不碰 DOM、不读盘、不联网；顶栏展示另由 scripts/e2e 验收。
//
// 判定表按 ADR-0012 穷举：三类目的地 × 是否删除 × 有无项目目录授权 = 12 组，
// 再加「未知目的地」两组删除与否 × 两组授权 = 4 组（未知一律拒绝）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeGate, writeScopeLabel } from '../src/write-gate.mjs';

/** 授权对象只表达「本次会话」：调用方传进来，函数不持有。 */
const NO_GRANT = Object.freeze({ project: false });
const GRANTED = Object.freeze({ project: true });

// 判定表的每一行：输入 + 期望 outcome + 理由里必须出现的关键词。
const TABLE = [
  // 自有目录：默认放行；删除照样确认（即使已授权也不解除）。
  { destination: 'own', deletes: false, granted: NO_GRANT, outcome: 'allow', keyword: '自有' },
  { destination: 'own', deletes: false, granted: GRANTED, outcome: 'allow', keyword: '自有' },
  { destination: 'own', deletes: true, granted: NO_GRANT, outcome: 'confirm', keyword: '删除' },
  { destination: 'own', deletes: true, granted: GRANTED, outcome: 'confirm', keyword: '删除' },
  // 项目目录：未授权要确认；已授权且不删放行；删除即使已授权也确认。
  { destination: 'project', deletes: false, granted: NO_GRANT, outcome: 'confirm', keyword: '授权' },
  { destination: 'project', deletes: false, granted: GRANTED, outcome: 'allow', keyword: '已授权' },
  { destination: 'project', deletes: true, granted: NO_GRANT, outcome: 'confirm', keyword: '删除' },
  { destination: 'project', deletes: true, granted: GRANTED, outcome: 'confirm', keyword: '删除' },
  // 外发：永不放行，授权也不解除。
  { destination: 'external', deletes: false, granted: NO_GRANT, outcome: 'confirm', keyword: '外发' },
  { destination: 'external', deletes: false, granted: GRANTED, outcome: 'confirm', keyword: '外发' },
  { destination: 'external', deletes: true, granted: NO_GRANT, outcome: 'confirm', keyword: '删除' },
  { destination: 'external', deletes: true, granted: GRANTED, outcome: 'confirm', keyword: '删除' }
];

test('表驱动：三类目的地 × 是否删除 × 有无授权，穷举 12 组', () => {
  assert.equal(TABLE.length, 12);
  for (const row of TABLE) {
    const result = writeGate({
      destination: row.destination,
      deletes: row.deletes,
      granted: row.granted
    });
    const label = `${row.destination}/deletes=${row.deletes}/granted=${row.granted.project}`;
    assert.equal(result.outcome, row.outcome, label);
    assert.match(result.reason, new RegExp(row.keyword, 'u'), label);
    assert.equal(result.scope, row.destination, label);
  }
});

test('表驱动：未知目的地一律拒绝（未知比放行安全）', () => {
  const unknowns = ['', 'oown', 'local', 'network', 'projectX', null, undefined, 42];
  for (const destination of unknowns) {
    for (const deletes of [false, true]) {
      for (const granted of [NO_GRANT, GRANTED]) {
        const result = writeGate({ destination, deletes, granted });
        const label = `${String(destination)}/deletes=${deletes}/granted=${granted.project}`;
        assert.equal(result.outcome, 'deny', label);
        assert.match(result.reason, /未知/u, label);
        assert.equal(result.scope, 'unknown', label);
      }
    }
  }
});

test('未知目的地即使声明删除也拒绝，不会退化成「确认」', () => {
  const result = writeGate({ destination: 'nowhere', deletes: true, granted: GRANTED });
  assert.equal(result.outcome, 'deny');
  assert.equal(result.scope, 'unknown');
});

test('缺省入参：不给目的地即拒绝，不给授权即未授权', () => {
  assert.equal(writeGate().outcome, 'deny');
  assert.equal(writeGate({ destination: 'own' }).outcome, 'allow');
  assert.equal(writeGate({ destination: 'project' }).outcome, 'confirm');
  // granted 缺省等价于未授权；project 字段只认严格 true，'true' / 1 都不算授权。
  assert.equal(writeGate({ destination: 'project', granted: {} }).outcome, 'confirm');
  assert.equal(writeGate({ destination: 'project', granted: { project: 'true' } }).outcome, 'confirm');
  assert.equal(writeGate({ destination: 'project', granted: { project: 1 } }).outcome, 'confirm');
});

test('输出形状固定：outcome / reason / scope 三个键，outcome 只在三值里', () => {
  const samples = [
    writeGate({ destination: 'own' }),
    writeGate({ destination: 'project' }),
    writeGate({ destination: 'external' }),
    writeGate({ destination: 'mystery' })
  ];
  for (const result of samples) {
    assert.deepEqual(Object.keys(result).sort(), ['outcome', 'reason', 'scope']);
    assert.ok(['allow', 'confirm', 'deny'].includes(result.outcome));
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0);
  }
});

test('授权不持有状态：同一目的地，换一份授权就换结果（按会话）', () => {
  const before = writeGate({ destination: 'project', deletes: false, granted: { project: false } });
  const after = writeGate({ destination: 'project', deletes: false, granted: { project: true } });
  const reset = writeGate({ destination: 'project', deletes: false, granted: { project: false } });
  assert.equal(before.outcome, 'confirm');
  assert.equal(after.outcome, 'allow');
  // 换会话（新的授权对象、project=false）立刻回到需确认，不残留上一次的放行。
  assert.equal(reset.outcome, 'confirm');
});

test('顶栏文案：默认「写·自有」，项目目录授权后「项目目录已授权」', () => {
  const own = writeScopeLabel({ granted: NO_GRANT });
  assert.equal(own.label, '写·自有');
  assert.equal(own.scope, 'own');
  assert.equal(own.granted, false);

  const granted = writeScopeLabel({ granted: GRANTED });
  assert.equal(granted.label, '项目目录已授权');
  assert.equal(granted.scope, 'project');
  assert.equal(granted.granted, true);
});

test('顶栏文案只认严格 true 的会话授权，缺省即「写·自有」', () => {
  assert.equal(writeScopeLabel().label, '写·自有');
  assert.equal(writeScopeLabel({}).label, '写·自有');
  assert.equal(writeScopeLabel({ granted: null }).label, '写·自有');
  assert.equal(writeScopeLabel({ granted: { project: 'true' } }).label, '写·自有');
  assert.equal(writeScopeLabel({ granted: { project: true } }).label, '项目目录已授权');
});
