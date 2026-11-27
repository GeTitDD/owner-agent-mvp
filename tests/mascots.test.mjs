// 桌宠皮肤注册表：Cindy 皮肤集、自定义覆盖、回退与 Codex 阶段映射。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MASCOT_SKINS, DEFAULT_MASCOT_SKIN, SESSION_PHASES,
  listMascots, resolveMascot, isValidMascotSelection, phaseForState,
  readMascotPackage, importMascot, animationForPhase
} from '../src/mascots.mjs';

const makeDirs = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-'));
  const builtin = path.join(root, 'builtin');
  const user = path.join(root, 'user');
  fs.mkdirSync(builtin, { recursive: true });
  fs.mkdirSync(user, { recursive: true });
  for (const id of ['pululu', 'cindy', 'blackcat']) {
    fs.writeFileSync(path.join(builtin, `${id}.png`), `png-${id}`);
  }
  fs.writeFileSync(path.join(builtin, 'pululu.svg'), '<svg/>');
  return { root, builtin, user };
};

test('内置皮肤顺序与 Cindy 一致，并识别 png/svg', () => {
  assert.deepEqual(MASCOT_SKINS, [
    'cindy', 'blackcat', 'pululu', 'tarara', 'boli',
    'whitesnow', 'annie', 'chaku', 'muffin', 'erika'
  ]);
  const { builtin, user } = makeDirs();
  const catalog = listMascots({ builtinDir: builtin, userDir: user });
  assert.deepEqual(catalog.skins.map((item) => item.id), ['cindy', 'blackcat', 'pululu']);
  assert.equal(catalog.skins.every((item) => item.builtin), true);
});

test('用户目录同名皮肤覆盖内置，manifest 可改显示名与默认值', () => {
  const { builtin, user } = makeDirs();
  fs.writeFileSync(path.join(user, 'cindy.png'), 'custom-cindy');
  fs.writeFileSync(path.join(user, 'my-pet.png'), 'custom-other');
  fs.writeFileSync(path.join(user, 'manifest.json'), JSON.stringify({
    default: 'my-pet', labels: { 'my-pet': '我的宠物', cindy: 'Cindy 自定义' }
  }));
  const catalog = listMascots({ builtinDir: builtin, userDir: user });
  const cindy = catalog.skins.find((item) => item.id === 'cindy');
  assert.equal(cindy.source, 'custom');
  assert.equal(cindy.builtin, false);
  assert.equal(cindy.label, 'Cindy 自定义');
  assert.equal(catalog.skins.find((item) => item.id === 'my-pet').label, '我的宠物');
  assert.equal(catalog.default, 'my-pet');

  const resolved = resolveMascot({ builtinDir: builtin, userDir: user, skin: 'my-pet' });
  assert.equal(resolved.skin, 'my-pet');
  assert.match(resolved.file, /my-pet\.png$/u);
});

test('无效配置回退到 manifest 默认或首个可用模板，再回退到首个可用皮肤', () => {
  const { builtin, user } = makeDirs();
  const fallback = resolveMascot({ builtinDir: builtin, userDir: user, skin: 'not-exist' });
  assert.equal(fallback.skin, 'cindy');
  assert.equal(fallback.fallback, true);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-empty-'));
  const first = resolveMascot({ builtinDir: empty, userDir: empty, skin: 'cindy' });
  assert.equal(first.skin, '');
  assert.equal(first.file, '');
});

test('选择校验拒绝路径穿越与未知 id', () => {
  const { builtin, user } = makeDirs();
  assert.equal(isValidMascotSelection({ builtinDir: builtin, userDir: user, skin: 'cindy' }), true);
  assert.equal(isValidMascotSelection({ builtinDir: builtin, userDir: user, skin: '../../evil' }), false);
  assert.equal(isValidMascotSelection({ builtinDir: builtin, userDir: user, skin: 'nope' }), false);
});

test('五态映射到 Codex/Agent Island 阶段', () => {
  assert.deepEqual(SESSION_PHASES, ['idle', 'running', 'needs-interaction', 'completed', 'error']);
  assert.equal(phaseForState('working'), 'running');
  assert.equal(phaseForState('waiting'), 'needs-interaction');
  assert.equal(phaseForState('done'), 'completed');
  assert.equal(phaseForState('error'), 'error');
  assert.equal(phaseForState('unknown'), 'idle');
});

test('Codex Pet 包：读取 pet.json / spritesheet，并默认 8x9 动画行', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-pkg-'));
  const user = path.join(root, 'user');
  const dir = path.join(user, 'demo-pet');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'spritesheet.webp'), 'fake-webp');
  fs.writeFileSync(path.join(dir, 'pet.json'), JSON.stringify({
    id: 'demo-pet', displayName: 'Demo Pet', spriteVersionNumber: 1,
    spritesheetPath: 'spritesheet.webp',
    states: { idle: { row: 0, durationMs: 120 }, running: { row: 7, durationMs: 90 } }
  }));
  const pkg = readMascotPackage(dir);
  assert.equal(pkg.id, 'demo-pet');
  assert.equal(pkg.kind, 'sprite');
  assert.equal(pkg.sprite.columns, 8);
  assert.equal(pkg.sprite.rows, 9);
  assert.equal(pkg.sprite.frameWidth, 192);
  assert.equal(pkg.sprite.frameHeight, 208);
  assert.equal(pkg.sprite.states.running.row, 7);
  assert.equal(pkg.sprite.states.running.durationMs, 90);
  // 只覆写时长时，帧数仍用 Codex 标准的 idle 6 帧。
  assert.equal(pkg.sprite.states.idle.frames, 6);
  assert.equal(pkg.sprite.states.waving.frames, 4);

  const catalog = listMascots({ builtinDir: '', userDir: user });
  assert.equal(catalog.skins.length, 1);
  assert.equal(catalog.skins[0].kind, 'sprite');
  const resolved = resolveMascot({ builtinDir: '', userDir: user, skin: 'demo-pet' });
  assert.equal(resolved.kind, 'sprite');
  assert.match(resolved.file, /spritesheet\.webp$/u);
  assert.equal(resolved.sprite.states.idle.row, 0);
});

