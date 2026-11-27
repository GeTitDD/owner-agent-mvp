// 变化窗口（change window）的纯函数视图模型：回答「自上次看过之后，这个项目变了什么」。
//
// 为什么单独一个文件：#83 把「上次看到哪」的水位变成主路径，水位边界的规则——什么算新、
// 什么算旧、判断不了时怎么表达——必须先落在一处，后续界面票只负责画。这里只组装视图模型：
// 不读 git、不读库、不联网，也不推进水位。git 事实由调用方给，水位由存储层在本函数返回
// 之后推进（ADR-0008：先算差异，再推水位，顺序反了等于让人白开一次）。
//
// 三个探针（提交清单、未提交改动清单、观察员事件）各自可能读不到。读不到时按「未知」表达，
// 绝不缩成「没有变化」：ADR-0008 的后果一节要求探针读不到仓库时说明原因，而不是显示
// 「没有变化」。所以条目分三个桶：
// - 变化：时间在水位之后；未提交改动没有时间，当前工作区里有就算变化；
// - 已看过：时间不晚于水位（等于水位已算看过），保留条目与计数，不静默丢弃；
// - 未知：没有水位、条目没有可解析的时间、或条目形状读不懂，宁可标未知也不猜。
//
// 时间比较只认「严格晚于水位」：水位推到当前时，恰好落在水位那一刻的提交已经看过了。
// 观察员事件用发现时间（detectedAt 等），不用 lastCommitAt——后者说的是被观察的提交，
// 不是事件发生的时间。

import { eventTypeLabel } from '../observer/event-types.mjs';

/** 三段块的定义只写一份：顺序、标题、两种空态文案都从这里出。 */
const BLOCK_DEFS = [
  {
    key: 'commits',
    title: '新提交',
    emptyHint: '自上次看过之后没有新提交。',
    unavailableHint: '没有拿到提交清单，无法判断有没有新提交。',
    noWatermarkHint: '没有上次水位，无法判断哪些提交是新的。'
  },
  {
    key: 'dirty',
    title: '未提交改动',
    emptyHint: '工作区没有未提交的改动。',
    unavailableHint: '没有拿到未提交改动清单，无法判断工作区干不干净。'
  },
  {
    key: 'events',
    title: '观察员事件',
    emptyHint: '这段时间没有观察员事件。',
    unavailableHint: '没有拿到观察员事件，无法判断有没有异常。',
    noWatermarkHint: '没有上次水位，无法判断哪些事件是新的。'
  }
];

/** 探针读不到时给出的短说明，拼进 overall 的未知文案。 */
const UNAVAILABLE_NOTES = {
  commits: '拿不到提交清单',
  dirty: '拿不到未提交改动清单',
  events: '拿不到观察员事件'
};

const EMPTY_TEXT = '都看过了，自上次之后没有新变化。';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const asList = (value) => (Array.isArray(value) ? value : []);
const text = (value) => (typeof value === 'string' ? value : '');
/** 按顺序取第一个非空字符串：数据里有 camelCase 与 snake_case 两套叫法。 */
const textOf = (...values) => {
  for (const value of values) {
    const found = text(value);
    if (found) return found;
  }
  return '';
};
const projectIdOf = (item) => textOf(item?.projectId, item?.project_id);

/**
 * 解析时间：ISO 串、Date、毫秒时间戳都认；10 位以上的纯数字串按毫秒时间戳读，
 * 小于 1e11 的数字按秒读（秒级时间戳没有 1e11 这么大的值）。解析不了返回 null，不猜。
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
    if (/^\d{10,}$/.test(raw)) {
      const ms = Number(raw);
      return Number.isFinite(ms) ? toMillis(ms) : null;
    }
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

/**
 * 水位归一化。调用方可能直接给时间，也可能给存储层那一行（{ at } / { lastSeenAt }）。
 * 拿不到可解析的时间就是「没有水位」，不拿 0 当默认值——0 会把全部历史算成新的。
 */
const watermarkOf = (raw) => {
  const value = isObject(raw) && !(raw instanceof Date)
    ? (raw.at ?? raw.lastSeenAt ?? raw.last_seen_at ?? raw.since ?? raw.viewedAt ?? raw.viewed_at ?? null)
    : raw;
  const ms = toMillis(value);
  if (ms === null) return { at: '', ms: null, known: false };
  const at = isoOf(ms);
  return at ? { at, ms, known: true } : { at: '', ms: null, known: false };
};

/**
 * 从若干候选字段里取第一个能解析的时间，返回 ISO；都解析不了返回空串。
 * 不先转字符串：调用方可能直接给 Date 或毫秒数。
 */
const timeOf = (...values) => {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const ms = toMillis(value);
    if (ms !== null) return isoOf(ms);
  }
  return '';
};

const shortSha = (sha) => String(sha ?? '').slice(0, 8);

