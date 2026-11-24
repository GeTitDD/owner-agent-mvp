// 知识模式：把本地 SQLite 读成「候选 / 经验 / 知识」三层只读视图模型。
//
// 三层来自 ADR-0007：执行记录 ──提炼──▶ 经验 ──收敛──▶ 知识；候选是等待入场的队列。
// 待验证、已验证、已复现、争议都只是条目上的状态徽章，不再各自成组——否则同一条内容
// 会因为状态变化在页面上换位置。每层给两个计数口径：当前项目（受项目筛选影响）与
// 全部项目（不受影响，用来显示「切回全部还能看到多少」）。
//
// 这里只做组装，不写库；候选审核见 review.mjs。数据来源只有本地 SQLite
// （personal_units / personal_proposals / knowledge_lessons），不读 owner.json 里的
// 项目知识，避免同屏出现两套不同步的内容（ADR-0002 / ADR-0006）。

const CANDIDATE_CONTRACT = 'knowledge-candidate/v1';
const DEFAULT_LIMIT = 50;

// 状态徽章：沿用存储层的取值，展示时翻成中文；未登记的状态原样显示，方便排查。
const STATUS_LABELS = {
  inferred: '推断',
  unverified: '待验证',
  verified: '已验证',
  reproduced: '已复现',
  needs_reverification: '待重新验证',
  disputed: '争议'
};
const CANDIDATE_BADGE = '待审核';
const SCOPE_LABELS = { project: '项目', domain: '领域共享', personal: '个人' };

/** 状态徽章文案：未知状态不吞掉，原样显示。 */
const badgeOf = (status) => STATUS_LABELS[status] ?? String(status ?? '未知');

/**
 * 三层定义：层的顺序、标题与空状态文案只在这里写一份。
 * 加层或改文案时改这一处，视图模型与「知识库未初始化」的占位层会同时跟上。
 */
const LAYER_DEFS = [
  {
    key: 'candidates',
    label: '候选',
    hint: (filtered) => (filtered
      ? '这个项目还没有待审核候选。'
      : '还没有待审核候选；提炼经验后会先进入候选。')
  },
  {
    key: 'lessons',
    label: '经验',
    hint: (filtered) => (filtered
      ? '这个项目还没有经验。'
      : '还没有经验；从执行记录里提炼出「现象 → 机制 → 对策」后会出现在这里。')
  },
  {
    key: 'knowledge',
    label: '知识',
    hint: (filtered) => (filtered
      ? '这个项目还没有知识条目。'
      : '还没有知识；接受候选或由经验收敛出规则后会出现在这里。')
  }
];

/** 把任意文本压成一行，避免长内容把列表撑开。 */
const oneLine = (value, max = 120) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);

/** 时间倒序；时间相同的按 id 兜底，保证同一份数据每次渲染顺序一致。 */
const newestFirst = (a, b) =>
  String(b.at ?? '').localeCompare(String(a.at ?? '')) || String(a.id).localeCompare(String(b.id));

const projectIdsOf = (value) => [...new Set((value ?? []).filter(Boolean))];

/**
 * 组装知识模式三层视图模型。
 *
 * @param {object} input
 * @param {string} [input.projectId] 当前筛选的项目；空串表示「全部项目」
 * @param {object[]} [input.units] personal_units 行（进「知识」层）
 * @param {object[]} [input.proposals] personal_proposals 行（待审核候选，进「候选」层）
 * @param {object[]} [input.lessons] knowledge_lessons 行（lesson/v1，进「经验」层）
 * @param {number} [input.limit] 每层最多渲染多少条（计数仍按全量）
 * @returns {object} 供面板直接渲染的只读视图模型
 */
