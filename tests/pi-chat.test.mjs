// 对话模式只读会话：提示词、工具面二次核对、路径引用核验与失败分类。
// 全部用可注入的假 SDK / 假会话，不联网、不调用真实模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CHAT_TOOLS,
  DEFAULT_SKILL_IDS,
  PiChatService,
  assertChatToolSurface,
  buildChatPrompt,
  buildSkillSection,
  composeChatAnswer,
  createChatSessionFactory,
  createSkillTool,
  forwardChatEvent,
  parseSkillCommand,
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

test('保存新模型不会中断正在回答的旧模型，旧会话在回答结束后释放', async () => {
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const began = new Promise((resolve) => { started = resolve; });
  let disposed = 0;
  const adapter = { ...makeAdapter({ answer: '旧回答完整结束' }),
    prompt: async () => { started(); await gate; }, dispose: () => { disposed += 1; } };
  const { service } = fakeService(adapter);
  const request = service.ask({ project: { id: 'alpha', root: os.tmpdir() }, model: 'fixture/old', question: '继续回答' });
  await began;
  try {
    service.setModel('fixture/new');
    assert.equal(disposed, 0, '正在回答的会话必须保留到这次回答结束');
    release();
    assert.equal((await request).status, 'ok');
    assert.equal(disposed, 1);
  } finally { release(); await request; service.disposeAll(); }
});

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
  ModelRuntime: { create: async () => ({ getModel: (provider, id) => ({ provider, id }) }) },
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
  assert.deepEqual(seen.options.tools, ['read', 'grep', 'find', 'ls', 'skill']);
  assert.deepEqual(seen.options.excludeTools, ['write', 'edit', 'bash', 'powershell']);
  // 技能正文靠自定义只读工具取，不走 SDK 原生技能加载（保持会话隔离）。
  assert.equal(seen.options.customTools.length, 1);
  assert.equal(seen.options.customTools[0].name, 'skill');
  assert.equal(seen.options.cwd, project.root);
  assert.equal(seen.loader.noExtensions, true);
  assert.equal(seen.loader.noContextFiles, true);
  assert.equal(seen.loader.noSkills, true);
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
  assert.deepEqual(result.tools, ['read', 'grep', 'find', 'ls', 'skill']);

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

// ── 技能：索引里谁详写、谁只能显式调用、正文怎么取 ─────────────

const fakeSkills = () => ([
  { id: 'diagnosing-bugs', name: 'diagnosing-bugs', description: '查为什么坏', path: '', origin: 'engineering' },
  { id: 'how', name: 'how', description: '这段代码怎么工作', path: '', origin: 'pstack' },
  { id: 'why', name: 'why', description: '为什么这么设计', path: '', origin: 'pstack' },
  { id: 'poteto-mode', name: 'poteto-mode', description: '分阶段交付工作流', path: '', origin: 'pstack' },
  { id: 'tdd', name: 'tdd', description: '测试先行', path: '', origin: 'pstack' },
  { id: 'to-spec', name: 'to-spec', description: '把想法写成规格', path: '', origin: 'engineering' }
]);

test('技能索引：隐式集合详写，其余一律只能显式调用（不分来源）', () => {
  const lines = buildSkillSection(fakeSkills()).join('\n');
  assert.match(lines, /^- how：/mu);
  assert.match(lines, /^- why：/mu);
  // 隐式之外的全部——包括 matt 来源的 to-spec——都只能点名
  assert.match(lines, /只能显式调用（3 个/u);
  assert.match(lines, /- pstack: poteto-mode, tdd/u);
  assert.match(lines, /- engineering: to-spec/u);
});

test('隐式集合可配置：只详写配置里的那几个', () => {
  const lines = buildSkillSection(fakeSkills(), ['how', 'to-spec']).join('\n');
  assert.match(lines, /^- how：/mu);
  assert.match(lines, /^- to-spec：/mu);
  assert.doesNotMatch(lines, /^- why：/mu);
  assert.match(lines, /只能显式调用（4 个/u);
});

test('/skill:id 解析：命中注入正文，写错报错并列出可用 id', async () => {
  assert.deepEqual(parseSkillCommand('/skill:tdd 给支付加测试'), { id: 'tdd', question: '给支付加测试' });
  assert.equal(parseSkillCommand('普通问题'), null);
  assert.equal(parseSkillCommand('/skill:tdd'), null);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-fs-'));
  const bodyFile = path.join(root, 'tdd', 'SKILL.md');
  fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
  fs.writeFileSync(bodyFile, '---\nname: tdd\ndescription: x\n---\n\n# TDD\n\n先写失败测试。\n', 'utf8');
  const skills = [{ id: 'tdd', name: 'tdd', description: '测试先行', path: bodyFile, origin: 'pstack' }];

  const forced = buildChatPrompt({
    project: { id: 'p', root }, question: '加测试', skills, forcedSkill: skills[0]
  });
  assert.match(forced, /【指定技能 tdd】/u);
  assert.match(forced, /先写失败测试/u);
  assert.doesNotMatch(forced, /只能显式调用/u);

  // 写错 id：走服务层失败分支，不静默忽略
  const service = new PiChatService({ model: 'fake/model', skills, sessionFactory: { create: async () => { throw new Error('should not create'); } } });
  const failed = await service.ask({ project: { id: 'p', root }, question: '/skill:nope 加测试', model: 'fake/model' });
  assert.equal(failed.status, 'error');
  assert.equal(failed.category, 'unknown-skill');
  assert.match(failed.answer, /没有这个技能：nope/u);
  service.disposeAll();
});

