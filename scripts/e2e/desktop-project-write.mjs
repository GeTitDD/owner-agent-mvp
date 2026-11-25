// #115 验收：把文档同步进被观察项目目录。
//
// 路径：卡片壳（#105）→ 输入 /同步到项目 → 确认卡（#113 的卡，逐条完整路径 + 三轴 + 判据）
// → 允许这一次（按会话授权并真的写盘）→ 回执（路径、字节数、是否进 git 工作区）。
// 断言六层：
//   ① 只有「同步到项目目录」这条命令触发确认；未授权时判定是 confirm，且出卡前后目录快照一致
//      （没授权就是只读）；
//   ② 卡片逐条列出每个目标文件的完整路径，不合并、不省略；四个动作都在；
//   ③ 允许后文件真的落到项目目录，回执逐条给路径 + 字节数 + git 工作区，字节数与盘上一致；
//   ④ 同一会话第二次同步不再出卡（授权按会话生效），直接写并给回执；
//   ⑤ 换一个会话后再次要求确认；取消的卡逐条列出没写的路径，取消前后目录快照完全一致；
//   ⑥ 控制台干净。
// 纯函数规则在 tests/project-write.test.mjs；这里只断言界面上与磁盘上看得见的东西。
// 截图写到 SHOTS_DIR（缺省 mm-notes/shots-115）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { OwnerStore } from '../../src/owner-store.mjs';
import { capture, consoleErrors, createChecker, sleep, startApp, waitFor } from './lib/cdp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const shotsDir = process.env.SHOTS_DIR
  ?? path.resolve(repoRoot, '..', '..', 'mm-notes', 'shots-115');
const tempBase = process.env.TMP_115 ?? path.resolve(shotsDir, '..', 'tmp-115');
const { check, failures } = createChecker('[PROJECT-WRITE-#115]');

const DOCS = [
  { relativePath: 'docs/notes/retry.md', content: '# 重试\n\n上限三次，之后交给人工。\n' },
  { relativePath: 'docs/notes/backoff.md', content: '# 退避\n\n指数退避，封顶 30 秒。\n' }
];

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

const click = (panel, selector) => panel.evaluate(`(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) return false;
  node.click();
  return true;
})()`);

const messageCount = (panel) => panel.evaluate("document.querySelectorAll('#messages .msg').length");

const waitMessages = (panel, count) => waitFor(
  panel, `document.querySelectorAll('#messages .msg').length === ${count}`, 15000
);

/** 项目浮层里选项目；没有会话时这会直接开一条绑定它的会话。 */
const chooseProject = async (panel, projectId) => {
  await panel.evaluate("document.getElementById('projectToggle').click()");
  await waitFor(panel, "document.getElementById('projectPopover').hidden === false", 5000);
  const clicked = await click(panel, `#projectList button[data-project="${projectId}"]`);
  if (!clicked) return false;
  const confirmShown = await panel.evaluate(
    "document.getElementById('projectConfirm').hidden === false"
  );
  // 已有会话时先出确认弹窗，选「在本会话切换」。
  if (confirmShown) await click(panel, '#confirmInSession');
  return waitFor(panel, "document.getElementById('projectLabel').textContent.trim() === 'Alpha Repo'", 10000);
};

/** 开一条新会话并绑到 Alpha：用来验证「换会话后再次要求确认」。 */
const newSessionOnAlpha = async (panel) => {
  await panel.evaluate("document.getElementById('sessionToggle').click()");
  await waitFor(panel, "document.getElementById('sessionPopover').hidden === false", 5000);
  await panel.evaluate("document.getElementById('sessionNew').click()");
  await waitFor(panel, "document.getElementById('input').disabled === false", 10000);
  await panel.evaluate("document.getElementById('sessionToggle').click()");
  const ready = await chooseProject(panel, 'alpha');
  // 新会话没有消息：流清空，确认卡计数也回到 0。
  await waitFor(panel, "document.querySelectorAll('#messages .msg').length === 0", 8000);
  return ready;
};

