// 按需提炼与阈值提议：提议只是一条信号，不提炼、不写库。
//
// 阈值按「未提炼的执行记录条数」计，不按「同类现象」计——现象是提炼的产物，
// 提炼前并不存在。执行记录不落表，所以「未提炼」只能从经验表反推：记录的 id
// 不在已提炼的 source_record_id 集合里（LessonDistiller.queue 用的就是这个判定）。
// 因此这里只有读操作：查一遍 owner store 的项目与执行记录投影，再查一次经验表。
// 什么时候提炼由人决定，调用 distillOnDemand 才写经验。
import { EXECUTION_RECORD_LIMIT } from './execution-records.mjs';

export const DISTILL_PROPOSAL_THRESHOLD = 3;

/** 要统计的项目：指定了就只统计它，否则先列项目再逐个查，不扫描整张记录表。 */
const projectIdsFor = ({ distiller, projectId }) => {
  const id = String(projectId ?? '').trim();
  if (id) return [id];
  return (distiller.owner.listProjects() ?? []).map((project) => project.id).filter(Boolean);
};

/**
 * 提议信号查询：按项目统计未提炼的执行记录条数，达到阈值的返回 {projectId, count}。
 *
 * 返回值只是建议，不是队列也不是写入；重复调用结果稳定且不改变任何数据。
 * @param {{distiller: object, projectId?: string, threshold?: number}} input
 * @returns {{projectId: string, count: number}[]}
 */
export function listDistillProposals({ distiller, projectId = '', threshold = DISTILL_PROPOSAL_THRESHOLD } = {}) {
  if (!distiller || typeof distiller.queue !== 'function') throw new Error('distiller is required');
  if (!Number.isSafeInteger(threshold) || threshold < 1) {
    throw new Error('threshold must be a positive integer');
  }
  const proposals = [];
  for (const id of projectIdsFor({ distiller, projectId })) {
    // 与提炼共用同一个投影与上限：total 是队列里的未提炼条数，超过上限时按上限计。
    const pending = distiller.queue({ projectId: id, limit: EXECUTION_RECORD_LIMIT }).total;
    if (pending >= threshold) proposals.push({ projectId: id, count: pending });
  }
  // 条数多的排前面，同数按项目 ID：界面每次拿到同一个顺序。
  return proposals.sort((a, b) => b.count - a.count || a.projectId.localeCompare(b.projectId));
}

/**
 * 显式提炼入口：只有调用它才会写经验，提议本身不会触发这里。
 * 省略的参数沿用 LessonDistiller.distill 的默认值（哪些记录、多少条、用哪个提炼器）。
 */
export async function distillOnDemand({ distiller, projectId, recordIds, limit, extractor } = {}) {
  if (!distiller || typeof distiller.distill !== 'function') throw new Error('distiller is required');
  const id = String(projectId ?? '').trim();
  if (!id) throw new Error('projectId is required');
  return distiller.distill({ projectId: id, recordIds, limit, extractor });
}
