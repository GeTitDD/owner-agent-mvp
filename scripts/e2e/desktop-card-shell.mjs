// #106 验收：会话成为对话流的唯一容器（顶栏胶囊那一格）。
//
// 面板层没有单测先例，这里用离屏 Electron + CDP 走真实路径：起两次实例，中间不换目录，
// 所以「重启后会话、置顶、当前选择都还在」不是在内存里自证，而是真的重开一遍。
//   第一次：空态 → 新建三条会话并各发一句 → 置顶 → 搜索（有结果 / 无匹配）→ 切会话
//           → 重命名 → 删除确认（先取消、再删掉一条非当前）→ 收工；
//   第二次（同一 userData + 同一 owner 库）：列表/置顶/当前选择/消息都在 → 删掉当前会话
//           落到第一条 → 全删后空态且输入框锁死 → 从「已删除」找回一条并继续发。
// 截图：会话列表、搜索无结果、空态（首启与删光各一张）、归档。
// 纯函数与存储层在 tests/card-sessions.test.mjs；这里只断言界面上看得见的东西。
import fs from 'node:fs';
import path from 'node:path';
import {
  capture, consoleErrors, createChecker, startApp, waitFor
} from './lib/cdp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const shotsDir = process.env.SHOTS_DIR
  ?? path.resolve(repoRoot, '..', '..', 'mm-notes', 'shots-106');
const tempBase = process.env.TMP_106 ?? path.resolve(shotsDir, '..', 'tmp-106');
const { check, failures } = createChecker('[CARD-SHELL-#106]');

const SLOTS = ['session', 'project', 'write'];

/** 顶栏：两个入口 + 一个写范围状态位；监控与导出改由 /监控 与 /发布 承担。 */
const readHeader = (panel) => panel.evaluate(`(() => {
  const capsule = document.getElementById('sessionToggle');
  const popover = document.getElementById('sessionPopover');
  return {
    slots: [...document.querySelectorAll('#shellHeader [data-slot]')].map((node) => node.dataset.slot),
    placeholders: [...document.querySelectorAll('#shellHeader .slot .slot-value')]
      .map((node) => node.textContent.trim()),
    capsules: document.querySelectorAll('#shellHeader .capsule').length,
    windowControls: document.querySelectorAll('#shellHeader .win-btn').length,
    otherControls: document.querySelectorAll(
      '#shellHeader > button, #shellHeader > input, #shellHeader > select, #shellHeader > a'
    ).length,
    label: document.getElementById('sessionLabel').textContent.trim(),
    expanded: capsule.getAttribute('aria-expanded'),
    popoverHidden: popover.hidden
  };
})()`);

/** 浮动列表里每一行的可断言形状。 */
const readSessions = (panel) => panel.evaluate(`(() => {
  const hint = document.getElementById('sessionListHint');
  return {
    hint: hint.hidden ? '' : hint.textContent.trim(),
    hintKind: hint.dataset.kind ?? '',
    archive: document.getElementById('sessionArchive').textContent.trim(),
    rows: [...document.querySelectorAll('#sessionList .session-row')].map((row) => ({
      id: row.dataset.id,
      title: (row.querySelector('.session-title') ?? row.querySelector('.session-name'))?.textContent.trim() ?? '',
      pinned: row.dataset.pinned === 'true',
      current: row.dataset.current === 'true',
      archived: row.classList.contains('is-archived'),
      confirming: row.classList.contains('is-confirming'),
      pinBadge: Boolean(row.querySelector('.pin-mark')),
      actions: [...row.querySelectorAll('button[data-act]')].map((button) => button.dataset.act)
    }))
  };
})()`);

/** 对话流 + 输入框：条数、正文、空态文案、是否锁死。 */
const readThread = (panel) => panel.evaluate(`(() => {
  const items = [...document.querySelectorAll('#messages .msg')];
  const empty = document.getElementById('emptyState');
  const input = document.getElementById('input');
  return {
    count: items.length,
    emptyText: empty.hidden ? '' : empty.textContent.trim(),
    texts: items.map((item) => item.querySelector('.bubble')?.textContent ?? ''),
    roles: items.map((item) => item.dataset.role),
    placeholders: items.map((item) => item.dataset.placeholder === 'true'),
    inputDisabled: input.disabled,
    sendDisabled: document.getElementById('send').disabled,
    draft: input.value
  };
})()`);

const click = (panel, selector) => panel.evaluate(`(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) return false;
  node.click();
  return true;
})()`);

