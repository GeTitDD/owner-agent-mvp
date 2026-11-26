// #135 `/提炼决策`：项目内的决策扫描回合与待办状态。
//
// 复用 #86 / #85 / #87 的既有管道，不另写一套提炼：
// - 扫描：session-scan.mjs 的 scanSessions（读 Codex / Claude Code 会话、按 cwd 匹配项目）；
// - 提炼：decision-draft.mjs 的配对、注入过滤、指纹去重；
// - 入库：decision-confirm.mjs 的 confirmDecisionCandidate（只在人接受时调用）。
//
// 本文件补的是「一次命令的回合」：
// 1. 只把当前项目传给 scanSessions，别的项目的会话匹配不上，也不会被记成已扫过；
// 2. 有未处理候选时先给待办，不扫描；待办清空后才继续扫；
// 3. 候选落进 memory-scan.json 的 pending，人接受 / 拒绝之前不进知识库；
// 4. 拒绝记指纹；之后的扫描与合并都跳过它，同一内容不再出现；
// 5. 扫描抛错、会话读不出来、结果被截断都生成 partial / failed 回执，不伪造空成功。
//
// 不读项目目录、不联网、不调模型；会话读取失败与提炼失败都在计数里说明。

import { flatText } from '../utils.mjs';
import { confirmDecisionCandidate } from './decision-confirm.mjs';

const TEXT = {
  project: 90,
  fingerprint: 128,
  name: 200,
  phenomenon: 500,
  intent: 2000,
  abandoned: 2000,
  reason: 2000,
  quote: 2000,
  ref: 500,
  at: 80
};

const DEFAULTS = {
  pending: 500,
  rejected: 2000,
  sessions: 5000,
  fingerprints: 5000,
  // 扫描结果默认只回 60 条样本；待办要全量，所以这里把样本上限抬高。
  maxCandidateSample: 500
};

const asText = (value, max = 0) => flatText(value, max);

/** 证据引用：只留能回查的四个字段，超长截断；不认识的条目丢掉。 */
const normalizeEvidence = (value) => {
  if (!Array.isArray(value)) return [];
  const refs = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const role = asText(item.role, 20);
    if (!role) continue;
    const index = Number.isFinite(item.index) ? item.index : null;
    if (index === null) continue;
    refs.push({
      role,
      index,
      sessionId: asText(item.sessionId, TEXT.ref),
      at: asText(item.at, TEXT.at)
    });
  }
  return refs;
};

/** 候选 → 待办记录：项目 id、指纹、四个字段、来源与会话出处缺一不可。 */
export function pendingRecordOf(candidate = {}, { projectId = '', projectName = '', now = '' } = {}) {
  const evidence = normalizeEvidence(candidate?.evidence);
  const owner = asText(projectId || candidate?.projectId, TEXT.project);
  const fingerprint = asText(candidate?.fingerprint, TEXT.fingerprint);
  if (!owner || !fingerprint) return null;
  const phenomenon = asText(candidate?.phenomenon || candidate?.quote?.user, TEXT.phenomenon);
  const intent = asText(candidate?.intent, TEXT.intent);
  const abandoned = asText(candidate?.abandoned, TEXT.abandoned);
  const reason = asText(candidate?.reason, TEXT.reason);
  const sessionId = asText(candidate?.sessionId || evidence[0]?.sessionId, TEXT.ref);
  return {
    projectId: owner,
    projectName: asText(projectName || candidate?.projectName, TEXT.name),
    fingerprint,
    phenomenon,
    intent,
    abandoned,
    reason,
    // 理由空着就是空着：missingReason 单独存，确认时据此追问一句，绝不填占位词。
    missingReason: reason === '',
    partial: candidate?.partial === true,
    quote: {
      user: asText(candidate?.quote?.user || phenomenon, TEXT.quote),
      assistant: asText(candidate?.quote?.assistant, TEXT.quote)
    },
    evidence,
    source: asText(candidate?.source, 40),
    sessionId,
    sessionPath: asText(candidate?.sessionPath, TEXT.ref),
    foundAt: asText(now || candidate?.foundAt || candidate?.at, TEXT.at)
  };
}

const normalizePending = (value, limits) => {
  const records = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const record = pendingRecordOf(raw, {
      projectId: raw?.projectId,
      projectName: raw?.projectName,
      now: raw?.foundAt
    });
    if (!record) continue;
    const key = `${record.projectId}\u0000${record.fingerprint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(record);
  }
  return records.slice(-Math.max(1, limits.pending));
};

const normalizeRejected = (value, limits) => {
  const records = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const projectId = asText(raw?.projectId, TEXT.project);
    const fingerprint = asText(raw?.fingerprint, TEXT.fingerprint);
    if (!projectId || !fingerprint) continue;
    const key = `${projectId}\u0000${fingerprint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push({ projectId, fingerprint, at: asText(raw?.at, TEXT.at) });
  }
  return records.slice(-Math.max(1, limits.rejected));
};

