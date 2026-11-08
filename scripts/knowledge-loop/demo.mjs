#!/usr/bin/env node
// Knowledge Loop 演示：采集 → 提炼 → 审核/验证 → 复用 → 反馈 → 晋升建议。
//
// 默认使用确定性 Sandbox fixture 与注入式 Harvest，不产生模型费用。
// 加 --allow-model 才调用真实 Pi；真实运行证据写入 --root 下的 JSON/TSV。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OwnerStore } from '../../src/owner-store.mjs';
import { PersonalKnowledgeStore } from '../../src/personal-store.mjs';
import { createDomainEngine } from '../../src/engine.mjs';
import { ExperienceCollector } from '../../src/knowledge-loop/experience.mjs';
import { KnowledgeHarvester } from '../../src/knowledge-loop/harvest.mjs';
import { KnowledgeReuse } from '../../src/knowledge-loop/reuse.mjs';
import { KnowledgeFeedback } from '../../src/knowledge-loop/feedback.mjs';
import { appendDecision } from '../../src/knowledge-loop/decision-log.mjs';
import { createSyntheticProject, createPassingProject, writeProjectContext } from './fixtures.mjs';

const args = process.argv.slice(2);
const read = (flag, fallback = '') => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1];
};
const allowModel = args.includes('--allow-model');
const fakeHarvest = args.includes('--fake-harvest') || !allowModel;
const keep = args.includes('--keep') || args.includes('--allow-model');
const root = path.resolve(read('--root', fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-loop-demo-'))));
fs.mkdirSync(root, { recursive: true });
const ownerDb = path.join(root, 'owner.sqlite');
const knowledgeDb = path.join(root, 'knowledge.sqlite');
const decisions = path.join(root, 'decisions.tsv');
const reportPath = path.join(root, 'report.json');
const model = read('--model', process.env.OWNER_MODEL || '');
const report = { contract: 'knowledge-loop-demo/v1', root, model: model || 'sdk-default', allowModel, stages: {} };

const log = (stage, decision, why, evidence, result) => {
  appendDecision(decisions, { phase: stage, decision, why, evidence, result });
  console.log(`[${stage}] ${decision} -> ${result}`);
};

function fakeExtractor(layer) {
  return ({ experiences }) => ({
    candidates: [{
      title: 'Retry helper must use all attempts',
      claim: 'When a Node retry helper is expected to attempt N times, loop with `i < attempts`; `i < attempts - 1` silently drops the final attempt.',
      kind: 'pattern',
      proposedLayer: layer,
      applicability: ['Node retry helper with a positive attempts count'],
      exceptions: ['attempts <= 0'],
      confidence: 0.9,
      contradictions: [],
      keywords: ['retry', 'off-by-one', 'attempts'],
      evidenceRefs: experiences.flatMap((item) => item.evidenceRefs).slice(0, 10),
      facts: experiences.flatMap((item) => item.facts).slice(0, 10),
      inferences: ['The failing assertion is caused by the loop bound.'],
      unknowns: [],
      validationSuggestions: ['Reuse in a second project with the same fixture.', 'Add a counterexample where attempts is 1.']
    }]
  });
}

async function harvestFor({ owner, personal, experienceIds, projectId, layer }) {
  const harvester = new KnowledgeHarvester({
    ownerStore: owner,
    personalStore: personal,
    model,
    allowModel,
    pstackDir: read('--pstack-dir', process.env.PSTACK_DIR || '')
  });
  return harvester.harvest({
    experienceIds,
    projectId,
    domainId: 'software-engineering',
    allowModel,
    model,
    extractor: fakeHarvest ? fakeExtractor(layer) : null
  });
}

function approveAndVerify(personal, proposalId, actor = 'demo-owner') {
  const reviewed = personal.reviewProposal(proposalId, { decision: 'approved', reviewer: actor });
  let unit = personal.get(reviewed.applied_id);
  unit = personal.update(unit.id, {
    ...unit,
    verificationStatus: 'verified',
    evidenceRefs: [...new Set([...(unit.evidenceRefs ?? []), 'demo:passing-tests'])]
  }, { expectedRevision: unit.revision, actor, note: 'Demo owner verified against passing tests' });
  return { proposal: reviewed, unit };
}

async function reuseIn({ owner, personal, engine, project, task, targetRunId }) {
  const reuse = new KnowledgeReuse({ personalStore: personal, engine, ownerStore: owner });
  const result = await reuse.compileAsync({
    cwd: project.root,
    task,
    targetRunId,
    projectId: project.projectId,
    maxTokens: 2000
  });
  const unitRefs = (result.plan?.knowledgeRefs ?? []).filter((key) => key.startsWith('workspace:'));
  return { ...result, unitRefs };
}

async function main() {
  const owner = new OwnerStore(ownerDb);
  const personal = new PersonalKnowledgeStore(knowledgeDb);
  const engine = createDomainEngine({ dbPath: knowledgeDb });
  try {
    fs.rmSync(path.join(root, 'a'), { recursive: true, force: true });
    fs.rmSync(path.join(root, 'b'), { recursive: true, force: true });
    fs.rmSync(path.join(root, 'c'), { recursive: true, force: true });
    const a = createSyntheticProject({ store: owner, root: path.join(root, 'a'), projectId: 'demo-a', name: 'Demo A' });
    const b = createPassingProject({ store: owner, root: path.join(root, 'b'), projectId: 'demo-b', name: 'Demo B' });
    const c = createPassingProject({ store: owner, root: path.join(root, 'c'), projectId: 'demo-c', name: 'Demo C' });
    writeProjectContext(a.root, 'demo-a');
    writeProjectContext(b.root, 'demo-b');
    writeProjectContext(c.root, 'demo-c');
    log('fixture', 'created three isolated projects', 'need two independent projects for L2 and three for L1', root, 'ok');

    const collector = new ExperienceCollector(owner, personal);
    const experiences = [
      ...collector.collectProject('demo-a', { limit: 20 }),
      ...collector.collectProject('demo-b', { limit: 20 }),
      ...collector.collectProject('demo-c', { limit: 20 })
    ];
    report.stages.experiences = experiences.map((item) => ({
      id: item.id, projectId: item.projectId, outcome: item.observedOutcome.status,
      testStatus: item.observedOutcome.testStatus, duplicate: item.duplicate
    }));
    log('collect', `collected ${experiences.length} experiences`, 'every run must be traceable before harvest', ownerDb, `${experiences.length} records`);

    const aExperiences = experiences.filter((item) => item.projectId === 'demo-a');
    const abExperiences = experiences.filter((item) => ['demo-a', 'demo-b'].includes(item.projectId));

    const l3 = await harvestFor({
      owner, personal, experienceIds: aExperiences.map((item) => item.id), projectId: 'demo-a', layer: 'project'
    });
    report.stages.l3Harvest = {
      harvestRunId: l3.harvestRun.id, candidateIds: l3.candidates.map((item) => item.id),
      layers: l3.candidates.map((item) => item.payload.layer)
    };
    log('harvest-l3', 'harvested project-scoped candidate', 'single-project evidence must stay conservative', l3.harvestRun.id, l3.candidates[0]?.payload.layer ?? 'empty');
    if (!l3.candidates[0]) throw new Error('L3 harvest produced no candidate');
    const l3Verified = approveAndVerify(personal, l3.candidates[0].id);
    report.stages.l3Verified = { knowledgeId: l3Verified.unit.id, revision: l3Verified.unit.revision, layer: l3Verified.unit.layer };
    log('verify-l3', 'approved and verified project knowledge', 'owner approval plus passing-test evidence', l3Verified.unit.id, 'verified');

    const l2 = await harvestFor({
      owner, personal, experienceIds: abExperiences.map((item) => item.id), projectId: 'demo-a', layer: 'applied'
    });
    report.stages.l2Harvest = {
      harvestRunId: l2.harvestRun.id, candidateIds: l2.candidates.map((item) => item.id),
      layers: l2.candidates.map((item) => item.payload.layer)
    };
    log('harvest-l2', 'harvested cross-project candidate', 'two independent projects have passing evidence', l2.harvestRun.id, l2.candidates[0]?.payload.layer ?? 'empty');
    if (!l2.candidates[0]) throw new Error('L2 harvest produced no candidate');
    const l2Verified = approveAndVerify(personal, l2.candidates[0].id);
    report.stages.l2Verified = { knowledgeId: l2Verified.unit.id, revision: l2Verified.unit.revision, layer: l2Verified.unit.layer };
    log('verify-l2', 'approved and verified applied knowledge', 'cross-project tests passed', l2Verified.unit.id, 'verified');

    const task = 'retry helper off-by-one attempts loop';
    const reuseA = await reuseIn({ owner, personal, engine, project: a, task, targetRunId: a.repairRunId });
    const reuseB = await reuseIn({ owner, personal, engine, project: b, task, targetRunId: b.runId });
    const reuseC = await reuseIn({ owner, personal, engine, project: c, task, targetRunId: c.runId });
    report.stages.reuse = [reuseA, reuseB, reuseC].map((item) => ({
      unitRefs: item.unitRefs,
      usageIds: item.usages.map((usage) => usage.id),
      contextChars: item.plan?.dynamicContext?.length ?? 0
    }));
    log('reuse', `used knowledge in ${[reuseA, reuseB, reuseC].filter((item) => item.usages.length).length} projects`,
      'retrieval must be project-scoped and recorded', knowledgeDb, `${reuseB.usages.length} usage in B`);

    const feedback = new KnowledgeFeedback({ ownerStore: owner, personalStore: personal });
    const feedbackResults = [];
    for (const [reuse, runId] of [[reuseA, a.repairRunId], [reuseB, b.runId], [reuseC, c.runId]]) {
      for (const usage of reuse.usages) {
        feedbackResults.push(feedback.record({ usageId: usage.id, runId, rationale: 'demo passing test' }));
      }
    }
    report.stages.feedback = feedbackResults.map((item) => ({
      usageId: item.feedback?.usageId, benefit: item.feedback?.observedBenefit,
      evolution: item.evolution?.id ?? null, evolutionKind: item.evolution?.meta?.kind ?? null
    }));
    log('feedback', 'recorded usage outcomes', 'reuse must be tied back to a real outcome', knowledgeDb, `${feedbackResults.length} feedback rows`);

    const promotion = feedbackResults.map((item) => item.evolution).find((item) => item?.meta?.kind === 'promotion') ?? null;
    report.stages.promotion = promotion ? { id: promotion.id, targetLayer: promotion.payload.layer, scope: promotion.payload.scope } : null;
    log('evolution', promotion ? 'proposed L2 -> L1 promotion' : 'no promotion yet', 'needs three independent positive projects', knowledgeDb, promotion?.payload?.layer ?? 'none');

    report.summary = {
      experiences: personal.listExperiences({ limit: 1000 }).length,
      pendingCandidates: personal.proposals('pending').filter((item) => item.meta?.contract === 'knowledge-candidate/v1').length,
      verifiedUnits: personal.list({ limit: 2000 }).filter((item) => item.verificationStatus === 'verified').length,
      usages: personal.listUsages({ limit: 1000 }).length,
      positiveUsages: personal.listUsages({ limit: 1000 }).filter((item) => item.observedBenefit === 'positive').length,
      promotionProposal: promotion?.id ?? null,
      decisionLog: decisions
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ report: reportPath, summary: report.summary }, null, 2));
  } finally {
    engine.close();
    personal.close();
    owner.close();
    if (!keep) {
      console.log(`[INFO] kept report at ${reportPath}; temp root is retained for inspection`);
    }
  }
}

main().catch((error) => {
  console.error(`knowledge-loop demo failed: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
