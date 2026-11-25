// 专注页「操作区」的纯函数视图模型：回答「现在要你处理什么」。
//
// 为什么单独一个文件：#66 把专注页切成操作区与工作区，操作区的规则——哪三类进来、
// 按什么顺序、空态怎么表达、两个计数口径怎么算——必须先落在一处，后续界面票只负责画。
// 这里不读库、不读 DOM、不发请求：给定三份数据即得输出，也不重排待办（顺序来自快照，
// 分组来自 pending-groups.cjs），更不重新计算「未提炼够不够 3 条」（那是 on-demand.mjs 的事）。
//
// 两段来自操作区的两个问题：
// - 需要决定：待办（批准 / 拒绝）。
// - 需要知道：运行中与卡住（停 / 看）、待提炼提议（去提炼 / 稍后）。
// 这条归属同时保证了 #67 的固定顺序：待办 → 运行中 → 提议；两段只做分组展示，
// 不改变三段块的先后。
//
// 计数学知识页 browse.mjs 的做法给两个口径：project 是「当前视图项目几条」，
// all 是「全部项目几条」。与知识页的差别只有一个：操作区本身跨项目，
// 所以条目不做项目过滤（过滤掉就不是跨项目了），当前项目口径只用来显示「其中本项目几条」，
// 因此 block.count === block.items.length === block.counts.all 恒成立。
//
// 终态 / 审批态 / 相位（卡住、运行中、排队）的判定统一在 src/execution-status.mjs，
// 这里不再维护第二份状态集：同一批执行在提炼与操作区必须叫同一个名字。

import { executionPhase, isInFlight as inFlightStatus } from './execution-status.mjs';

/** 执行主体：面板与 owner store 两处叫法不同，这里统一成四个键。 */
const KIND_ALIASES = new Map(Object.entries({
  job: 'job',
  jobs: 'job',
  patch: 'patch',
  patches: 'patch',
  run: 'sandbox',
  runs: 'sandbox',
  sandbox: 'sandbox',
  'sandbox-run': 'sandbox',
  sandbox_run: 'sandbox',
  cycle: 'cycle',
  cycles: 'cycle',
  repair: 'cycle',
  repair_cycle: 'cycle',
  'repair-cycle': 'cycle'
}));

// 终态判定与 src/execution-status.mjs 共用同一份状态集：那里同时服务执行记录、
// 跨项目快照与本模型，避免同一件事在三个地方各有一种说法。

/**
 * 三段块的定义只在写一份：顺序、标题、空态说明都从这里出。
 * zone 指向它归属的那一段；改归属时只改这一列，两段与三段不会对不上。
 */
const BLOCK_DEFS = [
  {
    key: 'pending',
    zone: 'decide',
    title: '待办',
    emptyHint: '没有等你批准或拒绝的事。'
  },
  {
    key: 'running',
    zone: 'know',
    title: '运行中',
    emptyHint: '现在没有正在跑或卡住的执行。'
  },
  {
    key: 'proposing',
    zone: 'know',
    title: '待提炼',
    emptyHint: '没有攒够阈值的执行记录要提炼。'
  }
];

/** 两段的顺序固定为「需要决定 → 需要知道」，与块的顺序一致展开。 */
const ZONE_DEFS = [
  { key: 'decide', title: '需要决定', emptyHint: '没有要你决定的事。' },
  { key: 'know', title: '需要知道', emptyHint: '没有需要你知道的运行状态。' }
];

const asList = (value) => (Array.isArray(value) ? value : []);
const text = (value) => (typeof value === 'string' ? value : '');
const objectList = (value) => asList(value).filter((item) => item && typeof item === 'object');
const projectIdOf = (item) => String(item?.projectId ?? item?.project_id ?? '');
const statusOf = (item) => String(item?.status ?? '').toLowerCase();
const kindOf = (item) => {
  const raw = String(item?.kind ?? item?.source ?? item?.type ?? '').toLowerCase();
  return KIND_ALIASES.get(raw) ?? raw;
};

/**
 * 这条执行还在不在场内。
 * - 终态的不进操作区（ADR-0007：已终态的才成为执行记录与提炼原料）；
 * - 等你批准的属于待办，不在运行中重复出现；
 * - 没有状态的一律不猜：无法判定终态就不画，宁可少一行也不画错一行。
 * 判定本身在 execution-status.mjs，这里只按条目取 kind/status。
 */
const isInFlight = (item) => inFlightStatus(kindOf(item), statusOf(item));

