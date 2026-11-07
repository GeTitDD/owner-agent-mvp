// 沙箱提交与审批的服务层。
//
// 与 v0.9/v1.0 的 CLI 行为保持一致：快照只来自“已应用且复核通过”的提案 +
// Owner 精确 includePaths；审批哈希覆盖 project/workspace/proposal/profile/
// snapshot/includePaths，任何一项变化都会导致运行失败。
import { randomUUID } from 'node:crypto';
import { OwnerInputError } from './owner-store.mjs';
import { approvalHash, normalizeIncludePaths, resolveTestProfile } from './sandbox-protocol.mjs';
import {
  cleanupInputSnapshot,
  createInputSnapshot,
  defaultSandboxRoot,
  verifyInputSnapshot
} from './sandbox-materializer.mjs';
import { sha256 } from './utils.mjs';

/**
 * 为已应用的补丁提案创建一个待审批的沙箱运行。
 *
 * @param {import('./owner-store.mjs').OwnerStore} store
 * @param {import('./workspace-broker.mjs').WorkspaceBroker} broker
 * @param {{proposalId: string, profileId?: string, includePaths?: string[],
 *          imageDigest?: string, repairCycleId?: string, sandboxRoot?: string}} input
 * @returns {Promise<object>} 带 approvalHash / snapshotHash 的 sandbox run
 */
export async function submitSandboxRun(store, broker, {
  proposalId,
  profileId = 'node-smoke',
  includePaths = [],
  imageDigest = '',
  repairCycleId = '',
  sandboxRoot = ''
} = {}) {
  const proposal = store.getPatchProposal(proposalId);
  if (!proposal) throw new OwnerInputError('Unknown proposal', 404);
  if (proposal.status !== 'applied') {
    throw new OwnerInputError(`Proposal in status ${proposal.status} cannot be sandboxed`, 409);
  }
  const workspace = store.getWorkspace(proposal.workspace_id);
  if (!workspace) throw new OwnerInputError('Workspace not found for this proposal', 404);

  // 运行前复核工作树，防止“审批后被改写”。
  const verify = await broker.verifyApplied(workspace, proposal);
  if (!verify || !verify.ok) {
    throw new OwnerInputError(
      `confirm-applied verification failed: ${verify?.reason ?? 'worktree does not match the proposal'}`,
      409
    );
  }

  const profile = resolveTestProfile(profileId, { imageDigest: imageDigest || undefined });
  const normalizedIncludes = normalizeIncludePaths(includePaths);
  const cycleId = proposal.repair_cycle_id || repairCycleId || null;
  if (cycleId) {
    // 修复复测必须与源 Run 的 profile/image/includePaths 完全一致。
    store.assertRepairSandboxMatch({
      repairCycleId: cycleId,
      proposalId: proposal.id,
      baseSha: proposal.base_sha,
      profile,
      includePaths: normalizedIncludes
    });
  }

  const runId = randomUUID();
  const root = sandboxRoot || defaultSandboxRoot();
  const snapshot = createInputSnapshot({
    runId,
    workspacePath: workspace.path,
    proposal,
    includePaths: normalizedIncludes,
    sandboxRoot: root
  });
  const approval = approvalHash({
    projectId: proposal.project_id,
    workspaceId: workspace.id,
    proposalId: proposal.id,
    approvedHash: proposal.approved_hash,
    baseSha: proposal.base_sha,
    profile,
    snapshotHash: snapshot.snapshotHash,
    includePaths: normalizedIncludes
  });

  try {
    const run = store.createSandboxRun({
      id: runId,
      projectId: proposal.project_id,
      jobId: proposal.job_id,
      attempt: proposal.attempt,
      workspaceId: workspace.id,
      proposalId: proposal.id,
      approvedHash: proposal.approved_hash,
      baseSha: proposal.base_sha,
      profile,
      approvalHash: approval,
      snapshotHash: snapshot.snapshotHash,
      snapshotPath: snapshot.snapshotPath,
      includePaths: normalizedIncludes,
      repairCycleId: cycleId
    });
    const manifest = JSON.stringify(snapshot.manifest);
    store.saveSandboxEvidence(runId, 'snapshot_manifest', {
      content: manifest,
      contentHash: sha256(manifest),
      bytes: Buffer.byteLength(manifest)
    });
    return { ...run, approvalHash: approval, snapshotHash: snapshot.snapshotHash };
  } catch (error) {
    // 失败时不要留下误挂的快照目录。
    try {
      cleanupInputSnapshot({
        snapshotPath: snapshot.snapshotPath,
        runId,
        snapshotHash: snapshot.snapshotHash,
        sandboxRoot: root
      });
    } catch { /* best effort */ }
    throw error;
  }
}

/**
 * 复核快照并按哈希批准一次沙箱运行。
 *
 * @param {import('./owner-store.mjs').OwnerStore} store
 * @param {{runId: string, hash: string, actor?: string}} input
 * @returns {object}
 */
export function approveSandboxRun(store, { runId, hash, actor = 'owner' }) {
  const run = store.getSandboxRun(runId);
  if (!run) throw new OwnerInputError('Unknown sandbox run', 404);
  const manifest = store.getSandboxEvidence(runId, 'snapshot_manifest');
  if (!manifest) throw new OwnerInputError('Sandbox snapshot manifest is missing', 409);
  verifyInputSnapshot({
    snapshotPath: run.snapshot_path,
    manifest: JSON.parse(manifest.content),
    snapshotHash: run.snapshot_hash
  });
  return store.approveSandboxRun(runId, { expectedHash: hash, actor });
}
