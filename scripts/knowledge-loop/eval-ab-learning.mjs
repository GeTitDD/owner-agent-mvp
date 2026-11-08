#!/usr/bin/env node
// 真正的跨项目 A→B 学习实验。
//
// 规则：
// - A 的失败/修复证据 → Harvest → 审核/验证 → L3。
// - B 无知识 baseline 失败，只证明问题存在，不足以晋升 L2。
// - B 用 L3 内容做显式 validation-injection，通过后产生第二条独立通过证据。
// - Harvest(A pass + B pass) → L2。
// - B 再通过 Compiler 正常检索 L2，执行 knowledge run；Usage/Feedback 绑定该 eval run。
//
// 不使用 personal.create 预置答案；Oracle Control 仍由 eval-hard.mjs 单独提供。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { OwnerStore } from '../../src/owner-store.mjs';
import { PersonalKnowledgeStore } from '../../src/personal-store.mjs';
import { createDomainEngine } from '../../src/engine.mjs';
import { ExperienceCollector } from '../../src/knowledge-loop/experience.mjs';
import { KnowledgeHarvester } from '../../src/knowledge-loop/harvest.mjs';
import { KnowledgeReuse } from '../../src/knowledge-loop/reuse.mjs';
import { KnowledgeFeedback } from '../../src/knowledge-loop/feedback.mjs';
import { KnowledgeEvalRunner } from '../../src/knowledge-loop/eval.mjs';
import { appendDecision } from '../../src/knowledge-loop/decision-log.mjs';
import { sha256 } from '../../src/utils.mjs';
import {
  insertJob, insertWorkspace, insertPatch, insertRun, insertRepairCycle
} from './fixtures.mjs';

