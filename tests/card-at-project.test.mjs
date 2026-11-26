// #124「关联项目」：草稿状态迁移、胶囊增删、四类资料计数与「## 关联项目」段组装。
// 这里只喂纯数据，不起 Electron；展开态与发送由 e2e（desktop-at-project.mjs）覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const project = require('../desktop/shell-at-project.cjs');
const prompt = require('../desktop/shell-at-prompt.cjs');

const ALPHA = { id: 'alpha', name: 'Alpha Repo', root: 'D:\\repos\\alpha' };
const BETA = { id: 'beta', name: 'Beta Repo', root: 'D:\\repos\\beta' };

// ── 项目列表：不含当前项目，没有 id 的行丢掉 ────────────────────────

test('可关联项目：全局列出全部，选了项目就把它自己排除', () => {
  assert.deepEqual(project.linkableProjects([ALPHA, BETA], '').map((row) => row.id), ['alpha', 'beta']);
  assert.deepEqual(project.linkableProjects([ALPHA, BETA], 'alpha').map((row) => row.id), ['beta']);
  // 没有 id 的行不参与；root 原样带着（prompt 段要写路径）。
  const rows = project.linkableProjects([{ name: '无 id' }, null, ALPHA], '');
  assert.deepEqual(rows, [{ id: 'alpha', name: 'Alpha Repo', root: 'D:\\repos\\alpha' }]);
});

// ── 草稿：项目内选资料 / 自动找互斥 ────────────────────────────────

test('资料勾选：点一次加入、再点一次取消，入参不被改', () => {
  const empty = project.emptyDraft();
  const one = project.toggleMaterial(empty, 'alpha', 'experience');
  assert.deepEqual(empty, {});
  assert.deepEqual(project.draftRowOf(one, 'alpha').materials, ['experience']);
  const two = project.toggleMaterial(one, 'alpha', 'profile');
  assert.deepEqual(project.draftRowOf(two, 'alpha').materials, ['experience', 'profile']);
  const back = project.toggleMaterial(two, 'alpha', 'experience');
  assert.deepEqual(project.draftRowOf(back, 'alpha').materials, ['profile']);
  // 不认识的资料键 / 空项目 id：原样返回副本，不产生半个勾选。
  assert.deepEqual(project.toggleMaterial(two, 'alpha', 'nope'), two);
  assert.deepEqual(project.toggleMaterial(two, '', 'experience'), two);
});

test('「让 Agent 自己找」与指定资料互斥：勾自动清空资料，勾资料关掉自动', () => {
  let draft = project.toggleMaterial(project.emptyDraft(), 'alpha', 'experience');
  draft = project.toggleAuto(draft, 'alpha');
  assert.deepEqual(project.draftRowOf(draft, 'alpha'), { auto: true, materials: [] });
  // 自动开着时再勾一类资料：自动被关掉，资料生效。
  draft = project.toggleMaterial(draft, 'alpha', 'decisions');
  assert.deepEqual(project.draftRowOf(draft, 'alpha'), { auto: false, materials: ['decisions'] });
  // 再勾一次自动：资料清空。
  draft = project.toggleAuto(draft, 'alpha');
  assert.deepEqual(project.draftRowOf(draft, 'alpha'), { auto: true, materials: [] });
  // 再点一次取消：这一条草稿整个消失。
  draft = project.toggleAuto(draft, 'alpha');
  assert.deepEqual(draft, {});
});

test('草稿计数与行文案：未选 / N 类资料 / 让 Agent 自己找', () => {
  let draft = project.emptyDraft();
  assert.equal(project.draftCount(draft), 0);
  assert.equal(project.draftSummary(draft, 'alpha'), '未选');
  draft = project.toggleMaterial(draft, 'alpha', 'profile');
  draft = project.toggleMaterial(draft, 'beta', 'experience');
  assert.equal(project.draftCount(draft), 2);
  assert.equal(project.draftSummary(draft, 'alpha'), '已选 1 类资料');
  draft = project.toggleAuto(draft, 'beta');
  assert.equal(project.draftSummary(draft, 'beta'), '让 Agent 自己找');
});

