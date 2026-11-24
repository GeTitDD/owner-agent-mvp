// 执行记录（Execution record）：owner store 里已终态的运行、任务与补丁的只读投影。
//
// 不落表、不写库：每次读取都直接查 owner store 的既有事实，因此项目被删除后
// 天然不会再返回任何指向它的记录。非终态记录一律不投影——这正是历史脏数据的来源。
export const EXECUTION_RECORD_LIMIT = 100;
/** 单次扫描上限：owner store 的列表接口最多返回 500 条，够覆盖默认的最近 100 条。 */
const SCAN_LIMIT = 500;

/** 终态判定与 ExperienceCollector 保持一致，避免两处对「已终态」的理解分叉。 */
const TERMINAL_SANDBOX = new Set(['completed', 'failed', 'cancelled', 'rejected']);
const TERMINAL_JOB = new Set(['succeeded', 'failed', 'cancelled', 'rejected']);
const TERMINAL_PATCH = new Set(['applied', 'rejected', 'apply_failed']);

const text = (value, max = 300) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);
/** 取第一个非空字符串：终态记录的发生时间优先用真实结束时间。 */
const firstTime = (...values) => values.find((value) => typeof value === 'string' && value) ?? null;
const fileList = (patch) => (patch?.files ?? []).map((file) => text(file?.path ?? file, 200)).filter(Boolean);
const unique = (values) => [...new Set(values.filter(Boolean))];
const runTimestamp = (run) => firstTime(run?.finished_at, run?.updated_at, run?.created_at);
const byOccurredAtAsc = (a, b) =>
  String(runTimestamp(a) ?? '').localeCompare(String(runTimestamp(b) ?? ''));
/** 取最近发生的一条运行：作业/补丁自身没有测试结论，用它的测试状态代表。 */
const latestRun = (runs) => runs.slice().sort(byOccurredAtAsc).at(-1) ?? null;

function sandboxRecord({ run, job, task, patch, evidenceKinds }) {
  const changedFiles = fileList(patch);
  return {
    id: `sandbox:${run.id}`,
    source: 'sandbox',
    sourceId: run.id,
    projectId: run.project_id,
    taskId: task?.id ?? null,
    taskTitle: text(task?.title ?? job?.title ?? '', 200) || null,
    actionSummary: [
      changedFiles.length ? `补丁文件：${changedFiles.join(', ')}` : '',
      `Sandbox profile=${run.profile_id}`
    ].filter(Boolean).join('；'),
    changedFiles,
    status: run.status,
    testStatus: run.test_status ?? null,
    occurredAt: runTimestamp(run),
    evidenceRefs: unique([
      `sandbox:${run.id}`,
      ...evidenceKinds.map((kind) => `evidence:${run.id}:${kind}`),
      `job:${run.job_id}`,
      `patch:${run.proposal_id}`,
      task ? `task:${task.id}` : ''
    ])
  };
}

function jobRecord({ job, attempts, task, runs, patches }) {
  const changedFiles = unique(patches.flatMap(fileList));
  // 作业自身没有测试结论，取该作业最近一次终态运行的结果作为测试状态。
  const testStatus = latestRun(runs)?.test_status ?? null;
  return {
    id: `job:${job.id}`,
    source: 'job',
    sourceId: job.id,
    projectId: job.project_id,
    taskId: task?.id ?? null,
    taskTitle: text(task?.title ?? job.title ?? '', 200) || null,
    actionSummary: [
      changedFiles.length ? `补丁文件：${changedFiles.join(', ')}` : '',
      job.job_type ? `Job 类型 ${job.job_type}` : '',
      attempts.length ? `尝试 ${attempts.length} 次` : ''
    ].filter(Boolean).join('；'),
    changedFiles,
    status: job.status,
    testStatus,
    occurredAt: firstTime(job.finished_at, job.updated_at, job.created_at),
    evidenceRefs: unique([
      `job:${job.id}`,
      ...attempts.map((attempt) => `attempt:${attempt.id}`),
      ...runs.map((run) => `sandbox:${run.id}`),
      ...patches.map((item) => `patch:${item.id}`),
      task ? `task:${task.id}` : ''
    ])
  };
}

