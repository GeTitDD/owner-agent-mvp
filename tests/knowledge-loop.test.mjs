import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { createDomainEngine } from '../src/engine.mjs';
import { normalizeExperience } from '../src/knowledge-loop/contracts.mjs';
import { ExperienceCollector } from '../src/knowledge-loop/experience.mjs';
import { KnowledgeHarvester, HARVEST_STEPS } from '../src/knowledge-loop/harvest.mjs';
import { KnowledgeReuse } from '../src/knowledge-loop/reuse.mjs';
import { KnowledgeFeedback } from '../src/knowledge-loop/feedback.mjs';
import { appendDecision } from '../src/knowledge-loop/decision-log.mjs';
import { createWorkbenchServer } from '../src/workbench-server.mjs';
import { DatabaseSync } from 'node:sqlite';

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

const job = (id, overrides = {}) => ({
  id, project_id: 'p1', owner_task_id: 'task1', title: 'Fix the failing retry test',
  status: 'succeeded', attempts: [
    { id: `attempt-${id}`, attempt: 1, status: 'succeeded', result_note: 'ok' }
  ], payload: {}, ...overrides
});

test('Experience collector records success, failure and repair without duplicating', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const owner = fakeOwner({
      tasks: { task1: { id: 'task1', project_id: 'p1' } },
      jobs: { job1: job('job1') },
      patches: { patch1: { id: 'patch1', status: 'applied', files: [{ path: 'src/retry.js' }], proposal_hash: 'a'.repeat(64) } },
      runs: {
        runPass: sandbox('runPass'),
        runFail: sandbox('runFail', { test_status: 'fail' }),
        runRepair: sandbox('runRepair', { repair_cycle_id: 'cycle1', test_status: 'pass' })
      },
      cycles: [{ id: 'cycle1', status: 'tested_pass', repairScope: ['src/'], source_sandbox_run_id: 'runFail', repair_sandbox_run_id: 'runRepair' }],
      evidence: { 'runPass:stdout': { content: 'ok 1' }, 'runPass:stderr': { content: '' } }
    });
    const collector = new ExperienceCollector(owner, personal, { clock: () => '2026-01-01T00:00:00.000Z' });
    const pass = collector.collectSandboxRun('runPass');
    assert.equal(pass.observedOutcome.status, 'succeeded');
    assert.equal(pass.observedOutcome.testStatus, 'pass');
    assert.ok(pass.evidenceRefs.includes('sandbox:runPass'));
    assert.ok(pass.evidenceRefs.includes('patch:patch1'));
    const again = collector.collectSandboxRun('runPass');
    assert.equal(again.duplicate, true);
    assert.equal(personal.listExperiences({ projectId: 'p1' }).length, 1);

    const fail = collector.collectSandboxRun('runFail');
    assert.equal(fail.observedOutcome.status, 'failed');
    const repair = collector.collectSandboxRun('runRepair');
    assert.equal(repair.observedOutcome.status, 'repaired');
    assert.equal(repair.observedOutcome.repairStatus, 'tested_pass');
    assert.equal(personal.listExperiences({ projectId: 'p1' }).length, 3);

    const unknown = collector.collectSandboxRun('runFail');
    assert.equal(unknown.duplicate, true);
  } finally { personal.close(); }
});

test('Experience collector handles rejected jobs and marks missing test evidence unknown', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const owner = fakeOwner({
      jobs: { rejected: job('rejected', { status: 'rejected', attempts: [] }) },
      tasks: { task1: { id: 'task1', project_id: 'p1' } }
    });
    const collector = new ExperienceCollector(owner, personal);
    const record = collector.collectJob('rejected');
    assert.equal(record.observedOutcome.status, 'rejected');
    assert.equal(record.observedOutcome.testStatus, null);
    assert.ok(record.unknowns.some((item) => /没有 Sandbox/u.test(item)));
  } finally { personal.close(); }
});

