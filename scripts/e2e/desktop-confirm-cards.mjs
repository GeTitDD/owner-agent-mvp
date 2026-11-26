// #116 验收：外发确认卡 / 删除确认卡 / 删除回执 / 写后外发拆两次。
//
// 路径：卡片壳（#105）→ 输入 /外发、/删除、/同步（脚本化，不真的发、不真的删）。
// 断言：
//   ① 外发卡：强调「发出即收不回」；动作只有发出这一次 / 取消，没有免问；
//      取消后回执说「未发出」，且没有新增确认卡（本地状态未变）；
//   ② 删除卡：逐条列出完整路径；每项一个按钮 + 取消，没有「全部 / 批量」；
//      删一项后回执含已删与剩余项，剩余项另起一张卡；
//   ③ 同一动作既有写入又有外发：两张卡（risk 写入确认在前，confirm 外发在后），
//      说明先写后发的理由；
//   ④ 窄宽度下确认卡不把对话流撑出横向滚动；控制台干净。
// 截图：外发卡 / 删除卡 / 删除回执，写到 SHOTS_DIR（缺省 mm-notes/shots-116）。
import fs from 'node:fs';
import path from 'node:path';
import { capture, consoleErrors, createChecker, sleep, startApp, waitFor } from './lib/cdp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const shotsDir = process.env.SHOTS_DIR
  ?? path.resolve(repoRoot, '..', '..', 'mm-notes', 'shots-116');
const tempBase = process.env.TMP_116 ?? path.resolve(shotsDir, '..', 'tmp-116');
const { check, failures } = createChecker('[CONFIRM-#116]');

const EXTERNAL_PATHS = [
  'D:\\work\\integration\\docs\\adr\\0012-write-by-destination.md',
  'C:\\Users\\Owner\\.owner-agent\\knowledge\\exports\\snapshot-index.md'
];
const DELETE_PATHS = [
  'D:\\work\\integration\\docs\\adr\\0014-export-policy.md',
  'D:\\work\\integration\\docs\\adr\\0013-write-by-destination.md',
  'C:\\Users\\Owner\\.owner-agent\\exports\\cmp-demo\\v3'
];

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

const ensureSession = async (panel) => {
  await panel.evaluate("document.getElementById('sessionToggle').click()");
  await waitFor(panel, "document.getElementById('sessionPopover').hidden === false", 5000);
  await panel.evaluate("document.getElementById('sessionNew').click()");
  const ready = await waitFor(panel, "document.getElementById('input').disabled === false", 10000);
  await panel.evaluate("document.getElementById('sessionToggle').click()");
  return ready;
};

const waitConfirmCount = (panel, count) => waitFor(
  panel,
  `document.querySelectorAll('#messages .msg.agent [data-block="confirm"]').length === ${count}`,
  8000
);

const readConfirmCards = (panel) => panel.evaluate(`(() => {
  const nodes = [...document.querySelectorAll('#messages .msg.agent [data-block="confirm"]')];
  const text = (node, selector) => node.querySelector(selector)?.textContent ?? '';
  return nodes.map((node) => ({
    kind: node.dataset.confirmKind ?? '',
    id: node.dataset.confirmId ?? '',
    title: text(node, '.block-head h4'),
    badge: text(node, '.confirm-badge'),
    headline: text(node, '.confirm-headline'),
    conclusion: text(node, '.confirm-conclusion'),
    target: text(node, '.confirm-target dd'),
    sequence: text(node, '.confirm-sequence'),
    items: [...node.querySelectorAll('.confirm-item')].map((item) => ({
      label: item.querySelector('.confirm-item-label')?.textContent ?? '',
      path: item.querySelector('.confirm-item-path')?.textContent ?? ''
    })),
    notices: [...node.querySelectorAll('.confirm-notice')].map((item) => item.textContent),
    actions: [...node.querySelectorAll('[data-confirm-action]')].map((button) => ({
      id: button.dataset.confirmAction ?? '',
      index: button.dataset.confirmIndex ?? '',
      label: button.textContent
    })),
    answered: text(node, '.confirm-answered')
  }));
})()`);

const clickConfirm = (panel, cardIndex, action, itemIndex = null) => panel.evaluate(`(() => {
  const nodes = [...document.querySelectorAll('#messages .msg.agent [data-block="confirm"]')];
  const card = nodes[${cardIndex}];
  const index = ${itemIndex === null ? 'null' : Number(itemIndex)};
  const suffix = index === null ? '' : '[data-confirm-index="' + index + '"]';
  const button = card?.querySelector('[data-confirm-action="' + ${JSON.stringify(action)} + '"]' + suffix);
  if (!button || button.disabled) return false;
  button.click();
  return true;
})()`);

