// #120 GitHub 采集器：只请求被勾选的关注面；缺凭证明确「未配置」而不是空结果；
// HTTP / 网络失败都带回原因，不吞。假 fetch 注入，断言调用参数本身就是断言「只请求勾选项」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectGithub, GITHUB_API_BASE, GITHUB_PER_PAGE } from '../src/watch/collect-github.mjs';
import { WatchTargetError } from '../src/watch/target.mjs';

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
});

/** 假 fetch：按顺序吐出预设响应；String(url) 记下来供断言。 */
const recordingFetch = (responses) => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error('fake fetch 收到了多余的请求');
    return next;
  };
  return { fetch, calls };
};

const commitBody = (sha, date, message) => ({
  sha,
  commit: { message, author: { name: 'Owner', date } }
});

const prBody = (number, updatedAt, extra = {}) => ({
  number,
  title: `PR ${number}`,
  state: 'open',
  updated_at: updatedAt,
  html_url: `https://github.com/Owner/Repo/pull/${number}`,
  draft: false,
  ...extra
});

const issueBody = (number, updatedAt) => ({
  number,
  title: `Issue ${number}`,
  state: 'open',
  updated_at: updatedAt,
  html_url: `https://github.com/Owner/Repo/issues/${number}`
});

test('只请求勾选的关注面：focus=[issues] 时一次请求，且不碰 commits / pulls 端点', async () => {
  const { fetch, calls } = recordingFetch([jsonResponse([issueBody(7, '2026-11-02T00:00:00Z')])]);
  const target = { type: 'github', owner: 'Owner', repo: 'Repo', focus: ['issues'] };

  const result = await collectGithub(target, {
    now: new Date('2026-11-03T00:00:00.000Z'),
    deps: { token: 'token-1', fetch }
  });

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, `${GITHUB_API_BASE}/repos/Owner/Repo/issues`);
  assert.equal(url.searchParams.get('per_page'), String(GITHUB_PER_PAGE));
  assert.equal(calls[0].options.headers.authorization, 'Bearer token-1');
  assert.equal(result.status, 'ok');
  assert.equal(result.ref, 'github:owner/repo');
  assert.deepEqual(result.items, [{
    kind: 'issue',
    number: 7,
    title: 'Issue 7',
    state: 'open',
    at: '2026-11-02T00:00:00.000Z',
    url: 'https://github.com/Owner/Repo/issues/7'
  }]);
});

test('两个勾选项按固定顺序各请求一次；未勾选的端点一次都不请求', async () => {
  const { fetch, calls } = recordingFetch([
    jsonResponse([commitBody('sha1', '2026-11-02T00:00:00Z', '标题\n\n正文')]),
    jsonResponse([prBody(3, '2026-11-02T01:00:00Z')])
  ]);
  const target = { type: 'github', owner: 'Owner', repo: 'Repo', focus: ['pullRequests', 'commits'] };

  const result = await collectGithub(target, {
    now: new Date('2026-11-03T00:00:00.000Z'),
    deps: { token: 'token-1', fetch }
  });

  assert.equal(calls.length, 2);
  // target.mjs 已把 focus 归一成 commits → pullRequests 固定顺序。
  assert.match(calls[0].url, /\/repos\/Owner\/Repo\/commits\?/u);
  assert.match(calls[1].url, /\/repos\/Owner\/Repo\/pulls\?/u);
  assert.ok(calls.every((call) => !call.url.includes('/issues')), '没勾 issues 就不该请求');
  assert.deepEqual(result.items.map((item) => item.kind), ['commit', 'pullRequest']);
  assert.deepEqual(result.items[0], {
    kind: 'commit', sha: 'sha1', at: '2026-11-02T00:00:00.000Z', subject: '标题'
  });
  assert.deepEqual(result.items[1], {
    kind: 'pullRequest',
    number: 3,
    title: 'PR 3',
    state: 'open',
    at: '2026-11-02T01:00:00.000Z',
    url: 'https://github.com/Owner/Repo/pull/3',
    draft: false
  });
});

test('水位之后的条目才留下：commits 用 since 参数，PR / issue 按 updated_at 客户端过滤', async () => {
  const { fetch, calls } = recordingFetch([
    jsonResponse([commitBody('old', '2026-10-01T00:00:00Z', '旧'), commitBody('new', '2026-11-02T00:00:00Z', '新')]),
    jsonResponse([prBody(1, '2026-10-01T00:00:00Z'), prBody(2, '2026-11-02T00:00:00Z')])
  ]);
  const target = { type: 'github', owner: 'Owner', repo: 'Repo', focus: ['commits', 'pullRequests'] };

  const result = await collectGithub(target, {
    since: '2026-11-01T00:00:00.000Z',
    now: new Date('2026-11-03T00:00:00.000Z'),
    deps: { token: 'token-1', fetch }
  });

  const commitsUrl = new URL(calls[0].url);
  assert.equal(commitsUrl.searchParams.get('since'), '2026-11-01T00:00:00.000Z');
  assert.deepEqual(result.items.map((item) => item.kind === 'commit' ? item.sha : item.number), ['new', 2]);
});

