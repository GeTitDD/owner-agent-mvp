// 同步计划（#129）：拿本地与远端两份文档清单，算出这次同步要做什么。
//
// 纯函数：不读盘、不联网、不读环境变量，也不执行拉取或推送（那是 #130）。输入只有两份清单
// 与各自的版本/标记，输出只供预览卡渲染。
//
// 判定顺序（ADR-0013：不宣告真相源，冲突交人）：
// 1. 只在本地 → 新增（待推送）；只在远端 → 归档（待拉取，不做真删）。
// 2. 两边都有：先看「自上次同步后是否改过」，再看版本高低。
//    - 两边都改过 → 冲突，停在人确认；不按时间戳比新旧（时间先后不是判据）。
//    - 只有一边改过 → 可直接合并：本地改过就推，远端改过就拉。
//    - 都没改过 → 版本相同即无变化；版本不同则由版本高的一边覆盖。
// 3. 「改过」只看显式标记：条目自带的 `dirty: true`，或注入的 `baseVersion`
//    （条目字段或 syncPlan 参数，按 id 给或给一个标量）。没给基线时不猜「谁改过」，
//    宁可退化成版本比较。版本相同但时间不同不算更新——`updatedAt` 只用于展示。
//
// 条目形状：`{ id, version, updatedAt, dirty?, baseVersion? }`。id 是身份，版本与时间
// 是属性；同一份输入每次得到同一份结果（输出按 id 排序）。

/** 空态文案只写两份：两边都没文档，与两边一致。 */
const EMPTY_BOTH_TEXT = '两边都没有文档，没有要同步的内容。';
const EMPTY_SAME_TEXT = '两边一致，没有要同步的变化。';
const UNAVAILABLE_TEXT = '缺少本地或远端文档清单，算不出同步计划。';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const text = (value) => (typeof value === 'string' ? value : '');

/** 按顺序取第一个非空字符串：清单里 camelCase / snake_case 都出现过。 */
const textOf = (...values) => {
  for (const value of values) {
    const found = text(value);
    if (found) return found;
  }
  return '';
};

/** 版本号统一读成去掉首尾空白的字符串；数字版本也走这里，避免 1 与 '1' 被当成两版。 */
const versionTextOf = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return value.trim();
  return '';
};

/** 解析时间：ISO 串、Date、毫秒/秒时间戳都认；解析不了返回 null，不猜。 */
const toMillis = (value) => {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return null;
    if (/^\d{10,}$/.test(raw)) return toMillis(Number(raw));
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
};

/** 展示用时间：能解析就统一成 ISO；解析不了保留原字符串，不把它当 0。 */
const timeTextOf = (value) => {
  const ms = toMillis(value);
  if (ms !== null) {
    try {
      return new Date(ms).toISOString();
    } catch {
      // Date 表示不了的毫秒数：退回原字符串。
    }
  }
  return typeof value === 'string' ? value.trim() : '';
};

/** 版本序号：`v1` / `1` / `1.2.3` 按段比数字；认不出的版本按字符序比，保证结果确定。 */
const versionOrder = (leftVersion, rightVersion) => {
  const left = versionTextOf(leftVersion);
  const right = versionTextOf(rightVersion);
  if (left === right) return 0;
  const leftMatch = /^v?(\d+(?:\.\d+)*)$/i.exec(left);
  const rightMatch = /^v?(\d+(?:\.\d+)*)$/i.exec(right);
  if (leftMatch && rightMatch) {
    const leftParts = leftMatch[1].split('.').map(Number);
    const rightParts = rightMatch[1].split('.').map(Number);
    const length = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < length; index += 1) {
      const leftPart = leftParts[index] ?? 0;
      const rightPart = rightParts[index] ?? 0;
      if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
    }
    return 0;
  }
  // 不用 localeCompare：结果不应随机器语言环境变化。
  return left < right ? -1 : 1;
};

const sameVersion = (left, right) => versionOrder(left, right) === 0;

/** id 排序同样不依赖语言环境。 */
const compareId = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/** 一条原始条目归一化；认不出 id 的返回 null，由调用方计入 skipped。 */
const docOf = (raw) => {
  if (typeof raw === 'string') {
    const id = raw.trim();
    return id ? { id, version: '', updatedAt: '', dirty: false, baseVersion: null } : null;
  }
  if (!isObject(raw)) return null;
  const id = textOf(raw.id, raw.docId, raw.doc_id);
  if (!id) return null;
  return {
    id,
    version: versionTextOf(raw.version),
    updatedAt: timeTextOf(raw.updatedAt ?? raw.updated_at),
    dirty: raw.dirty === true,
    baseVersion: raw.baseVersion ?? raw.base_version ?? null
  };
};

/**
 * 解析某一条目的同步基线。优先级：条目字段 > 注入参数按 id 给的值 > 注入的标量。
 * 都拿不到就是 null——没有基线时不能推断「自上次同步后改过」。
 */
const baseVersionOf = (doc, injected) => {
  if (doc.baseVersion !== null && doc.baseVersion !== undefined) return doc.baseVersion;
  if (injected === null || injected === undefined) return null;
  if (injected instanceof Map) return injected.has(doc.id) ? injected.get(doc.id) : null;
  if (isObject(injected)) {
    return Object.prototype.hasOwnProperty.call(injected, doc.id) ? injected[doc.id] : null;
  }
  return injected;
};

/** 自上次同步后是否改过：显式 dirty，或版本与基线不同。时间戳不参与。 */
const changedSinceSync = (doc, injectedBase) => {
  if (doc.dirty) return true;
  const base = baseVersionOf(doc, injectedBase);
  if (base === null || base === undefined) return false;
  const baseText = versionTextOf(base);
  if (!baseText) return Boolean(doc.version);
  return !sameVersion(doc.version, base);
};

