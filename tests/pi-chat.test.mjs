// 对话模式只读会话：提示词、工具面二次核对、路径引用核验与失败分类。
// 全部用可注入的假 SDK / 假会话，不联网、不调用真实模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CHAT_TOOLS,
  PiChatService,
  assertChatToolSurface,
  buildChatPrompt,
  composeChatAnswer,
  createChatSessionFactory,
  verifyChatCitations
} from '../src/pi-chat.mjs';

const makeProject = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-project-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'retry.js'), 'export const attempts = 7;\n', 'utf8');
  fs.writeFileSync(path.join(root, 'README.md'), '# demo\n', 'utf8');
  return { id: 'demo', root };
};

const makeAdapter = ({
  answer = '',
  activeTools = [...CHAT_TOOLS],
  lastMessage = null,
  hang = false,
  promptHook = null,
  state = {}
} = {}) => {
  state.disposed = 0;
  state.aborted = 0;
  return {
    sessionId: () => 'chat-session',
    prompt: async (value) => {
      promptHook?.(value);
      if (hang) return new Promise(() => {});
      return undefined;
    },
    abort: () => { state.aborted += 1; },
    activeTools: () => [...activeTools],
    lastMessage: () => lastMessage,
    getLastText: () => answer,
    model: 'fake/model',
    dispose: () => { state.disposed += 1; }
  };
};

const fakeService = (adapter, options = {}) => {
  const state = { created: 0, prompts: [] };
  const factory = {
    async create() {
      state.created += 1;
      if (options.throwOnCreate) throw options.throwOnCreate;
      return typeof adapter === 'function' ? adapter(state) : adapter;
    }
  };
  const service = new PiChatService({
    sessionFactory: factory,
    timeoutMs: options.timeoutMs ?? 1000,
    logger: { error: () => {} }
  });
  return { service, state };
};

test('对话提示词包含项目边界、只读约束与路径引用格式', () => {
  const prompt = buildChatPrompt({
    project: { id: 'demo', root: 'D:\\demo' },
    question: '这个项目为什么卡住？'
  });
  assert.match(prompt, /D:\\demo/u);
  assert.match(prompt, /这个项目为什么卡住/u);
  assert.match(prompt, /只能读/u);
  assert.match(prompt, /read\/grep\/find\/ls/u);
  assert.match(prompt, /src\/app\.mjs:12/u);
});

test('路径引用核验：只认项目内真实存在的相对路径', () => {
  const project = makeProject();
  const { citations, missing } = verifyChatCitations(project.root, [
    '默认 attempts 在 `src/retry.js:1`，`README.md` 也提到 demo。',
    '另一个文件 docs/missing.md 不存在，Node.js 不是路径，../../etc/passwd 越界。'
  ].join('\n'));
  assert.deepEqual(citations, [
    { path: 'src/retry.js', line: 1 },
    { path: 'README.md', line: 0 }
  ]);
  assert.deepEqual(missing, ['docs/missing.md']);
});

test('回答拼装：未找到的路径必须显式提醒', () => {
  const answer = composeChatAnswer('结论见 src/retry.js。', ['docs/missing.md']);
  assert.match(answer, /结论见 src\/retry\.js/u);
  assert.match(answer, /没有找到/u);
  assert.match(answer, /docs\/missing\.md/u);
  assert.equal(composeChatAnswer('ok', []), 'ok');
});

const fakeSdk = (rawSession, seen = {}) => ({
  DefaultResourceLoader: class {
    constructor(options) { seen.loader = options; }
    async reload() { seen.reloaded = true; }
  },
  SessionManager: { inMemory: () => ({ kind: 'memory' }) },
  createAgentSession: async (options) => {
    seen.options = options;
    return { session: rawSession };
  }
});

