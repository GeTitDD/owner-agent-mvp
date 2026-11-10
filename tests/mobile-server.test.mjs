// 手机桥：配对、设备令牌、概览、聊天与想法的 HTTP 契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OwnerStore } from '../src/owner-store.mjs';
import { startMobileServer } from '../src/mobile-server.mjs';

const setup = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-mobile-'));
  const projectRoot = path.join(root, 'demo');
  fs.mkdirSync(projectRoot, { recursive: true });
  const store = new OwnerStore(path.join(root, 'owner.sqlite'));
  store.registerProject({ id: 'demo', name: 'Demo', root: projectRoot });
  const chatCalls = [];
  const server = await startMobileServer({
    store,
    stateDir: path.join(root, 'userdata'),
    host: '127.0.0.1',
    port: 0,
    version: 'test',
    getOverview: async ({ projectId }) => ({
      activeProjectId: projectId || 'demo',
      projects: [{ id: 'demo', name: 'Demo' }]
    }),
    submitChat: async ({ projectId, text }) => {
      chatCalls.push({ projectId, text });
      return { mode: 'answer', summary: '好的' };
    }
  });
  const base = `http://127.0.0.1:${server.port}`;
  const call = async (route, { method = 'GET', body, token } = {}) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return {
    root,
    store,
    server,
    call,
    chatCalls,
    async cleanup() {
      await server.close();
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
};

test('健康检查公开，其余接口必须带设备令牌', async () => {
  const env = await setup();
  try {
    const health = await env.call('/m/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    const overview = await env.call('/m/overview');
    assert.equal(overview.status, 401);
  } finally {
    await env.cleanup();
  }
});

test('配对码换令牌后可以读概览，配对码只能用一次', async () => {
  const env = await setup();
  try {
    const { code } = env.server.pairingCode();
    assert.match(code, /^\d{6}$/u);
    const wrong = await env.call('/m/pair', { method: 'POST', body: { code: '000000', deviceName: 'iPhone' } });
    assert.equal(wrong.status, 401);

    const paired = await env.call('/m/pair', { method: 'POST', body: { code, deviceName: 'iPhone 15' } });
    assert.equal(paired.status, 200);
    assert.ok(paired.body.token.length > 20);

    const reused = await env.call('/m/pair', { method: 'POST', body: { code, deviceName: 'iPad' } });
    assert.equal(reused.status, 401);

    const overview = await env.call('/m/overview?projectId=demo', { token: paired.body.token });
    assert.equal(overview.status, 200);
    assert.equal(overview.body.activeProjectId, 'demo');
    assert.equal(overview.body.projects.length, 1);

    const ping = await env.call('/m/ping', { token: paired.body.token });
    assert.equal(ping.status, 200);
    assert.equal(ping.body.ok, true);
  } finally {
    await env.cleanup();
  }
});

test('想法：新增、改状态、删除；聊天走注入的执行器', async () => {
  const env = await setup();
  try {
    const paired = await env.call('/m/pair', {
      method: 'POST', body: { code: env.server.pairingCode().code, deviceName: 'Test' }
    });
    const token = paired.body.token;

    const created = await env.call('/m/ideas', {
      method: 'POST', token, body: { projectId: 'demo', title: '加一个导出按钮' }
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.kind, 'idea');
    assert.equal(created.body.source, 'mobile');

    const duplicate = await env.call('/m/ideas', {
      method: 'POST', token, body: { projectId: 'demo', title: '加一个导出按钮' }
    });
    assert.equal(duplicate.body.id, created.body.id);

    const adopted = await env.call(`/m/ideas/${created.body.id}`, {
      method: 'PATCH', token, body: { status: 'done' }
    });
    assert.equal(adopted.status, 200);
    assert.equal(adopted.body.status, 'done');

    const badStatus = await env.call(`/m/ideas/${created.body.id}`, {
      method: 'PATCH', token, body: { status: 'later' }
    });
    assert.equal(badStatus.status, 400);

    const chat = await env.call('/m/chat', {
      method: 'POST', token, body: { projectId: 'demo', text: '这个项目现在怎么样？' }
    });
    assert.equal(chat.status, 200);
    assert.equal(chat.body.summary, '好的');
    assert.deepEqual(env.chatCalls, [{ projectId: 'demo', text: '这个项目现在怎么样？' }]);

    const removed = await env.call(`/m/ideas/${created.body.id}`, { method: 'DELETE', token });
    assert.equal(removed.status, 200);
    assert.equal(env.store.listProjectQueue('demo', 'idea').length, 0);
  } finally {
    await env.cleanup();
  }
});
