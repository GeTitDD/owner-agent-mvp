// #109 验收：生成式 UI 块（十三种）长在现有对话流里。
//
// 路径：卡片壳（#105）→ 输入 /blocks（脚本化、不连模型）→ 回复带「文字 + 块」。
// 断言四层：
//   ① 十三种块按清单顺序出现，每种块的关键结构（表格行数、图表 svg 与点数、
//      代码行号、提问选项数、时间线步骤、键值行数…）都对得上；
//   ② 提问块三个出口：选项、自由回答、跳过，各自产生「我的 + 脚本化回复」两条，
//      回答过的块收起按钮，重新渲染也不会再冒出来；
//   ③ 窄宽度（380px）整条对话流没有横向溢出，块的左右边都在流内；
//   ④ 控制台无错误。
// 纯函数规则在 tests/shell-blocks.test.mjs；这里只断言界面上看得见的东西。
// 截图：块全览 / 提问块 / 窄宽度，写到 SHOTS_DIR（缺省 mm-notes/shots-109）。
import fs from 'node:fs';
import path from 'node:path';
import { capture, consoleErrors, createChecker, sleep, startApp, waitFor } from './lib/cdp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const shotsDir = process.env.SHOTS_DIR
  ?? path.resolve(repoRoot, '..', '..', 'mm-notes', 'shots-109');
const tempBase = process.env.TMP_109 ?? path.resolve(shotsDir, '..', 'tmp-109');
const { check, failures } = createChecker('[BLOCKS-#109]');

// 与 desktop/shell-blocks.cjs 的 BLOCK_TYPES 同序；e2e 自己写死一份，
// 免得「样本漏了一种块」被同一份清单一起掩盖过去。
const EXPECTED_TYPES = [
  'card', 'table', 'kpi', 'line', 'donut', 'timeline',
  'kv', 'code', 'diff', 'tool', 'badges', 'ask', 'review'
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

/**
 * #106 起「没有会话就不能发消息」：块样本也要先有一个会话。
 * 走界面上的那一个入口（顶栏胶囊 → 新建），不直接调 IPC。
 */
const ensureSession = async (panel) => {
  await panel.evaluate("document.getElementById('sessionToggle').click()");
  await waitFor(panel, "document.getElementById('sessionPopover').hidden === false", 5000);
  await panel.evaluate("document.getElementById('sessionNew').click()");
  const ready = await waitFor(panel, "document.getElementById('input').disabled === false", 10000);
  await panel.evaluate("document.getElementById('sessionToggle').click()");
  return ready;
};

/** 流里每条消息：角色、文字、块数（有没有气泡、块挂在哪都看这里）。 */
const readThread = (panel) => panel.evaluate(`(() => {
  const items = [...document.querySelectorAll('#messages .msg')];
  return items.map((item) => ({
    role: item.dataset.role,
    index: Number(item.dataset.index),
    text: item.querySelector('.bubble')?.textContent ?? '',
    bubbles: item.querySelectorAll('.bubble').length,
    blocks: item.querySelectorAll('[data-block]').length
  }));
})()`);

/** 逐块读出可断言的结构。只读文本与结构，不读实现。 */
const readBlocks = (panel) => panel.evaluate(`(() => {
  const nodes = [...document.querySelectorAll('#messages .msg.agent [data-block]')];
  const text = (node, selector) => node.querySelector(selector)?.textContent ?? '';
  return nodes.map((node) => ({
    type: node.dataset.block,
    index: Number(node.dataset.blockIndex),
    text: node.textContent,
    title: text(node, '.block-head h4'),
    sections: node.querySelectorAll('.block-section').length,
    sectionItems: node.querySelectorAll('.block-row').length,
    heads: node.querySelectorAll('table.block-table thead th').length,
    rows: node.querySelectorAll('table.block-table tbody tr').length,
    kpis: node.querySelectorAll('.kpi').length,
    kpisUp: node.querySelectorAll('.kpi-delta.up').length,
    kpisDown: node.querySelectorAll('.kpi-delta.down').length,
    charts: node.querySelectorAll('svg').length,
    points: (node.querySelector('svg polyline')?.getAttribute('points') ?? '').trim().split(/\\s+/u).filter(Boolean).length,
    circles: node.querySelectorAll('svg circle').length,
    legend: node.querySelectorAll('.donut-legend li').length,
    steps: node.querySelectorAll('.block-timeline .step').length,
    stepTones: [...node.querySelectorAll('.block-timeline .step')].map((step) => step.className),
    kvRows: node.querySelectorAll('.block-kv > div').length,
    codeLines: node.querySelectorAll('.block-code .cl').length,
    codeNumbers: [...node.querySelectorAll('.block-code .ln')].map((line) => line.textContent),
    diffAdd: node.querySelectorAll('.d-row.add').length,
    diffDel: node.querySelectorAll('.d-row.del').length,
    toolSummary: text(node, 'details summary'),
    toolOutput: text(node, 'details pre'),
    tags: node.querySelectorAll('.block-badges .tag').length,
    askOptions: [...node.querySelectorAll('[data-ask-choice]')].map((button) => button.textContent),
    askSkip: Boolean(node.querySelector('[data-ask-skip]')),
    askFree: Boolean(node.querySelector('[data-ask-free]')),
    askAnswered: text(node, '.ask-answered')
  }));
})()`);

const clickFirst = (panel, selector) => panel.evaluate(`(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) return false;
  node.click();
  return true;
})()`);

const scrollToBlock = (panel, blockType) => panel.evaluate(`(() => {
  const node = document.querySelector(${JSON.stringify(`#messages [data-block="${blockType}"]`)});
  node?.scrollIntoView({ block: 'center' });
  return Boolean(node);
})()`);

/** 窄宽度断言：流本身不横向滚动，每个块的左右边都在流里。 */
const readNarrowLayout = (panel) => panel.evaluate(`(() => {
  const thread = document.getElementById('thread');
  const threadRect = thread.getBoundingClientRect();
  const blocks = [...document.querySelectorAll('#messages .block')];
  const outside = blocks
    .filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.right > threadRect.right + 1 || rect.left < threadRect.left - 1;
    })
    .map((node) => node.dataset.block);
  const selfOverflow = blocks
    .filter((node) => node.scrollWidth > node.clientWidth + 1)
    .map((node) => node.dataset.block);
  // 宽表格是唯一预期的块内横向滚动：它能滚，但只在自己框里滚。
  const table = document.querySelector('.block-table-wrap');
  return {
    viewport: window.innerWidth,
    threadScroll: thread.scrollWidth,
    threadClient: thread.clientWidth,
    outside,
    selfOverflow,
    tableScroll: table?.scrollWidth ?? 0,
    tableClient: table?.clientWidth ?? 0,
    tableOverflow: table ? getComputedStyle(table).overflowX : ''
  };
})()`);

const safeRemove = (target) => {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    console.warn(`[BLOCKS-#109] kept state: ${target}`);
  }
};

