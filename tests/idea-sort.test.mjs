// #96 灵感整理：链接守卫（纯函数，逐网段 / 逐协议）、抓取的四种失败、四段整理、
// 缓存与重试、状态推进，以及侧车的整理路由。
//
// 网络一律用注入的假 fetch：这里不访问外网，也不依赖 DNS。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OwnerStore } from '../src/owner-store.mjs';
import { ideaInboxView } from '../src/idea-inbox.mjs';
import { startSidecar } from '../src/sidecar-server.mjs';
import {
  FETCH_MAX_BYTES,
  guardIdeaLink,
  guardResolvedAddresses,
  sectionsFromText,
  tidyIdeaSections,
  fetchIdeaPage,
  sortIdeaEntry
} from '../src/idea-sort.mjs';

const TOKEN = 'idea-sort-token-0123456789';
const ORIGIN = {
  gatewayInstanceId: 'gw-idea-sort',
  sessionKey: 'agent:main:idea-sort',
  runId: 'run-idea-sort',
  operatorId: 'owner'
};

const FOUR_SECTIONS_HTML = `<!doctype html><html><head><title>把灵感整理成四段</title></head><body>
  <h1>把灵感整理成四段</h1>
  <h2>问题</h2><p>灵感存下来只有一句话，回头看不出为什么重要。</p>
  <h2>想法</h2><p>整理时抓一次公网正文，写成四段。</p>
  <h2>预期收益</h2><p>决定采纳时能直接对照。</p>
  <h2>风险</h2><p>抓不到正文会缺段，缺段要标出来。</p>
</body></html>`;

const tempDb = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-idea-sort-'));
  return { root, dbPath: path.join(root, 'owner.sqlite') };
};

const withStore = async (fn) => {
  const { root, dbPath } = tempDb();
  const store = new OwnerStore(dbPath);
  try {
    await fn({ store, root });
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const htmlPage = (html, { status = 200, headers = {} } = {}) => new Response(html, {
  status,
  headers: { 'content-type': 'text/html; charset=utf-8', ...headers }
});

const publicResolve = async () => [{ address: '93.184.216.34', family: 4 }];

/** 假 fetch：按地址给页面，同时数真正发出去几次（缓存证据靠它）。 */
const fakeFetch = (handler) => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push(String(url));
    return handler(String(url), init);
  };
  return { impl, calls };
};

const addLinkItem = (store, link = 'https://example.com/ideas/96') => store.addIdeaItem({
  title: link,
  rawText: link,
  captureSource: 'link',
  link
});

test('链接守卫：公网 http / https 放行', () => {
  const allowed = [
    'https://example.com/a?b=1#c',
    'http://example.com/',
    'https://news.ycombinator.com/item?id=1',
    'https://93.184.216.34/',
    'http://example.com:8080/path'
  ];
  for (const url of allowed) {
    const result = guardIdeaLink(url);
    assert.equal(result.ok, true, `${url} 应该放行`);
    assert.equal(result.reason, '');
    assert.ok(result.url && result.host);
  }
});

test('链接守卫：每个内网 / 本机网段各拒绝一条，并给出网段原因', () => {
  const cases = [
    ['http://127.0.0.1/', /127\.0\.0\.0\/8/u],
    ['http://127.255.255.254/', /127\.0\.0\.0\/8/u],
    ['http://10.0.0.1/', /10\.0\.0\.0\/8/u],
    ['http://172.16.0.1/', /172\.16\.0\.0\/12/u],
    ['http://172.31.255.254/', /172\.16\.0\.0\/12/u],
    ['http://192.168.1.1/', /192\.168\.0\.0\/16/u],
    ['http://169.254.169.254/latest/meta-data/', /169\.254\.0\.0\/16/u],
    ['http://0.0.0.0/', /0\.0\.0\.0\/8/u],
    ['http://100.64.0.1/', /100\.64\.0\.0\/10/u],
    ['http://224.0.0.1/', /224\.0\.0\.0\/4/u],
    ['http://[::1]/', /::1/u],
    ['http://[fd00::1]/', /fc00::\/7/u],
    ['http://[fe80::1]/', /fe80::\/10/u],
    ['http://localhost/', /localhost/u],
    ['http://localhost./', /localhost/u],
    ['http://api.localhost/', /localhost/u],
    ['http://intranet/', /不是公网域名/u],
    ['http://example.local/', /内网域名/u]
  ];
  for (const [url, pattern] of cases) {
    const result = guardIdeaLink(url);
    assert.equal(result.ok, false, `${url} 应该被拒`);
    assert.equal(result.code, 'private', `${url} 的拒绝码`);
    assert.match(result.reason, pattern, `${url} 的原因`);
  }
  // 172.32 已经在 172.16/12 之外，是公网段，不能误伤。
  assert.equal(guardIdeaLink('http://172.32.0.1/').ok, true);
});

