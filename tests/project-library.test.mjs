// 项目库是视图：聚合本项目经验、所属领域知识、由本项目升上去的知识、画像与图谱。
// 条目只按「已验证 / 观察中」分两节，互斥、不丢；域知识按「同领域 + 本项目贡献」筛选。
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectLibraryView } from '../src/project-library.mjs';

const PROJECT = {
  id: 'p1',
  name: '演示项目',
  primaryDomain: 'software-engineering',
  domains: ['software-engineering']
};

const lesson = ({
  id,
  status = 'verified',
  at = '2026-11-20T00:00:00.000Z',
  projectId = PROJECT.id
} = {}) => ({
  id,
  projectId,
  phenomenon: `现象 ${id}`,
  mechanism: `机制 ${id}`,
  countermeasure: `对策 ${id}`,
  scope: { layer: 'project', projectId, domainIds: ['software-engineering'] },
  verificationStatus: status,
  evidence: status === 'inferred' ? [] : [{ ref: `run:${id}` }],
  createdAt: at
});

const unit = ({
  id,
  status = 'verified',
  domains = ['software-engineering'],
  projectId = null,
  originProjectId = null,
  at = '2026-11-21T00:00:00.000Z',
  sources = null
} = {}) => ({
  id,
  title: `知识 ${id}`,
  content: `内容 ${id}`,
  kind: 'claim',
  scope: projectId ? 'project' : 'domain',
  layer: projectId ? 'project' : 'applied',
  projectId,
  domains,
  ...(originProjectId ? { originProjectId } : {}),
  ...(sources ? { sources } : {}),
  verificationStatus: status,
  revision: 1,
  evidenceRefs: status === 'verified' ? [`evidence:${id}`] : [],
  updatedAt: at
});

const groupsByKey = (view) => Object.fromEntries(view.groups.map((group) => [group.key, group]));
const sectionsByKey = (view) => Object.fromEntries(view.sections.map((section) => [section.key, section]));
const idsOf = (items) => items.map((item) => item.id).sort();

test('四类内容都出现：本项目经验、领域知识、本项目贡献、画像与图谱', () => {
  const view = projectLibraryView({
    project: PROJECT,
    lessons: [lesson({ id: 'l1' })],
    knowledge: [
      unit({ id: 'k-domain' }),
      unit({ id: 'k-contributed', domains: ['frontend'], originProjectId: 'p1' })
    ],
    profile: {
      oneLiner: '一个演示项目。',
      whatItIs: '用来演示项目库。',
      basedOnCommit: 'abc1234',
      generatedAt: '2026-11-22T00:00:00.000Z'
    },
    diagrams: [
      {
        kind: 'dependency',
        title: '依赖图',
        summary: '两个模块',
        basedOnCommit: 'abc1234',
        updatedAt: '2026-11-22T00:00:00.000Z'
      }
    ]
  });

  assert.deepEqual(view.groups.map((group) => group.key), [
    'experiences', 'domainKnowledge', 'contributedKnowledge'
  ]);
  assert.deepEqual(view.groups.map((group) => group.label), [
    '本项目经验', '所属领域知识', '本项目升上去的知识'
  ]);
  assert.deepEqual({
    experiences: groupsByKey(view).experiences.count,
    domainKnowledge: groupsByKey(view).domainKnowledge.count,
    contributedKnowledge: groupsByKey(view).contributedKnowledge.count,
    profile: view.counts.profile,
    diagrams: view.counts.diagrams
  }, { experiences: 1, domainKnowledge: 1, contributedKnowledge: 1, profile: 1, diagrams: 1 });

  // 每一条都能看出自己的来源。
  const allItems = view.sections.flatMap((section) => section.items);
  assert.deepEqual(idsOf(allItems), ['k-contributed', 'k-domain', 'l1']);
  assert.equal(allItems.find((item) => item.id === 'l1').sourceLabel, '本项目经验');
  assert.equal(allItems.find((item) => item.id === 'k-domain').sourceLabel, '所属领域知识');
  assert.equal(allItems.find((item) => item.id === 'k-contributed').sourceLabel, '本项目贡献');

  // 画像与图谱是只读资产，带新鲜度，不混进两节。
  assert.equal(view.assets.profile.available, true);
  assert.equal(view.assets.profile.oneLiner, '一个演示项目。');
  assert.equal(view.assets.profile.basedOnCommit, 'abc1234');
  assert.equal(view.assets.profile.generatedAt, '2026-11-22T00:00:00.000Z');
  const dependency = view.assets.diagrams.find((diagram) => diagram.kind === 'dependency');
  assert.equal(dependency.available, true);
  assert.equal(dependency.title, '依赖图');
  assert.equal(dependency.basedOnCommit, 'abc1234');
  assert.equal(view.assets.diagrams.length, 5);
  assert.equal(view.empty, null);
});

