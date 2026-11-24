// 观察流程编排：探针 → 事件 → 审计 → 冷却 → 投递。
//
// 两条投递链路：
//   - 单事件链路（deliverEvent）：每条事件先落审计库，再按指纹判断冷却，冷却期内只记一条
//     skipped 投递。冷却依据是审计库里同一指纹最后一次成功投递的时间（ObserverStore.lastSentAt），
//     因此不持有进程内状态：重启后自然恢复，也不补发历史事件（#28）。
//   - 每日聚合链路（runDigestScan）：一次扫描覆盖全部已登记项目，每个项目每个本地日历日最多
//     一条聚合消息，列出三类事件计数与最严重的 3 条；22:00–08:00 不投递，顺延到下一个可投递日
//     合并（#30）。聚合状态落审计库，重启后不重复发也不丢待发。
import { probeProject } from './probe.mjs';
import {
  detectStaleEvent,
  detectDriftEvent,
  detectBacklogEvent,
  DEFAULT_STALE_THRESHOLD_DAYS
} from './events.mjs';
import { DEFAULT_THRESHOLDS, mergeThresholds } from './thresholds.mjs';
import { deliverFeishu, formatEventMessage } from './feishu.mjs';
import { evaluateCooldown, DEFAULT_COOLDOWN_MS } from './cooldown.mjs';
import {
  DEFAULT_DIGEST_SUMMARIES,
  DEFAULT_QUIET_HOURS,
  digestFingerprint,
  formatDigestMessage,
  inQuietHours,
  localDayKey,
  nextLocalDayKey,
  normalizeQuietHours
} from './digest.mjs';

/** 聚合投递租约：两个进程同时扫描时，同一聚合只有一方能发；崩溃后过期可被重新抢占。 */
const DIGEST_LEASE_MS = 120_000;

/** 单条事件投递失败时的重试次数（#30 只重试一次）。 */
const DELIVERY_RETRIES = 1;

/** 聚合详情落库前的长度上限，与 store 的 detail 校验保持一致。 */
const DETAIL_MAX = 1000;

/**
 * 单条事件的统一出口：记录事件 → 判断冷却 → 投递（或跳过）→ 记录投递。
 *
 * send=false 是 `observerctl check/stale` 的默认行为：只写事件与冷却判断，
 * 不真正投递、也不写投递记录；定时投递唯一入口是 digest。
 * @param {{event:object, store:object, webhookUrl?:string, now:Date, cooldownMs?:number,
 *   channel?:string, fetchImpl?:Function, send?:boolean}} options
 * @returns {Promise<{eventId:string, duplicate:boolean, delivery:object|null, cooldown:object,
 *   text:string, preview:boolean}>}
 */
async function deliverEvent({
  event,
  store,
  webhookUrl = '',
  now,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  channel = 'feishu',
  fetchImpl,
  send = true
}) {
  const saved = store.recordEvent(event);
  const text = formatEventMessage(event);
  const cooldown = evaluateCooldown({
    lastSentAt: store.lastSentAt({ fingerprint: event.fingerprint, channel }),
    now,
    cooldownMs
  });
  if (!send) {
    return { eventId: saved.id, duplicate: saved.duplicate, delivery: null, cooldown, text, preview: true };
  }
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
  return { eventId: saved.id, duplicate: saved.duplicate, delivery, cooldown, text, preview: false };
}

const assertProject = (project) => {
  if (!project || typeof project.id !== 'string' || !project.root) {
    throw new Error('A registered project is required');
  }
  return project;
};

/**
 * 对一个项目做一次只读探针并产出三类事件；不写库、不投递。
 * 单项目链路与每日聚合链路共用，避免两处阈值或判定漂移。
 * @param {{project:object, now:Date, thresholds?:object, gitBin?:string}} options
 * @returns {{snapshot:object, events:object[], limits:object}}
 */
function detectProjectEvents({ project, now, thresholds = DEFAULT_THRESHOLDS, gitBin = 'git' }) {
  const limits = mergeThresholds(thresholds);
  const snapshot = probeProject({
    projectId: project.id,
    projectName: project.name ?? '',
    root: project.root,
    gitBin
  });
  // 三类事件共用同一个快照与同一份阈值，避免重复探针与配置漂移。
  const events = [
    detectStaleEvent(snapshot, { now, thresholdDays: limits.staleDays }),
    detectDriftEvent(snapshot, { now, driftCommits: limits.driftCommits }),
    detectBacklogEvent(snapshot, { now, backlogFiles: limits.backlogFiles })
  ].filter(Boolean);
  return { snapshot, events, limits };
}

