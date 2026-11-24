import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { createDomainEngine } from '../src/engine.mjs';
import { KnowledgeReuse } from '../src/knowledge-loop/reuse.mjs';
import { KnowledgeFeedback } from '../src/knowledge-loop/feedback.mjs';
import { appendDecision } from '../src/knowledge-loop/decision-log.mjs';
import { createWorkbenchServer } from '../src/workbench-server.mjs';
import { DatabaseSync } from 'node:sqlite';
import { OwnerStore } from '../src/owner-store.mjs';
import { KnowledgeLoopRuntime } from '../src/knowledge-loop/runtime.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const image = `sha256:${'a'.repeat(64)}`;

const fakeOwner = ({ runs = {}, jobs = {}, tasks = {}, patches = {}, cycles = [], evidence = {} } = {}) => ({
  getProject: (id) => ({ id, name: id, primary_domain: 'software-engineering' }),
  getSandboxRun: (id) => runs[id] ?? null,
  getJob: (id) => jobs[id] ?? null,
  getTask: (id) => tasks[id] ?? null,
  getPatchProposal: (id) => patches[id] ?? null,
  listRepairCycles: () => cycles,
  listSandboxRuns: ({ projectId }) => Object.values(runs).filter((run) => run.project_id === projectId),
  listJobs: ({ projectId }) => Object.values(jobs).filter((job) => job.project_id === projectId),
  getSandboxEvidence: (runId, kind) => evidence[`${runId}:${kind}`] ?? null
});

const sandbox = (id, overrides = {}) => ({
  id, project_id: 'p1', job_id: 'job1', proposal_id: 'patch1', status: 'completed',
  execution_status: 'completed', test_status: 'pass', profile_id: 'node-smoke',
  image_digest: image, evidence: [{ kind: 'stdout' }, { kind: 'stderr' }],
  ...overrides
});

test('Reuse compiles a project-scoped knowledge unit and records idempotent usage', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-reuse-'));
  const dbPath = path.join(tmp, 'loop.sqlite');
  const project = path.join(tmp, 'project-b');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'domain-context.json'), JSON.stringify({
    project: { id: 'project-b', primaryDomain: 'software-engineering' },
    domainRoot: path.join(ROOT, 'domains'),
    domains: [{ id: 'software-engineering', version: '1.0.0' }],
    context: { maxTokens: 2000 },
    workspace: { enabled: true, importDomainIds: ['software-engineering'], includeProject: true }
  }, null, 2));
  const personal = new PersonalKnowledgeStore(dbPath);
  const engine = createDomainEngine({ dbPath });
  try {
    const unit = personal.create({
      title: 'Retry loop bound', content: 'Use i < attempts so the final retry executes.',
      kind: 'claim', layer: 'applied', scope: 'domain', domains: ['software-engineering'],
      tags: ['retry', 'off-by-one'], evidenceRefs: ['sandbox:run-a'],
      verificationStatus: 'verified', sourceRef: 'test'
    });
    const reuse = new KnowledgeReuse({ personalStore: personal, engine, ownerStore: fakeOwner() });
    const result = await reuse.compileAsync({
      cwd: project, task: 'retry loop off-by-one', targetRunId: 'session-b',
      projectId: 'project-b'
    });
    assert.ok(result.plan.dynamicContext.includes('Use i < attempts'));
    assert.ok(result.plan.knowledgeRefs.includes(`workspace:${unit.id}:r1`));
    assert.equal(result.usages.length, 1);
    assert.equal(result.usages[0].knowledgeId, unit.id);
    assert.equal(result.usages[0].revision, 1);
    const again = await reuse.compileAsync({
      cwd: project, task: 'retry loop off-by-one', targetRunId: 'session-b', projectId: 'project-b'
    });
    assert.equal(again.usages.length, 1);
    assert.equal(again.usages[0].id, result.usages[0].id);
  } finally {
    personal.close(); engine.close(); fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('successful runs leave observedBenefit unknown and never trigger promotion', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const unit = personal.create({
      title: 'Retry loop bound', content: 'Use i < attempts so the final retry executes.',
      kind: 'claim', layer: 'project', scope: 'project', projectId: 'p1',
      domains: ['software-engineering'], tags: ['retry'], evidenceRefs: ['sandbox:run-a'],
      verificationStatus: 'verified', sourceRef: 'test'
    });
    const owner = fakeOwner({
      runs: {
        run1: sandbox('run1'),
        run2: sandbox('run2', { project_id: 'p2' })
      }
    });
    const feedback = new KnowledgeFeedback({ ownerStore: owner, personalStore: personal });
    const usage1 = personal.addUsage({
      knowledgeId: unit.id, revision: unit.revision, targetRunId: 'run1', projectId: 'p1',
      retrievalReason: 'retry task', applicabilityResult: 'applicable', contextSnapshotId: 'c1',
      outcome: 'unknown', observedBenefit: 'unknown'
    });
    const first = feedback.record({ usageId: usage1.id, runId: 'run1', rationale: 'task passed' });
    assert.equal(first.feedback.outcome, 'succeeded');
    assert.equal(first.feedback.observedBenefit, 'unknown');
    assert.equal(first.evolution, null);
    const usage2 = personal.addUsage({
      knowledgeId: unit.id, revision: unit.revision, targetRunId: 'run2', projectId: 'p2',
      retrievalReason: 'retry task', applicabilityResult: 'applicable', contextSnapshotId: 'c2',
      outcome: 'unknown', observedBenefit: 'unknown'
    });
    const second = feedback.record({ usageId: usage2.id, runId: 'run2', rationale: 'task passed in p2' });
    assert.equal(second.feedback.observedBenefit, 'unknown');
    assert.equal(second.evolution, null);
    assert.equal(personal.proposals('pending').filter((item) => item.meta?.kind === 'promotion').length, 0);
    assert.equal(personal.getUsage(usage1.id).observedBenefit, 'unknown');
    assert.equal(personal.getUsage(usage2.id).observedBenefit, 'unknown');
  } finally { personal.close(); }
});

