import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { OwnerStore } from '../../src/owner-store.mjs';
import { WorkspaceBroker } from '../../src/workspace-broker.mjs';
import { PatchCodingWorker } from '../../src/patch-coding-worker.mjs';
import { FakePatchProposalAgent } from '../../src/patch-proposal-agent.mjs';

export const git = (cwd, args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
}).trim();

export const defaultPatchFiles = () => [
  { path: 'src/app.js', action: 'modify', content: 'export const x = 2;\n' },
  {
    path: 'tests/sandbox-smoke.test.mjs',
    action: 'add',
    content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('sandbox smoke', () => assert.equal(1, 1));\n"
  }
];

export const makeAppliedSandboxFixture = async ({
  projectId = 'proj-a',
  patchFiles = defaultPatchFiles(),
  key = 'sandbox-fixture'
} = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-fixture-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'tests', '.keep'), '');
  fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'export const x = 1;\n');
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'owner@example.invalid']);
  git(repo, ['config', 'user.name', 'Owner Test']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'init']);
  const base = git(repo, ['rev-parse', 'HEAD']);

  const store = new OwnerStore(path.join(root, 'knowledge.sqlite'));
  store.registerProject({ id: projectId, name: 'Sandbox Project', root: repo, primaryDomain: 'software-engineering' });
  const broker = new WorkspaceBroker(store, { workspacesRoot: path.join(root, 'workspaces') });
  const task = store.createTask({ projectId, title: 'Sandbox fixture task' });
  const job = store.createJob({
    projectId,
    jobType: 'code-patch',
    title: 'Sandbox fixture patch',
    payload: { baseSha: base, allowedPaths: 'src/,tests/' },
    idempotencyKey: key,
    ownerTaskId: task.id
  });
  store.approveJob(job.id);
  const patchWorker = new PatchCodingWorker(store, {
    broker,
    proposalAgent: new FakePatchProposalAgent({ files: patchFiles }),
    workerId: 'sandbox-patch-worker'
  });
  const patchRun = await patchWorker.runOnce({ projectId });
  if (patchRun.outcome !== 'succeeded') {
    throw new Error(`fixture patch failed: ${store.getJob(job.id).attempts[0]?.result_note ?? patchRun.outcome}`);
  }
  let proposal = store.getPatchProposal(patchRun.proposalId);
  store.approvePatchProposal(proposal.id, { expectedHash: proposal.proposal_hash });
  const workspace = store.getWorkspaceForAttempt(job.id, 1);
  const applied = await broker.applyProposal(workspace, store.getPatchProposal(proposal.id));
  if (applied.outcome !== 'applied') throw new Error(`fixture apply failed: ${applied.outcome}`);
  proposal = store.getPatchProposal(proposal.id);
  return {
    root,
    repo,
    base,
    store,
    broker,
    task,
    job,
    projectId,
    proposal,
    workspace,
    sandboxRoot: path.join(root, 'sandbox'),
    cleanup() {
      try { store.close(); } catch { /* already closed */ }
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
};
