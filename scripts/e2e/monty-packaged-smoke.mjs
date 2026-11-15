// 打包后 Monty 冒烟：验证 asarUnpack 的原生包与 worker 在 portable/dir 构建中可用。
//
// 用法：
//   node scripts/e2e/monty-packaged-smoke.mjs            # 缺构建时自动 electron-builder --win dir
//   PACKAGED_EXE=<path> node scripts/e2e/monty-packaged-smoke.mjs
//   node scripts/e2e/monty-packaged-smoke.mjs --no-build # 只用已有构建
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const args = process.argv.slice(2);
const noBuild = args.includes('--no-build');
const exe = process.env.PACKAGED_EXE
  || path.join(repoRoot, 'dist-companion', 'win-unpacked', 'Owner Companion.exe');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.platform !== 'win32') {
  console.log('[PACKAGED] SKIP: only validated on Windows');
  process.exit(0);
}

if (!fs.existsSync(exe)) {
  if (noBuild) {
    console.error(`[PACKAGED] FAIL: missing ${exe}`);
    process.exit(1);
  }
  console.log('[PACKAGED] building win-unpacked…');
  execFileSync('npx', ['electron-builder', '--win', 'dir', '--x64'], {
    cwd: repoRoot, stdio: 'inherit', shell: true, timeout: 30 * 60 * 1000
  });
}

if (!fs.existsSync(exe)) {
  console.error(`[PACKAGED] FAIL: build did not produce ${exe}`);
  process.exit(1);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monty-packaged-'));
const userData = path.join(root, 'userdata');
const out = path.join(root, 'selftest.json');
fs.mkdirSync(userData, { recursive: true });

const child = spawn(exe, [
  '--self-test=monty',
  `--self-test-out=${out}`,
  `--user-data-dir=${userData}`
], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += String(chunk); });

const deadline = Date.now() + 120000;
while (!fs.existsSync(out) && Date.now() < deadline) await sleep(500);
try { child.kill(); } catch { /* best effort */ }

if (!fs.existsSync(out)) {
  console.error('[PACKAGED] FAIL: self-test result not produced');
  if (stderr) console.error(stderr.slice(0, 2000));
  process.exit(1);
}
const result = JSON.parse(fs.readFileSync(out, 'utf8'));
console.log('[PACKAGED]', JSON.stringify(result));
const ok = result.ok === true && result.result === '5050' && result.packaged === true;
if (!ok) {
  console.error('[PACKAGED] FAIL: Monty does not run inside the packaged app');
  process.exit(1);
}
console.log('[PACKAGED] PASS');