// ── 草稿 → 关联项 → 胶囊 ───────────────────────────────────────────

test('一项都没选时提交：给明确理由，不产生空关联', () => {
  const plan = project.linksFromDraft(project.emptyDraft(), [ALPHA, BETA]);
  assert.equal(plan.ok, false);
  assert.ok(plan.reason.includes('一项都没选'));
  assert.deepEqual(plan.links, []);
  // 只选了不存在的项目 id 也一样。
  const ghost = project.emptyDraft();
  assert.equal(project.linksFromDraft(project.toggleAuto(ghost, 'gone'), [ALPHA, BETA]).ok, false);
});

test('关联项：按项目列表顺序输出，资料按固定顺序而不是点选顺序', () => {
  let draft = project.toggleMaterial(project.emptyDraft(), 'beta', 'profile');
  draft = project.toggleMaterial(draft, 'alpha', 'profile');
  draft = project.toggleMaterial(draft, 'alpha', 'experience');
  const plan = project.linksFromDraft(draft, [ALPHA, BETA]);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.links.map((link) => link.id), ['alpha', 'beta']);
  assert.deepEqual(plan.links[0], {
    id: 'alpha',
    name: 'Alpha Repo',
    root: 'D:\\repos\\alpha',
    source: '项目库',
    auto: false,
    materials: ['experience', 'profile']
  });
  assert.equal(project.capsuleLabel(plan.links[0]), 'Alpha Repo · 经验、画像');
});

test('「让 Agent 自己找」的胶囊文案只写这一句', () => {
  const plan = project.linksFromDraft(project.toggleAuto(project.emptyDraft(), 'beta'), [BETA]);
  assert.equal(plan.links[0].auto, true);
  assert.deepEqual(plan.links[0].materials, []);
  assert.equal(project.capsuleLabel(plan.links[0]), 'Beta Repo · 让 Agent 自己找');
});

test('胶囊合并：同一项目覆盖，其它保留；移除只去掉指定项目', () => {
  const alpha = project.linksFromDraft(
    project.toggleMaterial(project.emptyDraft(), 'alpha', 'experience'), [ALPHA]
  ).links;
  const beta = project.linksFromDraft(
    project.toggleAuto(project.emptyDraft(), 'beta'), [BETA]
  ).links;
  const merged = project.mergeLinks(alpha, beta);
  assert.deepEqual(merged.map((link) => link.id), ['alpha', 'beta']);
  const replaced = project.mergeLinks(merged,
    project.linksFromDraft(project.toggleMaterial(project.emptyDraft(), 'alpha', 'diagrams'), [ALPHA]).links);
  assert.deepEqual(replaced.map((link) => link.id), ['alpha', 'beta']);
  assert.deepEqual(replaced[0].materials, ['diagrams']);
  assert.deepEqual(project.removeLink(replaced, 'alpha').map((link) => link.id), ['beta']);
  assert.deepEqual(project.removeLink(replaced, 'nope').map((link) => link.id), ['alpha', 'beta']);
});

// ── prompt 段：「项目名（来源 · 路径）」+「关联资料：…」 ─────────────

test('关联段：空列表整段不出现；每项两行并写明只读', () => {
  assert.equal(project.linksToSection([]), '');
  assert.equal(project.linksToSection(project.emptyDraft()), '');
  const links = project.linksFromDraft(
    project.toggleMaterial(
      project.toggleMaterial(project.emptyDraft(), 'alpha', 'experience'),
      'alpha', 'profile'
    ),
    [ALPHA]
  ).links;
  const section = project.linksToSection(links);
  assert.ok(section.startsWith('## 关联项目\n\n'));
  assert.ok(section.includes('- Alpha Repo（项目库 · D:\\repos\\alpha）'));
  assert.ok(section.includes('  关联资料：经验、画像'));
  assert.ok(section.includes('跨项目只读：以上关联只影响读取，不改变写入落点'));
  // 项目没有登记路径时也写明，而不是留空括号。
  const noRoot = project.linksToSection([{ id: 'x', name: 'X', materials: ['decisions'] }]);
  assert.ok(noRoot.includes('- X（项目库 · 路径未登记）'));
});

