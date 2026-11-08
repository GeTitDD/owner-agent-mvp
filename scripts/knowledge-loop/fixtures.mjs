// Knowledge Loop 演示/测试 fixture：在 OwnerStore 中写入确定性的 Sandbox 结果。
//
// 这些行用于快速回归和演示知识闭环，不冒充真实 Docker / 真实 Pi 执行；
// 真实 Pi 的 Harvest 与 Reuse 在 demo 中单独运行并记录。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256 } from '../../src/utils.mjs';
import { resolveTestProfile } from '../../src/sandbox-protocol.mjs';
import { makeAcceptanceFixture } from '../../scripts/acceptance/make-fixture.mjs';

const now = () => new Date().toISOString();
const hex = (value) => sha256(value);
const image = `sha256:${'a'.repeat(64)}`;

export function insertJob(store, { id, projectId, taskId, title, baseSha }) {
  const stamp = now();
  store.db.prepare(`INSERT INTO owner_jobs(id,project_id,owner_task_id,job_type,title,payload,status,idempotency_key,created_at,updated_at,last_attempt,finished_at)
    VALUES(?,?,?,?,?,?,'succeeded',?,?,?,1,?)`).run(
    id, projectId, taskId, 'code-patch', title,
    JSON.stringify({ baseSha, allowedPaths: 'src/' }), id, stamp, stamp, stamp
  );
}

export function insertWorkspace(store, { id, projectId, jobId, baseSha, root }) {
  store.db.prepare(`INSERT INTO owner_workspaces(id,project_id,job_id,attempt,base_sha,branch,path,status,created_at)
    VALUES(?,?,?,1,?,?,?,'quarantined',?)`).run(
    id, projectId, jobId, baseSha, `owner/job-${jobId}-a1`, path.join(root, '.fixture-workspaces', id), now()
  );
}

