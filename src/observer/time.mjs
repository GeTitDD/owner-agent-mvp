// 本地日历时间格式化（单一来源）。
//
// 观察台与每日聚合都必须按用户本地日历判断「今天」，并且格式完全一致；
// 两处各写一份 pad/localDayKey 迟早会在时区边界或补零上出现偏差，因此收敛到这里。
const pad = (value) => String(value).padStart(2, '0');

const toDate = (value, label) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid ${label}`);
  return date;
};

/**
 * 本地日历日 YYYY-MM-DD。
 * @param {Date|string} [value]
 * @returns {string}
 */
export function localDayKey(value = new Date()) {
  const date = toDate(value, 'day clock');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 下一个本地日历日。用本地构造函数加一天，跨月、跨年与夏令时都交给 Date 处理。
 * @param {Date|string} [value]
 * @returns {string}
 */
export function nextLocalDayKey(value = new Date()) {
  const date = toDate(value, 'day clock');
  return localDayKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1));
}

/**
 * 本地日期时间 YYYY-MM-DD HH:mm；无法解析时返回占位符而不是抛错，
 * 因为它只用于展示，不应让一条坏数据拖垮整页。
 * @param {Date|string} value
 * @returns {string}
 */
export function formatLocalDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return `${localDayKey(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
