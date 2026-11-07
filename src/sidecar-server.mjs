// Owner Agent sidecar：给 OpenClaw 插件使用的本机 HTTP 适配层。
//
// 设计约束（与 v1.1 方案一致）：
// - 只监听 127.0.0.1，必须携带 bearer token；
// - 审批接口必须显式携带 Owner 冻结的 64-hex 哈希；
// - 写操作把 OpenClaw 的来源（gateway/session/run/operator）记入 Owner 事件流；
// - 不在本层放宽任何 OwnerStore 的状态机与不变量。
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OwnerInputError } from './owner-store.mjs';
import { approveAndApplyPatch } from './patch-service.mjs';
import { approveSandboxRun, submitSandboxRun } from './sandbox-service.mjs';

export const SIDECAR_DEFAULT_PORT = 47830;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_ORIGIN_BYTES = 1024;
const ORIGIN_KEYS = new Set([
  'gatewayInstanceId',
  'sessionKey',
  'runId',
  'operatorId',
  'pluginVersion'
]);

/** sidecar token 的默认文件位置：与 Owner 数据库同目录。 */
export function sidecarTokenPath(dbPath = '') {
  if (process.env.OWNER_AGENT_SIDECAR_TOKEN_FILE) {
    return path.resolve(process.env.OWNER_AGENT_SIDECAR_TOKEN_FILE);
  }
  const dir = dbPath ? path.dirname(path.resolve(dbPath)) : path.join(os.homedir(), '.domain-context');
  return path.join(dir, 'sidecar.token');
}

/** 解析 token：显式参数 > 环境变量 > 已有文件 > 新建文件（0600）。 */
export function resolveSidecarToken({ dbPath = '', explicit = '' } = {}) {
  if (explicit) return explicit.trim();
  if (process.env.OWNER_AGENT_SIDECAR_TOKEN) return process.env.OWNER_AGENT_SIDECAR_TOKEN.trim();
  const file = sidecarTokenPath(dbPath);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch { /* 文件不存在时新建 */ }
  const token = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch { /* Windows 上是尽力而为 */ }
  return token;
}

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();

const tokenMatches = (header, token) => {
  const raw = typeof header === 'string' ? header : '';
  if (!raw.startsWith('Bearer ')) return false;
  const provided = raw.slice('Bearer '.length).trim();
  if (!provided) return false;
  // 先做等长摘要再比较，避免长度/前缀时序泄漏。
  return crypto.timingSafeEqual(digest(provided), digest(token));
};

const isLoopbackHost = (header, expectedPort) => {
  if (!header) return false;
  let parsed;
  try {
    parsed = new URL(`http://${header}`);
  } catch {
    return false;
  }
  const hostname = parsed.hostname;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) return false;
  if (expectedPort) {
    const port = parsed.port ? Number(parsed.port) : 80;
    if (port !== Number(expectedPort)) return false;
  }
  return true;
};

const isSameOrigin = (origin, expectedPort) => {
  // 非浏览器调用（插件后端）不会带 Origin；带了就必须是同源页面。
  if (!origin) return true;
  if (!expectedPort) return false;
  return [
    `http://127.0.0.1:${expectedPort}`,
    `http://localhost:${expectedPort}`,
    `http://[::1]:${expectedPort}`
  ].includes(origin);
};

const send = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
};

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      reject(new OwnerInputError('Request body is too large', 413));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

const readJson = async (req) => {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  const type = String(req.headers['content-type'] ?? '');
  if (!/^application\/json\b/i.test(type)) {
    throw new OwnerInputError('Content-Type must be application/json', 415);
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new OwnerInputError('Request body must be valid JSON', 400);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OwnerInputError('Request body must be a JSON object', 400);
  }
  return value;
};

const str = (value, name, max, required = true) => {
  if (value === undefined || value === null) {
    if (required) throw new OwnerInputError(`Missing ${name}`, 400);
    return '';
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new OwnerInputError(`Invalid ${name}`, 400);
  }
  return value;
};

const strList = (value, name, maxItems = 50) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new OwnerInputError(`Invalid ${name}`, 400);
  }
  return value.map((item) => str(item, name, 300));
};

