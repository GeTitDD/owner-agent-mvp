// Knowledge Maintenance & Provenance：来源身份、观察、绑定、采纳、重验证与会话上下文。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { OwnerStore } from '../src/owner-store.mjs';
import { KnowledgeProvenance } from '../src/knowledge/provenance.mjs';
import { KnowledgeContextLedger } from '../src/knowledge/context-ledger.mjs';
import {
  sourceIdFor, observationIdFor, normalizeSourceDescriptor, parseLegacyRef,
  computeProjectIdentity
} from '../src/knowledge/sources.mjs';
import {
  resolveGitFileSource, resolveLocalFileSource, resolveGitHubSource,
  resolveOwnerRunSource, resolveSessionSource, SourceResolveError
} from '../src/knowledge/resolvers.mjs';
import { createSyntheticProject } from '../scripts/knowledge-loop/fixtures.mjs';
import { KnowledgeReuse } from '../src/knowledge-loop/reuse.mjs';

const makeUnit = (store, { content = 'loop with i < attempts', verificationStatus = 'unverified' } = {}) => store.create({
  title: 'Retry bound', content, kind: 'claim', layer: 'project', scope: 'project',
  projectId: 'demo', domains: ['software-engineering'], tags: ['retry'],
  evidenceRefs: ['legacy:run-a'], verificationStatus
});

const makeGitRepo = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-git-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'retry.js'), 'export const attempts = 7;\n', 'utf8');
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q', '-b', 'main']);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'user.email', 'prov@example.invalid']);
  git(['config', 'user.name', 'Prov Fixture']);
  git(['add', '.']);
  git(['commit', '-qm', 'init']);
  return { root, git, head: git(['rev-parse', 'HEAD']) };
};

