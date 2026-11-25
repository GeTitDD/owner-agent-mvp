// #95 验收：面板里的「灵感收件箱」捕获入口。
//
// 断言六件事：
//   ① 粘贴一段文本就进收件箱，带来源（粘贴）与时间；
//   ② 粘贴一个链接按「链接」来源入队，只存地址——抓取是下一张票，这里不能发任何请求；
//   ③ 重复粘贴同一段内容不产生第二条，面板说清「已经有了」；
//   ④ 非法流转（收件箱直接采纳 / 已采纳再丢弃）被拒，原因里写明从哪到哪；
//   ⑤ 合法流转 收件箱 → 已整理 → 已采纳 / 已丢弃 能走通，丢弃后原文与链接仍能查回；
//   ⑥ 控制台无错误。
// 全程用临时 userData + 临时 owner / 知识库，不碰真实 %APPDATA%。
// 截图与探针写到 SHOTS_DIR（缺省 mm-notes/shots-95）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OwnerStore } from '../../src/owner-store.mjs';
import { PersonalKnowledgeStore } from '../../src/personal-store.mjs';
import { capture, consoleErrors, createChecker, sleep, startApp, waitFor } from './lib/cdp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const shotsDir = process.env.SHOTS_DIR
  ?? path.resolve(repoRoot, '..', '..', 'mm-notes', 'shots-95');
const { check, failures } = createChecker('[IDEAS-#95]');

const LINK = 'https://example.com/notes/95-link-only';
const TEXT = '收件箱空的时候应该有一句提示，而不是一片空白。';

const shot = async (panel, file) => capture(panel, path.join(shotsDir, file));

/** 面板是 440×640 的固定窗口：临时把视口抬高，把收件箱整段截进一张图。 */
const shotSection = async (panel, file, height = 900) => {
  await panel.send('Emulation.setDeviceMetricsOverride', {
    width: 440, height, deviceScaleFactor: 1, mobile: false
  });
  await panel.evaluate(
    "document.getElementById('queueSection')?.scrollIntoView({ block: 'start' })"
  );
  await sleep(400);
  await shot(panel, file);
  await panel.send('Emulation.clearDeviceMetricsOverride');
  await sleep(200);
};

const makeRoot = () => {
  const base = process.env.TMP_95 ?? os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'idea-capture-'));
  const userData = path.join(root, 'userdata');
  const projectRoot = path.join(root, 'alpha');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  return {
    root,
    userData,
    projectRoot,
    ownerDb: path.join(root, 'owner.sqlite'),
    knowledgeDb: path.join(root, 'knowledge.sqlite')
  };
};

const safeRemove = (target) => {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    console.warn(`[IDEAS-#95] kept state: ${target}`);
  }
};

const seed = ({ ownerDb, knowledgeDb, projectRoot, userData }) => {
  const owner = new OwnerStore(ownerDb);
  try {
    owner.registerProject({ id: 'alpha', name: 'Alpha Repo', root: projectRoot });
  } finally {
    owner.close();
  }
  // 知识库只需要存在：收件箱的取数不依赖它。
  new PersonalKnowledgeStore(knowledgeDb).close();
  fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({
    projectId: 'alpha',
    gatewayUrl: 'http://127.0.0.1:18789',
    model: '',
    includePaths: ['package.json'],
    mascotSkin: 'erika'
  }, null, 2));
};