test('域知识只收「同领域」与「本项目贡献」，无关领域不出现', () => {
  const view = projectLibraryView({
    project: PROJECT,
    knowledge: [
      unit({ id: 'same-domain' }),
      unit({ id: 'contributed-other-domain', domains: ['frontend'], originProjectId: PROJECT.id }),
      unit({ id: 'unrelated', domains: ['frontend'] }),
      unit({ id: 'contributed-via-sources', domains: ['data'], sources: [{ projectId: PROJECT.id }] }),
      unit({ id: 'contributed-same-domain', domains: ['software-engineering'], originProjectId: PROJECT.id }),
      unit({ id: 'other-project', domains: ['frontend'], projectId: 'p2' })
    ]
  });

  assert.deepEqual(idsOf(view.sections.flatMap((section) => section.items)), [
    'contributed-other-domain',
    'contributed-same-domain',
    'contributed-via-sources',
    'same-domain'
  ]);
  assert.deepEqual(idsOf(groupsByKey(view).domainKnowledge.items), ['same-domain']);
  // 同领域的贡献条目仍算「本项目贡献」：来源看贡献，不重复出现在领域那一组。
  assert.deepEqual(idsOf(groupsByKey(view).contributedKnowledge.items), [
    'contributed-other-domain',
    'contributed-same-domain',
    'contributed-via-sources'
  ]);
  assert.equal(view.counts.total, 4);
  assert.equal(view.counts.domainKnowledge, 1);
  assert.equal(view.counts.contributedKnowledge, 3);
});

test('新项目不空白，也不会被整个领域的条目塞满', () => {
  const inDomain = ['k1', 'k2', 'k3'].map((id) => unit({ id, status: 'unverified' }));
  const otherDomain = ['x1', 'x2', 'x3', 'x4', 'x5']
    .map((id) => unit({ id, domains: ['frontend'], status: 'unverified' }));

  const view = projectLibraryView({
    project: { id: 'p-new', name: '新项目', domains: ['software-engineering'] },
    knowledge: [...inDomain, ...otherDomain]
  });

  assert.equal(view.empty, null);
  assert.equal(view.counts.experiences, 0);
  assert.equal(view.counts.domainKnowledge, 3);
  assert.equal(view.counts.contributedKnowledge, 0);
  assert.equal(view.counts.total, 3);
  assert.equal(view.counts.total < inDomain.length + otherDomain.length, true);
  assert.deepEqual(idsOf(sectionsByKey(view).observing.items), ['k1', 'k2', 'k3']);
  assert.deepEqual(sectionsByKey(view).verified.items, []);
});

test('已验证与观察中互斥，两节合计等于总数', () => {
  const view = projectLibraryView({
    project: PROJECT,
    lessons: [
      lesson({ id: 'l-verified', status: 'verified', at: '2026-11-24T00:00:00.000Z' }),
      lesson({ id: 'l-unverified', status: 'unverified', at: '2026-11-23T00:00:00.000Z' })
    ],
    knowledge: [
      unit({ id: 'k-verified', status: 'verified' }),
      unit({ id: 'k-inferred', status: 'inferred', at: '2026-11-22T00:00:00.000Z' }),
      unit({ id: 'k-disputed', status: 'disputed', at: '2026-11-21T00:00:00.000Z' })
    ]
  });

  const verified = sectionsByKey(view).verified;
  const observing = sectionsByKey(view).observing;
  assert.deepEqual(idsOf(verified.items), ['k-verified', 'l-verified']);
  assert.deepEqual(idsOf(observing.items), ['k-disputed', 'k-inferred', 'l-unverified']);

  // 互斥：没有条目同时出现在两节；不丢：并集就是全部条目。
  const verifiedIds = new Set(verified.items.map((item) => item.id));
  assert.equal(observing.items.some((item) => verifiedIds.has(item.id)), false);
  assert.deepEqual(idsOf([...verified.items, ...observing.items]), [
    'k-disputed', 'k-inferred', 'k-verified', 'l-unverified', 'l-verified'
  ]);
  assert.equal(view.counts.total, 5);
  assert.equal(view.counts.verified + view.counts.observing, view.counts.total);
  assert.equal(verified.count, 2);
  assert.equal(observing.count, 3);
  // 每条记录的 section 与它所在的那一节一致，徽章保留真实状态。
  assert.equal(verified.items.every((item) => item.section === 'verified'), true);
  assert.equal(observing.items.every((item) => item.section === 'observing'), true);
  assert.equal(observing.items.find((item) => item.id === 'k-disputed').badge, '争议');
  assert.equal(observing.items.find((item) => item.id === 'k-inferred').badge, '推断');
});

test('空库有明确空态：不造假条目，说明缺什么', () => {
  const view = projectLibraryView({ project: PROJECT });

  assert.equal(view.counts.total, 0);
  assert.equal(view.counts.verified, 0);
  assert.equal(view.counts.observing, 0);
  assert.deepEqual(view.sections.map((section) => section.key), ['verified', 'observing']);
  assert.equal(view.sections.every((section) => section.empty && section.items.length === 0), true);
  assert.ok(view.empty);
  assert.equal(view.empty.kind, 'empty-library');
  assert.match(view.empty.title, /空/u);
  assert.match(view.empty.detail, /经验/u);
  // 缺画像与缺图谱都要写明缺，而不是静默省略。
  assert.equal(view.assets.profile.available, false);
  assert.equal(view.assets.diagrams.length, 5);
  assert.equal(view.assets.diagrams.every((diagram) => diagram.available === false), true);
  assert.deepEqual(view.assets.diagrams.map((diagram) => diagram.kind).sort(), [
    'control', 'dataflow', 'dependency', 'sequence', 'state'
  ]);
});

test('只有画像时不算空库，但两节仍各自给出空说明', () => {
  const view = projectLibraryView({
    project: PROJECT,
    profile: { oneLiner: '只有画像。', basedOnCommit: 'abc1234' }
  });

  assert.equal(view.empty, null);
  assert.equal(view.counts.total, 0);
  assert.equal(view.counts.profile, 1);
  assert.match(sectionsByKey(view).verified.emptyHint, /还没有已验证/u);
  assert.match(sectionsByKey(view).observing.emptyHint, /没有观察中/u);
});
