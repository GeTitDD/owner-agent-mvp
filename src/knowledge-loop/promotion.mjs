// 经验提升为知识候选（#61）：一条经验 → 一条待审候选，走既有 personal_proposals 审核流。
//
// 边界：
// - 只写候选队列，不写 knowledge_lessons。提升不改经验的验证状态（unverified / inferred），
//   也不动 disputed / superseded 这类既有裁决——那些字段只有裁决入口能改。
// - 候选 payload 由 contracts.candidateToProposal 产出，与自动提炼共用 knowledge-candidate/v1，
//   不另造形状；来源经验记在 meta.sourceLessonIds，知识浏览已按它把候选归属回项目。
// - 同现象经验累积到 3 条（同一条经验被 3 条执行记录支持也算）时只返回提议信号，
//   不自动提升、不自动合并：由人决定提哪一条。
// 本模块不联网、不调真实模型、不引入依赖；测试用 PersonalKnowledgeStore(':memory:')。
import { CANDIDATE_CONTRACT, candidateToProposal } from './contracts.mjs';

/** 同一现象第 3 次出现时界面主动提议（ADR-0007）；「第 3 次」按执行记录去重计数。 */
export const PROMOTION_THRESHOLD = 3;

const flat = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();

/** 冲突/分组用的文本规范化：优先复用 store 的 #57 实现，保证两处判定同一把尺子。 */
const textKeyOf = (personalStore, value) => (
  typeof personalStore?.lessonConflictText === 'function'
    ? personalStore.lessonConflictText(value)
    : flat(value).toLowerCase()
);

/** 有效状态：争议 / 已被取代优先于验证状态；store 没实现时退回裸验证状态。 */
const statusOf = (personalStore, lesson) => (
  typeof personalStore?.lessonStatusOf === 'function'
    ? personalStore.lessonStatusOf(lesson)
    : (lesson?.verificationStatus ?? 'inferred')
);

const lessonProjectId = (lesson) => lesson?.scope?.projectId ?? lesson?.projectId ?? null;

const lessonDomainIds = (lesson) => (
  Array.isArray(lesson?.scope?.domainIds) ? lesson.scope.domainIds.map(String) : []
);

/**
 * 候选引用的证据：证据行的 ref 与 payload 上的 evidenceRefs 合起来去重，不发明新引用。
 * 候选契约对 evidenceRefs 的上限是 40；经验经 #55 反复累加可能超过，候选侧按先来后到截断，
 * 完整证据仍留在经验行里，不因提升而丢。
 */
const lessonEvidenceRefs = (lesson) => {
  const rows = Array.isArray(lesson?.evidence) ? lesson.evidence : [];
  return [...new Set([
    ...rows.map((row) => row?.ref).filter(Boolean),
    ...(Array.isArray(lesson?.evidenceRefs) ? lesson.evidenceRefs : [])
  ])].slice(0, 40);
};

/**
 * 经验 → 候选草稿：现象进标题，现象 / 机制 / 对策合成正文。
 * 只做映射，不写库；候选类型固定 pattern（落库是 claim），层跟着经验的作用域层走。
 * 经验本身永远不是「已验证」，所以候选的 verificationStatus 由契约给成 unverified。
 */
export function lessonToCandidateDraft(lesson) {
  if (!lesson || typeof lesson !== 'object' || Array.isArray(lesson)) throw new Error('lesson is required');
  const phenomenon = flat(lesson.phenomenon);
  if (!phenomenon) throw new Error('Lesson phenomenon is required');
  const mechanism = flat(lesson.mechanism);
  const countermeasure = flat(lesson.countermeasure);
  const claim = [
    phenomenon,
    mechanism ? `机制：${mechanism}` : '',
    countermeasure ? `对策：${countermeasure}` : ''
  ].filter(Boolean).join('\n');
  return {
    title: phenomenon,
    claim,
    kind: 'pattern',
    proposedLayer: lesson.scope?.layer === 'domain' ? 'domain' : 'project',
    evidenceRefs: lessonEvidenceRefs(lesson),
    facts: Array.isArray(lesson.facts) ? lesson.facts : [],
    inferences: Array.isArray(lesson.inferences) ? lesson.inferences : [],
    unknowns: Array.isArray(lesson.unknowns) ? lesson.unknowns : []
  };
}

/** 这条经验已有的候选：一经验一候选（拒绝后可重提，已接受的不再重复提交）。 */
const candidateFor = (personalStore, lessonId, status) => {
  if (typeof personalStore.proposals !== 'function') return null;
  return personalStore.proposals(status).find((row) => (
    row?.meta?.contract === CANDIDATE_CONTRACT
    && (row.meta?.sourceLessonIds ?? []).includes(lessonId)
  )) ?? null;
};

/**
 * 一键把一条经验提为知识候选。
 *
 * @param {object} input
 * @param {object} input.personalStore PersonalKnowledgeStore
 * @param {string} input.lessonId 经验 ID
 * @param {string} [input.actor] 操作者标识，默认本地用户
 * @param {string} [input.note] 候选备注
 * @param {string} [input.playbook] 候选 meta 里的 playbook，默认 edae（与自动提炼一致）
 * @param {string[]} [input.steps] 候选 meta 里的步骤，默认空
 * @returns {{created: boolean, reason: 'pending'|'approved'|null, lesson: object,
 *   proposal: object, payload: object, meta: object}}
 *   已有待审候选时 created 为 false 并原样返回那条候选；已被接受过的不再重复提交。
 */