test('Source identity 稳定且与本地路径无关', () => {
  const a = sourceIdFor({ namespace: 'git:prj_abc', sourceType: 'git', objectId: 'prj_abc:src/a.js' });
  const b = sourceIdFor({ namespace: 'git:prj_abc', sourceType: 'git', objectId: 'prj_abc:src/a.js' });
  const c = sourceIdFor({ namespace: 'git:prj_xyz', sourceType: 'git', objectId: 'prj_xyz:src/a.js' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^src_[a-f0-9]{24}$/u);
  const obs = observationIdFor({ sourceId: a, sourceVersion: 'abc', contentHash: 'h', captureRunId: 'r' });
  assert.match(obs, /^obs_[a-f0-9]{24}$/u);
  assert.notEqual(obs, observationIdFor({ sourceId: a, sourceVersion: 'abd', contentHash: 'h', captureRunId: 'r' }));
});

test('SourceDescriptor 规范化拒绝伪造字段，Legacy Ref 只保留字符串', () => {
  assert.throws(() => normalizeSourceDescriptor({ sourceType: 'unknown', namespace: 'n', objectId: 'o', sourceVersion: 'v', locator: 'l' }), /Unknown source type/u);
  assert.throws(() => normalizeSourceDescriptor({ sourceType: 'git', namespace: 'n', objectId: '', sourceVersion: 'v', locator: 'l' }), /Empty source field/u);
  const normalized = normalizeSourceDescriptor({
    sourceType: 'git', namespace: 'git:prj_a', objectId: 'prj_a:src/a.js',
    sourceVersion: 'deadbeef', locator: 'src/a.js', availability: 'available'
  });
  assert.equal(normalized.contract, 'source-descriptor/v1');
  assert.deepEqual(parseLegacyRef('sandbox:run-1'), { kind: 'sandbox', value: 'run-1', version: '' });
  assert.deepEqual(parseLegacyRef('free text'), { kind: 'legacy', value: 'free text', version: '' });
});

test('Project Identity：remote 优先，其次首提交，最后本地根', () => {
  const remote = computeProjectIdentity({ root: 'D:/x', remoteUrl: 'git@github.com:GeTitDD/owner-agent-mvp.git' });
  const remoteHttps = computeProjectIdentity({ root: 'D:/y', remoteUrl: 'https://github.com/GeTitDD/owner-agent-mvp' });
  assert.equal(remote.projectIdentity, remoteHttps.projectIdentity);
  assert.equal(remote.identityKind, 'git-remote');
  const first = computeProjectIdentity({ root: 'D:/x', firstCommit: 'abc' });
  assert.equal(first.identityKind, 'git-first-commit');
  assert.throws(() => computeProjectIdentity({ root: 'D:/x' }), /requires remoteUrl/u);
});

test('Git 与本地文件解析器产出可核验的版本与内容哈希', () => {
  const repo = makeGitRepo();
  const gitSource = resolveGitFileSource({ root: repo.root, relPath: 'src/retry.js', projectId: 'demo' });
  assert.equal(gitSource.descriptor.sourceType, 'git');
  assert.equal(gitSource.descriptor.sourceVersion, repo.head);
  assert.match(gitSource.descriptor.contentHash, /^[a-f0-9]{40}$/u);
  assert.equal(gitSource.descriptor.locator, 'src/retry.js');
  assert.equal(gitSource.descriptor.availability, 'available');

  const untracked = path.join(repo.root, 'notes.txt');
  fs.writeFileSync(untracked, 'hello\n', 'utf8');
  const fileSource = resolveLocalFileSource({ root: repo.root, relPath: 'notes.txt', projectId: 'demo' });
  assert.equal(fileSource.descriptor.sourceType, 'file');
  assert.match(fileSource.descriptor.sourceVersion, /^sha256:[a-f0-9]{64}$/u);

  assert.throws(() => resolveGitFileSource({ root: repo.root, relPath: 'missing.js' }), /not tracked at HEAD/u);
  assert.throws(() => resolveLocalFileSource({ root: repo.root, relPath: '../outside.txt' }), /outside-project/u);
});

test('GitHub 解析器使用不可变版本；失败时不伪造', () => {
  const runner = (args) => {
    if (args[1].includes('/commits/')) return { sha: 'c0ffee', html_url: 'https://github.com/o/r/commit/c0ffee' };
    if (args[1].includes('/pulls/')) return { head: { sha: 'prsha' }, html_url: 'https://github.com/o/r/pull/7' };
    return { updated_at: '2026-11-09T00:00:00Z', html_url: 'https://github.com/o/r/issues/3' };
  };
  const commit = resolveGitHubSource({ repo: 'o/r', kind: 'commit', ref: 'main', runner });
  assert.equal(commit.descriptor.sourceVersion, 'c0ffee');
  assert.equal(commit.descriptor.namespace, 'github:o/r');
  const pr = resolveGitHubSource({ repo: 'o/r', kind: 'pr', ref: '7', runner });
  assert.equal(pr.descriptor.sourceVersion, 'prsha');
  const issue = resolveGitHubSource({ repo: 'o/r', kind: 'issue', ref: '3', runner });
  assert.match(issue.descriptor.sourceVersion, /^updated:/u);
  assert.throws(() => resolveGitHubSource({
    repo: 'o/r', kind: 'commit', ref: 'main',
    runner: () => { throw new Error('HTTP 404'); }
  }), (error) => error instanceof SourceResolveError && error.reason === 'github-unavailable');
});

test('Owner Run 与 Pi Session 解析器：终态可用、无哈希不冒充内容校验', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-owner-'));
  const owner = new OwnerStore(path.join(root, 'owner.sqlite'));
  try {
    createSyntheticProject({ store: owner, root: path.join(root, 'proj'), projectId: 'demo', name: 'Demo' });
    const run = resolveOwnerRunSource({ ownerStore: owner, runId: 'run-demo-repair' });
    assert.equal(run.descriptor.sourceVersion, 'run-demo-repair');
    assert.equal(run.descriptor.availability, 'available');
    assert.match(run.descriptor.contentHash, /^[a-f0-9]{64}$/u);
    assert.equal(run.evidence.testStatus, 'pass');
    assert.throws(
      () => resolveOwnerRunSource({ ownerStore: owner, runId: 'nope' }),
      (error) => error.reason === 'run-not-found'
    );
  } finally { owner.close(); }

  const withHash = resolveSessionSource({ sessionId: 's1', transcriptHash: 'abc' });
  assert.equal(withHash.descriptor.availability, 'available');
  const withoutHash = resolveSessionSource({ sessionId: 's2' });
  assert.equal(withoutHash.descriptor.availability, 'unknown');
  assert.equal(withoutHash.descriptor.sourceVersion, 'session:s2');
});

