// 离线同步：导出、导入、fast-forward、三方合并、冲突保留与完整性校验。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { KnowledgeProvenance } from '../src/knowledge/provenance.mjs';
import {
  exportBundle, importBundle, classifyImport, mergePayloads, SYNC_CONTRACT
} from '../src/knowledge/sync.mjs';

const makeUnit = (store, { content = 'loop with i < attempts', tags = ['retry'] } = {}) => store.create({
  title: 'Retry bound', content, kind: 'claim', layer: 'project', scope: 'project',
  projectId: 'demo', domains: ['software-engineering'], tags,
  evidenceRefs: ['legacy:run-a'], verificationStatus: 'unverified'
});

const pair = () => ({
  a: new PersonalKnowledgeStore(':memory:'),
  b: new PersonalKnowledgeStore(':memory:')
});

test('classifyImport：unchanged / fast-forward / local-ahead / diverged', () => {
  assert.equal(classifyImport([], ['h1']).action, 'new');
  assert.equal(classifyImport(['h1'], ['h1']).action, 'unchanged');
  assert.equal(classifyImport(['h1'], ['h1', 'h2']).action, 'fast-forward');
  assert.equal(classifyImport(['h1', 'h2'], ['h1']).action, 'local-ahead');
  assert.equal(classifyImport(['h1', 'a'], ['h1', 'b']).action, 'diverged');
  assert.equal(classifyImport(['a'], ['b']).action, 'diverged');
});

test('mergePayloads：单边改动自动合并，双边冲突不替 Owner 选择', () => {
  const base = { content: 'c1', tags: ['t1'], title: 'T' };
  const local = { content: 'c2', tags: ['t1'], title: 'T' };
  const incoming = { content: 'c1', tags: ['t2'], title: 'T' };
  const merged = mergePayloads({ base, local, incoming });
  assert.equal(merged.conflicts.length, 0);
  assert.equal(merged.merged.content, 'c2');
  assert.deepEqual(merged.merged.tags, ['t2']);

  const conflict = mergePayloads({
    base,
    local: { ...base, content: 'local' },
    incoming: { ...base, content: 'incoming' }
  });
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(conflict.merged.content, 'local');
});

test('导入新单元保留原 ID、修订与哈希', () => {
  const { a, b } = pair();
  try {
    const unit = makeUnit(a);
    a.update(unit.id, { ...unit, content: 'revised claim' }, { expectedRevision: 1 });
    const bundle = exportBundle({ personalStore: a, projectId: 'demo', device: 'dev-a' });
    assert.equal(bundle.contract, SYNC_CONTRACT);
    assert.equal(bundle.units.length, 1);
    assert.equal(bundle.units[0].revisions.length, 2);

    const report = importBundle({ personalStore: b, bundle, device: 'dev-b' });
    assert.equal(report.imported, 1);
    assert.deepEqual(report.errors, []);
    const imported = b.get(unit.id);
    assert.equal(imported.revision, 2);
    assert.equal(imported.content, 'revised claim');
    assert.equal(b.revisions(unit.id).length, 2);
  } finally { a.close(); b.close(); }
});

test('重复导入是幂等的，远端领先时 fast-forward 追加修订', () => {
  const { a, b } = pair();
  try {
    const unit = makeUnit(a);
    const first = exportBundle({ personalStore: a, device: 'dev-a' });
    importBundle({ personalStore: b, bundle: first, device: 'dev-b' });
    const again = importBundle({ personalStore: b, bundle: first, device: 'dev-b' });
    assert.equal(again.unchanged, 1);
    assert.equal(b.get(unit.id).revision, 1);

    a.update(unit.id, { ...a.get(unit.id), content: 'newer claim' }, { expectedRevision: 1 });
    const second = exportBundle({ personalStore: a, device: 'dev-a' });
    const report = importBundle({ personalStore: b, bundle: second, device: 'dev-b' });
    assert.equal(report.fastForwarded, 1);
    assert.equal(b.get(unit.id).revision, 2);
    assert.equal(b.get(unit.id).content, 'newer claim');
    const revisions = b.revisions(unit.id);
    assert.match(revisions[0].note, /sync:dev-b/u);
  } finally { a.close(); b.close(); }
});

