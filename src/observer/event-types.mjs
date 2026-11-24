// 观察事件类型注册表（单一来源）。
//
// 类型名、中文标签、风险等级、消息标题、计数文案、严重度口径与人读消息格式都只在这里定义。
// board / digest / feishu / observerctl 一律从这里取；新增第四类事件时只需在本文件补一项，
// 并把新的 detect* 接到 service.detectProjectEvents 上。
const nameOf = (event) => event.projectName || event.projectId;

/**
 * 定义一类事件。summary 由 messageTitle 统一拼出，避免「标题写死在消息里」而和注册表脱节。
 * @param {object} spec
 * @returns {object} 冻结后的类型定义
 */
const defineType = (spec) => {
  const { headline, lines, ...rest } = spec;
  const summary = (event) => [
    `【${spec.messageTitle}】${headline(event)}`,
    ...lines(event)
  ].join('\n');
  return Object.freeze({ ...rest, summary });
};

/**
 * 类型 -> 定义。字段说明：
 *   label        中文标签（徽章、消息、计数通用）
 *   riskLevel    观察台风险等级（与类型同名，便于 CSS class 稳定）
 *   messageTitle 单事件消息标题
 *   countLabel   聚合计数用的文案
 *   order        同分时的稳定次序：越靠前越危险
 *   field        证据字段
 *   threshold    thresholds.mjs 里的阈值字段
 *   unit         徽章单位
 *   reaches      越线判断，必须与 events.mjs 的判定保持一致
 *   phrase       人读的一句话度量
 *   badge        徽章文案
 *   headline/lines 单事件通知正文（标题由 messageTitle 补）
 */
export const EVENT_TYPES = Object.freeze({
  stale: defineType({
    type: 'stale',
    label: '停滞',
    riskLevel: 'stale',
    messageTitle: '停滞',
    countLabel: '停滞',
    order: 0,
    field: 'daysStale',
    threshold: 'staleDays',
    unit: '天',
    reaches: (value, limit) => value >= limit,
    phrase: (value) => `停滞 ${value} 天`,
    badge: (value) => `停滞 ${value} 天`,
    headline: (event) => `${nameOf(event)} 已停滞 ${event.daysStale} 天`,
    lines: (event) => [
      `项目：${nameOf(event)}（${event.projectId}）`,
      `分支：${event.branchLabel}`,
      `最后提交：${event.lastCommitAt}`
    ]
  }),
  drift: defineType({
    type: 'drift',
    label: '漂移',
    riskLevel: 'drift',
    messageTitle: '漂移',
    countLabel: '漂移',
    order: 1,
    field: 'behindTrunk',
    threshold: 'driftCommits',
    unit: '提交',
    reaches: (value, limit) => value > limit,
    phrase: (value) => `落后主干 ${value} 个提交`,
    badge: (value) => `漂移 ${value} 提交`,
    headline: (event) => `${nameOf(event)} 落后主干 ${event.behindTrunk} 个提交`,
    lines: (event) => [
      `项目：${nameOf(event)}（${event.projectId}）`,
      `分支：${event.branchLabel} → 主干：${event.trunkRef}`,
      `当前提交：${event.head}`
    ]
  }),
  backlog: defineType({
    type: 'backlog',
    label: '积压',
    riskLevel: 'backlog',
    messageTitle: '积压',
    countLabel: '积压',
    order: 2,
    field: 'uncommittedFiles',
    threshold: 'backlogFiles',
    unit: '文件',
    reaches: (value, limit) => value >= limit,
    phrase: (value) => `积压 ${value} 个未提交文件`,
    badge: (value) => `积压 ${value} 文件`,
    headline: (event) => `${nameOf(event)} 有 ${event.uncommittedFiles} 个未提交文件`,
    lines: (event) => [
      `项目：${nameOf(event)}（${event.projectId}）`,
      `分支：${event.branchLabel}`
    ]
  })
});

/** 所有类型名，顺序固定。 */
export const EVENT_TYPE_NAMES = Object.freeze(Object.keys(EVENT_TYPES));

/** 所有类型定义，顺序与 EVENT_TYPE_NAMES 一致。 */
export const EVENT_TYPE_LIST = Object.freeze(EVENT_TYPE_NAMES.map((type) => EVENT_TYPES[type]));

/** 是否为已注册事件类型。 */
export const isEventType = (type) => Object.hasOwn(EVENT_TYPES, type);

/** 类型定义；未知类型返回 null，调用方据此降级展示而不是崩溃。 */
export const eventTypeSpec = (type) => (isEventType(type) ? EVENT_TYPES[type] : null);

/** 中文标签；未知类型原样显示。 */
export const eventTypeLabel = (type) => eventTypeSpec(type)?.label ?? String(type ?? '');

/** 同分排序用的类型次序；未知类型排最后。 */
export const eventTypeOrder = (type) => eventTypeSpec(type)?.order ?? 99;

/** 三类计数都带 0，页面与消息不需要判空。 */
export function emptyEventCounts() {
  return Object.fromEntries(EVENT_TYPE_NAMES.map((type) => [type, 0]));
}

/**
 * 事件类型计数。
 * @param {object[]} events
 * @returns {Record<string, number>}
 */
export function countEventTypes(events = []) {
  const counts = emptyEventCounts();
  for (const event of events) {
    if (Object.hasOwn(counts, event?.type)) counts[event.type] += 1;
  }
  return counts;
}

/** 计数文案：停滞 1 · 漂移 0 · 积压 0。 */
export const formatEventCounts = (counts = {}) => EVENT_TYPE_LIST
  .map((spec) => `${spec.countLabel} ${counts[spec.type] ?? 0}`)
  .join(' · ');

/**
 * 按事件类型选择人读消息格式。
 * @param {object} event 任一类观察事件
 * @returns {string}
 */
export function formatEventMessage(event) {
  const spec = eventTypeSpec(event?.type);
  if (!spec) throw new Error(`Unknown observer event type: ${event?.type}`);
  return spec.summary(event);
}
