// #96 验收：灵感整理的链接守卫、抓取四段、缓存与重试。
//
// 断言七件事：
//   ① 带链接的条目点「整理链接」：抓一次正文，写成「问题 / 想法 / 预期收益 / 风险」四段，
//      原文与链接一字不改，状态推进到「已整理」；
//   ② 四段里缺一段时（页面没有「风险」）明确标「缺」并写原因，不留空、不编；
//   ③ 同一条目二次整理不再发请求：缓存落在条目上，fetch.attempts 仍是 1；
//   ④ 内网地址、带凭证 / file: / javascript: 的链接一律拒绝并发不出去请求，原因可见；
//   ⑤ 抓取失败（503）时条目保持原状（仍在收件箱、没有整理结果），人再点一次能成功；
//   ⑥ 控制台无错误。
// 抓取走 OWNER_COMPANION_FAKE_SORT=1 的预置页面：验收不访问外网，守卫与限时/限大/四段全走真路径。
// 全程用临时 userData + 临时 owner / 知识库，截图与探针写到 SHOTS_DIR（缺省 mm-notes/shots-96）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OwnerStore } from '../../src/owner-store.mjs';
import { PersonalKnowledgeStore } from '../../src/personal-store.mjs';
import { guardIdeaLink } from '../../src/idea-sort.mjs';
import { capture, consoleErrors, createChecker, sleep, startApp, waitFor } from './lib/cdp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const shotsDir = process.env.SHOTS_DIR
  ?? path.resolve(repoRoot, '..', '..', 'mm-notes', 'shots-96');
const { check, failures } = createChecker('[IDEAS-#96]');

const LINK = 'https://example.com/ideas/96-four-sections';
const NO_RISK = 'https://example.com/ideas/96-no-risk';
const FLAKY = 'https://example.com/ideas/96-flaky';
const INTERNAL = 'http://192.168.1.10/admin';

const shot = async (panel, file) => capture(panel, path.join(shotsDir, file));

/** 面板是 440×640 的固定窗口：临时把视口抬高，把收件箱整段截进一张图。 */
const shotSection = async (panel, file, height = 1000) => {
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
  const base = process.env.TMP_96 ?? os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'idea-sort-'));
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
    console.warn(`[IDEAS-#96] kept state: ${target}`);
  }
};

/** 预置三条「链接来路不明」的条目：file: / javascript: / 带凭证。捕获入口不会产生它们，
 *  但库里可能早就有（旧数据、别的写入方），整理时同样要挡住。 */
const seed = ({ ownerDb, knowledgeDb, projectRoot, userData }) => {
  const owner = new OwnerStore(ownerDb);
  try {
    owner.registerProject({ id: 'alpha', name: 'Alpha Repo', root: projectRoot });
    for (const link of [
      'file:///C:/Windows/win.ini',
      'javascript:alert(document.cookie)',
      'https://owner:secret@example.com/private'
    ]) {
      owner.addIdeaItem({
        title: link,
        rawText: link,
        captureSource: 'link',
        link
      });
    }
  } finally {
    owner.close();
  }
  new PersonalKnowledgeStore(knowledgeDb).close();
  fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({
    projectId: 'alpha',
    gatewayUrl: 'http://127.0.0.1:18789',
    model: '',
    includePaths: ['package.json'],
    mascotSkin: 'erika'
  }, null, 2));
};

