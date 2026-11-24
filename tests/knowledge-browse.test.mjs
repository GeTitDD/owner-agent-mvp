// 知识模式三层视图模型：候选 / 经验 / 知识。
// 待验证、已验证等状态只是条目上的徽章，不再是分组；计数分「当前项目」与「全部项目」两个口径。
import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { knowledgeBrowseFor, knowledgeBrowseView } from '../src/knowledge/browse.mjs';

const unit = ({ id, scope = 'project', projectId = 'p1', title = id, status = 'verified' }) => ({
  id, title, content: `${title} content`, kind: 'claim',
  scope, layer: scope === 'project' ? 'project' : 'applied', projectId,
  verificationStatus: status, revision: 1, tags: [],
  evidenceRefs: status === 'verified' ? [`evidence:${id}`] : [],
  updatedAt: `2026-11-2${id.slice(-1) || 1}T00:00:00.000Z`
});

const candidateRow = ({ id, projectIds = ['p1'], title = id, createdAt = '2026-11-20T00:00:00.000Z' }) => ({
  id,
  status: 'pending',
  created_at: createdAt,
  payload: {
    title, layer: 'project',
    projectId: projectIds.length ? projectIds[0] : null
  },
  meta: { contract: 'knowledge-candidate/v1', confidence: 0.6 }
});

const lessonRow = ({
  id, projectId = 'p1', layer = 'project', status = 'unverified',
  createdAt = '2026-11-21T00:00:00.000Z'
}) => ({
  id,
  projectId: layer === 'project' ? projectId : null,
  sourceRecordId: `sandbox:${id}`,
  phenomenon: `现象 ${id}`,
  mechanism: `机制 ${id}`,
  countermeasure: `对策 ${id}`,
  scope: { layer, projectId: layer === 'project' ? projectId : null, domainIds: ['software-engineering'] },
  verificationStatus: status,
  evidenceRefs: [`evidence:${id}`],
  evidence: [{ ref: `evidence:${id}`, recordId: `run-${id}` }],
  createdAt
});

const groupsByKey = (view) => Object.fromEntries(view.groups.map((group) => [group.key, group]));

const LAYER_KEYS = ['candidates', 'lessons', 'knowledge'];
const LAYER_LABELS = ['候选', '经验', '知识'];

test('三层顺序与中文标题固定：候选 / 经验 / 知识', () => {
  const view = knowledgeBrowseView({
    units: [unit({ id: 'u1' }), unit({ id: 'u2', title: '未验证', status: 'unverified' })],
    proposals: [candidateRow({ id: 'c1' })],
    lessons: [lessonRow({ id: 'l1' })]
  });
  assert.deepEqual(view.groups.map((group) => group.key), LAYER_KEYS);
  assert.deepEqual(view.groups.map((group) => group.label), LAYER_LABELS);
  assert.deepEqual(view.totals, { candidates: 1, lessons: 1, knowledge: 2, all: 4 });
  assert.deepEqual(groupsByKey(view).candidates.items.map((item) => item.id), ['c1']);
  assert.match(groupsByKey(view).candidates.items[0].detail, /待审核/u);
  assert.deepEqual(groupsByKey(view).lessons.items.map((item) => item.id), ['l1']);
  assert.equal(groupsByKey(view).knowledge.items.length, 2);
  assert.equal(view.empty, null);
  assert.deepEqual(view.emptyLayers, []);
});

test('待验证与已验证是同一层内的状态徽章，不是两个分组', () => {
  const view = knowledgeBrowseView({
    units: [unit({ id: 'u1' }), unit({ id: 'u2', status: 'unverified' })]
  });
  assert.deepEqual(view.groups.map((group) => group.label), LAYER_LABELS);
  const knowledge = groupsByKey(view).knowledge;
  assert.equal(knowledge.count, 2);
  const byId = Object.fromEntries(knowledge.items.map((item) => [item.id, item]));
  assert.equal(byId.u1.status, 'verified');
  assert.equal(byId.u1.badge, '已验证');
  assert.equal(byId.u2.status, 'unverified');
  assert.equal(byId.u2.badge, '待验证');
  // 状态词只出现在徽章与说明里，不再作为层名。
  assert.equal(view.groups.some((group) => group.label === '待验证知识'), false);
  assert.equal(view.groups.some((group) => group.label === '已验证知识'), false);
});