const rowAction = (panel, id, act) => click(panel, `.session-row[data-id="${id}"] button[data-act="${act}"]`);

/** 打开/收起会话浮层；opened=true 时等到它真的展开。 */
const setPopover = async (panel, opened) => {
  const header = await readHeader(panel);
  if (header.popoverHidden === opened) await click(panel, '#sessionToggle');
  return waitFor(panel, `document.getElementById('sessionPopover').hidden === ${!opened}`, 5000);
};

/** 往搜索框里打字并派发 input（等价于用户输入，不触发别的动作）。 */
const setSearch = (panel, text) => panel.evaluate(`(() => {
  const node = document.getElementById('sessionSearch');
  node.focus();
  node.value = ${JSON.stringify(text)};
  node.dispatchEvent(new Event('input', { bubbles: true }));
  return node.value;
})()`);

/** 往输入框里打字并派发 input 事件（等价于用户敲字，不触发发送）。 */
const typeDraft = (panel, text) => panel.evaluate(`(() => {
  const input = document.getElementById('input');
  input.focus();
  input.value = ${JSON.stringify(text)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input.value;
})()`);

/** 派发一次 Enter，返回「默认行为有没有被拦下」（拦下=当成发送）。 */
const pressEnter = (panel) => panel.evaluate(`(() => {
  const input = document.getElementById('input');
  input.focus();
  const event = new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', bubbles: true, cancelable: true
  });
  input.dispatchEvent(event);
  return event.defaultPrevented;
})()`);

/** 新建会话并等它出现在列表里，返回新行 id。 */
const createSession = async (panel) => {
  const before = (await readSessions(panel)).rows.map((row) => row.id);
  await click(panel, '#sessionNew');
  const ok = await waitFor(
    panel,
    `document.querySelectorAll('#sessionList .session-row').length === ${before.length + 1}`,
    8000
  );
  if (!ok) return '';
  const rows = (await readSessions(panel)).rows;
  return rows.find((row) => !before.includes(row.id))?.id ?? '';
};

/** 发一句：先打字再回车，等流里多出「我问的一条 + 占位回复」。 */
const sendLine = async (panel, text, expectedCount) => {
  await typeDraft(panel, text);
  await pressEnter(panel);
  return waitFor(panel, `document.querySelectorAll('#messages .msg').length === ${expectedCount}`, 8000);
};

/** 两步删除：先点删除，等确认行，再点确认。 */
const deleteSession = async (panel, id) => {
  await rowAction(panel, id, 'delete');
  const asked = await waitFor(
    panel,
    `Boolean(document.querySelector('.session-row[data-id="${id}"].is-confirming'))`,
    5000
  );
  if (!asked) return false;
  await rowAction(panel, id, 'confirm-delete');
  return waitFor(panel, `!document.querySelector('.session-row[data-id="${id}"]')`, 8000);
};

const safeRemove = (target) => {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    console.warn(`[CARD-SHELL-#106] kept state: ${target}`);
  }
};

