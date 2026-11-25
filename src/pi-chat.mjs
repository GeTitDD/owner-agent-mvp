// 对话模式的只读 Pi 会话。
//
// 目标：绑定一个项目回答「这个项目为什么卡住」「这个文件为什么这么写」。
// 不变量：
// - 工具面只有 read/grep/find/ls；写、执行、联网工具不注册，创建后再用
//   getActiveToolNames() 二次核对，越权或无法枚举都直接中止（fail closed）。
// - 没有模型配置时不创建会话，返回 no-model 的明确提示，不静默失败。
// - 回答里的文件引用要落地检查：只把项目中真实存在的路径作为 citations 返回，
//   找不到的路径单独列出并提醒谨慎采信。
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolvePiModel } from './pi-model-catalog.mjs';
import { READONLY_TOOLS, FORBIDDEN_TOOLS } from './pstack/playbooks.mjs';
import { scanMattSkills, scanPstackSkills } from './knowledge/skills.mjs';
import { Type } from 'typebox';

/** 对话模式允许使用的工具：只读白名单 + 取技能正文的 skill。 */
export const CHAT_TOOLS = Object.freeze([...READONLY_TOOLS, 'skill']);

/**
 * 对话模式默认带全文的技能：诊断、设计、术语、自省、查证，加上 pstack 的「怎么工作 / 为什么」。
 * 其余技能不在索引里详写，但仍可用 skill(id) 取到。
 */
export const DEFAULT_SKILL_IDS = Object.freeze([
  'diagnosing-bugs',
  'codebase-design',
  'domain-modeling',
  'ask-matt',
  'research',
  'how',
  'why'
]);

/**
 * 只有显式点名才用的技能（pstack 除 how / why 之外的全部）。
 *
 * 为什么：pstack 里大量是「工作流」性质的技能（poteto-mode、swarm、arena…），
 * 它们自带阶段划分与产出物，模型自行判定「现在该走这套流程」几乎总是错的。
 * 索引里仍然列出来，但用法写成「Owner 点名时才用」。
 */
export const EXPLICIT_ONLY_ORIGINS = Object.freeze(['pstack']);

const skillCache = { at: 0, value: null };
const SKILL_CACHE_MS = 60_000;
const MAX_SKILL_BODY = 6000;

/**
 * 扫两处技能根，返回统一形状 `[{ id, name, description, path, origin }]`。
 * id 用技能目录名；重名时带上来源前缀，避免对话里点错。
 */
export function loadChatSkillCatalogue({ pstackSkillsDir = '', mattSkillsDir = '' } = {}) {
  const pstackDir = pstackSkillsDir || process.env.PSTACK_DIR
    || 'D:\\nautilus_trader\\.tmp\\opencode\\pstack-pi\\skills';
  const mattDir = mattSkillsDir || process.env.MATT_SKILLS_DIR
    || path.join(os.homedir(), '.owner-agent', 'skills', 'matt');

  const entries = [];
  // id 一律取目录名：front-matter 的 name 是给人看的显示名（可能是 "Make Bot UI"），
  // 带空格和大写，不适合当工具参数。
  const idOf = (skillPath, fallback) => {
    const base = path.basename(path.dirname(String(skillPath ?? '')));
    return base || fallback;
  };
  try {
    for (const entry of scanPstackSkills({ skillsDir: pstackDir })) {
      if (entry.missing || entry.playbookOnly) continue;
      const id = idOf(entry.path, entry.name);
      entries.push({ id, name: entry.name, description: entry.description, path: entry.path, origin: 'pstack' });
    }
  } catch { /* 目录不可读就当没有这一处 */ }
  try {
    for (const entry of scanMattSkills({ skillsRoot: mattDir })) {
      if (entry.missing) continue;
      const id = idOf(entry.path, entry.name);
      entries.push({ id, name: entry.name, description: entry.description, path: entry.path, origin: entry.origin });
    }
  } catch { /* 同上 */ }

  // 重名时保留两条，但 id 加来源前缀，保证 skill(id) 不会取错。
  const seen = new Map();
  for (const entry of entries) seen.set(entry.id, (seen.get(entry.id) ?? 0) + 1);
  for (const entry of entries) {
    if (seen.get(entry.id) > 1) entry.id = `${entry.origin}:${entry.name}`;
  }
  return entries;
}

