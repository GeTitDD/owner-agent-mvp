import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createDomainEngine } from '../src/engine.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'domain-evolution-'));
  cpSync(path.join(ROOT, 'domains'), path.join(dir, 'domains'), { recursive: true });
  for (const id of ['payment-service', 'queue-worker']) {
    const folder = path.join(dir, id);
    mkdirSync(folder);
    writeFileSync(path.join(folder, 'domain-context.json'), JSON.stringify({
      project: { id }, domainRoot: '../domains',
      domains: [{ id: 'software-engineering', version: '1.0.0' }],
      context: { maxTokens: 2000 }, evolution: { capture: 'metadata' }
    }));
  }
  return { dir, project: (name) => path.join(dir, name), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function seedRun(store, projectId = 'payment-service', status = 'settled') {
  const runId = store.beginRun({ sessionId: 'session-a', branchLeafId: 'leaf-1', projectId, projectRoot: '/project/'+projectId, snapshotId: 'snapshot-a' });
  store.recordTool({ runId, toolCallId: 'call-1', toolName: 'bash', isError: false, durationMs: 42 });
  store.settleRun(runId, { aborted: status === 'aborted' });
  return runId;
}
function seedEvidence(store, runId, overrides = {}) {
  return store.addEvidence({ runId, kind: 'test', outcome: 'passed', summary: 'Retry handling test passed with duplicate delivery', reference: 'local:tests/retry.test.mjs#case-1', sharingConsent: true, ...overrides });
}
function seedCandidate(store, evidenceId, overrides = {}) {
  return store.propose({ domainId: 'software-engineering', baseVersion: '1.0.0', knowledgeId: 'pattern.retry-boundary', kind: 'pattern',
    title: 'Stable retry boundary', claim: 'Maintain a stable deduplication identity across attempts and validate a crash-before-commit replay with a test.',
    keywords: ['retry', 'duplicate', 'deduplication', 'crash'], evidenceIds: [evidenceId], applicability: ['queue-worker', 'payment-service'], ...overrides });
}

test('trace ledger is idempotent and only stores safe metadata', () => {
  const engine = createDomainEngine({ dbPath: ':memory:' });
  try {
    const s = engine.evolution;
    const id = s.beginRun({ id: 'run-1', sessionId: 'sid', branchLeafId: 'leaf', projectId: 'project-a', projectRoot: '/x', snapshotId: 'abc' });
    const args = { apiKey: 'secretNeverStored' };
    const result = { text: 'toolOutputNeverStored' };
    // Only explicitly picked fields are passed to the ledger; even a caller passing extra properties cannot persist them.
    s.recordTool({ runId: id, toolCallId: 'x', toolName: 'bash', isError: false, durationMs: 8, args, result });
    s.recordTool({ runId: id, toolCallId: 'x', toolName: 'bash', isError: false, durationMs: 8, args, result });
    s.settleRun(id);
    s.settleRun(id);
    const trace = s.getRunTrace(id);
    assert.equal(trace.status, 'settled');
    assert.equal(trace.branch_leaf_id, 'leaf');
    assert.equal(trace.tools.length, 1);
    assert.doesNotMatch(JSON.stringify(trace), /secretNeverStored|toolOutputNeverStored/);
    assert.throws(() => s.recordTool({ runId: id, toolCallId: 'other', toolName: 'bash' }), /running run/);
  } finally { engine.close(); }
});

test('evidence requires settled run and blocks obvious credentials', () => {
  const engine = createDomainEngine({ dbPath: ':memory:' });
  try {
    const s = engine.evolution;
    const aborted = seedRun(s, 'a', 'aborted');
    assert.throws(() => seedEvidence(s, aborted), /settled/);
    const runId = seedRun(s);
    assert.throws(() => seedEvidence(s, runId, { summary: 'api_key=notasecretbutlong12345678' }), /credential/);
    const evidence = seedEvidence(s, runId);
    assert.equal(evidence.sharing_consent, 1);
  } finally { engine.close(); }
});

test('candidate cannot be approved without independently attested passed-test evidence and sharing consent', () => {
  const engine = createDomainEngine({ dbPath: ':memory:' });
  try {
    const s = engine.evolution;
    const runId = seedRun(s);
    const weak = seedEvidence(s, runId, { sharingConsent: false, outcome: 'unknown', kind: 'observation' });
    const c = seedCandidate(s, weak.id);
    assert.equal(s.readiness(c.id).ready, false);
    assert.throws(() => s.review({ candidateId: c.id, decision: 'approve', reviewer: 'reviewer' }), /not ready/);
    const passed = seedEvidence(s, runId);
    const c2 = seedCandidate(s, passed.id);
    const approved = s.review({ candidateId: c2.id, decision: 'approve', reviewer: 'reviewer-1' });
    assert.equal(approved.status, 'approved');
    assert.equal(approved.review.candidate_hash, approved.payload_hash);
    assert.throws(() => s.review({ candidateId: c2.id, decision: 'approve', reviewer: 'reviewer-1' }), /already been reviewed/);
    const rejected = s.review({ candidateId: c.id, decision: 'reject', reviewer: 'reviewer-1', note: 'insufficient proof' });
    assert.equal(rejected.status, 'rejected');
  } finally { engine.close(); }
});

test('publish creates an immutable clean new version and another project can retrieve the new knowledge', async () => {
  const f = fixture();
  const engine = createDomainEngine({ dbPath: ':memory:' });
  try {
    const paymentSnapshot = await engine.resolve({ cwd: f.project('payment-service'), sessionId: 'old-session' });
    const sourcePlan = engine.compile({ snapshot: paymentSnapshot, task: 'deduplication identity across retry attempts' });
    const runId = seedRun(engine.evolution);
    const evidence = seedEvidence(engine.evolution, runId);
    const candidate = seedCandidate(engine.evolution, evidence.id);
    assert.equal(engine.evolution.getCandidate(candidate.id).status, 'candidate');
    const newDir = path.join(f.dir, 'domains/software-engineering/1.0.1');
    await assert.rejects(engine.publish({ domainRoot: paymentSnapshot.domainRoot, domainId: 'software-engineering', baseVersion: '1.0.0', newVersion: '1.0.1', candidateIds: [candidate.id] }), /approved/);
    assert.equal(existsSync(newDir), false);
    engine.evolution.review({ candidateId: candidate.id, decision: 'approve', reviewer: 'domain-curator' });
    const publication = await engine.publish({ domainRoot: paymentSnapshot.domainRoot, domainId: 'software-engineering', baseVersion: '1.0.0', newVersion: '1.0.1', candidateIds: [candidate.id] });
    assert.equal(publication.knowledgeCount, 7);
    assert.equal(engine.evolution.getCandidate(candidate.id).status, 'published');
    assert.equal(existsSync(path.join(newDir, 'knowledge/draft.unverified.json')), false);
    const manifest = JSON.parse(readFileSync(path.join(newDir, 'manifest.json')));
    assert.equal(manifest.version, '1.0.1');
    assert.ok(manifest.knowledgeFiles.includes('knowledge/pattern.retry-boundary.json'));
    assert.equal(manifest.knowledgeFiles.some((f) => f.includes('draft.unverified')), false);
    const published = JSON.parse(readFileSync(path.join(newDir, 'knowledge/pattern.retry-boundary.json')));
    assert.equal(published.status, 'published');
    assert.equal(published.sharing, 'shared');
    assert.equal(published.evidenceRefs.length, 1);
    assert.doesNotMatch(JSON.stringify(published), /local:tests\/retry/);
    await assert.rejects(engine.publish({ domainRoot: paymentSnapshot.domainRoot, domainId: 'software-engineering', baseVersion: '1.0.0', newVersion: '1.0.1', candidateIds: [candidate.id] }), /approved|already exists/);

    const otherProject = f.project('queue-worker');
    const configPath = path.join(otherProject, 'domain-context.json');
    const next = JSON.parse(readFileSync(configPath));
    next.domains[0].version = '1.0.1';
    writeFileSync(configPath, JSON.stringify(next));
    const otherSnapshot = await engine.resolve({ cwd: otherProject, sessionId: 'next-session' });
    assert.notEqual(otherSnapshot.id, paymentSnapshot.id);
    assert.equal(otherSnapshot.records.some((r) => r.id === 'pattern.retry-boundary'), true);
    const refs = engine.retrieve({ snapshot: otherSnapshot, query: 'retry deduplication crash' }).map((r) => r.id);
    assert.ok(refs.includes('pattern.retry-boundary'));
    const otherPlan = engine.compile({ snapshot: otherSnapshot, task: 'retry deduplication crash' });
    assert.match(otherPlan.dynamicContext, /Stable retry boundary/);
    assert.notEqual(sourcePlan.stableHash, otherPlan.stableHash);
    // Rollback is a project-reference change, never in-place mutation of the published package.
    next.domains[0].version = '1.0.0';
    writeFileSync(configPath, JSON.stringify(next));
    await assert.rejects(engine.resolve({ cwd: otherProject, sessionId: 'next-session' }), /pinned to a different domain snapshot/);
    const reverted = await engine.resolve({ cwd: otherProject, sessionId: 'rollback-session' });
    assert.equal(reverted.id, paymentSnapshot.id);
  } finally { engine.close(); f.cleanup(); }
});

test('publisher rejects duplicate knowledge IDs and keeps source domain immutable', async () => {
  const f = fixture();
  const engine = createDomainEngine({ dbPath: ':memory:' });
  try {
    const snap = await engine.resolve({ cwd: f.project('payment-service') });
    const evidence = seedEvidence(engine.evolution, seedRun(engine.evolution));
    const candidate = seedCandidate(engine.evolution, evidence.id, { knowledgeId: 'pattern.idempotency' });
    engine.evolution.review({ candidateId: candidate.id, decision: 'approve', reviewer: 'reviewer' });
    await assert.rejects(engine.publish({ domainRoot: snap.domainRoot, domainId: 'software-engineering', baseVersion: '1.0.0', newVersion: '1.0.1', candidateIds: [candidate.id] }), /already exists/);
    assert.equal(existsSync(path.join(f.dir, 'domains/software-engineering/1.0.1')), false);
  } finally { engine.close(); f.cleanup(); }
});

test('local Node test evidence actually executes with no shell and records pass/fail', async () => {
  const f = fixture();
  const engine = createDomainEngine({ dbPath: ':memory:' });
  try {
    const projectRoot = f.project('payment-service');
    const testDir = path.join(projectRoot, 'tests');
    mkdirSync(testDir);
    writeFileSync(path.join(testDir, 'pass.test.mjs'), "import assert from 'node:assert/strict'; assert.equal(2+2,4);\n");
    writeFileSync(path.join(testDir, 'fail.test.mjs'), "import assert from 'node:assert/strict'; assert.equal(2+2,5);\n");
    const runId = engine.evolution.beginRun({ sessionId: 'id', branchLeafId: 'branch', projectId: 'payment-service', projectRoot, snapshotId: 'hash' });
    engine.evolution.settleRun(runId);
    const ok = await engine.verifyNodeTest({ runId, projectRoot, testFile: 'tests/pass.test.mjs', summary: 'Arithmetic regression passes', sharingConsent: true });
    assert.equal(ok.passed, true);
    assert.equal(ok.evidence.verification_method, 'node-test');
    assert.match(ok.evidence.reference, /^node-test:tests\/pass.test.mjs@/);
    const fail = await engine.verifyNodeTest({ runId, projectRoot, testFile: 'tests/fail.test.mjs', summary: 'Negative test', sharingConsent: false });
    assert.equal(fail.passed, false);
    assert.equal(fail.evidence.outcome, 'failed');
    await assert.rejects(engine.verifyNodeTest({ runId, projectRoot, testFile: '../outside.test.mjs', summary: 'Invalid traversal' }), /Invalid relative path/);
  } finally { engine.close(); f.cleanup(); }
});

test('extractor sees only consented summaries; suggestions remain unpublished until human review', async () => {
  const engine = createDomainEngine({ dbPath: ':memory:' });
  try {
    const store = engine.evolution;
    const id = seedRun(store);
    const evidence = seedEvidence(store, id);
    let provided;
    const drafts = await engine.extract({ domainId: 'software-engineering', baseVersion: '1.0.0', evidenceIds: [evidence.id], extractor: async (input) => {
      provided = input;
      return [{ knowledgeId: 'pattern.new-check', kind: 'pattern', title: 'Cross-project retry check', claim: 'Test replay with a stable event key.', keywords: ['retry', 'replay'] }];
    } });
    assert.equal(provided.evidence[0].summary, evidence.summary);
    assert.equal('reference' in provided.evidence[0], false);
    assert.equal('projectId' in provided.evidence[0], false);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].status, 'candidate');
    assert.deepEqual(drafts[0].payload.evidenceIds, [evidence.id]);
    const privateE = seedEvidence(store, id, { sharingConsent: false });
    await assert.rejects(engine.extract({ domainId: 'software-engineering', baseVersion: '1.0.0', evidenceIds: [privateE.id], extractor: async () => [] }), /share-consented/);
  } finally { engine.close(); }
});
