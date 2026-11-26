// #126 验收：`@@` →「分享到飞书」——目标只有飞书（其它平台置灰可见）、勾选两条、发送先出
// #116 外发确认、允许后回执（注入成功）；再注入失败 → 原因 + 可重试；取消 → 零发送、内容还在；
// webhook 未配置 → 明确提示与去哪儿配。
//
// 命中真实路径：离屏 Electron + CDP，加载卡片壳 shell.html。
// 投递一律注入假实现（window.OwnerShareDeliver），不读真网络、不碰本机 webhook。
// 截图：方法卡、外发确认、成功回执、失败回执、未配置提示。
import fs from 'node:fs';
import path from 'node:path';
import {
  capture, consoleErrors, createChecker, startApp, sleep, waitFor
} from './lib/cdp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const shotsDir = process.env.SHOTS_DIR
  ?? path.resolve(repoRoot, '..', '..', 'mm-notes', 'shots-126');
const tempBase = process.env.TMP_126 ?? path.resolve(shotsDir, '..', 'tmp-126');
const { check, failures } = createChecker('[AT-SHARE-#126]');

const QUESTION = '第一条：周五交付可以吗？';
const ENV = 'OWNER_OBSERVER_FEISHU_WEBHOOK';

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

/** 点流里的第 n 条消息：勾选态下点气泡正文即「选这条」。 */
const clickMessage = (panel, index) => panel.evaluate(`(() => {
  const item = document.querySelectorAll('#messages .msg')[${index}];
  if (!item) return false;
  item.click();
  return true;
})()`);

const createSession = async (panel) => {
  await click(panel, '#sessionToggle');
  await waitFor(panel, "document.getElementById('sessionPopover').hidden === false", 5000);
  await click(panel, '#sessionNew');
  return waitFor(panel, "document.getElementById('input').disabled === false", 8000);
};

const openShareMethod = async (panel) => {
  await typeInput(panel, '@@');
  await waitFor(panel, "document.getElementById('atPanel').hidden === false", 5000);
  await click(panel, '.at-method[data-at-method="share"]');
  return waitFor(panel, "document.querySelector('.at-share')", 5000);
};

const injectStatus = (panel, configured) => panel.evaluate(`(() => {
  window.OwnerShareStatusProvider = () => ({
    ok: true, configured: ${configured ? 'true' : 'false'}, env: ${JSON.stringify(ENV)}
  });
  return true;
})()`);

const injectDeliver = (panel, status, detail) => panel.evaluate(`(() => {
  window.__shareCalls = window.__shareCalls || [];
  window.OwnerShareDeliver = async (input) => {
    window.__shareCalls.push(input);
    return { status: ${JSON.stringify(status)}, detail: ${JSON.stringify(detail)} };
  };
  return true;
})()`);

const readCalls = (panel) => panel.evaluate('window.__shareCalls || []');

const readMethodCard = (panel) => panel.evaluate(`(() => ({
  hidden: document.getElementById('atPanel').hidden,
  title: document.getElementById('atTitle').textContent.trim(),
  targets: [...document.querySelectorAll('.at-share-target')].map((node) => ({
    key: node.dataset.shareTarget,
    label: node.textContent.trim(),
    disabled: node.disabled === true,
    pressed: node.getAttribute('aria-pressed') === 'true'
  })),
  count: document.querySelector('.at-share-count')?.textContent.trim() ?? '',
  sendDisabled: document.querySelector('.at-share-send')?.disabled === true,
  status: document.querySelector('.at-share-status')?.hidden
    ? ''
    : document.querySelector('.at-share-status')?.textContent.trim() ?? ''
}))()`);

const readThread = (panel) => panel.evaluate(`(() => ({
  count: document.querySelectorAll('#messages .msg').length,
  confirms: document.querySelectorAll('#messages [data-block="confirm"]').length,
  shares: [...document.querySelectorAll('#messages [data-block="share"]')].map((block) => ({
    status: block.dataset.shareStatus,
    text: block.textContent,
    retry: Boolean(block.querySelector('[data-share-retry]')),
    answered: block.querySelector('.share-answered')?.textContent.trim() ?? ''
  })),
  body: document.getElementById('messages').innerText
}))()`);

