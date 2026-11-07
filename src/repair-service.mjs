// Owner-controlled Patch–Test–Repair orchestration.
//
// The service only assembles bounded context and creates frozen records. It never mutates
// the source worktree, never applies a patch and never starts a sandbox test.
import { randomUUID } from 'node:crypto';
import { sha256 } from './utils.mjs';
import {
  buildRepairContext,
  normalizeRepairScope,
  repairApprovalHash,
  sourceChainHash,
  sourceEvidenceHash
} from './repair-protocol.mjs';

const check = (ok, message, status = 400) => {
  if (!ok) {
    const error = new Error(message);
    error.status = status;
    throw error;
  }
};

const MAX_DIFF_BYTES = 1_048_576;

// v1.0 blocker 2: never trust the stored hash field. Re-hash the actual artifact
// content so a row whose content changed while metadata stayed intact is rejected.
const loadVerifiedProposalDiff = (store, proposalId) => {
  const artifact = store.getPatchArtifact(proposalId, 'proposal_diff');
  check(!!artifact, 'Source proposal diff artifact is missing', 409);
  check(typeof artifact.content === 'string' && artifact.content.length > 0,
    'Source proposal diff is empty', 409);
  check(Buffer.byteLength(artifact.content, 'utf8') <= MAX_DIFF_BYTES,
    'Source proposal diff exceeds the size limit', 409);
  check(sha256(artifact.content) === artifact.content_hash,
    'Source proposal diff content hash mismatch', 409);
  return artifact.content;
};

const loadSource = (store, sandboxRunId) => {
  const run = store.getSandboxRun(sandboxRunId);
  check(!!run, 'Unknown sandbox run', 404);
  check(run.status === 'completed' && run.execution_status === 'completed' && run.test_status === 'fail',
    'Repair requires a completed failed test run', 409);
  check(!run.repair_cycle_id, 'Repair-of-repair is not supported in v1.0', 409);
  const proposal = store.getPatchProposal(run.proposal_id);
  check(!!proposal, 'Source proposal is missing', 404);
  check(proposal.status === 'applied', 'Source proposal is not applied', 409);
  const workspace = store.getWorkspace(run.workspace_id);
  check(!!workspace, 'Source workspace is missing', 404);
  const job = store.getJob(run.job_id);
  check(!!job && !!job.owner_task_id, 'Source job/owner task is missing', 404);
  const task = store.getTask(job.owner_task_id);
  check(!!task && task.project_id === run.project_id, 'Source task belongs to a different project', 409);
  const evidence = {
    stdout: store.getSandboxEvidence(run.id, 'stdout'),
    stderr: store.getSandboxEvidence(run.id, 'stderr'),
    result: store.getSandboxEvidence(run.id, 'result')
  };
  check(!!evidence.result, 'Source test result evidence is missing', 409);
  for (const kind of ['stdout', 'stderr', 'result']) {
    const row = evidence[kind];
    if (!row) continue;
    check(typeof row.content === 'string', `Source ${kind} evidence content is missing`, 409);
    check(sha256(row.content) === row.content_hash, `Source ${kind} evidence content hash mismatch`, 409);
    check(Buffer.byteLength(row.content, 'utf8') <= 200000, `Source ${kind} evidence exceeds the size limit`, 409);
  }
  for (const kind of ['stdout', 'stderr']) {
    const row = evidence[kind];
    if (!row) {
      check((run[`${kind}_bytes`] ?? 0) === 0, `Source ${kind} evidence is missing`, 409);
      continue;
    }
    check(run[`${kind}_bytes`] === row.bytes, `Source ${kind} evidence size mismatch`, 409);
    check(run[`${kind}_hash`] === row.content_hash, `Source ${kind} evidence hash mismatch`, 409);
  }
  const diff = loadVerifiedProposalDiff(store, proposal.id);
  return { run, proposal, workspace, job, task, evidence, diff };
};

export function submitRepairCycle(store, {
  sandboxRunId,
  scope,
  idempotencyKey,
  now = new Date().toISOString()
} = {}) {
  const source = loadSource(store, sandboxRunId);
  const normalizedScope = normalizeRepairScope(scope, source.proposal.allowedPaths);
  const evidenceHash = sourceEvidenceHash(source.run, source.evidence);
  const chain = sourceChainHash({
    run: { ...source.run, owner_task_id: source.job.owner_task_id },
    proposal: source.proposal,
    workspace: source.workspace,
    evidenceHash,
    snapshotHash: source.run.snapshot_hash
  });
  const context = buildRepairContext({
    run: { ...source.run, owner_task_id: source.job.owner_task_id },
    evidence: source.evidence,
    proposal: source.proposal,
    proposalDiff: source.diff,
    scope: normalizedScope
  });
  const approvalHash = repairApprovalHash({
    sourceChain: chain,
    scope: normalizedScope,
    contextHash: context.contextHash
  });

  const existing = store.getRepairCycleByKey(source.run.project_id, idempotencyKey);
  if (existing) {
    check(existing.source_sandbox_run_id === sandboxRunId
      && existing.source_base_sha === source.run.base_sha
      && JSON.stringify(existing.repairScope) === JSON.stringify(normalizedScope)
      && existing.context_hash === context.contextHash,
      'Idempotency key reused with a different repair request', 409);
    return { ...store.getRepairCycle(existing.id), duplicate: true };
  }
  const bySource = store.getRepairCycleBySourceRun(sandboxRunId);
  check(!bySource, 'A repair cycle already exists for this source run', 409);

  const cycle = store.createRepairCycle({
    id: randomUUID(),
    projectId: source.run.project_id,
    ownerTaskId: source.job.owner_task_id,
    sourceProposalId: source.proposal.id,
    sourceWorkspaceId: source.workspace.id,
    sourceSandboxRunId: source.run.id,
    sourceEvidenceHash: evidenceHash,
    sourceSnapshotHash: source.run.snapshot_hash,
    sourceBaseSha: source.run.base_sha,
    sourceChainHash: chain,
    repairScope: normalizedScope,
    contextText: context.text,
    contextHash: context.contextHash,
    approvalHash,
    idempotencyKey,
    now
  });
  return cycle;
}

