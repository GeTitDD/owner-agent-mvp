// Owner Agent sidecar：给 OpenClaw 插件与 Control UI 使用的本机 HTTP 适配层。
//
// 授权模型（v1.1，对应 PR #17 第一轮 Review）：
// - 读取令牌（sidecar.token）：GET、提交 Job、创建沙箱运行。插件后端持有。
// - 审批令牌（approval.token）：所有 approve / apply / reject 决策。**插件后端不读取**，
//   只由操作员在 Control UI 中粘贴，浏览器直接调用 sidecar。这样即使模型工具能读到
//   读取令牌，也无法单独完成审批。
// - 审计：审批决策与业务状态变更写在同一事务（OwnerStore.insertDecisionAudit）；
//   自报的 X-Owner-Origin 标记为 claimed，不当作已验证身份。
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { OwnerInputError } from './owner-store.mjs';
import { applyApprovedPatch } from './patch-service.mjs';
import { approveRepairCycle, submitRepairCycle } from './repair-service.mjs';
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

const defaultStateDir = (dbPath = '') =>
  dbPath ? path.dirname(path.resolve(dbPath)) : path.join(os.homedir(), '.domain-context');

/** 读取令牌：插件后端使用，只允许读取与非审批提交。 */
export function sidecarTokenPath(dbPath = '') {
  if (process.env.OWNER_AGENT_SIDECAR_TOKEN_FILE) {
    return path.resolve(process.env.OWNER_AGENT_SIDECAR_TOKEN_FILE);
  }
  return path.join(defaultStateDir(dbPath), 'sidecar.token');
}

/** 审批令牌：操作员使用，绝不进入插件进程。 */
export function approvalTokenPath(dbPath = '') {
  if (process.env.OWNER_AGENT_APPROVAL_TOKEN_FILE) {
    return path.resolve(process.env.OWNER_AGENT_APPROVAL_TOKEN_FILE);
  }
  return path.join(defaultStateDir(dbPath), 'approval.token');
}

const readOrCreateToken = (file, envValue) => {
  if (envValue) return envValue.trim();
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
};

/** 解析读取令牌：显式参数 > 环境变量 > 已有文件 > 新建文件（0600）。 */
export function resolveSidecarToken({ dbPath = '', explicit = '' } = {}) {
  if (explicit) return explicit.trim();
  return readOrCreateToken(
    sidecarTokenPath(dbPath),
    process.env.OWNER_AGENT_SIDECAR_TOKEN
  );
}

/** 解析审批令牌。插件不应调用这个函数。 */
export function resolveApprovalToken({ dbPath = '', explicit = '' } = {}) {
  if (explicit) return explicit.trim();
  return readOrCreateToken(
    approvalTokenPath(dbPath),
    process.env.OWNER_AGENT_APPROVAL_TOKEN
  );
}

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();

const tokenMatches = (header, token) => {
  const raw = typeof header === 'string' ? header : '';
  if (!raw.startsWith('Bearer ')) return false;
  const provided = raw.slice('Bearer '.length).trim();
  if (!provided) return false;
  return crypto.timingSafeEqual(digest(provided), digest(token));
};

const tokenValueMatches = (value, token) => {
  if (typeof value !== 'string' || !value) return false;
  return crypto.timingSafeEqual(digest(value.trim()), digest(token));
};

const isLoopbackHost = (header, expectedPort) => {
  if (!header) return false;
  let parsed;
  try {
    parsed = new URL(`http://${header}`);
  } catch {
    return false;
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return false;
  if (expectedPort) {
    const port = parsed.port ? Number(parsed.port) : 80;
    if (port !== Number(expectedPort)) return false;
  }
  return true;
};

/** 只允许本机 Control UI 跨域调用 sidecar。 */
const isLoopbackOrigin = (origin) => {
  if (typeof origin !== 'string' || !origin) return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
};

const applyCors = (res, origin) => {
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'Origin');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'access-control-allow-headers',
    'authorization,content-type,x-owner-origin,x-owner-approval-token'
  );
  res.setHeader('access-control-max-age', '600');
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

const actorFrom = (origin, principalKind = 'approval-token') => {
  const who = origin?.operatorId || 'owner';
  const session = origin?.sessionKey ? `/${origin.sessionKey}` : '';
  return `${principalKind}:${who}${session}`.slice(0, 80);
};

/** 审批决策审计：principal 是令牌持有者，origin 只是自报线索。 */
const decisionAudit = (origin) => ({
  principal: { kind: 'approval-token', id: 'owner' },
  claimedOrigin: origin,
  originTrust: 'claimed'
});

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

/** 读取项目当前 HEAD，供对话创建 code-patch Job 使用。 */
const baseShaOf = (root) => {
  try {
    const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return /^[0-9a-f]{40}$/u.test(sha) ? sha : '';
  } catch {
    return '';
  }
};