test('待重新验证与争议同样只是徽章', () => {
  const view = knowledgeBrowseView({
    units: [
      unit({ id: 'u1', status: 'needs_reverification' }),
      unit({ id: 'u2', status: 'disputed' })
    ]
  });
  const knowledge = groupsByKey(view).knowledge;
  const byId = Object.fromEntries(knowledge.items.map((item) => [item.id, item]));
  assert.equal(byId.u1.badge, '待重新验证');
  assert.equal(byId.u2.badge, '争议');
  assert.equal(view.groups.length, 3);
});

test('每层计数区分当前项目与全部项目', () => {
  const input = {
    units: [
      unit({ id: 'u1', projectId: 'p1' }),
      unit({ id: 'u2', projectId: 'p2' }),
      unit({ id: 'u3', scope: 'domain', projectId: null })
    ],
    proposals: [candidateRow({ id: 'c1', projectIds: ['p1'] }), candidateRow({ id: 'c2', projectIds: ['p2'] })],
    lessons: [lessonRow({ id: 'l1', projectId: 'p1' }), lessonRow({ id: 'l2', projectId: 'p2' })]
  };
  // 没选项目时「当前项目」就是「全部项目」，两个口径相等。
  const all = knowledgeBrowseView(input);
  assert.deepEqual(all.groups.map((group) => group.counts), [
    { project: 2, all: 2 },
    { project: 2, all: 2 },
    { project: 3, all: 3 }
  ]);
  assert.deepEqual(all.totals, { candidates: 2, lessons: 2, knowledge: 3, all: 7 });

  const p1 = knowledgeBrowseView({ ...input, projectId: 'p1' });
  assert.deepEqual(p1.groups.map((group) => group.counts), [
    { project: 1, all: 2 },
    { project: 1, all: 2 },
    { project: 1, all: 3 }
  ]);
  // count 是当前口径的条数，面板直接显示它。
  assert.deepEqual(p1.groups.map((group) => group.count), [1, 1, 1]);
  assert.deepEqual(p1.totals, { candidates: 1, lessons: 1, knowledge: 1, all: 3 });
  // overall 不受筛选影响：「全部」按钮要知道切回去能看到多少条。
  assert.deepEqual(p1.overall, all.totals);
  // 领域共享知识不属于任何项目，按项目筛选时不出现。
  assert.equal(groupsByKey(p1).knowledge.items.some((item) => item.id === 'u3'), false);

  const restored = knowledgeBrowseView({ ...input, projectId: '' });
  assert.deepEqual(restored.totals, all.totals);
  assert.equal(restored.filter.projectId, '');
});

test('空层只给标记，不产出占位条目', () => {
  const view = knowledgeBrowseView({ proposals: [candidateRow({ id: 'c1' })] });
  assert.deepEqual(view.emptyLayers, ['lessons', 'knowledge']);
  for (const key of ['lessons', 'knowledge']) {
    const group = groupsByKey(view)[key];
    assert.equal(group.empty, true);
    assert.equal(group.count, 0);
    assert.deepEqual(group.counts, { project: 0, all: 0 });
    assert.equal(group.items.length, 0);
    assert.equal(group.shown, 0);
    assert.equal(group.truncated, false);
    assert.ok(group.emptyHint.length > 0, `${key} 需要空状态说明`);
  }
  // 有内容的层不带空标记。
  assert.equal(groupsByKey(view).candidates.empty, false);
  assert.equal(view.empty, null);
});