/** 提交条目：sha / 标题 / 时间三样，缺时间留给分类那一步判「未知」。 */
const commitItem = (raw) => {
  if (typeof raw === 'string') {
    const sha = raw.trim();
    return {
      kind: 'commit',
      id: sha,
      sha,
      shortSha: shortSha(sha),
      title: sha || '无法识别的提交条目',
      author: '',
      at: '',
      projectId: '',
      valid: Boolean(sha)
    };
  }
  if (!isObject(raw)) {
    return {
      kind: 'commit', id: '', sha: '', shortSha: '', title: '无法识别的提交条目', author: '', at: '', projectId: '', valid: false
    };
  }
  const sha = textOf(raw.sha, raw.hash, raw.commit, raw.id);
  const at = timeOf(raw.at, raw.committedAt, raw.committed_at, raw.date, raw.timestamp, raw.time);
  const subject = textOf(raw.subject, raw.title, raw.message, raw.summary).split('\n')[0].trim();
  const author = textOf(raw.author, raw.authorName, raw.author_name, raw.committer?.name);
  return {
    kind: 'commit',
    id: sha || subject,
    sha,
    shortSha: shortSha(sha),
    title: subject || (sha ? `提交 ${shortSha(sha)}` : '无法识别的提交条目'),
    author,
    at,
    projectId: projectIdOf(raw),
    valid: Boolean(sha || subject)
  };
};

/** 未提交改动条目：一条 = 一个文件；status 只是徽章，空着也能显示路径。 */
const dirtyItem = (raw) => {
  if (typeof raw === 'string') {
    const path = raw.trim();
    return {
      kind: 'dirty', id: path, path, status: '', title: path || '无法识别的改动条目', projectId: '', valid: Boolean(path)
    };
  }
  if (!isObject(raw)) {
    return {
      kind: 'dirty', id: '', path: '', status: '', title: '无法识别的改动条目', projectId: '', valid: false
    };
  }
  const path = textOf(raw.path, raw.file, raw.filename, raw.name);
  const status = textOf(raw.status, raw.change, raw.code, raw.kind);
  return {
    kind: 'dirty',
    id: path,
    path,
    status,
    title: [status, path, raw.previousPath ? `（原路径：${raw.previousPath}）` : ''].filter(Boolean).join(' ') || '无法识别的改动条目',
    projectId: projectIdOf(raw),
    valid: Boolean(path)
  };
};

/** 观察员事件条目：标签来自 event-types 注册表，未知类型原样显示，方便排查。 */
const eventItem = (raw) => {
  if (typeof raw === 'string') {
    const type = raw.trim();
    return {
      kind: 'event',
      id: type,
      type,
      typeLabel: type ? eventTypeLabel(type) : '',
      title: type || '无法识别的事件',
      at: '',
      projectId: '',
      valid: Boolean(type)
    };
  }
  if (!isObject(raw)) {
    return {
      kind: 'event', id: '', type: '', typeLabel: '', title: '无法识别的事件', at: '', projectId: '', valid: false
    };
  }
  const type = textOf(raw.type, raw.kind);
  const id = textOf(raw.id) || type;
  // 发现时间优先：lastCommitAt 是被观察的提交时间，不是事件发生的时间。
  const at = timeOf(
    raw.detectedAt, raw.detected_at,
    raw.occurredAt, raw.occurred_at,
    raw.updatedAt, raw.updated_at,
    raw.createdAt, raw.created_at,
    raw.at, raw.timestamp
  );
  const label = type ? eventTypeLabel(type) : '';
  // 事件本身没有标题字段；有项目名时补在标签后面，让同屏多条能分开。
  const name = textOf(raw.projectName, raw.project_name, raw.branchLabel, raw.branch_label);
  return {
    kind: 'event',
    id,
    type,
    typeLabel: label,
    title: [label, name].filter(Boolean).join(' · ') || '无法识别的事件',
    at,
    projectId: projectIdOf(raw),
    valid: Boolean(id)
  };
};

const BUILDERS = { commits: commitItem, dirty: dirtyItem, events: eventItem };

/** 时间倒序；时间相同按标题兜底，保证同一份输入每次渲染顺序一致。 */
const newestFirst = (a, b) => String(b.at ?? '').localeCompare(String(a.at ?? ''))
  || String(a.id).localeCompare(String(b.id))
  || String(a.title).localeCompare(String(b.title));

/**
 * 一条条目落进哪个桶。
 * - dirty 没有时间，工作区里存在就是变化；
 * - 没有水位时提交与事件一律未知：分不清新旧，不能当成看过、也不能当成新的；
 * - 时间解析不了同样未知，不默认算看过（那会把真变化吞掉）。
 */
const bucketOf = (item, { category, watermark, filterId }) => {
  if (!item.valid) return { bucket: 'unknown', reason: 'malformed' };
  if (filterId && item.projectId && item.projectId !== filterId) {
    return { bucket: 'ignored', reason: 'other-project' };
  }
  if (category === 'dirty') return { bucket: 'change', reason: '' };
  if (!watermark.known) return { bucket: 'unknown', reason: 'no-watermark' };
  const atMs = toMillis(item.at);
  if (atMs === null) return { bucket: 'unknown', reason: 'no-time' };
  return atMs > watermark.ms ? { bucket: 'change', reason: '' } : { bucket: 'ignored', reason: 'before-watermark' };
};

