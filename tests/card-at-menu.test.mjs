// #122 `@@` 方法菜单与小卡片容器：触发判定、方法列表数据、菜单 ↔ 方法卡迁移、
// 以及输入区按键优先级里 `@@` 这一层。这里只喂纯状态，不起 Electron。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const at = require('../desktop/shell-at.cjs');
const compose = require('../desktop/shell-compose.cjs');

// ── 触发：只有末尾的连续两个 @ 才算 ────────────────────────────────

test('单个 @ 不触发：@某人、邮箱与正文里的 @ 都照常是正文', () => {
  assert.equal(at.atTrigger(''), false);
  assert.equal(at.atTrigger('@'), false);
  assert.equal(at.atTrigger('@张三 帮我看下'), false);
  assert.equal(at.atTrigger('me@example.com'), false);
  assert.equal(at.atTrigger('先说结论，再 @ 我'), false);
});

test('末尾连续两个 @ 触发，允许跟一点查询字', () => {
  assert.equal(at.atTrigger('@@'), true);
  assert.equal(at.atTrigger('帮我@@'), true);      // 中文紧跟也触发
  assert.equal(at.atTrigger('@@生成'), true);
  assert.equal(at.atTrigger('第一行\n@@'), true);
  // 词中的双 @ 不拦：那段正文可能只是一个写坏的地址，不是命令。
  assert.equal(at.atTrigger('a@@b'), false);
  assert.equal(at.atTrigger('hi@@'), false);
  // 三个 @ 不是「连续两个」。
  assert.equal(at.atTrigger('@@@'), false);
});

// ── 方法列表是数据：形状固定，加方法只加数据 ──────────────────────

test('方法列表的形状：key / title / desc，键唯一且有对应内容', () => {
  const methods = at.atMethods();
  // #126 加第四条「分享到飞书」：菜单数据变了，这是预期变化（原来只有三条）。
  assert.equal(methods.length, 4);
  assert.deepEqual(methods.map((method) => method.key), ['prompt', 'project', 'session', 'share']);
  for (const method of methods) {
    assert.equal(typeof method.key, 'string');
    assert.ok(method.key.length > 0);
    assert.equal(typeof method.title, 'string');
    assert.ok(method.title.length > 0);
    assert.equal(typeof method.desc, 'string');
    assert.ok(method.desc.length > 0);
    // 容器按 key 取内容：每个方法都必须自带一份，不能画空卡。
    assert.ok(at.atContent(method.key), `method ${method.key} has no content`);
  }
  assert.equal(new Set(methods.map((method) => method.key)).size, methods.length);
  // 不认识的 key 不兜底成第一条，也不返回半个对象。
  assert.equal(at.atMethod('nope'), null);
  assert.equal(at.atContent('nope'), null);
});

test('atMethods 返回副本：调用方改返回值不会污染菜单数据', () => {
  const methods = at.atMethods();
  methods[0].title = '改坏了';
  methods.push({ key: 'extra', title: '多出来的', desc: '' });
  // #126 之后是四条：分享排在 session 之后。
  assert.equal(at.atMethods().length, 4);
  assert.equal(at.atMethods()[0].title, '生成 prompt');
});

// ── 容器状态：关 → 菜单 → 方法卡 → 返回 → 关 ──────────────────────

test('容器迁移：菜单进方法、返回菜单、最后关闭', () => {
  let state = at.atInitialState();
  assert.equal(at.atView(state).open, false);

  state = at.atTransition(state, { type: 'open' });
  let view = at.atView(state);
  assert.equal(view.open, true);
  assert.equal(view.step, 'menu');
  assert.equal(view.canBack, false);

  state = at.atTransition(state, { type: 'pick', key: 'prompt' });
  view = at.atView(state);
  assert.equal(view.step, 'method');
  assert.equal(view.methodKey, 'prompt');
  assert.equal(view.title, '生成 prompt');
  assert.equal(view.canBack, true);

  state = at.atTransition(state, { type: 'back' });
  view = at.atView(state);
  assert.equal(view.step, 'menu');
  assert.equal(view.canBack, false);

  state = at.atTransition(state, { type: 'close' });
  assert.equal(at.atView(state).open, false);
  assert.equal(state.method, null);
});

test('不认识的迁移不产生半截状态', () => {
  // 关着时 pick：原样关着。
  const closed = at.atInitialState();
  assert.deepEqual(at.atTransition(closed, { type: 'pick', key: 'prompt' }), closed);
  // 菜单里 pick 一个不存在的方法：留在菜单。
  const menu = at.atTransition(closed, { type: 'open' });
  assert.deepEqual(at.atTransition(menu, { type: 'pick', key: 'nope' }), menu);
  // 菜单里 back：没有方法可退，原样。
  assert.deepEqual(at.atTransition(menu, { type: 'back' }), menu);
  // 不认识的 action：原样。
  assert.deepEqual(at.atTransition(menu, { type: 'wat' }), menu);
});

// ── 按键优先级：`/` 优先，`@@` 不吞普通 Enter ─────────────────────

const keyPlan = (overrides = {}) => compose.composerKeyAction({
  slashOpen: false,
  slashCustomizing: false,
  itemCount: 0,
  atOpen: false,
  key: 'Enter',
  shiftKey: false,
  ...overrides
});

test('@@ 面板：Enter 关面板并照常发送，Esc 只关面板', () => {
  assert.deepEqual(keyPlan({ atOpen: true }),
    { action: 'close-at-and-send', preventDefault: true });
  assert.deepEqual(keyPlan({ atOpen: true, key: 'Escape' }),
    { action: 'close-at', preventDefault: true });
  // 打开着时 Shift+Enter 仍然换行，不发送。
  assert.deepEqual(keyPlan({ atOpen: true, shiftKey: true }),
    { action: 'none', preventDefault: false });
  // 这一轮菜单没有键盘选中项：↑↓ 留给输入框挪光标，不吞。
  assert.deepEqual(keyPlan({ atOpen: true, key: 'ArrowDown' }),
    { action: 'none', preventDefault: false });
});

test('两个面板都声称开着时 `/` 优先，行为不被 @@ 改写', () => {
  assert.deepEqual(keyPlan({ slashOpen: true, atOpen: true, itemCount: 2 }),
    { action: 'invoke', preventDefault: true });
  assert.deepEqual(keyPlan({ slashOpen: true, atOpen: true, itemCount: 0 }),
    { action: 'close-and-send', preventDefault: true });
  assert.deepEqual(keyPlan({ slashOpen: true, atOpen: true, key: 'Escape' }),
    { action: 'close-panel', preventDefault: true });
});

test('@@ 关着时按键行为与 #132 完全一致', () => {
  assert.deepEqual(keyPlan(), { action: 'send', preventDefault: true });
  assert.deepEqual(keyPlan({ atOpen: false, shiftKey: true }),
    { action: 'none', preventDefault: false });
});
