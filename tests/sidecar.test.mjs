// v1.1 sidecar 契约测试：授权隔离、审批/应用拆分、原子审计与 CORS。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { OwnerStore } from '../src/owner-store.mjs';
import {
  approvalTokenPath,
  resolveApprovalToken,
  resolveSidecarToken,
  sidecarTokenPath,
  startSidecar
} from '../src/sidecar-server.mjs';

const TOKEN = 'sidecar-test-token-0123456789';
const APPROVAL = 'approval-test-token-0123456789';

const ORIGIN = {
  gatewayInstanceId: 'gw-1',
  sessionKey: 'agent:main:sidecar',
  runId: 'run-1',
  operatorId: 'owner'
};

const call = async (handle, method, routePath, {
  body,
  headers = {},
  token = TOKEN,
  approval = false,
  omitOrigin = false
} = {}) => {
  const merged = {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(method === 'POST' && !omitOrigin ? { 'x-owner-origin': JSON.stringify(ORIGIN) } : {}),
    ...(approval ? { 'x-owner-approval-token': APPROVAL } : {}),
    ...headers
  };
  const response = await fetch(`http://127.0.0.1:${handle.port}${routePath}`, {
    method,
    headers: merged,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
};

const rawRequest = (port, { method = 'GET', path: routePath = '/owner/v1/health', headers = {} } = {}) =>
  new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: routePath, method, headers },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({
          status: response.statusCode,
          body,
          headers: response.headers
        }));
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
    brokerFactory: () => { throw new Error('broker must not be used in these tests'); },
    token: TOKEN,
    approvalToken: APPROVAL,
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

const createJob = async (handle, task, key = 'sidecar-key-1') => call(handle, 'POST', '/owner/v1/jobs', {
  body: {
    projectId: 'p1',
    jobType: 'status-note',
    title: 'Sidecar job',
    payload: { note: 'hello' },
    idempotencyKey: key,
    ownerTaskId: task.id
  }
});

test('health requires the read token', async () => {
  await withSidecar(async ({ handle }) => {
    assert.equal((await call(handle, 'GET', '/owner/v1/health', { token: '' })).status, 401);
    assert.equal((await call(handle, 'GET', '/owner/v1/health', { token: 'wrong' })).status, 401);
    const ok = await call(handle, 'GET', '/owner/v1/health');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.approvalMode, 'token');
  });
});

test('read token cannot approve; approval token is required', async () => {
  await withSidecar(async ({ handle, task }) => {
    const created = await createJob(handle, task);
    assert.equal(created.status, 201);

    // 只有读取令牌：拒绝，且状态不变。
    const readOnly = await call(handle, 'POST', `/owner/v1/jobs/${created.body.id}/approve`);
    assert.equal(readOnly.status, 403);

    const wrong = await call(handle, 'POST', `/owner/v1/jobs/${created.body.id}/approve`, {
      approval: true,
      headers: { 'x-owner-approval-token': 'not-the-approval-token' }
    });
    assert.equal(wrong.status, 403);

    const approved = await call(handle, 'POST', `/owner/v1/jobs/${created.body.id}/approve`, {
      approval: true
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, 'queued');
  });
});

test('mutations require X-Owner-Origin and reject unknown fields', async () => {
  await withSidecar(async ({ handle, task }) => {
    const missing = await call(handle, 'POST', '/owner/v1/jobs', {
      omitOrigin: true,
      body: {
        projectId: 'p1',
        jobType: 'status-note',
        title: 'No origin',
        payload: { note: 'x' },
        idempotencyKey: 'sidecar-no-origin',
        ownerTaskId: task.id
      }
    });
    assert.equal(missing.status, 400);

    const forgedField = await call(handle, 'POST', '/owner/v1/jobs', {
      headers: { 'x-owner-origin': JSON.stringify({ evil: '1' }) },
      body: {
        projectId: 'p1',
        jobType: 'status-note',
        title: 'Bad origin',
        payload: { note: 'x' },
        idempotencyKey: 'sidecar-bad-origin',
        ownerTaskId: task.id
      }
    });
    assert.equal(forgedField.status, 400);
  });
});

test('approval writes an atomic decision audit with a claimed origin', async () => {
  await withSidecar(async ({ store, handle, task }) => {
    const created = await createJob(handle, task, 'sidecar-audit-1');
    const approved = await call(handle, 'POST', `/owner/v1/jobs/${created.body.id}/approve`, {
      approval: true,
      headers: {
        'x-owner-origin': JSON.stringify({ ...ORIGIN, runId: 'forged-run' })
      }
    });
    assert.equal(approved.status, 200);

    const rows = store.listDecisionAudit({ subjectType: 'job', subjectId: created.body.id });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'approve');
    assert.equal(rows[0].principal_kind, 'approval-token');
    assert.equal(rows[0].principal_id, 'owner');
    assert.equal(rows[0].origin_trust, 'claimed');
    assert.equal(rows[0].claimed_origin.runId, 'forged-run');
  });
});

