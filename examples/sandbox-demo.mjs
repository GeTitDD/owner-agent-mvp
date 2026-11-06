// Deterministic v0.9 demo: applied patch → frozen input snapshot → Owner approval →
// Fake SandboxProvider execution → bounded evidence → explicit snapshot cleanup.
// No real Docker, no project code in the host process, no network, no cost.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { OwnerStore } from '../src/owner-store.mjs';
import { WorkspaceBroker } from '../src/workspace-broker.mjs';
import { PatchCodingWorker } from '../src/patch-coding-worker.mjs';
import { FakePatchProposalAgent } from '../src/patch-proposal-agent.mjs';
import { FakeSandboxProvider } from '../src/sandbox-provider.mjs';
import { SandboxRunner } from '../src/sandbox-runner.mjs';
import { createInputSnapshot, cleanupInputSnapshot } from '../src/sandbox-materializer.mjs';
import { approvalHash, resolveTestProfile } from '../src/sandbox-protocol.mjs';
import { sha256 } from '../src/utils.mjs';

let failures = 0;
const expect = (label, actual, expected) => {
  const ok = actual === expected;
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${label} (actual=${JSON.stringify(actual)}${ok ? '' : `, expected=${JSON.stringify(expected)}`})`);
  if (!ok) failures++;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-sandbox-demo-'));
const repo = path.join(dir, 'repo');
const store = new OwnerStore(path.join(dir, 'demo.sqlite'));
try {
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'tests', '.keep'), '');
  fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'export const retries = 1;\n');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'demo@example.invalid');
  git('config', 'user.name', 'Demo Owner');
  git('add', '.');
  git('commit', '-qm', 'init');
  const base = git('rev-parse', 'HEAD');

  store.registerProject({ id: 'demo-sandbox', name: 'Sandbox Demo', root: repo, primaryDomain: 'software-engineering' });
  const task = store.createTask({ projectId: 'demo-sandbox', title: 'Run bounded sandbox smoke' });
  const job = store.createJob({
    projectId: 'demo-sandbox',
    jobType: 'code-patch',
    title: 'Add sandbox smoke test',
    payload: { baseSha: base, allowedPaths: 'src/,tests/' },
    idempotencyKey: 'sandbox-demo-patch',
    ownerTaskId: task.id
  });
  store.approveJob(job.id);
  const broker = new WorkspaceBroker(store, { workspacesRoot: path.join(dir, 'workspaces') });
  const patchWorker = new PatchCodingWorker(store, {
    broker,
    proposalAgent: new FakePatchProposalAgent({
      files: [
        { path: 'src/app.js', action: 'modify', content: 'export const retries = 2;\n' },
        {
          path: 'tests/sandbox-smoke.test.mjs',
          action: 'add',
          content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('demo sandbox smoke', () => assert.equal(1, 1));\n"
        }
      ]
    }),
    workerId: 'sandbox-demo-patch-worker'
  });
  const patchRun = await patchWorker.runOnce({ projectId: 'demo-sandbox' });
  expect('applied proposal is required for sandbox input', patchRun.outcome, 'succeeded');
  let proposal = store.getPatchProposal(patchRun.proposalId);
  store.approvePatchProposal(proposal.id, { expectedHash: proposal.proposal_hash });
  const workspace = store.getWorkspaceForAttempt(job.id, 1);
  const applied = await broker.applyProposal(workspace, store.getPatchProposal(proposal.id));
  expect('patch is applied in its isolated worktree', applied.outcome, 'applied');
  proposal = store.getPatchProposal(proposal.id);

  const imageDigest = `sha256:${'a'.repeat(64)}`;
  const profile = resolveTestProfile('node-smoke', { imageDigest });
  const runId = 'demo-sandbox-run-1';
  const snapshot = createInputSnapshot({
    runId,
    workspacePath: workspace.path,
    proposal,
    includePaths: [],
    sandboxRoot: path.join(dir, 'sandbox')
  });
  const hash = approvalHash({
    projectId: 'demo-sandbox',
    workspaceId: workspace.id,
    proposalId: proposal.id,
    approvedHash: proposal.approved_hash,
    baseSha: proposal.base_sha,
    profile,
    snapshotHash: snapshot.snapshotHash,
    includePaths: []
  });
  const run = store.createSandboxRun({
    id: runId,
    projectId: 'demo-sandbox',
    jobId: job.id,
    attempt: proposal.attempt,
    workspaceId: workspace.id,
    proposalId: proposal.id,
    approvedHash: proposal.approved_hash,
    baseSha: proposal.base_sha,
    profile,
    approvalHash: hash,
    snapshotHash: snapshot.snapshotHash,
    snapshotPath: snapshot.snapshotPath,
    includePaths: []
  });
  const manifest = JSON.stringify(snapshot.manifest);
  store.saveSandboxEvidence(runId, 'snapshot_manifest', {
    content: manifest, contentHash: sha256(manifest), bytes: Buffer.byteLength(manifest)
  });
  expect('sandbox run starts pending Owner approval', run.status, 'pending_approval');
  expect('snapshot is hash-bound', snapshot.snapshotHash.length, 64);

  store.approveSandboxRun(runId, { expectedHash: hash });
  const provider = new FakeSandboxProvider();
  const start = provider.start.bind(provider);
  provider.start = async (handle) => {
    const result = await start(handle);
    provider.complete(handle, {
      exitCode: 0,
      stdout: 'TAP version 13\nok 1 - demo sandbox smoke\n',
      stderr: ''
    });
    return result;
  };
  const runner = new SandboxRunner(store, { provider, workerId: 'demo-sandbox-runner', pollMs: 0 });
  const result = await runner.runOnce({ projectId: 'demo-sandbox' });
  expect('sandbox run completes', result.outcome, 'completed');
  expect('test status is separate from execution status', result.testStatus, 'pass');
  const saved = store.getSandboxRun(runId);
  expect('run status completed', saved.status, 'completed');
  expect('execution status completed', saved.execution_status, 'completed');
  expect('test status pass', saved.test_status, 'pass');
  const stdout = store.getSandboxEvidence(runId, 'stdout');
  expect('stdout evidence is hashed', stdout.content_hash, sha256(stdout.content));
  expect('main worktree remains untouched', fs.readFileSync(path.join(repo, 'src', 'app.js'), 'utf8'), 'export const retries = 1;\n');
  expect('logs are not stored in Job events', JSON.stringify(store.getJob(job.id).events).includes('TAP version'), false);

  const cleaned = cleanupInputSnapshot({
    snapshotPath: snapshot.snapshotPath,
    runId,
    snapshotHash: snapshot.snapshotHash,
    sandboxRoot: path.join(dir, 'sandbox')
  });
  expect('explicit cleanup removes the private snapshot', cleaned.cleaned, true);
  expect('snapshot directory is gone', fs.existsSync(snapshot.snapshotPath), false);

  console.log('\n== demo finished ==');
  if (failures) {
    console.error(`\n${failures} demo assertion(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nAll demo assertions passed');
  }
} finally {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
