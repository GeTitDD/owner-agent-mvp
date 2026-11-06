// PatchCodingWorker — v0.8 patch-first coding worker (control plane only).
//
// Flow: claim(code-patch) → WorkspaceBroker worktree (base-pinned) → PatchProposalAgent
// (isolated tool-free session; the real path requires --allow-model) → host-side proposal
// validation → atomic proposal storage. It NEVER applies patches: apply happens only after
// the Owner's explicit patch-approve through the trusted host (WorkspaceBroker.applyProposal).
// Cancel/timeout/fence never apply anything and quarantine the workspace as evidence.
import { sha256 } from './utils.mjs';
import {
  PATCH_LIMITS,
  normalizeAllowedEntries,
  proposalMetadata,
  validateProposal
} from './patch-protocol.mjs';
import { PatchProposalAgent } from './patch-proposal-agent.mjs';
import { WorkspaceBroker } from './workspace-broker.mjs';
import { verifyProjectRoot } from './project-identity.mjs';

const checkBase = (value) => {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error('payload.baseSha must be an explicit 40-hex commit SHA');
  }
};

const splitAllowed = (value) => {
  if (typeof value !== 'string') throw new Error('payload.allowedPaths must be a comma-separated string');
  const raw = value.split(',').map((part) => part.trim()).filter(Boolean);
  if (raw.length === 0) throw new Error('no allowed paths configured');
  if (raw.length > PATCH_LIMITS.maxAllowedPaths) throw new Error('too many allowed paths');
  return raw;
};

const WORKER_CATEGORIES = new Set([
  'invalid-proposal', 'timeout', 'aborted', 'unconfirmed-stop', 'isolation-error',
  'proposal-error', 'session-aborted', 'auth-error', 'network-error', 'session-error',
  'workspace-error', 'worker-error'
]);

const classifyWorkerError = (error) => {
  const category = String(error?.category ?? '');
  if (WORKER_CATEGORIES.has(category)) return category;
  const name = String(error?.name ?? '');
  if (/abort/i.test(name)) return 'session-aborted';
  if (/timeout/i.test(name)) return 'timeout';
  if (/workspace/i.test(String(error?.message ?? ''))) return 'workspace-error';
  return 'worker-error';
};

export class PatchCodingWorker {
  constructor(store, {
    workerId = 'patch-coding-worker',
    leaseMs = 30000,
    clock = () => new Date().toISOString(),
    broker = null,
    proposalAgent = null,
    model = '',
    timeoutMs = 120000,
    abortConfirmMs = 5000,
    maxFiles = PATCH_LIMITS.maxFiles,
    maxFileBytes = PATCH_LIMITS.maxFileBytes,
    timers = {
      interval: (fn, ms) => setInterval(fn, ms),
      timeout: (fn, ms) => setTimeout(fn, ms),
      clear: (handle) => {
        clearInterval(handle);
        clearTimeout(handle);
      }
    }
  } = {}) {
    this.store = store;
    this.workerId = workerId;
    this.leaseMs = leaseMs;
    this.clock = clock;
    this.broker = broker ?? new WorkspaceBroker(store);
    this.proposalAgent = proposalAgent ?? new PatchProposalAgent({ model });
    this.timeoutMs = timeoutMs;
    this.abortConfirmMs = abortConfirmMs;
    this.maxFiles = maxFiles;
    this.maxFileBytes = maxFileBytes;
    this.timers = timers;
  }

