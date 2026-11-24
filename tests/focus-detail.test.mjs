// 专注模式「项目详情卡」的视图模型：选项目、九块内容、入口计数。
//
// 卡片只读，不写回配置；项目选择只影响这一张卡，所以这里的模型必须能
// 在“没选”“选了别的项目”“详情还没到”三种情况下都给出确定结果。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildFocusDetail } = require('../desktop/focus-detail.cjs');

const project = (id, name, extra = {}) => ({
  id, name, root: `D:/work/${id}`, goal: '', pending: 0, github: null, ...extra
});

const detailFor = (projectId, extra = {}) => ({
  config: { projectId },
  counts: { jobs: 5, patches: 2, tests: 3, cycles: 1 },
  pending: [{ kind: 'patch', projectId, title: '补丁待审' }],
  chain: {
    job: { status: 'succeeded' },
    patch: { status: 'applied' },
    sandbox: { status: 'completed', test_status: 'pass' },
    cycle: null
  },
  knowledge: { projectId, counts: { knowledge: 4, experiences: 3, verified: 2, candidates: 1 } },
  brief: {
    oneLiner: '一句话说明',
    whatItIs: '这是一个项目',
    howToRun: ['npm start'],
    modules: [{ name: 'src', role: '入口' }],
    verify: { commands: ['npm test'] },
    risks: [],
    unknowns: [],
    generatedAt: '2026-11-24T01:00:00.000Z',
    generatedFrom: 'local-scan',
    version: 2,
    stale: false
  },
  diagrams: [{ kind: 'dependency', mermaid: 'graph TD; A-->B', generatedAt: '2026-11-24T01:00:00.000Z' }],
  queue: [{ id: 'q1', kind: 'idea', title: '想法一', status: 'todo' }],
  playbook: null,
  testConfig: { enabled: true, ok: true, profile: 'node-smoke', missing: [] },
  ...extra
});

test('没有项目时给出添加项目的引导', () => {
  const model = buildFocusDetail({ projects: [] });
  assert.equal(model.hasProjects, false);
  assert.deepEqual(model.tabs, []);
  assert.match(model.guide.title, /还没有项目/u);
  assert.equal(model.guide.actionLabel, '添加项目');
});

test('默认展示第一个项目', () => {
  const model = buildFocusDetail({
    projects: [project('a', 'A'), project('b', 'B')],
    detail: detailFor('a')
  });
  assert.equal(model.projectId, 'a');
  assert.equal(model.projectName, 'A');
  assert.equal(model.detailReady, true);
  assert.deepEqual(model.tabs.map((tab) => [tab.id, tab.selected]), [['a', true], ['b', false]]);
});

test('选中的项目不存在时回到第一个', () => {
  const model = buildFocusDetail({
    projects: [project('a', 'A'), project('b', 'B')],
    selectedId: 'gone',
    detail: detailFor('a')
  });
  assert.equal(model.projectId, 'a');
});

test('切到第二个项目时不会拿第一个项目的详情充数', () => {
  const model = buildFocusDetail({
    projects: [project('a', 'A'), project('b', 'B')],
    selectedId: 'b',
    detail: detailFor('a')
  });
  assert.equal(model.projectId, 'b');
  assert.equal(model.detailReady, false);
  assert.equal(model.brief.state, 'loading');
  assert.equal(model.entries.find((entry) => entry.key === 'knowledge').count, 0);
  assert.equal(model.entries.find((entry) => entry.key === 'knowledge').note, '正在读取…');
});

test('画像、图谱、想法、Playbook 默认展开', () => {
  const model = buildFocusDetail({ projects: [project('a', 'A')], detail: detailFor('a') });
  assert.deepEqual(model.expanded, { brief: true, diagram: true, ideas: true, playbook: true });
  assert.equal(model.brief.state, 'ready');
  assert.equal(model.brief.oneLiner, '一句话说明');
  assert.deepEqual(model.brief.howToRun, ['npm start']);
  assert.deepEqual(model.brief.modules, [{ name: 'src', role: '入口' }]);
  assert.deepEqual(model.brief.verify, ['npm test']);
});

test('没有画像时给一键理解的提示，不编内容', () => {
  const model = buildFocusDetail({
    projects: [project('a', 'A')],
    detail: detailFor('a', { brief: null })
  });
  assert.equal(model.brief.state, 'empty');
  assert.equal(model.brief.oneLiner, '');
  assert.match(model.brief.hint, /一键理解/u);
});

test('知识、测试、补丁、运行四项入口带计数，GitHub 不在其中', () => {
  const model = buildFocusDetail({ projects: [project('a', 'A')], detail: detailFor('a') });
  assert.deepEqual(model.entries.map((entry) => entry.key), ['knowledge', 'tests', 'patches', 'runs']);
  assert.deepEqual(model.entries.map((entry) => entry.label), ['知识', '测试', '补丁', '运行']);
  const byKey = Object.fromEntries(model.entries.map((entry) => [entry.key, entry]));
  assert.equal(byKey.knowledge.count, 4);
  assert.equal(byKey.knowledge.note, '候选 1 · 已验证 2');
  assert.equal(byKey.tests.count, 3);
  assert.equal(byKey.tests.note, '最近通过');
  assert.equal(byKey.patches.count, 2);
  assert.equal(byKey.patches.note, '待审 1');
  assert.equal(byKey.runs.count, 5);
  assert.equal(byKey.runs.note, '空闲');
});

