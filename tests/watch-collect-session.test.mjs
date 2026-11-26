// #120 会话采集器：只从水位之后数新消息；只读会话文件，不改写对方会话。
// 假读取器注入，真实文件读取另有一条端到端用例（临时目录里的 Codex 会话布局），
// 用来证明「读完之后文件字节与修改时间都没变」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectSession, findSessionFile } from '../src/watch/collect-session.mjs';
import { WatchTargetError } from '../src/watch/target.mjs';

const codexRow = (role, text, at) => JSON.stringify({
  type: 'response_item',
  timestamp: at,
  payload: { type: 'message', role, content: [{ type: 'input_text', text }] }
});

const claudeRow = (role, text, at) => JSON.stringify({
  type: role,
  timestamp: at,
  message: { content: [{ type: 'text', text }] }
});

const target = { type: 'session', source: 'codex', sessionId: 'abc123' };

/** 注入用的假依赖：记下查询参数，读取返回固定文本。 */
const fakeDeps = (text, file = '/sessions/rollout-abc123.jsonl') => {
  const queries = [];
  const reads = [];
  return {
    queries,
    reads,
    deps: {
      findSessionFile: async (query) => {
        queries.push(query);
        return file ? { file, mtimeMs: 1, size: text.length } : null;
      },
      readFile: async (readPath) => {
        reads.push(readPath);
        return text;
      }
    }
  };
};

test('水位之后的消息才计数，结果只带角色与时间，不搬运正文', async () => {
  const rows = [
    codexRow('user', '早先那句', '2026-11-01T00:00:00.000Z'),
    codexRow('assistant', '中间那句', '2026-11-01T01:00:00.000Z'),
    codexRow('user', '最新那句', '2026-11-01T02:00:00.000Z')
  ].join('\n');
  const { deps, queries, reads } = fakeDeps(rows);

  const result = await collectSession(target, {
    since: '2026-11-01T00:00:00.000Z',
    now: new Date('2026-11-01T03:00:00.000Z'),
    deps
  });

  assert.deepEqual(queries, [{ source: 'codex', sessionId: 'abc123' }]);
  assert.deepEqual(reads, ['/sessions/rollout-abc123.jsonl']);
  assert.equal(result.status, 'ok');
  assert.equal(result.type, 'session');
  assert.equal(result.ref, 'session:codex:abc123');
  assert.equal(result.error, null);
  assert.equal(result.cursor, '2026-11-01T03:00:00.000Z');
  assert.deepEqual(result.items, [
    { kind: 'message', role: 'assistant', at: '2026-11-01T01:00:00.000Z' },
    { kind: 'message', role: 'user', at: '2026-11-01T02:00:00.000Z' }
  ]);
  const serialised = JSON.stringify(result.items);
  assert.ok(!serialised.includes('早先那句'), '采集不搬运会话正文');
  assert.ok(!serialised.includes('最新那句'), '采集不搬运会话正文');
});

test('没有水位（首次心跳）：读到的消息都算新，游标给出本次快照时刻', async () => {
  const rows = [
    claudeRow('user', '第一句', '2026-11-01T00:00:00.000Z'),
    claudeRow('assistant', '第二句', '2026-11-01T00:10:00.000Z')
  ].join('\n');
  const { deps } = fakeDeps(rows);

  const result = await collectSession({ type: 'session', source: 'claude', sessionId: 's1' }, {
    now: new Date('2026-11-01T00:20:00.000Z'),
    deps
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items[0], { kind: 'message', role: 'user', at: '2026-11-01T00:00:00.000Z' });
});

test('找不到会话文件：返回错误并写明来源与会话 id', async () => {
  const { deps } = fakeDeps('', null);

  const result = await collectSession(target, { deps });

  assert.equal(result.status, 'error');
  assert.deepEqual(result.items, []);
  assert.equal(result.cursor, null);
  assert.equal(result.error.code, 'session-not-found');
  assert.match(result.error.message, /codex/u);
  assert.match(result.error.message, /abc123/u);
});

test('会话文件读不出来：错误里带原因，不吞成 0 条新消息', async () => {
  const deps = {
    findSessionFile: async () => '/sessions/rollout-abc123.jsonl',
    readFile: async () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    }
  };

  const result = await collectSession(target, { deps });

  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'session-unreadable');
  assert.match(result.error.message, /EACCES/u);
  assert.deepEqual(result.items, []);
});

test('JSONL 半行（写到一半）跳过，不让整段会话作废', async () => {
  const rows = [
    codexRow('user', '完整一句', '2026-11-01T00:00:00.000Z'),
    codexRow('assistant', '完整二句', '2026-11-01T01:00:00.000Z'),
    '{"type":"response_item","timestamp":"2026-11-01T02:00:00.000Z","payload":{"ty'
  ].join('\n');
  const { deps } = fakeDeps(rows);

  const result = await collectSession(target, {
    since: '2026-10-31T00:00:00.000Z',
    now: new Date('2026-11-01T03:00:00.000Z'),
    deps
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.items.length, 2);
  assert.ok(result.items.every((item) => item.at.startsWith('2026-11-01T0')));
});

test('行上没有时间戳：不能证明它早于水位，按新消息算，时间留空', async () => {
  const rows = [
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '没有时间' }] } }),
    claudeRow('assistant', '有时间', '2026-11-01T00:00:00.000Z')
  ].join('\n');
  const { deps } = fakeDeps(rows);

  const result = await collectSession({ type: 'session', source: 'claude', sessionId: 's2' }, {
    since: '2026-11-02T00:00:00.000Z',
    now: new Date('2026-11-03T00:00:00.000Z'),
    deps
  });

  assert.equal(result.status, 'ok');
  // 有时间的那条早于水位被滤掉；没时间的那条保留，时间为空。
  assert.deepEqual(result.items, [{ kind: 'message', role: 'user', at: '' }]);
});

test('默认查找器按 Codex 目录布局找到会话，端到端读完后文件一字不动', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-session-'));
  const dir = path.join(home, '.codex', 'sessions', '2026', '11', '25');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'rollout-2026-11-25T10-00-00-abc123.jsonl');
  const rows = [
    codexRow('user', '你好', '2026-11-25T02:00:00.000Z'),
    codexRow('assistant', '在', '2026-11-25T02:00:05.000Z')
  ].join('\n');
  fs.writeFileSync(file, rows);

  const before = { text: fs.readFileSync(file, 'utf8'), mtimeMs: fs.statSync(file).mtimeMs, size: fs.statSync(file).size };
  const listingBefore = fs.readdirSync(dir).sort();

  const found = await findSessionFile({
    source: 'codex',
    sessionId: 'abc123',
    roots: [{ source: 'codex', dir: path.join(home, '.codex', 'sessions') }]
  });
  assert.equal(found.file, file);

  const result = await collectSession(target, {
    since: '2026-11-25T00:00:00.000Z',
    now: new Date('2026-11-25T03:00:00.000Z'),
    deps: { homeDir: home, env: {} }
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.items.length, 2);
  assert.deepEqual({
    text: fs.readFileSync(file, 'utf8'),
    mtimeMs: fs.statSync(file).mtimeMs,
    size: fs.statSync(file).size
  }, before);
  assert.deepEqual(fs.readdirSync(dir).sort(), listingBefore);
});

test('采集器只接受会话对象：传错类型明确拒绝', async () => {
  await assert.rejects(
    () => collectSession({ type: 'project', projectId: 'alpha' }, {}),
    (error) => {
      assert.ok(error instanceof WatchTargetError);
      assert.equal(error.code, 'target-type-mismatch');
      assert.match(error.message, /session/u);
      return true;
    }
  );
});
