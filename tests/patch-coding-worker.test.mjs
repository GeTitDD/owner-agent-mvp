import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { OwnerStore } from '../src/owner-store.mjs';
import { WorkspaceBroker } from '../src/workspace-broker.mjs';
import { PatchCodingWorker } from '../src/patch-coding-worker.mjs';
import {
  FakePatchProposalAgent,
  PatchProposalAgent,
  parseProposalText
} from '../src/patch-proposal-agent.mjs';
import {
  PATCH_LIMITS,
  normalizeAllowedEntries,
  normalizeRelPath,
  validateProposal
} from '../src/patch-protocol.mjs';
import { waitFor } from './helpers/wait.mjs';

const clock = (start = '2026-08-01T00:00:00.000Z') => {
  let t = Date.parse(start);
  return {
    now: () => new Date(t).toISOString(),
    advanceMs: (ms) => {
      t += ms;
      return new Date(t).toISOString();
    }
  };
};

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
    fire: (id) => {
      const handle = handles.get(id);
      if (handle) handle.fn();
    },
    fireByMs: (ms) => {
      for (const [id, handle] of [...handles]) {
        if (handle.ms === ms) {
          handles.delete(id);
          handle.fn();
        }
      }
    }
  };
};

const git = (cwd, args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
});

const gitOut = (cwd, args) => git(cwd, args).trim();

// Directory links are unavailable in some restricted Windows hosts; try a real symlink
// first, then a junction, and let the caller skip only when neither is possible.
const makeDirLink = (target, link) => {
  try {
    symlinkSync(target, link, 'dir');
    return true;
  } catch {
    // fall through
  }
  try {
    symlinkSync(target, link, 'junction');
    return true;
  } catch {
    return false;
  }
};

const makeRepo = (parent, name = 'repo') => {
  const repo = path.join(parent, name);
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  writeFileSync(path.join(repo, 'src', 'app.js'), 'export const x = 1;\n');
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'owner@example.invalid']);
  git(repo, ['config', 'user.name', 'Owner Test']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'init']);
  return { repo, base: gitOut(repo, ['rev-parse', 'HEAD']) };
};

const withEnv = async (cb) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'patch-worker-test-'));
  const { repo, base } = makeRepo(root);
  const store = new OwnerStore(path.join(root, 'knowledge.sqlite'));
  store.registerProject({ id: 'proj-a', name: 'Project A', root: repo, primaryDomain: 'software-engineering' });
  const broker = new WorkspaceBroker(store, { workspacesRoot: path.join(root, 'workspaces') });
  const c = clock();
  try {
    return await cb({ root, repo, base, store, broker, clock: c, projectId: 'proj-a' });
  } finally {
    try { store.close(); } catch { /* already closed */ }
    rmSync(root, { recursive: true, force: true });
  }
};

const submitCode = (store, clock, { projectId = 'proj-a', base, key, allowedPaths = 'src/' } = {}) => {
  const task = store.createTask({ projectId, title: 'Change the fixture' });
  const job = store.createJob({
    projectId,
    jobType: 'code-patch',
    title: 'Patch fixture',
    payload: { baseSha: base, allowedPaths, focus: 'keep it small' },
    idempotencyKey: key,
    ownerTaskId: task.id
  });
  store.approveJob(job.id, { now: clock.now() });
  return { task, job };
};

const happyFiles = () => [
  { path: 'src/app.js', action: 'modify', content: 'export const x = 2;\n' },
  { path: 'src/new.js', action: 'add', content: 'export const y = 3;\n' }
];

const runWorker = async ({ store, broker, clock, projectId = 'proj-a', files = happyFiles(), timers, leaseMs = 30000, timeoutMs = 120000, abortConfirmMs = 5000, agent }) => {
  const proposalAgent = agent ?? new FakePatchProposalAgent({ files });
  const worker = new PatchCodingWorker(store, {
    broker,
    proposalAgent,
    workerId: 'patch-test-worker',
    clock: clock.now,
    leaseMs,
    timeoutMs,
    abortConfirmMs,
    timers
  });
  return worker.runOnce({ projectId });
};

test('[patch#1] an unapproved job or the real model gate never reaches a session or worktree', () => withEnv(async ({ store, base, broker, clock }) => {
  const { job } = submitCode(store, clock, { base, key: 'gate-1' });
  // Remove approval for the first assertion by creating a second, still-pending job.
  const task = store.createTask({ projectId: 'proj-a', title: 'Pending task' });
  const pending = store.createJob({
    projectId: 'proj-a',
    jobType: 'code-patch',
    title: 'Pending patch',
    payload: { baseSha: base, allowedPaths: 'src/' },
    idempotencyKey: 'gate-pending',
    ownerTaskId: task.id
  });
  const agent = new FakePatchProposalAgent({ files: happyFiles() });
  const first = await runWorker({ store, broker, clock, agent });
  // The approved job runs; the pending job must still never be claimed.
  assert.equal(first.outcome, 'succeeded');
  assert.equal(agent.calls.length, 1);
  assert.equal(store.getJob(pending.id).status, 'pending_approval');

  const gatedJob = store.createJob({
    projectId: 'proj-a',
    jobType: 'code-patch',
    title: 'Real gate',
    payload: { baseSha: base, allowedPaths: 'src/' },
    idempotencyKey: 'gate-real',
    ownerTaskId: store.createTask({ projectId: 'proj-a', title: 'Gate task' }).id
  });
  store.approveJob(gatedJob.id, { now: clock.now() });
  const realWorker = new PatchCodingWorker(store, {
    broker,
    workerId: 'real-gate-worker',
    clock: clock.now,
    proposalAgent: new PatchProposalAgent()
  });
  const refused = await realWorker.runOnce({ projectId: 'proj-a', allowModel: false });
  assert.deepEqual(refused, { claimed: false, reason: 'model-disabled' });
  assert.equal(store.getJob(gatedJob.id).status, 'queued');
  assert.equal(store.getJob(gatedJob.id).attempts.length, 0);
  assert.equal(store.getWorkspaceForAttempt(gatedJob.id, 1), null);
  // The real factory was never asked to create a session.
  assert.equal(store.getJob(job.id).status, 'succeeded');
}));

