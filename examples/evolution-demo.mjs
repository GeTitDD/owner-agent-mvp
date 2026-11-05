// End-to-end P2 demo. Uses temporary project copies; no API key and no changes to shared examples.
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createDomainEngine } from '../src/engine.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'domain-p2-demo-'));
const engine = createDomainEngine({ dbPath: path.join(tmp, 'index.sqlite') });
try {
  cpSync(path.join(repo, 'domains'), path.join(tmp, 'domains'), { recursive: true });
  for (const name of ['payment-service', 'queue-worker']) {
    mkdirSync(path.join(tmp, name));
    writeFileSync(path.join(tmp, name, 'domain-context.json'), JSON.stringify({
      project: { id: name, notes: 'demo workspace' }, domainRoot: '../domains',
      domains: [{ id: 'software-engineering', version: '1.0.0' }],
      context: { maxTokens: 2000 }, evolution: { capture: 'metadata' }
    }, null, 2));
  }
  const source = await engine.resolve({ cwd: path.join(tmp, 'payment-service'), sessionId: 'source-session' });
  const s = engine.evolution;
  const runId = s.beginRun({ sessionId: 'source-session', branchLeafId: 'branch-1', projectId: 'payment-service', projectRoot: path.join(tmp, 'payment-service'), snapshotId: source.id });
  s.recordTool({ runId, toolCallId: 'test-1', toolName: 'bash', isError: false, durationMs: 11 });
  s.settleRun(runId);
  mkdirSync(path.join(tmp, 'payment-service', 'tests'));
  writeFileSync(path.join(tmp, 'payment-service', 'tests', 'replay.test.mjs'), "import assert from 'node:assert/strict'; assert.equal(new Set(['event-a','event-a']).size, 1);\n");
  const verified = await engine.verifyNodeTest({
    runId, projectRoot: path.join(tmp, 'payment-service'), testFile: 'tests/replay.test.mjs',
    summary: 'Replay handling test uses a stable event identity', sharingConsent: true
  });
  if (!verified.passed) throw new Error('Demo test failed');
  // A deterministic sample extractor stands in for an external LLM; it does NOT auto-approve anything.
  const [candidate] = await engine.extract({
    domainId: 'software-engineering', baseVersion: '1.0.0', evidenceIds: [verified.evidence.id],
    extractor: async () => [{
      knowledgeId: 'pattern.replay-identity', kind: 'pattern', title: 'Replay identity check',
      claim: 'For at-least-once events, retain a stable event identity across retries and test duplicate replay before marking handling complete.',
      keywords: ['replay', 'duplicate', 'event', 'retry']
    }]
  });
  s.review({ candidateId: candidate.id, decision: 'approve', reviewer: 'demo-human-reviewer', note: 'Demo-only test evidence' });
  const pub = await engine.publish({ domainRoot: source.domainRoot, domainId: 'software-engineering', baseVersion: '1.0.0', newVersion: '1.0.1', candidateIds: [candidate.id] });
  const targetConfig = path.join(tmp, 'queue-worker', 'domain-context.json');
  const config = JSON.parse(readFileSync(targetConfig));
  config.domains[0].version = '1.0.1';
  writeFileSync(targetConfig, JSON.stringify(config));
  const target = await engine.resolve({ cwd: path.join(tmp, 'queue-worker'), sessionId: 'new-session' });
  const found = engine.retrieve({ snapshot: target, query: 'replay duplicate event identity retry' });
  const matched = found.find((r) => r.id === 'pattern.replay-identity');
  if (!matched) throw new Error('Cross-project knowledge transfer failed');
  console.log(JSON.stringify({
    verifiedTest: verified.passed,
    runId, candidateStatus: s.getCandidate(candidate.id).status,
    publishedVersion: pub.version, originalSnapshot: source.id.slice(0, 12), newSnapshot: target.id.slice(0, 12),
    recipientProject: target.profile.id, retrieved: matched.key,
    lesson: 'The demo shows a reviewed knowledge transfer; it does not measure model task-quality improvement.'
  }, null, 2));
} finally {
  engine.close();
  rmSync(tmp, { recursive: true, force: true });
}
