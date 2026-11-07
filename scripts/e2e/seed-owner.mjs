// v1.1 E2E 数据准备：造出 Job → Patch → Sandbox(fail) → Repair(pending) 的真实链路。
//
// 只用产品 API，不修改业务状态机：
// - FakePatchProposalAgent 生成补丁（无模型调用）
// - 真实 Docker 沙箱执行失败测试
// - 真实 repair-service 冻结修复周期
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { OwnerStore } from '../../src/owner-store.mjs';
import { WorkspaceBroker } from '../../src/workspace-broker.mjs';
import { PatchCodingWorker } from '../../src/patch-coding-worker.mjs';
import { FakePatchProposalAgent } from '../../src/patch-proposal-agent.mjs';
import { DockerSandboxProvider } from '../../src/sandbox-provider.mjs';
import { SandboxRunner } from '../../src/sandbox-runner.mjs';
import { approveSandboxRun, submitSandboxRun } from '../../src/sandbox-service.mjs';
import { submitRepairCycle } from '../../src/repair-service.mjs';

const BUGGY = `export function withRetry(fn, { attempts = 3 } = {}) {
  let lastError;
  // 真实 bug：off-by-one，只尝试 attempts - 1 次。
  for (let i = 0; i < attempts - 1; i += 1) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
`;

const FIXED = `export function withRetry(fn, { attempts = 3 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
`;

const TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../src/retry.js';

test('withRetry uses all attempts', () => {
  let calls = 0;
  const result = withRetry(() => {
    calls += 1;
    if (calls < 3) throw new Error('flaky');
    return 'ok';
  }, { attempts: 3 });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});
`;

const PACKAGE = JSON.stringify({
  name: 'owner-loop-fixture',
  private: true,
  type: 'module'
}, null, 2) + '\n';

const git = (cwd, args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
}).trim();

const makeFixture = (root) => {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), PACKAGE, 'utf8');
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.owner-root-identity\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'retry.js'), BUGGY, 'utf8');
  fs.writeFileSync(path.join(root, 'tests', 'sandbox-smoke.test.mjs'), TEST, 'utf8');
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'user.email', 'e2e@example.invalid']);
  git(root, ['config', 'user.name', 'E2E Fixture']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'e2e base: buggy retry + failing test']);
  return git(root, ['rev-parse', 'HEAD']);
};

const imageDigest = () => {
  const ref = execFileSync('docker', [
    'image', 'inspect', 'node:22-alpine', '--format', '{{index .RepoDigests 0}}'
  ], { encoding: 'utf8' }).trim();
  const digest = ref.split('@')[1];
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest ?? '')) {
    throw new Error(`could not resolve node:22-alpine digest from ${ref}`);
  }
  return digest;
};

const run = async () => {
  const dbPath = process.env.OWNER_AGENT_DB;
  if (!dbPath) throw new Error('OWNER_AGENT_DB is required');
  const root = process.env.OWNER_E2E_ROOT
    ?? path.join(path.dirname(dbPath), 'loop');
  fs.mkdirSync(root, { recursive: true });

  const store = new OwnerStore(dbPath);
  try {
    const projectId = 'loop';
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    const baseSha = fs.existsSync(path.join(repo, '.git')) && git(repo, ['rev-parse', 'HEAD'])
      ? git(repo, ['rev-parse', 'HEAD'])
      : makeFixture(repo);
    if (!store.getProject(projectId)) {
      store.registerProject({
        id: projectId,
        name: 'Loop Fixture',
        root: repo,
        primaryDomain: 'software-engineering'
      });
    }

    const existing = store.listRepairCycles({ projectId, limit: 5 });
    if (existing.length > 0) {
      console.log(JSON.stringify({ reused: true, cycle: existing[0] }, null, 2));
      return;
    }

    // 独立的 ops 项目：给 UI 审批普通 Job，避免占用 loop 项目的活跃 Job 名额。
    const opsRepo = path.join(root, 'ops-repo');
    fs.mkdirSync(opsRepo, { recursive: true });
    if (!store.getProject('ops')) {
      store.registerProject({ id: 'ops', name: 'Ops Queue', root: opsRepo });
    }
    const opsTask = store.createTask({ projectId: 'ops', title: 'Review queue' });
    store.createJob({
      projectId: 'ops',
      jobType: 'status-note',
      title: 'Review the repair cycle',
      payload: {},
      idempotencyKey: 'ops-seed-review-job',
      ownerTaskId: opsTask.id
    });

    const task = store.createTask({ projectId, title: 'Fix the failing retry test' });
    const job = store.createJob({
      projectId,
      jobType: 'code-patch',
      title: 'Fix retry off-by-one',
      payload: { baseSha, allowedPaths: 'src/' },
      idempotencyKey: 'loop-seed-job-1',
      ownerTaskId: task.id
    });
    store.approveJob(job.id);

    const broker = new WorkspaceBroker(store, {
      workspacesRoot: path.join(root, 'workspaces')
    });
    const patchWorker = new PatchCodingWorker(store, {
      broker,
      workerId: 'e2e-seed',
      // 源补丁只加注释，保留 bug —— 这样沙箱会真实失败，才能产生修复周期。
      proposalAgent: new FakePatchProposalAgent({
        files: [{
          path: 'src/retry.js',
          action: 'modify',
          content: `${BUGGY}\n// touched by e2e source patch\n`
        }]
      }),
      timeoutMs: 60000
    });
    const patchRun = await patchWorker.runOnce({ projectId });
    if (patchRun.outcome !== 'succeeded') throw new Error(`patch proposal failed: ${patchRun.outcome}`);

    const proposal = store.getPatchProposal(patchRun.proposalId);
    store.approvePatchProposal(proposal.id, { expectedHash: proposal.proposal_hash });
    const workspace = store.getWorkspaceForAttempt(job.id, 1);
    await broker.applyProposal(workspace, store.getPatchProposal(proposal.id));

    const sandbox = await submitSandboxRun(store, broker, {
      proposalId: proposal.id,
      profileId: 'node-smoke',
      includePaths: ['package.json', 'tests/sandbox-smoke.test.mjs'],
      imageDigest: imageDigest(),
      sandboxRoot: path.join(root, 'sandbox')
    });
    approveSandboxRun(store, {
      runId: sandbox.id,
      hash: sandbox.approval_hash,
      actor: 'e2e-seed'
    });
    const runner = new SandboxRunner(store, {
      provider: new DockerSandboxProvider({ requireRootless: false }),
      workerId: 'e2e-seed-sandbox',
      pollMs: 250,
      leaseMs: 120000
    });
    await runner.runOnce({ projectId });
    const source = store.getSandboxRun(sandbox.id);
    if (source.test_status !== 'fail') {
      throw new Error(`expected a failing source run, got ${source.status}/${source.test_status}`);
    }

    const cycle = submitRepairCycle(store, {
      sandboxRunId: sandbox.id,
      scope: ['src/'],
      idempotencyKey: 'loop-seed-repair-1'
    });

    console.log(JSON.stringify({
      projectId,
      taskId: task.id,
      jobId: job.id,
      proposalId: proposal.id,
      proposalHash: proposal.proposal_hash,
      sandboxRunId: sandbox.id,
      sourceStatus: `${source.status}/${source.execution_status}/${source.test_status}`,
      cycleId: cycle.id,
      cycleStatus: cycle.status,
      approvalHash: cycle.approval_hash
    }, null, 2));
  } finally {
    store.close();
  }
};

run().catch((error) => {
  console.error(`[seed] FAIL: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
