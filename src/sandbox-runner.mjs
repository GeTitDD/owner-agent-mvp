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
    timers = {
      timeout: (fn, ms) => setTimeout(fn, ms),
      clear: (handle) => clearTimeout(handle)
    }
  } = {}) {
    if (!provider) throw new Error('SandboxRunner requires a provider');
    this.store = store;
    this.provider = provider;
    this.workerId = workerId;
    this.leaseMs = leaseMs;
    this.clock = clock;
    this.pollMs = Math.max(0, pollMs);
    this.timers = timers;
  }

  sleep(ms) {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.timers.timeout(resolve, ms);
    });
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
    let startedAt = null;

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

    try {
      const manifestEvidence = this.store.getSandboxEvidence(run.id, 'snapshot_manifest');
      if (!manifestEvidence) {
        return {
          claimed: true,
          runId: run.id,
          outcome: 'failed',
          errorCode: 'snapshot-manifest-missing',
          run: finish({
            finalStatus: 'failed',
            executionStatus: 'failed',
            testStatus: 'unknown',
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
            finalStatus: 'failed',
            executionStatus: 'failed',
            testStatus: 'unknown',
            errorCode: 'snapshot-invalid'
          })
        };
      }

      const preflight = await this.provider.preflight(profile);
      if (!preflight.ok) {
        return {
          claimed: true,
          runId: run.id,
          outcome: 'unsupported',
          reason: preflight.reason,
          run: finish({
            finalStatus: 'failed',
            executionStatus: 'failed',
            testStatus: 'unknown',
            errorCode: `preflight:${String(preflight.reason ?? 'unsupported').slice(0, 60)}`
          })
        };
      }

      if (!handle) {
        try {
          handle = await this.provider.create(spec);
          try {
            this.store.attachSandboxProvider(run.id, {
              workerId: this.workerId,
              provider: preflight.provider ?? 'unknown',
              providerRunId: handle.providerRunId,
              providerName: handle.name ?? handle.providerRunId,
              now: this.clock()
            });
          } catch (error) {
            let disposed = false;
            try { disposed = (await this.provider.dispose(handle)).confirmed; } catch { disposed = false; }
            if (!disposed) {
              this.store.markSandboxNeedsReconciliation(run.id, {
                reason: 'provider attach failed and container cleanup was not confirmed',
                errorCode: 'provider-attach-unconfirmed',
                now: this.clock()
              });
              return { claimed: true, runId: run.id, outcome: 'needs_reconciliation' };
            }
            throw error;
          }
        } catch (error) {
          return {
            claimed: true,
            runId: run.id,
            outcome: 'failed',
            errorCode: 'provider-create-failed',
            run: finish({
              finalStatus: 'failed',
              executionStatus: 'failed',
              testStatus: 'unknown',
              errorCode: `provider-create:${String(error?.code ?? 'error').slice(0, 60)}`
            })
          };
        }
        try {
          await this.provider.start(handle);
          startedAt = this.clock();
          this.store.startSandboxRun(run.id, { workerId: this.workerId, now: startedAt });
        } catch (error) {
          let disposed = false;
          try { disposed = (await this.provider.dispose(handle)).confirmed; } catch { disposed = false; }
          if (!disposed) {
            this.store.markSandboxNeedsReconciliation(run.id, {
              reason: 'provider start failed and container cleanup was not confirmed',
              errorCode: 'provider-start-unconfirmed',
              now: this.clock()
            });
            return { claimed: true, runId: run.id, outcome: 'needs_reconciliation' };
          }
          return {
            claimed: true,
            runId: run.id,
            outcome: 'failed',
            errorCode: 'provider-start-failed',
            run: finish({
              finalStatus: 'failed',
              executionStatus: 'failed',
              testStatus: 'unknown',
              errorCode: `provider-start:${String(error?.code ?? 'error').slice(0, 60)}`
            })
          };
        }
      } else {
        // A queued run with a provider id is ambiguous; startup recovery normally moves
        // these to needs_reconciliation. Refuse to guess.
        this.store.markSandboxNeedsReconciliation(run.id, {
          reason: 'queued run already has a provider id',
          errorCode: 'ambiguous-resume',
          now: this.clock()
        });
        return { claimed: true, runId: run.id, outcome: 'needs_reconciliation' };
      }

      while (true) {
        try {
          this.store.heartbeatSandboxRun(run.id, {
            workerId: this.workerId,
            now: this.clock(),
            leaseMs: this.leaseMs
          });
        } catch {
          fenced = true;
          return { claimed: true, runId: run.id, outcome: 'fenced' };
        }

        const current = this.store.getSandboxRun(run.id);
        if (current.cancel_requested_at) {
          const stopped = await this.provider.stop(handle);
          if (!stopped.confirmed) {
            this.store.markSandboxNeedsReconciliation(run.id, {
              reason: 'cancel stop could not be confirmed',
              errorCode: 'unconfirmed-stop',
              now: this.clock()
            });
            return { claimed: true, runId: run.id, outcome: 'fenced', unconfirmedStop: true };
          }
          let collected = null;
          try {
            this.store.beginSandboxCollect(run.id, { workerId: this.workerId, now: this.clock() });
            collected = await this.provider.collect(handle);
          } catch { /* bounded empty evidence */ }
          this.store.completeSandboxRun({
            id: run.id,
            workerId: this.workerId,
            finalStatus: 'cancelled',
            executionStatus: 'cancelled',
            testStatus: 'unknown',
            exitCode: collected?.exitCode ?? null,
            signal: collected?.signal ?? null,
            evidence: {
              ...(collected ? evidenceFor(collected) : {}),
              result: resultEvidence({
                finalStatus: 'cancelled', executionStatus: 'cancelled', testStatus: 'unknown',
                exitCode: collected?.exitCode ?? null, signal: collected?.signal ?? null, collected
              })
            },
            errorCode: '',
            now: this.clock()
          });
          try { await this.provider.dispose(handle); } catch { /* cleanup is a separate owner action */ }
          return { claimed: true, runId: run.id, outcome: 'cancelled' };
        }

        let info;
        try {
          info = await this.provider.inspect(handle);
        } catch {
          this.store.markSandboxNeedsReconciliation(run.id, {
            reason: 'provider inspect failed',
            errorCode: 'inspect-failed',
            now: this.clock()
          });
          return { claimed: true, runId: run.id, outcome: 'needs_reconciliation' };
        }
        if (info.state === 'exited') {
          let collected;
          try {
            this.store.beginSandboxCollect(run.id, { workerId: this.workerId, now: this.clock() });
            collected = await this.provider.collect(handle);
          } catch {
            this.store.markSandboxNeedsReconciliation(run.id, {
              reason: 'provider collect failed',
              errorCode: 'collect-failed',
              now: this.clock()
            });
            return { claimed: true, runId: run.id, outcome: 'needs_reconciliation' };
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
          try { await this.provider.dispose(handle); } catch { /* owner can clean later */ }
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
          this.store.markSandboxNeedsReconciliation(run.id, {
            reason: 'container disappeared before evidence collection',
            errorCode: 'container-missing',
            now: this.clock()
          });
          return { claimed: true, runId: run.id, outcome: 'needs_reconciliation' };
        }

        const started = startedAt ?? this.store.getSandboxRun(run.id).started_at;
        if (started && Date.parse(this.clock()) - Date.parse(started) >= run.timeout_ms) {
          const stopped = await this.provider.stop(handle);
          if (!stopped.confirmed) {
            this.store.markSandboxNeedsReconciliation(run.id, {
              reason: 'timeout stop could not be confirmed',
              errorCode: 'timeout-unconfirmed',
              now: this.clock()
            });
            return { claimed: true, runId: run.id, outcome: 'fenced', unconfirmedStop: true };
          }
          let collected = null;
          try {
            this.store.beginSandboxCollect(run.id, { workerId: this.workerId, now: this.clock() });
            collected = await this.provider.collect(handle);
          } catch { /* bounded empty */ }
          this.store.completeSandboxRun({
            id: run.id,
            workerId: this.workerId,
            finalStatus: 'failed',
            executionStatus: 'timeout',
            testStatus: 'unknown',
            exitCode: collected?.exitCode ?? null,
            signal: collected?.signal ?? null,
            evidence: {
              ...(collected ? evidenceFor(collected) : {}),
              result: resultEvidence({
                finalStatus: 'failed', executionStatus: 'timeout', testStatus: 'unknown',
                exitCode: collected?.exitCode ?? null, signal: collected?.signal ?? null, collected
              })
            },
            errorCode: 'timeout',
            now: this.clock()
          });
          try { await this.provider.dispose(handle); } catch { /* owner can clean later */ }
          return { claimed: true, runId: run.id, outcome: 'timeout' };
        }

        await this.sleep(this.pollMs);
      }
    } catch (error) {
      if (fenced) return { claimed: true, runId: run.id, outcome: 'fenced' };
      try {
        this.store.markSandboxNeedsReconciliation(run.id, {
          reason: 'sandbox runner error',
          errorCode: `runner:${String(error?.code ?? 'error').slice(0, 60)}`,
          now: this.clock()
        });
      } catch {
        // Preserve the original failure; owner reconciliation remains required.
      }
      return { claimed: true, runId: run.id, outcome: 'needs_reconciliation' };
    }
  }
}