test('链接守卫：IPv4 的其它写法同样按解析后的地址判断', () => {
  // 十进制与十六进制写法会被 URL 解析成 127.0.0.1，守卫看的是解析后的结果。
  for (const url of ['http://2130706433/', 'http://0x7f000001/', 'http://017700000001/']) {
    const result = guardIdeaLink(url);
    assert.equal(result.ok, false, url);
    assert.match(result.reason, /127\.0\.0\.0\/8/u, url);
  }
});

test('链接守卫：file:// javascript: ftp: 与带凭证的地址都被拒，各带原因', () => {
  const protocolCases = [
    ['file:///C:/Windows/win.ini', /file:/u],
    ['javascript:alert(1)', /javascript:/u],
    ['ftp://example.com/a.txt', /ftp:/u],
    ['data:text/html,hi', /data:/u]
  ];
  for (const [url, pattern] of protocolCases) {
    const result = guardIdeaLink(url);
    assert.equal(result.ok, false, url);
    assert.equal(result.code, 'protocol', url);
    assert.match(result.reason, pattern, url);
  }
  const credentials = guardIdeaLink('https://owner:secret@example.com/private');
  assert.equal(credentials.ok, false);
  assert.equal(credentials.code, 'credentials');
  assert.match(credentials.reason, /用户名或密码/u);
  assert.equal(guardIdeaLink('').code, 'empty');
});

test('解析结果复查：域名解析到内网地址同样拒绝', () => {
  assert.equal(guardResolvedAddresses([{ address: '93.184.216.34' }]).ok, true);
  for (const address of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '::1', 'fd00::5']) {
    const result = guardResolvedAddresses([{ address }]);
    assert.equal(result.ok, false, address);
    assert.equal(result.code, 'private');
  }
  // 一条公网、一条内网：整条拒绝，不给「碰巧先连公网」的机会。
  assert.equal(guardResolvedAddresses([{ address: '93.184.216.34' }, { address: '10.0.0.5' }]).ok, false);
  assert.equal(guardResolvedAddresses([]).code, 'dns');
});

