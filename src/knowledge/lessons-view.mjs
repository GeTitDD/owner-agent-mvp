// 完整工作台的经验浏览（#136）：只读视图模型与页面渲染。
//
// ADR-0015：系统性浏览放在工作台，卡片壳只保留 `/经验` 的流内查看与流内确认。
// 这里只读 knowledge_lessons（现象 → 机制 → 对策 + 证据），不写库、不提供
// 编辑 / 删除 / 审核入口，也不新增任何写路由。
//
// 两个消费方共用同一个视图模型：`GET /api/lessons` 直接回 JSON，
// `GET /lessons` 服务端渲染成页面（不依赖 Electron 或客户端脚本）。

import { flatText } from '../utils.mjs';
import { LESSON_STATUSES, lessonStatusLabel, lessonStatusOf } from '../lesson-status.mjs';

/** 一次最多渲染多少条经验：本地经验是几百条的规模，页面不跟着无限增长。 */
export const LESSONS_PAGE_LIMIT = 100;

/** 没有证据行时的固定说法：明示「追不到证据」，不伪装成待验证或已验证。 */
export const EVIDENCE_EMPTY_NOTE = '没有可追溯证据';

/** 证据摘要的展示长度：列表要能扫读，完整引用仍保留在 ref 里。 */
const EXCERPT_CHARS = 240;

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const oneLine = (value, max = 0) => flatText(value, max);

