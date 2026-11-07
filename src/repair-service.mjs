// Owner-controlled Patch–Test–Repair orchestration.
//
// The service only assembles bounded context and creates frozen records. It never mutates
// the source worktree, never applies a patch and never starts a sandbox test.
import { randomUUID } from 'node:crypto';
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
  for (const kind of ['stdout', 'stderr']) {
    const row = evidence[kind];
    if (!row) {
      check((run[`${kind}_bytes`] ?? 0) === 0, `Source ${kind} evidence is missing`, 409);
      continue;
    }
    check(run[`${kind}_bytes`] === row.bytes, `Source ${kind} evidence size mismatch`, 409);
    check(run[`${kind}_hash`] === row.content_hash, `Source ${kind} evidence hash mismatch`, 409);
  }
  return { run, proposal, workspace, job, task, evidence };
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
  const proposalDiff = store.getPatchArtifactContent(source.proposal.id, 'proposal_diff') ?? '';
  const context = buildRepairContext({
    run: { ...source.run, owner_task_id: source.job.owner_task_id },
    evidence: source.evidence,
    proposal: source.proposal,
    proposalDiff,
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
  const proposalDiff = store.getPatchArtifactContent(source.proposal.id, 'proposal_diff') ?? '';
  const rebuiltContext = buildRepairContext({
    run: { ...source.run, owner_task_id: source.job.owner_task_id },
    evidence: source.evidence,
    proposal: source.proposal,
    proposalDiff,
    scope: cycle.repairScope
  });
  check(rebuiltContext.contextHash === cycle.context_hash, 'Repair context changed; approval is stale', 409);

  const idempotencyKey = `repair-${id}`;
  let job = store.createJob({
    projectId: cycle.project_id,
    jobType: 'code-patch',
    title: `Repair cycle ${id}`.slice(0, 200),
    payload: {
      baseSha: cycle.source_base_sha,
      allowedPaths: cycle.repairScope.join(','),
      focus: `bounded repair ${id}`.slice(0, 300),
      repairCycleId: id
    },
    idempotencyKey,
    ownerTaskId: cycle.owner_task_id,
    actor
  });
  if (job.status === 'pending_approval') job = store.approveJob(job.id, { actor, now });
  check(['queued', 'leased', 'running'].includes(job.status), `Repair job is in status ${job.status}`, 409);
  const queued = store.markRepairCycleQueued(id, { jobId: job.id, expectedHash, actor, now });
  return queued;
}