/** 一分钟缓存，避免每次提问都扫盘。 */
export function chatSkillCatalogue(options = {}) {
  if (skillCache.value && Date.now() - skillCache.at < SKILL_CACHE_MS) return skillCache.value;
  const value = loadChatSkillCatalogue(options);
  skillCache.at = Date.now();
  skillCache.value = value;
  return value;
}

/**
 * 提示词里的技能段：常用的详写，其余只列 id。
 * 全部 92 条都带描述约 5700 token，每轮都背不起；常用 8 条约 500 token。
 */
export function buildSkillSection(skills = []) {
  if (!Array.isArray(skills) || skills.length === 0) return [];
  const byId = new Map(skills.map((item) => [item.id, item]));
  const common = DEFAULT_SKILL_IDS.map((id) => byId.get(id)).filter(Boolean);
  const rest = skills.filter((item) => !DEFAULT_SKILL_IDS.includes(item.id));
  const explicitOnly = rest.filter((item) => EXPLICIT_ONLY_ORIGINS.includes(item.origin));
  const implicitRest = rest.filter((item) => !EXPLICIT_ONLY_ORIGINS.includes(item.origin));

  const lines = ['', '可用技能（只读；需要全文时用 skill(id) 取）：'];
  for (const item of common) lines.push(`- ${item.id}：${String(item.description ?? '').slice(0, 160)}`);

  if (implicitRest.length) {
    const byOrigin = new Map();
    for (const item of implicitRest) {
      const key = item.origin || 'other';
      if (!byOrigin.has(key)) byOrigin.set(key, []);
      byOrigin.get(key).push(item.id);
    }
    lines.push(`其余 ${implicitRest.length} 个（id 逗号分隔，同样可用）：`);
    for (const [origin, ids] of byOrigin) lines.push(`- ${origin}: ${ids.join(', ')}`);
  }

  // pstack 的工作流类技能只在点名时用：它们自带阶段划分，模型自己判定何时进入几乎总是错的。
  if (explicitOnly.length) {
    lines.push(`只能显式调用（${explicitOnly.length} 个，Owner 点名时才用，不要自行启动）：`);
    lines.push(`- ${explicitOnly.map((item) => item.id).join(', ')}`);
  }

  lines.push('规则：先判断需不需要技能；需要时取一次全文，按它的步骤做，不要凭印象复述技能内容。');
  return lines;
}

export const MAX_QUESTION = 1200;
const MAX_ANSWER = 8000;
const MAX_CITATIONS = 12;

const DEFAULT_TIMEOUT_MS = Number(process.env.OWNER_CHAT_TIMEOUT_MS) || 120000;

// 失败后给用户可执行的一句话，而不是只显示分类名。
export const CHAT_FAILURE_ADVICE = Object.freeze({
  'no-model': '还没有配置模型：先在设置里选一个模型（需要 Pi 登录或 API key），再回到对话提问。',
  'no-project': '还没有登记项目：先在设置里添加一个项目目录，对话才能读文件回答。',
  'empty-question': '请先输入问题。',
  'question-too-long': `问题最多 ${MAX_QUESTION} 字。`,
  busy: '上一个问题还在处理中，等它答完再问。',
  'readonly-violation': '只读工具校验失败，已中止本次会话；这是客户端缺陷，请不要继续。',
  'auth-error': '模型凭据不可用：到设置里检查模型，或重新登录 Pi。',
  'network-error': '模型服务连接失败：检查代理/网络后重试。',
  'quota-exceeded': '模型额度已用尽（429）。换一个模型，或等额度重置后再试。',
  timeout: '回答超时：项目较大时可以问得更具体一些，或稍后重试。',
  canceled: '已中止本次提问。',
  'empty-response': '模型返回了空内容：可能是额度、网络或上下文问题；先重试，仍为空就换模型。',
  'session-error': '模型会话异常：重试一次；持续失败时换模型或缩小问题范围。'
});