/** 这些路径是“决策”，必须使用审批令牌，读取令牌无效。 */
const isDecisionRoute = (rest, method) => {
  if (method !== 'POST' || rest.length !== 3) return false;
  const [head, , action] = rest;
  if (head === 'jobs') return action === 'approve' || action === 'reject';
  if (head === 'patches') return ['approve', 'apply', 'reject'].includes(action);
  if (head === 'repair-cycles') return action === 'approve';
  if (head === 'sandbox-runs') return action === 'approve';
  return false;
};

/**
 * 构建 sidecar 的 HTTP 处理器（便于单测直接使用）。
 *
 * @param {{store: object, brokerFactory: () => object, token: string,
 *          approvalToken?: string|null, version?: string, imageDigest?: string,
 *          sandboxRoot?: string, getExpectedPort?: () => number|null}} options
 */
export function createSidecarHandler({
  store,
  brokerFactory,
  token,
  approvalToken = null,
  worker = null,
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
    const requestOrigin = req.headers.origin;
    if (requestOrigin && !isLoopbackOrigin(requestOrigin)) {
      send(res, 403, { error: 'Only loopback browser origins are accepted' });
      return;
    }
    if (requestOrigin) applyCors(res, requestOrigin);

    const method = req.method || 'GET';
    if (method === 'OPTIONS') {
      // 预检请求不带 Authorization，必须在鉴权前处理。
      res.writeHead(204);
      res.end();
      return;
    }

    const expectedPort = getExpectedPort();
    if (!isLoopbackHost(req.headers.host, expectedPort)) {
      send(res, 403, { error: 'Only loopback Host headers are accepted' });
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (segments.length < 3 || segments[0] !== 'owner' || segments[1] !== 'v1') {
      send(res, 404, { error: 'Not found' });
      return;
    }
    const rest = segments.slice(2);
    const decision = isDecisionRoute(rest, method);

    if (decision) {
      // 审批只认审批令牌；读取令牌（插件后端持有）不能替代。
      if (!approvalToken) {
        send(res, 503, {
          error: 'Approval token is not configured; run `ownerctl serve` to create one'
        });
        return;
      }
      if (!tokenValueMatches(req.headers['x-owner-approval-token'], approvalToken)) {
        send(res, 403, { error: 'Approval token is required for decisions' });
        return;
      }
    } else if (!tokenMatches(req.headers.authorization, token)) {
      send(res, 401, { error: 'Unauthorized' });
      return;
    }

    // 写操作必须声明来源；缺失即失败（fail closed）。来源仍标记为 claimed。
    const origin = parseOrigin(req.headers['x-owner-origin']);
    if (method === 'POST' && !origin) {
      throw new OwnerInputError('X-Owner-Origin is required for mutations', 400);
    }

    const audit = decisionAudit(origin);
    const [head, id, action] = rest;

    // 读取/提交类操作保留一条补充事件；决策的权威审计在业务事务内。
    const noteCall = (projectId, actionName) => {
      if (!origin || !projectId) return;
      try {
        store.recordEvent({
          projectId,
          kind: 'api_call',
          note: `${actionName} ${method} ${url.pathname}`.slice(0, 300),
          origin
        });
      } catch (error) {
        console.error(`[sidecar] failed to record api_call: ${error.message}`);
      }
    };

    if (rest.length === 1 && head === 'health') {
      requireMethod(method, 'GET');
      send(res, 200, {
        ok: true,
        version,
        pid: process.pid,
        db: store.dbPath ? path.basename(store.dbPath) : null,
        approvalMode: approvalToken ? 'token' : 'unconfigured',
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
      send(res, 200, {
        items: store.listProjects().map((project) => ({
          ...project,
          baseSha: baseShaOf(project.root)
        }))
      });
      return;
    }

    if (rest.length === 3 && head === 'projects' && rest[2] === 'brief') {
      const projectId = rest[1];
      if (method === 'GET') {
        send(res, 200, store.getProjectBrief(projectId) ?? null);
        return;
      }
      requireMethod(method, 'PUT');
      const body = await readJson(req);
      const saved = store.saveProjectBrief({
        projectId,
        payload: body.payload,
        basedOnCommit: body.basedOnCommit ?? '',
        sourceRunId: body.sourceRunId ?? ''
      });
      send(res, 200, saved);
      return;
    }

    if (rest.length === 1 && head === 'tasks') {
      if (method === 'GET') {
        send(res, 200, { items: store.listTasks(url.searchParams.get('projectId') ?? '') });
        return;
      }
      requireMethod(method, 'POST');
      const body = await readJson(req);
      const task = store.createTask({
        projectId: str(body.projectId, 'projectId', 90),
        title: str(body.title, 'title', 200)
      });
      noteCall(task.project_id, 'task.create');
      send(res, 201, task);
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

    if (rest.length === 1 && head === 'decisions') {
      requireMethod(method, 'GET');
      send(res, 200, {
        items: store.listDecisionAudit({
          subjectType: url.searchParams.get('subjectType') ?? '',
          subjectId: url.searchParams.get('subjectId') ?? '',
          limit: limitOf(url, 50)
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
        actor: actorFrom(origin, 'openclaw')
      });
      noteCall(job.project_id, 'job.create');
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
      await readBody(req);
      const job = store.approveJob(id, { actor: actorFrom(origin), audit });
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

    // 审批与应用分离：approve 只冻结批准，不写文件；apply 必须再带同一个 hash。
    if (rest.length === 3 && head === 'patches' && action === 'approve') {
      requireMethod(method, 'POST');
      const body = await readJson(req);
      const hash = str(body.hash, 'hash', 64);
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new OwnerInputError('hash must be 64 lowercase hex', 400);
      const proposal = store.approvePatchProposal(id, {
        expectedHash: hash,
        reviewer: actorFrom(origin),
        audit
      });
      send(res, 200, { proposal, applied: false });
      return;
    }

    if (rest.length === 3 && head === 'patches' && action === 'apply') {
      requireMethod(method, 'POST');
      const body = await readJson(req);
      const hash = str(body.hash, 'hash', 64);
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new OwnerInputError('hash must be 64 lowercase hex', 400);
      const proposal = store.getPatchProposal(id);
      if (!proposal) throw new OwnerInputError('Unknown proposal', 404);
      const result = await applyApprovedPatch(store, broker(), { proposalId: id, hash });
      noteCall(proposal.project_id, 'patch.apply');
      send(res, 200, { ...result, applied: result.outcome === 'applied' });
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
      send(res, 200, result);
      return;
    }

    if (rest.length === 1 && head === 'repair-cycles') {
      if (method === 'GET') {
        send(res, 200, {
          items: store.listRepairCycles({
            projectId: url.searchParams.get('projectId') ?? '',
            status: url.searchParams.get('status') ?? '',
            limit: limitOf(url)
          })
        });
        return;
      }
      requireMethod(method, 'POST');
      const body = await readJson(req);
      const runId = str(body.sandboxRunId, 'sandboxRunId', 90);
      const run = store.getSandboxRun(runId);
      if (!run) throw new OwnerInputError('Unknown sandbox run', 404);
      const proposal = store.getPatchProposal(run.proposal_id);
      if (!proposal) throw new OwnerInputError('Source proposal is missing', 404);
      // getPatchProposal 返回解析后的 allowedPaths（数组）；不要再用原始 JSON 字符串。
      const allowed = Array.isArray(proposal.allowedPaths)
        ? proposal.allowedPaths
        : String(proposal.allowedPaths ?? proposal.allowed_paths ?? '')
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean);
      const scope = Array.isArray(body.scope) ? strList(body.scope, 'scope', 5) : allowed;
      if (scope.length === 0) throw new OwnerInputError('Repair scope is required', 400);
      const cycle = submitRepairCycle(store, {
        sandboxRunId: runId,
        scope,
        idempotencyKey: str(body.idempotencyKey, 'idempotencyKey', 89)
      });
      noteCall(run.project_id, 'repair.submit');
      send(res, cycle.duplicate ? 200 : 201, cycle);
      return;
    }

    if (rest.length === 2 && head === 'worker' && id === 'status') {
      requireMethod(method, 'GET');
      send(res, 200, worker
        ? { configured: true, ...worker.status() }
        : { configured: false, running: false, current: null, last: null });
      return;
    }

    if (rest.length === 2 && head === 'worker' && id === 'tick') {
      requireMethod(method, 'POST');
      const body = await readJson(req);
      if (!worker) throw new OwnerInputError('Worker is not configured on this sidecar', 503);
      const result = worker.start({
        projectId: str(body.projectId, 'projectId', 90, false),
        wait: false
      });
      noteCall('', 'worker.tick');
      send(res, 202, { ...result, status: worker.status() });
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
      const result = approveRepairCycle(store, {
        id,
        expectedHash: hash,
        actor: actorFrom(origin),
        audit
      });
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
        projectDir: str(body.projectDir, 'projectDir', 120, false) || '',
        repairCycleId: str(body.repairCycleId, 'repairCycleId', 90, false),
        sandboxRoot
      });
      noteCall(run.project_id, 'sandbox.submit');
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
          stderr: store.getSandboxEvidence(id, 'stderr')?.content ?? '',
          result: store.getSandboxEvidence(id, 'result')?.content ?? ''
        }
        : run);
      return;
    }

    if (rest.length === 3 && head === 'sandbox-runs' && action === 'approve') {
      requireMethod(method, 'POST');
      const body = await readJson(req);
      const hash = str(body.hash, 'hash', 64);
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new OwnerInputError('hash must be 64 lowercase hex', 400);
      const run = approveSandboxRun(store, {
        runId: id,
        hash,
        actor: actorFrom(origin),
        audit
      });
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
  approvalToken = null,
  worker = null,
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
    approvalToken,
    worker,
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
