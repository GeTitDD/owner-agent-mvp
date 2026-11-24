// 经验（Lesson）：把一条执行记录提炼成「现象 → 机制 → 对策」，并保留能追回该记录的证据引用。
// 这里只断言外部行为：给定 owner store 里有什么、提炼器返回什么，库里就应该出现什么。
// 提炼器一律用假的，不联网、不调真实模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { OwnerStore } from '../src/owner-store.mjs';
import { LessonDistiller } from '../src/knowledge-loop/lesson.mjs';
import { LESSON_CONTRACT } from '../src/knowledge-loop/contracts.mjs';
import { createPassingProject } from '../scripts/knowledge-loop/fixtures.mjs';

// 与 tests/knowledge-loop.test.mjs 的 fakeOwner 同形；补上执行记录投影需要的补丁列表与补丁产物。
const fakeOwner = ({
  projects = { p1: { id: 'p1', name: 'P1', primary_domain: 'software-engineering' } },
  runs = {}, jobs = {}, tasks = {}, patches = {}, evidence = {}, artifacts = {}
} = {}) => ({
  getProject: (id) => projects[id] ?? null,
  listSandboxRuns: ({ projectId }) => Object.values(runs).filter((run) => run.project_id === projectId),
  getSandboxRun: (id) => (runs[id] ? { evidence: [], exit_code: null, ...runs[id] } : null),
  listJobs: ({ projectId }) => Object.values(jobs).filter((job) => job.project_id === projectId),
  getJob: (id) => jobs[id] ?? null,
  listPatchProposals: ({ projectId }) => Object.values(patches).filter((patch) => patch.project_id === projectId),
  getPatchProposal: (id) => patches[id] ?? null,
  getTask: (id) => tasks[id] ?? null,
  getSandboxEvidence: (runId, kind) => evidence[`${runId}:${kind}`] ?? null,
  getPatchArtifactContent: (id, kind) => artifacts[`${id}:${kind}`] ?? null
});

const sandbox = (id, overrides = {}) => ({
  id, project_id: 'p1', job_id: 'job1', proposal_id: 'patch1', status: 'failed',
  execution_status: 'completed', test_status: 'fail', exit_code: 1, profile_id: 'node-smoke',
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

const task = (id) => ({ id, project_id: 'p1', title: '修好重试测试' });

const diff = [
  '--- a/src/retry.js',
  '+++ b/src/retry.js',
  '@@ -1,1 +1,1 @@',
  '-  for (let i = 0; i < attempts - 1; i += 1) {',
  '+  for (let i = 0; i < attempts; i += 1) {'
].join('\n');

const buildOwner = () => fakeOwner({
  runs: { run1: sandbox('run1') },
  jobs: { job1: job('job1') },
  tasks: { task1: task('task1') },
  patches: { patch1: patch('patch1') },
  evidence: {
    'run1:stdout': { content: 'not ok 1 - withRetry uses all attempts' },
    'run1:stderr': { content: 'AssertionError: expected 3 retries, saw 2' }
  },
  artifacts: { 'patch1:proposal_diff': diff }
});

const draft = (overrides = {}) => ({
  phenomenon: '  Retry loop   leaves the last attempt unused. ',
  mechanism: 'for 循环写成 i < attempts - 1，最后一次重试永远不会执行',
  countermeasure: '改成 i < attempts，并用同一条断言复跑测试确认次数',
  evidenceRefs: ['evidence:run1:stderr', 'sandbox:run1', 'patch:patch1'],
  ...overrides
});

test('给定执行记录与假提炼器，提炼出一条字段齐全的经验', async () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const owner = buildOwner();
    let seen = null;
    const extractor = ({ record, evidence }) => {
      seen = { record, evidence };
      return draft();
    };
    const distiller = new LessonDistiller({
      ownerStore: owner, personalStore: personal, extractor,
      clock: () => '2026-02-02T00:00:00.000Z'
    });
    // 执行记录不会因为读取而落表，队列本身是投影结果。
    assert.deepEqual(distiller.queue({ projectId: 'p1' }).records.map((item) => item.id), ['sandbox:run1']);

    const result = await distiller.distill({ projectId: 'p1' });
    assert.equal(result.attempted, 1);
    assert.equal(result.lessons.length, 1);
    assert.equal(result.failed.length, 0);

    // 提炼输入是执行记录 + 它引用的证据：失败日志、diff 摘要、测试退出码都在里面。
    assert.equal(seen.record.id, 'sandbox:run1');
    const refs = seen.evidence.map((item) => item.ref);
    for (const ref of ['sandbox:run1', 'evidence:run1:stdout', 'evidence:run1:stderr', 'job:job1', 'patch:patch1']) {
      assert.ok(refs.includes(ref), `提炼输入缺少证据 ${ref}`);
    }
    assert.match(seen.evidence.find((item) => item.ref === 'sandbox:run1').excerpt, /exit=1/u);
    assert.match(seen.evidence.find((item) => item.ref === 'evidence:run1:stderr').excerpt, /expected 3 retries/u);
    assert.match(seen.evidence.find((item) => item.ref === 'patch:patch1').excerpt, /attempts/u);

    const lesson = result.lessons[0];
    assert.equal(lesson.contract, LESSON_CONTRACT);
    // 现象是规范化后的短句：压平空白、去掉句末标点。
    assert.equal(lesson.phenomenon, 'Retry loop leaves the last attempt unused');
    assert.equal(lesson.mechanism, 'for 循环写成 i < attempts - 1，最后一次重试永远不会执行');
    assert.equal(lesson.countermeasure, '改成 i < attempts，并用同一条断言复跑测试确认次数');
    assert.equal(lesson.projectId, 'p1');
    assert.equal(lesson.sourceRecordId, 'sandbox:run1');
    assert.deepEqual(lesson.scope, { layer: 'project', projectId: 'p1', domainIds: ['software-engineering'] });
    assert.equal(lesson.verificationStatus, 'unverified');
    assert.equal(lesson.createdAt, '2026-02-02T00:00:00.000Z');
    assert.ok(lesson.dedupeKey, '经验需要「现象 + 作用域」派生的去重键');
    assert.equal(personal.listLessons({ projectId: 'p1' }).length, 1);

    // 已经提炼过的执行记录不再留在待提炼队列，重跑不会重复造经验。
    assert.equal(distiller.queue({ projectId: 'p1' }).records.length, 0);
    const again = await distiller.distill({ projectId: 'p1' });
    assert.equal(again.attempted, 0);
    assert.equal(personal.listLessons({ projectId: 'p1' }).length, 1);
  } finally { personal.close(); }
});