test('发送拼接：没有关联原样返回；有关联才空一行接上「## 关联项目」', () => {
  assert.equal(project.withLinks('原样一句', []), '原样一句');
  const links = project.linksFromDraft(project.toggleAuto(project.emptyDraft(), 'beta'), [BETA]).links;
  const text = project.withLinks('帮我看下这个取舍\n\n', links);
  assert.ok(text.startsWith('帮我看下这个取舍\n\n## 关联项目'));
  assert.ok(text.includes('关联资料：让 Agent 自己找'));
  assert.ok(!text.includes('帮我看下这个取舍\n\n\n'));
});

// ── 四类资料计数：来自 project-library 的库视图 ────────────────────

test('资料计数：经验 / 图谱 / 画像用 counts，决策从 group 条目 kind 数', () => {
  const library = {
    counts: { diagrams: 2, experiences: 3, profile: 1 },
    groups: [
      { key: 'experiences', count: 3, kinds: ['lesson', 'lesson', 'lesson'] },
      { key: 'contributedKnowledge', count: 2, kinds: ['knowledge', 'decision'] }
    ]
  };
  const rows = project.materialsOfLibrary(library);
  assert.deepEqual(rows.map((row) => row.key), ['diagrams', 'experience', 'decisions', 'profile']);
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
  assert.equal(byKey.diagrams.count, 2);
  assert.equal(byKey.diagrams.countText, '2 张');
  assert.equal(byKey.experience.count, 3);
  assert.equal(byKey.experience.countText, '3 条');
  assert.equal(byKey.decisions.count, 1);
  assert.equal(byKey.decisions.countText, '1 条');
  assert.equal(byKey.profile.count, 1);
  assert.equal(byKey.profile.countText, '有画像');
  assert.ok(rows.every((row) => row.available === true));
});

test('资料计数：没有内容的类型计数为 0 且不可选；items 形状同样能数决策', () => {
  const rows = project.materialsOfLibrary({
    counts: {},
    groups: [{ key: 'contributedKnowledge', items: [{ kind: 'decision' }, { kind: 'knowledge' }] }]
  });
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
  assert.equal(byKey.decisions.count, 1);
  assert.equal(byKey.diagrams.countText, '暂无');
  assert.equal(byKey.profile.countText, '暂无');
  assert.equal(byKey.experience.available, false);
  assert.equal(byKey.decisions.available, true);
});

// ── 与 #123 的接缝：生成 prompt 时也按位置插入「关联项目」段 ─────────

test('生成 prompt：关联段在上下文之后、引用对话之前；没有关联就不出现', () => {
  const messages = [{ role: 'user', text: '一句原文' }];
  const without = prompt.buildPrompt({ instruction: '做事', messages, selected: new Set([0]) });
  assert.ok(!without.includes('## 关联项目'));
  const links = project.linksFromDraft(project.toggleAuto(project.emptyDraft(), 'beta'), [BETA]).links;
  const text = prompt.buildPrompt({
    instruction: '做事',
    context: { project: '当前项目' },
    messages,
    selected: new Set([0]),
    projectSection: project.linksToSection(links)
  });
  const at = (heading) => text.indexOf(heading);
  assert.ok(at('## 关联项目') > at('# 上下文'));
  assert.ok(at('## 引用对话（原文）') > at('## 关联项目'));
  assert.ok(at('# 我需要你') > at('## 引用对话（原文）'));
  assert.ok(text.includes('- Beta Repo（项目库 · D:\\repos\\beta）'));
});
