// 项目库：一个项目的知识聚合视图，不是一个新存储。
//
// 四类内容全部由调用方注入：本项目的经验（lesson/v1）、所属领域的知识
// （personal_units 一类的知识条目池）、由本项目升上去的知识、画像与图谱。
// 这里只做筛选、分组、分节，不读库、不读盘、不联网，也不产生新事实。
//
// 两条固定规则（ADR-0009）：
// 1. 域知识进库 = 「属于该项目的领域」或「由该项目贡献」。只取后者会让新项目一片空白，
//    全取会让库变成整个领域的镜像；两个条件必须同时生效。
// 2. 条目只按「已验证 / 观察中」分两节：先给每条算出唯一去处，再做一次 partition，
//    因此两节天然互斥，合计恒等于条目总数。非已验证状态（待验证、推断、争议、
//    待重新验证、已被取代）不藏起来，连同真实状态徽章一起放进「观察中」。
//
// 画像与图谱是只读资产，不参与两节的分节，但同样出现在库视图里；每类图谱给一张代表，
// 缺的写明缺，避免让人以为项目只有一个视角。

import { DIAGRAM_KINDS, DIAGRAM_LABELS } from './project-diagrams.mjs';
import { decisionDecidedAt, decisionStatusOf } from './memory/decision-status.mjs';

const DEFAULT_LIMIT = 50;

// 条目来源只有三种：本项目的经验、同领域的知识、由本项目贡献的知识。
// 画像与图谱走 assets，不占条目来源。
const SOURCE_LABELS = Object.freeze({
  experience: '本项目经验',
  domain: '所属领域知识',
  contributed: '本项目贡献'
});

// 分组的标题比来源徽章更完整：经验与知识分开后，「升上去」是这一类的内容说明。
const GROUP_LABELS = Object.freeze({
  experiences: '本项目经验',
  domainKnowledge: '所属领域知识',
  contributedKnowledge: '本项目升上去的知识'
});

// 状态徽章：未知状态原样显示，方便排查；不吞掉、不冒充已验证。
const STATUS_LABELS = Object.freeze({
  verified: '已验证',
  unverified: '待验证',
  inferred: '推断',
  needs_reverification: '待重新验证',
  disputed: '争议',
  superseded: '已被取代',
  // 决策类知识不用「待验证 / 已验证」，生效中的决策同样不属于「观察中」。
  active: '生效中',
  replaced: '已被取代',
  abandoned: '已放弃'
});

// 可以进「已验证」一节的状态。复现（reproduced）是属性不是状态，不自动升验证（ADR-0007）。
const VERIFIED_STATUSES = new Set(['verified', 'active']);

/** 去重并丢掉空值，保持首次出现的顺序。 */
const unique = (values) => [...new Set(values.filter(Boolean))];

/** 把任意文本压成一行，避免长内容把列表撑开。 */
const oneLine = (value, max = 120) => String(value ?? '')
  .replace(/\s+/gu, ' ')
  .trim()
  .slice(0, max);

const asArray = (value) => (Array.isArray(value) ? value : []);

/**
 * 证据引用只留「指向哪条记录」：快照固化的是结论与引用，不把证据正文带进去。
 * 经验侧是 evidence 行对象（带 kind/ref），知识侧是 evidenceRefs 字符串，这里统一成
 * { kind, ref }，快照与面板读同一份形状。
 */
const evidenceRefsOf = (value) => asArray(value)
  .map((item) => {
    if (typeof item === 'string') {
      const ref = item.trim().slice(0, 300);
      return ref ? { kind: 'evidence', ref } : null;
    }
    const ref = String(item?.ref ?? item?.id ?? '').trim().slice(0, 300);
    return ref ? { kind: String(item?.kind ?? 'evidence').slice(0, 40), ref } : null;
  })
  .filter(Boolean);

/**
 * 条目状态：决策读自己的状态列（decisionStatus），其余读验证状态。
 * 两者不互相冒充——决策的「生效中」不是「已验证」，决策的「已放弃」也不是「待验证」。
 */