/** 组装对话提示词：只读边界 + 路径引用格式 + 本会话最近几轮上下文。 */
export function buildChatPrompt({ project, question, history = [], skills = [] }) {
  const root = String(project?.root ?? '');
  const id = String(project?.id ?? '');
  const value = String(question ?? '').trim().slice(0, MAX_QUESTION);
  // 上次进程里的 Pi 会话可能已经释放（重启、切模型）：用落库的历史补上下文。
  const turns = (Array.isArray(history) ? history : [])
    .slice(-8)
    .map((item) => {
      const role = item?.role === 'assistant' ? '你' : 'Owner';
      const text = String(item?.text ?? '').trim().slice(0, 600);
      return text ? `${role}：${text}` : '';
    })
    .filter(Boolean);
  const context = turns.length
    ? ['', '本会话之前的对话（仅供理解上下文，不要复述）：', ...turns]
    : [];
  return [
    `你正在只读查看项目 ${id}（根目录 ${root}）。`,
    ...context,
    ...buildSkillSection(skills),
    `Owner 的问题：${value}`,
    '',
    '回答要求：',
    '1. 先用 read/grep/find/ls 看相关文件，再回答；没读到的内容说「未知」，不要猜。',
    '2. 你只能读，不能改：没有写文件、执行命令或联网的能力。Owner 想改代码时，说明要打开「交办」并走审批。',
    '3. 引用文件时写项目内相对路径（如 `src/app.mjs`），必要时带行号（如 `src/app.mjs:12`）。',
    '4. 直接回答，用中文；先给结论，再给依据；不要复述这些规则。'
  ].join('\n');
}

// 文件引用：允许 `src/a.mjs`、`./src/a.mjs`、`src\\a.mjs`，可带 :行号。
// 纯文件名（没有目录分隔符）只认反引号里的写法，避免把「Node.js」这类词误判成路径。
const CHAT_CITATION_RE =
  /(^|[\s`'"“”‘’()[\]{}<>,，。：:；;])((?:\.{1,2}[\\/])?[A-Za-z0-9_@.+\-\\/]+\.[A-Za-z][A-Za-z0-9]{0,7})(?::(\d{1,6}))?/gu;

/**
 * 从回答正文里提取文件引用并落地检查。
 * 只接受项目根目录内的相对路径；越界、目录、不存在的路径都进入 missing。
 */
export function verifyChatCitations(projectRoot, text, { limit = MAX_CITATIONS } = {}) {
  const root = String(projectRoot ?? '').trim();
  if (!root) return { citations: [], missing: [] };
  const absoluteRoot = path.resolve(root);
  const citations = [];
  const missing = [];
  const seen = new Set();
  const raw = String(text ?? '').replace(/https?:\/\/\S+/gu, ' ');
  for (const match of raw.matchAll(CHAT_CITATION_RE)) {
    const boundary = match[1] ?? '';
    const token = match[2] ?? '';
    const line = match[3] ? Number(match[3]) : 0;
    if (!token) continue;
    // 同一条消息里同一路径只算一次，避免行号不同重复出现。
    if (!/[\\/]/u.test(token) && boundary !== '`') continue;
    const normalized = token.replaceAll('\\', '/').replace(/^\.\//u, '');
    if (!normalized || normalized.split('/').includes('..')) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const absolute = path.resolve(absoluteRoot, normalized);
    const inside = absolute === absoluteRoot || absolute.startsWith(`${absoluteRoot}${path.sep}`);
    if (inside && existsSync(absolute)) citations.push({ path: normalized, line });
    else missing.push(normalized);
    if (seen.size >= limit) break;
  }
  return { citations, missing };
}

/** 拼装最终回答：原文 + 未找到路径的提醒，避免把猜测当成事实。 */
export function composeChatAnswer(answer, missing = []) {
  const body = String(answer ?? '').trim().slice(0, MAX_ANSWER);
  const note = missing.length
    ? `（以下路径在项目里没有找到，请谨慎采信：${missing.join('、')}）`
    : '';
  return [body, note].filter(Boolean).join('\n\n');
}

/** 取会话最后一条消息的受控视图，用于识别上游错误。 */
export function readLastMessage(session) {
  const messages = session?.messages ?? [];
  const last = messages[messages.length - 1];
  if (!last) return null;
  return {
    role: last.role ?? last.type ?? 'unknown',
    stopReason: last.stopReason ?? null,
    errorMessage: last.errorMessage ?? null,
    hasText: Array.isArray(last.content)
      ? last.content.some((part) => part?.type === 'text' && String(part.text ?? '').trim())
      : Boolean(String(last.content ?? '').trim())
  };
}

/**
 * 二次核对工具面：白名单之外出现任何工具、或缺 read，都直接失败。
 * 传入的可以是 SDK 会话（getActiveToolNames）或工厂返回的句柄（activeTools）；
 * 失败时顺便释放会话，避免带着越权工具继续跑。
 */
export function assertChatToolSurface(session, allowed = CHAT_TOOLS) {
  let names = null;
  try {
    names = typeof session?.getActiveToolNames === 'function'
      ? session.getActiveToolNames()
      : (typeof session?.activeTools === 'function' ? session.activeTools() : null);
  } catch {
    names = null;
  }
  const active = Array.isArray(names) ? [...names] : null;
  const fail = (message) => {
    try { session?.dispose?.(); } catch { /* 释放失败也要抛出 */ }
    throw Object.assign(new Error(message), { category: 'readonly-violation' });
  };
  // 无法枚举 = 未知，按越权处理（fail closed）。
  if (!active) return fail('chat-tools-unverified');
  const unexpected = active.filter((name) => !allowed.includes(name));
  if (unexpected.length) return fail(`chat-tools-violation: ${unexpected.join(',')}`);
  if (!active.includes('read')) return fail('chat-tools-missing: read');
  return active;
}

/**
 * 技能正文工具：按 id 读 SKILL.md，去掉 front-matter，截断到 MAX_SKILL_BODY。
 *
 * 只按目录里已扫到的条目取，不接受任意路径：id 不在目录里就直接报错，
 * 这样即便模型编一个 id 也读不到项目之外的任何文件。
 */
export function createSkillTool({ skills = [], maxChars = MAX_SKILL_BODY } = {}) {
  const byId = new Map(skills.map((item) => [item.id, item]));
  return {
    name: 'skill',
    label: 'Skill',
    description: '读取一个技能的说明（SKILL.md）全文',
    parameters: Type.Object({ id: Type.String({ description: '技能 id，例如 diagnosing-bugs' }) }),
    async execute(_callId, params) {
      const id = String(params?.id ?? '').trim();
      const entry = byId.get(id);
      if (!entry) {
        return {
          isError: true,
          content: [{ type: 'text', text: `没有这个技能：${id}。只能用索引里列出的 id。` }]
        };
      }
      try {
        const raw = readFileSync(entry.path, 'utf8');
        const body = raw.startsWith('---\n')
          ? raw.slice(raw.indexOf('\n---', 4) + 4).trim()
          : raw.trim();
        return {
          content: [{ type: 'text', text: body.slice(0, maxChars) }],
          details: { id, path: entry.path }
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: `读不到技能正文：${String(error?.message ?? error)}` }]
        };
      }
    }
  };
}

