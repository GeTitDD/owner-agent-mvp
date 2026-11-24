// 经验检索（对话用）：先按当前项目取项目级经验，再补域级经验。
//
// 只读本地 SQLite，不写库、不联网、不调模型。本地几百条的量级，结构化过滤
// 加关键词匹配就够（ADR-0007），不引入向量库。
// 返回顺序：已验证优先，其次待验证，推断在后，争议（disputed）永远垫底；
// 同状态时项目级先于域级，再按证据条数与时间倒序。每条都带证据条数，让模型能表达「这条有多可靠」。
//
// #57 冲突与争议：同一现象同时有域级与项目级时，默认结果只给域级，
// 被覆盖的项目级放进 overridden（不删不藏，仍可用 listLessonsForProject 单查）；
// 争议条目带「争议」标注且不参与已验证优先排序；
// 已被取代（superseded）的不进 items，单独列在 superseded，避免把落选对策当建议。
//
// 没有匹配时不返回一个空列表假装「没有经验」：reason.code 区分
// no-project（没指定项目）/ project-not-distilled（项目还没提炼过）/
// no-matching-lesson（有经验但没有这一类）。
import { flatText } from '../utils.mjs';
import { LESSON_STATUS_LABELS, lessonStatusOf } from '../lesson-status.mjs';

/** 一次对话默认取这么多条；多取会把项目上下文挤出提示词。 */
export const DEFAULT_LESSON_RETRIEVAL_LIMIT = 10;
/** listLessons 的条数上限：域的补充要覆盖全量，所以按它的天花板扫。 */
const MAX_LESSON_SCAN = 1000;

/** 状态优先级：已验证排最前，争议与已被取代按约定排在最后。 */
const STATUS_RANK = { verified: 0, unverified: 1, inferred: 2, disputed: 3, superseded: 4 };
/** 状态标注跟着结果一起返回：待验证不能被当成定论。文案与存储层共用一份。 */
const STATUS_LABEL = LESSON_STATUS_LABELS;

const LAYER_LABEL = { project: '项目', domain: '域' };

/** 压平空白：关键词匹配与展示用同一份文本，避免多空格把一条经验切成两块。 */
const flat = (value) => flatText(value);

/** 关键词按空白切成多个词，全部命中才算匹配（大小写不敏感）。 */
const tokensOf = (query) => flat(query).toLowerCase().split(' ').filter(Boolean);

/** 现象 / 机制 / 对策都参与匹配：模型问「上次这个怎么修的」时，对策里的词也该命中。 */
const haystackOf = (lesson) =>
  flat([lesson.phenomenon, lesson.mechanism, lesson.countermeasure].join(' ')).toLowerCase();

const layerOf = (lesson) => (lesson?.scope?.layer === 'domain' ? 'domain' : 'project');

const domainsOf = (lesson) => (Array.isArray(lesson?.scope?.domainIds) ? lesson.scope.domainIds : []);

/** 没传域时从 owner store 的项目行推主域；推不出来就只查项目级，不猜。 */
const domainOf = ({ ownerStore, projectId }) => {
  if (!ownerStore || !projectId) return '';
  try {
    const project = ownerStore.getProject(projectId);
    return flat(project?.primary_domain ?? project?.primaryDomain ?? '');
  } catch { return ''; }
};

/** 证据条数来自证据表：按执行记录去重计数，与 #55 的合并结果一致。 */
const supportOf = (personalStore, lesson) => {
  const support = personalStore.lessonSupport(lesson.id) ?? {};
  return {
    supportCount: Number(support.records) || 0,
    evidenceCount: Number(support.evidence) || 0
  };
};

const toItem = (personalStore, lesson, layer) => {
  const status = lessonStatusOf(lesson);
  return {
    id: lesson.id,
    layer,
    layerLabel: LAYER_LABEL[layer],
    verificationStatus: status,
    statusLabel: STATUS_LABEL[status] ?? status,
    phenomenon: lesson.phenomenon ?? '',
    mechanism: lesson.mechanism ?? '',
    countermeasure: lesson.countermeasure ?? '',
    // 项目级经验记项目本身；域级经验记它最初来自哪个项目（升域属于 #56，这里只读）。
    projectId: lesson.projectId ?? lesson.scope?.projectId ?? null,
    domainIds: [...domainsOf(lesson)],
    sourceRecordId: lesson.sourceRecordId ?? null,
    evidenceRefs: Array.isArray(lesson.evidenceRefs) ? [...lesson.evidenceRefs] : [],
    createdAt: lesson.createdAt ?? null,
    ...supportOf(personalStore, lesson)
  };
};

/**
 * 排序：状态优先（已验证 → 待验证 → 推断 → 争议），同状态项目级先于域级，
 * 再按证据多的在前，最后按时间倒序 + id 兜底，保证同一份数据每次顺序一致。
 */
const compareItems = (a, b) =>
  (STATUS_RANK[a.verificationStatus] ?? 9) - (STATUS_RANK[b.verificationStatus] ?? 9)
  || (a.layer === 'project' ? 0 : 1) - (b.layer === 'project' ? 0 : 1)
  || b.supportCount - a.supportCount
  || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
  || String(a.id).localeCompare(String(b.id));

const checkLimit = (limit) => {
  const value = limit ?? DEFAULT_LESSON_RETRIEVAL_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error('limit must be an integer between 1 and 100');
  }
  return value;
};

