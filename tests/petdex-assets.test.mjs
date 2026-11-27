// 排行下载必须完整、可离线使用且能逐文件追溯，不能用预览图冒充动画包。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {listMascots,readMascotPackage,DEFAULT_MASCOT_SKIN} from '../src/mascots.mjs';
const root=path.resolve(import.meta.dirname,'../desktop/assets/mascots');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'petdex-manifest.json'),'utf8'));

test('Petdex 快照严格包含安装量降序的前五十项，保存来源和下载包摘要',()=>{
 assert.equal(manifest.count,50);assert.equal(manifest.sort,'installed');assert.equal(manifest.pets.length,50);
 assert.equal(new Set(manifest.pets.map(p=>p.slug)).size,50);
 assert.deepEqual(manifest.pets.map(p=>p.rank),Array.from({length:50},(_,i)=>i+1));
 const counts=manifest.pets.map(p=>p.metrics.installCount);assert.deepEqual(counts,[...counts].sort((a,b)=>b-a));
 assert.equal(manifest.pets[0].id,DEFAULT_MASCOT_SKIN);
 for(const pet of manifest.pets){assert.match(pet.source,/^https:\/\/petdex\.dev\/pets\//u);assert.match(pet.archiveSha256,/^[a-f0-9]{64}$/u);assert.ok(Object.hasOwn(pet,'license'));}
});

test('五十份原始图集、原始配置、轻量缩略图与来源文件均实际入库且摘要正确',()=>{
 for(const pet of manifest.pets){
  const dir=path.join(root,pet.id);const pkg=readMascotPackage(dir);
  assert.ok(pkg,pet.slug);assert.equal(pkg.kind,'sprite');assert.equal(pkg.collection,'petdex');assert.equal(pkg.rank,pet.rank);
  assert.ok(fs.statSync(path.join(dir,'thumb.png')).size>0);
  assert.ok(fs.statSync(path.join(dir,'upstream-pet.json')).size>0);
  for(const file of pet.files){const data=fs.readFileSync(path.join(dir,file.path));assert.equal(data.length,file.bytes);assert.equal(createHash('sha256').update(data).digest('hex'),file.sha256,pet.slug+'/'+file.path);}
 }
});

test('运行时按快照排名优先展示全部 Petdex 动画，仍保留 Cindy 与外部扩展',()=>{
 const c=listMascots({builtinDir:root});assert.equal(c.skins.length,60);
 assert.deepEqual(c.skins.slice(0,50).map(s=>s.id),manifest.pets.map(p=>p.id));
 assert.ok(c.skins.slice(0,50).every(s=>s.kind==='sprite'&&s.builtin));
 assert.equal(c.skins.filter(s=>s.kind==='static').length,10);
 const fixed=manifest.pets.find(p=>p.slug==='spyro');assert.ok(fixed.adaptations.length>0);
 assert.match(readMascotPackage(path.join(root,fixed.id)).file,/\.png$/u);
});
