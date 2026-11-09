// v1.1 真实项目端到端验收驱动（#14）。
//
// 分级：
//   --level 1  确定性提案（Fake 模型）+ 真实 Docker，验证 repair 状态链
//   --level 2  真实 Pi 提案 + Fake provider，验证模型输出能通过协议/scope/哈希校验
//   --level 3  真实 Pi 修复 + 真实 Docker，验证真实容器里 fail -> pass（核心闸门）
//
// 关键不变量：bug 与失败测试提交在 base；repair scope 只含 src/；复测快照中的测试
// 文件 sha256 必须等于 base 版本，防止用"改弱测试"换取 tested_pass。
//
// 本脚本只调用产品 API，不修改 src/；默认在临时目录运行，结束即清理。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { OwnerStore } from '../../src/owner-store.mjs';
import { WorkspaceBroker } from '../../src/workspace-broker.mjs';
import { PatchCodingWorker } from '../../src/patch-coding-worker.mjs';
import { FakePatchProposalAgent } from '../../src/patch-proposal-agent.mjs';
import { DockerSandboxProvider, FakeSandboxProvider } from '../../src/sandbox-provider.mjs';
import { SandboxRunner } from '../../src/sandbox-runner.mjs';
import { createInputSnapshot, cleanupInputSnapshot } from '../../src/sandbox-materializer.mjs';
import { approvalHash, resolveTestProfile } from '../../src/sandbox-protocol.mjs';
import { submitRepairCycle, approveRepairCycle } from '../../src/repair-service.mjs';
import { sha256 } from '../../src/utils.mjs';
import {
  FIXTURE_TEST_PATH,
  fixedRetryFiles,
  makeAcceptanceFixture,
  sourcePatchFiles
} from './make-fixture.mjs';

const args = process.argv.slice(2);
const read = (flag, fallback = '') => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1];
};

const level = Number(read('--level', '3'));
const model = read('--model', '');
const timeoutMs = Math.max(15000, Number(read('--timeout', '180000')) || 180000);
const outPath = read('--out', '');
const keep = read('--keep', '') === '1' || args.includes('--keep');
const rootArg = read('--root', '');
let imageDigest = read('--image-digest', process.env.OWNER_AGENT_SANDBOX_IMAGE_DIGEST || '');

if (![1, 2, 3].includes(level)) {
  console.error('--level must be 1, 2 or 3');
  process.exit(1);
}

// 验收包含的非代码文件也必须进快照：package.json 决定 .js 的 ESM 解析。
const INCLUDE_PATHS = ['package.json', FIXTURE_TEST_PATH];

