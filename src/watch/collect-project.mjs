// 项目采集器（#120）：git 提交清单 + 工作区「有没有未提交改动」。
//
// 只读边界（沿用 observer/probe.mjs 的规矩，不另开一扇门）：
// - 只跑 rev-parse / log / status 这类查询，固定参数向量、不走 shell；
// - 一律带 `--no-optional-locks` 与 `GIT_OPTIONAL_LOCKS=0`：`git status` 不回写 .git/index，
//   被观察仓库在采集前后保持一字不差；
// - 没有 fetch / add / commit / checkout，也不联网。
//
// 「工作区脏不脏」只看 `git status --porcelain` 有没有输出：不读文件内容，也不把路径
// 带回结果（父 spec 的「只看有无」）。带路径就等于把被改文件清单搬进状态库，那不该由
// 采集器决定。
//
// 读不到仓库时返回 error，不返回空清单：空清单会被界面显示成「没有变化」，
// 与事实（没读到）相反。
//
// 依赖注入：git 执行器从 deps.git 取，签名 `{ root, args } => stdout`（非零退出即抛出）。
// 只读与参数向量的断言在测试里靠注入假实现完成；真实执行器只在缺省时构造。
import { execFileSync } from 'node:child_process';
import { normalizeWatchTarget, WatchTargetError } from './target.mjs';
import { failedResult, isAfter, isoOf, okResult, toMillis } from './collect-result.mjs';

const GIT_TIMEOUT_MS = 15_000;

/** 一次最多读这么多条提交：面板只列最近几条，读太多只是让主进程白等。 */
export const PROJECT_COMMIT_LIMIT = 50;

/** 字段分隔用 ASCII 单元分隔符：出现在提交标题里的概率远低于制表符或竖线。 */
const FIELD = '\x1f';

const gitEnv = () => ({
  ...process.env,
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0'
});

/**
 * 缺省 git 执行器：固定参数向量 + 只读全局选项，不走 shell。
 * 返回 stdout 原文；非零退出、超时、git 不存在都直接抛出，由采集器转成原因。
 *
 * @param {{root:string, args:string[]}} input
 * @returns {string}
 */
export const defaultGitRunner = ({ root, args }) => execFileSync(
  'git',
  ['--no-optional-locks', '-C', root, ...args],
  {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    env: gitEnv()
  }
);

/** 错误压成一行：git 的 stderr 可能好几行，界面只需要一句原因。 */
const describe = (error) => String(error?.message ?? error ?? '').trim().split(/\r?\n/u)[0].trim();

/** git 不存在（ENOENT）与其它失败分开报：前者是环境没装/没进 PATH，后者是仓库问题。 */
const codeOf = (error) => (error?.code === 'ENOENT' ? 'git-unavailable' : 'git-failed');

/** 提交清单按行解析；空行跳过。 */
const commitsOf = (output, sinceMs) => String(output ?? '')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => {
    const [sha = '', author = '', at = '', subject = ''] = line.split(FIELD);
    return { sha, author, at, subject };
  })
  .filter((row) => row.sha && isAfter(row.at, sinceMs))
  .map((row) => ({
    kind: 'commit',
    sha: row.sha,
    author: row.author,
    at: isoOf(toMillis(row.at)),
    subject: row.subject
  }));

/**
 * 采一个项目对象。
 *
 * @param {object} target 监控对象描述符（type 必须是 project）
 * @param {{since?:string|number|Date|null, now?:Date|number|string,
 *   deps?:{git?:({root:string,args:string[]})=>string}} [options]
 * @returns {Promise<object>} 统一结果形状（见 collect-result.mjs）
 */
export async function collectProject(target, { since = null, now = new Date(), deps = {} } = {}) {
  const { type, ref, projectId, root } = normalizeWatchTarget(target);
  if (type !== 'project') {
    throw new WatchTargetError(`项目采集器只接受 project 对象，收到 ${type}`, 'target-type-mismatch');
  }
  // 没有项目根就不猜目录：猜出来的仓库不是这个项目的仓库。
  if (!root) {
    return failedResult({
      type, ref,
      code: 'project-root-missing',
      message: `项目 ${projectId} 没有登记项目根，无法读取 git`
    });
  }

  const git = deps.git ?? defaultGitRunner;
  const attempt = async (args) => {
    try {
      return { out: await git({ root, args }), error: null };
    } catch (error) {
      return { out: '', error };
    }
  };

  const inside = await attempt(['rev-parse', '--is-inside-work-tree']);
  if (inside.error) {
    return failedResult({
      type, ref,
      code: codeOf(inside.error),
      message: `读不到项目 ${projectId} 的 git：${describe(inside.error)}`
    });
  }
  if (String(inside.out ?? '').trim() !== 'true') {
    return failedResult({
      type, ref,
      code: 'not-a-work-tree',
      message: `项目根不是 git 工作区：${root}`
    });
  }

  // 空仓库上 rev-parse --verify HEAD 非零退出：这是正常状态，不是探针错误。
  const head = await attempt(['rev-parse', '--verify', 'HEAD']);

  const items = [];
  if (!head.error && String(head.out ?? '').trim()) {
    const sinceMs = toMillis(since);
    const log = await attempt(['log', `--max-count=${PROJECT_COMMIT_LIMIT}`, `--format=%H${FIELD}%an${FIELD}%aI${FIELD}%s`]);
    if (log.error) {
      return failedResult({
        type, ref,
        code: codeOf(log.error),
        message: `读不到项目 ${projectId} 的提交清单：${describe(log.error)}`
      });
    }
    items.push(...commitsOf(log.out, sinceMs));
  }

  const status = await attempt(['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.error) {
    return failedResult({
      type, ref,
      code: codeOf(status.error),
      message: `读不到项目 ${projectId} 的工作区状态：${describe(status.error)}`
    });
  }
  // 只看有无：porcelain 有一行就是脏，行里的路径与状态码都不带出去。
  const dirty = String(status.out ?? '').split(/\r?\n/u).some((line) => line.trim() !== '');
  items.push({ kind: 'workingTree', dirty });

  return okResult({ type, ref, items, now });
}