const lastReceipt = (panel) => panel.evaluate(`(() => {
  const nodes = [...document.querySelectorAll('#messages .msg.agent [data-block="kv"]')];
  const node = nodes[nodes.length - 1];
  if (!node) return null;
  const rows = {};
  [...node.querySelectorAll('.block-kv > div')].forEach((row) => {
    rows[row.querySelector('dt')?.textContent ?? ''] = row.querySelector('dd')?.textContent ?? '';
  });
  return { title: node.querySelector('.block-head h4')?.textContent ?? '', rows };
})()`);

/** 消息 / 确认卡 / 键值块的数量：取消动作前后比较，证明没有偷偷生成新东西。 */
const snapshot = (panel) => panel.evaluate(`(() => ({
  messages: document.querySelectorAll('#messages .msg').length,
  confirms: document.querySelectorAll('#messages .msg.agent [data-block="confirm"]').length,
  kv: document.querySelectorAll('#messages .msg.agent [data-block="kv"]').length
}))()`);

const scrollTo = (panel, selector, index = -1) => panel.evaluate(`(() => {
  const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const node = ${index < 0} ? nodes[nodes.length - 1] : nodes[${index}];
  node?.scrollIntoView({ block: 'center' });
  return Boolean(node);
})()`);

const shot = async (panel, file, selector, index = -1) => {
  await panel.send('Emulation.setDeviceMetricsOverride', {
    width: 440, height: 1000, deviceScaleFactor: 1, mobile: false
  });
  await sleep(300);
  await scrollTo(panel, selector, index);
  await sleep(300);
  await capture(panel, file);
  await panel.send('Emulation.clearDeviceMetricsOverride');
  await sleep(200);
};

const safeRemove = (target) => {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    console.warn(`[CONFIRM-#116] kept state: ${target}`);
  }
};

