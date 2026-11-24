// 沉淀去重与证据累加：同一现象在同一作用域再次被提炼时，只追加证据、不新增经验行。
// 比较用的是提炼时产出的规范化现象短句（压平空白、忽略大小写、去句末标点），不是整段文本。
// 这里只断言外部行为：给 owner store 造几条执行记录、喂一个假提炼器，看库里最后剩下什么。
// 提炼器一律用假的，不联网、不调真实模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { OwnerStore } from '../src/owner-store.mjs';
import { LessonDistiller } from '../src/knowledge-loop/lesson.mjs';
import { normalizeLesson } from '../src/knowledge-loop/contracts.mjs';
import { createSyntheticProject } from '../scripts/knowledge-loop/fixtures.mjs';

// 与 tests/lesson.test.mjs 的 fakeOwner 同形，只是多留一个项目位以便验证跨项目不合并。
const fakeOwner = ({
  projects = {
    p1: { id: 'p1', name: 'P1', primary_domain: 'software-engineering' },
    p2: { id: 'p2', name: 'P2', primary_domain: 'software-engineering' }
  },
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
  id, project_id: 'p1', job_id: `job-${id}`, proposal_id: `patch-${id}`, status: 'failed',
  execution_status: 'completed', test_status: 'fail', exit_code: 1, profile_id: 'node-smoke',
  evidence: [{ kind: 'stdout' }],
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

// 两条指向同一现象的执行记录：同一个项目里重试循环少跑一次，先后各失败一次。
const buildOwner = () => fakeOwner({
  runs: { run1: sandbox('run1'), run2: sandbox('run2') },
  jobs: { 'job-run1': job('job-run1'), 'job-run2': job('job-run2') },
  tasks: { task1: task('task1') },
  patches: { 'patch-run1': patch('patch-run1'), 'patch-run2': patch('patch-run2') },
  evidence: {
    'run1:stdout': { content: 'not ok 1 - withRetry uses all attempts' },
    'run2:stdout': { content: 'not ok 1 - withRetry uses all attempts' }
  }
});

// 提炼器的产出：现象是同一件事的不同写法（大小写、空白、句末标点都不同），表述可以不一样。
const draft = (phenomenon, recordId) => ({
  phenomenon,
  mechanism: 'for 循环写成 i < attempts - 1，最后一次重试永远不会执行',
  countermeasure: '改成 i < attempts，并用同一条断言复跑测试确认次数',
  // 只引用这次执行记录自身的摘要，保证证据一定能追回这条记录。
  evidenceRefs: [recordId]
});

test('同一现象两次提炼：经验行数为 1、证据数为 2、支持记录数为 2', async () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const owner = buildOwner();
    const distiller = new LessonDistiller({
      ownerStore: owner, personalStore: personal,
      extractor: ({ record }) => draft(
        record.id === 'sandbox:run1'
          ? '  Retry loop   leaves the last attempt unused. '
          : 'retry LOOP leaves the last attempt unused',
        record.id
      )
    });

    // 第一次提炼：库里只有一条执行记录，产出一条经验。
    const first = await distiller.distill({ projectId: 'p1', recordIds: ['sandbox:run1'] });
    assert.equal(first.lessons.length, 1);
    assert.equal(personal.listLessons({ projectId: 'p1' }).length, 1);

    // 第二次提炼：同一现象落在同一条经验上，不新增经验行。
    const second = await distiller.distill({ projectId: 'p1', recordIds: ['sandbox:run2'] });
    assert.equal(second.lessons.length, 1);
    assert.equal(second.lessons[0].id, first.lessons[0].id, '第二次提炼必须命中已有经验');

    const lessons = personal.listLessons({ projectId: 'p1' });
    assert.equal(lessons.length, 1, '同一现象同一作用域只留一条经验');
    const id = lessons[0].id;

    const evidence = personal.getLesson(id).evidence;
    assert.equal(evidence.length, 2, '两条执行记录各留下一条证据');
    assert.deepEqual(
      evidence.map((row) => row.recordId).sort(),
      ['sandbox:run1', 'sandbox:run2'],
      '证据必须分别指回两次执行'
    );

    // 「这条经验被多少条执行记录支持」：按证据指向的执行记录去重计数。
    const support = personal.lessonSupport(id);
    assert.equal(support.records, 2);
    assert.equal(support.evidence, 2);
    assert.deepEqual([...support.recordIds].sort(), ['sandbox:run1', 'sandbox:run2']);

    // 两条记录都算已提炼，队列不再把它们排进来。
    assert.deepEqual(distiller.queue({ projectId: 'p1' }).records.map((item) => item.id), []);

    // 经验上的证据引用与证据表保持一致，第二次的证据不会丢。
    const stored = personal.getLesson(id);
    assert.deepEqual(new Set(stored.evidenceRefs), new Set(['sandbox:run1', 'sandbox:run2']));
  } finally { personal.close(); }
});

test('同一条证据重复出现：幂等，不报错也不重复计数', async () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const distiller = new LessonDistiller({
      ownerStore: buildOwner(), personalStore: personal,
      extractor: ({ record }) => draft('Retry loop leaves the last attempt unused', record.id)
    });
    const [record] = distiller.queue({ projectId: 'p1' }).records;

    const first = await distiller.distillRecord(record);
    assert.equal(first.ok, true);
    // 同一条执行记录再提炼一次：命中同一条经验、同一条证据，什么都不该多出来。
    const again = await distiller.distillRecord(record);
    assert.equal(again.ok, true);
    assert.equal(again.lesson.id, first.lesson.id);

    const lesson = personal.getLesson(first.lesson.id);
    assert.equal(personal.listLessons({ projectId: 'p1' }).length, 1);
    assert.equal(lesson.evidence.length, 1, '重复证据不能再插一行');
    assert.equal(personal.lessonSupport(first.lesson.id).records, 1);
    assert.equal(personal.lessonSupport(first.lesson.id).evidence, 1);
  } finally { personal.close(); }
});