test('只有 how 与 why 留在默认隐式集合里', () => {
  assert.equal(DEFAULT_SKILL_IDS.includes('how'), true);
  assert.equal(DEFAULT_SKILL_IDS.includes('why'), true);
  assert.equal(DEFAULT_SKILL_IDS.includes('figure-it-out'), false);
  assert.equal(DEFAULT_SKILL_IDS.includes('poteto-mode'), false);
});

test('skill 工具：按 id 读正文、去 front-matter、拒绝未知 id', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-skill-'));
  const file = path.join(root, 'how', 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '---\nname: how\ndescription: 这段代码怎么工作\n---\n\n# How\n\n第二节：先读入口。\n', 'utf8');

  const tool = createSkillTool({
    skills: [{ id: 'how', name: 'how', description: '', path: file, origin: 'pstack' }]
  });
  assert.equal(tool.name, 'skill');

  const ok = await tool.execute('call-1', { id: 'how' });
  assert.match(ok.content[0].text, /第二节：先读入口/u);
  assert.doesNotMatch(ok.content[0].text, /^---/u);

  const missing = await tool.execute('call-2', { id: 'no-such-skill' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /没有这个技能/u);
});

test('skill 工具不接受路径：只认索引里的 id', async () => {
  const tool = createSkillTool({ skills: [{ id: 'how', name: 'how', description: '', path: '/tmp/x/SKILL.md', origin: 'pstack' }] });
  const escape = await tool.execute('call-3', { id: '../../etc/passwd' });
  assert.equal(escape.isError, true);
});

// ── 流式：事件翻译与收尾 ──────────────────────────────────────────

test('停止信号到达时底层 prompt 同步正常结束，仍须返回取消而非成功', async () => {
  const project = makeProject(); const controller = new AbortController();
  let started; let finish;
  const ready = new Promise(resolve => { started = resolve; });
  const adapter = { ...makeAdapter({answer:'停止前的半段回复'}),
    prompt: () => new Promise(resolve => { finish = resolve; started(); }),
    abort: () => { finish?.(); }
  };
  const { service } = fakeService(adapter);
  try {
    const pending = service.askStream({project,question:'停止这一轮',model:'fake/model',signal:controller.signal});
    await ready; controller.abort(); const result = await pending;
    assert.equal(result.status,'aborted'); assert.equal(result.ok,false);
  } finally { service.disposeAll(); fs.rmSync(project.root,{recursive:true,force:true}); }
});

test('准备阶段已经停止的轮次不再创建模型会话或发出 prompt', async () => {
  const project = makeProject(); const controller = new AbortController(); controller.abort();
  let prompts = 0;
  const { service, state } = fakeService(makeAdapter({promptHook:()=>{prompts += 1;}}));
  try {
    const result = await service.askStream({project,question:'已经停止',model:'fake/model',signal:controller.signal});
    assert.equal(result.status,'aborted'); assert.equal(state.created,0); assert.equal(prompts,0);
  } finally { service.disposeAll(); fs.rmSync(project.root,{recursive:true,force:true}); }
});

test('停止时 SDK 尚未提交最终消息，也要保留本轮已流出的正文', async () => {
  const project = makeProject(); const controller = new AbortController();
  let started; let subscriber; const ready = new Promise(resolve => { started = resolve; });
  const adapter = { ...makeAdapter({answer:''}),
    subscribe: callback => { subscriber = callback; return () => {}; },
    prompt: () => { subscriber({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'已经流出的半段正文'}});started();return new Promise(()=>{}); }
  };
  const { service } = fakeService(adapter);
  try {
    const pending = service.askStream({project,question:'核对停止',model:'fake/model',signal:controller.signal,onEvent:()=>{}});
    await ready;controller.abort();const result = await pending;
    assert.equal(result.status,'aborted');assert.equal(result.answer,'已经流出的半段正文');
  } finally {service.disposeAll();fs.rmSync(project.root,{recursive:true,force:true});}
});

