// #131 验收：断网时读写照常，顶栏明确标「未同步」，联网后手动补同步。
//
// 走真实窗口（离屏 Electron + CDP），不 mock DOM：
//   ① 首启没有状态文件 → 顶栏是「未同步 / 从未成功同步过」，不是绿色；
//   ② 注入一次成功 → 补同步后变「已同步」（绿色），记下最后成功时间；
//   ③ 注入一次断网失败 → 顶栏回到「未同步」（橙色，不是绿色），保留上次成功时间与失败原因；
//   ④ 未同步期间在界面上新建会话并发言 → 消息照常落库（本地读写不被阻塞）；
//   ⑤ 再注入成功 → 补同步后恢复「已同步」，失败原因清掉、成功时间前进；
//   ⑥ 重启（同一 userData）→ 状态与最后成功时间仍在（证明时间与原因存在盘上）。
// 截图：01-unsynced.png（断网未同步）、02-recovered.png（恢复已同步）。
//
// 注入通道只在 OWNER_AGENT_SYNC_FAKE=1 时存在（见 desktop/main.cjs 的 runSyncAttempt）：
// 读 <userData>/sync-fake.json 的 result，验收脚本在两次点击之间改写这个文件。
import fs from 'node:fs';
import path from 'node:path';
import {
  capture, consoleErrors, createChecker, sleep, startApp, waitFor
} from './lib/cdp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const shotsDir = process.env.SHOTS_DIR
  ?? path.resolve(repoRoot, '..', '..', 'mm-notes', 'shots-131');
const tempBase = process.env.TMP_131 ?? path.resolve(shotsDir, '..', 'tmp-131');
const { check, failures } = createChecker('[SYNC-OFFLINE-#131]');

const GREEN = ['rgb(31, 122, 77)', 'rgb(91, 189, 139)'];

const makeRoot = () => {
  fs.mkdirSync(tempBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'sync-offline-'));
  const userData = path.join(root, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  return {
    root,
    userData,
    ownerDb: path.join(root, 'owner.sqlite'),
    knowledgeDb: path.join(root, 'knowledge.sqlite')
  };
};

const safeRemove = (target) => {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    console.warn(`[SYNC-OFFLINE-#131] kept state: ${target}`);
  }
};

/** 写假结果：只改 result，不改状态文件——状态必须由主进程按执行器结果推导并落盘。 */
const fakeResult = (userData, result) => {
  fs.writeFileSync(path.join(userData, 'sync-fake.json'), JSON.stringify({ result }, null, 2), 'utf8');
};

const SUCCESS = {
  status: 'ok',
  step: 'done',
  text: '同步完成：拉取 1 篇，推送 1 篇。'
};
const OFFLINE = {
  status: 'error',
  step: 'pull',
  code: 'pull-failed',
  message: 'network unreachable：注入的断网失败'
};

/** 顶栏同步这一格当前画了什么（含真实计算出来的颜色）。 */
const readSyncEntry = (panel) => panel.evaluate(`(() => {
  const entry = document.getElementById('syncEntry');
  const state = document.getElementById('syncState');
  const detail = document.getElementById('syncDetail');
  const retry = document.getElementById('syncRetry');
  const row = document.getElementById('syncRow');
  const style = state ? getComputedStyle(state) : null;
  return {
    exists: Boolean(entry && state && retry && detail),
    entryState: entry?.dataset.state ?? '',
    label: state?.textContent?.trim() ?? '',
    detail: detail?.textContent?.trim() ?? '',
    tone: state?.dataset.tone ?? '',
    state: state?.dataset.state ?? '',
    color: style?.color ?? '',
    retryHidden: retry ? retry.hidden : true,
    retryText: retry?.textContent?.trim() ?? '',
    retryDisabled: retry ? retry.disabled : true,
    hint: row?.getAttribute('title') ?? entry?.getAttribute('title') ?? ''
  };
})()`);

const click = (panel, selector) => panel.evaluate(`(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) return false;
  node.click();
  return true;
})()`);

