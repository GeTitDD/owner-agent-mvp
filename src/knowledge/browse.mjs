// 知识模式：只读浏览本地 SQLite 里的候选、待验证/已验证知识与经验。
//
// 这里只做组装，不写库；候选审核见 review.mjs，#43 复用既有 reviewProposal。
// 数据来源只有本地 SQLite（personal_units / personal_proposals /
// knowledge_experiences），不读 owner.json 里的项目知识，避免同屏出现两套不同步
// 的内容（ADR-0002 / ADR-0006）。

const CANDIDATE_CONTRACT = 'knowledge-candidate/v1';
const DEFAULT_LIMIT = 50;

const OUTCOME_LABELS = {
  succeeded: '成功',
  repaired: '已修复',
  failed: '失败',
  cancelled: '已取消',
  rejected: '已拒绝',
  unknown: '结果未知'
};
const SCOPE_LABELS = { project: '项目', domain: '领域共享', personal: '个人' };
// 接受候选只会得到未验证知识；真正验证是下一步，所以单列一组，避免条目凭空消失。
const STATUS_LABELS = { unverified: '待验证', needs_reverification: '待重新验证', disputed: '有争议' };

/**
 * 知识分组定义：分组顺序、标题与空状态文案只在这里写一份。
 * 加组时改这一处，视图模型与「知识库未初始化」的占位分组会同时跟上。
 */
const GROUP_DEFS = [
  {
    key: 'candidates',
    label: '候选',
    empty: (filtered) => (filtered
      ? '这个项目还没有待审核候选。'
      : '还没有待审核候选；提炼经验后会先进入候选。')
  },
  {
    key: 'pending',
    label: '待验证知识',
    empty: (filtered) => (filtered
      ? '这个项目还没有待验证知识。'
      : '还没有待验证知识；接受候选后会先进入这里。')
  },
  {
    key: 'verified',
    label: '已验证知识',
    empty: (filtered) => (filtered
      ? '这个项目还没有已验证知识。'
      : '还没有已验证知识；候选确认并附证据后才算已验证。')
  },
  {
    key: 'experiences',
    label: '经验',
    empty: (filtered) => (filtered
      ? '这个项目还没有经验记录。'
      : '还没有经验记录；完成一次任务并验证后会自动采集。')
  }
];

/** 把任意文本压成一行，避免长经验内容把列表撑开。 */
const oneLine = (value, max = 120) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);

/** 时间倒序；时间相同的按 id 兜底，保证同一份数据每次渲染顺序一致。 */
const newestFirst = (a, b) =>
  String(b.at ?? '').localeCompare(String(a.at ?? '')) || String(a.id).localeCompare(String(b.id));

const projectIdsOf = (value) => [...new Set((value ?? []).filter(Boolean))];

/**
 * 组装知识模式视图模型。
 *
 * @param {object} input
 * @param {string} [input.projectId] 当前筛选的项目；空串表示「全部」
 * @param {object[]} [input.units] personal_units 行（含 payload 展开后的字段）
 * @param {object[]} [input.proposals] personal_proposals 行（待审核候选）
 * @param {object[]} [input.experiences] knowledge_experiences 行
 * @param {number} [input.limit] 每组最多渲染多少条（计数仍按全量）
 * @returns {object} 供面板直接渲染的只读视图模型
 */