test('同一现象跨项目合并为一条经验，升域后仍是另一条作用域', async () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const phenomenon = 'Retry loop leaves the last attempt unused';
    // 两个项目出现同一现象：#56 起合并为一条经验并打「已复现」标记。
    const owner = fakeOwner({
      runs: {
        run1: sandbox('run1'),
        run9: sandbox('run9', { project_id: 'p2', job_id: 'job-run9', proposal_id: 'patch-run9' })
      },
      jobs: { 'job-run1': job('job-run1'), 'job-run9': job('job-run9', { project_id: 'p2' }) },
      tasks: { task1: task('task1') },
      patches: { 'patch-run1': patch('patch-run1'), 'patch-run9': patch('patch-run9', { project_id: 'p2' }) }
    });
    const distiller = new LessonDistiller({
      ownerStore: owner, personalStore: personal,
      extractor: ({ record }) => draft(phenomenon, record.id)
    });
    await distiller.distill({ projectId: 'p1' });
    const p1Only = personal.listLessons()[0];
    assert.equal(p1Only.reproduced, false, '只在一个项目出现时不打复现标记');
    await distiller.distill({ projectId: 'p2' });
    assert.equal(personal.listLessons({ projectId: 'p1' }).length, 1);
    // 合并后经验行只挂在最早的项目下；第二个项目靠来源台账反查（#56 的代价）。
    assert.equal(personal.listLessons({ projectId: 'p2' }).length, 0);
    assert.equal(personal.listLessons().length, 1, '同一现象跨项目只留一条经验');
    const merged = personal.getLesson(p1Only.id);
    assert.equal(merged.reproduced, true);
    assert.deepEqual(personal.lessonSources(merged.id).projects.sort(), ['p1', 'p2']);
    assert.deepEqual(personal.listLessonsForProject('p2').map((item) => item.id), [merged.id]);

    // 同一现象升到域层：去重键含作用域层，域层那条不会被当成项目级那条。
    const lessonDraft = {
      sourceRecordId: 'sandbox:run1',
      phenomenon,
      mechanism: 'for 循环写成 i < attempts - 1，最后一次重试永远不会执行',
      countermeasure: '改成 i < attempts，并用同一条断言复跑测试确认次数',
      verificationStatus: 'unverified',
      evidenceRefs: ['sandbox:run1'],
      createdAt: '2026-02-03T00:00:00.000Z'
    };
    const projectKey = normalizeLesson({
      ...lessonDraft, projectId: 'p1',
      scope: { layer: 'project', projectId: 'p1', domainIds: ['software-engineering'] }
    }).dedupeKey;
    const domainKey = normalizeLesson({
      ...lessonDraft, projectId: null,
      scope: { layer: 'domain', projectId: null, domainIds: ['software-engineering'] }
    }).dedupeKey;
    assert.notEqual(projectKey, domainKey, '作用域层不同，去重键必须不同');
    const p1Lesson = personal.listLessons({ projectId: 'p1' })[0];
    assert.equal(personal.lessonByDedupe(projectKey)?.id, p1Lesson.id);
    // 未升域前库里的去重键仍只按项目级算，域级键查不到东西。
    assert.equal(personal.lessonByDedupe(domainKey), null);
    // 升域后去重键换成域级键，项目级键不再命中。
    const promoted = personal.promoteLessonToDomain(merged.id, { domainIds: ['software-engineering'] });
    assert.equal(promoted.dedupeKey, domainKey);
    assert.equal(personal.lessonByDedupe(domainKey)?.id, merged.id);
  } finally { personal.close(); }
});

test('真实 owner store：失败与修复两条执行记录合并成一条经验', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-dedupe-'));
  const projectId = 'dedupe-project';
  const owner = new OwnerStore(path.join(tmp, 'owner.sqlite'));
  const personal = new PersonalKnowledgeStore(path.join(tmp, 'knowledge.sqlite'));
  try {
    // fixture 在同一项目里造出两条终态沙箱运行：先失败、再修复通过。
    const seeded = createSyntheticProject({ store: owner, root: path.join(tmp, 'repo'), projectId, name: 'Dedupe' });
    const distiller = new LessonDistiller({
      ownerStore: owner, personalStore: personal,
      extractor: ({ record }) => draft('retry 循环少跑一次，最后一次重试不执行', record.id)
    });
    const queued = distiller.queue({ projectId }).records.map((item) => item.id).sort();
    assert.deepEqual(queued, [`sandbox:${seeded.repairRunId}`, `sandbox:${seeded.sourceRunId}`].sort());

    const result = await distiller.distill({ projectId });
    assert.equal(result.attempted, 2);
    assert.equal(result.failed.length, 0);
    // 两次提炼命中同一条经验：返回的是同一条经验，而不是两条。
    assert.equal(new Set(result.lessons.map((lesson) => lesson.id)).size, 1);

    const lessons = personal.listLessons({ projectId });
    assert.equal(lessons.length, 1, '真实库里同一现象只留一条经验');
    assert.equal(lessons[0].evidence.length, 2);
    assert.equal(personal.lessonSupport(lessons[0].id).records, 2);
    assert.deepEqual(distiller.queue({ projectId }).records, [], '两条执行记录都算已提炼');
  } finally {
    personal.close();
    owner.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