export function knowledgeBrowseView({
  projectId = '',
  units = [],
  proposals = [],
  lessons = [],
  limit = DEFAULT_LIMIT
} = {}) {
  const filterId = String(projectId ?? '');
  const cap = Math.max(1, Number.isSafeInteger(limit) ? limit : DEFAULT_LIMIT);

  // 候选被提炼出来时只带来源 id：先建索引，才能把候选归属回项目。
  // 来源只认 lesson/v1（#60 起的新链路）；旧的 experience/v1 表已退役（#62），不再读取。
  const sourceProject = new Map();
  for (const row of lessons) {
    const ids = projectIdsOf([row.scope?.projectId ?? row.projectId ?? null]);
    if (ids.length) sourceProject.set(row.id, ids[0]);
  }

  const candidates = proposals
    .filter((row) => row?.status === 'pending' && row?.meta?.contract === CANDIDATE_CONTRACT)
    .map((row) => {
      const payload = row.payload ?? {};
      const ids = projectIdsOf([
        payload.projectId ?? null,
        ...(row.meta?.sourceLessonIds ?? []).map((id) => sourceProject.get(id))
      ]);
      const layer = payload.layer ?? row.meta?.proposedLayer ?? 'project';
      const confidence = row.meta?.confidence;
      return {
        id: row.id,
        kind: 'candidate',
        title: oneLine(payload.title, 200) || '未命名候选',
        status: 'pending',
        badge: CANDIDATE_BADGE,
        detail: `${CANDIDATE_BADGE} · ${layer} 层 · 置信度 ${confidence === undefined || confidence === null ? '未知' : confidence}`,
        projectIds: ids,
        projectId: ids[0] ?? null,
        at: row.createdAt ?? row.created_at ?? null
      };
    })
    .sort(newestFirst);

  // 经验：lesson/v1 的「现象 → 机制 → 对策」，默认项目级；域级经验不属于任何项目。
  const lessonItems = lessons
    .map((row) => {
      const layer = row.scope?.layer ?? 'project';
      const ids = layer === 'project'
        ? projectIdsOf([row.scope?.projectId ?? row.projectId ?? null])
        : [];
      const status = row.verificationStatus ?? 'inferred';
      const evidenceCount = Array.isArray(row.evidence)
        ? row.evidence.length
        : (row.evidenceRefs?.length ?? 0);
      return {
        id: row.id,
        kind: 'lesson',
        title: oneLine(row.phenomenon, 200) || '未命名经验',
        status,
        badge: badgeOf(status),
        detail: `经验 · ${badgeOf(status)} · ${layer === 'domain' ? SCOPE_LABELS.domain : SCOPE_LABELS.project} · 证据 ${evidenceCount} 条`,
        projectIds: ids,
        projectId: ids[0] ?? null,
        at: row.lastMergedAt ?? row.createdAt ?? row.created_at ?? null
      };
    })
    .sort(newestFirst);

  // 知识：personal_units 行。项目级与域级的规则同处一层，作用域与层写在说明里，
  // 验证状态只做徽章——接受候选后的待验证条目因此不会「凭空消失」。
  const knowledgeItems = units
    .map((row) => {
      const status = row.verificationStatus ?? 'unverified';
      const layer = row.layer ?? 'applied';
      const ids = row.scope === 'project' ? projectIdsOf([row.projectId]) : [];
      return {
        id: row.id,
        kind: 'knowledge',
        title: oneLine(row.title, 200) || '未命名知识',
        status,
        badge: badgeOf(status),
        detail: `${badgeOf(status)} · ${SCOPE_LABELS[row.scope] ?? row.scope ?? '个人'} · ${layer} 层 · r${row.revision ?? 1}`,
        projectIds: ids,
        projectId: ids[0] ?? null,
        at: row.updatedAt ?? row.updated_at ?? null
      };
    })
    .sort(newestFirst);

  const buckets = { candidates, lessons: lessonItems, knowledge: knowledgeItems };

  // 项目筛选：条目可能同时归属多个项目（候选由多条证据提炼而来），命中原样保留。
  const matches = (item) => !filterId || item.projectIds.includes(filterId);

  // 项目筛选下拉的数据来自全部条目，不引入 owner.json 的项目表。
  const projectCounts = new Map();
  for (const item of [...candidates, ...lessonItems, ...knowledgeItems]) {
    for (const id of item.projectIds) projectCounts.set(id, (projectCounts.get(id) ?? 0) + 1);
  }
  const projects = [...projectCounts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

  // 计数两个口径：project 受当前筛选影响，all 恒为全量。
  // 没选项目时「当前项目」就是「全部项目」，两个口径相等而不是强行报 0。
  const groups = LAYER_DEFS.map((def) => {
    const all = buckets[def.key] ?? [];
    const visible = all.filter(matches);
    return {
      key: def.key,
      label: def.label,
      // count 是当前口径的条数，面板直接显示它（保持数字，不换成对象）。
      count: visible.length,
      counts: { project: visible.length, all: all.length },
      shown: Math.min(visible.length, cap),
      truncated: visible.length > cap,
      items: visible.slice(0, cap),
      // 空层不造假条目：只给标记与说明，面板据此显示一行空状态。
      empty: visible.length === 0,
      emptyHint: def.hint(Boolean(filterId))
    };
  });

  const byKey = Object.fromEntries(groups.map((group) => [group.key, group]));
  const totals = {
    candidates: byKey.candidates.count,
    lessons: byKey.lessons.count,
    knowledge: byKey.knowledge.count
  };
  totals.all = totals.candidates + totals.lessons + totals.knowledge;
  // overall 是筛选前的总量：「全部」筛选按钮用它显示回到全部后能看到多少条。
  const overall = {};
  for (const group of groups) overall[group.key] = group.counts.all;
  overall.all = groups.reduce((sum, group) => sum + group.counts.all, 0);

  // 空层清单：给调用方一个可直接读的标记，不必再自己遍历 groups。
  const emptyLayers = groups.filter((group) => group.empty).map((group) => group.key);

  // 三层全空时给出「为什么空」，而不是留一片空白列表。
  let empty = null;
  if (totals.all === 0) {
    empty = filterId
      ? {
          kind: 'no-project-data',
          title: '这个项目还没有知识条目',
          detail: '候选、经验与知识都会记录所属项目；切回「全部」还能看到其他项目和域级共享内容。'
        }
      : {
          kind: 'no-data',
          title: '本地知识库还没有内容',
          detail: '经验来自执行记录的提炼；提炼会先产出候选，接受候选或收敛出规则后才成为知识。'
        };
  }

  return { filter: { projectId: filterId }, projects, totals, overall, groups, emptyLayers, empty };
}

/**
 * 从本地 SQLite 读出三份数据后组装视图模型。
 * 读不到存储时返回 available:false，面板据此显示「知识库未初始化」。
 */
export function knowledgeBrowseFor({ personalStore, projectId = '', limit = DEFAULT_LIMIT } = {}) {
  if (!personalStore) {
    return {
      available: false,
      filter: { projectId: String(projectId ?? '') },
      projects: [],
      totals: { candidates: 0, lessons: 0, knowledge: 0, all: 0 },
      overall: { candidates: 0, lessons: 0, knowledge: 0, all: 0 },
      groups: LAYER_DEFS.map((def) => ({
        key: def.key,
        label: def.label,
        count: 0,
        counts: { project: 0, all: 0 },
        shown: 0,
        truncated: false,
        items: [],
        empty: true,
        emptyHint: `知识库未初始化，暂时读不到${def.label}。`
      })),
      emptyLayers: LAYER_DEFS.map((def) => def.key),
      empty: {
        kind: 'unavailable',
        title: '知识库还没有初始化',
        detail: '本地 SQLite 打不开时这里只显示说明；重启客户端会自动重试。'
      }
    };
  }
  const units = personalStore.list({ limit: 2000 });
  const proposals = personalStore.proposals('pending');
  const lessons = personalStore.listLessons({ limit: 1000 });
  return {
    available: true,
    ...knowledgeBrowseView({ projectId, units, proposals, lessons, limit })
  };
}
