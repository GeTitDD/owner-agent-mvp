// Knowledge Reuse：复用现有 Domain Context Compiler + workspace overlay，
// 记录本次任务实际选择了哪些知识及其 revision / snapshot。
import { normalizeUsage } from './contracts.mjs';

const workspaceRef = /^workspace:([^:]+):r(\d+)$/u;

export function personalRefsFromPlan(plan) {
  return (plan?.knowledgeRefs ?? []).map((key) => {
    const match = workspaceRef.exec(key);
    return match ? { key, knowledgeId: match[1], revision: Number(match[2]) } : null;
  }).filter(Boolean);
}

export class KnowledgeReuse {
  constructor({ personalStore, engine, ownerStore = null, contextLedger = null } = {}) {
    if (!personalStore) throw new Error('personalStore is required');
    if (!engine) throw new Error('engine is required');
    this.personal = personalStore;
    this.engine = engine;
    this.owner = ownerStore;
    this.ledger = contextLedger;
  }

  /** 检索当前项目可用的知识与适用性，不写入 usage。 */
  retrieve({ snapshot, task, limit = 5 }) {
    return this.engine.retrieve({ snapshot, query: task, limit }).map((rec) => {
      const match = workspaceRef.exec(rec.key);
      const unit = match ? this.personal.get(match[1]) : null;
      return {
        ...rec,
        knowledgeId: match ? match[1] : null,
        revision: unit?.revision ?? (match ? Number(match[2]) : null),
        personal: Boolean(unit)
      };
    });
  }

  /**
   * 编译任务上下文，并为实际进入上下文的个人知识记录 usage。
   * targetRunId 缺省时不写 usage（只用于预览/测试）。
   */
  async compileAsync({ cwd, task, targetRunId = '', maxTokens, sessionId, projectId } = {}) {
    const snapshot = await this.engine.resolve({ cwd, sessionId });
    if (!snapshot) return { snapshot: null, plan: null, usages: [] };
    const plan = this.engine.compile({ snapshot, task, maxTokens });
    if (!targetRunId) return { snapshot, plan, usages: [] };
    const applicability = new Map((plan.applicability ?? []).map((item) => [item.key, item.state]));
    const usages = [];
    for (const ref of personalRefsFromPlan(plan)) {
      const unit = this.personal.get(ref.knowledgeId);
      if (!unit) continue;
      const state = applicability.get(ref.key);
      if (!['applicable', 'needs_verification'].includes(state)) continue;
      const usage = this.personal.addUsage(normalizeUsage({
        knowledgeId: ref.knowledgeId,
        revision: unit.revision,
        targetRunId,
        projectId: projectId ?? snapshot.profile.id,
        retrievalReason: task,
        applicabilityResult: state,
        contextSnapshotId: plan.compilationHash,
        outcomeEvidenceRefs: [],
        observedBenefit: 'unknown',
        unresolvedQuestions: []
      }));
      usages.push(usage);
    }
    this.recordContext({ plan, task, projectId: projectId ?? snapshot.profile.id, sessionId });
    return { snapshot, plan, usages };
  }

  /** Pi 扩展使用：从编译结果和 session 记录 usage，不返回项目内容。 */
  recordFromPlan({ plan, task, targetRunId, projectId, sessionId = '' }) {
    if (!plan || !targetRunId) return [];
    const applicability = new Map((plan.applicability ?? []).map((item) => [item.key, item.state]));
    const usages = [];
    for (const ref of personalRefsFromPlan(plan)) {
      const unit = this.personal.get(ref.knowledgeId);
      if (!unit) continue;
      const state = applicability.get(ref.key);
      if (!['applicable', 'needs_verification'].includes(state)) continue;
      usages.push(this.personal.addUsage(normalizeUsage({
        knowledgeId: ref.knowledgeId,
        revision: unit.revision,
        targetRunId,
        projectId,
        retrievalReason: task,
        applicabilityResult: state,
        contextSnapshotId: plan.compilationHash ?? plan.snapshotId,
        outcomeEvidenceRefs: [],
        observedBenefit: 'unknown',
        unresolvedQuestions: []
      })));
    }
    this.recordContext({ plan, task, projectId, sessionId: sessionId || targetRunId });
    return usages;
  }

  /** 记录上下文快照；失败不影响本次编译（只有审计价值，不是主路径）。 */
  recordContext({ plan, task, projectId, sessionId = '' }) {
    if (!this.ledger) return;
    try {
      this.ledger.record({ projectId, sessionId, task, plan });
    } catch { /* 台账失败不回滚编译 */ }
  }
}