test('issues 端点会把 PR 一起返回：只勾 issues 时把 PR 条目剔掉', async () => {
  const { fetch } = recordingFetch([
    jsonResponse([
      issueBody(7, '2026-11-02T00:00:00Z'),
      { ...prBody(8, '2026-11-02T00:00:00Z'), pull_request: { url: 'https://api.github.com/repos/Owner/Repo/pulls/8' } }
    ])
  ]);
  const target = { type: 'github', owner: 'Owner', repo: 'Repo', focus: ['issues'] };

  const result = await collectGithub(target, { deps: { token: 'token-1', fetch } });

  assert.deepEqual(result.items.map((item) => item.number), [7]);
  assert.ok(result.items.every((item) => item.kind === 'issue'));
});

test('缺凭证：明确「未配置」，不发请求，也不是空结果', async () => {
  const { fetch, calls } = recordingFetch([]);
  const target = { type: 'github', owner: 'Owner', repo: 'Repo', focus: ['commits'] };

  const result = await collectGithub(target, { deps: { token: '', env: {}, fetch } });

  assert.equal(calls.length, 0, '没有凭证就不该发请求');
  assert.equal(result.status, 'unconfigured');
  assert.equal(result.error.code, 'github-unconfigured');
  assert.match(result.error.message, /GITHUB_TOKEN/u);
  assert.match(result.error.message, /Owner\/Repo/u);
  assert.deepEqual(result.items, []);
  assert.equal(result.cursor, null);
});

test('凭证从环境变量取（GITHUB_TOKEN / GH_TOKEN），显式注入优先', async () => {
  const first = recordingFetch([jsonResponse([])]);
  const envResult = await collectGithub(
    { type: 'github', owner: 'o', repo: 'r', focus: ['commits'] },
    { deps: { env: { GH_TOKEN: 'env-token' }, fetch: first.fetch } }
  );
  assert.equal(envResult.status, 'ok');
  assert.equal(first.calls[0].options.headers.authorization, 'Bearer env-token');

  const second = recordingFetch([jsonResponse([])]);
  await collectGithub(
    { type: 'github', owner: 'o', repo: 'r', focus: ['commits'] },
    { deps: { token: 'explicit', env: { GH_TOKEN: 'env-token' }, fetch: second.fetch } }
  );
  assert.equal(second.calls[0].options.headers.authorization, 'Bearer explicit');
});

test('HTTP 失败：带回状态码与关注面，且不回显 token', async () => {
  const { fetch } = recordingFetch([jsonResponse({ message: 'boom' }, 500)]);
  const target = { type: 'github', owner: 'Owner', repo: 'Repo', focus: ['commits'] };

  const result = await collectGithub(target, { deps: { token: 'secret-token', fetch } });

  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'github-http');
  assert.equal(result.error.focus, 'commits');
  assert.match(result.error.message, /500/u);
  assert.match(result.error.message, /commits/u);
  assert.ok(!result.error.message.includes('secret-token'), '错误信息不能泄露凭证');
  assert.deepEqual(result.items, []);
});

test('网络失败：原因写清楚，不吞', async () => {
  const { fetch } = recordingFetch([Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND' })]);
  const target = { type: 'github', owner: 'Owner', repo: 'Repo', focus: ['pullRequests'] };

  const result = await collectGithub(target, { deps: { token: 'token-1', fetch } });

  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'github-request-failed');
  assert.match(result.error.message, /ENOTFOUND/u);
  assert.match(result.error.message, /pullRequests/u);
});

test('响应形状不对：明确报「读不懂」，不当作 0 条', async () => {
  const { fetch } = recordingFetch([jsonResponse({ message: 'not a list' })]);
  const target = { type: 'github', owner: 'Owner', repo: 'Repo', focus: ['issues'] };

  const result = await collectGithub(target, { deps: { token: 'token-1', fetch } });

  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'github-bad-response');
  assert.match(result.error.message, /issues/u);
});

test('采集器只接受 GitHub 对象：传错类型明确拒绝', async () => {
  await assert.rejects(
    () => collectGithub({ type: 'project', projectId: 'alpha' }, {}),
    (error) => {
      assert.ok(error instanceof WatchTargetError);
      assert.equal(error.code, 'target-type-mismatch');
      assert.match(error.message, /github/u);
      return true;
    }
  );
});