test('有进行中的任务链时运行显示进行中', () => {
  const detail = detailFor('a', {
    chain: { job: { status: 'running' }, patch: null, sandbox: null, cycle: null }
  });
  const model = buildFocusDetail({ projects: [project('a', 'A')], detail });
  assert.equal(model.entries.find((entry) => entry.key === 'runs').note, '进行中 1');
});

test('GitHub 与测试配置折叠在「更多」', () => {
  const model = buildFocusDetail({
    projects: [project('a', 'A', {
      github: { available: true, nameWithOwner: 'me/a', url: 'https://github.com/me/a' }
    })],
    detail: detailFor('a'),
    github: {
      issueCount: 2,
      prCount: 1,
      issues: [
        { number: 1, title: '问题一', url: 'u1' },
        { number: 2, title: '问题二', url: 'u2' },
        { number: 3, title: '问题三', url: 'u3' }
      ],
      prs: []
    }
  });
  assert.equal(model.more.github.nameWithOwner, 'me/a');
  assert.equal(model.more.github.issueCount, 2);
  assert.equal(model.more.github.prCount, 1);
  assert.deepEqual(model.more.github.items.map((item) => item.title), ['问题一', '问题二', '问题三']);
  assert.equal(model.more.tests.enabled, true);
  assert.equal(model.more.tests.profile, 'node-smoke');
  assert.deepEqual(model.more.tests.missing, []);
});

test('没有关联 GitHub 时更多里说明未关联', () => {
  const model = buildFocusDetail({ projects: [project('a', 'A')], detail: detailFor('a') });
  assert.equal(model.more.github.linked, false);
  assert.match(model.more.github.hint, /GitHub/u);
});

test('图谱默认依赖图，没有就退到第一个已有的', () => {
  const onlyControl = detailFor('a', { diagrams: [{ kind: 'control', mermaid: 'flowchart TD;' }] });
  const model = buildFocusDetail({ projects: [project('a', 'A')], detail: onlyControl });
  assert.equal(model.diagram.kind, 'control');
  assert.equal(model.diagram.label, '控制流图');

  const both = detailFor('a', {
    diagrams: [{ kind: 'state', mermaid: 'x' }, { kind: 'dependency', mermaid: 'y' }]
  });
  const preferred = buildFocusDetail({ projects: [project('a', 'A')], detail: both });
  assert.equal(preferred.diagram.kind, 'dependency');
  assert.equal(preferred.diagram.mermaid, 'y');
  assert.equal(preferred.diagram.kinds.find((kind) => kind.kind === 'state').state, 'ready');
  assert.equal(preferred.diagram.kinds.find((kind) => kind.kind === 'sequence').state, 'empty');
});

test('没有图谱时不假装有内容', () => {
  const model = buildFocusDetail({
    projects: [project('a', 'A')],
    detail: detailFor('a', { diagrams: [] })
  });
  assert.equal(model.diagram.state, 'empty');
  assert.equal(model.diagram.mermaid, '');
  assert.match(model.diagram.hint, /生成/u);
});

test('想法只统计这个项目的想法，并给出活跃条数', () => {
  const detail = detailFor('a', {
    queue: [
      { id: '1', kind: 'idea', title: 'x', status: 'todo' },
      { id: '2', kind: 'idea', title: 'y', status: 'done' },
      { id: '3', kind: 'task', title: 'z', status: 'todo' }
    ]
  });
  const model = buildFocusDetail({ projects: [project('a', 'A')], detail });
  assert.equal(model.ideas.total, 2);
  assert.equal(model.ideas.active, 1);
  assert.deepEqual(model.ideas.items.map((item) => item.title), ['x', 'y']);
  assert.equal(model.ideas.items[0].statusLabel, '新想法');
});

test('Playbook 只认所选项目的目录，串项目就当没有', () => {
  const catalog = {
    skillsAvailable: true,
    groups: [{ id: 'g', label: '理解', items: [{ id: 'reflect', label: '复盘' }, { id: 'how', label: '怎么跑' }] }],
    lastRuns: { reflect: { runId: 'r1', status: 'ok', summary: 's', startedAt: '2026-11-24T00:00:00.000Z' } }
  };
  const foreign = buildFocusDetail({
    projects: [project('a', 'A'), project('b', 'B')],
    selectedId: 'b',
    detail: detailFor('b'),
    playbook: { projectId: 'a', catalog }
  });
  assert.equal(foreign.playbook.available, false);

  const own = buildFocusDetail({
    projects: [project('a', 'A')],
    detail: detailFor('a'),
    playbook: { projectId: 'a', catalog }
  });
  assert.equal(own.playbook.available, true);
  assert.deepEqual(own.playbook.lastRuns.map((run) => [run.label, run.status]), [['复盘', 'ok']]);
  assert.equal(own.playbook.running, false);
});

test('Playbook 正在跑时卡片显示运行中', () => {
  const model = buildFocusDetail({
    projects: [project('a', 'A')],
    detail: detailFor('a', { playbook: { running: true, playbookId: 'reflect', title: '复盘' } })
  });
  assert.equal(model.playbook.running, true);
  assert.equal(model.playbook.runningTitle, '复盘');
});