/** 把视口临时拉高，让「块全览」一张图能装下；截完恢复。 */
const shotTall = async (panel, file, height) => {
  await panel.send('Emulation.setDeviceMetricsOverride', {
    width: 440, height, deviceScaleFactor: 1, mobile: false
  });
  await sleep(400);
  await panel.evaluate("document.getElementById('thread').scrollTop = 0");
  await capture(panel, file);
  await panel.send('Emulation.clearDeviceMetricsOverride');
  await sleep(200);
};

const runBlocks = async () => {
  fs.mkdirSync(tempBase, { recursive: true });
  fs.mkdirSync(shotsDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'blocks-109-'));
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
    check('a session exists before the block sample is sent', await ensureSession(panel));

    // ① 一条带全部块的回复。
    await sendDraft(panel, '/blocks');
    await waitFor(panel, "document.querySelectorAll('#messages .msg').length === 2", 5000);
    const thread = await readThread(panel);
    check('/blocks appends my message and one reply', thread.length === 2,
      JSON.stringify(thread.map((item) => item.role)));
    check('my message is the command I typed', thread[0]?.text === '/blocks', thread[0]?.text);
    check('the reply says it is a scripted sample', (thread[1]?.text ?? '').includes('脚本化样本'),
      thread[1]?.text);
    check('the reply carries thirteen blocks', thread[1]?.blocks === 13, String(thread[1]?.blocks));

    const blocks = await readBlocks(panel);
    check('block order matches the thirteen-type list',
      JSON.stringify(blocks.map((block) => block.type)) === JSON.stringify(EXPECTED_TYPES),
      JSON.stringify(blocks.map((block) => block.type)));

    const byType = Object.fromEntries(blocks.map((block) => [block.type, block]));

    check('card: title + three sections + one empty group',
      byType.card?.title === '项目库概览' && byType.card?.sections === 3
      && byType.card?.sectionItems === 2
      && (byType.card?.text ?? '').includes('这一组还没有条目。'),
      JSON.stringify({ title: byType.card?.title, sections: byType.card?.sections }));

    check('table: three headings and three rows',
      byType.table?.heads === 3 && byType.table?.rows === 3,
      JSON.stringify({ heads: byType.table?.heads, rows: byType.table?.rows }));
    check('table: the commit cell is visible text',
      (byType.table?.text ?? '').includes('7ccbe10'), byType.table?.text?.slice(0, 40));

    check('kpi: four metrics, two up and one down',
      byType.kpi?.kpis === 4 && byType.kpi?.kpisUp === 2 && byType.kpi?.kpisDown === 1,
      JSON.stringify({ kpis: byType.kpi?.kpis, up: byType.kpi?.kpisUp, down: byType.kpi?.kpisDown }));

    check('line: one svg, seven points, seven dots',
      byType.line?.charts === 1 && byType.line?.points === 7 && byType.line?.circles === 7,
      JSON.stringify({ charts: byType.line?.charts, points: byType.line?.points }));
    check('line: the last value is spelled out',
      (byType.line?.text ?? '').includes('末值 33s'), byType.line?.text?.slice(-30));

    check('donut: three arcs and a three-row legend',
      byType.donut?.circles === 3 && byType.donut?.legend === 3,
      JSON.stringify({ arcs: byType.donut?.circles, legend: byType.donut?.legend }));

    check('timeline: three steps with tones',
      byType.timeline?.steps === 3
      && byType.timeline?.stepTones.some((name) => name.includes('pending')),
      JSON.stringify(byType.timeline?.stepTones));

    check('kv: four rows', byType.kv?.kvRows === 4, String(byType.kv?.kvRows));

    check('code: five lines numbered 1..5',
      byType.code?.codeLines === 5
      && JSON.stringify(byType.code?.codeNumbers) === JSON.stringify(['1', '2', '3', '4', '5']),
      JSON.stringify(byType.code?.codeNumbers));

    check('diff: three added and one removed line',
      byType.diff?.diffAdd === 3 && byType.diff?.diffDel === 1,
      JSON.stringify({ add: byType.diff?.diffAdd, del: byType.diff?.diffDel }));

    check('tool: name in the summary, output below it',
      (byType.tool?.toolSummary ?? '').includes('knowledge.search')
      && (byType.tool?.toolOutput ?? '').includes('Retry loop bound'),
      JSON.stringify({ summary: byType.tool?.toolSummary, output: byType.tool?.toolOutput }));

    check('badges: thirteen status tags', byType.badges?.tags === 13,
      String(byType.badges?.tags));

    check('ask: question, why, tried, three options, free answer and skip',
      (byType.ask?.title ?? '').includes('这条经验要归到哪个项目')
      && (byType.ask?.text ?? '').includes('已经试过：')
      && byType.ask?.askOptions.length === 3
      && byType.ask?.askFree === true
      && byType.ask?.askSkip === true,
      JSON.stringify({
        title: byType.ask?.title,
        options: byType.ask?.askOptions,
        free: byType.ask?.askFree,
        skip: byType.ask?.askSkip
      }));

    // 截图①②：块全览（视口临时拉高）与提问块。
    await shotTall(panel, path.join(shotsDir, 'blocks-overview.png'), 2800);
    await panel.send('Emulation.setDeviceMetricsOverride', {
      width: 440, height: 900, deviceScaleFactor: 1, mobile: false
    });
    check('ask block is reachable for its screenshot', await scrollToBlock(panel, 'ask'));
    await sleep(300);
    await capture(panel, path.join(shotsDir, 'blocks-ask.png'));
    await panel.send('Emulation.clearDeviceMetricsOverride');
    await sleep(200);

    // ② 提问块的三个出口。
    check('clicking an option is possible',
      await clickFirst(panel, '[data-block="ask"] [data-ask-choice]'));
    await waitFor(panel, "document.querySelectorAll('#messages .msg').length === 4", 5000);
    const afterOption = await readThread(panel);
    check('option click appends my choice and one reply',
      afterOption.length === 4
      && afterOption[2].role === 'user'
      && afterOption[2].text === '选择：Companion Demo'
      && afterOption[3].role === 'agent'
      && afterOption[3].text.includes('脚本化响应'),
      JSON.stringify(afterOption.slice(2).map((item) => ({ role: item.role, text: item.text.slice(0, 24) }))));

    const answered = await readBlocks(panel);
    check('the answered ask keeps the record and drops its buttons',
      answered[11]?.askAnswered.includes('Companion Demo')
      && answered[11]?.askOptions.length === 0
      && answered[11]?.askFree === false,
      JSON.stringify({ answered: answered[11]?.askAnswered, options: answered[11]?.askOptions }));

    // 再来一份样本，走自由回答。
    await sendDraft(panel, '/blocks');
    await waitFor(panel, "document.querySelectorAll('#messages .msg').length === 6", 5000);
    const free = '一个全新的项目';
    await panel.evaluate(`(() => {
      const input = document.querySelector('[data-ask-free]');
      input.value = ${JSON.stringify(free)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.value;
    })()`);
    check('free answer submits', await clickFirst(panel, '[data-ask-free-submit]'));
    await waitFor(panel, "document.querySelectorAll('#messages .msg').length === 8", 5000);
    const afterFree = await readThread(panel);
    check('free answer becomes my message and gets a scripted reply',
      afterFree[6]?.role === 'user'
      && afterFree[6]?.text === free
      && afterFree[7]?.role === 'agent'
      && afterFree[7]?.text.includes(free),
      JSON.stringify(afterFree.slice(6).map((item) => ({ role: item.role, text: item.text.slice(0, 30) }))));

    // 第三份样本，走跳过。
    await sendDraft(panel, '/blocks');
    await waitFor(panel, "document.querySelectorAll('#messages .msg').length === 10", 5000);
    check('skip is clickable', await clickFirst(panel, '[data-ask-skip]'));
    await waitFor(panel, "document.querySelectorAll('#messages .msg').length === 12", 5000);
    const afterSkip = await readThread(panel);
    check('skip appends my skip and a reply marked as inference',
      afterSkip[10]?.text === '跳过，按你的判断来'
      && afterSkip[11]?.text.includes('推断'),
      JSON.stringify(afterSkip.slice(10).map((item) => ({ role: item.role, text: item.text.slice(0, 30) }))));

    // ③ 窄宽度：380px（面板最窄）。
    await panel.send('Emulation.setDeviceMetricsOverride', {
      width: 380, height: 900, deviceScaleFactor: 1, mobile: false
    });
    await panel.evaluate("document.getElementById('thread').scrollTop = 0");
    await sleep(400);
    const narrow = await readNarrowLayout(panel);
    check('narrow: 380px viewport', narrow.viewport === 380, String(narrow.viewport));
    check('narrow: the thread does not scroll sideways',
      narrow.threadScroll <= narrow.threadClient + 1,
      JSON.stringify({ scroll: narrow.threadScroll, client: narrow.threadClient }));
    check('narrow: every block stays inside the thread',
      narrow.outside.length === 0, JSON.stringify(narrow.outside));
    check('narrow: no block overflows itself',
      narrow.selfOverflow.length === 0, JSON.stringify(narrow.selfOverflow));
    // 长内容在块内滚动：表格自带横向滚动容器，滚的是它自己，不是整条流。
    check('narrow: a wide table scrolls inside its own box, not the flow',
      narrow.tableOverflow === 'auto' && narrow.tableScroll >= narrow.tableClient,
      JSON.stringify({
        overflowX: narrow.tableOverflow,
        scroll: narrow.tableScroll,
        client: narrow.tableClient
      }));
    await capture(panel, path.join(shotsDir, 'blocks-narrow.png'));
    await panel.send('Emulation.clearDeviceMetricsOverride');
    await sleep(200);

    // 默认宽度下同样不该横向溢出。
    const wide = await readNarrowLayout(panel);
    check('default width: the thread does not scroll sideways',
      wide.threadScroll <= wide.threadClient + 1,
      JSON.stringify({ scroll: wide.threadScroll, client: wide.threadClient }));

    const errors = consoleErrors(panel);
    check('console is clean', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await app.stop();
    // 成功就清临时 userData / 库，失败留现场；截图始终留在 shotsDir。
    if (failures.length === 0) safeRemove(root);
    else console.warn(`[BLOCKS-#109] kept state: ${root}`);
  }
};

const run = async () => {
  await runBlocks();
  if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
  console.log(`[BLOCKS-#109] screenshots: ${shotsDir}`);
  console.log('[BLOCKS-#109] PASS');
};

run().catch((error) => {
  console.error(`[BLOCKS-#109] FAIL: ${error.stack ?? error.message}`);
  if (failures.length > 0) console.error(`[BLOCKS-#109] screenshots kept: ${shotsDir}`);
  process.exitCode = 1;
});
