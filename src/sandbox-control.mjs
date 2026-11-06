// Owner-side sandbox reconciliation. The DB attestation is issued only after this module
// has either (a) verified the RunID-labelled container and confirmed stop/dispose, or
// (b) completed a successful authoritative lookup proving no container exists.
import { cleanupInputSnapshot, defaultSandboxRoot } from './sandbox-materializer.mjs';

export async function reconcileSandboxWithProvider(store, provider, run, {
  decision,
  reason = '',
  actor = 'ownerctl'
} = {}) {
  if (!run) throw new Error('Unknown sandbox run');
  const lookup = () => provider.findOwnedContainerStrict({
    runId: run.id,
    projectId: run.project_id,
    attempt: run.attempt
  });

  let handle = run.provider_run_id
    ? {
        providerRunId: run.provider_run_id,
        name: run.provider_name,
        runId: run.id,
        projectId: run.project_id,
        attempt: run.attempt
      }
    : await lookup();

  if (handle) {
    let info = await provider.inspect(handle);
    if (info.state === 'missing') {
      handle = await lookup();
      if (handle) info = await provider.inspect(handle);
    }
    if (handle && info.state === 'running') {
      const stopped = await provider.stop(handle);
      if (!stopped.confirmed) throw new Error('sandbox stop could not be confirmed; fence remains');
      info = await provider.inspect(handle);
    }
    if (handle && info.state !== 'missing') {
      const disposed = await provider.dispose(handle);
      if (!disposed.confirmed) throw new Error('sandbox dispose could not be confirmed; fence remains');
    }
  }

  return store.reconcileSandboxRun(run.id, {
    decision,
    reason,
    actor,
    providerChecked: true
  });
}

export async function cleanupSandboxWithProvider(store, provider, run, {
  sandboxRoot = defaultSandboxRoot()
} = {}) {
  if (!run) throw new Error('Unknown sandbox run');
  if (!['completed', 'failed', 'cancelled', 'rejected'].includes(run.status)) {
    throw new Error('sandbox run must be terminal before cleanup');
  }
  const lookup = () => provider.findOwnedContainerStrict({
    runId: run.id,
    projectId: run.project_id,
    attempt: run.attempt
  });
  let handle = run.provider_run_id
    ? {
        providerRunId: run.provider_run_id,
        name: run.provider_name,
        runId: run.id,
        projectId: run.project_id,
        attempt: run.attempt
      }
    : await lookup();
  if (handle) {
    let info = await provider.inspect(handle);
    if (info.state === 'missing') {
      handle = await lookup();
      if (handle) info = await provider.inspect(handle);
    }
    if (handle && info.state === 'running') throw new Error('sandbox container is still running; cancel/reconcile first');
    if (handle && info.state !== 'missing') {
      const disposed = await provider.dispose(handle);
      if (!disposed.confirmed) throw new Error('sandbox dispose could not be confirmed');
    }
  }
  const cleanup = cleanupInputSnapshot({
    snapshotPath: run.snapshot_path,
    runId: run.id,
    snapshotHash: run.snapshot_hash,
    sandboxRoot
  });
  store.markSandboxSnapshotCleaned(run.id);
  return { run, cleanup };
}
