// 随包技能必须离线可读、来源固定，并被真正包含在发行包中。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { bundledSkillsRoot, bundledPstackSkills, bundledMattSkills, isBundledSkill } from '../src/bundled-skills.mjs';
import { skillCatalogFor, localSkillRoots } from '../src/knowledge/skills.mjs';
import { chatSkillRegistry, resolveChatSkill } from '../src/knowledge/chat-catalog.mjs';
import { resolvePstackSkillsDir } from '../src/pstack/readonly-session.mjs';

test('两个技能包固定来源版本，所有正文和附属文件与记录的摘要一致', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(bundledSkillsRoot,'manifest.json'),'utf8'));
  assert.equal(manifest.runtimeNetworkRequired,false);
  assert.deepEqual(manifest.packages.map(item=>item.id),['pstack','matt']);
  for (const pkg of manifest.packages) {
    assert.match(pkg.revision,/^[a-f0-9]{40}$/u);
    assert.match(pkg.repository,/^https:\/\/github.com\//u);
    assert.match(fs.readFileSync(path.join(bundledSkillsRoot,pkg.licensePath),'utf8'),/MIT License/u);
    for (const file of pkg.files) {
      const full=path.join(bundledSkillsRoot,pkg.id,file.path);
      assert.ok(isBundledSkill(full));
      assert.equal(createHash('sha256').update(fs.readFileSync(full)).digest('hex'),file.sha256,file.path);
    }
  }
});

test('默认使用应用自带资源，本机目录仅显式启用，包配置包含资源', () => {
  assert.equal(resolvePstackSkillsDir(''),bundledPstackSkills);
  assert.deepEqual(localSkillRoots({env:{HOME:'/missing',CODEX_HOME:'/missing'}}),[]);
  assert.equal(isBundledSkill('/outside/SKILL.md'),false);
  assert.equal(isBundledSkill(path.join(bundledSkillsRoot,'..','outside.md')),false);
  const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  assert.ok(pkg.build.files.includes('resources/skills/**/*'));
});

test('默认目录中两套技能可读，同名保留来源，废弃技能不出现在调用清单', () => {
  const view=skillCatalogFor({pstackSkillsDir:bundledPstackSkills,mattSkillsDir:bundledMattSkills,withItems:true});
  const registry=chatSkillRegistry(view.items);
  assert.equal(registry.items.filter(item=>item.source==='pstack'&&item.callable).length,53);
  assert.ok(registry.items.filter(item=>item.source==='matt'&&item.callable).length>30);
  assert.ok(registry.items.every(item=>isBundledSkill(item.path)));
  assert.ok(registry.items.every(item=>!item.path.includes(path.sep+'deprecated'+path.sep)));
  assert.ok(resolveChatSkill(registry.skills,'pstack:tdd'));
  assert.ok(resolveChatSkill(registry.skills,'matt:engineering/tdd'));
  assert.equal(resolveChatSkill(registry.skills,'tdd'),null);
  assert.ok(resolveChatSkill(registry.skills,'domain-modeling'));
});