test('观察幂等、变更只生成待重验证项、不静默修改知识', () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    const provenance = new KnowledgeProvenance({ personalStore: store, device: 'dev_test' });
    const unit = makeUnit(store);
    const descriptor = {
      sourceType: 'git', namespace: 'git:prj_a', objectId: 'prj_a:src/retry.js',
      sourceVersion: 'commit-1', locator: 'src/retry.js', contentHash: 'blob-1',
      availability: 'available', projectId: 'demo'
    };
    const first = provenance.observeSource(descriptor, { captureRunId: 'cap-1' });
    assert.equal(first.created, true);
    assert.equal(first.revalidations.length, 0);
    const repeat = provenance.observeSource(descriptor, { captureRunId: 'cap-1' });
    assert.equal(repeat.created, false);
    assert.equal(repeat.observation.observationId, first.observation.observationId);

    provenance.linkRevision({
      unitId: unit.id, revision: unit.revision,
      observationId: first.observation.observationId, relation: 'supports'
    });
    const links = provenance.linksFor({ unitId: unit.id, revision: unit.revision });
    assert.equal(links.length, 1);
    assert.equal(links[0].sourceVersion, 'commit-1');

    const second = provenance.observeSource(
      { ...descriptor, sourceVersion: 'commit-2', contentHash: 'blob-2' },
      { captureRunId: 'cap-2' }
    );
    assert.equal(second.revalidations.length, 1);
    const queued = provenance.listRevalidations({ status: 'pending', unitId: unit.id });
    assert.equal(queued.length, 1);
    assert.equal(queued[0].reason, 'source_changed');
    // 只提示，不改 Owner 已采纳的知识。
    assert.equal(store.get(unit.id).verificationStatus, 'unverified');
    assert.equal(store.get(unit.id).revision, 1);
  } finally { store.close(); }
});

test('重验证：accepted 产生 needs_reverification 修订，dismissed 只关闭提示', () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    const provenance = new KnowledgeProvenance({ personalStore: store });
    const unit = makeUnit(store);
    const base = {
      sourceType: 'file', namespace: 'file:prj_a', objectId: 'prj_a:src/retry.js',
      locator: 'src/retry.js', availability: 'available', projectId: 'demo'
    };
    const first = provenance.observeSource({ ...base, sourceVersion: 'sha256:1', contentHash: '1' });
    provenance.linkRevision({ unitId: unit.id, revision: 1, observationId: first.observation.observationId });
    const changed = provenance.observeSource({ ...base, sourceVersion: 'sha256:2', contentHash: '2' });
    const item = changed.revalidations[0];

    const dismissed = provenance.resolveRevalidation({ id: item.id, decision: 'dismissed' });
    assert.equal(dismissed.status, 'dismissed');
    assert.equal(store.get(unit.id).revision, 1);

    const third = provenance.observeSource({ ...base, sourceVersion: 'sha256:3', contentHash: '3' });
    const accepted = provenance.resolveRevalidation({ id: third.revalidations[0].id, decision: 'accepted' });
    assert.equal(accepted.status, 'accepted');
    const after = store.get(unit.id);
    assert.equal(after.verificationStatus, 'needs_reverification');
    assert.equal(after.revision, 2);
    assert.throws(
      () => provenance.resolveRevalidation({ id: accepted.id, decision: 'accepted' }),
      /already resolved/u
    );
  } finally { store.close(); }
});

test('采纳记录与 explain 能回答来源、版本与漂移', () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    const provenance = new KnowledgeProvenance({ personalStore: store });
    const unit = makeUnit(store);
    const first = provenance.observeSource({
      sourceType: 'git', namespace: 'git:prj_a', objectId: 'prj_a:src/retry.js',
      sourceVersion: 'commit-1', locator: 'src/retry.js', contentHash: 'blob-1',
      availability: 'available', projectId: 'demo'
    });
    provenance.linkRevision({ unitId: unit.id, revision: 1, observationId: first.observation.observationId });

    const adopted = provenance.adopt({ unitId: unit.id, revision: 1, note: 'accepted for demo' });
    assert.equal(adopted.revision, 1);
    assert.equal(adopted.drift, false);

    store.update(unit.id, { ...unit, content: 'loop with i < attempts (revised)' }, { expectedRevision: 1 });
    assert.equal(provenance.adoption(unit.id).drift, true);

    const explanation = provenance.explain(unit.id);
    assert.equal(explanation.headRevision, 2);
    assert.equal(explanation.adoptedRevision, 1);
    assert.equal(explanation.adoptionDrift, true);
    assert.equal(explanation.revisions.length, 2);
    const firstRevision = explanation.revisions.find((item) => item.revision === 1);
    assert.equal(firstRevision.links[0].sourceVersion, 'commit-1');
    assert.deepEqual(explanation.evidenceRefs, ['legacy:run-a']);
    const evidence = provenance.evidenceFor({ unitId: unit.id, revision: 1 });
    assert.equal(evidence.links.length, 1);
    assert.equal(evidence.legacyRefs[0].kind, 'legacy');
  } finally { store.close(); }
});

