// #139 定位屏：不选项目时，主内容是「先看哪个」的项目行，不是全局聚合数字。
//
// 这一层只做三件可测的事，不读库、不读 git、不碰 DOM：
// 1. 归因「待确认」：知识候选按 payload.projectId，或按来源经验归到项目；
//    决策候选直接读 #135 pendingSummary 的每项目计数。动作级确认（写入 / 外发 / 删除）
//    不在这两张表里，也不按候选合同收，所以不会让排序随一次写入抖动（ADR-0014）。
// 2. 把三类未读压成可读的行字段：读得到的给数字，读不到的给 null——绝不写成 0。
// 3. 算关注顺序：有待确认候选 > 有未读变化 > 超过 7 天未看 > 其余。
//    同级里按待确认数、未读数、上次看过时间排；没有置顶机制，就不在这里发明一个。
//
// 未读本身来自 src/memory/since-last-seen.mjs 的 previewSinceLastSeen（只读水位），
// 本文件只接收它算好的计数，不推进水位，也不触发任何扫描。

/** 陈旧阈值固定 7 天，不做配置项（ADR-0014）。 */
import { candidateProjectIds } from '../knowledge/candidate-view.mjs';

export const STALE_DAYS = 7;

/** 关注顺序的四档，顺序即优先级。 */
export const TIERS = Object.freeze(['pending', 'unread', 'stale', 'rest']);

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const asArray = (value) => (Array.isArray(value) ? value : []);

const text = (value) => (typeof value === 'string' ? value.trim() : '');

const oneLine = (value, max = 160) => String(value ?? '')
  .replace(/\s+/gu, ' ')
  .trim()
  .slice(0, max);

const toMillis = (value) => {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value.trim());
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
};

/** 数字或「读不到」：null 是未知，0 是真的没有，两者不能混。 */
const countOrNull = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

/**
 * 把 changeWindowView 的输出压成三类未读计数。
 *
 * 规则：某个探针读不到（没有仓库、没有水位、观察员事件读不出）时，那一类给 null；
 * 三类都读得到才给 total，否则 total 也是 null——不能拿「已知的一半」冒充总数。
 *
 * @param {object} view changeWindowView 的视图模型（或 IPC 回来的同一形状）
 * @returns {{commits:number|null, dirty:number|null, events:number|null,
 *   total:number|null, known:boolean, partial:boolean, unknownText:string,
 *   watermark:{known:boolean, at:string}}}
 */
export function unreadCountsOf(view = {}) {
  const source = view && typeof view === 'object' ? view : {};
  const probes = source.probes && typeof source.probes === 'object' ? source.probes : {};
  const counts = source.counts && typeof source.counts === 'object' ? source.counts : {};
  const probeOk = (key) => probes[key]?.ok === true;
  const pick = (key) => (probeOk(key) ? countOrNull(counts[key]) : null);
  const commits = pick('commits');
  const dirty = pick('dirty');
  const events = pick('events');
  const known = commits !== null && dirty !== null && events !== null;
  const anyKnown = commits !== null || dirty !== null || events !== null;
  const total = known ? commits + dirty + events : null;
  return {
    commits,
    dirty,
    events,
    total,
    known,
    partial: !known && anyKnown,
    // change-window 已经写清「算不全」的原因；没有就补一句通用的，界面不自己编。
    unknownText: text(source.unknownText) || (known ? '' : '这类变化读不到，先按未知看。'),
    watermark: {
      known: source.watermark?.known === true,
      at: text(source.watermark?.at)
    }
  };
}

const isKnowledgeCandidate = (proposal) => proposal?.meta?.contract === 'knowledge-candidate/v1';

const emptyPending = () => ({ knowledge: 0, decisions: 0, total: 0 });

