// #97 灵感提升：把「已整理」的条目送去两个既有去处——知识候选（假设类）或项目队列任务。
//
// 三条边界写在这里，后面两个函数都守着它们：
// 1. 复用既有入口，不新建「灵感知识表」：知识走 PersonalKnowledgeStore.submitProposal
//    （与 #61 经验提升同一张 personal_proposals、同一套人工审核），任务走
//    OwnerStore.addProjectQueueItem。灵感到知识只是候选 meta 上的一条指针
//    （sourceIdeaId）加一份摘要（四段 + 原文引用进 claim），没有第二份真值。
// 2. 只有 sorted 能提升；成功才把灵感推到 adopted，失败一个字都不改。候选之后被拒属于
//    后续审核（personal_proposals 自己的状态），不回滚灵感——见 README 报告里的决定。
// 3. 提升不改 raw_text / sorted_result / capture_source / link_url：本模块只读这些字段，
//    唯一的写操作是 setIdeaStatus（只动 idea_status / sorted_at / updated_at）。
//
// 不联网、不调模型、不引入依赖：摘要由已存的 sorted_result 拼出来，缺段照实写「缺」。

import { flatText } from './utils.mjs';
import { IDEA_SECTIONS } from './idea-sort.mjs';
import { CANDIDATE_CONTRACT, candidateToProposal } from './knowledge-loop/contracts.mjs';

/** 任务队列项的 source 标记：能看出这条任务是从灵感提升来的（不带 id，列宽 40）。 */
export const IDEA_PROMOTION_SOURCE = 'idea-promote';
/** 灵感 → 任务正文里的来源前缀；重试靠它认出「已经放过了」，不再插第二条。 */
export const IDEA_TASK_MARKER = '来源灵感：';
/** 知识候选 claim 的上限（contracts.normalizeCandidateDraft 限 8000）。 */
const CLAIM_LIMIT = 7800;
/** 任务正文上限（owner-store 的 body 列限 4000）。 */
const TASK_BODY_LIMIT = 3800;
/** 四段进摘要时每段再收一次：整理结果单段 800，提升摘要不必原样铺满。 */
const SUMMARY_SECTION_LIMIT = 600;

