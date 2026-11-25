// 技能目录：三处来源合并、缺失标注、容错与缓存的纯函数测试（不联网、不启动 Electron）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSkillCatalogCache,
  parseSkillFrontMatter,
  scanDomainSkills,
  scanMattSkills,
  scanPluginSkills,
  scanPstackSkills,
  skillCatalogFor,
  skillCatalogView
} from '../src/knowledge/skills.mjs';

const tempRoot = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-skills-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

const writeFile = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
};

const skillMd = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n正文。\n`;

test('front-matter 只取简单键值；没有 front-matter 时返回空对象', () => {
  assert.deepEqual(parseSkillFrontMatter(skillMd('alpha', '第一颗技能')), {
    name: 'alpha', description: '第一颗技能'
  });
  assert.deepEqual(parseSkillFrontMatter('没有元数据\n'), {});
  assert.deepEqual(parseSkillFrontMatter('---\nname: beta\n没闭合\n'), {});
});

test('视图模型按来源分组、统计缺失，缺失排在最前', () => {
  const view = skillCatalogView({
    scannedAt: '2026-11-24T00:00:00.000Z',
    items: [
      { id: 'd1', source: 'domain', sourceLabel: '域包', name: 'z-skill', missing: false },
      { id: 'd2', source: 'domain', sourceLabel: '域包', name: 'a-skill', missing: true },
      { id: 'p1', source: 'pstack', sourceLabel: 'pstack', name: 'how', missing: false },
      { id: 'g1', source: 'plugin', sourceLabel: '插件', name: 'relay', missing: true }
    ]
  });
  const [domain, pstack, matt, plugin] = view.groups;
  assert.deepEqual(view.groups.map((group) => group.label), ['域包', 'pstack', 'matt', '插件']);
  assert.deepEqual(domain.items.map((item) => item.name), ['a-skill', 'z-skill']);
  assert.equal(domain.missing, 1);
  assert.equal(pstack.count, 1);
  assert.equal(plugin.missing, 1);
  assert.deepEqual(view.totals,
    { all: 4, missing: 2, playbookOnly: 0, present: 2, domain: 2, pstack: 1, matt: 0, plugin: 1 });
  assert.equal(view.empty, null);
  assert.equal(view.scannedAt, '2026-11-24T00:00:00.000Z');
});

test('视图模型截断时仍保留缺失条目，并给出全空说明', () => {
  const items = Array.from({ length: 15 }, (_, index) => ({
    id: `p${index}`, source: 'pstack', sourceLabel: 'pstack', name: `skill-${String(index).padStart(2, '0')}`,
    missing: index === 14
  }));
  const view = skillCatalogView({ items, limit: 3 });
  const group = view.groups.find((item) => item.key === 'pstack');
  assert.equal(group.count, 15);
  assert.equal(group.shown, 3);
  assert.equal(group.truncated, true);
  assert.equal(group.items[0].name, 'skill-14', '缺失条目必须排在最前，不能因截断被藏掉');
  assert.equal(group.missing, 1);

  const empty = skillCatalogView({ items: [] });
  assert.equal(empty.empty.kind, 'no-skills');
  assert.equal(empty.totals.all, 0);
});

test('域包扫描：正常技能、SKILL.md 缺失、manifest 异常、无 skillDirs', (t) => {
  const root = tempRoot(t);
  const domainRoot = path.join(root, 'domains');
  writeFile(path.join(domainRoot, 'alpha', '1.0.0', 'manifest.json'), JSON.stringify({
    skillDirs: ['skills/good', 'skills/gone']
  }));
  writeFile(path.join(domainRoot, 'alpha', '1.0.0', 'skills', 'good', 'SKILL.md'), skillMd('good', '可用的域包技能'));
  // gone 目录连 SKILL.md 都没有。
  fs.mkdirSync(path.join(domainRoot, 'alpha', '1.0.0', 'skills', 'gone'), { recursive: true });
  // 坏 manifest：非法 JSON。
  writeFile(path.join(domainRoot, 'bad', '0.1.0', 'manifest.json'), '{ oops');
  // 没有 skillDirs 的域包不算错误，也不产出条目。
  writeFile(path.join(domainRoot, 'plain', '0.1.0', 'manifest.json'), JSON.stringify({ id: 'plain' }));

  const items = scanDomainSkills({ domainRoot });
  const byName = Object.fromEntries(items.map((item) => [item.name, item]));
  assert.equal(byName.good.missing, false);
  assert.equal(byName.good.description, '可用的域包技能');
  assert.equal(byName.good.origin, 'alpha@1.0.0');
  assert.match(byName.good.path, /SKILL\.md$/u);
  assert.equal(byName.gone.missing, true);
  assert.equal(byName.gone.reason, 'SKILL.md 缺失');
  assert.equal(byName['bad@0.1.0'].missing, true);
  assert.match(byName['bad@0.1.0'].reason, /manifest 解析失败/u);
  assert.equal(items.some((item) => item.origin === 'plain@0.1.0'), false);
  assert.equal(items.every((item) => item.source === 'domain' && item.sourceLabel === '域包'), true);
});

test('域包扫描：目录不存在时不抛错、返回空列表', (t) => {
  const root = tempRoot(t);
  assert.deepEqual(scanDomainSkills({ domainRoot: path.join(root, 'missing') }), []);
  assert.deepEqual(scanDomainSkills({}), []);
});

test('插件扫描：声明与 SKILL.md 对应，缺文件与坏 ghost.json 都标缺失', (t) => {
  const root = tempRoot(t);
  const pluginsDir = path.join(root, 'plugins');
  writeFile(path.join(pluginsDir, 'good', 'ghost.json'), JSON.stringify({
    skill: { items: [{ dir: 'skills/one', name: 'one', description: '清单里的描述' }, { dir: 'skills/two' }] }
  }));
  writeFile(path.join(pluginsDir, 'good', 'skills', 'one', 'SKILL.md'), skillMd('one', 'SKILL.md 里的描述'));
  // two 只有目录、没有 SKILL.md。
  fs.mkdirSync(path.join(pluginsDir, 'good', 'skills', 'two'), { recursive: true });
  // 坏 ghost.json。
  writeFile(path.join(pluginsDir, 'broken', 'ghost.json'), 'null nope');
  // 没有 ghost.json 的目录不是技能载体。
  fs.mkdirSync(path.join(pluginsDir, 'plain'), { recursive: true });

  const items = scanPluginSkills({ pluginsDir });
  const byName = Object.fromEntries(items.map((item) => [item.name, item]));
  assert.equal(byName.one.missing, false);
  // 清单里声明的描述优先，避免把 SKILL.md 正文里的长段落塞进列表。
  assert.equal(byName.one.description, '清单里的描述');
  assert.equal(byName.one.origin, 'good');
  assert.equal(byName.two.missing, true);
  assert.equal(byName.two.reason, 'SKILL.md 缺失');
  assert.equal(byName.broken.missing, true);
  assert.match(byName.broken.reason, /ghost\.json 解析失败/u);
  assert.equal(items.some((item) => item.origin === 'plain'), false);
});

test('插件扫描：目录不存在或 ghost 缺少 skill 时返回空/跳过', (t) => {
  const root = tempRoot(t);
  assert.deepEqual(scanPluginSkills({ pluginsDir: path.join(root, 'missing') }), []);
  const pluginsDir = path.join(root, 'plugins');
  writeFile(path.join(pluginsDir, 'no-skill', 'ghost.json'), JSON.stringify({ id: 'no-skill' }));
  assert.deepEqual(scanPluginSkills({ pluginsDir }), []);
});

test('matt 扫描：两级目录、带分类、跳过 deprecated、缺 SKILL.md 标缺失', (t) => {
  const root = tempRoot(t);
  const skillsRoot = path.join(root, 'matt');
  writeFile(path.join(skillsRoot, 'engineering', 'code-review', 'SKILL.md'), skillMd('code-review', '审代码'));
  writeFile(path.join(skillsRoot, 'productivity', 'grilling', 'SKILL.md'), skillMd('grilling', '追问'));
  fs.mkdirSync(path.join(skillsRoot, 'misc', 'hollow'), { recursive: true });
  writeFile(path.join(skillsRoot, 'deprecated', 'old-skill', 'SKILL.md'), skillMd('old-skill', '已废弃'));

  const items = scanMattSkills({ skillsRoot });
  // deprecated 整组跳过：3 条（两条真技能 + 一条缺 SKILL.md 的目录）
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((item) => item.origin).sort(), ['engineering', 'misc', 'productivity']);
  const hollow = items.find((item) => item.name === 'hollow');
  assert.equal(hollow.missing, true);
  assert.equal(hollow.reason, 'SKILL.md 缺失');
  assert.equal(items.find((item) => item.name === 'code-review').source, 'matt');

  assert.deepEqual(scanMattSkills({ skillsRoot: path.join(root, 'missing') }), []);
});

test('pstack 扫描：磁盘上的技能、缺 SKILL.md 的目录、只在注册表里的 id', (t) => {
  const root = tempRoot(t);
  const skillsDir = path.join(root, 'pstack', 'skills');
  writeFile(path.join(skillsDir, 'how', 'SKILL.md'), skillMd('how', '结构走读'));
  fs.mkdirSync(path.join(skillsDir, 'hollow'), { recursive: true });

  const items = scanPstackSkills({ skillsDir, expectedIds: ['how', 'architect'] });
  const byName = Object.fromEntries(items.map((item) => [item.name, item]));
  assert.equal(byName.how.missing, false);
  assert.equal(byName.how.description, '结构走读');
  assert.equal(byName.hollow.missing, true);
  assert.equal(byName.hollow.reason, 'SKILL.md 缺失');
  assert.equal(byName.architect.missing, true);
  assert.equal(byName.architect.reason, 'SKILL.md 缺失');
  assert.match(byName.architect.path, /architect.SKILL\.md$/u);
});

test('pstack 扫描：目录解析不到时按已知 id 全部标缺失', () => {
  const items = scanPstackSkills({ skillsDir: '', expectedIds: ['how', 'why'] });
  assert.equal(items.length, 2);
  assert.equal(items.every((item) => item.missing), true);
  assert.match(items[0].reason, /PSTACK_DIR/u);
  assert.equal(items[0].sourceLabel, 'pstack');
});

test('P1-7 图谱 playbook 没有 skill 目录：标 playbookOnly，不计入缺失', () => {
  const items = scanPstackSkills({
    skillsDir: '',
    expectedIds: [
      { id: 'how', playbookLabel: '结构走读' },
      { id: 'diagram-control', playbookLabel: '控制流', noSkillDir: true }
    ]
  });
  const byId = Object.fromEntries(items.map((entry) => [entry.id, entry]));
  // 真正的 skill 缺目录仍然报警。
  assert.equal(byId['pstack:how'].missing, true);
  // playbook 是设计如此：不是缺失，也不产生「缺失原因」。
  assert.equal(byId['pstack:diagram-control'].missing, false);
  assert.equal(byId['pstack:diagram-control'].playbookOnly, true);
  assert.equal(byId['pstack:diagram-control'].reason, '');
  assert.match(byId['pstack:diagram-control'].name, /控制流/u);
  const view = skillCatalogView({ items });
  assert.equal(view.totals.missing, 1);
  // 展开详情时能告诉用户「没有目录是正常的」，而不是缺失原因。
  assert.equal(view.groups.find((group) => group.key === 'pstack').items
    .find((entry) => entry.playbookOnly).playbookOnly, true);
});

test('skillCatalogFor 合并三处来源；某处坏掉不影响其他两组', (t) => {
  const root = tempRoot(t);
  const domainRoot = path.join(root, 'domains');
  writeFile(path.join(domainRoot, 'alpha', '1.0.0', 'manifest.json'), JSON.stringify({ skillDirs: ['skills/ok'] }));
  writeFile(path.join(domainRoot, 'alpha', '1.0.0', 'skills', 'ok', 'SKILL.md'), skillMd('ok', '域包技能'));
  const pluginsDir = path.join(root, 'plugins');
  writeFile(path.join(pluginsDir, 'p', 'ghost.json'), JSON.stringify({ skill: { items: [{ dir: 'skills/x', name: 'x' }] } }));
  writeFile(path.join(pluginsDir, 'p', 'skills', 'x', 'SKILL.md'), skillMd('x', '插件技能'));
  const pstackRoot = path.join(root, 'pstack-skills');
  // 故意不放 SKILL.md：pstack 组应当整组标缺失，但另外两组照常返回。
  fs.mkdirSync(pstackRoot, { recursive: true });

  const view = skillCatalogFor({
    domainRoot, pluginsDir, pstackSkillsDir: pstackRoot, pstackSkillIds: ['how'],
    scannedAt: '2026-11-24T00:00:00.000Z'
  });
  const [domain, pstack, matt, plugin] = view.groups;
  assert.deepEqual([domain.count, pstack.count, matt.count, plugin.count], [1, 1, 0, 1]);
  assert.equal(domain.items[0].name, 'ok');
  assert.equal(plugin.items[0].name, 'x');
  assert.equal(pstack.items[0].missing, true);
  assert.equal(view.scannedAt, '2026-11-24T00:00:00.000Z');
  assert.equal(view.empty, null);
  assert.equal(view.totals.missing, 1);
});

test('缓存：TTL 内复用、过期重扫、refresh 强制重扫', () => {
  let clock = 1_000;
  let scans = 0;
  const cache = createSkillCatalogCache({
    ttlMs: 60_000,
    now: () => clock,
    scan: () => {
      scans += 1;
      return { scannedAt: `scan-${scans}`, totals: { all: 0 }, groups: [], empty: null };
    }
  });

  const first = cache.read();
  assert.equal(scans, 1);
  assert.equal(first.cached, false);
  assert.equal(first.ttlMs, 60_000);

  clock += 1_000;
  const second = cache.read();
  assert.equal(scans, 1, 'TTL 内不应再扫描');
  assert.equal(second.cached, true);
  assert.equal(second.scannedAt, 'scan-1');

  clock += 60_000;
  const third = cache.read();
  assert.equal(scans, 2, '过期后应重扫');
  assert.equal(third.cached, false);

  const forced = cache.read({ refresh: true });
  assert.equal(scans, 3, 'refresh 必须强制重扫');
  assert.equal(forced.scannedAt, 'scan-3');

  cache.clear();
  cache.read();
  assert.equal(scans, 4);
});