/**
 * 只读对话会话工厂。
 * loadSdk 可注入，测试用假 SDK 覆盖工具面校验，不联网、不调用真实模型。
 * skills 可注入，测试不依赖磁盘上的技能目录。
 */
export function createChatSessionFactory({ loadSdk = null, skills = null } = {}) {
  const load = loadSdk ?? (() => import('@earendil-works/pi-coding-agent'));
  const catalogue = () => (Array.isArray(skills) ? skills : chatSkillCatalogue());
  return {
    tools: [...CHAT_TOOLS],
    async create({ cwd, model, signal } = {}) {
      if (!cwd) throw new Error('chat project root is required');
      const sdk = await load();
      // 每次会话一个空 agentDir：不加载全局扩展、Skill、项目 .pi 与上下文文件。
      const agentDir = mkdtempSync(path.join(os.tmpdir(), 'owner-chat-agent-'));
      const created = (async () => {
        const loader = new sdk.DefaultResourceLoader({
          cwd,
          agentDir,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true
        });
        try {
          await loader.reload();
          const { session } = await sdk.createAgentSession({
            cwd,
            tools: [...CHAT_TOOLS],
            customTools: [createSkillTool({ skills: catalogue() })],
            excludeTools: [...FORBIDDEN_TOOLS],
            sessionManager: sdk.SessionManager.inMemory(),
            resourceLoader: loader,
            ...(model ? { model: resolvePiModel(model) } : {})
          });
          const active = assertChatToolSurface(session);
          let disposed = false;
          return {
            sessionId: () => String(session.sessionId ?? ''),
            prompt: (value) => session.prompt(value),
            abort: () => session.abort?.(),
            activeTools: () => [...active],
            lastMessage: () => readLastMessage(session),
            getLastText: () => String(session.getLastAssistantText?.() ?? ''),
            get model() {
              return session.model
                ? `${session.model.provider}/${session.model.id}`
                : (model || 'unknown');
            },
            dispose() {
              if (disposed) return;
              disposed = true;
              try {
                session.dispose?.();
              } finally {
                try { rmSync(agentDir, { recursive: true, force: true }); } catch { /* 最佳努力清理 */ }
              }
            }
          };
        } catch (error) {
          try { rmSync(agentDir, { recursive: true, force: true }); } catch { /* ignore */ }
          throw error;
        }
      })();
      // 创建阶段被取消时，迟到的会话必须中止并释放，不能留在后台继续计费。
      if (signal) {
        const disposeLate = () => {
          created
            .then((session) => {
              try { session.abort?.(); } catch { /* ignore */ }
              session.dispose();
            })
            .catch(() => {
              try { rmSync(agentDir, { recursive: true, force: true }); } catch { /* ignore */ }
            });
        };
        if (signal.aborted) disposeLate();
        else signal.addEventListener('abort', disposeLate, { once: true });
      }
      return created;
    }
  };
}

