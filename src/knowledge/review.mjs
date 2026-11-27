// 知识模式候选审核：复用 PersonalKnowledgeStore.reviewProposal 的既有状态机。
//
// 这里不新建状态流转，也不在面板里做乐观更新；只把提案 id 与决策交给存储层，
// 再把存储层的英文冲突错误翻成可执行的中文提示。返回结构化结果而不是抛异常，
// 避免 Electron IPC 把错误包成一段前缀很长的字符串。

import { CANDIDATE_CONTRACT } from '../knowledge-loop/contracts.mjs';

const DECISIONS = new Set(['approved', 'rejected']);

/**
 * 把审核状态机抛出的错误翻成中文提示。
 * 未识别的错误保留原文，方便排查而不是吞掉。
 */
export function reviewFailureReason(error) {
  const message = String(error?.message ?? error ?? '');
  if (/Proposal not found/u.test(message)) return '候选不存在，可能已被清理；刷新后再试。';
  if (/already reviewed/u.test(message)) return '这条候选已经审核过了；刷新查看最新分组。';
  if (/Target changed since proposal/u.test(message)) return '候选基于的知识已经被改过；刷新后重新审核。';
  if (/Target knowledge was removed/u.test(message)) return '候选要更新的知识已被删除；这条候选无法接受。';
  if (/cannot change target scope/u.test(message)) return '候选改动了所属范围或项目，需要在工作台人工处理。';
  if (/Invalid proposal decision/u.test(message)) return '审核动作无效，只支持接受或拒绝。';
  return message || '审核失败，请稍后再试。';
}

/**
 * 接受或拒绝一条知识候选。
 *
 * @param {object} input
 * @param {object|null} input.personalStore 本地知识库
 * @param {string} input.id 候选（personal_proposals）id
 * @param {'approved'|'rejected'} input.decision 接受或拒绝
 * @param {string} [input.reviewer] 审核人标识，默认本地用户
 * @returns {{ok: boolean, id: string, decision: string|null, reason: string|null,
 *   status?: string, appliedId?: string|null}}
 */
export function knowledgeReviewFor({
  personalStore,
  id,
  decision,
  reviewer = 'local-user', edits = null, expectedHash = ''
} = {}) {
  const proposalId = String(id ?? '');
  const fail = (reason) => ({
    ok: false,
    id: proposalId,
    decision: decision ?? null,
    reason
  });

  if (!personalStore) return fail('知识库尚未初始化，无法审核候选。');
  if (!proposalId) return fail('候选不存在，请刷新后重试。');
  if (!DECISIONS.has(decision)) return fail('审核动作无效，只支持接受或拒绝。');

  let proposal = null;
  try {
    proposal = personalStore.proposal(proposalId);
  } catch (error) {
    return fail(reviewFailureReason(error));
  }
  if (!proposal) return fail('候选不存在，可能已被清理；刷新后再试。');
  // 知识模式只处理候选；其他类型的提案仍应回到工作台审核。
  if (proposal.meta?.contract !== CANDIDATE_CONTRACT) {
    return fail('这条内容不是知识候选，请到工作台审核。');
  }
  if (proposal.status !== 'pending') {
    return fail('这条候选已经审核过了；刷新查看最新分组。');
  }

  try {
    const done = personalStore.reviewProposal(proposalId, {
      decision,
      reviewer, edits, expectedProposalHash: expectedHash,
      // 有目标知识时把提案钉住的修订号一并传下去，冲突让存储层拒绝。
      expectedRevision: proposal.target_revision ?? null
    });
    return {
      ok: true,
      id: proposalId,
      decision,
      status: done?.status ?? decision,
      appliedId: done?.applied_id ?? null,
      item: done?.applied_id ? personalStore.get(done.applied_id) : null,
      reason: null
    };
  } catch (error) {
    return fail(reviewFailureReason(error));
  }
}
