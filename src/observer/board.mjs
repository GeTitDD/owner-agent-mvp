// 观察台视图模型与页面渲染（纯函数）。
//
// ADR-0002：同一事实只存一处。这里只读 #27 已经落库的项目登记与观察事件，
// 每次请求现算视图，不缓存任何结论。
// ADR-0003 / T5：`GET /observer` 由服务端直接渲染卡片与事件流，
// 页面不发起阻塞式客户端请求，所以 Electron 未启动也能用浏览器打开。
import { DEFAULT_STALE_THRESHOLD_DAYS } from './events.mjs';

/** 单页最多展示多少条当天事件；审计表可以无限长，页面不跟着膨胀。 */
export const BOARD_EVENT_LIMIT = 200;

/** 事件类型的中文标签；未知类型原样显示，新增事件类型时页面不会崩。 */
const EVENT_TYPE_LABELS = { stale: '停滞' };

/** 卡片排序：先看风险，再看停了多久，最后按名字稳定排序。 */
const RISK_ORDER = { stale: 0, watch: 1, unknown: 2 };

const pad = (value) => String(value).padStart(2, '0');
const parseTime = (value) => {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : 0;
};

/** 本地日期 YYYY-MM-DD；「当天事件流」按用户本地日历判断，而不是 UTC。 */
const localDay = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const formatDateTime = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return `${localDay(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const eventTypeLabel = (type) => EVENT_TYPE_LABELS[type] ?? String(type ?? '');

/**
 * 风险徽章：只把审计库里的停滞天数与阈值比一比，不在这里重新判断「是否停滞」。
 * 没有事件不等于健康，只能标「未观测」，否则页面会说谎。
 */
const riskBadge = ({ daysStale, thresholdDays }) => {
  if (!Number.isFinite(daysStale)) return { level: 'unknown', label: '未观测', daysStale: null };
  return daysStale >= thresholdDays
    ? { level: 'stale', label: '停滞', daysStale }
    : { level: 'watch', label: '关注', daysStale };
};

const summarizeEvent = (event) => ({
  id: event.id,
  projectId: event.projectId,
  projectName: event.projectName || event.projectId,
  type: event.type,
  typeLabel: eventTypeLabel(event.type),
  branchLabel: event.branchLabel || event.branch || '',
  daysStale: event.daysStale ?? null,
  detectedAt: event.detectedAt
});

const compareCards = (a, b) => RISK_ORDER[a.risk.level] - RISK_ORDER[b.risk.level]
  || (b.daysStale ?? -1) - (a.daysStale ?? -1)
  || a.name.localeCompare(b.name);

/**
 * 把项目登记与观察事件拼成观察台视图。
 * @param {{projects?:object[], events?:object[], now?:Date, thresholdDays?:number}} [options]
 * @returns {{generatedAt:string, date:string, thresholdDays:number, projects:object[], events:object[]}}
 */
export function buildBoardViewModel({
  projects = [],
  events = [],
  now = new Date(),
  thresholdDays = DEFAULT_STALE_THRESHOLD_DAYS
} = {}) {
  if (!Number.isFinite(thresholdDays) || thresholdDays < 0) throw new Error('Invalid stale threshold');
  const today = localDay(now);
  // 审计库按字符串倒序返回；这里再按真实时间排一次，带时区偏移的时间戳不会被字典序排错。
  const ordered = [...events].sort((a, b) => (parseTime(b.detectedAt) - parseTime(a.detectedAt))
    || String(a.id).localeCompare(String(b.id)));

  const latestByProject = new Map();
  for (const event of ordered) {
    if (!latestByProject.has(event.projectId)) latestByProject.set(event.projectId, event);
  }

  const cards = projects.map((project) => {
    const lastEvent = latestByProject.get(project.id) ?? null;
    return {
      id: String(project.id),
      name: project.name || String(project.id),
      root: project.root ?? '',
      status: project.status ?? '',
      branch: lastEvent?.branchLabel || lastEvent?.branch || '',
      lastCommitAt: lastEvent?.lastCommitAt ?? null,
      daysStale: lastEvent?.daysStale ?? null,
      lastEvent: lastEvent ? summarizeEvent(lastEvent) : null,
      risk: riskBadge({ daysStale: lastEvent?.daysStale ?? null, thresholdDays })
    };
  }).sort(compareCards);

  return {
    generatedAt: new Date(now).toISOString(),
    date: today,
    thresholdDays,
    projects: cards,
    events: ordered.filter((event) => localDay(event.detectedAt) === today).map(summarizeEvent)
  };
}

const badgeText = (risk) => (risk.daysStale === null ? risk.label : `${risk.label} ${risk.daysStale} 天`);

const renderCard = (card) => `<article class="card risk-${card.risk.level}">
  <header class="card-head">
    <div>
      <h3>${escapeHtml(card.name)}</h3>
      <p class="card-id">${escapeHtml(card.id)}</p>
    </div>
    <span class="badge badge-${card.risk.level}">${escapeHtml(badgeText(card.risk))}</span>
  </header>
  <dl class="card-meta">
    <div><dt>仓库</dt><dd class="path">${escapeHtml(card.root || '—')}</dd></div>
    <div><dt>分支</dt><dd>${escapeHtml(card.branch || '未采集')}</dd></div>
    <div><dt>最后提交</dt><dd>${escapeHtml(card.lastCommitAt ? formatDateTime(card.lastCommitAt) : '—')}</dd></div>
    <div><dt>最近事件</dt><dd>${card.lastEvent
      ? `${escapeHtml(card.lastEvent.typeLabel)} · ${escapeHtml(formatDateTime(card.lastEvent.detectedAt))}`
      : '从未观测'}</dd></div>
  </dl>
