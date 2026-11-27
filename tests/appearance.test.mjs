// 外观资源需要各平台可用、来源可追溯；默认桌宠必须是已下载的真实模板。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DEFAULT_MASCOT_SKIN,listMascots,resolveMascot} from '../src/mascots.mjs';
const root=path.resolve(import.meta.dirname,'..');
const assets=path.join(root,'desktop/assets/branding');

test('动漫图标包含完整 PNG、Windows ICO、macOS ICNS 和源文件许可记录',()=>{
 const png=fs.readFileSync(path.join(assets,'app-icon.png'));
 assert.equal(png.subarray(1,4).toString(),'PNG');
 assert.equal(png.readUInt32BE(16),1024);assert.equal(png.readUInt32BE(20),1024);
 const ico=fs.readFileSync(path.join(assets,'app-icon.ico'));assert.equal(ico.readUInt16LE(2),1);assert.ok(ico.readUInt16LE(4)>=6);
 const icns=fs.readFileSync(path.join(assets,'app-icon.icns'));assert.equal(icns.subarray(0,4).toString(),'icns');assert.equal(icns.readUInt32BE(4),icns.length);
 const source=JSON.parse(fs.readFileSync(path.join(assets,'source.json'),'utf8'));
 assert.equal(source.sourceSha256,createHash('sha256').update(fs.readFileSync(path.join(assets,'avatar-source.svg'))).digest('hex'));
 assert.equal(source.license,'CC BY-SA 3.0');assert.ok(fs.statSync(path.join(assets,'LICENSE-CC-BY-SA-3.0.txt')).size>10000);
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 assert.equal(pkg.build.win.icon,'desktop/assets/branding/app-icon.ico');assert.equal(pkg.build.mac.icon,'desktop/assets/branding/app-icon.icns');
});

test('默认使用 Petdex 首位动画，同时保留十个 Cindy 模板',()=>{
 const builtinDir=path.join(root,'desktop/assets/mascots');const catalog=listMascots({builtinDir});
 assert.equal(DEFAULT_MASCOT_SKIN,'petdex-01-boba');assert.equal(catalog.skins.length,60);
 const current=resolveMascot({builtinDir});assert.equal(current.skin,'petdex-01-boba');assert.equal(current.kind,'sprite');
 assert.equal(catalog.skins.every(item=>item.builtin),true);assert.equal(catalog.skins.find(item=>item.id==='erika').label,'Erika');
});
