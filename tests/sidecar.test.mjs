// v1.1 sidecar 契约测试：只验证 HTTP 适配层，不重复 v1.0 的领域状态机测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { OwnerStore } from '../src/owner-store.mjs';
import { resolveSidecarToken, startSidecar } from '../src/sidecar-server.mjs';

const TOKEN = 'sidecar-test-token-0123456789';

const call = async (handle, method, routePath, { body, headers = {}, token = TOKEN } = {}) => {
  const response = await fetch(`http://127.0.0.1:${handle.port}${routePath}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

const rawStatus = (port, headers) => new Promise((resolve, reject) => {
  const request = http.request(
    { host: '127.0.0.1', port, path: '/owner/v1/health', method: 'GET', headers },
    (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    }
  );
  request.on('error', reject);
  request.end();
});

const withSidecar = async (fn) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-sidecar-'));
  const store = new OwnerStore(path.join(root, 'owner.sqlite'));
  store.registerProject({ id: 'p1', name: 'Sidecar Test', root });
  const task = store.createTask({ projectId: 'p1', title: 'Acceptance task' });
  const handle = await startSidecar({
    store,
    // 这些用例不触碰补丁/沙箱，误用 broker 应当直接失败。
    brokerFactory: () => { throw new Error('broker must not be used in these tests'); },
    token: TOKEN,
    port: 0
  });
  try {
    await fn({ store, handle, root, task });
  } finally {
    await handle.close();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
};

test('sidecar rejects missing or wrong bearer token', async () => {
  await withSidecar(async ({ handle }) => {
    assert.equal((await call(handle, 'GET', '/owner/v1/health', { token: '' })).status, 401);
    assert.equal((await call(handle, 'GET', '/owner/v1/health', { token: 'wrong' })).status, 401);
    const ok = await call(handle, 'GET', '/owner/v1/health');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
  });
});

test('sidecar rejects non-loopback Host and cross-site Origin', async () => {
  await withSidecar(async ({ handle }) => {
    assert.equal(await rawStatus(handle.port, { host: 'evil.example', authorization: `Bearer ${TOKEN}` }), 403);
    const crossSite = await call(handle, 'GET', '/owner/v1/health', {
      headers: { origin: 'http://evil.example' }
    });
    assert.equal(crossSite.status, 403);
    const sameOrigin = await call(handle, 'GET', '/owner/v1/health', {
      headers: { origin: `http://127.0.0.1:${handle.port}` }
    });
    assert.equal(sameOrigin.status, 200);
  });
});

test('sidecar lists projects, tasks and summary', async () => {
  await withSidecar(async ({ handle, task }) => {
    const projects = await call(handle, 'GET', '/owner/v1/projects');
    assert.equal(projects.status, 200);
    assert.deepEqual(projects.body.items.map((item) => item.id), ['p1']);

    const tasks = await call(handle, 'GET', '/owner/v1/tasks?projectId=p1');
    assert.equal(tasks.status, 200);
    assert.equal(tasks.body.items[0].id, task.id);

    const summary = await call(handle, 'GET', '/owner/v1/summary');
    assert.equal(summary.status, 200);
    assert.equal(summary.body.projectCount >= 1, true);
  });
});

