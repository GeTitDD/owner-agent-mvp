// GitHub 只读查询与 Draft PR 创建（受控）。
//
// 只通过本机 gh CLI 操作；创建 PR 必须显式 confirm:true，且只从当前分支推送到
// origin，不合并、不改 base。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const parseRemote = (url) => {
  const value = String(url ?? '').trim();
  const https = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(value);
  if (https) return { owner: https[1], repo: https[2] };
  const ssh = /^git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(value);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  return null;
};

const trim = (value, max = 200) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);

export function createGithub({ exec = execFileAsync } = {}) {
  const run = async (args, cwd, timeout = 25000) => {
    try {
      const { stdout } = await exec('gh', args, {
        cwd,
        timeout,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024
      });
      return String(stdout ?? '');
    } catch (error) {
      const detail = String(error?.stderr || error?.message || error).trim().split(/\r?\n/u).filter(Boolean).slice(-2).join(' ');
      throw new Error(detail.slice(0, 300) || 'gh 命令失败');
    }
  };

  const detectRepo = async (root) => {
    // 在非 git 目录里 `git config --get` 会回落全局配置；而且临时目录可能位于
    // 更大的仓库里，所以要求 show-toplevel 正好等于项目根。
    const { stdout: topOut } = await exec('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
      timeout: 5000, windowsHide: true
    });
    if (path.resolve(topOut.trim()) !== path.resolve(root)) {
      throw new Error('这个目录不是独立的 git 仓库根目录');
    }
    const { stdout } = await exec('git', ['-C', root, 'config', '--local', '--get', 'remote.origin.url'], {
      timeout: 5000, windowsHide: true
    });
    const parsed = parseRemote(stdout);
    if (!parsed) throw new Error('这个项目没有可识别的 GitHub origin');
    return parsed;
  };

  const repoSlug = async (root) => {
    const repo = await detectRepo(root);
    return `${repo.owner}/${repo.repo}`;
  };

  const listIssues = async (root, { state = 'open', limit = 10 } = {}) => {
    const repo = await repoSlug(root);
    const raw = await run([
      'issue', 'list', '--repo', repo, '--state', state,
      '--limit', String(Math.min(20, Math.max(1, limit))),
      '--json', 'number,title,state,author,updatedAt,url'
    ], root);
    return JSON.parse(raw || '[]').map((item) => ({
      number: item.number,
      title: trim(item.title),
      state: item.state,
      author: item.author?.login ?? '',
      updatedAt: item.updatedAt ?? '',
      url: item.url ?? ''
    }));
  };

  const listPrs = async (root, { state = 'open', limit = 10 } = {}) => {
    const repo = await repoSlug(root);
    const raw = await run([
      'pr', 'list', '--repo', repo, '--state', state,
      '--limit', String(Math.min(20, Math.max(1, limit))),
      '--json', 'number,title,state,isDraft,author,updatedAt,url'
    ], root);
    return JSON.parse(raw || '[]').map((item) => ({
      number: item.number,
      title: trim(item.title),
      state: item.state,
      draft: item.isDraft === true,
      author: item.author?.login ?? '',
      updatedAt: item.updatedAt ?? '',
      url: item.url ?? ''
    }));
  };

  const preview = async (root) => {
    const repo = await repoSlug(root);
    const [{ stdout: branchOut }, { stdout: statusOut }, { stdout: statOut }] = await Promise.all([
      exec('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000, windowsHide: true }),
      exec('git', ['-C', root, 'status', '--porcelain'], { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 }),
      exec('git', ['-C', root, 'diff', '--stat', 'origin/HEAD...HEAD'], { timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024 })
        .catch(() => exec('git', ['-C', root, 'diff', '--stat', 'HEAD~1..HEAD'], { timeout: 10000, windowsHide: true }))
    ]);
    return {
      repo,
      branch: branchOut.trim(),
      clean: statusOut.trim() === '',
      changes: statusOut.trim().split(/\r?\n/u).filter(Boolean).slice(0, 30),
      stat: statOut.trim().slice(0, 4000)
    };
  };

  const createDraftPr = async (root, { base = 'main', title = '', body = '', confirm = false } = {}) => {
    if (confirm !== true) throw new Error('创建 PR 需要显式确认');
    const repo = await repoSlug(root);
    const info = await preview(root);
    if (!info.clean) throw new Error('工作区有未提交改动，先提交再创建 PR');
    if (info.branch === base) throw new Error(`当前分支就是 ${base}，请先切换分支`);
    const { stdout: countOut } = await exec('git', ['-C', root, 'rev-list', '--count', `${base}..HEAD`], {
      timeout: 10000, windowsHide: true
    });
    if (Number(countOut.trim()) === 0) throw new Error(`当前分支相对 ${base} 没有新提交`);
    await exec('git', ['-C', root, 'push', '-u', 'origin', 'HEAD'], {
      timeout: 60000, windowsHide: true, maxBuffer: 1024 * 1024
    });
    const prTitle = trim(title, 120) || `Draft: ${info.branch}`;
    const raw = await run([
      'pr', 'create', '--repo', repo, '--draft',
      '--base', base, '--head', info.branch,
      '--title', prTitle, '--body', String(body ?? '').slice(0, 4000)
    ], root, 60000);
    return { ok: true, repo, branch: info.branch, url: raw.trim() };
  };

  return { detectRepo, repoSlug, listIssues, listPrs, preview, createDraftPr };
}
