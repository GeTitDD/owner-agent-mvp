// Knowledge Sync v2：双设备分叉、候选保留、R4 收敛、旧会话与作用域。
import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { KnowledgeProvenance } from '../src/knowledge/provenance.mjs';
import { KnowledgeContextLedger } from '../src/knowledge/context-ledger.mjs';
import { exportBundle, importBundle, SYNC_CONTRACT, SYNC_SCHEMA_VERSION, bundleToJsonl, bundleFromJsonl } from '../src/knowledge/sync.mjs';

const open = (device) => {
  const store = new PersonalKnowledgeStore(':memory:');
  const provenance = new KnowledgeProvenance({ personalStore: store, device });
  return { store, provenance };
};

const makeUnit = (store, overrides = {}) => store.create({
  title: 'Retry bound',
  content: 'loop with i < attempts',
  kind: 'claim',
  layer: 'project',
  scope: 'project',
  projectId: 'demo',
  domains: ['software-engineering'],
  tags: ['retry'],
  evidenceRefs: ['legacy:run-a'],
  verificationStatus: 'unverified',
  ...overrides
});

const observe = (provenance, objectId = 'docs/retry.md') => provenance.observeSource({
  sourceType: 'file', namespace: 'local-file', objectId,
  sourceVersion: 'v1', locator: objectId, contentHash: 'abc123',
  availability: 'available', observedAt: new Date().toISOString(), projectId: 'demo'
}, { observedBy: 'agent', captureRunId: 'run-1' });