const refuse = (code, reason) => ({ ok: false, code, reason });
const clean = (value) => flatText(value).replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/gu, '');
const clip = (value, max) => {
  const text = clean(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** 四段（缺段带原因）拼成一段纯文本；limit 之内给原文引用留位置。 */
export function ideaPromotionSummary(item, { limit = TASK_BODY_LIMIT } = {}) {
  const sorted = item?.sorted && typeof item.sorted === 'object' ? item.sorted : null;
  const saved = Array.isArray(sorted?.sections) ? sorted.sections : [];
  const byKey = new Map(saved.map((section) => [String(section?.key ?? ''), section]));
  const lines = IDEA_SECTIONS.map((definition) => {
    const section = byKey.get(definition.key) ?? null;
    const text = clip(section?.text, SUMMARY_SECTION_LIMIT);
    if (text) return `${definition.label}：${text}`;
    // 没整理过（或这一段缺）就照实写：不给「未说明」这类占位词。
    const reason = clean(section?.reason) || '这条灵感还没有整理结果，先去整理。';
    return `${definition.label}：（缺）${reason}`;
  });
  const head = lines.join('\n');
  const raw = clean(item?.rawText);
  const link = clip(item?.link, 300);
  const tail = [];
  const budget = Math.max(0, limit - head.length - 6);
  if (raw) {
    const room = Math.max(0, budget - (link ? link.length + 6 : 0));
    if (room > 0) {
      tail.push(`原文：${raw.length > room ? `${raw.slice(0, room - 1)}…` : raw}`);
    }
  }
  if (link) tail.push(`链接：${link}`);
  return [head, ...tail].join('\n').slice(0, limit);
}

/** 灵感 → 候选草稿；假设类（hypothesis），有项目就落项目层，没有就落 applied 层。 */
export function ideaToCandidateDraft(item) {
  const title = clip(item?.title, 160) || clip(item?.rawText, 80) || '未命名灵感';
  const summary = ideaPromotionSummary(item, { limit: CLAIM_LIMIT });
  const saved = Array.isArray(item?.sorted?.sections) ? item.sorted.sections : [];
  const missing = saved.filter((section) => section?.missing === true);
  return {
    title,
    claim: summary,
    // 「假设类」= hypothesis：还没验证过的想法，进候选队列等人工审核，不直接成为已验证知识。
    kind: 'hypothesis',
    proposedLayer: item?.projectId ? 'project' : 'applied',
    // 假设先不写适用范围与例外：整理结果只有四段，编不出来就留空。
    applicability: [],
    exceptions: [],
    confidence: 0.4,
    // 来源指针同时落在 evidenceRefs 上：候选队列与审核页不读 meta 也能看到来自哪条灵感。
    evidenceRefs: [`idea:${item.id}`],
    facts: [],
    inferences: [],
    unknowns: missing.map((section) => clip(
      `${section?.label ?? section?.key ?? ''}缺：${section?.reason ?? '这段没有内容'}`, 300
    )).filter(Boolean),
    validationSuggestions: ['先补全缺的段，再决定要不要验证这条假设。'],
    keywords: ['灵感']
  };
}

/** 已整理才有去处；收件箱先整理，已采纳 / 已丢弃是终点。 */
const statusReason = (status) => {
  if (status === 'inbox') return '这条还在收件箱：先点「整理」，再提升。';
  if (status === 'adopted' || status === 'discarded') return '这条已经走到头了（已采纳 / 已丢弃），不能再提升。';
  return `当前状态 ${status} 不能提升。`;
};

const findPendingCandidate = (personalStore, ideaId) => {
  const proposals = personalStore.proposals('pending');
  return proposals.find((row) => row?.meta?.contract === CANDIDATE_CONTRACT
    && row?.meta?.sourceIdeaId === ideaId) ?? null;
};

/**
 * 提升为知识：落成假设类候选，走既有 personal_proposals 人工审核。
 *
 * @param {object} input
 * @param {object} input.store OwnerStore（只读条目 + setIdeaStatus）
 * @param {object} input.personalStore PersonalKnowledgeStore
 * @param {string} input.id 灵感 id
 * @param {string} [input.actor] 提交者标识
 * @param {string} [input.note] 候选备注
 * @returns {{ok: true, item: object, proposal: object, created: boolean}
 *   | {ok: false, code: string, reason: string}}
 */
export function promoteIdeaToKnowledge({
  store, personalStore, id, actor = 'local-user', note = ''
} = {}) {
  const ideaId = String(id ?? '');
  if (!store || typeof store.getIdeaItem !== 'function') {
    throw new Error('store is required');
  }
  if (!personalStore || typeof personalStore.submitProposal !== 'function') {
    return refuse('knowledge', '知识库尚未初始化，暂时不能提升为知识。');
  }
  const item = store.getIdeaItem(ideaId);
  if (!item) return refuse('missing', '这条灵感不存在，可能已经删了。');
  if (item.ideaStatus !== 'sorted') return refuse('status', statusReason(item.ideaStatus));

  // 重试幂等：上次候选已经建好、只是状态没来得及推进时，复用同一条，不再造第二条。
  let proposal = findPendingCandidate(personalStore, item.id);
  const created = !proposal;
  if (!proposal) {
    try {
      const mapped = candidateToProposal({
        draft: ideaToCandidateDraft(item),
        projectId: item.projectId ?? null,
        domainIds: [],
        // 灵感不是 experience/v1：来源不走 sourceExperienceIds，单独记 sourceIdeaId。
        sourceExperienceIds: [],
        harvestRunId: `idea:${item.id}`,
        playbook: 'edae',
        steps: []
      });
      // 指针只放在 meta 上，payload 保持既有候选形状；标题 / 四段摘要都在 claim 里。
      const meta = { ...mapped.meta, sourceIdeaId: item.id };
      proposal = personalStore.submitProposal({
        targetId: null,
        payload: mapped.payload,
        actor,
        note: clip(note, 500) || `从灵感 ${item.id} 提升为知识候选（假设类）`,
        meta
      });
    } catch (error) {
      // 服务端拒绝（校验失败、密钥误判等）时状态不变：条目仍可修改后重试。
      return refuse('candidate', `候选没建成：${error?.message ?? error}　灵感没改动，可以再试。`);
    }
  }

  const adopted = store.setIdeaStatus(item.id, 'adopted');
  return { ok: true, code: '', reason: '', item: adopted, proposal, created };
}

/**
 * 提升为任务：落进指定项目的队列（kind=task）。
 * 没有项目一律拦下——不猜、不丢进第一个项目。
 *
 * @param {object} input
 * @param {object} input.store OwnerStore
 * @param {string} input.id 灵感 id
 * @param {string} [input.projectId] 目标项目；条目自己有项目时可省略
 * @returns {{ok: true, item: object, task: object, projectId: string}
 *   | {ok: false, code: string, reason: string}}
 */
export function promoteIdeaToTask({ store, id, projectId = '' } = {}) {
  const ideaId = String(id ?? '');
  if (!store || typeof store.getIdeaItem !== 'function') {
    throw new Error('store is required');
  }
  const item = store.getIdeaItem(ideaId);
  if (!item) return refuse('missing', '这条灵感不存在，可能已经删了。');
  if (item.ideaStatus !== 'sorted') return refuse('status', statusReason(item.ideaStatus));

  // 显式选择优先；没选就用条目自己的项目。两个都没有就停在这里，不替用户挑默认项目。
  const target = projectId === undefined || projectId === null || projectId === ''
    ? (item.projectId ?? '')
    : String(projectId);
  if (!target) {
    return refuse('needs-project', '这条灵感还没有项目：先在条目里选一个项目，再提升为任务。');
  }
  if (typeof store.getProject !== 'function' || !store.getProject(target)) {
    return refuse('project', `找不到项目 ${target}：换一个项目再提升。`);
  }

  const marker = `${IDEA_TASK_MARKER}${item.id}`;
  const body = `${ideaPromotionSummary(item, { limit: TASK_BODY_LIMIT })}\n${marker}`.slice(0, 3900);
  let task = null;
  try {
    // 重试幂等：同一项目里已经有带这条标记的任务时复用，不插第二条。
    task = store.listProjectQueue(target, 'task')
      .find((row) => String(row.body ?? '').includes(marker)) ?? null;
    task = task ?? store.addProjectQueueItem({
      projectId: target,
      title: clip(item.title, 280) || clip(item.rawText, 80) || '未命名任务',
      body,
      source: IDEA_PROMOTION_SOURCE,
      kind: 'task'
    });
  } catch (error) {
    return refuse('queue', `任务没放进队列：${error?.message ?? error}　灵感没改动，可以再试。`);
  }

  const adopted = store.setIdeaStatus(item.id, 'adopted');
  return { ok: true, code: '', reason: '', item: adopted, task, projectId: target };
}