test('抓取成功：正文转纯文本，带上标题、字节数与跳数', async () => {
  const { impl, calls } = fakeFetch(async () => htmlPage(FOUR_SECTIONS_HTML));
  const result = await fetchIdeaPage({
    url: 'https://example.com/ideas/96', fetchImpl: impl, resolveHost: publicResolve
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.status, 200);
  assert.equal(result.redirects, 0);
  assert.equal(result.title, '把灵感整理成四段');
  assert.match(result.text, /问题/u);
  assert.ok(result.bytes > 0);
  assert.equal(calls.length, 1);
  // 默认值就是验收说的「5 秒 / 1MB / 最多 3 跳」。
  assert.equal(FETCH_MAX_BYTES, 1024 * 1024);
});

test('抓取失败：非 2xx、非网页、超大、超时、重定向超限各有明确结果', async () => {
  const notOk = await fetchIdeaPage({
    url: 'https://example.com/gone',
    fetchImpl: async () => htmlPage('nope', { status: 404 }),
    resolveHost: publicResolve
  });
  assert.equal(notOk.ok, false);
  assert.equal(notOk.code, 'status');
  assert.match(notOk.reason, /404/u);

  const notHtml = await fetchIdeaPage({
    url: 'https://example.com/file.pdf',
    fetchImpl: async () => new Response('%PDF-1.7', { headers: { 'content-type': 'application/pdf' } }),
    resolveHost: publicResolve
  });
  assert.equal(notHtml.ok, false);
  assert.equal(notHtml.code, 'content-type');
  assert.match(notHtml.reason, /不是网页正文/u);

  const declaredHuge = await fetchIdeaPage({
    url: 'https://example.com/big',
    maxBytes: 1024,
    fetchImpl: async () => htmlPage('<html><body>hi</body></html>', {
      headers: { 'content-length': '2048' }
    }),
    resolveHost: publicResolve
  });
  assert.equal(declaredHuge.ok, false);
  assert.equal(declaredHuge.code, 'too-large');
  assert.match(declaredHuge.reason, /2048/u);

  // 边读边数：没有 content-length 也挡得住，读到一半就停。
  const streamedHuge = await fetchIdeaPage({
    url: 'https://example.com/stream',
    maxBytes: 16,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        for (let i = 0; i < 4; i += 1) controller.enqueue(new Uint8Array(8));
        controller.close();
      }
    }), { headers: { 'content-type': 'text/html' } }),
    resolveHost: publicResolve
  });
  assert.equal(streamedHuge.ok, false);
  assert.equal(streamedHuge.code, 'too-large');
  assert.match(streamedHuge.reason, /读到一半/u);

  const timedOut = await fetchIdeaPage({
    url: 'https://example.com/slow',
    timeoutMs: 30,
    fetchImpl: async (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
    resolveHost: publicResolve
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.code, 'timeout');
  assert.match(timedOut.reason, /30 毫秒/u);

  // 3 跳以内能到；第 4 跳判失败。
  const hopOf = (url) => Number(new URL(url).searchParams.get('hop') ?? 0);
  const chain = (limit) => async (url) => {
    const hop = hopOf(url);
    if (hop >= limit) return htmlPage(FOUR_SECTIONS_HTML);
    return new Response('', {
      status: 302,
      headers: {
        'content-type': 'text/html',
        location: `https://example.com/hop?hop=${hop + 1}`
      }
    });
  };
  const threeHops = await fetchIdeaPage({
    url: 'https://example.com/hop?hop=0', fetchImpl: chain(3), resolveHost: publicResolve
  });
  assert.equal(threeHops.ok, true, threeHops.reason);
  assert.equal(threeHops.redirects, 3);

  const fourHops = await fetchIdeaPage({
    url: 'https://example.com/hop?hop=0', fetchImpl: chain(4), resolveHost: publicResolve
  });
  assert.equal(fourHops.ok, false);
  assert.equal(fourHops.code, 'redirect');
  assert.match(fourHops.reason, /超过 3 跳/u);

  // 重定向到内网地址：跟到第二跳就拒，不发第二次请求。
  const { impl, calls } = fakeFetch(async () => new Response('', {
    status: 302,
    headers: { 'content-type': 'text/html', location: 'http://127.0.0.1/secret' }
  }));
  const toPrivate = await fetchIdeaPage({
    url: 'https://example.com/redirect', fetchImpl: impl, resolveHost: publicResolve
  });
  assert.equal(toPrivate.ok, false);
  assert.equal(toPrivate.code, 'redirect');
  assert.match(toPrivate.reason, /不放行/u);
  assert.equal(calls.length, 1);

  // 解析到内网地址：根本没发请求。
  const { impl: dnsImpl, calls: dnsCalls } = fakeFetch(async () => htmlPage(FOUR_SECTIONS_HTML));
  const dnsPrivate = await fetchIdeaPage({
    url: 'https://rebind.example.com/',
    fetchImpl: dnsImpl,
    resolveHost: async () => [{ address: '10.0.0.5', family: 4 }]
  });
  assert.equal(dnsPrivate.ok, false);
  assert.equal(dnsPrivate.code, 'private');
  assert.equal(dnsCalls.length, 0);
});