test('证据引用指回具体的执行记录，并落进证据表', async () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const distiller = new LessonDistiller({
      ownerStore: buildOwner(), personalStore: personal, extractor: () => draft()
    });
    const [lesson] = (await distiller.distill({ projectId: 'p1' })).lessons;
    const stored = personal.getLesson(lesson.id);
    assert.ok(Array.isArray(stored.evidence) && stored.evidence.length > 0, '经验必须带证据行');
    for (const row of stored.evidence) {
      assert.equal(row.recordId, 'sandbox:run1', '证据必须指回这次执行记录');
      assert.ok(
        // 允许的引用都来自这条执行记录自己的证据清单（sandbox + 证据片段 + 补丁）。
        ['sandbox:run1', 'evidence:run1:stdout', 'evidence:run1:stderr', 'patch:patch1'].includes(row.ref),
        `证据引用不可追踪：${row.ref}`
      );
      assert.ok(row.excerpt.length > 0, '证据行要保存可读片段');
    }
    assert.deepEqual(
      new Set(stored.evidenceRefs),
      new Set(stored.evidence.map((row) => row.ref)),
      '经验上的证据引用与证据表必须一致'
    );
    // 反查：这条执行记录只产出一条经验。
    const byRecord = personal.listLessons({ sourceRecordId: 'sandbox:run1' });
    assert.equal(byRecord.length, 1);
    assert.equal(byRecord[0].id, lesson.id);
  } finally { personal.close(); }
});

test('追不到证据的结论标为推断，不进入待验证候选', async () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const distiller = new LessonDistiller({
      ownerStore: buildOwner(), personalStore: personal,
      // 模型引用了一条别的项目的运行和一个不存在的补丁：都追不到本记录的证据。
      extractor: () => draft({ evidenceRefs: ['sandbox:run-other-project', 'patch:ghost'] })
    });
    const result = await distiller.distill({ projectId: 'p1' });
    const lesson = result.lessons[0];
    assert.equal(result.inferred, 1);
    assert.equal(lesson.verificationStatus, 'inferred');
    assert.deepEqual(lesson.evidenceRefs, []);
    assert.deepEqual(lesson.untraceableRefs.sort(), ['patch:ghost', 'sandbox:run-other-project']);
    assert.equal(personal.lessonEvidence(lesson.id).length, 0);
    assert.equal(personal.listLessons({ projectId: 'p1', verificationStatus: 'unverified' }).length, 0);
    assert.equal(personal.listLessons({ projectId: 'p1', verificationStatus: 'inferred' }).length, 1);

    // 模型干脆不写证据时同样只算推断，系统不会替它补来源。
    const silentPersonal = new PersonalKnowledgeStore(':memory:');
    try {
      const silent = new LessonDistiller({
        ownerStore: buildOwner(), personalStore: silentPersonal,
        extractor: () => draft({ evidenceRefs: [] })
      });
      const [inferred] = (await silent.distill({ projectId: 'p1' })).lessons;
      assert.equal(inferred.verificationStatus, 'inferred');
      assert.deepEqual(inferred.evidenceRefs, []);
    } finally { silentPersonal.close(); }
  } finally { personal.close(); }
});