const runConfirm = async () => {
  fs.mkdirSync(tempBase, { recursive: true });
  fs.mkdirSync(shotsDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'confirm-116-'));
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
    check('the confirm-card module is mounted for the shell',
      await waitFor(panel, 'Boolean(window.OwnerConfirm?.isCommand && window.OwnerConfirmCards?.normalizeConfirmCard)'));
    check('a session exists before the confirmation card is sent', await ensureSession(panel));

    // ① 外发卡：发出即收不回，没有免问。
    await sendDraft(panel, '/外发');
    check('external card appears', await waitConfirmCount(panel, 1));
    let cards = await readConfirmCards(panel);
    const external = cards[0];
    check('external: kind / badge / headline', external?.kind === 'external'
      && external?.badge === '不可逆'
      && (external?.headline ?? '').includes('发出即收不回'),
    JSON.stringify({ kind: external?.kind, badge: external?.badge, headline: external?.headline }));
    check('external: every full path is listed separately',
      JSON.stringify(external?.items.map((item) => item.path)) === JSON.stringify(EXTERNAL_PATHS),
      JSON.stringify(external?.items));
    check('external: target is named', (external?.target ?? '').includes('飞书'),
      external?.target);
    check('external: exactly send-once + cancel, no exemption',
      JSON.stringify(external?.actions.map((action) => action.id)) === JSON.stringify(['send-once', 'cancel'])
      && JSON.stringify(external?.actions.map((action) => action.label)) === JSON.stringify(['发出这一次', '取消']),
      JSON.stringify(external?.actions));
    check('external: no "ask me later / never ask" affordance',
      !(external?.actions ?? []).some((action) => /免问|不用再问|以后/u.test(action.label)),
      JSON.stringify(external?.actions));
    check('external: notices say it cannot be recalled and is never exempt',
      (external?.notices ?? []).some((line) => line.includes('发出即收不回'))
      && (external?.notices ?? []).some((line) => line.includes('没有「以后不用问」')),
      JSON.stringify(external?.notices));
    await shot(panel, path.join(shotsDir, 'external-card.png'), '[data-block="confirm"]', 0);

    // 取消外发：只留「未发出」回执，不生成新卡。
    const beforeCancel = await snapshot(panel);
    check('external: cancel can be clicked', await clickConfirm(panel, 0, 'cancel'));
    check('external: card records the cancellation',
      await waitFor(panel,
        "document.querySelectorAll('#messages [data-block=\"confirm\"] .confirm-answered')[0]?.textContent.includes('取消')"));
    const afterCancel = await snapshot(panel);
    const cancelReceipt = await lastReceipt(panel);
    check('external cancel: receipt says nothing was sent',
      (cancelReceipt?.title ?? '').includes('外发回执')
      && (cancelReceipt?.rows?.结果 ?? '').includes('未发出'),
      JSON.stringify(cancelReceipt));
    check('external cancel: local state is explicitly unchanged',
      (cancelReceipt?.rows?.本地状态 ?? '').includes('未变'), JSON.stringify(cancelReceipt));
    check('external cancel: only the two messages were appended, no new card',
      afterCancel.messages === beforeCancel.messages + 2
      && afterCancel.confirms === beforeCancel.confirms
      && afterCancel.kv === beforeCancel.kv + 1,
      JSON.stringify({ beforeCancel, afterCancel }));

    // ② 删除卡：逐条列出，无批量。
    await sendDraft(panel, '/删除');
    check('delete card appears', await waitConfirmCount(panel, 2));
    cards = await readConfirmCards(panel);
    const remove = cards[1];
    check('delete: kind / badge / headline', remove?.kind === 'delete'
      && remove?.badge === '逐条确认'
      && (remove?.headline ?? '').includes('逐条'),
    JSON.stringify({ kind: remove?.kind, badge: remove?.badge, headline: remove?.headline }));
    check('delete: every object is listed with its full path',
      JSON.stringify(remove?.items.map((item) => item.path)) === JSON.stringify(DELETE_PATHS),
      JSON.stringify(remove?.items));
    check('delete: one button per item plus cancel, nothing else',
      JSON.stringify(remove?.actions.map((action) => action.id))
        === JSON.stringify(['delete-item', 'delete-item', 'delete-item', 'cancel'])
      && JSON.stringify(remove?.actions.filter((action) => action.id === 'delete-item')
        .map((action) => action.index)) === JSON.stringify(['0', '1', '2']),
      JSON.stringify(remove?.actions));
    check('delete: no bulk / all-in-one action exists',
      !(remove?.actions ?? []).some((action) => /全部|批量|所有/u.test(action.label))
      && (remove?.notices ?? []).some((line) => line.includes('没有批量放行')),
      JSON.stringify({ actions: remove?.actions, notices: remove?.notices }));
    await shot(panel, path.join(shotsDir, 'delete-card.png'), '[data-block="confirm"]', 1);

    // 删一项：回执含已删与剩余项，剩余项另起一张卡。
    check('delete: the first item can be deleted alone', await clickConfirm(panel, 1, 'delete-item', 0));
    check('delete: a receipt and a remaining-items card appear', await waitConfirmCount(panel, 3));
    const deleteReceipt = await lastReceipt(panel);
    check('delete receipt: says what was deleted',
      (deleteReceipt?.rows?.已删除 ?? '') === DELETE_PATHS[0], JSON.stringify(deleteReceipt));
    check('delete receipt: lists what remains',
      (deleteReceipt?.rows?.剩余 ?? '') === '2 项'
      && (deleteReceipt?.rows?.['剩余 1'] ?? '') === DELETE_PATHS[1]
      && (deleteReceipt?.rows?.['剩余 2'] ?? '') === DELETE_PATHS[2],
      JSON.stringify(deleteReceipt));
    cards = await readConfirmCards(panel);
    check('delete: remaining items get their own card, still per-item',
      JSON.stringify(cards[2]?.items.map((item) => item.path)) === JSON.stringify(DELETE_PATHS.slice(1))
      && cards[2]?.actions.filter((action) => action.id === 'delete-item').length === 2,
      JSON.stringify({ items: cards[2]?.items, actions: cards[2]?.actions }));
    await shot(panel, path.join(shotsDir, 'delete-receipt.png'), '[data-block="kv"]', -1);

    // 取消剩余项的删除：回执说未删除，剩余项原样。
    check('delete: remaining card can be cancelled', await clickConfirm(panel, 2, 'cancel'));
    check('delete cancel: the remaining card records the cancellation',
      await waitFor(panel,
        "document.querySelectorAll('#messages [data-block=\"confirm\"] .confirm-answered').length === 3"));
    const deleteCancelReceipt = await lastReceipt(panel);
    check('delete cancel: result + remaining items are explicit',
      (deleteCancelReceipt?.rows?.结果 ?? '').includes('未删除')
      && (deleteCancelReceipt?.rows?.剩余 ?? '') === '2 项'
      && (deleteCancelReceipt?.rows?.['剩余 2'] ?? '') === DELETE_PATHS[2],
      JSON.stringify(deleteCancelReceipt));

    // ③ 同一动作里的写入 + 外发：两张卡，先写后发。
    await sendDraft(panel, '/同步');
    const both = await waitFor(panel, `(() => {
      const msgs = [...document.querySelectorAll('#messages .msg.agent')];
      const last = msgs[msgs.length - 1];
      return last?.querySelectorAll('[data-block]').length === 2;
    })()`, 8000);
    check('split: the compound action produces two cards', both);
    const split = await panel.evaluate(`(() => {
      const msgs = [...document.querySelectorAll('#messages .msg.agent')];
      const last = msgs[msgs.length - 1];
      return {
        types: [...last.querySelectorAll('[data-block]')].map((node) => node.dataset.block),
        text: last.querySelector('.bubble')?.textContent ?? ''
      };
    })()`);
    check('split: write card comes first, external card second',
      JSON.stringify(split?.types) === JSON.stringify(['risk', 'confirm']),
      JSON.stringify(split));
    check('split: reply explains the fixed order and why',
      (split?.text ?? '').includes('拆成两次确认') && (split?.text ?? '').includes('先写')
      && (split?.text ?? '').includes('收不回'),
      split?.text);
    cards = await readConfirmCards(panel);
    const splitExternal = cards[cards.length - 1];
    check('split: external card is marked as the second of two confirmations',
      (splitExternal?.sequence ?? '').includes('第 2 次确认')
      && (splitExternal?.sequence ?? '').includes('先写后发'),
      splitExternal?.sequence);

    // ④ 窄宽度：确认卡不把整条流撑出横向滚动。
    await panel.send('Emulation.setDeviceMetricsOverride', {
      width: 380, height: 900, deviceScaleFactor: 1, mobile: false
    });
    await sleep(400);
    const narrow = await panel.evaluate(`(() => {
      const thread = document.getElementById('thread');
      const threadRect = thread.getBoundingClientRect();
      const cards = [...document.querySelectorAll('#messages [data-block="confirm"]')];
      return {
        threadScroll: thread.scrollWidth,
        threadClient: thread.clientWidth,
        outside: cards.filter((node) => {
          const rect = node.getBoundingClientRect();
          return rect.right > threadRect.right + 1 || rect.left < threadRect.left - 1;
        }).length,
        selfOverflow: cards.filter((node) => node.scrollWidth > node.clientWidth + 1).length
      };
    })()`);
    check('narrow: the thread does not scroll sideways',
      narrow.threadScroll <= narrow.threadClient + 1, JSON.stringify(narrow));
    check('narrow: every confirmation card stays inside the thread',
      narrow.outside === 0 && narrow.selfOverflow === 0, JSON.stringify(narrow));
    await panel.send('Emulation.clearDeviceMetricsOverride');
    await sleep(200);

    // 会话库：取消没有生成新卡，删除剩下的卡片也在。
    const stored = await panel.evaluate(`(async () => {
      const list = await window.companion.cardSessions.list({});
      const detail = await window.companion.cardSessions.get({ id: list.items[0].id });
      const blocks = detail.messages.flatMap((message) => message.blocks ?? []);
      return {
        confirms: blocks.filter((block) => block.type === 'confirm').length,
        kv: blocks.filter((block) => block.type === 'kv').map((block) => block.rows?.[1]?.[1] ?? '')
      };
    })()`);
    check('stored: cancelled external did not create a card',
      stored?.confirms === 4, JSON.stringify(stored));
    check('stored: cancellation receipts are persisted',
      (stored?.kv ?? []).some((text) => text.includes('未发出'))
      && (stored?.kv ?? []).some((text) => text.includes('未删除')),
      JSON.stringify(stored?.kv));

    const errors = consoleErrors(panel);
    check('console is clean', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await app.stop();
    // 成功就清临时 userData / 库，失败留现场；截图始终留在 shotsDir。
    if (failures.length === 0) safeRemove(root);
    else console.warn(`[CONFIRM-#116] kept state: ${root}`);
  }
};

const run = async () => {
  await runConfirm();
  if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
  console.log(`[CONFIRM-#116] screenshots: ${shotsDir}`);
  console.log('[CONFIRM-#116] PASS');
};

run().catch((error) => {
  console.error(`[CONFIRM-#116] FAIL: ${error.stack ?? error.message}`);
  if (failures.length > 0) console.error(`[CONFIRM-#116] screenshots kept: ${shotsDir}`);
  process.exitCode = 1;
});