/**
 * 状态归一：读文件、老版本（只有 sessions / fingerprints）与坏数据都走这一处。
 * 老字段原样保留，新字段缺省为空数组；is 推断只做一次，别让界面层再猜。
 */
export function normalizeDecisionScanState(value, limits = {}) {
  const caps = { ...DEFAULTS, ...limits };
  const state = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const strings = (items) => (Array.isArray(items) ? items.filter((item) => typeof item === 'string' && item) : []);
  return {
    sessions: strings(state.sessions).slice(-Math.max(1, caps.sessions)),
    fingerprints: strings(state.fingerprints).slice(-Math.max(1, caps.fingerprints)),
    pending: normalizePending(state.pending, caps),
    rejected: normalizeRejected(state.rejected, caps)
  };
}

/** 当前项目的未处理候选；顺序按发现时间，先发现的先给人看。 */
export function pendingOf(state, projectId) {
  const owner = asText(projectId, TEXT.project);
  if (!owner) return [];
  return normalizeDecisionScanState(state).pending.filter((item) => item.projectId === owner);
}

/** 当前项目拒绝过的指纹；扫描与合并都用它挡住同一内容。 */
export function rejectedFingerprintsOf(state, projectId) {
  const owner = asText(projectId, TEXT.project);
  if (!owner) return [];
  return normalizeDecisionScanState(state).rejected
    .filter((item) => item.projectId === owner)
    .map((item) => item.fingerprint);
}

/** 待办摘要（只读）：定位屏要的「每个项目几条 + 条目」。不建界面、不扫描。 */
export function pendingSummary(state, projects = []) {
  const current = normalizeDecisionScanState(state);
  const groups = new Map();
  for (const item of current.pending) {
    if (!groups.has(item.projectId)) {
      groups.set(item.projectId, {
        projectId: item.projectId,
        projectName: item.projectName,
        count: 0,
        items: []
      });
    }
    const group = groups.get(item.projectId);
    group.count++;
    if (!group.projectName && item.projectName) group.projectName = item.projectName;
    group.items.push({
      fingerprint: item.fingerprint,
      title: item.phenomenon || '（没有现象描述）',
      intent: item.intent,
      abandoned: item.abandoned,
      reason: item.reason,
      missingReason: item.missingReason,
      source: item.source,
      sessionId: item.sessionId,
      foundAt: item.foundAt
    });
  }
  const listed = (Array.isArray(projects) ? projects : [])
    .filter((project) => project && typeof project === 'object' && asText(project.id, TEXT.project))
    .map((project) => {
      const id = asText(project.id, TEXT.project);
      const group = groups.get(id);
      return {
        projectId: id,
        projectName: asText(project.name, TEXT.name) || group?.projectName || '',
        count: group?.count ?? 0,
        items: group?.items ?? []
      };
    });
  const known = new Set(listed.map((project) => project.projectId));
  for (const [id, group] of groups) {
    // 已删除项目留下的待办也列出来，计数才和 total 对得上；不假装它还有项目。
    if (known.has(id)) continue;
    listed.push({ ...group, projectName: group.projectName || '（已删除的项目）' });
  }
  return { total: current.pending.length, projects: listed };
}

/**
 * 把本轮扫描出的候选并进待办。
 * - 只收当前项目的候选：别的项目即使漏进来也不入待办；
 * - 拒绝过的指纹直接挡掉（扫描层已挡一次，这里是第二层）；
 * - 已在待办里的不重复添加，返回计数供回执说明。
 */
export function mergeCandidates(state, candidates, { projectId = '', projectName = '', now = '' } = {}) {
  const current = normalizeDecisionScanState(state);
  const owner = asText(projectId, TEXT.project);
  const added = [];
  let duplicates = 0;
  let suppressed = 0;
  if (!owner) return { state: current, added, duplicates, suppressed };
  const pendingKeys = new Set(current.pending.map((item) => `${item.projectId}\u0000${item.fingerprint}`));
  const rejectedKeys = new Set(current.rejected.map((item) => `${item.projectId}\u0000${item.fingerprint}`));
  const stamp = now || new Date().toISOString();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const record = pendingRecordOf(candidate, { projectId: owner, projectName, now: stamp });
    if (!record || record.projectId !== owner) {
      suppressed++;
      continue;
    }
    const key = `${record.projectId}\u0000${record.fingerprint}`;
    if (rejectedKeys.has(key)) {
      suppressed++;
      continue;
    }
    if (pendingKeys.has(key)) {
      duplicates++;
      continue;
    }
    pendingKeys.add(key);
    added.push(record);
  }
  const pending = [...current.pending, ...added].slice(-DEFAULTS.pending);
  return { state: { ...current, pending }, added, duplicates, suppressed };
}

