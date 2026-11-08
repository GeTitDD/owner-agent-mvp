// 知识摘要与手动提炼：项目隔离、待提炼计算、候选归属与人工动作边界。
import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import {
  knowledgeSummaryFor, pendingExperiencesFor, harvestProjectNow
} from '../src/knowledge/summary.mjs';

const experience = (store, { id, projectId, outcome = 'succeeded' }) => store.addExperience({
  id,
  contract: 'experience/v1',
  sourceRunId: `run-${id}`,
  projectId,
  taskId: null,
  domainIds: ['software-engineering'],
  observedProblem: `problem ${id}`,
  actionSummary: 'did something',
  observedOutcome: { status: outcome, source: 'owner-store', testStatus: outcome === 'succeeded' ? 'pass' : 'fail' },
  evidenceRefs: [`sandbox:run-${id}`],
  environment: { primaryDomain: 'software-engineering', profileId: 'node-smoke', runtime: 'node' },
  facts: [], inferences: [], unknowns: [],
  createdAt: new Date().toISOString()
});

const unit = (store, { projectId, scope = 'project', layer = scope, title = 'unit' }) => store.create({
  title, content: `${title} content`, kind: 'claim', layer,
  scope, projectId: scope === 'project' ? projectId : null,
  domains: ['software-engineering'], tags: [], evidenceRefs: ['legacy:run'],
  verificationStatus: 'unverified'
});

const candidate = (store, { projectId, experienceIds, title }) => store.submitProposal({
  payload: {
    title, content: `${title} claim`, kind: 'claim', layer: 'project', scope: 'project',
    projectId, domains: ['software-engineering'], tags: [], evidenceRefs: [], verificationStatus: 'unverified'
  },
  meta: { contract: 'knowledge-candidate/v1', sourceExperienceIds: experienceIds, confidence: 0.7 }
});

test('待提炼按项目隔离，已提炼的不再重复进入队列', () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    experience(store, { id: 'p1-a', projectId: 'p1' });
    experience(store, { id: 'p1-b', projectId: 'p1' });
    experience(store, { id: 'p2-a', projectId: 'p2' });
    store.addHarvestRun({
      projectId: 'p1', experienceIds: ['p1-a'], dedupeKey: 'h1',
      model: 'fake', status: 'completed', candidateIds: []
    });
    assert.deepEqual(pendingExperiencesFor({ personalStore: store, projectId: 'p1' }).map((item) => item.id), ['p1-b']);
    assert.deepEqual(pendingExperiencesFor({ personalStore: store, projectId: 'p2' }).map((item) => item.id), ['p2-a']);
    assert.deepEqual(pendingExperiencesFor({ personalStore: store, projectId: 'p3' }), []);
  } finally { store.close(); }
});

test('摘要计数按项目归属，共享知识单独统计', () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    experience(store, { id: 'p1-a', projectId: 'p1' });
    experience(store, { id: 'p2-a', projectId: 'p2' });
    unit(store, { projectId: 'p1', title: 'project unit' });
    unit(store, { projectId: null, scope: 'domain', layer: 'applied', title: 'shared unit' });
    candidate(store, { projectId: 'p1', experienceIds: ['p1-a'], title: 'candidate p1' });
    candidate(store, { projectId: 'p2', experienceIds: ['p2-a'], title: 'candidate p2' });

    const p1 = knowledgeSummaryFor({ personalStore: store, projectId: 'p1' });
    assert.equal(p1.counts.experiences, 1);
    assert.equal(p1.counts.pendingHarvest, 1);
    assert.equal(p1.counts.knowledge, 1);
    assert.equal(p1.counts.sharedKnowledge, 1);
    assert.equal(p1.counts.candidates, 1);
    assert.equal(p1.candidates[0].title, 'candidate p1');
    assert.equal(p1.pendingExperiences[0].id, 'p1-a');

    const p2 = knowledgeSummaryFor({ personalStore: store, projectId: 'p2' });
    assert.equal(p2.counts.experiences, 1);
    assert.equal(p2.counts.candidates, 1);
    assert.equal(p2.candidates[0].title, 'candidate p2');
  } finally { store.close(); }
});

test('手动提炼只提交当前项目的待提炼经验，并返回候选', async () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    experience(store, { id: 'p1-a', projectId: 'p1' });
    experience(store, { id: 'p1-b', projectId: 'p1' });
    experience(store, { id: 'p2-a', projectId: 'p2' });
    let seen = null;
    const fakeHarvester = {
      async harvest(input) {
        seen = input;
        return {
          harvestRun: { id: 'harvest_test' },
          candidates: [{ id: 'cand-1', payload: { title: 'Candidate A', layer: 'project' }, meta: { confidence: 0.8 } }],
          skipped: [], invalid: []
        };
      }
    };
    const result = await harvestProjectNow({
      personalStore: store, ownerStore: {}, projectId: 'p1',
      model: 'fake/model', harvester: fakeHarvester
    });
    assert.deepEqual(seen.experienceIds.sort(), ['p1-a', 'p1-b']);
    assert.equal(seen.projectId, 'p1');
    assert.equal(seen.allowModel, true);
    assert.equal(result.experienceCount, 2);
    assert.equal(result.harvestRunId, 'harvest_test');
    assert.deepEqual(result.candidates.map((item) => item.title), ['Candidate A']);
  } finally { store.close(); }
});

test('没有待提炼经验时给出可执行提示，不调用模型', async () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    let called = false;
    await assert.rejects(
      () => harvestProjectNow({
        personalStore: store, projectId: 'p1', model: 'fake',
        harvester: { async harvest() { called = true; } }
      }),
      /没有待提炼经验/u
    );
    assert.equal(called, false);
  } finally { store.close(); }
});