/** 面板里能看到的收件箱 DOM 快照（不含库内字段）。 */
const readInbox = (panel) => panel.evaluate(`(() => ({
  badge: document.getElementById('queueBadge')?.textContent ?? '',
  badgeTitle: document.getElementById('queueBadge')?.title ?? '',
  hint: document.getElementById('ideaHint')?.hidden
    ? '' : (document.getElementById('ideaHint')?.textContent ?? ''),
  input: document.getElementById('ideaInput')?.value ?? '',
  groups: [...document.querySelectorAll('#ideaList .idea-group-title')]
    .map((node) => node.textContent),
  rows: [...document.querySelectorAll('#ideaList .queue-item')].map((node) => ({
    id: node.dataset.id,
    status: node.dataset.status,
    source: node.dataset.source,
    title: node.querySelector('.queue-title')?.textContent ?? '',
    statusLabel: node.querySelector('.queue-status')?.textContent ?? '',
    sourceLabel: node.querySelector('.queue-source')?.textContent ?? '',
    time: node.querySelector('.queue-time')?.textContent ?? '',
    link: node.querySelector('.queue-link')?.textContent ?? '',
    actions: [...node.querySelectorAll('button[data-next]')].map((button) => button.dataset.next),
    promotes: [...node.querySelectorAll('button[data-promote]')].map((button) => button.dataset.promote),
    picks: [...node.querySelectorAll('select[data-idea-project]')].length
  }))
}))()`);

/** 库里的原始行：DOM 能改，读库才能证明「原文没被删」。 */
const readStore = async (ownerDb, id) => {
  const store = new OwnerStore(ownerDb);
  try {
    const item = store.getIdeaItem(id);
    return item ? {
      id: item.id,
      ideaStatus: item.ideaStatus,
      captureSource: item.captureSource,
      rawText: item.rawText,
      link: item.link,
      createdAt: item.createdAt,
      sortedAt: item.sortedAt
    } : null;
  } finally {
    store.close();
  }
};

const storeCount = (ownerDb) => {
  const store = new OwnerStore(ownerDb);
  try {
    return store.listIdeaInbox().length;
  } finally {
    store.close();
  }
};

