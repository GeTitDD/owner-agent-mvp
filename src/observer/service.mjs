// 单项目观察流程编排：探针 → 事件 → 审计 → 投递。
//
// #27 只做「一次扫描一个项目」；多项目聚合、夜间静默与重试属于 #30，
// 指纹冷却属于 #28，这里都不实现。
import { probeProject } from './probe.mjs';
import { detectStaleEvent, DEFAULT_STALE_THRESHOLD_DAYS } from './events.mjs';
import { deliverFeishu, formatStaleMessage } from './feishu.mjs';

/**
 * 对一个已登记项目执行一次停滞检查。
 * 事件先落审计库再投递：即使投递失败或未配置，事实仍然留痕。
 * @param {{project:{id:string,name?:string,root:string}, store:object, webhookUrl?:string,
 *   now?:Date, thresholdDays?:number, fetchImpl?:Function, gitBin?:string}} options
 * @returns {Promise<{snapshot:object, event:object|null, eventId?:string,
 *   duplicate?:boolean, delivery:object|null, text?:string}>}
 */
export async function runStaleCheck({
  project,
  store,
  webhookUrl = '',
  now = new Date(),
  thresholdDays = DEFAULT_STALE_THRESHOLD_DAYS,
  fetchImpl,
  gitBin = 'git'
} = {}) {
  if (!project || typeof project.id !== 'string' || !project.root) throw new Error('A registered project is required');
  const snapshot = probeProject({
    projectId: project.id,
    projectName: project.name ?? '',
    root: project.root,
    gitBin
  });
  const event = detectStaleEvent(snapshot, { now, thresholdDays });
  if (!event) return { snapshot, event: null, delivery: null };

  const saved = store.recordEvent(event);
  const text = formatStaleMessage(event);
  const delivery = await deliverFeishu({ webhookUrl, text, fetchImpl });
  store.recordDelivery({
    eventId: saved.id,
    fingerprint: event.fingerprint,
    status: delivery.status,
    detail: delivery.detail,
    at: now.toISOString()
  });
  return { snapshot, event, eventId: saved.id, duplicate: saved.duplicate, delivery, text };
}
