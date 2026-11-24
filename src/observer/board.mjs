// 观察台视图模型与页面渲染（纯函数）。
//
// ADR-0002：同一事实只存一处。这里只读 #27 已经落库的项目登记与观察事件，
// 每次请求现算视图，不缓存任何结论。
// ADR-0003 / T5：`GET /observer` 由服务端直接渲染卡片与事件流，
// 页面不发起阻塞式客户端请求，所以 Electron 未启动也能用浏览器打开。
// #32：三类事件各自成徽章，卡片按风险分排序，页面顶部直接指出最该看的项目。
import { mergeThresholds } from './thresholds.mjs';
import {
  EVENT_TYPES,
  EVENT_TYPE_LIST,
  EVENT_TYPE_NAMES,
  eventTypeLabel
} from './event-types.mjs';
import { formatLocalDateTime, localDayKey } from './time.mjs';

/** 单页最多展示多少条当天事件；审计表可以无限长，页面不跟着膨胀。 */
export const BOARD_EVENT_LIMIT = 200;

/** 非事件类型的风险等级文案；事件类型的中文标签从注册表补齐。 */
const LEVEL_LABELS = {
  critical: '多重风险',
  watch: '关注',
  unknown: '未观测'
};
for (const spec of EVENT_TYPE_LIST) LEVEL_LABELS[spec.riskLevel] = spec.label;

/** 同分时的稳定次序：多重风险最先，事件类型按注册表次序，最后是关注/未观测。 */
const LEVEL_ORDER = {
  critical: 0,
  ...Object.fromEntries(EVENT_TYPE_LIST.map((spec) => [spec.riskLevel, spec.order + 1])),
  watch: EVENT_TYPE_LIST.length + 1,
  unknown: EVENT_TYPE_LIST.length + 2
};

/** 卡片排序：风险分高的在前，再看等级、停滞天数，最后按名字稳定排序。 */
const compareCards = (a, b) => b.risk.score - a.risk.score
  || LEVEL_ORDER[a.risk.level] - LEVEL_ORDER[b.risk.level]
  || (b.daysStale ?? -1) - (a.daysStale ?? -1)
  || a.name.localeCompare(b.name);

const parseTime = (value) => {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : 0;
};

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

/** 事件的度量文本：停滞看天数，漂移看落后提交，积压看未提交文件。 */
const eventMeasure = (event) => {
  const spec = EVENT_TYPES[event?.type];
  if (!spec) return '—';
  const value = Number.isFinite(event[spec.field]) ? event[spec.field] : 0;
  return `${value} ${spec.unit}`;
};

/** 把某类事件的最近一条观测折成一条风险信号；越线与否只跟阈值比，不重做判定。 */
const toSignal = (type, event, limits) => {
  const spec = EVENT_TYPES[type];
  const value = Number.isFinite(event[spec.field]) ? event[spec.field] : 0;
  const threshold = limits[spec.threshold];
  return {
    type,
    label: eventTypeLabel(type),
    value,
    unit: spec.unit,
    threshold,
    crossing: spec.reaches(value, threshold),
    badge: spec.badge(value),
    phrase: spec.phrase(value),
    detectedAt: event.detectedAt
  };
};

/** 风险等级：越线信号越多越危险；有观测但都没越线只是「关注」，没观测才叫「未观测」。 */
const levelOf = (signals) => {
  const crossing = signals.filter((signal) => signal.crossing);
  if (crossing.length > 1) return 'critical';
  if (crossing.length === 1) return crossing[0].type;
  return signals.length ? 'watch' : 'unknown';
};

/** 徽章文案：越线的列出具体度量；只是关注就在前面加「关注」，未观测直接写明。 */
const badgeOf = (level, signals) => {
  if (level === 'unknown') return LEVEL_LABELS.unknown;
  const shown = level === 'watch' ? signals : signals.filter((signal) => signal.crossing);
  const text = shown.map((signal) => signal.badge).join(' · ');
  return level === 'watch' ? `关注 · ${text}` : text;
};

/**
 * 风险徽章与风险分：风险分 = 越线信号数量（同时命中越多越危险）。
 * 没有事件不等于健康，只能标「未观测」，否则页面会说谎。
 */
const scoreRisk = (signals) => {
  const level = levelOf(signals);
  return {
    level,
    label: LEVEL_LABELS[level],
    score: signals.filter((signal) => signal.crossing).length,
    badge: badgeOf(level, signals),
    daysStale: signals.find((signal) => signal.type === 'stale')?.value ?? null,
    signals
  };
};

