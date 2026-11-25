// #105 验收：卡片壳（单窗口骨架）。
//
// 面板层没有单测先例，这里用离屏 Electron + CDP 走真实路径，并留三张截图：
//   ① 空态：没有消息，顶栏五个状态位在位且都写着「占位」，顶栏里没有任何可点控件；
//   ② 一条对话：回车发送后流里出现「我」的一条 + 一条占位回复（带「占位」徽章），输入框清空；
//   ③ 输入中：只打字不发送，流里条数不变，输入框高度不超过三行；
// 最后再起一次默认实例，确认不开开关时仍是旧面板（新壳没有改变旧行为）。
// 纯函数的消息状态迁移在 tests/shell-thread.test.mjs；这里只断言界面看得见的东西。
import fs from 'node:fs';
import path from 'node:path';
import {
  capture, consoleErrors, createChecker, startApp, waitFor
} from './lib/cdp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const shotsDir = process.env.SHOTS_DIR
  ?? path.resolve(repoRoot, '..', '..', 'mm-notes', 'shots-105');
const tempBase = process.env.TMP_105 ?? path.resolve(shotsDir, '..', 'tmp-105');
const { check, failures } = createChecker('[CARD-SHELL-#105]');

const SLOTS = ['session', 'project', 'write', 'monitor', 'export'];

/** 读流里每条消息的可断言形状：角色、谁说的、正文、是不是占位。 */
const readThread = (panel) => panel.evaluate(`(() => {
  const items = [...document.querySelectorAll('#messages .msg')];
  return {
    count: items.length,
    emptyHidden: document.getElementById('emptyState').hidden,
    messages: items.map((item) => ({
      role: item.dataset.role,
      placeholder: item.dataset.placeholder === 'true',
      who: item.querySelector('.who')?.textContent ?? '',
      badge: item.querySelector('.badge')?.textContent ?? '',
      text: item.querySelector('.bubble')?.textContent ?? ''
    })),
    draft: document.getElementById('input').value
  };
})()`);

/** 往输入框里打字并派发 input 事件（等价于用户敲字，不触发发送）。 */
const typeDraft = (panel, text) => panel.evaluate(`(() => {
  const input = document.getElementById('input');
  input.focus();
  input.value = ${JSON.stringify(text)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input.value;
})()`);

/** 派发一次 Enter / Shift+Enter，返回「默认行为有没有被拦下」。 */
const pressEnter = (panel, { shift = false } = {}) => panel.evaluate(`(() => {
  const input = document.getElementById('input');
  input.focus();
  const event = new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', shiftKey: ${shift}, bubbles: true, cancelable: true
  });
  input.dispatchEvent(event);
  return event.defaultPrevented;
})()`);

const inputHeight = (panel) => panel.evaluate(
  "document.getElementById('input').getBoundingClientRect().height"
);

const safeRemove = (target) => {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    console.warn(`[CARD-SHELL-#105] kept state: ${target}`);
  }
};