const args = process.argv.slice(2);
const read = (flag, fallback = '') => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1];
};
if (!args.includes('--allow-model')) throw new Error('--allow-model is required');
const root = path.resolve(read('--root', fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-ab-'))));
fs.mkdirSync(root, { recursive: true });
const ownerDb = path.join(root, 'owner.sqlite');
const knowledgeDb = path.join(root, 'knowledge.sqlite');
const decisions = path.join(root, 'ab-decisions.tsv');
const reportPath = path.join(root, 'ab-report.json');
const model = read('--model', process.env.OWNER_MODEL || '');
const domain = 'software-engineering';

const log = (phase, decision, why, evidence, result) => {
  appendDecision(decisions, { phase, decision, why, evidence, result });
  console.log(`[${phase}] ${decision} -> ${result}`);
};
const git = (cwd, cmd) => execFileSync('git', cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const testContent = `import test from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../src/retry.js';
test('withRetry uses all attempts', () => {
  let calls = 0;
  const result = withRetry(() => {
    calls += 1;
    if (calls < 7) throw new Error('flaky');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 7);
});
`;
const buggy = `export function withRetry(fn, { attempts = 1 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try { return fn(); } catch (error) { lastError = error; }
  }
  throw lastError;
}
`;
const fixed = `export function withRetry(fn, { attempts = 7 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try { return fn(); } catch (error) { lastError = error; }
  }
  throw lastError;
}
`;
const repairDiff = `--- a/src/retry.js\n+++ b/src/retry.js\n@@\n-export function withRetry(fn, { attempts = 1 } = {}) {\n+export function withRetry(fn, { attempts = 7 } = {}) {\n`;

function makeProject(projectId) {
  const projectRoot = path.join(root, projectId);
  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'package.json'), `{"name":"${projectId}","private":true,"type":"module"}\n`, 'utf8');
  fs.writeFileSync(path.join(projectRoot, 'src', 'retry.js'), buggy, 'utf8');
  fs.writeFileSync(path.join(projectRoot, 'tests', 'sandbox-smoke.test.mjs'), testContent, 'utf8');
  git(projectRoot, ['init', '-q', '-b', 'main']);
  git(projectRoot, ['config', 'core.autocrlf', 'false']);
  git(projectRoot, ['config', 'user.email', 'ab@example.invalid']);
  git(projectRoot, ['config', 'user.name', 'AB Fixture']);
  git(projectRoot, ['add', '.']);
  git(projectRoot, ['commit', '-qm', 'hidden convention: default attempts=7']);
  const baseSha = git(projectRoot, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(projectRoot, 'domain-context.json'), `${JSON.stringify({
    project: { id: projectId, primaryDomain: domain },
    domainRoot: path.resolve(process.cwd(), 'domains'),
    domains: [{ id: domain, version: '1.0.0' }],
    context: { maxTokens: 2000 },
    workspace: { enabled: true, importDomainIds: [domain], includeProject: true }
  }, null, 2)}\n`, 'utf8');
  return { projectRoot, baseSha };
}

function addFailRun(store, { projectId, root: projectRoot, baseSha, taskId, suffix }) {
  const jobId = `job-${projectId}-${suffix}`;
  insertJob(store, { id: jobId, projectId, taskId, title: 'Fix the failing retry test', baseSha });
  const workspaceId = `ws-${projectId}-${suffix}`;
  insertWorkspace(store, { id: workspaceId, projectId, jobId, baseSha, root: projectRoot });
  const patchId = `patch-${projectId}-${suffix}`;
  insertPatch(store, {
    id: patchId, projectId, jobId, taskId, workspaceId, baseSha,
    filePath: 'src/retry.js', content: `${buggy}\n// no semantic change\n`,
    diff: '--- a/src/retry.js\n+++ b/src/retry.js\n@@\n // no semantic change\n'
  });
  const runId = `run-${projectId}-${suffix}`;
  insertRun(store, { id: runId, projectId, jobId, workspaceId, patchId, baseSha, testStatus: 'fail', root: projectRoot });
  return { jobId, workspaceId, patchId, runId };
}

function addRepairRun(store, { projectId, root: projectRoot, baseSha, taskId, source }) {
  const jobId = `job-${projectId}-repair`;
  insertJob(store, { id: jobId, projectId, taskId, title: 'Human repair: set default attempts to 7', baseSha });
  const workspaceId = `ws-${projectId}-repair`;
  insertWorkspace(store, { id: workspaceId, projectId, jobId, baseSha, root: projectRoot });
  const patchId = `patch-${projectId}-repair`;
  insertPatch(store, {
    id: patchId, projectId, jobId, taskId, workspaceId, baseSha,
    filePath: 'src/retry.js', content: fixed, diff: repairDiff
  });
  const runId = `run-${projectId}-repair`;
  const cycleId = `cycle-${projectId}`;
  insertRun(store, {
    id: runId, projectId, jobId, workspaceId, patchId, baseSha, testStatus: 'pass',
    root: projectRoot, repairCycleId: cycleId
  });
  insertRepairCycle(store, {
    id: cycleId, projectId, taskId,
    sourcePatchId: source.patchId, sourceWorkspaceId: source.workspaceId, sourceRunId: source.runId,
    repairJobId: jobId, repairPatchId: patchId, repairRunId: runId, baseSha
  });
  return { jobId, workspaceId, patchId, runId, cycleId };
}

function approveAndVerify(personal, proposalId) {
  const reviewed = personal.reviewProposal(proposalId, { decision: 'approved', reviewer: 'ab-owner' });
  let unit = personal.get(reviewed.applied_id);
  unit = personal.update(unit.id, {
    ...unit,
    verificationStatus: 'verified',
    evidenceRefs: [...new Set([...(unit.evidenceRefs ?? []), 'ab:validated'])]
  }, { expectedRevision: unit.revision, actor: 'ab-owner', note: 'Verified from A/B evidence' });
  return { proposal: reviewed, unit };
}

function evalSummary(result) {
  return {
    success: result.success,
    testExitCode: result.testExitCode,
    failureType: result.failureType,
    model: result.model,
    proposalHash: result.proposalHash,
    outputHash: result.outputHash,
    stdoutHash: result.stdoutHash,
    stderrHash: result.stderrHash,
    filesChanged: result.filesChanged,
    knowledgeRefs: result.knowledgeRefs,
    estimatedKnowledgeTokens: result.estimatedKnowledgeTokens,
    durationMs: result.durationMs
  };
}

async function harvest(owner, personal, experienceIds, projectId) {
  const harvester = new KnowledgeHarvester({
    ownerStore: owner, personalStore: personal, model, allowModel: true,
    pstackDir: read('--pstack-dir', process.env.PSTACK_DIR || '')
  });
  return harvester.harvest({ experienceIds, projectId, domainId: domain, allowModel: true, model });
}

async function main() {
  const owner = new OwnerStore(ownerDb);
  const personal = new PersonalKnowledgeStore(knowledgeDb);
  const engine = createDomainEngine({ dbPath: knowledgeDb });
  const report = { contract: 'knowledge-ab-learning/v1', root, model: model || 'sdk-default', stages: {} };
  try {
    const a = makeProject('ab-a');
    owner.registerProject({ id: 'ab-a', name: 'AB A', root: a.projectRoot, primaryDomain: domain });
    const taskA = owner.createTask({ projectId: 'ab-a', title: 'Fix hidden retry convention' });
    const sourceA = addFailRun(owner, { projectId: 'ab-a', root: a.projectRoot, baseSha: a.baseSha, taskId: taskA.id, suffix: 'source' });
    const repairA = addRepairRun(owner, { projectId: 'ab-a', root: a.projectRoot, baseSha: a.baseSha, taskId: taskA.id, source: sourceA });
    const collector = new ExperienceCollector(owner, personal);
    const expA = [collector.collectSandboxRun(sourceA.runId), collector.collectSandboxRun(repairA.runId)];
    report.stages.aExperiences = expA.map((item) => ({ id: item.id, outcome: item.observedOutcome.status, test: item.observedOutcome.testStatus }));
    log('A', 'collected failure and human repair', 'A must provide the hidden convention evidence', ownerDb, `${expA.length} experiences`);

    const l3 = await harvest(owner, personal, expA.map((item) => item.id), 'ab-a');
    if (!l3.candidates[0]) throw new Error('A harvest produced no candidate');
    if (l3.candidates[0].payload.layer !== 'project') throw new Error('A-only harvest must stay project-scoped');
    report.stages.aHarvest = { id: l3.harvestRun.id, candidateId: l3.candidates[0].id, layer: l3.candidates[0].payload.layer, claim: l3.candidates[0].payload.content };
    const l3Verified = approveAndVerify(personal, l3.candidates[0].id);
    report.stages.aKnowledge = { id: l3Verified.unit.id, layer: l3Verified.unit.layer, revision: l3Verified.unit.revision };
    log('A', 'approved L3 knowledge', 'single-project evidence stays project-scoped', l3Verified.unit.id, l3Verified.unit.layer);

    const b = makeProject('ab-b');
    owner.registerProject({ id: 'ab-b', name: 'AB B', root: b.projectRoot, primaryDomain: domain });
    const taskB = owner.createTask({ projectId: 'ab-b', title: 'Fix hidden retry convention in B' });
    const sourceB = addFailRun(owner, { projectId: 'ab-b', root: b.projectRoot, baseSha: b.baseSha, taskId: taskB.id, suffix: 'source' });
    const expB = collector.collectSandboxRun(sourceB.runId);
    report.stages.bExperience = { id: expB.id, outcome: expB.observedOutcome.status, test: expB.observedOutcome.testStatus };
    log('B', 'collected independent baseline failure', 'B failure proves the problem, not the fix', ownerDb, expB.id);

    const runner = new KnowledgeEvalRunner({ personalStore: personal, model });
    const task = 'Fix the failing retry test in src/retry.js';
    const baseline = await runner.runTask({
      taskId: 'ab-b-baseline', projectRoot: b.projectRoot, task,
      allowedPaths: ['src/'], variant: 'baseline'
    });
    report.stages.bBaseline = evalSummary(baseline);
    log('B', 'baseline run without knowledge', 'same task/model/test as validation/variant', `exit=${baseline.testExitCode}`, baseline.success ? 'pass' : 'fail');

    const pendingHarvest = await harvest(owner, personal, [expA[0].id, expA[1].id, expB.id], 'ab-a');
    if (!pendingHarvest.candidates[0]) throw new Error('A+B baseline harvest produced no candidate');
    if (pendingHarvest.candidates[0].payload.layer !== 'project') {
      throw new Error('A pass + B fail must not be promoted to L2');
    }
    report.stages.pendingHarvest = {
      id: pendingHarvest.harvestRun.id,
      candidateId: pendingHarvest.candidates[0].id,
      layer: pendingHarvest.candidates[0].payload.layer
    };
    log('A+B', 'baseline harvest stayed L3', 'B has no passing evidence yet', pendingHarvest.harvestRun.id, pendingHarvest.candidates[0].payload.layer);

    // B validation：显式注入 L3 内容，只作为“第二项目验证”，不是正常检索。
    const validationId = `eval_b_validation_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const validationContext = `## Validation Knowledge\n${l3Verified.unit.title}\n${l3Verified.unit.content}\n[verification=verified; scope=validation-injection]`;
    const validation = await runner.runTask({
      taskId: 'ab-b-validation', projectRoot: b.projectRoot, task,
      allowedPaths: ['src/'], variant: 'validation-injection', knowledgeContext: validationContext,
      knowledgeRefs: [`knowledge:${l3Verified.unit.id}:r${l3Verified.unit.revision}`]
    });
    const validationRun = personal.addEvalRun({
      id: validationId,
      projectId: 'ab-b', taskId: taskB.id,
      knowledgeId: l3Verified.unit.id, knowledgeRevision: l3Verified.unit.revision,
      domainId: domain, task, model: model || baseline.model || 'sdk-default',
      mode: 'validation-injection', status: 'completed',
      baseline: evalSummary(baseline), variant: evalSummary(validation),
      sameTask: true,
      taskHash: sha256(task),
      contextHash: sha256(validationContext),
      evidenceRefs: [`eval:${validationId}`]
    });
    const expValidation = collector.collectEvalRun(validationId);
    report.stages.bValidation = {
      evalRunId: validationRun.id,
      success: validation.success,
      exit: validation.testExitCode,
      experienceId: expValidation.id
    };
    log('B', 'validation run with L3 content', 'second project passes before L2 consideration', validationRun.id, validation.success ? 'pass' : 'fail');
    if (!validation.success) throw new Error('B validation did not pass; L2 not demonstrated');

    const l2 = await harvest(owner, personal, [expA[1].id, expValidation.id], 'ab-a');
    if (!l2.candidates[0]) throw new Error('A+B passing harvest produced no candidate');
    if (l2.candidates[0].payload.layer !== 'applied') throw new Error('Two independent passing projects must be eligible for L2');
    report.stages.abHarvest = { id: l2.harvestRun.id, candidateId: l2.candidates[0].id, layer: l2.candidates[0].payload.layer, claim: l2.candidates[0].payload.content };
    const l2Verified = approveAndVerify(personal, l2.candidates[0].id);
    report.stages.abKnowledge = { id: l2Verified.unit.id, layer: l2Verified.unit.layer, revision: l2Verified.unit.revision };
    log('A+B', 'approved shared knowledge', 'two independent projects each have passing evidence', l2Verified.unit.id, l2Verified.unit.layer);

    // 正常检索：Usage 绑定知识版 eval run，而不是 B 的 baseline sandbox。
    const reuseId = `eval_b_reuse_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const reuse = new KnowledgeReuse({ personalStore: personal, engine, ownerStore: owner });
    const planResult = await reuse.compileAsync({
      cwd: b.projectRoot,
      task: 'retry attempts default loop',
      targetRunId: reuseId,
      projectId: 'ab-b',
      maxTokens: 2000
    });
    const knowledgeRefs = (planResult.plan?.knowledgeRefs ?? []).filter((key) => key.startsWith('workspace:'));
    if (!knowledgeRefs.some((key) => key.startsWith(`workspace:${l2Verified.unit.id}:`))) {
      throw new Error('B did not retrieve the L2 unit');
    }
    const knowledge = await runner.runTask({
      taskId: 'ab-b-reuse', projectRoot: b.projectRoot, task,
      allowedPaths: ['src/'], variant: 'knowledge',
      knowledgeContext: planResult.plan?.dynamicContext ?? '',
      knowledgeRefs
    });
    const reuseRun = personal.addEvalRun({
      id: reuseId,
      projectId: 'ab-b', taskId: taskB.id,
      knowledgeId: l2Verified.unit.id, knowledgeRevision: l2Verified.unit.revision,
      domainId: domain, task, model: model || baseline.model || 'sdk-default',
      mode: 'retrieval', status: 'completed',
      baseline: evalSummary(baseline), variant: evalSummary(knowledge),
      sameTask: true,
      taskHash: sha256(task),
      contextHash: planResult.plan?.compilationHash ?? '',
      usageIds: planResult.usages.map((usage) => usage.id),
      evidenceRefs: [`eval:${reuseId}`]
    });
    report.stages.reuse = {
      evalRunId: reuseRun.id,
      knowledgeRefs,
      usageIds: planResult.usages.map((usage) => usage.id),
      contextChars: planResult.plan?.dynamicContext?.length ?? 0
    };
    report.stages.bKnowledge = evalSummary(knowledge);
    log('B', 'knowledge run', 'normal compiler retrieval; same task/model/test', reuseRun.id, knowledge.success ? 'pass' : 'fail');

    const feedback = new KnowledgeFeedback({ ownerStore: owner, personalStore: personal });
    const feedbackResults = [];
    for (const usage of planResult.usages) {
      feedbackResults.push(feedback.record({
        usageId: usage.id,
        runId: reuseId,
        rationale: 'same task: baseline failed, knowledge variant passed',
        benefitEvidenceRefs: [`eval:${reuseId}`],
        comparison: {
          id: reuseId,
          knowledgeId: usage.knowledgeId,
          sameTask: true,
          baselineOutcome: baseline.success ? 'succeeded' : 'failed',
          variantOutcome: knowledge.success ? 'succeeded' : 'failed'
        }
      }));
    }
    report.stages.feedback = feedbackResults.map((item) => ({
      usageId: item.feedback.usageId,
      outcome: item.feedback.outcome,
      benefit: item.feedback.observedBenefit,
      benefitEvidenceRefs: item.feedback.benefitEvidenceRefs,
      evolution: item.evolution?.meta?.kind ?? null
    }));
    log('feedback', 'recorded controlled A/B benefit', 'usage points to the knowledge eval run', knowledgeDb, report.stages.feedback[0]?.benefit ?? 'unknown');

    report.summary = {
      aKnowledgeLayer: report.stages.aKnowledge.layer,
      pendingL2Layer: report.stages.pendingHarvest.layer,
      abKnowledgeLayer: report.stages.abKnowledge.layer,
      baselineSuccess: baseline.success,
      validationSuccess: validation.success,
      knowledgeSuccess: knowledge.success,
      knowledgeRefs,
      feedbackBenefit: report.stages.feedback[0]?.benefit ?? 'unknown',
      evalRunIds: { validation: validationRun.id, reuse: reuseRun.id },
      decisions
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ report: reportPath, summary: report.summary }, null, 2));
    if (baseline.success) throw new Error('Baseline unexpectedly succeeded; A→B contrast is not demonstrated');
    if (!knowledge.success) throw new Error('Knowledge variant failed; A→B transfer is not demonstrated');
  } finally {
    engine.close();
    personal.close();
    owner.close();
  }
}

main().catch((error) => {
  console.error(`A→B learning eval failed: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
