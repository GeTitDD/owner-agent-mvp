// 补丁审批与应用的服务层。
//
// CLI（bin/ownerctl.mjs）与 sidecar 共用这里，避免出现两套“批准 + 应用”语义：
// - 审批必须携带 64-hex 的 proposal hash；
// - 已应用时幂等返回 already-applied；
// - 任何状态不符都由 OwnerStore 抛 409，调用方不要自行放宽。
import { OwnerInputError } from './owner-store.mjs';

/**
 * 审批并应用一个补丁提案。
 *
 * @param {import('./owner-store.mjs').OwnerStore} store
 * @param {import('./workspace-broker.mjs').WorkspaceBroker} broker
 * @param {{proposalId: string, hash: string, reviewer?: string}} input
 * @returns {Promise<{outcome: string, proposal: object}>}
 */
export async function approveAndApplyPatch(store, broker, { proposalId, hash, reviewer = 'owner' }) {
  const proposal = store.getPatchProposal(proposalId);
  if (!proposal) throw new OwnerInputError('Unknown proposal', 404);
  // 与 CLI 一致：只有 proposed 才需要先落审批；approved/applied 走幂等分支。
  if (proposal.status === 'proposed') {
    store.approvePatchProposal(proposalId, { expectedHash: hash, reviewer });
  }
  return applyApprovedPatch(store, broker, { proposalId, hash });
}

/**
 * 应用一个已经审批的补丁提案（幂等）。
 *
 * @param {import('./owner-store.mjs').OwnerStore} store
 * @param {import('./workspace-broker.mjs').WorkspaceBroker} broker
 * @param {{proposalId: string, hash: string}} input
 * @returns {Promise<{outcome: string, proposal: object}>}
 */
export async function applyApprovedPatch(store, broker, { proposalId, hash }) {
  const check = store.assertPatchApplyAllowed(proposalId, { expectedHash: hash });
  if (check.alreadyApplied) return { outcome: 'already-applied', proposal: check.proposal };
  const workspace = store.getWorkspaceForAttempt(check.proposal.job_id, check.proposal.attempt);
  if (!workspace) throw new OwnerInputError('Workspace not found for this job attempt', 404);
  return broker.applyProposal(workspace, check.proposal);
}