/** 把上游错误归到受控分类。 */
export function classifyChatError(error) {
  if (error?.category) return error.category;
  const name = String(error?.name ?? '');
  const message = String(error?.message ?? '');
  if (/timeout/iu.test(name) || /timeout/iu.test(message)) return 'timeout';
  if (/abort/iu.test(name) || /cancel/iu.test(message)) return 'canceled';
  if (/chat-tools|readonly-tools/u.test(message)) return 'readonly-violation';
  if (/no api key|api key|relogin|auth|permission|forbidden/iu.test(message)) return 'auth-error';
  if (/network|fetch|connection|socket|dns/iu.test(message)) return 'network-error';
  return 'session-error';
}

/** 识别 429/鉴权这类「空内容 + stopReason=error」的上游失败。 */
export function classifyChatProviderError(rawMessage) {
  const raw = String(rawMessage ?? '');
  if (/429|1310|quota|rate.?limit|使用上限|额度/iu.test(raw)) {
    const reset = /(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)/u.exec(raw);
    return {
      category: 'quota-exceeded',
      detail: reset ? `额度将于 ${reset[1]} 重置。` : ''
    };
  }
  if (/401|403|unauthorized|invalid api key|no api key|relogin/iu.test(raw)) {
    return { category: 'auth-error', detail: '' };
  }
  if (/timeout|ETIMEDOUT/iu.test(raw)) return { category: 'timeout', detail: '' };
  return { category: 'session-error', detail: '' };
}

/**
 * 对话服务：按「项目 + 模型」持有一个进程内会话，支持连续追问。
 * 失败即丢弃会话，避免半截上下文继续用；模型切换时整体重置。
 */
export class PiChatService {
  constructor({
    model = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sessionFactory = null,
    skills = null,
    maxSessions = 2,
    logger = console
  } = {}) {
    this.model = String(model ?? '').trim();
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
    // 技能目录可注入：主进程只扫一次，测试不碰磁盘。
    this.skills = Array.isArray(skills) ? skills : null;
    this.sessionFactory = sessionFactory ?? createChatSessionFactory({ skills: this.skills });
    this.maxSessions = Math.max(1, Number(maxSessions) || 2);
    this.logger = logger;
    this.sessions = new Map();
  }

  /** 模型变更后旧会话不再适用：直接释放，下一问重建。 */
  setModel(model) {
    const next = String(model ?? '').trim();
    if (next === this.model) return;
    this.model = next;
    this.disposeAll();
  }

  disposeAll() {
    for (const key of [...this.sessions.keys()]) this.drop(key);
  }

  drop(key) {
    const entry = this.sessions.get(key);
    if (!entry) return;
    this.sessions.delete(key);
    try { entry.session.dispose(); } catch { /* ignore */ }
  }

