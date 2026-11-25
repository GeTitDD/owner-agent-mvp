// #108 `/` 技能面板：搜索、数字别名与冲突的纯函数测试。
// 不启动 Electron、不读盘：扫描结果在真实界面里由 skills.catalog 带回，
// 这里只断言「拿到这些技能之后，面板怎么选、怎么合、怎么报冲突」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const slash = require('../desktop/shell-skills.cjs');

const skill = (id, extra = {}) => ({
  id,
  name: id,
  description: `${id} description`,
  source: 'pstack',
  sourceLabel: 'pstack',
  missing: false,
  playbookOnly: false,
  ...extra
});

test('flattenCatalog：优先用完整 items，缺字段时退回分组；重复 id 只留第一条', () => {
  const fromItems = slash.flattenCatalog({
    items: [skill('z'), skill('a'), skill('a', { description: '重复的' })],
    groups: [{ items: [skill('ignored')] }]
  });
  assert.deepEqual(fromItems.map((item) => item.id), ['a', 'z']);
  assert.equal(fromItems.find((item) => item.id === 'a').description, 'a description');

  const fromGroups = slash.flattenCatalog({
    groups: [
      { items: [skill('matt-one', { source: 'matt', sourceLabel: 'matt' })] },
      { items: [skill('dom', { source: 'domain', sourceLabel: '域包' })] }
    ]
  });
  assert.deepEqual(fromGroups.map((item) => item.id), ['dom', 'matt-one']);
  assert.deepEqual(slash.flattenCatalog(null), []);
});

test('searchSkills：按 id、按说明、空查询与大小写都能命中', () => {
  const skills = [
    skill('code-review', { description: 'Review changes since a fixed point.' }),
    skill('diagnosing-bugs', { description: 'Diagnosis loop for hard bugs.' }),
    skill('pr')
  ];
  // 空查询原样返回，不打乱顺序。
  assert.deepEqual(slash.searchSkills(skills, '').map((item) => item.id),
    ['code-review', 'diagnosing-bugs', 'pr']);
  assert.deepEqual(slash.searchSkills(skills, '/').map((item) => item.id),
    ['code-review', 'diagnosing-bugs', 'pr']);
  // 按 id 命中，带不带开头的 / 都一样。
  assert.deepEqual(slash.searchSkills(skills, '/CODE').map((item) => item.id), ['code-review']);
  // 按说明命中。
  assert.deepEqual(slash.searchSkills(skills, 'hard bugs').map((item) => item.id),
    ['diagnosing-bugs']);
  assert.deepEqual(slash.searchSkills(skills, 'no-such-skill'), []);
});

test('filterSlots：纯数字按数字前缀找，其余按技能 id / 说明找', () => {
  const slots = [
    { id: 'a', number: 1, skill: skill('a', { description: '第一颗' }) },
    { id: 'b', number: 2, skill: skill('b', { description: 'second skill' }) }
  ];
  assert.deepEqual(slash.filterSlots(slots, '').map((slot) => slot.id), ['a', 'b']);
  assert.deepEqual(slash.filterSlots(slots, '1').map((slot) => slot.id), ['a']);
  assert.deepEqual(slash.filterSlots(slots, '2').map((slot) => slot.id), ['b']);
  assert.deepEqual(slash.filterSlots(slots, 'second').map((slot) => slot.id), ['b']);
  assert.deepEqual(slash.filterSlots(slots, '第一颗').map((slot) => slot.id), ['a']);
});

