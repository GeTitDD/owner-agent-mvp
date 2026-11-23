// 单项目观察流程编排：探针 → 事件 → 审计 → 冷却 → 投递。
//
// 三条命令共用同一条投递链路（deliverEvent）：每条事件先落审计库，再按指纹判断冷却，
// 冷却期内只记一条 skipped 投递，不发消息。冷却依据是审计库里同一指纹最后一次成功投递
// 的时间（ObserverStore.lastSentAt），因此不持有进程内状态：重启后自然恢复，也不补发历史事件。
// 多项目聚合、夜间静默与投递重试属于 #30，这里不实现。
import { probeProject } from './probe.mjs';
import {
  detectStaleEvent,
  detectDriftEvent,
  detectBacklogEvent,
  DEFAULT_STALE_THRESHOLD_DAYS
} from './events.mjs';
import { DEFAULT_THRESHOLDS } from './thresholds.mjs';
import { deliverFeishu, formatEventMessage } from './feishu.mjs';
import { evaluateCooldown, DEFAULT_COOLDOWN_MS } from './cooldown.mjs';

/**
 * 单条事件的统一出口：记录事件 → 判断冷却 → 投递（或跳过）→ 记录投递。
 *
 * 冷却期内不发消息，但仍然写一条 status='skipped' 的投递记录：
 * 这样才能查清「为什么这次没收到」。只有 status='sent' 会占用窗口（见 cooldown.mjs）。
 * @param {{event:object, store:object, webhookUrl?:string, now:Date, cooldownMs?:number,
 *   channel?:string, fetchImpl?:Function}} options
 * @returns {Promise<{eventId:string, duplicate:boolean, delivery:object, cooldown:object, text:string}>}
 */
async function deliverEvent({
  event,
  store,
  webhookUrl = '',
  now,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  channel = 'feishu',
  fetchImpl
}) {
  const saved = store.recordEvent(event);
  const text = formatEventMessage(event);
  const cooldown = evaluateCooldown({
    lastSentAt: store.lastSentAt({ fingerprint: event.fingerprint, channel }),
    now,
    cooldownMs
  });
  const delivery = cooldown.coolingDown
    ? { status: 'skipped', detail: `cooldown active until ${cooldown.resumesAt}` }
    : await deliverFeishu({ webhookUrl, text, fetchImpl });

  store.recordDelivery({
    eventId: saved.id,
    fingerprint: event.fingerprint,
    channel,
    status: delivery.status,
    detail: delivery.detail,
    at: now.toISOString()
  });
  return { eventId: saved.id, duplicate: saved.duplicate, delivery, cooldown, text };
}

/**
 * 对一个已登记项目执行一次停滞检查（#27 的窄路径，保持原有返回结构）。
 * @param {{project:{id:string,name?:string,root:string}, store:object, webhookUrl?:string,
 *   now?:Date, thresholdDays?:number, cooldownMs?:number, channel?:string,
 *   fetchImpl?:Function, gitBin?:string}} options
 * @returns {Promise<{snapshot:object, event:object|null, eventId?:string, duplicate?:boolean,
 *   delivery:object|null, cooldown?:object, text?:string}>}
 */
export async function runStaleCheck({
  project,
  store,
  webhookUrl = '',
  now = new Date(),
  thresholdDays = DEFAULT_STALE_THRESHOLD_DAYS,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  channel = 'feishu',
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

  // 停滞消息由 formatEventMessage 按类型选中（与 #27 的格式一致）。
  const delivered = await deliverEvent({ event, store, webhookUrl, now, cooldownMs, channel, fetchImpl });
  return { snapshot, event, ...delivered };
}

/**
 * 对一个已登记项目执行一次全量检查：停滞、漂移、积压共用同一份阈值与同一条投递链路。
 * 每条事件各自先落审计库、各自判断冷却；单条投递失败不影响其余事件。
 * @param {{project:{id:string,name?:string,root:string}, store:object, webhookUrl?:string,
 *   now?:Date, thresholds?:object, cooldownMs?:number, channel?:string,
 *   fetchImpl?:Function, gitBin?:string}} options
 * @returns {Promise<{snapshot:object, events:object[], results:object[], deliveries:object[]}>}
 */
export async function runProjectCheck({
  project,
  store,
  webhookUrl = '',
  now = new Date(),
  thresholds = DEFAULT_THRESHOLDS,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  channel = 'feishu',
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

  const results = [];
  for (const event of detected) {
    const delivered = await deliverEvent({ event, store, webhookUrl, now, cooldownMs, channel, fetchImpl });
    results.push({ event, ...delivered });
  }
  return {
    snapshot,
    events: results.map((item) => item.event),
    results,
    deliveries: results.map((item) => item.delivery)
  };
}