test('双方分叉但字段不冲突：三方合并成一个新修订', () => {
  const { a, b } = pair();
  try {
    const unit = makeUnit(a);
    importBundle({ personalStore: b, bundle: exportBundle({ personalStore: a, device: 'dev-a' }), device: 'dev-b' });

    a.update(unit.id, { ...a.get(unit.id), content: 'content from A' }, { expectedRevision: 1 });
    b.update(unit.id, { ...b.get(unit.id), tags: ['retry', 'from-b'] }, { expectedRevision: 1 });

    const report = importBundle({
      personalStore: b,
      provenance: new KnowledgeProvenance({ personalStore: b, device: 'dev-b' }),
      bundle: exportBundle({ personalStore: a, device: 'dev-a' }),
      device: 'dev-b'
    });
    assert.equal(report.merged, 1);
    assert.deepEqual(report.conflicts, []);
    const merged = b.get(unit.id);
    assert.equal(merged.revision, 3);
    assert.equal(merged.content, 'content from A');
    assert.deepEqual(merged.tags, ['retry', 'from-b']);
  } finally { a.close(); b.close(); }
});

test('双方修改同一字段：保留本地 Head 并记录 conflict，不静默覆盖', () => {
  const { a, b } = pair();
  try {
    const unit = makeUnit(a);
    importBundle({ personalStore: b, bundle: exportBundle({ personalStore: a, device: 'dev-a' }), device: 'dev-b' });

    a.update(unit.id, { ...a.get(unit.id), content: 'A version' }, { expectedRevision: 1 });
    b.update(unit.id, { ...b.get(unit.id), content: 'B version' }, { expectedRevision: 1 });
    const provenance = new KnowledgeProvenance({ personalStore: b, device: 'dev-b' });

    const report = importBundle({
      personalStore: b,
      provenance,
      bundle: exportBundle({ personalStore: a, device: 'dev-a' }),
      device: 'dev-b'
    });
    assert.equal(report.merged, 0);
    assert.equal(report.conflicts.length, 1);
    assert.deepEqual(report.conflicts[0].fields, ['content']);
    assert.equal(b.get(unit.id).revision, 2);
    assert.equal(b.get(unit.id).content, 'B version');
    const open = provenance.listConflicts({ unitId: unit.id, status: 'open' });
    assert.equal(open.length, 1);
    assert.equal(open[0].localValue, 'B version');
    assert.equal(open[0].incomingValue, 'A version');
    assert.match(open[0].incomingOrigin, /dev-b:dev-a/u);
  } finally { a.close(); b.close(); }
});

test('篡改哈希的条目被拒绝，不会写入', () => {
  const { a, b } = pair();
  try {
    const unit = makeUnit(a);
    const bundle = exportBundle({ personalStore: a, device: 'dev-a' });
    bundle.units[0].revisions[0].payloadHash = 'f'.repeat(64);
    const report = importBundle({ personalStore: b, bundle, device: 'dev-b' });
    assert.equal(report.imported, 0);
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0].error, /Payload hash mismatch/u);
    assert.equal(b.get(unit.id), null);
  } finally { a.close(); b.close(); }
});

test('dry-run 只报告不落库', () => {
  const { a, b } = pair();
  try {
    const unit = makeUnit(a);
    const bundle = exportBundle({ personalStore: a, device: 'dev-a' });
    const report = importBundle({ personalStore: b, bundle, apply: false, device: 'dev-b' });
    assert.equal(report.applied, false);
    assert.equal(report.imported, 1);
    assert.equal(b.get(unit.id), null);
  } finally { a.close(); b.close(); }
});

test('来源、观察、链接与采纳随包同步，且不覆盖本地采纳', () => {
  const { a, b } = pair();
  try {
    const unit = makeUnit(a);
    const provenanceA = new KnowledgeProvenance({ personalStore: a, device: 'dev-a' });
    const observed = provenanceA.observeSource({
      sourceType: 'git', namespace: 'git:prj_a', objectId: 'prj_a:src/retry.js',
      sourceVersion: 'commit-1', locator: 'src/retry.js', contentHash: 'blob-1',
      availability: 'available', projectId: 'demo'
    }, { captureRunId: 'cap-1' });
    provenanceA.linkRevision({
      unitId: unit.id, revision: 1, observationId: observed.observation.observationId, relation: 'supports'
    });
    provenanceA.adopt({ unitId: unit.id, revision: 1, note: 'A adoption' });

    const bundle = exportBundle({ personalStore: a, provenance: provenanceA, projectId: 'demo', device: 'dev-a' });
    assert.equal(bundle.sources.length, 1);
    assert.equal(bundle.observations.length, 1);
    assert.equal(bundle.links.length, 1);
    assert.equal(bundle.adoptions.length, 1);

    const provenanceB = new KnowledgeProvenance({ personalStore: b, device: 'dev-b' });
    const report = importBundle({ personalStore: b, provenance: provenanceB, bundle, device: 'dev-b' });
    assert.equal(report.provenance.sources, 1);
    assert.equal(report.provenance.observations, 1);
    assert.equal(report.provenance.adoptions, 1);
    assert.equal(provenanceB.linksFor({ unitId: unit.id, revision: 1 }).length, 1);
    assert.equal(provenanceB.adoption(unit.id).revision, 1);

    // B 本地已有采纳 → 再次导入不覆盖 Owner 的决定。
    provenanceB.adopt({ unitId: unit.id, revision: 1, note: 'B decision' });
    const again = importBundle({ personalStore: b, provenance: provenanceB, bundle, device: 'dev-b' });
    assert.equal(again.provenance.adoptions, 0);
    assert.equal(provenanceB.adoption(unit.id).note, 'B decision');
  } finally { a.close(); b.close(); }
});