/** 逐张读出确认卡的结构：路径、等级、动作、结论。 */
const readCards = (panel) => panel.evaluate(`(() => {
  const nodes = [...document.querySelectorAll('#messages .msg.agent [data-block="risk"]')];
  const text = (node, selector) => node.querySelector(selector)?.textContent ?? '';
  return nodes.map((node) => ({
    id: node.dataset.riskId ?? '',
    level: node.dataset.riskLevel ?? '',
    title: text(node, '.block-head h4'),
    conclusion: text(node, '.risk-conclusion'),
    paths: [...node.querySelectorAll('.risk-path')].map((item) => item.dataset.path ?? item.textContent),
    axes: [...node.querySelectorAll('.risk-axis')].map((row) => row.querySelector('dd')?.textContent ?? ''),
    actions: [...node.querySelectorAll('[data-risk-action]')].map((button) => ({
      id: button.dataset.riskAction ?? '',
      label: button.textContent,
      disabled: button.disabled === true
    })),
    basisCount: Number((text(node, '.risk-basis-count') || '0').replace(/\\D+/gu, '')) || 0,
    answered: text(node, '.risk-answered')
  }));
})()`);

/** 点第 index 张确认卡上的某个动作；返回是否真的点到。 */
const clickCardAction = (panel, index, action) => panel.evaluate(`(() => {
  const nodes = [...document.querySelectorAll('#messages .msg.agent [data-block="risk"]')];
  const button = nodes[${index}]?.querySelector('[data-risk-action="${action}"]');
  if (!button || button.disabled) return false;
  button.click();
  return true;
})()`);

/** 一条回执：文字 + 键值块的行（按「键 → 值」读，重复键按顺序保留）。 */
const readReceipt = (panel, messageIndex) => panel.evaluate(`(() => {
  const item = document.querySelector('#messages .msg[data-index="${messageIndex}"]');
  if (!item) return null;
  const block = item.querySelector('[data-block="kv"]');
  const rows = [...(block?.querySelectorAll('.block-kv > div') ?? [])].map((row) => [
    row.querySelector('dt')?.textContent ?? '',
    row.querySelector('dd')?.textContent ?? ''
  ]);
  return {
    role: item.dataset.role ?? '',
    text: item.querySelector('.bubble')?.textContent ?? '',
    blockTitle: block?.querySelector('.block-head h4')?.textContent ?? '',
    rows,
    answered: ''
  };
})()`);

/** 目录快照：相对路径 → 字节数 + 哈希。.git 不进快照（git status 会自己动索引）。 */
const snapshotDir = (root) => {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const bytes = fs.readFileSync(full);
      out[path.relative(root, full).replace(/\\/gu, '/')] = {
        bytes: bytes.length,
        sha: crypto.createHash('sha256').update(bytes).digest('hex')
      };
    }
  };
  walk(root);
  return out;
};

const safeRemove = (target) => {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    console.warn(`[PROJECT-WRITE-#115] kept state: ${target}`);
  }
};

const git = (root, args) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', windowsHide: true
});

/** 一个已登记、已 git init 的项目：回执里的「是否进 git 工作区」才有东西可答。 */
const seedProject = (root, ownerDb) => {
  const alphaRoot = path.join(root, 'alpha');
  fs.mkdirSync(alphaRoot, { recursive: true });
  fs.writeFileSync(path.join(alphaRoot, 'README.md'), '# Alpha\n', 'utf8');
  git(alphaRoot, ['init']);
  git(alphaRoot, ['config', 'user.email', 'e2e@example.com']);
  git(alphaRoot, ['config', 'user.name', 'E2E']);
  git(alphaRoot, ['add', '.']);
  git(alphaRoot, ['commit', '-m', 'init']);
  const owner = new OwnerStore(ownerDb);
  try {
    owner.registerProject({
      id: 'alpha',
      name: 'Alpha Repo',
      root: alphaRoot,
      primaryDomain: 'software-engineering',
      domains: ['software-engineering']
    });
  } finally {
    owner.close();
  }
  return alphaRoot;
};

const shotThread = async (panel, file, { bottom = false } = {}) => {
  await panel.send('Emulation.setDeviceMetricsOverride', {
    width: 440, height: 1100, deviceScaleFactor: 1, mobile: false
  });
  await sleep(300);
  await panel.evaluate(`(() => {
    const thread = document.getElementById('thread');
    thread.scrollTop = ${bottom ? 'thread.scrollHeight' : '0'};
    return thread.scrollTop;
  })()`);
  await sleep(200);
  await capture(panel, file);
  await panel.send('Emulation.clearDeviceMetricsOverride');
  await sleep(200);
};

