// 手机端（iOS/Android）局域网桥：给 Expo 客户端提供一套带设备令牌的只读 + 想法 API。
//
// 设计取舍：
// - 桌面 sidecar 只允许 127.0.0.1；手机必须走局域网，所以单独开一个端口，默认 47831。
// - 首次连接用 6 位配对码换长期设备令牌；令牌只保存 SHA-256，明文只在配对响应里出现一次。
// - 手机端 v1 只能：看项目/画像/想法/知识摘要、聊天（只读分析）、管理想法。
//   审批、写文件、执行 Job 一律不开放，避免拿到手机就拿到写权限。
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OwnerInputError } from './owner-store.mjs';

export const MOBILE_DEFAULT_PORT = 47831;
const MAX_BODY_BYTES = 96 * 1024;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const PAIR_ATTEMPT_WINDOW_MS = 60 * 1000;
const PAIR_ATTEMPT_LIMIT = 8;
const IDEA_STATUSES = new Set(['todo', 'doing', 'blocked', 'done', 'failed']);

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-max-age': '86400'
};

const send = (res, status, value) => {
  const body = JSON.stringify(value ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...corsHeaders
  });
  res.end(body);
};

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      reject(new OwnerInputError('Request body too large', 413));
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
  if (!/^application\/json\b/iu.test(String(req.headers['content-type'] ?? ''))) {
    throw new OwnerInputError('Content-Type must be application/json', 415);
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new OwnerInputError('Body must be valid JSON', 400);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OwnerInputError('Body must be a JSON object', 400);
  }
  return value;
};

const str = (value, name, max, required = true) => {
  if (value === undefined || value === null) {
    if (required) throw new OwnerInputError(`Missing ${name}`, 400);
    return '';
  }
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new OwnerInputError(`Invalid ${name}`, 400);
  }
  return value.trim();
};

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** 设备令牌仓库：只在磁盘上保存哈希。 */
export const createDeviceStore = (stateDir) => {
  const file = path.join(stateDir, 'mobile-devices.json');
  let devices = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') devices = raw;
  } catch { /* 首次运行没有文件 */ }

  const persist = () => {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(devices, null, 2), { mode: 0o600 });
    } catch { /* 写失败不影响内存态 */ }
  };

  return {
    file,
    issue(name = 'iPhone') {
      const token = crypto.randomBytes(32).toString('base64url');
      const id = crypto.randomUUID();
      devices[hashToken(token)] = {
        id,
        name: String(name).slice(0, 60) || 'iPhone',
        createdAt: new Date().toISOString()
      };
      persist();
      return { token, deviceId: id };
    },
    verify(token) {
      if (!token) return null;
      return devices[hashToken(token)] ?? null;
    },
    revoke(token) {
      const key = hashToken(token);
      if (!devices[key]) return false;
      delete devices[key];
      persist();
      return true;
    },
    list() {
      return Object.values(devices).map((device) => ({ ...device }));
    }
  };
};

/** 6 位配对码：内存态，10 分钟有效，配对成功后立即作废。 */
export const createPairing = ({ ttlMs = PAIRING_TTL_MS, now = () => Date.now() } = {}) => {
  let current = null;
  const attempts = new Map();

  const issue = () => {
    current = {
      code: String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'),
      expiresAt: now() + ttlMs
    };
    return { ...current };
  };

  return {
    issue,
    current() {
      if (!current || current.expiresAt <= now()) return issue();
      return { ...current };
    },
    /** 返回 'ok' | 'expired' | 'mismatch' | 'throttled' */
    verify(code, ip = '') {
      const stamp = now();
      const record = attempts.get(ip) ?? { at: stamp, count: 0 };
      if (stamp - record.at > PAIR_ATTEMPT_WINDOW_MS) {
        record.at = stamp;
        record.count = 0;
      }
      record.count += 1;
      attempts.set(ip, record);
      if (record.count > PAIR_ATTEMPT_LIMIT) return 'throttled';
      if (!current || current.expiresAt <= stamp) return 'expired';
      if (String(code ?? '').trim() !== current.code) return 'mismatch';
      current = null;
      return 'ok';
    }
  };
};

const VIRTUAL_INTERFACE = /(?:vEthernet|WSL|Hyper-V|VirtualBox|VMware|Docker|Loopback|Tailscale|ZeroTier|utun|aliyun)/iu;