/** 时间倒序；时间相同按 id 兜底，保证同一份数据每次渲染顺序一致。 */
const newestFirst = (a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
  || String(a.id).localeCompare(String(b.id));

/**
 * 这条经验属于哪些项目：行上的 project_id、作用域里的项目，以及来源台账
 * （跨项目复现后经验行只挂在最早的项目下，第二个项目靠 payload.sources 反查，
 * 与 PersonalKnowledgeStore.listLessonsForProject 的口径一致）。
 */
const projectIdsOf = (lesson) => [...new Set([
  lesson?.scope?.projectId,
  lesson?.projectId,
  ...(Array.isArray(lesson?.sources) ? lesson.sources.map((source) => source?.projectId) : [])
].filter(Boolean).map(String))];

/** 一条经验的只读视图：把存储形态整理成页面能直接渲染的样子。 */
const toItem = (lesson) => {
  const recordedStatus = lessonStatusOf(lesson);
  const evidence = (Array.isArray(lesson.evidence) ? lesson.evidence : []).map((row) => ({
    id: String(row?.id ?? ''),
    ref: oneLine(row?.ref, 500),
    kind: oneLine(row?.kind, 40),
    excerpt: oneLine(row?.excerpt, EXCERPT_CHARS),
    recordId: oneLine(row?.recordId, 200)
  }));
  const evidenceEmpty = evidence.length === 0;
  // 没有证据行就看不到「待验证 / 已验证」：这两个状态的前提是有可追证据。
  // 展示状态退回 inferred（推断），状态名仍取自 lesson-status 那一份，不另造词。
  const status = evidenceEmpty && (recordedStatus === 'unverified' || recordedStatus === 'verified')
    ? 'inferred'
    : recordedStatus;
  const projectIds = projectIdsOf(lesson);
  return {
    id: String(lesson.id ?? ''),
    projectIds,
    projectId: projectIds[0] ?? null,
    // 跨项目复现的经验有多个来源项目：页面要把它们都列出来，不能只留第一个。
    projectLabel: projectIds.length ? projectIds.join(' · ') : '未记录',
    phenomenon: oneLine(lesson.phenomenon, 400) || '未命名经验',
    mechanism: oneLine(lesson.mechanism),
    countermeasure: oneLine(lesson.countermeasure),
    status,
    statusLabel: lessonStatusLabel(status),
    reproduced: lesson.reproduced === true,
    evidence,
    evidenceCount: evidence.length,
    evidenceEmpty,
    evidenceNote: evidenceEmpty ? EVIDENCE_EMPTY_NOTE : '',
    sourceRecordId: oneLine(lesson.sourceRecordId, 200),
    createdAt: lesson.createdAt ?? null
  };
};

/**
 * 组装经验浏览视图模型（纯函数）。
 *
 * @param {object} input
 * @param {object[]} [input.lessons] knowledge_lessons 行（含 evidence）
 * @param {string} [input.projectId] 当前筛选的项目；空串表示「全部项目」
 * @param {string} [input.status] 当前筛选的状态；空串表示「全部状态」
 * @param {number} [input.limit] 最多渲染多少条（计数仍按筛选后的全量）
 * @returns {object} 供 JSON 接口与页面共用的只读视图模型
 */
export function buildLessonsView({ lessons = [], projectId = '', status = '', limit = LESSONS_PAGE_LIMIT } = {}) {
  const filterProject = String(projectId ?? '');
  const filterStatus = String(status ?? '');
  const cap = Math.max(1, Number.isSafeInteger(limit) ? limit : LESSONS_PAGE_LIMIT);

  const items = lessons.map(toItem).sort(newestFirst);
  // 项目筛选先做，状态计数按项目口径算：切状态时数字不会突然变成全库的数字。
  const inProject = items.filter((item) => !filterProject || item.projectIds.includes(filterProject));
  const matched = inProject.filter((item) => !filterStatus || item.status === filterStatus);

  const statuses = LESSON_STATUSES.map((value) => ({
    value,
    label: lessonStatusLabel(value),
    count: inProject.filter((item) => item.status === value).length
  }));

  const projectCounts = new Map();
  for (const item of items) {
    for (const id of item.projectIds) projectCounts.set(id, (projectCounts.get(id) ?? 0) + 1);
  }
  const projects = [...projectCounts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

  const statusLabel = filterStatus ? lessonStatusLabel(filterStatus) : '';
  // 三种空：本地一条经验都没有、项目没有经验、当前状态没有经验；说法不同，不混成一句「没有数据」。
  let empty = null;
  if (!items.length) {
    empty = {
      kind: 'no-lessons',
      title: '本地还没有经验',
      detail: '经验来自执行记录的提炼；提炼出「现象 → 机制 → 对策」后会出现在这里。'
    };
  } else if (!inProject.length) {
    empty = {
      kind: 'no-project-lessons',
      title: `项目 ${filterProject} 还没有经验`,
      detail: '切回「全部项目」还能看到其他项目与领域级共享的经验。'
    };
  } else if (!matched.length) {
    empty = {
      kind: 'no-status-lessons',
      title: `没有处于「${statusLabel}」状态的经验`,
      detail: '状态读自经验的状态列；换一个状态或回到「全部状态」再看。'
    };
  }

  return {
    readOnly: true,
    filter: { projectId: filterProject, status: filterStatus, statusLabel },
    statuses,
    projects,
    totals: {
      all: items.length,
      project: inProject.length,
      shown: Math.min(matched.length, cap),
      evidenceEmpty: matched.filter((item) => item.evidenceEmpty).length
    },
    truncated: matched.length > cap,
    lessons: matched.slice(0, cap),
    empty
  };
}

/** 筛选链接：空值不进查询串，回到「全部」就是干净的 /lessons。 */
const filterHref = (params) => {
  const query = Object.entries(params)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return query ? `/lessons?${query}` : '/lessons';
};

/** 筛选条：全部 + 每个候选值一个链接，当前值高亮；只读页面用链接而不是表单。 */
const renderChips = (label, options) => `<div class="chips" role="group" aria-label="${escapeHtml(label)}">
    <span class="chips-label">${escapeHtml(label)}</span>
    ${options.map((option) => `<a class="chip${option.active ? ' chip-active' : ''}"${option.active ? ' aria-current="true"' : ''} href="${escapeHtml(option.href)}">${escapeHtml(option.text)}</a>`).join('')}
  </div>`;

const renderEvidence = (item) => {
  if (item.evidenceEmpty) return `<p class="evidence-empty">${escapeHtml(item.evidenceNote)}</p>`;
  const rows = item.evidence.map((row) => `<li>
        <code class="evidence-ref">${escapeHtml(row.ref)}</code>
        <span class="evidence-kind">${escapeHtml(row.kind || '未分类')}</span>
        <p class="evidence-excerpt">${row.excerpt ? escapeHtml(row.excerpt) : '（这条引用没有摘要）'}</p>
      </li>`).join('');
  return `<ul class="evidence-list">${rows}</ul>`;
};

const renderLesson = (item) => `<article class="lesson" id="lesson-${escapeHtml(item.id)}">
    <header class="lesson-head">
      <h2>${escapeHtml(item.phenomenon)}</h2>
      <p class="lesson-meta">
        <span class="badge status-${escapeHtml(item.status)}">${escapeHtml(item.statusLabel)}</span>
        ${item.reproduced ? '<span class="badge badge-reproduced" title="独立证据支持同一现象在多个项目出现；不代表机制或对策已经验证">已复现</span>' : ''}
        <span>来源项目 <code>${escapeHtml(item.projectLabel)}</code></span>
        ${item.createdAt ? `<span>创建于 ${escapeHtml(String(item.createdAt).replace('T', ' ').slice(0, 19))}</span>` : ''}
      </p>
    </header>
    <dl class="lesson-detail">
      <div><dt>机制</dt><dd>${item.mechanism ? escapeHtml(item.mechanism) : '（还没有写机制）'}</dd></div>
      <div><dt>对策</dt><dd>${item.countermeasure ? escapeHtml(item.countermeasure) : '（还没有写对策）'}</dd></div>
    </dl>
    <section class="lesson-evidence">
      <h3>证据 <small>${item.evidenceCount} 条</small></h3>
      ${renderEvidence(item)}
    </section>
  </article>`;

/** 空状态：把「为什么空」写清楚，而不是留一片空白列表。 */
const renderEmpty = (empty) => `<p class="empty"><strong>${escapeHtml(empty.title)}</strong><br />${escapeHtml(empty.detail)}</p>`;

/**
 * 服务端渲染 `/lessons`：与 `/observer` 同一套路子——页面上没有脚本、没有表单，
 * 筛选靠链接，数据在渲染时一次取全，Electron 没运行也能直接用浏览器打开。
 */
export function renderLessonsPage(view) {
  const projectOptions = [
    { text: `全部项目 ${view.totals.all}`, href: filterHref({ status: view.filter.status }), active: !view.filter.projectId },
    ...view.projects.map((project) => ({
      text: `${project.id} ${project.count}`,
      href: filterHref({ projectId: project.id, status: view.filter.status }),
      active: view.filter.projectId === project.id
    }))
  ];
  const statusOptions = [
    { text: `全部状态 ${view.totals.project}`, href: filterHref({ projectId: view.filter.projectId }), active: !view.filter.status },
    ...view.statuses.map((status) => ({
      text: `${status.label} ${status.count}`,
      href: filterHref({ projectId: view.filter.projectId, status: status.value }),
      active: view.filter.status === status.value
    }))
  ];

  const list = view.empty
    ? renderEmpty(view.empty)
    : `<div class="lessons">${view.lessons.map(renderLesson).join('')}</div>`;
  const truncation = view.truncated
    ? `<p class="truncated">只展示前 ${view.lessons.length} 条；用项目或状态筛选把范围缩小。</p>`
    : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>经验浏览 · Owner Workbench</title>
<link rel="stylesheet" href="/lessons.css" />
</head>
<body>
<header class="page-head">
  <div>
    <p class="eyebrow">Owner · Lessons</p>
    <h1>经验浏览</h1>
    <p class="sub">共 ${view.totals.all} 条经验 · 当前筛选 ${view.totals.project} 条 · 其中 ${view.totals.evidenceEmpty} 条没有可追溯证据 · 只读</p>
  </div>
  <p class="head-actions"><a href="/">返回工作台</a></p>
</header>
<main>
  <section class="panel" aria-label="筛选">
    ${renderChips('项目', projectOptions)}
    ${renderChips('状态', statusOptions)}
  </section>
  <section class="panel" aria-label="经验列表">
    ${list}
    ${truncation}
  </section>
  <p class="footnote">这里只读：看机制、对策与证据。编辑、审核与确认仍在对话流内完成（ADR-0015）。</p>
</main>
</body>
</html>`;
}
