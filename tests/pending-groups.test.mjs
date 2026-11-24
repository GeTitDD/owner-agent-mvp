// #39 待办分组：分组顺序与「首组展开」语义用纯函数验证，不碰 DOM。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { groupPending } = require('../desktop/pending-groups.cjs');

const item = (projectId, id, projectName = '') => ({ id, projectId, projectName });

test('按项目分组，组顺序跟随待办出现顺序', () => {
  const model = groupPending([
    item('beta', 'b1', 'Beta'),
    item('alpha', 'a1', 'Alpha'),
    item('beta', 'b2', 'Beta')
  ]);
  assert.equal(model.single, false);
  assert.deepEqual(model.groups.map((group) => group.projectId), ['beta', 'alpha']);
  assert.deepEqual(model.groups[0].items.map((entry) => entry.id), ['b1', 'b2']);
});

test('首组展开的是「第一条待办所属项目」，不是第一个项目', () => {
  // 项目列表顺序是 alpha 在前，但第一条待办属于 beta：展开 beta，别打开空组。
  const model = groupPending([
    item('beta', 'b1', 'Beta'),
    item('alpha', 'a1', 'Alpha')
  ]);
  assert.equal(model.groups[0].projectId, 'beta');
  assert.equal(model.groups[0].open, true);
  assert.equal(model.groups[1].open, false);
  // 只有一组时不折叠，渲染层退化成普通列表。
  const single = groupPending([item('alpha', 'a1', 'Alpha'), item('alpha', 'a2', 'Alpha')]);
  assert.equal(single.single, true);
  assert.equal(single.groups[0].open, false);
  assert.equal(single.groups[0].items.length, 2);
});

test('缺项目 id / 名字时仍有稳定分组与展示名', () => {
  const model = groupPending([item('', 'x1'), item('', 'x2')]);
  assert.equal(model.single, true);
  assert.equal(model.groups[0].projectId, '');
  assert.equal(model.groups[0].name, '未命名项目');
  assert.deepEqual(groupPending(null), { single: false, groups: [] });
});
