// OwnerWorker 契约测试：只推进已批准对象，且一次只处理一个。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { OwnerStore } from '../src/owner-store.mjs';
import { WorkspaceBroker } from '../src/workspace-broker.mjs';
import { FakePatchProposalAgent } from '../src/patch-proposal-agent.mjs';
import { OwnerWorker } from '../src/worker-agent.mjs';

const git = (cwd, args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
}).trim();

const fixture = (root) => {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'),
    '{"name":"worker-test","private":true,"type":"module"}\n', 'utf8');
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.owner-root-identity\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'value.js'),
    'export const value = () => 1;\n', 'utf8');
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'user.email', 'worker@example.invalid']);
  git(root, ['config', 'user.name', 'Worker Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  return git(root, ['rev-parse', 'HEAD']);
};

const withWorker = async (fn) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-worker-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const base = fixture(repo);
  const store = new OwnerStore(path.join(root, 'owner.sqlite'));
  store.registerProject({ id: 'p1', name: 'Worker', root: repo });
  const task = store.createTask({ projectId: 'p1', title: 'Worker task' });
  const job = store.createJob({
    projectId: 'p1',
    jobType: 'code-patch',
    title: 'Change value',
    payload: { baseSha: base, allowedPaths: 'src/' },
    idempotencyKey: 'worker-job-1',
    ownerTaskId: task.id
  });
  const broker = new WorkspaceBroker(store, { workspacesRoot: path.join(root, 'workspaces') });
  const worker = new OwnerWorker(store, {
    broker,
    proposalAgent: new FakePatchProposalAgent({
      files: [{
        path: 'src/value.js',
        action: 'modify',
        content: 'export const value = () => 2;\n'
      }]
    }),
    allowModel: false
  });
  try {
    await fn({ store, worker, job });
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
};

test('worker does not execute a job that is not approved', async () => {
  await withWorker(async ({ store, worker, job }) => {
    const result = await worker.start({ wait: true });
    assert.equal(result.kind, 'idle');
    assert.equal(store.getJob(job.id).status, 'pending_approval');
    assert.equal(store.listPatchProposals({ projectId: 'p1' }).length, 0);
  });
});

test('worker executes an approved job once', async () => {
  await withWorker(async ({ store, worker, job }) => {
    store.approveJob(job.id, { actor: 'test' });
    const result = await worker.start({ wait: true });
    assert.equal(result.kind, 'patch');
    assert.equal(result.outcome, 'succeeded');
    assert.equal(store.getJob(job.id).status, 'succeeded');
    const proposals = store.listPatchProposals({ projectId: 'p1' });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].status, 'proposed');
    assert.equal(proposals[0].files[0].path, 'src/value.js');
  });
});
