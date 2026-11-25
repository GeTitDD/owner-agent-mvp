// #113 验收：写入风险确认卡（等级 / 三轴 / 逐条路径 / 可折叠判据 / 四个动作 / 改判）。
//
// 路径：卡片壳（#105）→ 输入 /risk high|low（脚本化，不连模型、不执行真实写入）。
// 断言四层：
//   ① 高风险卡：标题、等级徽章、结论、三轴、两条完整路径、四个动作都在，
//      「低风险免问」在高风险卡上是禁用；
//   ② 判据默认收起，点开后才展开，且含「为什么不是别的等级」；
//   ③ 低风险卡：四个动作都在，「低风险免问」这次可点；
//   ④ 改判：点「我的判断不同」→ 填等级与理由 → 生成新卡；原卡收起动作并留下记录，
//      新卡保留原判据、并列追加人工记录，且两条消息都进了会话库。
// 截图：高风险卡（判据展开）/ 低风险卡 / 改判后的新卡，写到 SHOTS_DIR
// （缺省 mm-notes/shots-113）。纯函数规则在 tests/risk-card.test.mjs。
import fs from 'node:fs';
import path from 'node:path';
import { capture, consoleErrors, createChecker, sleep, startApp, waitFor } from './lib/cdp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const shotsDir = process.env.SHOTS_DIR
  ?? path.resolve(repoRoot, '..', '..', 'mm-notes', 'shots-113');
const tempBase = process.env.TMP_113 ?? path.resolve(shotsDir, '..', 'tmp-113');
const { check, failures } = createChecker('[RISK-#113]');

const EXPECTED_ACTIONS = ['允许这一次', '低风险免问', '我的判断不同', '取消'];
const HIGH_PATHS = [
  'D:\\work\\integration\\docs\\adr\\0014-export-policy.md',
  'D:\\work\\integration\\docs\\adr\\0013-write-by-destination.md'
];

/** 往输入框里打字并派发 input 事件（等价于用户敲字，不触发发送）。 */
const typeDraft = (panel, text) => panel.evaluate(`(() => {
  const input = document.getElementById('input');
  input.focus();
  input.value = ${JSON.stringify(text)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input.value;
})()`);

/** 派发一次 Enter，返回「默认行为有没有被拦下」。 */
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

/** 与 desktop-blocks 相同：先有一个会话才能发消息；走界面上的那一个入口。 */
const ensureSession = async (panel) => {
  await panel.evaluate("document.getElementById('sessionToggle').click()");
  await waitFor(panel, "document.getElementById('sessionPopover').hidden === false", 5000);
  await panel.evaluate("document.getElementById('sessionNew').click()");
  const ready = await waitFor(panel, "document.getElementById('input').disabled === false", 10000);
  await panel.evaluate("document.getElementById('sessionToggle').click()");
  return ready;
};

/** 逐张读出确认卡的可断言结构；只读文本与结构，不读实现。 */
const readRiskCards = (panel) => panel.evaluate(`(() => {
  const nodes = [...document.querySelectorAll('#messages .msg.agent [data-block="risk"]')];
  const text = (node, selector) => node.querySelector(selector)?.textContent ?? '';
  return nodes.map((node) => ({
    id: node.dataset.riskId ?? '',
    level: node.dataset.riskLevel ?? '',
    overridden: node.dataset.riskOverridden === 'true',
    title: text(node, '.block-head h4'),
    badge: text(node, '.risk-badge'),
    change: text(node, '.risk-change'),
    conclusion: text(node, '.risk-conclusion'),
    degraded: text(node, '.risk-degraded'),
    escalated: text(node, '.risk-escalated'),
    axes: [...node.querySelectorAll('.risk-axis')].map((row) => ({
      key: row.dataset.axis ?? '',
      label: row.querySelector('dt')?.textContent ?? '',
      value: row.querySelector('dd')?.textContent ?? ''
    })),
    paths: [...node.querySelectorAll('.risk-path')].map((item) => item.dataset.path ?? item.textContent),
    actions: [...node.querySelectorAll('[data-risk-action]')].map((button) => ({
      id: button.dataset.riskAction ?? '',
      label: button.textContent,
      disabled: button.disabled === true
    })),
    basisCount: Number((text(node, '.risk-basis-count') || '0').replace(/\\D+/gu, '')) || 0,
    basisOpen: Boolean(node.querySelector('details.risk-basis')?.open),
    basis: [...node.querySelectorAll('.risk-basis-list li')].map((item) => item.textContent),
    answered: text(node, '.risk-answered'),
    overrideFormHidden: node.querySelector('[data-risk-override-form]')?.hidden === true
  }));
})()`);

/** 等第几块确认卡出现（消息 append 是异步的）。 */
const waitCardCount = (panel, count) => waitFor(
  panel,
  `document.querySelectorAll('#messages .msg.agent [data-block="risk"]').length === ${count}`,
  8000
);

const scrollToRisk = (panel, index = 0) => panel.evaluate(`(() => {
  const nodes = [...document.querySelectorAll('#messages .msg.agent [data-block="risk"]')];
  const node = nodes[${index}];
  node?.scrollIntoView({ block: 'center' });
  return Boolean(node);
})()`);

