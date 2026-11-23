// 事件判定（纯函数）。
//
// 本票实现「停滞」一类事件；漂移与积压属于 #29。指纹在这里派生，
// 24 小时冷却在 cooldown.mjs 里按指纹判断（#28）。
// 事件只描述事实，投递格式留给 feishu 模块。
import { canonical, sha256 } from '../utils.mjs';

const DAY_MS = 86_400_000;

/** 停滞阈值（天）。第一版是经验值，后续按误报率校准（见 OBSERVER_V0_1_PLAN 风险节）。 */
export const DEFAULT_STALE_THRESHOLD_DAYS = 3;

/** detached HEAD 没有分支名，仍然需要一个稳定的展示与指纹用标签。 */
export const branchLabelOf = (snapshot) => snapshot.branch ?? '(detached HEAD)';

/**
 * 停滞事件指纹：由仓库（projectId）、分支标签与事件类型派生。
 *
 * 刻意不含 HEAD、停滞天数与检测时间：票据 #28 要求「同一项目、同一分支、同一类事件
 * 24 小时内只通知一次」，若把 HEAD 放进指纹，同分支推一个新提交就会换指纹、绕过冷却。
 * HEAD 等仍作为事件证据字段保留在事件对象与审计表里，只是不参与指纹。
 * @param {{projectId:string, branchLabel:string}} input
 * @returns {string} 64 位十六进制
 */
export const staleFingerprint = ({ projectId, branchLabel }) => sha256(canonical({
  type: 'stale',
  projectId,
  branch: branchLabel
}));

/**
 * 判断快照是否越过了停滞阈值。
 * @param {object} snapshot probeProject 的输出
 * @param {{now?:Date, thresholdDays?:number}} [options]
 * @returns {object|null} 事件；未越线或无提交历史时返回 null
 */
export function detectStaleEvent(snapshot, { now = new Date(), thresholdDays = DEFAULT_STALE_THRESHOLD_DAYS } = {}) {
  if (typeof thresholdDays !== 'number' || !Number.isFinite(thresholdDays) || thresholdDays < 0) {
    throw new Error('Invalid stale threshold');
  }
  // 没有提交历史就没有「停滞」可言，这是正常状态而不是错误。
  if (!snapshot?.hasCommits || !snapshot.lastCommitAt) return null;
  const lastCommit = Date.parse(snapshot.lastCommitAt);
  if (!Number.isFinite(lastCommit)) return null;
  const ageMs = now.getTime() - lastCommit;
  if (ageMs <= thresholdDays * DAY_MS) return null;
  const branchLabel = branchLabelOf(snapshot);
  return {
    type: 'stale',
    fingerprint: staleFingerprint({ projectId: snapshot.projectId, branchLabel }),
    projectId: snapshot.projectId,
    projectName: snapshot.projectName ?? '',
    branch: snapshot.branch,
    branchLabel,
    head: snapshot.head,
    lastCommitAt: snapshot.lastCommitAt,
    daysStale: Math.floor(ageMs / DAY_MS),
    detectedAt: now.toISOString()
  };
}