/**
 * 待确认归因。
 *
 * - 知识候选：personal_proposals 里 status=pending 且 meta.contract=knowledge-candidate/v1 的记录。
 *   payload.projectId 有值就记那个项目；没有（域级 / 应用层候选）就沿 meta.sourceLessonIds
 *   找来源经验的项目，每个项目各记一条——一条候选可能同时是多个项目的未处理候选。
 *   域级候选没有来源经验时不归到任何项目：不能为了凑数把它算到第一个项目头上。
 * - 决策候选：#135 的 pendingSummary 已经按项目分好组，这里只取计数，不触发扫描。
 * - 动作级确认（写入 / 外发 / 删除）不是记忆候选，合同对不上，自然不计入。
 *
 * @param {object} [input]
 * @param {Array<object>} [input.proposals] personalStore.proposals() 的结果（pending 与已审过的都给也行）
 * @param {Array<object>} [input.lessons] 经验清单（至少带 id 与 projectId）
 * @param {object} [input.decisionSummary] pendingSummary() 的返回值
 * @returns {{byProject: Record<string, {knowledge:number, decisions:number, total:number}>}}
 */
export function pendingCountsOf({ proposals = [], lessons = [], decisionSummary = null } = {}) {
  const lessonById = new Map();
  for (const lesson of asArray(lessons)) {
    const id = text(lesson?.id);
    if (id) lessonById.set(id, lesson);
  }

  const byProject = {};
  const ensure = (projectId) => {
    if (!byProject[projectId]) byProject[projectId] = emptyPending();
    return byProject[projectId];
  };

  for (const proposal of asArray(proposals)) {
    if (proposal?.status !== 'pending' || !isKnowledgeCandidate(proposal)) continue;
    for (const projectId of candidateProjectIds(proposal, (id) => lessonById.get(id))) {
      ensure(projectId).knowledge += 1;
    }
  }

  for (const group of asArray(decisionSummary?.projects)) {
    const projectId = text(group?.projectId);
    const count = countOrNull(group?.count);
    if (!projectId || !count) continue;
    ensure(projectId).decisions += count;
  }

  for (const pending of Object.values(byProject)) {
    pending.total = pending.knowledge + pending.decisions;
  }
  return { byProject };
}

/**
 * 每个项目显示哪条「最近决策」。
 *
 * 项目自己的决策优先；没有时用域级决策兜底——域级决策对所有项目都生效，
 * 但不能让一条共享决策把项目自己更近的决策挤掉。
 *
 * @param {object} [input]
 * @param {Array<object>} [input.decisions] personalStore.listDecisions() 的结果（时间倒序最好）
 * @param {Array<{id:string}>} [input.projects] 已登记项目
 * @returns {Record<string, {id:string, title:string, status:string, at:string}|null>}
 */
export function latestDecisionsOf({ decisions = [], projects = [] } = {}) {
  const ordered = asArray(decisions).slice().sort((a, b) =>
    String(b?.updatedAt ?? '').localeCompare(String(a?.updatedAt ?? '')));
  const shared = ordered.find((decision) => text(decision?.scope) !== 'project') ?? null;
  const byProject = {};
  for (const project of asArray(projects)) {
    const id = text(project?.id);
    if (!id) continue;
    const own = ordered.find((decision) =>
      text(decision?.scope) === 'project' && text(decision?.projectId) === id) ?? shared;
    byProject[id] = own
      ? {
        id: text(own.id),
        title: oneLine(own.decision?.intent || own.title, 160) || '（没有标题的决策）',
        reason: oneLine(own.decision?.reason, 300),
        phenomenon: oneLine(own.title, 160),
        status: text(own.decisionStatus || own.verificationStatus),
        at: text(own.updatedAt)
      }
      : null;
  }
  return byProject;
}

/** 上次看过的时间说法：只由水位与当前时刻决定，不读时钟以外的东西。 */
const lastReadLabelOf = (lastReadMs, nowMs) => {
  if (lastReadMs === null) return '从未看过';
  const diff = nowMs - lastReadMs;
  if (diff < MINUTE_MS) return '刚刚看过';
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)} 分钟前看过`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)} 小时前看过`;
  if (diff < 2 * DAY_MS) return '昨天看过';
  return `${Math.floor(diff / DAY_MS)} 天前看过`;
};

/** 「超过 7 天」按毫秒判定：正好 7 天不算陈旧，多 1 秒就算。 */
const isStaleAt = (lastReadMs, nowMs) =>
  lastReadMs === null || nowMs - lastReadMs > STALE_DAYS * DAY_MS;

