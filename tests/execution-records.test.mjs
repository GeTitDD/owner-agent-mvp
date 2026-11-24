// 执行记录投影：只读 owner store 的终态事实，不落表。
// 这里用假 owner store 驱动入口，断言外部行为（给定仓库里有什么，就返回什么），
// 不断言内部函数调用顺序。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OwnerStore } from '../src/owner-store.mjs';
import { listExecutionRecords } from '../src/knowledge-loop/execution-records.mjs';
import { createPassingProject } from '../scripts/knowledge-loop/fixtures.mjs';

const fakeOwner = ({
  projects = { p1: { id: 'p1', name: 'P1', status: 'active' } },
  runs = {}, jobs = {}, tasks = {}, patches = {}
} = {}) => ({
  getProject: (id) => projects[id] ?? null,
  listSandboxRuns: ({ projectId }) => Object.values(runs).filter((run) => run.project_id === projectId),
  getSandboxRun: (id) => (runs[id] ? { evidence: [], ...runs[id] } : null),
  listJobs: ({ projectId }) => Object.values(jobs).filter((job) => job.project_id === projectId),
  getJob: (id) => jobs[id] ?? null,
  listPatchProposals: ({ projectId }) => Object.values(patches).filter((patch) => patch.project_id === projectId),
  getPatchProposal: (id) => patches[id] ?? null,
  getTask: (id) => tasks[id] ?? null
});

const sandbox = (id, overrides = {}) => ({
  id, project_id: 'p1', job_id: 'job1', proposal_id: 'patch1', status: 'completed',
  execution_status: 'completed', test_status: 'pass', profile_id: 'node-smoke',
  evidence: [{ kind: 'stdout' }, { kind: 'stderr' }],
  created_at: '2026-02-01T00:00:00.000Z', finished_at: '2026-02-01T00:05:00.000Z',
  updated_at: '2026-02-01T00:05:00.000Z', ...overrides
});

const job = (id, overrides = {}) => ({
  id, project_id: 'p1', owner_task_id: 'task1', job_type: 'code-patch',
  title: '改掉重试次数上限', status: 'succeeded', attempts: [],
  created_at: '2026-01-31T00:00:00.000Z', finished_at: '2026-01-31T00:10:00.000Z',
  updated_at: '2026-01-31T00:10:00.000Z', ...overrides
});

const patch = (id, overrides = {}) => ({
  id, project_id: 'p1', job_id: 'job1', owner_task_id: 'task1', status: 'applied',
  files: [{ path: 'src/retry.js', action: 'modify' }], proposal_hash: 'a'.repeat(64),
  created_at: '2026-01-30T00:00:00.000Z', updated_at: '2026-01-30T00:02:00.000Z', ...overrides
});

const task = (id, overrides = {}) => ({
  id, project_id: 'p1', title: '修好重试测试', status: 'done', ...overrides
});

test('非终态的排队、执行中、待批准记录都不出现', () => {
  const owner = fakeOwner({
    runs: {
      queued: sandbox('queued', { status: 'queued' }),
      running: sandbox('running', { status: 'running' }),
      waiting: sandbox('waiting', { status: 'pending_approval' }),
      provisioning: sandbox('provisioning', { status: 'provisioning' }),
      collecting: sandbox('collecting', { status: 'collecting' }),
      reconciling: sandbox('reconciling', { status: 'needs_reconciliation' }),
      done: sandbox('done')
    },
    jobs: {
      pendingJob: job('pendingJob', { status: 'pending_approval' }),
      runningJob: job('runningJob', { status: 'running' }),
      queuedJob: job('queuedJob', { status: 'queued' }),
      succeededJob: job('succeededJob')
    },
    patches: {
      proposed: patch('proposed', { status: 'proposed' }),
      approved: patch('approved', { status: 'approved', job_id: 'succeededJob' }),
      applying: patch('applying', { status: 'applying', job_id: 'succeededJob' }),
      reconciling: patch('reconciling', { status: 'needs_reconciliation', job_id: 'succeededJob' }),
      applied: patch('applied', { job_id: 'succeededJob' })
    }
  });
  const { records, total } = listExecutionRecords({ ownerStore: owner, projectId: 'p1' });
  assert.deepEqual(records.map((record) => record.id).sort(), ['job:succeededJob', 'sandbox:done']);
  assert.equal(total, 2);
});