</article>`;

const renderEventRow = (event) => `<tr>
  <td class="when">${escapeHtml(formatDateTime(event.detectedAt))}</td>
  <td><span class="who">${escapeHtml(event.projectName)}</span> <span class="card-id">${escapeHtml(event.projectId)}</span></td>
  <td><span class="badge badge-${event.type === 'stale' ? 'stale' : 'unknown'}">${escapeHtml(event.typeLabel)}</span></td>
  <td>${escapeHtml(event.branchLabel || '—')}</td>
  <td>${escapeHtml(Number.isFinite(event.daysStale) ? `${event.daysStale} 天` : '—')}</td>
</tr>`;

/**
 * 渲染完整观察台页面。首屏自带全部卡片与当天事件，不依赖客户端 fetch。
 * @param {ReturnType<typeof buildBoardViewModel>} view
 * @returns {string} HTML
 */
export function renderBoardPage(view) {
  const staleCount = view.projects.filter((project) => project.risk.level === 'stale').length;
  const unknownCount = view.projects.filter((project) => project.risk.level === 'unknown').length;
  const cards = view.projects.length
    ? `<div class="cards">${view.projects.map(renderCard).join('')}</div>`
    : `<p class="empty">还没有登记项目。在仓库根目录运行
      <code>node bin/ownerctl.mjs register --id &lt;id&gt; --name &lt;名称&gt; --root &lt;目录&gt;</code>
      登记后再刷新本页。</p>`;
  const events = view.events.length
    ? `<table class="events">
    <thead><tr><th>发生时间</th><th>项目</th><th>类型</th><th>分支</th><th>停滞</th></tr></thead>
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
    <p class="sub">已登记 ${view.projects.length} 个项目 · 停滞 ${staleCount} · 未观测 ${unknownCount} · 停滞阈值 ${view.thresholdDays} 天</p>
  </div>
  <div class="head-actions">
    <p class="stamp">生成于 ${escapeHtml(formatDateTime(view.generatedAt))}</p>
    <a class="refresh" href="/observer">重新读取</a>
  </div>
</header>
<main>
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