test('项目身份登记：同 identity 不重复建项目，不同 identity 拒绝', () => {  const store = new PersonalKnowledgeStore(':memory:');
  try {
    const provenance = new KnowledgeProvenance({ personalStore: store });
    const created = provenance.ensureProject({ projectId: 'demo', identity: 'prj_aaa111', identityKind: 'git-remote' });
    assert.equal(created.projectIdentity, 'prj_aaa111');
    const again = provenance.ensureProject({ projectId: 'demo', identity: 'prj_aaa111', identityKind: 'git-remote' });
    assert.equal(again.projectIdentity, 'prj_aaa111');
    assert.throws(
      () => provenance.ensureProject({ projectId: 'demo', identity: 'prj_bbb222', identityKind: 'git-remote' }),
      /different identity/u
    );
    // 同一仓库在不同设备/目录注册了不同 projectId：记录别名，而不是复制或报错丢弃。
    const aliased = provenance.ensureProject({ projectId: 'other', identity: 'prj_aaa111', identityKind: 'git-remote' });
    assert.equal(aliased.aliasOf, 'demo');
    assert.ok(aliased.aliases.includes('other'));
  } finally { store.close(); }
});

test('同步包携带项目身份：导入端登记 identity 并记录别名', () => {
  const { a, b } = pair();
  try {
    const unit = makeUnit(a);
    const provenanceA = new KnowledgeProvenance({ personalStore: a, device: 'dev-a' });
    provenanceA.ensureProject({ projectId: 'demo', identity: 'prj_shared001', identityKind: 'git-remote' });
    const bundle = exportBundle({ personalStore: a, provenance: provenanceA, projectId: 'demo', device: 'dev-a' });
    assert.equal(bundle.project.projectIdentity, 'prj_shared001');

    const provenanceB = new KnowledgeProvenance({ personalStore: b, device: 'dev-b' });
    const report = importBundle({ personalStore: b, provenance: provenanceB, bundle, device: 'dev-b' });
    assert.equal(report.project, 'registered');
    assert.equal(provenanceB.getProject('demo').projectIdentity, 'prj_shared001');
    assert.equal(b.get(unit.id).revision, 1);

    // 本地同名项目已被绑定到不同 identity → 不覆盖，只报告。
    provenanceB.ensureProject({ projectId: 'local-other', identity: 'prj_other002', identityKind: 'local-root' });
    const conflicting = importBundle({
      personalStore: b,
      provenance: provenanceB,
      bundle: { ...bundle, project: { ...bundle.project, projectId: 'local-other' } },
      device: 'dev-b'
    });
    assert.match(conflicting.project, /^skipped:/u);
    assert.equal(provenanceB.getProject('local-other').projectIdentity, 'prj_other002');
  } finally { a.close(); b.close(); }
});

test('非 git 目录退到 local-root 身份，并明确标记', () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    const provenance = new KnowledgeProvenance({ personalStore: store });
    // 用不存在的目录：git 探测失败，必须退到本地根身份而不是抛错。
    const root = path.join(os.tmpdir(), `prov-local-missing-${Date.now()}`);
    const project = provenance.ensureProjectFromRoot({ projectId: 'local-demo', root });
    assert.equal(project.identityKind, 'local-root');
    assert.match(project.projectIdentity, /^prj_[a-f0-9]{24}$/u);
    assert.equal(project.aliases.includes('local-demo'), true);
  } finally { store.close(); }
});
