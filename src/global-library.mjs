// 全局模式的跨项目聚合：只读视图，不是新存储，也不产生新事实。
//
// 为什么单独一个文件：不选项目就是全局模式（#107），但它读什么必须和项目库同一口径，
// 否则「全局看到的」和「进项目看到的」会对不上。这里不做筛选、不读库、不联网：
// 每个项目已经由 src/project-library.mjs 的 projectLibraryView 算好一份库视图，
// 本文件只做三件事：
//
// 1) 去重：同一份域知识会同时进多个项目的库视图（ADR-0009 的「同领域即入」），
//    聚合时按 `kind:id` 合成一条，并记下它出现在哪些项目里；否则全局计数会被
//    项目数量放大，看起来像凭空多出一堆知识。
// 2) 分节：沿用条目自己算好的 section（已验证 / 观察中），不重算、不重排规则，
//    所以两节仍然互斥，合计恒等于去重后的条目数。
// 3) 计数与截断：count 按全量，entries 受 limit 截断；每项目另给一份原始计数，
//    并标明它是「本项目口径」（不去重），避免两个数字被当成矛盾。
//
// 全局视图永远是只读：写入落点由「正在看的项目」决定，没有项目就没有落点（见
// src/global-write.mjs）。这里不返回任何「能不能写」的暗示，只返回读到了什么。

const DEFAULT_LIMIT = 8;

const asArray = (value) => (Array.isArray(value) ? value : []);

const oneLine = (value, max = 160) => String(value ?? '')
  .replace(/\s+/gu, ' ')
  .trim()
  .slice(0, max);

/**
 * 条目身份：库视图里的条目本来就带 `kind` 与稳定 `id`。
 * 缺 id 的异常条目退化成「类型 + 标题 + 时间」，只用于去重，不冒充稳定标识。
 */
const entryKeyOf = (entry) => {
  const id = String(entry?.id ?? '').trim();
  const kind = String(entry?.kind ?? 'entry');
  if (id) return `${kind}:${id}`;
  return `${kind}:${oneLine(entry?.title, 80)}:${String(entry?.at ?? '')}`;
};

/** 时间倒序；同一时间按标题兜底，保证同一份输入每次得到同一份输出。 */
const newestFirst = (a, b) =>
  String(b.at ?? '').localeCompare(String(a.at ?? '')) || String(a.title ?? '').localeCompare(String(b.title ?? ''));

/** 一条条目属于哪个来源类别：经验 / 由项目贡献 / 领域共享。 */
const sourceGroupOf = (entry) => {
  if (entry.kind === 'lesson') return 'experiences';
  const sources = asArray(entry.sources);
  return sources.includes('contributed') || entry.source === 'contributed'
    ? 'contributedKnowledge'
    : 'domainKnowledge';
};

/**
 * 组装全局只读视图。
 *
 * @param {object} [input]
 * @param {Array<{project: {id: string, name?: string}, library: object}>} [input.libraries]
 *   每个已登记项目与它的库视图（projectLibraryView 的返回值）
 * @param {number} [input.limit] 合并后最多列出多少条（计数仍按全量）
 * @returns {object} 供卡片壳直接渲染的只读视图模型
 */
export function globalLibraryView({ libraries = [], limit = DEFAULT_LIMIT } = {}) {
  const cap = Math.max(1, Number.isSafeInteger(limit) ? limit : DEFAULT_LIMIT);
  const byProject = [];
  const merged = new Map();

  for (const item of asArray(libraries)) {
    const id = String(item?.project?.id ?? '').trim();
    const name = oneLine(item?.project?.name, 120) || id || '未命名项目';
    const library = item?.library ?? {};
    // 每项目原始计数：不去重，标成「本项目口径」。
    byProject.push({
      id,
      name,
      counts: { ...(library.counts ?? {}) },
      empty: library.empty?.kind ?? ''
    });
    // groups 是未截断的全量条目；sections 只用于显示，不参与聚合。
    for (const group of asArray(library.groups)) {
      for (const entry of asArray(group?.items)) {
        if (!entry || typeof entry !== 'object') continue;
        const key = entryKeyOf(entry);
        const current = merged.get(key);
        if (!current) {
          merged.set(key, {
            ...entry,
            projectIds: [id],
            projects: [name],
            sources: [String(entry.source ?? '')].filter(Boolean)
          });
          continue;
        }
        // 同一条知识出现在多个项目：补上项目来源，不复制成两条。
        if (!current.projectIds.includes(id)) {
          current.projectIds.push(id);
          current.projects.push(name);
        }
        const source = String(entry.source ?? '');
        if (source && !current.sources.includes(source)) current.sources.push(source);
      }
    }
  }

  const all = [...merged.values()]
    .map((entry) => ({
      ...entry,
      // 一条知识可能既被本项目贡献、又因同领域进入别的库；来源按「更具体」的顺序合并。
      source: entry.sources.includes('experience')
        ? 'experience'
        : (entry.sources.includes('contributed') ? 'contributed' : 'domain'),
      // 顶栏/列表里一句话说清「从哪几个项目读到」。
      projectLabel: entry.projects.join(' / ')
    }))
    .sort(newestFirst);

  const verified = all.filter((entry) => entry.section === 'verified');
  const observing = all.filter((entry) => entry.section === 'observing');
  const counts = {
    // total 只数条目，恒等于 verified + observing（与项目库同一互斥规则）。
    total: all.length,
    verified: verified.length,
    observing: observing.length,
    experiences: all.filter((entry) => sourceGroupOf(entry) === 'experiences').length,
    contributedKnowledge: all.filter((entry) => sourceGroupOf(entry) === 'contributedKnowledge').length,
    domainKnowledge: all.filter((entry) => sourceGroupOf(entry) === 'domainKnowledge').length,
    // 出现在两个及以上项目里的条目：全局视图相对各项目之和少掉的部分。
    shared: all.filter((entry) => entry.projectIds.length > 1).length,
    projects: byProject.length
  };

  const empty = counts.projects === 0
    ? {
      kind: 'no-project',
      title: '还没有登记项目',
      detail: '全局模式读所有项目的记忆；先登记一个项目，这里才有东西可读。'
    }
    : counts.total === 0
      ? {
        kind: 'empty-global',
        title: '所有项目的库都还是空的',
        detail: '各项目的经验、所属领域的知识、由项目贡献的知识都还没有内容；沉淀之后会自动聚到这里。'
      }
      : null;

  const visible = all.slice(0, cap);

  return {
    scope: 'global',
    // 只读不是提示语，是这一层的契约：没有项目就没有写入落点。
    readOnly: true,
    title: '全局 · 跨项目记忆',
    hint: '读所有项目的经验与知识（同一条只算一次），不写入任何项目。',
    projectCount: byProject.length,
    counts,
    projects: byProject,
    sections: [
      { key: 'verified', label: '已验证', count: verified.length },
      { key: 'observing', label: '观察中', count: observing.length }
    ],
    entries: visible,
    shown: visible.length,
    truncated: all.length > visible.length,
    empty
  };
}
