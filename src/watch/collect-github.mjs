// GitHub 采集器（#120）：只请求被勾选的关注面（commits / pullRequests / issues）。
//
// 三条硬规矩：
// 1. 只请求勾选项。请求哪几个端点完全由 target.focus 决定（target.mjs 已去重并排成固定
//    顺序），没勾的面一次都不请求——「顺手多拉一面」就是越权观察。
// 2. 缺凭证说「未配置」。没有 GITHUB_TOKEN / GH_TOKEN 时返回 status='unconfigured' 与原因，
//    而不是空 items：空 items 会被显示成「没有新东西」，与事实无关。
// 3. 失败不吞。HTTP 非 2xx、网络错误、响应不是列表都带回原因码与关注面；truthy 的空数组
//    只表示「这一面确实没有」。
//
// 只读：只有一个 GET 请求（fetch 方法缺省就是 GET），不写任何仓库，也不改任何文件。
// 不打印 / 不回显 token：错误信息里只有状态码、关注面与原因。
//
// issues 端点的坑：GitHub 的 `/issues` 会把 PR 一起返回（带 pull_request 字段）。没勾
// pullRequests 时必须把这些条目剔掉，否则「只请求勾选项」名不副实。
//
// 依赖注入：deps.fetch / deps.token / deps.env / deps.apiBase。测试用假 fetch 记录调用，
// 断言请求面与参数本身就是断言行为。
import { GITHUB_FOCUS, normalizeWatchTarget, WatchTargetError } from './target.mjs';
import {
  failedResult, isAfter, isoOf, okResult, toMillis, unconfiguredResult
} from './collect-result.mjs';

/** 公开 API 根：可被 deps.apiBase 改指（测试或企业版），但缺省只有一个。 */
export const GITHUB_API_BASE = 'https://api.github.com';

/** 每面一次最多取这么多条：心跳只要「有没有新的」，不翻页。 */
export const GITHUB_PER_PAGE = 30;

const TIMEOUT_MS = 15_000;

/** 关注面 → 路径。所有路径都由 owner/repo 拼成，不接外部传入的完整 URL。 */
const PATH_OF = Object.freeze({
  commits: (owner, repo) => `/repos/${owner}/${repo}/commits`,
  pullRequests: (owner, repo) => `/repos/${owner}/${repo}/pulls`,
  issues: (owner, repo) => `/repos/${owner}/${repo}/issues`
});

/** 关注面 → 查询参数。commits 支持服务端 since；PR / issue 只能按 updated_at 客户端过滤。 */
const QUERY_OF = Object.freeze({
  commits: (since) => [
    ['per_page', String(GITHUB_PER_PAGE)],
    ...(since ? [['since', since]] : [])
  ],
  pullRequests: () => [
    ['state', 'all'],
    ['sort', 'updated'],
    ['direction', 'desc'],
    ['per_page', String(GITHUB_PER_PAGE)]
  ],
  issues: () => [
    ['state', 'all'],
    ['sort', 'updated'],
    ['direction', 'desc'],
    ['per_page', String(GITHUB_PER_PAGE)]
  ]
});

const describe = (error) => String(error?.message ?? error ?? '').trim().split(/\r?\n/u)[0].trim();

/** 提交标题只取第一行：正文很长的提交不该把状态撑大。 */
const firstLine = (value) => String(value ?? '').split(/\r?\n/u)[0].trim();

/** 凭证：显式注入优先（空串也算显式「没有」），否则看环境变量。 */
const tokenOf = (deps) => {
  if (deps.token !== undefined && deps.token !== null) return String(deps.token).trim();
  const env = deps.env ?? process.env;
  return String(env.GITHUB_TOKEN ?? env.GH_TOKEN ?? '').trim();
};

const headersOf = (token) => ({
  accept: 'application/vnd.github+json',
  authorization: `Bearer ${token}`,
  'x-github-api-version': '2022-11-28',
  'user-agent': 'owner-agent-watch'
});

const urlOf = (base, path, pairs) => {
  const url = new URL(`${base}${path}`);
  for (const [key, value] of pairs) url.searchParams.set(key, value);
  return url.toString();
};

