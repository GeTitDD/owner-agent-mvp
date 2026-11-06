// Deterministic v0.8 demo: base-pinned worktree → fake patch proposal → Owner approval
// → apply in the isolated worktree → inspect diff → explicit cleanup.
// No real model, no network, no API key, no cost. The project's main worktree is never
// modified; the only writes happen inside the per-attempt worktree.
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { OwnerStore } from '../src/owner-store.mjs';
import { WorkspaceBroker } from '../src/workspace-broker.mjs';
import { PatchCodingWorker } from '../src/patch-coding-worker.mjs';
import { FakePatchProposalAgent } from '../src/patch-proposal-agent.mjs';

let failures = 0;
const expect = (label, actual, expected) => {
  const ok = actual === expected;
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${label} (actual=${JSON.stringify(actual)}${ok ? '' : `, expected=${JSON.stringify(expected)}`})`);
  if (!ok) failures++;
};
let t = Date.parse('2026-08-01T09:00:00.000Z');
const now = () => new Date(t).toISOString();
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const dir = mkdtempSync(path.join(os.tmpdir(), 'owner-patch-demo-'));
const repo = path.join(dir, 'repo');
const store = new OwnerStore(path.join(dir, 'demo.sqlite'));
try {
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  writeFileSync(path.join(repo, 'src', 'app.js'), 'export const retries = 1;\n');
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'demo@example.invalid']);
  git(repo, ['config', 'user.name', 'Demo Owner']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'init']);
  const base = git(repo, ['rev-parse', 'HEAD']);

  store.registerProject({
    id: 'demo-patch',
    name: 'Demo Patch Project',
    root: repo,
    primaryDomain: 'software-engineering',
    goal: 'Raise retry limit safely'
  });
  const task = store.createTask({ projectId: 'demo-patch', title: 'Raise the retry limit', note: 'Keep it to src/app.js' });
  const job = store.createJob({
    projectId: 'demo-patch',
    jobType: 'code-patch',
    title: 'Retry limit proposal',
    payload: { baseSha: base, allowedPaths: 'src/', focus: 'retries 2' },
    idempotencyKey: 'patch-demo-1',
    ownerTaskId: task.id
  });
  expect('submitted code-patch job starts pending_approval', job.status, 'pending_approval');

  const broker = new WorkspaceBroker(store, { workspacesRoot: path.join(dir, 'workspaces') });
  const agent = new FakePatchProposalAgent({
    files: [
      { path: 'src/app.js', action: 'modify', content: 'export const retries = 2;\n' },
      { path: 'src/retry.js', action: 'add', content: 'export const policy = "bounded";\n' }
    ]
  });
  const worker = new PatchCodingWorker(store, {
    broker,
    proposalAgent: agent,
    workerId: 'demo-patch-worker',
    clock: now,
    leaseMs: 30000
  });

  const beforeApproval = await worker.runOnce({ projectId: 'demo-patch' });
  expect('unapproved job is never scheduled', beforeApproval.reason, 'no-queued-job');
  expect('no agent call before approval', agent.calls.length, 0);

  store.approveJob(job.id, { now: now() });
  const run = await worker.runOnce({ projectId: 'demo-patch' });
  expect('approved code-patch job succeeds', run.outcome, 'succeeded');
  expect('proposal has two files', run.files, 2);

  const proposal = store.getPatchProposal(run.proposalId);
  const workspace = store.getWorkspaceForAttempt(job.id, 1);
  expect('proposal is awaiting Owner review', proposal.status, 'proposed');
  expect('proposal hash is sha256', proposal.proposal_hash.length, 64);
  expect('workspace is a dedicated attempt path', workspace.path.includes(path.join('demo-patch', job.id, 'a1')), true);
  expect('main worktree is untouched', readFileSync(path.join(repo, 'src', 'app.js'), 'utf8'), 'export const retries = 1;\n');
  expect('main HEAD is still the approved base', git(repo, ['rev-parse', 'HEAD']), base);
  expect('OwnerTask is not auto-completed', store.getTask(task.id).status, 'todo');
  expect('Job success does not use the generic result table', store.listJobResults(job.id).length, 0);

  const proposalDiff = store.getPatchArtifactContent(proposal.id, 'proposal_diff');
  expect('proposal diff is reviewable unified diff', proposalDiff.startsWith('diff --git '), true);

  // Wrong hash never applies.
  let wrongHashRejected = false;
  try {
    store.approvePatchProposal(proposal.id, { expectedHash: '0'.repeat(64) });
  } catch {
    wrongHashRejected = true;
  }
  expect('a wrong approval hash is rejected', wrongHashRejected, true);

  store.approvePatchProposal(proposal.id, { expectedHash: proposal.proposal_hash });
  const applied = await broker.applyProposal(workspace, store.getPatchProposal(proposal.id));
  expect('approved proposal applies exactly once', applied.outcome, 'applied');
  expect('main worktree stays unchanged after apply', readFileSync(path.join(repo, 'src', 'app.js'), 'utf8'), 'export const retries = 1;\n');
  expect('worktree contains the proposed change', readFileSync(path.join(workspace.path, 'src', 'app.js'), 'utf8'), 'export const retries = 2;\n');
  expect('applied diff is archived', store.getPatchArtifactContent(proposal.id, 'applied_diff').startsWith('diff --git '), true);
  expect('proposal reaches applied', store.getPatchProposal(proposal.id).status, 'applied');

  const cleaned = await broker.cleanup(workspace.id, { confirm: true });
  expect('explicit cleanup removes the worktree', cleaned.status, 'cleaned');
  expect('controlled branch is removed', git(repo, ['branch', '--list', workspace.branch]), '');
  expect('Project main worktree is still intact', readFileSync(path.join(repo, 'src', 'app.js'), 'utf8'), 'export const retries = 1;\n');

  console.log('\n== demo finished ==');
  if (failures) {
    console.error(`\n${failures} demo assertion(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nAll demo assertions passed');
  }
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