/** 顶栏是否被挤爆：内容宽度不能超过顶栏自身宽度，否则右侧状态位会被裁掉。 */
const readHeaderLayout = (panel) => panel.evaluate(`(() => {
  const header = document.getElementById('shellHeader');
  const rect = (node) => {
    const box = node.getBoundingClientRect();
    return {
      left: Math.round(box.left),
      right: Math.round(box.right),
      top: Math.round(box.top),
      bottom: Math.round(box.bottom),
      width: Math.round(box.width),
      height: Math.round(box.height)
    };
  };
  return {
    width: Math.round(header.getBoundingClientRect().width),
    scrollWidth: header.scrollWidth,
    children: [...header.children].map((node) => ({
      id: node.id,
      slot: node.dataset?.slot ?? '',
      text: node.textContent.trim().slice(0, 18),
      ...rect(node)
    }))
  };
})()`);

const shot = async (panel, file) => capture(panel, path.join(shotsDir, file));

const waitState = (panel, state, timeoutMs = 15000) =>
  waitFor(panel, `document.getElementById('syncEntry')?.dataset.state === ${JSON.stringify(state)}`, timeoutMs);

/** 读当前唯一会话的消息（证明未同步期间的写入真的落库了）。 */
const readStoredMessages = (panel) => panel.evaluate(`(async () => {
  const list = await window.companion.cardSessions.list({});
  const session = (list.items ?? [])[0];
  if (!session) return { id: '', messages: [] };
  const detail = await window.companion.cardSessions.get({ id: session.id });
  return {
    id: session.id,
    messages: (detail.messages ?? []).map((message) => ({ role: message.role, text: message.text }))
  };
})()`);

const startShell = (root) => startApp({
  userData: root.userData,
  ownerDb: root.ownerDb,
  knowledgeDb: root.knowledgeDb,
  env: { OWNER_AGENT_SYNC_FAKE: '1' },
  showPanel: true,
  page: 'shell.html'
});