test('四段整理：齐全时 complete，缺段时标 missing 并写明原因', () => {
  const full = tidyIdeaSections({
    rawText: 'x',
    link: 'https://example.com/',
    page: { text: '问题：p\n想法：i\n预期收益：b\n风险：r' }
  });
  assert.equal(full.complete, true);
  assert.deepEqual(full.missing, []);
  assert.deepEqual(full.sections.map((section) => section.key), ['problem', 'idea', 'benefit', 'risk']);
  assert.deepEqual(full.sections.map((section) => section.text), ['p', 'i', 'b', 'r']);

  const partial = tidyIdeaSections({
    rawText: 'x',
    link: 'https://example.com/',
    page: { text: '## 问题\n只有问题\n## 想法\n只有想法' }
  });
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.missing, ['benefit', 'risk']);
  const risk = partial.sections.find((section) => section.key === 'risk');
  assert.equal(risk.missing, true);
  assert.equal(risk.text, '');
  assert.match(risk.reason, /没有「风险」这一段/u);
  assert.match(partial.note, /缺 2 段/u);

  // 纯文本条目：读原文，不读（不存在的）网页。
  const textOnly = tidyIdeaSections({ rawText: '想法：把收件箱做成两段\n风险：会越积越多' });
  assert.equal(textOnly.source, 'text');
  assert.equal(textOnly.sections.find((section) => section.key === 'idea').text, '把收件箱做成两段');
  assert.equal(textOnly.missing.includes('problem'), true);

  // 注入的提炼器整体替换这一步；抛错就当一段都没提炼出来。
  const injected = tidyIdeaSections({
    rawText: 'x',
    link: 'https://example.com/',
    page: { text: 'nothing here' },
    extract: () => ({ problem: 'P', idea: 'I', benefit: 'B', risk: 'R' })
  });
  assert.equal(injected.complete, true);
  const broken = tidyIdeaSections({
    rawText: 'x', page: { text: 'y' }, extract: () => { throw new Error('model down'); }
  });
  assert.equal(broken.complete, false);
  assert.equal(broken.missing.length, 4);
});

test('sectionsFromText：行内提到「问题」不算标题', () => {
  const found = sectionsFromText('这段话里提到了风险和收益，但不是标题。\n风险：只有一个真的标题');
  assert.equal(found.risk, '只有一个真的标题');
  assert.equal(found.problem, undefined);
  assert.equal(found.benefit, undefined);
});

test('整理链接条目：抓一次、写四段、推进到已整理，原文一字不改', async () => {
  await withStore(async ({ store }) => {
    const link = 'https://example.com/ideas/96-four';
    const item = addLinkItem(store, link);
    const { impl, calls } = fakeFetch(async () => htmlPage(FOUR_SECTIONS_HTML));

    const result = await sortIdeaEntry({
      store, id: item.id, fetchImpl: impl, resolveHost: publicResolve, now: '2026-11-25T10:00:00.000Z'
    });
    assert.equal(result.ok, true, result.reason);
    assert.equal(calls.length, 1);
    assert.equal(result.cached, false);
    assert.equal(result.attempts, 1);

    const saved = store.getIdeaItem(item.id);
    assert.equal(saved.ideaStatus, 'sorted');
    assert.equal(saved.sortedAt, '2026-11-25T10:00:00.000Z');
    assert.equal(saved.rawText, link, '原文必须原样保留');
    assert.equal(saved.link, link);
    assert.equal(saved.sorted.complete, true);
    assert.equal(saved.sorted.sections.length, 4);
    assert.equal(saved.sorted.fetch.attempts, 1);
    assert.equal(saved.sorted.extractor, 'builtin');
    // 只缓存切四段要用的正文，整页 HTML 不进库。
    assert.equal(saved.sorted.fetch.text.includes('<h2>'), false);
    assert.match(saved.sorted.fetch.text, /问题/u);

    // 视图模型把四段与抓取元信息一起交给面板。
    const view = ideaInboxView({ items: store.listIdeaInbox() });
    const row = view.groups[1].items[0];
    assert.equal(row.status, 'sorted');
    assert.deepEqual(row.sorted.sections.map((section) => section.label),
      ['问题', '想法', '预期收益', '风险']);
    assert.equal(row.sorted.fetch.attempts, 1);
  });
});

