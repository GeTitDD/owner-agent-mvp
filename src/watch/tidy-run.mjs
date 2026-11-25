// 定时整理的编排（#119）：判定 → 整理 → 记一次运行；以及「注入时钟与定时器」的调度器。
//
// 顺序与心跳同一套规矩：判定只读上次整理时间，整理失败一个字不写，
// 成功之后才把「这次整理到哪」记下来。失败时不记运行——不记，下一次仍然是该跑的状态，天然可重试；
// 记了就等于宣称整理过，那批变化会永远停在队列里没人再看（ADR-0008 的同一类错）。
//
// 调度器不直接使用 setInterval：时钟与定时器都从外面注入，测试给假时钟假定时器就能
// 断言「到点跑一次」「启动即补跑」「留空不排期」，不必真的等一天。调度器只管「什么时候问一次」，
// 「该不该跑」全在 runTidy 里判定——启动时调用一次 runTidy 就等于补跑检查，不需要第二套判断。
import { formatLocalDateTime } from '../observer/time.mjs';
import { normalizeWatchTarget } from './target.mjs';
import { nextTidyAt, parseTidySchedule, tidyDecision } from './tidy-schedule.mjs';
import { tidyQueue } from './tidy.mjs';

/** Node 的 setTimeout 超过这个数会被当成 1ms：一天的毫秒远小于它，仍然夹一道更稳。 */
const MAX_TIMER_DELAY = 2 ** 31 - 1;

/** 运行附注：只放一句人话，结论与正文不在这里（与心跳附注同一条规矩）。 */
const noteOf = (decision, result) => {
  const plan = formatLocalDateTime(decision.plannedAt);
  const ran = formatLocalDateTime(decision.nowAt);
  const body = result.changes === 0
    ? '队列是空的'
    : `${result.changes} 条变更 → ${result.submitted.length} 条候选`;
  if (decision.late) return `迟到补跑：计划 ${plan}，实际 ${ran}；${body}`;
  return `按时整理：计划 ${plan}；${body}`;
};

/**
 * 跑一次定时整理。该不该跑由 tidyDecision 判；不该跑就什么都不动（队列照样只收集）。
 *
 * @param {object} input
 * @param {object} input.store WatchStateStore（需要 getTidy / markTidy / listChanges / clearChanges）
 * @param {object} input.target 监控对象描述符
 * @param {object} input.personalStore PersonalKnowledgeStore（候选入口）
 * @param {Function} [input.distill] 注入的提炼器；不给时用兜底清单
 * @param {string|object} [input.schedule] 计划时刻；留空 = 只收集不整理
 * @param {string|number|Date} [input.now] 当前时间（注入时钟的读数）
 * @param {string} [input.actor] 提交者标识
 * @param {number} [input.limit] 这一批最多读多少条队列
 * @param {number} [input.graceMs] 迟到宽限（毫秒）
 * @param {string} [input.note] 覆盖运行附注
 * @returns {object} 运行结果：ran / late / plannedAt / ranAt / changes / submitted / decision
 */
export function runTidy({
  store, target, personalStore = null, distill = null, schedule = '',
  now = new Date(), actor = 'watch', limit = 200, graceMs = 0, note = ''
} = {}) {
  if (!store || typeof store.listChanges !== 'function' || typeof store.clearChanges !== 'function') {
    throw new Error('缺少监控状态存储（需要 WatchStateStore）');
  }
  if (typeof store.markTidy !== 'function' || typeof store.getTidy !== 'function') {
    throw new Error('监控状态存储缺少整理记录（需要 getTidy / markTidy）');
  }
  const normalized = normalizeWatchTarget(target);
  const last = store.getTidy(normalized);
  const decision = tidyDecision({ now, lastRunAt: last?.ranAt ?? null, schedule, graceMs });

  if (!decision.due) {
    return {
      ok: true,
      ran: false,
      attempted: false,
      reason: decision.reason,
      late: false,
      plannedAt: decision.plannedAt,
      ranAt: '',
      changes: 0,
      submitted: [],
      skipped: 0,
      decision
    };
  }

  const result = tidyQueue({
    store,
    target: normalized,
    personalStore,
    distill,
    at: decision.nowAt,
    actor,
    limit,
    plannedAt: decision.plannedAt,
    late: decision.late
  });

  if (!result.ok) {
    // 失败不记运行：队列原样留着，下次启动 / 下个周期仍会判定「该跑」。
    return {
      ok: false,
      ran: false,
      attempted: true,
      code: result.code,
      reason: result.reason,
      queueKept: true,
      late: decision.late,
      plannedAt: decision.plannedAt,
      ranAt: decision.nowAt,
      changes: result.changes,
      submitted: result.submitted,
      skipped: 0,
      decision
    };
  }

  const tidy = store.markTidy(normalized, {
    plannedAt: decision.plannedAt,
    ranAt: decision.nowAt,
    late: decision.late,
    note: note || noteOf(decision, result)
  });

  return {
    ok: true,
    ran: true,
    attempted: true,
    reason: decision.reason,
    empty: result.empty,
    late: decision.late,
    plannedAt: decision.plannedAt,
    ranAt: decision.nowAt,
    changes: result.changes,
    submitted: result.submitted,
    skipped: result.skipped,
    rejected: result.rejected,
    tidy,
    decision
  };
}

