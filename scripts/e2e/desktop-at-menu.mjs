// #122 验收：输入 `@@` 出的方法菜单与小卡片容器。
//
// 命中真实路径：离屏 Electron + CDP，加载卡片壳 shell.html。
// 覆盖：单个 @ / 邮箱不触发；双 @ 立刻出菜单；菜单项来自方法数据；进方法卡再返回；
//       Esc 关闭（焦点在卡片里时还回输入框末尾）；取消无副作用；`@@` 里直接回车不吞消息。
// 截图：菜单、方法卡骨架。
import fs from 'node:fs';
import path from 'node:path';
import {
  capture, consoleErrors, createChecker, startApp, sleep, waitFor
} from './lib/cdp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const shotsDir = process.env.SHOTS_DIR
  ?? path.resolve(repoRoot, '..', '..', 'mm-notes', 'shots-122');
const tempBase = process.env.TMP_122 ?? path.resolve(shotsDir, '..', 'tmp-122');
const { check, failures } = createChecker('[AT-#122]');

/** 往输入框里打字并派发 input：与用户敲 `@` 走同一条路径。 */
const typeInput = (panel, text) => panel.evaluate(`(() => {
  const input = document.getElementById('input');
  input.focus();
  input.value = ${JSON.stringify(text)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input.value;
})()`);

/** 在输入框上按键（与用户按 Enter / Esc 同一条路径）。 */
const pressInputKey = (panel, key) => panel.evaluate(`(() => {
  const input = document.getElementById('input');
  input.focus();
  const event = new KeyboardEvent('keydown', {
    key: ${JSON.stringify(key)}, code: ${JSON.stringify(key)}, bubbles: true, cancelable: true
  });
  input.dispatchEvent(event);
  return event.defaultPrevented;
})()`);

/** 在「当前焦点」上按键：验证焦点在卡片里时 Esc 也能关。 */
const pressFocusedKey = (panel, key) => panel.evaluate(`(() => {
  const target = document.activeElement ?? document.body;
  const event = new KeyboardEvent('keydown', {
    key: ${JSON.stringify(key)}, code: ${JSON.stringify(key)}, bubbles: true, cancelable: true
  });
  target.dispatchEvent(event);
  return { prevented: event.defaultPrevented, active: document.activeElement?.id ?? '' };
})()`);

const click = (panel, selector) => panel.evaluate(`(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) return false;
  node.click();
  return true;
})()`);

/** 面板当前可断言的形状：菜单行、标题、返回 / 关闭、尺寸、提示。 */
const readPanel = (panel) => panel.evaluate(`(() => {
  const node = document.getElementById('atPanel');
  const body = document.getElementById('atBody');
  const rect = node.getBoundingClientRect();
  const composerRect = document.getElementById('composer').getBoundingClientRect();
  return {
    hidden: node.hidden,
    title: document.getElementById('atTitle').textContent.trim(),
    sub: document.getElementById('atSub').textContent.trim(),
    backHidden: document.getElementById('atBack').hidden,
    hint: document.getElementById('atHint').textContent.trim(),
    methods: [...body.querySelectorAll('.at-method')].map((row) => ({
      key: row.dataset.atMethod,
      name: row.querySelector('.at-method-name')?.textContent.trim() ?? '',
      desc: row.querySelector('.at-method-desc')?.textContent.trim() ?? ''
    })),
    content: body.querySelector('.at-content')?.textContent.trim() ?? '',
    hasBody: Boolean(body.querySelector('.at-content')),
    width: rect.width,
    height: rect.height,
    bottom: rect.bottom,
    composerTop: composerRect.top,
    winWidth: window.innerWidth,
    winHeight: window.innerHeight,
    active: document.activeElement?.id ?? '',
    inputValue: document.getElementById('input').value,
    inputFocused: document.activeElement === document.getElementById('input'),
    caret: document.getElementById('input').selectionStart
  };
})()`);

const readMessageCount = (panel) => panel.evaluate(
  "document.querySelectorAll('#messages .msg').length"
);

/** 新建一条会话：没有当前会话时输入框被锁，测不了输入。 */
const createSession = async (panel) => {
  await click(panel, '#sessionToggle');
  await waitFor(panel, "document.getElementById('sessionPopover').hidden === false", 5000);
  await click(panel, '#sessionNew');
  return waitFor(panel, "document.getElementById('input').disabled === false", 8000);
};

