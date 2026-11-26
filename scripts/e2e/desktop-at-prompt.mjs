// #123 验收：`@@` →「生成 prompt」的流内勾选与四段落流。
//
// 命中真实路径：离屏 Electron + CDP，加载卡片壳 shell.html。
// 覆盖：进方法即进勾选态；提问与回复都能勾、能取消；卡片只放计数 / 指令 / 生成；
//       填指令生成后四段按固定顺序落进流、引用是原文、两张引用标签各自编号；
//       生成后退出勾选态、卡片关闭、焦点回输入框；块复制拿到同一份 prompt。
// 截图：勾选态、生成结果。
import fs from 'node:fs';
import path from 'node:path';
import {
  capture, consoleErrors, createChecker, startApp, sleep, waitFor
} from './lib/cdp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const shotsDir = process.env.SHOTS_DIR
  ?? path.resolve(repoRoot, '..', '..', 'mm-notes', 'shots-123');
const tempBase = process.env.TMP_123 ?? path.resolve(shotsDir, '..', 'tmp-123');
const { check, failures } = createChecker('[AT-PROMPT-#123]');

const typeInput = (panel, text) => panel.evaluate(`(() => {
  const input = document.getElementById('input');
  input.focus();
  input.value = ${JSON.stringify(text)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input.value;
})()`);

const pressEnter = (panel) => panel.evaluate(`(() => {
  const input = document.getElementById('input');
  input.focus();
  const event = new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', bubbles: true, cancelable: true
  });
  input.dispatchEvent(event);
  return event.defaultPrevented;
})()`);

const click = (panel, selector) => panel.evaluate(`(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) return false;
  node.click();
  return true;
})()`);

/** 真实点击的第一段：mousedown 要能从消息冒泡到对话流，@ 卡片不能把它当外部点击。 */
const pressMouseDown = (panel, selector) => panel.evaluate(`(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) return false;
  node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  return true;
})()`);

/** 点一条消息（先 mousedown 再 click，与真实指针顺序一致）。 */
const clickMessage = async (panel, index) => {
  const selector = `#messages .msg[data-index="${index}"] .bubble`;
  const down = await pressMouseDown(panel, selector);
  return down && click(panel, selector);
};

const createSession = async (panel) => {
  await click(panel, '#sessionToggle');
  await waitFor(panel, "document.getElementById('sessionPopover').hidden === false", 5000);
  await click(panel, '#sessionNew');
  return waitFor(panel, "document.getElementById('input').disabled === false", 8000);
};

const sendLine = async (panel, text, expectedCount) => {
  await typeInput(panel, text);
  await pressEnter(panel);
  return waitFor(panel, `document.querySelectorAll('#messages .msg').length === ${expectedCount}`, 8000);
};

const openPromptMethod = async (panel) => {
  await typeInput(panel, '@@');
  await waitFor(panel, "document.getElementById('atPanel').hidden === false", 5000);
  await click(panel, '.at-method[data-at-method="prompt"]');
  return waitFor(panel, "document.getElementById('atPromptInstruction')", 5000);
};

const readCard = (panel) => panel.evaluate(`(() => {
  const panelNode = document.getElementById('atPanel');
  const field = document.getElementById('atPromptInstruction');
  const button = document.querySelector('.at-prompt-generate');
  return {
    panelHidden: panelNode.hidden,
    title: document.getElementById('atTitle').textContent.trim(),
    count: document.querySelector('.at-prompt-count')?.textContent.trim() ?? '',
    hasField: Boolean(field),
    fieldValue: field?.value ?? '',
    generateDisabled: button?.disabled ?? true,
    selecting: document.getElementById('messages').classList.contains('selecting'),
    selected: [...document.querySelectorAll('#messages .msg[data-selected="true"]')]
      .map((item) => Number(item.dataset.index)),
    selectable: [...document.querySelectorAll('#messages .msg')]
      .map((item) => ({ index: Number(item.dataset.index), ok: item.dataset.selectable === 'true' })),
    active: document.activeElement?.id ?? '',
    inputFocused: document.activeElement === document.getElementById('input')
  };
})()`);

const readMessageText = (panel, index) => panel.evaluate(`(() => {
  const item = document.querySelector('#messages .msg[data-index="${index}"]');
  return item?.querySelector('.bubble')?.textContent ?? '';
})()`);