test('提炼器抛错时返回明确原因，待提炼队列保持不变', async () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const distiller = new LessonDistiller({
      ownerStore: buildOwner(), personalStore: personal,
      extractor: () => { throw new Error('model offline'); }
    });
    const before = distiller.queue({ projectId: 'p1' }).records.map((item) => item.id);
    assert.deepEqual(before, ['sandbox:run1']);

    const result = await distiller.distill({ projectId: 'p1' });
    assert.equal(result.lessons.length, 0);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].recordId, 'sandbox:run1');
    assert.equal(result.failed[0].code, 'extractor-failed');
    assert.match(result.failed[0].reason, /model offline/u);
    assert.deepEqual(result.pending, before, '失败时待提炼队列必须原样保留');
    assert.deepEqual(distiller.queue({ projectId: 'p1' }).records.map((item) => item.id), before);
    assert.equal(personal.listLessons({ projectId: 'p1' }).length, 0);
  } finally { personal.close(); }
});

test('没有可注入的提炼器时明确拒绝，不写库也不丢队列', async () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const distiller = new LessonDistiller({ ownerStore: buildOwner(), personalStore: personal });
    const result = await distiller.distill({ projectId: 'p1' });
    assert.equal(result.lessons.length, 0);
    assert.equal(result.failed[0].code, 'extractor-unavailable');
    assert.match(result.failed[0].reason, /提炼器/u);
    assert.deepEqual(result.pending, ['sandbox:run1']);
    assert.equal(personal.listLessons().length, 0);
  } finally { personal.close(); }
});

test('真实 owner store 的 stdout、diff 摘要与测试退出码进入提炼输入', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-real-'));
  const projectId = 'lesson-project';
  const owner = new OwnerStore(path.join(tmp, 'owner.sqlite'));
  const personal = new PersonalKnowledgeStore(path.join(tmp, 'knowledge.sqlite'));
  try {
    const seeded = createPassingProject({ store: owner, root: path.join(tmp, 'repo'), projectId, name: 'Lesson' });
    let seenEvidence = [];
    const distiller = new LessonDistiller({
      ownerStore: owner, personalStore: personal,
      extractor: ({ evidence }) => {
        seenEvidence = evidence;
        return draft({
          phenomenon: 'retry 循环少跑一次，最后一次重试不执行',
          evidenceRefs: [`evidence:${seeded.runId}:stdout`, `patch:${seeded.patchId}`]
        });
      }
    });
    const result = await distiller.distill({ projectId });
    assert.equal(result.lessons.length, 1, '真实库里的一条流水线应提炼出一条经验');
    const lesson = result.lessons[0];
    assert.equal(lesson.sourceRecordId, `sandbox:${seeded.runId}`);
    assert.equal(lesson.verificationStatus, 'unverified');
    const stdout = seenEvidence.find((item) => item.ref === `evidence:${seeded.runId}:stdout`);
    assert.match(stdout?.excerpt ?? '', /ok 1 - withRetry uses all attempts/u);
    const runSummary = seenEvidence.find((item) => item.ref === `sandbox:${seeded.runId}`);
    assert.match(runSummary?.excerpt ?? '', /exit=0/u, '测试退出码必须进提炼输入');
    const patchSummary = seenEvidence.find((item) => item.ref === `patch:${seeded.patchId}`);
    assert.match(patchSummary?.excerpt ?? '', /i < attempts/u, '补丁 diff 摘要必须进提炼输入');
    assert.deepEqual(personal.getLesson(lesson.id).evidence.map((row) => row.recordId), [
      `sandbox:${seeded.runId}`, `sandbox:${seeded.runId}`
    ]);
  } finally {
    personal.close();
    owner.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
