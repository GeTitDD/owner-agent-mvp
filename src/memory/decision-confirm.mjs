// 决策确认：把一条会话扫描出的候选落成知识的一种（kind = decision）。
//
// 两条边界写死在这里：
// 1. 候选本身不写库。只有人点了「确认」才调 confirmDecisionCandidate；
//    草稿函数 decisionDraftFromCandidate 是纯函数，方便先测「确认后会出现什么」。
// 2. 理由是可选的，但「缺理由」必须显式留下。空串不等于「没这条信息」，
//    所以 reasonMissing 单独存，界面据此显示「缺理由」，确认时也能补一句。
//
// 来源与时间一起入库：来源是候选的会话出处（Codex / Claude Code + 会话 id + 路径），
// 时间是确认那一刻；证据引用保留候选的用户原话与助手确认两处位置，事后能回到原会话。
//
// 不读盘、不读库（confirmDecisionCandidate 只通过传入的 store 写入）、不联网、不调模型。

import { flatText } from '../utils.mjs';
import { decisionFingerprint } from './decision-draft.mjs';
import {
  DECISION_KIND,
  DECISION_STATUS_LABELS,
  DEFAULT_DECISION_STATUS,
  decisionStatusChange
} from './decision-status.mjs';

const REF_MAX = 500;
const QUOTE_MAX = 2000;

/** 会话 id：候选顶层没有时，从第一条证据上取（decision-draft 把会话 id 放在证据里）。 */
const sessionIdOf = (candidate) => {
  const direct = flatText(candidate?.sessionId);
  if (direct) return direct;
  const first = Array.isArray(candidate?.evidence) ? candidate.evidence[0] : null;
  return flatText(first?.sessionId);
};

/**
 * 来源种类：会话扫描默认是 session-scan；`/记决策` 手动写的那条标 manual。
 * 手动条目没有会话可回查，不能沿用 session-scan 的出处拼接，否则会凭空长出一条
 * `session-scan::` 的假证据。
 */
const sourceKindOf = (candidate) => flatText(candidate?.sourceKind, 40) || 'session-scan';

/** 会话出处：来源 + 会话 id（缺 id 时用文件路径）。超长按证据引用的上限截断。 */
const sessionRefOf = (candidate) => {
  if (sourceKindOf(candidate) === 'manual') return '';
  const source = flatText(candidate?.source);
  const sessionPath = flatText(candidate?.sessionPath);
  return flatText(`session-scan:${source}:${sessionIdOf(candidate) || sessionPath}`, REF_MAX);
};

/**
 * 证据引用：候选已带 evidence（角色 + 位置 + 会话），逐条压成可回查的短串。
 * 缺位置时退回会话出处一条——宁可证据粗一点，也不要留空让决策变成「没有出处」。
 */
const evidenceRefsOf = (candidate) => {
  const source = flatText(candidate?.source);
  const fallback = sessionRefOf(candidate);
  const refs = [];
  for (const item of Array.isArray(candidate?.evidence) ? candidate.evidence : []) {
    const sessionId = flatText(item?.sessionId);
    const role = flatText(item?.role);
    const index = Number.isFinite(item?.index) ? item.index : '';
    if (!role || index === '') continue;
    refs.push(flatText(`${source}:${sessionId || 'session'}#${role}:${index}`, REF_MAX));
  }
  const unique = [...new Set(refs.filter(Boolean))];
  return unique.length ? unique : (fallback ? [fallback] : []);
};

/**
 * 决策正文：人读的一段话，由候选的四个字段拼出来，缺哪行就省哪行。
 * 理由是「确认时问人」的那一句，所以空着时不写占位词，交给 reasonMissing 表达。
 */
export function decisionContentOf({ phenomenon = '', intent = '', abandoned = '', reason = '' } = {}) {
  const lines = [`决策：${flatText(phenomenon, 500)}`];
  const chosen = flatText(intent, 2000);
  const dropped = flatText(abandoned, 2000);
  const why = flatText(reason, 2000);
  if (chosen) lines.push(`选择：${chosen}`);
  if (dropped) lines.push(`放弃的方案：${dropped}`);
  if (why) lines.push(`理由：${why}`);
  return lines.join('\n');
}

/**
 * 候选 → 知识条目草稿（纯函数）。
 *
 * @param {object} input
 * @param {object} input.candidate 会话扫描出的候选（见 decision-draft.mjs）
 * @param {string} [input.reason] 确认时补的理由；留空即「缺理由」
 * @param {string} [input.projectId] 覆盖候选上的项目（默认取候选的）
 * @param {string} [input.now] 确认时间；缺省由调用方给（纯函数不读时钟）
 * @returns {{payload: object, fingerprint: string}}
 */