/** 拒绝一条待办：移除候选并记指纹；同一条重复拒绝是幂等空操作。 */
export function rejectPending({ scanStore, projectId = '', fingerprint = '', now = '' } = {}) {
  const owner = asText(projectId, TEXT.project);
  const key = asText(fingerprint, TEXT.fingerprint);
  if (!scanStore || typeof scanStore.read !== 'function' || typeof scanStore.write !== 'function') {
    return { ok: false, removed: false, reason: '本地待办存储不可用，暂时不能拒绝。' };
  }
  if (!owner || !key) return { ok: false, removed: false, reason: '这条候选缺少项目或指纹。' };
  const current = scanStore.read();
  const index = current.pending.findIndex((item) => item.projectId === owner && item.fingerprint === key);
  if (index < 0) {
    return { ok: false, removed: false, reason: '这条候选已经不在待办了，可能已经处理过。' };
  }
  const pending = current.pending.filter((_, at) => at !== index);
  const exists = current.rejected.some((item) => item.projectId === owner && item.fingerprint === key);
  const rejected = exists
    ? current.rejected
    : [...current.rejected, { projectId: owner, fingerprint: key, at: asText(now) || new Date().toISOString() }]
      .slice(-DEFAULTS.rejected);
  scanStore.write({ ...current, pending, rejected });
  return { ok: true, removed: true, projectId: owner, fingerprint: key, rejected: rejected.length };
}

/**
 * 接受一条待办：确认写一条决策，再把候选从待办移除。
 * 确认走 decision-confirm 的幂等路径：同一指纹已入库时 created=false，也不会写第二条。
 * 理由为空就是「缺理由」；调用方在缺理由时负责先问一句，跳过的理由仍保持空。
 */
export function acceptPendingCandidate({
  scanStore,
  personalStore,
  projectId = '',
  fingerprint = '',
  reason = '',
  now = ''
} = {}) {
  const fail = (text) => ({
    ok: false, created: false, id: null, status: null, fingerprint: null,
    missingReason: true, reason: text
  });
  if (!scanStore || typeof scanStore.read !== 'function' || typeof scanStore.write !== 'function') {
    return fail('本地待办存储不可用，暂时不能接受。');
  }
  if (!personalStore) return fail('知识库尚未初始化，暂时不能接受决策。');
  const owner = asText(projectId, TEXT.project);
  const key = asText(fingerprint, TEXT.fingerprint);
  if (!owner || !key) return fail('这条候选缺少项目或指纹。');
  const current = scanStore.read();
  const candidate = current.pending.find((item) => item.projectId === owner && item.fingerprint === key);
  if (!candidate) return fail('这条候选已经不在待办了，可能已经处理过。');

  const result = confirmDecisionCandidate({
    personalStore,
    candidate,
    // 人补的理由优先；没补时沿用候选里已有的（通常为空，保持「缺理由」）。
    reason: asText(reason, TEXT.reason) || candidate.reason,
    actor: 'local-user'
  });
  if (!result.ok) return result;

  const pending = current.pending.filter((item) => !(item.projectId === owner && item.fingerprint === key));
  scanStore.write({ ...current, pending });
  return {
    ...result,
    projectId: owner,
    fingerprint: key,
    source: candidate.source,
    sessionId: candidate.sessionId,
    sessionPath: candidate.sessionPath,
    removed: true
  };
}

/**
 * 一次 `/提炼决策` 回合。
 *
 * @param {object} input
 * @param {object} input.state 现有 memory-scan.json 状态（未归一也行）
 * @param {{id: string, name?: string, root?: string}|null} input.project 当前项目
 * @param {{source: string, dir: string}[]} [input.roots] 会话根目录
 * @param {(input: object) => Promise<object>} input.scan 注入的扫描器（默认由主进程传 scanSessions）
 * @param {(pair: object) => object|null} [input.extract] 注入的提炼器
 * @param {Iterable<string>} [input.confirmedFingerprints] 知识库里已有决策的指纹
 * @param {object} [input.scanOptions] 扫描上限等，透传给 scanSessions
 * @returns {Promise<object>} 回执 + 待办 + 归一后的新状态
 */