const readConfirm = (panel) => panel.evaluate(`(() => {
  const cards = document.querySelectorAll('#messages [data-block="confirm"]');
  const card = cards[cards.length - 1];
  if (!card) return null;
  return {
    id: card.dataset.confirmId,
    target: card.querySelector('.confirm-target dd')?.textContent.trim() ?? '',
    headline: card.querySelector('.confirm-headline')?.textContent.trim() ?? '',
    notices: [...card.querySelectorAll('.confirm-notice')].map((node) => node.textContent.trim()),
    items: [...card.querySelectorAll('.confirm-item-label')].map((node) => node.textContent.trim()),
    actions: [...card.querySelectorAll('[data-confirm-action]')].map((node) => ({
      id: node.dataset.confirmAction,
      label: node.textContent.trim()
    }))
  };
})()`);

const clickConfirm = (panel, action) => panel.evaluate(`(() => {
  const cards = document.querySelectorAll('#messages [data-block="confirm"]');
  const card = cards[cards.length - 1];
  if (!card) return false;
  const button = card.querySelector('[data-confirm-action="${action}"]');
  if (!button) return false;
  button.click();
  return true;
})()`);

const run = async () => {
  fs.mkdirSync(tempBase, { recursive: true });
  fs.mkdirSync(shotsDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'at-share-126-'));
  const userData = path.join(root, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  const app = await startApp({
    userData,
    ownerDb: path.join(root, 'owner.sqlite'),
    knowledgeDb: path.join(root, 'knowledge.sqlite'),
    env: {
      // 本机若配过 webhook 也不让 e2e 看见：真实投递一律走注入的假实现。
      OWNER_OBSERVER_FEISHU_WEBHOOK: ''
    },
    showPanel: true,
    page: 'shell.html'
  });
  const { panel } = app;
  try {
    check('card shell loads', await waitFor(panel, "document.querySelector('#shellHeader')", 30000));
    check('a session exists before opening @@', await createSession(panel));

    // ① 造两条原文：一次发送 = 我的一句 + 一条占位回复。
    await typeInput(panel, QUESTION);
    check('the question is sent', await pressEnter(panel));
    check('two messages land in the stream', await waitFor(panel,
      "document.querySelectorAll('#messages .msg').length === 2", 8000));

    // ② 菜单第四条：分享排在 session 之后。
    await typeInput(panel, '@@');
    check('the @@ menu opens', await waitFor(panel,
      "document.getElementById('atPanel').hidden === false", 5000));
    const menuKeys = await panel.evaluate(
      "[...document.querySelectorAll('#atBody .at-method')].map((row) => row.dataset.atMethod)"
    );
    check('the share method is the fourth menu row',
      JSON.stringify(menuKeys) === '["prompt","project","session","share"]', JSON.stringify(menuKeys));

    // ③ 方法卡：只有目标选择 + 发送；其它平台可见但置灰。
    check('the share method mounts its card', await openShareMethod(panel));
    let card = await readMethodCard(panel);
    check('the card is the share method', card.hidden === false && card.title === '分享到飞书', card.title);
    check('only feishu is selectable',
      card.targets.filter((target) => !target.disabled).map((target) => target.key).join(',') === 'feishu',
      JSON.stringify(card.targets));
    check('feishu is the pressed target', card.targets.find((target) => target.key === 'feishu')?.pressed === true);
    check('other platforms stay visible but greyed with 暂不支持',
      card.targets.filter((target) => target.disabled).length === 2
      && card.targets.filter((target) => target.disabled).every((target) => target.label.includes('暂不支持')),
      JSON.stringify(card.targets));
    check('nothing selected yet: count 0 and send disabled',
      card.count === '已选 0 条' && card.sendDisabled === true, `${card.count} / ${card.sendDisabled}`);

    // ④ 在流里勾两条：与 #123 同一份勾选态与计数。
    check('the first message is selected', await clickMessage(panel, 0));
    check('the second message is selected', await clickMessage(panel, 1));
    check('the count follows the stream selection', await waitFor(panel,
      "document.querySelector('.at-share-count')?.textContent.trim() === '已选 2 条'", 3000));
    card = await readMethodCard(panel);
    check('two selected: send becomes available', card.sendDisabled === false);
    await capture(panel, path.join(shotsDir, 'at-share-card.png'));

    // ⑤ 发送：先出 #116 外发确认，允许才真的调投递。
    await injectStatus(panel, true);
    await injectDeliver(panel, 'sent', 'feishu code 0');
    check('the send button is clicked', await click(panel, '.at-share-send'));
    check('an external confirm card appears before anything is sent', await waitFor(panel,
      "document.querySelectorAll('#messages [data-block=\"confirm\"]').length === 1", 8000));
    check('nothing was delivered before the confirm', (await readCalls(panel)).length === 0);
    let confirm = await readConfirm(panel);
    check('the confirm names feishu as the destination', confirm?.target === '飞书', confirm?.target);
    check('the confirm says the external send cannot be taken back',
      confirm?.headline === '发出即收不回', confirm?.headline);
    check('the confirm has no 以后不用问 action',
      confirm?.actions.every((action) => !action.label.includes('以后不用问'))
      && confirm?.notices.some((line) => line.includes('没有「以后不用问」')),
      JSON.stringify(confirm?.actions));
    check('the confirm lists both selected messages one by one',
      confirm?.items.length === 2 && confirm.items[0].includes('我的第 1 句'),
      JSON.stringify(confirm?.items));
    check('the method card closed after handing off to the confirm',
      (await readMethodCard(panel)).hidden === true);
    await capture(panel, path.join(shotsDir, 'at-share-confirm.png'));

    // ⑥ 允许 → 回执进流：会话名、条数、成功。
    check('send-once is clicked', await clickConfirm(panel, 'send-once'));
    check('a success receipt lands in the stream', await waitFor(panel,
      "document.querySelectorAll('#messages [data-block=\"share\"]').length === 1", 8000));
    let thread = await readThread(panel);
    check('the receipt is a success with a count',
      thread.shares[0]?.status === 'sent' && thread.shares[0]?.text.includes('2 条'),
      thread.shares[0]?.text);
    check('the receipt has no retry button after success', thread.shares[0]?.retry === false);
    const calls = await readCalls(panel);
    check('exactly one delivery happened', calls.length === 1, String(calls.length));
    check('the delivered text carries the 出处 lines',
      calls[0]?.text.includes('【分享自 Companion】')
      && calls[0]?.text.includes('- 项目：')
      && calls[0]?.text.includes('- 会话：'),
      calls[0]?.text.slice(0, 120));
    check('the delivered text carries the quoted原文',
      calls[0]?.text.includes(QUESTION) && calls[0]?.text.includes('> '),
      calls[0]?.text.slice(0, 200));
    await capture(panel, path.join(shotsDir, 'at-share-receipt-ok.png'));

    // ⑦ 失败：回执带原因、内容还在、给「重试」；重试仍要先过确认。
    check('the share method reopens for a second run', await openShareMethod(panel));
    check('the first message is selected again', await clickMessage(panel, 0));
    check('the second message is selected again', await clickMessage(panel, 1));
    await waitFor(panel, "document.querySelector('.at-share-count')?.textContent.trim() === '已选 2 条'", 3000);
    await injectDeliver(panel, 'failed', 'feishu http 500');
    check('send is clicked for the failing run', await click(panel, '.at-share-send'));
    check('a second confirm card appears', await waitFor(panel,
      "document.querySelectorAll('#messages [data-block=\"confirm\"]').length === 2", 8000));
    check('send-once is clicked for the failing run', await clickConfirm(panel, 'send-once'));
    check('a failed receipt lands in the stream', await waitFor(panel,
      "document.querySelectorAll('#messages [data-block=\"share\"][data-share-status=\"failed\"]').length === 1", 8000));
    thread = await readThread(panel);
    const failed = thread.shares.find((item) => item.status === 'failed');
    check('the failure names the reason', failed?.text.includes('feishu http 500'), failed?.text);
    check('the failure keeps the content and offers 重试', failed?.retry === true);
    check('the failure is not retried automatically', (await readCalls(panel)).length === 2,
      String((await readCalls(panel)).length));
    await capture(panel, path.join(shotsDir, 'at-share-receipt-failed.png'));

    // ⑧ 重试：内容还在；重试只再出一张外发确认，不直接发送。
    check('the retry button is clicked', await panel.evaluate(`(() => {
      const button = document.querySelector('#messages [data-block="share"][data-share-status="failed"] [data-share-retry]');
      if (!button) return false;
      button.click();
      return true;
    })()`));
    check('retry brings the same content back through a new confirm', await waitFor(panel,
      "document.querySelectorAll('#messages [data-block=\"confirm\"]').length === 3", 8000));
    check('retry alone delivers nothing', (await readCalls(panel)).length === 2);
    thread = await readThread(panel);
    check('the old receipt collapses to 已选择',
      thread.shares.find((item) => item.status === 'failed')?.retry === false
      && thread.shares.find((item) => item.status === 'failed')?.answered.includes('重试'),
      thread.shares.find((item) => item.status === 'failed')?.answered);

    // ⑨ 取消：零发送，回执说清「什么都没发、内容还在」。
    check('cancel is clicked on the retried confirm', await clickConfirm(panel, 'cancel'));
    check('a cancelled receipt lands in the stream', await waitFor(panel,
      "document.querySelectorAll('#messages [data-block=\"share\"][data-share-status=\"cancelled\"]').length === 1", 8000));
    thread = await readThread(panel);
    const cancelled = thread.shares.find((item) => item.status === 'cancelled');
    check('cancel sends nothing', (await readCalls(panel)).length === 2);
    check('the cancel receipt says nothing was sent and the content stayed',
      thread.body.includes('什么都没发') && thread.body.includes('还留着'),
      thread.body.split('\n').find((line) => line.includes('取消')) ?? '');
    check('the cancel receipt can retry the same draft', cancelled?.retry === true);

    // ⑩ 未配置 webhook：明确提示与去哪儿配，不出确认卡、不发送，选择保留。
    check('the share method reopens for the unconfigured run', await openShareMethod(panel));
    check('the first message is selected for the unconfigured run', await clickMessage(panel, 0));
    check('the second message is selected for the unconfigured run', await clickMessage(panel, 1));
    await injectStatus(panel, false);
    const confirmsBefore = (await readThread(panel)).confirms;
    check('send is clicked without a configured webhook', await click(panel, '.at-share-send'));
    check('the card explains 未配置 and where to configure', await waitFor(panel,
      `document.querySelector('.at-share-status')?.textContent.includes('未配置')`, 5000));
    card = await readMethodCard(panel);
    check('the hint names the environment variable',
      card.status.includes(ENV) && card.status.includes('feishu.json'), card.status);
    check('no confirm card is created when the webhook is missing',
      (await readThread(panel)).confirms === confirmsBefore, String(confirmsBefore));
    check('nothing is sent when the webhook is missing', (await readCalls(panel)).length === 2);
    check('the selection is kept after the 未配置 hint', card.count === '已选 2 条', card.count);
    await capture(panel, path.join(shotsDir, 'at-share-unconfigured.png'));

    const errors = consoleErrors(panel);
    check('console is clean', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await app.stop();
    if (failures.length === 0) {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      } catch { /* 失败留现场，成功删不掉也不影响结论 */ }
    } else {
      console.warn(`[AT-SHARE-#126] kept state: ${root}`);
    }
  }
  if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
  console.log(`[AT-SHARE-#126] screenshots: ${shotsDir}`);
  console.log('[AT-SHARE-#126] PASS');
};

run().catch((error) => {
  console.error(`[AT-SHARE-#126] FAIL: ${error.stack ?? error.message}`);
  if (failures.length > 0) console.error(`[AT-SHARE-#126] screenshots kept: ${shotsDir}`);
  process.exitCode = 1;
});