const run = async () => {
  fs.mkdirSync(tempBase, { recursive: true });
  fs.mkdirSync(shotsDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'project-write-115-'));
  const userData = path.join(root, 'userdata');
  const ownerDb = path.join(root, 'owner.sqlite');
  const knowledgeDb = path.join(root, 'knowledge.sqlite');
  fs.mkdirSync(userData, { recursive: true });
  const alphaRoot = seedProject(root, ownerDb);
  const writtenPath = (relative) => path.join(alphaRoot, ...relative.split('/'));

  const app = await startApp({
    userData,
    ownerDb,
    knowledgeDb,
    env: { OWNER_AGENT_SHELL: '1' },
    showPanel: true,
    page: 'shell.html'
  });
  const { panel } = app;
  try {
    check('shell page loads through the main-process switch',
      await waitFor(panel, "document.querySelector('#shellHeader')", 30000));
    check('the project-write module is readable from the page',
      await waitFor(panel, 'Boolean(window.OwnerProjectWrite?.request)', 10000));
    check('the risk card module is readable too (cards come from #113)',
      await waitFor(panel, 'Boolean(window.OwnerRiskCard?.riskCardModelOf)', 10000));
    check('a session bound to Alpha exists before syncing', await chooseProject(panel, 'alpha'));

    // ① 触发条件：只有这条命令进确认路径；未授权判定是 confirm。
    const triggers = await panel.evaluate(`(() => {
      const api = window.OwnerProjectWrite;
      return {
        sync: api.parseCommand('/同步到项目'),
        chat: api.parseCommand('/记灵感 一句灵感'),
        risk: api.parseCommand('/risk high'),
        unauth: api.decide({ sessionId: 's-1', grants: {} }),
        authed: api.decide({ sessionId: 's-1', grants: { 's-1': true } }),
        otherSession: api.decide({ sessionId: 's-2', grants: { 's-1': true } })
      };
    })()`);
    check('only /同步到项目 is the sync trigger',
      triggers?.sync?.kind === 'project-sync' && triggers?.chat === null && triggers?.risk === null,
      JSON.stringify(triggers?.sync));
    check('unauthorized project write needs confirmation',
      triggers?.unauth?.needsConfirm === true && triggers?.unauth?.gate?.scope === 'project',
      JSON.stringify(triggers?.unauth?.gate));
    check('a grant only covers its own session',
      triggers?.authed?.allowed === true && triggers?.otherSession?.needsConfirm === true,
      JSON.stringify({ authed: triggers?.authed?.allowed, other: triggers?.otherSession?.needsConfirm }));

    // ② 未授权时出确认卡：逐条完整路径，且目录没被动过。
    // 多文档清单走注入点（默认来源是「这次会话一篇笔记」，见最末一段）。
    await panel.evaluate(`(() => {
      window.OwnerProjectSyncDocs = async () => (${JSON.stringify(DOCS)});
      return true;
    })()`);
    const beforeCard = snapshotDir(alphaRoot);
    await sendDraft(panel, '/同步到项目 重试设计笔记');
    check('the sync leaves two messages (my line + the confirmation card)',
      await waitMessages(panel, 2), String(await messageCount(panel)));
    let cards = await readCards(panel);
    check('exactly one confirmation card appears', cards.length === 1, String(cards.length));
    const expectedPaths = DOCS.map((doc) => writtenPath(doc.relativePath));
    check('the card lists every target path in full, one by one',
      JSON.stringify(cards[0]?.paths) === JSON.stringify(expectedPaths),
      JSON.stringify(cards[0]?.paths));
    check('the card names the project and the risk level',
      (cards[0]?.title ?? '') === '同步文档到项目目录' && cards[0]?.level === 'medium',
      JSON.stringify({ title: cards[0]?.title, level: cards[0]?.level }));
    check('the card carries the three axes',
      JSON.stringify(cards[0]?.axes) === JSON.stringify(['项目级', '需重建', '否']),
      JSON.stringify(cards[0]?.axes));
    check('the card has exactly the four actions, in order',
      JSON.stringify(cards[0]?.actions.map((action) => action.label))
        === JSON.stringify(['允许这一次', '低风险免问', '我的判断不同', '取消']),
      JSON.stringify(cards[0]?.actions.map((action) => action.label)));
    check('the card exposes collapsible criteria', (cards[0]?.basisCount ?? 0) >= 4,
      String(cards[0]?.basisCount));
    check('nothing is written before the card is allowed',
      JSON.stringify(snapshotDir(alphaRoot)) === JSON.stringify(beforeCard));
    await shotThread(panel, path.join(shotsDir, 'project-sync-card.png'));

    // ③ 允许这一次：真的落盘 + 回执逐条给路径、字节数、git 工作区。
    check('the allow-once button can be clicked', await clickCardAction(panel, 0, 'allow-once'));
    check('allowing appends my choice and the receipt',
      await waitMessages(panel, 4), String(await messageCount(panel)));
    const receipt = await readReceipt(panel, 3);
    check('the receipt is a kv block titled as a project write',
      receipt?.role === 'agent' && receipt?.blockTitle === '写入回执 · 同步到项目目录',
      JSON.stringify({ title: receipt?.blockTitle, role: receipt?.role, text: receipt?.text }));
    const rows = receipt?.rows ?? [];
    const rowValue = (key) => rows.find(([name]) => name === key)?.[1] ?? '';
    check('the receipt says how many files and how many bytes',
      /^2 个文件 · \d+ 字节$/u.test(rowValue('写入')), rowValue('写入'));
    check('the receipt lists each written path in full, with its own byte count',
      /（\d+ 字节）$/u.test(rowValue('路径 1')) && /（\d+ 字节）$/u.test(rowValue('路径 2'))
      && rowValue('路径 1').startsWith(expectedPaths[0])
      && rowValue('路径 2').startsWith(expectedPaths[1]),
      JSON.stringify([rowValue('路径 1'), rowValue('路径 2')]));
    check('the receipt answers whether the files are in the git worktree',
      rowValue('git 工作区').startsWith('是（'), rowValue('git 工作区'));
    for (const doc of DOCS) {
      const target = writtenPath(doc.relativePath);
      check(`the file landed on disk: ${doc.relativePath}`,
        fs.existsSync(target) && fs.readFileSync(target, 'utf8') === doc.content);
      check(`the receipt byte count matches the disk: ${doc.relativePath}`,
        rowValue(`路径 ${DOCS.indexOf(doc) + 1}`).includes(`（${Buffer.byteLength(doc.content, 'utf8')} 字节）`),
        rowValue(`路径 ${DOCS.indexOf(doc) + 1}`));
    }
    const porcelain = git(alphaRoot, ['status', '--porcelain', '--', 'docs/notes/retry.md', 'docs/notes/backoff.md']);
    check('git sees the synced docs as changes',
      porcelain.includes('docs/notes/retry.md') && porcelain.includes('docs/notes/backoff.md'),
      porcelain.replace(/\n/gu, ' | '));
    await shotThread(panel, path.join(shotsDir, 'project-sync-receipt.png'), { bottom: true });

    // ④ 同一会话第二次同步：授权生效，不再出卡。
    await sendDraft(panel, '/同步到项目 重试设计笔记');
    check('the second sync in the same session leaves two more messages',
      await waitMessages(panel, 6), String(await messageCount(panel)));
    cards = await readCards(panel);
    check('no second confirmation card in the same session', cards.length === 1, String(cards.length));
    const second = await readReceipt(panel, 5);
    check('the second sync writes directly and leaves a receipt',
      second?.blockTitle === '写入回执 · 同步到项目目录'
      && /已写入 2 个文件/u.test(second?.text ?? ''),
      JSON.stringify({ title: second?.blockTitle, text: second?.text }));

    // ⑤ 换会话：授权不继承，再出卡；取消后目录快照完全一致。
    check('a new session bound to Alpha opens', await newSessionOnAlpha(panel));
    // 新会话可能带着一条「切到项目」的说明，所以下面的计数从当前条数起算。
    const base = await messageCount(panel);
    check('the new session does not carry the old flow over', base <= 1, String(base));
    const beforeCancelCard = snapshotDir(alphaRoot);
    await sendDraft(panel, '/同步到项目 重试设计笔记');
    check('the new session gets its own confirmation card',
      await waitMessages(panel, base + 2), String(await messageCount(panel)));
    cards = await readCards(panel);
    check('the new session is asked again (grant did not carry over)', cards.length === 1,
      String(cards.length));
    check('the cancel target list is still the full path list',
      JSON.stringify(cards[0]?.paths) === JSON.stringify(expectedPaths),
      JSON.stringify(cards[0]?.paths));
    await shotThread(panel, path.join(shotsDir, 'project-sync-cancel-before.png'));

    check('the cancel button can be clicked', await clickCardAction(panel, 0, 'cancel'));
    check('cancelling appends my choice and the not-written receipt',
      await waitMessages(panel, base + 4), String(await messageCount(panel)));
    const cancelled = await readReceipt(panel, base + 3);
    check('the cancel receipt says nothing was written',
      cancelled?.blockTitle === '未写入 · 同步到项目目录'
      && /一个都没写/u.test(cancelled?.text ?? '')
      && (cancelled?.rows ?? []).some(([key, value]) => key === '写入' && value === '未写入（0 处）'),
      JSON.stringify({ title: cancelled?.blockTitle, text: cancelled?.text }));
    check('the cancel receipt lists every path that was not written',
      (cancelled?.rows ?? []).filter(([key]) => key.startsWith('路径')).length === 2,
      JSON.stringify(cancelled?.rows));
    const afterCancel = snapshotDir(alphaRoot);
    check('the project directory is byte-identical before and after the cancel',
      JSON.stringify(afterCancel) === JSON.stringify(beforeCancelCard),
      JSON.stringify({ before: Object.keys(beforeCancelCard), after: Object.keys(afterCancel) }));
    check('the synced files are untouched by the cancel',
      DOCS.every((doc) => fs.readFileSync(writtenPath(doc.relativePath), 'utf8') === doc.content));
    await shotThread(panel, path.join(shotsDir, 'project-sync-cancel-after.png'), { bottom: true });

    // 默认来源（不注入）：一份会话笔记，路径在 docs/notes 下，正文含会话内容。
    await panel.evaluate('delete window.OwnerProjectSyncDocs');
    const noteBase = await messageCount(panel);
    await sendDraft(panel, `/同步到项目 ${'重试设计笔记'}`);
    check('the default source produces one more card in this session',
      await waitMessages(panel, noteBase + 2), String(await messageCount(panel)));
    cards = await readCards(panel);
    check('the default note target sits under docs/notes',
      cards.length === 2 && cards[1].paths.length === 1
      && cards[1].paths[0] === writtenPath('docs/notes/重试设计笔记.md'),
      JSON.stringify(cards[1]?.paths));
    check('the default note is not written before confirmation',
      !fs.existsSync(writtenPath(`docs/notes/重试设计笔记.md`)));
    await clickCardAction(panel, 1, 'allow-once');
    check('the default note is written after allowing', await waitFor(
      panel, `document.querySelectorAll('#messages .msg').length === ${noteBase + 4}`, 15000
    ), String(await messageCount(panel)));
    const noteFile = writtenPath('docs/notes/重试设计笔记.md');
    check('the default note carries the conversation markdown',
      fs.existsSync(noteFile) && /# 重试设计笔记/u.test(fs.readFileSync(noteFile, 'utf8')),
      noteFile);
    const noteReceipt = await readReceipt(panel, noteBase + 3);
    check('the default note receipt counts one file',
      /^1 个文件 · \d+ 字节$/u.test(
        (noteReceipt?.rows ?? []).find(([key]) => key === '写入')?.[1] ?? ''
      ),
      JSON.stringify(noteReceipt?.rows?.slice(0, 3)));

    await sleep(200);
    const errors = consoleErrors(panel);
    check('console is clean', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await app.stop();
    // 成功就清临时 userData / 库 / 项目目录，失败留现场；截图始终留在 shotsDir。
    if (failures.length === 0) safeRemove(root);
    else console.warn(`[PROJECT-WRITE-#115] kept state: ${root}`);
  }

  if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
  console.log(`[PROJECT-WRITE-#115] screenshots: ${shotsDir}`);
  console.log('[PROJECT-WRITE-#115] PASS');
};

run().catch((error) => {
  console.error(`[PROJECT-WRITE-#115] FAIL: ${error.stack ?? error.message}`);
  if (failures.length > 0) console.error(`[PROJECT-WRITE-#115] screenshots kept: ${shotsDir}`);
  process.exitCode = 1;
});
