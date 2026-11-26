// #125 验收：`@@` →「关联会话」列最近会话、选指针、发送段里只有指针没有正文；
// 线索无效时在对话流里给明确失败。
//
// 命中真实路径：离屏 Electron + CDP，加载卡片壳 shell.html。
// 会话索引用临时 home 造 Codex / Claude 两个来源（OWNER_SESSION_HOME），
// 不碰本机真实会话；OpenCode 库指到不存在的路径，验证「读不到 ≠ 空列表」。
// 截图：方法卡、胶囊、发送后的 prompt 段。
import fs from 'node:fs';
import path from 'node:path';
import {
  capture, consoleErrors, createChecker, startApp, sleep, waitFor
} from './lib/cdp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const shotsDir = process.env.SHOTS_DIR
  ?? path.resolve(repoRoot, '..', '..', 'mm-notes', 'shots-125');
const tempBase = process.env.TMP_125 ?? path.resolve(shotsDir, '..', 'tmp-125');
const { check, failures } = createChecker('[AT-SESSION-#125]');

const CODEX_ID = '01a1a3bc-a07b-76d0-9532-e942ded4731e';
const CLAUDE_ID = 'ce930107-64d0-4abe-915b-09087f2db30f';
const CODEX_TITLE = '指针测试会话';
const CLAUDE_TITLE = 'Claude 线索会话';
const CODEX_BODY = 'CODEX_BODY_SECRET_125 这段会话正文不该被导入';
const CLAUDE_BODY = 'CLAUDE_BODY_SECRET_125 这段会话正文不该被导入';
const ASK = '用刚关联的会话回答我';

const jsonl = (items) => `${items.map((item) => JSON.stringify(item)).join('\n')}\n`;

const seedSessions = (home) => {
  const codexFile = path.join(
    home, '.codex', 'sessions', '2026', '11', '26',
    `rollout-2026-11-26T08-00-00-${CODEX_ID}.jsonl`
  );
  fs.mkdirSync(path.dirname(codexFile), { recursive: true });
  fs.writeFileSync(codexFile, jsonl([
    {
      timestamp: '2026-11-26T08:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: CODEX_ID,
        cwd: 'D:\\fixture\\codex-project',
        timestamp: '2026-11-26T08:00:00.000Z'
      }
    },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: CODEX_TITLE }] }
    },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '先记下。' }] }
    },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: CODEX_BODY }] }
    }
  ]), 'utf8');

  const claudeFile = path.join(
    home, '.claude', 'projects', 'D--fixture-claude-project', `${CLAUDE_ID}.jsonl`
  );
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
  fs.writeFileSync(claudeFile, jsonl([
    {
      type: 'user',
      cwd: 'D:\\fixture\\claude-project',
      slug: 'claude-clue-session',
      sessionId: CLAUDE_ID,
      timestamp: '2026-11-25T09:10:00.000Z',
      message: { role: 'user', content: CLAUDE_TITLE }
    },
    {
      type: 'assistant',
      cwd: 'D:\\fixture\\claude-project',
      sessionId: CLAUDE_ID,
      timestamp: '2026-11-25T09:11:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: '边界在适配层。' }] }
    },
    {
      type: 'user',
      cwd: 'D:\\fixture\\claude-project',
      sessionId: CLAUDE_ID,
      timestamp: '2026-11-25T09:12:00.000Z',
      message: { role: 'user', content: CLAUDE_BODY }
    }
  ]), 'utf8');
};

const typeInput = (panel, text) => panel.evaluate(`(() => {
  const input = document.getElementById('input');
  input.focus();
  input.value = ${JSON.stringify(text)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input.value;
})()`);

