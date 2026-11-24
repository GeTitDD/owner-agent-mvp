// 知识模式候选审核：复用既有 reviewProposal。
// 接受候选后条目从「候选」层进入「知识」层，状态是条目上的「待验证」徽章，不是另一个分组。
import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { knowledgeBrowseView } from '../src/knowledge/browse.mjs';
import { knowledgeReviewFor, reviewFailureReason } from '../src/knowledge/review.mjs';

const candidatePayload = (title = '候选知识') => ({
  title,
  content: `${title} 的内容。`,
  kind: 'claim',
  layer: 'project',
  scope: 'project',
  projectId: 'p1',
  domains: [],
  tags: ['retry'],
  evidenceRefs: ['experience:e1'],
  verificationStatus: 'unverified',
  relations: {},
  sourceRef: 'test'
});

const addCandidate = (store, title = '候选知识') => store.submitProposal({
  payload: candidatePayload(title),
  meta: { contract: 'knowledge-candidate/v1', sourceExperienceIds: ['e1'], confidence: 0.6 }
});

const browse = (store) => knowledgeBrowseView({
  units: store.list(),
  proposals: store.proposals('pending'),
  lessons: store.listLessons()
});

const groupOf = (view, key) => view.groups.find((group) => group.key === key);

test('接受候选后从候选层移到知识层，并带上待验证徽章', () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    const proposal = addCandidate(store);
    const before = browse(store);
    assert.equal(before.totals.candidates, 1);
    assert.equal(before.totals.knowledge, 0);
    assert.equal(before.totals.lessons, 0);

    const result = knowledgeReviewFor({
      personalStore: store, id: proposal.id, decision: 'approved'
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'approved');
    assert.ok(result.appliedId);

    const after = browse(store);
    assert.equal(after.totals.candidates, 0);
    assert.equal(after.totals.knowledge, 1);
    // 接受不等于已验证：条目留在知识层，靠「待验证」徽章区分，等工作台附证据后再晋升。
    const items = groupOf(after, 'knowledge').items;
    assert.deepEqual(items.map((item) => item.id), [result.appliedId]);
    assert.equal(items[0].status, 'unverified');
    assert.equal(items[0].badge, '待验证');
    assert.equal(groupOf(after, 'lessons').items.length, 0);
    // 候选层被清空，经验层本来就没有内容，只有知识层有这一条。
    assert.deepEqual(after.emptyLayers, ['candidates', 'lessons']);
  } finally {
    store.close();
  }
});

test('拒绝候选后条目离开候选层，不写入知识', () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    const proposal = addCandidate(store);
    const result = knowledgeReviewFor({
      personalStore: store, id: proposal.id, decision: 'rejected'
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'rejected');
    assert.equal(result.appliedId, null);

    const after = browse(store);
    assert.equal(after.totals.candidates, 0);
    assert.equal(after.totals.knowledge, 0);
    assert.equal(store.list().length, 0);
    assert.deepEqual(after.emptyLayers, ['candidates', 'lessons', 'knowledge']);
  } finally {
    store.close();
  }
});

test('目标知识已被改过时失败，候选保持原状态', () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    const target = store.create({
      ...candidatePayload('原知识'), evidenceRefs: [], sourceRef: 'test'
    });
    const proposal = store.submitProposal({
      targetId: target.id,
      payload: candidatePayload('更新后的知识'),
      meta: { contract: 'knowledge-candidate/v1', sourceExperienceIds: [], confidence: 0.5 }
    });
    // 模拟候选提交后目标知识又被改了一次。
    store.update(target.id, candidatePayload('原知识再改'), {
      expectedRevision: target.revision
    });

    const before = browse(store);
    const result = knowledgeReviewFor({
      personalStore: store, id: proposal.id, decision: 'approved'
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /已经被改过/u);
    // 失败不吞候选：仍待审核，候选层条数不变。
    assert.equal(store.proposal(proposal.id).status, 'pending');
    assert.equal(browse(store).totals.candidates, before.totals.candidates);
    assert.equal(store.list().length, 1);
  } finally {
    store.close();
  }
});

test('非知识候选或无效动作直接拒绝，不改库', () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    const other = store.submitProposal({
      payload: candidatePayload('普通提案'),
      meta: { contract: 'other-proposal/v1' }
    });
    const wrongType = knowledgeReviewFor({
      personalStore: store, id: other.id, decision: 'approved'
    });
    assert.equal(wrongType.ok, false);
    assert.match(wrongType.reason, /不是知识候选/u);
    assert.equal(store.proposal(other.id).status, 'pending');

    const badDecision = knowledgeReviewFor({
      personalStore: store, id: other.id, decision: 'maybe'
    });
    assert.equal(badDecision.ok, false);
    assert.match(badDecision.reason, /只支持接受或拒绝/u);

    const missingStore = knowledgeReviewFor({ personalStore: null, id: 'x', decision: 'approved' });
    assert.equal(missingStore.ok, false);
    assert.match(missingStore.reason, /尚未初始化/u);

    assert.equal(reviewFailureReason(new Error('Proposal already reviewed')), '这条候选已经审核过了；刷新查看最新分组。');
    assert.equal(reviewFailureReason(new Error('unknown boom')), 'unknown boom');
  } finally {
    store.close();
  }
});