/** 面板里能看到的收件箱 DOM 快照。 */
const readInbox = (panel) => panel.evaluate(`(() => ({
  badge: document.getElementById('queueBadge')?.textContent ?? '',
  toast: document.getElementById('toast')?.hidden
    ? '' : (document.getElementById('toast')?.textContent ?? ''),
  groups: [...document.querySelectorAll('#ideaList .idea-group-title')]
    .map((node) => node.textContent),
  rows: [...document.querySelectorAll('#ideaList .queue-item')].map((node) => ({
    id: node.dataset.id,
    status: node.dataset.status,
    source: node.dataset.source,
    title: node.querySelector('.queue-title')?.textContent ?? '',
    statusLabel: node.querySelector('.queue-status')?.textContent ?? '',
    link: node.querySelector('.queue-link')?.textContent ?? '',
    actions: [...node.querySelectorAll('button[data-next]')].map((button) => button.dataset.next),
    sortable: Boolean(node.querySelector('button[data-sort]')),
    sortLabel: node.querySelector('button[data-sort]')?.textContent ?? '',
    sortedMeta: node.querySelector('.idea-sorted-meta')?.textContent ?? '',
    sections: [...node.querySelectorAll('.idea-section')].map((section) => ({
      key: section.dataset.section,
      missing: section.dataset.missing === 'true',
      label: section.querySelector('.idea-section-label')?.textContent ?? '',
      text: section.querySelector('.idea-section-text')?.textContent ?? '',
      reason: section.querySelector('.idea-section-missing')?.textContent ?? ''
    }))
  }))
}))()`);

/** 库里的原始行：DOM 能改，读库才能证明原文没被改动、缓存落在条目上。 */
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
      sortedAt: item.sortedAt,
      sorted: item.sorted
    } : null;
  } finally {
    store.close();
  }
};

const captureIdea = async (panel, text) => {
  await panel.evaluate(`(() => {
    const input = document.getElementById('ideaInput');
    input.value = ${JSON.stringify(text)};
    document.getElementById('ideaCapture').click();
    return true;
  })()`);
};

const clickSort = (panel, id) => panel.evaluate(`(() => {
  const row = document.querySelector('#ideaList .queue-item[data-id="${id}"]');
  const button = row?.querySelector('button[data-sort]');
  if (!button) return false;
  button.click();
  return true;
})()`);

/** 提示条会留 4~7 秒：下一次动作前先清空，否则会读到上一条的原因。 */
const clearToast = (panel) => panel.evaluate(`(() => {
  const node = document.getElementById('toast');
  if (node) { node.textContent = ''; node.hidden = true; }
  return true;
})()`);

/**
 * 提示条只在几秒内可见，截图/读 DOM 都可能错过；这里在页面里记一份历史，
 * 断言读的是「这次动作期间出现过的提示」，不跟计时器赛跑。
 */
const installToastRecorder = (panel) => panel.evaluate(`(() => {
  window.__toasts = [];
  const node = document.getElementById('toast');
  const record = () => {
    const text = node && !node.hidden ? node.textContent : '';
    if (text && window.__toasts[window.__toasts.length - 1] !== text) window.__toasts.push(text);
  };
  if (node) {
    new MutationObserver(record).observe(node, {
      childList: true, characterData: true, attributes: true, subtree: true
    });
  }
  setInterval(record, 120);
  return true;
})()`);
const toastMark = async (panel) => (await panel.evaluate('(window.__toasts ?? []).length')) ?? 0;
const toastsSince = async (panel, mark) =>
  (await panel.evaluate(`(window.__toasts ?? []).slice(${mark})`)) ?? [];
const waitToast = async (panel, mark) => waitFor(panel, `(window.__toasts ?? []).length > ${mark}`, 15000);

const waitRow = async (panel, id, timeoutMs = 15000) => {
  const ok = await waitFor(panel, `document.querySelector('#ideaList .queue-item[data-id="${id}"]')`, timeoutMs);
  if (!ok) throw new Error(`row not found: ${id}`);
};

const idOf = async (panel, title) => {
  const inbox = await readInbox(panel);
  return inbox.rows.find((row) => row.title === title)?.id ?? '';
};

