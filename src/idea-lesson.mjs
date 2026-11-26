// #137 灵感回执上的「提升为 Lesson」：把一条灵感的原文变成项目级经验。
//
// 经验链的第一道人工确认（Idea → Lesson）：
// - 现象只取灵感原文，机制 / 对策没有就不编，留空；
// - 来源记录 id 就是灵感 id，证据引用是 `idea:<id>` 加一段原文摘录，
//   所以事后能从经验回到当初那条灵感；
// - 作用域只认「当前项目」，没有选项目就明确拒绝，绝不退回第一个项目；
// - 只写经验表：知识候选仍要人在经验卡上再点一次（HITL 2），这里不自动入库。
//
// 同一条灵感只提升一次：先按来源记录 id 找已有经验；命中就原样返回并说明已有，
// 不再写第二条。现象相同、来源不同的经验沿用 recordLesson 的合并规则（只追加证据）。
import { flatText } from './utils.mjs';
import { LESSON_CONTRACT, lessonDedupeKey, normalizePhenomenon } from './knowledge-loop/contracts.mjs';

/** 新写一条「灵感经验」时记下的提炼器名：事后能看出它不是模型提炼的。 */
export const IDEA_LESSON_EXTRACTOR = 'idea-receipt';
/** 证据引用的来源前缀：`idea:<id>` 只指向灵感，不冒充执行记录。 */
export const IDEA_EVIDENCE_PREFIX = 'idea:';
/** 证据摘录上限，与 personal-store 的 evidence excerpt 列宽一致。 */
const EXCERPT_LIMIT = 2000;

const nowIso = () => new Date().toISOString();
const refuse = (code, reason) => ({ ok: false, code, reason });

/**
 * 灵感的原文：优先 rawText；旧条目只有标题时用标题兜底。
 * 空串表示这条灵感没有可写的现象。
 */
export function ideaLessonSource(item) {
  const raw = flatText(item?.rawText);
  return raw || flatText(item?.title);
}

/**
 * 由灵感构造一条项目级经验（纯函数，不落库）。
 *
 * @param {object} item 灵感条目（owner-store.getIdeaItem 的形状）
 * @param {object} input
 * @param {string} input.projectId 当前项目
 * @param {string} [input.at] 创建时间（测试可固定）
 * @returns {object} 满足 knowledge-loop 经验形状的对象
 */
export function ideaToLesson(item, { projectId, at = nowIso() } = {}) {
  const source = ideaLessonSource(item);
  const ideaId = String(item?.id ?? '');
  const lesson = {
    contract: LESSON_CONTRACT,
    projectId,
    sourceRecordId: ideaId,
    // 现象是灵感的短句；完整原文留在下面的证据摘录里，长文不会被截断后无处可查。
    phenomenon: normalizePhenomenon(source),
    // 没有证据就不编机制与对策：这两段留空，由人在后续审核里补。
    mechanism: '',
    countermeasure: '',
    scope: { layer: 'project', projectId, domainIds: [] },
    // 只到「推断」：系统不会自动把一条灵感标成已验证。
    verificationStatus: 'inferred',
    evidenceRefs: [`${IDEA_EVIDENCE_PREFIX}${ideaId}`],
    untraceableRefs: [],
    facts: [],
    inferences: [],
    unknowns: [],
    sourceRecord: {
      status: item?.ideaStatus ?? null,
      testStatus: null,
      occurredAt: item?.createdAt ?? null,
      taskTitle: item?.title ?? null
    },
    extractor: IDEA_LESSON_EXTRACTOR,
    createdAt: at
  };
  lesson.dedupeKey = lessonDedupeKey(lesson);
  return lesson;
}

/**
 * 把一条灵感提升为 Lesson。
 *
 * 返回值分三种：
 * - 新建：`{ok:true, created:true, lesson}`；
 * - 已有：`{ok:true, created:false, reason:'existing', lesson}`（同一条灵感不写第二条）；
 * - 拒绝：`{ok:false, code, reason}`，此时一个字都不写。
 *
 * @param {object} input
 * @param {object} input.store OwnerStore（只读灵感与项目）
 * @param {object} input.personalStore PersonalKnowledgeStore（写经验）
 * @param {string} input.id 灵感 id
 * @param {string} [input.projectId] 当前项目；缺了就拒绝
 */
export function promoteIdeaToLesson({ store, personalStore, id, projectId = '' } = {}) {
  if (!store || typeof store.getIdeaItem !== 'function') {
    throw new Error('store is required');
  }
  if (!personalStore || typeof personalStore.recordLesson !== 'function'
    || typeof personalStore.listLessons !== 'function') {
    throw new Error('personalStore is required');
  }

  const ideaId = String(id ?? '').trim();
  if (!ideaId) return refuse('missing', '没有给出灵感 id：这次什么都没写。');
  const item = store.getIdeaItem(ideaId);
  if (!item) return refuse('missing', '这条灵感不存在，可能已经删了。');

  const source = ideaLessonSource(item);
  if (!source) return refuse('empty', '这条灵感没有原文：没有可写的现象，这次什么都没写。');

  // 当前项目只认调用方显式给的；没有就拒绝，不拿灵感自己的项目偷偷兜底。
  const project = String(projectId ?? '').trim();
  if (!project) {
    return refuse('needs-project', '提升为 Lesson 要先在顶栏选一个项目：这次什么都没写。');
  }
  if (typeof store.getProject === 'function' && !store.getProject(project)) {
    return refuse('project', `找不到项目 ${project}：换一个项目再提升。`);
  }

  // 同一条灵感只提升一次：按来源记录 id 找回已有经验，不再写第二条。
  const existing = personalStore.listLessons({ sourceRecordId: ideaId, limit: 10 })[0] ?? null;
  if (existing) {
    return { ok: true, created: false, reason: 'existing', lesson: existing };
  }

  const lesson = ideaToLesson(item, { projectId: project });
  // 现象 + 作用域相同的经验已在库里时，recordLesson 只追加证据、不新建：仍按「已有」回执。
  const duplicate = typeof personalStore.lessonByDedupe === 'function'
    ? personalStore.lessonByDedupe(lesson.dedupeKey)
    : null;
  const evidence = [{
    ref: `${IDEA_EVIDENCE_PREFIX}${ideaId}`,
    recordId: ideaId,
    kind: 'idea',
    excerpt: flatText(source, EXCERPT_LIMIT)
  }];

  let stored;
  try {
    stored = personalStore.recordLesson(lesson, { evidence });
  } catch (error) {
    // 写失败不静默：把原因交回调用方，流里留一条失败回执。
    return refuse('write', `经验没写成：${error?.message ?? error}　这次什么都没写。`);
  }
  return { ok: true, created: !duplicate, reason: duplicate ? 'existing' : '', lesson: stored };
}