const runScenario = async (probe) => {
  const root = makeRoot();
  const statusFile = path.join(root.userData, 'sync-status.json');
  probe.statusFile = statusFile;

  // 首次启动前没有任何同步记录。
  probe.statusFileBefore = fs.existsSync(statusFile);

  let app = await startShell(root);
  let { panel } = app;
  try {
    await waitFor(panel, "document.querySelector('#shellHeader') && window.OwnerSyncStatus", 30000);
    await waitFor(panel, "document.getElementById('syncEntry')?.dataset.state === 'unknown'", 15000);
    await sleep(300);

    // ① 从未成功同步：写「未同步」，用灰色而不是绿色；补同步入口可见。
    const initial = await readSyncEntry(panel);
    probe.initial = initial;
    check('首启没有状态文件（状态只能由一次同步结果产生）', probe.statusFileBefore === false);
    check('从未成功同步时顶栏写「未同步」', initial.exists && initial.label === '未同步', initial.label);
    check('从未成功同步时不是绿色', initial.tone === 'unknown' && !GREEN.includes(initial.color),
      `tone=${initial.tone} color=${initial.color}`);
    check('从未成功同步时给补同步入口', initial.retryHidden === false && initial.retryText === '补同步',
      `hidden=${initial.retryHidden} text=${initial.retryText}`);
    check('说明行直接写「从未成功同步过」（不靠悬停）', initial.detail.includes('从未成功同步过'),
      initial.detail);
    check('提示里说清「从未成功同步过」', initial.hint.includes('从未成功同步过'), initial.hint);

    // 顶栏一行五个位置 + 单独一行同步：同步行不能盖住第一行，也不能横向溢出。
    const layout = await readHeaderLayout(panel);
    probe.headerLayout = layout;
    check('顶栏没有横向溢出（同步行不挤掉其它状态位）', layout.scrollWidth <= layout.width + 1,
      `${layout.scrollWidth} > ${layout.width}: ${JSON.stringify(layout.children)}`);
    const topRow = layout.children.find((node) => node.id === 'topRow');
    const syncRow = layout.children.find((node) => node.id === 'syncRow');
    check('同步行在五个状态位下面单独一行', Boolean(topRow && syncRow) && syncRow.top >= topRow.bottom,
      `topRow.bottom=${topRow?.bottom} syncRow.top=${syncRow?.top}`);

    // ② 注入成功：补同步后变「已同步」（绿色），并记下时间。
    fakeResult(root.userData, SUCCESS);
    await click(panel, '#syncRetry');
    check('注入成功后补同步变成已同步', await waitState(panel, 'synced'));
    await waitFor(panel, "!document.getElementById('syncRetry').disabled", 10000);
    const synced = await readSyncEntry(panel);
    probe.syncedFirst = synced;
    check('已同步时标签是「已同步」', synced.label === '已同步', synced.label);
    check('已同步时用绿色（ok）', synced.tone === 'ok' && GREEN.includes(synced.color),
      `tone=${synced.tone} color=${synced.color}`);
    check('已同步时收起补同步入口', synced.retryHidden === true, `hidden=${synced.retryHidden}`);
    check('已同步时说明行显示最后成功时间', /最后同步 20\d\d-\d\d-\d\d \d\d:\d\d UTC/u.test(synced.detail),
      synced.detail);
    const firstSuccessHint = synced.detail;
    const firstSuccessIso = JSON.parse(fs.readFileSync(statusFile, 'utf8')).lastSuccessAt;
    probe.firstSuccessIso = firstSuccessIso;

    // ③ 注入断网失败：回到「未同步」，橙色，不是绿色；保留上次成功时间与原因。
    fakeResult(root.userData, OFFLINE);
    await click(panel, '#syncRetry');
    check('注入断网失败后回到未同步', await waitState(panel, 'unsynced'));
    await waitFor(panel, "!document.getElementById('syncRetry').disabled", 10000);
    const offline = await readSyncEntry(panel);
    probe.offline = offline;
    check('断网时标签是「未同步」，不写成已同步', offline.label === '未同步', offline.label);
    check('断网时不是绿色', offline.tone === 'warn' && !GREEN.includes(offline.color),
      `tone=${offline.tone} color=${offline.color}`);
    check('断网时补同步入口仍在', offline.retryHidden === false && offline.retryText === '补同步',
      `hidden=${offline.retryHidden} text=${offline.retryText}`);
    check('断网时说明行保留最后成功时间', /最后同步 20\d\d-\d\d-\d\d \d\d:\d\d UTC/u.test(offline.detail),
      offline.detail);
    check('断网时说明行给出失败原因', /network unreachable/u.test(offline.detail), offline.detail);
    check('断网时说明行先写最后成功时间（不会被截掉）', offline.detail.startsWith('最后同步 '),
      offline.detail);
    check('断网时的最后成功时间与恢复前同一条', offline.detail.includes(
      (firstSuccessHint.match(/最后同步 [^；·]+/u) ?? [''])[0]
    ), `${firstSuccessHint} vs ${offline.detail}`);
    await shot(panel, '01-unsynced.png');

    // ④ 未同步期间本地写入照常：新建会话 + 发一条，界面上出现、库里也读得到。
    await click(panel, '#sessionNew');
    await waitFor(panel, "document.querySelectorAll('#sessionList .session-row').length >= 1", 10000);
    const typed = '断网时也要能写：本地先落库';
    await panel.evaluate(`(() => {
      const input = document.getElementById('input');
      input.focus();
      input.value = ${JSON.stringify(typed)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(150);
    await click(panel, '#send');
    const appeared = await waitFor(panel, `[...document.querySelectorAll('#messages .msg')]
      .some((item) => (item.textContent || '').includes(${JSON.stringify(typed)}))`, 10000);
    check('未同步期间界面照常出现本地消息', appeared);
    const stored = await readStoredMessages(panel);
    probe.localWrite = stored;
    check('未同步期间消息真的落库（不是只画在屏幕上）',
      stored.messages.some((message) => message.role === 'user' && message.text === typed),
      JSON.stringify(stored.messages));
    const stillOffline = await readSyncEntry(panel);
    probe.afterLocalWrite = stillOffline;
    check('本地写入没有把状态改回已同步', stillOffline.entryState === 'unsynced', stillOffline.entryState);

    // ⑤ 恢复联网：补同步后回到已同步，原因清掉、成功时间前进。
    fakeResult(root.userData, { ...SUCCESS, text: '同步完成：拉取 2 篇，推送 1 篇。' });
    await click(panel, '#syncRetry');
    check('恢复后补同步回到已同步', await waitState(panel, 'synced'));
    await waitFor(panel, "!document.getElementById('syncRetry').disabled", 10000);
    await sleep(300);
    const recovered = await readSyncEntry(panel);
    probe.recovered = recovered;
    check('恢复后标签回到「已同步」', recovered.label === '已同步', recovered.label);
    check('恢复后重新是绿色', recovered.tone === 'ok' && GREEN.includes(recovered.color),
      `tone=${recovered.tone} color=${recovered.color}`);
    check('恢复后说明行不再显示失败原因', !/network unreachable/u.test(recovered.detail), recovered.detail);
    check('恢复后说明行仍有最后成功时间', /最后同步 20\d\d-\d\d-\d\d \d\d:\d\d UTC/u.test(recovered.detail),
      recovered.detail);
    const recoveredFile = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    probe.recoveredFile = recoveredFile;
    check('恢复后最后同步时间真的前进（不是只换了文案）',
      Date.parse(recoveredFile.lastSuccessAt) > Date.parse(firstSuccessIso),
      `${firstSuccessIso} → ${recoveredFile.lastSuccessAt}`);
    check('状态文件已写盘', fs.existsSync(statusFile));
    await shot(panel, '02-recovered.png');

    const beforeRestartHint = recovered.detail;
    const beforeRestartFile = JSON.parse(fs.readFileSync(statusFile, 'utf8'));

    // ⑥ 重启：状态与时间必须还在（读的是盘，不是内存）。
    await app.stop();
    app = await startShell(root);
    panel = app.panel;
    await waitFor(panel, "document.querySelector('#shellHeader') && window.OwnerSyncStatus", 30000);
    check('重启后仍是已同步', await waitState(panel, 'synced', 20000));
    await sleep(300);
    const afterRestart = await readSyncEntry(panel);
    probe.afterRestart = afterRestart;
    check('重启后标签仍是「已同步」', afterRestart.label === '已同步', afterRestart.label);
    check('重启后最后同步时间与重启前一致', afterRestart.detail === beforeRestartHint,
      `${beforeRestartHint} vs ${afterRestart.detail}`);
    check('状态文件里记的是同一次成功时间',
      beforeRestartFile.lastSuccessAt && beforeRestartFile.lastSuccessAt ===
        JSON.parse(fs.readFileSync(statusFile, 'utf8')).lastSuccessAt,
      `${beforeRestartFile.lastSuccessAt} vs ${afterRestart.detail}`);

    const errors = consoleErrors(panel);
    probe.consoleErrors = errors;
    check('控制台无错误', errors.length === 0, errors.join(' | ').slice(0, 300));
  } finally {
    await app.stop();
  }
  probe.rootRemoved = root.root;
  safeRemove(root.root);
};

const run = async () => {
  fs.mkdirSync(shotsDir, { recursive: true });
  const probe = { shotsDir, tempBase };
  await runScenario(probe);
  fs.writeFileSync(path.join(shotsDir, 'sync-offline-probe.json'), JSON.stringify(probe, null, 2));
  if (failures.length) throw new Error(`${failures.length} assertion(s) failed`);
  console.log('[SYNC-OFFLINE-#131] PASS');
};

run().catch((error) => {
  console.error(`[SYNC-OFFLINE-#131] FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
