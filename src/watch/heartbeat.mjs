// 心跳的「发现」（#118）：给上次水位与一次快照，算出新增 / 修改 / 删除，并给出变化卡的数据形状。
//
// 这一层只做分类，不做理解：不读文件内容、不解析提交正文、不调模型（父 spec #102 的分层）。
// 快照从外面注入，本轮只接本地 git 提交列表这一种来源——测试给假数据，生产由调用方去拿。
// 因为不读内容，判断只能靠快照自己带的两样元数据：时间与（可选的）状态字母。于是规则只有三条：
// 1. 时间严格晚于水位才算「这次发现的」；恰好等于水位已看过（与 memory/change-window 同一条边界）；
// 2. 类由快照声明：A / M / D 映射成新增 / 修改 / 删除；提交列表没声明状态时，出现即新增；
// 3. 判断不了就进未知：没有水位、没有可解析的时间、没有 id、状态认不得。
//    未知绝不折成「没有变化」——那是 ADR-0008 点名的错。
//
// 另外两条写死在这里，别的模块不用再想：
// - 同一批里重复的条目只算一条（同 kind + id + 时间），重复的只报个数；
// - 空窗口返回明确空态（empty + emptyText），不是「返回空数组」了事。
//
// 存储与推进不在这里：入队、推进水位、记心跳是 heartbeat-run.mjs 的事，顺序也由它保证。
// UI 也不在这里：#109/#111 只消费本文件产出的结构化形状，本文件不产出 HTML。
import { normalizeWatchTarget } from './target.mjs';

/** 空窗口的固定文案：卡片与心跳附注共用这一句，别处不再拼。 */
export const HEARTBEAT_EMPTY_TEXT = '自上次心跳之后没有新变化。';

/** 三个变化类：顺序即卡片分组顺序，只写一份。 */
export const HEARTBEAT_KINDS = Object.freeze(['added', 'modified', 'deleted']);

/** 三类在卡片上的标题与空态说辞。 */
const CARD_BLOCKS = Object.freeze([
  { key: 'added', title: '新增', emptyHint: '没有新增。' },
  { key: 'modified', title: '修改', emptyHint: '没有修改。' },
  { key: 'deleted', title: '删除', emptyHint: '没有删除。' }
]);

/**
 * 快照里声明的状态 → 变化类。认得 git 的字母、也认得写全的词，大小写都收。
 * 重命名 / 复制按「修改」记：条目 id 取新路径，仍是同一个东西换了位置。
 * 认不得的状态不进这张表，交给未知——不猜成修改。
 */
const KIND_BY_STATUS = new Map([
  ['a', 'added'], ['added', 'added'], ['new', 'added'], ['+', 'added'], ['??', 'added'],
  ['m', 'modified'], ['modified', 'modified'], ['changed', 'modified'], ['t', 'modified'],
  ['r', 'modified'], ['renamed', 'modified'], ['c', 'modified'], ['copied', 'modified'],
  ['d', 'deleted'], ['deleted', 'deleted'], ['removed', 'deleted'], ['-', 'deleted']
]);

/** 与 store.mjs 的 ref 上限一致：超出的 id 进不了队列，所以在分类时就标未知。 */
const MAX_ID = 400;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const asList = (value) => (Array.isArray(value) ? value : []);
const text = (value) => (typeof value === 'string' ? value.trim() : '');

/** 按顺序取第一个非空字符串：数据里有 camelCase 与 snake_case 两套叫法。 */
const textOf = (...values) => {
  for (const value of values) {
    const found = text(value);
    if (found) return found;
  }
  return '';
};

/**
 * 解析时间：ISO 串、Date、毫秒/秒时间戳都认（与 memory/change-window 同一套规则）。
 * 解析不了返回 null，不猜。
 */
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
    if (/^\d{10,}$/u.test(raw)) return toMillis(Number(raw));
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
};

/** 毫秒转 ISO；超出 Date 可表示范围时返回空串（toISOString 会抛 RangeError）。 */
const isoOf = (ms) => {
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toISOString();
  } catch {
    return '';
  }
};

/** 从若干候选字段里取第一个能解析的时间，返回 ISO；都解析不了返回空串。 */
const timeOf = (...values) => {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const ms = toMillis(value);
    if (ms !== null) return isoOf(ms);
  }
  return '';
};

/**
 * 水位归一化。调用方可以给时间，也可以直接给 store.getWatermark 那一行（{ at }）。
 * 拿不到可解析的时间就是「没有水位」，不拿 0 当默认值——0 会把全部历史算成新的。
 */
const watermarkOf = (raw) => {
  const value = isObject(raw) && !(raw instanceof Date)
    ? (raw.at ?? raw.watermark_at ?? raw.lastSeenAt ?? raw.last_seen_at ?? null)
    : raw;
  const ms = toMillis(value);
  if (ms === null) return { at: '', ms: null, known: false };
  const at = isoOf(ms);
  return at ? { at, ms, known: true } : { at: '', ms: null, known: false };
};