const rawSession = ({ tools = [...CHAT_TOOLS], text = 'ok', dispose } = {}) => {
  let disposed = false;
  return {
    sessionId: 'raw-session',
    model: { provider: 'fake', id: 'model' },
    messages: [{ role: 'assistant', stopReason: 'end', content: [{ type: 'text', text }] }],
    prompt: async () => {},
    abort: () => {},
    getActiveToolNames: () => [...tools],
    getLastAssistantText: () => text,
    dispose: () => { disposed = true; dispose?.(); },
    get disposed() { return disposed; }
  };
};

test('会话工厂只注册只读工具并做二次核对', async () => {
  const project = makeProject();
  const seen = {};
  const raw = rawSession();
  const factory = createChatSessionFactory({
    loadSdk: async () => fakeSdk(raw, seen)
  });
  const session = await factory.create({ cwd: project.root, model: 'fake/model' });
  assert.deepEqual(seen.options.tools, ['read', 'grep', 'find', 'ls']);
  assert.deepEqual(seen.options.excludeTools, ['write', 'edit', 'bash', 'powershell']);
  assert.equal(seen.options.cwd, project.root);
  assert.equal(seen.loader.noExtensions, true);
  assert.equal(seen.loader.noContextFiles, true);
  assert.deepEqual(session.activeTools(), [...CHAT_TOOLS]);
  session.dispose();
  assert.equal(raw.disposed, true);
});

test('工具面越权或无法枚举时直接中止并释放会话', async () => {
  const project = makeProject();
  const raw = rawSession({ tools: ['read', 'write'] });
  const factory = createChatSessionFactory({ loadSdk: async () => fakeSdk(raw) });
  await assert.rejects(
    () => factory.create({ cwd: project.root, model: 'fake/model' }),
    /chat-tools-violation: write/u
  );
  assert.equal(raw.disposed, true);

  const unenumerable = { prompt: async () => {}, dispose() {} };
  assert.throws(() => assertChatToolSurface(unenumerable), /chat-tools-unverified/u);
});

test('没有模型时不创建会话，返回明确提示', async () => {
  const project = makeProject();
  const { service, state } = fakeService(makeAdapter({ answer: '不该被调用' }));
  const result = await service.ask({ project, question: '这是怎么回事？', model: '  ' });
  assert.equal(result.status, 'error');
  assert.equal(result.category, 'no-model');
  assert.match(result.answer, /还没有配置模型/u);
  assert.equal(state.created, 0);
});

test('提问读文件后返回结论，并只把存在的路径列为引用', async () => {
  const project = makeProject();
  const { service, state } = fakeService(() => makeAdapter({
    answer: '常量 attempts 在 src/retry.js:1；docs/missing.md 不存在。',
    promptHook: (value) => state.prompts.push(value)
  }));
  const result = await service.ask({ project, question: '默认重试几次？', model: 'fake/model' });
  assert.equal(result.status, 'ok');
  assert.match(state.prompts[0], /默认重试几次/u);
  assert.deepEqual(result.citations, [{ path: 'src/retry.js', line: 1 }]);
  assert.deepEqual(result.missingCitations, ['docs/missing.md']);
  assert.match(result.answer, /请谨慎采信/u);
  assert.deepEqual(result.tools, ['read', 'grep', 'find', 'ls']);

  // 同一项目的第二次追问复用同一个会话。
  const second = await service.ask({ project, question: '还有别的吗？', model: 'fake/model' });
  assert.equal(second.status, 'ok');
  assert.equal(state.created, 1);
  service.disposeAll();
});

test('服务层再次核对工具面：注入的会话越权也会中止', async () => {
  const project = makeProject();
  const adapterState = {};
  const adapter = makeAdapter({ answer: 'ok', activeTools: ['read', 'bash'], state: adapterState });
  const { service } = fakeService(adapter);
  const result = await service.ask({ project, question: '看看', model: 'fake/model' });
  assert.equal(result.status, 'error');
  assert.equal(result.category, 'readonly-violation');
  assert.match(result.answer, /只读工具校验失败/u);
  assert.equal(adapterState.disposed, 1);
});