/** 预览卡需要的一侧摘要：版本 + 时间 + 是否改过。 */
const sideOf = (doc) => {
  const side = {
    version: doc.version,
    updatedAt: doc.updatedAt,
    dirty: doc.dirty
  };
  if (doc.baseVersion !== null && doc.baseVersion !== undefined) {
    side.baseVersion = versionTextOf(doc.baseVersion);
  }
  return side;
};

/** 单侧新增 / 归档的条目摘要。 */
const summaryOf = (doc) => ({
  id: doc.id,
  version: doc.version,
  updatedAt: doc.updatedAt
});

/** 把清单按 id 收成索引；重复 id 保留后者并记录，认不出 id 的计入 skipped。 */
const indexOf = (list) => {
  const docs = new Map();
  const duplicateIds = [];
  let skipped = 0;
  for (const raw of list) {
    const doc = docOf(raw);
    if (!doc) {
      skipped += 1;
      continue;
    }
    if (docs.has(doc.id)) duplicateIds.push(doc.id);
    docs.set(doc.id, doc);
  }
  return { docs, skipped, duplicateIds };
};

/**
 * 算出同步计划。
 *
 * @param {object} [input]
 * @param {object[]} [input.local] 本地文档清单，每条 `{ id, version, updatedAt, dirty?, baseVersion? }`
 * @param {object[]} [input.remote] 远端文档清单，形状同上
 * @param {string|number|Map|object} [input.baseVersion] 上次同步的版本：标量应用于所有条目，
 *   Map / 普通对象按 id 取；条目自带的 baseVersion 优先
 * @returns {object} 预览卡数据：四类条目 + 计数 + ahead / behind + 空态文案
 */
export function syncPlan(input = {}) {
  const options = isObject(input) ? input : {};
  const localList = Array.isArray(options.local) ? options.local : null;
  const remoteList = Array.isArray(options.remote) ? options.remote : null;
  const readable = localList !== null && remoteList !== null;

  const localIndex = indexOf(localList ?? []);
  const remoteIndex = indexOf(remoteList ?? []);
  const injectedBase = options.baseVersion ?? null;

  const ids = [...new Set([...localIndex.docs.keys(), ...remoteIndex.docs.keys()])].sort(compareId);

  const added = [];
  const updated = [];
  const archived = [];
  const conflicts = [];
  let unchanged = 0;

  // 少一份清单就整套不算：只拿本地清单分类会把「远端未知」误显示成「全是新增」。
  for (const id of readable ? ids : []) {
    const local = localIndex.docs.get(id);
    const remote = remoteIndex.docs.get(id);

    if (local && !remote) {
      added.push({ ...summaryOf(local), pending: 'push' });
      continue;
    }
    if (!local && remote) {
      archived.push({ ...summaryOf(remote), pending: 'pull' });
      continue;
    }

    const localChanged = changedSinceSync(local, injectedBase);
    const remoteChanged = changedSinceSync(remote, injectedBase);

    // 冲突只看「两边都改过」，不看谁的时间更新；时间戳单独出现时永远不判冲突。
    if (localChanged && remoteChanged) {
      conflicts.push({
        id,
        reason: 'both-changed',
        local: sideOf(local),
        remote: sideOf(remote)
      });
      continue;
    }
    if (localChanged !== remoteChanged) {
      updated.push({
        id,
        direction: localChanged ? 'push' : 'pull',
        reason: localChanged ? 'local-changed' : 'remote-changed',
        local: sideOf(local),
        remote: sideOf(remote)
      });
      continue;
    }

    const order = versionOrder(local.version, remote.version);
    if (order === 0) {
      unchanged += 1;
      continue;
    }
    updated.push({
      id,
      direction: order > 0 ? 'push' : 'pull',
      reason: order > 0 ? 'local-version-ahead' : 'remote-version-ahead',
      local: sideOf(local),
      remote: sideOf(remote)
    });
  }

  const counts = {
    added: added.length,
    updated: updated.length,
    archived: archived.length,
    conflicts: conflicts.length,
    unchanged,
    total: readable ? ids.length : 0
  };
  const changes = counts.added + counts.updated + counts.archived + counts.conflicts;

  // ahead = 本地要推出去的条目数；behind = 要从远端拉回来的条目数。冲突两边都不算。
  const ahead = added.length + updated.filter((entry) => entry.direction === 'push').length;
  const behind = archived.length + updated.filter((entry) => entry.direction === 'pull').length;

  const empty = readable && changes === 0;
  let emptyText = '';
  if (empty) emptyText = ids.length === 0 ? EMPTY_BOTH_TEXT : EMPTY_SAME_TEXT;

  const status = readable ? 'ok' : 'unavailable';
  const headline = status === 'ok'
    ? (empty
      ? emptyText
      : `新增 ${counts.added} · 更新 ${counts.updated} · 归档 ${counts.archived} · 冲突 ${counts.conflicts}`)
    : '';

  return {
    status,
    added,
    updated,
    archived,
    conflicts,
    counts,
    ahead,
    behind,
    empty,
    emptyText,
    unavailableText: status === 'ok' ? '' : UNAVAILABLE_TEXT,
    headline,
    // 认不出 id 或同一份清单里重复 id 的条目：不静默吞掉，留给调用方排查。
    skipped: { local: localIndex.skipped, remote: remoteIndex.skipped },
    duplicateIds: [...localIndex.duplicateIds, ...remoteIndex.duplicateIds].sort(compareId)
  };
}