const run = async () => {
  fs.mkdirSync(shotsDir, { recursive: true });
  const probe = { shotsDir, link: LINK, text: TEXT };
  const { root, userData, ownerDb, knowledgeDb, projectRoot } = makeRoot();
  seed({ ownerDb, knowledgeDb, projectRoot, userData });

  const app = await startApp({ ownerDb, knowledgeDb, userData, showPanel: true });
  const { panel } = app;
  try {
    await waitFor(panel, "document.querySelector('#modeBar button[data-mode=\"focus\"]')");
    await panel.evaluate("document.querySelector('#modeBar button[data-mode=\"focus\"]').click()");
    await waitFor(panel, "!document.getElementById('modeA').hidden");
    await waitFor(panel, "document.getElementById('queueBadge')?.textContent === '0'");
    await sleep(600);

    // 网络证据：CDP 记录请求，同时在渲染进程里钩住 fetch / XHR / sendBeacon。
    await panel.send('Network.enable');
    const netBefore = panel.events.filter((event) => event.method === 'Network.requestWillBeSent').length;
    await panel.evaluate(`(() => {
      window.__ideaNet = [];
      const originalFetch = window.fetch;
      window.fetch = (...args) => {
        window.__ideaNet.push(String(args[0]?.url ?? args[0]));
        return originalFetch.apply(window, args);
      };
      const open = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        window.__ideaNet.push(String(url));
        return open.call(this, method, url, ...rest);
      };
      const beacon = navigator.sendBeacon?.bind(navigator);
      if (beacon) {
        navigator.sendBeacon = (url, data) => {
          window.__ideaNet.push(String(url));
          return beacon(url, data);
        };
      }
      return true;
    })()`);

    // 等第一次快照把「空收件箱」提示画出来，再断言；否则读到的只是 HTML 初始值。
    await waitFor(panel, "document.getElementById('ideaHint')?.textContent.includes('收件箱是空的')");
    const empty = await readInbox(panel);
    probe.empty = empty;
    check('空收件箱有提示而不是一片空白', empty.hint.includes('收件箱是空的'), empty.hint);
    check('空收件箱徽章为 0', empty.badge === '0', empty.badge);
    await shotSection(panel, 'idea-inbox-empty.png', 760);

    // ① 粘贴文本：文本框里放整段话，点「存入」。
    await panel.evaluate(`(() => {
      const input = document.getElementById('ideaInput');
      input.value = ${JSON.stringify(TEXT)};
      document.getElementById('ideaCapture').click();
      return true;
    })()`);
    await waitFor(panel, "document.querySelectorAll('#ideaList .queue-item').length === 1");
    await sleep(500);
    const afterText = await readInbox(panel);
    probe.afterText = afterText;
    const textRow = afterText.rows.find((row) => row.status === 'inbox') ?? afterText.rows[0];
    check('文本入队后收件箱里有一条', afterText.rows.length === 1, JSON.stringify(afterText.rows));
    check('文本条目来源标为「粘贴」', textRow?.source === 'paste' && textRow?.sourceLabel === '粘贴',
      `${textRow?.source}/${textRow?.sourceLabel}`);
    check('文本条目状态是「收件箱」', textRow?.status === 'inbox' && textRow?.statusLabel === '收件箱');
    check('文本条目带时间', Boolean(textRow?.time), textRow?.time);
    check('文本条目只给合法的下一步（标记已整理）',
      JSON.stringify(textRow?.actions) === JSON.stringify(['sorted']), JSON.stringify(textRow?.actions));
    await shotSection(panel, 'idea-inbox-text.png', 900);

    const textStored = await readStore(ownerDb, textRow.id);
    probe.textStored = textStored;
    check('库里的原文与粘贴内容一致', textStored?.rawText === TEXT, textStored?.rawText);
    check('库里记了来源与时间', textStored?.captureSource === 'paste' && Boolean(textStored?.createdAt),
      `${textStored?.captureSource}/${textStored?.createdAt}`);

    // ② 粘贴链接：只存地址。
    await panel.evaluate(`(() => {
      const input = document.getElementById('ideaInput');
      input.value = ${JSON.stringify(LINK)};
      document.getElementById('ideaCapture').click();
      return true;
    })()`);
    await waitFor(panel, "document.querySelectorAll('#ideaList .queue-item').length === 2");
    await sleep(500);
    const afterLink = await readInbox(panel);
    probe.afterLink = afterLink;
    const linkRow = afterLink.rows.find((row) => row.source === 'link');
    check('链接条目来源标为「链接」', linkRow?.source === 'link' && linkRow?.sourceLabel === '链接',
      `${linkRow?.source}/${linkRow?.sourceLabel}`);
    check('链接条目在列表里露出地址本身',
      linkRow?.title === LINK && linkRow?.link === 'example.com',
      `${linkRow?.title} / ${linkRow?.link}`);
    const linkStored = await readStore(ownerDb, linkRow?.id ?? '');
    probe.linkStored = linkStored;
    check('库里只存链接、没有抓取结果',
      linkStored?.link === LINK && linkStored?.rawText === LINK,
      `${linkStored?.link} / ${linkStored?.rawText}`);
    check('链接条目没有整理结果（整理是下一张票）',
      linkStored?.ideaStatus === 'inbox' && !linkStored?.sortedAt,
      `${linkStored?.ideaStatus}/${linkStored?.sortedAt}`);
    await shotSection(panel, 'idea-inbox-link.png', 960);

    const netAfter = panel.events.filter((event) => event.method === 'Network.requestWillBeSent').length;
    const netUrls = panel.events
      .filter((event) => event.method === 'Network.requestWillBeSent')
      .map((event) => String(event.params?.request?.url ?? ''));
    const hooked = await panel.evaluate('window.__ideaNet.slice()');
    probe.network = {
      requestsDuringCapture: netAfter - netBefore,
      urls: netUrls.filter((url) => url.includes('example.com')),
      hooked
    };
    check('捕获期间没有向粘贴的链接发过请求',
      !netUrls.some((url) => url.includes('example.com')), netUrls.join(' | ').slice(0, 300));
    check('渲染进程的 fetch / XHR / sendBeacon 一次都没被调用',
      Array.isArray(hooked) && hooked.length === 0, JSON.stringify(hooked));

    // ③ 重复粘贴：同一段文本再来一次，不该多出第二条。
    const beforeDuplicate = storeCount(ownerDb);
    await panel.evaluate(`(() => {
      const input = document.getElementById('ideaInput');
      input.value = ${JSON.stringify(TEXT)};
      document.getElementById('ideaCapture').click();
      return true;
    })()`);
    await waitFor(panel, "document.getElementById('toast')?.textContent.includes('已经有这一条')");
    await sleep(600);
    const afterDuplicate = await readInbox(panel);
    probe.duplicate = {
      before: beforeDuplicate,
      after: storeCount(ownerDb),
      toast: await panel.evaluate("document.getElementById('toast')?.textContent ?? ''"),
      rows: afterDuplicate.rows.length
    };
    check('重复粘贴不新增条目', probe.duplicate.after === beforeDuplicate,
      `${beforeDuplicate} → ${probe.duplicate.after}`);
    check('重复粘贴时面板说清「已经有了」',
      probe.duplicate.toast.includes('已经有这一条'), probe.duplicate.toast);
    check('重复粘贴后列表仍是两条', afterDuplicate.rows.length === 2, String(afterDuplicate.rows.length));

    // ④ 非法流转：收件箱直接采纳。
    const illegalJump = await panel.evaluate(`(async () => {
      const snapshot = await window.companion.snapshot();
      const id = snapshot.ideas.groups[0].items[0].id;
      try {
        await window.companion.ideas.status({ id, status: 'adopted' });
        return { rejected: false, message: '' };
      } catch (error) {
        return { rejected: true, message: String(error?.message ?? error) };
      }
    })()`);
    probe.illegalJump = illegalJump;
    check('收件箱直接采纳被拒绝', illegalJump.rejected === true, illegalJump.message.slice(0, 200));
    check('拒绝原因写明从收件箱到已采纳',
      /cannot move from inbox to adopted/u.test(illegalJump.message), illegalJump.message.slice(0, 200));

    const stillInbox = await readStore(ownerDb, textRow.id);
    check('被拒的流转没有改动条目状态', stillInbox?.ideaStatus === 'inbox', stillInbox?.ideaStatus);

    // ⑤ 合法流转：文本条目 收件箱 → 已整理 → 已采纳。
    await panel.evaluate(`(() => {
      const row = document.querySelector('#ideaList .queue-item[data-id="${textRow.id}"]');
      row.querySelector('button[data-next="sorted"]').click();
      return true;
    })()`);
    await waitFor(panel, `document.querySelector('#ideaList .queue-item[data-id="${textRow.id}"]')?.dataset.status === 'sorted'`);
    await sleep(400);
    const afterSorted = await readInbox(panel);
    probe.afterSorted = afterSorted;
    const sortedRow = afterSorted.rows.find((row) => row.id === textRow.id);
    check('标记已整理后状态是「已整理」', sortedRow?.status === 'sorted' && sortedRow?.statusLabel === '已整理',
      `${sortedRow?.status}/${sortedRow?.statusLabel}`);
    // #97 起 adopted 只能经提升到达：已整理给「提升为知识 / 提升为任务 / 丢弃」，不再有空的「采纳」。
    check('已整理给 提升为知识 / 提升为任务 / 丢弃 三条去处',
      JSON.stringify(sortedRow?.promotes) === JSON.stringify(['knowledge', 'task'])
      && JSON.stringify(sortedRow?.actions) === JSON.stringify(['discarded']),
      `${JSON.stringify(sortedRow?.promotes)} / ${JSON.stringify(sortedRow?.actions)}`);
    await shotSection(panel, 'idea-inbox-sorted.png', 900);

    await panel.evaluate(`(() => {
      const row = document.querySelector('#ideaList .queue-item[data-id="${textRow.id}"]');
      row.querySelector('select[data-idea-project]').value = 'alpha';
      row.querySelector('button[data-promote="task"]').click();
      return true;
    })()`);
    await waitFor(panel, `document.querySelector('#ideaList .queue-item[data-id="${textRow.id}"]')?.dataset.status === 'adopted'`);
    await sleep(400);
    const adopted = await readStore(ownerDb, textRow.id);
    probe.adopted = adopted;
    check('采纳后库里状态是 adopted，原文还在',
      adopted?.ideaStatus === 'adopted' && adopted?.rawText === TEXT,
      `${adopted?.ideaStatus}/${adopted?.rawText}`);

    // 终端条目不许再回头：已采纳 → 丢弃。
    const illegalBack = await panel.evaluate(`(async () => {
      try {
        await window.companion.ideas.status({ id: ${JSON.stringify(textRow.id)}, status: 'discarded' });
        return { rejected: false, message: '' };
      } catch (error) {
        return { rejected: true, message: String(error?.message ?? error) };
      }
    })()`);
    probe.illegalBack = illegalBack;
    check('已采纳的条目不能再丢弃', illegalBack.rejected === true, illegalBack.message.slice(0, 200));
    check('拒绝原因写明从已采纳到已丢弃',
      /cannot move from adopted to discarded/u.test(illegalBack.message), illegalBack.message.slice(0, 200));

    // 链接条目：整理后丢弃。丢弃不删除原文/链接。
    await panel.evaluate(`(() => {
      const row = document.querySelector('#ideaList .queue-item[data-id="${linkRow.id}"]');
      row.querySelector('button[data-next="sorted"]').click();
      return true;
    })()`);
    await waitFor(panel, `document.querySelector('#ideaList .queue-item[data-id="${linkRow.id}"]')?.dataset.status === 'sorted'`);
    await sleep(300);
    await panel.evaluate(`(() => {
      const row = document.querySelector('#ideaList .queue-item[data-id="${linkRow.id}"]');
      row.querySelector('button[data-next="discarded"]').click();
      return true;
    })()`);
    await waitFor(panel, `document.querySelector('#ideaList .queue-item[data-id="${linkRow.id}"]')?.dataset.status === 'discarded'`);
    await sleep(500);
    const discarded = await readStore(ownerDb, linkRow.id);
    probe.discarded = discarded;
    const afterDiscard = await readInbox(panel);
    probe.afterDiscard = afterDiscard;
    const discardRow = afterDiscard.rows.find((row) => row.id === linkRow.id);
    check('丢弃后库里状态是 discarded，链接仍在',
      discarded?.ideaStatus === 'discarded' && discarded?.link === LINK && discarded?.rawText === LINK,
      `${discarded?.ideaStatus}/${discarded?.link}`);
    check('丢弃的条目仍留在「已整理」段里可查回',
      afterDiscard.groups.some((label) => label.startsWith('已整理')) && Boolean(discardRow),
      JSON.stringify(afterDiscard.groups));
    check('丢弃的条目显示「已丢弃」徽章', discardRow?.statusLabel === '已丢弃', discardRow?.statusLabel);
    check('丢弃的条目没有下一步按钮（终态）',
      JSON.stringify(discardRow?.actions) === JSON.stringify([]), JSON.stringify(discardRow?.actions));
    check('收件箱徽章归零、已整理记了两条',
      afterDiscard.badge === '0' && afterDiscard.badgeTitle.includes('已整理 2 条'),
      `${afterDiscard.badge} / ${afterDiscard.badgeTitle}`);
    await shotSection(panel, 'idea-inbox-discarded.png', 900);

    const finalCount = storeCount(ownerDb);
    probe.finalCount = finalCount;
    check('整轮下来库里只有两条（没有重复入队）', finalCount === 2, String(finalCount));

    const errors = consoleErrors(panel);
    probe.consoleErrors = errors;
    check('控制台无错误', errors.length === 0, errors.join(' | ').slice(0, 300));
  } finally {
    await app.stop();
  }
  safeRemove(root);

  fs.writeFileSync(path.join(shotsDir, 'idea-capture-probe.json'), JSON.stringify(probe, null, 2));
  if (failures.length) throw new Error(`${failures.length} assertion(s) failed`);
  console.log('[IDEAS-#95] PASS');
};

run().catch((error) => {
  console.error(`[IDEAS-#95] FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