export function promoteLessonToCandidate({
  personalStore, lessonId, actor = 'local-user', note = '', playbook = 'edae', steps = []
} = {}) {
  if (!personalStore || typeof personalStore.submitProposal !== 'function'
    || typeof personalStore.getLesson !== 'function') {
    throw new Error('personalStore is required');
  }
  const id = flat(lessonId);
  if (!id) throw new Error('lessonId is required');
  const lesson = personalStore.getLesson(id);
  if (!lesson) throw new Error('Lesson not found');

  const pending = candidateFor(personalStore, lesson.id, 'pending');
  if (pending) {
    return {
      created: false, reason: 'pending', lesson,
      proposal: pending, payload: pending.payload, meta: pending.meta
    };
  }
  // 已接受的候选已经落成知识：同一条经验不再造第二条候选。被拒的不拦，人可以改完再提。
  const approved = candidateFor(personalStore, lesson.id, 'approved');
  if (approved) {
    return {
      created: false, reason: 'approved', lesson,
      proposal: approved, payload: approved.payload, meta: approved.meta
    };
  }

  const draft = lessonToCandidateDraft(lesson);
  const layer = draft.proposedLayer;
  // 直接复用现有候选契约：层 / 作用域 / 项目 / 域 / tags / sourceRef 都由它统一决定。
  const mapped = candidateToProposal({
    draft,
    projectId: layer === 'project' ? lessonProjectId(lesson) : null,
    domainIds: lessonDomainIds(lesson),
    // 经验不是 experience/v1：不用经验 ID 冒充来源经验，来源单独记 sourceLessonIds。
    sourceExperienceIds: [],
    harvestRunId: `lesson:${lesson.id}`,
    playbook,
    steps
  });
  const meta = { ...mapped.meta, sourceLessonIds: [lesson.id] };
  const proposal = personalStore.submitProposal({
    targetId: null,
    payload: mapped.payload,
    actor,
    note: flat(note) || `从经验 ${lesson.id} 提升为知识候选`,
    meta
  });
  return { created: true, lesson, proposal, payload: proposal.payload, meta: proposal.meta };
}

/**
 * 同现象经验的提议信号（只读，不提升）。
 *
 * 一条经验可能在 #55/#56 里合并了多条执行记录，所以「同类经验到 3 条」按两个口径一起算：
 * lessonCount（同现象的经验行数，争议时会各成一行）与 recordCount（支持这些经验的执行记录
 * 去重条数），取较大值作为 occurrences。达到阈值只返回信号，是否提升仍由人决定。
 *
 * @param {object} input
 * @param {object} input.personalStore PersonalKnowledgeStore
 * @param {string} [input.projectId] 只看某个项目（含跨项目合并进来的经验）；空串看全部
 * @param {number} [input.threshold] 提议阈值，默认 3
 * @returns {{threshold: number, signals: object[]}}
 */
export function lessonPromotionSignals({
  personalStore, projectId = '', threshold = PROMOTION_THRESHOLD
} = {}) {
  if (!personalStore || typeof personalStore.listLessons !== 'function') {
    throw new Error('personalStore is required');
  }
  if (!Number.isSafeInteger(threshold) || threshold < 2) {
    throw new Error('threshold must be an integer of at least 2');
  }
  const project = flat(projectId);
  const scoped = Boolean(project) && typeof personalStore.listLessonsForProject === 'function';
  const lessons = scoped
    ? personalStore.listLessonsForProject(project, { limit: 500 })
    : personalStore.listLessons({ limit: 1000 })
      // 老库没有 listLessonsForProject 时至少按行上的项目过滤，不把别的项目混进来。
      .filter((lesson) => !project || lessonProjectId(lesson) === project);

  const groups = new Map();
  for (const lesson of lessons) {
    // 裁决输掉的经验不再当建议，也不参与「同类经验」计数。
    if (statusOf(personalStore, lesson) === 'superseded') continue;
    const key = textKeyOf(personalStore, lesson.phenomenon);
    if (!key) continue;
    const group = groups.get(key) ?? {
      phenomenon: flat(lesson.phenomenon), lessons: [], records: new Set(), domains: new Set()
    };
    group.lessons.push(lesson);
    for (const recordId of personalStore.lessonSupport(lesson.id)?.recordIds ?? []) {
      group.records.add(recordId);
    }
    for (const domainId of lessonDomainIds(lesson)) group.domains.add(domainId);
    groups.set(key, group);
  }

  const candidatesFor = (status) => (typeof personalStore.proposals === 'function'
    ? personalStore.proposals(status).filter((row) => row?.meta?.contract === CANDIDATE_CONTRACT)
    : []);
  const pending = candidatesFor('pending');
  const approved = candidatesFor('approved');
  const signals = [];
  for (const group of groups.values()) {
    const lessonIds = group.lessons.map((lesson) => lesson.id);
    const occurrences = Math.max(group.lessons.length, group.records.size);
    if (occurrences < threshold) continue;
    const matchesGroup = (row) => (row.meta?.sourceLessonIds ?? []).some((id) => lessonIds.includes(id));
    const pendingProposal = pending.find(matchesGroup) ?? null;
    const promotedProposal = approved.find(matchesGroup) ?? null;
    signals.push({
      phenomenon: group.phenomenon,
      occurrences,
      lessonCount: group.lessons.length,
      recordCount: group.records.size,
      threshold,
      lessonIds,
      scopeLayers: [...new Set(group.lessons.map((lesson) => (
        lesson.scope?.layer === 'domain' ? 'domain' : 'project'
      )))],
      projectIds: [...new Set(group.lessons.map(lessonProjectId).filter(Boolean))],
      domainIds: [...group.domains],
      pendingProposalId: pendingProposal?.id ?? null,
      promotedProposalId: promotedProposal?.id ?? null
    });
  }
  // 先攒得多的，再按现象短句排；同一份数据每次顺序一致。
  signals.sort((a, b) => b.occurrences - a.occurrences || a.phenomenon.localeCompare(b.phenomenon));
  return { threshold, signals };
}