/** 第一次：空态 → 建会话 → 置顶 → 搜索 → 切换 → 重命名 → 删除确认。 */
const firstRun = async ({ userData, ownerDb, knowledgeDb }) => {
  const app = await startApp({
    userData,
    ownerDb,
    knowledgeDb,
    showPanel: true,
    page: 'shell.html'
  });
  const { panel } = app;
  const seen = { pinnedId: '', currentId: '', pinnedTitle: '', currentTitle: '' };
  try {
    check('shell page loads through the main-process switch',
      await waitFor(panel, "document.querySelector('#shellHeader')", 30000));

    const header = await readHeader(panel);
    check('top bar keeps two entries and the write-scope slot',
      JSON.stringify(header.slots) === JSON.stringify(SLOTS), JSON.stringify(header.slots));
    check('only the session and project slots are entries',
      header.capsules === 2 && header.otherControls === 0,
      `capsules=${header.capsules} others=${header.otherControls}`);
    check('the frameless window has a single hide button, not a quit button',
      header.windowControls === 1, `windowControls=${header.windowControls}`);
    // 监控与导出不再占位：它们分别由 `/监控` 与 `/发布` 承担；
    // 状态行里只有写范围这一行文字（由 card-scope 给出「只读·全局」）。
    check('the write-scope slot keeps its label',
      JSON.stringify(header.placeholders) === JSON.stringify(['只读·全局']),
      JSON.stringify(header.placeholders));
    check('the capsule says there is no session yet', header.label === '还没有会话', header.label);

    // ① 首启空态：没有会话时不许发消息。
    const firstThread = await readThread(panel);
    check('empty state explains there is no session', firstThread.emptyText.includes('还没有会话'),
      firstThread.emptyText);
    check('composer is locked while there is no session',
      firstThread.inputDisabled === true && firstThread.sendDisabled === true,
      JSON.stringify({ input: firstThread.inputDisabled, send: firstThread.sendDisabled }));
    await capture(panel, path.join(shotsDir, 'sessions-empty.png'));

    // ② 新建三条会话，各发一句：会话是对话流的唯一容器。
    await setPopover(panel, true);
    const first = await createSession(panel);
    check('new session appears in the list and becomes current', Boolean(first));
    const afterCreate = await readThread(panel);
    check('composer unlocks once a session exists', afterCreate.inputDisabled === false);
    check('a fresh session starts with an empty thread hint',
      afterCreate.count === 0 && afterCreate.emptyText.includes('还没有消息'), afterCreate.emptyText);

    await setPopover(panel, false);
    check('a line goes into the current session', await sendLine(panel, '第一条会话的问题', 2));
    const firstThreadAfter = await readThread(panel);
    check('the reply is still the placeholder', firstThreadAfter.placeholders[1] === true);
    check('the session auto-titles itself from the first question',
      firstThreadAfter.count === 2);

    await setPopover(panel, true);
    const second = await createSession(panel);
    await setPopover(panel, false);
    await sendLine(panel, '第二条会话的问题', 2);

    await setPopover(panel, true);
    const third = await createSession(panel);
    await setPopover(panel, false);
    await sendLine(panel, '第三条会话的问题', 2);

    // ③ 重命名：Enter 保存。
    await setPopover(panel, true);
    const renameInput = await panel.evaluate(`(() => {
      const node = document.querySelector('.session-row[data-id="${third}"] .session-rename');
      return Boolean(node);
    })()`);
    check('rename does not open by itself', renameInput === false);
    await rowAction(panel, third, 'rename');
    await waitFor(panel, `Boolean(document.querySelector('.session-row[data-id="${third}"] .session-rename'))`, 5000);
    await panel.evaluate(`(() => {
      const node = document.querySelector('.session-row[data-id="${third}"] .session-rename');
      node.value = '第三条：手工改名';
      node.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', bubbles: true, cancelable: true
      }));
    })()`);
    await waitFor(panel, `!document.querySelector('.session-row[data-id="${third}"] .session-rename')`, 8000);
    let rows = (await readSessions(panel)).rows;
    check('rename saves the new title',
      rows.find((row) => row.id === third)?.title === '第三条：手工改名',
      rows.find((row) => row.id === third)?.title);

    // 失焦也保存。
    await rowAction(panel, second, 'rename');
    await waitFor(panel, `Boolean(document.querySelector('.session-row[data-id="${second}"] .session-rename'))`, 5000);
    const focusInfo = await panel.evaluate(`(() => {
      const node = document.querySelector('.session-row[data-id="${second}"] .session-rename');
      return {
        active: document.activeElement?.className ?? '',
        isInput: node === document.activeElement,
        hasFocus: document.hasFocus()
      };
    })()`);
    check('rename box takes focus so blur can save', focusInfo.isInput === true, JSON.stringify(focusInfo));
    await panel.evaluate(`(() => {
      const node = document.querySelector('.session-row[data-id="${second}"] .session-rename');
      node.value = '第二条：失焦改名';
      // 窗口是离屏的，focus/blur 的默认派发会被浏览器跳过，这里按用户移开焦点时
      // 浏览器会派发的那个事件直接派发一次：验的是「失焦这条路径会不会保存」。
      node.dispatchEvent(new FocusEvent('blur'));
    })()`);
    await waitFor(panel, `!document.querySelector('.session-row[data-id="${second}"] .session-rename')`, 8000);
    rows = (await readSessions(panel)).rows;
    check('blurring the rename box also saves',
      rows.find((row) => row.id === second)?.title === '第二条：失焦改名',
      rows.find((row) => row.id === second)?.title);

    // 空标题视为取消：名字不变，也不报错。
    await rowAction(panel, second, 'rename');
    await waitFor(panel, `Boolean(document.querySelector('.session-row[data-id="${second}"] .session-rename'))`, 5000);
    await panel.evaluate(`(() => {
      const node = document.querySelector('.session-row[data-id="${second}"] .session-rename');
      node.value = '   ';
      node.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', bubbles: true, cancelable: true
      }));
    })()`);
    await waitFor(panel, `!document.querySelector('.session-row[data-id="${second}"] .session-rename')`, 8000);
    rows = (await readSessions(panel)).rows;
    check('an empty title cancels the rename',
      rows.find((row) => row.id === second)?.title === '第二条：失焦改名',
      rows.find((row) => row.id === second)?.title);

    // ④ 置顶：置顶项排到最前并带标记。
    await rowAction(panel, first, 'pin');
    await waitFor(panel, `document.querySelector('.session-row')?.dataset.id === "${first}"`, 8000);
    rows = (await readSessions(panel)).rows;
    check('pinned session moves to the top', rows[0]?.id === first, rows.map((row) => row.id).join(','));
    check('pinned session is marked', rows[0]?.pinned === true && rows[0]?.pinBadge === true,
      JSON.stringify({ pinned: rows[0]?.pinned, badge: rows[0]?.pinBadge }));
    check('the pinned row still shows its own title',
      (rows[0]?.title ?? '') === '第一条会话的问题', rows[0]?.title);
    seen.pinnedId = first;
    seen.currentId = third;
    seen.pinnedTitle = rows[0].title;
    await capture(panel, path.join(shotsDir, 'sessions-list.png'));

    // ⑤ 搜索：按标题过滤；无匹配给明确空态。
    await setSearch(panel, '第二条');
    await waitFor(panel, "document.querySelectorAll('#sessionList .session-row').length === 1", 5000);
    const filtered = await readSessions(panel);
    check('search keeps only the matching title',
      filtered.rows.length === 1 && filtered.rows[0].id === second,
      filtered.rows.map((row) => row.id).join(','));
    await setSearch(panel, '没有这个会话');
    await waitFor(panel, "document.querySelector('#sessionListHint').hidden === false", 5000);
    const noMatch = await readSessions(panel);
    check('search with no match shows an explicit empty hint',
      noMatch.rows.length === 0
      && noMatch.hint.includes('没有匹配')
      && noMatch.hint.includes('没有这个会话'),
      noMatch.hint);
    await capture(panel, path.join(shotsDir, 'sessions-search-empty.png'));
    await setSearch(panel, '');
    await waitFor(panel, "document.querySelectorAll('#sessionList .session-row').length === 3", 5000);

    // ⑥ 切换会话：流内容跟着切。
    await click(panel, `.session-row[data-id="${first}"] button[data-act="switch"]`);
    await waitFor(panel, `document.getElementById('sessionLabel').textContent.trim() === ${JSON.stringify(seen.pinnedTitle)}`, 8000);
    const switched = await readThread(panel);
    check('switching to another session swaps the thread',
      switched.texts[0] === '第一条会话的问题' && switched.count === 2,
      JSON.stringify(switched.texts));
    check('the capsule follows the current session',
      (await readHeader(panel)).label === seen.pinnedTitle);
    // 收工时当前是置顶那条：重启后应该回到它。
    seen.currentId = seen.pinnedId;
    seen.currentTitle = seen.pinnedTitle;

    // ⑦ 删除要二次确认：先取消一次，记录还在。
    await setPopover(panel, true);
    await rowAction(panel, second, 'delete');
    const asked = await waitFor(
      panel,
      `Boolean(document.querySelector('.session-row[data-id="${second}"].is-confirming'))`,
      5000
    );
    check('delete asks for confirmation first', asked === true);
    const confirming = await readSessions(panel);
    check('the confirmation names the session and promises recovery',
      (confirming.rows.find((row) => row.id === second)?.title ?? '').includes('删除')
      && confirming.rows.some((row) => row.confirming && row.actions.includes('confirm-delete')),
      JSON.stringify(confirming.rows.find((row) => row.id === second)));
    await rowAction(panel, second, 'cancel-delete');
    await waitFor(panel, `!document.querySelector('.session-row[data-id="${second}"].is-confirming')`, 5000);
    check('cancelling keeps the session', (await readSessions(panel)).rows.some((row) => row.id === second));

    // 删一条不是当前的：当前会话不变。
    const beforeDelete = await readHeader(panel);
    check('deleting a non-current session succeeds', await deleteSession(panel, second));
    check('current session is untouched by deleting another one',
      (await readHeader(panel)).label === beforeDelete.label, (await readHeader(panel)).label);
    check('soft-deleted session leaves the list',
      !(await readSessions(panel)).rows.some((row) => row.id === second));

    const errors = consoleErrors(panel);
    check('console is clean on first run', errors.length === 0, errors.slice(0, 3).join(' | '));

    // #111 撤旧壳：旧面板三个文件必须已经删除，不能靠开关绕开。
    check('old panel files are gone',
      !fs.existsSync(path.join(repoRoot, 'desktop', 'panel.html'))
      && !fs.existsSync(path.join(repoRoot, 'desktop', 'panel.js'))
      && !fs.existsSync(path.join(repoRoot, 'desktop', 'panel.css')));
    return seen;
  } finally {
    await app.stop();
  }
};

