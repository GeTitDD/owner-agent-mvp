// 只读 Git 探针。
//
// 约束：
//   - 只调用固定参数向量的 git 子命令，绝不使用 shell；
//   - 一律带 `--no-optional-locks` 与 `GIT_OPTIONAL_LOCKS=0`，避免 git status 回写 .git/index；
//   - 不执行任何写命令（不 fetch / checkout / add / commit），被观察仓库在探针前后保持一致。
import { execFileSync } from 'node:child_process';

const GIT_TIMEOUT_MS = 15_000;

/** 探针无法读取仓库时抛出；调用方据此把该项目标记为不可观察，而不是崩溃。 */
export class ObserverProbeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ObserverProbeError';
  }
}

const gitEnv = () => ({
  ...process.env,
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0'
});

// 固定参数向量 + 只读全局选项；返回 stdout（保留原始换行，由调用方 trim）。
const runGit = (gitBin, root, args) => execFileSync(gitBin, ['--no-optional-locks', '-C', root, ...args], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: GIT_TIMEOUT_MS,
  windowsHide: true,
  env: gitEnv()
});

// 允许失败的只读查询：detached HEAD、无提交历史等都会让 git 返回非零退出码，
// 这些是正常仓库状态，不是探针错误。
const tryGit = (gitBin, root, args) => {
  try {
    return runGit(gitBin, root, args);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new ObserverProbeError(`git executable not found: ${gitBin}`);
    if (error?.killed || error?.signal === 'SIGTERM') throw new ObserverProbeError('git command timed out');
    return null;
  }
};

// 主干候选：优先远端跟踪分支（最后一次 fetch 的结果），其次本地同名分支。
// 只读取本地已有引用，不 fetch —— 探针保持只读、不联网。
const TRUNK_NAMES = ['main', 'master'];

const firstExistingRef = (gitBin, root, candidates) => {
  for (const ref of candidates) {
    // 用 rev-parse --verify 确认引用可解析为提交；失败按“没有该主干”处理。
    if (tryGit(gitBin, root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) return ref;
  }
  return null;
};

/**
 * 选出用于漂移比较的主干引用。
 * 远端 HEAD 指向的分支最可信；否则按 origin/main、origin/master、本地 main/master 依次尝试。
 * 当前分支本身不作为主干，避免“自己落后自己”。
 */
const resolveTrunkRef = (gitBin, root, branch) => {
  const originHead = tryGit(gitBin, root, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])?.trim() || '';
  const candidates = [];
  if (originHead) candidates.push(originHead);
  for (const name of TRUNK_NAMES) candidates.push(`origin/${name}`);
  for (const name of TRUNK_NAMES) if (name !== branch) candidates.push(name);
  return firstExistingRef(gitBin, root, [...new Set(candidates)]);
};

// 只统计落后/领先的提交数；两个引用无共同祖先时 rev-list 仍能给出计数，不会抛错。
const countCommits = (gitBin, root, range) => {
  const output = tryGit(gitBin, root, ['rev-list', '--count', range]);
  const count = Number.parseInt(String(output ?? '').trim(), 10);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
};

/**
 * 采集单个项目的只读快照。
 * @param {{projectId:string, projectName?:string, root:string, gitBin?:string}} options
 * @returns {{projectId:string, projectName:string, root:string, branch:string|null,
 *   detached:boolean, head:string|null, hasCommits:boolean, lastCommitAt:string|null,
 *   uncommittedFiles:number, hasRemote:boolean, trunkRef:string|null,
 *   behindTrunk:number, aheadTrunk:number}}
 */
export function probeProject({ projectId, projectName = '', root, gitBin = 'git' } = {}) {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new ObserverProbeError('Invalid project id');
  if (typeof root !== 'string' || !root.trim()) throw new ObserverProbeError('Invalid project root');

  const inside = tryGit(gitBin, root, ['rev-parse', '--is-inside-work-tree']);
  if (inside?.trim() !== 'true') throw new ObserverProbeError(`Not a git work tree: ${root}`);

  const head = tryGit(gitBin, root, ['rev-parse', '--verify', 'HEAD'])?.trim() || null;
  // symbolic-ref 在 unborn 分支上仍返回分支名，detached 时失败 —— 正好区分两种状态。
  const branch = tryGit(gitBin, root, ['symbolic-ref', '-q', '--short', 'HEAD'])?.trim() || null;
  const lastCommitAt = head ? tryGit(gitBin, root, ['log', '-1', '--format=%cI', 'HEAD'])?.trim() || null : null;
  const status = tryGit(gitBin, root, ['status', '--porcelain=v1', '--untracked-files=all']) ?? '';
  const uncommittedFiles = status.split(/\r?\n/).filter(Boolean).length;
  const remotes = tryGit(gitBin, root, ['remote']) ?? '';
  const trunkRef = head ? resolveTrunkRef(gitBin, root, branch) : null;
  const behindTrunk = trunkRef ? countCommits(gitBin, root, `HEAD..${trunkRef}`) : 0;
  const aheadTrunk = trunkRef ? countCommits(gitBin, root, `${trunkRef}..HEAD`) : 0;

  return {
    projectId: projectId.trim(),
    projectName: String(projectName),
    root,
    branch,
    detached: !branch,
    head,
    hasCommits: Boolean(head),
    lastCommitAt,
    uncommittedFiles,
    hasRemote: remotes.split(/\r?\n/).some(Boolean),
    trunkRef,
    behindTrunk,
    aheadTrunk
  };
}
