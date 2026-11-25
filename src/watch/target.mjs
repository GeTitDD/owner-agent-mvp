// 监控对象描述符（#117）：项目 / Agent 会话 / GitHub 三类，只有一种合法形状。
//
// 为什么是「对象」而不是「范围」：监控看什么由对象本身决定（项目根、会话文件、仓库），
// 不给人写 include/exclude 那种文件级参数（父 spec #102「对象而非范围」）。所以这里只做
// 两件事：校验形状、归一化成一个稳定键 `ref`。
//
// 三条规矩：
// 1. 纯函数：不读盘、不读库、不联网。项目根只作携带字段，本文件不碰它。
// 2. 不做兜底猜测：未知类型、缺字段、focus 里有未知项一律抛错并说明原因；不退回默认来源，
//    不把字符串猜成对象，也不把空 focus 当成「全都要」。
// 3. `ref` 是状态的唯一隔离维度（水位、变更队列、心跳都按它归档）。因此 ref 里只放
//    「是哪个对象」，不放「这次想看什么」：GitHub 的 focus 不进 ref，换关注面仍共用同一份水位。
/** 三类对象。顺序即界面与报错里的列举顺序，只写这一份。 */
export const WATCH_TARGET_TYPES = Object.freeze(['project', 'session', 'github']);

/** Agent 会话的来源：与 memory/session-scan 实际能读的两种本地会话一致，不先支持不存在的来源。 */
export const SESSION_SOURCES = Object.freeze(['codex', 'claude']);

/** GitHub 的关注面：commits / pull requests / issues 的子集，顺序固定便于比较与显示。 */
export const GITHUB_FOCUS = Object.freeze(['commits', 'pullRequests', 'issues']);

/** 与 memory/watermark 的项目 id 上限一致：同一个 id 在两处不该有不同长度规则。 */
const MAX_PROJECT_ID = 90;
const MAX_SESSION_ID = 200;
/** GitHub 账号最长 39、仓库名最长 100；沿用 github.mjs 的字符集，两处判定保持一致。 */
const MAX_OWNER = 39;
const MAX_REPO = 100;
/** 路径上限沿用 owner-store 的登记上限。 */
const MAX_ROOT = 1500;
const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/u;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u;

/**
 * 描述符不合法。带 code 是为了让调用方（面板、命令行）按原因分派文案，
 * 而不是去匹配中文字符串。
 */
export class WatchTargetError extends Error {
  constructor(message, code = 'target-invalid') {
    super(message);
    this.name = 'WatchTargetError';
    this.code = code;
  }
}