test('controlled A/B comparisons across projects can promote a project knowledge unit', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const unit = personal.create({
      title: 'Retry loop bound', content: 'Use i < attempts so the final retry executes.',
      kind: 'claim', layer: 'project', scope: 'project', projectId: 'p1',
      domains: ['software-engineering'], tags: ['retry'], evidenceRefs: ['sandbox:run-a'],
      verificationStatus: 'verified', sourceRef: 'test'
    });
    const owner = fakeOwner({
      runs: { run1: sandbox('run1'), run2: sandbox('run2', { project_id: 'p2' }) }
    });
    const feedback = new KnowledgeFeedback({ ownerStore: owner, personalStore: personal });
    const usage1 = personal.addUsage({
      knowledgeId: unit.id, revision: unit.revision, targetRunId: 'run1', projectId: 'p1',
      retrievalReason: 'retry task', applicabilityResult: 'applicable', contextSnapshotId: 'c1',
      outcome: 'unknown', observedBenefit: 'unknown'
    });
    const first = feedback.record({
      usageId: usage1.id, runId: 'run1', rationale: 'same task baseline failed, knowledge passed',
      comparison: {
        id: 'ab-p1', knowledgeId: unit.id, sameTask: true,
        baselineOutcome: 'failed', variantOutcome: 'succeeded'
      }
    });
    assert.equal(first.feedback.observedBenefit, 'positive');
    assert.deepEqual(first.feedback.benefitEvidenceRefs, ['comparison:ab-p1']);
    assert.equal(first.evolution, null);
    const usage2 = personal.addUsage({
      knowledgeId: unit.id, revision: unit.revision, targetRunId: 'run2', projectId: 'p2',
      retrievalReason: 'retry task', applicabilityResult: 'applicable', contextSnapshotId: 'c2',
      outcome: 'unknown', observedBenefit: 'unknown'
    });
    const second = feedback.record({
      usageId: usage2.id, runId: 'run2', rationale: 'independent project same A/B result',
      comparison: {
        id: 'ab-p2', knowledgeId: unit.id, sameTask: true,
        baselineOutcome: 'failed', variantOutcome: 'succeeded'
      }
    });
    assert.equal(second.evolution.meta.kind, 'promotion');
    assert.equal(second.evolution.payload.layer, 'applied');
    assert.equal(second.evolution.payload.scope, 'domain');
    assert.deepEqual(second.evolution.payload.relations.specializes, [unit.id]);
    assert.deepEqual(second.evolution.meta.independentProjects.sort(), ['p1', 'p2']);
  } finally { personal.close(); }
});