const typeClue = (panel, text) => panel.evaluate(`(() => {
  const field = document.getElementById('atSessionClue');
  if (!field) return false;
  field.focus();
  field.value = ${JSON.stringify(text)};
  field.dispatchEvent(new Event('input', { bubbles: true }));
  return field.value;
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

const createSession = async (panel) => {
  await click(panel, '#sessionToggle');
  await waitFor(panel, "document.getElementById('sessionPopover').hidden === false", 5000);
  await click(panel, '#sessionNew');
  return waitFor(panel, "document.getElementById('input').disabled === false", 8000);
};

const openSessionMethod = async (panel) => {
  await typeInput(panel, '@@');
  await waitFor(panel, "document.getElementById('atPanel').hidden === false", 5000);
  await click(panel, '.at-method[data-at-method="session"]');
  return waitFor(panel, "document.getElementById('atSessionClue')", 5000);
};

const readCard = (panel) => panel.evaluate(`(() => ({
  panelHidden: document.getElementById('atPanel').hidden,
  title: document.getElementById('atTitle').textContent.trim(),
  tabs: [...document.querySelectorAll('.at-session-tab')].map((tab) => ({
    key: tab.dataset.atSessionSource,
    label: tab.textContent.trim(),
    on: tab.getAttribute('aria-pressed') === 'true'
  })),
  rows: [...document.querySelectorAll('.at-session-row')].map((row) => ({
    source: row.dataset.source,
    id: row.dataset.sessionId,
    title: row.querySelector('.at-session-row-title')?.textContent.trim() ?? '',
    meta: row.querySelector('.at-session-row-meta')?.textContent.trim() ?? '',
    badge: row.querySelector('.at-session-badge')?.textContent.trim() ?? ''
  })),
  empty: document.querySelector('.at-session-empty')?.textContent.trim() ?? '',
  status: document.getElementById('atSessionClue') ? '' : ''
}))()`);

const readCapsules = (panel) => panel.evaluate(`(() => ({
  hidden: document.getElementById('sessionPointers').hidden,
  items: [...document.querySelectorAll('#sessionPointers .session-pointer')].map((pill) => ({
    source: pill.querySelector('.session-pointer-src')?.textContent.trim() ?? '',
    title: pill.querySelector('.session-pointer-title')?.textContent.trim() ?? '',
    meta: pill.querySelector('.session-pointer-meta')?.textContent.trim() ?? '',
    mark: pill.querySelector('.session-pointer-mark')?.textContent.trim() ?? ''
  }))
}))()`);

const readThread = (panel) => panel.evaluate(`(() => ({
  count: document.querySelectorAll('#messages .msg').length,
  lastText: [...document.querySelectorAll('#messages .msg .bubble')].at(-1)?.textContent ?? '',
  body: document.getElementById('messages').innerText
}))()`);

const readStored = (panel, sessionId) => panel.evaluate(
  `window.companion.cardSessions.get({ id: ${JSON.stringify(sessionId)} })`
);

const currentSessionId = (panel) => panel.evaluate(
  "window.companion.cardSessions.list({}).then((data) => data.items[0]?.id ?? '')"
);

const run = async () => {
  fs.mkdirSync(tempBase, { recursive: true });
  fs.mkdirSync(shotsDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'at-session-125-'));
  const userData = path.join(root, 'userdata');
  const home = path.join(root, 'home');
  fs.mkdirSync(userData, { recursive: true });
  seedSessions(home);
  const app = await startApp({
    userData,
    ownerDb: path.join(root, 'owner.sqlite'),
    knowledgeDb: path.join(root, 'knowledge.sqlite'),
    env: {
      // 会话索引只看这个临时 home；OpenCode 库指到不存在的位置，验证降级原因。
      OWNER_SESSION_HOME: home,
      CODEX_HOME: path.join(home, '.codex'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      OPENCODE_DB: path.join(home, 'missing-opencode.db')
    },
    showPanel: true,
    page: 'shell.html'
  });
  const { panel } = app;
  try {
    check('card shell loads', await waitFor(panel, "document.querySelector('#shellHeader')", 30000));
    check('a session exists before opening @@', await createSession(panel));

    // ① 方法卡：来源切换 + 最近会话（Codex 这一栏）。
    check('the session method mounts its clue input', await openSessionMethod(panel));
    check('the Codex recent row loads from the session index', await waitFor(panel,
      "document.querySelector('.at-session-row[data-source=\"codex\"]')", 10000));
    let card = await readCard(panel);
    check('the card is the session method', card.panelHidden === false && card.title === '关联会话',
      card.title);
    check('three sources are switchable', JSON.stringify(card.tabs.map((tab) => tab.key))
      === '["codex","claude","opencode"]', JSON.stringify(card.tabs));
    check('Codex is the active source', card.tabs.find((tab) => tab.key === 'codex')?.on === true);
    check('the recent row carries title / time / turns / project',
      card.rows[0]?.title === CODEX_TITLE
      && card.rows[0]?.meta.includes('2026-11-26 08:00')
      && card.rows[0]?.meta.includes('3 轮')
      && card.rows[0]?.meta.includes('codex-project'),
      JSON.stringify(card.rows[0]));
    check('the recent row is a confirmed pointer (no 来源未确认 badge)',
      card.rows[0]?.badge === '', card.rows[0]?.badge);
    await capture(panel, path.join(shotsDir, 'at-session-card.png'));

    // ② 选一段最近会话 → 胶囊。
    check('the Codex row is clicked', await click(panel,
      '.at-session-row[data-source="codex"]'));
    check('a pointer capsule appears above the composer', await waitFor(panel,
      "document.querySelectorAll('#sessionPointers .session-pointer').length === 1", 5000));
    const capsules = await readCapsules(panel);
    check('the capsule names the source and title', capsules.items[0]?.source === 'Codex'
      && capsules.items[0]?.title === CODEX_TITLE, JSON.stringify(capsules.items[0]));
    check('the capsule reports turns and stays a pointer',
      capsules.items[0]?.meta === '3 轮' && capsules.items[0]?.mark === '',
      JSON.stringify(capsules.items[0]));
    check('the card stays open after picking', (await readCard(panel)).panelHidden === false);
    // 收起方法卡后胶囊仍在输入框上方；截图这一屏才看得见它。
    check('the method card closes without dropping the pointer', await click(panel, '#atClose'));
    await waitFor(panel, "document.getElementById('atPanel').hidden === true", 3000);
    await sleep(150);
    await capture(panel, path.join(shotsDir, 'at-session-capsule.png'));

    // ③ 发送：prompt 里是指针段，没有会话正文。
    await typeInput(panel, ASK);
    check('the question is sent with the pointer attached', await pressEnter(panel));
    check('the sent turn lands in the stream', await waitFor(panel,
      "document.querySelectorAll('#messages .msg').length === 2", 8000));
    await sleep(250);
    const sessionId = await currentSessionId(panel);
    check('the current session id is readable', Boolean(sessionId), sessionId);
    const detail = await readStored(panel, sessionId);
    const messages = detail?.messages ?? [];
    const sent = [...messages].reverse().find((message) => message.role === 'user')?.text ?? '';
    check('the prompt starts with the question', sent.startsWith(ASK), sent.slice(0, 40));
    check('the prompt carries the 关联会话 section',
      sent.includes('## 关联会话（指针，不是正文）'), sent.slice(0, 200));
    check('the prompt tells the agent to retrieve and ask when lost',
      sent.includes('需要什么就回这些会话里检索；定位不到就问我，不要猜。'));
    check('the pointer line carries source / title / time / turns / project / id',
      sent.includes('- Codex · 《指针测试会话》 · 2026-11-26 08:00 · 3 轮')
      && sent.includes('项目：codex-project')
      && sent.includes(`id：${CODEX_ID}`), sent);
    check('the stored prompt does not include the Codex session body',
      !sent.includes('CODEX_BODY_SECRET_125'), sent);
    check('the stored session has no external session body anywhere',
      !JSON.stringify(detail).includes('CODEX_BODY_SECRET_125')
      && !JSON.stringify(detail).includes('CLAUDE_BODY_SECRET_125'));
    check('the flow never renders the external session body',
      !(await readThread(panel)).body.includes('CODEX_BODY_SECRET_125'));
    check('the capsule is consumed after sending', (await readCapsules(panel)).hidden === true);
    await capture(panel, path.join(shotsDir, 'at-session-prompt.png'));

    // ④ 线索无效：流里给明确失败，不返回空。
    const before = (await readThread(panel)).count;
    check('the method reopens for a clue', await openSessionMethod(panel));
    check('a bad path clue is typed', await typeClue(panel, 'D:\\no-such-session-125\\missing'));
    check('the clue kind is shown as a keyword',
      await waitFor(panel, "document.querySelector('.at-session-clue-kind')?.dataset.kind === 'keyword'", 3000));
    check('the clue is resolved', await click(panel, '.at-session-resolve'));
    check('a failure lands in the stream', await waitFor(panel,
      `document.querySelectorAll('#messages .msg').length === ${before + 1}`, 8000));
    const failed = await readThread(panel);
    check('the failure is explicit, not an empty result',
      failed.lastText.includes('关联会话没有建立') && failed.lastText.includes('没找到匹配'),
      failed.lastText);
    check('the failure says nothing was read as body',
      failed.lastText.includes('没有整段读取任何会话'), failed.lastText);
    check('the failure stays visible in the card as well', await waitFor(panel,
      "document.querySelector('.at-session-empty')?.textContent.includes('没有匹配')", 3000));
    await capture(panel, path.join(shotsDir, 'at-session-clue-miss.png'));

    // ⑤ 线索命中：标「来源未确认」，胶囊上也能看见；选完可移除。
    check('a title keyword is typed', await typeClue(panel, 'Claude 线索'));
    check('the clue is resolved again', await click(panel, '.at-session-resolve'));
    check('the matching Claude row appears', await waitFor(panel,
      "document.querySelector('.at-session-row[data-source=\"claude\"]')", 8000));
    card = await readCard(panel);
    check('a clue match is marked 来源未确认',
      card.rows[0]?.badge === '来源未确认', JSON.stringify(card.rows));
    check('the clue match is picked', await click(panel, '.at-session-row[data-source="claude"]'));
    check('the clue pointer capsule is marked 来源未确认', await waitFor(panel,
      "document.querySelector('#sessionPointers .session-pointer-mark')?.textContent.trim() === '来源未确认'", 5000));
    check('the capsule names the clue session', (await readCapsules(panel)).items[0]?.title === CLAUDE_TITLE);
    check('the capsule can be removed', await click(panel,
      '#sessionPointers .session-pointer-remove'));
    check('removing clears the capsule', (await readCapsules(panel)).hidden === true);

    // ⑥ OpenCode 库不在本机：切过去要说「读不出来」，不是静默空列表。
    check('the OpenCode tab is clicked', await click(panel,
      '.at-session-tab[data-at-session-source="opencode"]'));
    check('the OpenCode tab explains why it is empty', await waitFor(panel,
      "document.querySelector('.at-session-status')?.textContent.includes('OpenCode')", 8000));

    const errors = consoleErrors(panel);
    check('console is clean', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await app.stop();
    if (failures.length === 0) {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      } catch { /* 失败留现场，成功删不掉也不影响结论 */ }
    } else {
      console.warn(`[AT-SESSION-#125] kept state: ${root}`);
    }
  }
  if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
  console.log(`[AT-SESSION-#125] screenshots: ${shotsDir}`);
  console.log('[AT-SESSION-#125] PASS');
};

run().catch((error) => {
  console.error(`[AT-SESSION-#125] FAIL: ${error.stack ?? error.message}`);
  if (failures.length > 0) console.error(`[AT-SESSION-#125] screenshots kept: ${shotsDir}`);
  process.exitCode = 1;
});
