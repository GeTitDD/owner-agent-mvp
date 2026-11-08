// Outcome Feedback：把知识复用后的真实结果写回，并给出晋升/降级建议。
//
// 关键语义：任务成功只说明 outcome，不等于被注入知识产生了正收益。
// observedBenefit 默认 unknown；只有显式对照实验或人工审核的 benefitEvidenceRefs
// 才能标记 positive/negative，并参与晋升/降级建议。
import { normalizeFeedback } from './contracts.mjs';

export class KnowledgeFeedback {
  constructor({ ownerStore, personalStore, clock = () => new Date().toISOString() } = {}) {
    if (!ownerStore || !personalStore) throw new Error('ownerStore and personalStore are required');
    this.owner = ownerStore;
    this.personal = personalStore;
    this.clock = clock;
  }

  outcomeForRun(runId) {
    const sandbox = this.owner.getSandboxRun(runId);
    if (sandbox) {
      const outcome = sandbox.test_status === 'pass' ? 'succeeded'
        : sandbox.test_status === 'fail' ? 'failed'
          : sandbox.status === 'cancelled' ? 'cancelled' : 'unknown';
      return {
        outcome,
        projectId: sandbox.project_id,
        observedBenefit: 'unknown',
        evidenceRefs: [`sandbox:${sandbox.id}`]
      };
    }
    const job = this.owner.getJob(runId);
    if (job) {
      const outcome = job.status === 'succeeded' ? 'succeeded'
        : job.status === 'cancelled' ? 'cancelled'
          : job.status === 'rejected' ? 'rejected'
            : job.status === 'failed' ? 'failed' : 'unknown';
      return {
        outcome,
        projectId: job.project_id,
        observedBenefit: 'unknown',
        evidenceRefs: [`job:${job.id}`]
      };
    }
    return { outcome: 'unknown', projectId: null, observedBenefit: 'unknown', evidenceRefs: [] };
  }

  pendingEvolution(kind, sourceIds) {
    return this.personal.proposals('pending').find((proposal) =>
      proposal.meta?.kind === kind
      && Array.isArray(proposal.meta?.sourceKnowledgeIds)
      && sourceIds.every((id) => proposal.meta.sourceKnowledgeIds.includes(id))
    ) ?? null;
  }

  proposePromotion(unit, { usageIds, evidenceRefs }) {
    const usages = usageIds.map((id) => this.personal.getUsage(id)).filter(Boolean);
    // 只有带显式对照/人工证据的正向 usage 才能参与晋升。
    const evidenced = usages.filter((usage) =>
      usage.observedBenefit === 'positive'
      && Array.isArray(usage.benefitEvidenceRefs)
      && usage.benefitEvidenceRefs.length > 0
    );
    const projects = new Set(evidenced.map((usage) => usage.projectId));
    let targetLayer = null;
    if (unit.layer === 'project' && projects.size >= 2) targetLayer = 'applied';
    if (unit.layer === 'applied' && projects.size >= 3) targetLayer = 'domain';
    if (!targetLayer) return null;
    const existing = this.pendingEvolution('promotion', [unit.id]);
    if (existing) return existing;
    const payload = {
      title: `${unit.title}（跨项目复用建议）`,
      content: unit.content,
      kind: unit.kind,
      layer: targetLayer,
      scope: 'domain',
      projectId: null,
      domains: unit.domains,
      tags: [...new Set([...unit.tags, 'promotion'])],
      evidenceRefs: [...new Set([
        ...unit.evidenceRefs,
        ...evidenceRefs,
        ...evidenced.flatMap((usage) => usage.benefitEvidenceRefs ?? []),
        ...evidenced.map((usage) => `usage:${usage.id}`)
      ])],
      verificationStatus: 'unverified',
      relations: { ...(unit.relations ?? {}), specializes: [unit.id] },
      sourceRef: `knowledge-loop:promotion:${unit.id}:r${unit.revision}`
    };
    return this.personal.submitProposal({
      targetId: null,
      payload,
      actor: 'knowledge-feedback',
      note: `Promotion suggestion from ${projects.size} independent evidenced projects`,
      meta: {
        contract: 'knowledge-evolution/v1',
        kind: 'promotion',
        sourceKnowledgeIds: [unit.id],
        revision: unit.revision,
        usageIds: evidenced.map((usage) => usage.id),
        independentProjects: [...projects],
        targetLayer,
        evidenceRefs,
        benefitEvidenceRefs: [...new Set(evidenced.flatMap((usage) => usage.benefitEvidenceRefs ?? []))],
        createdAt: this.clock()
      }
    });
  }

  proposeDemotion(unit, { usageIds, evidenceRefs, reason }) {
    const existing = this.pendingEvolution('demotion', [unit.id]);
    if (existing) return existing;
    if (unit.verificationStatus === 'needs_reverification' || unit.verificationStatus === 'disputed') return null;
    const payload = {
      ...unit,
      verificationStatus: 'needs_reverification',
      tags: [...new Set([...unit.tags, 'negative-evidence'])],
      evidenceRefs: [...new Set([...unit.evidenceRefs, ...evidenceRefs])]
    };
    delete payload.id;
    delete payload.revision;
    delete payload.createdAt;
    delete payload.updatedAt;
    return this.personal.submitProposal({
      targetId: unit.id,
      payload,
      actor: 'knowledge-feedback',
      note: `Demotion / re-verification suggestion: ${reason}`,
      meta: {
        contract: 'knowledge-evolution/v1',
        kind: 'demotion',
        sourceKnowledgeIds: [unit.id],
        revision: unit.revision,
        usageIds,
        evidenceRefs,
        reason,
        createdAt: this.clock()
      }
    });
  }

