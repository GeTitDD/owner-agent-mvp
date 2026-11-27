// #110 验收：悬停复制与会话导出。
//
// 路径：卡片壳（#105）+ 块（#109）→ 输入 /blocks 得到「文字 + 十三块」。
// 断言五层：
//   ① 悬停消息只亮消息按钮；移到块上只亮块按钮（同一时刻一个）；
//   ② 复制块得到「这个块」的 Markdown（表格仍是表格，不含别的块）；
//   ③ 复制消息得到「文字 + 全部块」，块之间有且只有一个空行；
//   ④ 剪贴板写入失败时出现可见的失败提示（用注入的 writer，不碰真实剪贴板）；
//   ⑤ 导出落到 <userData>/conversations/<sessionId>.md，四个头字段齐全，重复导出正文一致。
// 纯函数规则在 tests/shell-copy.test.mjs；这里只断言界面上看得见的东西。
// 截图：悬停态 / 复制成功提示 / 导出路径，写到 SHOTS_DIR（缺省 mm-notes/shots-110）。
import fs from 'node:fs';
import path from 'node:path';
import { capture, consoleErrors, createChecker, sleep, startApp, waitFor } from './lib/cdp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const shotsDir = process.env.SHOTS_DIR
  ?? path.resolve(repoRoot, '..', '..', 'mm-notes', 'shots-110');
const tempBase = process.env.TMP_110 ?? path.resolve(shotsDir, '..', 'tmp-110');
const { check, failures } = createChecker('[COPY-EXPORT-#110]');

/** 往输入框里打字并派发 input 事件（等价于用户敲字，不触发发送）。 */
const typeDraft = (panel, text) => panel.evaluate(`(() => {
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

const sendDraft = async (panel, text) => {
  await typeDraft(panel, text);
  await pressEnter(panel);
};

/**
 * #106 起「没有会话就不能发消息」：复制与导出都挂在一条真实会话上。
 * 走界面上的入口（顶栏胶囊 → 新建），不直接调 IPC。
 */
const ensureSession = async (panel) => {
  await panel.evaluate("document.getElementById('sessionToggle').click()");
  await waitFor(panel, "document.getElementById('sessionPopover').hidden === false", 5000);
  await panel.evaluate("document.getElementById('sessionNew').click()");
  const ready = await waitFor(panel, "document.getElementById('input').disabled === false", 10000);
  await panel.evaluate("document.getElementById('sessionToggle').click()");
  return ready;
};

const hover = (panel, selector) => panel.evaluate(`(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) return false;
  node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  return true;
})()`);

/** 把目标滚进视口：悬停截图要真的看见那个块，而不是流到底部的另一屏。 */
const scrollTo = (panel, selector) => panel.evaluate(`(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) return false;
  node.scrollIntoView({ block: 'center' });
  return true;
})()`);

/** 当前可见的复制按钮：opacity 1 且吃指针事件。 */
const readCopyState = (panel) => panel.evaluate(`(() => {
  const visible = [...document.querySelectorAll('.copy-affordance')]
    .filter((node) => {
      const style = getComputedStyle(node);
      return style.opacity === '1' && style.pointerEvents !== 'none';
    })
    .map((node) => {
      const msg = node.closest('.msg');
      const block = node.closest('[data-block]');
      return {
        kind: node.classList.contains('msg-copy') ? 'message' : 'block',
        messageIndex: Number(msg?.dataset.index),
        block: block?.dataset.block ?? ''
      };
    });
  return {
    visible,
    activeMessages: [...document.querySelectorAll('.msg[data-copy-active]')].map((node) => node.dataset.index),
    activeBlocks: [...document.querySelectorAll('.block[data-copy-active]')].map((node) => node.dataset.block)
  };
})()`);

const click = (panel, selector) => panel.evaluate(`(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) return false;
  node.click();
  return true;
})()`);

const injectWriter = (panel, body) => panel.evaluate(`(() => {
  window.__copiedText = null;
  window.OwnerShellClipboard = { write: async (text) => { ${body} } };
  return true;
})()`);

const readToast = (panel) => panel.evaluate(`(() => {
  const toast = document.getElementById('toast');
  return { hidden: toast.hidden, text: toast.textContent, tone: toast.dataset.tone ?? '' };
})()`);

const readExportPath = (panel) => panel.evaluate(`(() => {
  const node = document.getElementById('exportPath');
  return { hidden: node.hidden, text: node.textContent };
})()`);

const readSession = (panel) => panel.evaluate(
  "window.companion.cardSessions.list({}).then((result) => result.items[0] ?? null)"
);

const safeRemove = (target) => {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    console.warn(`[COPY-EXPORT-#110] kept state: ${target}`);
  }
};

