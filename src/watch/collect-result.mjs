// 采集结果形状（#120）：三个采集器共用一种返回，成功 / 未配置 / 失败三态显式。
//
// 为什么要有 status：空数组有两种意思——「看过了，确实没有新东西」与「根本没看成」。
// 父 spec 硬要求 GitHub 缺凭证时说「未配置」、探针读不到仓库时说明原因，所以状态显式
// 分三态（ok / unconfigured / error），而不是用「空 items + 可选 error」让调用方猜。
//
// cursor 是「这次看到哪」的时间点：采集是一次完整快照（git 清单读完、会话文件读到 EOF、
// GitHub 这一屏拉完），所以成功时就是本次快照时刻 now。失败与未配置一律 cursor = null，
// 表示「没看到哪」，调用方不得据此推进水位（ADR-0008：先算差异再推水位）。推进本身由
// 调用方做，本文件只给建议值，不碰存储。
//
// 结果不带正文：会话消息只带角色与时间，项目工作区只带「脏不脏」。搬运内容不是采集的活。
export const COLLECT_STATUS = Object.freeze(['ok', 'unconfigured', 'error']);

const MAX_ERROR_CODE = 60;
const MAX_ERROR_MESSAGE = 500;
const CONTROL_CHARS = /[\u0000-\u001f]+/gu;

/** 压成一行一句话：错误信息来自 git stderr / fetch，可能带换行与控制字符，界面只显示一行。 */
const clean = (value, max) => String(value ?? '')
  .replace(CONTROL_CHARS, ' ')
  .replace(/\s+/gu, ' ')
  .trim()
  .slice(0, max);

/**
 * 时间归一成毫秒。Date、毫秒数、ISO 串都认；解析不了返回 null（不拿 0 顶替，
 * 0 会把全部历史算成新的）。
 *
 * @param {Date|number|string|null|undefined} value
 * @returns {number|null}
 */
export const toMillis = (value) => {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value.trim());
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
};

/**
 * 毫秒转 UTC ISO；解析不了或超出 Date 范围时返回 null（不返回空串，免得被当成时间）。
 *
 * @param {number|null} ms
 * @returns {string|null}
 */
export const isoOf = (ms) => {
  if (!Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
};

/**
 * 这条事实是不是水位之后的：严格晚于水位才算新（恰好等于水位的那一刻已经看过了）。
 * 没有水位（首次心跳）或条目时间读不出来时按「新」算——文件/清单是完整读出的，
 * 证明不了它早于水位，就越不该替人把它算成已看过（ADR-0008：读不懂标未知，不猜）。
 *
 * @param {string|null} at ISO 时间
 * @param {number|null} sinceMs 水位（毫秒）；null 表示没有水位
 * @returns {boolean}
 */
export const isAfter = (at, sinceMs) => {
  if (sinceMs === null || sinceMs === undefined) return true;
  const ms = toMillis(at);
  if (ms === null) return true;
  return ms > sinceMs;
};

const errorOf = ({ code, message, focus = '' }) => {
  const codeValue = clean(code, MAX_ERROR_CODE);
  if (!codeValue) throw new Error('采集错误必须带原因码');
  if (!/^[a-z][a-z0-9-]*$/u.test(codeValue)) throw new Error(`采集错误的原因码不合法：${codeValue}`);
  const messageValue = clean(message, MAX_ERROR_MESSAGE);
  if (!messageValue) throw new Error('采集错误必须写清原因（不能只说失败了）');
  // focus 只在 GitHub 采集器里出现：多关注面时，说清是哪一面失败的。
  return { code: codeValue, message: messageValue, focus: clean(focus, MAX_ERROR_CODE) };
};

const resultOf = ({ type, ref, status, items, cursor, error }) => ({
  type,
  ref,
  status,
  items,
  cursor,
  error
});

/**
 * 采到了：items 是这次看到的事实，cursor 是本次快照时刻（可交给调用方推进水位）。
 *
 * @param {{type:string, ref:string, items?:Array<object>, now?:Date|number|string}} input
 * @returns {{type:string, ref:string, status:'ok', items:Array<object>, cursor:string, error:null}}
 */
export function okResult({ type, ref, items = [], now = new Date() }) {
  const cursor = isoOf(toMillis(now));
  // 快照没有时刻就没有游标：与其给个 null 让人以为可以推进，不如当场报错。
  if (!cursor) throw new Error('采集的 now 不是可解析的时间，无法给出游标');
  return resultOf({ type, ref, status: 'ok', items: [...items], cursor, error: null });
}

/**
 * 没配置（目前只有 GitHub 缺凭证）：不是失败，也不是「没有新东西」，
 * 而是一个可以修的配置缺失。items 为空，cursor 为 null。
 *
 * @param {{type:string, ref:string, code?:string, message:string, focus?:string}} input
 */
export function unconfiguredResult({ type, ref, code = 'target-unconfigured', message, focus = '' }) {
  return resultOf({
    type, ref, status: 'unconfigured', items: [], cursor: null, error: errorOf({ code, message, focus })
  });
}

/**
 * 没读成：原因码 + 一句人话，items 为空、cursor 为 null。原因不吞——
 * 读不到仓库/会话/远端时，界面要说得出是哪一步、为什么。
 *
 * @param {{type:string, ref:string, code:string, message:string, focus?:string}} input
 */
export function failedResult({ type, ref, code, message, focus = '' }) {
  return resultOf({
    type, ref, status: 'error', items: [], cursor: null, error: errorOf({ code, message, focus })
  });
}