test('feedback rejects mismatched runs or unevidenced positive claims', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const unit = personal.create({
      title: 'Retry loop bound', content: 'Use i < attempts.', kind: 'claim',
      layer: 'project', scope: 'project', projectId: 'p1', domains: ['software-engineering'],
      tags: ['retry'], evidenceRefs: ['sandbox:run1'], verificationStatus: 'verified', sourceRef: 'test'
    });
    const owner = fakeOwner({
      runs: {
        run1: sandbox('run1'),
        run2: sandbox('run2', { project_id: 'p2' }),
        run3: sandbox('run3', { project_id: 'p3' })
      }
    });
    const feedback = new KnowledgeFeedback({ ownerStore: owner, personalStore: personal });
    const usage = personal.addUsage({
      knowledgeId: unit.id, revision: unit.revision, targetRunId: 'run1', projectId: 'p1',
      retrievalReason: 'retry', applicabilityResult: 'applicable', contextSnapshotId: 'c1',
      outcome: 'unknown', observedBenefit: 'unknown'
    });
    assert.throws(() => feedback.record({ usageId: usage.id, runId: 'run2' }), /targetRunId/u);
    const other = personal.addUsage({
      knowledgeId: unit.id, revision: unit.revision, targetRunId: 'run3', projectId: 'p2',
      retrievalReason: 'retry', applicabilityResult: 'applicable', contextSnapshotId: 'c2',
      outcome: 'unknown', observedBenefit: 'unknown'
    });
    assert.throws(() => feedback.record({ usageId: other.id, runId: 'run3' }), /project/u);
    const third = personal.addUsage({
      knowledgeId: unit.id, revision: unit.revision, targetRunId: 'run1', projectId: 'p1',
      retrievalReason: 'retry', applicabilityResult: 'applicable', contextSnapshotId: 'c3',
      outcome: 'unknown', observedBenefit: 'unknown'
    });
    assert.throws(() => feedback.record({
      usageId: third.id, runId: 'run1', observedBenefit: 'positive', rationale: 'looks good'
    }), /benefitEvidenceRefs/u);
  } finally { personal.close(); }
});

test('controlled negative comparison proposes re-verification', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const applied = personal.create({
      title: 'Always retry exactly twice', content: 'Fixed retry behavior.',
      kind: 'claim', layer: 'applied', scope: 'domain', domains: ['software-engineering'],
      tags: ['retry'], evidenceRefs: ['sandbox:old'], verificationStatus: 'verified', sourceRef: 'test'
    });
    const owner = fakeOwner({ runs: { runNegative: sandbox('runNegative', { test_status: 'fail' }) } });
    const feedback = new KnowledgeFeedback({ ownerStore: owner, personalStore: personal });
    const usage = personal.addUsage({
      knowledgeId: applied.id, revision: applied.revision, targetRunId: 'runNegative',
      projectId: 'p1', retrievalReason: 'retry task', applicabilityResult: 'applicable',
      contextSnapshotId: 'c3', outcome: 'unknown', observedBenefit: 'unknown'
    });
    const negative = feedback.record({
      usageId: usage.id, runId: 'runNegative', rationale: 'same task baseline passed, knowledge failed',
      comparison: {
        id: 'ab-negative', knowledgeId: applied.id, sameTask: true,
        baselineOutcome: 'succeeded', variantOutcome: 'failed'
      }
    });
    assert.equal(negative.feedback.observedBenefit, 'negative');
    assert.equal(negative.evolution.meta.kind, 'demotion');
    assert.equal(negative.evolution.target_id, applied.id);
    assert.equal(negative.evolution.payload.verificationStatus, 'needs_reverification');
    assert.equal(personal.getUsage(usage.id).observedBenefit, 'negative');
  } finally { personal.close(); }
});

