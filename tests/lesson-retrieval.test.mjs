// 经验检索（对话用）：先按当前项目取项目级经验，再补域级经验。
// 这里只断言外部行为：给一个内存库 + 假 owner store，看检索返回什么。
// 不联网、不调真实模型、不起 Electron。
import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { retrieveLessons } from '../src/knowledge-loop/retrieval.mjs';

// 假 owner store：检索只问它「这个项目的主域是什么」，其余一律不碰。
const fakeOwner = ({
  projects = { p1: { id: 'p1', name: 'P1', primary_domain: 'software-engineering' } }
} = {}) => ({
  getProject: (id) => projects[id] ?? null,
  listProjects: () => Object.values(projects)
});

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

// 当前表的 CHECK 只允许 unverified / inferred：「已验证」要等 #57 的人工确认落地。
// 那条路径用桩 store 断言，不绕过真实库的约束去造一个还不存在的状态。
const stubStore = (rows) => ({
  listLessons: ({ projectId = '', limit = 100 } = {}) =>
    rows.filter((row) => !projectId || row.projectId === projectId).slice(0, limit),
  lessonSupport: () => ({ records: 1, evidence: 1 })
});

test('项目级先取、域级补齐：两条都能取到，项目级排在同状态的域级前面', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const projectLesson = personal.recordLesson(lesson(), {
      evidence: [{ ref: 'sandbox:run1', recordId: 'sandbox:run1', kind: 'record', excerpt: 'test=fail' }]
    });
    const domainLesson = personal.addLesson(lesson({
      projectId: 'p2',
      sourceRecordId: 'sandbox:run9',
      phenomenon: '集成测试超时多半是 retry 退避上限太大',
      scope: { layer: 'domain', projectId: null, domainIds: ['software-engineering'] },
      evidenceRefs: ['sandbox:run9'],
      createdAt: '2026-02-02T00:00:00.000Z'
    }), {
      evidence: [{ ref: 'sandbox:run9', recordId: 'sandbox:run9', kind: 'record', excerpt: 'exit=124' }]
    });

    const result = retrieveLessons({ personalStore: personal, ownerStore: fakeOwner(), projectId: 'p1' });

    assert.equal(result.items.length, 2, '项目级与域级都要取到');
    assert.deepEqual(result.items.map((item) => item.layer), ['project', 'domain'], '同状态时项目级在前，域级后补');
    assert.deepEqual(result.items.map((item) => item.id), [projectLesson.id, domainLesson.id]);
    assert.equal(result.counts.project, 1);
    assert.equal(result.counts.domain, 1);
    assert.equal(result.reason, null);
    // 域级经验按域 ID 补，不是按项目：p2 的域级经验也得补给 p1。
    assert.equal(result.items[1].domainIds[0], 'software-engineering');
    assert.equal(result.domain, 'software-engineering', '没传域时从 owner store 的项目主域推出来');
  } finally { personal.close(); }
});