/**
 * 定时整理调度器：注入时钟与定时器，到点问一次 runTidy；启动时也问一次（补跑检查）。
 *
 * 为什么启动时无条件问一次：runTidy 自己会判「该不该跑」，所以这一次调用在按时的情况下
 * 什么也不做，在错过的机器上正好补跑一次并标迟到——不需要在调度器里再写一遍判定。
 *
 * @param {object} input
 * @param {object|string} input.schedule 计划时刻；留空 = 不排期、不整理
 * @param {Function} input.runOnce 跑一次整理：`(now:Date) => result`，通常是 runTidy 的包装
 * @param {() => Date} [input.clock] 时钟；测试注入假时钟
 * @param {{setTimeout:Function, clearTimeout:Function}} [input.timers] 定时器；测试注入假定时器
 * @param {Function} [input.onResult] 每次结果回调（界面据此更新状态卡）；它抛错不打断排期
 * @param {boolean} [input.catchUp] 启动时是否先问一次；默认 true（补跑）
 * @returns {{active:boolean, last:object|null, scheduled:boolean, stop:Function, checkNow:Function}}
 */
export function startTidyScheduler({
  schedule = '', runOnce, clock = () => new Date(), timers = null, onResult = () => {}, catchUp = true
} = {}) {
  const parsed = parseTidySchedule(schedule);
  const timerImpl = timers ?? { setTimeout, clearTimeout };
  if (typeof timerImpl.setTimeout !== 'function' || typeof timerImpl.clearTimeout !== 'function') {
    throw new Error('定时器需要 setTimeout / clearTimeout');
  }
  if (parsed.enabled && typeof runOnce !== 'function') throw new Error('定时整理需要 runOnce');

  let stopped = false;
  let handle = null;
  let last = null;

  const current = () => {
    const value = clock();
    return value instanceof Date ? value : new Date(value);
  };

  /** 问一次。runOnce 抛出的异常折成失败结果交给 onResult：一轮崩了不该让排期消失。 */
  const fire = () => {
    if (stopped) return null;
    let result;
    try {
      result = runOnce(current());
    } catch (error) {
      result = { ok: false, ran: false, code: 'run-error', reason: `${error?.message ?? error}` };
    }
    last = result;
    try {
      onResult(result);
    } catch {
      // 观察者的错（渲染、日志）不该打断下一轮。
    }
    return result;
  };

  const scheduleNext = () => {
    if (stopped || !parsed.enabled) return;
    const now = current();
    const next = nextTidyAt({ now, schedule: parsed });
    if (!next) return;
    const delay = Math.min(Math.max(0, next.ms - now.getTime()), MAX_TIMER_DELAY);
    handle = timerImpl.setTimeout(() => {
      handle = null;
      if (stopped) return;
      try {
        fire();
      } finally {
        // 失败也照排下一次：可重试的意思是「下一轮还会来」，不是要人手动重启调度器。
        scheduleNext();
      }
    }, delay);
  };

  const stop = () => {
    stopped = true;
    if (handle !== null) {
      timerImpl.clearTimeout(handle);
      handle = null;
    }
  };

  if (parsed.enabled) {
    if (catchUp) fire();
    scheduleNext();
  }

  return {
    get active() { return !stopped && parsed.enabled; },
    get scheduled() { return handle !== null; },
    get last() { return last; },
    stop,
    checkNow: () => fire()
  };
}