test('Codex v2 包默认 8x11，并接受 animations.states 覆盖', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-v2-'));
  const dir = path.join(root, 'v2-pet');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sheet.png'), 'fake-png');
  fs.writeFileSync(path.join(dir, 'pet.json'), JSON.stringify({
    id: 'v2-pet', spriteVersionNumber: 2, spritesheet: 'sheet.png',
    animations: { states: { idle: { row: 0, durationMs: 100 }, review: { row: 8, durationMs: 80 } } }
  }));
  const pkg = readMascotPackage(dir);
  assert.equal(pkg.sprite.rows, 11);
  assert.equal(pkg.sprite.states.review.row, 8);
  assert.equal(pkg.sprite.states.review.durationMs, 80);
});

test('无效 Codex 包被忽略：缺失 spritesheet、路径穿越、坏 JSON', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-bad-'));
  const user = path.join(root, 'user');
  fs.mkdirSync(path.join(user, 'missing-sheet'), { recursive: true });
  fs.writeFileSync(path.join(user, 'missing-sheet', 'pet.json'), JSON.stringify({
    id: 'missing-sheet', spritesheetPath: 'nope.webp'
  }));
  fs.mkdirSync(path.join(user, 'escape'), { recursive: true });
  fs.writeFileSync(path.join(user, 'escape', 'pet.json'), JSON.stringify({
    id: 'escape', spritesheetPath: '../outside.webp'
  }));
  fs.mkdirSync(path.join(user, 'broken'), { recursive: true });
  fs.writeFileSync(path.join(user, 'broken', 'pet.json'), '{bad json');
  const catalog = listMascots({ builtinDir: '', userDir: user });
  assert.equal(catalog.skins.length, 0);
});

test('importMascot 只复制 manifest 与 spritesheet，并返回可直接切换的 id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-import-'));
  const source = path.join(root, 'source', 'my-pet');
  const user = path.join(root, 'user');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'sheet.png'), 'sheet-bytes');
  fs.writeFileSync(path.join(source, 'preview.png'), 'preview-bytes');
  fs.writeFileSync(path.join(source, 'pet.json'), JSON.stringify({
    id: 'my-pet', displayName: 'My Pet', spritesheetPath: 'sheet.png'
  }));
  const imported = importMascot({ sourcePath: path.join(source, 'pet.json'), userDir: user });
  assert.equal(imported.skin, 'my-pet');
  assert.equal(fs.readFileSync(path.join(user, 'my-pet', 'sheet.png'), 'utf8'), 'sheet-bytes');
  assert.equal(fs.existsSync(path.join(user, 'my-pet', 'preview.png')), true);
  const resolved = resolveMascot({ builtinDir: '', userDir: user, skin: 'my-pet' });
  assert.equal(resolved.kind, 'sprite');
});

test('阶段到动画行：waiting/review/failed 的优先顺序', () => {
  const states = {
    idle: { row: 0 }, review: { row: 8 }, waiting: { row: 6 }, failed: { row: 5 }
  };
  assert.equal(animationForPhase('idle', states).name, 'idle');
  assert.equal(animationForPhase('needs-interaction', states).name, 'waiting');
  assert.equal(animationForPhase('completed', states).name, 'review');
  assert.equal(animationForPhase('error', states).name, 'failed');
  assert.equal(animationForPhase('running', states).name, 'idle');
});

test('Codex 默认帧数：每行只播有效帧，行尾透明占位不参与循环', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-frames-'));
  const dir = path.join(root, 'default-pet');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sheet.png'), 'fake-png');
  fs.writeFileSync(path.join(dir, 'pet.json'), JSON.stringify({
    id: 'default-pet', spritesheetPath: 'sheet.png'
  }));
  const { sprite } = readMascotPackage(dir);
  const frames = Object.fromEntries(Object.entries(sprite.states).map(([k, v]) => [k, v.frames]));
  assert.deepEqual(frames, {
    idle: 6, 'running-right': 8, 'running-left': 8, waving: 4, jumping: 5,
    failed: 8, waiting: 6, running: 6, review: 6
  });
  // waving / jumping / failed 是一次性动作，默认不循环。
  assert.equal(sprite.states.waving.loop, false);
  assert.equal(sprite.states.jumping.loop, false);
  assert.equal(sprite.states.failed.loop, false);
  assert.equal(sprite.states.idle.loop, true);
  assert.equal(sprite.states.review.loop, true);
});
