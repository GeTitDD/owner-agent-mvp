// Knowledge Provenance v2：修订索引、变更事件、身份映射与冲突候选。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { KnowledgeProvenance } from '../src/knowledge/provenance.mjs';
import { revisionIdFor } from '../src/knowledge/sources.mjs';

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

test('revisionId 对相同内容/父修订稳定，对内容变化敏感', () => {
  const base = {
    knowledgeId: 'personal.k1',
    contentHash: 'hash-a',
    parentRevisionIds: ['rev_1'],
    reason: 'Edited',
    actorId: 'user'
  };
  assert.equal(revisionIdFor(base), revisionIdFor({ ...base }));
  assert.notEqual(revisionIdFor(base), revisionIdFor({ ...base, contentHash: 'hash-b' }));
  assert.notEqual(revisionIdFor(base), revisionIdFor({ ...base, parentRevisionIds: ['rev_2'] }));
});

test('旧库打开时自动补齐身份与修订索引，并保留父子链', () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    const unit = makeUnit(store);
    store.update(unit.id, { ...store.get(unit.id), content: 'revised' }, { expectedRevision: 1 });
    const provenance = new KnowledgeProvenance({ personalStore: store, device: 'dev-a' });
    const knowledgeId = provenance.knowledgeIdForUnit(unit.id);
    assert.equal(knowledgeId, unit.id);
    const revisions = provenance.listRevisions({ unitId: unit.id });
    assert.equal(revisions.length, 2);
    assert.equal(revisions[0].parentRevisionIds.length, 0);
    assert.deepEqual(revisions[1].parentRevisionIds, [revisions[0].revisionId]);
    assert.equal(revisions[1].localRevision, 2);
    assert.equal(revisions[1].status, 'active');
  } finally { store.close(); }
});

test('新修订写入时自动记录索引与变更事件，重复事件幂等', () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    const provenance = new KnowledgeProvenance({ personalStore: store, device: 'dev-a' });
    const unit = makeUnit(store);
    const knowledgeId = provenance.knowledgeIdForUnit(unit.id);
    const first = provenance.listRevisions({ unitId: unit.id });
    assert.equal(first.length, 1);
    const changes = provenance.listChanges({ knowledgeId });
    assert.equal(changes.length, 1);
    assert.equal(changes[0].operation, 'create');
    assert.equal(changes[0].resultRevisionId, first[0].revisionId);

    store.update(unit.id, { ...store.get(unit.id), content: 'revised' }, { expectedRevision: 1 });
    const second = provenance.listRevisions({ unitId: unit.id });
    assert.equal(second.length, 2);
    assert.deepEqual(second[1].parentRevisionIds, [second[0].revisionId]);
    assert.equal(provenance.listChanges({ knowledgeId }).length, 2);

    const payload = changes[0].payload;
    const duplicate = provenance.appendChange({
      changeId: changes[0].changeId,
      knowledgeId,
      operation: 'create',
      resultRevisionId: first[0].revisionId,
      payload
    });
    assert.equal(duplicate.duplicate, true);
    assert.throws(() => provenance.appendChange({
      changeId: changes[0].changeId,
      knowledgeId,
      operation: 'create',
      resultRevisionId: first[0].revisionId,
      payload: { ...payload, tampered: true }
    }), /different payload/u);
  } finally { store.close(); }
});

test('Owner 采纳与来源链接产生可审计事件', () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    const provenance = new KnowledgeProvenance({ personalStore: store, device: 'dev-a' });
    const unit = makeUnit(store);
    const observed = provenance.observeSource({
      sourceType: 'file', namespace: 'local-file', objectId: 'docs/retry.md',
      sourceVersion: 'v1', locator: 'docs/retry.md', contentHash: 'abc123',
      availability: 'available', observedAt: new Date().toISOString(), projectId: 'demo'
    });
    assert.equal(observed.observation.sourceSystem, 'local-file');
    assert.equal(observed.observation.sourceLocator, 'docs/retry.md');
    provenance.linkRevision({ unitId: unit.id, revision: 1, observationId: observed.observation.observationId });
    provenance.adopt({ unitId: unit.id, revision: 1, note: 'owner accepted' });
    const knowledgeId = provenance.knowledgeIdForUnit(unit.id);
    const operations = provenance.listChanges({ knowledgeId }).map((item) => item.operation);
    assert.ok(operations.includes('link-source'));
    assert.ok(operations.includes('adopt'));
    const explain = provenance.explain(unit.id);
    assert.equal(explain.knowledgeId, knowledgeId);
    assert.ok(explain.headRevisionId);
    assert.equal(explain.revisions[0].revisionId, explain.headRevisionId);
    assert.equal(explain.changes.length, operations.length);
  } finally { store.close(); }
});

test('候选修订与冲突可持久化并保留来源包', () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    const provenance = new KnowledgeProvenance({ personalStore: store, device: 'dev-a' });
    const unit = makeUnit(store);
    const knowledgeId = provenance.knowledgeIdForUnit(unit.id);
    const candidate = provenance.addCandidate({
      knowledgeId, unitId: unit.id, baseRevisionId: null,
      revisionId: 'rev_remote_1', payload: { content: 'remote' }, payloadHash: 'h',
      sourceBundle: { sources: [] }, originDevice: 'dev-b'
    });
    assert.equal(provenance.listCandidates({ unitId: unit.id }).length, 1);
    assert.equal(provenance.getCandidate(candidate.candidateId).originDevice, 'dev-b');
    const conflict = provenance.addConflict({
      unitId: unit.id, field: 'content', baseValue: 'a', localValue: 'b', incomingValue: 'c',
      localRevision: 1, incomingRevision: 1, incomingOrigin: 'dev-b', candidateId: candidate.candidateId
    });
    assert.equal(conflict.candidateId, candidate.candidateId);
    assert.equal(provenance.listConflicts({ unitId: unit.id }).length, 1);
  } finally { store.close(); }
});

test('关闭并重新打开文件数据库后索引与冲突仍在', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-restart-'));
  const file = path.join(dir, 'index.sqlite');
  const store = new PersonalKnowledgeStore(file);
  let unitId = '';
  try {
    const provenance = new KnowledgeProvenance({ personalStore: store, device: 'dev-a' });
    const unit = makeUnit(store);
    unitId = unit.id;
    assert.equal(provenance.listRevisions({ unitId }).length, 1);
  } finally { store.close(); }
  const reopened = new PersonalKnowledgeStore(file);
  try {
    const provenance = new KnowledgeProvenance({ personalStore: reopened, device: 'dev-a' });
    assert.equal(provenance.listRevisions({ unitId }).length, 1);
    assert.equal(provenance.listRevisions({ unitId })[0].deviceId, 'dev-a');
  } finally {
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
