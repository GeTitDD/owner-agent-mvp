// 知识摘要：项目隔离、经验口径与候选归属。
// #62 起摘要只读 lesson/v1；旧的 experience/v1 表已退役，不再出现在任何字段里。
import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { knowledgeSummaryFor } from '../src/knowledge/summary.mjs';

const lesson = (store, { id, projectId, status = 'unverified' }) => store.addLesson({
  projectId,
  sourceRecordId: `sandbox:${id}`,
  phenomenon: `现象 ${id}`,
  mechanism: `机制 ${id}`,
  countermeasure: `对策 ${id}`,
  scope: { layer: 'project', projectId, domainIds: ['software-engineering'] },
  verificationStatus: status,
  evidenceRefs: [`sandbox:${id}`]
}, {
  evidence: [{ ref: `sandbox:${id}`, recordId: id, kind: 'log', excerpt: `excerpt ${id}` }]
});

const unit = (store, { projectId, scope = 'project', layer = scope, title = 'unit' }) => store.create({
  title, content: `${title} content`, kind: 'claim', layer,
  scope, projectId: scope === 'project' ? projectId : null,
  domains: ['software-engineering'], tags: [], evidenceRefs: ['legacy:run'],
  verificationStatus: 'unverified'
});

const candidate = (store, { projectId, lessonIds = [], title }) => store.submitProposal({
  payload: {
    title, content: `${title} claim`, kind: 'claim', layer: projectId ? 'project' : 'applied',
    scope: projectId ? 'project' : 'domain', projectId,
    domains: ['software-engineering'], tags: [], evidenceRefs: [], verificationStatus: 'unverified'
  },
  meta: { contract: 'knowledge-candidate/v1', sourceLessonIds: lessonIds, confidence: 0.7 }
});

test('经验计数按项目归属，共享知识单独统计', () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    const p1Lesson = lesson(store, { id: 'p1-a', projectId: 'p1' });
    lesson(store, { id: 'p2-a', projectId: 'p2' });
    unit(store, { projectId: 'p1', title: 'project unit' });
    unit(store, { projectId: null, scope: 'domain', layer: 'applied', title: 'shared unit' });
    candidate(store, { projectId: 'p1', lessonIds: ['l1'], title: 'candidate p1' });
    candidate(store, { projectId: 'p2', lessonIds: ['l2'], title: 'candidate p2' });

    const p1 = knowledgeSummaryFor({ personalStore: store, projectId: 'p1' });
    assert.equal(p1.counts.lessons, 1);
    assert.equal(p1.counts.knowledge, 1);
    assert.equal(p1.counts.sharedKnowledge, 1);
    assert.equal(p1.counts.candidates, 1);
    assert.equal(p1.candidates[0].title, 'candidate p1');
    assert.equal(p1.recentLessons[0].id, p1Lesson.id);
    assert.match(p1.recentLessons[0].title, /现象/u);
    assert.equal(p1.recentLessons[0].status, 'unverified');

    const p2 = knowledgeSummaryFor({ personalStore: store, projectId: 'p2' });
    assert.equal(p2.counts.lessons, 1);
    assert.equal(p2.counts.candidates, 1);
    assert.equal(p2.candidates[0].title, 'candidate p2');

    // 旧经验口径彻底消失：不再产出 experiences / pendingHarvest / 旧经验列表。
    for (const summary of [p1, p2]) {
      assert.equal('experiences' in summary.counts, false);
      assert.equal('pendingHarvest' in summary.counts, false);
      assert.equal('pendingExperiences' in summary, false);
      assert.equal('recentExperiences' in summary, false);
      assert.equal('experienceCount' in summary, false);
    }
  } finally { store.close(); }
});

test('提升候选按来源经验归属回项目，项目无关候选不串项目', () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    const owned = lesson(store, { id: 'p1-a', projectId: 'p1' });
    lesson(store, { id: 'p2-a', projectId: 'p2' });
    // 域级候选自身没有 projectId，只能靠来源经验归属。
    candidate(store, { projectId: null, lessonIds: [owned.id], title: 'promoted from p1' });
    candidate(store, { projectId: 'p3', lessonIds: [], title: 'candidate p3' });

    const p1 = knowledgeSummaryFor({ personalStore: store, projectId: 'p1' });
    assert.deepEqual(p1.candidates.map((item) => item.title), ['promoted from p1']);
    const p2 = knowledgeSummaryFor({ personalStore: store, projectId: 'p2' });
    assert.deepEqual(p2.candidates, []);
  } finally { store.close(); }
});

test('没有经验与知识时给出稳定空摘要，不报错', () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    const summary = knowledgeSummaryFor({ personalStore: store, projectId: 'p1' });
    assert.equal(summary.counts.lessons, 0);
    assert.equal(summary.counts.knowledge, 0);
    assert.equal(summary.counts.candidates, 0);
    assert.deepEqual(summary.recentLessons, []);
    assert.deepEqual(summary.topKnowledge, []);
    assert.equal(summary.lastKnowledgeAt, null);
    assert.equal(knowledgeSummaryFor({ personalStore: null }), null);
  } finally { store.close(); }
});
