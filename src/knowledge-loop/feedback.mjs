// Outcome Feedback：把知识复用后的真实结果写回，并给出晋升/降级建议。
//
// 只产生 pending proposal；不会自动批准、发布或修改 pstack 全局 Skill。
import { normalizeFeedback } from './contracts.mjs';
import { canonical, sha256 } from '../utils.mjs';

const positive = new Set(['succeeded', 'repaired']);

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
      const status = sandbox.test_status === 'pass' ? 'succeeded'
        : sandbox.test_status === 'fail' ? 'failed'
          : sandbox.status === 'cancelled' ? 'cancelled' : 'unknown';
      return {
        outcome: status,
        observedBenefit: status === 'succeeded' ? 'positive' : status === 'failed' ? 'negative' : 'unknown',
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
        observedBenefit: outcome === 'succeeded' ? 'positive' : outcome === 'failed' ? 'negative' : 'unknown',
        evidenceRefs: [`job:${job.id}`]
      };
    }
    return { outcome: 'unknown', observedBenefit: 'unknown', evidenceRefs: [] };
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
    const projects = new Set(usages.map((usage) => usage.projectId));
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
      evidenceRefs: [...new Set([...unit.evidenceRefs, ...evidenceRefs, ...usages.map((u) => `usage:${u.id}`)])],
      verificationStatus: 'unverified',
      relations: { ...(unit.relations ?? {}), specializes: [unit.id] },
      sourceRef: `knowledge-loop:promotion:${unit.id}:r${unit.revision}`
    };
    return this.personal.submitProposal({
      targetId: null,
      payload,
      actor: 'knowledge-feedback',
      note: `Promotion suggestion from ${projects.size} independent projects`,
      meta: {
        contract: 'knowledge-evolution/v1',
        kind: 'promotion',
        sourceKnowledgeIds: [unit.id],
        revision: unit.revision,
        usageIds,
        independentProjects: [...projects],
        targetLayer,
        evidenceRefs,
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

  record({ usageId, runId = '', rationale = '', outcome, observedBenefit, evidenceRefs = [] } = {}) {
    const usage = this.personal.getUsage(usageId);
    if (!usage) throw new Error('Unknown usage');
    const existing = this.personal.feedbackForUsage(usageId);
    if (existing) {
      return { feedback: existing, evolution: this.personal.proposal(existing.payload?.evolutionProposalId ?? '') ?? null, duplicate: true };
    }
    const derived = runId ? this.outcomeForRun(runId) : null;
    const finalOutcome = outcome ?? derived?.outcome ?? 'unknown';
    const finalBenefit = observedBenefit ?? derived?.observedBenefit ?? 'unknown';
    const refs = [...new Set([...(derived?.evidenceRefs ?? []), ...evidenceRefs])];
    let proposedEvolution = 'none';
    let evolution = null;
    let reason = rationale;
    if (finalBenefit === 'negative') {
      const unit = this.personal.get(usage.knowledgeId);
      if (unit) {
        evolution = this.proposeDemotion(unit, {
          usageIds: [usageId], evidenceRefs: refs, reason: rationale || 'negative reuse outcome'
        });
        if (evolution) proposedEvolution = 'demote';
      }
    } else if (finalBenefit === 'positive') {
      const unit = this.personal.get(usage.knowledgeId);
      if (unit) {
        const positiveUsages = [...new Set([usageId, ...this.positiveUsages(unit.id)])];
        evolution = this.proposePromotion(unit, { usageIds: positiveUsages, evidenceRefs: refs });
        if (evolution) proposedEvolution = 'promote';
      }
    }
    const normalized = normalizeFeedback({
      usageId,
      outcome: finalOutcome,
      observedBenefit: finalBenefit,
      evidenceRefs: refs,
      proposedEvolution,
      rationale: reason
    });
    const feedback = this.personal.addFeedback({
      ...normalized,
      runId: runId || usage.targetRunId,
      evolutionProposalId: evolution?.id ?? null
    });
    // 把结果写回 usage，便于查询“这条知识有没有用”。
    this.personal.updateUsageOutcome(usageId, {
      outcome: finalOutcome,
      observedBenefit: finalBenefit,
      outcomeEvidenceRefs: refs
    });
    return { feedback, evolution, duplicate: false };
  }

  positiveUsages(knowledgeId) {
    return this.personal.listUsages({ knowledgeId, limit: 1000 })
      .filter((usage) => usage.observedBenefit === 'positive')
      .map((usage) => usage.id);
  }
}
