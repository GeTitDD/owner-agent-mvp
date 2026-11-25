// 项目库版本 diff（#92）：按条目身份给出新增 / 变更 / 消失三类，首版明确不可比。
// 只测纯函数；不碰 Electron、不读库、不联网。
import test from 'node:test';
import assert from 'node:assert/strict';
import { versionDiffOf } from '../src/project-version-diff.mjs';
import { projectLibraryView } from '../src/project-library.mjs';
import { snapshotContentOf } from '../src/project-snapshots.mjs';

const item = ({ id, title = `条目 ${id}`, status = 'verified', at = '2026-11-24T00:00:00.000Z', revision = null } = {}) => ({
  ref: { kind: 'knowledge', id, ...(revision ? { revision } : {}) },
  title,
  status,
  badge: status === 'verified' ? '已验证' : '待验证',
  detail: '知识 · 领域共享',
  at,
  evidence: [{ kind: 'evidence', ref: `evidence:${id}` }]
});

const content = ({ verified = [], observing = [] } = {}) => ({
  format: 'project-snapshot/v1',
  note: '',
  counts: { verified: verified.length, observing: observing.length, total: verified.length + observing.length },
  sections: [
    { key: 'verified', label: '已验证', count: verified.length, items: verified },
    { key: 'observing', label: '观察中', count: observing.length, items: observing }
  ]
});

test('三类齐全：加一条、改一条、删一条', () => {
  const previous = content({
    verified: [item({ id: 'a' }), item({ id: 'b' })],
    observing: [item({ id: 'c', status: 'unverified' })]
  });
  const current = content({
    verified: [item({ id: 'a' }), item({ id: 'b', title: '改过的条目', at: '2026-11-25T00:00:00.000Z' }), item({ id: 'd' })]
  });
  const diff = versionDiffOf(previous, current, { previousLabel: 'v1' });

  assert.equal(diff.comparable, true);
  assert.equal(diff.firstVersion, false);
  assert.deepEqual(diff.counts, { added: 1, changed: 1, removed: 1, unchanged: 1 });
  assert.deepEqual(diff.added.map((entry) => entry.key), ['knowledge:d']);
  assert.deepEqual(diff.removed.map((entry) => entry.key), ['knowledge:c']);
  assert.deepEqual(diff.changed.map((entry) => entry.key), ['knowledge:b']);
  // 变更能看出是哪一条、哪个字段、从什么变成什么。
  const changed = diff.changed[0];
  assert.equal(changed.title, '改过的条目');
  assert.deepEqual(changed.changes.map((change) => change.field), ['title', 'at']);
  assert.equal(changed.changes.find((change) => change.field === 'title').before, '条目 b');
  assert.equal(changed.changes.find((change) => change.field === 'title').after, '改过的条目');
  assert.equal(diff.headline, '与 v1 相比：新增 1 条 · 变更 1 条 · 消失 1 条');
});

test('状态变化与跨节变化都算变更，并写明分节', () => {
  const previous = content({ observing: [item({ id: 'k', status: 'unverified' })] });
  const current = content({ verified: [item({ id: 'k', status: 'verified' })] });
  const diff = versionDiffOf(previous, current, { previousLabel: 'v1' });
  assert.equal(diff.counts.changed, 1);
  assert.equal(diff.counts.added, 0);
  assert.equal(diff.counts.removed, 0);
  const changes = Object.fromEntries(diff.changed[0].changes.map((change) => [change.field, change]));
  assert.equal(changes.status.before, 'unverified');
  assert.equal(changes.status.after, 'verified');
  assert.equal(changes.badge.before, '待验证');
  assert.equal(changes.badge.after, '已验证');
  assert.equal(changes.section.before, '观察中');
  assert.equal(changes.section.after, '已验证');
});

test('无变化：同一批条目原样再发一版', () => {
  const previous = content({ verified: [item({ id: 'a' })], observing: [item({ id: 'b', status: 'unverified' })] });
  const current = structuredClone(previous);
  const diff = versionDiffOf(previous, current, { previousLabel: 'v2' });
  assert.equal(diff.comparable, true);
  assert.deepEqual(diff.counts, { added: 0, changed: 0, removed: 0, unchanged: 2 });
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.removed, []);
  assert.equal(diff.headline, '与 v2 相比：没有变化');
});

test('条目顺序变化不算变更', () => {
  const previous = content({
    verified: [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })]
  });
  const current = content({
    verified: [item({ id: 'c' }), item({ id: 'a' }), item({ id: 'b' })]
  });
  const diff = versionDiffOf(previous, current, { previousLabel: 'v1' });
  assert.deepEqual(diff.counts, { added: 0, changed: 0, removed: 0, unchanged: 3 });
  assert.equal(diff.headline, '与 v1 相比：没有变化');
});