const lanUrls = (port) => {
  const candidates = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      candidates.push({ name, address: entry.address });
    }
  }
  const rank = (address) => {
    if (address.startsWith('192.168.')) return 0;
    if (address.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./u.test(address)) return 2;
    return 3;
  };
  const physical = candidates.filter((item) => !VIRTUAL_INTERFACE.test(item.name));
  const pool = physical.length ? physical : candidates;
  return pool
    .sort((a, b) => rank(a.address) - rank(b.address))
    .map((item) => ({ interface: item.name, url: `http://${item.address}:${port}` }));
};

const attemptKey = (req) => String(req.socket.remoteAddress ?? '');

/**
 * @param {object} options
 * @param {object} options.store OwnerStore
 * @param {(input: {projectId: string}) => Promise<object>} options.getOverview
 * @param {(input: {projectId: string, text: string}) => Promise<object>} options.submitChat
 * @param {string} options.stateDir 设备令牌存放目录（通常是 userData）
 */
export async function startMobileServer({
  store,
  getOverview,
  submitChat,
  stateDir,
  host = '0.0.0.0',
  port = MOBILE_DEFAULT_PORT,
  version = '1.0.0'
} = {}) {
  if (!store) throw new Error('store is required');
  const devices = createDeviceStore(stateDir);
  const pairing = createPairing();
  const state = { port: 0 };

  const handle = async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const route = url.pathname.replace(/\/+$/u, '') || '/';
      const method = req.method ?? 'GET';

      if (method === 'GET' && route === '/m/health') {
        send(res, 200, { ok: true, name: 'Owner Companion Mobile Bridge', version });
        return;
      }

      if (method === 'POST' && route === '/m/pair') {
        const body = await readJson(req);
        const result = pairing.verify(body.code, attemptKey(req));
        if (result === 'throttled') throw new OwnerInputError('尝试过多，请稍后再试', 429);
        if (result !== 'ok') throw new OwnerInputError('配对码无效或已过期', 401);
        const issued = devices.issue(str(body.deviceName, 'deviceName', 60, false) || 'iPhone');
        send(res, 200, { ...issued, version });
        return;
      }

      // 其余接口一律验设备令牌。
      const header = String(req.headers.authorization ?? '');
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (!devices.verify(token)) throw new OwnerInputError('Unauthorized', 401);

      if (method === 'GET' && route === '/m/ping') {
        send(res, 200, { ok: true, time: new Date().toISOString() });
        return;
      }

      if (method === 'GET' && route === '/m/overview') {
        const projectId = url.searchParams.get('projectId') ?? '';
        send(res, 200, await getOverview({ projectId, device: devices.verify(token) }));
        return;
      }

      if (method === 'POST' && route === '/m/chat') {
        const body = await readJson(req);
        const projectId = str(body.projectId, 'projectId', 90);
        const text = str(body.text, 'text', 1200);
        send(res, 200, await submitChat({ projectId, text }));
        return;
      }

      if (method === 'POST' && route === '/m/ideas') {
        const body = await readJson(req);
        const projectId = str(body.projectId, 'projectId', 90);
        const title = str(body.title, 'title', 300);
        send(res, 201, store.addProjectQueueItem({
          projectId, title, kind: 'idea', body: String(body.body ?? ''), source: 'mobile'
        }));
        return;
      }

      const ideaMatch = /^\/m\/ideas\/([^/]+)$/u.exec(route);
      if (ideaMatch && method === 'PATCH') {
        const body = await readJson(req);
        const status = str(body.status, 'status', 20);
        if (!IDEA_STATUSES.has(status)) throw new OwnerInputError('Invalid status', 400);
        send(res, 200, store.updateProjectQueueItem(decodeURIComponent(ideaMatch[1]), { status }));
        return;
      }
      if (ideaMatch && method === 'DELETE') {
        send(res, 200, store.removeProjectQueueItem(decodeURIComponent(ideaMatch[1])));
        return;
      }

      throw new OwnerInputError('Not found', 404);
    } catch (error) {
      const status = Number(error?.status) >= 400 ? Number(error.status) : 500;
      send(res, status, { error: String(error?.message ?? error).slice(0, 300) });
    }
  };

  const server = http.createServer((req, res) => { void handle(req, res); });
  await new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
  state.port = server.address().port;

  return {
    port: state.port,
    host,
    urls: lanUrls(state.port),
    pairingCode: () => pairing.current(),
    refreshCode: () => pairing.issue(),
    devices: () => devices.list(),
    revoke: (token) => devices.revoke(token),
    close: () => new Promise((resolve) => {
      if (!server.listening) { resolve(); return; }
      server.close(() => resolve());
    })
  };
}