let failures = 0;
const expect = (label, actual, expected) => {
  const ok = actual === expected;
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${label} (actual=${JSON.stringify(actual)}${ok ? '' : `, expected=${JSON.stringify(expected)}`})`);
  if (!ok) failures += 1;
};
const expectOk = (label, condition, detail = '') => {
  const ok = Boolean(condition);
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
};

const resolveDockerDigest = () => {
  if (imageDigest) return imageDigest;
  const repoDigest = execFileSync('docker', [
    'image', 'inspect', 'node:22-alpine', '--format', '{{index .RepoDigests 0}}'
  ], { encoding: 'utf8' }).trim();
  const digest = repoDigest.split('@')[1];
  if (!/^sha256:[0-9a-f]{64}$/.test(digest || '')) {
    throw new Error(`could not resolve a sha256 digest from ${repoDigest}`);
  }
  return digest;
};

const makeWritable = (target) => {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    try { fs.chmodSync(target, 0o755); } catch { /* best effort */ }
    for (const entry of fs.readdirSync(target)) makeWritable(path.join(target, entry));
  } else if (stat.isFile()) {
    try { fs.chmodSync(target, 0o644); } catch { /* best effort */ }
  }
};

// Fake provider 只在 L2 使用：模拟源 run 失败、修复 run 通过。
const fakeProvider = (exitCode, marker) => {
  const provider = new FakeSandboxProvider();
  const start = provider.start.bind(provider);
  provider.start = async (handle) => {
    const result = await start(handle);
    provider.complete(handle, {
      exitCode,
      stdout: exitCode === 0 ? `ok 1 - ${marker}\n` : `not ok 1 - ${marker}\n`,
      stderr: ''
    });
    return result;
  };
  return provider;
};

const describeFailure = (store, jobId, cycleId) => {
  const job = store.getJob(jobId);
  const attempt = job?.attempts?.[job.attempts.length - 1];
  const cycle = cycleId ? store.getRepairCycle(cycleId) : null;
  return JSON.stringify({
    jobStatus: job?.status ?? null,
    attemptStatus: attempt?.status ?? null,
    note: attempt?.result_note ?? null,
    cycleStatus: cycle?.status ?? null
  });
};

async function runOnce({ round }) {
  const startedAt = new Date().toISOString();
  const root = rootArg ? path.resolve(rootArg) : fs.mkdtempSync(path.join(os.tmpdir(), `owner-accept-l${level}-`));
  fs.mkdirSync(root, { recursive: true });
  const repo = path.join(root, 'repo');
  const fixture = makeAcceptanceFixture({ root: repo });
  const store = new OwnerStore(path.join(root, 'owner.sqlite'));
  const broker = new WorkspaceBroker(store, { workspacesRoot: path.join(root, 'workspaces') });
  const sandboxRoot = path.join(root, 'sandbox');
  const evidence = {
    level,
    round,
    model: model || 'sdk-default',
    imageDigest,
    profileId: 'node-smoke',
    fixtureBase: fixture.base,
    fixtureTestPath: FIXTURE_TEST_PATH,
    fixtureTestSha256: fixture.testSha256,
    startedAt
  };

  try {
    store.registerProject({
      id: 'acceptance',
      name: 'Acceptance Fixture',
      root: fixture.repo,
      primaryDomain: 'software-engineering'
    });
    const task = store.createTask({
      projectId: 'acceptance',
      title: 'Fix the failing retry acceptance test',
      note: 'The committed sandbox test fails against the base implementation.'
    });

    // ---- 1. 源补丁：确定性，只加注释，不修 bug、不碰测试 ----
    const sourceJob = store.createJob({
      projectId: 'acceptance',
      jobType: 'code-patch',
      title: 'Acceptance source patch (deterministic)',
      payload: { baseSha: fixture.base, allowedPaths: 'src/' },
      idempotencyKey: `accept-l${level}-r${round}-source`,
      ownerTaskId: task.id
    });
    store.approveJob(sourceJob.id);
    const sourceWorker = new PatchCodingWorker(store, {
      broker,
      workerId: 'accept-source',
      proposalAgent: new FakePatchProposalAgent({ files: sourcePatchFiles() }),
      timeoutMs: 60000
    });
    const sourcePatchRun = await sourceWorker.runOnce({ projectId: 'acceptance' });
    expect('source proposal stored', sourcePatchRun.outcome, 'succeeded');

    let sourceProposal = store.getPatchProposal(sourcePatchRun.proposalId);
    store.approvePatchProposal(sourceProposal.id, { expectedHash: sourceProposal.proposal_hash });
    const sourceWorkspace = store.getWorkspaceForAttempt(sourceJob.id, 1);
    const sourceApplied = await broker.applyProposal(sourceWorkspace, store.getPatchProposal(sourceProposal.id));
    expect('source patch applied', sourceApplied.outcome, 'applied');
    sourceProposal = store.getPatchProposal(sourceProposal.id);

    // ---- 2. 源测试：真实 Docker（L1/L3）或 Fake（L2）----
    const profile = resolveTestProfile('node-smoke', {
      imageDigest: level === 2 ? `sha256:${'a'.repeat(64)}` : imageDigest
    });
    const sourceProvider = level === 2
      ? fakeProvider(1, 'withRetry uses all attempts')
      : new DockerSandboxProvider({ requireRootless: process.env.OWNER_AGENT_SANDBOX_REQUIRE_ROOTLESS === '1' });
    if (level !== 2) {
      const preflight = await sourceProvider.preflight(profile);
      expectOk('docker preflight ok', preflight.ok, JSON.stringify(preflight.capabilities ?? preflight));
    }

    const runSandbox = async ({ runId, proposal, workspace, provider, repairCycleId = null, expectedTestStatus, marker }) => {
      const snapshot = createInputSnapshot({
        runId,
        workspacePath: workspace.path,
        proposal,
        includePaths: INCLUDE_PATHS,
        sandboxRoot
      });
      const hash = approvalHash({
        projectId: 'acceptance',
        workspaceId: workspace.id,
        proposalId: proposal.id,
        approvedHash: proposal.approved_hash,
        baseSha: proposal.base_sha,
        profile,
        snapshotHash: snapshot.snapshotHash,
        includePaths: INCLUDE_PATHS
      });
      store.createSandboxRun({
        id: runId,
        projectId: 'acceptance',
        jobId: proposal.job_id,
        attempt: proposal.attempt,
        workspaceId: workspace.id,
        proposalId: proposal.id,
        approvedHash: proposal.approved_hash,
        baseSha: proposal.base_sha,
        profile,
        approvalHash: hash,
        snapshotHash: snapshot.snapshotHash,
        snapshotPath: snapshot.snapshotPath,
        includePaths: INCLUDE_PATHS,
        repairCycleId
      });
      const manifest = JSON.stringify(snapshot.manifest);
      store.saveSandboxEvidence(runId, 'snapshot_manifest', {
        content: manifest,
        contentHash: sha256(manifest),
        bytes: Buffer.byteLength(manifest)
      });
      store.approveSandboxRun(runId, { expectedHash: hash });

      const runner = new SandboxRunner(store, {
        provider,
        workerId: `accept-${runId}`,
        pollMs: level === 2 ? 0 : 250,
        leaseMs: 120000
      });
      const result = await runner.runOnce({ projectId: 'acceptance' });
      const saved = store.getSandboxRun(runId);
      expect(`sandbox ${runId} execution completed`, saved.execution_status, 'completed');
      expect(`sandbox ${runId} test ${expectedTestStatus}`, saved.test_status, expectedTestStatus);
      const stdout = store.getSandboxEvidence(runId, 'stdout');
      if (level !== 2) {
        expectOk(`sandbox ${runId} stdout contains assertion marker`, String(stdout?.content ?? '').includes(marker),
          `bytes=${stdout?.bytes ?? 0}`);
      }
      return { saved, snapshot, result, stdout };
    };

    const sourceRun = await runSandbox({
      runId: `accept-l${level}-r${round}-source-run`,
      proposal: sourceProposal,
      workspace: sourceWorkspace,
      provider: sourceProvider,
      expectedTestStatus: 'fail',
      marker: 'withRetry uses all attempts'
    });
    expect('source run is completed/completed/fail',
      `${sourceRun.saved.status}/${sourceRun.saved.execution_status}/${sourceRun.saved.test_status}`,
      'completed/completed/fail');

    // ---- 3. 修复请求与审批 ----
    const cycle = submitRepairCycle(store, {
      sandboxRunId: sourceRun.saved.id,
      scope: ['src/'],
      idempotencyKey: `accept-l${level}-r${round}-repair`
    });
    expect('repair cycle pending approval', cycle.status, 'pending_approval');
    const approved = approveRepairCycle(store, { id: cycle.id, expectedHash: cycle.approval_hash });
    expect('repair job queued', approved.status, 'queued');
    expectOk('repair job is code-patch', approved.job?.job_type === 'code-patch', approved.job?.job_type);

    // ---- 4. 修复提案：L1 确定性；L2/L3 真实 Pi ----
    const repairAgent = level === 1
      ? new FakePatchProposalAgent({ files: fixedRetryFiles() })
      : null;
    const repairWorker = new PatchCodingWorker(store, {
      broker,
      workerId: 'accept-repair',
      model,
      timeoutMs,
      ...(repairAgent ? { proposalAgent: repairAgent } : {})
    });
    const repairPatchRun = await repairWorker.runOnce({
      projectId: 'acceptance',
      allowModel: level >= 2
    });
    if (repairPatchRun.outcome !== 'succeeded') {
      throw new Error(`repair proposal failed: ${describeFailure(store, repairPatchRun.jobId, cycle.id)}`);
    }
    expect('repair proposal stored', repairPatchRun.outcome, 'succeeded');

    const repairProposal = store.getPatchProposal(repairPatchRun.proposalId);
    expect('repair cycle proposal_ready', store.getRepairCycle(cycle.id).status, 'proposal_ready');
    expect('repair proposal is linked to cycle', repairProposal.repair_cycle_id, cycle.id);
    const proposalPaths = (repairProposal.files ?? []).map((file) => file.path);
    expectOk('repair proposal only touches src/', proposalPaths.every((p) => p.startsWith('src/')),
      proposalPaths.join(','));
    expectOk('repair proposal does not touch tests/', !proposalPaths.some((p) => p.startsWith('tests/')),
      proposalPaths.join(','));

    store.approvePatchProposal(repairProposal.id, { expectedHash: repairProposal.proposal_hash });
    const repairWorkspace = store.getWorkspace(repairProposal.workspace_id);
    const repairApplied = await broker.applyProposal(
      repairWorkspace,
      store.getPatchProposal(repairProposal.id)
    );
    expect('repair proposal applied', repairApplied.outcome, 'applied');
    expect('repair cycle applied', store.getRepairCycle(cycle.id).status, 'applied');

    // ---- 5. 复测：同一 profile / image / includePaths ----
    const repairProvider = level === 2
      ? fakeProvider(0, 'withRetry uses all attempts')
      : new DockerSandboxProvider({ requireRootless: process.env.OWNER_AGENT_SANDBOX_REQUIRE_ROOTLESS === '1' });
    const repairRun = await runSandbox({
      runId: `accept-l${level}-r${round}-repair-run`,
      proposal: store.getPatchProposal(repairProposal.id),
      workspace: repairWorkspace,
      provider: repairProvider,
      repairCycleId: cycle.id,
      expectedTestStatus: 'pass',
      marker: 'withRetry uses all attempts'
    });
    expect('repair run is completed/completed/pass',
      `${repairRun.saved.status}/${repairRun.saved.execution_status}/${repairRun.saved.test_status}`,
      'completed/completed/pass');
    expect('repair cycle tested_pass', store.getRepairCycle(cycle.id).status, 'tested_pass');

    // ---- 6. 完整性断言 ----
    const repairManifest = JSON.parse(store.getSandboxEvidence(repairRun.saved.id, 'snapshot_manifest').content);
    const testEntry = repairManifest.find((entry) => entry.path === FIXTURE_TEST_PATH);
    expect('repaired snapshot contains the committed test', Boolean(testEntry), true);
    expect('repaired snapshot test hash equals base', testEntry?.sha256, fixture.testSha256);

    const sourceRetryAfter = fs.readFileSync(path.join(sourceWorkspace.path, 'src', 'retry.js'), 'utf8');
    expect('source worktree unchanged after repair', sourceRetryAfter, sourcePatchFiles()[0].content);
    expect('OwnerTask remains todo', store.getTask(task.id).status, 'todo');

    // 冻结的 repair context 按设计包含有界证据（私有字段）；这里只检查 Job/Event/oplog
    // 与对外投影，不把 context_text 本身当作泄漏。
    const auditText = JSON.stringify({
      events: store.listEvents({ projectId: 'acceptance' }),
      jobs: store.listJobs({ projectId: 'acceptance' }),
      oplog: store.getRepairCycle(cycle.id).oplog
    });
    expectOk('Job/Event/oplog contain no raw test output',
      !auditText.includes('not ok 1 - withRetry') && !auditText.includes('AssertionError'),
      `auditChars=${auditText.length}`);

    Object.assign(evidence, {
      projectId: 'acceptance',
      taskId: task.id,
      sourceJobId: sourceJob.id,
      sourceProposalId: sourceProposal.id,
      sourceProposalHash: sourceProposal.proposal_hash,
      sourceWorkspaceId: sourceWorkspace.id,
      sourceBaseSha: fixture.base,
      sourceRunId: sourceRun.saved.id,
      sourceStatus: {
        status: sourceRun.saved.status,
        execution: sourceRun.saved.execution_status,
        test: sourceRun.saved.test_status,
        exitCode: sourceRun.saved.exit_code
      },
      cycleId: cycle.id,
      approvalHash: cycle.approval_hash,
      repairJobId: approved.job?.id ?? null,
      repairProposalId: repairProposal.id,
      repairProposalHash: repairProposal.proposal_hash,
      repairWorkspaceId: repairWorkspace.id,
      repairRunId: repairRun.saved.id,
      repairStatus: {
        status: repairRun.saved.status,
        execution: repairRun.saved.execution_status,
        test: repairRun.saved.test_status,
        exitCode: repairRun.saved.exit_code
      },
      testIntegrity: {
        path: FIXTURE_TEST_PATH,
        baseSha256: fixture.testSha256,
        repairSha256: testEntry?.sha256 ?? null,
        equal: testEntry?.sha256 === fixture.testSha256
      },
      sourceWorktreeUnchanged: sourceRetryAfter === sourcePatchFiles()[0].content,
      ownerTaskStatus: store.getTask(task.id).status,
      finishedAt: new Date().toISOString()
    });
  } finally {
    try { store.close(); } catch { /* already closed */ }
    if (keep) {
      console.log(`[INFO] kept temporary directory: ${root}`);
    } else {
      makeWritable(root);
      fs.rmSync(root, { recursive: true, force: true });
      console.log(`[INFO] cleaned temporary directory: ${root}`);
    }
  }
  return evidence;
}

const main = async () => {
  if (level !== 2) imageDigest = resolveDockerDigest();
  console.log(`== v1.1 acceptance: level=${level} model=${model || 'sdk-default'} image=${imageDigest || 'fake'} ==`);
  const evidence = await runOnce({ round: 1 });
  evidence.durationMs = Date.parse(evidence.finishedAt) - Date.parse(evidence.startedAt);
  console.log('\n== evidence ==');
  console.log(JSON.stringify(evidence, null, 2));
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    console.log(`[INFO] evidence written to ${outPath}`);
  }
  if (failures > 0) {
    console.error(`\nACCEPTANCE FAILED (${failures} assertion(s))`);
    process.exitCode = 1;
  } else {
    console.log('\nACCEPTANCE PASSED');
  }
};

main().catch((error) => {
  console.error(`\nACCEPTANCE ERROR: ${error?.message ?? error}`);
  if (error?.stack) console.error(error.stack);
  process.exitCode = 1;
});