const summarizeEvent = (event) => ({
  id: event.id,
  projectId: event.projectId,
  projectName: event.projectName || event.projectId,
  type: event.type,
  typeLabel: eventTypeLabel(event.type),
  branchLabel: event.branchLabel || event.branch || '',
  daysStale: event.daysStale ?? null,
  measure: eventMeasure(event),
  detectedAt: event.detectedAt,
  updatedAt: event.updatedAt ?? event.detectedAt
});

/**
 * 顶部结论：最该看的项目与一句原因；没有越线项目时给出明确的空状态。
 * 只描述事实：未观测的项目不能算作健康。
 */
const buildHeadline = (cards) => {
  const top = cards.find((card) => card.risk.score > 0) ?? null;
  if (top) {
    const reasons = top.risk.signals.filter((signal) => signal.crossing)
      .map((signal) => signal.phrase);
    return {
      kind: 'risk',
      projectId: top.id,
      projectName: top.name,
      level: top.risk.level,
      score: top.risk.score,
      reason: `${top.risk.score > 1 ? '同时' : ''}${reasons.join('、')}`
    };
  }
  if (!cards.length) {
    return { kind: 'unregistered', reason: '还没有登记项目，暂无风险可评。' };
  }
  const unknown = cards.filter((card) => card.risk.level === 'unknown').length;
  return {
    kind: 'empty',
    reason: unknown
      ? `当前没有越过阈值的风险项目；另有 ${unknown} 个项目从未观测，不能算健康。`
      : '当前没有越过阈值的风险项目。'
  };
};

/**
 * 把项目登记与观察事件拼成观察台视图。
 * @param {{projects?:object[], events?:object[], now?:Date, thresholdDays?:number,
 *   thresholds?:{staleDays:number, driftCommits:number, backlogFiles:number}}} [options]
 * @returns {{generatedAt:string, date:string, thresholdDays:number, thresholds:object,
 *   headline:object, riskCount:number, unknownCount:number, projects:object[], events:object[]}}
 */
export function buildBoardViewModel({
  projects = [],
  events = [],
  now = new Date(),
  thresholdDays,
  thresholds = {}
} = {}) {
  // thresholdDays 是 #31 的旧入口，等价于 thresholds.staleDays。
  const limits = mergeThresholds({
    ...(thresholds ?? {}),
    ...(thresholdDays === undefined ? {} : { staleDays: thresholdDays })
  });

  const today = localDayKey(now);
  // 审计库按字符串倒序返回；这里再按真实时间排一次，带时区偏移的时间戳不会被字典序排错。
  // 证据刷新时间（updatedAt）也算「更近」：冷却窗口内重复命中的事件不会被旧行遮住。
  const ordered = [...events].sort((a, b) => (parseTime(b.updatedAt ?? b.detectedAt)
    - parseTime(a.updatedAt ?? a.detectedAt))
    || String(a.id).localeCompare(String(b.id)));

  // 每个项目、每类事件各取最近一条：停滞与积压可以同时存在，不能只留最近那一条。
  const latestByProject = new Map();
  const latestByType = new Map();
  for (const event of ordered) {
    const projectId = String(event.projectId);
    if (!latestByProject.has(projectId)) latestByProject.set(projectId, event);
    let byType = latestByType.get(projectId);
    if (!byType) {
      byType = new Map();
      latestByType.set(projectId, byType);
    }
    if (!byType.has(event.type)) byType.set(event.type, event);
  }

  const cards = projects.map((project) => {
    const id = String(project.id);
    const lastEvent = latestByProject.get(id) ?? null;
    const byType = latestByType.get(id) ?? new Map();
    const signals = EVENT_TYPE_NAMES
      .filter((type) => byType.has(type))
      .map((type) => toSignal(type, byType.get(type), limits));
    const risk = scoreRisk(signals);
    return {
      id,
      name: project.name || id,
      root: project.root ?? '',
      status: project.status ?? '',
      branch: lastEvent?.branchLabel || lastEvent?.branch || '',
      lastCommitAt: lastEvent?.lastCommitAt ?? null,
      daysStale: risk.daysStale,
      lastEvent: lastEvent ? summarizeEvent(lastEvent) : null,
      risk
    };
  }).sort(compareCards);

  return {
    generatedAt: new Date(now).toISOString(),
    date: today,
    thresholdDays: limits.staleDays,
    thresholds: limits,
    headline: buildHeadline(cards),
    riskCount: cards.filter((card) => card.risk.score > 0).length,
    unknownCount: cards.filter((card) => card.risk.level === 'unknown').length,
    projects: cards,
    events: ordered.filter((event) => localDayKey(event.detectedAt) === today).map(summarizeEvent)
  };
}

/** 卡片上的信号清单：三类观测各自成行，越线的排在前面。 */
const signalLines = (signals) => [...signals]
  .sort((a, b) => Number(b.crossing) - Number(a.crossing))
  .map((signal) => escapeHtml(signal.badge))
  .join(' · ');