const statusOf = (row) => String(
  row?.kind === 'decision'
    ? (decisionStatusOf(row) ?? 'active')
    : (row?.verificationStatus ?? row?.status ?? 'unverified')
);

const badgeOf = (status) => STATUS_LABELS[status] ?? (status ? String(status) : '未知');

const isVerifiedStatus = (status) => VERIFIED_STATUSES.has(status);

/** 时间倒序；时间相同的按 id 兜底，保证同一份输入每次得到同一份输出。 */
const newestFirst = (a, b) =>
  String(b.at ?? '').localeCompare(String(a.at ?? '')) || String(a.id).localeCompare(String(b.id));

const projectIdOf = (project) => String(project?.id ?? project?.projectId ?? '').trim();

/**
 * 项目领域：owner_projects 里是 primary_domain + domains 两列，entry() 之后是
 * primary_domain/domains；调用方也可能给 primaryDomain/domain。这里一并认。
 */
const projectDomainsOf = (project) => unique([
  ...asArray(project?.domains),
  project?.primaryDomain,
  project?.primary_domain,
  project?.domain
].map((value) => String(value ?? '').trim()).filter(Boolean));

/** 知识条目自己的领域：域级条目写在 domains；兼容单数 domain 与 scope.domains。 */
const itemDomainsOf = (row) => unique([
  ...asArray(row?.domains),
  row?.domain,
  ...asArray(row?.scope?.domains),
  row?.scope?.domain
].map((value) => String(value ?? '').trim()).filter(Boolean));

/**
 * 知识条目的贡献来源：项目级知识的 projectId，升域后保留的 originProjectId，
 * 以及来源台账 sources[].projectId。升域不丢来源（personal-store.promoteLessonToDomain）。
 */
const contributionIdsOf = (row) => unique([
  row?.projectId,
  row?.originProjectId,
  row?.scope?.projectId,
  ...asArray(row?.contributedByProjects),
  ...asArray(row?.contributedByProjectIds),
  ...asArray(row?.projectIds),
  ...asArray(row?.sources).map((source) => source?.projectId)
].map((value) => String(value ?? '').trim()).filter(Boolean));

/** 本项目的经验：现象 → 机制 → 对策，状态只从 verificationStatus/status 读。 */
const entryOfLesson = (row) => {
  const status = statusOf(row);
  const evidenceCount = Array.isArray(row?.evidence)
    ? row.evidence.length
    : asArray(row?.evidenceRefs).length;
  const layer = row?.scope?.layer === 'domain' ? '域级经验' : '项目经验';
  return {
    id: String(row?.id ?? ''),
    kind: 'lesson',
    source: 'experience',
    sourceLabel: SOURCE_LABELS.experience,
    title: oneLine(row?.phenomenon, 200) || '未命名经验',
    status,
    badge: badgeOf(status),
    detail: `${layer} · ${badgeOf(status)} · 证据 ${evidenceCount} 条`,
    evidenceCount,
    evidenceRefs: evidenceRefsOf(row?.evidence),
    at: row?.lastMergedAt ?? row?.createdAt ?? row?.created_at ?? null,
    section: isVerifiedStatus(status) ? 'verified' : 'observing'
  };
};

/** 知识条目：来源由筛选时的判定给出（同领域 / 本项目贡献），状态只做徽章。 */
const entryOfKnowledge = (row, source) => {
  const isDecision = row?.kind === 'decision';
  const status = statusOf(row);
  const evidenceCount = asArray(row?.evidenceRefs).length;
  const current = !isDecision || status === 'active';
  const decidedAt = isDecision ? decisionDecidedAt(row) : null;
  return {
    id: String(row?.id ?? ''),
    kind: isDecision ? 'decision' : 'knowledge',
    source,
    sourceLabel: SOURCE_LABELS[source],
    title: oneLine(row?.title, 200) || (isDecision ? '未命名决策' : '未命名知识'),
    status,
    badge: badgeOf(status),
    current,
    reasonMissing: isDecision && row?.decision?.reasonMissing === true,
    decidedAt,
    detail: [
      isDecision ? '决策' : '知识',
      source === 'contributed' ? '本项目贡献' : '领域共享',
      badgeOf(status),
      current ? '' : '不算现状',
      `证据 ${evidenceCount} 条`
    ].filter(Boolean).join(' · '),
    evidenceCount,
    evidenceRefs: evidenceRefsOf(row?.evidenceRefs),
    // 知识条目带修订号：快照里的引用要能指回「当时是哪一版」。
    ...(Number.isSafeInteger(row?.revision) ? { revision: row.revision } : {}),
    at: row?.updatedAt ?? row?.updated_at ?? row?.createdAt ?? row?.created_at ?? null,
    // 生效中的决策属于现状，进「已验证」一节；结束状态与其它未验证条目一起进「观察中」。
    section: isVerifiedStatus(status) ? 'verified' : 'observing'
  };
};