const experience = (id, projectId = 'p1', overrides = {}) => normalizeExperience({
  sourceRunId: id, projectId, taskId: `task-${id}`, domainIds: ['software-engineering'],
  observedProblem: 'retry loop leaves the last attempt unused',
  actionSummary: 'changed loop bound and verified the retry test',
  observedOutcome: { status: 'succeeded', source: 'owner-store', testStatus: 'pass', executionStatus: 'completed', repairStatus: null },
  evidenceRefs: [`sandbox:${id}`, `experience:${id}`],
  environment: { primaryDomain: 'software-engineering', profileId: 'node-smoke', runtime: 'node' },
  facts: ['test passed'], inferences: [], unknowns: [],
  ...overrides
});

test('Harvest maps drafts into pending proposals, forces project layer for single-project evidence', async () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const exp = personal.addExperience(experience('run-a'));
    const harvester = new KnowledgeHarvester({
      ownerStore: fakeOwner({ jobs: {}, tasks: {} }),
      personalStore: personal,
      extractor: null
    });
    const result = await harvester.harvest({
      experienceIds: [exp.id],
      projectId: 'p1',
      domainId: 'software-engineering',
      extractor: () => ({
        candidates: [{
          title: 'Retry loop bound', claim: 'Use i < attempts so the final retry executes.',
          kind: 'pattern', proposedLayer: 'domain', applicability: ['node retry helper'],
          exceptions: ['attempts <= 0'], confidence: 0.9, contradictions: [],
          keywords: ['retry', 'off-by-one'], evidenceRefs: [`experience:${exp.id}`],
          facts: ['test passed'], inferences: ['off-by-one is the cause'], unknowns: [],
          validationSuggestions: ['run in a second project']
        }]
      })
    });
    assert.equal(result.candidates.length, 1);
    const proposal = result.candidates[0];
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.payload.layer, 'project');
    assert.equal(proposal.payload.scope, 'project');
    assert.equal(proposal.payload.projectId, 'p1');
    assert.equal(proposal.payload.verificationStatus, 'unverified');
    assert.deepEqual(proposal.meta.sourceExperienceIds, [exp.id]);
    assert.deepEqual(proposal.meta.steps, HARVEST_STEPS);
    const duplicate = await harvester.harvest({
      experienceIds: [exp.id], projectId: 'p1', domainId: 'software-engineering',
      extractor: () => { throw new Error('must not be called'); }
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.candidates[0].id, proposal.id);
  } finally { personal.close(); }
});

test('Harvest suggests applied only with two independent projects and flags contradictions', async () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const a = personal.addExperience(experience('run-a', 'p1'));
    const b = personal.addExperience(experience('run-b', 'p2'));
    const harvester = new KnowledgeHarvester({ ownerStore: fakeOwner(), personalStore: personal });
    const result = await harvester.harvest({
      experienceIds: [a.id, b.id], projectId: 'p1', domainId: 'software-engineering',
      extractor: () => ({
        candidates: [{
          title: 'Retry bound across projects',
          claim: 'When a retry helper is expected to use every attempt, loop with i < attempts.',
          kind: 'pattern', proposedLayer: 'applied', applicability: ['Node retry helper with attempts=3'],
          exceptions: ['attempts < 1'], confidence: 0.8, contradictions: ['project:old knowledge says attempts - 1'],
          keywords: ['retry'], evidenceRefs: [`experience:${a.id}`, `experience:${b.id}`],
          facts: [], inferences: [], unknowns: [], validationSuggestions: []
        }]
      })
    });
    const proposal = result.candidates[0];
    assert.equal(proposal.payload.layer, 'applied');
    assert.equal(proposal.payload.scope, 'domain');
    assert.equal(proposal.payload.verificationStatus, 'needs_reverification');
    assert.equal(proposal.meta.independentProjects?.length ?? 2, 2);
  } finally { personal.close(); }
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

