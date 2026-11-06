// SandboxRunner — durable control-plane loop for one approved SandboxRun.
//
// It never executes project code in the host process. The trusted provider receives a
// frozen spec and runs the project test inside the restricted container. Cancel/timeout
// only stop the RunID-labelled container and require inspect-confirmed termination;
// unconfirmed stops become needs_reconciliation and keep the project fence.
import path from 'node:path';
import { sanitizeLog } from './sandbox-protocol.mjs';
import { verifyInputSnapshot } from './sandbox-materializer.mjs';
import { sha256 } from './utils.mjs';

export class SandboxRunner {
  constructor(store, {
    provider,
    workerId = 'sandbox-runner',
    leaseMs = 30000,
    clock = () => new Date().toISOString(),
    pollMs = 1000,
    providerOpMs = 60000,
    timers = {
      interval: (fn, ms) => setInterval(fn, ms),
      timeout: (fn, ms) => setTimeout(fn, ms),
      clear: (handle) => {
        clearInterval(handle);
        clearTimeout(handle);
      }
    }
  } = {}) {
    if (!provider) throw new Error('SandboxRunner requires a provider');
    this.store = store;
    this.provider = provider;
    this.workerId = workerId;
    this.leaseMs = leaseMs;
    this.clock = clock;
    this.pollMs = Math.max(0, pollMs);
    this.providerOpMs = providerOpMs;
    this.timers = timers;
  }