/** 第二次：同一个 userData + 同一个库重启，验持久化与删除落点、空态、找回。 */
const secondRun = async ({ userData, ownerDb, knowledgeDb }, seen) => {
  const app = await startApp({
    userData,
    ownerDb,
    knowledgeDb,
    showPanel: true,
    page: 'shell.html'
  });
  const { panel } = app;
  try {
    check('after restart the window is still the card shell',
      await waitFor(panel, "document.querySelector('#shellHeader')", 30000));
    await waitFor(panel, "document.querySelectorAll('#sessionList .session-row').length >= 1", 15000);
    const header = await readHeader(panel);
    check('the remembered session is still selected after restart',
      header.label === seen.currentTitle, `${header.label} != ${seen.currentTitle}`);

    await setPopover(panel, true);
    const rows = (await readSessions(panel)).rows;
    check('sessions survive a restart', rows.length === 2, rows.map((row) => row.id).join(','));
    check('the pinned session is still first and still pinned',
      rows[0]?.id === seen.pinnedId && rows[0]?.pinned === true,
      JSON.stringify(rows[0]));
    const thread = await readThread(panel);
    check('the current session replays its messages after restart',
      thread.count === 2 && thread.texts[0] === '第一条会话的问题',
      JSON.stringify(thread.texts));

    // 切到另一条：每会话各自一条流，互不串。
    const other = rows.find((row) => row.id !== seen.pinnedId);
    await click(panel, `.session-row[data-id="${other.id}"] button[data-act="switch"]`);
    await waitFor(panel, `document.getElementById('sessionLabel').textContent.trim() === ${JSON.stringify(other.title)}`, 8000);
    const otherThread = await readThread(panel);
    check('each session keeps its own thread across a restart',
      otherThread.count === 2 && otherThread.texts[0] === '第三条会话的问题',
      JSON.stringify(otherThread.texts));

    // 删除当前会话 → 落到第一条（置顶那条）。
    await setPopover(panel, true);
    check('deleting the current session succeeds', await deleteSession(panel, other.id));
    await waitFor(panel, `document.getElementById('sessionLabel').textContent.trim() === ${JSON.stringify(seen.pinnedTitle)}`, 8000);
    const landed = await readHeader(panel);
    check('deleting the current session lands on the first remaining one',
      landed.label === seen.pinnedTitle, landed.label);

    // 删到一条不剩：空态 + 不许发消息。
    await setPopover(panel, true);
    check('deleting the last visible session succeeds', await deleteSession(panel, seen.pinnedId));
    await waitFor(panel, "document.querySelectorAll('#sessionList .session-row').length === 0", 8000);
    const emptyList = await readSessions(panel);
    check('empty list explains how to start again',
      emptyList.hint.includes('还没有会话') && emptyList.hintKind === 'no-session', emptyList.hint);
    const emptyThread = await readThread(panel);
    check('the thread goes back to the empty state',
      emptyThread.count === 0 && emptyThread.emptyText.includes('还没有会话'), emptyThread.emptyText);
    check('no session means no sending (composer locked)',
      emptyThread.inputDisabled === true && emptyThread.sendDisabled === true,
      JSON.stringify({ input: emptyThread.inputDisabled, send: emptyThread.sendDisabled }));
    // 就算硬发一次提交，也不该冒出消息。
    await panel.evaluate(
      "document.getElementById('composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))"
    );
    const afterSubmit = await readThread(panel);
    check('submitting without a session adds nothing', afterSubmit.count === 0, String(afterSubmit.count));
    check('the capsule has nothing to show', (await readHeader(panel)).label === '还没有会话');
    await capture(panel, path.join(shotsDir, 'sessions-empty-after-delete.png'));

    // 软删除：记录还在，能从「已删除」找回。
    const archiveLabel = (await readSessions(panel)).archive;
    check('the archive keeps a count of deleted sessions', archiveLabel === '已删除 3', archiveLabel);
    await click(panel, '#sessionArchive');
    await waitFor(panel, "document.querySelectorAll('#sessionList .session-row').length === 3", 8000);
    const archived = await readSessions(panel);
    check('deleted sessions are still there to recover',
      archived.rows.length === 3 && archived.rows.every((row) => row.archived),
      archived.rows.map((row) => row.title).join(' | '));
    await capture(panel, path.join(shotsDir, 'sessions-archive.png'));

    const recover = archived.rows.find((row) => row.title === seen.pinnedTitle) ?? archived.rows[0];
    await rowAction(panel, recover.id, 'restore');
    await waitFor(panel, "document.querySelectorAll('#sessionList .session-row').length === 2", 8000);
    check('restoring puts the session back in the archive view', true);

    await click(panel, '#sessionArchive');
    await waitFor(panel, "document.querySelectorAll('#sessionList .session-row').length === 1", 8000);
    const restoredRows = (await readSessions(panel)).rows;
    check('the restored session is back in the list', restoredRows.length === 1 && !restoredRows[0].archived,
      JSON.stringify(restoredRows));

    // 找回后能重新选中并继续写：消息一条没丢。
    await click(panel, `.session-row[data-id="${restoredRows[0].id}"] button[data-act="switch"]`);
    await waitFor(panel, `document.querySelectorAll('#messages .msg').length === 2`, 8000);
    const restoredThread = await readThread(panel);
    check('the restored session still has its messages', restoredThread.texts[0] === '第一条会话的问题',
      JSON.stringify(restoredThread.texts));
    check('a restored session can be written to again', await sendLine(panel, '找回之后接着说', 4));

    const errors = consoleErrors(panel);
    check('console is clean after restart', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await app.stop();
  }
};

/** #111 默认入口就是新壳：不给 env、不给 page，窗口仍必须加载 shell.html。 */
const runDefaultEntry = async () => {
  const root = fs.mkdtempSync(path.join(tempBase, 'card-shell-111-default-'));
  const userData = path.join(root, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  const app = await startApp({
    userData,
    ownerDb: path.join(root, 'owner.sqlite'),
    knowledgeDb: path.join(root, 'knowledge.sqlite'),
    showPanel: true
  });
  try {
    // 默认页面由 lib/cdp.mjs 的 page 缺省值（shell.html）选中；这里再验 DOM 是新壳。
    check('without any switch the window loads shell.html',
      await waitFor(app.panel, "document.querySelector('#shellHeader')", 30000));
    check('the old mode bar is not in the DOM',
      (await app.panel.evaluate("Boolean(document.getElementById('modeBar'))")) === false);
    check('the old two-zone layout is not in the DOM',
      (await app.panel.evaluate("Boolean(document.getElementById('opsZone'))")) === false);
    const url = String(await app.panel.evaluate('location.pathname'));
    check('the page is shell.html', url.endsWith('/shell.html'), url);
    const errors = consoleErrors(app.panel);
    check('shell boots with a clean console by default', errors.length === 0, errors.slice(0, 3).join(' | '));
    await capture(app.panel, path.join(shotsDir, 'card-shell-default-entry.png'));
  } finally {
    await app.stop();
    if (failures.length === 0) safeRemove(root);
    else console.warn(`[CARD-SHELL-#111] kept state: ${root}`);
  }
};

const run = async () => {
  fs.mkdirSync(tempBase, { recursive: true });
  fs.mkdirSync(shotsDir, { recursive: true });
  // 两次启动共用同一个临时目录与 owner 库：重启不是重新造一份内存状态。
  const root = fs.mkdtempSync(path.join(tempBase, 'card-shell-106-'));
  const userData = path.join(root, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  const files = {
    userData,
    ownerDb: path.join(root, 'owner.sqlite'),
    knowledgeDb: path.join(root, 'knowledge.sqlite')
  };
  try {
    const seen = await firstRun(files);
    await secondRun(files, seen);
  } finally {
    // 成功就清临时 userData / 库，失败留着现场；截图始终留在 shotsDir。
    if (failures.length === 0) safeRemove(root);
    else console.warn(`[CARD-SHELL-#106] kept state: ${root}`);
  }
  await runDefaultEntry();
  if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
  console.log(`[CARD-SHELL-#106] screenshots: ${shotsDir}`);
  console.log('[CARD-SHELL-#106] PASS');
};

run().catch((error) => {
  console.error(`[CARD-SHELL-#106] FAIL: ${error.stack ?? error.message}`);
  if (failures.length > 0) console.error(`[CARD-SHELL-#106] screenshots kept: ${shotsDir}`);
  process.exitCode = 1;
});