test('全空与空项目仍给出三层结构与明确空状态', () => {
  const empty = knowledgeBrowseView({});
  assert.deepEqual(empty.groups.map((group) => group.key), LAYER_KEYS);
  assert.deepEqual(empty.emptyLayers, LAYER_KEYS);
  assert.equal(empty.totals.all, 0);
  assert.equal(empty.empty.kind, 'no-data');
  assert.match(empty.empty.title, /还没有内容/u);
  for (const group of empty.groups) {
    assert.equal(group.empty, true);
    assert.equal(group.count, 0);
    assert.equal(group.items.length, 0);
    assert.ok(group.emptyHint.length > 0, `${group.key} 需要空状态说明`);
  }

  const filtered = knowledgeBrowseView({ projectId: 'missing' });
  assert.equal(filtered.empty.kind, 'no-project-data');
  assert.match(filtered.empty.detail, /全部/u);
  // 空项目下「全部项目」口径仍然报 0，因为数据本身为空。
  assert.deepEqual(filtered.overall, { candidates: 0, lessons: 0, knowledge: 0, all: 0 });
});

test('候选可以通过来源经验（lesson）归属到项目（来源只用于归属，不占经验层）', () => {
  const view = knowledgeBrowseView({
    proposals: [{
      id: 'c1',
      status: 'pending',
      created_at: '2026-11-20T00:00:00.000Z',
      payload: { title: '共享候选', layer: 'applied', scope: 'domain', projectId: null },
      meta: { contract: 'knowledge-candidate/v1', sourceLessonIds: ['l9'] }
    }],
    lessons: [lessonRow({ id: 'l9', projectId: 'p9' })]
  });
  assert.equal(groupsByKey(view).candidates.items[0].projectId, 'p9');
  // 来源 lesson 自己也在「经验」层里，候选归属不会把它藏起来。
  assert.deepEqual(groupsByKey(view).lessons.items.map((item) => item.id), ['l9']);
  assert.equal(knowledgeBrowseView({
    proposals: [candidateRow({ id: 'c', projectIds: ['p9'] })],
    projectId: 'p9'
  }).totals.candidates, 1);
});

test('领域级经验不属于任何项目，只在「全部项目」口径里计数', () => {
  const domainLesson = lessonRow({ id: 'l1', layer: 'domain' });
  const all = knowledgeBrowseView({ lessons: [domainLesson] });
  assert.equal(groupsByKey(all).lessons.counts.all, 1);
  assert.equal(groupsByKey(all).lessons.counts.project, 1);
  assert.deepEqual(groupsByKey(all).lessons.items[0].projectIds, []);

  const p1 = knowledgeBrowseView({ lessons: [domainLesson], projectId: 'p1' });
  assert.equal(groupsByKey(p1).lessons.counts.project, 0);
  assert.equal(groupsByKey(p1).lessons.counts.all, 1);
});

test('条目超过上限时保留全量计数，只截断渲染', () => {
  const units = Array.from({ length: 12 }, (_, index) => unit({ id: `u${index}` }));
  const view = knowledgeBrowseView({ units, limit: 5 });
  const knowledge = groupsByKey(view).knowledge;
  assert.equal(knowledge.count, 12);
  assert.deepEqual(knowledge.counts, { project: 12, all: 12 });
  assert.equal(knowledge.shown, 5);
  assert.equal(knowledge.items.length, 5);
  assert.equal(knowledge.truncated, true);
});

