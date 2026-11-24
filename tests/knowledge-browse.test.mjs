// 知识模式浏览视图模型：三组计数、项目筛选、空状态与截断。
import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { knowledgeBrowseFor, knowledgeBrowseView } from '../src/knowledge/browse.mjs';

const unit = ({ id, scope = 'project', projectId = 'p1', title = id, status = 'verified' }) => ({
  id, title, content: `${title} content`, kind: 'claim',
  scope, layer: scope === 'project' ? 'project' : 'applied', projectId,
  verificationStatus: status, revision: 1, tags: [],
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

const experienceRow = ({ id, projectId = 'p1', createdAt = '2026-11-21T00:00:00.000Z' }) => ({
  id, projectId, observedProblem: `problem ${id}`,
  observedOutcome: { status: 'succeeded' }, createdAt
});

const groupsByKey = (view) => Object.fromEntries(view.groups.map((group) => [group.key, group]));

test('分组分别返回计数与条目', () => {
  const view = knowledgeBrowseView({
    units: [unit({ id: 'u1' }), unit({ id: 'u2', title: '未验证', status: 'unverified' })],
    proposals: [candidateRow({ id: 'c1' }), { ...candidateRow({ id: 'c2' }), status: 'approved' }],
    experiences: [experienceRow({ id: 'e1' })]
  });
  const groups = groupsByKey(view);
  assert.deepEqual(view.totals, { candidates: 1, pending: 1, verified: 1, experiences: 1, all: 4 });
  assert.equal(groups.candidates.label, '候选');
  assert.equal(groups.candidates.items[0].title, 'c1');
  assert.match(groups.candidates.items[0].detail, /待审核/u);
  assert.equal(groups.pending.label, '待验证知识');
  assert.deepEqual(groups.pending.items.map((item) => item.id), ['u2']);
  assert.match(groups.pending.items[0].detail, /待验证/u);
  assert.equal(groups.verified.label, '已验证知识');
  assert.deepEqual(groups.verified.items.map((item) => item.id), ['u1']);
  assert.equal(groups.experiences.items[0].id, 'e1');
  assert.match(groups.experiences.items[0].detail, /成功/u);
  assert.equal(view.empty, null);
});

test('项目筛选生效，切回全部恢复', () => {
  const input = {
    units: [
      unit({ id: 'u1', projectId: 'p1' }),
      unit({ id: 'u2', projectId: 'p2' }),
      unit({ id: 'u3', scope: 'domain', projectId: null })
    ],
    proposals: [candidateRow({ id: 'c1', projectIds: ['p1'] }), candidateRow({ id: 'c2', projectIds: ['p2'] })],
    experiences: [experienceRow({ id: 'e1', projectId: 'p1' }), experienceRow({ id: 'e2', projectId: 'p2' })]
  };
  const all = knowledgeBrowseView(input);
  assert.equal(all.totals.all, 7);
  assert.deepEqual(all.projects.map((item) => item.id).sort(), ['p1', 'p2']);

  const p1 = knowledgeBrowseView({ ...input, projectId: 'p1' });
  assert.deepEqual(p1.totals, { candidates: 1, pending: 0, verified: 1, experiences: 1, all: 3 });
  // 「全部」按钮要知道切回全部能看到多少条，所以 overall 不受筛选影响。
  assert.deepEqual(p1.overall, all.totals);
  assert.deepEqual(groupsByKey(p1).verified.items.map((item) => item.id), ['u1']);
  // 领域共享知识不属于任何项目，按项目筛选时不出现。
  assert.equal(p1.groups[1].items.some((item) => item.id === 'u3'), false);

  const restored = knowledgeBrowseView({ ...input, projectId: '' });
  assert.deepEqual(restored.totals, all.totals);
  assert.equal(restored.filter.projectId, '');
});

test('空库与空项目给出明确空状态', () => {
  const empty = knowledgeBrowseView({});
  assert.equal(empty.totals.all, 0);
  assert.equal(empty.empty.kind, 'no-data');
  assert.match(empty.empty.title, /还没有内容/u);
  assert.equal(empty.groups.length, 4);
  for (const group of empty.groups) {
    assert.equal(group.count, 0);
    assert.equal(group.items.length, 0);
    assert.ok(group.emptyHint.length > 0, `${group.key} 需要空状态说明`);
  }

  const filtered = knowledgeBrowseView({ projectId: 'missing' });
  assert.equal(filtered.empty.kind, 'no-project-data');
  assert.match(filtered.empty.detail, /全部/u);
});

test('候选可以通过来源经验归属到项目', () => {
  const view = knowledgeBrowseView({
    proposals: [{
      id: 'c1',
      status: 'pending',
      created_at: '2026-11-20T00:00:00.000Z',
      payload: { title: '共享候选', layer: 'applied', scope: 'domain', projectId: null },
      meta: { contract: 'knowledge-candidate/v1', sourceExperienceIds: ['e1'] }
    }],
    experiences: [experienceRow({ id: 'e1', projectId: 'p9' })]
  });
  assert.equal(groupsByKey(view).candidates.items[0].projectId, 'p9');
  assert.equal(knowledgeBrowseView({
    proposals: [candidateRow({ id: 'c', projectIds: ['p9'] })],
    experiences: [experienceRow({ id: 'e9', projectId: 'p9' })],
    projectId: 'p9'
  }).totals.candidates, 1);
});

test('条目超过上限时保留全量计数，只截断渲染', () => {
  const units = Array.from({ length: 12 }, (_, index) => unit({ id: `u${index}` }));
  const view = knowledgeBrowseView({ units, limit: 5 });
  const verified = groupsByKey(view).verified;
  assert.equal(verified.count, 12);
  assert.equal(verified.shown, 5);
  assert.equal(verified.items.length, 5);
  assert.equal(verified.truncated, true);
});

test('从个人知识库读出的分组数据与筛选一致', () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    const verified = store.create({
      title: 'Retry loop bound', content: 'Use i < attempts so the last retry runs.',
      kind: 'claim', layer: 'project', scope: 'project', projectId: 'p1',
      domains: [], tags: ['retry'], evidenceRefs: ['sandbox:run-a'],
      verificationStatus: 'verified'
    });
    store.create({
      title: 'Unverified note', content: 'Still a hypothesis.',
      kind: 'note', layer: 'project', scope: 'project', projectId: 'p1',
      domains: [], tags: [], evidenceRefs: [], verificationStatus: 'unverified'
    });
    store.addExperience({
      contract: 'experience/v1', sourceRunId: 'run-a', projectId: 'p1', taskId: null,
      domainIds: [], observedProblem: 'retry loop dropped the last attempt',
      actionSummary: 'changed the loop bound', observedOutcome: { status: 'repaired' },
      evidenceRefs: ['sandbox:run-a'], createdAt: '2026-11-21T00:00:00.000Z'
    });
    store.submitProposal({
      payload: {
        title: 'Candidate from retry experience', content: 'Read the contract first.',
        kind: 'claim', layer: 'project', scope: 'project', projectId: 'p1',
        domains: [], tags: [], evidenceRefs: [], verificationStatus: 'unverified'
      },
      meta: { contract: 'knowledge-candidate/v1', sourceExperienceIds: [], confidence: 0.5 }
    });

    const view = knowledgeBrowseFor({ personalStore: store, projectId: 'p1' });
    assert.equal(view.available, true);
    assert.deepEqual(view.totals, { candidates: 1, pending: 1, verified: 1, experiences: 1, all: 4 });
    assert.equal(groupsByKey(view).verified.items[0].title, 'Retry loop bound');
    assert.equal(groupsByKey(view).verified.items[0].projectId, 'p1');
    assert.equal(groupsByKey(view).verified.items[0].id, verified.id);

    const other = knowledgeBrowseFor({ personalStore: store, projectId: 'p2' });
    assert.equal(other.totals.all, 0);
    assert.equal(other.overall.all, 4);
    assert.equal(other.empty.kind, 'no-project-data');

    const missing = knowledgeBrowseFor({ personalStore: null });
    assert.equal(missing.available, false);
    assert.equal(missing.empty.kind, 'unavailable');
    assert.equal(missing.overall.all, 0);
  } finally {
    store.close();
  }
});
