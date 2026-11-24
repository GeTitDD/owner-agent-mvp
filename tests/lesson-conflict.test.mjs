// 冲突与争议（#57）：域级覆盖项目级、同级不同对策标争议、争议不进已验证优先序、裁决留入口。
// 只断言外部行为：内存库 + 假 owner store；不联网、不调真实模型、不起 Electron。
import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { LessonDistiller } from '../src/knowledge-loop/lesson.mjs';
import { retrieveLessons } from '../src/knowledge-loop/retrieval.mjs';

// 假 owner store：检索只问它「这个项目的主域是什么」。
const fakeOwner = ({
  projects = {
    p1: { id: 'p1', name: 'P1', primary_domain: 'software-engineering' },
    p2: { id: 'p2', name: 'P2', primary_domain: 'software-engineering' }
  }
} = {}) => ({
  getProject: (id) => projects[id] ?? null,
  listProjects: () => Object.values(projects)
});

// 「已验证」还没落库（表的 CHECK 只允许 unverified / inferred）；排序用桩 store 断言，
// 不绕过真实库的约束去造一个还不存在的状态。
const stubStore = (rows) => ({
  listLessons: ({ projectId = '', limit = 100 } = {}) =>
    rows.filter((row) => !projectId || row.projectId === projectId).slice(0, limit),
  lessonSupport: () => ({ records: 1, evidence: 1 })
});

const evidence = (ref) => [{ ref, recordId: ref, kind: 'record', excerpt: 'test=fail' }];

const lesson = (overrides = {}) => ({
  projectId: 'p1',
  sourceRecordId: 'sandbox:run1',
  phenomenon: 'retry 循环少跑一次，最后一次重试不执行',
  mechanism: 'for 循环写成 i < attempts - 1',
  countermeasure: '改成 i < attempts，并用同一条断言复跑测试',
  scope: { layer: 'project', projectId: 'p1', domainIds: ['software-engineering'] },
  verificationStatus: 'unverified',
  evidenceRefs: ['sandbox:run1'],
  createdAt: '2026-02-01T00:00:00.000Z',
  ...overrides
});

const domainLesson = (overrides = {}) => lesson({
  projectId: 'p2',
  sourceRecordId: 'sandbox:run9',
  scope: { layer: 'domain', projectId: null, domainIds: ['software-engineering'] },
  evidenceRefs: ['sandbox:run9'],
  createdAt: '2026-02-02T00:00:00.000Z',
  ...overrides
});

// 同一现象、同一作用域、不同对策：这是「争议」的最小形态。
const conflictingLesson = (overrides = {}) => lesson({
  sourceRecordId: 'sandbox:run2',
  countermeasure: '改成 while 循环直到成功，并加最大尝试次数上限',
  createdAt: '2026-02-03T00:00:00.000Z',
  ...overrides
});

test('域级覆盖项目级：默认查询只给域级，被覆盖的项目级仍可单查', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const projectLesson = personal.recordLesson(lesson(), { evidence: evidence('sandbox:run1') });
    const domain = personal.addLesson(
      domainLesson({ countermeasure: '把重试次数与退避写成显式常量，并在 CI 里断言总耗时' }),
      { evidence: evidence('sandbox:run9') }
    );

    // 默认查询（域级优先）：只给域级那条。
    const view = personal.listEffectiveLessons({ projectId: 'p1', domainIds: ['software-engineering'] });
    assert.deepEqual(view.effective.map((item) => item.id), [domain.id]);
    assert.deepEqual(view.overridden.map((item) => item.id), [projectLesson.id]);
    assert.equal(view.overridden[0].overriddenBy, domain.id);
    assert.equal(view.overridden[0].sameCountermeasure, false, '对策不同才算真冲突');

    // 被覆盖的项目级不删不藏：单查仍在。
    assert.deepEqual(personal.listLessons({ projectId: 'p1' }).map((item) => item.id), [projectLesson.id]);
    assert.ok(personal.listLessonsForProject('p1').some((item) => item.id === projectLesson.id));

    // 对话检索同样以域级为准，但仍把被覆盖的那条带回来（不丢、可追溯）。
    const result = retrieveLessons({ personalStore: personal, ownerStore: fakeOwner(), projectId: 'p1' });
    assert.deepEqual(result.items.map((item) => item.id), [domain.id]);
    assert.equal(result.items[0].layer, 'domain');
    assert.deepEqual(result.overridden.map((item) => item.id), [projectLesson.id]);
    assert.equal(result.counts.overridden, 1);
  } finally { personal.close(); }
});