const emptyCounts = () => ({ commits: 0, dirty: 0, events: 0, total: 0 });
const countInto = (counts, category) => {
  counts[category] += 1;
  counts.total += 1;
};

/**
 * 组装变化窗口视图模型。
 *
 * @param {object} input
 * @param {string} [input.projectId] 项目 id；事件与提交带项目 id 且不等于它时归入「其他项目」
 * @param {string|number|Date|object} [input.since] 上次水位；也接受 { at } / { lastSeenAt } 行
 * @param {object[]} [input.commits] 提交清单（sha + 提交时间 + 标题），来源由调用方决定
 * @param {object[]} [input.dirty] 未提交改动清单（path + status）
 * @param {object[]} [input.events] 观察员事件（observer store 的 eventRow 形状即可）
 * @returns {object} 供面板直接渲染的只读视图模型
 */
export function changeWindowView(input = {}) {
  const options = isObject(input) ? input : {};
  const projectId = String(options.projectId ?? options.project_id ?? '');
  const filterId = projectId;
  const watermark = watermarkOf(options.since ?? options.watermark ?? null);

  // 探针状态：清单没给（或给了非数组）就是「拿不到」；提交与事件还需要水位才分得清新旧。
  const probes = {};
  for (const def of BLOCK_DEFS) {
    const source = options[def.key];
    const listed = Array.isArray(source);
    const needsWatermark = def.key !== 'dirty';
    if (!listed) probes[def.key] = { ok: false, reason: 'unavailable' };
    else if (needsWatermark && !watermark.known) probes[def.key] = { ok: false, reason: 'no-watermark' };
    else probes[def.key] = { ok: true, reason: '' };
  }

  const change = { commits: [], dirty: [], events: [] };
  const unknown = { counts: emptyCounts(), items: [] };
  const ignored = { counts: emptyCounts(), items: [] };

  for (const def of BLOCK_DEFS) {
    const build = BUILDERS[def.key];
    for (const raw of asList(options[def.key])) {
      const item = build(raw);
      const { bucket, reason } = bucketOf(item, { category: def.key, watermark, filterId });
      if (bucket === 'change') {
        change[def.key].push(item);
      } else {
        // 未知与已看过都保留条目本身，只补上分类与原因：调用方能看到「为什么没算进来」。
        const target = bucket === 'unknown' ? unknown : ignored;
        target.items.push({ ...item, category: def.key, reason });
        countInto(target.counts, def.key);
      }
    }
  }

  for (const def of BLOCK_DEFS) change[def.key].sort(newestFirst);
  unknown.items.sort(newestFirst);
  ignored.items.sort(newestFirst);

  const counts = emptyCounts();
  for (const def of BLOCK_DEFS) counts[def.key] = change[def.key].length;
  counts.total = BLOCK_DEFS.reduce((sum, def) => sum + counts[def.key], 0);

  const blocks = BLOCK_DEFS.map((def) => {
    const items = change[def.key];
    const probe = probes[def.key];
    // 探针失败时换掉空态文案：不能让人把「读不到」看成「没有变化」。
    let emptyHint = def.emptyHint;
    if (!probe.ok) {
      emptyHint = probe.reason === 'no-watermark'
        ? (def.noWatermarkHint ?? def.unavailableHint)
        : def.unavailableHint;
    }
    return {
      key: def.key,
      title: def.title,
      count: items.length,
      empty: items.length === 0,
      probe,
      emptyHint,
      items
    };
  });

  // 三个探针都可用、且没有条目读不出时间或形状，窗口才算「算得清」。
  // 只要有一处读不到，就不能说「都看过了」——空态与未知态必须分得开。
  const probesOk = BLOCK_DEFS.every((def) => probes[def.key].ok);
  const status = probesOk && unknown.counts.total === 0 ? 'ok' : 'unknown';
  const empty = status === 'ok' && counts.total === 0;

  let unknownText = '';
  if (status !== 'ok') {
    const notes = [];
    for (const def of BLOCK_DEFS) {
      const probe = probes[def.key];
      if (!probe.ok && probe.reason === 'unavailable') notes.push(UNAVAILABLE_NOTES[def.key]);
    }
    if (!watermark.known) notes.push('没有上次水位，分不清哪些提交与事件是新的');
    if (unknown.counts.total > 0) notes.push(`有 ${unknown.counts.total} 条条目认不出时间或形状，没算进变化`);
    unknownText = `这次变化窗口算不全：${notes.join('、')}，所以不能当成「没有变化」。`;
  }

  return {
    projectId,
    status,
    since: watermark.at,
    watermark: { at: watermark.at, ms: watermark.ms, known: watermark.known },
    probes,
    counts,
    blocks,
    // 三个类目在顶层也各给一份：面板既能按块遍历，也能直接取某一类。
    commits: change.commits,
    dirty: change.dirty,
    events: change.events,
    unknown,
    ignored,
    empty,
    emptyText: empty ? EMPTY_TEXT : '',
    unknownText
  };
}