export function decisionDraftFromCandidate({
  candidate = {},
  reason = '',
  projectId = '',
  now = ''
} = {}) {
  const project = flatText(projectId || candidate?.projectId);
  const phenomenon = flatText(candidate?.phenomenon || candidate?.quote?.user, 500);
  const intent = flatText(candidate?.intent, 2000);
  const abandoned = flatText(candidate?.abandoned, 2000);
  const why = flatText(reason, 2000);
  const fingerprint = flatText(candidate?.fingerprint, 128)
    || decisionFingerprint({ projectId: project, text: phenomenon });
  const source = {
    kind: sourceKindOf(candidate),
    source: flatText(candidate?.source),
    sessionId: sessionIdOf(candidate),
    sessionPath: flatText(candidate?.sessionPath, REF_MAX),
    projectName: flatText(candidate?.projectName)
  };
  const decidedAt = flatText(now) || new Date().toISOString();
  const quote = {
    user: flatText(candidate?.quote?.user || candidate?.phenomenon, QUOTE_MAX),
    assistant: flatText(candidate?.quote?.assistant, QUOTE_MAX)
  };
  const payload = {
    title: flatText(phenomenon || quote.user, 200) || '未命名决策',
    content: flatText(decisionContentOf({ phenomenon: phenomenon || quote.user, intent, abandoned, reason: why }), 25000),
    kind: DECISION_KIND,
    // 决策属于某个项目：确认发生在项目下面；跨项目时走既有的「项目级 → 域级」升级。
    layer: 'project',
    scope: 'project',
    projectId: project,
    domains: [],
    tags: ['decision', source.source].filter(Boolean),
    evidenceRefs: evidenceRefsOf(candidate),
    // 验证状态与决策状态分开：决策不会「被验证」，这里只是知识表要求的默认值，不冒充决策状态。
    verificationStatus: 'unverified',
    sourceRef: sessionRefOf(candidate) || null,
    decisionStatus: DEFAULT_DECISION_STATUS,
    decision: {
      fingerprint,
      reason: why,
      reasonMissing: why === '',
      intent,
      abandoned,
      quote,
      source,
      decidedAt,
      history: []
    }
  };
  return { payload, fingerprint };
}

/** 把存储层抛出的校验错误翻成界面可执行的提示；未识别的保留原文方便排查。 */
export function decisionConfirmFailureReason(error) {
  const message = String(error?.message ?? error ?? '');
  if (/not found/iu.test(message)) return '知识库里的记录找不到了，刷新后再试。';
  if (/Invalid project ID|Project scope requires/iu.test(message)) {
    return '这条候选没有归属项目，无法在项目下面确认。';
  }
  if (/already exists|UNIQUE/iu.test(message)) return '这条决策已经确认入库了。';
  return message || '确认失败，请稍后再试。';
}

/**
 * 确认一条候选：写一条决策知识，带来源、时间与证据引用。
 * 幂等：同一指纹（用户原话 + 项目）已入库时不再写第二条，返回 created=false。
 *
 * @returns {{ok: boolean, created: boolean, id: string|null, status: string|null,
 *   fingerprint: string|null, missingReason: boolean, reason: string|null}}
 */
export function confirmDecisionCandidate({
  personalStore,
  candidate = {},
  reason = '',
  actor = 'local-user'
} = {}) {
  const fail = (text) => ({
    ok: false, created: false, id: null, status: null, fingerprint: null,
    missingReason: true, reason: text
  });
  if (!personalStore || typeof personalStore.create !== 'function') {
    return fail('知识库尚未初始化，暂时不能确认决策。');
  }
  const projectId = flatText(candidate?.projectId);
  if (!projectId) return fail('这条候选没有归属项目，无法在项目下面确认。');

  const { payload, fingerprint } = decisionDraftFromCandidate({ candidate, reason, projectId });
  try {
    // 已确认过同一句话：不重复写，也不把这次的补理由当成新决策。
    const existing = typeof personalStore.decisionByFingerprint === 'function'
      ? personalStore.decisionByFingerprint(fingerprint)
      : null;
    if (existing) {
      return {
        ok: true, created: false, id: existing.id,
        status: existing.decisionStatus ?? DEFAULT_DECISION_STATUS,
        fingerprint, missingReason: existing.decision?.reasonMissing === true, reason: null
      };
    }
    const unit = personalStore.create(payload, { actor, note: '确认会话决策候选' });
    return {
      ok: true, created: true, id: unit?.id ?? null,
      status: unit?.decisionStatus ?? DEFAULT_DECISION_STATUS,
      fingerprint, missingReason: payload.decision.reasonMissing, reason: null
    };
  } catch (error) {
    return fail(decisionConfirmFailureReason(error));
  }
}

/**
 * 结束一条生效中的决策（标为已被取代 / 已放弃）。
 * 状态只写 decision_status 这一列，验证状态原样不动。
 *
 * @returns {{ok: boolean, id: string, status: string|null, previous: string|null, reason: string|null}}
 */
export function changeDecisionStatus({
  personalStore,
  id,
  status,
  note = '',
  actor = 'local-user'
} = {}) {
  const decisionId = String(id ?? '');
  const fail = (text) => ({ ok: false, id: decisionId, status: null, previous: null, reason: text });
  if (!personalStore) return fail('知识库尚未初始化，暂时不能改决策状态。');
  if (!decisionId) return fail('决策不存在，刷新后再试。');
  const unit = typeof personalStore.get === 'function' ? personalStore.get(decisionId) : null;
  if (!unit) return fail('决策不存在，可能已被清理；刷新后再试。');
  if (unit.kind !== DECISION_KIND) return fail('只有决策才有「已被取代 / 已放弃」这两种状态。');
  const previous = unit.decisionStatus ?? DEFAULT_DECISION_STATUS;
  const verdict = decisionStatusChange(previous, status);
  if (!verdict.ok) return { ...fail(verdict.message), previous };
  try {
    const next = personalStore.setDecisionStatus(decisionId, status, { actor, note });
    return {
      ok: true, id: decisionId,
      status: next?.decisionStatus ?? status,
      previous,
      reason: null
    };
  } catch (error) {
    return { ...fail(decisionConfirmFailureReason(error)), previous };
  }
}

/** 状态文案出口：面板与视图模型共用一份，避免各写一套中文。 */
export const decisionStatusText = (status) => DECISION_STATUS_LABELS[status] ?? String(status ?? '');