test('上游错误与空回答都映射成受控分类', async () => {
  const project = makeProject();
  const quota = fakeService(makeAdapter({
    answer: '',
    lastMessage: { stopReason: 'error', errorMessage: '429 quota exceeded' }
  }));
  const quotaResult = await quota.service.ask({ project, question: '看看', model: 'fake/model' });
  assert.equal(quotaResult.status, 'error');
  assert.equal(quotaResult.category, 'quota-exceeded');

  const empty = fakeService(makeAdapter({ answer: '   ' }));
  const emptyResult = await empty.service.ask({ project, question: '看看', model: 'fake/model' });
  assert.equal(emptyResult.status, 'error');
  assert.equal(emptyResult.category, 'empty-response');

  const auth = fakeService(makeAdapter({ answer: '' }), {
    throwOnCreate: new Error('No API key found for undefined')
  });
  const authResult = await auth.service.ask({ project, question: '看看', model: 'fake/model' });
  assert.equal(authResult.status, 'error');
  assert.equal(authResult.category, 'auth-error');
});

test('超时后中止并释放会话，不把挂起会话留在内存', async () => {
  const project = makeProject();
  const adapterState = {};
  const { service } = fakeService(
    () => makeAdapter({ hang: true, state: adapterState }),
    { timeoutMs: 30 }
  );
  const result = await service.ask({ project, question: '慢慢看', model: 'fake/model' });
  assert.equal(result.status, 'error');
  assert.equal(result.category, 'timeout');
  assert.equal(adapterState.aborted, 1);
  assert.equal(adapterState.disposed, 1);
  assert.equal(service.sessions.size, 0);
});

test('没有项目或问题为空时给出可执行提示', async () => {
  const { service } = fakeService(makeAdapter({ answer: 'ok' }));
  const noProject = await service.ask({ project: null, question: '看看', model: 'fake/model' });
  assert.equal(noProject.category, 'no-project');
  const project = makeProject();
  const empty = await service.ask({ project, question: '   ', model: 'fake/model' });
  assert.equal(empty.category, 'empty-question');
});

test('历史只作为续聊上下文进入提示词，不伪装成新问题', () => {
  const prompt = buildChatPrompt({
    project: { id: 'demo', root: 'D:\\demo' },
    question: '那第二处呢？',
    history: [
      { role: 'user', text: '这个项目为什么卡住' },
      { role: 'assistant', text: '重试循环少跑了一次' }
    ]
  });
  assert.match(prompt, /本会话之前的对话/u);
  assert.match(prompt, /Owner：这个项目为什么卡住/u);
  assert.match(prompt, /你：重试循环少跑了一次/u);
  assert.match(prompt, /Owner 的问题：那第二处呢/u);
});

test('不同会话各自持有进程内 Pi 会话，同一会话继续复用', async () => {
  const project = makeProject();
  const { service, state } = fakeService(() => makeAdapter({ answer: 'ok' }));
  await service.ask({ project, question: '第一问', model: 'fake/model', sessionId: 'chat_a' });
  await service.ask({ project, question: '继续问', model: 'fake/model', sessionId: 'chat_a' });
  assert.equal(state.created, 1);
  await service.ask({ project, question: '另一个会话', model: 'fake/model', sessionId: 'chat_b' });
  assert.equal(state.created, 2);
  service.disposeAll();
});

test('只有新建的 Pi 会话才注入落库历史，活会话不重复带上下文', async () => {
  const project = makeProject();
  const prompts = [];
  const { service } = fakeService(() => makeAdapter({
    answer: 'ok',
    promptHook: (value) => prompts.push(value),
    state: {}
  }));
  const history = [{ role: 'user', text: '更早的问题' }];
  await service.ask({ project, question: '第一问', model: 'fake/model', sessionId: 'chat_h', history });
  assert.match(prompts[0], /更早的问题/u);
  await service.ask({ project, question: '第二问', model: 'fake/model', sessionId: 'chat_h', history });
  assert.doesNotMatch(prompts[1], /更早的问题/u);
  service.disposeAll();
});
