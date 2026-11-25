// 会话脱敏：别的 Agent 的会话原文在变成候选、进入存储之前，先把能认出来的秘密换成
// 「带类型的占位符」。这是 ADR-0008 的要求：扫已知的别人内容，不能假装安全，
// 所以替换后保留占位（如 `sk-…<redacted:api-key>`），既让语义不断裂，也让界面
// 能诚实显示「本次脱敏 N 处」。
//
// 纯函数：输入一段文本，输出 { text, hits }。不读盘、不读库、不联网、不调模型。
//
// 覆盖范围与阈值（都写死在这里，别在调用方再猜一遍）：
// - 私钥块：-----BEGIN ... PRIVATE KEY----- 到 -----END ...，整块换成占位；保留首尾行会被
//   知识库的存前凭据检测拒收，所以这里不留 BEGIN/END 标记；
// - JWT：三段 base64url，首段以 eyJ 开头，每段至少 10 个字符；
// - 密钥前缀：sk-（后接 ≥16 位）、ghp_/gho_/ghu_/ghs_/ghr_（≥16 位）、
//   github_pat_（≥16 位）、AKIA + 16 位大写字母数字、xox[abprs]-（≥10 位）；
// - Bearer token：Bearer 后至少 12 位；
// - URL 里的 user:pass@：保留协议与用户名，只替换密码；
// - 赋值：password/passwd/pwd/secret/token/api_key/access_key/client_secret/
//   private_key/auth_token 后跟 = 或 :，值是 ≥6 位的裸串或 ≥1 位的引号串；
// - 长 base64/hex：hex ≥32 位；base64 ≥40 位且同时含大写、小写、数字。
//
// 幂等：已存在的 `<redacted:...>` 占位符先被切成独立片段跳过，所以同一段文本
// 脱敏两次结果不变，指纹也就不会因为重复脱敏而漂移。

/** 占位符形状：类型名只用小写字母与连字符，方便一次性识别与跳过。 */
const PLACEHOLDER = /(<redacted:[a-z-]+>)/u;

/** 每条规则替换时至少命中一次，hits 就加一；占位符本身不匹配任何规则。 */
const RULES = [
  {
    // 私钥块整段换成占位符，不保留 BEGIN/END：知识库的存前检查会把任何
    // `-----BEGIN ... PRIVATE KEY-----` 当成未脱敏凭据拒收，保留标记会让合法候选存不进去。
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu,
    replace: () => '<redacted:private-key>'
  },
  {
    // JWT：三段式，首段 eyJ 是 `{"` 的 base64 前缀；每段阈值写清，避免把普通 a.b.c 当 token。
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
    replace: () => 'eyJ…<redacted:jwt>'
  },
  {
    // GitHub：经典 ghp_/gho_ 与细粒度 github_pat_，前缀原样保留。
    pattern: /\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}\b/gu,
    replace: (_match, prefix) => `${prefix}…<redacted:github-token>`
  },
  {
    // AWS access key id：AKIA + 16 位大写字母数字。
    pattern: /\bAKIA[0-9A-Z]{16}\b/gu,
    replace: () => 'AKIA…<redacted:aws-key>'
  },
  {
    // Slack：xoxb/xoxa/xoxp/xoxr/xoxs，前缀原样保留。
    pattern: /\b(xox[abprs]-)[A-Za-z0-9-]{10,}\b/gu,
    replace: (_match, prefix) => `${prefix}…<redacted:slack-token>`
  },
  {
    // OpenAI / Anthropic 一类 sk- 密钥；后接至少 16 位，避免误伤 `sk-learn` 这种词。
    pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/gu,
    replace: () => 'sk-…<redacted:api-key>'
  },
  {
    // HTTP 头里的 Bearer token：保留方案名，只换凭据。
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu,
    replace: () => 'Bearer …<redacted:bearer-token>'
  },
  {
    // URL 里的 user:pass@：保留协议与用户名，密码换占位；密码里不跨 / 与 @。
    pattern: /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/giu,
    replace: (_match, scheme, user) => `${scheme}${user}:…<redacted:url-password>@`
  },
  {
    // 赋值型：password=... / token: ... / secret="..." 等，保留键名与等号，值换占位。
    pattern: /(\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|auth[_-]?token)\b\s*[:=]\s*)(?:"(?!…)[^"\r\n]{1,}"|'(?!…)[^'\r\n]{1,}'|[A-Za-z0-9][A-Za-z0-9._~+/@:-]{5,})/giu,
    replace: (_match, head) => `${head}…<redacted:credential>`
  },
  {
    // 长 hex：32 位以上；常见于密钥、会话 id 与哈希。阈值写在这里，不散在调用方。
    pattern: /\b[0-9a-fA-F]{32,}\b/gu,
    replace: () => '…<redacted:hex>'
  },
  {
    // 长 base64：40 位以上且同时含大写、小写、数字；纯小写长串交给上一条 hex 处理。
    pattern: /\b(?=[A-Za-z0-9+/]{40,}={0,2}\b)(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[0-9])[A-Za-z0-9+/]{40,}={0,2}\b/gu,
    replace: () => '…<redacted:base64>'
  }
];

/**
 * 把一段文本里的秘密换成占位符。
 *
 * @param {unknown} value 任意文本；非字符串按 String() 处理
 * @returns {{text: string, hits: number}} hits 是替换掉的片段数（一段私钥块算 1 处）
 */
export function redactSecrets(value) {
  const source = String(value ?? '');
  let hits = 0;
  const parts = source.split(PLACEHOLDER);
  const output = parts.map((part, index) => {
    // split 带捕获组：奇数下标就是已有占位符，原样保留，保证幂等。
    if (index % 2 === 1) return part;
    let chunk = part;
    for (const rule of RULES) {
      chunk = chunk.replace(rule.pattern, (...args) => {
        hits += 1;
        return rule.replace(...args);
      });
    }
    return chunk;
  });
  return { text: output.join(''), hits };
}

/** 候选里必须脱敏的字段；引用与提炼结果都在这里，别在调用方漏一项。 */
export const CANDIDATE_TEXT_FIELDS = ['phenomenon', 'intent', 'abandoned', 'reason'];

/**
 * 脱敏一条候选：quote 两段与四个提炼字段全部经过 redactSecrets。
 * 返回新对象，不原地改候选；hits 是本条候选新增的替换数（已经脱敏过的文本为 0）。
 *
 * @param {object} candidate decision-draft 产出的候选
 * @returns {{candidate: object, hits: number}}
 */
export function redactCandidate(candidate) {
  const source = candidate && typeof candidate === 'object' ? candidate : {};
  let hits = 0;
  const out = { ...source };
  const quote = source.quote && typeof source.quote === 'object' ? source.quote : {};
  const nextQuote = { ...quote };
  for (const key of ['user', 'assistant']) {
    if (typeof nextQuote[key] !== 'string') continue;
    const result = redactSecrets(nextQuote[key]);
    nextQuote[key] = result.text;
    hits += result.hits;
  }
  out.quote = nextQuote;
  for (const key of CANDIDATE_TEXT_FIELDS) {
    if (typeof out[key] !== 'string') continue;
    const result = redactSecrets(out[key]);
    out[key] = result.text;
    hits += result.hits;
  }
  return { candidate: out, hits };
}
