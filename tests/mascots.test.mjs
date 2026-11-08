// 桌宠皮肤注册表：Cindy 皮肤集、自定义覆盖、回退与 Codex 阶段映射。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MASCOT_SKINS, DEFAULT_MASCOT_SKIN, SESSION_PHASES,
  listMascots, resolveMascot, isValidMascotSelection, phaseForState
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
  assert.equal(cindy.label, 'Cindy 自定义');
  assert.equal(catalog.skins.find((item) => item.id === 'my-pet').label, '我的宠物');
  assert.equal(catalog.default, 'my-pet');

  const resolved = resolveMascot({ builtinDir: builtin, userDir: user, skin: 'my-pet' });
  assert.equal(resolved.skin, 'my-pet');
  assert.match(resolved.file, /my-pet\.png$/u);
});

test('无效配置回退到 manifest 默认或 pululu，再回退到首个可用皮肤', () => {
  const { builtin, user } = makeDirs();
  const fallback = resolveMascot({ builtinDir: builtin, userDir: user, skin: 'not-exist' });
  assert.equal(fallback.skin, DEFAULT_MASCOT_SKIN);
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