const parseOrigin = (raw) => {
  if (!raw) return null;
  if (typeof raw !== 'string' || raw.length > MAX_ORIGIN_BYTES) {
    throw new OwnerInputError('X-Owner-Origin is too large', 400);
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new OwnerInputError('X-Owner-Origin must be JSON', 400);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OwnerInputError('X-Owner-Origin must be an object', 400);
  }
  const origin = {};
  for (const [key, item] of Object.entries(value)) {
    if (!ORIGIN_KEYS.has(key)) throw new OwnerInputError(`Unknown origin field: ${key}`, 400);
    if (item === null || item === undefined || item === '') continue;
    origin[key] = str(item, `origin.${key}`, 200);
  }
  if (Object.keys(origin).length === 0) throw new OwnerInputError('X-Owner-Origin is empty', 400);
  return origin;
};

const actorFrom = (origin) => {
  if (!origin) return 'openclaw';
  const who = origin.operatorId || 'operator';
  const session = origin.sessionKey ? `/${origin.sessionKey}` : '';
  return `openclaw:${who}${session}`.slice(0, 80);
};

const requireMethod = (actual, expected) => {
  if (actual !== expected) throw new OwnerInputError(`Method ${actual} is not allowed`, 405);
};

const limitOf = (url, fallback = 100) => {
  const raw = url.searchParams.get('limit');
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) {
    throw new OwnerInputError('Invalid limit', 400);
  }
  return value;
};

/**
 * 构建 sidecar 的 HTTP 处理器（便于单测直接使用）。
 *
 * @param {{store: object, brokerFactory: () => object, token: string, version?: string,
 *          imageDigest?: string, sandboxRoot?: string, getExpectedPort?: () => number|null}} options
 */
