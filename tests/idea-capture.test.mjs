// #95 灵感捕获：文本/链接分拣、重复入队、状态机与侧车路由。
// 存储与状态机一律用临时库（照 tests/idea-inbox.test.mjs 的做法），不碰真实数据。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OwnerStore } from '../src/owner-store.mjs';
import { asIdeaLink, ideaDedupeKey, parseIdeaCapture } from '../src/idea-entry.mjs';
import { startSidecar } from '../src/sidecar-server.mjs';

const TOKEN = 'idea-capture-token-0123456789';
const ORIGIN = {
  gatewayInstanceId: 'gw-idea',
  sessionKey: 'agent:main:idea-capture',
  runId: 'run-idea',
  operatorId: 'owner'
};

const tempDb = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-idea-capture-'));
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

const withSidecar = async (fn) => {
  const { root, dbPath } = tempDb();
  const store = new OwnerStore(dbPath);
  const handle = await startSidecar({
    store,
    brokerFactory: () => { throw new Error('broker must not be used in these tests'); },
    token: TOKEN,
    port: 0
  });
  try {
    await fn({ store, handle });
  } finally {
    await handle.close();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
};

test('粘贴文本按「粘贴」入队，标题取首句、原文原样保留', () => {
  const parsed = parseIdeaCapture('  收件箱空的时候\n应该有一句提示，不是一片空白。  ');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.source, 'paste');
  assert.equal(parsed.link, '');
  // 只去首尾空白：正文中间的换行属于原文，不能被压成一行。
  assert.equal(parsed.text, '收件箱空的时候\n应该有一句提示，不是一片空白。');
  assert.match(parsed.title, /收件箱空的时候/u);
});

test('整段就是一个 http(s) 链接时按「链接」入队，只存地址', () => {
  const parsed = parseIdeaCapture('https://example.com/notes/95-link-only');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.source, 'link');
  assert.equal(parsed.link, 'https://example.com/notes/95-link-only');
  assert.equal(parsed.text, parsed.link);
  assert.ok(parsed.title.length > 0);
});

test('一段话里夹着链接仍按「粘贴」，不把正文丢掉', () => {
  const text = '看到一篇讲收件箱设计的文章 https://example.com/notes/95 可以借鉴它的两段式。';
  const parsed = parseIdeaCapture(text);
  assert.equal(parsed.source, 'paste');
  assert.equal(parsed.link, '');
  assert.equal(parsed.text, text);
});

test('非 http(s) 与非绝对地址不认成链接', () => {
  assert.equal(asIdeaLink('ftp://example.com/a'), '');
  assert.equal(asIdeaLink('file:///C:/notes.md'), '');
  assert.equal(asIdeaLink('https://'), '');
  assert.equal(asIdeaLink('example.com/a'), '');
  assert.equal(asIdeaLink('http://example.com/a'), 'http://example.com/a');
  // 只做字符串解析，不解析 DNS、不发请求。
  assert.equal(parseIdeaCapture('https://').source, 'paste');
});

test('空内容与超长内容给出明确原因，不静默入库', () => {
  const empty = parseIdeaCapture('   \n  ');
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /空内容/u);
  const long = parseIdeaCapture('字'.repeat(8001));
  assert.equal(long.ok, false);
  assert.match(long.reason, /8000/u);
});