test('KnowledgeLoopRuntime 已退役：tick 不再采集、不写库、不产生待提炼队列', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-runtime-'));
  const ownerDb = path.join(tmp, 'owner.sqlite');
  const knowledgeDb = path.join(tmp, 'knowledge.sqlite');
  const owner = new OwnerStore(ownerDb);
  const personal = new PersonalKnowledgeStore(knowledgeDb);
  try {
    const runtime = new KnowledgeLoopRuntime({ ownerStore: owner, personalStore: personal });
    const first = await runtime.tick();
    assert.equal(first.retired, true);
    assert.equal(first.collected, 0);
    assert.equal(first.newExperiences, 0);
    assert.equal(first.pending, 0);
    // 旧经验表不存在，也就没有任何写入：重复 tick 仍然是同一个空结果。
    assert.equal(personal.db.prepare("SELECT name FROM sqlite_master WHERE name='knowledge_experiences'").get(), undefined);
    const second = await runtime.tick({ projectId: 'anything' });
    assert.equal(second.retired, true);
    assert.equal(second.projectId, 'anything');
    assert.equal(runtime.status().pending, 0);
    assert.equal(runtime.status().allowHarvest, false);
    // setAutoHarvest 保留入口但永远不开启：旧链路不会因为旧设置被重新激活。
    assert.equal(runtime.setAutoHarvest(true, { model: 'fake/model' }).allowHarvest, false);
    assert.equal(personal.listHarvestRuns(10).length, 0);
  } finally {
    personal.close();
    owner.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Workbench exposes knowledge-loop read-only views', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-workbench-'));
  const dbPath = path.join(tmp, 'knowledge.sqlite');
  const personal = new PersonalKnowledgeStore(dbPath);
  let server;
  try {
    const lesson = personal.addLesson({
      projectId: 'p1', sourceRecordId: 'sandbox:run-a',
      phenomenon: 'retry loop leaves the last attempt unused',
      mechanism: 'loop bound is exclusive',
      countermeasure: 'use i < attempts',
      scope: { layer: 'project', projectId: 'p1', domainIds: ['software-engineering'] },
      verificationStatus: 'unverified', evidenceRefs: ['sandbox:run-a']
    }, { evidence: [{ ref: 'sandbox:run-a', recordId: 'run-a', kind: 'log', excerpt: 'attempt 3 missing' }] });
    const unit = personal.create({
      title: 'Retry loop bound', content: 'Use i < attempts.', kind: 'claim',
      layer: 'applied', scope: 'domain', domains: ['software-engineering'],
      tags: ['retry'], evidenceRefs: ['sandbox:run-a'], verificationStatus: 'verified',
      sourceRef: 'test'
    });
    const usage = personal.addUsage({
      knowledgeId: unit.id, revision: unit.revision, targetRunId: 'run-b', projectId: 'p2',
      retrievalReason: 'retry', applicabilityResult: 'applicable', contextSnapshotId: 'c1',
      outcome: 'succeeded', observedBenefit: 'positive'
    });
    const proposal = personal.submitProposal({
      targetId: null,
      payload: {
        title: 'Cross-project retry', content: 'Use i < attempts.', kind: 'claim',
        layer: 'applied', scope: 'domain', projectId: null,
        domains: ['software-engineering'], tags: ['retry'],
        evidenceRefs: [], verificationStatus: 'unverified',
        relations: {}, sourceRef: 'test'
      },
      meta: { contract: 'knowledge-candidate/v1', sourceLessonIds: [lesson.id] }
    });
    server = await createWorkbenchServer({ dbPath, port: 0 });
    const info = await server.listen();
    const base = `http://127.0.0.1:${info.port}`;
    const summary = await (await fetch(`${base}/api/knowledge/loop-summary`)).json();
    // 旧 experience/v1 已退役：loop-summary 的「经验」口径改读 lesson/v1。
    assert.equal(summary.lessons, 1);
    assert.equal('experiences' in summary, false);
    assert.equal(summary.pendingCandidates, 1);
    assert.equal(summary.usages, 1);
    assert.equal(summary.positiveUsages, 1);
    // 旧经验读路由已摘除：不再返回列表，而是普通 404。
    const retired = await fetch(`${base}/api/knowledge/experiences?projectId=p1`);
    assert.equal(retired.status, 404);
    const candidates = await (await fetch(`${base}/api/knowledge/candidates`)).json();
    assert.equal(candidates[0].id, proposal.id);
    assert.equal(candidates[0].meta.sourceLessonIds[0], lesson.id);
    const usages = await (await fetch(`${base}/api/knowledge/usages?targetRunId=run-b`)).json();
    assert.equal(usages[0].id, usage.id);
  } finally {
    if (server) await server.close();
    personal.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('old personal_proposals schema migrates meta_json without losing proposals', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-migrate-'));
  const dbPath = path.join(tmp, 'old.sqlite');
  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE personal_proposals (
        id TEXT PRIMARY KEY, target_id TEXT, payload TEXT NOT NULL,
        status TEXT NOT NULL, actor TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL,
        reviewed_at TEXT, reviewer TEXT, applied_id TEXT
      );
    `);
    legacy.close();
    const store = new PersonalKnowledgeStore(dbPath);
    try {
      const columns = store.db.prepare('PRAGMA table_info(personal_proposals)').all().map((row) => row.name);
      assert.ok(columns.includes('meta_json'));
      const proposal = store.submitProposal({
        targetId: null,
        payload: {
          title: 'Migrated', content: 'A migrated claim.', kind: 'claim',
          layer: 'project', scope: 'project', projectId: 'p1',
          domains: ['software-engineering'], tags: [], evidenceRefs: ['experiment:1'],
          verificationStatus: 'unverified', relations: {}, sourceRef: 'test'
        },
        meta: { contract: 'knowledge-candidate/v1' }
      });
      assert.equal(proposal.meta.contract, 'knowledge-candidate/v1');
      assert.equal(store.proposals('pending')[0].id, proposal.id);
    } finally { store.close(); }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('Decision log matches pstack columns and escapes formula cells', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-log-'));
  const file = path.join(tmp, 'decisions.tsv');
  try {
    appendDecision(file, {
      phase: 'harvest', decision: '=formula', why: 'why', evidence: 'ev', result: 'ok'
    }, () => '2026-01-01T00:00:00.000Z');
    const [header, row] = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(header, 'ts\tphase\tdecision\twhy\tevidence\tresult');
    assert.match(row, /'=formula/u);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
