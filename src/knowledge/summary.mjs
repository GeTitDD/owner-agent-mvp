// 知识摘要与手动提炼：把“待提炼队列”和“当前项目”对齐，避免跨项目串数据。
//
// 纯查询 + 一次显式人工动作，不改变知识验证状态：提炼只写 pending 候选。
import { KnowledgeHarvester } from '../knowledge-loop/harvest.mjs';

const proposalIsCandidate = (proposal) => proposal?.meta?.contract === 'knowledge-candidate/v1';

/** 计算某项目的待提炼经验：该项目内、且没有进入过任何 Harvest 的经验。 */
export function pendingExperiencesFor({ personalStore, projectId = '' }) {
  const experiences = personalStore.listExperiences({ projectId, limit: 1000 });
  const harvested = new Set(personalStore.listHarvestRuns(1000).flatMap((run) => run.experienceIds ?? []));
  return experiences.filter((experience) => !harvested.has(experience.id));
}

/**
 * 当前项目的知识摘要。
 * 项目内：经验 / 待提炼 / 项目知识 / 已验证 / 候选 / 复用
 * 全局：共享知识（applied/domain 层）、正负反馈
 */
export function knowledgeSummaryFor({ personalStore, projectId = '', limit = 2000 } = {}) {
  if (!personalStore) return null;
  const experiences = personalStore.listExperiences({ projectId, limit: 1000 });
  const pending = pendingExperiencesFor({ personalStore, projectId });
  const projectUnits = personalStore.list({ projectId, limit });
  const allUnits = personalStore.list({ limit });
  const sharedUnits = allUnits.filter((unit) => unit.scope !== 'project');
  const projectExperienceIds = new Set(experiences.map((experience) => experience.id));
  const candidates = personalStore.proposals('pending').filter((proposal) => {
    if (!proposalIsCandidate(proposal)) return false;
    if (proposal.payload?.projectId === projectId) return true;
    return (proposal.meta?.sourceExperienceIds ?? []).some((id) => projectExperienceIds.has(id));
  });
  const usages = personalStore.listUsages({ projectId, limit: 200 });
  return {
    projectId,
    counts: {
      experiences: experiences.length,
      pendingHarvest: pending.length,
      knowledge: projectUnits.length,
      verified: projectUnits.filter((unit) => unit.verificationStatus === 'verified').length,
      sharedKnowledge: sharedUnits.length,
      sharedVerified: sharedUnits.filter((unit) => unit.verificationStatus === 'verified').length,
      candidates: candidates.length,
      usages: usages.length,
      positiveUsages: usages.filter((usage) => usage.observedBenefit === 'positive').length,
      negativeUsages: usages.filter((usage) => usage.observedBenefit === 'negative').length
    },
    pendingExperiences: pending.slice(0, 10).map((experience) => ({
      id: experience.id,
      projectId: experience.projectId,
      title: experience.observedProblem,
      outcome: experience.observedOutcome?.status ?? 'unknown',
      testStatus: experience.observedOutcome?.testStatus ?? null,
      createdAt: experience.createdAt
    })),
    recentExperiences: experiences.slice(0, 5).map((experience) => ({
      id: experience.id,
      projectId: experience.projectId,
      title: experience.observedProblem,
      outcome: experience.observedOutcome?.status ?? 'unknown',
      testStatus: experience.observedOutcome?.testStatus ?? null,
      createdAt: experience.createdAt
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

/**
 * 对当前项目的待提炼经验执行一次真实 Harvest。
 * 只写 knowledge_harvest_runs + pending 候选；绝不自动 approve/verify。
 */
export async function harvestProjectNow({
  personalStore, ownerStore, model = '', projectId,
  domainId = 'software-engineering', timeoutMs = 300000,
  harvester = null, logger = console
} = {}) {
  if (!personalStore) throw new Error('知识库尚未初始化。');
  if (!projectId) throw new Error('先选择一个项目。');
  const pending = pendingExperiencesFor({ personalStore, projectId });
  if (pending.length === 0) {
    throw new Error('当前项目没有待提炼经验：先完成一次终态任务（交办 → 批准 → 补丁 → 沙箱），再回来提炼。');
  }
  const runner = harvester ?? new KnowledgeHarvester({
    ownerStore, personalStore, model, allowModel: true,
    timeoutMs, logger
  });
  const result = await runner.harvest({
    experienceIds: pending.map((experience) => experience.id),
    projectId,
    domainId: pending[0]?.domainIds?.[0] ?? domainId,
    allowModel: true,
    model
  });
  const candidates = (result?.candidates ?? []).map((proposal) => ({
    id: proposal.id,
    title: proposal.payload?.title ?? '候选',
    layer: proposal.payload?.layer ?? proposal.meta?.proposedLayer ?? null,
    confidence: proposal.meta?.confidence ?? null
  }));
  return {
    harvestRunId: result?.harvestRun?.id ?? null,
    experienceCount: pending.length,
    candidates,
    skipped: result?.skipped ?? [],
    invalid: result?.invalid ?? []
  };
}