/** 运行中的条目：只补齐渲染要用的字段，不动状态词与相位文案（文案映射留在面板）。 */
const runningItem = (item, now) => {
  const id = String(item.id ?? '');
  const kind = kindOf(item) || 'execution';
  const status = text(item.status);
  const leaseUntil = text(item.leaseUntil) || text(item.lease_until);
  return {
    id,
    kind,
    projectId: projectIdOf(item),
    projectName: text(item.projectName) || text(item.project_name),
    title: text(item.title) || text(item.taskTitle) || id,
    detail: text(item.detail),
    status,
    // 相位是模型给出的语义（stuck / stopping / queued / running），
    // 面板只负责把相位映射成中文与颜色，不自己判断状态。
    // 租约过期但状态还没被 reconcile 的执行，同样算卡住。
    phase: executionPhase(kind, status, { leaseUntil, now }),
    leaseUntil,
    at: text(item.occurredAt) || text(item.updated_at) || text(item.updatedAt) || text(item.created_at)
  };
};

/** 提议是一条「某项目已积 N 条未提炼」的信号（on-demand.mjs），不是一个可执行主体。 */
const proposalItem = (item) => {
  const projectId = projectIdOf(item);
  const raw = Number(item.count);
  const count = Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
  return {
    id: `distill:${projectId}`,
    kind: 'proposing',
    projectId,
    projectName: text(item.projectName) || text(item.project_name),
    count,
    title: `已积 ${count} 条未提炼，要提炼吗`
  };
};

/** 两个计数口径：没有视图项目时「当前项目」就是「全部项目」，与知识页一致。 */
const scopeCounts = (items, filterId) => ({
  project: filterId ? items.filter((item) => item.projectId === filterId).length : items.length,
  all: items.length
});

/**
 * 组装操作区视图模型：两段（需要决定 / 需要知道）与三段块（待办 / 运行中 / 待提炼）。
 *
 * @param {object} input
 * @param {string} [input.projectId] 当前视图项目；空串表示「全部项目」
 * @param {object[]} [input.pending] 待办条目（快照里的 pending，已按紧急度排好，原样透传）
 * @param {object[]} [input.executions] 执行（job / patch / sandbox / cycle 的任意并集）
 * @param {object[]} [input.proposals] 提炼提议（listDistillProposals 的返回：{projectId, count}）
 * @param {number} [input.now] 判断租约是否过期用的时间（测试可注入）
 * @returns {object} 供面板直接渲染的只读视图模型
 */
export function focusOpsView(input = {}) {
  const {
    projectId = '',
    pending = [],
    executions = [],
    proposals = [],
    now = Date.now()
  } = input ?? {};
  const filterId = String(projectId ?? '');

  // 待办原样透传（分组与排序是既有视图模型的事），只把 projectId 归一化，
  // 让下面两个口径与运行中、提议用同一种读法。
  const pendingItems = objectList(pending).map((item) => ({ ...item, projectId: projectIdOf(item) }));
  const runningItems = objectList(executions).filter(isInFlight)
    .map((item) => runningItem(item, now));
  // count 为 0 的提议不是提议：阈值由 on-demand.mjs 判定，这里只接住「够阈值」的那些。
  const proposalItems = objectList(proposals).map(proposalItem).filter((item) => item.count > 0);

  const buckets = { pending: pendingItems, running: runningItems, proposing: proposalItems };

  // 三段块只建一次；两段持有的是同一批对象引用，改一处文案不会出现两套。
  const blocks = BLOCK_DEFS.map((def) => {
    const items = buckets[def.key];
    const counts = scopeCounts(items, filterId);
    return {
      key: def.key,
      zone: def.zone,
      title: def.title,
      // count 是条目数，面板直接显示它；counts 给「其中本项目几条」用。
      count: counts.all,
      counts,
      empty: items.length === 0,
      emptyHint: def.emptyHint,
      items
    };
  });

  const sections = ZONE_DEFS.map((zone) => {
    const owned = blocks.filter((block) => block.zone === zone.key);
    const counts = {
      project: owned.reduce((sum, block) => sum + block.counts.project, 0),
      all: owned.reduce((sum, block) => sum + block.counts.all, 0)
    };
    return {
      key: zone.key,
      title: zone.title,
      count: counts.all,
      counts,
      // 空的那一段不产出占位条目：items 只存在于块里，空的块 items 为空数组。
      empty: counts.all === 0,
      emptyHint: zone.emptyHint,
      blocks: owned
    };
  });

  const empty = blocks.every((block) => block.empty);

  return {
    filter: { projectId: filterId },
    sections,
    blocks,
    // 三类全空时操作区压成一行（#66）：面板只读 empty/emptyText，不必自己再判断。
    empty,
    emptyText: empty ? '没有要你处理的事' : ''
  };
}
