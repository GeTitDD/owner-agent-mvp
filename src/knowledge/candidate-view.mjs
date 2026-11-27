// 待审候选的统一只读视图：定位计数、经验列表与提升回执使用相同的归属和正文口径。
import { lessonContent } from './lesson-content.mjs';
import { proposalReviewHash } from './experience-review.mjs';
import { CANDIDATE_CONTRACT } from '../knowledge-loop/contracts.mjs';

const list = (value) => Array.isArray(value) ? value : [];
const text = (value) => String(value ?? '').trim();
const unique = (values) => [...new Set(values.map(text).filter(Boolean))];

/** 项目明确归属优先；共享候选沿来源经验归属，绝不凭域名猜项目。 */
export function candidateProjectIds(proposal, lessonById) {
  const own = text(proposal?.payload?.projectId);
  if (own) return [own];
  return unique(list(proposal?.meta?.sourceLessonIds).map((id) => {
    const lesson = lessonById(text(id));
    return lesson?.scope?.projectId ?? lesson?.projectId;
  }));
}

/** 保留待写入的完整正文；证据只有引用时明说没有摘录，不把模型推断冒充证据。 */
export function candidateReviewView({ proposal, personalStore, ownerStore, projects = [] } = {}) {
  if (!proposal || proposal.meta?.contract !== CANDIDATE_CONTRACT) return null;
  const payload = proposal.payload ?? {};
  const meta = proposal.meta ?? {};
  const lessons = list(meta.sourceLessonIds).map((id) => ({ id, lesson: personalStore?.getLesson?.(id) ?? null }));
  const projectName = (id) => text(projects.find((project) => project.id === id)?.name) || text(id);
  const projectId = text(payload.projectId);
  const domains = unique(list(payload.domains));
  const scopeLabel = projectId ? `仅项目：${projectName(projectId)}`
    : `${payload.layer === 'applied' ? '应用层' : '域级共享'}：${domains.join('、') || '未指定域（请核对范围）'}`;
  const evidence = lessons.flatMap(({ lesson }) => list(lesson?.evidence));
  const refs = unique([...list(payload.evidenceRefs), ...evidence.map((row) => row.ref)]);
  const evidenceText = refs.map((ref) => {
    const excerpts = unique(evidence.filter((row) => row.ref === ref).map((row) => row.excerpt));
    return `${ref}\n${excerpts.join('\n') || '仅有引用，未保存摘录；接受前请核对原始记录。'}`;
  }).join('\n\n') || '未提供可追证据；请核对后再决定是否接受。';
  const sources = lessons.map(({ id, lesson }) => lesson
    ? `经验：${text(lesson.phenomenon)}（${id}）` : `来源经验不可用：${id}`);
  if (meta.sourceExperienceIds?.length) sources.push(`执行记录：${meta.sourceExperienceIds.join('、')}`);
  if (!sources.length && payload.sourceRef) sources.push(`来源：${payload.sourceRef}`);
  const original=text(payload.content ?? payload.claim);
  const idea=lessons.map(({lesson})=>lesson).find(lesson=>lesson?.extractor==='idea-receipt'&&original===lesson.phenomenon);
  const recovered=idea?lessonContent(idea,{ownerStore}):original;
  return {
    id: text(proposal.id), title: text(payload.title) || '待审核候选',
    content: text(payload.content ?? payload.claim), scopeLabel,
    applicability: list(meta.applicability), exceptions: list(meta.exceptions),
    facts: list(meta.facts), inferences: list(meta.inferences), unknowns: list(meta.unknowns),
    validationSuggestions: list(meta.validationSuggestions), evidenceText,
    sourceLabel: sources.join('\n') || '未记录来源',
    verificationLabel: ({ verified: '已验证', unverified: '待验证', needs_reverification: '需重新验证', disputed: '有争议' })[payload.verificationStatus] || '待验证',
    status: text(proposal.status), createdAt: text(proposal.created_at),
    projectId: projectId || text(meta.sourceProjectId),
    projectName: projectName(projectId || text(meta.sourceProjectId)),
    expectedHash: proposalReviewHash(proposal),
    editValues: {title:text(payload.title),content:recovered,scope:payload.scope==='domain'?'domain':'project',
      domains:domains.join(', ') || text(projects.find(project=>project.id===projectId)?.primary_domain || projects.find(project=>project.id===projectId)?.primaryDomain),
      applicability:list(meta.applicability).join('；'),exceptions:list(meta.exceptions).join('；')},
    lessonIds: lessons.map(({ id }) => id)
  };
}

/** 先归属和关键词过滤，再分页；沿候选引用读经验，不受经验列表的 1000 条上限影响。 */
export function pendingCandidateView({ personalStore, ownerStore, projects = [], projectId = '', keyword = '', limit = 20 } = {}) {
  const cache = new Map();
  const lessonById = (id) => {
    if (!cache.has(id)) cache.set(id, personalStore?.getLesson?.(id) ?? null);
    return cache.get(id);
  };
  const source = { getLesson: lessonById };
  const wanted = text(keyword).toLowerCase();
  const items = list(personalStore?.proposals?.('pending')).filter((row) => row.status === 'pending'
    && row.meta?.contract === CANDIDATE_CONTRACT
    && (!projectId || candidateProjectIds(row, lessonById).includes(projectId)))
    .map((proposal) => candidateReviewView({ proposal, personalStore: source, ownerStore, projects }))
    .filter((item) => !wanted || [item.title, item.content].some((value) => value.toLowerCase().includes(wanted)));
  const cap = Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : 20;
  return { projectId, total: items.length, items: items.slice(0, cap), hasMore: items.length > cap };
}