/** 一节的固定形状：计数按全量，items 受 limit 截断，空节给说明而不是假条目。 */
const sectionOf = (key, label, items, emptyHint, limit) => {
  const visible = items.slice(0, limit);
  return {
    key,
    label,
    count: items.length,
    shown: visible.length,
    truncated: items.length > visible.length,
    items: visible,
    empty: items.length === 0,
    emptyHint
  };
};

/** 画像：只读，带上「基于哪个提交、什么时候生成」，过期与否由调用方判定后传入 stale。 */
const profileAssetOf = (profile) => {
  if (!profile || typeof profile !== 'object') {
    return {
      available: false,
      title: '项目画像',
      detail: '还没有生成项目画像；生成后会以只读方式出现在这里。'
    };
  }
  return {
    available: true,
    title: '项目画像',
    oneLiner: oneLine(profile.oneLiner ?? profile.summary, 120),
    whatItIs: String(profile.whatItIs ?? profile.summary ?? '').slice(0, 2000),
    basedOnCommit: profile.basedOnCommit ?? null,
    generatedAt: profile.generatedAt ?? profile.updatedAt ?? profile.updated_at
      ?? profile.createdAt ?? profile.created_at ?? null,
    stale: profile.stale === true
  };
};

/** 图谱：每类各给一张代表（同类取最新），缺的写明缺，不静默省略。 */
const diagramsAssetOf = (diagrams) => {
  const rows = asArray(diagrams).filter((row) => row && typeof row === 'object');
  return DIAGRAM_KINDS.map((kind) => {
    const label = DIAGRAM_LABELS[kind] ?? kind;
    const candidates = rows
      .filter((row) => (row.kind ?? 'dependency') === kind)
      .map((row) => ({
        row,
        at: row.updatedAt ?? row.updated_at ?? row.generatedAt ?? row.createdAt ?? null
      }))
      .sort(newestFirst);
    const chosen = candidates[0]?.row;
    if (!chosen) {
      return {
        kind,
        label,
        available: false,
        title: label,
        detail: `还没有生成${label}；发布时会把这类标为缺失。`
      };
    }
    return {
      kind,
      label,
      available: true,
      title: oneLine(chosen.title, 120) || label,
      summary: oneLine(chosen.summary ?? chosen.data?.summary, 300),
      basedOnCommit: chosen.basedOnCommit ?? null,
      generatedAt: chosen.generatedAt ?? chosen.updatedAt ?? chosen.updated_at
        ?? chosen.createdAt ?? null,
      stale: chosen.stale === true
    };
  });
};

/**
 * 组装项目库视图。
 *
 * @param {object} input
 * @param {object} [input.project] 项目记录：{ id, name, domains?, primaryDomain? }
 * @param {object[]} [input.lessons] 本项目的经验（lesson/v1 行）
 * @param {object[]} [input.knowledge] 知识条目池（personal_units 行）；按域 + 贡献筛选
 * @param {object|null} [input.profile] 项目画像（project-brief 结构，可带 basedOnCommit/generatedAt）
 * @param {object[]} [input.diagrams] 项目图谱（project-diagrams 结构，可带 kind/title/updatedAt）
 * @param {number} [input.limit] 每节最多渲染多少条（计数仍按全量）
 * @returns {object} 供面板/快照直接渲染的只读视图模型
 */