test('双设备 R1 → R2/R3 分叉 → R4 收敛，旧会话仍引用 R1', () => {
  const A = open('dev-a');
  const B = open('dev-b');
  try {
    const unit = makeUnit(A.store);
    const observed = observe(A.provenance);
    A.provenance.linkRevision({ unitId: unit.id, revision: 1, observationId: observed.observation.observationId });
    A.provenance.adopt({ unitId: unit.id, revision: 1 });
    const r1 = A.provenance.listRevisions({ unitId: unit.id })[0];
    const ledger = new KnowledgeContextLedger({ personalStore: A.store, device: 'dev-a' });
    const snapshot = ledger.record({
      projectId: 'demo', sessionId: 'session-1', task: 'first run',
      plan: { compilationHash: 'compile-1', knowledgeRefs: [`workspace:${unit.id}:r1`] }
    });

    const first = exportBundle({ personalStore: A.store, provenance: A.provenance, all: true, device: 'dev-a' });
    assert.equal(first.contract, SYNC_CONTRACT);
    assert.equal(first.schemaVersion, SYNC_SCHEMA_VERSION);
    assert.ok(first.events.length >= 1);
    const imported = importBundle({ personalStore: B.store, provenance: B.provenance, bundle: first, device: 'dev-b' });
    assert.equal(imported.imported, 1);
    assert.equal(B.store.get(unit.id).content, 'loop with i < attempts');
    assert.equal(B.provenance.adoption(unit.id).revision, 1);
    assert.equal(B.provenance.linksFor({ unitId: unit.id, revision: 1 }).length, 1);
    assert.equal(B.provenance.knowledgeIdForUnit(unit.id), unit.id);

    // B 在另一会话形成 R2 候选（不自动替代已采纳的 R1）。
    B.store.update(unit.id, {
      ...B.store.get(unit.id), content: 'experiment result', tags: ['retry', 'exp']
    }, { expectedRevision: 1, actor: 'agent', note: 'experiment R2' });
    const r2 = B.provenance.listRevisions({ unitId: unit.id })[1];
    assert.equal(B.provenance.adoption(unit.id).revision, 1);

    // A 离线期间独立形成 R3。
    A.store.update(unit.id, {
      ...A.store.get(unit.id), content: 'offline edit', tags: ['retry', 'offline']
    }, { expectedRevision: 1, actor: 'owner', note: 'offline R3' });
    const r3 = A.provenance.listRevisions({ unitId: unit.id })[1];

    // A → B：识别共同祖先 R1，保留两条分支，本地 Head 不动。
    const second = exportBundle({ personalStore: A.store, provenance: A.provenance, all: true, device: 'dev-a' });
    const conflictReport = importBundle({ personalStore: B.store, provenance: B.provenance, bundle: second, device: 'dev-b' });
    assert.equal(B.store.get(unit.id).revision, 2);
    assert.equal(B.store.get(unit.id).content, 'experiment result');
    assert.ok(conflictReport.conflicts.length >= 1);
    const candidate = B.provenance.listCandidates({ unitId: unit.id })[0];
    assert.equal(candidate.revisionId, r3.revisionId);
    assert.equal(candidate.baseRevisionId, r1.revisionId);
    const preserved = new Set(B.provenance.listRevisions({ unitId: unit.id }).map((row) => row.revisionId));
    assert.ok(preserved.has(r2.revisionId));
    assert.ok(preserved.has(r3.revisionId));

    // Owner 审核后采用远端内容 → R4（双亲修订），并保留来源链接。
    const conflict = B.provenance.listConflicts({ unitId: unit.id })[0];
    const resolved = B.provenance.resolveConflict({ id: conflict.id, decision: 'accept-incoming', actor: 'owner' });
    assert.ok(resolved.revisionId);
    assert.equal(B.store.get(unit.id).revision, 3);
    assert.equal(B.store.get(unit.id).content, 'offline edit');
    const r4 = B.provenance.getRevision(resolved.revisionId);
    assert.ok(r4.parentRevisionIds.includes(r2.revisionId));
    assert.ok(r4.parentRevisionIds.includes(r3.revisionId));
    assert.equal(B.provenance.linksFor({ unitId: unit.id, revision: 3 }).length, 1);
    B.provenance.adopt({ unitId: unit.id, revision: 3 });

    // B → A：R4 的父修订包含 A 的 Head R3，按后代追加，不产生新冲突。
    const third = exportBundle({ personalStore: B.store, provenance: B.provenance, all: true, device: 'dev-b' });
    const converge = importBundle({ personalStore: A.store, provenance: A.provenance, bundle: third, device: 'dev-a' });
    assert.ok(converge.fastForwarded >= 1);
    assert.equal(converge.conflicts.length, 0);
    assert.equal(A.store.get(unit.id).content, 'offline edit');
    const aIds = new Set(A.provenance.listRevisions({ unitId: unit.id }).map((row) => row.revisionId));
    assert.ok(aIds.has(r2.revisionId));
    assert.ok(aIds.has(r3.revisionId));
    assert.ok(aIds.has(resolved.revisionId));

    // 旧 Session 仍指向 R1，并报告 revision-changed。
    const restored = ledger.restore(snapshot.snapshot.snapshotId);
    assert.equal(restored.refs[0].revision, 1);
    assert.equal(restored.refs[0].payloadHash, A.provenance.getRevision(r1.revisionId).payloadHash);
    assert.equal(restored.refs[0].drift, 'revision-changed');

    // 重复导入不产生新修订，事件按 change_id 幂等。
    const before = A.store.revisions(unit.id).length;
    const again = importBundle({ personalStore: A.store, provenance: A.provenance, bundle: third, device: 'dev-a' });
    assert.equal(again.unchanged, 1);
    assert.equal(A.store.revisions(unit.id).length, before);
    assert.equal(again.events.applied, 0);
    assert.ok(again.events.duplicates > 0);
  } finally { A.store.close(); B.store.close(); }
});

test('篡改内容或修订哈希的 Bundle 整条拒绝', () => {
  const A = open('dev-a');
  const B = open('dev-b');
  try {
    makeUnit(A.store);
    const bundle = exportBundle({ personalStore: A.store, provenance: A.provenance, all: true, device: 'dev-a' });
    bundle.units[0].revisions[0].payload.content = 'tampered';
    const report = importBundle({ personalStore: B.store, provenance: B.provenance, bundle, device: 'dev-b' });
    assert.equal(report.imported, 0);
    assert.ok(report.errors.some((item) => /hash mismatch/u.test(item.error)));
    assert.equal(B.store.list({ limit: 10 }).length, 0);
  } finally { A.store.close(); B.store.close(); }
});

