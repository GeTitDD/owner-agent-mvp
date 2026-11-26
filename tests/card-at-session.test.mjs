// #125「关联会话」：线索分类、指针形状、prompt 段组装。
// 这里只喂纯数据，不起 Electron；卡片、胶囊与失败落流由 e2e 覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const session = require('../desktop/shell-at-session.cjs');

const UUID = '01a1a3bc-a07b-76d0-9532-e942ded4731e';

// ── 线索：三类，不猜 ────────────────────────────────────────────────

test('线索分类：可解析 id（UUID / ses_ / id: 前缀）', () => {
  assert.deepEqual(session.classifyClue(UUID), { kind: 'id', value: UUID });
  // 大小写不影响 UUID 识别，值照原样带回。
  assert.equal(session.classifyClue(UUID.toUpperCase()).kind, 'id');
  assert.deepEqual(session.classifyClue('ses_nNGitSepMqB0bckkSmhfwoZmwW'), {
    kind: 'id',
    value: 'ses_nNGitSepMqB0bckkSmhfwoZmwW'
  });
  // 显式前缀去掉前缀，只留 id。
  assert.deepEqual(session.classifyClue(`id：${UUID}`), { kind: 'id', value: UUID });
});

test('线索分类：可搜索关键词（标题 / 路径都算）', () => {
  assert.equal(session.classifyClue('决策记录').kind, 'keyword');
  assert.equal(session.classifyClue('nautilus').kind, 'keyword');
  // 路径不是单独一类：按关键词去匹配 cwd / 路径。
  assert.equal(session.classifyClue('D:\\nautilus_trader\\src').kind, 'keyword');
  assert.equal(session.classifyClue('  Codex 转入  ').value, 'Codex 转入');
});

test('线索分类：不可用只说原因，不猜成关键词', () => {
  assert.equal(session.classifyClue('').kind, 'unusable');
  assert.equal(session.classifyClue('   ').kind, 'unusable');
  assert.equal(session.classifyClue('？！').kind, 'unusable');
  assert.equal(session.classifyClue('id:').kind, 'unusable');
  assert.match(session.classifyClue('').reason, /空/u);
  assert.match(session.clueHint(session.classifyClue('...')), /用不了/u);
});

// ── 指针：只留白名单字段，正文塞不进来 ─────────────────────────────

test('指针形状：只有来源 / id / 标题 / 时间 / 轮数 / 项目 / 未确认标', () => {
  const pointer = session.pointerOf({
    source: 'codex',
    id: UUID,
    title: '取舍讨论',
    at: '2026-11-26T08:00:00.000Z',
    turns: 6,
    project: '示例项目',
    // 这三样都不该穿过指针这一层。
    text: '会话正文',
    messages: [{ role: 'user', text: '正文' }],
    body: '正文'
  });
  assert.deepEqual(Object.keys(pointer).sort(), [...session.POINTER_FIELDS].sort());
  assert.equal(pointer.source, 'codex');
  assert.equal(pointer.id, UUID);
  assert.equal(pointer.title, '取舍讨论');
  assert.equal(pointer.turns, 6);
  assert.equal(pointer.project, '示例项目');
  assert.equal(pointer.unconfirmed, false);
  // 序列化后也不带正文。
  assert.ok(!JSON.stringify(pointer).includes('会话正文'));
});

test('指针形状：线索命中标来源未确认；缺来源 / 完全定位不到就不造指针', () => {
  const base = { source: 'claude', id: UUID, title: '线索会话', at: '', turns: 2 };
  assert.equal(session.pointerOf(base, 'clue').unconfirmed, true);
  assert.equal(session.pointerOf(base, 'recent').unconfirmed, false);
  assert.equal(session.pointerOf({ ...base, source: 'other' }), null);
  assert.equal(session.pointerOf({ source: 'codex', id: '', title: '', turns: 1 }), null);
  assert.equal(session.pointerOf(null), null);
  // 负数 / 小数轮数按 0 处理，不写出一句假统计。
  assert.equal(session.pointerOf({ ...base, turns: -2 }).turns, 0);
});

test('指针行：五样都在，来源未确认写在来源旁边', () => {
  const pointer = session.pointerOf({
    source: 'opencode',
    id: 'ses_abc123456',
    title: '工业级 RAG',
    at: '2026-11-26T08:30:00.000Z',
    turns: 12,
    project: '知识库'
  }, 'clue');
  const line = session.pointerLine(pointer);
  assert.ok(line.startsWith('- OpenCode（来源未确认）'));
  assert.ok(line.includes('《工业级 RAG》'));
  assert.ok(line.includes('2026-11-26 08:30'));
  assert.ok(line.includes('12 轮'));
  assert.ok(line.includes('项目：知识库'));
  assert.ok(line.includes('id：ses_abc123456'));
});

// ── prompt 段：标题、检索约定、只有指针 ─────────────────────────────

const POINTERS = [
  session.pointerOf({
    source: 'codex',
    id: UUID,
    title: '取舍讨论',
    at: '2026-11-26T08:00:00.000Z',
    turns: 6,
    project: '示例项目'
  }),
  session.pointerOf({
    source: 'claude',
    id: '00000000-0000-4000-8000-000000000000',
    title: '线索会话',
    at: '2026-11-25T09:10:00.000Z',
    turns: 3,
    project: ''
  }, 'clue')
];

test('prompt 段：固定标题与检索约定，空列表整段不出现', () => {
  const text = session.buildSessionSection(POINTERS);
  assert.ok(text.startsWith('## 关联会话（指针，不是正文）'));
  assert.ok(text.includes(session.SESSION_SECTION_HINT));
  assert.ok(text.includes('定位不到就问我，不要猜'));
  assert.ok(text.includes('这里只有指针，没有正文'));
  // 两条指针都在，顺序照传入。
  assert.ok(text.indexOf('《取舍讨论》') < text.indexOf('《线索会话》'));
  // 线索命中带未确认标；自动列表不带。
  assert.equal(text.match(/来源未确认/gu)?.length, 1);
  assert.equal(session.buildSessionSection([]), '');
  assert.equal(session.buildSessionSection(null), '');
});

test('发送文本：指针段接在原话后面；没有指针一字不改', () => {
  const text = session.composeSendText('帮我看看这段取舍', POINTERS);
  assert.ok(text.startsWith('帮我看看这段取舍\n\n## 关联会话（指针，不是正文）'));
  assert.equal(session.composeSendText('原文', []), '原文');
  assert.equal(session.composeSendText('原文'), '原文');
  // 段里没有引用块：这里不是正文导入。
  assert.ok(!text.includes('\n> '));
});

test('指针相等：来源 + 会话 id 决定同一条，标题变了也不重复', () => {
  const left = { source: 'codex', id: UUID, title: 'A' };
  const right = { source: 'codex', id: UUID, title: 'B' };
  assert.equal(session.pointerKey(left), session.pointerKey(right));
  assert.equal(session.samePointer(left, right), true);
  assert.equal(session.samePointer(left, { ...right, source: 'claude' }), false);
});

test('方法卡注册表：session 已带 mount，不再画占位', () => {
  const at = require('../desktop/shell-at.cjs');
  assert.equal(typeof at.atContent('session').mount, 'function');
  assert.equal(at.atContent('session').todo, undefined);
  // #124 之后菜单多了一条「关联项目」，#126 又多了「分享到飞书」；
  // 顺序按父 spec：#123 → #124 → #125 → #126。
  assert.deepEqual(
    at.atMethods().map((method) => method.key),
    ['prompt', 'project', 'session', 'share']
  );
});