export function knowledgeBrowseView({
  projectId = '',
  units = [],
  proposals = [],
  experiences = [],
  limit = DEFAULT_LIMIT
} = {}) {
  const filterId = String(projectId ?? '');
  const cap = Math.max(1, Number.isSafeInteger(limit) ? limit : DEFAULT_LIMIT);

  // 经验先建索引：候选用 sourceExperienceIds 反查所属项目。
  const experienceProject = new Map(
    experiences.map((row) => [row.id, row.projectId ?? row.project_id ?? null])
  );

  const candidates = proposals
    .filter((row) => row?.status === 'pending' && row?.meta?.contract === CANDIDATE_CONTRACT)
    .map((row) => {
      const payload = row.payload ?? {};
      const ids = projectIdsOf([
        payload.projectId ?? null,
        ...(row.meta?.sourceExperienceIds ?? []).map((id) => experienceProject.get(id))
      ]);
      const layer = payload.layer ?? row.meta?.proposedLayer ?? 'project';
      const confidence = row.meta?.confidence;
      return {
        id: row.id,
        kind: 'candidate',
        title: oneLine(payload.title, 200) || '未命名候选',
        detail: `待审核 · ${layer} 层 · 置信度 ${confidence === undefined || confidence === null ? '未知' : confidence}`,
        projectIds: ids,
        projectId: ids[0] ?? null,
        at: row.createdAt ?? row.created_at ?? null
      };
    })
    .sort(newestFirst);

  // 候选被接受后先落成未验证知识；已验证与待验证只差一个状态词，
  // 所以共用一份映射，再按 kind 拆成两组，避免两段几乎相同的代码各自漂移。
  const mapKnowledgeUnit = (row) => {
    const ids = row.scope === 'project' ? projectIdsOf([row.projectId]) : [];
    const status = row.verificationStatus;
    const verified = status === 'verified';
    return {
      id: row.id,
      kind: verified ? 'verified' : 'pending',
      title: oneLine(row.title, 200) || '未命名知识',
      detail: `${verified ? '已验证' : STATUS_LABELS[status] ?? '待验证'} · ${SCOPE_LABELS[row.scope] ?? row.scope ?? '个人'} · ${row.layer ?? 'applied'} 层 · r${row.revision ?? 1}`,
      projectIds: ids,
      projectId: ids[0] ?? null,
      at: row.updatedAt ?? row.updated_at ?? null
    };
  };
  const knowledgeUnits = units
    .filter((row) => row?.verificationStatus)
    .map(mapKnowledgeUnit)
    .sort(newestFirst);
  const pendingUnits = knowledgeUnits.filter((item) => item.kind === 'pending');
  const verified = knowledgeUnits.filter((item) => item.kind === 'verified');

  const experienceItems = experiences
    .map((row) => {
      const ids = projectIdsOf([row.projectId ?? row.project_id ?? null]);
      const outcome = row.observedOutcome?.status ?? row.outcome ?? 'unknown';
      return {
        id: row.id,
        kind: 'experience',
        title: oneLine(row.observedProblem, 200) || '未命名经验',
        detail: `经验 · ${OUTCOME_LABELS[outcome] ?? outcome}`,
        projectIds: ids,
        projectId: ids[0] ?? null,
        at: row.createdAt ?? row.created_at ?? null
      };
    })
    .sort(newestFirst);

  // 项目筛选：条目可能同时归属多个项目（候选由多条经验提炼而来），命中原样保留。
  const matches = (item) => !filterId || item.projectIds.includes(filterId);
  const visibleCandidates = candidates.filter(matches);
  const visiblePending = pendingUnits.filter(matches);
  const visibleVerified = verified.filter(matches);
  const visibleExperiences = experienceItems.filter(matches);

  // 项目筛选下拉的数据同样只来自这些组条目，不引入 owner.json 的项目表。
  const projectCounts = new Map();
  for (const item of [...candidates, ...pendingUnits, ...verified, ...experienceItems]) {
    for (const id of item.projectIds) projectCounts.set(id, (projectCounts.get(id) ?? 0) + 1);
  }
  const projects = [...projectCounts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

  const makeGroup = (key, label, items, emptyHint) => ({
    key,
    label,
    count: items.length,
    shown: Math.min(items.length, cap),
    truncated: items.length > cap,
    items: items.slice(0, cap),
    emptyHint
  });

  const visible = {
    candidates: visibleCandidates,
    pending: visiblePending,
    verified: visibleVerified,
    experiences: visibleExperiences
  };

  // 即使全空也保留四组与计数，让「候选 / 已验证 / 经验」的结构始终可见。
  const groups = GROUP_DEFS.map((def) =>
    makeGroup(def.key, def.label, visible[def.key], def.empty(Boolean(filterId))));

  const totals = {
    candidates: visibleCandidates.length,
    pending: visiblePending.length,
    verified: visibleVerified.length,
    experiences: visibleExperiences.length
  };
  totals.all = totals.candidates + totals.pending + totals.verified + totals.experiences;
  // overall 是筛选前的总量：「全部」筛选按钮用它显示回到全部后能看到多少条。
  const overall = {
    candidates: candidates.length,
    pending: pendingUnits.length,
    verified: verified.length,
    experiences: experienceItems.length
  };
  overall.all = overall.candidates + overall.pending + overall.verified + overall.experiences;

  // 全空时给出「为什么空」，而不是留一片空白列表。
  let empty = null;
  if (totals.all === 0) {
    empty = filterId
      ? {
          kind: 'no-project-data',
          title: '这个项目还没有知识条目',
          detail: '候选、待验证知识、已验证知识和经验都会记录所属项目；切回「全部」还能看到其他项目和共享知识。'
        }
      : {
          kind: 'no-data',
          title: '本地知识库还没有内容',
          detail: '经验来自完成并验证过的任务；提炼经验会产出候选，确认候选后先进入待验证知识。'
        };
  }

  return { filter: { projectId: filterId }, projects, totals, overall, groups, empty };
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
      totals: { candidates: 0, pending: 0, verified: 0, experiences: 0, all: 0 },
      overall: { candidates: 0, pending: 0, verified: 0, experiences: 0, all: 0 },
      groups: GROUP_DEFS.map((def) => ({
        key: def.key,
        label: def.label,
        count: 0,
        shown: 0,
        truncated: false,
        items: [],
        emptyHint: `知识库未初始化，暂时读不到${def.label}。`
      })),
      empty: {
        kind: 'unavailable',
        title: '知识库还没有初始化',
        detail: '本地 SQLite 打不开时这里只显示说明；重启客户端会自动重试。'
      }
    };
  }
  const units = personalStore.list({ limit: 2000 });
  const proposals = personalStore.proposals('pending');
  const experiences = personalStore.listExperiences({ limit: 1000 });
  return {
    available: true,
    ...knowledgeBrowseView({ projectId, units, proposals, experiences, limit })
  };
}
