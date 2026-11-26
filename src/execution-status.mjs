// 执行状态的唯一判定处：终态、等你点头、仍在场内，以及「卡住 / 运行中 / 排队」的分界。
//
// 为什么要单独一个文件：#70 之前「哪些状态算终态」有四个副本（desktop/main.cjs、
// 旧面板、旧详情卡、src/knowledge-loop/execution-records.mjs），彼此已经不完全一致。
// 本票新增「跨项目运行中」时不能再造第五份，所以把判定收敛到这里：
// - execution-records.mjs 决定「哪些能提炼」；
// - desktop/main.cjs 决定「跨项目取哪些执行」。
// 两处都读本文件的状态集，同一件事不会在执行记录里算已终态、在别处还在跑。
//
// #111 撤掉旧面板后，旧的「运行账本 / 详情卡计数」不再存在；本文件仍是执行状态的唯一判定。
//
// 「卡住」不是另造的时间阈值，而是仓库既有的两种数据事实：
// - needs_reconciliation：owner-store 在租约过期后显式标记的状态，owner-agent.mjs
//   的摘要里直接叫它 stuck；系统不会自动重试。
// - 租约已经过期但还没来得及被 reconcile：状态仍写着 running / leased /
//   cancel_requested，但 lease_until 已过去，心跳断了。这正是「看着在跑、其实没活着」。
// 两种都算卡住，不需要猜「多久没更新算卡住」。

/** 各主体的终态：到了这里就不再需要人管，也不再进操作区。 */
export const TERMINAL = {
  job: new Set(['succeeded', 'failed', 'cancelled', 'rejected']),
  patch: new Set(['applied', 'rejected', 'apply_failed']),
  sandbox: new Set(['completed', 'failed', 'cancelled', 'rejected']),
  cycle: new Set(['tested_pass', 'tested_fail', 'failed', 'cancelled', 'rejected'])
};

/** 「等你点头」属于待办，不属于运行中：即使全部执行都递进来，也不会画两遍。 */
export const WAITING_APPROVAL = {
  job: new Set(['pending_approval']),
  patch: new Set(['proposed', 'approved']),
  sandbox: new Set(['pending_approval']),
  cycle: new Set(['pending_approval', 'proposal_ready'])
};

const union = (sets) => new Set(Object.values(sets).flatMap((set) => [...set]));
const ALL_TERMINAL = union(TERMINAL);
const ALL_WAITING = union(WAITING_APPROVAL);

const norm = (value) => String(value ?? '').toLowerCase();

/** 未知主体退回并集：宁可多认一种终态，也不把已结束的事画成还在跑。 */
export const isTerminal = (kind, status) => {
  const value = norm(status);
  if (!value) return false;
  return (TERMINAL[kind] ?? ALL_TERMINAL).has(value);
};

export const isWaitingApproval = (kind, status) => {
  const value = norm(status);
  if (!value) return false;
  return (WAITING_APPROVAL[kind] ?? ALL_WAITING).has(value);
};

/**
 * 这条执行还在不在场内（需要显示在操作区）。
 * 没有状态的一律不猜：无法判定终态就不画，宁可少一行也不画错一行。
 */
export const isInFlight = (kind, status) => {
  const value = norm(status);
  return Boolean(value) && !isTerminal(kind, value) && !isWaitingApproval(kind, value);
};

/**
 * 租约是否已经过期。没有租约（null/空串）不算过期：有些执行本来就没有租约。
 * 时间戳解析不了也不猜，按「没过期」处理，避免因为脏数据把活的说成卡住。
 */
const leaseExpired = (leaseUntil, now) => {
  const raw = String(leaseUntil ?? '');
  if (!raw) return false;
  const expiresAt = Date.parse(raw);
  return Number.isFinite(expiresAt) && expiresAt < Number(now);
};

/**
 * 在场执行的相位：界面据此把「卡住」和「运行中」分开画。
 * - stuck：needs_reconciliation（租约过期后显式标记），或租约已过期但状态还写着
 *   running / leased / cancel_requested（心跳断了，系统还没 reconcile）；
 * - stopping：cancel_requested，已经收到停止请求但还没确认；
 * - queued：已批准、还没被 worker 领取；
 * - running：其余在场状态（leased / running / provisioning / collecting /
 *   test_pending / applying / applied 等）。
 * 不在场的返回空串，调用方不该渲染它。
 */
