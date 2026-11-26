// 只读体检：这个仓库现在能不能被驱动。
// 用法：node .cursor/skills/verify-owner-companion/scripts/doctor.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(path.join(repoRoot, 'package.json'));
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

// Node 版本：package.json engines 要求 >=22.13（node:sqlite 与测试都依赖它）。
const [major, minor] = process.versions.node.split('.').map(Number);
check('Node >= 22.13', major > 22 || (major === 22 && minor >= 13), process.versions.node);

// Electron 可执行文件：cdp.startApp 用它起窗口。
let electronPath = '';
try {
  electronPath = require('electron');
} catch (error) {
  check('electron 已安装', false, String(error.message ?? error));
}
check('electron 可执行文件存在', Boolean(electronPath) && fs.existsSync(electronPath), electronPath);

// CDP harness 与语法检查清单。
const cdpFile = path.join(repoRoot, 'scripts/e2e/lib/cdp.mjs');
check('CDP harness 存在', fs.existsSync(cdpFile), cdpFile);
const listFile = path.join(repoRoot, 'scripts/check-files.json');
let listOk = false;
try {
  const list = JSON.parse(fs.readFileSync(listFile, 'utf8'));
  listOk = Array.isArray(list) && list.length > 100;
} catch { /* 下面统一报 */ }
check('语法检查清单可读', listOk, listFile);

// 驱动所需的模块能被加载（不启动窗口）。
let harnessOk = false;
try {
  const cdp = await import(pathToFileURL(cdpFile).href);
  harnessOk = ['startApp', 'connectCdp', 'waitFor', 'capture'].every((key) => typeof cdp[key] === 'function');
} catch { /* 下面统一报 */ }
check('harness 导出 startApp/waitFor/capture', harnessOk);

// 语法检查：只读，不写文件。
try {
  execFileSync(process.execPath, [path.join(repoRoot, 'scripts/check-syntax.mjs')], {
    cwd: repoRoot, stdio: 'pipe', timeout: 120000
  });
  check('npm run check 通过', true);
} catch (error) {
  check('npm run check 通过', false, String(error.stderr ?? error.message).slice(0, 300));
}

if (failures.length) {
  console.error(`\n${failures.length} 项未通过，先修好再驱动。`);
  process.exit(1);
}
console.log('\n可以驱动：用 run-feature.mjs 跑 features/ 里的一条 drive。');