test('终态运行投影成一条执行记录，带任务标题、改动文件与证据引用', () => {
  const owner = fakeOwner({
    runs: { run1: sandbox('run1') },
    jobs: { job1: job('job1') },
    tasks: { task1: task('task1') },
    patches: { patch1: patch('patch1') }
  });
  const { records } = listExecutionRecords({ ownerStore: owner, projectId: 'p1' });
  const record = records.find((item) => item.id === 'sandbox:run1');
  assert.ok(record, '终态运行必须出现');
  assert.equal(record.source, 'sandbox');
  assert.equal(record.sourceId, 'run1');
  assert.equal(record.projectId, 'p1');
  assert.equal(record.taskId, 'task1');
  assert.equal(record.taskTitle, '修好重试测试');
  assert.deepEqual(record.changedFiles, ['src/retry.js']);
  assert.equal(record.status, 'completed');
  assert.equal(record.testStatus, 'pass');
  assert.equal(record.occurredAt, '2026-02-01T00:05:00.000Z');
  for (const ref of ['sandbox:run1', 'evidence:run1:stdout', 'evidence:run1:stderr', 'job:job1', 'patch:patch1', 'task:task1']) {
    assert.ok(record.evidenceRefs.includes(ref), `缺少证据引用 ${ref}`);
  }
});

test('同一条流水线只产出一条运行记录，作业与补丁只作上下文', () => {
  const owner = fakeOwner({
    runs: { run1: sandbox('run1', { status: 'failed', test_status: 'fail' }) },
    jobs: { job1: job('job1') },
    tasks: { task1: task('task1') },
    patches: { patch1: patch('patch1') }
  });
  const { records, total } = listExecutionRecords({ ownerStore: owner, projectId: 'p1' });
  assert.equal(total, 1);
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.id, 'sandbox:run1');
  assert.equal(record.status, 'failed');
  assert.equal(record.testStatus, 'fail');
  assert.deepEqual(record.changedFiles, ['src/retry.js']);
  // 作业与补丁没有单独成条，但它们的信息必须仍能从这个入口拿到。
  for (const ref of ['sandbox:run1', 'job:job1', 'patch:patch1', 'task:task1']) {
    assert.ok(record.evidenceRefs.includes(ref), `运行记录缺少证据引用 ${ref}`);
  }
});

test('没有运行可代表时，终态作业产出一条记录并把补丁作为上下文', () => {
  const owner = fakeOwner({
    jobs: {
      job1: job('job1', {
        attempts: [{ id: 'attempt-1', attempt: 1, status: 'succeeded', result_note: 'ok' }]
      })
    },
    tasks: { task1: task('task1') },
    patches: { patch1: patch('patch1') }
  });
  const { records, total } = listExecutionRecords({ ownerStore: owner, projectId: 'p1' });
  assert.equal(total, 1);
  const [record] = records;
  assert.equal(record.id, 'job:job1');
  assert.equal(record.source, 'job');
  assert.equal(record.taskTitle, '修好重试测试');
  assert.deepEqual(record.changedFiles, ['src/retry.js']);
  assert.match(record.actionSummary, /补丁文件：src\/retry\.js/u);
  assert.equal(record.status, 'succeeded');
  assert.equal(record.occurredAt, '2026-01-31T00:10:00.000Z');
  for (const ref of ['job:job1', 'attempt:attempt-1', 'patch:patch1', 'task:task1']) {
    assert.ok(record.evidenceRefs.includes(ref), `作业记录缺少证据引用 ${ref}`);
  }
});

test('既没有运行也没有作业时，终态补丁产出一条记录', () => {
  const owner = fakeOwner({
    tasks: { task1: task('task1') },
    patches: { patch1: patch('patch1', { job_id: 'lost-job' }) }
  });
  const { records, total } = listExecutionRecords({ ownerStore: owner, projectId: 'p1' });
  assert.equal(total, 1);
  const [record] = records;
  assert.equal(record.id, 'patch:patch1');
  assert.equal(record.source, 'patch');
  assert.equal(record.taskTitle, '修好重试测试');
  assert.deepEqual(record.changedFiles, ['src/retry.js']);
  assert.equal(record.status, 'applied');
  assert.equal(record.occurredAt, '2026-01-30T00:02:00.000Z');
  for (const ref of ['patch:patch1', 'job:lost-job', 'task:task1']) {
    assert.ok(record.evidenceRefs.includes(ref), `补丁记录缺少证据引用 ${ref}`);
  }
});