const clickRiskAction = (panel, index, action) => panel.evaluate(`(() => {
  const nodes = [...document.querySelectorAll('#messages .msg.agent [data-block="risk"]')];
  const button = nodes[${index}]?.querySelector('[data-risk-action="${action}"]');
  if (!button || button.disabled) return false;
  button.click();
  return true;
})()`);

const openBasis = (panel, index) => panel.evaluate(`(() => {
  const nodes = [...document.querySelectorAll('#messages .msg.agent [data-block="risk"]')];
  const details = nodes[${index}]?.querySelector('details.risk-basis');
  if (!details) return false;
  details.querySelector('summary')?.click();
  return details.open;
})()`);

/** 在指定卡上填改判表单并提交；返回是否点到了提交按钮。 */
const submitOverride = (panel, index, level, note) => panel.evaluate(`(() => {
  const nodes = [...document.querySelectorAll('#messages .msg.agent [data-block="risk"]')];
  const card = nodes[${index}];
  const select = card?.querySelector('[data-risk-override-level]');
  const field = card?.querySelector('[data-risk-override-note]');
  const submit = card?.querySelector('[data-risk-override-submit]');
  if (!select || !field || !submit) return false;
  select.value = ${JSON.stringify(level)};
  field.value = ${JSON.stringify(note)};
  field.dispatchEvent(new Event('input', { bubbles: true }));
  submit.click();
  return true;
})()`);

const safeRemove = (target) => {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    console.warn(`[RISK-#113] kept state: ${target}`);
  }
};

const shotRisk = async (panel, file, index) => {
  await panel.send('Emulation.setDeviceMetricsOverride', {
    width: 440, height: 1000, deviceScaleFactor: 1, mobile: false
  });
  await sleep(300);
  await scrollToRisk(panel, index);
  await sleep(300);
  await capture(panel, file);
  await panel.send('Emulation.clearDeviceMetricsOverride');
  await sleep(200);
};