test('forwardChatEvent 只转正文 / 思考 / 工具三类事件', () => {
  const seen = [];
  const emit = (event) => seen.push(event);

  forwardChatEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '你' } }, emit);
  forwardChatEvent({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '想' } }, emit);
  forwardChatEvent({ type: 'tool_execution_start', toolName: 'read', args: { path: 'src/a.mjs' } }, emit);
  forwardChatEvent({ type: 'tool_execution_end', toolName: 'read' }, emit);
  // 不认识的类型与空增量都不能变成界面事件。
  forwardChatEvent({ type: 'message_end' }, emit);
  forwardChatEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '' } }, emit);

  assert.deepEqual(seen, [
    { type: 'delta', text: '你' },
    { type: 'thinking', text: '想' },
    { type: 'tool', phase: 'start', name: 'read', summary: 'src/a.mjs' },
    { type: 'tool', phase: 'end', name: 'read' }
  ]);
});

test('parseSkillCommand：允许带斜杠的技能 id（matt:分类/技能），问题不能为空', () => {
  assert.deepEqual(parseSkillCommand('/skill:matt:engineering/ask-matt 帮我选技能'), {
    id: 'matt:engineering/ask-matt',
    question: '帮我选技能'
  });
  assert.equal(parseSkillCommand('/skill:matt:engineering/ask-matt'), null);
  assert.equal(parseSkillCommand('/skill:how'), null);
});

test('askStream：turn-start → delta* → turn-done，done 的正文是权威全文', async () => {
  const events = [];
  const adapter = makeAdapter({ answer: '收到。' });
  adapter.subscribe = (listener) => {
    listener({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '收' } });
    listener({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '到' } });
    return () => {};
  };
  const { service } = fakeService(adapter);
  const result = await service.askStream({
    project: makeProject(),
    question: '在吗',
    model: 'fake/model',
    onEvent: (event) => events.push(event)
  });

  assert.deepEqual(events.map((event) => event.type), ['turn-start', 'delta', 'delta', 'turn-done']);
  assert.equal(events[0].model, 'fake/model');
  assert.equal(events[3].text, result.answer);
  assert.equal(result.status, 'ok');
});

test('askStream：中止时保留已产出的部分，事件是 turn-aborted', async () => {
  const events = [];
  const adapter = makeAdapter({ answer: '已经写了一半', hang: true });
  const { service } = fakeService(adapter);
  const controller = new AbortController();
  const pending = service.askStream({
    project: makeProject(),
    question: '继续',
    model: 'fake/model',
    signal: controller.signal,
    onEvent: (event) => events.push(event)
  });
  controller.abort();
  const result = await pending;

  assert.equal(result.status, 'aborted');
  assert.equal(result.answer, '已经写了一半');
  const aborted = events.find((event) => event.type === 'turn-aborted');
  assert.ok(aborted, '必须有 turn-aborted 事件');
  assert.equal(aborted.text, '已经写了一半');
  assert.equal(events.some((event) => event.type === 'turn-error'), false, '中止不能报成失败');
});

test('steer：插进正在跑的那一轮，不中止；空闲会话如实拒绝', async () => {
  const project = makeProject();
  const adapter = makeAdapter({ hang: true });
  const calls = [];
  adapter.prompt = async (value, options) => {
    calls.push({ value, options });
    if (options?.streamingBehavior) return undefined;
    return new Promise(() => {});
  };
  const { service } = fakeService(adapter, { timeoutMs: 5000 });
  const controller = new AbortController();
  const pending = service.askStream({
    project,
    question: '长任务',
    model: 'fake/model',
    sessionId: 'sess-1',
    signal: controller.signal,
    onEvent: () => {}
  });
  // 等 run() 建好会话、把 busy 置上。
  await new Promise((resolve) => setTimeout(resolve, 20));

  const ok = await service.steer({
    project, question: '改成一句话', model: 'fake/model', sessionId: 'sess-1'
  });
  assert.deepEqual(ok, { steered: true });
  const guided = calls.find((call) => call.options?.streamingBehavior === 'steer');
  assert.ok(guided, '必须带 streamingBehavior=steer');
  assert.equal(guided.value, '改成一句话');

  // 换了会话 id 就找不到那条会话：不假装插入成功。
  const missing = await service.steer({
    project, question: '插到别处', model: 'fake/model', sessionId: 'sess-2'
  });
  assert.deepEqual(missing, { steered: false, reason: 'no-session' });

  controller.abort();
  await pending;
});

test('askStream：空闲超时是 turn-error，分类为 timeout', async () => {
  const events = [];
  const adapter = makeAdapter({ hang: true });
  const { service } = fakeService(adapter, { timeoutMs: 30 });
  const result = await service.askStream({
    project: makeProject(),
    question: '慢',
    model: 'fake/model',
    onEvent: (event) => events.push(event)
  });

  assert.equal(result.status, 'error');
  assert.equal(result.category, 'timeout');
  const failed = events.find((event) => event.type === 'turn-error');
  assert.equal(failed?.category, 'timeout');
  assert.equal(failed?.retryable, true);
});