test('同一链接二次整理不再发请求：缓存落在条目上，attempts 仍是 1', async () => {
  await withStore(async ({ store }) => {
    const item = addLinkItem(store, 'https://example.com/ideas/96-cache');
    const { impl, calls } = fakeFetch(async () => htmlPage(FOUR_SECTIONS_HTML));

    const first = await sortIdeaEntry({ store, id: item.id, fetchImpl: impl, resolveHost: publicResolve });
    assert.equal(first.ok, true, first.reason);
    assert.equal(calls.length, 1);

    const second = await sortIdeaEntry({ store, id: item.id, fetchImpl: impl, resolveHost: publicResolve });
    assert.equal(second.ok, true, second.reason);
    assert.equal(calls.length, 1, '第二次整理不该再发请求');
    assert.equal(second.cached, true);
    assert.equal(second.attempts, 1);
    assert.equal(store.getIdeaItem(item.id).sorted.fetch.attempts, 1);
    assert.equal(store.getIdeaItem(item.id).ideaStatus, 'sorted', '重排不改状态');
  });
});

test('抓取失败：条目保持原状，原因照原样回，重试由人触发', async () => {
  await withStore(async ({ store }) => {
    const link = 'https://example.com/ideas/96-retry';
    const item = addLinkItem(store, link);
    let calls = 0;
    const broken = async () => {
      calls += 1;
      return htmlPage('boom', { status: 503 });
    };

    const failed = await sortIdeaEntry({ store, id: item.id, fetchImpl: broken, resolveHost: publicResolve });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'status');
    assert.match(failed.reason, /503/u);

    const untouched = store.getIdeaItem(item.id);
    assert.equal(untouched.ideaStatus, 'inbox');
    assert.equal(untouched.sorted, null);
    assert.equal(untouched.sortedAt, null);
    assert.equal(untouched.rawText, link);

    // 失败不写缓存：人再点一次就真的重试（这一次成功了）。
    const retry = await sortIdeaEntry({
      store, id: item.id, fetchImpl: async () => htmlPage(FOUR_SECTIONS_HTML), resolveHost: publicResolve
    });
    assert.equal(retry.ok, true, retry.reason);
    assert.equal(calls, 1);
    assert.equal(store.getIdeaItem(item.id).ideaStatus, 'sorted');
    assert.equal(store.getIdeaItem(item.id).sorted.fetch.attempts, 1);
  });
});

test('内网链接不整理也不发起请求，原因写明是内网', async () => {
  await withStore(async ({ store }) => {
    const item = addLinkItem(store, 'http://192.168.1.10/admin');
    const { impl, calls } = fakeFetch(async () => htmlPage(FOUR_SECTIONS_HTML));
    const result = await sortIdeaEntry({ store, id: item.id, fetchImpl: impl, resolveHost: publicResolve });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'private');
    assert.match(result.reason, /192\.168\.0\.0\/16/u);
    assert.equal(calls.length, 0, '被守卫拦下的地址一次请求都不该发');
    assert.equal(store.getIdeaItem(item.id).ideaStatus, 'inbox');
  });
});