export const executionPhase = (kind, status, { leaseUntil = '', now = Date.now() } = {}) => {
  if (!isInFlight(kind, status)) return '';
  const value = norm(status);
  if (value === 'needs_reconciliation') return 'stuck';
  if (leaseExpired(leaseUntil, now)) return 'stuck';
  if (value === 'cancel_requested') return 'stopping';
  if (value === 'queued') return 'queued';
  return 'running';
};

/** 相位的展示优先级：卡住最急，其次停止中，再是运行中、排队。 */
const PHASE_PRIORITY = { stuck: 0, stopping: 1, running: 2, queued: 3 };

const asList = (value) => (Array.isArray(value) ? value : []);
const text = (value) => (typeof value === 'string' ? value : '');
const projectIdOf = (item) => String(item?.project_id ?? item?.projectId ?? '');
const stampOf = (item) => text(item?.updated_at) || text(item?.updatedAt)
  || text(item?.created_at) || text(item?.createdAt);
const shortId = (id) => String(id ?? '').slice(0, 8);

/**
 * 把四张表（job / patch / sandbox run / repair cycle）摊平成操作区要的「在场执行」列表。
 *
 * 为什么需要这一层：view.chain 只装当前项目、每类最多一条（main.cjs 的
 * `activeJob ?? jobsInProject[0]`），拿不到「所有项目里还活着的执行」。这里按项目
 * 名称补齐显示字段，并按相位排序：卡住 → 停止中 → 运行中 → 排队，同级按最近更新。
 *
 * @param {object} tables 四张表的行（owner store 的原始形状，snake_case 也认）
 * @param {object} [options]
 * @param {Map<string,string>|object} [options.projectNames] 项目 id → 名称
 * @param {number} [options.limit] 上限；快照来自 limit=20 的取数窗口，默认同量级
 * @param {number} [options.now] 判断租约是否过期用的时间（测试可注入）
 * @returns {object[]} 只含非终态、非审批态的条目
 */
export function listInFlightExecutions(tables = {}, { projectNames, limit = 20, now = Date.now() } = {}) {
  const nameOf = (projectId) => {
    if (projectNames instanceof Map) return text(projectNames.get(projectId));
    if (projectNames && typeof projectNames === 'object') return text(projectNames[projectId]);
    return '';
  };
  const items = [];
  const push = (kind, row, title, detail) => {
    const status = text(row?.status);
    if (!isInFlight(kind, status)) return;
    const id = String(row?.id ?? '');
    const projectId = projectIdOf(row);
    const leaseUntil = text(row?.lease_until) || text(row?.leaseUntil);
    items.push({
      id,
      kind,
      projectId,
      projectName: nameOf(projectId),
      title,
      detail,
      status,
      phase: executionPhase(kind, status, { leaseUntil, now }),
      leaseUntil,
      at: stampOf(row)
    });
  };

  for (const job of asList(tables.jobs)) {
    push('job', job, text(job.title) || `任务 ${shortId(job.id)}`, text(job.job_type));
  }
  for (const patch of asList(tables.patches)) {
    const files = asList(patch.files).map((file) => text(file?.path ?? file)).filter(Boolean);
    push('patch', patch, files.join(', ') || `补丁 ${shortId(patch.id)}`, 'diff');
  }
  for (const run of asList(tables.sandboxes)) {
    const profile = text(run.profile?.id) || text(run.profile_id) || 'sandbox';
    push('sandbox', run, `${profile} 测试`, text(run.test_status));
  }
  for (const cycle of asList(tables.repairs)) {
    const scope = asList(cycle.repairScope).length ? asList(cycle.repairScope)
      : asList(cycle.repair_scope);
    push('cycle', cycle, `修复 ${scope.join(', ') || shortId(cycle.id)}`, '有界修复');
  }

  // 原地排序：调用方传进来的行不受影响（这里只排自己的投影数组）。
  items.sort((a, b) => {
    const byPhase = (PHASE_PRIORITY[a.phase] ?? 9) - (PHASE_PRIORITY[b.phase] ?? 9);
    if (byPhase !== 0) return byPhase;
    return String(b.at).localeCompare(String(a.at));
  });
  return items.slice(0, Math.max(0, Number(limit) || 0));
}