test('从个人知识库读出的三层数据与筛选一致', () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    const verified = store.create({
      title: 'Retry loop bound', content: 'Use i < attempts so the last retry runs.',
      kind: 'claim', layer: 'project', scope: 'project', projectId: 'p1',
      domains: [], tags: ['retry'], evidenceRefs: ['evidence:run-a'],
      verificationStatus: 'verified'
    });
    store.create({
      title: 'Unverified note', content: 'Still a hypothesis.',
      kind: 'note', layer: 'project', scope: 'project', projectId: 'p1',
      domains: [], tags: [], evidenceRefs: [], verificationStatus: 'unverified'
    });
    const lesson = store.addLesson({
      projectId: 'p1', sourceRecordId: 'sandbox:run-a',
      phenomenon: 'retry loop dropped the last attempt',
      mechanism: 'loop bound was exclusive',
      countermeasure: 'use i < attempts',
      scope: { layer: 'project', projectId: 'p1', domainIds: [] },
      verificationStatus: 'unverified', evidenceRefs: ['evidence:run-a']
    }, {
      evidence: [{ ref: 'evidence:run-a', recordId: 'run-a', kind: 'log', excerpt: 'attempt 3 missing' }]
    });
    store.submitProposal({
      payload: {
        title: 'Candidate from retry lesson', content: 'Read the contract first.',
        kind: 'claim', layer: 'project', scope: 'project', projectId: 'p1',
        domains: [], tags: [], evidenceRefs: [], verificationStatus: 'unverified'
      },
      meta: { contract: 'knowledge-candidate/v1', sourceExperienceIds: [], confidence: 0.5 }
    });

    const view = knowledgeBrowseFor({ personalStore: store, projectId: 'p1' });
    assert.equal(view.available, true);
    assert.deepEqual(view.groups.map((group) => group.key), LAYER_KEYS);
    assert.deepEqual(view.totals, { candidates: 1, lessons: 1, knowledge: 2, all: 4 });
    assert.equal(groupsByKey(view).lessons.items[0].id, lesson.id);
    assert.equal(groupsByKey(view).lessons.items[0].badge, '待验证');
    const knowledge = groupsByKey(view).knowledge;
    assert.equal(knowledge.items.find((item) => item.id === verified.id).title, 'Retry loop bound');
    assert.equal(knowledge.items.find((item) => item.id === verified.id).badge, '已验证');

    const other = knowledgeBrowseFor({ personalStore: store, projectId: 'p2' });
    assert.equal(other.totals.all, 0);
    assert.equal(other.overall.all, 4);
    assert.equal(other.empty.kind, 'no-project-data');
    assert.deepEqual(other.emptyLayers, LAYER_KEYS);
  } finally {
    store.close();
  }
});

test('P1-3 知识库不可用时也走同一份三层定义（三层、同一顺序）', () => {
  const missing = knowledgeBrowseFor({ personalStore: null });
  assert.deepEqual(missing.groups.map((group) => group.key), LAYER_KEYS);
  assert.deepEqual(missing.groups.map((group) => group.label), LAYER_LABELS);
  for (const group of missing.groups) {
    assert.equal(group.count, 0);
    assert.deepEqual(group.counts, { project: 0, all: 0 });
    assert.equal(group.empty, true);
    assert.match(group.emptyHint, /知识库未初始化/u);
  }
});

test('#42 AC4 渲染预算：一屏知识数据 1 秒内组装完视图模型', () => {
  const units = Array.from({ length: 1200 }, (_, index) => unit({
    id: `u${String(index).padStart(4, '0')}`,
    status: index % 5 === 0 ? 'unverified' : 'verified'
  }));
  const proposals = Array.from({ length: 300 }, (_, index) => ({
    id: `c${index}`,
    status: 'pending',
    createdAt: '2026-11-24T00:00:00.000Z',
    payload: { title: `candidate ${index}`, projectId: 'p1', layer: 'project' },
    meta: { contract: 'knowledge-candidate/v1', confidence: 0.8 }
  }));
  const lessons = Array.from({ length: 800 }, (_, index) => ({
    id: `l${index}`,
    projectId: 'p1',
    phenomenon: `phenomenon ${index}`,
    mechanism: 'mechanism',
    countermeasure: 'countermeasure',
    scope: { layer: 'project', projectId: 'p1', domainIds: [] },
    verificationStatus: 'unverified',
    evidenceRefs: ['evidence:run-a'],
    evidence: [{ ref: 'evidence:run-a' }],
    createdAt: '2026-11-24T00:00:00.000Z'
  }));
  const started = performance.now();
  const view = knowledgeBrowseView({ units, proposals, lessons });
  const elapsed = performance.now() - started;
  assert.equal(view.groups.length, 3);
  assert.equal(view.totals.all > 2000, true);
  assert.ok(elapsed < 1000, `视图模型组装超过 1 秒：${Math.round(elapsed)}ms`);
});
