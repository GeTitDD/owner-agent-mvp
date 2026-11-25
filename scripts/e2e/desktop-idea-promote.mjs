// #97 验收：已整理的灵感 → 知识候选（假设类）或项目队列任务。
//
// 断言六件事：
//   ① 提升为知识后，候选队列里出现这一条，kind=hypothesis、带来源灵感 id；
//      灵感状态变 adopted，候选走既有审核（未被直接写成已验证知识）；
//   ② 候选之后被拒：灵感仍是 adopted，不回滚，也不改四段结果；
//   ③ 提升为任务前没选项目：被拦住并给提示，灵感状态不变、没有偷偷进默认项目；
//   ④ 选了项目再提升：任务落进那个项目的队列，灵感变 adopted；
//   ⑤ 提升前后 raw_text / sorted_result / capture_source / link_url 四个字段完全一致；
//   ⑥ 控制台无错误。
//
// 全程临时 userData + 临时 owner / 知识库，不联网；截图与探针写到 SHOTS_DIR
// （缺省 mm-notes/shots-97）。知识候选出现在知识模式的候选组里，另截一张。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OwnerStore } from '../../src/owner-store.mjs';
import { PersonalKnowledgeStore } from '../../src/personal-store.mjs';
import { capture, consoleErrors, createChecker, sleep, startApp, waitFor } from './lib/cdp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const shotsDir = process.env.SHOTS_DIR
  ?? path.resolve(repoRoot, '..', '..', 'mm-notes', 'shots-97');
const { check, failures } = createChecker('[IDEAS-#97]');

const SECTIONS = [
  { key: 'problem', label: '问题', text: '灵感存下来只有一句话，回头看不出为什么重要。', missing: false, reason: '' },
  { key: 'idea', label: '想法', text: '整理后提升为知识或任务，不必重新读全文。', missing: false, reason: '' },
  { key: 'benefit', label: '预期收益', text: '决定去留时能直接对照四段与原文。', missing: false, reason: '' },
  { key: 'risk', label: '风险', text: '提升不改原文；候选被拒也不回滚灵感。', missing: false, reason: '' }
];

const shot = async (panel, file) => capture(panel, path.join(shotsDir, file));

/** 面板是 440×640 的固定窗口：临时抬高视口，把一整段截进一张图。 */
const shotSection = async (panel, file, target = 'queueSection', height = 1000) => {
  await panel.send('Emulation.setDeviceMetricsOverride', {
    width: 440, height, deviceScaleFactor: 1, mobile: false
  });
  await panel.evaluate(`document.getElementById('${target}')?.scrollIntoView({ block: 'start' })`);
  await sleep(400);
  await shot(panel, file);
  await panel.send('Emulation.clearDeviceMetricsOverride');
  await sleep(200);
};

const makeRoot = () => {
  const base = process.env.TMP_97 ?? os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'idea-promote-'));
  const userData = path.join(root, 'userdata');
  const alphaRoot = path.join(root, 'alpha');
  const betaRoot = path.join(root, 'beta');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(alphaRoot, { recursive: true });
  fs.mkdirSync(betaRoot, { recursive: true });
  return {
    root,
    userData,
    alphaRoot,
    betaRoot,
    ownerDb: path.join(root, 'owner.sqlite'),
    knowledgeDb: path.join(root, 'knowledge.sqlite')
  };
};

const safeRemove = (target) => {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    console.warn(`[IDEAS-#97] kept state: ${target}`);
  }
};

const addSorted = (owner, {
  title, rawText, projectId = null, link = ''
}) => {
  const item = owner.addIdeaItem({
    title,
    rawText,
    projectId,
    captureSource: link ? 'link' : 'paste',
    link
  });
  owner.updateIdeaItem(item.id, {
    sorted: {
      version: 1,
      at: '2026-11-25T00:00:00.000Z',
      source: link ? 'link' : 'text',
      link,
      sections: SECTIONS,
      missing: [],
      complete: true,
      note: '',
      fetch: null
    }
  });
  return owner.setIdeaStatus(item.id, 'sorted');
};