  async runOnce({ projectId, allowModel = false } = {}) {
    // Refused before claiming: no state change, no model call, no worktree, no cost.
    if (this.proposalAgent.requiresModel && !allowModel) {
      return { claimed: false, reason: 'model-disabled' };
    }
    const project = this.store.getProject(projectId);
    if (!project) return { claimed: false, reason: 'unknown-project' };
    const rootCheck = verifyProjectRoot(project);
    if (!rootCheck.ok) return { claimed: false, reason: rootCheck.reason };

    const claim = this.store.claimNextJob(projectId, this.workerId, {
      now: this.clock(),
      leaseMs: this.leaseMs,
      allowedTypes: ['code-patch']
    });
    if (!claim.claimed) return claim;

    const { job, attempt } = claim;
    const guard = (fn) => {
      try {
        return fn();
      } catch {
        return false;
      }
    };
    const controller = new AbortController();
    let fenced = false;
    let workspace = null;
    let cancelDetected = false;
    let signalCancel = null;
    const cancelSeen = new Promise((resolve) => { signalCancel = resolve; });

    const tick = () => {
      try {
        this.store.heartbeatJob(job.id, attempt.attempt, {
          workerId: this.workerId,
          now: this.clock(),
          leaseMs: this.leaseMs
        });
      } catch {
        fenced = true;
        controller.abort();
        return;
      }
      try {
        if (this.store.getJob(job.id).status === 'cancel_requested') {
          cancelDetected = true;
          controller.abort();
          signalCancel({ cancelled: true });
        }
      } catch {
        // The next tick re-checks; a failed heartbeat is the authoritative fence.
      }
    };
    const tickMs = Math.max(1000, Math.floor(this.leaseMs / 3));
    const tickTimer = this.timers.interval(tick, tickMs);

    const fail = (note) => {
      if (workspace) {
        guard(() => this.store.quarantineWorkspace(workspace.id, {
          reason: note,
          now: this.clock()
        }));
      }
      const reported = guard(() => this.store.reportJobResult(job.id, attempt.attempt, {
        workerId: this.workerId,
        outcome: 'failed',
        note,
        now: this.clock()
      }));
      return {
        claimed: true,
        jobId: job.id,
        attempt: attempt.attempt,
        outcome: reported ? 'failed' : 'fenced'
      };
    };
    const cancelled = (note) => {
      if (workspace) {
        guard(() => this.store.quarantineWorkspace(workspace.id, {
          reason: note,
          now: this.clock()
        }));
      }
      const confirmed = guard(() => this.store.confirmJobCancelled(job.id, attempt.attempt, {
        workerId: this.workerId,
        note,
        now: this.clock()
      }));
      return {
        claimed: true,
        jobId: job.id,
        attempt: attempt.attempt,
        outcome: confirmed ? 'cancelled' : 'fenced'
      };
    };

    try {
      if (this.store.getJob(job.id).status === 'cancel_requested') {
        return cancelled('cancelled before workspace creation');
      }
      this.store.startJob(job.id, attempt.attempt, {
        workerId: this.workerId,
        now: this.clock()
      });

      // ---- structured payload validation (host-side, before any worktree side effect) ----
      let allowedRaw;
      let entries;
      try {
        checkBase(job.payload.baseSha);
        allowedRaw = splitAllowed(job.payload.allowedPaths);
        entries = normalizeAllowedEntries(allowedRaw);
      } catch {
        return fail('invalid code-patch payload');
      }

      // ---- isolated worktree from the approved base ----
      let ws;
      try {
        ws = await this.broker.createWorkspace({
          projectId: job.project_id,
          jobId: job.id,
          attempt: attempt.attempt,
          baseSha: job.payload.baseSha
        });
      } catch {
        return fail('workspace creation rejected (dirty tree, base drift, missing git identity, or path conflict)');
      }
      workspace = ws.record;

      if (fenced) {
        guard(() => this.store.quarantineWorkspace(workspace.id, {
          reason: 'lease lost during workspace creation',
          now: this.clock()
        }));
        return { claimed: true, jobId: job.id, attempt: attempt.attempt, outcome: 'fenced' };
      }
      if (this.store.getJob(job.id).status === 'cancel_requested') {
        return cancelled('cancelled after workspace creation');
      }

      // ---- proposal generation through the isolated agent ----
      const snapshot = (() => {
        try {
          const parsed = JSON.parse(job.input_snapshot || '');
          if (parsed && typeof parsed === 'object') return parsed;
        } catch {
          // Falls back to the job title below.
        }
        return { title: job.title, note: '' };
      })();
      let material;
      try {
        material = this.broker.readMaterial(workspace, entries);
      } catch {
        return fail('approved material could not be read');
      }

      const generation = Promise.resolve()
        .then(() => this.proposalAgent.generate({
          cwd: workspace.path,
          signal: controller.signal,
          taskTitle: String(snapshot.title ?? job.title).slice(0, 200),
          taskNote: String(snapshot.note ?? '').slice(0, 500),
          focus: String(job.payload.focus ?? '').slice(0, 300),
          material
        }))
        .then((value) => ({ value }))
        .catch((error) => ({ error }));

      let generationTimer = null;
      let timedOut = false;
      let generationResult;
      try {
        generationResult = await Promise.race([
          generation,
          cancelSeen,
          new Promise((resolve) => {
            generationTimer = this.timers.timeout(() => {
              timedOut = true;
              controller.abort();
              resolve({ generationTimedOut: true });
            }, this.timeoutMs);
          })
        ]);
      } finally {
        if (generationTimer !== null) this.timers.clear(generationTimer);
      }

      // Wait for the OUTER generation promise to settle and return its final payload. A
      // cancelSeen race winner must not be mistaken for the generator's final state: the
      // Agent may reject later with `unconfirmed-stop` even though the wrapper promise
      // itself becomes fulfilled.
      const waitSettled = async () => {
        let result = null;
        let waitTimedOut = false;
        let confirmTimer = null;
        try {
          result = await Promise.race([
            generation,
            new Promise((resolve) => {
              confirmTimer = this.timers.timeout(() => {
                waitTimedOut = true;
                resolve(null);
              }, this.abortConfirmMs);
            })
          ]);
        } finally {
          if (confirmTimer !== null) this.timers.clear(confirmTimer);
        }
        return waitTimedOut ? { settled: false, result: null } : { settled: true, result };
      };
      const resultIsUnconfirmed = (result) =>
        Boolean(result?.error) && classifyWorkerError(result.error) === 'unconfirmed-stop';

      // Fence wins over any model output: no report, no proposal, keep evidence.
      if (fenced) {
        guard(() => this.store.quarantineWorkspace(workspace.id, {
          reason: 'lease lost during proposal generation',
          now: this.clock()
        }));
        return { claimed: true, jobId: job.id, attempt: attempt.attempt, outcome: 'fenced' };
      }
      if (cancelDetected || this.store.getJob(job.id).status === 'cancel_requested') {
        // A cancel request may only be confirmed after the generator has actually settled
        // (or the agent explicitly confirms its stop). Never release the project fence while
        // the model prompt could still be running.
        controller.abort();
        const waited = await waitSettled();
        if (!waited.settled || resultIsUnconfirmed(waited.result)) {
          guard(() => this.store.quarantineWorkspace(workspace.id, {
            reason: 'proposal generation stop could not be confirmed',
            now: this.clock()
          }));
          return {
            claimed: true,
            jobId: job.id,
            attempt: attempt.attempt,
            outcome: 'fenced',
            unconfirmedStop: true
          };
        }
        return cancelled('cancelled during proposal generation');
      }

      if (timedOut) {
        // Bounded stop confirmation: if the agent cannot confirm, stay fenced and let the
        // lease expire into human reconciliation instead of reporting a false stop.
        const waited = await waitSettled();
        const confirmed = waited.settled && !resultIsUnconfirmed(waited.result);
        if (!confirmed) {
          guard(() => this.store.quarantineWorkspace(workspace.id, {
            reason: 'proposal generation stop could not be confirmed',
            now: this.clock()
          }));
          return {
            claimed: true,
            jobId: job.id,
            attempt: attempt.attempt,
            outcome: 'fenced',
            unconfirmedStop: true
          };
        }
        return fail(`proposal generation timeout after ${this.timeoutMs}ms; session stopped`);
      }
      if (generationResult.error) {
        const category = classifyWorkerError(generationResult.error);
        if (category === 'unconfirmed-stop') {
          guard(() => this.store.quarantineWorkspace(workspace.id, {
            reason: 'proposal generation stop could not be confirmed',
            now: this.clock()
          }));
          return {
            claimed: true,
            jobId: job.id,
            attempt: attempt.attempt,
            outcome: 'fenced',
            unconfirmedStop: true
          };
        }
        return fail(`proposal generation failed (${category})`);
      }

      // ---- host-side proposal validation (never trust the model) ----
      let validated;
      try {
        validated = validateProposal({
          worktreeRoot: workspace.path,
          allowedPaths: allowedRaw,
          rawFiles: generationResult.value.files,
          maxFiles: this.maxFiles,
          maxFileBytes: this.maxFileBytes
        });
      } catch (error) {
        const category = error?.category === 'invalid-proposal' ? 'invalid-proposal' : classifyWorkerError(error);
        return fail(`proposal rejected (${category})`);
      }

      let proposalDiff;
      try {
        proposalDiff = await this.broker.buildProposalDiff(workspace.path, validated.files);
      } catch {
        return fail('proposal diff generation failed');
      }

      // A stop that landed while validating/diffing still wins over storage.
      if (fenced) {
        guard(() => this.store.quarantineWorkspace(workspace.id, {
          reason: 'lease lost before proposal storage',
          now: this.clock()
        }));
        return { claimed: true, jobId: job.id, attempt: attempt.attempt, outcome: 'fenced' };
      }
      if (this.store.getJob(job.id).status === 'cancel_requested') {
        return cancelled('cancelled before proposal storage');
      }

      const artifact = JSON.stringify({
        base_sha: job.payload.baseSha,
        allowed_paths: allowedRaw,
        files: validated.files.map((file) => ({
          path: file.path,
          action: file.action,
          old_sha: file.old_sha,
          new_sha: file.new_sha,
          content: file.content
        }))
      }, null, 1);
      const note = `proposal stored; sha:${validated.proposalHash.slice(0, 8)}; files:${validated.files.length}`;
      try {
        const stored = this.store.completeJobWithProposal({
          jobId: job.id,
          attemptNo: attempt.attempt,
          workerId: this.workerId,
          projectId: job.project_id,
          ownerTaskId: job.owner_task_id,
          workspaceId: workspace.id,
          baseSha: job.payload.baseSha,
          allowedPaths: allowedRaw,
          files: proposalMetadata(validated.files),
          proposalHash: validated.proposalHash,
          proposalArtifact: artifact,
          proposalDiff,
          note,
          now: this.clock()
        });
        return {
          claimed: true,
          jobId: job.id,
          attempt: attempt.attempt,
          outcome: 'succeeded',
          proposalId: stored.id,
          proposalHash: validated.proposalHash,
          files: validated.files.length,
          diffHash: sha256(proposalDiff)
        };
      } catch (error) {
        if (fenced) {
          guard(() => this.store.quarantineWorkspace(workspace.id, {
            reason: 'lease lost while storing proposal',
            now: this.clock()
          }));
          return { claimed: true, jobId: job.id, attempt: attempt.attempt, outcome: 'fenced' };
        }
        const current = this.store.getJob(job.id);
        if (current.status === 'cancel_requested') {
          return cancelled('cancelled while storing proposal');
        }
        return fail('proposal storage failed');
      }
    } catch (error) {
      // Unexpected worker error: fixed category only; the workspace is quarantined as
      // evidence and nothing is ever applied or retried automatically.
      if (fenced) {
        if (workspace) {
          guard(() => this.store.quarantineWorkspace(workspace.id, {
            reason: 'lease lost during worker error',
            now: this.clock()
          }));
        }
        return { claimed: true, jobId: job.id, attempt: attempt.attempt, outcome: 'fenced' };
      }
      return fail(`patch worker error (${classifyWorkerError(error)})`);
    } finally {
      this.timers.clear(tickTimer);
    }
  }
}