test('[patch#2] happy path stores a hash-bound proposal, leaves the main worktree untouched, applies once in its own worktree, then cleans up', () => withEnv(async ({ store, repo, base, broker, clock }) => {
  const { task, job } = submitCode(store, clock, { base, key: 'happy-1' });
  const agent = new FakePatchProposalAgent({ files: happyFiles() });
  const run = await runWorker({ store, broker, clock, agent });
  assert.equal(run.outcome, 'succeeded');
  assert.equal(run.files, 2);

  const proposal = store.getPatchProposal(run.proposalId);
  assert.equal(proposal.status, 'proposed');
  assert.equal(proposal.project_id, 'proj-a');
  assert.equal(proposal.job_id, job.id);
  assert.equal(proposal.attempt, 1);
  assert.equal(proposal.base_sha, base);
  assert.equal(proposal.files.length, 2);
  for (const file of proposal.files) {
    assert.equal(Object.hasOwn(file, 'content'), false, 'proposal metadata never stores source content');
  }
  assert.match(store.getPatchArtifactContent(proposal.id, 'proposal_diff'), /^diff --git /);
  assert.equal(store.listJobResults(job.id).length, 0, 'code-patch does not use the generic result table');

  // Prompt material is bounded to the allowed project snapshot.
  assert.equal(agent.calls.length, 1);
  assert.ok(agent.calls[0].material.some((m) => m.path === 'src/app.js'));
  assert.equal(agent.calls[0].cwd, store.getWorkspaceForAttempt(job.id, 1).path);

  const workspace = store.getWorkspaceForAttempt(job.id, 1);
  assert.equal(workspace.status, 'active');
  assert.ok(workspace.path.includes(path.join('proj-a', job.id, 'a1')));
  assert.equal(readFileSync(path.join(repo, 'src', 'app.js'), 'utf8'), 'export const x = 1;\n');
  assert.equal(gitOut(repo, ['rev-parse', 'HEAD']), base);
  assert.equal(store.getTask(task.id).status, 'todo', 'OwnerTask is never auto-completed');

  // Job/audit surfaces carry references only, never source content or prompts.
  const jobAfter = store.getJob(job.id);
  assert.ok(jobAfter.attempts[0].result_note.includes('proposal stored'));
  assert.ok(jobAfter.attempts[0].result_note.includes(proposal.proposal_hash.slice(0, 8)));
  const eventText = JSON.stringify(jobAfter.events);
  assert.equal(eventText.includes('export const x = 2'), false);
  assert.equal(eventText.includes('keep it small'), false);
  const oplogText = JSON.stringify(store.listPatchOplog(job.id));
  assert.equal(oplogText.includes('export const x = 2'), false);

  // Wrong approval hash is rejected without changing state.
  assert.throws(() => store.approvePatchProposal(proposal.id, { expectedHash: '0'.repeat(64) }),
    /Approval hash does not match/);
  assert.equal(store.getPatchProposal(proposal.id).status, 'proposed');

  store.approvePatchProposal(proposal.id, { expectedHash: proposal.proposal_hash });
  const applied = await broker.applyProposal(workspace, store.getPatchProposal(proposal.id));
  assert.equal(applied.outcome, 'applied');
  assert.equal(store.getPatchProposal(proposal.id).status, 'applied');
  assert.match(store.getPatchArtifactContent(proposal.id, 'applied_diff'), /^diff --git /);
  assert.equal(readFileSync(path.join(repo, 'src', 'app.js'), 'utf8'), 'export const x = 1;\n');
  assert.equal(readFileSync(path.join(workspace.path, 'src', 'app.js'), 'utf8'), 'export const x = 2;\n');
  assert.equal(readFileSync(path.join(workspace.path, 'src', 'new.js'), 'utf8'), 'export const y = 3;\n');

  // The same approval cannot be applied a second time.
  assert.throws(() => store.approvePatchProposal(proposal.id, { expectedHash: proposal.proposal_hash }),
    /cannot be approved/);
  assert.throws(() => store.beginPatchApply(proposal.id), /cannot enter apply/);
  await assert.rejects(() => broker.applyProposal(workspace, store.getPatchProposal(proposal.id)),
    /cannot be applied/);

  // Cleanup needs explicit consent and removes only the recorded worktree/branch.
  await assert.rejects(() => broker.cleanup(workspace.id), /explicit owner confirmation/);
  const cleaned = await broker.cleanup(workspace.id, { confirm: true });
  assert.equal(cleaned.status, 'cleaned');
  assert.equal(existsSync(workspace.path), false);
  assert.equal(gitOut(repo, ['branch', '--list', workspace.branch]), '');
  assert.equal(readFileSync(path.join(repo, 'src', 'app.js'), 'utf8'), 'export const x = 1;\n');
}));