test('未授权项目范围的数据不能通过同步绕过作用域', () => {
  const A = open('dev-a');
  const B = open('dev-b');
  try {
    makeUnit(A.store, { title: 'Demo unit' });
    makeUnit(A.store, { title: 'Secret unit', projectId: 'secret' });
    const bundle = exportBundle({ personalStore: A.store, provenance: A.provenance, all: true, device: 'dev-a' });
    const report = importBundle({
      personalStore: B.store, provenance: B.provenance, bundle,
      device: 'dev-b', allowedProjectIds: ['demo']
    });
    assert.equal(report.imported, 1);
    assert.equal(report.skippedScope, 1);
    const titles = B.store.list({ limit: 10 }).map((unit) => unit.title);
    assert.deepEqual(titles, ['Demo unit']);
  } finally { A.store.close(); B.store.close(); }
});

test('事件乱序与重复导入都保持幂等', () => {
  const A = open('dev-a');
  const B = open('dev-b');
  try {
    const unit = makeUnit(A.store);
    A.provenance.adopt({ unitId: unit.id, revision: 1 });
    const bundle = exportBundle({ personalStore: A.store, provenance: A.provenance, all: true, device: 'dev-a' });
    const reversed = { ...bundle, events: [...bundle.events].reverse() };
    const first = importBundle({ personalStore: B.store, provenance: B.provenance, bundle: reversed, device: 'dev-b' });
    assert.equal(first.events.applied, bundle.events.length);
    const second = importBundle({ personalStore: B.store, provenance: B.provenance, bundle: reversed, device: 'dev-b' });
    assert.equal(second.events.applied, 0);
    assert.equal(second.events.duplicates, bundle.events.length);
    assert.equal(second.imported, 0);
    assert.equal(second.unchanged, 1);
  } finally { A.store.close(); B.store.close(); }
});

test('dry-run 只出计划，不写候选、冲突或修订', () => {
  const A = open('dev-a');
  const B = open('dev-b');
  try {
    const unit = makeUnit(A.store);
    importBundle({ personalStore: B.store, provenance: B.provenance, bundle: exportBundle({ personalStore: A.store, provenance: A.provenance, all: true, device: 'dev-a' }), device: 'dev-b' });
    A.store.update(unit.id, { ...A.store.get(unit.id), content: 'a-content' }, { expectedRevision: 1 });
    B.store.update(unit.id, { ...B.store.get(unit.id), content: 'b-content' }, { expectedRevision: 1 });
    const before = B.store.get(unit.id).revision;
    const report = importBundle({
      personalStore: B.store, provenance: B.provenance,
      bundle: exportBundle({ personalStore: A.store, provenance: A.provenance, all: true, device: 'dev-a' }),
      device: 'dev-b', apply: false
    });
    assert.equal(B.store.get(unit.id).revision, before);
    assert.equal(B.provenance.listCandidates({ unitId: unit.id }).length, 0);
    assert.equal(B.provenance.listConflicts({ unitId: unit.id }).length, 0);
    assert.ok(report.conflicts.length >= 1);
  } finally { A.store.close(); B.store.close(); }
});

