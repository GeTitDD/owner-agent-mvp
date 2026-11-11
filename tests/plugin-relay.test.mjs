// Relay 插件 worker：消息流水、转交游标与历史记录的 RPC 契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKER = path.join(ROOT, 'plugins', 'cindy-relay', 'node', 'worker.cjs');

const setup = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-relay-'));
  const child = spawn(process.execPath, [WORKER], {
    env: { ...process.env, CINDY_RELAY_DIR: path.join(dir, 'data') },
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
    }, 15000);
    waiting.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return {
    dir,
    rpc,
    async cleanup() {
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
};

test('relay：记录消息、按游标取新增、转交后归零', async () => {
  const env = await setup();
  try {
    const sessionId = 'session-a';
    await env.rpc('relay/messages/append', { sessionId, role: 'user', text: '缓存层要不要拆成单独模块？' });
    await env.rpc('relay/messages/append', { sessionId, role: 'assistant', text: '用一份共享 cache.json，读写放一个模块。', model: 'gpt-6.1-sol' });

    const before = await env.rpc('relay/sessions/state', { sessionId });
    assert.equal(before.exists, true);
    assert.equal(before.pending.length, 2);
    assert.equal(before.lastRelayAt, '');
    assert.match(before.label, /缓存层/u);

    const marked = await env.rpc('relay/relays/mark', {
      sessionId,
      target: { kind: 'project', id: 'D:\\demo', label: 'demo' },
      note: '看第 2 条',
      chars: 120,
      taskId: 'task-1',
      requestKey: 'req-1'
    });
    assert.equal(marked.ok, true);
    assert.equal(marked.relay.chars, 120);

    const cleared = await env.rpc('relay/sessions/state', { sessionId });
    assert.equal(cleared.pending.length, 0);
    assert.ok(cleared.lastRelayAt);

    await env.rpc('relay/messages/append', { sessionId, role: 'user', text: '再加一把写锁。' });
    const after = await env.rpc('relay/sessions/state', { sessionId });
    assert.equal(after.pending.length, 1);
    assert.match(after.pending[0].text, /写锁/u);

    const all = await env.rpc('relay/sessions/all', { sessionId });
    assert.equal(all.messages.length, 3);
  } finally {
    await env.cleanup();
  }
});

test('relay：重复 messageId 幂等、空消息忽略、偏好可存', async () => {
  const env = await setup();
  try {
    const sessionId = 'session-b';
    const first = await env.rpc('relay/messages/append', {
      sessionId, role: 'user', text: '你好', messageId: 'm-1'
    });
    assert.equal(first.ok, true);
    const again = await env.rpc('relay/messages/append', {
      sessionId, role: 'user', text: '你好', messageId: 'm-1'
    });
    assert.equal(again.duplicated, true);

    const blank = await env.rpc('relay/messages/append', { sessionId, role: 'user', text: '   ' });
    assert.equal(blank.ok, false);

    const prefs = await env.rpc('relay/prefs/set', {
      patch: { targetKind: 'task', permissionMode: 'auto' }
    });
    assert.equal(prefs.prefs.targetKind, 'task');
    const read = await env.rpc('relay/prefs/get');
    assert.equal(read.prefs.permissionMode, 'auto');

    const sessions = await env.rpc('relay/sessions/list');
    assert.equal(sessions.sessions.length, 1);
    assert.equal(sessions.sessions[0].total, 1);

    const cleared = await env.rpc('relay/sessions/clear', { sessionId });
    assert.equal(cleared.ok, true);
    const state = await env.rpc('relay/sessions/state', { sessionId });
    assert.equal(state.total, 0);
    assert.equal(state.pending.length, 0);
  } finally {
    await env.cleanup();
  }
});

test('relay：转交历史按时间倒序保留', async () => {
  const env = await setup();
  try {
    await env.rpc('relay/messages/append', { sessionId: 's1', role: 'user', text: '一' });
    await env.rpc('relay/relays/mark', { sessionId: 's1', target: { kind: 'task', id: 't1', label: '任务一' }, chars: 1 });
    await env.rpc('relay/messages/append', { sessionId: 's2', role: 'user', text: '二' });
    await env.rpc('relay/relays/mark', { sessionId: 's2', target: { kind: 'bot', id: 'b1', label: '伙伴一' }, chars: 1 });

    const relays = await env.rpc('relay/relays/list', { limit: 10 });
    assert.equal(relays.relays.length, 2);
    assert.equal(relays.relays[0].target.label, '伙伴一');
    assert.equal(relays.relays[1].target.label, '任务一');
  } finally {
    await env.cleanup();
  }
});