test('链接校验：未知知识/修订/观察与非法关系都被拒绝', () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    const provenance = new KnowledgeProvenance({ personalStore: store });
    const unit = makeUnit(store);
    const observed = provenance.observeSource({
      sourceType: 'git', namespace: 'git:prj_a', objectId: 'prj_a:src/retry.js',
      sourceVersion: 'c1', locator: 'src/retry.js', contentHash: 'b1', availability: 'available'
    });
    assert.throws(
      () => provenance.linkRevision({ unitId: 'nope', revision: 1, observationId: observed.observation.observationId }),
      /unit not found/u
    );
    assert.throws(
      () => provenance.linkRevision({ unitId: unit.id, revision: 9, observationId: observed.observation.observationId }),
      /Revision mismatch/u
    );
    assert.throws(
      () => provenance.linkRevision({ unitId: unit.id, revision: 1, observationId: 'obs_nope' }),
      /observation not found/u
    );
    assert.throws(() => provenance.linkRevision({
      unitId: unit.id, revision: 1, observationId: observed.observation.observationId, relation: 'pretends'
    }), /Unknown source relation/u);
  } finally { store.close(); }
});

test('来源不可访问：只排队重验证，不改知识 Head', () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    const provenance = new KnowledgeProvenance({ personalStore: store });
    const unit = makeUnit(store);
    const observed = provenance.observeSource({
      sourceType: 'github', namespace: 'github:o/r', objectId: 'o/r@commit:abc',
      sourceVersion: 'abc', locator: 'https://github.com/o/r/commit/abc',
      contentHash: '', availability: 'available', projectId: 'demo'
    });
    provenance.linkRevision({ unitId: unit.id, revision: 1, observationId: observed.observation.observationId });
    const result = provenance.markSourceUnavailable({ sourceId: observed.observation.sourceId, note: 'repo deleted' });
    assert.equal(result.source.availability, 'unavailable');
    assert.equal(result.revalidations.length, 1);
    assert.equal(result.revalidations[0].reason, 'source_unavailable');
    assert.equal(store.get(unit.id).revision, 1);
    assert.equal(store.get(unit.id).verificationStatus, 'unverified');
  } finally { store.close(); }
});

test('上下文台账：记录、恢复与漂移检测', () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    const ledger = new KnowledgeContextLedger({ personalStore: store, device: 'dev_test' });
    const unit = makeUnit(store);
    const plan = { compilationHash: 'hash-1', knowledgeRefs: [`workspace:${unit.id}:r1`] };
    const { snapshot, created } = ledger.record({ projectId: 'demo', sessionId: 's1', task: 'fix retry', plan });
    assert.equal(created, true);
    assert.equal(snapshot.refs.length, 1);
    assert.equal(snapshot.refs[0].revision, 1);

    const same = ledger.restore(snapshot.snapshotId);
    assert.equal(same.drifted, 0);
    assert.equal(same.refs[0].drift, 'same');

    store.update(unit.id, { ...unit, content: 'changed later' }, { expectedRevision: 1 });
    const drifted = ledger.restore(snapshot.snapshotId);
    assert.equal(drifted.drifted, 1);
    assert.equal(drifted.refs[0].drift, 'revision-changed');
    assert.equal(drifted.refs[0].currentRevision, 2);

    assert.equal(ledger.latest({ projectId: 'demo' }).snapshotId, snapshot.snapshotId);
    const again = ledger.record({ projectId: 'demo', sessionId: 's1', task: 'fix retry', plan });
    assert.equal(again.created, false);
  } finally { store.close(); }
});

test('复用编译会写入上下文台账，新会话可恢复', async () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    const unit = makeUnit(store);
    const ledger = new KnowledgeContextLedger({ personalStore: store, device: 'dev_test' });
    const engine = {
      resolve: async () => ({ profile: { id: 'demo' } }),
      compile: () => ({
        compilationHash: 'hash-reuse',
        knowledgeRefs: [`workspace:${unit.id}:r1`],
        applicability: [{ key: `workspace:${unit.id}:r1`, state: 'applicable' }]
      })
    };
    const reuse = new KnowledgeReuse({ personalStore: store, engine, contextLedger: ledger });
    const result = await reuse.compileAsync({
      cwd: '/', task: 'fix retry', targetRunId: 'run-1', projectId: 'demo', sessionId: 'sess-1'
    });
    assert.equal(result.usages.length, 1);
    const latest = ledger.latest({ projectId: 'demo', sessionId: 'sess-1' });
    assert.equal(latest.compilationHash, 'hash-reuse');
    assert.equal(latest.refs[0].knowledgeId, unit.id);
    assert.equal(latest.refs[0].revision, 1);
  } finally { store.close(); }
});