test('按时间倒序列举，默认截断到最近 100 条', () => {
  const jobs = {};
  for (let index = 1; index <= 105; index += 1) {
    const key = String(index).padStart(3, '0');
    const at = new Date(Date.UTC(2026, 2, 1, 0, index)).toISOString();
    jobs[`job-${key}`] = job(`job-${key}`, {
      owner_task_id: null, title: `任务 ${key}`,
      created_at: at, finished_at: at, updated_at: at
    });
  }
  const owner = fakeOwner({ jobs });

  const all = listExecutionRecords({ ownerStore: owner, projectId: 'p1' });
  assert.equal(all.total, 105);
  assert.equal(all.truncated, true);
  assert.equal(all.records.length, 100);
  assert.equal(all.records[0].sourceId, 'job-105');
  assert.equal(all.records.at(-1).sourceId, 'job-006');
  const times = all.records.map((record) => record.occurredAt);
  assert.deepEqual(times, times.slice().sort().reverse(), '必须从新到旧');

  const few = listExecutionRecords({ ownerStore: owner, projectId: 'p1', limit: 2 });
  assert.deepEqual(few.records.map((record) => record.sourceId), ['job-105', 'job-104']);
  assert.equal(few.truncated, true);
  assert.equal(few.total, 105);
  assert.throws(() => listExecutionRecords({ ownerStore: owner, projectId: 'p1', limit: 0 }), /limit/u);
});

test('一条完整流水线（job → patch → run）只产出一条执行记录', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-pipeline-'));
  const projectId = 'pipeline-project';
  const store = new OwnerStore(path.join(tmp, 'owner.sqlite'));
  try {
    const seeded = createPassingProject({ store, root: path.join(tmp, 'repo'), projectId, name: 'Pipeline' });
    const jobId = store.listJobs({ projectId })
      .find((item) => item.job_type === 'code-patch').id;
    const { records, total } = listExecutionRecords({ ownerStore: store, projectId });
    assert.equal(total, 1, '一次执行只算一条记录');
    assert.equal(records.length, 1);
    const [record] = records;
    assert.equal(record.source, 'sandbox');
    assert.equal(record.id, `sandbox:${seeded.runId}`);
    assert.equal(record.taskId, seeded.taskId);
    assert.equal(record.testStatus, 'pass');
    assert.deepEqual(record.changedFiles, ['src/retry.js']);
    // 同一次执行的作业、补丁、任务和证据都要能从这一条记录里追到。
    for (const ref of [
      `sandbox:${seeded.runId}`, `evidence:${seeded.runId}:stdout`,
      `job:${jobId}`, `patch:${seeded.patchId}`, `task:${seeded.taskId}`
    ]) {
      assert.ok(record.evidenceRefs.includes(ref), `流水线记录缺少证据引用 ${ref}`);
    }
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('项目删除后不再返回任何记录，读取也不建表、不写库', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-records-'));
  const dbPath = path.join(tmp, 'owner.sqlite');
  const projectId = 'real-project';
  const tablesOf = (handle) => handle
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map((row) => row.name);
  const countsOf = (handle) => ({
    runs: handle.prepare('SELECT COUNT(*) AS n FROM owner_sandbox_runs').get().n,
    jobs: handle.prepare('SELECT COUNT(*) AS n FROM owner_jobs').get().n,
    patches: handle.prepare('SELECT COUNT(*) AS n FROM owner_patch_proposals').get().n,
    evidence: handle.prepare('SELECT COUNT(*) AS n FROM owner_sandbox_evidence').get().n
  });
  try {
    const store = new OwnerStore(dbPath);
    try {
      createPassingProject({ store, root: path.join(tmp, 'repo'), projectId, name: 'Real' });
      const before = listExecutionRecords({ ownerStore: store, projectId });
      assert.equal(before.total, 1);
      assert.deepEqual(before.records.map((record) => record.source), ['sandbox']);
    } finally {
      store.close();
    }

    const probe = new DatabaseSync(dbPath);
    const tablesBefore = tablesOf(probe);
    const countsBefore = countsOf(probe);
    // 产品还没有「删除项目」入口，这里直接删项目行来模拟删除；先关外键，
    // 名下的运行/作业/补丁会作为孤儿行留在库里，正是投影必须忽略的情形。
    probe.exec(`PRAGMA foreign_keys=OFF; DELETE FROM owner_projects WHERE id='${projectId}'`);
    const orphanRuns = probe.prepare('SELECT COUNT(*) AS n FROM owner_sandbox_runs WHERE project_id=?')
      .get(projectId).n;
    probe.close();
    assert.ok(orphanRuns > 0, '前提：删除项目后库里确实留下了孤儿行');

    const reopened = new OwnerStore(dbPath);
    try {
      const after = listExecutionRecords({ ownerStore: reopened, projectId });
      assert.deepEqual(after, { projectId, records: [], total: 0, truncated: false });
    } finally {
      reopened.close();
    }

    const verify = new DatabaseSync(dbPath);
    try {
      assert.deepEqual(tablesOf(verify), tablesBefore, '读取不应新增数据库表');
      assert.deepEqual(countsOf(verify), countsBefore, '读取不应写库');
    } finally {
      verify.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
