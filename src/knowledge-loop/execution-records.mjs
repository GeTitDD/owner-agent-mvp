// 执行记录（Execution record）：owner store 里已终态的运行、任务与补丁的只读投影。
//
// 不落表、不写库：每次读取都直接查 owner store 的既有事实，因此项目被删除后
// 天然不会再返回任何指向它的记录。非终态记录一律不投影——这正是历史脏数据的来源。
// 一次执行（job → patch → sandbox run）只产出一条记录，主体按 run > job > patch 取舍；
// 其余主体退化为这条记录的 evidenceRefs，供提炼时追证据。
import { flatText } from '../utils.mjs';
// 终态判定来自 src/execution-status.mjs：执行记录、操作区与跨项目快照共用一份。
import { TERMINAL } from '../execution-status.mjs';

export const EXECUTION_RECORD_LIMIT = 100;
/** 单次扫描上限：owner store 的列表接口最多返回 500 条，够覆盖默认的最近 100 条。 */
const SCAN_LIMIT = 500;

const TERMINAL_SANDBOX = TERMINAL.sandbox;
const TERMINAL_JOB = TERMINAL.job;
const TERMINAL_PATCH = TERMINAL.patch;


const text = (value, max = 300) => flatText(value, max);
/** 取第一个非空字符串：终态记录的发生时间优先用真实结束时间。 */
const firstTime = (...values) => values.find((value) => typeof value === 'string' && value) ?? null;
const fileList = (patch) => (patch?.files ?? []).map((file) => text(file?.path ?? file, 200)).filter(Boolean);
const unique = (values) => [...new Set(values.filter(Boolean))];
const runTimestamp = (run) => firstTime(run?.finished_at, run?.updated_at, run?.created_at);

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

function jobRecord({ job, attempts, task, patches }) {
  const changedFiles = unique(patches.flatMap(fileList));
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
    // 作业自身没有测试结论；有终态运行时这次执行已由 run 记录代表，不会走到这里。
    testStatus: null,
    occurredAt: firstTime(job.finished_at, job.updated_at, job.created_at),
    evidenceRefs: unique([
      `job:${job.id}`,
      ...attempts.map((attempt) => `attempt:${attempt.id}`),
      ...patches.map((item) => `patch:${item.id}`),
      task ? `task:${task.id}` : ''
    ])
  };
}

function patchRecord({ patch, job, task }) {
  const changedFiles = fileList(patch);
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
    // 没有运行也没有作业可代表这次执行，因此没有测试证据。
    testStatus: null,
    occurredAt: firstTime(patch.updated_at, patch.created_at),
    evidenceRefs: unique([
      `patch:${patch.id}`,
      `job:${patch.job_id}`,
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

  // 一次执行只产出一条记录，主体优先级与 ExperienceCollector.collectProject 一致：
  // 终态 run > 终态 job > 终态 patch。低优先级主体只作为证据引用出现，不另起记录。
  const jobsCoveredByRuns = new Set(runs.map((run) => run.job_id));
  const patchesCoveredByRuns = new Set(runs.map((run) => run.proposal_id));
  const terminalJobIds = new Set(jobs.map((job) => job.id));

  for (const run of runs) {
    const job = ownerStore.getJob(run.job_id);
    const task = job?.owner_task_id ? ownerStore.getTask(job.owner_task_id) : null;
    const patch = ownerStore.getPatchProposal(run.proposal_id);
    const evidenceKinds = (ownerStore.getSandboxRun(run.id)?.evidence ?? run.evidence ?? [])
      .map((item) => text(item?.kind, 40)).filter(Boolean);
    records.push(sandboxRecord({ run, job, task, patch, evidenceKinds }));
  }

  for (const job of jobs) {
    if (jobsCoveredByRuns.has(job.id)) continue;
    const detail = ownerStore.getJob(job.id) ?? job;
    const task = detail.owner_task_id ? ownerStore.getTask(detail.owner_task_id) : null;
    records.push(jobRecord({
      job: detail,
      attempts: detail.attempts ?? [],
      task,
      patches: patches.filter((patch) => patch.job_id === detail.id)
    }));
  }

  for (const patch of terminalPatches) {
    // run 或 job 已经代表过这次执行时，补丁只作为它们的上下文，不再单独成条。
    if (patchesCoveredByRuns.has(patch.id) || terminalJobIds.has(patch.job_id)) continue;
    const job = ownerStore.getJob(patch.job_id);
    const ownerTaskId = patch.owner_task_id ?? job?.owner_task_id;
    const task = ownerTaskId ? ownerStore.getTask(ownerTaskId) : null;
    records.push(patchRecord({ patch, job, task }));
  }

  records.sort(byOccurredAtDesc);
  return {
    projectId: id,
    records: records.slice(0, limit),
    total: records.length,
    truncated: records.length > limit
  };
}
