// Cindy 插件后端：Node worker 与本机 mobile bridge 的契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { OwnerStore } from '../src/owner-store.mjs';
import { startMobileServer } from '../src/mobile-server.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKER = path.join(ROOT, 'plugins', 'owner-companion', 'node', 'worker.cjs');

const setup = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-plugin-'));
  const projectRoot = path.join(dir, 'demo');
  fs.mkdirSync(projectRoot, { recursive: true });
  const store = new OwnerStore(path.join(dir, 'owner.sqlite'));
  store.registerProject({ id: 'demo', name: 'Demo', root: projectRoot });
  const server = await startMobileServer({
    store,
    stateDir: path.join(dir, 'userdata'),
    host: '127.0.0.1',
    port: 0,
    getOverview: async () => ({
      activeProjectId: 'demo',
      projects: [{ id: 'demo', name: 'Demo' }],
      ideas: [],
      knowledge: {}
    }),
    submitChat: async ({ text }) => ({ mode: 'answer', summary: `收到：${text}` })
  });

  const child = spawn(process.execPath, [WORKER], {
    env: { ...process.env, OWNER_COMPANION_DIR: path.join(dir, 'plugin') },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const lines = readline.createInterface({ input: child.stdout });
  const waiting = new Map();
  let nextId = 0;
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const entry = waiting.get(message.id);
    if (!entry) return;
    waiting.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });

  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      if (!waiting.has(id)) return;
      waiting.delete(id);
      reject(new Error(`worker timeout: ${method}`));
    }, 20000);
    waiting.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  return {
    dir,
    server,
    rpc,
    async cleanup() {
      child.kill();
      await server.close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
};

test('插件 worker：未配对提示、配对、概览、聊天与想法', async () => {
  const env = await setup();
  try {
    const before = await env.rpc('owner/status', {});
    assert.equal(before.paired, false);

    const baseUrl = `http://127.0.0.1:${env.server.port}`;
    const { code } = env.server.pairingCode();
    const paired = await env.rpc('owner/pair', { baseUrl, code });
    assert.equal(paired.ok, true);

    const after = await env.rpc('owner/status', {});
    assert.equal(after.paired, true);
    assert.equal(after.baseUrl, baseUrl);

    const overview = await env.rpc('owner/overview', { projectId: 'demo' });
    assert.equal(overview.activeProjectId, 'demo');
    assert.equal(overview.projects.length, 1);

    const chatStarted = await env.rpc('owner/chat/start', { projectId: 'demo', text: '进度如何' });
    assert.ok(chatStarted.jobId);
    let chat = { status: 'pending' };
    for (let i = 0; i < 50 && chat.status === 'pending'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      chat = await env.rpc('owner/chat/poll', { jobId: chatStarted.jobId });
    }
    assert.equal(chat.status, 'done');
    assert.equal(chat.result.mode, 'answer');
    assert.equal(chat.result.summary, '收到：进度如何');

    const idea = await env.rpc('owner/ideas/add', { projectId: 'demo', title: '加一个导出按钮' });
    assert.equal(idea.kind, 'idea');

    const adopted = await env.rpc('owner/ideas/status', { id: idea.id, status: 'done' });
    assert.equal(adopted.status, 'done');

    const removed = await env.rpc('owner/ideas/remove', { id: idea.id });
    assert.equal(removed.removed, idea.id);
  } finally {
    await env.cleanup();
  }
});

test('插件 worker：配对码错误时返回可读错误', async () => {
  const env = await setup();
  try {
    const baseUrl = `http://127.0.0.1:${env.server.port}`;
    await assert.rejects(
      () => env.rpc('owner/pair', { baseUrl, code: '000000' }),
      /配对码无效|配对失败/u
    );
  } finally {
    await env.cleanup();
  }
});