const reject = (message, code) => {
  throw new WatchTargetError(message, code);
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const typeList = () => WATCH_TARGET_TYPES.join(' / ');
const sourceList = () => SESSION_SOURCES.join(' / ');
const focusList = () => GITHUB_FOCUS.join(' / ');

/** 报错时把收到的值写清楚：数字、数组、null 都要能认出来，不能只写 [object Object]。 */
const show = (value) => {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(show).join(', ')}]`;
  return typeof value === 'object' ? '{…}' : String(value);
};

/**
 * 取一个必填的字符串字段：空、非字符串、含控制字符都按「缺」或「非法」分开报，
 * 这样调用方能看出是没给还是给坏了。
 */
const requireText = (raw, { field, label, max }) => {
  if (raw === undefined || raw === null) reject(`${label}缺少 ${field}`, 'target-field-missing');
  if (typeof raw !== 'string') reject(`${label} 的 ${field} 必须是字符串，收到 ${show(raw)}`, 'target-field-invalid');
  const value = raw.trim();
  if (!value) reject(`${label}缺少 ${field}`, 'target-field-missing');
  if (value.length > max) reject(`${label} 的 ${field} 过长（最多 ${max} 字符）`, 'target-field-invalid');
  if (CONTROL_CHARS.test(value)) reject(`${label} 的 ${field} 含控制字符`, 'target-field-invalid');
  return value;
};

/** 项目对象：项目 id 必填；项目根可携带，但不参与 ref、也不在这里校验存在性。 */
const projectTarget = (input) => {
  const projectId = requireText(input.projectId ?? input.project_id, {
    field: 'projectId', label: 'project 对象', max: MAX_PROJECT_ID
  });
  let root;
  if (input.root !== undefined && input.root !== null && input.root !== '') {
    root = requireText(input.root, { field: 'root', label: 'project 对象', max: MAX_ROOT });
  }
  return Object.freeze({
    type: 'project',
    ref: `project:${projectId}`,
    projectId,
    ...(root ? { root } : {})
  });
};

/** 会话对象：来源必须在已知的两种之内；未知来源直接拒绝，不退回默认。 */
const sessionTarget = (input) => {
  const rawSource = input.source;
  // 没给 / 空串按「缺字段」报，给了但认不得（包括给了数字）按「未知来源」报：
  // 两种情况修法不同，不能都压成一句「缺少 source」。
  if (rawSource === undefined || rawSource === null || (typeof rawSource === 'string' && !rawSource.trim())) {
    reject(`session 对象缺少 source（只支持 ${sourceList()}）`, 'target-field-missing');
  }
  const source = String(rawSource).trim();
  if (!SESSION_SOURCES.includes(source)) {
    reject(`未知的会话来源：${source}（只支持 ${sourceList()}）`, 'target-field-invalid');
  }
  const sessionId = requireText(input.sessionId ?? input.session_id, {
    field: 'sessionId', label: 'session 对象', max: MAX_SESSION_ID
  });
  return Object.freeze({
    type: 'session',
    ref: `session:${source}:${sessionId}`,
    source,
    sessionId
  });
};

/**
 * GitHub 关注的归一化：去重、按 GITHUB_FOCUS 的固定顺序排。
 * 空数组与未知项都拒绝——「什么都没选」不是一个可监控的对象。
 */
const focusOf = (raw) => {
  if (raw === undefined || raw === null) {
    reject(`github 对象缺少 focus（可选 ${focusList()} 的子集）`, 'target-field-missing');
  }
  if (!Array.isArray(raw)) {
    reject(`github 对象的 focus 必须是数组（可选 ${focusList()} 的子集），收到 ${show(raw)}`, 'target-field-invalid');
  }
  if (raw.length === 0) {
    reject(`github 对象的 focus 不能为空：至少选 ${focusList()} 之一`, 'target-focus-empty');
  }
  const chosen = new Set();
  for (const item of raw) {
    const key = typeof item === 'string' ? item.trim() : item;
    if (!GITHUB_FOCUS.includes(key)) {
      // 字符串项原样写出来（"stars" 不加引号），非字符串项按类型写，方便一眼看出给错了什么。
      const shown = typeof item === 'string' ? item : show(item);
      reject(`github 对象的 focus 里有未知项：${shown}（只支持 ${focusList()}）`, 'target-focus-unknown');
    }
    chosen.add(key);
  }
  return Object.freeze(GITHUB_FOCUS.filter((key) => chosen.has(key)));
};

/** GitHub 对象：owner/repo + 关注面子集；ref 小写，显示名保留原大小写。 */
const githubTarget = (input) => {
  const owner = requireText(input.owner, { field: 'owner', label: 'github 对象', max: MAX_OWNER });
  if (!GITHUB_NAME.test(owner)) {
    reject(`github 对象的 owner 不是合法的 GitHub 账号名：${owner}`, 'target-field-invalid');
  }
  const repo = requireText(input.repo, { field: 'repo', label: 'github 对象', max: MAX_REPO });
  if (!GITHUB_NAME.test(repo)) {
    reject(`github 对象的 repo 不是合法的仓库名：${repo}`, 'target-field-invalid');
  }
  const focus = focusOf(input.focus);
  return Object.freeze({
    type: 'github',
    // GitHub 的 owner/repo 不区分大小写：同一个仓库换大小写不该被当成两个对象、拆成两份水位。
    ref: `github:${owner.toLowerCase()}/${repo.toLowerCase()}`,
    owner,
    repo,
    nameWithOwner: `${owner}/${repo}`,
    focus
  });
};

// 用 Map 而不是普通对象：对象原型上的 constructor / __proto__ 会被当成「有这个类型」，
// 那就等于放进来一个没人认识的描述符；Map 只认这三个键。
const BUILDERS = new Map([
  ['project', projectTarget],
  ['session', sessionTarget],
  ['github', githubTarget]
]);

/**
 * 校验并归一化一个监控对象描述符。
 *
 * @param {object} input 形状：`{type:'project', projectId, root?}`
 *   / `{type:'session', source:'codex'|'claude', sessionId}`
 *   / `{type:'github', owner, repo, focus:['commits'|'pullRequests'|'issues', ...]}`
 * @returns {{type:string, ref:string}} 冻结的归一化描述符（另带各类型的结构字段）
 * @throws {WatchTargetError} 未知类型、缺字段、非法值、未知/空 focus
 */
export function normalizeWatchTarget(input) {
  if (!isObject(input)) {
    reject(`监控对象描述符必须是对象；收到 ${show(input)}`, 'target-not-object');
  }
  const type = typeof input.type === 'string' ? input.type.trim() : '';
  if (!type) {
    reject(`监控对象描述符缺少 type（只支持 ${typeList()}）`, 'target-type-missing');
  }
  const build = BUILDERS.get(type);
  if (!build) {
    reject(`未知的监控对象类型：${type}（只支持 ${typeList()}）`, 'target-type-unknown');
  }
  // 未在词表里的字段不报错也不采信：只做形状校验，字段名多一个不会变成另一个对象。
  return build(input);
}

/**
 * 对象在状态里的隔离键。等价于 `normalizeWatchTarget(input).ref`，
 * 单独导出只是让存储层读起来是一句「按 ref 隔离」。
 *
 * @param {object} input 监控对象描述符
 * @returns {string} `project:<id>` / `session:<source>:<id>` / `github:<owner>/<repo>`
 */
export function watchTargetRef(input) {
  return normalizeWatchTarget(input).ref;
}