function patchRecord({ patch, job, task, runs }) {
  const changedFiles = fileList(patch);
  // 补丁的测试结论来自引用它的终态运行；没有运行就表示没有测试证据。
  const testStatus = latestRun(runs)?.test_status ?? null;
  return {
    id: `patch:${patch.id}`,
    source: 'patch',
    sourceId: patch.id,
    projectId: patch.project_id,
    taskId: task?.id ?? null,
    taskTitle: text(task?.title ?? job?.title ?? '', 200) || null,
    actionSummary: changedFiles.length ? `补丁文件：${changedFiles.join(', ')}` : '',
    changedFiles,
    status: patch.status,
    testStatus,
    occurredAt: firstTime(patch.updated_at, patch.created_at),
    evidenceRefs: unique([
      `patch:${patch.id}`,
      `job:${patch.job_id}`,
      ...runs.map((run) => `sandbox:${run.id}`),
      task ? `task:${task.id}` : ''
    ])
  };
}

const byOccurredAtDesc = (a, b) =>
  String(b.occurredAt ?? '').localeCompare(String(a.occurredAt ?? '')) || String(b.id).localeCompare(String(a.id));

/**
 * 按项目列举执行记录：时间倒序，默认只给最近 100 条。
 * @param {{ownerStore: object, projectId: string, limit?: number}} input
 * @returns {{projectId: string, records: object[], total: number, truncated: boolean}}
 */
export function listExecutionRecords({ ownerStore, projectId, limit = EXECUTION_RECORD_LIMIT } = {}) {
  if (!ownerStore) throw new Error('ownerStore is required');
  const id = text(projectId, 90);
  if (!id) throw new Error('projectId is required');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SCAN_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${SCAN_LIMIT}`);
  }
  // 项目不存在（已被删除）时不返回任何记录：投影不落表，所以也不存在需要清理的孤儿行。
  if (!ownerStore.getProject(id)) return { projectId: id, records: [], total: 0, truncated: false };

  const records = [];
  const runs = ownerStore.listSandboxRuns({ projectId: id, limit: SCAN_LIMIT })
    .filter((run) => run.project_id === id && TERMINAL_SANDBOX.has(run.status));
  const jobs = ownerStore.listJobs({ projectId: id, limit: SCAN_LIMIT })
    .filter((job) => job.project_id === id && TERMINAL_JOB.has(job.status));
  const patches = ownerStore.listPatchProposals({ projectId: id, limit: SCAN_LIMIT })
    .filter((patch) => patch.project_id === id);
  const terminalPatches = patches.filter((patch) => TERMINAL_PATCH.has(patch.status));

  for (const run of runs) {
    const job = ownerStore.getJob(run.job_id);
    const task = job?.owner_task_id ? ownerStore.getTask(job.owner_task_id) : null;
    const patch = ownerStore.getPatchProposal(run.proposal_id);
    const evidenceKinds = (ownerStore.getSandboxRun(run.id)?.evidence ?? run.evidence ?? [])
      .map((item) => text(item?.kind, 40)).filter(Boolean);
    records.push(sandboxRecord({ run, job, task, patch, evidenceKinds }));
  }

  for (const job of jobs) {
    const detail = ownerStore.getJob(job.id) ?? job;
    const task = detail.owner_task_id ? ownerStore.getTask(detail.owner_task_id) : null;
    records.push(jobRecord({
      job: detail,
      attempts: detail.attempts ?? [],
      task,
      runs: runs.filter((run) => run.job_id === detail.id),
      patches: patches.filter((patch) => patch.job_id === detail.id)
    }));
  }

  for (const patch of terminalPatches) {
    const job = ownerStore.getJob(patch.job_id);
    const ownerTaskId = patch.owner_task_id ?? job?.owner_task_id;
    const task = ownerTaskId ? ownerStore.getTask(ownerTaskId) : null;
    records.push(patchRecord({
      patch,
      job,
      task,
      runs: runs.filter((run) => run.proposal_id === patch.id)
    }));
  }

  records.sort(byOccurredAtDesc);
  return {
    projectId: id,
    records: records.slice(0, limit),
    total: records.length,
    truncated: records.length > limit
  };
}
