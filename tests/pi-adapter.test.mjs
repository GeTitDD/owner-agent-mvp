import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerPiDomainContext } from '../adapters/pi/extension.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const Type = {
  Object: (fields, options) => ({ type: 'object', fields, ...options }),
  String: (opts) => ({ type: 'string', ...opts }),
  Integer: (opts) => ({ type: 'integer', ...opts }),
  Optional: (schema) => ({ ...schema, optional: true })
};

function makeMockPi() {
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const pi = {
    on(name, callback) { handlers.set(name, callback); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); }
  };
  return { pi, handlers, tools, commands };
}

async function init(mock, name = 'payment-service') {
  await registerPiDomainContext(mock.pi, { dbPath: ':memory:', Type });
  const cwd = path.join(ROOT, 'examples', name);
  const context = {
    cwd,
    sessionManager: { getSessionId: () => 'test-session' },
    getSystemPrompt: () => 'Pi default system instructions',
    hasUI: true,
    ui: { notify() {} }
  };
  await mock.handlers.get('session_start')({ reason: 'startup' }, context);
  return context;
}

test('Pi exposes Skill paths and domain_recall tool', async () => {
  const mock = makeMockPi();
  const ctx = await init(mock);
  const resources = await mock.handlers.get('resources_discover')({ reason: 'startup' }, ctx);
  assert.equal(resources.skillPaths.length, 1);
  const result = await mock.tools.get('domain_recall').execute('call-1', { query: 'idempotency' }, new AbortController().signal);
  assert.match(result.content[0].text, /Idempotency for retryable writes/);
  await mock.handlers.get('session_shutdown')({}, ctx);
});

test('Pi new structured sections preserve original prompt and split stable and task context', async () => {
  const mock = makeMockPi();
  const ctx = await init(mock);
  const event = { messageType: 'user', prompt: 'fix payment retry', systemPrompt: 'base', systemPromptOptions: { sections: {} } };
  const result = await mock.handlers.get('before_agent_start')(event, ctx);
  assert.equal(result, undefined);
  assert.match(event.systemPromptOptions.sections.domain_context_stable, /Shared Domain Context/);
  assert.match(event.systemPromptOptions.sections.domain_context_task, /payment-service/);
  const original = event.systemPromptOptions.sections.domain_context_stable;
  const second = { messageType: 'user', prompt: 'fix payment retry', systemPrompt: 'base', systemPromptOptions: { sections: {} } };
  await mock.handlers.get('before_agent_start')(second, ctx);
  assert.equal(second.systemPromptOptions.sections.domain_context_stable, original);
  await mock.handlers.get('session_shutdown')({}, ctx);
});

test('Pi older API falls back to bounded, non-duplicating prompt block', async () => {
  const mock = makeMockPi();
  const ctx = await init(mock);
  const handler = mock.handlers.get('before_agent_start');
  const first = await handler({ prompt: 'worker lease', systemPrompt: 'original system' }, ctx);
  assert.match(first.systemPrompt, /<domain_context_extension>/);
  const second = await handler({ prompt: 'worker lease', systemPrompt: first.systemPrompt }, ctx);
  assert.equal((second.systemPrompt.match(/<domain_context_extension>/g) ?? []).length, 1);
  await mock.handlers.get('session_shutdown')({}, ctx);
});

test('Pi custom-triggered agent run does not inject stale user task context', async () => {
  const mock = makeMockPi();
  const ctx = await init(mock);
  const event = { messageType: 'custom', systemPrompt: 'base', systemPromptOptions: { sections: {} } };
  const result = await mock.handlers.get('before_agent_start')(event, ctx);
  assert.equal(result, undefined);
  assert.equal(Object.keys(event.systemPromptOptions.sections).length, 0);
  await mock.handlers.get('session_shutdown')({}, ctx);
});

test('Pi agent_settled captures metadata-only trace, never prompt or tool payloads', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const { createDomainEngine } = await import('../src/engine.mjs');
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'pi-evolution-'));
  const filename = path.join(tmp, 'context.sqlite');
  try {
    const mock = makeMockPi();
    await registerPiDomainContext(mock.pi, { dbPath: filename, Type });
    const ctx = {
      cwd: path.join(ROOT, 'examples', 'payment-service'),
      sessionManager: { getSessionId: () => 'session-p2', getLeafId: () => 'leaf-p2' },
      getSystemPrompt: () => 'example prompt', hasUI: false
    };
    await mock.handlers.get('session_start')({}, ctx);
    await mock.handlers.get('agent_start')({}, ctx);
    await mock.handlers.get('tool_execution_end')({
      toolCallId: 'tool-1', toolName: 'bash', args: { password: 'plaintextArgDontPersist' },
      result: { content: [{ type: 'text', text: 'privateOutputDontPersist' }] }, isError: false, durationMs: 18
    }, ctx);
    await mock.handlers.get('agent_settled')({ aborted: false }, ctx);
    await mock.handlers.get('session_shutdown')({}, ctx);
    const engine = createDomainEngine({ dbPath: filename });
    try {
      const runs = engine.evolution.listRuns('payment-service');
      assert.equal(runs.length, 1);
      assert.equal(runs[0].branch_leaf_id, 'leaf-p2');
      assert.equal(runs[0].status, 'settled');
      const trace = engine.evolution.getRunTrace(runs[0].id);
      assert.equal(trace.tools.length, 1);
      assert.equal(trace.tools[0].tool_name, 'bash');
      assert.doesNotMatch(JSON.stringify(trace), /plaintextArgDontPersist|privateOutputDontPersist/);
    } finally { engine.close(); }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
