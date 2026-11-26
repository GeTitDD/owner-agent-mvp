// #114 验收：自有目录写入免确认、成功与失败都留可复制的回执。
//
// 路径：卡片壳（#105）+ 块（#109）+ 复制（#110）→ 输入 /记灵感 … 直接写本机库。
// 断言五层：
//   ① 面板取到的判定与 src/write-gate.mjs 同源：五类自有目录动作全部 allow；
//   ② 触发一次真实写入（记灵感），全程没有确认卡：流里只有「我的一句 + 回执一条」，
//      没有任何确认块 / 确认卡节点；
//   ③ 回执写明写了什么与结果（键值块），库里确实多了这一条；
//   ④ 点回执块上的复制能拿到回执的 Markdown（复用 #110 的复制能力）；
//   ⑤ 注入一次写失败：回执里带原因，不静默，也不出现确认卡。
// 纯函数规则在 tests/own-write.test.mjs；这里只断言界面上看得见的东西。
// 截图写到 SHOTS_DIR（缺省 mm-notes/shots-114）。
import fs from 'node:fs';
import path from 'node:path';
import { OwnerStore } from '../../src/owner-store.mjs';
import { capture, consoleErrors, createChecker, sleep, startApp, waitFor } from './lib/cdp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const shotsDir = process.env.SHOTS_DIR
  ?? path.resolve(repoRoot, '..', '..', 'mm-notes', 'shots-114');
const tempBase = process.env.TMP_114 ?? path.resolve(shotsDir, '..', 'tmp-114');
const { check, failures } = createChecker('[OWN-WRITE-#114]');

const IDEA_TEXT = '#114 回执验收：收件箱空的时候应该有一句提示，而不是一片空白。';
const FAILED_TEXT = '#114 失败路径：这条灵感写不进去，回执要带原因。';

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

/** 「没有会话就不能发消息」：走界面上的入口（顶栏胶囊 → 新建），不直接调 IPC。 */
const ensureSession = async (panel) => {
  await panel.evaluate("document.getElementById('sessionToggle').click()");
  await waitFor(panel, "document.getElementById('sessionPopover').hidden === false", 5000);
  await panel.evaluate("document.getElementById('sessionNew').click()");
  const ready = await waitFor(panel, "document.getElementById('input').disabled === false", 10000);
  await panel.evaluate("document.getElementById('sessionToggle').click()");
  return ready;
};

const messageCount = (panel) => panel.evaluate("document.querySelectorAll('#messages .msg').length");

/** 流里任何看起来像确认卡的东西：块类型、属性或类名都算。 */
const confirmCards = (panel) => panel.evaluate(`(() => {
  const nodes = [
    ...document.querySelectorAll('[data-block="confirm"], [data-confirm], [data-confirm-card], .confirm-card')
  ];
  return nodes.length;
})()`);

/** 一条回执的界面快照：文字 + 它自己的键值块（行按「键：值」读）。 */
const readReceipt = (panel, messageIndex) => panel.evaluate(`(() => {
  const item = document.querySelector('#messages .msg[data-index="${messageIndex}"]');
  if (!item) return null;
  const block = item.querySelector('[data-block="kv"]');
  const rows = {};
  if (block) {
    block.querySelectorAll('.block-kv > div').forEach((row) => {
      const key = row.querySelector('dt')?.textContent ?? '';
      const value = row.querySelector('dd')?.textContent ?? '';
      if (key) rows[key] = value;
    });
  }
  return {
    role: item.dataset.role ?? '',
    text: item.querySelector('.bubble')?.textContent ?? '',
    placeholder: item.dataset.placeholder === 'true',
    blockTitle: block?.querySelector('.block-head h4')?.textContent ?? '',
    rows,
    hasBlock: Boolean(block)
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

const injectFailingWrite = (panel, message) => panel.evaluate(`(() => {
  window.OwnerOwnWriteExecutor = async () => { throw new Error(${JSON.stringify(message)}); };
  return true;
})()`);

const safeRemove = (target) => {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    console.warn(`[OWN-WRITE-#114] kept state: ${target}`);
  }
};

