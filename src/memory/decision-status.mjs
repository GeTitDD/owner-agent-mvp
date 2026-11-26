// 决策状态：生效中 / 已被取代 / 已放弃，与「待验证 / 已验证」是两套状态机。
//
// 为什么单独一个文件：决策借用知识表（personal_units）存放，但它不是「一条待验证的知识」。
// 混用一列会出现「生效中的知识」这种自相矛盾的值，所以状态单独一列（decision_status），
// 读写、徽章文案、状态流转、检索过滤都收在这里，界面与存储不再各写一份。
//
// 三类状态的含义（从 ADR-0007 的「决策只会被取代」推出来）：
// - active（生效中）：当下的现状，检索与界面都算它；
// - superseded（已被取代）：后来有了新决策，旧的仍可查，但不再算现状；
// - abandoned（已放弃）：这条决策本身不再执行，仍可查，但不再算现状。
//
// 只有生效中的决策能结束；结束状态是终态，不提供「复活」——要重新采用另记一条新决策，
// 这样「什么时候为什么改回来」也留在库里，而不是被一次状态翻转抹掉。
//
// 本文件不读盘、不读库、不联网：输入是知识条目行（unit），输出是状态、徽章与检索视图。

import { flatText } from '../utils.mjs';

/** 决策是知识的一种（kind = decision）。 */
export const DECISION_KIND = 'decision';

/** 默认状态：确认入库即生效中。 */
export const DEFAULT_DECISION_STATUS = 'active';

/** 三种状态，顺序即界面上按钮的顺序。 */
export const DECISION_STATUSES = Object.freeze(['active', 'superseded', 'abandoned']);

/** 徽章文案：与验证状态的「待验证 / 已验证」完全分开。 */
export const DECISION_STATUS_LABELS = Object.freeze({
  active: '生效中',
  superseded: '已被取代',
  abandoned: '已放弃'
});

/** 结束状态：这两种在检索与界面里都不再算现状。 */
export const ENDED_DECISION_STATUSES = Object.freeze(['superseded', 'abandoned']);

/** 来源文案：决策候选只来自两类会话，界面据此说清「这条是从哪读出来的」；手动记的单独标。 */
const SOURCE_LABELS = Object.freeze({
  codex: 'Codex 会话',
  claude: 'Claude Code 会话',
  // #138 `/记决策`：人自己写的一条，不是从会话里读出来的，来源照实写「手动填写」。
  manual: '手动填写'
});

/** 状态是否认识：不认识的返回空串，交给调用方按「没有状态」处理，不猜。 */
export function normalizeDecisionStatus(value) {
  const status = String(value ?? '').trim();
  return DECISION_STATUSES.includes(status) ? status : '';
}

/**
 * 一条知识条目的决策状态。
 * 只有 kind = decision 才有这一列；非决策条目一律返回 null，避免把验证状态读成决策状态。
 */
export function decisionStatusOf(unit) {
  if (!unit || unit.kind !== DECISION_KIND) return null;
  return normalizeDecisionStatus(unit.decisionStatus) || DEFAULT_DECISION_STATUS;
}

/** 是否算「现状」：非决策条目恒为 true（这条判断只用于过滤决策）。 */
export function isCurrentDecision(unit) {
  const status = decisionStatusOf(unit);
  return status === null || status === DEFAULT_DECISION_STATUS;
}

/** 决策的状态徽章；非决策条目返回空串，界面据此不画决策徽章。 */
export function decisionStatusLabel(unit) {
  const status = decisionStatusOf(unit);
  return status ? DECISION_STATUS_LABELS[status] : '';
}

/**
 * 状态流转判定：只有「生效中 → 已被取代 / 已放弃」这一条路径。
 * 返回 { ok, reason }，不抛异常——调用方要把原因翻成界面提示。
 */
export function decisionStatusChange(from, to) {
  const previous = normalizeDecisionStatus(from) || DEFAULT_DECISION_STATUS;
  const next = normalizeDecisionStatus(to);
  if (!next) return { ok: false, reason: 'unknown-status', message: '决策状态只能是「生效中 / 已被取代 / 已放弃」。' };
  if (next === previous) return { ok: false, reason: 'unchanged', message: '这条决策已经是这个状态了。' };
  // 只有生效中的决策能结束；结束状态之间也不能互相改（终态）。
  if (previous !== DEFAULT_DECISION_STATUS) {
    return { ok: false, reason: 'terminal', message: '已被取代或已放弃的决策不会再改状态；要重新采用请另记一条新决策。' };
  }
  return { ok: true, reason: null, message: '' };
}

/** 是否结束状态（检索与界面用来判断「不再算现状」）。 */
export function isEndedDecisionStatus(status) {
  return ENDED_DECISION_STATUSES.includes(normalizeDecisionStatus(status));
}

