// 决策提炼：把一段会话片段读成「决策候选」的纯函数视图模型。
//
// 为什么单独一个文件：#85 的三条规则来自真实取样，不能散在摄入器与界面里各写一份——
// 1. 成对取：只留用户那句会丢掉一半信息，助手那句才给出具体范围（换什么、留什么）。
// 2. 理由稀少：约一成原话自带理由，所以「缺理由」是常态，要显式标 missingReason，
//    绝不填「未说明」这类占位词冒充内容。
// 3. 注入块过滤：会话开头常混进环境上下文与系统历史，它们不是用户原话，不能算候选。
//
// 这里不读盘、不读库、不联网，也不调真实模型：会话片段、已有决策的指纹、提炼器
// 全部由调用方注入。提炼器只回答「这一段像不像决策、各字段是什么」，配对、去重、
// 注入过滤、证据引用这些管道规则留在本文件里，这样它们能脱离模型单独测。
//
// 去重指纹取「用户原话正文 + 项目」，不取时间戳：同一句话在会话分叉里会出现四到八次，
// 时间不同不能算新决策；换一个项目说同一句话，则是另一条决策。

import { flatText, sha256 } from '../utils.mjs';

/** 角色归一：只认对话双方，工具输出、系统提示、开发者指令都不参与配对。 */
const roleOf = (value) => {
  const role = String(value ?? '').trim().toLowerCase();
  if (role === 'user' || role === 'human') return 'user';
  if (role === 'assistant' || role === 'ai' || role === 'model') return 'assistant';
  return 'other';
};

/**
 * 注入块识别：只看开头，命中即整段跳过。
 * 判的是「这段话不是用户的原话」，所以宁可只认明确的抬头，不按关键词搜正文——
 * 正文里提到「环境」往往是用户在讨论环境，不是注入。
 */
const INJECTED_PATTERNS = [
  // 中文抬头：环境上下文 / 环境信息 / 系统历史 / 历史上下文 / 系统上下文
  /^(?:环境上下文|环境信息|系统历史|历史上下文|系统上下文)/u,
  // XML 风格抬头：<environment_context> / <system_history> / <env> 等
  /^<?(?:environment[ _-]?context|environment[ _-]?information|system[ _-]?history|system[ _-]?context|env)>?(?!\w)/iu,
  // Markdown 或纯文本抬头：Environment context / System history / Environment information
  /^(?:environment|system)\s+(?:context|history|information)\b/iu
];

/**
 * 判断一段文本是不是注入的历史/环境块。
 * 先把开头的空白、BOM 与常见装饰符（引用号、标题号、列表点、中文书名号）剥掉再比，
 * 这样 `# System history`、`> <environment_context>`、`【环境上下文】` 都能认出来。
 */
export function isInjectedText(value) {
  const head = String(value ?? '')
    .replace(/^\uFEFF/u, '')
    .replace(/^[\s>#*\-•·【〔《(\[]+/u, '');
  return INJECTED_PATTERNS.some((pattern) => pattern.test(head));
}

/**
 * 决策指纹：用户原话正文归一后 + 项目，哈希成一个稳定标识。
 * 正文只做空白归一（换行、缩进、多余空格折叠掉），不做词干或大小写处理——
 * 中文没有词干，英文大小写可能是刻意的标识符；宁可多出一条，不可把两条不同的话并掉。
 */
export function decisionFingerprint({ projectId = '', text = '' } = {}) {
  const project = String(projectId ?? '').trim();
  const body = flatText(text);
  return sha256(`${project}\u0000${body}`);
}

/** 会话片段的文本入口：摄入层各处的字段叫法不同，这里统一读一处。 */
const textOf = (fragment) => String(fragment?.text ?? fragment?.content ?? fragment?.message ?? '')
  .replace(/\u0000/gu, '')
  .trim();

/**
 * 第一遍：过滤。留下真正参与配对的对话片段，其余分类计数。
 * 工具输出与系统消息被移出列表而不是打断配对——用户说完话、工具跑一下、助手再回，
 * 在真实会话里是最常见的顺序，「紧随」说的是对话层面紧随，不是列表位置相邻。
 * index 保留片段在原始输入里的位置，证据引用要能回到原处。
 */
const conversationOf = (fragments, sessionId, skipped) => {
  const list = Array.isArray(fragments) ? fragments : [];
  const conversation = [];
  for (const [index, raw] of list.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      skipped.ignored++;
      continue;
    }
    const role = roleOf(raw.role);
    const text = textOf(raw);
    if (role === 'other' || !flatText(text)) {
      skipped.ignored++;
      continue;
    }
    // 注入块通常是 user 角色混进来的，所以角色通过后还要再按抬头挡一次。
    if (isInjectedText(text)) {
      skipped.injected++;
      continue;
    }
    conversation.push({
      role,
      text,
      at: raw.at ?? raw.time ?? raw.timestamp ?? '',
      sessionId: String(raw.sessionId ?? sessionId ?? ''),
      index
    });
  }
  return conversation;
};

/** 证据引用：会话 id 加位置，再加时间；助手那句缺省时只有用户一条。 */
const evidenceOf = (user, assistant) => {
  const refs = [{ role: 'user', index: user.index, sessionId: user.sessionId, at: user.at }];
  if (assistant) refs.push({ role: 'assistant', index: assistant.index, sessionId: assistant.sessionId, at: assistant.at });
  return refs;
};

/**
 * 没有注入提炼器时的兜底：只把用户原话当作现象，其余字段留空。
 * 这一步唯一不编造的做法——助手那段原文不是「意图」，理由更不能从原文拼。
 */
const fallbackExtract = (pair) => ({
  phenomenon: pair.user.text,
  intent: '',
  abandoned: '',
  reason: ''
});

/**
 * 把一对片段交给提炼器并组装候选。
 * 提炼器返回 null 表示「这段不像决策」；抛错表示这一对提炼失败。
 * 两种都不让整批扫描停下来：一段会话里有一条读不动，其余条目照样出候选。
 */
const judge = (extract, projectId, fingerprint, user, assistant, skipped) => {
  const pair = {
    projectId,
    sessionId: user.sessionId,
    user: { role: 'user', text: user.text, at: user.at, index: user.index, sessionId: user.sessionId },
    assistant: assistant
      ? { role: 'assistant', text: assistant.text, at: assistant.at, index: assistant.index, sessionId: assistant.sessionId }
      : null
  };
  let fields;
  try {
    fields = (typeof extract === 'function' ? extract : fallbackExtract)(pair);
  } catch {
    skipped.failed++;
    return null;
  }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    skipped.rejected++;
    return null;
  }
  const reason = flatText(fields.reason);
  return {
    fingerprint,
    status: 'proposed',
    projectId,
    phenomenon: flatText(fields.phenomenon),
    intent: flatText(fields.intent),
    abandoned: flatText(fields.abandoned),
    // 理由空着就是空着：missingReason 单独标记，界面据此提示「确认时补一句」。
    reason,
    missingReason: reason === '',
    // 不完整 = 只有用户那句，没有紧随的助手确认；下游可以据此降低展示权重。
    partial: assistant === null,
    quote: { user: user.text, assistant: assistant?.text ?? '' },
    evidence: evidenceOf(user, assistant)
  };
};