test('defaultSlots：只用读得到的技能，最多九个，缺失与 playbook 不占数字', () => {
  const skills = [
    skill('one'),
    skill('missing', { missing: true }),
    skill('playbook', { playbookOnly: true }),
    ...Array.from({ length: 10 }, (_, index) => skill(`s${index}`))
  ];
  const slots = slash.defaultSlots(skills);
  assert.equal(slots.length, 9);
  assert.deepEqual(slots.map((slot) => slot.number), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(slots.some((slot) => slot.id === 'missing' || slot.id === 'playbook'), false);
  assert.equal(slots[0].id, 'one');
});

test('mergeAliases：默认数字 + 持久化覆盖；失效 id 与非法值被丢弃', () => {
  const skills = [skill('a'), skill('b'), skill('c')];
  const base = slash.mergeAliases({ skills });
  assert.deepEqual(base.slots.map((slot) => [slot.id, slot.number]), [['a', 1], ['b', 2], ['c', 3]]);
  assert.deepEqual(base.overrides, {});
  assert.deepEqual(base.conflicts.numbers, []);

  const merged = slash.mergeAliases({
    skills,
    overrides: { a: 9, b: 2, gone: 4, c: 'x', d: 0 }
  });
  assert.deepEqual(merged.slots.map((slot) => [slot.id, slot.number]), [['b', 2], ['c', 3], ['a', 9]]);
  // 与默认相同的不再写回；失效 id 与非法值都不留。
  assert.deepEqual(merged.overrides, { a: 9 });
  assert.deepEqual(merged.conflicts.numbers, []);
});

test('mergeAliases：两个技能抢同一个数字时如实返回冲突，不替用户消解', () => {
  const skills = [skill('a'), skill('b'), skill('c')];
  const merged = slash.mergeAliases({ skills, overrides: { a: 2 } });
  assert.deepEqual(merged.conflicts.numbers, [2]);
  assert.deepEqual(merged.conflicts.byNumber['2'], ['a', 'b']);
  assert.deepEqual(merged.conflicts.ids, ['a', 'b']);
  // 同号时按默认顺序：a（默认 1）排在 b（默认 2）前面。
  assert.deepEqual(merged.slots.map((slot) => [slot.id, slot.number]),
    [['a', 2], ['b', 2], ['c', 3]]);
});

test('applyAliasEdit：改成默认值 / 清空回默认，非法输入不动已有覆盖', () => {
  const skills = [skill('a'), skill('b')];
  const slots = slash.mergeAliases({ skills, overrides: { a: 4 } }).slots;
  assert.deepEqual(slash.applyAliasEdit({ a: 4 }, slots, 'a', '1'), {});
  assert.deepEqual(slash.applyAliasEdit({ a: 4 }, slots, 'a', ''), {});
  assert.deepEqual(slash.applyAliasEdit({ a: 4 }, slots, 'a', '0'), {});
  assert.deepEqual(slash.applyAliasEdit({ a: 4 }, slots, 'a', '5'), { a: 5 });
  assert.deepEqual(slash.applyAliasEdit({ a: 4 }, slots, 'b', '9'), { a: 4, b: 9 });
  // 不存在的 id 不改持久化。
  assert.deepEqual(slash.applyAliasEdit({ a: 4 }, slots, 'gone', '3'), { a: 4 });
});

test('invocationFor：数字行记「命令」，技能行记「调用技能」，都带来源与说明卡', () => {
  const target = skill('code-review', {
    name: 'code-review', description: 'Review changes since a fixed point.', sourceLabel: 'matt'
  });
  const command = slash.invocationFor(target, { kind: 'command', number: 3 });
  assert.equal(command.userText, '命令 3 · /code-review');
  assert.match(command.reply.text, /已执行命令 \/code-review/u);
  assert.equal(command.reply.blocks[0].type, 'kv');
  assert.deepEqual(command.reply.blocks[0].rows[0], ['技能', '/code-review']);
  assert.ok(command.reply.blocks[0].rows.some((row) => row[0] === '来源' && row[1] === 'matt'));

  const invoked = slash.invocationFor(target, { kind: 'skill' });
  assert.equal(invoked.userText, '调用技能 /code-review');
  assert.match(invoked.reply.text, /已调用技能/u);

  const missing = slash.invocationFor(skill('gone', { missing: true, reason: 'SKILL.md 缺失' }));
  assert.match(missing.reply.text, /缺失/u);
  assert.ok(missing.reply.blocks[0].rows.some((row) => row[0] === '状态' && row[1].includes('缺失')));
});