test('首版明确不可比，不显示成 0 变化', () => {
  const diff = versionDiffOf(null, content({ verified: [item({ id: 'a' })] }));
  assert.equal(diff.comparable, false);
  assert.equal(diff.firstVersion, true);
  assert.equal(diff.counts, null);
  assert.equal(diff.headline, '首版，无可比对象');
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.removed, []);
  assert.equal(diff.total, 1);
});

test('上一版读不到时与首版区分开', () => {
  const diff = versionDiffOf(null, content({}), { previousLabel: 'v1', previousMissing: true });
  assert.equal(diff.comparable, false);
  assert.equal(diff.firstVersion, false);
  assert.equal(diff.missingPrevious, true);
  assert.equal(diff.counts, null);
  assert.equal(diff.headline, 'v1 已不可用，无法比对');
});

test('证据引用变化算变更，按引用集合而不是数组顺序', () => {
  const before = item({ id: 'a' });
  before.evidence = [{ kind: 'evidence', ref: 'evidence:1' }, { kind: 'record', ref: 'sandbox:2' }];
  const reordered = item({ id: 'a' });
  reordered.evidence = [{ kind: 'record', ref: 'sandbox:2' }, { kind: 'evidence', ref: 'evidence:1' }];
  const expanded = item({ id: 'a' });
  expanded.evidence = [
    { kind: 'evidence', ref: 'evidence:1' },
    { kind: 'record', ref: 'sandbox:2' },
    { kind: 'record', ref: 'sandbox:3' }
  ];
  // 仅调整证据顺序：不算变更。
  assert.equal(versionDiffOf(content({ verified: [before] }), content({ verified: [reordered] })).counts.changed, 0);
  // 多一条证据：算变更，before/after 都能读。
  const diff = versionDiffOf(content({ verified: [before] }), content({ verified: [expanded] }), { previousLabel: 'v1' });
  assert.equal(diff.counts.changed, 1);
  const evidence = diff.changed[0].changes.find((change) => change.field === 'evidence');
  assert.match(evidence.before, /evidence:evidence:1/u);
  assert.match(evidence.after, /sandbox:3/u);
});

test('修订号变化算变更：同一身份换了修订', () => {
  const previous = content({ verified: [item({ id: 'k', revision: 2 })] });
  const current = content({ verified: [item({ id: 'k', revision: 3 })] });
  const diff = versionDiffOf(previous, current, { previousLabel: 'v1' });
  assert.equal(diff.counts.changed, 1);
  assert.equal(diff.counts.added, 0);
  assert.equal(diff.counts.removed, 0);
  const revision = diff.changed[0].changes.find((change) => change.field === 'revision');
  assert.deepEqual([revision.before, revision.after], ['2', '3']);
});

test('真实快照形状：身份取 ref，分节取外层 section（条目本身不带 section）', () => {
  const project = { id: 'p1', name: '演示项目', domains: ['software-engineering'] };
  const unit = ({ id, title, status = 'verified' }) => ({
    id,
    revision: 1,
    title,
    content: '内容',
    kind: 'claim',
    scope: 'domain',
    layer: 'applied',
    domains: ['software-engineering'],
    verificationStatus: status,
    evidenceRefs: [`evidence:${id}`],
    updatedAt: '2026-11-24T00:00:00.000Z'
  });
  const contentOf = (rows) => snapshotContentOf(
    projectLibraryView({ project, knowledge: rows }),
    { generatedAt: '2026-11-24T00:00:00.000Z' }
  );
  const previous = contentOf([
    unit({ id: 'k1', title: '保留的结论' }),
    unit({ id: 'k2', title: '会被改的结论' }),
    unit({ id: 'k3', title: '会被删的结论', status: 'unverified' })
  ]);
  const current = contentOf([
    unit({ id: 'k1', title: '保留的结论' }),
    unit({ id: 'k2', title: '改过的结论', status: 'unverified' }),
    unit({ id: 'k4', title: '新增的结论' })
  ]);
  // 快照条目确实没有 section 字段：diff 必须靠外层分节判断跨节变化。
  assert.equal('section' in current.sections[0].items[0], false);

  const diff = versionDiffOf(previous, current, { previousLabel: 'v1' });
  assert.deepEqual(diff.counts, { added: 1, changed: 1, removed: 1, unchanged: 1 });
  assert.equal(diff.added[0].ref.id, 'k4');
  assert.equal(diff.removed[0].ref.id, 'k3');
  const changed = diff.changed[0];
  assert.equal(changed.ref.id, 'k2');
  assert.equal(changed.section, 'observing');
  assert.equal(changed.sectionLabel, '观察中');
  assert.equal(changed.changes.find((change) => change.field === 'section').before, '已验证');
  assert.equal(changed.changes.find((change) => change.field === 'section').after, '观察中');
});
