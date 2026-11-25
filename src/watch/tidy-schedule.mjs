// 定时整理的判定（#119）：给「当前时间 / 上次整理时间 / 计划时刻」回答两件事——该不该跑、是不是迟到。
//
// 这里只有纯函数，不读库、不碰盘、不装定时器：时钟与定时器由调用方注入（tidy-run.mjs），
// 所以「到点」「错过」「暂停」这些分支能单独测，不必等到真的过一天。
//
// 四条写死在这里，别的模块不用再想：
// 1. 计划时刻按本机日历：`09:00` 就是本机 09:00，用本地构造函数算边界，跨月跨年与夏令时交给 Date。
// 2. 「这个周期的计划时刻」取不晚于当前时间的最近一次边界；没到点就是昨天的边界（已经跑过）。
//    「下一次计划时刻」严格晚于当前时间——到点那一刻算下一次，避免同一分钟里连跑。
// 3. 该不该跑只看一件事：上次整理时间早于这个周期的计划时刻。没跑过也算该跑（补一次）。
// 4. 迟到 = 该跑而且已经晚于计划时刻。没有一个「上次」，就没有「本该跑的那次」，所以首次补跑不算迟到。
//    判迟到不靠猜：晚多少毫秒直接记在结果里（lateMs），调用方要宽限就给 graceMs。
//
// 计划时刻留空（''/null）表示「只要收集，不要自动判断」：不启用、不迟到、不排期（父 spec #102 用户故事 5）。

const SCHEDULE_PATTERN = /^(\d{1,2}):(\d{2})$/u;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const pad = (value) => String(value).padStart(2, '0');

/** 时间归一化成 Date；解析不了就抛错（时间错是调用方的 bug，不能悄悄退回「现在」）。 */
const toDate = (value, label) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid ${label}`);
  return date;
};

/** 上一次整理时间：空值表示「没整理过」；给了但解析不了按 bug 报错。 */
const lastRunMsOf = (value) => {
  if (value === undefined || value === null || value === '') return null;
  return toDate(value, '上次整理时间').getTime();
};

const disabled = (nowAt) => ({
  enabled: false,
  due: false,
  late: false,
  plannedAt: '',
  nextAt: '',
  nowAt,
  lateMs: 0,
  reason: 'disabled',
  schedule: ''
});

/**
 * 计划时刻的解析。
 * 只认两种输入：`'HH:MM'`（设置界面里的一行）与 `{hour, minute}`（配置对象）；
 * 空值一律当「不启用」。认不得就抛错——把 `'9点'` 猜成 09:00 等于替人改设置。
 *
 * @param {string|object|null|undefined} value
 * @returns {{enabled:boolean, hour:number, minute:number, text:string}}
 */
export function parseTidySchedule(value) {
  if (value === undefined || value === null) return { enabled: false, hour: -1, minute: -1, text: '' };
  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return { enabled: false, hour: -1, minute: -1, text: '' };
    if (CONTROL_CHARS.test(raw)) throw new Error('定时整理的时刻含控制字符');
    const matched = SCHEDULE_PATTERN.exec(raw);
    if (!matched) {
      throw new Error(`定时整理的时刻必须是 HH:MM（收到 ${JSON.stringify(raw)}）`);
    }
    return checked(Number(matched[1]), Number(matched[2]));
  }
  if (isObject(value)) {
    // minute 省略按 0 读：`{hour: 9}` 就是每天 09:00，这是唯一一个安全的缺省。
    const hour = Number(value.hour);
    const minute = value.minute === undefined || value.minute === null ? 0 : Number(value.minute);
    return checked(hour, minute);
  }
  throw new Error(`定时整理的时刻必须是 HH:MM 字符串或 {hour,minute}（收到 ${JSON.stringify(value)}）`);
}

function checked(hour, minute) {
  if (!Number.isSafeInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`定时整理的小时必须在 0-23 之间（收到 ${hour}）`);
  }
  if (!Number.isSafeInteger(minute) || minute < 0 || minute > 59) {
    throw new Error(`定时整理的分钟必须在 0-59 之间（收到 ${minute}）`);
  }
  return { enabled: true, hour, minute, text: `${pad(hour)}:${pad(minute)}` };
}

/** 本机日历上某天的计划时刻；dayOffset 为 0 是今天，-1 是昨天，1 是明天。 */
const boundaryOf = (now, schedule, dayOffset) => {
  const date = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + dayOffset,
    schedule.hour,
    schedule.minute,
    0,
    0
  );
  return { at: date.toISOString(), ms: date.getTime(), date };
};

/**
 * 不晚于当前时间的最近一次计划时刻。没启用返回 null。
 * 这个周期的「那一次」就是它：到点之前它落在昨天，到点之后落在今天。
 */
export function latestTidyAt({ now = new Date(), schedule = '' } = {}) {
  const at = toDate(now, '当前时间');
  const parsed = parseTidySchedule(schedule);
  if (!parsed.enabled) return null;
  const today = boundaryOf(at, parsed, 0);
  return at.getTime() >= today.ms ? today : boundaryOf(at, parsed, -1);
}

/**
 * 严格晚于当前时间的下一次计划时刻。没启用返回 null。
 * 到点那一刻（毫秒相等）返回明天的边界：同一分钟里不该再排一次。
 */
export function nextTidyAt({ now = new Date(), schedule = '' } = {}) {
  const at = toDate(now, '当前时间');
  const parsed = parseTidySchedule(schedule);
  if (!parsed.enabled) return null;
  const today = boundaryOf(at, parsed, 0);
  return at.getTime() < today.ms ? today : boundaryOf(at, parsed, 1);
}

/**
 * 这一次该不该整理。
 *
 * @param {object} input
 * @param {string|number|Date} [input.now] 当前时间（注入时钟的读数）
 * @param {string|number|Date|null} [input.lastRunAt] 上次整理的实际执行时间；没整理过给 null
 * @param {string|object} [input.schedule] 计划时刻：`'HH:MM'` / `{hour,minute}` / 空
 * @param {number} [input.graceMs] 迟到宽限：晚于计划时刻不超过这么多毫秒仍算「到点」
 * @returns {{enabled:boolean, due:boolean, late:boolean, plannedAt:string, nextAt:string,
 *   nowAt:string, lateMs:number, reason:string, schedule:string}}
 */
export function tidyDecision({ now = new Date(), lastRunAt = null, schedule = '', graceMs = 0 } = {}) {
  const at = toDate(now, '当前时间');
  const nowAt = at.toISOString();
  const parsed = parseTidySchedule(schedule);
  if (!parsed.enabled) return disabled(nowAt);

  const latest = latestTidyAt({ now: at, schedule: parsed });
  const next = nextTidyAt({ now: at, schedule: parsed });
  const lastMs = lastRunMsOf(lastRunAt);
  const lateMs = Math.max(0, at.getTime() - latest.ms);
  const grace = Number.isFinite(graceMs) && graceMs > 0 ? graceMs : 0;

  const base = {
    enabled: true,
    plannedAt: latest.at,
    nextAt: next.at,
    nowAt,
    schedule: parsed.text
  };

  if (lastMs === null) {
    // 从没整理过：补一次，但不算迟到——没有「本该跑的那次」。
    return { ...base, due: true, late: false, lateMs, reason: 'first-run' };
  }
  if (lastMs < latest.ms) {
    const late = lateMs > grace;
    return { ...base, due: true, late, lateMs, reason: late ? 'late' : 'due' };
  }
  // 这个周期已经整理过（或还没到点）：不跑，也不报迟到。
  return { ...base, due: false, late: false, lateMs: 0, reason: 'not-due' };
}
