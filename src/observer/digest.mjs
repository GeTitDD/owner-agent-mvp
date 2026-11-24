// 每日聚合与夜间静默（纯函数，零状态、零时钟依赖）。
//
// #30 的规则：
//   1. 一个项目在一个本地日历日最多一条聚合消息，列出三类事件计数与最严重的若干条摘要；
//   2. 22:00–08:00（可配置）不投递，事件顺延到下一个可投递日合并，不丢失；
//   3. 「一天」按本地日历日计算，因此这里只做本地日期/小时判断，时间由调用方注入。
//
// 聚合只描述事实：计数与摘要全部来自审计库里的事件，不在这里重新判定阈值，
// 也不改事件指纹与冷却语义（#28 / #29）。
import { canonical, sha256 } from '../utils.mjs';
import { DEFAULT_THRESHOLDS } from './thresholds.mjs';
import {
  EVENT_TYPES,
  countEventTypes,
  eventTypeLabel,
  eventTypeOrder,
  formatEventCounts
} from './event-types.mjs';
import { localDayKey, nextLocalDayKey } from './time.mjs';

export { countEventTypes, localDayKey, nextLocalDayKey };

/** 默认静默窗口：22:00（含）到次日 08:00（不含）。 */
export const DEFAULT_QUIET_HOURS = Object.freeze({ startHour: 22, endHour: 8 });

/** 聚合消息里默认保留几条最严重的事件摘要。 */
export const DEFAULT_DIGEST_SUMMARIES = 3;

const toDate = (value, label) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid ${label}`);
  return date;
};

const isHour = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 23;

/**
 * 校验并补全静默窗口配置。
 * @param {{startHour?:number, endHour?:number}|null} [quietHours]
 * @returns {{startHour:number, endHour:number}}
 */
export function normalizeQuietHours(quietHours = DEFAULT_QUIET_HOURS) {
  if (quietHours === null || quietHours === undefined) return { ...DEFAULT_QUIET_HOURS };
  const { startHour, endHour } = quietHours;
  if (!isHour(startHour) || !isHour(endHour)) throw new Error('Invalid quiet hours: hour must be an integer 0-23');
  // 起止相同意味着「全天静默」或「从不静默」，两种解释都危险，直接拒绝。
  if (startHour === endHour) throw new Error('Invalid quiet hours: start and end must differ');
  return { startHour, endHour };
}

/**
 * 当前是否处于静默窗口。窗口可以跨午夜（start > end）。
 * @param {Date|string} now
 * @param {{startHour:number, endHour:number}} [quietHours]
 * @returns {boolean}
 */
export function inQuietHours(now, quietHours = DEFAULT_QUIET_HOURS) {
  const { startHour, endHour } = normalizeQuietHours(quietHours);
  const hour = toDate(now, 'quiet clock').getHours();
  return startHour > endHour
    ? hour >= startHour || hour < endHour
    : hour >= startHour && hour < endHour;
}

/**
 * 聚合指纹：项目 + 本地日历日。与事件指纹分开，避免聚合占用单事件的 24 小时冷却窗口。
 * @param {{projectId:string, day:string}} input
 * @returns {string} 64 位十六进制
 */
export const digestFingerprint = ({ projectId, day }) => sha256(canonical({
  kind: 'daily-digest',
  projectId,
  day
}));

/**
 * 事件的严重度：度量 / 阈值。不同单位不能直接比大小，用「超过阈值多少倍」排序。
 * 阈值缺失或为 0 时退化为「有量就排前面」，保证排序稳定而不抛错。
 * @param {object} event
 * @param {object} [thresholds]
 * @returns {{ratio:number, value:number, threshold:number, typeRank:number, label:string, phrase:string}}
 */
export function eventSeverity(event, thresholds = DEFAULT_THRESHOLDS) {
  const spec = EVENT_TYPES[event?.type];
  const label = eventTypeLabel(event?.type);
  if (!spec) return { ratio: 0, value: 0, threshold: 0, typeRank: 99, label, phrase: label };
  const value = Number.isFinite(event[spec.field]) ? event[spec.field] : 0;
  const rawThreshold = thresholds?.[spec.threshold];
  const threshold = Number.isFinite(rawThreshold) && rawThreshold > 0 ? rawThreshold : 0;
  const ratio = threshold > 0 ? value / threshold : (value > 0 ? Number.POSITIVE_INFINITY : 0);
  return { ratio, value, threshold, typeRank: eventTypeOrder(event.type), label, phrase: spec.phrase(value) };
}

const detectedMs = (event) => {
  const ms = Date.parse(event?.detectedAt ?? '');
  return Number.isFinite(ms) ? ms : 0;
};

/**
 * 按严重度挑出最值得看的若干条事件。
 * 排序：越线倍数降序 → 类型次序（停滞/漂移/积压）→ 发生时间降序 → 事件 ID，保证稳定。
 * @param {object[]} events
 * @param {{thresholds?:object, limit?:number}} [options]
 * @returns {object[]}
 */
export function rankDigestEvents(events = [], { thresholds = DEFAULT_THRESHOLDS, limit = DEFAULT_DIGEST_SUMMARIES } = {}) {
  const max = Number.isSafeInteger(limit) && limit >= 1 ? limit : DEFAULT_DIGEST_SUMMARIES;
  return [...events]
    .map((event) => ({ event, severity: eventSeverity(event, thresholds) }))
    .sort((a, b) => (b.severity.ratio - a.severity.ratio)
      || (a.severity.typeRank - b.severity.typeRank)
      || (detectedMs(b.event) - detectedMs(a.event))
      || String(a.event.id ?? '').localeCompare(String(b.event.id ?? '')))
    .slice(0, max)
    .map((item) => item.event);
}

const summarize = (event, thresholds) => {
  const severity = eventSeverity(event, thresholds);
  const branch = event.branchLabel || event.branch || '';
  return `【${severity.label}】${severity.phrase}${branch ? ` · 分支 ${branch}` : ''}`;
};

/**
 * 一个项目的每日聚合消息：三类计数 + 最严重的 N 条摘要。
 * @param {{projectId:string, projectName?:string, day:string, events?:object[],
 *   thresholds?:object, maxSummaries?:number}} options
 * @returns {string}
 */
export function formatDigestMessage({
  projectId,
  projectName = '',
  day,
  events = [],
  thresholds = DEFAULT_THRESHOLDS,
  maxSummaries = DEFAULT_DIGEST_SUMMARIES
} = {}) {
  const name = projectName || projectId;
  const counts = countEventTypes(events);
  const top = rankDigestEvents(events, { thresholds, limit: maxSummaries });
  const lines = [
    `【每日聚合】${name}（${projectId}） · ${day}`,
    formatEventCounts(counts)
  ];
  if (top.length) {
    lines.push(`最严重 ${top.length} 条：`);
    top.forEach((event, index) => {
      lines.push(`${index + 1}. ${summarize(event, thresholds)}`);
    });
  } else {
    lines.push('今日无事件。');
  }
  return lines.join('\n');
}
