import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeAppliedSandboxFixture } from './helpers/sandbox-fixture.mjs';
import { FakeSandboxProvider } from '../src/sandbox-provider.mjs';
import { SandboxRunner } from '../src/sandbox-runner.mjs';
import { createInputSnapshot, verifyInputSnapshot } from '../src/sandbox-materializer.mjs';
import { approvalHash, resolveTestProfile } from '../src/sandbox-protocol.mjs';
import { sha256 } from '../src/utils.mjs';

const FAKE_IMAGE = `sha256:${'a'.repeat(64)}`;
const clock = (start = '2026-09-01T00:00:00.000Z') => {
  let t = Date.parse(start);
  return {
    now: () => new Date(t).toISOString(),
    advanceMs: (ms) => {
      t += ms;
      return new Date(t).toISOString();
    }
  };
};

const waitFor = (fn, label, ms = 3000) => new Promise((resolve, reject) => {
  const started = Date.now();
  const timer = setInterval(() => {
    try {
      if (fn()) {
        clearInterval(timer);
        resolve();
        return;
      }
    } catch {
      // retry
    }
    if (Date.now() - started > ms) {
      clearInterval(timer);
      reject(new Error(`waitFor timeout: ${label}`));
    }
  }, 5);
});

const manualTimers = () => {
  const handles = new Map();
  let next = 1;
  return {
    handles,
    interval: (fn, ms) => {
      const id = next++;
      handles.set(id, { fn, ms, kind: 'interval' });
      return id;
    },
    timeout: (fn, ms) => {
      const id = next++;
      handles.set(id, { fn, ms, kind: 'timeout' });
      return id;
    },
    clear: (id) => handles.delete(id),
    fireByMs: (ms) => {
      for (const [id, handle] of [...handles]) {
        if (handle.ms === ms) {
          if (handle.kind !== 'interval') handles.delete(id);
          handle.fn();
        }
      }
    }
  };
};

let runCounter = 0;
const makeSandboxRun = ({ fixture, profile = resolveTestProfile('node-smoke', { imageDigest: FAKE_IMAGE }) }) => {
  const runId = `sandbox-run-${++runCounter}`;
  const snapshot = createInputSnapshot({
    runId,
    workspacePath: fixture.workspace.path,
    proposal: fixture.proposal,
    includePaths: [],
    sandboxRoot: fixture.sandboxRoot
  });
  const hash = approvalHash({
    projectId: fixture.projectId,
    workspaceId: fixture.workspace.id,
    proposalId: fixture.proposal.id,
    approvedHash: fixture.proposal.approved_hash,
    baseSha: fixture.proposal.base_sha,
    profile,
    snapshotHash: snapshot.snapshotHash,
    includePaths: []
  });
  const run = fixture.store.createSandboxRun({
    id: runId,
    projectId: fixture.projectId,
    jobId: fixture.job.id,
    attempt: fixture.proposal.attempt,
    workspaceId: fixture.workspace.id,
    proposalId: fixture.proposal.id,
    approvedHash: fixture.proposal.approved_hash,
    baseSha: fixture.proposal.base_sha,
    profile,
    approvalHash: hash,
    snapshotHash: snapshot.snapshotHash,
    snapshotPath: snapshot.snapshotPath,
    includePaths: []
  });
  const manifest = JSON.stringify(snapshot.manifest);
  fixture.store.saveSandboxEvidence(runId, 'snapshot_manifest', {
    content: manifest,
    contentHash: sha256(manifest),
    bytes: Buffer.byteLength(manifest)
  });
  return { runId, snapshot, approvalHash: hash, run, profile };
};

const autoCompleteProvider = (options) => {
  const provider = new FakeSandboxProvider();
  const start = provider.start.bind(provider);
  provider.start = async (handle) => {
    const result = await start(handle);
    provider.complete(handle, options);
    return result;
  };
  return provider;
};