test('[patch#3] dirty projects and base drift are rejected before any worktree is created', () => withEnv(async ({ store, repo, base, broker, clock }) => {
  const first = submitCode(store, clock, { base, key: 'dirty-1' });
  writeFileSync(path.join(repo, 'src', 'app.js'), 'export const x = 99;\n');
  const dirtyRun = await runWorker({ store, broker, clock });
  assert.equal(dirtyRun.outcome, 'failed');
  assert.equal(store.getWorkspaceForAttempt(first.job.id, 1), null);
  assert.equal(store.listPatchProposals({ projectId: 'proj-a' }).length, 0);

  git(repo, ['checkout', '--', '.']);
  writeFileSync(path.join(repo, 'src', 'app.js'), 'export const x = 4;\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'move head']);
  const second = submitCode(store, clock, { base, key: 'drift-1' });
  const driftRun = await runWorker({ store, broker, clock });
  assert.equal(driftRun.outcome, 'failed');
  assert.equal(store.getWorkspaceForAttempt(second.job.id, 1), null);
  assert.equal(store.getJob(second.job.id).attempts[0].result_note.includes('base drift'), true);
}));

test('[patch#4] path/scope/link/size attacks are rejected by the trusted validator', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'patch-protocol-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'patch-outside-'));
  try {
    mkdirSync(path.join(root, 'src', 'sub'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'app.js'), 'old\n');
    writeFileSync(path.join(outside, 'target.txt'), 'outside\n');
    const validate = (rawFiles, allowedPaths = ['src']) => validateProposal({
      worktreeRoot: root,
      allowedPaths,
      rawFiles
    });
    const modify = (p, content = 'new\n') => ({ path: p, action: 'modify', content });
    const add = (p, content = 'new\n') => ({ path: p, action: 'add', content });

    assert.throws(() => validate([add('../escape.txt')]), /traversal|empty segment/);
    assert.throws(() => validate([add('/absolute.txt')]), /absolute/);
    assert.throws(() => validate([add('C:\\absolute.txt')]), /drive-letter/);
    assert.throws(() => validate([add('.git/config')]), /denied path segment/);
    assert.throws(() => validate([add('.gitattributes', '*.txt filter=evil\n')]), /private key|credential|denied/i);
    assert.throws(() => validate([add('.pi/ext.js')]), /denied path segment/);
    assert.throws(() => validate([add('.env')]), /environment files/);
    assert.throws(() => validate([add('src/secret.txt')]), /secret\/credential/);
    assert.throws(() => validate([add('src/key.pem')]), /private key/);
    assert.throws(() => validate([add('src//double.js')]), /empty path/);
    assert.throws(() => validate([add('src/CON.txt')]), /reserved device/);
    assert.throws(() => validate([add('other/file.txt')]), /outside the allowed scope/);
    assert.throws(() => validate([add('src/app.js')]), /already exists/);
    assert.throws(() => validate([modify('src/missing.js')]), /does not exist/);
    assert.throws(() => validate([modify('src/missing/x.js')]), /parent directory/);
    assert.throws(() => validate([modify('SRC/app.js')]), /case-alias|parent directory/);
    assert.throws(() => validate([add('src', 'x')]), /already exists|regular file/);
    assert.throws(() => validate([{ path: 'src/app.js', action: 'modify', content: 'old\n' }]), /no change/);
    assert.throws(() => validate([{ path: 'src/app.js', action: 'delete', content: 'x' }]), /action must be/);
    assert.throws(() => validate([add('src/binary.js', 'a\u0000b')]), /binary content/);
    assert.throws(() => validate([add('src/big.js', 'x'.repeat(PATCH_LIMITS.maxFileBytes + 1))]), /per-file size/);
    assert.throws(() => validate(Array.from({ length: 6 }, (_, i) => add(`src/f${i}.js`))), /1-5 files/);
    assert.throws(() => validate([]), /1-5 files/);
    assert.throws(() => normalizeAllowedEntries(['.git']), /denied path segment/);
    assert.throws(() => normalizeRelPath('src//app.js'), /empty path/);
    assert.equal(normalizeRelPath('src\\app.js').norm, 'src/app.js');
    assert.equal(normalizeAllowedEntries(['src\\'])[0].norm, 'src');

    // Hardlink to a file outside the worktree: modifying it would write through the link.
    linkSync(path.join(outside, 'target.txt'), path.join(root, 'src', 'hard.txt'));
    assert.throws(() => validate([modify('src/hard.txt')]), /hard-linked/);

    // Symlink to a file or directory outside the worktree.
    let symlinkAvailable = true;
    try {
      symlinkSync(path.join(outside, 'target.txt'), path.join(root, 'src', 'link.txt'), 'file');
    } catch {
      symlinkAvailable = false;
    }
    if (symlinkAvailable) {
      assert.throws(() => validate([modify('src/link.txt')]), /symbolic link/);
      mkdirSync(path.join(root, 'src', 'linkdir'));
      rmSync(path.join(root, 'src', 'linkdir'), { recursive: true, force: true });
      try {
        symlinkSync(outside, path.join(root, 'src', 'linkdir'), 'dir');
        assert.throws(() => validate([add('src/linkdir/new.txt')]), /symbolic link|parent path/);
      } catch {
        // Directory symlinks are unavailable on this host; file symlink coverage remains.
      }
    }

    // No attack wrote outside the worktree.
    assert.equal(readFileSync(path.join(outside, 'target.txt'), 'utf8'), 'outside\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[patch#5] an end-to-end malicious proposal fails the job and quarantines the workspace without creating a proposal', () => withEnv(async ({ store, repo, base, broker, clock }) => {
  const cases = [
    [{ path: '../escape.txt', action: 'add', content: 'x' }],
    [{ path: '.git/config', action: 'modify', content: 'x' }],
    [{ path: 'other/file.txt', action: 'add', content: 'x' }],
    [{ path: 'src/app.js', action: 'add', content: 'x' }]
  ];
  for (let i = 0; i < cases.length; i++) {
    const { job } = submitCode(store, clock, { base, key: `attack-${i}` });
    const agent = new FakePatchProposalAgent({ files: cases[i] });
    const run = await runWorker({ store, broker, clock, agent });
    assert.equal(run.outcome, 'failed');
    assert.equal(store.listPatchProposals({ projectId: 'proj-a' }).filter((p) => p.job_id === job.id).length, 0);
    const workspace = store.getWorkspaceForAttempt(job.id, 1);
    assert.equal(workspace.status, 'quarantined');
    assert.equal(readFileSync(path.join(repo, 'src', 'app.js'), 'utf8'), 'export const x = 1;\n');
  }
}));

test('[patch#6] reject does not apply; tampering after approval never writes; approval is one-shot', () => withEnv(async ({ store, repo, base, broker, clock }) => {
  const first = submitCode(store, clock, { base, key: 'reject-1' });
  const run1 = await runWorker({ store, broker, clock });
  const proposal1 = store.getPatchProposal(run1.proposalId);
  store.rejectPatchProposal(proposal1.id, { reason: 'not wanted' });
  await assert.rejects(() => broker.applyProposal(store.getWorkspaceForAttempt(first.job.id, 1),
    store.getPatchProposal(proposal1.id)), /cannot be applied/);
  assert.equal(store.getPatchProposal(proposal1.id).status, 'rejected');
  assert.equal(readFileSync(path.join(repo, 'src', 'app.js'), 'utf8'), 'export const x = 1;\n');

  const second = submitCode(store, clock, { base, key: 'tamper-1' });
  const run2 = await runWorker({ store, broker, clock });
  const proposal2 = store.getPatchProposal(run2.proposalId);
  store.approvePatchProposal(proposal2.id, { expectedHash: proposal2.proposal_hash });
  // Tamper with the private artifact after approval: the apply path must detect it.
  store.db.prepare(`UPDATE owner_patch_artifacts SET content=? WHERE proposal_id=? AND kind='proposal'`)
    .run(JSON.stringify({ base_sha: proposal2.base_sha, allowed_paths: proposal2.allowedPaths, files: [] }), proposal2.id);
  const tamperedApply = await broker.applyProposal(store.getWorkspaceForAttempt(second.job.id, 1),
    store.getPatchProposal(proposal2.id));
  assert.equal(tamperedApply.outcome, 'apply_failed');
  assert.match(tamperedApply.error, /artifact hash mismatch/);
  assert.equal(readFileSync(path.join(repo, 'src', 'app.js'), 'utf8'), 'export const x = 1;\n');
  assert.equal(store.getPatchProposal(proposal2.id).status, 'apply_failed');
  assert.equal(store.getWorkspaceForAttempt(second.job.id, 1).status, 'quarantined');
}));

test('[patch#7] interrupted apply recovery is fail-closed and owner-reconciled, never auto-retried', () => withEnv(async ({ store, repo, base, broker, clock }) => {
  const { job } = submitCode(store, clock, { base, key: 'crash-1' });
  const run = await runWorker({ store, broker, clock });
  const proposal = store.getPatchProposal(run.proposalId);
  store.approvePatchProposal(proposal.id, { expectedHash: proposal.proposal_hash });
  store.beginPatchApply(proposal.id);
  const recovered = store.recoverInterruptedPatchApplies();
  assert.deepEqual(recovered, [proposal.id]);
  assert.equal(store.getPatchProposal(proposal.id).status, 'needs_reconciliation');
  assert.equal(store.getWorkspaceForAttempt(job.id, 1).status, 'quarantined');
  const verify = await broker.verifyApplied(store.getWorkspaceForAttempt(job.id, 1), store.getPatchProposal(proposal.id));
  assert.equal(verify.ok, false);
  store.reconcilePatch(proposal.id, { decision: 'discard', reason: 'owner rejected evidence' });
  assert.equal(store.getPatchProposal(proposal.id).status, 'apply_failed');
  await assert.rejects(() => broker.applyProposal(store.getWorkspaceForAttempt(job.id, 1),
    store.getPatchProposal(proposal.id)), /cannot be applied|not active/);
  assert.equal(readFileSync(path.join(repo, 'src', 'app.js'), 'utf8'), 'export const x = 1;\n');
}));

test('[patch#8] a fully-written but uncommitted apply can be confirmed by the owner after crash', () => withEnv(async ({ store, base, broker, clock }) => {
  const { job } = submitCode(store, clock, { base, key: 'confirm-1' });
  const run = await runWorker({ store, broker, clock });
  const proposal = store.getPatchProposal(run.proposalId);
  store.approvePatchProposal(proposal.id, { expectedHash: proposal.proposal_hash });
  store.beginPatchApply(proposal.id);
  const artifact = JSON.parse(store.getPatchArtifactContent(proposal.id, 'proposal'));
  const workspace = store.getWorkspaceForAttempt(job.id, 1);
  for (const file of artifact.files) {
    writeFileSync(path.join(workspace.path, file.path), file.content, 'utf8');
  }
  const verify = await broker.verifyApplied(workspace, store.getPatchProposal(proposal.id));
  assert.equal(verify.ok, true);
  store.reconcilePatch(proposal.id, {
    decision: 'confirm-applied',
    reason: 'owner verified the worktree',
    diffContent: verify.diff
  });
  const after = store.getPatchProposal(proposal.id);
  assert.equal(after.status, 'applied');
  assert.ok(store.getPatchArtifactContent(proposal.id, 'applied_diff').startsWith('diff --git'));
}));

test('[patch#9] projects and attempts cannot cross-apply proposals or read another project material', () => withEnv(async ({ root, store, repo, base, broker, clock }) => {
  const { base: baseB } = makeRepo(root, 'repo-b');
  store.registerProject({ id: 'proj-b', name: 'Project B', root: path.join(root, 'repo-b'), primaryDomain: 'software-engineering' });
  writeFileSync(path.join(root, 'repo-b', 'src', 'app.js'), 'export const b = 1;\n');
  git(path.join(root, 'repo-b'), ['add', '.']);
  git(path.join(root, 'repo-b'), ['commit', '-qm', 'b init']);
  const baseB2 = gitOut(path.join(root, 'repo-b'), ['rev-parse', 'HEAD']);

  const a = submitCode(store, clock, { base, key: 'cross-a' });
  const agentA = new FakePatchProposalAgent({ files: happyFiles() });
  const runA = await runWorker({ store, broker, clock, agent: agentA });
  assert.equal(runA.outcome, 'succeeded');
  const proposalA = store.getPatchProposal(runA.proposalId);

  const taskB = store.createTask({ projectId: 'proj-b', title: 'B task' });
  const jobB = store.createJob({
    projectId: 'proj-b',
    jobType: 'code-patch',
    title: 'B patch',
    payload: { baseSha: baseB2, allowedPaths: 'src/' },
    idempotencyKey: 'cross-b',
    ownerTaskId: taskB.id
  });
  store.approveJob(jobB.id, { now: clock.now() });
  const agentB = new FakePatchProposalAgent({ files: [{ path: 'src/app.js', action: 'modify', content: 'export const b = 2;\n' }] });
  const runB = await runWorker({ store, broker, clock, projectId: 'proj-b', agent: agentB });
  assert.equal(runB.outcome, 'succeeded');
  const workspaceB = store.getWorkspaceForAttempt(jobB.id, 1);
  const proposalB = store.getPatchProposal(runB.proposalId);

  assert.ok(workspaceB.path.includes('proj-b'));
  assert.equal(workspaceB.project_id, 'proj-b');
  await assert.rejects(() => broker.applyProposal(workspaceB, proposalA), /does not belong/);
  await assert.rejects(() => broker.applyProposal(store.getWorkspaceForAttempt(a.job.id, 1), proposalB), /does not belong/);
  assert.equal(agentA.calls[0].material.some((m) => m.content.includes('export const b = 1')), false);
}));

test('[patch#10] cancel, lost lease and late model output never store a proposal and always quarantine evidence', () => withEnv(async ({ store, base, broker, clock }) => {
  // ---- cancel during generation ----
  const cancelJob = submitCode(store, clock, { base, key: 'cancel-1' });
  let releaseCancel;
  const cancelAgent = new FakePatchProposalAgent({
    onGenerate: () => new Promise((resolve) => { releaseCancel = resolve; })
  });
  const cancelTimers = manualTimers();
  const cancelRun = runWorker({
    store, broker, clock, agent: cancelAgent, timers: cancelTimers
  });
  await waitFor(() => cancelAgent.calls.length === 1, 'cancel agent called');
  store.requestCancelJob(cancelJob.job.id, { now: clock.now() });
  cancelTimers.fireByMs(10000);
  releaseCancel(happyFiles());
  const cancelled = await cancelRun;
  assert.equal(cancelled.outcome, 'cancelled');
  assert.equal(store.listPatchProposals({ projectId: 'proj-a' }).filter((p) => p.job_id === cancelJob.job.id).length, 0);
  assert.equal(store.getWorkspaceForAttempt(cancelJob.job.id, 1).status, 'quarantined');
  assert.equal(cancelTimers.handles.size, 0);

  // ---- lease lost while the model is still working ----
  const fenceJob = submitCode(store, clock, { base, key: 'fence-1' });
  let releaseFence;
  const fenceAgent = new FakePatchProposalAgent({
    onGenerate: () => new Promise((resolve) => { releaseFence = resolve; })
  });
  const fenceTimers = manualTimers();
  const fenceRun = runWorker({
    store, broker, clock, agent: fenceAgent, timers: fenceTimers
  });
  await waitFor(() => fenceAgent.calls.length === 1, 'fence agent called');
  clock.advanceMs(30001);
  fenceTimers.fireByMs(10000);
  releaseFence(happyFiles());
  const fenced = await fenceRun;
  assert.equal(fenced.outcome, 'fenced');
  assert.equal(store.listPatchProposals({ projectId: 'proj-a' }).filter((p) => p.job_id === fenceJob.job.id).length, 0);
  assert.equal(store.getWorkspaceForAttempt(fenceJob.job.id, 1).status, 'quarantined');
  assert.equal(fenceTimers.handles.size, 0);
  store.reconcileExpiredLeases({ now: clock.now() });
  assert.equal(store.getJob(fenceJob.job.id).status, 'needs_reconciliation');
  store.reconcileJob(fenceJob.job.id, { decision: 'fail', reason: 'test cleanup' });

  // ---- timeout with an unconfirmed stop ----
  const timeoutJob = submitCode(store, clock, { base, key: 'timeout-1' });
  const hangAgent = new FakePatchProposalAgent({ onGenerate: () => new Promise(() => {}) });
  const timeoutTimers = manualTimers();
  const timeoutRun = runWorker({
    store, broker, clock, agent: hangAgent, timers: timeoutTimers, timeoutMs: 120000
  });
  await waitFor(() => hangAgent.calls.length === 1, 'hang agent called');
  timeoutTimers.fireByMs(120000);
  await waitFor(() => [...timeoutTimers.handles.values()].some((handle) => handle.ms === 5000),
    'bounded stop-confirm timer');
  timeoutTimers.fireByMs(5000);
  const timedOut = await timeoutRun;
  assert.equal(timedOut.outcome, 'fenced');
  assert.equal(timedOut.unconfirmedStop, true);
  assert.equal(store.listPatchProposals({ projectId: 'proj-a' }).filter((p) => p.job_id === timeoutJob.job.id).length, 0);
  assert.equal(store.getWorkspaceForAttempt(timeoutJob.job.id, 1).status, 'quarantined');
  assert.equal(timeoutTimers.handles.size, 0);
}));

test('[patch#11] workspace ids are sanitized and cleanup refuses an un-reconciled proposal or a tampered path', () => withEnv(async ({ root, store, base, broker, clock }) => {
  assert.throws(() => WorkspaceBroker.sanitizeIds({ projectId: '../escape', jobId: 'j', attempt: 1 }), /invalid project id/);
  assert.throws(() => WorkspaceBroker.sanitizeIds({ projectId: 'p', jobId: '..', attempt: 1 }), /invalid job id/);
  assert.throws(() => WorkspaceBroker.sanitizeIds({ projectId: 'p', jobId: 'j', attempt: 0 }), /invalid attempt/);
  const expected = broker.workspacePath('proj-a', 'job-1', 1);
  assert.ok(expected.toLowerCase().startsWith(path.join(root, 'workspaces').toLowerCase()));

  const { job } = submitCode(store, clock, { base, key: 'cleanup-1' });
  const run = await runWorker({ store, broker, clock });
  const workspace = store.getWorkspaceForAttempt(job.id, 1);
  assert.equal(workspace.status, 'active');
  await assert.rejects(() => broker.cleanup(workspace.id, { confirm: true }), /must be reconciled/);
  store.rejectPatchProposal(run.proposalId, { reason: 'cleanup test' });
  const cleaned = await broker.cleanup(workspace.id, { confirm: true });
  assert.equal(cleaned.status, 'cleaned');

  // A DB row whose path does not match its ids is refused before any filesystem action.
  const tamperedJob = submitCode(store, clock, { base, key: 'cleanup-tamper' });
  const tamperedRun = await runWorker({ store, broker, clock });
  assert.equal(tamperedRun.outcome, 'succeeded');
  store.rejectPatchProposal(tamperedRun.proposalId, { reason: 'tamper path test' });
  const tampered = store.getWorkspaceForAttempt(tamperedJob.job.id, 1);
  store.db.prepare('UPDATE owner_workspaces SET path=? WHERE id=?')
    .run(path.join(root, 'not-the-workspaces-root'), tampered.id);
  await assert.rejects(() => broker.cleanup(tampered.id, { confirm: true }), /does not match its ids/);
}));

test('[patch#12] proposal parser and real-Pi smoke are opt-in and fail closed', () => {
  const parsed = parseProposalText('prefix\n```json\n{"files":[{"path":"src/a.js","action":"modify","content":"x"}]}\n```\nsuffix');
  assert.equal(parsed.files.length, 1);
  assert.throws(() => parseProposalText('not json'), /no JSON object/);
  assert.throws(() => parseProposalText('{"files":[]}'), /non-empty/);
  assert.throws(() => parseProposalText('{"files":[{"path":"a","action":"add"}]}'), /path\/action\/content/);
});

test('[patch#13] material broker reuses parent-chain/link checks and fails closed on explicit paths', () => withEnv(async ({ root, repo, broker }) => {
  const outside = path.join(root, 'outside-material');
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, 'private.txt'), 'TOP SECRET\n');
  mkdirSync(path.join(repo, 'docs'), { recursive: true });
  const linked = makeDirLink(outside, path.join(repo, 'docs', 'link'));
  if (linked) {
    assert.throws(
      () => broker.readMaterial({ path: repo }, [{ norm: 'docs/link/private.txt', lower: 'docs/link/private.txt' }]),
      /symbolic link|non-directory|escapes/
    );
  }

  linkSync(path.join(outside, 'private.txt'), path.join(repo, 'docs', 'hard.txt'));
  assert.throws(
    () => broker.readMaterial({ path: repo }, [{ norm: 'docs/hard.txt', lower: 'docs/hard.txt' }]),
    /hard-linked/
  );

  writeFileSync(path.join(repo, 'docs', 'bad.txt'), Buffer.from([0xff, 0xfe, 0x00]));
  assert.throws(
    () => broker.readMaterial({ path: repo }, [{ norm: 'docs/bad.txt', lower: 'docs/bad.txt' }]),
    /binary|UTF-8/
  );
}));

test('[patch#14] cancel with a never-settling prompt is never confirmed and stays fenced', () => withEnv(async ({ store, base, broker, clock }) => {
  const { job } = submitCode(store, clock, { base, key: 'cancel-unconfirmed' });
  const agent = new FakePatchProposalAgent({ onGenerate: () => new Promise(() => {}) });
  const timers = manualTimers();
  const run = runWorker({ store, broker, clock, agent, timers, abortConfirmMs: 5000 });
  await waitFor(() => agent.calls.length === 1, 'unconfirmed cancel agent called');
  store.requestCancelJob(job.id, { now: clock.now() });
  timers.fireByMs(10000);
  await waitFor(() => [...timers.handles.values()].some((handle) => handle.ms === 5000),
    'unconfirmed cancel stop timer');
  timers.fireByMs(5000);
  const result = await run;
  assert.equal(result.outcome, 'fenced');
  assert.equal(result.unconfirmedStop, true);
  assert.equal(store.getJob(job.id).status, 'cancel_requested');
  assert.equal(store.listPatchProposals({ projectId: 'proj-a' }).filter((p) => p.job_id === job.id).length, 0);
  assert.equal(store.getWorkspaceForAttempt(job.id, 1).status, 'quarantined');
  assert.equal(timers.handles.size, 0);
}));

test('[patch#15] Git filter attributes are refused before checkout and never execute', () => withEnv(async ({ root, repo, base, store, broker, clock }) => {
  writeFileSync(path.join(repo, '.gitattributes'), '*.txt filter=evil\n');
  writeFileSync(path.join(repo, 'src', 'app.txt'), 'filtered\n');
  git(repo, ['add', '.gitattributes', 'src/app.txt']);
  git(repo, ['commit', '-qm', 'add filter attributes']);
  const marker = path.join(root, 'smudge-marker.txt');
  const script = path.join(root, 'smudge.mjs');
  writeFileSync(script, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ran');`);
  const command = `"${process.execPath}" "${script}"`;
  git(repo, ['config', 'filter.evil.smudge', command]);
  git(repo, ['config', 'filter.evil.clean', command]);
  const head = gitOut(repo, ['rev-parse', 'HEAD']);
  const { job } = submitCode(store, clock, { base: head, key: 'filter-1' });
  const result = await runWorker({ store, broker, clock });
  assert.equal(result.outcome, 'failed');
  assert.equal(store.getWorkspaceForAttempt(job.id, 1), null);
  assert.equal(existsSync(marker), false, 'the malicious smudge command must not run');
}));

test('[patch#16] a symlink under the workspaces root is refused before any write', () => withEnv(async ({ root, repo, base, store, broker, clock }) => {
  const workspacesRoot = path.join(root, 'workspaces');
  mkdirSync(workspacesRoot, { recursive: true });
  const outside = path.join(root, 'outside-workspaces');
  mkdirSync(outside, { recursive: true });
  if (!makeDirLink(outside, path.join(workspacesRoot, 'proj-a'))) return;
  const { job } = submitCode(store, clock, { base, key: 'parent-link-1' });
  const result = await runWorker({ store, broker, clock });
  assert.equal(result.outcome, 'failed');
  assert.equal(store.listWorkspaces().length, 0);
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(readFileSync(path.join(repo, 'src', 'app.js'), 'utf8'), 'export const x = 1;\n');
}));

test('[patch#17] an unresolved patch apply fences the whole project until Owner reconciliation', () => withEnv(async ({ root, store, base, broker, clock }) => {
  const { job } = submitCode(store, clock, { base, key: 'fence-patch-1' });
  const run = await runWorker({ store, broker, clock });
  const proposal = store.getPatchProposal(run.proposalId);
  store.approvePatchProposal(proposal.id, { expectedHash: proposal.proposal_hash });
  store.beginPatchApply(proposal.id);

  const pendingTask = store.createTask({ projectId: 'proj-a', title: 'blocked by unresolved patch' });
  const pendingJob = store.createJob({
    projectId: 'proj-a',
    jobType: 'code-patch',
    title: 'blocked patch',
    payload: { baseSha: base, allowedPaths: 'src/' },
    idempotencyKey: 'fence-patch-2',
    ownerTaskId: pendingTask.id
  });
  assert.throws(() => store.approveJob(pendingJob.id), /unresolved patch proposal/);
  assert.deepEqual(
    store.claimNextJob('proj-a', 'fence-test-worker', { now: clock.now() }),
    { claimed: false, reason: 'project-patch-quarantined', quarantinedProposalId: proposal.id }
  );

  // A different project is unaffected.
  const otherRepo = makeRepo(root, 'repo-other');
  store.registerProject({ id: 'proj-other', name: 'Other', root: otherRepo.repo, primaryDomain: 'software-engineering' });
  const otherTask = store.createTask({ projectId: 'proj-other', title: 'other' });
  const otherJob = store.createJob({
    projectId: 'proj-other',
    jobType: 'code-patch',
    title: 'other patch',
    payload: { baseSha: otherRepo.base, allowedPaths: 'src/' },
    idempotencyKey: 'fence-other-1',
    ownerTaskId: otherTask.id
  });
  assert.equal(store.approveJob(otherJob.id, { now: clock.now() }).status, 'queued');

  store.reconcilePatch(proposal.id, { decision: 'discard', reason: 'fence test' });
  assert.equal(store.approveJob(pendingJob.id, { now: clock.now() }).status, 'queued');
  assert.equal(store.getWorkspaceForAttempt(job.id, 1).status, 'quarantined');
}));

test('[patch#18] cleanup refuses a replaced ordinary directory and preserves its data', () => withEnv(async ({ store, base, broker, clock }) => {
  const { job } = submitCode(store, clock, { base, key: 'cleanup-replaced-1' });
  const run = await runWorker({ store, broker, clock });
  store.rejectPatchProposal(run.proposalId, { reason: 'cleanup replacement test' });
  const workspace = store.getWorkspaceForAttempt(job.id, 1);
  rmSync(workspace.path, { recursive: true, force: true });
  mkdirSync(workspace.path, { recursive: true });
  const sentinel = path.join(workspace.path, 'user-data.txt');
  writeFileSync(sentinel, 'do not delete\n');
  await assert.rejects(() => broker.cleanup(workspace.id, { confirm: true }),
    /not a registered git worktree|linked git worktree|unexpected .git/);
  assert.equal(readFileSync(sentinel, 'utf8'), 'do not delete\n');
  assert.equal(store.getWorkspace(workspace.id).status, 'active');
}));

test('[patch#19] a crash after approval can resume via the explicit hash-bound apply path', () => withEnv(async ({ store, base, broker, clock }) => {
  const { job } = submitCode(store, clock, { base, key: 'resume-approved-1' });
  const run = await runWorker({ store, broker, clock });
  const proposal = store.getPatchProposal(run.proposalId);
  // Simulate the crash window: approval persisted, apply never started.
  store.approvePatchProposal(proposal.id, { expectedHash: proposal.proposal_hash });
  assert.equal(store.getPatchProposal(proposal.id).status, 'approved');
  assert.throws(() => store.assertPatchApplyAllowed(proposal.id, { expectedHash: '0'.repeat(64) }),
    /does not match/);
  const resume = store.assertPatchApplyAllowed(proposal.id, { expectedHash: proposal.proposal_hash });
  assert.equal(resume.alreadyApplied, false);
  const applied = await broker.applyProposal(store.getWorkspaceForAttempt(job.id, 1), resume.proposal);
  assert.equal(applied.outcome, 'applied');
  assert.equal(store.assertPatchApplyAllowed(proposal.id, { expectedHash: proposal.proposal_hash }).alreadyApplied, true);
}));

test('[patch#20] unknown provider error categories never enter the durable job note', () => withEnv(async ({ store, base, broker, clock }) => {
  const { job } = submitCode(store, clock, { base, key: 'error-category-1' });
  const agent = new FakePatchProposalAgent({
    onGenerate: async () => {
      const error = new Error('provider endpoint and secret material');
      error.category = 'provider-secret-category';
      throw error;
    }
  });
  const result = await runWorker({ store, broker, clock, agent });
  assert.equal(result.outcome, 'failed');
  const note = store.getJob(job.id).attempts[0].result_note;
  assert.match(note, /worker-error/);
  assert.equal(note.includes('provider-secret-category'), false);
  assert.equal(note.includes('endpoint and secret'), false);
}));

test('[patch#21] a late unconfirmed-stop after cancel wins still stays fenced', () => withEnv(async ({ store, base, broker, clock }) => {
  const { job } = submitCode(store, clock, { base, key: 'late-unconfirmed-1' });
  let rejectGeneration;
  const agent = new FakePatchProposalAgent({
    onGenerate: () => new Promise((_resolve, reject) => { rejectGeneration = reject; })
  });
  const timers = manualTimers();
  const run = runWorker({ store, broker, clock, agent, timers, abortConfirmMs: 5000 });
  await waitFor(() => agent.calls.length === 1, 'late-unconfirmed agent called');
  store.requestCancelJob(job.id, { now: clock.now() });
  timers.fireByMs(10000);
  await waitFor(() => [...timers.handles.values()].some((handle) => handle.ms === 5000),
    'late-unconfirmed stop timer');
  rejectGeneration(Object.assign(new Error('inner session stop did not confirm'), { category: 'unconfirmed-stop' }));
  const result = await run;
  assert.equal(result.outcome, 'fenced');
  assert.equal(result.unconfirmedStop, true);
  assert.equal(store.getJob(job.id).status, 'cancel_requested');
  assert.equal(store.listPatchProposals({ projectId: 'proj-a' }).filter((p) => p.job_id === job.id).length, 0);
  assert.equal(store.getWorkspaceForAttempt(job.id, 1).status, 'quarantined');
  assert.equal(timers.handles.size, 0);
}));

test('[patch#22] filter attributes matching only a NEW proposal path are refused before checkout', () => withEnv(async ({ root, repo, base, store, broker, clock }) => {
  // Tracked .gitattributes matches *.txt, but the repo contains no tracked .txt yet.
  writeFileSync(path.join(repo, '.gitattributes'), '*.txt filter=evil\n');
  git(repo, ['add', '.gitattributes']);
  git(repo, ['commit', '-qm', 'filter pattern only']);
  const marker = path.join(root, 'new-path-smudge-marker.txt');
  const script = path.join(root, 'new-path-smudge.mjs');
  writeFileSync(script, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ran');`);
  const command = `"${process.execPath}" "${script}"`;
  git(repo, ['config', 'filter.evil.smudge', command]);
  git(repo, ['config', 'filter.evil.clean', command]);
  const head = gitOut(repo, ['rev-parse', 'HEAD']);
  mkdirSync(path.join(repo, 'docs'), { recursive: true });
  writeFileSync(path.join(repo, 'docs', '.keep'), '');
  git(repo, ['add', 'docs/.keep']);
  git(repo, ['commit', '-qm', 'docs dir']);
  const currentBase = gitOut(repo, ['rev-parse', 'HEAD']);
  const { job } = submitCode(store, clock, { base: currentBase, key: 'new-path-filter-1', allowedPaths: 'docs/' });
  const agent = new FakePatchProposalAgent({
    files: [{ path: 'docs/new.txt', action: 'add', content: 'new filtered path\n' }]
  });
  const result = await runWorker({ store, broker, clock, agent });
  assert.equal(result.outcome, 'failed');
  assert.equal(store.getWorkspaceForAttempt(job.id, 1), null);
  assert.equal(existsSync(marker), false, 'new-path smudge/clean must not run');
  assert.equal(head === currentBase, false);
}));

test('[patch#23] a filter added to the worktree after proposal is caught at apply precheck', () => withEnv(async ({ root, repo, base, store, broker, clock }) => {
  mkdirSync(path.join(repo, 'docs'), { recursive: true });
  writeFileSync(path.join(repo, 'docs', '.keep'), '');
  git(repo, ['add', 'docs/.keep']);
  git(repo, ['commit', '-qm', 'docs dir']);
  const currentBase = gitOut(repo, ['rev-parse', 'HEAD']);
  const { job } = submitCode(store, clock, { base: currentBase, key: 'apply-filter-1', allowedPaths: 'docs/' });
  const agent = new FakePatchProposalAgent({
    files: [{ path: 'docs/new.txt', action: 'add', content: 'new filtered path\n' }]
  });
  const run = await runWorker({ store, broker, clock, agent });
  assert.equal(run.outcome, 'succeeded');
  const proposal = store.getPatchProposal(run.proposalId);
  store.approvePatchProposal(proposal.id, { expectedHash: proposal.proposal_hash });
  const workspace = store.getWorkspaceForAttempt(job.id, 1);
  const marker = path.join(root, 'apply-smudge-marker.txt');
  const script = path.join(root, 'apply-smudge.mjs');
  writeFileSync(script, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ran');`);
  const command = `"${process.execPath}" "${script}"`;
  git(repo, ['config', 'filter.evil.smudge', command]);
  git(repo, ['config', 'filter.evil.clean', command]);
  writeFileSync(path.join(workspace.path, '.gitattributes'), '*.txt filter=evil\n');
  const applied = await broker.applyProposal(workspace, store.getPatchProposal(proposal.id));
  assert.equal(applied.outcome, 'apply_failed');
  assert.equal(existsSync(marker), false, 'apply/verify must not execute the worktree filter');
  assert.equal(store.getPatchProposal(proposal.id).status, 'apply_failed');
  assert.equal(store.getWorkspaceForAttempt(job.id, 1).status, 'quarantined');
}));

test('[patch#24] an ignored .gitattributes injected into the worktree is caught before apply', () => withEnv(async ({ root, repo, store, broker, clock }) => {
  mkdirSync(path.join(repo, 'docs'), { recursive: true });
  writeFileSync(path.join(repo, 'docs', '.keep'), '');
  writeFileSync(path.join(repo, '.gitignore'), 'docs/.gitattributes\n');
  git(repo, ['add', '.gitignore', 'docs/.keep']);
  git(repo, ['commit', '-qm', 'ignored attributes fixture']);
  const base = gitOut(repo, ['rev-parse', 'HEAD']);
  const { job } = submitCode(store, clock, { base, key: 'ignored-attrs-1', allowedPaths: 'docs/' });
  const agent = new FakePatchProposalAgent({
    files: [{ path: 'docs/new.txt', action: 'add', content: 'new filtered path\n' }]
  });
  const run = await runWorker({ store, broker, clock, agent });
  assert.equal(run.outcome, 'succeeded');
  const proposal = store.getPatchProposal(run.proposalId);
  store.approvePatchProposal(proposal.id, { expectedHash: proposal.proposal_hash });
  const workspace = store.getWorkspaceForAttempt(job.id, 1);

  const marker = path.join(root, 'ignored-attrs-marker.txt');
  const script = path.join(root, 'ignored-attrs-smudge.mjs');
  writeFileSync(script, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ran');`);
  const command = `"${process.execPath}" "${script}"`;
  git(repo, ['config', 'filter.evil.smudge', command]);
  git(repo, ['config', 'filter.evil.clean', command]);
  writeFileSync(path.join(workspace.path, 'docs', '.gitattributes'), '*.txt filter=evil\n');

  const applied = await broker.applyProposal(workspace, store.getPatchProposal(proposal.id));
  assert.equal(applied.outcome, 'apply_failed');
  assert.equal(existsSync(marker), false, 'ignored .gitattributes must not trigger clean/smudge');
  assert.equal(store.getPatchProposal(proposal.id).status, 'apply_failed');
  assert.equal(store.getWorkspaceForAttempt(job.id, 1).status, 'quarantined');
}));

test('[patch-real] optional real Pi smoke (OWNER_AGENT_REAL_PATCH_TEST=1)', {
  skip: process.env.OWNER_AGENT_REAL_PATCH_TEST !== '1'
}, () => withEnv(async ({ store, base, broker, clock }) => {
  const { job } = submitCode(store, clock, { base, key: 'real-1' });
  const worker = new PatchCodingWorker(store, {
    broker,
    workerId: 'real-pi-patch',
    clock: clock.now,
    proposalAgent: new PatchProposalAgent(),
    timeoutMs: 180000
  });
  const run = await worker.runOnce({ projectId: 'proj-a', allowModel: true });
  assert.equal(run.outcome, 'succeeded');
  const proposal = store.getPatchProposal(run.proposalId);
  assert.ok(proposal);
  assert.equal(store.getJob(job.id).status, 'succeeded');
}));
