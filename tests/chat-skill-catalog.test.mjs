// 身份映射跨四处来源保持一致；正文校验和同名处理不依赖 Electron 或模型。
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {chatSkillRegistry,resolveChatSkill,skillBodyOf} from '../src/knowledge/chat-catalog.mjs';
import {scanPluginSkills} from '../src/knowledge/skills.mjs';
import {PiChatService,createSkillTool,loadChatSkillCatalogue,buildSkillSection} from '../src/pi-chat.mjs';
const fixture=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'owner-skill-registry-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const make=(id,body)=>{const file=path.join(root,id,'SKILL.md');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);return file;};return{root,make};};

test('四处来源均有稳定可调用身份，重复短名只允许精确选定',t=>{
  const f=fixture(t);const entries=['domain','pstack','matt','plugin'].map(source=>({id:`${source}:same`,source,origin:source,name:'可读显示名',path:f.make(source+'/same',`# ${source}\n${source} 正文`)}));
  const registry=chatSkillRegistry(entries);assert.equal(registry.skills.length,4);assert.equal(resolveChatSkill(registry.skills,'same'),null);
  for(const item of registry.items){assert.equal(item.callId,item.id);assert.equal(item.commandName,'same');assert.equal(resolveChatSkill(registry.skills,item.callId).path,item.path);}
});
test('缺失、Playbook、空正文和不可读文件保留原因但不允许调用',t=>{
  const f=fixture(t);const items=[{id:'pstack:empty',path:f.make('empty','---\r\nname: Empty\r\n---\r\n')},{id:'pstack:missing',missing:true,reason:'SKILL.md 缺失'},{id:'pstack:play',playbookOnly:true},{id:'pstack:gone',path:path.join(f.root,'gone','SKILL.md')}];
  const r=chatSkillRegistry(items);assert.equal(r.items.length,4);assert.equal(r.skills.length,0);assert.ok(r.items.every(row=>!row.callable&&row.callReason));
});
test('技能工具支持目录刷新后的同一身份，并且不读取另一个来源',async t=>{
  const f=fixture(t);let skills=chatSkillRegistry([{id:'pstack:same',path:f.make('a/same','PSTACK-SENTINEL')}]).skills;
  const tool=createSkillTool({skills:()=>skills});assert.ok((await tool.execute('a',{id:'pstack:same'})).content[0].text.includes('PSTACK-SENTINEL'));
  skills=chatSkillRegistry([{id:'matt:same',path:f.make('b/same','MATT-SENTINEL')}]).skills;
  assert.equal((await tool.execute('b',{id:'pstack:same'})).isError,true);assert.equal((await tool.execute('c',{id:'same'})).content[0].text,'MATT-SENTINEL');
});
test('隐式短名只在唯一时解析，不把所有域包与插件变为默认隐式技能',t=>{
  const f=fixture(t);const r=chatSkillRegistry([{id:'pstack:why',path:f.make('why','为什么')},{id:'plugin:explicit',path:f.make('explicit','仅显式调用')}]);
  const text=buildSkillSection(r.skills,['why']).join('\n');assert.ok(text.includes('pstack:why'));assert.ok(text.includes('只能显式调用（1 个'));
});
test('指定技能文件在发送前被移除时明确失败，不创建模型会话',async t=>{
  const f=fixture(t);const file=f.make('gone','可读正文');const registry=chatSkillRegistry([{id:'matt:gone',path:file}]);fs.unlinkSync(file);let creates=0;
  const service=new PiChatService({model:'fixture/check',skills:()=>registry.skills,sessionFactory:{create:async()=>{creates++;throw Error('不得创建');}}});
  const r=await service.ask({project:{id:'demo',root:f.root},question:'/skill:matt:gone 检查代码'});assert.equal(r.category,'skill-unavailable');assert.equal(creates,0);service.disposeAll();
});
test('插件的身份不会因声明顺序变化而指向另一份正文',t=>{
  const f=fixture(t);const base=path.join(f.root,'plugins','fixture');f.make('plugins/fixture/a','A');f.make('plugins/fixture/b','B');const file=path.join(base,'ghost.json');
  const scan=dirs=>{fs.writeFileSync(file,JSON.stringify({id:'fixture',skill:{items:dirs.map(dir=>({dir}))}}));return scanPluginSkills({pluginsDir:path.dirname(base)});};
  const first=scan(['a','b']);const next=scan(['b','a']);assert.equal(first.find(row=>row.path.endsWith('/a/SKILL.md')).id,next.find(row=>row.path.endsWith('/a/SKILL.md')).id);
});
test('独立对话扫描的重名身份不使用含空格的显示名',t=>{
  const f=fixture(t);f.make('pstack/same','---\nname: Readable A\n---\nA');f.make('matt/engineering/same','---\nname: 可读名字 B\n---\nB');
  const r=loadChatSkillCatalogue({pstackSkillsDir:path.join(f.root,'pstack'),mattSkillsDir:path.join(f.root,'matt')});assert.equal(r.length,2);assert.ok(r.every(row=>!/[\s]/u.test(row.id)));assert.equal(new Set(r.map(row=>row.id)).size,2);
});
test('正文读取支持 Windows 换行与 BOM，元数据不会混入正文',()=>{assert.equal(skillBodyOf('\uFEFF---\r\nname: test\r\n---\r\n正文'),'正文');});

test('超长技能说明明确标注截断，不把片段冒充完整正文',async t=>{
 const f=fixture(t);const file=f.make('long','a'.repeat(6100));const {readSkillBody}=await import('../src/pi-chat.mjs');assert.match(readSkillBody(file),/已截断至 6000 字/u);
 const tool=createSkillTool({skills:[{id:'long',path:file}],maxChars:12});assert.match((await tool.execute('a',{id:'long'})).content[0].text,/已截断至 12 字/u);
});

test('重复声明同一文件去重，不同正文争用身份时明确禁用',t=>{
 const f=fixture(t);const a={id:'plugin:a',path:f.make('a','A')};const b={id:'plugin:a',path:f.make('b','B')};
 assert.equal(chatSkillRegistry([a,a]).skills.length,1);const r=chatSkillRegistry([a,b]);assert.equal(r.skills.length,0);assert.match(r.items[0].callReason,/重复身份/u);
});