const run = async () => {
  fs.mkdirSync(shotsDir, { recursive: true });
  const probe = { shotsDir, link: LINK, noRisk: NO_RISK, flaky: FLAKY, internal: INTERNAL };
  const { root, userData, ownerDb, knowledgeDb, projectRoot } = makeRoot();
  seed({ ownerDb, knowledgeDb, projectRoot, userData });

  const app = await startApp({
    ownerDb,
    knowledgeDb,
    userData,
    showPanel: true,
    env: { OWNER_COMPANION_FAKE_SORT: '1' }
  });
  const { panel } = app;
  try {
    await waitFor(panel, "document.querySelector('#modeBar button[data-mode=\"focus\"]')");
    await panel.evaluate("document.querySelector('#modeBar button[data-mode=\"focus\"]').click()");
    await waitFor(panel, "!document.getElementById('modeA').hidden");
    // 三条预置条目先出现，确认库通了再往里加。
    await waitFor(panel, "document.querySelectorAll('#ideaList .queue-item').length === 3");
    await installToastRecorder(panel);
    await sleep(400);

    // ① 正常链接：抓一次正文，四段齐全。
    await captureIdea(panel, LINK);
    await waitFor(panel, "document.querySelectorAll('#ideaList .queue-item').length === 4");
    await sleep(400);
    const linkId = await idOf(panel, LINK);
    probe.linkId = linkId;
    check('链接条目在收件箱里，带「整理链接」按钮', Boolean(linkId), String(linkId));
    const beforeSort = await readStore(ownerDb, linkId);
    check('整理前没有整理结果', beforeSort?.ideaStatus === 'inbox' && !beforeSort?.sorted,
      `${beforeSort?.ideaStatus}/${JSON.stringify(beforeSort?.sorted)}`);

    await waitRow(panel, linkId);
    await clickSort(panel, linkId);
    await waitFor(panel, `document.querySelector('#ideaList .queue-item[data-id="${linkId}"]')?.dataset.status === 'sorted'`);
    await sleep(600);
    const afterLink = await readInbox(panel);
    probe.afterLink = afterLink;
    const linkRow = afterLink.rows.find((row) => row.id === linkId);
    check('整理后状态是「已整理」', linkRow?.status === 'sorted' && linkRow?.statusLabel === '已整理',
      `${linkRow?.status}/${linkRow?.statusLabel}`);
    check('四段齐全：问题 / 想法 / 预期收益 / 风险',
      JSON.stringify(linkRow?.sections.map((section) => section.label))
        === JSON.stringify(['问题', '想法', '预期收益', '风险']),
      JSON.stringify(linkRow?.sections.map((section) => section.label)));
    check('四段都有正文，没有「缺」标记',
      linkRow?.sections.every((section) => !section.missing && section.text.length > 0),
      JSON.stringify(linkRow?.sections.map((section) => [section.missing, section.text.length])));
    check('面板写明只抓了 1 次', (linkRow?.sortedMeta ?? '').includes('抓取 1 次'), linkRow?.sortedMeta);
    check('已整理条目给的是「重新整理」（正文已缓存）',
      linkRow?.sortable === true && linkRow?.sortLabel === '重新整理', linkRow?.sortLabel);
    await shotSection(panel, 'idea-sort-four-sections.png', 1100);

    const linkStored = await readStore(ownerDb, linkId);
    probe.linkStored = linkStored;
    check('原文与链接一字不改',
      linkStored?.rawText === LINK && linkStored?.link === LINK,
      `${linkStored?.rawText} / ${linkStored?.link}`);
    check('库里四段齐全，抓取记了 1 次',
      linkStored?.sorted?.complete === true
      && linkStored?.sorted?.sections.length === 4
      && linkStored?.sorted?.fetch?.attempts === 1,
      `${linkStored?.sorted?.complete}/${linkStored?.sorted?.fetch?.attempts}`);

    // ② 二次整理：缓存生效，不再发请求。
    await clearToast(panel);
    await waitRow(panel, linkId);
    const cachedMark = await toastMark(panel);
    await clickSort(panel, linkId);
    await waitToast(panel, cachedMark);
    await sleep(500);
    const cachedToasts = await toastsSince(panel, cachedMark);
    const afterCached = await readInbox(panel);
    probe.afterCached = { ...afterCached, toasts: cachedToasts };
    const cachedStored = await readStore(ownerDb, linkId);
    check('二次整理时面板说清用的是上次抓到的正文',
      cachedToasts.some((text) => text.includes('没再请求')), cachedToasts.join(' | '));
    check('二次整理后抓取次数仍是 1（缓存生效，没有新请求）',
      cachedStored?.sorted?.fetch?.attempts === 1, String(cachedStored?.sorted?.fetch?.attempts));
    check('二次整理没有改动原文',
      cachedStored?.rawText === LINK, cachedStored?.rawText);
    await shotSection(panel, 'idea-sort-cached.png', 1100);

    // ③ 缺段：页面里没有「风险」。
    await captureIdea(panel, NO_RISK);
    await waitFor(panel, "document.querySelectorAll('#ideaList .queue-item').length === 5");
    await sleep(400);
    const noRiskId = await idOf(panel, NO_RISK);
    await clearToast(panel);
    await waitRow(panel, noRiskId);
    const noRiskMark = await toastMark(panel);
    await clickSort(panel, noRiskId);
    await waitFor(panel, `document.querySelector('#ideaList .queue-item[data-id="${noRiskId}"]')?.dataset.status === 'sorted'`);
    await waitToast(panel, noRiskMark);
    await sleep(500);
    const noRiskToasts = await toastsSince(panel, noRiskMark);
    const afterNoRisk = await readInbox(panel);
    probe.afterNoRisk = { ...afterNoRisk, toasts: noRiskToasts };
    const noRiskRow = afterNoRisk.rows.find((row) => row.id === noRiskId);
    const riskSection = noRiskRow?.sections.find((section) => section.key === 'risk');
    check('缺的那段标了「缺」并写明原因',
      riskSection?.missing === true && /没有「风险」这一段/u.test(riskSection?.reason ?? ''),
      `${riskSection?.missing}/${riskSection?.reason}`);
    check('其余三段照常有内容',
      noRiskRow?.sections.filter((section) => !section.missing).length === 3,
      JSON.stringify(noRiskRow?.sections.map((section) => section.missing)));
    check('缺段时面板也说了缺几段',
      noRiskToasts.some((text) => text.includes('缺 1 段')), noRiskToasts.join(' | '));
    await shotSection(panel, 'idea-sort-missing-risk.png', 1100);

    // ④ 守卫：内网地址、file:、javascript:、带凭证，每种各一条证据。
    await captureIdea(panel, INTERNAL);
    await waitFor(panel, "document.querySelectorAll('#ideaList .queue-item').length === 6");
    await sleep(400);
    const guardTargets = [
      { title: INTERNAL, label: '内网地址', pattern: /192\.168\.0\.0\/16/u },
      { title: 'file:///C:/Windows/win.ini', label: 'file://', pattern: /file:/u },
      { title: 'javascript:alert(document.cookie)', label: 'javascript:', pattern: /javascript:/u },
      { title: 'https://owner:secret@example.com/private', label: '带凭证', pattern: /用户名或密码/u }
    ];
    probe.guard = [];
    for (const target of guardTargets) {
      const id = await idOf(panel, target.title);
      await clearToast(panel);
      await waitRow(panel, id);
      const mark = await toastMark(panel);
      await clickSort(panel, id);
      await waitToast(panel, mark);
      await sleep(400);
      const toasts = await toastsSince(panel, mark);
      const toast = toasts.join(' | ');
      const stored = await readStore(ownerDb, id);
      probe.guard.push({
        label: target.label, title: target.title, toasts,
        ideaStatus: stored?.ideaStatus, sorted: stored?.sorted
      });
      check(`${target.label} 被拒绝且给出原因`, target.pattern.test(toast), toast);
      check(`${target.label} 被拒后条目还在收件箱、没有整理结果`,
        stored?.ideaStatus === 'inbox' && !stored?.sorted,
        `${stored?.ideaStatus}/${JSON.stringify(stored?.sorted)}`);
      // 一次只截最后一条的提示，前面几条的证据在探针里。
      if (target === guardTargets[guardTargets.length - 1]) {
        await shotSection(panel, 'idea-sort-guard-blocked.png', 1100);
      }
    }
    check('被拒的条目一条都没有整理结果',
      probe.guard.every((entry) => !entry.sorted && entry.ideaStatus === 'inbox'),
      JSON.stringify(probe.guard.map((entry) => entry.ideaStatus)));

    // ⑤ 抓取失败：条目保持原状，再点一次成功。
    await captureIdea(panel, FLAKY);
    await waitFor(panel, "document.querySelectorAll('#ideaList .queue-item').length === 7");
    await sleep(400);
    const flakyId = await idOf(panel, FLAKY);
    await clearToast(panel);
    await waitRow(panel, flakyId);
    const flakyMark = await toastMark(panel);
    await clickSort(panel, flakyId);
    await waitToast(panel, flakyMark);
    await sleep(500);
    const failedToasts = await toastsSince(panel, flakyMark);
    const failedToast = failedToasts.join(' | ');
    const failedStored = await readStore(ownerDb, flakyId);
    probe.failed = { toasts: failedToasts, stored: failedStored };
    check('抓取失败时写明状态码', /503/u.test(failedToast), failedToast);
    check('抓取失败时条目没脏：还在收件箱、没有整理结果',
      failedStored?.ideaStatus === 'inbox' && !failedStored?.sorted && failedStored?.rawText === FLAKY,
      `${failedStored?.ideaStatus}/${JSON.stringify(failedStored?.sorted)}`);
    const failedRow = (await readInbox(panel)).rows.find((row) => row.id === flakyId);
    check('抓取失败后仍可再点「整理链接」重试',
      failedRow?.sortable === true && (failedRow?.sections ?? []).length === 0,
      `${failedRow?.sortable}/${(failedRow?.sections ?? []).length}`);
    await shotSection(panel, 'idea-sort-fetch-failed.png', 1100);

    await clearToast(panel);
    await waitRow(panel, flakyId);
    const retryMark = await toastMark(panel);
    await clickSort(panel, flakyId);
    await waitFor(panel, `document.querySelector('#ideaList .queue-item[data-id="${flakyId}"]')?.dataset.status === 'sorted'`);
    await waitToast(panel, retryMark);
    await sleep(600);
    const retried = await readStore(ownerDb, flakyId);
    probe.retried = retried;
    check('人再点一次就能整理成功（重试由人触发）',
      retried?.ideaStatus === 'sorted' && retried?.sorted?.complete === true,
      `${retried?.ideaStatus}/${retried?.sorted?.complete}`);
    check('重试成功记的是第 1 次成功抓取', retried?.sorted?.fetch?.attempts === 1,
      String(retried?.sorted?.fetch?.attempts));
    await shotSection(panel, 'idea-sort-retry-ok.png', 1100);

    // 守卫本身再单独过一遍（纯函数，四种各一条），并与图上看到的一致。
    probe.guardVerdicts = [INTERNAL, 'file:///C:/Windows/win.ini', 'javascript:alert(1)',
      'https://owner:secret@example.com/private'].map((value) => {
      const verdict = guardIdeaLink(value);
      return { value, ok: verdict.ok, code: verdict.code, reason: verdict.reason };
    });
    check('守卫的四种拒绝与面板提示一致',
      probe.guardVerdicts.every((entry) => entry.ok === false && Boolean(entry.reason)),
      JSON.stringify(probe.guardVerdicts));

    const errors = consoleErrors(panel);
    probe.consoleErrors = errors;
    check('控制台无错误', errors.length === 0, errors.join(' | ').slice(0, 300));
  } finally {
    await app.stop();
  }
  safeRemove(root);

  fs.writeFileSync(path.join(shotsDir, 'idea-sort-probe.json'), JSON.stringify(probe, null, 2));
  if (failures.length) throw new Error(`${failures.length} assertion(s) failed`);
  console.log('[IDEAS-#96] PASS');
};

run().catch((error) => {
  console.error(`[IDEAS-#96] FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