const runShell = async () => {
  fs.mkdirSync(tempBase, { recursive: true });
  fs.mkdirSync(shotsDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'card-shell-105-'));
  const userData = path.join(root, 'userdata');
  fs.mkdirSync(userData, { recursive: true });

  // 开关：主进程只在 OWNER_AGENT_SHELL=1（或 --shell）时才加载新壳。
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
    check('shell page loads through the main-process switch',
      await waitFor(panel, "document.querySelector('#shellHeader')", 30000));

    const pageUrl = await panel.evaluate('location.pathname');
    check('window is showing the new renderer, not the old panel',
      String(pageUrl).includes('shell.html'), String(pageUrl));

    // ① 空态：顶栏五个状态位 + 空流。
    const slots = await panel.evaluate(
      "[...document.querySelectorAll('#shellHeader .slot')].map((node) => node.dataset.slot)"
    );
    check('top bar keeps the five status slots', JSON.stringify(slots) === JSON.stringify(SLOTS),
      JSON.stringify(slots));
    const placeholders = await panel.evaluate(
      "[...document.querySelectorAll('#shellHeader .slot-value')].map((node) => node.textContent.trim())"
    );
    check('every slot is marked as a placeholder',
      placeholders.length === SLOTS.length && placeholders.every((text) => text.includes('占位')),
      JSON.stringify(placeholders));
    const headerControls = await panel.evaluate(
      "document.querySelectorAll('#shellHeader button, #shellHeader input, #shellHeader select, #shellHeader a').length"
    );
    check('top bar has no controls (status only, not a second menu)', headerControls === 0,
      String(headerControls));

    const empty = await readThread(panel);
    check('empty state starts with no messages', empty.count === 0, String(empty.count));
    check('empty hint is visible before the first message', empty.emptyHidden === false);
    await capture(panel, path.join(shotsDir, 'shell-empty.png'));

    // ② 一条对话：回车发送。
    const draft = '把今天的待办整理成三条';
    await typeDraft(panel, draft);
    const sendEnabled = await panel.evaluate("document.getElementById('send').disabled === false");
    check('send button enables once there is text', sendEnabled);

    const enterBlocked = await pressEnter(panel);
    check('plain Enter is taken over as send', enterBlocked === true);

    const afterSend = await readThread(panel);
    check('one send produces exactly two entries', afterSend.count === 2, String(afterSend.count));
    check('my message comes first, with the text I typed',
      afterSend.messages[0]?.role === 'user' && afterSend.messages[0]?.text === draft,
      JSON.stringify(afterSend.messages[0]));
    check('my message is labelled 我', (afterSend.messages[0]?.who ?? '').startsWith('我'),
      afterSend.messages[0]?.who);
    check('a reply follows', afterSend.messages[1]?.role === 'agent',
      afterSend.messages[1]?.role);
    check('the reply says it is a placeholder',
      afterSend.messages[1]?.placeholder === true
      && afterSend.messages[1]?.text.includes('占位')
      && afterSend.messages[1]?.badge === '占位回复',
      JSON.stringify({ placeholder: afterSend.messages[1]?.placeholder, badge: afterSend.messages[1]?.badge }));
    check('the placeholder reply quotes what I said',
      afterSend.messages[1]?.text.includes(draft), afterSend.messages[1]?.text);
    check('composer is cleared after sending', afterSend.draft === '', afterSend.draft);
    check('empty hint is gone once there is a turn', afterSend.emptyHidden === true);
    await capture(panel, path.join(shotsDir, 'shell-one-turn.png'));

    // Shift+回车不是发送：默认行为不被拦，流不变。
    await typeDraft(panel, '第二句还没发');
    const shiftBlocked = await pressEnter(panel, { shift: true });
    const afterShift = await readThread(panel);
    check('Shift+Enter is left to the textarea (newline, not send)', shiftBlocked === false);
    check('Shift+Enter adds no message', afterShift.count === 2, String(afterShift.count));

    // ③ 输入中：只打字不发送；高度最多三行。
    await typeDraft(panel, '第一行\n第二行\n第三行\n第四行\n第五行');
    const tallHeight = await inputHeight(panel);
    check('composer grows but stops at three lines', tallHeight <= 88, `${tallHeight}px`);
    const typingDraft = '先不发送：这一屏只截「输入中」';
    await typeDraft(panel, typingDraft);
    const typing = await readThread(panel);
    check('typing does not add messages', typing.count === 2, String(typing.count));
    check('the draft stays in the composer', typing.draft === typingDraft, typing.draft);
    await capture(panel, path.join(shotsDir, 'shell-typing.png'));

    // 发送按钮也必须能发：点一次，条数从 2 变 4。
    await panel.evaluate("document.getElementById('send').click()");
    await waitFor(panel, "document.querySelectorAll('#messages .msg').length === 4", 5000);
    const afterClick = await readThread(panel);
    check('clicking send appends another pair', afterClick.count === 4, String(afterClick.count));

    const errors = consoleErrors(panel);
    check('console is clean', errors.length === 0, errors.slice(0, 3).join(' | '));

    // 旧面板文件必须还在（expand 步骤：只并存，不删）。
    check('old panel files are untouched and still present',
      fs.existsSync(path.join(repoRoot, 'desktop', 'panel.html'))
      && fs.existsSync(path.join(repoRoot, 'desktop', 'panel.js'))
      && fs.existsSync(path.join(repoRoot, 'desktop', 'panel.css')));
  } finally {
    await app.stop();
    // 成功就清临时 userData / 库，失败留着现场；截图始终留在 shotsDir。
    if (failures.length === 0) safeRemove(root);
    else console.warn(`[CARD-SHELL-#105] kept state: ${root}`);
  }
};

/** 不开开关时仍然是旧面板：新壳不能改变默认入口。 */
const runDefaultEntry = async () => {
  const root = fs.mkdtempSync(path.join(tempBase, 'card-shell-105-default-'));
  const userData = path.join(root, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  const app = await startApp({
    userData,
    ownerDb: path.join(root, 'owner.sqlite'),
    knowledgeDb: path.join(root, 'knowledge.sqlite'),
    showPanel: true
  });
  try {
    check('without the switch the window still loads panel.html',
      await waitFor(app.panel, "document.querySelector('#modeBar')", 30000));
    const modes = await app.panel.evaluate(
      "document.querySelectorAll('#modeBar button').length"
    );
    check('old panel still has its three modes', modes === 3, String(modes));
    const zones = await app.panel.evaluate("Boolean(document.getElementById('opsZone'))");
    check('old panel still has its two zones', zones === true);
    const errors = consoleErrors(app.panel);
    check('old panel boots with a clean console', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await app.stop();
    if (failures.length === 0) safeRemove(root);
    else console.warn(`[CARD-SHELL-#105] kept state: ${root}`);
  }
};

const run = async () => {
  await runShell();
  await runDefaultEntry();
  if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
  console.log(`[CARD-SHELL-#105] screenshots: ${shotsDir}`);
  console.log('[CARD-SHELL-#105] PASS');
};

run().catch((error) => {
  console.error(`[CARD-SHELL-#105] FAIL: ${error.stack ?? error.message}`);
  if (failures.length > 0) console.error(`[CARD-SHELL-#105] screenshots kept: ${shotsDir}`);
  process.exitCode = 1;
});
