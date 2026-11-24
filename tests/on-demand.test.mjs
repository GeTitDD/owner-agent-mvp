// 按需提炼与阈值提议：提议只是一条信号，不提炼、不写库；只有被显式调用才动经验表。
// 阈值按「未提炼的执行记录条数」计，不按「同类现象」计——现象是提炼的产物，提炼前并不存在。
// 假 owner store 与 tests/knowledge-loop.test.mjs 的 fakeOwner 同形；提炼器一律用假的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { LessonDistiller } from '../src/knowledge-loop/lesson.mjs';
import {
  DISTILL_PROPOSAL_THRESHOLD,
  listDistillProposals,
  distillOnDemand
} from '../src/knowledge-loop/on-demand.mjs';

const fakeOwner = ({ projects = {}, runs = {} } = {}) => ({
  listProjects: () => Object.values(projects),
  getProject: (id) => projects[id] ?? null,
  listSandboxRuns: ({ projectId }) => Object.values(runs).filter((run) => run.project_id === projectId),
  getSandboxRun: (id) => runs[id] ?? null,
  // 本票只关心执行记录里的 run 主体，其余主体留空即可。
  listJobs: () => [],
  getJob: () => null,
  listPatchProposals: () => [],
  getPatchProposal: () => null,
  getTask: () => null,
  getSandboxEvidence: () => null,
  getPatchArtifactContent: () => null
});

const sandbox = (projectId, id) => ({
  id, project_id: projectId, job_id: `job-${id}`, proposal_id: `patch-${id}`,
  status: 'failed', execution_status: 'completed', test_status: 'fail', exit_code: 1,
  profile_id: 'node-smoke', evidence: [],
  created_at: '2026-02-01T00:00:00.000Z',
  finished_at: '2026-02-01T00:05:00.000Z',
  updated_at: '2026-02-01T00:05:00.000Z'
});

/** 由 [projectId, runId] 列表造一个只读 owner store：每个 run 投影成一条执行记录。 */
const ownerWith = (...specs) => {
  const projects = {};
  const runs = {};
  for (const [projectId, runId] of specs) {
    projects[projectId] ??= { id: projectId, name: projectId, primary_domain: 'software-engineering' };
    runs[runId] = sandbox(projectId, runId);
  }
  return fakeOwner({ projects, runs });
};

/** 假提炼器：每条记录产出一条可追回自己的经验，不联网。 */
const extractor = ({ record }) => ({
  phenomenon: `${record.id} 失败`,
  mechanism: '断言失败暴露了实现缺口',
  countermeasure: '按断言修正实现并复跑测试',
  evidenceRefs: [record.id]
});

const makeDistiller = (owner, personal, injected = extractor) => new LessonDistiller({
  ownerStore: owner, personalStore: personal, extractor: injected,
  clock: () => '2026-02-02T00:00:00.000Z'
});

/** 库里每张表的行数：提议查询前后必须逐表一致。 */
const tableCounts = (personal) => {
  const names = personal.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map((row) => row.name);
  return Object.fromEntries(names.map((name) => [
    name, personal.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n
  ]));
};

test('未提炼记录不足 3 条时不提议', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    assert.equal(DISTILL_PROPOSAL_THRESHOLD, 3);
    const distiller = makeDistiller(ownerWith(['p1', 'run1'], ['p1', 'run2']), personal);
    assert.deepEqual(listDistillProposals({ distiller }), []);
    assert.deepEqual(listDistillProposals({ distiller, projectId: 'p1' }), []);
  } finally { personal.close(); }
});

