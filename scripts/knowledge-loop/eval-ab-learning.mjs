#!/usr/bin/env node
// 真正的跨项目 A→B 学习实验。
//
// A：隐藏约定（默认 attempts=7）的失败 + 人工修复证据
//   → 真实 Pi Harvest → 审核/验证 → L3
// B：独立项目先无知识执行（baseline fail）→ 采集独立证据
//   → Harvest(A+B) → L2 → B 知识注入执行（knowledge pass）
//
// 不使用 personal.create 预置答案；知识必须来自 A/B 的证据与 Harvest 审批。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

const diff = `--- a/src/retry.js\n+++ b/src/retry.js\n@@\n-export function withRetry(fn, { attempts = 1 } = {}) {\n+export function withRetry(fn, { attempts = 7 } = {}) {\n`;

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
  insertRun(store, {
    id: runId, projectId, jobId, workspaceId, patchId, baseSha, testStatus: 'fail', root: projectRoot
  });
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
    filePath: 'src/retry.js', content: fixed, diff
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
    evidenceRefs: [...new Set([...(unit.evidenceRefs ?? []), 'ab:passing-tests'])]
  }, { expectedRevision: unit.revision, actor: 'ab-owner', note: 'Verified from A/B passing evidence' });
  return { proposal: reviewed, unit };
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
    const expA = [
      collector.collectSandboxRun(sourceA.runId),
      collector.collectSandboxRun(repairA.runId)
    ];
    report.stages.aExperiences = expA.map((item) => ({ id: item.id, outcome: item.observedOutcome.status }));
    log('A', 'collected failure and human repair', 'A must provide the hidden convention evidence', ownerDb, `${expA.length} experiences`);

    const l3 = await harvest(owner, personal, expA.map((item) => item.id), 'ab-a');
    if (!l3.candidates[0]) {
      console.error('A harvest invalid candidates:', JSON.stringify(l3.invalid ?? [], null, 2).slice(0, 4000));
      throw new Error('A harvest produced no candidate');
    }
    report.stages.aHarvest = {
      id: l3.harvestRun.id,
      candidateId: l3.candidates[0].id,
      layer: l3.candidates[0].payload.layer,
      claim: l3.candidates[0].payload.content
    };
    const l3Verified = approveAndVerify(personal, l3.candidates[0].id);
    report.stages.aKnowledge = { id: l3Verified.unit.id, layer: l3Verified.unit.layer, revision: l3Verified.unit.revision };
    log('A', 'approved L3 knowledge', 'single-project evidence stays project-scoped', l3Verified.unit.id, l3Verified.unit.layer);

    const b = makeProject('ab-b');
    owner.registerProject({ id: 'ab-b', name: 'AB B', root: b.projectRoot, primaryDomain: domain });
    const taskB = owner.createTask({ projectId: 'ab-b', title: 'Fix hidden retry convention in B' });
    const sourceB = addFailRun(owner, { projectId: 'ab-b', root: b.projectRoot, baseSha: b.baseSha, taskId: taskB.id, suffix: 'source' });
    const expB = collector.collectSandboxRun(sourceB.runId);
    report.stages.bExperience = { id: expB.id, outcome: expB.observedOutcome.status };
    log('B', 'collected independent baseline failure', 'B must not receive A knowledge before baseline', ownerDb, expB.id);

    const runner = new KnowledgeEvalRunner({ personalStore: personal, model });
    const baseline = await runner.runTask({
      taskId: 'ab-b-baseline', projectRoot: b.projectRoot,
      task: 'Fix the failing retry test in src/retry.js', allowedPaths: ['src/'], variant: 'baseline'
    });
    report.stages.bBaseline = { success: baseline.success, failure: baseline.failureType, exit: baseline.testExitCode };
    log('B', 'baseline run without knowledge', 'same task/model/test as variant', `exit=${baseline.testExitCode}`, baseline.success ? 'pass' : 'fail');

    const l2 = await harvest(owner, personal, [expA[0].id, expA[1].id, expB.id], 'ab-a');
    if (!l2.candidates[0]) throw new Error('A+B harvest produced no candidate');
    report.stages.abHarvest = {
      id: l2.harvestRun.id,
      candidateId: l2.candidates[0].id,
      layer: l2.candidates[0].payload.layer,
      claim: l2.candidates[0].payload.content
    };
    const l2Verified = approveAndVerify(personal, l2.candidates[0].id);
    report.stages.abKnowledge = { id: l2Verified.unit.id, layer: l2Verified.unit.layer, revision: l2Verified.unit.revision };
    log('A+B', 'approved shared knowledge', 'two independent projects with passing evidence', l2Verified.unit.id, l2Verified.unit.layer);

    const reuse = new KnowledgeReuse({ personalStore: personal, engine, ownerStore: owner });
    const planResult = await reuse.compileAsync({
      cwd: b.projectRoot,
      task: 'retry attempts default loop',
      targetRunId: sourceB.runId,
      projectId: 'ab-b',
      maxTokens: 2000
    });
    const knowledgeRefs = (planResult.plan?.knowledgeRefs ?? []).filter((key) => key.startsWith('workspace:'));
    report.stages.reuse = {
      knowledgeRefs,
      usageIds: planResult.usages.map((usage) => usage.id),
      contextChars: planResult.plan?.dynamicContext?.length ?? 0
    };
    log('reuse', 'B context retrieved shared knowledge', 'knowledge must enter B through the compiler', knowledgeDb, knowledgeRefs.join(', '));

    const knowledge = await runner.runTask({
      taskId: 'ab-b-knowledge', projectRoot: b.projectRoot,
      task: 'Fix the failing retry test in src/retry.js', allowedPaths: ['src/'], variant: 'knowledge',
      knowledgeContext: planResult.plan?.dynamicContext ?? '',
      knowledgeRefs
    });
    report.stages.bKnowledge = {
      success: knowledge.success, failure: knowledge.failureType, exit: knowledge.testExitCode,
      knowledgeRefs: knowledge.knowledgeRefs, tokens: knowledge.estimatedKnowledgeTokens
    };
    log('B', 'knowledge run', 'same task/model/test; only knowledge context differs', `exit=${knowledge.testExitCode}`, knowledge.success ? 'pass' : 'fail');

    const feedback = new KnowledgeFeedback({ ownerStore: owner, personalStore: personal });
    const feedbackResults = [];
    for (const usage of planResult.usages) {
      feedbackResults.push(feedback.record({
        usageId: usage.id,
        runId: sourceB.runId,
        rationale: 'same task: baseline failed, knowledge variant passed',
        comparison: {
          id: 'ab-learning-b',
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
    log('feedback', 'recorded controlled A/B benefit', 'task success alone is not benefit evidence', knowledgeDb, report.stages.feedback[0]?.benefit ?? 'unknown');

    report.summary = {
      aKnowledgeLayer: report.stages.aKnowledge.layer,
      abKnowledgeLayer: report.stages.abKnowledge.layer,
      baselineSuccess: baseline.success,
      knowledgeSuccess: knowledge.success,
      knowledgeRefs,
      feedbackBenefit: report.stages.feedback[0]?.benefit ?? 'unknown',
      decisions
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ report: reportPath, summary: report.summary }, null, 2));
    if (baseline.success) throw new Error('Baseline unexpectedly succeeded; A→B learning contrast is not demonstrated');
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
