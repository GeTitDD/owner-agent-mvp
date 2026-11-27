// 使用已安装的真实 SDK 和隔离模型目录，验证 provider/model 不会退化成 undefined/undefined。
// 不读取真实凭据、不联网；模型定义与目录全部来自临时夹具。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as sdk from '@earendil-works/pi-coding-agent';
import { createChatSessionFactory } from '../src/pi-chat.mjs';
import { PiChatService } from '../src/pi-chat.mjs';
import { resolvePiModel, piAgentDir } from '../src/pi-model-catalog.mjs';
import { seedModelFixture, startModelFixture } from '../scripts/e2e/lib/model-fixture.mjs';

test('配置的自定义模型交给真实 SDK 后仍保留正确 provider 与 model', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-model-selection-'));
  const modelsPath = path.join(root, 'models.json');
  fs.writeFileSync(modelsPath, JSON.stringify({ providers: {
    'fixture-local': { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'not-a-real-key', models: [{
      id: 'check', name: 'Local Check', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024
    }] }
  } }));
  const runtime = await sdk.ModelRuntime.create({ modelsPath, modelsStorePath: path.join(root, 'models-store.json'),
    authPath: path.join(root, 'auth.json'), allowModelNetwork: false });
  let session;
  try {
    const model = runtime.getModel('fixture-local', 'check');
    assert.equal(model?.provider, 'fixture-local', '真实 SDK 已能读取夹具模型');
    const factory = createChatSessionFactory({ skills: [], loadSdk: async () => ({ ...sdk,
      ModelRuntime: { create: async () => runtime },
      createAgentSession: (options) => sdk.createAgentSession({ ...options, modelRuntime: runtime })
    }) });
    session = await factory.create({ cwd: root, model: 'fixture-local/check' });
    assert.equal(session.model, 'fixture-local/check');
  } finally {
    session?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('真实 SDK 从隔离目录选择模型，经本机 HTTP 返回成功和鉴权错误，保留只读工具约束', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-model-http-'));
  const server = await startModelFixture();
  const dir = path.join(root, 'agent');
  seedModelFixture(dir, server.baseUrl);
  const runtime = await sdk.ModelRuntime.create({ modelsPath: path.join(dir, 'models.json'),
    modelsStorePath: path.join(dir, 'models-store.json'), authPath: path.join(dir, 'auth.json'), allowModelNetwork: false });
  const factory = createChatSessionFactory({ skills: [], loadSdk: async () => ({ ...sdk,
    ModelRuntime: { create: async () => runtime }
  }) });
  const service = new PiChatService({ sessionFactory: factory, timeoutMs: 10000, logger: { error: () => {} } });
  try {
    const input = { project: { id: 'fixture', root }, model: 'fixture-local/check', question: '只回复连接状态。' };
    const ok = await service.ask(input);
    assert.equal(ok.status, 'ok', ok.answer);
    assert.match(ok.answer, /模型连接正常/);
    assert.equal(ok.model, 'fixture-local/check');
    assert.ok(server.requests.every((request) => request.path === '/v1/chat/completions'));
    server.setMode('auth');
    const failure = await service.ask({ ...input, sessionId: 'another-session' });
    assert.equal(failure.status, 'error');
    assert.equal(failure.category, 'auth-error');
  } finally {
    service.disposeAll();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('模型目录与运行时目录同源，未知模型在发出请求前被明确拒绝', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-model-unknown-'));
  try {
    assert.equal(piAgentDir({ env: { OWNER_AGENT_PI_HOME: root } }), path.join(root, 'agent'));
    assert.equal(piAgentDir({ env: { PI_CODING_AGENT_DIR: root } }), root);
    await assert.rejects(resolvePiModel('bad-format'), { category: 'unknown-model' });
    await assert.rejects(resolvePiModel('fixture-local/missing', { env: { OWNER_AGENT_PI_HOME: root } }), { category: 'unknown-model' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
