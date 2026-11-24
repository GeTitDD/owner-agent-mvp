import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { rm } from 'node:fs/promises';
import { deliverFeishu, formatStaleMessage } from '../src/observer/feishu.mjs';
import { resolveFeishuWebhook } from '../src/observer/config.mjs';
import { makeTempDir } from './helpers/observer-fixture.mjs';

const withServer = async (handler, fn) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const [status, payload] = handler(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn({ webhookUrl: `http://127.0.0.1:${port}/open-apis/bot/v2/hook/test`, requests });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

const staleEvent = () => ({
  type: 'stale',
  fingerprint: 'c'.repeat(64),
  projectId: 'obs-demo',
  projectName: 'Demo Project',
  branch: 'main',
  branchLabel: 'main',
  head: 'd'.repeat(40),
  lastCommitAt: '2026-11-20T09:00:00+08:00',
  daysStale: 4,
  detectedAt: '2026-11-24T01:00:00.000Z'
});

test('停滞消息包含项目名、分支与最后提交时间', () => {
  const text = formatStaleMessage(staleEvent());

  assert.match(text, /Demo Project/);
  assert.match(text, /main/);
  assert.match(text, /2026-11-20T09:00:00\+08:00/);
  assert.match(text, /4 天/);
});

test('投递到飞书 webhook：payload 是文本消息，返回 code:0 记为 sent', async () => {
  await withServer(() => [200, { code: 0, msg: 'success' }], async ({ webhookUrl, requests }) => {
    const result = await deliverFeishu({ webhookUrl, text: 'hello observer' });

    assert.equal(result.status, 'sent');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.match(requests[0].headers['content-type'], /application\/json/);
    assert.deepEqual(JSON.parse(requests[0].body), {
      msg_type: 'text',
      content: { text: 'hello observer' }
    });
  });
});

test('飞书返回非零 code 或 HTTP 失败时记为 failed，不抛异常', async () => {
  await withServer(() => [200, { code: 19001, msg: 'invalid webhook token' }], async ({ webhookUrl }) => {
    const result = await deliverFeishu({ webhookUrl, text: 'x' });
    assert.equal(result.status, 'failed');
    assert.match(result.detail, /19001/);
  });

  await withServer(() => [500, { code: 500, msg: 'boom' }], async ({ webhookUrl }) => {
    const result = await deliverFeishu({ webhookUrl, text: 'x' });
    assert.equal(result.status, 'failed');
    assert.match(result.detail, /http 500/);
  });
});

test('未配置 webhook 时退化为 skipped，且不发起任何请求', async () => {
  const result = await deliverFeishu({ webhookUrl: '', text: 'x' });

  assert.equal(result.status, 'skipped');
  assert.match(result.detail, /not configured/);
});

test('webhook 配置读取优先级：环境变量 > ~/.owner-agent/feishu.json > 无', async () => {
  const dir = makeTempDir();
  try {
    const configPath = path.join(dir, 'feishu.json');
    assert.deepEqual(resolveFeishuWebhook({ env: {}, configPath }), { webhook: '', source: 'none' });

    fs.writeFileSync(configPath, JSON.stringify({ webhook: 'https://example.invalid/hook/from-file' }));
    assert.deepEqual(resolveFeishuWebhook({ env: {}, configPath }), {
      webhook: 'https://example.invalid/hook/from-file',
      source: 'config'
    });

    assert.deepEqual(resolveFeishuWebhook({ env: { OWNER_OBSERVER_FEISHU_WEBHOOK: 'https://example.invalid/hook/from-env' }, configPath }), {
      webhook: 'https://example.invalid/hook/from-env',
      source: 'env'
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('配置文件损坏或字段缺失时视为未配置', async () => {
  const dir = makeTempDir();
  try {
    const configPath = path.join(dir, 'feishu.json');
    fs.writeFileSync(configPath, '{not json');
    assert.equal(resolveFeishuWebhook({ env: {}, configPath }).source, 'none');
    fs.writeFileSync(configPath, JSON.stringify({ webhook: '' }));
    assert.equal(resolveFeishuWebhook({ env: {}, configPath }).source, 'none');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// opt-in：只有显式设置 OWNER_OBSERVER_FEISHU_LIVE=1 才会真的往群里发一条消息。
// 默认跳过，保证 node --test 不联网、不外发。
test('真实飞书投递自检（opt-in，默认跳过）', {
  skip: process.env.OWNER_OBSERVER_FEISHU_LIVE !== '1'
}, async () => {
  const { webhook, source } = resolveFeishuWebhook();
  assert.ok(webhook, `no feishu webhook configured (source=${source})`);
  const result = await deliverFeishu({ webhookUrl: webhook, text: 'Owner Observer v0.1 真实投递自检（opt-in 测试）' });
  assert.equal(result.status, 'sent');
});