test('去重键：空白差异算同一条，来源不同算两条', () => {
  const a = ideaDedupeKey({ rawText: '同一段话', captureSource: 'paste' });
  const b = ideaDedupeKey({ rawText: '  同一段话 \n', captureSource: 'paste' });
  const c = ideaDedupeKey({ rawText: '同一段话', captureSource: 'link' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('重复入队：同一段正文 + 同一来源只留一条，重复调用返回同一条', async () => {
  await withStore(async ({ store }) => {
    const first = store.addIdeaItem({ title: '重复粘贴', rawText: '重复粘贴 同一段内容' });
    const again = store.addIdeaItem({ title: '重复粘贴', rawText: '重复粘贴 同一段内容' });
    assert.equal(again.id, first.id);
    // 换行与多余空格不算新内容。
    const spaced = store.addIdeaItem({
      title: '重复粘贴', rawText: '重复粘贴 \n 同一段内容  '
    });
    assert.equal(spaced.id, first.id);
    assert.equal(store.listIdeaInbox().length, 1);
  });
});

test('重复入队：同一段正文换个来源算另一条', async () => {
  await withStore(async ({ store }) => {
    const text = 'https://example.com/notes/95';
    const pasted = store.addIdeaItem({ title: text, rawText: text, captureSource: 'paste' });
    const linked = store.addIdeaItem({
      title: text, rawText: text, captureSource: 'link', link: text
    });
    assert.notEqual(linked.id, pasted.id);
    assert.equal(linked.captureSource, 'link');
    assert.equal(store.listIdeaInbox().length, 2);
  });
});

test('状态机拒绝跳级与回头，并把「从哪到哪」写进原因', async () => {
  await withStore(async ({ store }) => {
    const idea = store.addIdeaItem({ title: '状态机', rawText: '状态机拒绝非法流转' });
    assert.throws(
      () => store.setIdeaStatus(idea.id, 'adopted'),
      (error) => error.status === 409 && /inbox to adopted/u.test(error.message)
    );
    assert.throws(
      () => store.setIdeaStatus(idea.id, 'discarded'),
      (error) => error.status === 409 && /inbox to discarded/u.test(error.message)
    );
    store.setIdeaStatus(idea.id, 'sorted');
    assert.throws(() => store.setIdeaStatus(idea.id, 'sorted'), /cannot move/u);
    store.setIdeaStatus(idea.id, 'discarded');
    // 终态不再前进，也不会被「改回」收件箱。
    assert.throws(() => store.setIdeaStatus(idea.id, 'adopted'), /cannot move/u);
    assert.throws(() => store.setIdeaStatus(idea.id, 'inbox'), /cannot move/u);
    assert.throws(() => store.setIdeaStatus(idea.id, 'nonsense'), /Invalid idea status/u);
  });
});

test('丢弃不删除原文：条目留在已整理里，原文与链接都能查回', async () => {
  await withStore(async ({ store }) => {
    const text = '丢弃只是状态，原文要能查回';
    const idea = store.addIdeaItem({ title: text, rawText: text });
    store.setIdeaStatus(idea.id, 'sorted');
    const discarded = store.setIdeaStatus(idea.id, 'discarded');
    assert.equal(discarded.ideaStatus, 'discarded');
    assert.equal(discarded.rawText, text);
    assert.ok(discarded.sortedAt, '丢弃保留整理时间');
    const listed = store.listIdeaInbox();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].ideaStatus, 'discarded');
    assert.equal(listed[0].rawText, text);

    const link = 'https://example.com/notes/95-discard';
    const linked = store.addIdeaItem({
      title: link, rawText: link, captureSource: 'link', link
    });
    store.setIdeaStatus(linked.id, 'sorted');
    store.setIdeaStatus(linked.id, 'discarded');
    assert.equal(store.getIdeaItem(linked.id).link, link);
  });
});

test('侧车捕获：文本与链接各一条，重复捕获返回 duplicate 且不新增', async () => {
  await withSidecar(async ({ handle }) => {
    const text = await call(handle, 'POST', '/owner/v1/ideas', {
      body: { text: '把想法和链接先丢进收件箱，整理的时候再决定归属。' }
    });
    assert.equal(text.status, 201);
    assert.equal(text.body.duplicate, false);
    assert.equal(text.body.item.captureSource, 'paste');
    assert.ok(text.body.item.createdAt);

    const again = await call(handle, 'POST', '/owner/v1/ideas', {
      body: { text: '把想法和链接先丢进收件箱，整理的时候再决定归属。' }
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.item.id, text.body.item.id);

    const link = await call(handle, 'POST', '/owner/v1/ideas', {
      body: { text: 'https://example.com/notes/95' }
    });
    assert.equal(link.status, 201);
    assert.equal(link.body.item.captureSource, 'link');
    assert.equal(link.body.item.link, 'https://example.com/notes/95');

    const inbox = await call(handle, 'GET', '/owner/v1/ideas');
    assert.equal(inbox.status, 200);
    assert.equal(inbox.body.view.counts.inbox, 2);
    assert.equal(inbox.body.view.counts.all, 2);
    assert.deepEqual(inbox.body.view.groups.map((group) => group.key), ['inbox', 'sorted']);
  });
});

test('侧车捕获：空内容被拒；状态流转走 PATCH，非法流转 409', async () => {
  await withSidecar(async ({ handle }) => {
    const empty = await call(handle, 'POST', '/owner/v1/ideas', { body: { text: '   ' } });
    assert.equal(empty.status, 400);
    assert.match(empty.body.error, /空内容/u);

    const created = await call(handle, 'POST', '/owner/v1/ideas', {
      body: { text: '状态流转要能解释为什么被拒。' }
    });
    const id = created.body.item.id;
    const jump = await call(handle, 'PATCH', `/owner/v1/ideas/${id}`, {
      body: { status: 'adopted' }
    });
    assert.equal(jump.status, 409);
    assert.match(jump.body.error, /inbox to adopted/u);

    const sorted = await call(handle, 'PATCH', `/owner/v1/ideas/${id}`, {
      body: { status: 'sorted' }
    });
    assert.equal(sorted.status, 200);
    assert.equal(sorted.body.ideaStatus, 'sorted');

    const adopted = await call(handle, 'PATCH', `/owner/v1/ideas/${id}`, {
      body: { status: 'adopted' }
    });
    assert.equal(adopted.status, 200);
    assert.equal(adopted.body.ideaStatus, 'adopted');
    assert.equal(adopted.body.rawText, '状态流转要能解释为什么被拒。');

    const view = await call(handle, 'GET', '/owner/v1/ideas');
    assert.equal(view.body.view.counts.inbox, 0);
    assert.equal(view.body.view.counts.sorted, 1);
    assert.equal(view.body.view.groups[1].items[0].statusLabel, '已采纳');
  });
});

test('侧车捕获：未授权与缺少来源的写请求都被拒绝', async () => {
  await withSidecar(async ({ handle }) => {
    const noToken = await call(handle, 'POST', '/owner/v1/ideas', {
      body: { text: '没有令牌' }, token: ''
    });
    assert.equal(noToken.status, 401);

    const response = await fetch(`http://127.0.0.1:${handle.port}/owner/v1/ideas`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '没有来源头' })
    });
    assert.equal(response.status, 400);
  });
});