export function insertPatch(store, { id, projectId, jobId, taskId, workspaceId, baseSha, filePath, content, status = 'applied', diff = '' }) {
  const stamp = now();
  store.db.prepare(`INSERT INTO owner_patch_proposals(id,project_id,job_id,attempt,workspace_id,owner_task_id,base_sha,allowed_paths,files,proposal_hash,status,created_at,updated_at,approved_at,approved_by,approved_hash)
    VALUES(?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, projectId, jobId, workspaceId, taskId, baseSha, JSON.stringify(['src/']),
    JSON.stringify([{ path: filePath, action: 'modify', content }]),
    hex(`${id}:proposal`), status, stamp, stamp, stamp, 'fixture', hex(`${id}:approved`)
  );
  const artifactDiff = diff || (filePath === 'src/retry.js'
    ? `--- a/src/retry.js\n+++ b/src/retry.js\n@@\n-  for (let i = 0; i < attempts - 1; i += 1) {\n+  for (let i = 0; i < attempts; i += 1) {\n`
    : `--- a/${filePath}\n+++ b/${filePath}\n`);
  store.db.prepare(`INSERT INTO owner_patch_artifacts(id,proposal_id,kind,content,content_hash,created_at)
    VALUES(?,?,?,?,?,?)`).run(`artifact-${id}`, id, 'proposal_diff', artifactDiff, hex(artifactDiff), stamp);
}

export function insertRun(store, {
  id, projectId, jobId, workspaceId, patchId, baseSha, testStatus, root, repairCycleId = null
}) {
  const stamp = now();
  const profile = resolveTestProfile('node-smoke', { imageDigest: image });
  const stdout = testStatus === 'pass'
    ? 'ok 1 - withRetry uses all attempts\n1..1\n# pass 1\n'
    : 'not ok 1 - withRetry uses all attempts\n1..1\n# fail 1\n';
  store.db.prepare(`INSERT INTO owner_sandbox_runs(
    id,project_id,job_id,attempt,workspace_id,proposal_id,approved_hash,base_sha,profile_id,profile_hash,test_plan_hash,
    approval_hash,profile_json,image_digest,snapshot_hash,snapshot_path,include_paths,status,execution_status,test_status,
    exit_code,timeout_ms,memory_bytes,cpus,pids_limit,tmpfs_bytes,stdout_bytes,stderr_bytes,provider,created_at,
    finished_at,updated_at,repair_cycle_id)
    VALUES(?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,'completed','completed',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, projectId, jobId, workspaceId, patchId, hex(`${id}:approved`), baseSha,
    profile.id, profile.profileHash, profile.testPlanHash, hex(`${id}:approval`),
    JSON.stringify(profile), image, hex(`${id}:snapshot`), path.join(root, '.fixture-snapshots', id),
    JSON.stringify(['tests/sandbox-smoke.test.mjs']), testStatus, testStatus === 'pass' ? 0 : 1,
    profile.timeoutMs, profile.memoryBytes, profile.cpus, profile.pidsLimit, profile.tmpfsBytes,
    Buffer.byteLength(stdout), 0, 'fixture', stamp, stamp, stamp, repairCycleId
  );
  store.saveSandboxEvidence(id, 'stdout', {
    content: stdout, contentHash: hex(stdout), bytes: Buffer.byteLength(stdout)
  });
}

export function insertRepairCycle(store, {
  id, projectId, taskId, sourcePatchId, sourceWorkspaceId, sourceRunId,
  repairJobId, repairPatchId, repairRunId, baseSha, status = 'tested_pass'
}) {
  const stamp = now();
  store.db.prepare(`INSERT INTO owner_repair_cycles(
    id,project_id,owner_task_id,source_proposal_id,source_workspace_id,source_sandbox_run_id,
    source_evidence_hash,source_snapshot_hash,source_base_sha,source_chain_hash,repair_scope,context_text,
    context_hash,approval_hash,status,iteration,max_iterations,job_id,repair_proposal_id,repair_sandbox_run_id,
    idempotency_key,created_at,approved_at,updated_at,completed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1,?,?,?,?,?,?,?,?)`).run(
    id, projectId, taskId, sourcePatchId, sourceWorkspaceId, sourceRunId,
    hex('source-evidence'), hex('source-snapshot'), baseSha, hex('source-chain'),
    JSON.stringify(['src/']), 'fixture repair context', hex('context'), hex('approval'),
    status, repairJobId, repairPatchId, repairRunId, `repair-${projectId}`, stamp, stamp, stamp, stamp
  );
  return id;
}

export function createSyntheticProject({ store, root, projectId, name = projectId }) {
  const fixture = makeAcceptanceFixture({ root });
  store.registerProject({ id: projectId, name, root, primaryDomain: 'software-engineering' });
  const task = store.createTask({ projectId, title: 'Fix the failing retry test' });
  const sourceJobId = `job-${projectId}-source`;
  insertJob(store, { id: sourceJobId, projectId, taskId: task.id, title: 'Source patch', baseSha: fixture.base });
  const sourceWorkspaceId = `ws-${projectId}-source`;
  insertWorkspace(store, { id: sourceWorkspaceId, projectId, jobId: sourceJobId, baseSha: fixture.base, root });
  const sourcePatchId = `patch-${projectId}-source`;
  insertPatch(store, {
    id: sourcePatchId, projectId, jobId: sourceJobId, taskId: task.id,
    workspaceId: sourceWorkspaceId, baseSha: fixture.base,
    filePath: 'src/retry.js', content: `${fixture.buggyRetry}\n// source touched\n`
  });
  const sourceRunId = `run-${projectId}-source`;
  insertRun(store, {
    id: sourceRunId, projectId, jobId: sourceJobId, workspaceId: sourceWorkspaceId,
    patchId: sourcePatchId, baseSha: fixture.base, testStatus: 'fail', root
  });

  const repairJobId = `job-${projectId}-repair`;
  insertJob(store, { id: repairJobId, projectId, taskId: task.id, title: 'Repair patch', baseSha: fixture.base });
  const repairWorkspaceId = `ws-${projectId}-repair`;
  insertWorkspace(store, { id: repairWorkspaceId, projectId, jobId: repairJobId, baseSha: fixture.base, root });
  const repairPatchId = `patch-${projectId}-repair`;
  insertPatch(store, {
    id: repairPatchId, projectId, jobId: repairJobId, taskId: task.id,
    workspaceId: repairWorkspaceId, baseSha: fixture.base,
    filePath: 'src/retry.js', content: fixture.fixedRetry
  });
  const repairRunId = `run-${projectId}-repair`;
  const cycleId = `cycle-${projectId}`;
  insertRun(store, {
    id: repairRunId, projectId, jobId: repairJobId, workspaceId: repairWorkspaceId,
    patchId: repairPatchId, baseSha: fixture.base, testStatus: 'pass', root, repairCycleId: cycleId
  });
  insertRepairCycle(store, {
    id: cycleId, projectId, taskId: task.id,
    sourcePatchId, sourceWorkspaceId, sourceRunId,
    repairJobId, repairPatchId, repairRunId, baseSha: fixture.base
  });
  return {
    projectId, root, taskId: task.id, baseSha: fixture.base,
    sourceRunId, sourcePatchId, repairRunId, repairPatchId, cycleId
  };
}

export function createPassingProject({ store, root, projectId, name = projectId }) {
  const fixture = makeAcceptanceFixture({ root });
  store.registerProject({ id: projectId, name, root, primaryDomain: 'software-engineering' });
  const task = store.createTask({ projectId, title: 'Verify retry behavior' });
  const jobId = `job-${projectId}-pass`;
  insertJob(store, { id: jobId, projectId, taskId: task.id, title: 'Passing retry fix', baseSha: fixture.base });
  const workspaceId = `ws-${projectId}-pass`;
  insertWorkspace(store, { id: workspaceId, projectId, jobId, baseSha: fixture.base, root });
  const patchId = `patch-${projectId}-pass`;
  insertPatch(store, {
    id: patchId, projectId, jobId, taskId: task.id, workspaceId, baseSha: fixture.base,
    filePath: 'src/retry.js', content: fixture.fixedRetry
  });
  const runId = `run-${projectId}-pass`;
  insertRun(store, {
    id: runId, projectId, jobId, workspaceId, patchId, baseSha: fixture.base,
    testStatus: 'pass', root
  });
  return { projectId, root, taskId: task.id, baseSha: fixture.base, runId, patchId };
}

export function writeProjectContext(root, projectId) {
  fs.writeFileSync(path.join(root, 'domain-context.json'), `${JSON.stringify({
    project: { id: projectId, primaryDomain: 'software-engineering' },
    domainRoot: path.resolve(process.cwd(), 'domains'),
    domains: [{ id: 'software-engineering', version: '1.0.0' }],
    context: { maxTokens: 2000 },
    workspace: { enabled: true, importDomainIds: ['software-engineering'], includeProject: true }
  }, null, 2)}\n`, 'utf8');
}
