// GitHub 远端地址解析。
//
// 只接受 github.com 的仓库地址，支持：
//   - https://github.com/owner/repo(.git)
//   - git@github.com:owner/repo.git
//   - ssh://git@github.com/owner/repo.git
//   - github.com:owner/repo
// 返回统一格式，供面板显示仓库链接与 gh 状态。

/**
 * 解析 Git 远端地址。
 * @param {string} remote `git remote get-url origin` 的结果
 * @returns {{owner:string, repo:string, nameWithOwner:string, url:string}|null}
 */
export function parseGitHubRemote(remote) {
  const value = String(remote ?? '').trim();
  if (!value) return null;
  let host = '';
  let pathname = '';
  if (value.includes('://')) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    host = url.hostname;
    pathname = url.pathname;
  } else {
    // SCP 风格：git@github.com:owner/repo.git 或 github.com:owner/repo
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/u.exec(value);
    if (!scp) return null;
    host = scp[1];
    pathname = scp[2];
  }
  if (!/^(?:www\.)?github\.com$/iu.test(host)) return null;
  const parts = pathname
    .replace(/^\/+/u, '')
    .replace(/\.git$/iu, '')
    .split('/')
    .filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo] = parts;
  if (!/^[A-Za-z0-9_.-]+$/u.test(owner) || !/^[A-Za-z0-9_.-]+$/u.test(repo)) return null;
  return {
    owner,
    repo,
    nameWithOwner: `${owner}/${repo}`,
    url: `https://github.com/${owner}/${repo}`
  };
}
