import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createDomainEngine } from '../src/engine.mjs';
import { estimateTokens } from '../src/utils.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const project = (name) => path.join(ROOT, 'examples', name);
function withEngine(fn) {
  const engine = createDomainEngine({ dbPath: ':memory:' });
  return Promise.resolve().then(() => fn(engine)).finally(() => engine.close());
}

test('three projects share immutable snapshot and stable prefix', () => withEngine(async (engine) => {
  const names = ['payment-service', 'queue-worker', 'webhook-service'];
  const plans = [];
  for (const name of names) {
    const snapshot = await engine.resolve({ cwd: project(name) });
    const plan = engine.compile({ snapshot, task: 'Investigate duplicate retries on incoming events' });
    plans.push(plan);
  }
  assert.equal(new Set(plans.map((p) => p.snapshotId)).size, 1);
  assert.equal(new Set(plans.map((p) => p.stableHash)).size, 1);
  assert.equal(new Set(plans.map((p) => p.dynamicContext)).size, 3);
}));

test('deterministic compilation: exact same inputs give exact same bytes', () => withEngine(async (engine) => {
  const snapshot = await engine.resolve({ cwd: project('payment-service') });
  const a = engine.compile({ snapshot, task: 'Implement idempotent retry' });
  const b = engine.compile({ snapshot, task: 'Implement idempotent retry' });
  assert.deepEqual(a, b);
  assert.equal(a.stableHash.length, 64);
  assert.equal(a.compilationHash.length, 64);
}));

test('different tasks select different domain knowledge', () => withEngine(async (engine) => {
  const snapshot = await engine.resolve({ cwd: project('payment-service') });
  const lease = engine.compile({ snapshot, task: 'worker lease heartbeat expiry race' });
  const webhook = engine.compile({ snapshot, task: 'webhook signature duplicate delivery' });
  assert.match(lease.dynamicContext, /Worker lease and recovery/);
  assert.match(webhook.dynamicContext, /Webhook duplicates and authenticity/);
  assert.notEqual(lease.compilationHash, webhook.compilationHash);
}));

test('unpublished private knowledge never enters index or context', () => withEngine(async (engine) => {
  const snapshot = await engine.resolve({ cwd: project('payment-service') });
  assert.ok(snapshot.records.every((r) => r.id !== 'draft.unverified'));
  assert.deepEqual(engine.retrieve({ snapshot, query: 'unverified private' }), []);
  assert.doesNotMatch(engine.compile({ snapshot, task: 'unverified private' }).dynamicContext, /NEVER be retrieved/);
}));

test('retrieve and skill discovery return versioned results', () => withEngine(async (engine) => {
  const snapshot = await engine.resolve({ cwd: project('webhook-service') });
  const recs = engine.retrieve({ snapshot, query: 'webhook signature' });
  assert.equal(recs[0].id, 'pattern.webhook');
  assert.match(recs[0].key, /^software-engineering@1\.0\.0:/);
  assert.equal(snapshot.skillPaths.length, 1);
  assert.match(snapshot.skillPaths[0], /reliable-retries$/);
}));

test('budgeted context does not exceed estimated token budget', () => withEngine(async (engine) => {
  const snapshot = await engine.resolve({ cwd: project('payment-service') });
  const plan = engine.compile({ snapshot, task: 'payment retry idempotency with webhook lease', maxTokens: 300 });
  assert.ok(plan.estimatedTokens <= 300, plan.estimatedTokens);
  assert.ok(estimateTokens(plan.stableContext) < 300);
}));

test('too-small budget fails closed rather than silently truncating stable invariants', () => withEngine(async (engine) => {
  const snapshot = await engine.resolve({ cwd: project('payment-service') });
  assert.throws(() => engine.compile({ snapshot, task: 'anything', maxTokens: 100 }), /exceeds token budget/);
}));

test('session snapshot is pinned and detects changed published files', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'domain-context-test-'));
  try {
    cpSync(path.join(ROOT, 'domains'), path.join(tmp, 'domains'), { recursive: true });
    mkdirSync(path.join(tmp, 'my-project'));
    writeFileSync(path.join(tmp, 'my-project', 'domain-context.json'), JSON.stringify({
      project: { id: 'my-project' }, domainRoot: '../domains',
      domains: [{ id: 'software-engineering', version: '1.0.0' }],
      context: { maxTokens: 1500 }
    }));
    await withEngine(async (engine) => {
      const cwd = path.join(tmp, 'my-project');
      const snap = await engine.resolve({ cwd, sessionId: 'session-1' });
      assert.equal(snap.id, (await engine.resolve({ cwd, sessionId: 'session-1' })).id);
      const p = path.join(tmp, 'domains/software-engineering/1.0.0/knowledge/pattern.idempotency.json');
      const modified = JSON.parse(readFileSync(p, 'utf8'));
      modified.claim += ' This statement was changed.';
      writeFileSync(p, JSON.stringify(modified));
      await assert.rejects(engine.resolve({ cwd, sessionId: 'session-1' }), /pinned to a different domain snapshot/);
      await assert.rejects(engine.resolve({ cwd, sessionId: 'session-2' }), /Immutable domain package was modified/);
    });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});


test('Skill contents are included in domain package hash', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'domain-context-skill-'));
  try {
    cpSync(path.join(ROOT, 'domains'), path.join(tmp, 'domains'), { recursive: true });
    mkdirSync(path.join(tmp, 'project'));
    writeFileSync(path.join(tmp, 'project', 'domain-context.json'), JSON.stringify({
      project: { id: 'skill-check' }, domainRoot: '../domains',
      domains: [{ id: 'software-engineering', version: '1.0.0' }]
    }));
    await withEngine(async (engine) => {
      const cwd = path.join(tmp, 'project');
      await engine.resolve({ cwd, sessionId: 'pinned' });
      const skill = path.join(tmp, 'domains/software-engineering/1.0.0/skills/reliable-retries/SKILL.md');
      writeFileSync(skill, readFileSync(skill, 'utf8') + '\nNew guidance\n');
      await assert.rejects(engine.resolve({ cwd, sessionId: 'pinned' }), /pinned to a different domain snapshot/);
      await assert.rejects(engine.resolve({ cwd, sessionId: 'new' }), /Immutable domain package was modified/);
    });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
test('loader rejects path escapes and malformed IDs', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'domain-context-escape-'));
  try {
    mkdirSync(path.join(tmp, 'project'));
    mkdirSync(path.join(tmp, 'domains'));
    writeFileSync(path.join(tmp, 'project', 'domain-context.json'), JSON.stringify({
      project: { id: 'safe-project' }, domainRoot: '../domains',
      domains: [{ id: '../../outside', version: '1.0.0' }]
    }));
    await withEngine((engine) => assert.rejects(engine.resolve({ cwd: path.join(tmp, 'project') }), /Invalid domain id/));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('missing project manifest is a no-op', () => withEngine(async (engine) => {
  assert.equal(await engine.resolve({ cwd: os.tmpdir() }), null);
}));
