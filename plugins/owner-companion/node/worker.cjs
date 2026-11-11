// Owner Companion 插件的 Node 工作进程。
//
// 职责：把 Cindy 沙箱页面转来的请求，用本机 HTTP 发给桌面端的 mobile bridge。
// 页面与 main.js 都没有直连网络；只有这里是真正发请求的地方。
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const CONFIG_DIR = process.env.OWNER_COMPANION_DIR
  ? path.resolve(process.env.OWNER_COMPANION_DIR)
  : path.join(os.homedir(), '.owner-companion');
const CONFIG_FILE = path.join(CONFIG_DIR, 'plugin.json');
const DEFAULT_BASE = 'http://127.0.0.1:47831';

const readConfig = () => {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return {
      baseUrl: String(raw.baseUrl || DEFAULT_BASE).replace(/\/+$/u, ''),
      token: String(raw.token || '')
    };
  } catch {
    return { baseUrl: DEFAULT_BASE, token: '' };
  }
};

const saveConfig = (config) => {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* Windows 尽力而为 */ }
};

const request = (config, method, route, body, timeoutMs = 20000) => new Promise((resolve, reject) => {
  let url;
  try { url = new URL(`${config.baseUrl}${route}`); } catch { reject(new Error('地址不合法')); return; }
  const client = url.protocol === 'https:' ? https : http;
  const payload = body === undefined ? '' : JSON.stringify(body);
  const req = client.request({
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    method,
    headers: {
      ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      ...(config.token ? { authorization: `Bearer ${config.token}` } : {})
    },
    timeout: timeoutMs
  }, (res) => {
    let raw = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { raw += chunk; });
    res.on('end', () => {
      let data = null;
      try { data = raw ? JSON.parse(raw) : null; } catch { data = { error: raw.slice(0, 300) }; }
      if (res.statusCode >= 400) {
        reject(new Error(String(data?.error ?? `HTTP ${res.statusCode}`)));
        return;
      }
      resolve(data);
    });
  });
  req.on('timeout', () => req.destroy(new Error('请求超时')));
  req.on('error', (error) => reject(new Error(String(error?.message ?? error))));
  if (payload) req.write(payload);
  req.end();
});

const requireToken = (config) => {
  if (!config.token) throw new Error('还没有配对：请在插件设置里填写地址和 6 位配对码');
};

// 聊天是长任务：单次 Node RPC 最多 20 秒，所以拆成 start + poll。
const chatJobs = new Map();
const CHAT_JOB_TTL_MS = 15 * 60 * 1000;

const pruneChatJobs = () => {
  const now = Date.now();
  for (const [id, job] of chatJobs) {
    if (now - job.startedAt > CHAT_JOB_TTL_MS) chatJobs.delete(id);
  }
};

const startChatJob = (config, projectId, text) => {
  pruneChatJobs();
  const jobId = `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const job = { status: 'pending', startedAt: Date.now(), result: null, error: '' };
  chatJobs.set(jobId, job);
  request(config, 'POST', '/m/chat', { projectId, text }, 200000)
    .then((result) => {
      job.status = 'done';
      job.result = result;
    })
    .catch((error) => {
      job.status = 'error';
      job.error = String(error?.message ?? error);
    });
  return { jobId };
};

const pollChatJob = (jobId) => {
  const job = chatJobs.get(jobId);
  if (!job) throw new Error('找不到这次分析，请重试');
  if (job.status === 'pending') return { status: 'pending' };
  if (job.status === 'error') {
    chatJobs.delete(jobId);
    return { status: 'error', error: job.error };
  }
  const result = job.result;
  chatJobs.delete(jobId);
  return { status: 'done', result };
};

const methods = {
  async 'owner/status'(params) {
    const config = readConfig();
    const baseUrl = params?.baseUrl ? String(params.baseUrl).replace(/\/+$/u, '') : config.baseUrl;
    const probe = { ...config, baseUrl };
    try {
      const health = await request(probe, 'GET', '/m/health', undefined, 5000);
      return { ok: true, paired: Boolean(config.token), baseUrl: config.baseUrl, version: health.version };
    } catch (error) {
      return { ok: false, paired: Boolean(config.token), baseUrl: config.baseUrl, error: String(error.message ?? error) };
    }
  },

  async 'owner/pair'(params) {
    const baseUrl = String(params?.baseUrl || DEFAULT_BASE).trim().replace(/\/+$/u, '');
    const code = String(params?.code || '').trim();
    if (!/^\d{6}$/u.test(code)) throw new Error('配对码是 6 位数字');
    const result = await request({ baseUrl, token: '' }, 'POST', '/m/pair', {
      code,
      deviceName: 'Cindy 插件'
    }, 15000);
    if (!result?.token) throw new Error('配对失败：没有拿到设备令牌');
    saveConfig({ baseUrl, token: result.token });
    return { ok: true, baseUrl, version: result.version };
  },

  async 'owner/overview'(params) {
    const config = readConfig();
    requireToken(config);
    const projectId = String(params?.projectId || '');
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return request(config, 'GET', `/m/overview${query}`);
  },

  async 'owner/chat/start'(params) {
    const config = readConfig();
    requireToken(config);
    const projectId = String(params?.projectId || '');
    const text = String(params?.text || '').trim();
    if (!projectId || !text) throw new Error('缺少项目或内容');
    return startChatJob(config, projectId, text);
  },

  async 'owner/chat/poll'(params) {
    return pollChatJob(String(params?.jobId || ''));
  },

  async 'owner/ideas/add'(params) {
    const config = readConfig();
    requireToken(config);
    return request(config, 'POST', '/m/ideas', {
      projectId: String(params?.projectId || ''),
      title: String(params?.title || '').trim()
    });
  },

  async 'owner/ideas/status'(params) {
    const config = readConfig();
    requireToken(config);
    const id = encodeURIComponent(String(params?.id || ''));
    return request(config, 'PATCH', `/m/ideas/${id}`, { status: String(params?.status || 'todo') });
  },

  async 'owner/ideas/remove'(params) {
    const config = readConfig();
    requireToken(config);
    const id = encodeURIComponent(String(params?.id || ''));
    return request(config, 'DELETE', `/m/ideas/${id}`);
  }
};

const reply = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let request_;
  try {
    request_ = JSON.parse(line);
  } catch {
    return;
  }
  const handler = methods[request_?.method];
  if (!handler) {
    reply({ jsonrpc: '2.0', id: request_.id, error: { code: -32601, message: 'Method not found' } });
    return;
  }
  try {
    const result = await handler(request_.params ?? {});
    reply({ jsonrpc: '2.0', id: request_.id, result });
  } catch (error) {
    reply({
      jsonrpc: '2.0',
      id: request_.id,
      error: { code: -32000, message: String(error?.message ?? error) }
    });
  }
});