export async function runDecisionScan({
  state,
  project = null,
  roots = [],
  scan = null,
  extract = undefined,
  confirmedFingerprints = [],
  scanOptions = {},
  now = ''
} = {}) {
  const current = normalizeDecisionScanState(state);
  const projectId = asText(project?.id, TEXT.project);
  const projectName = asText(project?.name, TEXT.name);
  if (!projectId) {
    return {
      ok: false,
      mode: 'no-project',
      reason: '先选一个项目，再提炼决策。',
      projectId: '',
      pending: [],
      added: [],
      scan: null,
      state: current,
      receipt: { mode: 'no-project', status: 'no-project', added: 0, pending: 0 }
    };
  }

  // 有未处理候选：先给待办，不扫描。人处理完再执行一次才会继续扫。
  const waiting = pendingOf(current, projectId);
  if (waiting.length) {
    return {
      ok: true,
      mode: 'pending',
      projectId,
      projectName,
      pending: waiting,
      added: [],
      scan: null,
      state: current,
      receipt: {
        mode: 'pending',
        status: 'pending',
        projectId,
        projectName,
        added: 0,
        pending: waiting.length
      }
    };
  }

  if (typeof scan !== 'function') {
    return {
      ok: false,
      mode: 'failed',
      reason: '扫描接口没有接上，暂时不能提炼决策。',
      projectId,
      projectName,
      pending: [],
      added: [],
      scan: null,
      state: current,
      receipt: { mode: 'failed', status: 'failed', added: 0, pending: 0, reason: '扫描接口没有接上' }
    };
  }

  const fingerprints = [...new Set([
    ...current.fingerprints,
    ...Array.from(confirmedFingerprints ?? []),
    ...rejectedFingerprintsOf(current, projectId)
  ])];

  let scanned;
  try {
    scanned = await scan({
      roots: Array.isArray(roots) ? roots : [],
      // 只传当前项目：别的项目的会话匹配不上，既不会被消费，也不会被记成已扫过。
      projects: [{
        id: projectId,
        name: projectName,
        root: asText(project?.root, TEXT.ref)
      }],
      seenSessions: current.sessions,
      fingerprints,
      maxCandidateSample: DEFAULTS.maxCandidateSample,
      ...(extract === undefined ? {} : { extract }),
      ...scanOptions
    });
  } catch (error) {
    const reason = String(error?.message ?? error ?? '未知原因');
    return {
      ok: false,
      mode: 'failed',
      reason,
      projectId,
      projectName,
      pending: [],
      added: [],
      scan: null,
      state: current,
      receipt: { mode: 'failed', status: 'failed', projectId, projectName, added: 0, pending: 0, reason }
    };
  }
  if (!scanned || typeof scanned !== 'object') {
    return {
      ok: false,
      mode: 'failed',
      reason: '扫描没有返回可读的结果。',
      projectId,
      projectName,
      pending: [],
      added: [],
      scan: null,
      state: current,
      receipt: { mode: 'failed', status: 'failed', projectId, projectName, added: 0, pending: 0, reason: '扫描没有返回可读的结果' }
    };
  }

  const stamp = asText(now) || new Date().toISOString();
  const merged = mergeCandidates(current, scanned.candidates, { projectId, projectName, now: stamp });
  const nextState = normalizeDecisionScanState({
    ...current,
    // 只追加本轮真正读成功的当前项目会话键；读失败的下次还会重试。
    sessions: [...current.sessions, ...(Array.isArray(scanned.scannedKeys) ? scanned.scannedKeys : [])],
    pending: merged.state.pending
  });
  const dropped = scanned.dropped && typeof scanned.dropped === 'object' ? scanned.dropped : {};
  const counts = scanned.counts && typeof scanned.counts === 'object' ? scanned.counts : {};
  const unreadable = (Number(dropped.unreadable) || 0)
    + (Number(dropped.tooLarge) || 0)
    + (Number(counts.skipped?.failed) || 0);
  const truncated = Number(counts.truncated) || Number(scanned.truncated) || 0;
  const status = unreadable > 0 || truncated > 0
    ? 'partial'
    : (merged.added.length === 0 ? 'empty' : 'ok');
  const waitingAfter = pendingOf(nextState, projectId);
  const receipt = {
    mode: 'scanned',
    status,
    projectId,
    projectName,
    added: merged.added.length,
    duplicates: merged.duplicates,
    suppressed: merged.suppressed,
    pending: waitingAfter.length,
    counts,
    dropped,
    droppedReasons: Array.isArray(scanned.droppedReasons) ? scanned.droppedReasons : [],
    skippedFiles: Array.isArray(scanned.skippedFiles) ? scanned.skippedFiles : [],
    truncated,
    unreadable,
    redactions: Number(scanned.redactions) || 0
  };
  return {
    ok: true,
    mode: 'scanned',
    projectId,
    projectName,
    pending: waitingAfter,
    added: merged.added,
    scan: scanned,
    state: nextState,
    receipt
  };
}
