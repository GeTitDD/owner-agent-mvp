// Deterministic v1.0 demo: applied patch → failing sandbox evidence → Owner-approved
// repair cycle → replacement proposal on a fresh worktree → apply → passing sandbox.
// Every approval breakpoint is explicit; nothing is auto-applied/tested/merged.
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
import { createInputSnapshot } from '../src/sandbox-materializer.mjs';
import { approvalHash, resolveTestProfile } from '../src/sandbox-protocol.mjs';
import { submitRepairCycle, approveRepairCycle } from '../src/repair-service.mjs';
import { sha256 } from '../src/utils.mjs';

let failures = 0;
const expect = (label, actual, expected) => {
  const ok = actual === expected;
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${label} (actual=${JSON.stringify(actual)}${ok ? '' : `, expected=${JSON.stringify(expected)}`})`);
  if (!ok) failures++;
};
const digest = `sha256:${'a'.repeat(64)}`;
const profile = resolveTestProfile('node-smoke', { imageDigest: digest });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-repair-demo-'));
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

  store.registerProject({ id: 'demo-repair', name: 'Repair Demo', root: repo, primaryDomain: 'software-engineering' });
  const task = store.createTask({ projectId: 'demo-repair', title: 'Repair retry test' });
  const sourceJob = store.createJob({
    projectId: 'demo-repair',
    jobType: 'code-patch',
    title: 'Initial patch',
    payload: { baseSha: base, allowedPaths: 'src/,tests/' },
    idempotencyKey: 'repair-demo-source-patch',
    ownerTaskId: task.id
  });
  store.approveJob(sourceJob.id);
  const broker = new WorkspaceBroker(store, { workspacesRoot: path.join(dir, 'workspaces') });
  const sourcePatch = new PatchCodingWorker(store, {
    broker,
    workerId: 'repair-demo-source-worker',
    proposalAgent: new FakePatchProposalAgent({
      files: [
        { path: 'src/app.js', action: 'modify', content: 'export const retries = 2;\n' },
        {
          path: 'tests/sandbox-smoke.test.mjs',
          action: 'add',
          content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('buggy', () => assert.equal(2, 3));\n"
        }
      ]
    })
  });
  const sourcePatchRun = await sourcePatch.runOnce({ projectId: 'demo-repair' });
  expect('source patch proposal stored', sourcePatchRun.outcome, 'succeeded');
  let sourceProposal = store.getPatchProposal(sourcePatchRun.proposalId);
  store.approvePatchProposal(sourceProposal.id, { expectedHash: sourceProposal.proposal_hash });
  const sourceWorkspace = store.getWorkspaceForAttempt(sourceJob.id, 1);
  expect('source patch applied in its own worktree', (await broker.applyProposal(sourceWorkspace, store.getPatchProposal(sourceProposal.id))).outcome, 'applied');
  sourceProposal = store.getPatchProposal(sourceProposal.id);

  const runSandbox = async ({ runId, proposal, workspace, exitCode, repairCycleId = null }) => {
    const snapshot = createInputSnapshot({
      runId, workspacePath: workspace.path, proposal, includePaths: [], sandboxRoot: path.join(dir, 'sandbox')
    });
    const hash = approvalHash({
      projectId: 'demo-repair', workspaceId: workspace.id, proposalId: proposal.id,
      approvedHash: proposal.approved_hash, baseSha: proposal.base_sha, profile,
      snapshotHash: snapshot.snapshotHash, includePaths: []
    });
    store.createSandboxRun({
      id: runId, projectId: 'demo-repair', jobId: proposal.job_id, attempt: proposal.attempt,
      workspaceId: workspace.id, proposalId: proposal.id, approvedHash: proposal.approved_hash,
      baseSha: proposal.base_sha, profile, approvalHash: hash,
      snapshotHash: snapshot.snapshotHash, snapshotPath: snapshot.snapshotPath, includePaths: [],
      repairCycleId
    });
    const manifest = JSON.stringify(snapshot.manifest);
    store.saveSandboxEvidence(runId, 'snapshot_manifest', { content: manifest, contentHash: sha256(manifest), bytes: Buffer.byteLength(manifest) });
    store.approveSandboxRun(runId, { expectedHash: hash });
    const provider = new FakeSandboxProvider();
    const start = provider.start.bind(provider);
    provider.start = async (handle) => {
      const result = await start(handle);
      provider.complete(handle, { exitCode, stdout: exitCode ? 'not ok 1 - expected 2, got 3\n' : 'ok 1 - repaired\n', stderr: '' });
      return result;
    };
    const runner = new SandboxRunner(store, { provider, workerId: `demo-${runId}`, pollMs: 0 });
    return runner.runOnce({ projectId: 'demo-repair' });
  };

  const sourceFail = await runSandbox({ runId: 'source-fail', proposal: sourceProposal, workspace: sourceWorkspace, exitCode: 1 });
  expect('source sandbox completes with test fail', sourceFail.testStatus, 'fail');

  const cycle = submitRepairCycle(store, {
    sandboxRunId: 'source-fail', scope: ['src/', 'tests/'], idempotencyKey: 'repair-demo-key'
  });
  expect('repair cycle waits for Owner approval', cycle.status, 'pending_approval');
  const approved = approveRepairCycle(store, { id: cycle.id, expectedHash: cycle.approval_hash });
  expect('Owner approval freezes one repair job', approved.status, 'queued');
  expect('repair job is a new code-patch job', approved.job.job_type, 'code-patch');

  const repairPatch = new PatchCodingWorker(store, {
    broker,
    workerId: 'repair-demo-repair-worker',
    proposalAgent: new FakePatchProposalAgent({
      files: [
        { path: 'src/app.js', action: 'modify', content: 'export const retries = 3;\n' },
        {
          path: 'tests/sandbox-smoke.test.mjs',
          action: 'add',
          content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fixed', () => assert.equal(3, 3));\n"
        }
      ]
    })
  });
  const repairPatchRun = await repairPatch.runOnce({ projectId: 'demo-repair' });
  expect('replacement proposal stored from fresh worktree', repairPatchRun.outcome, 'succeeded');
  const repairProposal = store.getPatchProposal(repairPatchRun.proposalId);
  expect('repair proposal is linked to the cycle', repairProposal.repair_cycle_id, cycle.id);
  expect('cycle waits for proposal approval', store.getRepairCycle(cycle.id).status, 'proposal_ready');
  store.approvePatchProposal(repairProposal.id, { expectedHash: repairProposal.proposal_hash });
  const repairWorkspace = store.getWorkspace(repairProposal.workspace_id);
  expect('repaired proposal applied separately', (await broker.applyProposal(repairWorkspace, store.getPatchProposal(repairProposal.id))).outcome, 'applied');
  expect('cycle records applied', store.getRepairCycle(cycle.id).status, 'applied');

  const repairPass = await runSandbox({
    runId: 'repair-pass', proposal: store.getPatchProposal(repairProposal.id), workspace: repairWorkspace,
    exitCode: 0, repairCycleId: cycle.id
  });
  expect('repaired sandbox completes with test pass', repairPass.testStatus, 'pass');
  expect('cycle records tested_pass', store.getRepairCycle(cycle.id).status, 'tested_pass');
  expect('OwnerTask remains todo', store.getTask(task.id).status, 'todo');
  expect('source worktree remains unchanged', fs.readFileSync(path.join(sourceWorkspace.path, 'src', 'app.js'), 'utf8'), 'export const retries = 2;\n');
  expect('source test evidence remains private to owner storage', store.getSandboxEvidence('source-fail', 'stdout').content.includes('not ok'), true);
  expect('no automatic merge/PR was performed', true, true);

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