/** 库里的原始行：DOM 能改，读库才能证明「真的写进去了」。 */
const readIdea = (ownerDb, text) => {
  const store = new OwnerStore(ownerDb);
  try {
    return store.listIdeaInbox()
      .find((item) => String(item.rawText ?? '').includes(text.slice(0, 20))) ?? null;
  } finally {
    store.close();
  }
};

const run = async () => {
  fs.mkdirSync(tempBase, { recursive: true });
  fs.mkdirSync(shotsDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'own-write-114-'));
  const userData = path.join(root, 'userdata');
  const ownerDb = path.join(root, 'owner.sqlite');
  const knowledgeDb = path.join(root, 'knowledge.sqlite');
  fs.mkdirSync(userData, { recursive: true });

  const app = await startApp({
    userData,
    ownerDb,
    knowledgeDb,
    showPanel: true,
    page: 'shell.html'
  });
  const { panel } = app;
  try {
    check('shell page loads through the main-process switch',
      await waitFor(panel, "document.querySelector('#shellHeader')", 30000));
    // 模块脚本晚于经典脚本：等 own-write-host 把纯函数挂上窗口。
    check('the own-write module is readable from the page',
      await waitFor(panel, 'Boolean(window.OwnerOwnWrite?.run)', 10000));
    check('a session exists before the write', await ensureSession(panel));

    // ① 同一份判定：五类自有目录动作在面板里全部 allow，声明删除则不是 allow。
    const decisions = await panel.evaluate(`(() => {
      const api = window.OwnerOwnWrite;
      const kinds = api.OWN_WRITE_KINDS;
      const allow = kinds.map((kind) => api.decide({ kind, deletes: false, granted: {} }));
      const deleting = api.decide({ kind: 'idea', deletes: true, granted: {} });
      const unknown = api.decide({ kind: 'publish-to-project' });
      return {
        kinds,
        outcomes: allow.map((item) => item.gate.outcome),
        allowed: allow.map((item) => item.allowed),
        deleting: { allowed: deleting.allowed, needsConfirm: deleting.needsConfirm },
        unknown: { allowed: unknown.allowed, denied: unknown.denied }
      };
    })()`);
    check('the page knows all five own-directory actions',
      decisions?.kinds?.length === 5, JSON.stringify(decisions?.kinds));
    check('every own-directory action is allow in the page',
      decisions?.outcomes?.every((outcome) => outcome === 'allow')
      && decisions?.allowed?.every(Boolean),
      JSON.stringify(decisions?.outcomes));
    check('declaring delete is not allow (that path is #116)',
      decisions?.deleting?.allowed === false && decisions?.deleting?.needsConfirm === true,
      JSON.stringify(decisions?.deleting));
    check('an unknown action is denied', decisions?.unknown?.denied === true,
      JSON.stringify(decisions?.unknown));

    // ② 真实写入：一句 /记灵感，流里只有「我的一句 + 回执一条」。
    await sendDraft(panel, `/记灵感 ${IDEA_TEXT}`);
    check('the write leaves exactly two messages',
      await waitFor(panel, "document.querySelectorAll('#messages .msg').length === 2", 10000),
      String(await messageCount(panel)));
    check('no confirmation card appears anywhere in the flow',
      (await confirmCards(panel)) === 0, String(await confirmCards(panel)));

    const userMessage = await readReceipt(panel, 0);
    check('my line is kept as a plain user message',
      userMessage?.role === 'user' && userMessage.text.includes('/记灵感'), JSON.stringify(userMessage));
    const receipt = await readReceipt(panel, 1);
    check('the receipt is an agent message with the kv block',
      receipt?.role === 'agent' && receipt.hasBlock === true
      && receipt.blockTitle === '写入回执 · 记灵感',
      JSON.stringify({ role: receipt?.role, title: receipt?.blockTitle }));
    check('the receipt is not a placeholder reply', receipt?.placeholder === false,
      String(receipt?.placeholder));
    check('the receipt says what was written',
      receipt?.rows?.['动作'] === '记灵感'
      && /ideas 表/u.test(receipt?.rows?.['写入'] ?? '')
      && /写入回执（自有目录）：记灵感已写入/u.test(receipt?.text ?? ''),
      JSON.stringify(receipt?.rows));
    check('the receipt carries the result (idea id)',
      /^[0-9a-f][0-9a-f-]{7,}$/iu.test(receipt?.rows?.['结果'] ?? ''), receipt?.rows?.['结果']);
    await capture(panel, path.join(shotsDir, 'own-write-receipt.png'));

    // ③ 库里确实有这一条：回执不是画出来的假象。
    const stored = readIdea(ownerDb, IDEA_TEXT);
    check('the idea really landed in the own-directory store',
      Boolean(stored) && stored.rawText === IDEA_TEXT,
      JSON.stringify({ id: stored?.id, status: stored?.ideaStatus }));
    check('the receipt result matches the stored item',
      stored?.id === receipt?.rows?.['结果'],
      JSON.stringify({ row: receipt?.rows?.['结果'], stored: stored?.id }));

    // ④ 复制回执：既有块的复制按钮 + 既有 Markdown 转换。
    await injectWriter(panel, 'window.__copiedText = text;');
    check('the receipt block copy button is clickable',
      await click(panel, '#messages .msg[data-index="1"] [data-block="kv"] .block-copy'));
    check('the injected writer received the receipt markdown',
      await waitFor(panel, 'window.__copiedText', 5000));
    const copied = await panel.evaluate('window.__copiedText');
    check('the copied receipt keeps the title and the rows',
      copied.includes('### 写入回执 · 记灵感')
      && copied.includes('- 动作：记灵感')
      && copied.includes(`- 结果：${stored?.id ?? ''}`),
      String(copied).slice(0, 160));

    // ⑤ 失败路径：注入写失败，回执必须带原因，也不出现确认卡。
    await injectFailingWrite(panel, '磁盘写满');
    await sendDraft(panel, `/记灵感 ${FAILED_TEXT}`);
    check('the failed write also leaves exactly two more messages',
      await waitFor(panel, "document.querySelectorAll('#messages .msg').length === 4", 10000),
      String(await messageCount(panel)));
    check('no confirmation card appears on the failure path either',
      (await confirmCards(panel)) === 0, String(await confirmCards(panel)));
    const failed = await readReceipt(panel, 3);
    check('the failure receipt is titled as a failure',
      failed?.blockTitle === '写入回执 · 记灵感（失败）', String(failed?.blockTitle));
    check('the failure receipt carries the reason, not silence',
      failed?.rows?.['结果'] === '失败'
      && /磁盘写满/u.test(failed?.rows?.['原因'] ?? '')
      && /没有写成：磁盘写满/u.test(failed?.text ?? ''),
      JSON.stringify(failed?.rows));
    check('the failed write changed nothing in the store',
      readIdea(ownerDb, FAILED_TEXT) === null);
    await capture(panel, path.join(shotsDir, 'own-write-failure.png'));

    await sleep(200);
    const errors = consoleErrors(panel);
    check('console is clean', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await app.stop();
    // 成功就清临时 userData / 库，失败留现场；截图始终留在 shotsDir。
    if (failures.length === 0) safeRemove(root);
    else console.warn(`[OWN-WRITE-#114] kept state: ${root}`);
  }

  if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
  console.log(`[OWN-WRITE-#114] screenshots: ${shotsDir}`);
  console.log('[OWN-WRITE-#114] PASS');
};

run().catch((error) => {
  console.error(`[OWN-WRITE-#114] FAIL: ${error.stack ?? error.message}`);
  if (failures.length > 0) console.error(`[OWN-WRITE-#114] screenshots kept: ${shotsDir}`);
  process.exitCode = 1;
});