test('同一作用域内对策不同：两条都标争议，不自动合并、不自动择一', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const first = personal.recordLesson(lesson(), { evidence: evidence('sandbox:run1') });
    const second = personal.recordLessonOrDispute(conflictingLesson(), { evidence: evidence('sandbox:run2') });

    const rows = personal.listLessons({ projectId: 'p1' });
    assert.equal(rows.length, 2, '对策不同不能当成同一条经验的证据');
    assert.notEqual(first.id, second.id);

    for (const [id, otherId] of [[first.id, second.id], [second.id, first.id]]) {
      const dispute = personal.lessonDispute(id);
      assert.equal(dispute.status, 'disputed');
      assert.equal(dispute.disputed, true);
      assert.ok(dispute.peerIds.includes(otherId), '争议双方互为对立方');
      assert.equal(personal.lessonStatus(id), 'disputed', '争议优先于验证状态参与排序');
    }
    // 对策各自保留：不自动覆盖、不自动择一。
    assert.equal(new Set(rows.map((row) => row.countermeasure)).size, 2);

    const groups = personal.lessonConflicts({ projectId: 'p1' });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].lessonIds.length, 2);
    assert.equal(new Set(groups[0].countermeasures).size, 2);
    assert.equal(groups[0].disputed, true);

    const view = personal.listEffectiveLessons({ projectId: 'p1', domainIds: ['software-engineering'] });
    assert.deepEqual(view.effective.map((item) => item.effectiveStatus), ['disputed', 'disputed']);
  } finally { personal.close(); }
});

test('争议不参与已验证优先排序，也不会被当成已验证引用', () => {
  const rows = [
    // 争议条目故意带着旧状态 verified：检索必须按争议处理，排最后。
    {
      ...lesson({ sourceRecordId: 'sandbox:1', phenomenon: '争议但曾经验证过的现象' }),
      id: 'l-disputed', verificationStatus: 'verified',
      dispute: { status: 'disputed', peerIds: ['l-other'], openedAt: '2026-02-10T00:00:00.000Z' }
    },
    { ...lesson({ sourceRecordId: 'sandbox:2', phenomenon: '待验证的现象' }), id: 'l-unverified' },
    { ...lesson({ sourceRecordId: 'sandbox:3', phenomenon: '已验证的现象' }), id: 'l-verified', verificationStatus: 'verified' }
  ];

  const result = retrieveLessons({ personalStore: stubStore(rows), ownerStore: fakeOwner(), projectId: 'p1' });

  assert.deepEqual(result.items.map((item) => item.id), ['l-verified', 'l-unverified', 'l-disputed']);
  assert.deepEqual(result.items.map((item) => item.verificationStatus), ['verified', 'unverified', 'disputed']);
  assert.equal(result.items[2].statusLabel, '争议', '争议要显式标注，不能被读成已验证');
});

