// 知识摘要：把「当前项目」的知识、经验与候选对齐，避免跨项目串数据。
//
// 这里的「经验」是 ADR-0007 的 lesson/v1（现象 → 机制 → 对策），读 knowledge_lessons；
// 旧的 experience/v1 表已停写、读路径已摘除（#62），摘要不再读取它，也不再提供手动提炼入口。
const proposalIsCandidate = (proposal) => proposal?.meta?.contract === 'knowledge-candidate/v1';

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
  // 摘要列表：已验证优先，其次最近更新；只取少量，供面板首屏阅读。
  const rankedUnits = projectUnits.slice().sort((a, b) => {
    const verified = Number(b.verificationStatus === 'verified') - Number(a.verificationStatus === 'verified');
    return verified || String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
  const tagCounts = new Map();
  for (const unit of projectUnits) {
    for (const tag of unit.tags ?? []) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  const lastKnowledgeAt = projectUnits
    .map((unit) => unit.updatedAt)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  return {
    projectId,
    counts: {
      lessons: lessons.length,
      knowledge: projectUnits.length,
      verified: projectUnits.filter((unit) => unit.verificationStatus === 'verified').length,
      sharedKnowledge: sharedUnits.length,
      sharedVerified: sharedUnits.filter((unit) => unit.verificationStatus === 'verified').length,
      candidates: candidates.length,
      usages: usages.length,
      positiveUsages: usages.filter((usage) => usage.observedBenefit === 'positive').length,
      negativeUsages: usages.filter((usage) => usage.observedBenefit === 'negative').length
    },
    topKnowledge: rankedUnits.slice(0, 5).map((unit) => ({
      id: unit.id,
      title: unit.title,
      status: unit.verificationStatus,
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