const openAt = async (panel, text = '@@') => {
  await typeInput(panel, text);
  return waitFor(panel, "document.getElementById('atPanel').hidden === false", 5000);
};

const waitPanelHidden = (panel) => waitFor(panel,
  "document.getElementById('atPanel').hidden === true", 5000);

const run = async () => {
  fs.mkdirSync(tempBase, { recursive: true });
  fs.mkdirSync(shotsDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'at-122-'));
  const userData = path.join(root, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  const app = await startApp({
    userData,
    ownerDb: path.join(root, 'owner.sqlite'),
    knowledgeDb: path.join(root, 'knowledge.sqlite'),
    env: { OWNER_AGENT_SHELL: '1' },
    showPanel: true,
    page: 'shell.html'
  });
  const { panel } = app;
  try {
    check('card shell loads', await waitFor(panel, "document.querySelector('#shellHeader')", 30000));
    check('a session exists before typing @@', await createSession(panel));

    // ① 单个 @ 与邮箱不触发：正文里的 @ 不受影响。
    await typeInput(panel, '@');
    await sleep(150);
    check('a single @ does not open the menu', (await readPanel(panel)).hidden === true);
    await typeInput(panel, 'me@example.com');
    await sleep(150);
    check('an email address does not open the menu', (await readPanel(panel)).hidden === true);
    await typeInput(panel, '先说结论，再 @ 我');
    await sleep(150);
    check('an @ inside prose does not open the menu', (await readPanel(panel)).hidden === true);

    // ② 双 @ 立刻出菜单，菜单项来自方法数据，不是写死的分支。
    check('typing @@ opens the menu', await openAt(panel));
    let model = await readPanel(panel);
    const dataMethods = await panel.evaluate('window.OwnerShellAt.atMethods()');
    check('the menu is visible', model.hidden === false);
    check('the menu title says what @@ does', model.title === '@@ 要做什么', model.title);
    check('the menu is a small card, not a full window',
      model.height < model.winHeight * 0.6 && model.width <= model.winWidth - 20,
      `${Math.round(model.width)}x${Math.round(model.height)} in ${model.winWidth}x${model.winHeight}`);
    check('the menu sits above the composer instead of covering the draft',
      model.bottom <= model.composerTop + 1,
      `${Math.round(model.bottom)} <= ${Math.round(model.composerTop)}`);
    check('the menu rows are the method data (same rows and keys)',
      model.methods.length === dataMethods.length
      && JSON.stringify(model.methods.map((row) => row.key))
      === JSON.stringify(dataMethods.map((method) => method.key)),
      JSON.stringify(model.methods.map((row) => row.key)));
    check('the menu rows carry the data titles and descriptions',
      model.methods.every((row) => {
        const method = dataMethods.find((item) => item.key === row.key);
        return method && row.name === method.title && row.desc === method.desc;
      }),
      JSON.stringify(model.methods));
    check('the menu says how to close it without side effects',
      model.hint.includes('Esc') && model.hint.includes('正文不会变'), model.hint);
    check('opening the menu does not take focus away from the composer',
      model.inputFocused && model.inputValue === '@@', JSON.stringify({
        focused: model.inputFocused, value: model.inputValue
      }));
    await capture(panel, path.join(shotsDir, 'at-menu.png'));

    // ③ 选中方法 → 该方法自己的卡片：外壳给标题 + 返回 + 关闭，内容由方法给。
    check('clicking a method opens its card',
      await click(panel, '.at-method[data-at-method="prompt"]'));
    check('the method card is shown', await waitFor(panel,
      "document.getElementById('atTitle').textContent.includes('生成 prompt')", 5000));
    model = await readPanel(panel);
    check('the method card title comes from the method data',
      model.title === '生成 prompt' && model.sub === '方法卡片', `${model.title} / ${model.sub}`);
    check('the method card exposes a back button', model.backHidden === false);
    check('the method card body comes from the method content (prompt controls mounted)',
      model.hasBody && model.content.includes('已选'), model.content);
    check('the method card stays a small card',
      model.height < model.winHeight * 0.6,
      `${Math.round(model.width)}x${Math.round(model.height)} in ${model.winWidth}x${model.winHeight}`);
    check('entering the card moves focus onto the back button',
      await waitFor(panel, "document.activeElement?.id === 'atBack'", 5000), model.active);
    await capture(panel, path.join(shotsDir, 'at-method-card.png'));

    // ④ 返回菜单：卡片收掉，菜单重新出现，焦点落在第一行。
    check('back returns to the menu', await click(panel, '#atBack'));
    check('the menu is shown again', await waitFor(panel,
      "document.querySelectorAll('#atBody .at-method').length === window.OwnerShellAt.atMethods().length", 5000));
    model = await readPanel(panel);
    check('focus returns to the first method row',
      await waitFor(panel,
        "document.activeElement?.dataset?.atMethod === 'prompt'", 5000), model.active);

    // ⑤ 焦点在卡片里时 Esc：面板关闭，焦点回到输入框末尾，正文没被改。
    check('re-entering the method card', await click(panel,
      '.at-method[data-at-method="prompt"]'));
    check('Esc is handled while focus is inside the card',
      await waitFor(panel, "document.activeElement?.id === 'atBack'", 5000));
    const esc = await pressFocusedKey(panel, 'Escape');
    check('Esc closes the panel', await waitPanelHidden(panel), JSON.stringify(esc));
    model = await readPanel(panel);
    check('Esc returns focus to the composer', model.inputFocused === true, model.active);
    check('the caret is at the end after closing',
      model.caret === model.inputValue.length, `${model.caret}/${model.inputValue.length}`);
    check('cancelling leaves the draft untouched', model.inputValue === '@@', model.inputValue);
    check('cancelling writes nothing to the thread', await readMessageCount(panel) === 0);

    // ⑥ `@@` 里直接回车：关面板并把这条照常发出去（不吞消息）。
    check('reopening the menu for the Enter check', await openAt(panel));
    check('Enter is consumed by the menu layer', await pressInputKey(panel, 'Enter'));
    check('Enter closes the menu', await waitPanelHidden(panel));
    check('Enter still sends the draft as a normal message',
      await waitFor(panel, "document.querySelectorAll('#messages .msg').length === 2", 8000),
      String(await readMessageCount(panel)));
    const texts = await panel.evaluate(
      "[...document.querySelectorAll('#messages .msg')].map((item) => item.querySelector('.bubble')?.textContent ?? '')"
    );
    check('the sent draft keeps its raw @@ text', texts[0] === '@@', JSON.stringify(texts));

    // ⑦ `/` 与 `@@` 不同时占两层：方法卡开着时打 `/`，`@@` 收起，`/` 面板接手。
    check('reopening @@ for the panel-priority check', await openAt(panel));
    check('opening a method card for the priority check',
      await click(panel, '.at-method[data-at-method="session"]'));
    check('typing / after entering a method card', await typeInput(panel, '/'));
    check('the @@ card yields to the / panel', await waitPanelHidden(panel));
    check('the / panel is the one left open', await waitFor(panel,
      "document.getElementById('skillPanel').hidden === false", 20000));
    check('Esc closes the / panel again', await pressInputKey(panel, 'Escape'));
    check('the / panel is closed', await waitFor(panel,
      "document.getElementById('skillPanel').hidden === true", 5000));

    // ⑧ 关闭按钮：同样无副作用（只收起面板，不改正文）。
    check('reopening the menu for the close-button check', await openAt(panel));
    check('the close button closes the menu', await click(panel, '#atClose'));
    check('the close button leaves the draft untouched',
      (await readPanel(panel)).inputValue === '@@');

    const errors = consoleErrors(panel);
    check('console is clean', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await app.stop();
    if (failures.length === 0) {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      } catch { /* 失败留现场，成功删不掉也不影响结论 */ }
    } else {
      console.warn(`[AT-#122] kept state: ${root}`);
    }
  }
  if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
  console.log(`[AT-#122] screenshots: ${shotsDir}`);
  console.log('[AT-#122] PASS');
};

run().catch((error) => {
  console.error(`[AT-#122] FAIL: ${error.stack ?? error.message}`);
  if (failures.length > 0) console.error(`[AT-#122] screenshots kept: ${shotsDir}`);
  process.exitCode = 1;
});