const seed = ({ ownerDb, knowledgeDb, alphaRoot, betaRoot, userData }) => {
  const owner = new OwnerStore(ownerDb);
  try {
    owner.registerProject({ id: 'alpha', name: 'Alpha Repo', root: alphaRoot });
    owner.registerProject({ id: 'beta', name: 'Beta Repo', root: betaRoot });
    const knowledge = addSorted(owner, {
      title: '把灵感提升为知识候选',
      rawText: '已整理的灵感也应该能进知识流，而不是只能留在收件箱里。',
      projectId: 'alpha',
      link: 'https://example.com/ideas/97-knowledge'
    });
    const task = addSorted(owner, {
      title: '把灵感提升为任务',
      rawText: '「现在就该做」的那部分灵感需要一个任务出口。'
    });
    const noProject = addSorted(owner, {
      title: '没选项目时不许提升为任务',
      rawText: '没项目就不能提升为任务，也不该默默丢进默认项目。'
    });
    new PersonalKnowledgeStore(knowledgeDb).close();
    fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({
      projectId: 'alpha',
      gatewayUrl: 'http://127.0.0.1:18789',
      model: '',
      includePaths: ['package.json'],
      mascotSkin: 'erika'
    }, null, 2));
    return { knowledge, task, noProject };
  } finally {
    owner.close();
  }
};

/** 面板里能看到的收件箱 DOM 快照。 */
const readInbox = (panel) => panel.evaluate(`(() => ({
  toast: document.getElementById('toast')?.hidden
    ? '' : (document.getElementById('toast')?.textContent ?? ''),
  rows: [...document.querySelectorAll('#ideaList .queue-item')].map((node) => ({
    id: node.dataset.id,
    status: node.dataset.status,
    title: node.querySelector('.queue-title')?.textContent ?? '',
    promotes: [...node.querySelectorAll('button[data-promote]')].map((button) => button.dataset.promote),
    picks: [...node.querySelectorAll('select[data-idea-project]')].map((select) => select.value),
    actions: [...node.querySelectorAll('button[data-next]')].map((button) => button.dataset.next)
  }))
}))()`);

/** 库里的原始行：提升前后对比这四个字段，DOM 改不了库。 */
const readStore = async (ownerDb, id) => {
  const store = new OwnerStore(ownerDb);
  try {
    const item = store.getIdeaItem(id);
    return item ? {
      id: item.id,
      ideaStatus: item.ideaStatus,
      rawText: item.rawText,
      sortedResult: JSON.stringify(item.sorted),
      captureSource: item.captureSource,
      link: item.link,
      sortedAt: item.sortedAt,
      projectId: item.projectId
    } : null;
  } finally {
    store.close();
  }
};
const frozen = (row) => row && ({
  rawText: row.rawText,
  sortedResult: row.sortedResult,
  captureSource: row.captureSource,
  link: row.link
});

const readQueue = async (ownerDb, projectId) => {
  const store = new OwnerStore(ownerDb);
  try {
    return store.listProjectQueue(projectId, 'task').map((row) => ({
      id: row.id, kind: row.kind, source: row.source, body: row.body, projectId: row.projectId
    }));
  } finally {
    store.close();
  }
};

const readProposals = async (knowledgeDb, ideaId) => {
  const personal = new PersonalKnowledgeStore(knowledgeDb);
  try {
    return personal.proposals('pending')
      .filter((row) => row?.meta?.sourceIdeaId === ideaId)
      .map((row) => ({
        id: row.id,
        status: row.status,
        kind: row.payload?.kind,
        layer: row.payload?.layer,
        projectId: row.payload?.projectId,
        sourceRef: row.payload?.sourceRef,
        content: row.payload?.content,
        meta: { contract: row.meta?.contract, sourceIdeaId: row.meta?.sourceIdeaId }
      }));
  } finally {
    personal.close();
  }
};

