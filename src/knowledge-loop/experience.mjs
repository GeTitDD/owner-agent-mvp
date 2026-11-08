// Experience Collector：把 Owner Store 中已登记的 Run/Job 结果转成结构化经验。
//
// 只读取持久化事实，不推断模型自报的成功；原始 prompt / 工具输出 / 密钥不进入记录。
import { normalizeExperience } from './contracts.mjs';
import { requireId } from '../utils.mjs';

const text = (value, max = 1200) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);
const shortRef = (value, max = 80) => text(value, max);

function projectDomain(project) {
  return project?.primary_domain || project?.primaryDomain || 'software-engineering';
}

function sandboxOutcome(run, repair) {
  if (repair && repair.repair_sandbox_run_id === run.id) {
    if (repair.status === 'tested_pass') return 'repaired';
    if (['tested_fail', 'failed', 'cancelled', 'rejected'].includes(repair.status)) return 'failed';
  }
  if (run.status === 'completed') return run.test_status === 'pass' ? 'succeeded' : 'failed';
  if (run.status === 'cancelled' || run.status === 'rejected') return run.status;
  if (run.status === 'failed' || run.status === 'needs_reconciliation') return 'failed';
  return 'unknown';
}

export class ExperienceCollector {
  constructor(store, personalStore, { clock = () => new Date().toISOString() } = {}) {
    if (!store) throw new Error('OwnerStore is required');
    if (!personalStore) throw new Error('PersonalKnowledgeStore is required');
    this.store = store;
    this.personal = personalStore;
    this.clock = clock;
  }

  projectFor(projectId) {
    return this.store.getProject(projectId);
  }

  /** 从一次 Sandbox Run（含修复链）采集经验；重复采集返回已有记录。 */
  collectSandboxRun(runId) {
    requireId(runId, 'sandbox run id');
    const run = this.store.getSandboxRun(runId);
    if (!run) throw new Error('Sandbox run not found');
    const job = this.store.getJob(run.job_id);
    const task = job?.owner_task_id ? this.store.getTask(job.owner_task_id) : null;
    const project = this.projectFor(run.project_id);
    const repairs = this.store.listRepairCycles({ projectId: run.project_id, limit: 200 });
    const repair = repairs.find((cycle) =>
      cycle.source_sandbox_run_id === run.id || cycle.repair_sandbox_run_id === run.id
    ) ?? null;
    const outcome = sandboxOutcome(run, repair);
    const evidenceRefs = [
      `sandbox:${run.id}`,
      `job:${run.job_id}`,
      `patch:${run.proposal_id}`,
      ...run.evidence.map((item) => `evidence:${run.id}:${item.kind}`)
    ];
    if (repair) evidenceRefs.push(`repair:${repair.id}`);
    if (task) evidenceRefs.push(`task:${task.id}`);
    const patch = this.store.getPatchProposal(run.proposal_id);
    const patchPaths = (patch?.files ?? []).map((file) => file.path);
    const facts = [
      `sandbox.status=${run.status}`,
      `sandbox.execution_status=${run.execution_status}`,
      `sandbox.test_status=${run.test_status}`,
      `job.status=${job?.status ?? 'missing'}`,
      ...(repair ? [`repair.status=${repair.status}`] : [])
    ];
    const unknowns = [];
    if (run.test_status === 'unknown') unknowns.push('测试结论未知（可能未运行、超时或基础设施失败）');
    if (!job) unknowns.push('Job 记录缺失');
    if (!task) unknowns.push('没有关联 OwnerTask');
    const record = normalizeExperience({
      sourceRunId: run.id,
      projectId: run.project_id,
      taskId: task?.id ?? null,
      domainIds: [projectDomain(project)],
      observedProblem: text(job?.title ?? task?.title ?? '未命名任务'),
      actionSummary: text([
        patchPaths.length ? `补丁文件：${patchPaths.join(', ')}` : '',
        repair ? `修复周期 ${repair.id}，范围 ${(repair.repairScope ?? []).join(', ') || '未记录'}` : '',
        `Sandbox profile=${run.profile_id}`
      ].filter(Boolean).join('；'), 2000),
      observedOutcome: {
        status: outcome,
        source: 'owner-store',
        testStatus: run.test_status,
        executionStatus: run.execution_status,
        repairStatus: repair?.status ?? null
      },
      evidenceRefs,
      environment: {
        primaryDomain: projectDomain(project),
        profileId: run.profile_id,
        imageDigestPrefix: shortRef(run.image_digest, 24),
        runtime: run.profile_id === 'node-smoke' ? 'node' : 'unknown'
      },
      facts,
      inferences: [],
      unknowns,
      createdAt: this.clock()
    });
    const existing = this.personal.experienceByDedupe(record.dedupeKey);
    if (existing) return { ...existing, duplicate: true };
    const saved = this.personal.addExperience(record);
    return { ...saved, duplicate: false };
  }