  record({
    usageId, runId = '', rationale = '', outcome, observedBenefit,
    evidenceRefs = [], benefitEvidenceRefs = [], comparison = null
  } = {}) {
    const usage = this.personal.getUsage(usageId);
    if (!usage) throw new Error('Unknown usage');
    const existing = this.personal.feedbackForUsage(usageId);
    if (existing) {
      return { feedback: existing, evolution: this.personal.proposal(existing.payload?.evolutionProposalId ?? '') ?? null, duplicate: true };
    }
    // 结果必须属于这次 usage 的目标 run/project，避免把别的项目成功/失败算到这条知识上。
    if (runId && usage.targetRunId && runId !== usage.targetRunId) {
      throw new Error('Run does not match usage targetRunId');
    }
    const derived = this.outcomeForRun(runId || usage.targetRunId);
    if (derived.projectId && derived.projectId !== usage.projectId) {
      throw new Error('Run project does not match usage project');
    }
    const finalOutcome = outcome ?? derived.outcome ?? 'unknown';
    const refs = [...new Set([...(derived.evidenceRefs ?? []), ...evidenceRefs])];

    let finalBenefit = observedBenefit ?? 'unknown';
    const benefitRefs = [...new Set(benefitEvidenceRefs)];
    if (comparison) {
      // 只接受同任务、同模型的对照结果；baseline fail + variant pass 才是正收益。
      if (comparison.sameTask === false) throw new Error('Comparison must use the same task');
      if (!['failed', 'succeeded'].includes(comparison.baselineOutcome)
        || !['failed', 'succeeded'].includes(comparison.variantOutcome)) {
        throw new Error('Invalid comparison outcomes');
      }
      if (comparison.knowledgeId && comparison.knowledgeId !== usage.knowledgeId) {
        throw new Error('Comparison knowledge does not match usage');
      }
      finalBenefit = comparison.baselineOutcome === 'failed' && comparison.variantOutcome === 'succeeded'
        ? 'positive'
        : comparison.baselineOutcome === 'succeeded' && comparison.variantOutcome === 'failed'
          ? 'negative'
          : 'unknown';
      benefitRefs.push(`comparison:${comparison.id ?? 'unnamed'}`);
    }
    if (finalBenefit !== 'unknown' && !benefitRefs.length) {
      throw new Error('Positive/negative benefit requires explicit benefitEvidenceRefs or comparison');
    }
    if (finalBenefit !== 'unknown' && !rationale.trim()) {
      throw new Error('Positive/negative benefit requires a rationale');
    }

    // 先写回 usage，再计算 promotion，确保当前 usage 参与证据统计。
    this.personal.updateUsageOutcome(usageId, {
      outcome: finalOutcome,
      observedBenefit: finalBenefit,
      outcomeEvidenceRefs: refs,
      benefitEvidenceRefs: benefitRefs
    });

    let proposedEvolution = 'none';
    let evolution = null;
    if (finalBenefit === 'negative') {
      const unit = this.personal.get(usage.knowledgeId);
      if (unit) {
        evolution = this.proposeDemotion(unit, {
          usageIds: [usageId], evidenceRefs: [...refs, ...benefitRefs],
          reason: rationale || 'controlled negative reuse outcome'
        });
        if (evolution) proposedEvolution = 'demote';
      }
    } else if (finalBenefit === 'positive') {
      const unit = this.personal.get(usage.knowledgeId);
      if (unit) {
        const positiveUsages = [...new Set([usageId, ...this.positiveUsages(unit.id)])];
        evolution = this.proposePromotion(unit, { usageIds: positiveUsages, evidenceRefs: benefitRefs });
        if (evolution) proposedEvolution = 'promote';
      }
    }
    const normalized = normalizeFeedback({
      usageId,
      outcome: finalOutcome,
      observedBenefit: finalBenefit,
      evidenceRefs: refs,
      benefitEvidenceRefs: benefitRefs,
      proposedEvolution,
      rationale: rationale || (finalBenefit === 'unknown' ? 'No controlled benefit evidence' : '')
    });
    const feedback = this.personal.addFeedback({
      ...normalized,
      runId: runId || usage.targetRunId,
      evolutionProposalId: evolution?.id ?? null,
      comparison: comparison ?? null
    });
    return { feedback, evolution, duplicate: false };
  }

  positiveUsages(knowledgeId) {
    return this.personal.listUsages({ knowledgeId, limit: 1000 })
      .filter((usage) => usage.observedBenefit === 'positive'
        && Array.isArray(usage.benefitEvidenceRefs)
        && usage.benefitEvidenceRefs.length > 0)
      .map((usage) => usage.id);
  }
}
