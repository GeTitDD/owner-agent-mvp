// 语法检查：按 scripts/check-files.json 逐个跑 node --check。
// 抽成脚本是因为命令行有 8191 字符上限（Windows），条目只会越来越多。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const listPath = path.join(root, 'scripts', 'check-files.json');
const files = JSON.parse(fs.readFileSync(listPath, 'utf8'));

const failed = [];
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
  } catch (error) {
    failed.push({ file, detail: String(error.stderr ?? error.message).trim().split('\n').slice(0, 3).join(' / ') });
  }
}

if (failed.length) {
  for (const item of failed) console.error('语法错误：' + item.file + ' — ' + item.detail);
  console.error(failed.length + ' / ' + files.length + ' 个文件未通过');
  process.exit(1);
}
console.log('语法检查通过：' + files.length + ' 个文件');