/**
 * 快照探针：拿到清单了吗？拿不到（没给、形状不对、或调用方明说这次没取全）就整轮算不了，
 * 不能压成「没有变化」。清单是空数组则是合法的空窗口，两件事必须分开。
 */
const probeOf = (snapshot) => {
  if (Array.isArray(snapshot)) return { ok: true, reason: '', commits: snapshot, entries: [] };
  if (!isObject(snapshot)) return { ok: false, reason: 'snapshot-unavailable', commits: [], entries: [] };
  if (snapshot.complete === false) return { ok: false, reason: 'snapshot-unavailable', commits: [], entries: [] };
  const commits = Array.isArray(snapshot.commits) ? snapshot.commits : null;
  const entries = Array.isArray(snapshot.entries) ? snapshot.entries : null;
  if (!commits && !entries) return { ok: false, reason: 'snapshot-unavailable', commits: [], entries: [] };
  return { ok: true, reason: '', commits: commits ?? [], entries: entries ?? [] };
};

/**
 * 条目的归一化：id（提交 sha 或路径）、时间、（可选的）声明状态。
 * 这里不做「字符串猜对象」式的兜底：认不出 id 的条目原样留着，交给分类判未知。
 */
const itemOf = (raw) => {
  if (typeof raw === 'string') {
    const id = raw.trim();
    return { id, at: '', status: '', sha: '', label: id, kind: id ? 'added' : null };
  }
  if (!isObject(raw)) return { id: '', at: '', status: '', sha: '', label: '', kind: null };
  const sha = textOf(raw.sha, raw.hash, raw.commit);
  const id = textOf(raw.id, sha, raw.path, raw.file, raw.ref);
  const at = timeOf(
    raw.at, raw.committedAt, raw.committed_at, raw.date, raw.timestamp, raw.time, raw.mtime
  );
  const status = textOf(raw.status, raw.kind, raw.change, raw.state, raw.action);
  const subject = textOf(raw.subject, raw.title, raw.message, raw.summary).split('\n')[0].trim();
  const kind = status ? (KIND_BY_STATUS.get(status.toLowerCase()) ?? null) : (id ? 'added' : null);
  return {
    id,
    at,
    status,
    sha,
    kind,
    label: [sha ? sha.slice(0, 8) : '', subject || id].filter(Boolean).join(' ')
  };
};

/**
 * 一条条目落进哪个桶。
 * - 没 id / id 太长 / 带控制字符：形状读不懂，未知；
 * - 没有水位：分不清新旧，未知（不是「全都算新增」）；
 * - 没有可解析的时间：未知（不默认算看过，那会把真变化吞掉）；
 * - 不晚于水位：已看过，只计数；
 * - 状态认不得：未知。
 */
const bucketOf = (item, watermark) => {
  if (!item.id || item.id.length > MAX_ID || CONTROL_CHARS.test(item.id)) {
    return { bucket: 'unknown', reason: 'malformed' };
  }
  if (!watermark.known) return { bucket: 'unknown', reason: 'no-watermark' };
  if (!item.at) return { bucket: 'unknown', reason: 'no-time' };
  const ms = toMillis(item.at);
  if (ms === null) return { bucket: 'unknown', reason: 'no-time' };
  if (ms <= watermark.ms) return { bucket: 'seen', reason: 'at-or-before-watermark' };
  if (!item.kind) return { bucket: 'unknown', reason: 'unknown-kind' };
  return { bucket: item.kind, reason: '' };
};

/** 时间倒序；时间相同按 id 兜底，保证同一份输入每次得到同样的顺序。 */
const newestFirst = (a, b) => String(b.at ?? '').localeCompare(String(a.at ?? ''))
  || String(a.id).localeCompare(String(b.id));

const emptyCounts = () => ({ added: 0, modified: 0, deleted: 0, unknown: 0, total: 0, seen: 0, duplicates: 0 });

/**
 * 用上次水位给当前快照分类（纯函数）。
 *
 * @param {string|number|Date|object|null} watermark 上次水位；也接受 store.getWatermark 的行（{ at }）
 * @param {object|Array} snapshot 当前快照：`{ at?, complete?, commits?: [], entries?: [] }`；
 *   commits 是本地 git 提交列表（{ sha, at, subject }），entries 是带状态的条目
 *   （{ id, at, status }），两者都给就合并算。直接给数组按提交列表读。
 * @returns {object} { status, since, probe, counts, added, modified, deleted, unknown, empty, emptyText, unknownText }
 */
