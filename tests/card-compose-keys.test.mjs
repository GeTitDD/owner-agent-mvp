// #132 输入区按键的状态迁移：`/` 面板开没开、有没有可选项，决定 Enter 是
// 「执行选中项」「照常发送」还是「换行」。这里只喂纯状态，不起 Electron。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compose = require('../desktop/shell-compose.cjs');

const plan = (overrides = {}) => compose.composerKeyAction({
  slashOpen: false,
  slashCustomizing: false,
  itemCount: 0,
  key: 'Enter',
  shiftKey: false,
  ...overrides
});

test('没有面板时：普通 Enter 发送，Shift+Enter 交给浏览器换行', () => {
  assert.deepEqual(plan(), { action: 'send', preventDefault: true });
  assert.deepEqual(plan({ shiftKey: true }), { action: 'none', preventDefault: false });
  // 不是 Enter 的键不归输入区管。
  assert.deepEqual(plan({ key: 'a' }), { action: 'none', preventDefault: false });
});

test('面板有匹配时：Enter 执行选中项，↑↓ 移动，Esc 关面板', () => {
  assert.deepEqual(plan({ slashOpen: true, itemCount: 3 }),
    { action: 'invoke', preventDefault: true });
  assert.deepEqual(plan({ slashOpen: true, itemCount: 3, key: 'ArrowDown' }),
    { action: 'move-down', preventDefault: true });
  assert.deepEqual(plan({ slashOpen: true, itemCount: 3, key: 'ArrowUp' }),
    { action: 'move-up', preventDefault: true });
  assert.deepEqual(plan({ slashOpen: true, itemCount: 3, key: 'Escape' }),
    { action: 'close-panel', preventDefault: true });
});

test('#132 回归：面板无匹配时 Enter 不吞键，关面板后照常发送', () => {
  // 关键：不能落成 invoke（选不到任何项就什么也不做，`/risk high` 会永远发不出去）。
  assert.deepEqual(plan({ slashOpen: true, itemCount: 0 }),
    { action: 'close-and-send', preventDefault: true });
  // Esc 仍然只是关面板，不会顺手发出去。
  assert.deepEqual(plan({ slashOpen: true, itemCount: 0, key: 'Escape' }),
    { action: 'close-panel', preventDefault: true });
  // 没有可选项时 ↑↓ 也不该把键漏给别处。
  assert.deepEqual(plan({ slashOpen: true, itemCount: 0, key: 'ArrowDown' }),
    { action: 'move-down', preventDefault: true });
});

test('改数字优先：Enter / Esc 先收编辑态，不发送也不关面板', () => {
  assert.deepEqual(plan({ slashOpen: true, slashCustomizing: true, itemCount: 9 }),
    { action: 'finish-customize', preventDefault: true });
  assert.deepEqual(plan({ slashOpen: true, slashCustomizing: true, itemCount: 9, key: 'Escape' }),
    { action: 'finish-customize', preventDefault: true });
  // 改数字时 ↑↓ 仍可移动选中。
  assert.deepEqual(plan({ slashOpen: true, slashCustomizing: true, itemCount: 9, key: 'ArrowDown' }),
    { action: 'move-down', preventDefault: true });
});

test('面板开着时 Shift+Enter 仍然是换行，不发送也不调用', () => {
  assert.deepEqual(plan({ slashOpen: true, itemCount: 3, shiftKey: true }),
    { action: 'none', preventDefault: false });
  assert.deepEqual(plan({ slashOpen: true, itemCount: 0, shiftKey: true }),
    { action: 'none', preventDefault: false });
});
