import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Git 夹具一律关闭可选锁，避免测试准备阶段自己改写 .git/index 污染“只读”断言。
//
// 为什么要一次短重试：四路并行跑全量时，临时仓库的 git 启动偶发失败，
// 实测报错是 `error launching git` 与 `fatal: Out of memory, malloc failed`
// （t87-npm-test-3.log 的 makeRepo / makeBehindRepo 栈），不是断言失败，也不是仓库状态坏了。
// 只对这两类机器抖动重试一次、间隔 100ms；命令本身失败（例如坏 ref）照旧立刻抛出，不掩盖错误。
const TRANSIENT_GIT = /error launching git|Out of memory|malloc failed/iu;
const retryPause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
export const git = (cwd, args, env = {}) => {
  const run = () => execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env }
  }).trim();
  try {
    return run();
  } catch (error) {
    if (!TRANSIENT_GIT.test(String(error?.message ?? error))) throw error;
    retryPause();
    return run();
  }
};

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

/**
 * 建立一个当前分支落后主干指定提交数的仓库。
 * 先切出 feature，再在 main 上追加空提交，最后切回 feature —— 全程本地操作，不需要 remote。
 * @param {{root:string, behind?:number, branch?:string, trunk?:string, commitAt?:string}} options
 * @returns {string} 仓库根目录
 */
export const makeBehindRepo = ({ root, behind = 12, branch = 'feature', trunk = 'main',
  commitAt = null }) => {
  makeRepo({ root, commitAt });
  git(root, ['checkout', '-q', '-b', branch]);
  git(root, ['checkout', '-q', trunk]);
  for (let index = 0; index < behind; index += 1) {
    git(root, ['commit', '-q', '--allow-empty', '-m', `trunk ${index + 1}`]);
  }
  git(root, ['checkout', '-q', branch]);
  return root;
};

/** 在仓库里制造指定数量的未跟踪文件（不加入索引）。 */
export const addUntrackedFiles = (root, count, prefix = 'untracked') => {
  const files = {};
  for (let index = 0; index < count; index += 1) files[`${prefix}-${index + 1}.txt`] = `file ${index + 1}\n`;
  writeFiles(root, files);
  return count;
};
