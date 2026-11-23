import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Git 夹具一律关闭可选锁，避免测试准备阶段自己改写 .git/index 污染“只读”断言。
export const git = (cwd, args, env = {}) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env }
}).trim();

export const makeTempDir = (prefix = 'observer-test-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

export const writeFiles = (root, files) => {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
};

/**
 * 建立一个可提交的 Git 仓库夹具。
 * @param {{root:string, files?:Record<string,string>, commitAt?:string|null, branch?:string,
 *   remote?:string, commitMessage?:string}} options
 * @returns {string} 仓库根目录
 */
export const makeRepo = ({ root, files = { a: 'a\n' }, commitAt = null, branch = 'main',
  remote = '', commitMessage = 'init' }) => {
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init', '-q', '-b', branch]);
  git(root, ['config', 'user.email', 'observer@test.local']);
  git(root, ['config', 'user.name', 'Observer Test']);
  writeFiles(root, files);
  git(root, ['add', '-A']);
  const env = commitAt ? { GIT_AUTHOR_DATE: commitAt, GIT_COMMITTER_DATE: commitAt } : {};
  git(root, ['commit', '-q', '-m', commitMessage], env);
  if (remote) git(root, ['remote', 'add', 'origin', remote]);
  return root;
};

/** 递归记录路径集合与文件内容摘要；用于证明探针没有改动被观察仓库。 */
export const treeDigest = (root) => {
  const entries = [];
  const walk = (dir, prefix) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const target = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = fs.lstatSync(target);
      if (stat.isDirectory()) {
        entries.push(`${rel}/`);
        walk(target, rel);
      } else if (stat.isSymbolicLink()) {
        entries.push(`${rel}@${fs.readlinkSync(target)}`);
      } else {
        entries.push(`${rel}:${createHash('sha256').update(fs.readFileSync(target)).digest('hex')}`);
      }
    }
  };
  walk(root, '');
  return createHash('sha256').update(entries.join('\n')).digest('hex');
};

/** 只读的 git status 输出，用于前后对比。 */
export const statusText = (root) => git(root, ['status', '--porcelain=v1']);