/** 无匹配时给出人话原因：三种情况互斥，调用方据此决定怎么回话。 */
const reasonFor = ({ projectId, domain, query, projectTotal, domainTotal }) => {
  if (!projectId) {
    return {
      code: 'no-project',
      message: '没有当前项目，取不到项目级经验；先选一个项目再问，或只按域检索。'
    };
  }
  if (projectTotal === 0 && domainTotal === 0) {
    return {
      code: 'project-not-distilled',
      message: domain
        ? `项目 ${projectId} 还没提炼过经验，域 ${domain} 里也没有可补的经验。`
        : `项目 ${projectId} 还没提炼过经验；执行记录要多到值得提炼才会产出经验。`
    };
  }
  return {
    code: 'no-matching-lesson',
    message: `没有这类经验：项目里 ${projectTotal} 条、域里 ${domainTotal} 条，没有一条命中「${flat(query)}」。`
  };
};

/**
 * 检索经验。
 *
 * @param {object} input
 * @param {object} input.personalStore PersonalKnowledgeStore（只读调用 listLessons / lessonSupport）
 * @param {object} [input.ownerStore] owner store；只在没传 domain 时用它读项目主域
 * @param {string} [input.projectId] 当前项目；空串表示「没有绑定项目」
 * @param {string} [input.domain] 域 ID；空串时从 ownerStore 的项目主域推
 * @param {string} [input.query] 关键词；空串表示不过滤
 * @param {number} [input.limit] 最多返回多少条；计数按过滤前的全量
 * @returns {{projectId: string, domain: string, query: string, limit: number,
 *   items: object[], overridden: object[], superseded: object[],
 *   counts: {project: number, domain: number, matched: number, overridden: number},
 *   reason: null | {code: string, message: string}}}
 */
export function retrieveLessons({
  personalStore, ownerStore = null, projectId = '', domain = '', query = '',
  limit = DEFAULT_LESSON_RETRIEVAL_LIMIT
} = {}) {
  if (!personalStore || typeof personalStore.listLessons !== 'function') {
    throw new Error('personalStore is required');
  }
  const id = flat(projectId);
  const wantedDomain = flat(domain) || domainOf({ ownerStore, projectId: id });
  const wantedQuery = flat(query).slice(0, 500);
  const max = checkLimit(limit);

  // 第一遍：项目级经验。第二遍：域级经验按 scope.domainIds 补，不看项目归属。
  // #57 起优先走 store 的 listEffectiveLessons：域级覆盖同现象的项目级，
  // 被覆盖的项目级放进 overridden（不删不藏），已被取代的单独列在 superseded。
  // 桩 store 没有这个方法时退回原先的两次 listLessons，不影响已有调用方。
  const view = typeof personalStore.listEffectiveLessons === 'function'
    ? personalStore.listEffectiveLessons({
      projectId: id,
      domainIds: wantedDomain ? [wantedDomain] : [],
      limit: MAX_LESSON_SCAN
    })
    : null;
  const projectLessons = view
    ? view.project
    : id
      ? personalStore.listLessons({ projectId: id, limit: MAX_LESSON_SCAN })
        .filter((lesson) => layerOf(lesson) === 'project')
      : [];
  const known = new Set(projectLessons.map((lesson) => lesson.id));
  const domainLessons = view
    ? view.domain
    : wantedDomain
      ? personalStore.listLessons({ limit: MAX_LESSON_SCAN })
        .filter((lesson) => layerOf(lesson) === 'domain'
          && domainsOf(lesson).includes(wantedDomain)
          && !known.has(lesson.id))
      : [];
  const overridden = view ? view.overridden : [];
  const superseded = view ? view.superseded : [];

  const tokens = tokensOf(wantedQuery);
  const hit = (lesson) => tokens.every((token) => haystackOf(lesson).includes(token));
  // 默认结果不给被域级覆盖的项目级，也不给已被取代的那条；它们分别在 overridden / superseded 里。
  const shadowed = new Set(overridden.map((lesson) => lesson.id));
  const replaced = new Set(superseded.map((lesson) => lesson.id));
  const usable = (lesson) => !shadowed.has(lesson.id) && !replaced.has(lesson.id);
  const matched = [
    ...projectLessons.filter(usable).filter(hit).map((lesson) => toItem(personalStore, lesson, 'project')),
    ...domainLessons.filter(usable).filter(hit).map((lesson) => toItem(personalStore, lesson, 'domain'))
  ].sort(compareItems);
  const items = matched.slice(0, max);
  // 被域级覆盖的项目级经验同样按关键词带回来：查询以域级为准，但旧的不能凭空消失。
  const overriddenItems = overridden.filter(hit);

  return {
    projectId: id,
    domain: wantedDomain,
    query: wantedQuery,
    limit: max,
    items,
    overridden: overriddenItems,
    superseded: superseded.filter(hit),
    counts: {
      project: projectLessons.length,
      domain: domainLessons.length,
      matched: items.length,
      overridden: overriddenItems.length
    },
    // 有结果就不解释；没有结果时把原因讲清楚，而不是给一个空列表。
    reason: items.length
      ? null
      : reasonFor({
        projectId: id, domain: wantedDomain, query: wantedQuery,
        projectTotal: projectLessons.length - overriddenItems.length, domainTotal: domainLessons.length
      })
  };
}