// One Owner approval creates and approves exactly one bounded repair Job. Retrying is
// idempotent: a pending job is approved, an already queued job just binds the cycle.
export function approveRepairCycle(store, {
  id,
  expectedHash,
  actor = 'owner',
  now = new Date().toISOString()
} = {}) {
  let cycle = store.getRepairCycle(id);
  check(!!cycle, 'Unknown repair cycle', 404);
  check(expectedHash === cycle.approval_hash, 'Repair approval hash does not match the frozen cycle', 409);
  if (cycle.status === 'queued') return { ...cycle, duplicate: true };
  check(cycle.status === 'pending_approval', `Repair cycle in status ${cycle.status} cannot be approved`, 409);

  // Re-check the source evidence right before creating any execution side effect.
  const source = loadSource(store, cycle.source_sandbox_run_id);
  const evidenceHash = sourceEvidenceHash(source.run, source.evidence);
  const chain = sourceChainHash({
    run: { ...source.run, owner_task_id: source.job.owner_task_id },
    proposal: source.proposal,
    workspace: source.workspace,
    evidenceHash,
    snapshotHash: source.run.snapshot_hash
  });
  check(evidenceHash === cycle.source_evidence_hash, 'Source evidence changed; repair approval is stale', 409);
  check(chain === cycle.source_chain_hash, 'Source chain changed; repair approval is stale', 409);
  const rebuiltContext = buildRepairContext({
    run: { ...source.run, owner_task_id: source.job.owner_task_id },
    evidence: source.evidence,
    proposal: source.proposal,
    proposalDiff: source.diff,
    scope: cycle.repairScope
  });
  check(rebuiltContext.contextHash === cycle.context_hash, 'Repair context changed; approval is stale', 409);

  // v1.0 blocker 3: create + approve + bind happen in one IMMEDIATE transaction, so the
  // repair job can never be claimed before the cycle points at it.
  return store.approveRepairCycleJob({ cycleId: id, expectedHash, actor, now });
}

// v1.0 blocker 4: trusted host-side re-verification before any model call. The frozen
// context, source evidence/chain and the repair job scope/base must all still match.
export function verifyRepairCycleForJob(store, job) {
  const cycleId = typeof job?.payload?.repairCycleId === 'string' ? job.payload.repairCycleId : '';
  check(!!cycleId, 'Job is not a repair job', 409);
  const cycle = store.getRepairCycle(cycleId);
  check(!!cycle, 'Unknown repair cycle', 404);
  check(job.job_type === 'code-patch', 'Repair job type is invalid', 409);
  check(job.project_id === cycle.project_id, 'Repair job belongs to a different project', 409);
  check(job.owner_task_id === cycle.owner_task_id, 'Repair job belongs to a different owner task', 409);
  check(cycle.job_id === job.id, 'Repair cycle is not bound to this job', 409);
  check(['queued', 'running'].includes(cycle.status),
    `Repair cycle in status ${cycle.status} cannot run`, 409);
  check(cycle.iteration === 1 && cycle.max_iterations === 1, 'Repair cycle iteration budget is invalid', 409);
  check(job.payload.baseSha === cycle.source_base_sha, 'Repair job base does not match the frozen source', 409);
  check(job.payload.allowedPaths === cycle.repairScope.join(','),
    'Repair job scope does not match the frozen repair scope', 409);
  check(typeof cycle.context_text === 'string' && cycle.context_text.length > 0,
    'Repair context is missing', 409);
  check(sha256(cycle.context_text) === cycle.context_hash, 'Repair context hash mismatch', 409);

  const source = loadSource(store, cycle.source_sandbox_run_id);
  const evidenceHash = sourceEvidenceHash(source.run, source.evidence);
  check(evidenceHash === cycle.source_evidence_hash,
    'Source evidence changed after approval; repair run is refused', 409);
  const chain = sourceChainHash({
    run: { ...source.run, owner_task_id: source.job.owner_task_id },
    proposal: source.proposal,
    workspace: source.workspace,
    evidenceHash,
    snapshotHash: source.run.snapshot_hash
  });
  check(chain === cycle.source_chain_hash,
    'Source chain changed after approval; repair run is refused', 409);
  const rebuilt = buildRepairContext({
    run: { ...source.run, owner_task_id: source.job.owner_task_id },
    evidence: source.evidence,
    proposal: source.proposal,
    proposalDiff: source.diff,
    scope: cycle.repairScope
  });
  check(rebuilt.contextHash === cycle.context_hash, 'Rebuilt repair context differs from the approved one', 409);
  check(rebuilt.text === cycle.context_text, 'Frozen repair context differs from the approved source', 409);
  return { cycleId, contextText: cycle.context_text, contextHash: cycle.context_hash };
}
