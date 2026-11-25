// 心跳的编排（#118）：读水位 → 算差异 → 入队 → 轮末推进，顺序写死在这一个函数里。
//
// 为什么顺序要写死：顺序反了就是 ADR-0008 点名的典型 bug——先推水位再算差异，等于这一轮
// 什么都没看见还宣称「都看过了」。所以这里没有提前 return：中间任何一步抛错，水位都停在
// 原处，下次心跳会重新看这一段。推进放在函数末尾，且只有「快照拿到了」才推：
// 拿不到快照时推进，等于把没看见的一段永久算成看过。
//
// 推进目标取快照自己的时刻（snapshot.at），不是心跳时刻：快照拍完到心跳结束之间落地的提交，
// 属于下一轮，不能被这一轮顺手算成看过。调用方没给快照时刻时才退回心跳时刻。
//
// 入队走 store.appendChanges：同一批变化跑两次（例如推进失败后重试）只入队一次，
// 重复的计数在存储层按 kind + ref + at 判掉。本文件不另建存储、不读文件内容、不写项目目录。
import { normalizeWatchTarget } from './target.mjs';
import { diffHeartbeat, heartbeatCard } from './heartbeat.mjs';

/** 时间归一化成 UTC ISO；解析不了抛错（时间错是调用方的 bug，不该静默退回当前时间）。 */
const toIso = (value, label = '心跳时间') => {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) throw new Error(`Invalid ${label}`);
    return value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value.trim());
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  throw new Error(`Invalid ${label}`);
};

/**
 * 水位要推到的时刻：优先快照自己的时刻，其次心跳时刻。
 * 快照时刻给了但解析不了，按调用方的 bug 报错，不悄悄退回心跳时刻。
 */
const watermarkAtOf = (snapshot, at) => {
  if (snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    const takenAt = snapshot.at;
    if (takenAt !== undefined && takenAt !== null && takenAt !== '') {
      return toIso(takenAt, '快照时刻');
    }
  }
  return at;
};

/** 一条「发现」落进队列时的形状：kind + ref（路径或 sha）+ 时间 + 供整理阶段看的 detail。 */
const changesOf = (diff) => [...diff.added, ...diff.modified, ...diff.deleted].map((item) => ({
  kind: item.kind,
  ref: item.id,
  at: item.at,
  detail: {
    label: item.label,
    ...(item.sha ? { sha: item.sha } : {}),
    ...(item.status ? { status: item.status } : {})
  }
}));

/** 心跳附注：只放一句人话，结论与正文不进状态库。 */
const noteOf = (diff) => {
  if (!diff.probe.ok) return `这次没算成：${diff.probe.reason}`;
  if (diff.empty) return '没有变化';
  const { added, modified, deleted } = diff.counts;
  return `发现 ${diff.counts.total} 条变化（新增 ${added} / 修改 ${modified} / 删除 ${deleted}）`;
};

/**
 * 跑一次心跳：先算后推，轮末才推进水位。
 *
 * @param {object} input
 * @param {object} input.store WatchStateStore（或同形状的替身）；需要 getWatermark /
 *   appendChanges / setWatermark / markHeartbeat
 * @param {object} input.target 监控对象描述符（project / session / github）
 * @param {object|Array|null} [input.snapshot] 当前快照；null 或 complete:false 表示这次没拿到
 * @param {string|number|Date} [input.at] 这次心跳的时刻，默认当前
 * @param {string} [input.note] 心跳附注；不给时按这一轮的结果写一句
 * @param {boolean} [input.advance] 是否推进水位；默认「快照算得了才推」
 * @returns {{diff:object, card:object, queued:object[], advanced:object|null,
 *   previousAt:string, watermark:object|null}}
 */
export function runHeartbeat({
  store, target, snapshot = null, at = new Date(), note = '', advance
} = {}) {
  if (!store
    || typeof store.getWatermark !== 'function'
    || typeof store.appendChanges !== 'function'
    || typeof store.setWatermark !== 'function'
    || typeof store.markHeartbeat !== 'function') {
    throw new Error('缺少监控状态存储（需要 WatchStateStore）');
  }
  const normalized = normalizeWatchTarget(target);
  const heartbeatAt = toIso(at);

  // ① 先读上次水位。没有就是 null —— 按「还分不清」，不是按「没有变化」。
  const previous = store.getWatermark(normalized);

  // ② 用旧水位算差异；纯函数，不碰库、不碰盘。这一步之后才允许碰状态。
  const diff = diffHeartbeat(previous, snapshot);

  // ③ 算完才入队。算不了的窗口一条也不写，免得把「没看见」记成「没有」。
  const queued = diff.probe.ok ? store.appendChanges(normalized, changesOf(diff)) : [];

  // ④ 轮末才推进：先算后推。快照没拿到就不推，这一段落下次还得重新看。
  const shouldAdvance = advance === undefined ? diff.probe.ok : Boolean(advance);
  const advanced = shouldAdvance ? store.setWatermark(normalized, watermarkAtOf(snapshot, heartbeatAt)) : null;
  store.markHeartbeat(normalized, { at: heartbeatAt, note: note || noteOf(diff) });

  const card = heartbeatCard({
    target: normalized,
    at: heartbeatAt,
    diff,
    queuedCount: queued.length
  });
  return {
    diff,
    card,
    queued,
    advanced,
    previousAt: previous?.at ?? '',
    // 不回头再读一次库：推进成功就是推进后的那一行，没推进就是原样。
    watermark: advanced ?? previous
  };
}