export function projectLibraryView({
  project = {},
  lessons = [],
  knowledge = [],
  profile = null,
  diagrams = [],
  limit = DEFAULT_LIMIT
} = {}) {
  const projectId = projectIdOf(project);
  const domains = projectDomainsOf(project);
  const cap = Math.max(1, Number.isSafeInteger(limit) ? limit : DEFAULT_LIMIT);

  // 经验：调用方注入的就是本项目经验，这里不重复做项目筛选。
  const experienceItems = asArray(lessons)
    .filter((row) => row && typeof row === 'object')
    .map(entryOfLesson);

  // 域知识筛选：同领域 或 本项目贡献，二者取并集。
  // 同一领域且由本项目贡献的条目归到「本项目贡献」组——来源信息比领域匹配更具体。
  const domainItems = [];
  const contributedItems = [];
  for (const row of asArray(knowledge)) {
    if (!row || typeof row !== 'object') continue;
    const contributed = Boolean(projectId) && contributionIdsOf(row).includes(projectId);
    const sameDomain = domains.length > 0
      && itemDomainsOf(row).some((domain) => domains.includes(domain));
    if (!contributed && !sameDomain) continue;
    const item = entryOfKnowledge(row, contributed ? 'contributed' : 'domain');
    (contributed ? contributedItems : domainItems).push(item);
  }

  // 先合并、排序，再按每条已经算好的 section 做一次 partition：
  // 一条只会落进一节，两节合计恒等于 entries.length（互斥且不丢）。
  const entries = [...experienceItems, ...domainItems, ...contributedItems].sort(newestFirst);
  const verifiedItems = entries.filter((item) => item.section === 'verified');
  const observingItems = entries.filter((item) => item.section === 'observing');

  const groups = [
    { key: 'experiences', label: GROUP_LABELS.experiences, count: experienceItems.length, items: [...experienceItems].sort(newestFirst) },
    { key: 'domainKnowledge', label: GROUP_LABELS.domainKnowledge, count: domainItems.length, items: [...domainItems].sort(newestFirst) },
    { key: 'contributedKnowledge', label: GROUP_LABELS.contributedKnowledge, count: contributedItems.length, items: [...contributedItems].sort(newestFirst) }
  ];

  const sections = [
    sectionOf('verified', '已验证', verifiedItems, '这个项目还没有已验证的条目。', cap),
    sectionOf('observing', '观察中', observingItems, '没有观察中的条目。', cap)
  ];

  const profileAsset = profileAssetOf(profile);
  const diagramAssets = diagramsAssetOf(diagrams);

  const counts = {
    // total 只数条目（经验 + 知识），恒等于 verified + observing；画像与图谱单列。
    verified: verifiedItems.length,
    observing: observingItems.length,
    total: entries.length,
    experiences: experienceItems.length,
    domainKnowledge: domainItems.length,
    contributedKnowledge: contributedItems.length,
    profile: profileAsset.available ? 1 : 0,
    diagrams: diagramAssets.filter((diagram) => diagram.available).length
  };

  // 空态只在「一条条目、一张图、一份画像都没有」时出现；
  // 只有画像或只有图谱不算空库，但两节仍各自给空说明。
  const empty = counts.total === 0 && counts.profile === 0 && counts.diagrams === 0
    ? {
        kind: 'empty-library',
        title: '这个项目的库还是空的',
        detail: '本项目的经验、所属领域的知识、由本项目升上去的知识，以及画像与图谱都还没有内容；沉淀之后会自动出现在这里。'
      }
    : null;

  return {
    project: {
      id: projectId,
      name: oneLine(project?.name, 160) || projectId || '未命名项目',
      domains
    },
    counts,
    groups,
    sections,
    assets: {
      profile: profileAsset,
      diagrams: diagramAssets,
      missingDiagrams: diagramAssets.filter((diagram) => !diagram.available).map((diagram) => diagram.kind)
    },
    empty
  };
}