// 事件判定（纯函数）。
//
// 三类事件共用 thresholds.mjs 的阈值；24 小时指纹冷却属于 #28，不在这里实现。
// 事件只描述事实，投递格式留给 feishu 模块。
import { canonical, sha256 } from '../utils.mjs';
import { DEFAULT_THRESHOLDS } from './thresholds.mjs';

const DAY_MS = 86_400_000;

/** 停滞阈值（天）。默认值来自 thresholds.mjs，保持既有导出以兼容调用方。 */
export const DEFAULT_STALE_THRESHOLD_DAYS = DEFAULT_THRESHOLDS.staleDays;

/** detached HEAD 没有分支名，仍然需要一个稳定的展示与指纹用标签。 */
export const branchLabelOf = (snapshot) => snapshot.branch ?? '(detached HEAD)';

/**
 * 停滞事件指纹：由项目、分支标签、事件类型与关键值（最后提交）派生。
 * 同一仓库同一分支停在同一个提交上，指纹稳定；换分支或换提交都会产生新指纹。
 * @param {{projectId:string, branchLabel:string, head:string}} input
 * @returns {string} 64 位十六进制
 */
export const staleFingerprint = ({ projectId, branchLabel, head }) => sha256(canonical({
  type: 'stale',
  projectId,
  branch: branchLabel,
  head
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
    fingerprint: staleFingerprint({ projectId: snapshot.projectId, branchLabel, head: snapshot.head }),
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

/**
 * 漂移事件指纹：由项目、分支标签、HEAD、主干与落后提交数派生。
 * 落后得更深会换指纹，停在原地则指纹稳定。
 * @param {{projectId:string, branchLabel:string, head:string|null, trunkRef:string,
 *   behindTrunk:number}} input
 * @returns {string} 64 位十六进制
 */
export const driftFingerprint = ({ projectId, branchLabel, head, trunkRef, behindTrunk }) => sha256(canonical({
  type: 'drift',
  projectId,
  branch: branchLabel,
  head,
  trunk: trunkRef,
  behind: behindTrunk
}));

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
  const branchLabel = branchLabelOf(snapshot);
  return {
    type: 'drift',
    fingerprint: driftFingerprint({
      projectId: snapshot.projectId,
      branchLabel,
      head: snapshot.head,
      trunkRef: snapshot.trunkRef,
      behindTrunk
    }),
    projectId: snapshot.projectId,
    projectName: snapshot.projectName ?? '',
    branch: snapshot.branch,
    branchLabel,
    head: snapshot.head,
    trunkRef: snapshot.trunkRef,
    behindTrunk,
    detectedAt: now.toISOString()
  };
}

/**
 * 积压事件指纹：由项目、分支标签、HEAD 与未提交文件数派生。
 * 文件数变化会换指纹，保持同一积压规模则指纹稳定。
 * @param {{projectId:string, branchLabel:string, head:string|null, uncommittedFiles:number}} input
 * @returns {string} 64 位十六进制
 */
export const backlogFingerprint = ({ projectId, branchLabel, head, uncommittedFiles }) => sha256(canonical({
  type: 'backlog',
  projectId,
  branch: branchLabel,
  head,
  files: uncommittedFiles
}));

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
  const branchLabel = branchLabelOf(snapshot);
  return {
    type: 'backlog',
    fingerprint: backlogFingerprint({
      projectId: snapshot.projectId,
      branchLabel,
      head: snapshot.head ?? null,
      uncommittedFiles
    }),
    projectId: snapshot.projectId,
    projectName: snapshot.projectName ?? '',
    branch: snapshot.branch ?? null,
    branchLabel,
    head: snapshot.head ?? null,
    uncommittedFiles,
    detectedAt: now.toISOString()
  };
}
