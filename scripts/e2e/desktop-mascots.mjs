// 动态桌宠验收：Codex Pet spritesheet 播放 + 一键换肤（#111 后不再检查已删除的设置页网格）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { OwnerStore } from '../../src/owner-store.mjs';
import { createSyntheticProject } from '../knowledge-loop/fixtures.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const pluginDir = path.join(repoRoot, 'integrations', 'openclaw-plugin');
const { _electron: electron } = createRequire(path.join(pluginDir, 'package.json'))('playwright-core');
const electronPath = createRequire(path.join(repoRoot, 'package.json'))('electron');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const check = (label, condition, detail = '') => {
  if (condition) console.log(`[MASCOT] OK   ${label}${detail ? ` (${detail})` : ''}`);
  else { failures.push(label); console.error(`[MASCOT] FAIL ${label}${detail ? ` (${detail})` : ''}`); }
};

// 最小 PNG 编码器：生成 8 列 x 9 行、每帧 16x16 的纯色 spritesheet。
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};
const makeSpriteSheet = () => {
  const columns = 8;
  const rows = 9;
  const frame = 16;
  const width = columns * frame;
  const height = rows * frame;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const offset = y * (width * 4 + 1);
    raw[offset] = 0;
    const row = Math.floor(y / frame);
    for (let x = 0; x < width; x += 1) {
      const column = Math.floor(x / frame);
      const index = offset + 1 + x * 4;
      raw[index] = 30 + row * 24;
      raw[index + 1] = 80 + column * 18;
      raw[index + 2] = 180 - row * 12;
      raw[index + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
};

const run = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-mascot-'));
  const userData = path.join(root, 'userdata');
  const ownerDb = path.join(root, 'owner.sqlite');
  const evidence = process.env.EVIDENCE_DIR ?? path.join(root, 'evidence');
  const skinDir = path.join(userData, 'mascots', 'sprite-pet');
  fs.mkdirSync(skinDir, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(skinDir, 'spritesheet.png'), makeSpriteSheet());
  fs.writeFileSync(path.join(skinDir, 'pet.json'), JSON.stringify({
    id: 'sprite-pet', displayName: 'Sprite Pet', spriteVersionNumber: 1,
    spritesheetPath: 'spritesheet.png',
    states: {
      idle: { row: 0, durationMs: 90 },
      running: { row: 7, durationMs: 80 },
      waiting: { row: 6, durationMs: 80 },
      review: { row: 8, durationMs: 80 },
      failed: { row: 5, durationMs: 80 }
    }
  }, null, 2));
  fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({
    pet: { x: 220, y: 180 }, projectId: 'demo', mascotSkin: 'sprite-pet',
    gatewayUrl: 'http://127.0.0.1:18789', model: '', includePaths: ['package.json']
  }, null, 2));

  const owner = new OwnerStore(ownerDb);
  try {
    createSyntheticProject({ store: owner, root: path.join(root, 'demo'), projectId: 'demo', name: 'Demo' });
  } finally { owner.close(); }

  const app = await electron.launch({
    executablePath: electronPath,
    args: [path.join(repoRoot, 'desktop', 'main.cjs'), `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      OWNER_AGENT_DB: ownerDb,
      OWNER_AGENT_NOTIFICATIONS: '0',
      OWNER_AGENT_E2E_OFFSCREEN: '1'
    },
    timeout: 60000
  });

  let failed = true;
  let petPage;
  try {
    const deadline = Date.now() + 30000;
    while (!petPage && Date.now() < deadline) {
      petPage = app.windows().find((page) => page.url().includes('pet.html')) ?? null;
      if (!petPage) await sleep(300);
    }
    if (!petPage) throw new Error('pet window missing');
    await petPage.waitForSelector('#pet', { timeout: 20000 });
    await sleep(1500);

    const initial = await petPage.evaluate(() => ({
      skin: document.getElementById('pet')?.dataset.skin,
      spriteHidden: document.getElementById('sprite')?.hidden,
      mascotHidden: document.getElementById('mascot')?.hidden,
      plateCount: document.querySelectorAll('.plate, .ring').length,
      position: getComputedStyle(document.getElementById('sprite')).backgroundPosition,
      size: `${getComputedStyle(document.getElementById('sprite')).width}x${getComputedStyle(document.getElementById('sprite')).height}`
    }));
    check('sprite pet is active', initial.skin === 'sprite-pet', initial.skin);
    check('spritesheet is rendered instead of img', initial.spriteHidden === false && initial.mascotHidden === true, JSON.stringify(initial));
    check('no white plate or ring behind the pet', initial.plateCount === 0, String(initial.plateCount));
    check('sprite frame has a size', /^\d+pxx\d+px$/u.test(initial.size), initial.size);
    await sleep(400);
    const moved = await petPage.evaluate(() => getComputedStyle(document.getElementById('sprite')).backgroundPosition);
    check('idle animation advances frames', moved !== initial.position, `${initial.position} -> ${moved}`);

    // idle 只有 6 帧有效：采样 1.4s，列号不应走到 6/7 的透明占位。
    const columns = new Set();
    for (let i = 0; i < 8; i += 1) {
      const column = await petPage.evaluate(() => {
        const el = document.getElementById('sprite');
        const width = Number.parseFloat(getComputedStyle(el).width) || 1;
        const left = Number.parseFloat(getComputedStyle(el).backgroundPositionX) || 1;
        return Math.round(Math.abs(left) / width);
      });
      columns.add(column);
      await sleep(180);
    }
    check('current animation never plays blank trailing frames', Math.max(...columns) <= 5, [...columns].join(','));
    await petPage.screenshot({ path: path.join(evidence, 'pet-sprite-idle.png') });

    // 一键换肤：点击悬停工具条的 ↻，切到下一个皮肤。
    await petPage.locator('.stage').hover();
    await petPage.locator('#skinNext').click({ force: true });
    await sleep(1200);
    const cycled = await petPage.evaluate(() => ({
      skin: document.getElementById('pet')?.dataset.skin,
      spriteHidden: document.getElementById('sprite')?.hidden,
      mascotHidden: document.getElementById('mascot')?.hidden,
      mascotSrc: document.getElementById('mascot')?.getAttribute('src')
    }));
    check('one-click skin cycle changes the active skin', cycled.skin && cycled.skin !== 'sprite-pet', cycled.skin);
    check('static skin falls back to mascot image', cycled.spriteHidden === true && cycled.mascotHidden === false && Boolean(cycled.mascotSrc), JSON.stringify(cycled));

    // #111 撤旧壳后设置页的皮肤网格随旧面板一起删除；换肤仍在宠物自己的工具条上，
    // 这里继续用「↻」绕一圈，保证一键换肤能回到精灵皮肤。
    let restored = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      restored = await petPage.evaluate(() => ({
        skin: document.getElementById('pet')?.dataset.skin,
        spriteHidden: document.getElementById('sprite')?.hidden
      }));
      if (restored.skin === 'sprite-pet') break;
      await petPage.locator('.stage').hover();
      await petPage.locator('#skinNext').click({ force: true });
      await sleep(1200);
    }
    check('one-click skin cycle can return to sprite pet', restored?.skin === 'sprite-pet' && restored?.spriteHidden === false, JSON.stringify(restored));
    await petPage.screenshot({ path: path.join(evidence, 'pet-sprite-restored.png') });

    if (failures.length) throw new Error(`${failures.length} assertion(s) failed`);
    failed = false;
    console.log('[MASCOT] PASS');
  } finally {
    if (failed && petPage) {
      try { await petPage.screenshot({ path: path.join(evidence, 'pet-failure.png') }); } catch { /* best effort */ }
    }
    await app.close();
    if (!failures.length) fs.rmSync(root, { recursive: true, force: true });
    else console.error(`[MASCOT] kept state: ${root}`);
  }
};

run().catch((error) => {
  console.error(`[MASCOT] FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