  /** 从 Job 采集失败/取消/拒绝经验；有 Sandbox 的 Job 应优先采集 Sandbox。 */
  collectJob(jobId) {
    const job = this.store.getJob(requireId(jobId, 'job id'));
    if (!job) throw new Error('Job not found');
    const task = job.owner_task_id ? this.store.getTask(job.owner_task_id) : null;
    const project = this.projectFor(job.project_id);
    const runs = this.store.listSandboxRuns({ projectId: job.project_id, limit: 200 })
      .filter((run) => run.job_id === job.id);
    const outcome = job.status === 'succeeded' ? 'succeeded'
      : job.status === 'cancelled' ? 'cancelled'
        : job.status === 'rejected' ? 'rejected'
          : job.status === 'failed' || job.status === 'needs_reconciliation' ? 'failed' : 'unknown';
    const facts = [
      `job.status=${job.status}`,
      `job.attempts=${job.attempts.length}`,
      ...job.attempts.map((attempt) => `attempt.${attempt.attempt}.status=${attempt.status}`)
    ];
    const unknowns = [];
    if (!runs.length) unknowns.push('没有 Sandbox 测试证据');
    if (!task) unknowns.push('没有关联 OwnerTask');
    const record = normalizeExperience({
      sourceRunId: job.id,
      projectId: job.project_id,
      taskId: task?.id ?? null,
      domainIds: [projectDomain(project)],
      observedProblem: text(job.title),
      actionSummary: text(job.attempts.length
        ? `最近一次尝试 ${job.attempts.at(-1).attempt}：${job.attempts.at(-1).result_note || job.attempts.at(-1).status}`
        : `Job 状态 ${job.status}`),
      observedOutcome: {
        status: outcome,
        source: 'owner-store',
        testStatus: runs.at(-1)?.test_status ?? null,
        executionStatus: runs.at(-1)?.execution_status ?? null,
        repairStatus: null
      },
      evidenceRefs: [`job:${job.id}`, ...job.attempts.map((attempt) => `attempt:${attempt.id}`),
        ...runs.map((run) => `sandbox:${run.id}`), ...(task ? [`task:${task.id}`] : [])],
      environment: {
        primaryDomain: projectDomain(project),
        profileId: runs.at(-1)?.profile_id ?? null,
        imageDigestPrefix: runs.at(-1)?.image_digest ? shortRef(runs.at(-1).image_digest, 24) : null,
        runtime: runs.at(-1)?.profile_id === 'node-smoke' ? 'node' : 'unknown'
      },
      facts,
      inferences: [],
      unknowns,
      createdAt: this.clock()
    });
    const existing = this.personal.experienceByDedupe(record.dedupeKey);
    if (existing) return { ...existing, duplicate: true };
    const saved = this.personal.addExperience(record);
    return { ...saved, duplicate: false };
  }

  /** 批量采集：先 Sandbox，再没有 Sandbox 的 Job。 */
  collectProject(projectId, { limit = 50 } = {}) {
    const runs = this.store.listSandboxRuns({ projectId, limit });
    const jobs = this.store.listJobs({ projectId, limit });
    const seenJobs = new Set(runs.map((run) => run.job_id));
    const collected = [];
    for (const run of runs) collected.push(this.collectSandboxRun(run.id));
    for (const job of jobs) {
      if (!seenJobs.has(job.id)) collected.push(this.collectJob(job.id));
    }
    return collected;
  }
}
