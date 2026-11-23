// 单项目观察流程编排：探针 → 事件 → 审计 → 投递。
//
// #27 只做「停滞」；#29 在同一个探针与同一条投递链路上补上「漂移」与「积压」。
// 多项目聚合、夜间静默与重试属于 #30，指纹冷却属于 #28，这里都不实现。
import { probeProject } from './probe.mjs';
import {
  detectStaleEvent,
  detectDriftEvent,
  detectBacklogEvent,
  DEFAULT_STALE_THRESHOLD_DAYS
} from './events.mjs';
import { DEFAULT_THRESHOLDS } from './thresholds.mjs';
import { deliverFeishu, formatStaleMessage, formatEventMessage } from './feishu.mjs';

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

/**
 * 对一个已登记项目执行一次全量检查：停滞、漂移、积压共用同一份阈值与同一条投递链路。
 * 每条事件各自先落审计库再投递；单条投递失败不影响其余事件。
 * @param {{project:{id:string,name?:string,root:string}, store:object, webhookUrl?:string,
 *   now?:Date, thresholds?:object, fetchImpl?:Function, gitBin?:string}} options
 * @returns {Promise<{snapshot:object, events:object[], results:object[], deliveries:object[]}>}
 */
export async function runProjectCheck({
  project,
  store,
  webhookUrl = '',
  now = new Date(),
  thresholds = DEFAULT_THRESHOLDS,
  fetchImpl,
  gitBin = 'git'
} = {}) {
  if (!project || typeof project.id !== 'string' || !project.root) throw new Error('A registered project is required');
  const limits = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const snapshot = probeProject({
    projectId: project.id,
    projectName: project.name ?? '',
    root: project.root,
    gitBin
  });
  // 三类事件共用同一个快照与同一份阈值，避免重复探针与配置漂移。
  const detected = [
    detectStaleEvent(snapshot, { now, thresholdDays: limits.staleDays }),
    detectDriftEvent(snapshot, { now, driftCommits: limits.driftCommits }),
    detectBacklogEvent(snapshot, { now, backlogFiles: limits.backlogFiles })
  ].filter(Boolean);

  const events = [];
  const results = [];
  for (const event of detected) {
    const saved = store.recordEvent(event);
    const text = formatEventMessage(event);
    const delivery = await deliverFeishu({ webhookUrl, text, fetchImpl });
    store.recordDelivery({
      eventId: saved.id,
      fingerprint: event.fingerprint,
      status: delivery.status,
      detail: delivery.detail,
      at: now.toISOString()
    });
    events.push(event);
    results.push({ event, eventId: saved.id, duplicate: saved.duplicate, delivery, text });
  }
  return { snapshot, events, results, deliveries: results.map((item) => item.delivery) };
}