/** 把一面的响应条目归一成 items；时间读不出来的条目按「新」保留（isAfter 的规矩）。 */
const itemsOf = (focus, rows, sinceMs) => {
  const items = [];
  for (const row of rows) {
    if (focus === 'commits') {
      const at = isoOf(toMillis(row?.commit?.author?.date ?? row?.commit?.committer?.date));
      if (!isAfter(at, sinceMs)) continue;
      items.push({
        kind: 'commit',
        sha: String(row?.sha ?? ''),
        at: at ?? '',
        subject: firstLine(row?.commit?.message)
      });
      continue;
    }

    // issues 端点里的 PR 条目不是 issue：不管有没有勾 pullRequests，都不从这里算成 issue，
    // 否则勾了 issues 就"顺手"带回了 PR，勾了两个面又会重复两条。
    if (focus === 'issues' && row?.pull_request) continue;

    const at = isoOf(toMillis(row?.updated_at ?? row?.updatedAt));
    if (!isAfter(at, sinceMs)) continue;
    const number = Number(row?.number ?? 0);
    if (focus === 'pullRequests') {
      items.push({
        kind: 'pullRequest',
        number: Number.isFinite(number) ? number : 0,
        title: String(row?.title ?? ''),
        state: String(row?.state ?? ''),
        at: at ?? '',
        url: String(row?.html_url ?? ''),
        draft: row?.draft === true
      });
      continue;
    }
    items.push({
      kind: 'issue',
      number: Number.isFinite(number) ? number : 0,
      title: String(row?.title ?? ''),
      state: String(row?.state ?? ''),
      at: at ?? '',
      url: String(row?.html_url ?? '')
    });
  }
  return items;
};

/**
 * 采一个 GitHub 对象。
 *
 * @param {object} target 监控对象描述符（type 必须是 github，focus 已归一）
 * @param {{since?:string|number|Date|null, now?:Date|number|string,
 *   deps?:{token?:string, env?:object, fetch?:Function, apiBase?:string}} [options]
 * @returns {Promise<object>} 统一结果形状（见 collect-result.mjs）
 */
export async function collectGithub(target, { since = null, now = new Date(), deps = {} } = {}) {
  const { type, ref, owner, repo, nameWithOwner, focus } = normalizeWatchTarget(target);
  if (type !== 'github') {
    throw new WatchTargetError(`GitHub 采集器只接受 github 对象，收到 ${type}`, 'target-type-mismatch');
  }

  const token = tokenOf(deps);
  if (!token) {
    return unconfiguredResult({
      type, ref,
      code: 'github-unconfigured',
      message: `GitHub 未配置：缺少 GITHUB_TOKEN（或 GH_TOKEN），读不了 ${nameWithOwner}`
    });
  }

  const fetchImpl = deps.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return failedResult({
      type, ref,
      code: 'github-fetch-missing',
      message: `当前环境没有可用的 fetch，读不了 ${nameWithOwner}`
    });
  }
  const base = String(deps.apiBase ?? GITHUB_API_BASE).replace(/\/+$/u, '');
  const sinceMs = toMillis(since);
  const sinceIso = isoOf(sinceMs);
  const headers = headersOf(token);
  const items = [];

  // 按 focus 的固定顺序逐个请求：顺序稳定，失败时说得清是哪一面。
  for (const key of focus) {
    if (!GITHUB_FOCUS.includes(key)) {
      // target.mjs 已挡住未知项；这里只防改坏词表后悄悄少请求一面。
      throw new WatchTargetError(`未知的 GitHub 关注面：${key}`, 'target-focus-unknown');
    }
    const url = urlOf(base, PATH_OF[key](owner, repo), QUERY_OF[key](key === 'commits' ? sinceIso : null));

    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (error) {
      return failedResult({
        type, ref,
        code: 'github-request-failed',
        message: `GitHub 请求失败（${key}）：${describe(error)}`,
        focus: key
      });
    }

    if (!response?.ok) {
      return failedResult({
        type, ref,
        code: 'github-http',
        message: `GitHub 返回 HTTP ${response?.status ?? '未知'}（${key}），${nameWithOwner} 这一面没读到`,
        focus: key
      });
    }

    let body;
    try {
      body = await response.json();
    } catch (error) {
      return failedResult({
        type, ref,
        code: 'github-bad-response',
        message: `GitHub 的 ${key} 响应不是合法 JSON：${describe(error)}`,
        focus: key
      });
    }
    if (!Array.isArray(body)) {
      return failedResult({
        type, ref,
        code: 'github-bad-response',
        message: `GitHub 的 ${key} 响应不是列表，读不懂`,
        focus: key
      });
    }

    items.push(...itemsOf(key, body, sinceMs));
  }

  return okResult({ type, ref, items, now });
}