/**
 * 提炼一段会话的决策候选。
 *
 * @param {object} input
 * @param {string} [input.projectId] 这段会话归属的项目（匹配是摄入层的事，这里不猜）
 * @param {string} [input.sessionId] 会话 id；片段自带 sessionId 时以片段为准
 * @param {object[]} [input.fragments] 会话片段：{ role, text, at }，可按时间升序原样传入
 * @param {Iterable<string>} [input.fingerprints] 已有决策的指纹，命中即跳过
 * @param {(pair: object) => object|null} [input.extract] 注入的提炼器；缺省只填原话
 * @returns {object} { projectId, candidates, empty, skipped }
 */
export function draftDecisions({
  projectId = '',
  sessionId = '',
  fragments = [],
  fingerprints = [],
  extract = null
} = {}) {
  const project = String(projectId ?? '').trim();
  // 跳过分类各自计数：注入块与重复条目最容易被误当成「提不出东西」，要让调用方看得见。
  const skipped = {
    injected: 0,
    ignored: 0,
    orphanAssistant: 0,
    rejected: 0,
    failed: 0,
    existing: 0,
    duplicate: 0
  };
  const existing = fingerprints instanceof Set
    ? fingerprints
    : new Set(Array.isArray(fingerprints) ? fingerprints : []);

  const conversation = conversationOf(fragments, sessionId, skipped);
  const candidates = [];
  // fingerprint → 候选在列表中的位置：保持会话顺序，也让重复条目能被原位替换。
  const seen = new Map();

  let index = 0;
  while (index < conversation.length) {
    const current = conversation[index];
    if (current.role !== 'user') {
      // 开头就是助手那句，或前面那条用户原话被注入过滤掉了：不凭助手单口造候选。
      skipped.orphanAssistant++;
      index++;
      continue;
    }
    const next = conversation[index + 1];
    const assistant = next && next.role === 'assistant' ? next : null;
    index += assistant ? 2 : 1;

    const fingerprint = decisionFingerprint({ projectId: project, text: current.text });
    // 先比指纹再调提炼器：已知或重复的内容不该花一次提炼。
    if (existing.has(fingerprint)) {
      skipped.existing++;
      continue;
    }
    const previous = seen.get(fingerprint);
    if (previous !== undefined) {
      skipped.duplicate++;
      // 同一句话先以不完整形态出现、后又带上助手确认：用成对那条换掉它，位置不动。
      if (candidates[previous].partial && assistant) {
        const rebuilt = judge(extract, project, fingerprint, current, assistant, skipped);
        if (rebuilt) candidates[previous] = rebuilt;
      }
      continue;
    }

    const candidate = judge(extract, project, fingerprint, current, assistant, skipped);
    if (!candidate) continue;
    seen.set(fingerprint, candidates.length);
    candidates.push(candidate);
  }

  return { projectId: project, candidates, empty: candidates.length === 0, skipped };
}
