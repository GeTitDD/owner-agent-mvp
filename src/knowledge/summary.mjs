// 知识摘要：把「当前项目」的知识、经验与候选对齐，避免跨项目串数据。
//
// 这里的「经验」是 ADR-0007 的 lesson/v1（现象 → 机制 → 对策），读 knowledge_lessons；
// 旧的 experience/v1 表已停写、读路径已摘除（#62），摘要不再读取它，也不再提供手动提炼入口。
//
// 决策（#87）也算知识的一种，但状态读自己的 decision_status：「生效中」不是「已验证」，
// 已被取代 / 已放弃的不算现状，因此不计入知识条数与首屏列表。
import { decisionStatusOf, isCurrentDecision } from '../memory/decision-status.mjs';

const proposalIsCandidate = (proposal) => proposal?.meta?.contract === 'knowledge-candidate/v1';

/** 条目的状态：决策读决策状态，其余读验证状态，两套不互相冒充。 */
const statusOfUnit = (unit) => (unit?.kind === 'decision'
  ? decisionStatusOf(unit)
  : unit?.verificationStatus);

/** 是否算现状：非决策条目恒为 true；结束状态的决策不再算。 */
const isCurrentUnit = (unit) => unit?.kind !== 'decision' || isCurrentDecision(unit);

/**
 * 当前项目的知识摘要。
 * 项目内：经验（lesson）/ 项目知识 / 已验证 / 候选 / 复用
 * 全局：共享知识（applied/domain 层）、正负反馈
 */
export function knowledgeSummaryFor({ personalStore, projectId = '', limit = 2000 } = {}) {
  if (!personalStore) return null;
  const lessons = personalStore.listLessons({ projectId, limit: 1000 });
  const lessonIds = new Set(lessons.map((lesson) => lesson.id));
  const projectUnits = personalStore.list({ projectId, limit });
  const allUnits = personalStore.list({ limit });
  const sharedUnits = allUnits.filter((unit) => unit.scope !== 'project');
  const candidates = personalStore.proposals('pending').filter((proposal) => {
    if (!proposalIsCandidate(proposal)) return false;
    if (proposal.payload?.projectId === projectId) return true;
    // 提升为候选时只带来源经验 id（#61）；来源经验属于本项目时候选也算本项目。
    return (proposal.meta?.sourceLessonIds ?? []).some((id) => lessonIds.has(id));
  });
  const usages = personalStore.listUsages({ projectId, limit: 200 });
  // 结束状态的决策不算现状：不进知识条数、不进首屏列表，但单独给一个计数说明它们还在。
  const currentProjectUnits = projectUnits.filter(isCurrentUnit);
  const currentSharedUnits = sharedUnits.filter(isCurrentUnit);
  const endedDecisions = allUnits.filter((unit) => unit.kind === 'decision' && !isCurrentUnit(unit)).length;
  // 摘要列表：现状条目优先（已验证 / 生效中），其次最近更新；只取少量，供面板首屏阅读。
  const rankedUnits = currentProjectUnits.slice().sort((a, b) => {
    const good = (unit) => Number(['verified', 'active'].includes(statusOfUnit(unit)));
    return good(b) - good(a) || String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
  const tagCounts = new Map();
  for (const unit of currentProjectUnits) {
    for (const tag of unit.tags ?? []) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  const lastKnowledgeAt = currentProjectUnits
    .map((unit) => unit.updatedAt)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  return {
    projectId,
    counts: {
      lessons: lessons.length,
      knowledge: currentProjectUnits.length,
      verified: currentProjectUnits.filter((unit) => unit.verificationStatus === 'verified').length,
      sharedKnowledge: currentSharedUnits.length,
      sharedVerified: currentSharedUnits.filter((unit) => unit.verificationStatus === 'verified').length,
      // 已结束的决策不再算现状，单独计数（0 时面板不必显示）。
      endedDecisions,
      candidates: candidates.length,
      usages: usages.length,
      positiveUsages: usages.filter((usage) => usage.observedBenefit === 'positive').length,
      negativeUsages: usages.filter((usage) => usage.observedBenefit === 'negative').length
    },
    topKnowledge: rankedUnits.slice(0, 5).map((unit) => ({
      id: unit.id,
      title: unit.title,
      // 决策给决策状态，避免把「生效中」画成「待验证」。
      status: statusOfUnit(unit),
      layer: unit.layer,
      revision: unit.revision,
      updatedAt: unit.updatedAt
    })),
    tags: [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([tag, count]) => ({ tag, count })),
    lastKnowledgeAt,
    // 面板首屏只读一句话结论；机制与对策留给详情。
    recentLessons: lessons.slice(0, 5).map((lesson) => ({
      id: lesson.id,
      projectId: lesson.projectId,
      title: lesson.phenomenon,
      mechanism: lesson.mechanism ?? null,
      countermeasure: lesson.countermeasure ?? null,
      status: lesson.verificationStatus ?? 'inferred',
      createdAt: lesson.createdAt
    })),
    candidates: candidates.slice(0, 5).map((proposal) => ({
      id: proposal.id,
      title: proposal.payload?.title ?? '候选',
      status: proposal.status,
      layer: proposal.payload?.layer ?? proposal.meta?.proposedLayer ?? null,
      confidence: proposal.meta?.confidence ?? null,
      createdAt: proposal.created_at
    }))
  };
}