test('跨设备同步新版本后，旧 Usage/Feedback 仍指向运行使用的修订', () => {
  const A = open('dev-a');
  const B = open('dev-b');
  try {
    const unit = makeUnit(A.store);
    const r1 = A.provenance.listRevisions({ unitId: unit.id })[0];
    const ledger = new KnowledgeContextLedger({ personalStore: A.store, device: 'dev-a' });
    const snapshot = ledger.record({
      projectId: 'demo', sessionId: 'old-session', task: 'old run',
      plan: { compilationHash: 'compile-old', knowledgeRefs: [`workspace:${unit.id}:r1`] }
    });
    importBundle({
      personalStore: B.store, provenance: B.provenance,
      bundle: exportBundle({ personalStore: A.store, provenance: A.provenance, all: true, device: 'dev-a' }),
      device: 'dev-b'
    });
    B.store.update(unit.id, { ...B.store.get(unit.id), content: 'new version from B' }, {
      expectedRevision: 1, actor: 'owner', note: 'B revision'
    });
    const r2 = B.provenance.listRevisions({ unitId: unit.id })[1];
    importBundle({
      personalStore: A.store, provenance: A.provenance,
      bundle: exportBundle({ personalStore: B.store, provenance: B.provenance, all: true, device: 'dev-b' }),
      device: 'dev-a'
    });
    assert.equal(A.store.get(unit.id).revision, 2);
    assert.equal(A.provenance.getRevision(r1.revisionId).payload.content, 'loop with i < attempts');
    assert.equal(A.provenance.getRevision(r2.revisionId).payload.content, 'new version from B');

    // Usage 在同步之后写入，但必须指向当时运行实际使用的 R1。
    const usage = A.store.addUsage({
      knowledgeId: unit.id, revision: 1, targetRunId: 'run-old',
      projectId: 'demo', contextSnapshotId: snapshot.snapshot.snapshotId
    });
    assert.equal(usage.revision, 1);
    const feedback = A.store.addFeedback({
      usageId: usage.id, outcome: 'success', observedBenefit: 'positive'
    });
    assert.equal(feedback.usageId, usage.id);
    const restored = ledger.restore(snapshot.snapshot.snapshotId);
    assert.equal(restored.refs[0].revision, 1);
    assert.equal(restored.refs[0].payloadHash, A.provenance.getRevision(r1.revisionId).payloadHash);
    assert.equal(restored.refs[0].drift, 'revision-changed');
    // Feedback 通过 usage 关联，不会自动改挂到新 Head。
    assert.equal(A.store.getUsage(usage.id).revision, 1);
  } finally { A.store.close(); B.store.close(); }
});

test('JSONL Bundle 往返保留单元与事件，坏行整包拒绝', () => {
  const A = open('dev-a');
  const B = open('dev-b');
  try {
    const unit = makeUnit(A.store);
    A.provenance.adopt({ unitId: unit.id, revision: 1 });
    const bundle = exportBundle({ personalStore: A.store, provenance: A.provenance, all: true, device: 'dev-a' });
    const jsonl = bundleToJsonl(bundle);
    assert.match(jsonl.split('\n')[0], /"type":"header"/u);
    const restored = bundleFromJsonl(jsonl);
    assert.equal(restored.contract, SYNC_CONTRACT);
    assert.equal(restored.units.length, bundle.units.length);
    assert.equal(restored.events.length, bundle.events.length);
    const report = importBundle({ personalStore: B.store, provenance: B.provenance, bundle: restored, device: 'dev-b' });
    assert.equal(report.imported, 1);
    assert.equal(B.store.get(unit.id).content, 'loop with i < attempts');
    assert.throws(() => bundleFromJsonl('{"type":"header"}\n{bad}\n'), /Malformed JSONL/u);
  } finally { A.store.close(); B.store.close(); }
});

test('增量导出只包含游标之后变更的单元', () => {
  const A = open('dev-a');
  const B = open('dev-b');
  try {
    const unit = makeUnit(A.store, { title: 'Unit one' });
    makeUnit(A.store, { title: 'Unit two' });
    const first = exportBundle({ personalStore: A.store, provenance: A.provenance, all: true, device: 'dev-a' });
    importBundle({ personalStore: B.store, provenance: B.provenance, bundle: first, device: 'dev-b' });
    const cursor = first.cursor.lastChangeAppliedAt;
    A.store.update(unit.id, { ...A.store.get(unit.id), content: 'changed later' }, { expectedRevision: 1 });
    const delta = exportBundle({
      personalStore: A.store, provenance: A.provenance, since: cursor, device: 'dev-a'
    });
    const titles = delta.units.map((item) => item.revisions[item.revisions.length - 1].payload.title);
    assert.deepEqual(titles, ['Unit one']);
    const applied = importBundle({ personalStore: B.store, provenance: B.provenance, bundle: delta, device: 'dev-b' });
    assert.equal(applied.fastForwarded, 1);
    assert.equal(B.store.get(unit.id).content, 'changed later');
  } finally { A.store.close(); B.store.close(); }
});
