// 事件冷却（纯函数）。
//
// 规则：同一指纹在同一渠道上，距上一次成功投递不足冷却窗口时不再重复通知。
// 「上一次成功投递」由调用方从审计库读出（见 ObserverStore.lastSentAt），
// 因此进程重启后冷却状态自然恢复，本模块只做时间比较，不持有任何状态、不读时钟。
//
// 只有 status='sent' 才算数：未配置 webhook（skipped）或投递失败（failed）
// 都还没有真正通知到人，不应占用 24 小时窗口，否则沉默会掩盖事件（重试见 #30）。

/** 冷却窗口：24 小时。 */
export const DEFAULT_COOLDOWN_HOURS = 24;
export const DEFAULT_COOLDOWN_MS = DEFAULT_COOLDOWN_HOURS * 60 * 60 * 1000;

/**
 * 判断某个指纹是否仍在冷却期内。
 * @param {{lastSentAt?:string|null, now?:Date, cooldownMs?:number}} [options]
 * @returns {{coolingDown:boolean, lastSentAt:string|null, resumesAt:string|null, remainingMs:number}}
 */
export function evaluateCooldown({
  lastSentAt = null,
  now = new Date(),
  cooldownMs = DEFAULT_COOLDOWN_MS
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(nowMs)) throw new Error('Invalid cooldown clock');
  if (typeof cooldownMs !== 'number' || !Number.isFinite(cooldownMs) || cooldownMs < 0) {
    throw new Error('Invalid cooldown window');
  }

  if (lastSentAt === null || lastSentAt === undefined) {
    return { coolingDown: false, lastSentAt: null, resumesAt: null, remainingMs: 0 };
  }
  const sentMs = typeof lastSentAt === 'string' ? Date.parse(lastSentAt) : NaN;
  if (!Number.isFinite(sentMs)) throw new Error('Invalid last sent time');

  // 正好满窗口即视为冷却结束，避免边界上「永远差一毫秒」。
  const remainingMs = Math.max(0, sentMs + cooldownMs - nowMs);
  return {
    coolingDown: remainingMs > 0,
    lastSentAt,
    resumesAt: remainingMs > 0 ? new Date(sentMs + cooldownMs).toISOString() : null,
    remainingMs
  };
}