/** 陈旧行的「N 天未看」向上取整：只超过 7 天一点点时写 8 天，不写成「7 天」自相矛盾。 */
const staleDaysLabel = (lastReadMs, nowMs) => {
  if (lastReadMs === null) return '从未看过';
  return `${Math.ceil((nowMs - lastReadMs) / DAY_MS)} 天未看`;
};

/** 一条未读的读法：读不到的类别写「未知」，不写 0。 */
const unreadLabelOf = (unread) => {
  const part = (value, unit) => (value === null ? `未知 ${unit}` : `${value} ${unit}`);
  if (unread.known && unread.total === 0) return '没有未读变化';
  if (!unread.known && unread.total === null && unread.commits === null
    && unread.dirty === null && unread.events === null) {
    return '未读 未知';
  }
  return `未读 ${part(unread.commits, '提交')} · ${part(unread.dirty, '改动')} · ${part(unread.events, '知识')}`;
};

const pendingLabelOf = (pending) => {
  if (pending.total <= 0) return '没有待确认';
  if (pending.knowledge === 0) return `待确认 ${pending.total}（决策 ${pending.decisions}）`;
  if (pending.decisions === 0) return `待确认 ${pending.total}（知识 ${pending.knowledge}）`;
  return `待确认 ${pending.total}（知识 ${pending.knowledge} · 决策 ${pending.decisions}）`;
};

/** 已知未读之和：null（读不到）不参与相加，但只要有一类读到 > 0 就足以判断「确实有未读」。 */
const knownUnreadOf = (unread) => [unread?.commits, unread?.dirty, unread?.events]
  .reduce((sum, value) => (
    value === null || value === undefined ? sum : sum + Math.max(0, Number(value) || 0)
  ), 0);

/**
 * 一行的关注档位与理由。
 * - 已知的任一类未读 > 0 就算「有未读」：另一类读不到（total null）不能把它压回陈旧。
 * - 三类都读不到时不能替用户断言「有」，只能按上次看过时间排。
 * - 没有水位（从未看过）按陈旧处理：它比超过 7 天更久没被看过。
 */
const tierOf = ({ pending, unread, lastReadMs, nowMs }) => {
  if (pending.total > 0) return 'pending';
  if (knownUnreadOf(unread) > 0) return 'unread';
  if (isStaleAt(lastReadMs, nowMs)) return 'stale';
  return 'rest';
};

/** 每档内怎么排：理由越强越前；最后用项目名 / id 兜底，保证顺序稳定。 */
const compareRows = (a, b) => {
  const rank = TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier);
  if (rank !== 0) return rank;
  if (a.tier === 'pending') {
    const byPending = b.pending.total - a.pending.total;
    if (byPending !== 0) return byPending;
  }
  if (a.tier === 'pending' || a.tier === 'unread') {
    // 未读数按「已知三类之和」比：total 为 null 的项目也有可比的数字。
    const aUnread = knownUnreadOf(a.unread);
    const bUnread = knownUnreadOf(b.unread);
    if (aUnread !== bUnread) return bUnread - aUnread;
  }
  if (a.tier === 'stale') {
    // 越久没看越靠前；从未看过的（-Infinity）最靠前。
    const aMs = a.lastReadMs ?? Number.NEGATIVE_INFINITY;
    const bMs = b.lastReadMs ?? Number.NEGATIVE_INFINITY;
    if (aMs !== bMs) return aMs - bMs;
  }
  if (a.tier === 'rest') {
    // 刚看过的更可能还要接着看，排在前面；从未看过的不属于这一档。
    const aMs = a.lastReadMs ?? Number.NEGATIVE_INFINITY;
    const bMs = b.lastReadMs ?? Number.NEGATIVE_INFINITY;
    if (aMs !== bMs) return bMs - aMs;
  }
  return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN')
    || String(a.projectId).localeCompare(String(b.projectId));
};

const tierLabelOf = (tier, { pending, lastReadMs, nowMs }) => {
  if (tier === 'pending') return `待确认 ${pending.total}`;
  if (tier === 'unread') return '有未读';
  if (tier === 'stale') return staleDaysLabel(lastReadMs, nowMs);
  return '';
};

const emptyAttention = () => ({
  unread: {
    commits: null, dirty: null, events: null, total: null,
    known: false, partial: false, unknownText: '还没有读到这个项目的变化。',
    watermark: { known: false, at: '' }
  },
  lastReadAt: '',
  latestDecision: null
});