test('裁决：标某条为准，另一条落为已被取代，两条都还在库里', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const first = personal.recordLesson(lesson(), { evidence: evidence('sandbox:run1') });
    const second = personal.recordLessonOrDispute(conflictingLesson(), { evidence: evidence('sandbox:run2') });

    const resolved = personal.resolveLessonDispute(first.id, second.id, { actor: 'owner', note: '以第一次复跑结果为准' });
    assert.equal(resolved.winner.id, first.id);
    assert.equal(resolved.loser.id, second.id);

    assert.equal(personal.lessonDispute(first.id).status, 'resolved');
    assert.equal(personal.lessonDispute(second.id).status, 'superseded');
    assert.equal(personal.getLesson(second.id).supersededBy, first.id);
    assert.equal(personal.lessonStatus(second.id), 'superseded');
    assert.equal(personal.lessonStatus(first.id), 'unverified', '裁决不等于自动验证');

    // 被取代的一条不删不藏，仍可单独查到。
    assert.equal(personal.listLessons({ projectId: 'p1' }).length, 2);
    assert.ok(personal.listLessonsForProject('p1').some((item) => item.id === second.id));

    // 默认检索不再把已被取代的那条当建议，但把它列在 superseded 里。
    const result = retrieveLessons({ personalStore: personal, ownerStore: fakeOwner(), projectId: 'p1' });
    assert.deepEqual(result.items.map((item) => item.id), [first.id]);
    assert.deepEqual(result.superseded.map((item) => item.id), [second.id]);

    // 裁决之后不再算待裁决冲突。
    assert.deepEqual(personal.lessonConflicts({ projectId: 'p1' }), []);
  } finally { personal.close(); }
});

test('提炼管线：同现象同作用域换了对策，两条都标争议等裁决', async () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  // 提炼只问 owner store 要项目主域；执行记录用字面量，不建真仓库。
  const owner = { getProject: () => ({ primary_domain: 'software-engineering' }) };
  const record = (id) => ({ id, projectId: 'p1', status: 'failed', testStatus: 'failed', evidenceRefs: [id] });
  const draft = (countermeasure) => ({ record }) => ({
    phenomenon: 'retry 循环少跑一次，最后一次重试不执行',
    mechanism: 'for 循环写成 i < attempts - 1',
    countermeasure,
    evidenceRefs: [record.id]
  });
  try {
    const first = new LessonDistiller({ ownerStore: owner, personalStore: personal, extractor: draft('改成 i < attempts') });
    const firstRun = await first.distillRecord(record('sandbox:run1'));
    assert.equal(firstRun.ok, true);

    const second = new LessonDistiller({
      ownerStore: owner, personalStore: personal,
      extractor: draft('改成 while 循环直到成功，并加最大尝试次数上限')
    });
    const secondRun = await second.distillRecord(record('sandbox:run2'));
    assert.equal(secondRun.ok, true);

    const rows = personal.listLessons({ projectId: 'p1' });
    assert.equal(rows.length, 2, '对策不同不能被静默并进第一条经验');
    for (const row of rows) {
      assert.equal(personal.lessonDispute(row.id).status, 'disputed');
    }
  } finally { personal.close(); }
});

test('同现象不同作用域不算同级争议：跨项目复现与域级覆盖都不标争议', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const p1 = personal.recordLesson(lesson(), { evidence: evidence('sandbox:run1') });
    const p2 = personal.recordLesson(lesson({
      projectId: 'p2',
      sourceRecordId: 'sandbox:run2',
      scope: { layer: 'project', projectId: 'p2', domainIds: ['software-engineering'] },
      countermeasure: '属于另一个项目的对策，不是同级冲突'
    }), { evidence: evidence('sandbox:run2') });
    const domain = personal.addLesson(domainLesson({ countermeasure: '域级对策' }), { evidence: evidence('sandbox:run9') });

    assert.deepEqual(personal.lessonConflicts(), [], '不同作用域各管各的，不标争议');
    assert.equal(personal.lessonDispute(p1.id).status, 'none');
    assert.equal(personal.lessonDispute(p2.id).status, 'none');
    assert.equal(personal.lessonDispute(domain.id).status, 'none');

    // 域级覆盖只作用于同一批现象，且项目级仍单独可查。
    const view = personal.listEffectiveLessons({ projectId: 'p1', domainIds: ['software-engineering'] });
    assert.deepEqual(view.effective.map((item) => item.id), [domain.id]);
    assert.deepEqual(view.overridden.map((item) => item.id), [p1.id]);
  } finally { personal.close(); }
});