export function diffHeartbeat(watermark, snapshot = null) {
  const since = watermarkOf(watermark);
  const probe = probeOf(snapshot);
  const counts = emptyCounts();
  const buckets = { added: [], modified: [], deleted: [], unknown: [] };
  const seenKeys = new Set();

  if (probe.ok) {
    // 提交列表在前、状态条目在后：合并读出，来源不同但都是「这次看到了什么」。
    for (const raw of [...probe.commits, ...probe.entries]) {
      const item = itemOf(raw);
      const { bucket, reason } = bucketOf(item, since);
      const entry = {
        kind: item.kind,
        id: item.id,
        at: item.at,
        label: item.label,
        sha: item.sha,
        status: item.status,
        ...(bucket === 'unknown' ? { reason } : {})
      };
      // 同一批里同一件事只记一次；键里带时间，所以「同一个文件改两次」仍是两条。
      const key = `${bucket}\u0000${entry.id}\u0000${entry.at}\u0000${reason}`;
      if (seenKeys.has(key)) {
        counts.duplicates += 1;
        continue;
      }
      seenKeys.add(key);
      if (bucket === 'seen') {
        counts.seen += 1;
        continue;
      }
      buckets[bucket].push(entry);
      counts[bucket] += 1;
    }
  }

  for (const key of HEARTBEAT_KINDS) buckets[key].sort(newestFirst);
  buckets.unknown.sort(newestFirst);
  // total 只算三类变化：未知是「没算清」，不是一个变化类，不混进计数。
  counts.total = counts.added + counts.modified + counts.deleted;

  // 只有「快照拿到了、水位也在、没有一条读不懂」才算算得清；否则状态就是未知。
  const status = probe.ok && since.known && counts.unknown === 0 ? 'ok' : 'unknown';
  const empty = status === 'ok' && counts.total === 0;
  return {
    status,
    since: since.at,
    probe: { ok: probe.ok, reason: probe.reason },
    counts,
    added: buckets.added,
    modified: buckets.modified,
    deleted: buckets.deleted,
    unknown: buckets.unknown,
    empty,
    emptyText: empty ? HEARTBEAT_EMPTY_TEXT : '',
    unknownText: status === 'ok' ? '' : unknownTextOf(probe, since, counts)
  };
}

/** 算不全时的一句人话：把每一处原因都点名，别让人把「读不到」看成「没有变化」。 */
function unknownTextOf(probe, since, counts) {
  const notes = [];
  if (!probe.ok) notes.push('这次没拿到快照');
  if (!since.known) notes.push('没有上次水位，分不清哪些条目是新的');
  if (counts.unknown > 0) notes.push(`有 ${counts.unknown} 条条目认不出时间或形状，没算进变化`);
  return `这次心跳算不全：${notes.join('、')}，所以不能当成「没有变化」。`;
}

/** 对象的显示名：卡片的抬头用它，不反解 ref。 */
const targetLabelOf = (target) => {
  if (target.type === 'project') return textOf(target.projectId, target.project_id, target.ref);
  if (target.type === 'session') {
    return [textOf(target.source), textOf(target.sessionId)].filter(Boolean).join(':')
      || textOf(target.ref);
  }
  if (target.type === 'github') {
    return textOf(target.nameWithOwner)
      || [textOf(target.owner), textOf(target.repo)].filter(Boolean).join('/')
      || textOf(target.ref);
  }
  return textOf(target.ref);
};

/**
 * 卡片的隔离键：描述符已归一化时直接用它的 ref，否则按同一套规则现算一个——
 * 卡片与状态库必须认同一个键，不能一个按 ref、一个按项目名。
 */
const targetRefOf = (target) => textOf(target.ref) || normalizeWatchTarget(target).ref;

/** 卡片条目只留「显示什么」：id、一句文字、时间，不把整条元数据搬进界面。 */
const cardItemOf = (item) => ({
  id: String(item?.id ?? ''),
  text: String(item?.label ?? item?.id ?? ''),
  at: String(item?.at ?? '')
});

/**
 * 变化卡的数据形状（纯函数）：对象、时间、三类计数与条目。
 * 只产出结构化字段，不产出 HTML——渲染留给 #109/#111。
 *
 * @param {object} input
 * @param {object} input.target 归一化后的监控对象（normalizeWatchTarget 的输出即可）
 * @param {string|number|Date} [input.at] 这次心跳的时刻
 * @param {object} input.diff diffHeartbeat 的返回值
 * @param {number|null} [input.queuedCount] 这次真正新入队的条数；没入队就是 0
 * @returns {object} 卡片模型
 */
export function heartbeatCard({ target = null, at = '', diff = null, queuedCount = null } = {}) {
  if (!isObject(target)) throw new Error('变化卡需要监控对象');
  if (!isObject(diff) || !isObject(diff.counts)) throw new Error('变化卡需要 diffHeartbeat 的结果');
  const blocks = CARD_BLOCKS.map((def) => {
    const items = asList(diff[def.key]).map(cardItemOf);
    return {
      key: def.key,
      title: def.title,
      count: items.length,
      empty: items.length === 0,
      emptyHint: items.length === 0 ? def.emptyHint : '',
      items
    };
  });
  return {
    kind: 'change',
    title: '监控变化',
    target: {
      type: String(target.type ?? ''),
      ref: targetRefOf(target),
      label: targetLabelOf(target)
    },
    at: timeOf(at) || (typeof at === 'string' ? at : ''),
    since: String(diff.since ?? ''),
    status: String(diff.status ?? 'unknown'),
    counts: diff.counts,
    empty: diff.empty === true,
    emptyText: String(diff.emptyText ?? ''),
    unknownText: String(diff.unknownText ?? ''),
    blocks,
    queuedCount: Number.isSafeInteger(queuedCount) ? queuedCount : null
  };
}
