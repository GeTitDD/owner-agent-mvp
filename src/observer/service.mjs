// 单项目观察流程编排：探针 → 事件 → 审计 → 冷却 → 投递。
//
// 冷却（#28）的判断依据是审计库里同一指纹最后一次成功投递的时间，
// 因此不持有进程内状态：重启后自然恢复，也不会补发历史事件。
// 多项目聚合、夜间静默与投递重试属于 #30，这里不实现。
import { probeProject } from './probe.mjs';
import { detectStaleEvent, DEFAULT_STALE_THRESHOLD_DAYS } from './events.mjs';
import { deliverFeishu, formatStaleMessage } from './feishu.mjs';
import { evaluateCooldown, DEFAULT_COOLDOWN_MS } from './cooldown.mjs';

/**
 * 对一个已登记项目执行一次停滞检查。
 * 事件先落审计库再投递：即使投递失败、未配置或被冷却拦住，事实仍然留痕。
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

  const saved = store.recordEvent(event);
  const text = formatStaleMessage(event);
  const cooldown = evaluateCooldown({
    lastSentAt: store.lastSentAt({ fingerprint: event.fingerprint, channel }),
    now,
    cooldownMs
  });

  // 冷却期内不发消息，但仍然写一条投递记录：让人能查清「为什么这次没收到」。
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
  return { snapshot, event, eventId: saved.id, duplicate: saved.duplicate, delivery, cooldown, text };
}