const runRisk = async () => {
  fs.mkdirSync(tempBase, { recursive: true });
  fs.mkdirSync(shotsDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'risk-113-'));
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
    check('shell page loads through the main-process switch',
      await waitFor(panel, "document.querySelector('#shellHeader')", 30000));
    check('the risk module is readable by the shell',
      await waitFor(panel, 'Boolean(window.OwnerRiskCard?.normalizeRisk)'));
    check('a session exists before the confirmation card is sent', await ensureSession(panel));

    // ① 高风险卡。
    await sendDraft(panel, '/risk high');
    check('high card appears', await waitCardCount(panel, 1));
    let cards = await readRiskCards(panel);
    const high = cards[0];
    check('high: level + badge', high?.level === 'high' && high?.badge === '高风险',
      JSON.stringify({ level: high?.level, badge: high?.badge }));
    check('high: title and one-sentence conclusion are present',
      (high?.title ?? '').includes('删除') && (high?.conclusion ?? '').length > 10,
      JSON.stringify({ title: high?.title, conclusion: high?.conclusion }));
    check('high: three axes in fixed order/labels',
      JSON.stringify(high?.axes) === JSON.stringify([
        { key: 'impact', label: '影响面', value: '项目级' },
        { key: 'reversibility', label: '可逆性', value: '不可逆' },
        { key: 'leavesMachine', label: '是否离开本机', value: '否' }
      ]),
      JSON.stringify(high?.axes));
    check('high: every full path is listed separately',
      JSON.stringify(high?.paths) === JSON.stringify(HIGH_PATHS),
      JSON.stringify(high?.paths));
    check('high: exactly the four actions in order',
      JSON.stringify(high?.actions.map((action) => action.label)) === JSON.stringify(EXPECTED_ACTIONS),
      JSON.stringify(high?.actions.map((action) => action.label)));
    check('high: low-risk exemption is disabled',
      high?.actions.find((action) => action.id === 'defer-low')?.disabled === true,
      JSON.stringify(high?.actions.find((action) => action.id === 'defer-low')));
    check('high: criteria start collapsed', high?.basisOpen === false && high?.basisCount >= 4,
      JSON.stringify({ open: high?.basisOpen, count: high?.basisCount }));

    // ② 判据可展开，且含「为什么不是别的等级」。
    check('high: criteria can be expanded', await openBasis(panel, 0));
    check('high: expanded criteria are visible',
      await waitFor(panel,
        "document.querySelector('#messages [data-block=\"risk\"] details.risk-basis')?.open === true"));
    cards = await readRiskCards(panel);
    check('high: criteria include at least four lines and the why-not-other-levels sentence',
      cards[0]?.basis.length >= 4
      && cards[0]?.basis.some((line) => line.includes('为什么不是别的等级')),
      JSON.stringify(cards[0]?.basis));
    await shotRisk(panel, path.join(shotsDir, 'risk-high.png'), 0);

    // ③ 低风险卡。
    await sendDraft(panel, '/risk low');
    check('low card appears', await waitCardCount(panel, 2));
    cards = await readRiskCards(panel);
    const low = cards[1];
    check('low: level + badge', low?.level === 'low' && low?.badge === '低风险',
      JSON.stringify({ level: low?.level, badge: low?.badge }));
    check('low: three axes', JSON.stringify(low?.axes.map((axis) => axis.value))
      === JSON.stringify(['本机级', '可逆', '否']), JSON.stringify(low?.axes));
    check('low: exactly the four actions in order',
      JSON.stringify(low?.actions.map((action) => action.label)) === JSON.stringify(EXPECTED_ACTIONS),
      JSON.stringify(low?.actions.map((action) => action.label)));
    check('low: low-risk exemption is enabled',
      low?.actions.find((action) => action.id === 'defer-low')?.disabled === false,
      JSON.stringify(low?.actions.find((action) => action.id === 'defer-low')));
    await shotRisk(panel, path.join(shotsDir, 'risk-low.png'), 1);

    // ④ 改判：高风险卡 → 人工改为低风险，生成新卡。
    check('high: "my judgment differs" can be clicked', await clickRiskAction(panel, 0, 'override'));
    check('high: the override form opens',
      await waitFor(panel,
        "document.querySelector('#messages [data-block=\"risk\"] [data-risk-override-form]')?.hidden === false"));
    const note = '我看过了：只是两份旧 ADR，先留着。';
    check('high: override form submits', await submitOverride(panel, 0, 'low', note));
    check('override produces a new card', await waitCardCount(panel, 3));
    cards = await readRiskCards(panel);
    const original = cards[0];
    const overridden = cards[2];
    check('original card keeps its record and drops its buttons',
      (original?.answered ?? '').includes('我的判断不同：低风险')
      && original?.actions.length === 0,
      JSON.stringify({ answered: original?.answered, actions: original?.actions.length }));
    check('new card is marked as a human override at low risk',
      overridden?.overridden === true
      && overridden?.level === 'low'
      && overridden?.badge === '低风险'
      && (overridden?.change ?? '') === '人工改判',
      JSON.stringify({ level: overridden?.level, overridden: overridden?.overridden }));
    check('new card keeps the original criteria and appends the human record',
      (overridden?.basis ?? []).some((line) => line.includes('删掉的内容没有回收站'))
      && (overridden?.basis ?? []).some((line) => line.includes('人工改判 1'))
      && (overridden?.basis ?? []).some((line) => line.includes(note)),
      JSON.stringify(overridden?.basis));
    check('new card still has the four actions',
      JSON.stringify(overridden?.actions.map((action) => action.label))
        === JSON.stringify(EXPECTED_ACTIONS),
      JSON.stringify(overridden?.actions.map((action) => action.label)));
    await openBasis(panel, 2);
    await shotRisk(panel, path.join(shotsDir, 'risk-overridden.png'), 2);

    // 改判进了会话库：两条消息都在，新卡的块带 overridden 标记。
    const stored = await panel.evaluate(`(async () => {
      const list = await window.companion.cardSessions.list({});
      const detail = await window.companion.cardSessions.get({ id: list.items[0].id });
      return {
        count: detail.messages.length,
        users: detail.messages.filter((message) => message.role === 'user').map((message) => message.text),
        riskBlocks: detail.messages.flatMap((message) => (message.blocks ?? [])
          .filter((block) => block.type === 'risk')
          .map((block) => ({
            level: block.level,
            overridden: block.overridden === true,
            overrides: (block.overrides ?? []).length
          })))
      };
    })()`);
    check('the override user message is persisted in the session',
      (stored?.users ?? []).some((text) => text.startsWith('我的判断不同：改为低风险')),
      JSON.stringify(stored?.users));
    check('the new confirmation card is persisted with the human record',
      stored?.riskBlocks.length === 3
      && stored?.riskBlocks[2]?.overridden === true
      && stored?.riskBlocks[2]?.overrides === 1,
      JSON.stringify(stored?.riskBlocks));

    // 窄宽度（面板最窄 380px）：确认卡不能把整条流撑出横向滚动。
    await panel.send('Emulation.setDeviceMetricsOverride', {
      width: 380, height: 900, deviceScaleFactor: 1, mobile: false
    });
    await sleep(400);
    const narrow = await panel.evaluate(`(() => {
      const thread = document.getElementById('thread');
      const threadRect = thread.getBoundingClientRect();
      const cards = [...document.querySelectorAll('#messages [data-block="risk"]')];
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

    const errors = consoleErrors(panel);
    check('console is clean', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await app.stop();
    // 成功就清临时 userData / 库，失败留现场；截图始终留在 shotsDir。
    if (failures.length === 0) safeRemove(root);
    else console.warn(`[RISK-#113] kept state: ${root}`);
  }
};

const run = async () => {
  await runRisk();
  if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
  console.log(`[RISK-#113] screenshots: ${shotsDir}`);
  console.log('[RISK-#113] PASS');
};

run().catch((error) => {
  console.error(`[RISK-#113] FAIL: ${error.stack ?? error.message}`);
  if (failures.length > 0) console.error(`[RISK-#113] screenshots kept: ${shotsDir}`);
  process.exitCode = 1;
});