  sleep(ms) {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.timers.timeout(resolve, ms);
    });
  }

  async withDeadline(promise, ms, code) {
    let timer = null;
    try {
      return await Promise.race([
        promise,
        new Promise((resolve, reject) => {
          timer = this.timers.timeout(() => {
            const error = new Error(code);
            error.code = code;
            reject(error);
          }, ms);
        })
      ]);
    } finally {
      if (timer !== null) this.timers.clear(timer);
    }
  }

  async runOnce({ projectId } = {}) {
    const claim = this.store.claimSandboxRun(projectId, this.workerId, {
      now: this.clock(),
      leaseMs: this.leaseMs
    });
    if (!claim.claimed) return claim;

    const run = claim.run;
    const profile = run.profile;
    const spec = {
      runId: run.id,
      projectId: run.project_id,
      attempt: run.attempt,
      snapshotPath: path.join(run.snapshot_path, 'input'),
      command: profile.command,
      imageDigest: run.image_digest,
      timeoutMs: run.timeout_ms,
      memoryBytes: run.memory_bytes,
      cpus: run.cpus,
      pidsLimit: run.pids_limit,
      tmpfsBytes: run.tmpfs_bytes
    };
    let handle = run.provider_run_id
      ? { providerRunId: run.provider_run_id, name: run.provider_name, runId: run.id, projectId: run.project_id, attempt: run.attempt }
      : null;
    let fenced = false;
    let cancelRequested = false;
    let startedAt = null;
    let providerName = 'unknown';

    const refresh = () => {
      const current = this.store.getSandboxRun(run.id);
      if (current?.cancel_requested_at) cancelRequested = true;
      return current;
    };
    const heartbeat = () => this.store.heartbeatSandboxRun(run.id, {
      workerId: this.workerId,
      now: this.clock(),
      leaseMs: this.leaseMs
    });
    const tick = () => {
      try {
        heartbeat();
      } catch {
        fenced = true;
      }
      try {
        refresh();
      } catch {
        // The next heartbeat/refresh decides; an unreadable row is not a license to report.
      }
    };
    const tickTimer = this.timers.interval(tick, Math.max(1000, Math.floor(this.leaseMs / 3)));

    const evidenceFor = (collected) => ({
      stdout: sanitizeLog(collected.stdout, { maxBytes: profile.stdoutBytes }),
      stderr: sanitizeLog(collected.stderr, { maxBytes: profile.stderrBytes })
    });
    const resultEvidence = (fields) => {
      const text = JSON.stringify({
        finalStatus: fields.finalStatus,
        executionStatus: fields.executionStatus,
        testStatus: fields.testStatus,
        exitCode: fields.exitCode ?? null,
        signal: fields.signal ?? null,
        oomKilled: !!fields.collected?.oomKilled
      });
      return { text, bytes: Buffer.byteLength(text, 'utf8'), contentHash: sha256(text), truncated: false };
    };
    const finish = (fields) => {
      const evidence = fields.collected ? evidenceFor(fields.collected) : {};
      evidence.result = resultEvidence(fields);
      return this.store.completeSandboxRun({
        id: run.id,
        workerId: this.workerId,
        finalStatus: fields.finalStatus,
        executionStatus: fields.executionStatus,
        testStatus: fields.testStatus,
        exitCode: fields.exitCode ?? null,
        signal: fields.signal ?? null,
        evidence,
        errorCode: fields.errorCode ?? '',
        now: this.clock()
      });
    };
    const needs = (reason, errorCode) => {
      try {
        this.store.markSandboxNeedsReconciliation(run.id, {
          reason,
          errorCode,
          now: this.clock()
        });
      } catch {
        // Preserve the caller-visible outcome; lease expiry/startup recovery still applies.
      }
      return { claimed: true, runId: run.id, outcome: 'needs_reconciliation', reason };
    };
    const attach = (candidate) => {
      try {
        this.store.attachSandboxProvider(run.id, {
          workerId: this.workerId,
          provider: providerName,
          providerRunId: candidate.providerRunId,
          providerName: candidate.name ?? candidate.providerRunId,
          now: this.clock()
        });
      } catch {
        // The provider id may still be recoverable by the deterministic name/labels.
      }
    };
    const collect = async () => {
      this.store.beginSandboxCollect(run.id, { workerId: this.workerId, now: this.clock() });
      return this.withDeadline(this.provider.collect(handle), this.providerOpMs, 'collect-timeout');
    };

    const cancelCreated = async () => {
      // Created but not started: no project code has run. Remove it after inspect confirms
      // it is not running; otherwise keep the fence for Owner reconciliation.
      let disposed;
      try {
        disposed = await this.withDeadline(this.provider.dispose(handle), this.providerOpMs, 'dispose-timeout');
      } catch {
        return needs('cancel could not verify/remove the created container', 'cancel-dispose-unavailable');
      }
      if (!disposed.confirmed) return needs('created container cleanup was not confirmed', 'cancel-dispose-unconfirmed');
      finish({ finalStatus: 'cancelled', executionStatus: 'cancelled', testStatus: 'unknown', errorCode: '' });
      return { claimed: true, runId: run.id, outcome: 'cancelled' };
    };

    const stopAndFinish = async ({ finalStatus, executionStatus, errorCode }) => {
      let stopped;
      try {
        stopped = await this.withDeadline(this.provider.stop(handle), this.providerOpMs, 'stop-timeout');
      } catch {
        return needs('stop confirmation unavailable', 'stop-unconfirmed');
      }
      if (!stopped.confirmed) return needs('stop could not be confirmed', 'stop-unconfirmed');
      let collected = null;
      try {
        collected = await collect();
      } catch {
        return needs('stopped container evidence could not be collected', 'collect-failed');
      }
      this.store.completeSandboxRun({
        id: run.id,
        workerId: this.workerId,
        finalStatus,
        executionStatus,
        testStatus: 'unknown',
        exitCode: collected?.exitCode ?? null,
        signal: collected?.signal ?? null,
        evidence: {
          ...(collected ? evidenceFor(collected) : {}),
          result: resultEvidence({
            finalStatus,
            executionStatus,
            testStatus: 'unknown',
            exitCode: collected?.exitCode ?? null,
            signal: collected?.signal ?? null,
            collected
          })
        },
        errorCode,
        now: this.clock()
      });
      try { await this.withDeadline(this.provider.dispose(handle), this.providerOpMs, 'dispose-timeout'); } catch { /* cleanup later */ }
      return {
        claimed: true,
        runId: run.id,
        outcome: finalStatus === 'cancelled' ? 'cancelled' : executionStatus,
        unconfirmedStop: false
      };
    };

    try {
      const manifestEvidence = this.store.getSandboxEvidence(run.id, 'snapshot_manifest');
      if (!manifestEvidence) {
        return {
          claimed: true,
          runId: run.id,
          outcome: 'failed',
          errorCode: 'snapshot-manifest-missing',
          run: finish({
            finalStatus: 'failed', executionStatus: 'failed', testStatus: 'unknown',
            errorCode: 'snapshot-manifest-missing'
          })
        };
      }
      try {
        verifyInputSnapshot({
          snapshotPath: run.snapshot_path,
          manifest: JSON.parse(manifestEvidence.content),
          snapshotHash: run.snapshot_hash
        });
      } catch {
        return {
          claimed: true,
          runId: run.id,
          outcome: 'failed',
          errorCode: 'snapshot-invalid',
          run: finish({
            finalStatus: 'failed', executionStatus: 'failed', testStatus: 'unknown',
            errorCode: 'snapshot-invalid'
          })
        };
      }

      if (fenced) return { claimed: true, runId: run.id, outcome: 'fenced' };
      refresh();
      if (cancelRequested) {
        finish({ finalStatus: 'cancelled', executionStatus: 'cancelled', testStatus: 'unknown', errorCode: '' });
        return { claimed: true, runId: run.id, outcome: 'cancelled' };
      }

      let preflight;
      try {
        preflight = await this.withDeadline(this.provider.preflight(profile), this.providerOpMs, 'preflight-timeout');
      } catch {
        return {
          claimed: true,
          runId: run.id,
          outcome: 'unsupported',
          reason: 'preflight-timeout',
          run: finish({
            finalStatus: 'failed', executionStatus: 'failed', testStatus: 'unknown',
            errorCode: 'preflight-timeout'
          })
        };
      }
      if (fenced) return { claimed: true, runId: run.id, outcome: 'fenced' };
      refresh();
      if (cancelRequested) {
        finish({ finalStatus: 'cancelled', executionStatus: 'cancelled', testStatus: 'unknown', errorCode: '' });
        return { claimed: true, runId: run.id, outcome: 'cancelled' };
      }
      if (!preflight.ok) {
        return {
          claimed: true,
          runId: run.id,
          outcome: 'unsupported',
          reason: preflight.reason,
          run: finish({
            finalStatus: 'failed', executionStatus: 'failed', testStatus: 'unknown',
            errorCode: `preflight:${String(preflight.reason ?? 'unsupported').slice(0, 60)}`
          })
        };
      }
      providerName = preflight.provider ?? 'unknown';

      if (fenced) return { claimed: true, runId: run.id, outcome: 'fenced' };
      refresh();
      if (cancelRequested) {
        finish({ finalStatus: 'cancelled', executionStatus: 'cancelled', testStatus: 'unknown', errorCode: '' });
        return { claimed: true, runId: run.id, outcome: 'cancelled' };
      }

      if (handle) {
        return needs('queued run already has a provider id', 'ambiguous-resume');
      }
      try {
        handle = await this.withDeadline(this.provider.create(spec), this.providerOpMs, 'create-timeout');
        attach(handle);
      } catch (error) {
        // A create failure may still have produced a container. Look up the deterministic
        // owner labels; never release the fence on "unknown".
        let orphan = error?.providerRunId
          ? { providerRunId: error.providerRunId, name: error.name, runId: run.id, projectId: run.project_id, attempt: run.attempt }
          : null;
        if (!orphan && typeof this.provider.findOwnedContainer === 'function') {
          try {
            orphan = await this.provider.findOwnedContainer({
              runId: run.id, projectId: run.project_id, attempt: run.attempt
            });
          } catch {
            orphan = null;
          }
        }
        if (orphan) attach(orphan);
        return needs('provider create outcome could not be confirmed', 'provider-create-unconfirmed');
      }

      if (fenced) return { claimed: true, runId: run.id, outcome: 'fenced' };
      refresh();
      if (cancelRequested) return cancelCreated();

      // Re-check immediately before the irreversible start.
      if (fenced) return { claimed: true, runId: run.id, outcome: 'fenced' };
      refresh();
      if (cancelRequested) return cancelCreated();

      try {
        await this.withDeadline(this.provider.start(handle), this.providerOpMs, 'start-timeout');
        startedAt = this.clock();
        this.store.startSandboxRun(run.id, { workerId: this.workerId, now: startedAt });
      } catch (error) {
        let info = null;
        try {
          info = await this.withDeadline(this.provider.inspect(handle), this.providerOpMs, 'inspect-timeout');
        } catch {
          info = null;
        }
        if (info && info.state !== 'running') {
          try {
            const disposed = await this.withDeadline(this.provider.dispose(handle), this.providerOpMs, 'dispose-timeout');
            if (!disposed.confirmed) return needs('start failed and cleanup was not confirmed', 'provider-start-unconfirmed');
          } catch {
            return needs('start failed and cleanup could not be verified', 'provider-start-unconfirmed');
          }
          return {
            claimed: true,
            runId: run.id,
            outcome: 'failed',
            errorCode: 'provider-start-failed',
            run: finish({
              finalStatus: 'failed', executionStatus: 'failed', testStatus: 'unknown',
              errorCode: `provider-start:${String(error?.code ?? 'error').slice(0, 60)}`
            })
          };
        }
        return needs('provider start outcome could not be confirmed', 'provider-start-unconfirmed');
      }

      if (fenced) return { claimed: true, runId: run.id, outcome: 'fenced' };
      refresh();
      if (cancelRequested) return stopAndFinish({ finalStatus: 'cancelled', executionStatus: 'cancelled', errorCode: '' });

      while (true) {
        try {
          heartbeat();
        } catch {
          fenced = true;
          return { claimed: true, runId: run.id, outcome: 'fenced' };
        }
        refresh();
        if (cancelRequested) {
          return stopAndFinish({ finalStatus: 'cancelled', executionStatus: 'cancelled', errorCode: '' });
        }

        let info;
        try {
          info = await this.withDeadline(this.provider.inspect(handle), this.providerOpMs, 'inspect-timeout');
        } catch {
          return needs('provider inspect unavailable', 'inspect-unavailable');
        }
        if (info.state === 'exited') {
          let collected;
          try {
            collected = await collect();
          } catch {
            return needs('provider collect failed', 'collect-failed');
          }
          const testStatus = collected.exitCode === 0 && !collected.oomKilled ? 'pass' : 'fail';
          const completed = finish({
            collected,
            finalStatus: 'completed',
            executionStatus: 'completed',
            testStatus,
            exitCode: collected.exitCode,
            signal: collected.signal
          });
          try { await this.withDeadline(this.provider.dispose(handle), this.providerOpMs, 'dispose-timeout'); } catch { /* cleanup later */ }
          return {
            claimed: true,
            runId: run.id,
            outcome: 'completed',
            testStatus,
            exitCode: collected.exitCode,
            run: completed
          };
        }
        if (info.state === 'missing') {
          return needs('container disappeared before evidence collection', 'container-missing');
        }

        const started = startedAt ?? this.store.getSandboxRun(run.id).started_at;
        if (started && Date.parse(this.clock()) - Date.parse(started) >= run.timeout_ms) {
          return stopAndFinish({ finalStatus: 'failed', executionStatus: 'timeout', errorCode: 'timeout' });
        }
        await this.sleep(this.pollMs);
      }
    } catch (error) {
      if (fenced) return { claimed: true, runId: run.id, outcome: 'fenced' };
      return needs('sandbox runner error', `runner:${String(error?.code ?? 'error').slice(0, 60)}`);
    } finally {
      this.timers.clear(tickTimer);
    }
  }
}