test('audit failure rolls the approval back', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-audit-'));
  const store = new OwnerStore(path.join(root, 'owner.sqlite'));
  store.registerProject({ id: 'p1', name: 'Audit Test', root });
  const task = store.createTask({ projectId: 'p1', title: 'T' });
  const job = store.createJob({
    projectId: 'p1',
    jobType: 'status-note',
    title: 'J',
    payload: { note: 'x' },
    idempotencyKey: 'audit-rollback',
    ownerTaskId: task.id
  });
  try {
    assert.throws(() => store.approveJob(job.id, {
      audit: { principal: { kind: 'bogus', id: 'x' }, claimedOrigin: ORIGIN }
    }));
    assert.equal(store.getJob(job.id).status, 'pending_approval');
    assert.equal(store.listDecisionAudit({ subjectType: 'job', subjectId: job.id }).length, 0);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('patch approval is separated from apply', async () => {
  await withSidecar(async ({ handle }) => {
    // 不存在提案：审批与应用都必须 404，且不能互相替代。
    const approve = await call(handle, 'POST', '/owner/v1/patches/missing/approve', {
      approval: true,
      body: { hash: 'a'.repeat(64) }
    });
    assert.equal(approve.status, 404);
    const apply = await call(handle, 'POST', '/owner/v1/patches/missing/apply', {
      approval: true,
      body: { hash: 'a'.repeat(64) }
    });
    assert.equal(apply.status, 404);
    const badHash = await call(handle, 'POST', '/owner/v1/patches/missing/approve', {
      approval: true,
      body: { hash: 'nope' }
    });
    assert.equal(badHash.status, 400);
  });
});

test('decisions without an approval token return 503 (fail closed)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-noapproval-'));
  const store = new OwnerStore(path.join(root, 'owner.sqlite'));
  store.registerProject({ id: 'p1', name: 'No Approval', root });
  const task = store.createTask({ projectId: 'p1', title: 'T' });
  const job = store.createJob({
    projectId: 'p1',
    jobType: 'status-note',
    title: 'J',
    payload: { note: 'x' },
    idempotencyKey: 'no-approval',
    ownerTaskId: task.id
  });
  const handle = await startSidecar({
    store,
    brokerFactory: () => { throw new Error('unused'); },
    token: TOKEN,
    approvalToken: null,
    port: 0
  });
  try {
    const res = await call(handle, 'POST', `/owner/v1/jobs/${job.id}/approve`, { approval: true });
    assert.equal(res.status, 503);
    assert.equal(store.getJob(job.id).status, 'pending_approval');
  } finally {
    await handle.close();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CORS allows loopback Control UI origins only', async () => {
  await withSidecar(async ({ handle }) => {
    const preflight = await rawRequest(handle.port, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://127.0.0.1:19789',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,x-owner-approval-token'
      }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], 'http://127.0.0.1:19789');
    assert.match(String(preflight.headers['access-control-allow-headers']), /x-owner-approval-token/);

    const allowed = await rawRequest(handle.port, {
      headers: {
        origin: 'http://127.0.0.1:19789',
        authorization: `Bearer ${TOKEN}`
      }
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers['access-control-allow-origin'], 'http://127.0.0.1:19789');

    const blocked = await rawRequest(handle.port, {
      headers: {
        origin: 'http://evil.example',
        authorization: `Bearer ${TOKEN}`
      }
    });
    assert.equal(blocked.status, 403);
  });
});

test('worker endpoints fail closed when no worker is configured', async () => {
  await withSidecar(async ({ handle }) => {
    const status = await call(handle, 'GET', '/owner/v1/worker/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.configured, false);

    const tick = await call(handle, 'POST', '/owner/v1/worker/tick', { body: {} });
    assert.equal(tick.status, 503);

    const repair = await call(handle, 'POST', '/owner/v1/repair-cycles', {
      body: { sandboxRunId: 'missing', idempotencyKey: 'repair-missing' }
    });
    assert.equal(repair.status, 404);
  });
});

test('read and approval tokens live in separate files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-sidecar-token-'));
  const savedRead = process.env.OWNER_AGENT_SIDECAR_TOKEN;
  const savedApproval = process.env.OWNER_AGENT_APPROVAL_TOKEN;
  delete process.env.OWNER_AGENT_SIDECAR_TOKEN;
  delete process.env.OWNER_AGENT_APPROVAL_TOKEN;
  try {
    const dbPath = path.join(root, 'owner.sqlite');
    const read = resolveSidecarToken({ dbPath });
    const approval = resolveApprovalToken({ dbPath });
    assert.notEqual(read, approval);
    assert.ok(read.length >= 24 && approval.length >= 24);
    assert.equal(fs.readFileSync(sidecarTokenPath(dbPath), 'utf8').trim(), read);
    assert.equal(fs.readFileSync(approvalTokenPath(dbPath), 'utf8').trim(), approval);
  } finally {
    if (savedRead === undefined) delete process.env.OWNER_AGENT_SIDECAR_TOKEN;
    else process.env.OWNER_AGENT_SIDECAR_TOKEN = savedRead;
    if (savedApproval === undefined) delete process.env.OWNER_AGENT_APPROVAL_TOKEN;
    else process.env.OWNER_AGENT_APPROVAL_TOKEN = savedApproval;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