test('纯文本条目：不抓取，四段从原文里切', async () => {
  await withStore(async ({ store }) => {
    const raw = '想法：整理只针对公网链接\n风险：抓不到正文会缺两段';
    const item = store.addIdeaItem({ title: '纯文本', rawText: raw, captureSource: 'paste' });
    const { impl, calls } = fakeFetch(async () => htmlPage(FOUR_SECTIONS_HTML));
    const result = await sortIdeaEntry({ store, id: item.id, fetchImpl: impl, resolveHost: publicResolve });
    assert.equal(result.ok, true, result.reason);
    assert.equal(calls.length, 0, '没有链接就不该发请求');
    const saved = store.getIdeaItem(item.id);
    assert.equal(saved.ideaStatus, 'sorted');
    assert.equal(saved.sorted.fetch, null);
    assert.equal(saved.sorted.source, 'text');
    assert.equal(saved.sorted.sections.find((section) => section.key === 'idea').text, '整理只针对公网链接');
    assert.deepEqual(saved.sorted.missing, ['problem', 'benefit']);
    assert.equal(saved.rawText, raw);
  });
});

test('终态条目不整理', async () => {
  await withStore(async ({ store }) => {
    const item = addLinkItem(store, 'https://example.com/ideas/96-done');
    store.setIdeaStatus(item.id, 'sorted');
    store.setIdeaStatus(item.id, 'adopted');
    const result = await sortIdeaEntry({ store, id: item.id, fetchImpl: async () => {
      throw new Error('不该被调用');
    }, resolveHost: publicResolve });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'status');
    assert.match(result.reason, /已经采纳/u);
    assert.equal((await sortIdeaEntry({ store, id: 'nope' })).code, 'missing');
  });
});

const call = async (handle, method, routePath, { body, token = TOKEN } = {}) => {
  const headers = {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(method === 'POST' ? { 'x-owner-origin': JSON.stringify(ORIGIN) } : {})
  };
  const response = await fetch(`http://127.0.0.1:${handle.port}${routePath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

test('侧车整理路由：POST /owner/v1/ideas/:id/sort 走注入的抓取器，二次整理返回 cached', async () => {
  const { root, dbPath } = tempDb();
  const store = new OwnerStore(dbPath);
  const { impl, calls } = fakeFetch(async () => htmlPage(FOUR_SECTIONS_HTML));
  const handle = await startSidecar({
    store,
    brokerFactory: () => { throw new Error('broker must not be used in these tests'); },
    token: TOKEN,
    ideaFetch: impl,
    ideaResolve: publicResolve,
    port: 0
  });
  try {
    const created = await call(handle, 'POST', '/owner/v1/ideas', {
      body: { text: 'https://example.com/ideas/96-sidecar' }
    });
    assert.equal(created.status, 201);
    const id = created.body.item.id;

    const sorted = await call(handle, 'POST', `/owner/v1/ideas/${encodeURIComponent(id)}/sort`, { body: {} });
    assert.equal(sorted.status, 200);
    assert.equal(sorted.body.item.ideaStatus, 'sorted');
    assert.equal(sorted.body.cached, false);
    assert.equal(sorted.body.attempts, 1);
    assert.equal(sorted.body.item.sorted.sections.length, 4);

    const again = await call(handle, 'POST', `/owner/v1/ideas/${encodeURIComponent(id)}/sort`, { body: {} });
    assert.equal(again.status, 200);
    assert.equal(again.body.cached, true);
    assert.equal(again.body.attempts, 1);
    assert.equal(calls.length, 1);

    // 抓取失败：400 + 原因，条目还是已整理（第二次整理没改状态，也没脏数据）。
    const guarded = await call(handle, 'POST', '/owner/v1/ideas', {
      body: { text: 'http://10.0.0.9/internal' }
    });
    const internal = await call(handle, 'POST',
      `/owner/v1/ideas/${encodeURIComponent(guarded.body.item.id)}/sort`, { body: {} });
    assert.equal(internal.status, 400);
    assert.match(internal.body.error, /内网/u);

    const missing = await call(handle, 'POST', '/owner/v1/ideas/nope/sort', { body: {} });
    assert.equal(missing.status, 404);
  } finally {
    await handle.close();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