  /** 会话数上限：淘汰最久未用的空闲会话，避免长跑进程攒满内存。 */
  keep(key, session, tools) {
    this.sessions.set(key, { session, tools, busy: false, lastUsed: Date.now() });
    while (this.sessions.size > this.maxSessions) {
      const oldest = [...this.sessions.entries()]
        .filter(([itemKey, entry]) => itemKey !== key && !entry.busy)
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!oldest) break;
      this.drop(oldest[0]);
    }
  }

  failure({ projectId, category, began, model = '', detail = '', tools = [] }) {
    const advice = CHAT_FAILURE_ADVICE[category] ?? CHAT_FAILURE_ADVICE['session-error'];
    return {
      status: 'error',
      ok: false,
      projectId,
      category,
      answer: [advice, detail].filter(Boolean).join(' '),
      advice,
      detail,
      citations: [],
      missingCitations: [],
      tools,
      model: model || 'unknown',
      durationMs: Date.now() - began
    };
  }

  async ask({ project = null, question = '', model = this.model, signal, sessionId = '', history = [] } = {}) {
    const began = Date.now();
    const projectId = String(project?.id ?? '');
    const text = String(question ?? '').trim();

    if (!project?.root) return this.failure({ projectId, category: 'no-project', began });
    if (!text) return this.failure({ projectId, category: 'empty-question', began });
    if (text.length > MAX_QUESTION) {
      return this.failure({ projectId, category: 'question-too-long', began });
    }
    const resolvedModel = String(model ?? '').trim();
    if (!resolvedModel) return this.failure({ projectId, category: 'no-model', began, model: resolvedModel });
    if (resolvedModel !== this.model) this.setModel(resolvedModel);

    const root = path.resolve(project.root);
    // 每个持久化会话一个进程内 Pi 会话；同一个会话切换回来后仍能连续追问。
    const chatKey = String(sessionId ?? '').trim();
    const key = chatKey
      ? `${chatKey}::${projectId}::${root}::${resolvedModel}`
      : `${projectId}::${root}::${resolvedModel}`;
    const existing = this.sessions.get(key) ?? null;
    if (existing?.busy) return this.failure({ projectId, category: 'busy', began, model: resolvedModel });

    let session = existing?.session ?? null;
    // 只有新建的 Pi 会话才需要落库历史补上下文；活会话已经带着自己的消息。
    let freshSession = false;
    let timer = null;
    let cancelListener = null;
    const stopSession = () => {
      try { session?.abort?.(); } catch { /* 中止失败也要继续 dispose */ }
    };

    try {
      if (!session) {
        const created = await this.sessionFactory.create({ cwd: root, model: resolvedModel });
        let tools = null;
        // 二次核对：注入的工厂也要过同一道关，不能只靠工厂自己声明。
        // 校验失败时 assertChatToolSurface 自己会释放会话。
        tools = assertChatToolSurface(created);
        session = created;
        freshSession = true;
        this.keep(key, session, tools);
      }
      const entry = this.sessions.get(key);
      if (entry) {
        entry.busy = true;
        entry.lastUsed = Date.now();
      }

      const timedOut = new Promise((_, reject) => {
        timer = setTimeout(() => {
          stopSession();
          reject(Object.assign(new Error('chat timeout'), { name: 'TimeoutError' }));
        }, this.timeoutMs);
      });
      const canceled = new Promise((_, reject) => {
        if (!signal) return;
        cancelListener = () => {
          stopSession();
          reject(Object.assign(new Error('chat canceled'), { name: 'AbortError' }));
        };
        signal.addEventListener('abort', cancelListener, { once: true });
      });

      await Promise.race([
        session.prompt(buildChatPrompt({
          project: { id: projectId, root },
          question: text,
          history: freshSession ? history : [],
          skills: this.skills ?? chatSkillCatalogue()
        })),
        timedOut,
        canceled
      ]);

      // 上游可能以「空内容 + stopReason=error」结束（额度、鉴权、网络），必须显式失败。
      const last = session.lastMessage?.();
      if (last?.stopReason === 'error') {
        const classified = classifyChatProviderError(last.errorMessage);
        throw Object.assign(new Error('provider error'), {
          name: 'ProviderError',
          category: classified.category,
          detail: classified.detail
        });
      }
      const raw = String(session.getLastText?.() ?? '');
      if (!raw.trim()) {
        throw Object.assign(new Error('empty model response'), {
          name: 'EmptyResponseError',
          category: 'empty-response'
        });
      }
      const { citations, missing } = verifyChatCitations(root, raw);
      const tools = this.sessions.get(key)?.tools ?? CHAT_TOOLS;
      return {
        status: 'ok',
        ok: true,
        projectId,
        sessionId: String(session.sessionId?.() ?? ''),
        answer: composeChatAnswer(raw, missing),
        rawAnswer: raw.trim().slice(0, MAX_ANSWER),
        citations,
        missingCitations: missing,
        tools: [...tools],
        model: session.model ?? resolvedModel,
        durationMs: Date.now() - began
      };
    } catch (error) {
      // 出错即丢弃会话：半截上下文继续追问只会放大误导。
      this.drop(key);
      const category = classifyChatError(error);
      if (category === 'readonly-violation') {
        this.logger?.error?.(`chat session aborted: ${String(error?.message ?? error)}`);
      }
      return this.failure({
        projectId,
        category,
        began,
        model: resolvedModel,
        detail: String(error?.detail ?? '')
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && cancelListener) signal.removeEventListener('abort', cancelListener);
      const entry = this.sessions.get(key);
      if (entry) entry.busy = false;
    }
  }
}