test('待验证带标注排在推断前，项目级先于域级；每条带证据条数', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const inferred = personal.addLesson(lesson({
      sourceRecordId: 'sandbox:a', phenomenon: '推断出来的现象', verificationStatus: 'inferred',
      evidenceRefs: [], createdAt: '2026-02-05T00:00:00.000Z'
    }));
    const unverified = personal.recordLesson(lesson({
      sourceRecordId: 'sandbox:b', phenomenon: '待验证的现象', createdAt: '2026-02-04T00:00:00.000Z'
    }), { evidence: [{ ref: 'sandbox:b', recordId: 'sandbox:b', kind: 'record', excerpt: 'test=fail' }] });
    const domainUnverified = personal.addLesson(lesson({
      projectId: 'p2', sourceRecordId: 'sandbox:c', phenomenon: '域级的待验证现象',
      scope: { layer: 'domain', projectId: null, domainIds: ['software-engineering'] },
      evidenceRefs: ['sandbox:c'], createdAt: '2026-02-03T00:00:00.000Z'
    }), { evidence: [{ ref: 'sandbox:c', recordId: 'sandbox:c', kind: 'record', excerpt: 'exit=1' }] });

    const result = retrieveLessons({ personalStore: personal, ownerStore: fakeOwner(), projectId: 'p1' });

    assert.deepEqual(
      result.items.map((item) => item.verificationStatus),
      ['unverified', 'unverified', 'inferred'],
      '待验证 → 推断；同状态时项目级先于域级'
    );
    assert.deepEqual(result.items.map((item) => item.id), [unverified.id, domainUnverified.id, inferred.id]);
    // 状态标注跟结果一起返回：模型能说「这是待验证的」而不是当成定论。
    assert.deepEqual(result.items.map((item) => item.statusLabel), ['待验证', '待验证', '推断']);
    // 证据条数：让模型能表达「被 1 次执行支撑」。
    assert.equal(result.items[0].evidenceCount, 1);
    assert.equal(result.items[0].supportCount, 1);
    assert.equal(result.items[2].evidenceCount, 0, '推断没有可追证据');
  } finally { personal.close(); }
});

test('已验证排最前：状态由 #57 的人工确认写入，检索只按状态排序', () => {
  const rows = [
    // 顺序故意打乱：检索必须靠状态与作用域重排，不靠插入顺序。
    { ...lesson({ sourceRecordId: 'sandbox:1', phenomenon: '推断的现象', verificationStatus: 'inferred' }), id: 'l-inferred', scope: { layer: 'project', projectId: 'p1', domainIds: ['software-engineering'] } },
    { ...lesson({ sourceRecordId: 'sandbox:2', phenomenon: '域级待验证的现象' }), id: 'l-domain-unverified', scope: { layer: 'domain', projectId: null, domainIds: ['software-engineering'] } },
    { ...lesson({ sourceRecordId: 'sandbox:3', phenomenon: '已验证的现象', verificationStatus: 'verified' }), id: 'l-verified', scope: { layer: 'project', projectId: 'p1', domainIds: ['software-engineering'] } },
    { ...lesson({ sourceRecordId: 'sandbox:4', phenomenon: '项目级待验证的现象' }), id: 'l-project-unverified', scope: { layer: 'project', projectId: 'p1', domainIds: ['software-engineering'] } }
  ];
  const result = retrieveLessons({ personalStore: stubStore(rows), ownerStore: fakeOwner(), projectId: 'p1' });

  assert.deepEqual(
    result.items.map((item) => item.verificationStatus),
    ['verified', 'unverified', 'unverified', 'inferred'],
    '已验证优先；同状态时项目级先于域级'
  );
  assert.deepEqual(
    result.items.map((item) => item.statusLabel),
    ['已验证', '待验证', '待验证', '推断']
  );
});

test('关键词过滤大小写不敏感，机制与对策也参与匹配', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    personal.recordLesson(lesson({ sourceRecordId: 'sandbox:x' }), {
      evidence: [{ ref: 'sandbox:x', recordId: 'sandbox:x', kind: 'record', excerpt: 'not ok 1' }]
    });
    personal.recordLesson(lesson({
      sourceRecordId: 'sandbox:y',
      phenomenon: '集成测试超时',
      mechanism: 'RETRY 退避上限调到 30s，超过了 CI 的 20s 超时',
      countermeasure: '退避上限改回 5s'
    }), { evidence: [{ ref: 'sandbox:y', recordId: 'sandbox:y', kind: 'record', excerpt: 'timeout' }] });

    const upper = retrieveLessons({ personalStore: personal, projectId: 'p1', query: 'RETRY 循环' });
    assert.equal(upper.items.length, 1, '英文关键词大小写不敏感');
    assert.match(upper.items[0].phenomenon, /retry/u);

    const lower = retrieveLessons({ personalStore: personal, projectId: 'p1', query: 'retry 循环' });
    assert.equal(lower.items.length, 1);
    assert.equal(lower.items[0].id, upper.items[0].id);

    const mechanism = retrieveLessons({ personalStore: personal, projectId: 'p1', query: 'CI 的 20s 超时' });
    assert.equal(mechanism.items.length, 1, '机制里的词也能命中');
    assert.equal(mechanism.items[0].phenomenon, '集成测试超时');

    const chinese = retrieveLessons({ personalStore: personal, projectId: 'p1', query: '退避上限' });
    assert.equal(chinese.items.length, 1, '中文关键词照常过滤');
    assert.equal(chinese.counts.project, 2, 'counts 是过滤前的条数');
  } finally { personal.close(); }
});