/**
 * 对一个已登记项目执行一次停滞检查（#27 的窄路径，保持原有返回结构）。
 * 复用 detectProjectEvents，避免这里另起一份探针或阈值合并逻辑。
 * @param {{project:{id:string,name?:string,root:string}, store:object, webhookUrl?:string,
 *   now?:Date, thresholdDays?:number, cooldownMs?:number, channel?:string,
 *   fetchImpl?:Function, gitBin?:string, send?:boolean}} options
 * @returns {Promise<{snapshot:object, event:object|null, eventId?:string, duplicate?:boolean,
 *   delivery:object|null, cooldown?:object, text?:string, preview?:boolean}>}
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
  gitBin = 'git',
  send = true
} = {}) {
  assertProject(project);
  const { snapshot, events } = detectProjectEvents({
    project,
    now,
    thresholds: { staleDays: thresholdDays },
    gitBin
  });
  const event = events.find((item) => item.type === 'stale') ?? null;
  if (!event) return { snapshot, event: null, delivery: null, text: null };

  const delivered = await deliverEvent({
    event, store, webhookUrl, now, cooldownMs, channel, fetchImpl, send
  });
  return { snapshot, event, ...delivered };
}

/**
 * 对一个已登记项目执行一次全量检查：停滞、漂移、积压共用同一份阈值与同一条投递链路。
 * 每条事件各自先落审计库、各自判断冷却；单条投递失败不影响其余事件。
 * send=false 时只写事件并返回预览文案（`observerctl check` 的默认行为）。
 * @param {{project:{id:string,name?:string,root:string}, store:object, webhookUrl?:string,
 *   now?:Date, thresholds?:object, cooldownMs?:number, channel?:string,
 *   fetchImpl?:Function, gitBin?:string, send?:boolean}} options
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
  gitBin = 'git',
  send = true
} = {}) {
  assertProject(project);
  const { snapshot, events } = detectProjectEvents({ project, now, thresholds, gitBin });

  const results = [];
  for (const event of events) {
    const delivered = await deliverEvent({
      event, store, webhookUrl, now, cooldownMs, channel, fetchImpl, send
    });
    results.push({ event, ...delivered });
  }
  return {
    snapshot,
    events: results.map((item) => item.event),
    results,
    deliveries: results.map((item) => item.delivery)
  };
}

/**
 * 投递一条聚合：抢占租约 → 现读聚合内事件 → 组装消息 → 失败重试一次。
 *
 * 只有 status='sent' 消耗当日额度；未配置 webhook（skipped）退回 pending，
 * 配置好后同一日仍能补发。failed 是当日终态（已重试过一次），原因写入审计库。
 * @returns {Promise<object>} 投递摘要
 */
async function deliverDigest({
  digest,
  store,
  webhookUrl,
  now,
  channel,
  fetchImpl,
  thresholds,
  maxSummaries
}) {
  const base = { digestId: digest.id, projectId: digest.projectId, day: digest.day };
  if (!store.claimDigest({ id: digest.id, now, leaseMs: DIGEST_LEASE_MS })) {
    // 另一个进程正在发同一条聚合：不重复发，也不覆盖它的状态。
    return { ...base, status: 'claimed-elsewhere', detail: 'delivery already in progress', attempts: [] };
  }

  const events = store.listDigestEvents(digest.id);
  if (!events.length) {
    // 当天没有任何事件就不发消息（缺陷修复：空聚合不该打扰人）。
    // 退回 pending 并释放租约：当天稍后真的出现事件时仍能正常发送。
    const detail = 'no events; nothing to send';
    store.finishDigest({ id: digest.id, status: 'pending', detail, now });
    return { ...base, status: 'empty', detail, text: '', attempts: [] };
  }
  const text = formatDigestMessage({
    projectId: digest.projectId,
    projectName: events[0]?.projectName || digest.projectId,
    day: digest.day,
    events,
    thresholds,
    maxSummaries
  });

  const attempts = [];
  let outcome = null;
  for (let attempt = 1; attempt <= 1 + DELIVERY_RETRIES; attempt += 1) {
    const result = await deliverFeishu({ webhookUrl, text, fetchImpl });
    attempts.push(result);
    store.recordDigestAttempt({
      digestId: digest.id,
      attempt,
      status: result.status,
      detail: result.detail,
      at: now.toISOString()
    });
    if (result.status !== 'failed') { outcome = result; break; }
  }

  if (!outcome) {
    // 两次都失败：把每次的原因都写进审计，便于事后定位（不回显 webhook）。
    const reasons = attempts
      .map((attempt, index) => `attempt ${index + 1}: ${attempt.detail}`)
      .join('; ');
    const detail = `delivery failed after retry: ${reasons}`.slice(0, DETAIL_MAX);
    store.finishDigest({ id: digest.id, status: 'failed', detail, now });
    return { ...base, status: 'failed', detail, text, attempts };
  }

  if (outcome.status === 'skipped') {
    // 没有 webhook 不算发过：保持待发，不占用当天额度。
    const detail = `pending: ${outcome.detail}`;
    store.finishDigest({ id: digest.id, status: 'pending', detail, now });
    return { ...base, status: 'skipped', detail, text, attempts };
  }

  store.finishDigest({ id: digest.id, status: 'sent', detail: outcome.detail, now });
  return { ...base, status: 'sent', detail: outcome.detail, text, attempts };
}