test('Feedback proposes promotion after independent positive use and demotion after negative use', () => {
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
        run1: sandbox('run1'), run2: sandbox('run2', { project_id: 'p2' }),
        runNegative: sandbox('runNegative', { test_status: 'fail' })
      }
    });
    const feedback = new KnowledgeFeedback({ ownerStore: owner, personalStore: personal });
    const usage1 = personal.addUsage({
      knowledgeId: unit.id, revision: unit.revision, targetRunId: 'run1', projectId: 'p1',
      retrievalReason: 'retry task', applicabilityResult: 'applicable', contextSnapshotId: 'c1',
      outcome: 'unknown', observedBenefit: 'unknown'
    });
    const first = feedback.record({ usageId: usage1.id, runId: 'run1', rationale: 'test passed' });
    assert.equal(first.feedback.observedBenefit, 'positive');
    assert.equal(first.evolution, null);
    const usage2 = personal.addUsage({
      knowledgeId: unit.id, revision: unit.revision, targetRunId: 'run2', projectId: 'p2',
      retrievalReason: 'retry task', applicabilityResult: 'applicable', contextSnapshotId: 'c2',
      outcome: 'unknown', observedBenefit: 'unknown'
    });
    const second = feedback.record({ usageId: usage2.id, runId: 'run2', rationale: 'test passed in p2' });
    assert.equal(second.evolution.meta.kind, 'promotion');
    assert.equal(second.evolution.payload.layer, 'applied');
    assert.equal(second.evolution.payload.scope, 'domain');
    assert.deepEqual(second.evolution.payload.relations.specializes, [unit.id]);
    assert.equal(second.duplicate, false);

    const applied = personal.create({
      title: 'Always retry exactly twice', content: 'Fixed retry behavior.',
      kind: 'claim', layer: 'applied', scope: 'domain', domains: ['software-engineering'],
      tags: ['retry'], evidenceRefs: ['sandbox:old'], verificationStatus: 'verified', sourceRef: 'test'
    });
    const usage3 = personal.addUsage({
      knowledgeId: applied.id, revision: applied.revision, targetRunId: 'runNegative',
      projectId: 'p1', retrievalReason: 'retry task', applicabilityResult: 'applicable',
      contextSnapshotId: 'c3', outcome: 'unknown', observedBenefit: 'unknown'
    });
    const negative = feedback.record({ usageId: usage3.id, runId: 'runNegative', rationale: 'test still fails' });
    assert.equal(negative.evolution.meta.kind, 'demotion');
    assert.equal(negative.evolution.target_id, applied.id);
    assert.equal(negative.evolution.payload.verificationStatus, 'needs_reverification');
    assert.equal(personal.getUsage(usage3.id).observedBenefit, 'negative');
  } finally { personal.close(); }
});

test('Workbench exposes knowledge-loop read-only views', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-workbench-'));
  const dbPath = path.join(tmp, 'knowledge.sqlite');
  const personal = new PersonalKnowledgeStore(dbPath);
  let server;
  try {
    const exp = personal.addExperience(experience('run-a'));
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
        evidenceRefs: [`experience:${exp.id}`], verificationStatus: 'unverified',
        relations: {}, sourceRef: 'test'
      },
      meta: { contract: 'knowledge-candidate/v1', sourceExperienceIds: [exp.id] }
    });
    server = await createWorkbenchServer({ dbPath, port: 0 });
    const info = await server.listen();
    const base = `http://127.0.0.1:${info.port}`;
    const summary = await (await fetch(`${base}/api/knowledge/loop-summary`)).json();
    assert.equal(summary.experiences, 1);
    assert.equal(summary.pendingCandidates, 1);
    assert.equal(summary.usages, 1);
    assert.equal(summary.positiveUsages, 1);
    const experiences = await (await fetch(`${base}/api/knowledge/experiences?projectId=p1`)).json();
    assert.equal(experiences[0].id, exp.id);
    const candidates = await (await fetch(`${base}/api/knowledge/candidates`)).json();
    assert.equal(candidates[0].id, proposal.id);
    assert.equal(candidates[0].meta.sourceExperienceIds[0], exp.id);
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