export function createSidecarHandler({
  store,
  brokerFactory,
  token,
  version = '1.0.0',
  imageDigest = '',
  sandboxRoot = '',
  getExpectedPort = () => null
} = {}) {
  if (!store) throw new Error('store is required');
  if (typeof brokerFactory !== 'function') throw new Error('brokerFactory is required');
  if (typeof token !== 'string' || token.length < 24) {
    throw new Error('sidecar token must be at least 24 characters');
  }

  let brokerInstance = null;
  const broker = () => {
    if (!brokerInstance) brokerInstance = brokerFactory();
    return brokerInstance;
  };

  const handle = async (req, res) => {
    const expectedPort = getExpectedPort();
    if (!isLoopbackHost(req.headers.host, expectedPort)) {
      send(res, 403, { error: 'Only loopback Host headers are accepted' });
      return;
    }
    if (!tokenMatches(req.headers.authorization, token)) {
      send(res, 401, { error: 'Unauthorized' });
      return;
    }
    if (!isSameOrigin(req.headers.origin, expectedPort)) {
      send(res, 403, { error: 'Cross-site requests are rejected' });
      return;
    }

    const url = new URL(req.url, 'http://127.0.0.1');
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (segments.length < 3 || segments[0] !== 'owner' || segments[1] !== 'v1') {
      send(res, 404, { error: 'Not found' });
      return;
    }
    const rest = segments.slice(2);
    const method = req.method || 'GET';
    const origin = parseOrigin(req.headers['x-owner-origin']);

    // 写操作成功后把来源写入 Owner 事件流；失败不阻断主操作。
    const audit = (projectId, action) => {
      if (!origin || !projectId) return;
      try {
        store.recordEvent({
          projectId,
          kind: 'api_call',
          note: `${action} ${method} ${url.pathname}`.slice(0, 300),
          origin
        });
      } catch (error) {
        console.error(`[sidecar] failed to record origin: ${error.message}`);
      }
    };

    const [head, id, action] = rest;

    if (rest.length === 1 && head === 'health') {
      requireMethod(method, 'GET');
      send(res, 200, {
        ok: true,
        version,
        pid: process.pid,
        db: store.dbPath ? path.basename(store.dbPath) : null,
        time: new Date().toISOString()
      });
      return;
    }

    if (rest.length === 1 && head === 'summary') {
      requireMethod(method, 'GET');
      send(res, 200, store.summary());
      return;
    }

    if (rest.length === 1 && head === 'projects') {
      requireMethod(method, 'GET');
      send(res, 200, { items: store.listProjects() });
      return;
    }

    if (rest.length === 1 && head === 'tasks') {
      requireMethod(method, 'GET');
      send(res, 200, { items: store.listTasks(url.searchParams.get('projectId') ?? '') });
      return;
    }

    if (rest.length === 1 && head === 'events') {
      requireMethod(method, 'GET');
      send(res, 200, {
        items: store.listEvents({
          projectId: url.searchParams.get('projectId') ?? '',
          limit: limitOf(url, 40)
        })
      });
      return;
    }

    if (rest.length === 1 && head === 'workspaces') {
      requireMethod(method, 'GET');
      send(res, 200, {
        items: store.listWorkspaces({
          projectId: url.searchParams.get('projectId') ?? '',
          status: url.searchParams.get('status') ?? '',
          limit: limitOf(url)
        })
      });
      return;
    }

    if (rest.length === 1 && head === 'jobs') {
      if (method === 'GET') {
        send(res, 200, {
          items: store.listJobs({
            projectId: url.searchParams.get('projectId') ?? '',
            status: url.searchParams.get('status') ?? '',
            limit: limitOf(url, 50)
          })
        });
        return;
      }
      requireMethod(method, 'POST');
      const body = await readJson(req);
      const job = store.createJob({
        projectId: str(body.projectId, 'projectId', 90),
        jobType: str(body.jobType, 'jobType', 40),
        title: str(body.title, 'title', 200, false) || 'Owner job',
        payload: body.payload ?? {},
        idempotencyKey: str(body.idempotencyKey, 'idempotencyKey', 89),
        ownerTaskId: body.ownerTaskId ? str(body.ownerTaskId, 'ownerTaskId', 90) : '',
        actor: actorFrom(origin)
      });
      audit(job.project_id, 'job.create');
      send(res, job.duplicate ? 200 : 201, job);
      return;
    }

    if (rest.length === 2 && head === 'jobs') {
      requireMethod(method, 'GET');
      const job = store.getJob(id);
      if (!job) throw new OwnerInputError('Unknown job', 404);
      send(res, 200, job);
      return;
    }

    if (rest.length === 3 && head === 'jobs' && action === 'approve') {
      requireMethod(method, 'POST');
      await readBody(req); // 拒绝意外的超大 body，同时允许空 body
      const job = store.approveJob(id, { actor: actorFrom(origin) });
      audit(job.project_id, 'job.approve');
      send(res, 200, job);
      return;
    }

    if (rest.length === 3 && head === 'jobs' && action === 'reject') {
      requireMethod(method, 'POST');
      const body = await readJson(req);
      const job = store.rejectJob(id, {
        actor: actorFrom(origin),
        reason: str(body.reason, 'reason', 500, false)
      });
      audit(job.project_id, 'job.reject');
      send(res, 200, job);
      return;
    }

    if (rest.length === 1 && head === 'patches') {
      requireMethod(method, 'GET');
      send(res, 200, {
        items: store.listPatchProposals({
          projectId: url.searchParams.get('projectId') ?? '',
          status: url.searchParams.get('status') ?? '',
          limit: limitOf(url)
        })
      });
      return;
    }

    if (rest.length === 2 && head === 'patches') {
      requireMethod(method, 'GET');
      const proposal = store.getPatchProposal(id);
      if (!proposal) throw new OwnerInputError('Unknown proposal', 404);
      const includeContent = url.searchParams.get('content') === '1';
      send(res, 200, {
        ...proposal,
        proposal_diff: store.getPatchArtifactContent(id, 'proposal_diff'),
        applied_diff: store.getPatchArtifactContent(id, 'applied_diff'),
        ...(includeContent
          ? { proposal_content: store.getPatchArtifactContent(id, 'proposal') }
          : {})
      });
      return;
    }

    if (rest.length === 3 && head === 'patches' && action === 'approve') {
      requireMethod(method, 'POST');
      const body = await readJson(req);
      const hash = str(body.hash, 'hash', 64);
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new OwnerInputError('hash must be 64 lowercase hex', 400);
      const proposal = store.getPatchProposal(id);
      if (!proposal) throw new OwnerInputError('Unknown proposal', 404);
      const result = await approveAndApplyPatch(store, broker(), {
        proposalId: id,
        hash,
        reviewer: actorFrom(origin)
      });
      audit(proposal.project_id, 'patch.approve');
      send(res, 200, result);
      return;
    }

    if (rest.length === 3 && head === 'patches' && action === 'reject') {
      requireMethod(method, 'POST');
      const body = await readJson(req);
      const proposal = store.getPatchProposal(id);
      if (!proposal) throw new OwnerInputError('Unknown proposal', 404);
      const result = store.rejectPatchProposal(id, {
        reason: str(body.reason, 'reason', 500, false),
        reviewer: actorFrom(origin)
      });
      audit(proposal.project_id, 'patch.reject');
      send(res, 200, result);
      return;
    }

    if (rest.length === 1 && head === 'repair-cycles') {
      requireMethod(method, 'GET');
      send(res, 200, {
        items: store.listRepairCycles({
          projectId: url.searchParams.get('projectId') ?? '',
          status: url.searchParams.get('status') ?? '',
          limit: limitOf(url)
        })
      });
      return;
    }

    if (rest.length === 2 && head === 'repair-cycles') {
      requireMethod(method, 'GET');
      const cycle = store.getRepairCycle(id);
      if (!cycle) throw new OwnerInputError('Unknown repair cycle', 404);
      send(res, 200, cycle);
      return;
    }

    if (rest.length === 3 && head === 'repair-cycles' && action === 'approve') {
      requireMethod(method, 'POST');
      const body = await readJson(req);
      const hash = str(body.hash, 'hash', 64);
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new OwnerInputError('hash must be 64 lowercase hex', 400);
      const { approveRepairCycle } = await import('./repair-service.mjs');
      const result = approveRepairCycle(store, {
        id,
        expectedHash: hash,
        actor: actorFrom(origin)
      });
      audit(result.project_id, 'repair.approve');
      send(res, 200, result);
      return;
    }

    if (rest.length === 1 && head === 'sandbox-runs') {
      if (method === 'GET') {
        send(res, 200, {
          items: store.listSandboxRuns({
            projectId: url.searchParams.get('projectId') ?? '',
            status: url.searchParams.get('status') ?? '',
            limit: limitOf(url)
          })
        });
        return;
      }
      requireMethod(method, 'POST');
      const body = await readJson(req);
      const run = await submitSandboxRun(store, broker(), {
        proposalId: str(body.proposalId, 'proposalId', 90),
        profileId: str(body.profile, 'profile', 40, false) || 'node-smoke',
        includePaths: strList(body.includePaths, 'includePaths'),
        imageDigest: str(body.imageDigest, 'imageDigest', 80, false) || imageDigest,
        repairCycleId: str(body.repairCycleId, 'repairCycleId', 90, false),
        sandboxRoot
      });
      audit(run.project_id, 'sandbox.submit');
      send(res, 201, run);
      return;
    }

    if (rest.length === 2 && head === 'sandbox-runs') {
      requireMethod(method, 'GET');
      const run = store.getSandboxRun(id);
      if (!run) throw new OwnerInputError('Unknown sandbox run', 404);
      const includeLogs = url.searchParams.get('logs') === '1';
      send(res, 200, includeLogs
        ? {
          ...run,
          stdout: store.getSandboxEvidence(id, 'stdout')?.content ?? '',
          stderr: store.getSandboxEvidence(id, 'stderr')?.content ?? ''
        }
        : run);
      return;
    }

    if (rest.length === 3 && head === 'sandbox-runs' && action === 'approve') {
      requireMethod(method, 'POST');
      const body = await readJson(req);
      const hash = str(body.hash, 'hash', 64);
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new OwnerInputError('hash must be 64 lowercase hex', 400);
      const run = approveSandboxRun(store, { runId: id, hash, actor: actorFrom(origin) });
      audit(run.project_id, 'sandbox.approve');
      send(res, 200, run);
      return;
    }

    send(res, 404, { error: 'Not found' });
  };

  return (req, res) => {
    handle(req, res).catch((error) => {
      const status = error instanceof OwnerInputError ? error.status : 500;
      if (!res.headersSent) send(res, status, { error: error.message });
      else res.destroy();
    });
  };
}

/**
 * 启动 sidecar。只允许绑定 127.0.0.1。
 *
 * @returns {Promise<{server: import('node:http').Server, host: string, port: number,
 *                    close: () => Promise<void>}>}
 */
export async function startSidecar({
  store,
  brokerFactory,
  token,
  host = '127.0.0.1',
  port = SIDECAR_DEFAULT_PORT,
  version = '1.0.0',
  imageDigest = '',
  sandboxRoot = ''
} = {}) {
  if (host !== '127.0.0.1') throw new OwnerInputError('Sidecar may only bind to 127.0.0.1');
  const state = { port: 0 };
  const handler = createSidecarHandler({
    store,
    brokerFactory,
    token,
    version,
    imageDigest,
    sandboxRoot,
    getExpectedPort: () => state.port || null
  });
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
  state.port = server.address().port;
  return {
    server,
    host,
    port: state.port,
    close: () => new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    })
  };
}