/** 提示条会留几秒：动作前清空，动作后读历史，不跟计时器赛跑。 */
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
const clearToast = (panel) => panel.evaluate(`(() => {
  const node = document.getElementById('toast');
  if (node) { node.textContent = ''; node.hidden = true; }
  return true;
})()`);

const waitRow = async (panel, id, timeoutMs = 15000) => {
  const ok = await waitFor(panel, `document.querySelector('#ideaList .queue-item[data-id="${id}"]')`, timeoutMs);
  if (!ok) throw new Error(`row not found: ${id}`);
};

const run = async () => {
  fs.mkdirSync(shotsDir, { recursive: true });
  const probe = { shotsDir };
  const { root, userData, ownerDb, knowledgeDb, alphaRoot, betaRoot } = makeRoot();
  const ids = seed({ ownerDb, knowledgeDb, alphaRoot, betaRoot, userData });
  probe.ids = { knowledge: ids.knowledge.id, task: ids.task.id, noProject: ids.noProject.id };

  const app = await startApp({ ownerDb, knowledgeDb, userData, showPanel: true });
  const { panel } = app;
  try {
    await waitFor(panel, "document.querySelector('#modeBar button[data-mode=\"focus\"]')");
    await panel.evaluate("document.querySelector('#modeBar button[data-mode=\"focus\"]').click()");
    await waitFor(panel, "!document.getElementById('modeA').hidden");
    await waitFor(panel, "document.querySelectorAll('#ideaList .queue-item').length === 3");
    await installToastRecorder(panel);
    await sleep(500);

    const beforeKnowledge = await readStore(ownerDb, ids.knowledge.id);
    probe.beforeKnowledge = beforeKnowledge;
    const rows = await readInbox(panel);
    const knowledgeRow = rows.rows.find((row) => row.id === ids.knowledge.id);
    check('已整理条目给出「提升为知识 / 提升为任务」两个动作',
      JSON.stringify(knowledgeRow?.promotes) === JSON.stringify(['knowledge', 'task']),
      JSON.stringify(knowledgeRow?.promotes));
    check('有项目的条目不显示项目选择框', (knowledgeRow?.picks ?? []).length === 0,
      JSON.stringify(knowledgeRow?.picks));

    // ① 提升为知识。
    await clearToast(panel);
    await waitRow(panel, ids.knowledge.id);
    const knowledgeMark = await toastMark(panel);
    await panel.evaluate(`(() => {
      const row = document.querySelector('#ideaList .queue-item[data-id="${ids.knowledge.id}"]');
      row.querySelector('button[data-promote="knowledge"]').click();
      return true;
    })()`);
    await waitFor(panel, `document.querySelector('#ideaList .queue-item[data-id="${ids.knowledge.id}"]')?.dataset.status === 'adopted'`);
    await waitToast(panel, knowledgeMark);
    await sleep(600);
    const knowledgeToasts = await toastsSince(panel, knowledgeMark);
    probe.knowledgeToasts = knowledgeToasts;
    check('面板说清已提升为知识候选（假设类）',
      knowledgeToasts.some((text) => text.includes('知识候选') && text.includes('假设类')),
      knowledgeToasts.join(' | '));

    const proposals = await readProposals(knowledgeDb, ids.knowledge.id);
    probe.proposals = proposals;
    check('候选队列里出现这一条，且只有一条', proposals.length === 1, String(proposals.length));
    check('候选是假设类，走既有候选审核（pending、未验证）',
      proposals[0]?.kind === 'hypothesis' && proposals[0]?.status === 'pending',
      `${proposals[0]?.kind}/${proposals[0]?.status}`);
    check('候选带来源灵感 id',
      proposals[0]?.meta?.contract === 'knowledge-candidate/v1'
      && proposals[0]?.meta?.sourceIdeaId === ids.knowledge.id
      && proposals[0]?.sourceRef === `knowledge-loop:idea:${ids.knowledge.id}`,
      JSON.stringify(proposals[0]?.meta));
    check('候选正文带四段摘要与原文引用',
      ['问题', '想法', '预期收益', '风险'].every((label) => proposals[0]?.content.includes(label))
      && proposals[0]?.content.includes('原文：'),
      proposals[0]?.content?.slice(0, 80));

    const afterKnowledge = await readStore(ownerDb, ids.knowledge.id);
    probe.afterKnowledge = afterKnowledge;
    check('提升为知识后灵感状态是 adopted', afterKnowledge?.ideaStatus === 'adopted',
      afterKnowledge?.ideaStatus);
    check('提升前后四字段完全一致',
      JSON.stringify(frozen(afterKnowledge)) === JSON.stringify(frozen(beforeKnowledge)),
      JSON.stringify(frozen(afterKnowledge)).slice(0, 160));
    await clearToast(panel);
    await sleep(250);
    await shotSection(panel, 'idea-promote-knowledge.png', 'queueSection', 1000);

    // 候选在知识模式的候选组里真的可见。
    await panel.evaluate("document.querySelector('#modeBar button[data-mode=\"knowledge\"]').click()");
    await waitFor(panel, "document.querySelector('#kbGroups')?.textContent?.includes('把灵感提升为知识候选')");
    await sleep(400);
    await clearToast(panel);
    await shotSection(panel, 'idea-promote-knowledge-candidate.png', 'knowledgeBrowse', 660);
    probe.knowledgeBrowseText = await panel.evaluate(
      "(document.getElementById('kbGroups')?.textContent ?? '').slice(0, 400)"
    );
    await panel.evaluate("document.querySelector('#modeBar button[data-mode=\"focus\"]').click()");
    await waitFor(panel, "!document.getElementById('modeA').hidden");

    // ② 候选被拒：属于后续审核，不回滚灵感。
    const personal = new PersonalKnowledgeStore(knowledgeDb);
    try {
      personal.reviewProposal(proposals[0].id, { decision: 'rejected' });
    } finally {
      personal.close();
    }
    const afterReject = await readStore(ownerDb, ids.knowledge.id);
    probe.afterReject = afterReject;
    check('候选被拒后灵感仍是 adopted', afterReject?.ideaStatus === 'adopted', afterReject?.ideaStatus);
    check('候选被拒没有改动四字段',
      JSON.stringify(frozen(afterReject)) === JSON.stringify(frozen(beforeKnowledge)),
      JSON.stringify(frozen(afterReject)).slice(0, 160));

    // ③ 没项目时提升为任务：拦住并给提示，状态不变、没有进任何项目队列。
    await clearToast(panel);
    await waitRow(panel, ids.noProject.id);
    const noProjectMark = await toastMark(panel);
    await panel.evaluate(`(() => {
      const row = document.querySelector('#ideaList .queue-item[data-id="${ids.noProject.id}"]');
      row.querySelector('button[data-promote="task"]').click();
      return true;
    })()`);
    await waitToast(panel, noProjectMark);
    await sleep(400);
    const noProjectToasts = await toastsSince(panel, noProjectMark);
    probe.noProjectToasts = noProjectToasts;
    check('没选项目时明确拦住并给提示',
      noProjectToasts.some((text) => text.includes('还没有项目') && text.includes('选一个项目')),
      noProjectToasts.join(' | '));
    const noProjectStored = await readStore(ownerDb, ids.noProject.id);
    probe.noProjectStored = noProjectStored;
    check('被拦住后灵感状态不变', noProjectStored?.ideaStatus === 'sorted', noProjectStored?.ideaStatus);
    check('没有偷偷进默认项目',
      (await readQueue(ownerDb, 'alpha')).length === 0
      && (await readQueue(ownerDb, 'beta')).length === 0,
      `${(await readQueue(ownerDb, 'alpha')).length}/${(await readQueue(ownerDb, 'beta')).length}`);
    await shotSection(panel, 'idea-promote-needs-project.png', 'queueSection', 1000);

    // ④ 选了项目再提升为任务。
    const beforeTask = await readStore(ownerDb, ids.task.id);
    probe.beforeTask = beforeTask;
    const taskRows = await readInbox(panel);
    const taskRow = taskRows.rows.find((row) => row.id === ids.task.id);
    check('没项目的条目给出项目选择框', (taskRow?.picks ?? []).length === 1,
      JSON.stringify(taskRow?.picks));
    await clearToast(panel);
    await waitRow(panel, ids.task.id);
    const taskMark = await toastMark(panel);
    await panel.evaluate(`(() => {
      const row = document.querySelector('#ideaList .queue-item[data-id="${ids.task.id}"]');
      const select = row.querySelector('select[data-idea-project]');
      select.value = 'alpha';
      row.querySelector('button[data-promote="task"]').click();
      return true;
    })()`);
    await waitFor(panel, `document.querySelector('#ideaList .queue-item[data-id="${ids.task.id}"]')?.dataset.status === 'adopted'`);
    await waitToast(panel, taskMark);
    await sleep(600);
    const taskToasts = await toastsSince(panel, taskMark);
    probe.taskToasts = taskToasts;
    check('面板说清任务进了哪个项目',
      taskToasts.some((text) => text.includes('Alpha Repo') && text.includes('已采纳')),
      taskToasts.join(' | '));

    const alphaQueue = await readQueue(ownerDb, 'alpha');
    const betaQueue = await readQueue(ownerDb, 'beta');
    probe.alphaQueue = alphaQueue;
    check('任务落进选中的项目队列，且只有一条',
      alphaQueue.length === 1 && alphaQueue[0].kind === 'task' && betaQueue.length === 0,
      `${alphaQueue.length}/${betaQueue.length}`);
    check('任务带来源灵感 id 与四段摘要',
      alphaQueue[0]?.body.includes(`来源灵感：${ids.task.id}`)
      && ['问题', '想法', '预期收益', '风险'].every((label) => alphaQueue[0].body.includes(label)),
      alphaQueue[0]?.body?.slice(0, 100));

    const afterTask = await readStore(ownerDb, ids.task.id);
    probe.afterTask = afterTask;
    check('提升为任务后灵感状态是 adopted', afterTask?.ideaStatus === 'adopted', afterTask?.ideaStatus);
    check('提升为任务前后四字段完全一致',
      JSON.stringify(frozen(afterTask)) === JSON.stringify(frozen(beforeTask)),
      JSON.stringify(frozen(afterTask)).slice(0, 160));
    await shotSection(panel, 'idea-promote-task.png', 'queueSection', 1000);

    // ⑤ 知识提升前后四字段的对比直接记进探针，报告里引用同一份。
    check('知识提升前后四字段逐项一致（显式对比）',
      beforeKnowledge?.rawText === afterKnowledge?.rawText
      && beforeKnowledge?.sortedResult === afterKnowledge?.sortedResult
      && beforeKnowledge?.captureSource === afterKnowledge?.captureSource
      && beforeKnowledge?.link === afterKnowledge?.link,
      `raw=${beforeKnowledge?.rawText === afterKnowledge?.rawText}, `
      + `sorted=${beforeKnowledge?.sortedResult === afterKnowledge?.sortedResult}, `
      + `source=${beforeKnowledge?.captureSource === afterKnowledge?.captureSource}, `
      + `link=${beforeKnowledge?.link === afterKnowledge?.link}`);

    const errors = consoleErrors(panel);
    probe.consoleErrors = errors;
    check('控制台无错误', errors.length === 0, errors.join(' | ').slice(0, 300));
  } finally {
    await app.stop();
  }
  safeRemove(root);

  fs.writeFileSync(path.join(shotsDir, 'idea-promote-probe.json'), JSON.stringify(probe, null, 2));
  if (failures.length) throw new Error(`${failures.length} assertion(s) failed`);
  console.log('[IDEAS-#97] PASS');
};

run().catch((error) => {
  console.error(`[IDEAS-#97] FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