test('sidecar creates jobs idempotently and approves them', async () => {
  await withSidecar(async ({ handle, task }) => {
    const created = await call(handle, 'POST', '/owner/v1/jobs', {
      body: {
        projectId: 'p1',
        jobType: 'status-note',
        title: 'Sidecar job',
        payload: { note: 'hello' },
        idempotencyKey: 'sidecar-key-1',
        ownerTaskId: task.id
      }
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, 'pending_approval');
    assert.equal(created.body.duplicate, undefined);

    const duplicate = await call(handle, 'POST', '/owner/v1/jobs', {
      body: {
        projectId: 'p1',
        jobType: 'status-note',
        title: 'Sidecar job',
        payload: { note: 'hello' },
        idempotencyKey: 'sidecar-key-1',
        ownerTaskId: task.id
      }
    });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.id, created.body.id);
    assert.equal(duplicate.body.duplicate, true);

    const approved = await call(handle, 'POST', `/owner/v1/jobs/${created.body.id}/approve`);
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, 'queued');

    const fetched = await call(handle, 'GET', `/owner/v1/jobs/${created.body.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.status, 'queued');
  });
});

test('sidecar records the OpenClaw origin on mutations', async () => {
  await withSidecar(async ({ handle, task }) => {
    const created = await call(handle, 'POST', '/owner/v1/jobs', {
      body: {
        projectId: 'p1',
        jobType: 'status-note',
        title: 'Origin job',
        payload: { note: 'origin' },
        idempotencyKey: 'sidecar-origin-1',
        ownerTaskId: task.id
      },
      headers: {
        'x-owner-origin': JSON.stringify({
          gatewayInstanceId: 'gw-1',
          sessionKey: 'agent:main:sidecar',
          runId: 'run-1',
          operatorId: 'owner'
        })
      }
    });
    assert.equal(created.status, 201);

    const events = await call(handle, 'GET', '/owner/v1/events?projectId=p1');
    assert.equal(events.status, 200);
    const audit = events.body.items.find((item) => item.kind === 'api_call');
    assert.ok(audit, 'api_call event should be recorded');
    assert.equal(audit.payload.origin.gatewayInstanceId, 'gw-1');
    assert.equal(audit.payload.origin.sessionKey, 'agent:main:sidecar');
    assert.equal(audit.payload.origin.runId, 'run-1');
    assert.match(audit.payload.note, /job\.create/);

    const job = await call(handle, 'GET', `/owner/v1/jobs/${created.body.id}`);
    assert.equal(job.body.events[0].actor.startsWith('openclaw:owner'), true);
  });
});

test('sidecar rejects unknown origin fields and non-JSON bodies', async () => {
  await withSidecar(async ({ handle, task }) => {
    const badOrigin = await call(handle, 'POST', '/owner/v1/jobs', {
      body: {
        projectId: 'p1',
        jobType: 'status-note',
        title: 'Bad origin',
        payload: { note: 'x' },
        idempotencyKey: 'sidecar-bad-origin',
        ownerTaskId: task.id
      },
      headers: { 'x-owner-origin': JSON.stringify({ evil: '1' }) }
    });
    assert.equal(badOrigin.status, 400);

    const wrongType = await call(handle, 'POST', '/owner/v1/jobs', {
      body: { anything: true },
      headers: { 'content-type': 'text/plain' }
    });
    assert.equal(wrongType.status, 415);
  });
});

test('sidecar maps validation and state errors to HTTP status codes', async () => {
  await withSidecar(async ({ handle }) => {
    assert.equal((await call(handle, 'GET', '/owner/v1/jobs/missing')).status, 404);
    assert.equal((await call(handle, 'POST', '/owner/v1/jobs', {
      body: { projectId: 'p1' }
    })).status, 400);
    assert.equal((await call(handle, 'POST', '/owner/v1/patches/missing/approve', {
      body: { hash: 'a'.repeat(64) }
    })).status, 404);
    assert.equal((await call(handle, 'POST', '/owner/v1/patches/missing/approve', {
      body: { hash: 'not-a-hash' }
    })).status, 400);
    assert.equal((await call(handle, 'GET', '/owner/v1/unknown')).status, 404);
    assert.equal((await call(handle, 'DELETE', '/owner/v1/jobs')).status, 405);
  });
});

test('token file is created once and reused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-sidecar-token-'));
  const saved = process.env.OWNER_AGENT_SIDECAR_TOKEN;
  delete process.env.OWNER_AGENT_SIDECAR_TOKEN;
  try {
    const dbPath = path.join(root, 'owner.sqlite');
    const first = resolveSidecarToken({ dbPath });
    const second = resolveSidecarToken({ dbPath });
    assert.equal(first, second);
    assert.ok(first.length >= 24);
    const file = path.join(root, 'sidecar.token');
    assert.equal(fs.readFileSync(file, 'utf8').trim(), first);
  } finally {
    if (saved === undefined) delete process.env.OWNER_AGENT_SIDECAR_TOKEN;
    else process.env.OWNER_AGENT_SIDECAR_TOKEN = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