test('未提炼记录达到 3 条时提议，带项目与条数', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const owner = ownerWith(
      ['p1', 'run1'], ['p1', 'run2'], ['p1', 'run3'], ['p1', 'run4'],
      ['p2', 'run5'], ['p2', 'run6'], ['p2', 'run7'],
      ['p3', 'run8']
    );
    const distiller = makeDistiller(owner, personal);
    // 达到阈值的项目才有信号；条数多的排在前面，便于界面优先展示。
    assert.deepEqual(listDistillProposals({ distiller }), [
      { projectId: 'p1', count: 4 },
      { projectId: 'p2', count: 3 }
    ]);
    // 指定项目时只看这一个项目；不足 3 条的项目不返回。
    assert.deepEqual(listDistillProposals({ distiller, projectId: 'p2' }), [{ projectId: 'p2', count: 3 }]);
    assert.deepEqual(listDistillProposals({ distiller, projectId: 'p3' }), []);
    // 阈值可配：默认 3，调高到 4 时只剩 p1，调高到 5 时无人提议，调低到 1 时 p3 也提议。
    assert.deepEqual(listDistillProposals({ distiller, threshold: 4 }), [{ projectId: 'p1', count: 4 }]);
    assert.deepEqual(listDistillProposals({ distiller, threshold: 5 }), []);
    assert.deepEqual(listDistillProposals({ distiller, projectId: 'p3', threshold: 1 }), [
      { projectId: 'p3', count: 1 }
    ]);
  } finally { personal.close(); }
});

test('已提炼的记录不计入未提炼条数', async () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const distiller = makeDistiller(
      ownerWith(['p1', 'run1'], ['p1', 'run2'], ['p1', 'run3'], ['p1', 'run4']), personal
    );
    assert.deepEqual(listDistillProposals({ distiller }), [{ projectId: 'p1', count: 4 }]);

    // 把第 1 条记录提炼掉：剩下的未提炼记录只有 3 条，而且提议里不该再出现它。
    await distillOnDemand({ distiller, projectId: 'p1', recordIds: ['sandbox:run1'] });
    const pendingIds = distiller.queue({ projectId: 'p1' }).records.map((record) => record.id);
    assert.ok(!pendingIds.includes('sandbox:run1'));
    assert.equal(personal.lessonedRecordIds({ projectId: 'p1' }).includes('sandbox:run1'), true);
    assert.deepEqual(listDistillProposals({ distiller }), [{ projectId: 'p1', count: 3 }]);

    // 只剩 1 条未提炼时，提议消失。
    await distillOnDemand({ distiller, projectId: 'p1', recordIds: ['sandbox:run2', 'sandbox:run3'] });
    assert.deepEqual(listDistillProposals({ distiller }), []);
  } finally { personal.close(); }
});

test('查询提议不产生任何写入，也不调用提炼器', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const distiller = makeDistiller(
      ownerWith(['p1', 'run1'], ['p1', 'run2'], ['p1', 'run3']), personal,
      () => { throw new Error('提议查询不应调用提炼器'); }
    );
    const before = tableCounts(personal);
    for (const args of [
      {}, { projectId: 'p1' }, { threshold: 1 }, { threshold: 99 }, { projectId: 'p-missing' }
    ]) {
      listDistillProposals({ distiller, ...args });
    }
    // 建议存在，但库里一行没多：提议 ≠ 执行。
    assert.deepEqual(listDistillProposals({ distiller }), [{ projectId: 'p1', count: 3 }]);
    assert.equal(personal.listLessons().length, 0, '提议不能写出经验');
    assert.deepEqual(tableCounts(personal), before, '提议查询前后所有表行数必须一致');
  } finally { personal.close(); }
});

test('未被显式触发时不提炼，调用入口才提炼', async () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const distiller = makeDistiller(ownerWith(['p1', 'run1'], ['p1', 'run2'], ['p1', 'run3']), personal);
    // 有 3 条待提炼记录，也有可用提炼器，但没人调用入口就什么都不发生。
    assert.equal(distiller.queue({ projectId: 'p1' }).records.length, 3);
    assert.equal(personal.listLessons({ projectId: 'p1' }).length, 0);

    const result = await distillOnDemand({ distiller, projectId: 'p1' });
    assert.equal(result.attempted, 3);
    assert.equal(result.lessons.length, 3);
    assert.equal(personal.listLessons({ projectId: 'p1' }).length, 3);

    // 再次显式触发时队列已空，不会重复造经验。
    const again = await distillOnDemand({ distiller, projectId: 'p1' });
    assert.equal(again.attempted, 0);
    assert.equal(personal.listLessons({ projectId: 'p1' }).length, 3);
  } finally { personal.close(); }
});