/** 来源文案：决策候选带 source.kind（codex / claude），缺省时原样留空。 */
export function decisionSourceLabel(source) {
  const kind = String(source?.source ?? source?.kind ?? '').trim();
  return SOURCE_LABELS[kind] ?? '';
}

/** 决策显示时间：确认入库的时间优先，其次创建时间。 */
export function decisionDecidedAt(unit) {
  return unit?.decision?.decidedAt ?? unit?.createdAt ?? unit?.created_at ?? null;
}

/**
 * 把一条知识条目压成检索/展示用的决策视图。
 * 这里只读，不判断归属项目（那是调用方的事）；理由空着就显式标「缺理由」，
 * 不填「未说明」这类占位词冒充内容。
 */
export function decisionViewOf(unit) {
  const status = decisionStatusOf(unit);
  if (!status) return null;
  const decision = unit?.decision && typeof unit.decision === 'object' ? unit.decision : {};
  const reason = flatText(decision.reason);
  const source = decision.source && typeof decision.source === 'object' ? decision.source : null;
  return {
    id: String(unit?.id ?? ''),
    kind: DECISION_KIND,
    title: flatText(unit?.title, 200) || flatText(decision.phenomenon, 200) || '未命名决策',
    status,
    statusLabel: DECISION_STATUS_LABELS[status],
    current: status === DEFAULT_DECISION_STATUS,
    // 理由空着是常态：missingReason 单独标记，界面据此提示「确认时补一句」。
    reason,
    missingReason: decision.reasonMissing === true || reason === '',
    intent: flatText(decision.intent),
    abandoned: flatText(decision.abandoned),
    source,
    sourceLabel: decisionSourceLabel(source),
    decidedAt: decisionDecidedAt(unit),
    fingerprint: flatText(decision.fingerprint, 128) || null,
    evidenceRefs: Array.isArray(unit?.evidenceRefs) ? [...unit.evidenceRefs] : [],
    projectId: unit?.scope === 'project' ? (unit?.projectId ?? null) : null
  };
}

const tokensOf = (query) => flatText(query).toLowerCase().split(' ').filter(Boolean);

const haystackOf = (unit) => flatText([
  unit?.title,
  unit?.content,
  unit?.decision?.intent,
  unit?.decision?.abandoned,
  unit?.decision?.reason,
  ...(Array.isArray(unit?.tags) ? unit.tags : [])
].join(' ')).toLowerCase();

/**
 * 决策检索视图（纯函数）。
 *
 * 契约：`items` 只放生效中的决策；已被取代 / 已放弃的放进 `ended`，带状态与时间，
 * 仍可查但不算现状。项目级决策按项目过滤，域级决策对所有项目可见；空结果给原因
 * （没有项目 / 还没确认过 / 全都被取代了 / 没有关键词命中），不给一个空数组让人猜。
 *
 * @param {object} input
 * @param {object[]} [input.units] 知识条目行（personal_units）
 * @param {string} [input.projectId] 当前项目；空串表示「全部」
 * @param {string} [input.query] 关键词，空白分隔，全部命中才算命中
 * @param {number} [input.limit] 每类最多返回多少条
 */
export function decisionRetrievalView({ units = [], projectId = '', query = '', limit = 20 } = {}) {
  const project = flatText(projectId);
  const tokens = tokensOf(query);
  const cap = Math.max(1, Number.isSafeInteger(limit) ? limit : 20);
  const decisions = (Array.isArray(units) ? units : [])
    .filter((unit) => unit && typeof unit === 'object' && unit.kind === DECISION_KIND);
  // 项目归属：项目级只归本项目，域级对所有项目可见（项目级 → 域级是显式升级，见 store）。
  const inProject = (unit) => !project
    || unit.scope !== 'project'
    || flatText(unit.projectId) === project;
  const hit = (unit) => tokens.every((token) => haystackOf(unit).includes(token));
  const views = decisions
    .filter(inProject)
    .filter(hit)
    .map(decisionViewOf)
    .filter(Boolean);

  const current = views.filter((view) => view.current);
  const ended = views.filter((view) => !view.current);
  const code = current.length
    ? null
    : decisions.length === 0
      ? 'no-decision'
      : ended.length
        ? 'all-ended'
        : 'no-matching-decision';
  const message = code === 'no-decision'
    ? (project ? `项目 ${project} 还没有确认过的决策。` : '还没有确认过的决策。')
    : code === 'all-ended'
      ? `命中的 ${ended.length} 条决策都已被取代或已放弃，不再算现状。`
      : code === 'no-matching-decision'
        ? `没有决策命中「${flatText(query)}」。`
        : '';

  return {
    projectId: project,
    query: flatText(query),
    items: current.slice(0, cap),
    ended: ended.slice(0, cap),
    counts: { current: current.length, ended: ended.length, matched: views.length },
    reason: code ? { code, message } : null
  };
}