test('[sandbox#1] an unapproved run never calls a provider or executes a container', async () => {
  const fixture = await makeAppliedSandboxFixture();
  try {
    const pending = makeSandboxRun({ fixture });
    const provider = new FakeSandboxProvider();
    const runner = new SandboxRunner(fixture.store, { provider, workerId: 'sandbox-test', pollMs: 0 });
    const result = await runner.runOnce({ projectId: fixture.projectId });
    assert.deepEqual(result, { claimed: false, reason: 'no-queued-sandbox-run' });
    assert.equal(provider.preflightCalls.length, 0);
    assert.equal(provider.createCalls.length, 0);
    assert.equal(fixture.store.getSandboxRun(pending.runId).status, 'pending_approval');
    fixture.store.rejectSandboxRun(pending.runId, { reason: 'not needed' });
    assert.equal(provider.createCalls.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('[sandbox#2] pass/fail are completed execution results with hashed private evidence', async () => {
  for (const [exitCode, expectedTest] of [[0, 'pass'], [1, 'fail']]) {
    const fixture = await makeAppliedSandboxFixture({ key: `sandbox-result-${exitCode}` });
    try {
      const run = makeSandboxRun({ fixture });
      fixture.store.approveSandboxRun(run.runId, { expectedHash: run.approvalHash });
      const provider = autoCompleteProvider({
        exitCode,
        stdout: exitCode === 0 ? 'ok\n' : 'not ok\n',
        stderr: ''
      });
      const runner = new SandboxRunner(fixture.store, { provider, workerId: 'sandbox-test', pollMs: 0 });
      const result = await runner.runOnce({ projectId: fixture.projectId });
      assert.equal(result.outcome, 'completed');
      assert.equal(result.testStatus, expectedTest);
      const saved = fixture.store.getSandboxRun(run.runId);
      assert.equal(saved.status, 'completed');
      assert.equal(saved.execution_status, 'completed');
      assert.equal(saved.test_status, expectedTest);
      assert.equal(saved.exit_code, exitCode);
      const stdout = fixture.store.getSandboxEvidence(run.runId, 'stdout');
      assert.ok(stdout);
      assert.equal(stdout.content_hash, sha256(stdout.content));
      assert.equal(stdout.content, exitCode === 0 ? 'ok\n' : 'not ok\n');
      const jobEvents = JSON.stringify(fixture.store.getJob(fixture.job.id).events);
      assert.equal(jobEvents.includes('not ok'), false, 'logs never enter Job events');
    } finally {
      fixture.cleanup();
    }
  }
});

test('[sandbox#3] approval hash, snapshot drift and profile drift fail closed', async () => {
  const fixture = await makeAppliedSandboxFixture({ key: 'sandbox-drift' });
  try {
    const run = makeSandboxRun({ fixture });
    assert.throws(() => fixture.store.approveSandboxRun(run.runId, { expectedHash: '0'.repeat(64) }),
      /approval hash does not match/);
    const file = path.join(run.snapshot.snapshotPath, 'input', 'src', 'app.js');
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, 'tampered\n');
    assert.throws(() => verifyInputSnapshot({
      snapshotPath: run.snapshot.snapshotPath,
      manifest: run.snapshot.manifest,
      snapshotHash: run.snapshot.snapshotHash
    }), /hash mismatch|size mismatch/);
    const provider = new FakeSandboxProvider();
    const runner = new SandboxRunner(fixture.store, { provider, workerId: 'sandbox-test', pollMs: 0 });
    const result = await runner.runOnce({ projectId: fixture.projectId });
    assert.equal(result.claimed, false, 'unapproved run is not claimable');
    assert.equal(provider.createCalls.length, 0);
    assert.equal(fixture.store.getSandboxRun(run.runId).status, 'pending_approval');
  } finally {
    fixture.cleanup();
  }
});

test('[sandbox#4] cancel stops the RunID container and records bounded cancelled evidence', async () => {
  const fixture = await makeAppliedSandboxFixture({ key: 'sandbox-cancel' });
  try {
    const run = makeSandboxRun({ fixture });
    fixture.store.approveSandboxRun(run.runId, { expectedHash: run.approvalHash });
    const provider = new FakeSandboxProvider();
    const timers = manualTimers();
    const runner = new SandboxRunner(fixture.store, { provider, workerId: 'sandbox-test', pollMs: 1000, timers });
    const running = runner.runOnce({ projectId: fixture.projectId });
    await waitFor(() => provider.startCalls.length === 1, 'sandbox start');
    fixture.store.requestCancelSandboxRun(run.runId, { actor: 'owner' });
    timers.fireByMs(1000);
    const result = await running;
    assert.equal(result.outcome, 'cancelled');
    assert.equal(provider.stopCalls.length, 1);
    const saved = fixture.store.getSandboxRun(run.runId);
    assert.equal(saved.status, 'cancelled');
    assert.equal(saved.execution_status, 'cancelled');
    assert.equal(saved.test_status, 'unknown');
  } finally {
    fixture.cleanup();
  }
});

test('[sandbox#5] an unconfirmed stop fences the project until explicit reconciliation', async () => {
  const fixture = await makeAppliedSandboxFixture({ key: 'sandbox-unconfirmed' });
  try {
    const run = makeSandboxRun({ fixture });
    fixture.store.approveSandboxRun(run.runId, { expectedHash: run.approvalHash });
    const provider = new FakeSandboxProvider();
    provider.stopConfirmed = false;
    const timers = manualTimers();
    const runner = new SandboxRunner(fixture.store, { provider, workerId: 'sandbox-test', pollMs: 1000, timers });
    const running = runner.runOnce({ projectId: fixture.projectId });
    await waitFor(() => provider.startCalls.length === 1, 'sandbox start');
    fixture.store.requestCancelSandboxRun(run.runId, { actor: 'owner' });
    timers.fireByMs(1000);
    const result = await running;
    assert.equal(result.outcome, 'needs_reconciliation');
    assert.equal(fixture.store.getSandboxRun(run.runId).status, 'needs_reconciliation');
    const task = fixture.store.createTask({ projectId: fixture.projectId, title: 'blocked by sandbox' });
    const job = fixture.store.createJob({
      projectId: fixture.projectId,
      jobType: 'code-patch',
      title: 'blocked patch',
      payload: { baseSha: fixture.base, allowedPaths: 'src/' },
      idempotencyKey: 'blocked-by-sandbox',
      ownerTaskId: task.id
    });
    assert.throws(() => fixture.store.approveJob(job.id), /unresolved sandbox run/);
    fixture.store.reconcileSandboxRun(run.runId, { decision: 'discard', reason: 'test reconcile' });
    assert.equal(fixture.store.getSandboxRun(run.runId).status, 'failed');
    assert.equal(fixture.store.approveJob(job.id).status, 'queued');
  } finally {
    fixture.cleanup();
  }
});

test('[sandbox#6] timeout stops the container and records execution_status=timeout', async () => {
  const fixture = await makeAppliedSandboxFixture({ key: 'sandbox-timeout' });
  try {
    const run = makeSandboxRun({ fixture });
    fixture.store.approveSandboxRun(run.runId, { expectedHash: run.approvalHash });
    const provider = new FakeSandboxProvider();
    const c = clock();
    const timers = manualTimers();
    const runner = new SandboxRunner(fixture.store, {
      provider, workerId: 'sandbox-test', pollMs: 1000, timers, clock: c.now, leaseMs: 120000
    });
    const running = runner.runOnce({ projectId: fixture.projectId });
    await waitFor(() => provider.startCalls.length === 1, 'sandbox start');
    c.advanceMs(31001);
    timers.fireByMs(1000);
    const result = await running;
    assert.equal(result.outcome, 'timeout');
    const saved = fixture.store.getSandboxRun(run.runId);
    assert.equal(saved.status, 'failed');
    assert.equal(saved.execution_status, 'timeout');
    assert.equal(saved.test_status, 'unknown');
  } finally {
    fixture.cleanup();
  }
});

test('[sandbox#7] a lost lease never reports a result and requires crash reconciliation', async () => {
  const fixture = await makeAppliedSandboxFixture({ key: 'sandbox-fence' });
  try {
    const run = makeSandboxRun({ fixture });
    fixture.store.approveSandboxRun(run.runId, { expectedHash: run.approvalHash });
    const provider = new FakeSandboxProvider();
    const c = clock();
    const timers = manualTimers();
    const runner = new SandboxRunner(fixture.store, { provider, workerId: 'sandbox-test', pollMs: 1000, timers, clock: c.now });
    const running = runner.runOnce({ projectId: fixture.projectId });
    await waitFor(() => provider.startCalls.length === 1, 'sandbox start');
    c.advanceMs(30001);
    timers.fireByMs(1000);
    const result = await running;
    assert.equal(result.outcome, 'fenced');
    fixture.store.recoverInterruptedSandboxRuns({ now: c.now() });
    assert.equal(fixture.store.getSandboxRun(run.runId).status, 'needs_reconciliation');
  } finally {
    fixture.cleanup();
  }
});

test('[sandbox#8] logs are capped, redacted and hashed without entering Job/Event/oplog', async () => {
  const fixture = await makeAppliedSandboxFixture({ key: 'sandbox-logs' });
  try {
    const run = makeSandboxRun({ fixture });
    fixture.store.approveSandboxRun(run.runId, { expectedHash: run.approvalHash });
    const provider = autoCompleteProvider({
      exitCode: 0,
      stdout: `api_key=SUPERSECRET\n${'x'.repeat(70000)}`,
      stderr: 'Bearer abc.def.ghi\n'
    });
    const runner = new SandboxRunner(fixture.store, { provider, workerId: 'sandbox-test', pollMs: 0 });
    const result = await runner.runOnce({ projectId: fixture.projectId });
    assert.equal(result.outcome, 'completed');
    const stdout = fixture.store.getSandboxEvidence(run.runId, 'stdout');
    const stderr = fixture.store.getSandboxEvidence(run.runId, 'stderr');
    assert.equal(stdout.content.includes('SUPERSECRET'), false);
    assert.match(stdout.content, /\[REDACTED\]/);
    assert.equal(stdout.truncated, 1);
    assert.equal(stderr.content.includes('abc.def.ghi'), false);
    assert.ok(stdout.bytes <= 70000);
    const persisted = JSON.stringify({
      run: fixture.store.getSandboxRun(run.runId),
      events: fixture.store.listJobEvents(fixture.job.id),
      oplog: fixture.store.getSandboxRun(run.runId).oplog
    });
    assert.equal(persisted.includes('SUPERSECRET'), false);
    assert.equal(persisted.includes('abc.def.ghi'), false);
  } finally {
    fixture.cleanup();
  }
});

test('[sandbox#9] missing Docker/preflight capability fails closed without creating a container', async () => {
  const fixture = await makeAppliedSandboxFixture({ key: 'sandbox-preflight' });
  try {
    const run = makeSandboxRun({ fixture });
    fixture.store.approveSandboxRun(run.runId, { expectedHash: run.approvalHash });
    const provider = new FakeSandboxProvider();
    provider.preflightResult = { ok: false, reason: 'docker-not-available', provider: 'docker' };
    const runner = new SandboxRunner(fixture.store, { provider, workerId: 'sandbox-test', pollMs: 0 });
    const result = await runner.runOnce({ projectId: fixture.projectId });
    assert.equal(result.outcome, 'unsupported');
    assert.equal(provider.createCalls.length, 0);
    const saved = fixture.store.getSandboxRun(run.runId);
    assert.equal(saved.status, 'failed');
    assert.equal(saved.execution_status, 'failed');
    assert.match(saved.error_code, /docker-not-available/);
  } finally {
    fixture.cleanup();
  }
});

test('[sandbox#11] changing image digest or profile invalidates the frozen approval', async () => {
  const fixture = await makeAppliedSandboxFixture({ key: 'sandbox-profile-drift' });
  try {
    const run = makeSandboxRun({ fixture });
    const otherProfile = resolveTestProfile('node-smoke', { imageDigest: `sha256:${'b'.repeat(64)}` });
    const otherHash = approvalHash({
      projectId: fixture.projectId,
      workspaceId: fixture.workspace.id,
      proposalId: fixture.proposal.id,
      approvedHash: fixture.proposal.approved_hash,
      baseSha: fixture.proposal.base_sha,
      profile: otherProfile,
      snapshotHash: run.snapshot.snapshotHash,
      includePaths: []
    });
    assert.notEqual(otherHash, run.approvalHash);
    assert.throws(() => fixture.store.approveSandboxRun(run.runId, { expectedHash: otherHash }),
      /approval hash does not match/);
    assert.equal(fixture.store.getSandboxRun(run.runId).status, 'pending_approval');
  } finally {
    fixture.cleanup();
  }
});

test('[sandbox#12] projects cannot claim or borrow another project sandbox run', async () => {
  const a = await makeAppliedSandboxFixture({ projectId: 'proj-a', key: 'sandbox-project-a' });
  const b = await makeAppliedSandboxFixture({ projectId: 'proj-b', key: 'sandbox-project-b' });
  try {
    const pendingA = makeSandboxRun({ fixture: a });
    const runB = makeSandboxRun({ fixture: b });
    b.store.approveSandboxRun(runB.runId, { expectedHash: runB.approvalHash });
    const provider = autoCompleteProvider({ exitCode: 0, stdout: 'b ok\n', stderr: '' });
    const runner = new SandboxRunner(b.store, { provider, workerId: 'sandbox-b', pollMs: 0 });
    const result = await runner.runOnce({ projectId: 'proj-b' });
    assert.equal(result.outcome, 'completed');
    assert.equal(b.store.getSandboxRun(runB.runId).status, 'completed');
    assert.equal(b.store.getSandboxRun(pendingA.runId), null);
    assert.equal(a.store.getSandboxRun(pendingA.runId).status, 'pending_approval');
    const cross = await new SandboxRunner(a.store, { provider, workerId: 'sandbox-a', pollMs: 0 })
      .runOnce({ projectId: 'proj-a' });
    assert.deepEqual(cross, { claimed: false, reason: 'no-queued-sandbox-run' });
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test('[sandbox#13] snapshot verification rejects extra files, directories, symlinks and hardlinks', async () => {
  const fixture = await makeAppliedSandboxFixture({ key: 'sandbox-extra-content' });
  try {
    const run = makeSandboxRun({ fixture });
    fixture.store.approveSandboxRun(run.runId, { expectedHash: run.approvalHash });
    const input = path.join(run.snapshot.snapshotPath, 'input');
    const verify = () => verifyInputSnapshot({
      snapshotPath: run.snapshot.snapshotPath,
      manifest: run.snapshot.manifest,
      snapshotHash: run.snapshot.snapshotHash
    });
    // The snapshot is intentionally 0555/0444 for the container; the test must opt in to
    // writing into it to simulate an attacker injecting extra content.
    fs.chmodSync(input, 0o755);
    fs.chmodSync(path.join(input, 'tests'), 0o755);
    const extraFile = path.join(input, 'tests', 'helper.mjs');
    fs.writeFileSync(extraFile, '// injected\n');
    assert.throws(verify, /unapproved files/);
    fs.rmSync(extraFile, { force: true });

    const extraDir = path.join(input, 'extra-dir');
    fs.mkdirSync(extraDir);
    assert.throws(verify, /unapproved directories/);
    fs.rmdirSync(extraDir);

    try {
      fs.symlinkSync(path.join(input, 'src', 'app.js'), path.join(input, 'tests', 'link.js'), 'file');
      assert.throws(verify, /symlink|unapproved/);
      fs.rmSync(path.join(input, 'tests', 'link.js'), { force: true });
    } catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    }

    fs.linkSync(path.join(input, 'src', 'app.js'), path.join(input, 'tests', 'hard.js'));
    assert.throws(verify, /hard-linked|unapproved/);
    fs.rmSync(path.join(input, 'tests', 'hard.js'), { force: true });

    assert.equal(verify().ok, true, 'the original exact tree still verifies');
  } finally {
    fixture.cleanup();
  }
});

test('[sandbox#14] cancel before create prevents any container creation', async () => {
  const fixture = await makeAppliedSandboxFixture({ key: 'sandbox-cancel-before-create' });
  try {
    const run = makeSandboxRun({ fixture });
    fixture.store.approveSandboxRun(run.runId, { expectedHash: run.approvalHash });
    const provider = new FakeSandboxProvider();
    let releasePreflight;
    const preflight = provider.preflight.bind(provider);
    provider.preflight = async (profile) => {
      provider.preflightCalls.push(profile);
      await new Promise((resolve) => { releasePreflight = resolve; });
      return preflight(profile);
    };
    const timers = manualTimers();
    const runner = new SandboxRunner(fixture.store, { provider, workerId: 'sandbox-test', pollMs: 1000, timers });
    const pending = runner.runOnce({ projectId: fixture.projectId });
    await waitFor(() => provider.preflightCalls.length === 1, 'preflight entered');
    fixture.store.requestCancelSandboxRun(run.runId, { actor: 'owner' });
    releasePreflight();
    const result = await pending;
    assert.equal(result.outcome, 'cancelled');
    assert.equal(provider.createCalls.length, 0);
    assert.equal(provider.startCalls.length, 0);
    assert.equal(fixture.store.getSandboxRun(run.runId).status, 'cancelled');
  } finally {
    fixture.cleanup();
  }
});

test('[sandbox#15] cancel after create but before start never starts the container', async () => {
  const fixture = await makeAppliedSandboxFixture({ key: 'sandbox-cancel-after-create' });
  try {
    const run = makeSandboxRun({ fixture });
    fixture.store.approveSandboxRun(run.runId, { expectedHash: run.approvalHash });
    const provider = new FakeSandboxProvider();
    let releaseCreate;
    const create = provider.create.bind(provider);
    provider.create = async (spec) => {
      const created = await create(spec);
      await new Promise((resolve) => { releaseCreate = resolve; });
      return created;
    };
    const timers = manualTimers();
    const runner = new SandboxRunner(fixture.store, { provider, workerId: 'sandbox-test', pollMs: 1000, timers });
    const pending = runner.runOnce({ projectId: fixture.projectId });
    await waitFor(() => provider.createCalls.length === 1, 'create entered');
    fixture.store.requestCancelSandboxRun(run.runId, { actor: 'owner' });
    releaseCreate();
    const result = await pending;
    assert.equal(result.outcome, 'cancelled');
    assert.equal(provider.startCalls.length, 0);
    assert.equal(provider.disposeCalls.length, 1);
    assert.equal(fixture.store.getSandboxRun(run.runId).status, 'cancelled');
  } finally {
    fixture.cleanup();
  }
});

test('[sandbox#16] a create failure with an orphan id enters reconciliation instead of failed', async () => {
  const fixture = await makeAppliedSandboxFixture({ key: 'sandbox-create-orphan' });
  try {
    const run = makeSandboxRun({ fixture });
    fixture.store.approveSandboxRun(run.runId, { expectedHash: run.approvalHash });
    const provider = new FakeSandboxProvider();
    provider.createError = Object.assign(new Error('create ownership inspect failed'), {
      code: 'inspect-unavailable',
      providerRunId: 'fake-orphan-1',
      name: `owner-sandbox-${run.runId}`
    });
    const runner = new SandboxRunner(fixture.store, { provider, workerId: 'sandbox-test', pollMs: 0 });
    const result = await runner.runOnce({ projectId: fixture.projectId });
    assert.equal(result.outcome, 'needs_reconciliation');
    const saved = fixture.store.getSandboxRun(run.runId);
    assert.equal(saved.status, 'needs_reconciliation');
    assert.equal(saved.provider_run_id, 'fake-orphan-1');
    const task = fixture.store.createTask({ projectId: fixture.projectId, title: 'blocked by orphan' });
    const job = fixture.store.createJob({
      projectId: fixture.projectId,
      jobType: 'code-patch',
      title: 'blocked orphan patch',
      payload: { baseSha: fixture.base, allowedPaths: 'src/' },
      idempotencyKey: 'blocked-by-orphan',
      ownerTaskId: task.id
    });
    assert.throws(() => fixture.store.approveJob(job.id), /unresolved sandbox run/);
  } finally {
    fixture.cleanup();
  }
});

test('[sandbox#17] a stop that never returns is bounded and stays fenced', async () => {
  const fixture = await makeAppliedSandboxFixture({ key: 'sandbox-stop-forever' });
  try {
    const run = makeSandboxRun({ fixture });
    fixture.store.approveSandboxRun(run.runId, { expectedHash: run.approvalHash });
    const provider = new FakeSandboxProvider();
    provider.stop = async () => new Promise(() => {});
    const timers = manualTimers();
    const runner = new SandboxRunner(fixture.store, {
      provider, workerId: 'sandbox-test', pollMs: 1000, providerOpMs: 1000, timers
    });
    const pending = runner.runOnce({ projectId: fixture.projectId });
    await waitFor(() => provider.startCalls.length === 1, 'sandbox start');
    fixture.store.requestCancelSandboxRun(run.runId, { actor: 'owner' });
    timers.fireByMs(1000);
    await waitFor(() => [...timers.handles.values()].some((handle) => handle.ms === 1000),
      'stop operation deadline');
    timers.fireByMs(1000);
    const result = await pending;
    assert.equal(result.outcome, 'needs_reconciliation');
    assert.equal(fixture.store.getSandboxRun(run.runId).status, 'needs_reconciliation');
    assert.equal(fs.existsSync(path.join(run.snapshot.snapshotPath, 'input', 'src', 'app.js')), true,
      'snapshot is retained while the stop is unconfirmed');
    const task = fixture.store.createTask({ projectId: fixture.projectId, title: 'blocked by stop-forever' });
    const job = fixture.store.createJob({
      projectId: fixture.projectId,
      jobType: 'code-patch',
      title: 'blocked stop-forever patch',
      payload: { baseSha: fixture.base, allowedPaths: 'src/' },
      idempotencyKey: 'blocked-by-stop-forever',
      ownerTaskId: task.id
    });
    assert.throws(() => fixture.store.approveJob(job.id), /unresolved sandbox run/);
  } finally {
    fixture.cleanup();
  }
});

test('[sandbox#10] a snapshot modified after submission fails before any provider call', async () => {
  const fixture = await makeAppliedSandboxFixture({ key: 'sandbox-snapshot' });
  try {
    const run = makeSandboxRun({ fixture });
    fixture.store.approveSandboxRun(run.runId, { expectedHash: run.approvalHash });
    const runRow = fixture.store.getSandboxRun(run.runId);
    const file = path.join(runRow.snapshot_path, 'input', 'src', 'app.js');
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, 'mutated after approval\n');
    const provider = new FakeSandboxProvider();
    const runner = new SandboxRunner(fixture.store, { provider, workerId: 'sandbox-test', pollMs: 0 });
    const result = await runner.runOnce({ projectId: fixture.projectId });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.errorCode, 'snapshot-invalid');
    assert.equal(provider.createCalls.length, 0);
    assert.equal(fixture.store.getSandboxRun(run.runId).status, 'failed');
  } finally {
    fixture.cleanup();
  }
});