const renderCard = (card) => `<article class="card risk-${card.risk.level}">
  <header class="card-head">
    <div>
      <h3>${escapeHtml(card.name)}</h3>
      <p class="card-id">${escapeHtml(card.id)}</p>
    </div>
    <span class="badge badge-${card.risk.level}">${escapeHtml(card.risk.badge)}</span>
  </header>
  <dl class="card-meta">
    <div><dt>仓库</dt><dd class="path">${escapeHtml(card.root || '—')}</dd></div>
    <div><dt>分支</dt><dd>${escapeHtml(card.branch || '未采集')}</dd></div>
    <div><dt>最后提交</dt><dd>${escapeHtml(card.lastCommitAt ? formatLocalDateTime(card.lastCommitAt) : '—')}</dd></div>
    <div><dt>风险信号</dt><dd>${card.risk.signals.length ? signalLines(card.risk.signals) : '从未观测'}</dd></div>
    <div><dt>最近事件</dt><dd>${card.lastEvent
      ? `${escapeHtml(card.lastEvent.typeLabel)} · ${escapeHtml(formatLocalDateTime(card.lastEvent.detectedAt))}`
      : '从未观测'}</dd></div>
  </dl>
</article>`;

const renderEventRow = (event) => `<tr>
  <td class="when">${escapeHtml(formatLocalDateTime(event.detectedAt))}</td>
  <td><span class="who">${escapeHtml(event.projectName)}</span> <span class="card-id">${escapeHtml(event.projectId)}</span></td>
  <td><span class="badge badge-${EVENT_TYPES[event.type] ? event.type : 'unknown'}">${escapeHtml(event.typeLabel)}</span></td>
  <td>${escapeHtml(event.branchLabel || '—')}</td>
  <td>${escapeHtml(event.measure)}</td>
</tr>`;

/**
 * 顶部结论：直接回答「现在最该看的是哪个项目」。
 * 没有越线项目时给出明确空状态，而不是留白。
 */
const renderHeadline = (headline) => `<section class="panel attention risk-${headline.kind === 'risk' ? headline.level : 'none'}" aria-labelledby="attention-heading">
    <h2 id="attention-heading">最该看的项目</h2>
    ${headline.kind === 'risk'
    ? `<p class="attention-name">${escapeHtml(headline.projectName)}</p>
    <p class="attention-reason">${escapeHtml(headline.reason)}</p>`
    : `<p class="empty">${escapeHtml(headline.reason)}</p>`}
  </section>`;

/**
 * 渲染完整观察台页面。首屏自带全部卡片与当天事件，不依赖客户端 fetch。
 * @param {ReturnType<typeof buildBoardViewModel>} view
 * @returns {string} HTML
 */
export function renderBoardPage(view) {
  const cards = view.projects.length
    ? `<div class="cards">${view.projects.map(renderCard).join('')}</div>`
    : `<p class="empty">还没有登记项目。在仓库根目录运行
      <code>node bin/ownerctl.mjs register --id &lt;id&gt; --name &lt;名称&gt; --root &lt;目录&gt;</code>
      登记后再刷新本页。</p>`;
  const events = view.events.length
    ? `<table class="events">
    <thead><tr><th>发生时间</th><th>项目</th><th>类型</th><th>分支</th><th>度量</th></tr></thead>
    <tbody>${view.events.map(renderEventRow).join('')}</tbody>
  </table>`
    : '<p class="empty">今日暂无事件。</p>';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>观察台 · 项目与事件</title>
<link rel="stylesheet" href="/observer.css" />
</head>
<body>
<header class="board-head">
  <div>
    <p class="eyebrow">Owner · Observer</p>
    <h1>观察台</h1>
    <p class="sub">已登记 ${view.projects.length} 个项目 · 风险 ${view.riskCount} · 未观测 ${view.unknownCount} · 阈值 ${view.thresholds.staleDays} 天 / ${view.thresholds.driftCommits} 提交 / ${view.thresholds.backlogFiles} 文件</p>
  </div>
  <div class="head-actions">
    <p class="stamp">生成于 ${escapeHtml(formatLocalDateTime(view.generatedAt))}</p>
    <a class="refresh" href="/observer">重新读取</a>
  </div>
</header>
<main>
  ${renderHeadline(view.headline)}
  <section class="panel" aria-labelledby="projects-heading">
    <h2 id="projects-heading">项目</h2>
    ${cards}
  </section>
  <section class="panel" aria-labelledby="events-heading">
    <h2 id="events-heading">今日事件 <small>${escapeHtml(view.date)}</small></h2>
    ${events}
  </section>
</main>
</body>
</html>`;
}
