// 项目库历史版本与自动 diff（#92）：相邻两版快照之间，按条目身份给出三类变化。
//
// 纯函数：只吃两份快照内容（src/project-snapshots.mjs 的 snapshotContentOf 形状），
// 不读库、不读盘、不联网，也不产生新事实。查看历史版本是只读动作，比对同样只读。
//
// 身份判定用条目自己的引用（ref.kind + ref.id），不用数组下标，也不用标题文本：
// 标题恰恰是最常被改的字段之一，用它当身份会把「改标题」误判成「删一条加一条」。
// 修订号（ref.revision）属于同一身份的不同修订，只在字段对比里体现，不参与身份。
//
// 相邻两版比较时，条目在数组里的先后顺序变化不算变更：两侧都先按身份建索引，
// 再逐条比字段；因此同一批条目换个顺序发布，三类结果都是空的。

const asArray = (value) => (Array.isArray(value) ? value : []);

// 参与比对的字段顺序也是面板展示顺序：结论本身在前，时间与修订在后。
const FIELD_ORDER = Object.freeze(['title', 'status', 'badge', 'section', 'evidence', 'revision', 'at']);

const FIELD_LABELS = Object.freeze({
  title: '标题',
  status: '状态',
  badge: '徽章',
  section: '分节',
  evidence: '证据',
  revision: '修订',
  at: '更新时间'
});

/** 条目的稳定身份：kind:id。快照构建时总会写入 ref，缺失时也保持同一规则。 */
const identityOf = (item) => {
  const kind = String(item?.ref?.kind ?? '');
  const id = String(item?.ref?.id ?? '');
  return `${kind}:${id}`;
};

/** 证据引用按「kind:ref」拼成可比较、可展示的字符串；顺序变化不影响判定。 */
const evidenceTextOf = (item) => asArray(item?.evidence)
  .map((evidence) => `${String(evidence?.kind ?? '')}:${String(evidence?.ref ?? '')}`)
  .sort()
  .join(' · ');

/** 分节标题：优先用快照自带的 label，认不出来时退回键名，不猜。 */
const sectionLabelsOf = (...contents) => {
  const labels = new Map();
  for (const content of contents) {
    for (const section of asArray(content?.sections)) {
      const key = String(section?.key ?? '');
      if (!key) continue;
      labels.set(key, String(section?.label ?? key));
    }
  }
  return labels;
};

/**
 * 条目所在节由外层 section 决定：快照写进条目时已经剥掉了 section 字段，
 * 复用 item.section 会永远读到空值。这里显式传进来。
 */
const fieldsOf = (item, section, sectionLabels) => {
  const revision = item?.ref?.revision;
  return {
    title: String(item?.title ?? ''),
    status: String(item?.status ?? ''),
    badge: String(item?.badge ?? ''),
    section: sectionLabels.get(section) ?? (section || '—'),
    evidence: evidenceTextOf(item),
    revision: Number.isSafeInteger(revision) ? String(revision) : '',
    at: String(item?.at ?? '')
  };
};

/** 新增 / 消失只需要「是哪一条」：身份、标题、所在节与徽章足够定位。 */
const summaryOf = (item, section, sectionLabels) => ({
  key: identityOf(item),
  ref: {
    kind: String(item?.ref?.kind ?? ''),
    id: String(item?.ref?.id ?? ''),
    ...(Number.isSafeInteger(item?.ref?.revision) ? { revision: item.ref.revision } : {})
  },
  title: String(item?.title ?? ''),
  section,
  sectionLabel: sectionLabels.get(section) ?? (section || '—'),
  badge: String(item?.badge ?? '')
});

/** 把快照按身份收成索引；同一身份出现两次时保留后者（快照本身不该重复）。 */
const entriesOf = (content) => {
  const entries = new Map();
  for (const section of asArray(content?.sections)) {
    for (const item of asArray(section?.items)) {
      entries.set(identityOf(item), { item, section: String(section?.key ?? '') });
    }
  }
  return entries;
};

/**
 * 相邻两版自动 diff。
 *
 * @param {object|null} previous 上一版快照内容；null 表示没有可比的上一版（首版）。
 * @param {object} current 这一版快照内容。
 * @param {object} [options]
 * @param {string} [options.previousLabel] 上一版标签（如 v1），只用于文案。
 * @param {boolean} [options.previousMissing] 版本号大于 1 但上一版读不到时置 true，
 *   与首版区分开：首版是「本来就没有」，这个是「本该有却不见了」。
 * @returns {object} 三类结果 + 未变化计数 + 一句可直接展示的结论；不可比时 counts 为 null。
 */
export function versionDiffOf(previous, current, { previousLabel = '', previousMissing = false } = {}) {
  const entries = entriesOf(current);
  const total = entries.size;

  if (previousMissing) {
    return {
      comparable: false,
      firstVersion: false,
      missingPrevious: true,
      previousLabel,
      headline: `${previousLabel || '上一版'} 已不可用，无法比对`,
      added: [],
      changed: [],
      removed: [],
      unchanged: 0,
      counts: null,
      total
    };
  }

  if (previous === null || previous === undefined) {
    // 首版没有可比对象：不显示成「0 变化」，也不给三类计数，免得被读成「比过且没变」。
    return {
      comparable: false,
      firstVersion: true,
      missingPrevious: false,
      previousLabel: '',
      headline: '首版，无可比对象',
      added: [],
      changed: [],
      removed: [],
      unchanged: 0,
      counts: null,
      total
    };
  }

  const labels = sectionLabelsOf(previous, current);
  const before = entriesOf(previous);
  const added = [];
  const changed = [];
  const removed = [];
  let unchanged = 0;

  for (const [key, entry] of entries) {
    const old = before.get(key);
    if (!old) {
      added.push(summaryOf(entry.item, entry.section, labels));
      continue;
    }
    const beforeFields = fieldsOf(old.item, old.section, labels);
    const afterFields = fieldsOf(entry.item, entry.section, labels);
    const changes = FIELD_ORDER
      .filter((field) => beforeFields[field] !== afterFields[field])
      .map((field) => ({
        field,
        label: FIELD_LABELS[field],
        before: beforeFields[field],
        after: afterFields[field]
      }));
    if (changes.length === 0) {
      unchanged += 1;
      continue;
    }
    changed.push({
      key,
      ref: summaryOf(entry.item, entry.section, labels).ref,
      title: String(entry.item?.title ?? ''),
      section: entry.section,
      sectionLabel: labels.get(entry.section) ?? (entry.section || '—'),
      badge: String(entry.item?.badge ?? ''),
      changes
    });
  }

  for (const [key, entry] of before) {
    if (entries.has(key)) continue;
    removed.push(summaryOf(entry.item, entry.section, labels));
  }

  // 输出按身份排序：同一份输入永远得到同一份结果，顺序变化不产生差异。
  const byKey = (a, b) => String(a.key).localeCompare(String(b.key));
  added.sort(byKey);
  changed.sort(byKey);
  removed.sort(byKey);

  const label = previousLabel || '上一版';
  const headline = added.length || changed.length || removed.length
    ? `与 ${label} 相比：新增 ${added.length} 条 · 变更 ${changed.length} 条 · 消失 ${removed.length} 条`
    : `与 ${label} 相比：没有变化`;

  return {
    comparable: true,
    firstVersion: false,
    missingPrevious: false,
    previousLabel,
    headline,
    added,
    changed,
    removed,
    unchanged,
    counts: {
      added: added.length,
      changed: changed.length,
      removed: removed.length,
      unchanged
    },
    total
  };
}