test('证据条数按执行记录去重：同一现象两次执行 = 2 条记录、2 条证据', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const first = personal.recordLesson(lesson({ sourceRecordId: 'sandbox:run1' }), {
      evidence: [{ ref: 'sandbox:run1', recordId: 'sandbox:run1', kind: 'record', excerpt: 'test=fail' }]
    });
    personal.recordLesson(lesson({ sourceRecordId: 'sandbox:run2' }), {
      evidence: [{ ref: 'sandbox:run2', recordId: 'sandbox:run2', kind: 'record', excerpt: 'test=fail' }]
    });

    const result = retrieveLessons({ personalStore: personal, projectId: 'p1' });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].id, first.id);
    assert.equal(result.items[0].supportCount, 2);
    assert.equal(result.items[0].evidenceCount, 2);
  } finally { personal.close(); }
});

test('无匹配时说清原因：没项目 / 项目还没提炼过 / 没有这类经验', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    // 1) 没有项目：项目级无从取，域也没给。
    const noProject = retrieveLessons({ personalStore: personal, ownerStore: fakeOwner(), projectId: '' });
    assert.deepEqual(noProject.items, []);
    assert.equal(noProject.reason.code, 'no-project');
    assert.match(noProject.reason.message, /项目/u);

    // 2) 项目里有执行记录但从没提炼过：空结果 + 「还没提炼过」。
    const notDistilled = retrieveLessons({ personalStore: personal, ownerStore: fakeOwner(), projectId: 'p1' });
    assert.deepEqual(notDistilled.items, []);
    assert.equal(notDistilled.reason.code, 'project-not-distilled');
    assert.match(notDistilled.reason.message, /还没提炼过/u);

    // 3) 项目已经提炼过，只是没有这一类：空结果 + 「没有这类经验」，并带上已有条数。
    personal.recordLesson(lesson({ sourceRecordId: 'sandbox:z' }), {
      evidence: [{ ref: 'sandbox:z', recordId: 'sandbox:z', kind: 'record', excerpt: 'test=fail' }]
    });
    const noMatch = retrieveLessons({ personalStore: personal, projectId: 'p1', query: '数据库迁移' });
    assert.deepEqual(noMatch.items, []);
    assert.equal(noMatch.reason.code, 'no-matching-lesson');
    assert.match(noMatch.reason.message, /数据库迁移/u);
    assert.match(noMatch.reason.message, /1 条/u, '原因里要写清已有多少条，人才知道是「没这类」而不是「没有经验」');
  } finally { personal.close(); }
});

test('limit 只裁剪结果，不影响计数，也不改变排序', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    for (const [index, id] of ['sandbox:1', 'sandbox:2', 'sandbox:3'].entries()) {
      personal.recordLesson(lesson({ sourceRecordId: id, phenomenon: `现象 ${id}` }), {
        evidence: [{ ref: id, recordId: id, kind: 'record', excerpt: `run ${index}` }]
      });
    }
    const result = retrieveLessons({ personalStore: personal, projectId: 'p1', limit: 2 });
    assert.equal(result.items.length, 2);
    assert.equal(result.counts.matched, 2);
    assert.equal(result.counts.project, 3);
    assert.throws(() => retrieveLessons({ personalStore: personal, projectId: 'p1', limit: 0 }), /limit/u);
  } finally { personal.close(); }
});
