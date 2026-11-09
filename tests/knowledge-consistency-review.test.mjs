// PR #26 复审回归：dry-run/作用域、revisionId 映射、Compiler 采纳版本、运行时漂移与审批钩子。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { KnowledgeProvenance } from '../src/knowledge/provenance.mjs';
import { KnowledgeContextLedger } from '../src/knowledge/context-ledger.mjs';
import { KnowledgeReuse } from '../src/knowledge-loop/reuse.mjs';
import { createDomainEngine } from '../src/engine.mjs';
import { applyWorkspaceOverlay } from '../src/workspace-overlay.mjs';
import { exportBundle, importBundle } from '../src/knowledge/sync.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

const open = (device = 'dev-a') => {
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

const tableCounts = (store) => {
  const tables = [
    'personal_units', 'personal_revisions', 'knowledge_projects', 'knowledge_changes',
    'knowledge_sources', 'knowledge_source_observations', 'knowledge_source_links',
    'knowledge_adoptions', 'knowledge_revalidations', 'knowledge_conflicts',
    'knowledge_context_snapshots', 'knowledge_candidates', 'knowledge_pending_links',
    'knowledge_pending_adoptions'
  ];
  const counts = {};
  for (const table of tables) {
    try { counts[table] = store.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c; }
    catch { counts[table] = -1; }
  }
  return counts;
};

const observe = (provenance, projectId = 'demo', objectId = 'docs/retry.md') => provenance.observeSource({
  sourceType: 'file', namespace: 'local-file', objectId,
  sourceVersion: 'v1', locator: objectId, contentHash: 'abc123',
  availability: 'available', observedAt: new Date().toISOString(), projectId
}, { observedBy: 'agent', captureRunId: 'run-1' });

test('dry-run 不写项目、事件、来源、快照或知识', () => {
  const A = open('dev-a');
  const B = open('dev-b');
  try {
    A.provenance.ensureProject({ projectId: 'demo', identity: 'prj_demo', identityKind: 'git-remote' });
    const unit = makeUnit(A.store);
    const observed = observe(A.provenance);
    A.provenance.linkRevision({ unitId: unit.id, revision: 1, observationId: observed.observation.observationId });
    A.provenance.adopt({ unitId: unit.id, revision: 1 });
    const ledger = new KnowledgeContextLedger({ personalStore: A.store, device: 'dev-a' });
    ledger.record({
      projectId: 'demo', sessionId: 's1', task: 'dry run',
      plan: { compilationHash: 'c1', knowledgeRefs: [`workspace:${unit.id}:r1`] }
    });
    const bundle = exportBundle({ personalStore: A.store, provenance: A.provenance, projectId: 'demo', device: 'dev-a' });
    const before = tableCounts(B.store);
    const report = importBundle({
      personalStore: B.store, provenance: B.provenance, bundle, apply: false, device: 'dev-b'
    });
    const after = tableCounts(B.store);
    assert.deepEqual(after, before);
    assert.equal(report.applied, false);
    assert.ok(report.imported >= 1);
  } finally { A.store.close(); B.store.close(); }
});

test('作用域检查覆盖项目、历史修订、事件、来源与快照', () => {
  const A = open('dev-a');
  const C = open('dev-c');
  try {
    const demo = makeUnit(A.store, { title: 'Demo unit', projectId: 'demo' });
    const secret = makeUnit(A.store, { title: 'Secret unit', projectId: 'secret' });
    const demoSource = observe(A.provenance, 'demo', 'docs/demo.md');
    const secretSource = observe(A.provenance, 'secret', 'docs/secret.md');
    const globalSource = A.provenance.observeSource({
      sourceType: 'file', namespace: 'local-file', objectId: 'shared/global.md',
      sourceVersion: 'v1', locator: 'shared/global.md', contentHash: 'g1',
      availability: 'available', observedAt: new Date().toISOString(), projectId: null
    }, { observedBy: 'agent', captureRunId: 'run-1' });
    A.provenance.linkRevision({ unitId: demo.id, revision: 1, observationId: demoSource.observation.observationId });
    A.provenance.linkRevision({ unitId: secret.id, revision: 1, observationId: secretSource.observation.observationId });
    A.provenance.linkRevision({ unitId: secret.id, revision: 1, observationId: globalSource.observation.observationId });
    A.provenance.adopt({ unitId: demo.id, revision: 1 });
    const bundle = exportBundle({ personalStore: A.store, provenance: A.provenance, all: true, device: 'dev-a' });
    bundle.project = { projectId: 'secret', projectIdentity: 'prj_secret', identityKind: 'git-remote' };
    bundle.contextSnapshots = [
      { snapshotId: 'ctx_secret', projectId: 'secret', sessionId: 's', compilationHash: 'c', task: 't', createdAt: new Date().toISOString() },
      { snapshotId: 'ctx_demo', projectId: 'demo', sessionId: 's', compilationHash: 'c', task: 't', createdAt: new Date().toISOString() }
    ];
    const report = importBundle({
      personalStore: C.store, provenance: C.provenance, bundle,
      device: 'dev-c', allowedProjectIds: ['demo']
    });
    assert.equal(report.skippedScope, 4);
    assert.equal(report.skippedEvents, 3);
    assert.equal(C.store.list({ limit: 10 }).length, 1);
    assert.equal(C.store.list({ limit: 10 })[0].title, 'Demo unit');
    assert.equal(C.provenance.listSources({ limit: 10 }).filter((s) => s.projectId === 'secret').length, 0);
    assert.equal(C.provenance.listSources({ limit: 10 }).filter((s) => s.objectId === 'shared/global.md').length, 0);
    const snapshots = C.store.db.prepare('SELECT project_id FROM knowledge_context_snapshots').all().map((row) => row.project_id);
    assert.deepEqual(snapshots, ['demo']);
    const secretKnowledgeId = A.provenance.knowledgeIdForUnit(secret.id);
    const secretEvents = C.store.db.prepare('SELECT COUNT(*) AS c FROM knowledge_changes WHERE knowledge_id=?').get(secretKnowledgeId).c;
    assert.equal(secretEvents, 0);
    assert.equal(C.store.db.prepare("SELECT COUNT(*) AS c FROM knowledge_projects WHERE project_id='secret'").get().c, 0);
  } finally { A.store.close(); C.store.close(); }
});

test('跨设备来源与采纳按 revisionId 映射，不复用远端整数 revision', () => {
  const A = open('dev-a');
  const B = open('dev-b');
  try {
    const unit = makeUnit(A.store);
    // A 不采纳；先同步 R1 给 B，B 采纳 R1。
    importBundle({
      personalStore: B.store, provenance: B.provenance,
      bundle: exportBundle({ personalStore: A.store, provenance: A.provenance, all: true, device: 'dev-a' }),
      device: 'dev-b'
    });
    B.provenance.adopt({ unitId: unit.id, revision: 1 });
    B.store.update(unit.id, { ...B.store.get(unit.id), content: 'B experiment' }, { expectedRevision: 1, actor: 'agent', note: 'R2' });
    A.store.update(unit.id, { ...A.store.get(unit.id), content: 'A offline' }, { expectedRevision: 1, actor: 'owner', note: 'R3' });
    // B 先导入 A，产生冲突并保留候选；B 再采用远端生成 R4。
    importBundle({
      personalStore: B.store, provenance: B.provenance,
      bundle: exportBundle({ personalStore: A.store, provenance: A.provenance, all: true, device: 'dev-a' }),
      device: 'dev-b'
    });
    const conflict = B.provenance.listConflicts({ unitId: unit.id })[0];
    B.provenance.resolveConflict({ id: conflict.id, decision: 'accept-incoming', actor: 'owner' });
    const bRevision = B.store.get(unit.id).revision;
    const bR4 = B.provenance.listRevisions({ unitId: unit.id }).find((row) => row.localRevision === bRevision);
    B.provenance.adopt({ unitId: unit.id, revision: bRevision });
    const source = observe(B.provenance, 'demo', 'docs/r4.md');
    B.provenance.linkRevision({ unitId: unit.id, revision: bRevision, observationId: source.observation.observationId });
    // A 导入 B 的 R1/R2/R4：本地 revision 号与 B 不同（A 已有 R1+R3）。
    const report = importBundle({
      personalStore: A.store, provenance: A.provenance,
      bundle: exportBundle({ personalStore: B.store, provenance: B.provenance, all: true, device: 'dev-b' }),
      device: 'dev-a'
    });
    assert.ok(report.fastForwarded >= 1);
    const adopted = A.provenance.adoption(unit.id);
    assert.ok(adopted);
    const aRevision = A.store.get(unit.id).revision;
    assert.notEqual(adopted.revision, bRevision, '两端本地 revision 号应不同，才能验证映射');
    const adoptedRevision = A.provenance.listRevisions({ unitId: unit.id })
      .find((row) => row.localRevision === adopted.revision);
    assert.equal(adoptedRevision.revisionId, bR4.revisionId);
    assert.equal(A.store.revisions(unit.id).find((row) => row.revision === adopted.revision).payload.content, 'A offline');
    const links = A.provenance.linksFor({ unitId: unit.id, revision: adopted.revision });
    assert.equal(links.length, 1);
    assert.equal(links[0].observationId, source.observation.observationId);
    assert.equal(A.provenance.linksFor({ unitId: unit.id, revision: 3 }).length, 0);
  } finally { A.store.close(); B.store.close(); }
});

test('目标修订缺失时来源与采纳挂起，不猜本地 revision', () => {
  const A = open('dev-a');
  const B = open('dev-b');
  try {
    const unit = makeUnit(A.store);
    const source = observe(A.provenance);
    A.provenance.linkRevision({ unitId: unit.id, revision: 1, observationId: source.observation.observationId });
    const bundle = exportBundle({ personalStore: A.store, provenance: A.provenance, all: true, device: 'dev-a' });
    bundle.adoptions = [{ unitId: unit.id, revision: 2, revisionId: 'rev_00000000000000000000000000000000', actor: 'owner', note: 'missing target' }];
    bundle.links = [{ unitId: unit.id, revision: 2, revisionId: 'rev_00000000000000000000000000000000', observationId: source.observation.observationId, relation: 'supports' }];
    const report = importBundle({ personalStore: B.store, provenance: B.provenance, bundle, device: 'dev-b' });
    assert.ok(report.suspendedAdoptions >= 1);
    assert.ok(report.suspendedLinks >= 1);
    assert.equal(B.provenance.adoption(unit.id), null);
    assert.equal(B.provenance.linksFor({ unitId: unit.id, revision: 1 }).length, 0);
    assert.equal(B.store.db.prepare('SELECT COUNT(*) AS c FROM knowledge_pending_links').get().c, 1);
    assert.equal(B.store.db.prepare('SELECT COUNT(*) AS c FROM knowledge_pending_adoptions').get().c, 1);
  } finally { A.store.close(); B.store.close(); }
});

test('Compiler 使用已采纳修订（文件数据库）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compiler-adoption-'));
  const dbPath = path.join(dir, 'index.sqlite');
  const store = new PersonalKnowledgeStore(dbPath);
  try {
    const provenance = new KnowledgeProvenance({ personalStore: store, device: 'dev-a' });
    const unit = store.create({
      title: 'Retry loop bound', content: 'adopted R1 content',
      kind: 'claim', layer: 'applied', scope: 'domain',
      domains: ['software-engineering'], tags: ['retry'], verificationStatus: 'verified',
      evidenceRefs: ['sandbox:run-a']
    });
    provenance.adopt({ unitId: unit.id, revision: 1 });
    store.update(unit.id, { ...store.get(unit.id), content: 'unadopted R2 content' }, { expectedRevision: 1 });
    const snapshot = {
      profile: { id: 'demo' },
      domainItems: [{ id: 'software-engineering' }],
      projectRecords: [],
      projectSnapshotId: 'base'
    };
    const overlaid = applyWorkspaceOverlay(snapshot, {
      dbPath,
      config: { enabled: true, importDomainIds: ['software-engineering'], includeProject: false }
    });
    const record = overlaid.projectRecords.find((item) => item.id === unit.id);
    assert.ok(record);
    assert.equal(record.key, `workspace:${unit.id}:r1`);
    assert.equal(record.claim, 'adopted R1 content');
    assert.equal(record.verificationStatus, 'verified');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('KnowledgeReuse 与 Ledger 使用计划锁定的 revision，而非当前 Head', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reuse-drift-'));
  const dbPath = path.join(dir, 'loop.sqlite');
  const project = path.join(dir, 'project-b');
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
    const provenance = new KnowledgeProvenance({ personalStore: personal, device: 'dev-a' });
    const ledger = new KnowledgeContextLedger({ personalStore: personal, device: 'dev-a' });
    const unit = personal.create({
      title: 'Retry loop bound', content: 'Use i < attempts so the final retry executes.',
      kind: 'claim', layer: 'applied', scope: 'domain', domains: ['software-engineering'],
      tags: ['retry', 'off-by-one'], evidenceRefs: ['sandbox:run-a'],
      verificationStatus: 'verified', sourceRef: 'test'
    });
    provenance.adopt({ unitId: unit.id, revision: 1 });
    const reuse = new KnowledgeReuse({ personalStore: personal, engine, contextLedger: ledger });
    const compiled = await reuse.compileAsync({
      cwd: project, task: 'retry loop off-by-one', targetRunId: 'run-1', projectId: 'project-b'
    });
    assert.equal(compiled.usages[0].revision, 1);
    // 编译后 Head 变化：后续 Usage 仍必须指向计划中的 R1。
    personal.update(unit.id, { ...personal.get(unit.id), content: 'changed after compile' }, { expectedRevision: 1 });
    const usages = reuse.recordFromPlan({
      plan: compiled.plan, task: 'retry loop off-by-one', targetRunId: 'run-2',
      projectId: 'project-b', sessionId: 'session-2'
    });
    assert.equal(usages.length, 1);
    assert.equal(usages[0].revision, 1);
    const retrieved = reuse.retrieve({ snapshot: compiled.snapshot, task: 'retry loop off-by-one' });
    const personalRecord = retrieved.find((item) => item.knowledgeId === unit.id);
    assert.equal(personalRecord.revision, 1);
    const snapshot = ledger.latest({ projectId: 'project-b' });
    const restored = ledger.restore(snapshot.snapshotId);
    assert.equal(restored.refs[0].revision, 1);
    assert.equal(restored.refs[0].verificationStatus, 'verified');
    assert.equal(restored.refs[0].drift, 'revision-changed');
  } finally {
    personal.close(); engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('真实 Harvest 提案 → 批准 → 同步 → 复用的修订一致', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-proposal-sync-'));
  const dbA = path.join(dir, 'a.sqlite');
  const dbB = path.join(dir, 'b.sqlite');
  const project = path.join(dir, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'domain-context.json'), JSON.stringify({
    project: { id: 'project-sync', primaryDomain: 'software-engineering' },
    domainRoot: path.join(ROOT, 'domains'),
    domains: [{ id: 'software-engineering', version: '1.0.0' }],
    context: { maxTokens: 2000 },
    workspace: { enabled: true, importDomainIds: ['software-engineering'], includeProject: false }
  }, null, 2));
  const A = new PersonalKnowledgeStore(dbA);
  const B = new PersonalKnowledgeStore(dbB);
  const provA = new KnowledgeProvenance({ personalStore: A, device: 'dev-a' });
  const provB = new KnowledgeProvenance({ personalStore: B, device: 'dev-b' });
  const engineB = createDomainEngine({ dbPath: dbB });
  try {
    const unit = A.create({
      title: 'Retry loop bound', content: 'approved harvest content',
      kind: 'claim', layer: 'applied', scope: 'domain',
      domains: ['software-engineering'], tags: ['retry'], verificationStatus: 'verified',
      evidenceRefs: ['sandbox:run-a']
    });
    const proposal = A.submitProposal({
      targetId: unit.id,
      payload: { ...A.get(unit.id), content: 'approved harvest content v2' },
      actor: 'agent', note: 'harvest proposal'
    });
    A.reviewProposal(proposal.id, { decision: 'approved', reviewer: 'owner' });
    const approved = A.get(unit.id);
    assert.equal(approved.revision, 2);
    assert.equal(provA.listRevisions({ unitId: unit.id }).length, 2);
    provA.adopt({ unitId: unit.id, revision: 2 });

    importBundle({
      personalStore: B, provenance: provB,
      bundle: exportBundle({ personalStore: A, provenance: provA, all: true, device: 'dev-a' }),
      device: 'dev-b'
    });
    const adopted = provB.adoption(unit.id);
    assert.equal(adopted.revision, 2);
    const ledger = new KnowledgeContextLedger({ personalStore: B, device: 'dev-b' });
    const reuse = new KnowledgeReuse({ personalStore: B, engine: engineB, contextLedger: ledger });
    const compiled = await reuse.compileAsync({
      cwd: project, task: 'retry loop off-by-one', targetRunId: 'run-sync', projectId: 'project-sync'
    });
    assert.ok(compiled.plan.dynamicContext.includes('approved harvest content v2'));
    assert.equal(compiled.usages.length, 1);
    assert.equal(compiled.usages[0].revision, 2);
    const snapshot = ledger.latest({ projectId: 'project-sync' });
    assert.equal(snapshot.refs[0].revision, 2);
    const r2 = provB.listRevisions({ unitId: unit.id }).find((row) => row.localRevision === 2);
    assert.equal(snapshot.refs[0].revisionId, r2.revisionId);
    assert.equal(snapshot.refs[0].payloadHash, provB.getRevision(r2.revisionId).payloadHash);
  } finally {
    engineB.close(); A.close(); B.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('proposal 批准后立即写入修订索引与变更事件', () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    const provenance = new KnowledgeProvenance({ personalStore: store, device: 'dev-a' });
    const unit = store.create({
      title: 'Retry loop bound', content: 'initial',
      kind: 'claim', layer: 'applied', scope: 'domain',
      domains: ['software-engineering'], tags: ['retry'], verificationStatus: 'unverified',
      evidenceRefs: ['sandbox:run-a']
    });
    const knowledgeId = provenance.knowledgeIdForUnit(unit.id);
    const update = store.submitProposal({
      targetId: unit.id,
      payload: { ...store.get(unit.id), content: 'approved update' },
      actor: 'agent', note: 'harvest proposal'
    });
    store.reviewProposal(update.id, { decision: 'approved', reviewer: 'owner' });
    const revisions = provenance.listRevisions({ unitId: unit.id });
    assert.equal(revisions.length, 2);
    assert.equal(revisions[1].localRevision, 2);
    const changes = provenance.listChanges({ knowledgeId });
    assert.equal(changes.length, 2);
    assert.equal(changes[1].operation, 'revise');
    assert.equal(changes[1].resultRevisionId, revisions[1].revisionId);

    const create = store.submitProposal({
      payload: {
        title: 'New approved knowledge', content: 'from harvest',
        kind: 'claim', layer: 'applied', scope: 'domain',
        domains: ['software-engineering'], tags: ['new'], verificationStatus: 'unverified',
        evidenceRefs: ['sandbox:run-b']
      },
      actor: 'agent', note: 'new proposal'
    });
    store.reviewProposal(create.id, { decision: 'approved', reviewer: 'owner' });
    const reviewedCreate = store.proposal(create.id);
    const created = store.get(reviewedCreate.applied_id);
    const createdRevisions = provenance.listRevisions({ unitId: created.id });
    assert.equal(createdRevisions.length, 1);
    assert.equal(createdRevisions[0].localRevision, 1);
    const createdChanges = provenance.listChanges({ knowledgeId: provenance.knowledgeIdForUnit(created.id) });
    assert.equal(createdChanges.length, 1);
    assert.equal(createdChanges[0].operation, 'create');
  } finally { store.close(); }
});