const run = async () => {
  fs.mkdirSync(tempBase, { recursive: true });
  fs.mkdirSync(shotsDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'copy-export-110-'));
  const userData = path.join(root, 'userdata');
  fs.mkdirSync(userData, { recursive: true });

  const app = await startApp({
    userData,
    ownerDb: path.join(root, 'owner.sqlite'),
    knowledgeDb: path.join(root, 'knowledge.sqlite'),
    showPanel: true,
    page: 'shell.html'
  });
  const { panel } = app;
  try {
    check('shell page loads through the main-process switch',
      await waitFor(panel, "document.querySelector('#shellHeader')", 30000));
    check('a session exists before copy and export', await ensureSession(panel));

    // 一条带全部块的回复。
    await sendDraft(panel, '/blocks');
    await waitFor(panel, "document.querySelectorAll('#messages .msg').length === 2", 5000);
    check('the sample reply carries thirteen blocks',
      await panel.evaluate("document.querySelectorAll('#messages .msg.agent [data-block]').length") === 13);

    // ① 悬停消息：只有消息按钮亮。
    check('hovering a message is possible',
      await hover(panel, '#messages .msg[data-index="0"] .bubble'));
    const onMessage = await readCopyState(panel);
    check('message hover shows exactly one copy button',
      onMessage.visible.length === 1 && onMessage.visible[0].kind === 'message',
      JSON.stringify(onMessage.visible));
    check('message hover targets that message only',
      onMessage.activeMessages.length === 1
      && onMessage.activeMessages[0] === '0'
      && onMessage.activeBlocks.length === 0,
      JSON.stringify(onMessage));

    // 悬停块：块按钮替代消息按钮，同一时刻仍然只有一个。
    check('the table block can be scrolled into view',
      await scrollTo(panel, '#messages [data-block="table"]'));
    await sleep(300);
    check('hovering a block is possible',
      await hover(panel, '#messages [data-block="table"] .block-table'));
    const onBlock = await readCopyState(panel);
    check('block hover shows exactly one copy button',
      onBlock.visible.length === 1
      && onBlock.visible[0].kind === 'block'
      && onBlock.visible[0].block === 'table',
      JSON.stringify(onBlock.visible));
    check('block hover hides the message button',
      onBlock.activeBlocks.length === 1
      && onBlock.activeBlocks[0] === 'table'
      && onBlock.activeMessages.length === 0,
      JSON.stringify(onBlock));
    await capture(panel, path.join(shotsDir, 'copy-hover-block.png'));

    // ② 复制块：内容只有这个块，且表格还是表格。
    await injectWriter(panel, 'window.__copiedText = text;');
    check('the block copy button is clickable',
      await click(panel, '#messages [data-block="table"] .block-copy'));
    check('the injected writer received the block markdown',
      await waitFor(panel, 'window.__copiedText', 5000));
    const blockCopy = await panel.evaluate('window.__copiedText');
    check('block copy keeps the table shape',
      blockCopy.includes('### 最近三条提交')
      && blockCopy.includes('| 提交 | 说明 | 时间 |')
      && blockCopy.includes('| 7ccbe10 | Merge branch feat/card-shell | 11:42 |'),
      blockCopy.slice(0, 120));
    check('block copy does not leak the rest of the reply',
      !blockCopy.includes('### 项目库概览') && !blockCopy.includes('### 知识来源'),
      blockCopy.slice(0, 120));

    await waitFor(panel, "document.getElementById('toast').dataset.tone === 'ok'", 5000);
    const successToast = await readToast(panel);
    check('a visible success toast follows the copy',
      successToast.hidden === false && successToast.text.includes('已复制'),
      JSON.stringify(successToast));
    await capture(panel, path.join(shotsDir, 'copy-success.png'));

    // ③ 复制整条消息：文字 + 块按顺序，块之间一个空行。
    await injectWriter(panel, 'window.__copiedText = text;');
    check('the message copy button is clickable',
      await click(panel, '#messages .msg[data-index="1"] .msg-copy'));
    check('the injected writer received the message markdown',
      await waitFor(panel, 'window.__copiedText', 5000));
    const messageCopy = await panel.evaluate('window.__copiedText');
    check('message copy starts with the reply text',
      messageCopy.startsWith('这是块全览的脚本化样本'),
      messageCopy.slice(0, 40));
    check('message copy keeps every block in order',
      messageCopy.indexOf('### 项目库概览') < messageCopy.indexOf('### 最近三条提交')
      && messageCopy.indexOf('### 最近三条提交') < messageCopy.indexOf('### 本周活动')
      && messageCopy.indexOf('### 本周活动') < messageCopy.indexOf('### 这条经验要归到哪个项目？'),
      messageCopy.slice(0, 80));
    check('message copy separates blocks with one blank line',
      messageCopy.includes('\n\n### 最近三条提交') && !messageCopy.includes('\n\n\n### 最近三条提交'),
      messageCopy.slice(0, 160));

    // ④ 剪贴板失败：可见提示，不静默。
    await injectWriter(panel, 'throw new Error("剪贴板被拒绝");');
    check('copy is clickable while the writer is failing',
      await click(panel, '#messages [data-block="kv"] .block-copy'));
    check('a failed copy shows an error toast',
      await waitFor(panel, "document.getElementById('toast').dataset.tone === 'error'", 5000));
    const errorToast = await readToast(panel);
    check('the failure toast says the copy failed and why',
      errorToast.hidden === false
      && errorToast.text.includes('复制失败')
      && errorToast.text.includes('剪贴板被拒绝'),
      JSON.stringify(errorToast));

    // ⑤ 导出：路径、头字段、重复导出正文一致。
    check('clicking export is possible', await click(panel, '#exportConversation'));
    check('export reports where the file went',
      await waitFor(panel, "document.getElementById('exportPath').hidden === false", 5000));
    const shownPath = await readExportPath(panel);
    const session = await readSession(panel);
    check('the page keeps a stable session id', Boolean(session?.id), JSON.stringify(session));
    const expectedPath = path.join(userData, 'conversations', `${session?.id ?? ''}.md`);
    check('export lands in <userData>/conversations/<sessionId>.md',
      path.resolve(shownPath.text) === path.resolve(expectedPath) && fs.existsSync(expectedPath),
      JSON.stringify({ shown: shownPath.text, expected: expectedPath }));

    const firstMarkdown = fs.readFileSync(expectedPath, 'utf8');
    const headerLines = firstMarkdown.split('\n');
    check('export header carries project, session, time and model',
      headerLines.some((line) => line.startsWith('- 项目：'))
      && headerLines.some((line) => line.startsWith('- 会话：'))
      && headerLines.some((line) => line.startsWith('- 时间：'))
      && headerLines.some((line) => line.startsWith('- 模型：')),
      headerLines.slice(0, 8).join(' | '));
    check('export body keeps both messages and the table block',
      firstMarkdown.includes('## 我')
      && firstMarkdown.includes('/blocks')
      && firstMarkdown.includes('## Companion')
      && firstMarkdown.includes('| 7ccbe10 | Merge branch feat/card-shell | 11:42 |'),
      firstMarkdown.slice(0, 80));
    await capture(panel, path.join(shotsDir, 'export-path.png'));

    // 同一会话再导出一次：文件内容必须逐字节一致。
    check('exporting the same conversation again is possible',
      await click(panel, '#exportConversation'));
    await sleep(600);
    const secondMarkdown = fs.readFileSync(expectedPath, 'utf8');
    check('repeated export of the same conversation is byte-identical',
      secondMarkdown === firstMarkdown,
      `${firstMarkdown.length} vs ${secondMarkdown.length}`);

    const errors = consoleErrors(panel);
    check('console is clean', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await app.stop();
    // 成功就清临时 userData / 库，失败留现场；截图始终留在 shotsDir。
    if (failures.length === 0) safeRemove(root);
    else console.warn(`[COPY-EXPORT-#110] kept state: ${root}`);
  }

  if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
  console.log(`[COPY-EXPORT-#110] screenshots: ${shotsDir}`);
  console.log('[COPY-EXPORT-#110] PASS');
};

run().catch((error) => {
  console.error(`[COPY-EXPORT-#110] FAIL: ${error.stack ?? error.message}`);
  if (failures.length > 0) console.error(`[COPY-EXPORT-#110] screenshots kept: ${shotsDir}`);
  process.exitCode = 1;
});