/** 生成结果从块模型里读：按渲染出的每一行拼回去，避免把行号一起读进来。 */
const readCodeBlock = (panel, index) => panel.evaluate(`(() => {
  const item = document.querySelector('#messages .msg[data-index="${index}"]');
  const block = item?.querySelector('[data-block="code"]');
  if (!block) return null;
  return {
    title: block.querySelector('.block-head h4')?.textContent.trim() ?? '',
    lines: [...block.querySelectorAll('.block-code .lc')].map((node) => node.textContent),
    blockIndex: Number(block.dataset.blockIndex)
  };
})()`);

const readThreadFlags = (panel) => panel.evaluate(`(() => ({
  count: document.querySelectorAll('#messages .msg').length,
  selecting: document.getElementById('messages').classList.contains('selecting'),
  panelHidden: document.getElementById('atPanel').hidden,
  inputFocused: document.activeElement === document.getElementById('input'),
  inputValue: document.getElementById('input').value
}))()`);

const injectWriter = (panel) => panel.evaluate(`(() => {
  window.__copiedText = null;
  window.OwnerShellClipboard = { write: async (text) => { window.__copiedText = text; } };
  return true;
})()`);

const run = async () => {
  fs.mkdirSync(tempBase, { recursive: true });
  fs.mkdirSync(shotsDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'at-prompt-123-'));
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

    // 两轮对话：用户 1 / 回复 1 / 用户 2 / 回复 2。
    const FIRST_ASK = '把 A 方案换成 B 方案吗？';
    const SECOND_ASK = '先补哪一块测试？';
    check('first turn lands in the stream', await sendLine(panel, FIRST_ASK, 2));
    check('second turn lands in the stream', await sendLine(panel, SECOND_ASK, 4));
    check('two user messages and two replies are visible',
      await panel.evaluate(`(() => {
        const items = [...document.querySelectorAll('#messages .msg')];
        return items.filter((item) => item.dataset.role === 'user').length === 2
          && items.filter((item) => item.dataset.role === 'agent').length === 2;
      })()`));
    const FIRST_REPLY = await readMessageText(panel, 1);
    const SECOND_REPLY = await readMessageText(panel, 3);
    check('the replies have text to quote', FIRST_REPLY.length > 0 && SECOND_REPLY.length > 0);

    // ① 进方法：对话流可勾选，卡片只有计数 / 指令 / 生成。
    check('entering the prompt method mounts its controls', await openPromptMethod(panel));
    let card = await readCard(panel);
    check('the card is the prompt method', card.panelHidden === false && card.title === '生成 prompt',
      card.title);
    check('the card starts at zero selected', card.count === '已选 0 条', card.count);
    check('the card has an instruction field', card.hasField, JSON.stringify(card));
    check('generate is disabled until something is selected', card.generateDisabled === true);
    check('the stream is in select mode', card.selecting === true);
    check('every message with text is selectable', card.selectable.every((row) => row.ok),
      JSON.stringify(card.selectable));

    // ② 勾自己的提问：可勾，再点一次可取消。
    check('the first question is clickable', await clickMessage(panel, 0));
    card = await readCard(panel);
    check('clicking a question selects it and updates the count',
      JSON.stringify(card.selected) === '[0]' && card.count === '已选 1 条',
      JSON.stringify({ selected: card.selected, count: card.count }));
    check('clicking an in-flow message does not close the @@ card', card.panelHidden === false);
    check('the selected message is visibly marked', await panel.evaluate(
      "document.querySelector('#messages .msg[data-index=\"0\"]').getAttribute('aria-selected') === 'true'"
    ));
    check('clicking the same question again cancels it', await clickMessage(panel, 0));
    card = await readCard(panel);
    check('the count goes back to zero',
      card.selected.length === 0 && card.count === '已选 0 条' && card.generateDisabled === true,
      JSON.stringify({ selected: card.selected, count: card.count }));

    // ③ 重新勾一条提问 + 一条回复：计数 2，标签各自编号。
    check('selecting the first question again', await clickMessage(panel, 0));
    check('selecting the second reply', await clickMessage(panel, 3));
    card = await readCard(panel);
    check('two messages are selected', JSON.stringify(card.selected) === '[0,3]',
      JSON.stringify(card.selected));
    check('the card says 已选 2 条', card.count === '已选 2 条', card.count);
    check('generate is enabled with a selection', card.generateDisabled === false);
    await capture(panel, path.join(shotsDir, 'at-prompt-selecting.png'));

    // ④ 填指令并生成。
    const INSTRUCTION = '把这段对话整理成一条决策记录';
    await panel.evaluate(`(() => {
      const field = document.getElementById('atPromptInstruction');
      field.focus();
      field.value = ${JSON.stringify(INSTRUCTION)};
      field.dispatchEvent(new Event('input', { bubbles: true }));
      return field.value;
    })()`);
    check('the generate button is clicked', await click(panel, '.at-prompt-generate'));
    check('the prompt lands in the stream as a new message',
      await waitFor(panel, "document.querySelectorAll('#messages .msg').length === 5", 8000),
      String((await readThreadFlags(panel)).count));
    await sleep(200);
    const flags = await readThreadFlags(panel);
    check('the card closes after generating', flags.panelHidden === true);
    check('select mode ends after generating', flags.selecting === false);
    check('focus returns to the composer', flags.inputFocused === true, flags.active);
    // 取消与生成都不动正文：#122 的「没有副作用」口径保持，`@@` 原文留在草稿里由用户处理。
    check('generating leaves the draft untouched', flags.inputValue === '@@', flags.inputValue);

    const result = await readCodeBlock(panel, 4);
    check('the result is a code block named as the generated prompt',
      Boolean(result) && result.title === '生成的 prompt', JSON.stringify(result?.title));
    const text = (result?.lines ?? []).join('\n');

    // ⑤ 四段结构：顺序固定，空段不出现；这里指令已填、两条已选，所以四段都在。
    const headings = ['# 指令', '# 上下文', '## 引用对话（原文）', '# 我需要你'];
    const positions = headings.map((heading) => text.indexOf(heading));
    check('all four sections are present', positions.every((at) => at >= 0),
      JSON.stringify(headings.map((heading, i) => [heading, positions[i]])));
    check('the sections keep the documented order',
      positions.every((at, i) => i === 0 || at > positions[i - 1]), JSON.stringify(positions));
    check('the instruction is quoted in the first section',
      text.startsWith(`# 指令\n\n${INSTRUCTION}`), text.slice(0, 60));
    check('the context carries project / session / time',
      text.includes('- 项目：') && text.includes('- 会话：') && text.includes('- 时间：'));
    check('the two references keep their own numbering',
      text.includes('**我的第 1 句**') && text.includes('**第 2 条回复**')
      && !text.includes('**第 1 条回复**'));
    check('the question is quoted verbatim', text.includes(`> ${FIRST_ASK}`), FIRST_ASK);
    check('the reply is quoted verbatim', text.includes(`> ${SECOND_REPLY}`), SECOND_REPLY);
    check('the closing ask repeats the same instruction',
      text.endsWith(`# 我需要你\n\n${INSTRUCTION}`));
    await capture(panel, path.join(shotsDir, 'at-prompt-result.png'));

    // ⑥ 复制：块上的复制按钮拿到同一份 prompt。
    await injectWriter(panel);
    check('the generated block can be copied', await click(panel,
      '#messages .msg[data-index="4"] [data-block="code"] .block-copy'));
    check('the clipboard writer receives the prompt', await waitFor(panel, 'window.__copiedText', 5000));
    const copied = await panel.evaluate('window.__copiedText');
    check('the copied text contains the exact generated prompt', copied.includes(text),
      `${copied.length} bytes`);
    check('copying still reports success', await waitFor(panel,
      "document.getElementById('toast').textContent.includes('已复制')", 5000));

    const errors = consoleErrors(panel);
    check('console is clean', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await app.stop();
    if (failures.length === 0) {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      } catch { /* 失败留现场，成功删不掉也不影响结论 */ }
    } else {
      console.warn(`[AT-PROMPT-#123] kept state: ${root}`);
    }
  }
  if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
  console.log(`[AT-PROMPT-#123] screenshots: ${shotsDir}`);
  console.log('[AT-PROMPT-#123] PASS');
};

run().catch((error) => {
  console.error(`[AT-PROMPT-#123] FAIL: ${error.stack ?? error.message}`);
  if (failures.length > 0) console.error(`[AT-PROMPT-#123] screenshots kept: ${shotsDir}`);
  process.exitCode = 1;
});
