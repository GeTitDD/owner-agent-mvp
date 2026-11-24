// 事件判定（纯函数）。
//
// 三类事件共用 thresholds.mjs 的阈值；指纹在此派生（#28），
// 24 小时冷却在 cooldown.mjs 里按指纹判断。
// 事件只描述事实，投递格式留给 feishu 模块。
import { canonical, sha256 } from '../utils.mjs';
import { DEFAULT_THRESHOLDS } from './thresholds.mjs';

const DAY_MS = 86_400_000;

/** 停滞阈值（天）。默认值来自 thresholds.mjs，保持既有导出以兼容调用方。 */
export const DEFAULT_STALE_THRESHOLD_DAYS = DEFAULT_THRESHOLDS.staleDays;

/** detached HEAD 没有分支名，仍然需要一个稳定的展示与指纹用标签。 */
export const branchLabelOf = (snapshot) => snapshot.branch ?? '(detached HEAD)';

/**
 * 事件指纹：由事件类型、仓库（projectId）与分支标签派生。
 *
 * 刻意不含 HEAD、落后提交数、未提交文件数、阈值与检测时间：票据 #28 要求
 * 「同一项目、同一分支、同一类事件 24 小时内只通知一次」；若把 HEAD 或计数放进指纹，
 * 推一个新提交或积压更多文件就会换指纹、绕过冷却。这些量仍作为事件证据字段
 * 保留在事件对象与审计表里，只是不参与指纹。
 * @param {'stale'|'drift'|'backlog'} type
 * @param {string} projectId 已登记仓库标识
 * @param {string} branchLabel 分支标签（detached HEAD 用可读标签）
 * @returns {string} 64 位十六进制
 */
const eventFingerprint = (type, projectId, branchLabel) => sha256(canonical({
  type,
  projectId,
  branch: branchLabel
}));

/**
 * 三类事件共用的信封：类型、指纹、仓库、分支、HEAD 与检测时间只在这里拼一次。
 * @param {{type:string, snapshot:object, now:Date, evidence?:object}} options
 * @returns {object}
 */
const makeEvent = ({ type, snapshot, now, evidence = {} }) => {
  const branchLabel = branchLabelOf(snapshot);
  return {
    type,
    fingerprint: eventFingerprint(type, snapshot.projectId, branchLabel),
    projectId: snapshot.projectId,
    projectName: snapshot.projectName ?? '',
    branch: snapshot.branch ?? null,
    branchLabel,
    head: snapshot.head ?? null,
    ...evidence,
    detectedAt: now.toISOString()
  };
};

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
  return makeEvent({
    type: 'stale',
    snapshot,
    now,
    evidence: {
      lastCommitAt: snapshot.lastCommitAt,
      daysStale: Math.floor(ageMs / DAY_MS)
    }
  });
}

/**
 * 判断当前分支是否落后主干超过阈值（默认 10 个提交）。
 * 没有可比较的主干时不产生事件：那不是漂移，只是没有主干信息。
 * @param {object} snapshot probeProject 的输出
 * @param {{now?:Date, driftCommits?:number}} [options]
 * @returns {object|null}
 */
export function detectDriftEvent(snapshot, { now = new Date(), driftCommits = DEFAULT_THRESHOLDS.driftCommits } = {}) {
  if (!Number.isSafeInteger(driftCommits) || driftCommits < 0) throw new Error('Invalid drift threshold');
  if (!snapshot?.hasCommits || !snapshot.trunkRef) return null;
  const behindTrunk = Number.isSafeInteger(snapshot.behindTrunk) && snapshot.behindTrunk > 0
    ? snapshot.behindTrunk : 0;
  // “超过阈值”是开区间：落后 10 个不报，11 个才报。
  if (behindTrunk <= driftCommits) return null;
  return makeEvent({
    type: 'drift',
    snapshot,
    now,
    evidence: {
      trunkRef: snapshot.trunkRef,
      behindTrunk
    }
  });
}

/**
 * 判断未提交文件是否达到积压阈值（默认 20 个，达到即触发）。
 * 无提交历史的仓库也可能有积压，因此不要求 hasCommits。
 * @param {object} snapshot probeProject 的输出
 * @param {{now?:Date, backlogFiles?:number}} [options]
 * @returns {object|null}
 */
export function detectBacklogEvent(snapshot, { now = new Date(), backlogFiles = DEFAULT_THRESHOLDS.backlogFiles } = {}) {
  if (!Number.isSafeInteger(backlogFiles) || backlogFiles < 1) throw new Error('Invalid backlog threshold');
  const uncommittedFiles = Number.isSafeInteger(snapshot?.uncommittedFiles) && snapshot.uncommittedFiles >= 0
    ? snapshot.uncommittedFiles : 0;
  if (uncommittedFiles < backlogFiles) return null;
  return makeEvent({
    type: 'backlog',
    snapshot,
    now,
    evidence: { uncommittedFiles }
  });
}