/**
 * 多项目每日聚合扫描（#30）。
 *
 * 步骤：逐项目探针并落事件 → 归入「项目 + 目标投递日」聚合 → 把过期待发聚合顺延到目标日
 * → 非静默窗口才投递。目标投递日是本地日历日：傍晚静默时改为次日，凌晨静默仍是当天，
 * 所以夜间事件会在次日早晨与当天事件合并成一条消息，不丢失也不多发。
 * @param {{projects?:object[], store:object, webhookUrl?:string, now?:Date, thresholds?:object,
 *   quietHours?:{startHour:number, endHour:number}, maxSummaries?:number, channel?:string,
 *   fetchImpl?:Function, gitBin?:string}} options
 * @returns {Promise<{day:string, targetDay:string, quiet:boolean, quietHours:object,
 *   projects:object[], rolled:object[], deliveries:object[]}>}
 */
export async function runDigestScan({
  projects = [],
  store,
  webhookUrl = '',
  now = new Date(),
  thresholds = DEFAULT_THRESHOLDS,
  quietHours = DEFAULT_QUIET_HOURS,
  maxSummaries = DEFAULT_DIGEST_SUMMARIES,
  channel = 'feishu',
  fetchImpl,
  gitBin = 'git'
} = {}) {
  if (!store || typeof store.ensureDigest !== 'function') throw new Error('An observer store is required');
  if (!Array.isArray(projects)) throw new Error('A list of registered projects is required');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Invalid digest clock');
  const quietWindow = normalizeQuietHours(quietHours);
  const summaries = Number.isSafeInteger(maxSummaries) && maxSummaries >= 1
    ? maxSummaries : DEFAULT_DIGEST_SUMMARIES;
  const limits = mergeThresholds(thresholds);

  const today = localDayKey(now);
  const quiet = inQuietHours(now, quietWindow);
  // 静默期内：傍晚（已过开始小时）投到明天，凌晨（还没到结束小时）投到今天稍后；
  // 这样 23:00 的事件顺延到次日，而 07:59 不会再推到第三天。
  const targetDay = quiet && now.getHours() >= quietWindow.endHour ? nextLocalDayKey(now) : today;

  const scanned = [];
  for (const project of projects) {
    assertProject(project);
    let snapshot;
    let events;
    try {
      ({ snapshot, events } = detectProjectEvents({ project, now, thresholds: limits, gitBin }));
    } catch (error) {
      // 单个仓库不可读（目录被删、git 缺失）不能阻断整轮扫描：
      // 否则夜间顺延的待发聚合也会跟着卡住。错误进返回值，由命令行显示。
      scanned.push({
        projectId: project.id,
        projectName: project.name ?? '',
        snapshot: null,
        events: [],
        digestId: null,
        hasEvents: false,
        skipped: false,
        error: error?.message ?? String(error)
      });
      continue;
    }
    const saved = events.map((event) => store.recordEvent(event));

    // 当日额度是否已被占用：sent / failed 都是终态，不再追加也不重发。
    const existing = store.listDigests({ projectId: project.id, day: targetDay, limit: 1 })[0] ?? null;
    const terminal = existing && (existing.status === 'sent' || existing.status === 'failed');
    let digestId = existing?.id ?? null;
    if (!terminal && existing) {
      // 已有待发聚合：只补挂事件，不重复建聚合。
      digestId = existing.id;
      if (saved.length) {
        store.addDigestEvents({ digestId: existing.id, eventIds: saved.map((item) => item.id), now });
      }
    } else if (!terminal && saved.length) {
      // 只有当天确实有事件才建聚合；零事件的项目不入聚合、不发消息。
      const digest = store.ensureDigest({
        projectId: project.id,
        day: targetDay,
        fingerprint: digestFingerprint({ projectId: project.id, day: targetDay }),
        now
      });
      digestId = digest.id;
      store.addDigestEvents({ digestId: digest.id, eventIds: saved.map((item) => item.id), now });
    }
    scanned.push({
      projectId: project.id,
      projectName: project.name ?? '',
      snapshot,
      events,
      digestId,
      hasEvents: saved.length > 0,
      skipped: Boolean(terminal),
      error: null
    });
  }

  // 停机跨天或夜间静默留下的待发聚合，统一顺延到目标日（不丢内容）。
  const rolled = store.rollPendingDigests({ toDay: targetDay, now });

  const deliveries = [];
  if (!quiet) {
    for (const due of store.listDueDigests({ day: today })) {
      deliveries.push(await deliverDigest({
        digest: due,
        store,
        webhookUrl,
        now,
        channel,
        fetchImpl,
        thresholds: limits,
        maxSummaries: summaries
      }));
    }
  }

  return {
    day: today,
    targetDay,
    quiet,
    quietHours: quietWindow,
    projects: scanned,
    rolled,
    deliveries
  };
}