/**
 * 组装定位屏视图。
 *
 * @param {object} [input]
 * @param {Array<{id:string, name?:string}>} [input.projects] 已登记项目（含读不到变化的）
 * @param {Record<string, object>} [input.pending] pendingCountsOf().byProject
 * @param {Record<string, {unread:object, lastReadAt?:string, latestDecision?:object|null}>} [input.attention]
 *   每个项目的只读注意力数据；缺项的按「全部未知」处理，不把项目从列表里去掉
 * @param {string|number|Date} [input.now] 当前时刻（测试注入；默认现在）
 * @returns {object} 行式视图模型：排序、档位、标签都在这里定，渲染层只写 textContent
 */
export function locateScreenView({
  projects = [], pending = {}, attention = {}, now = new Date()
} = {}) {
  const nowMs = toMillis(now) ?? Date.now();
  const rows = [];
  for (const item of asArray(projects)) {
    const projectId = text(item?.id);
    if (!projectId) continue;
    const name = oneLine(item?.name, 120) || projectId;
    const viewed = attention?.[projectId] ?? emptyAttention();
    const unread = viewed.unread && typeof viewed.unread === 'object'
      ? {
        commits: viewed.unread.commits ?? null,
        dirty: viewed.unread.dirty ?? null,
        events: viewed.unread.events ?? null,
        total: viewed.unread.total ?? null,
        known: viewed.unread.known === true,
        partial: viewed.unread.partial === true,
        unknownText: text(viewed.unread.unknownText),
        watermark: viewed.unread.watermark ?? { known: false, at: '' }
      }
      : emptyAttention().unread;
    const lastReadAt = text(viewed.lastReadAt);
    const lastReadMs = toMillis(lastReadAt);
    const ownPending = pending?.[projectId] ?? emptyPending();
    const counts = {
      knowledge: Number(ownPending.knowledge) || 0,
      decisions: Number(ownPending.decisions) || 0
    };
    counts.total = counts.knowledge + counts.decisions;
    const tier = tierOf({ pending: counts, unread, lastReadMs, nowMs });
    const decision = viewed.latestDecision && typeof viewed.latestDecision === 'object'
      ? {
        id: text(viewed.latestDecision.id),
        title: oneLine(viewed.latestDecision.title, 160) || '（没有标题的决策）',
        reason: oneLine(viewed.latestDecision.reason, 300),
        phenomenon: oneLine(viewed.latestDecision.phenomenon, 160),
        status: text(viewed.latestDecision.status),
        at: text(viewed.latestDecision.at)
      }
      : null;
    rows.push({
      projectId,
      name,
      tier,
      tierRank: TIERS.indexOf(tier),
      tierLabel: tierLabelOf(tier, { pending: counts, lastReadMs, nowMs }),
      pending: counts,
      pendingLabel: pendingLabelOf(counts),
      unread,
      unreadLabel: unreadLabelOf(unread),
      lastReadAt,
      lastReadMs,
      lastReadLabel: lastReadLabelOf(lastReadMs, nowMs),
      stale: tier === 'stale',
      latestDecision: decision,
      decisionLabel: decision ? `最近决策：${decision.title}` : '最近决策：没有决策记录'
    });
  }

  rows.sort(compareRows);

  return {
    scope: 'locate',
    readOnly: true,
    title: '先看哪个',
    hint: '排序：待确认候选 > 有未读变化 > 超过 7 天未看 > 其余。切换项目不会清零未读；看过的变化在 `/变化` 里才清。',
    now: new Date(nowMs).toISOString(),
    staleDays: STALE_DAYS,
    counts: {
      projects: rows.length,
      pendingProjects: rows.filter((row) => row.tier === 'pending').length,
      unreadProjects: rows.filter((row) => row.tier === 'unread').length,
      staleProjects: rows.filter((row) => row.tier === 'stale').length
    },
    projects: rows,
    // 空态只解释「为什么没有行」，不冒充「没有变化」。
    empty: rows.length === 0
      ? {
        kind: 'no-project',
        title: '还没有登记项目',
        detail: '定位屏按项目的待确认候选与未读变化排序；先登记一个项目，这里才有行可排。'
      }
      : null
  };
}
