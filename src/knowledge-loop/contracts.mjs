// Knowledge Loop 数据契约：Experience / Knowledge Candidate / Usage / Feedback。
//
// 这里只做纯函数校验与映射，不访问数据库、不调用模型。所有自动生成的候选
// 都保持 unverified，必须经过现有 personal_proposals 人工审核。
import { canonical, requireId, sha256 } from '../utils.mjs';

export const EXPERIENCE_CONTRACT = 'experience/v1';
export const CANDIDATE_CONTRACT = 'knowledge-candidate/v1';
export const USAGE_CONTRACT = 'knowledge-usage/v1';
export const FEEDBACK_CONTRACT = 'knowledge-feedback/v1';
// 经验（Lesson）是执行记录与知识之间的中间层：现象 → 机制 → 对策，带可追的证据引用。
// 不复用 experience/v1：那一层记录的是「一次执行发生了什么」，去重键也绑在 sourceRunId 上。
export const LESSON_CONTRACT = 'lesson/v1';
export const COLLECTOR_VERSION = '1.0.0';

const OUTCOMES = new Set(['succeeded', 'failed', 'repaired', 'cancelled', 'rejected', 'unknown']);
const BENEFITS = new Set(['positive', 'negative', 'neutral', 'unknown']);
const LAYERS = new Set(['project', 'applied', 'domain']);
const KINDS = new Set(['invariant', 'pattern', 'anti-pattern', 'experience', 'concept', 'procedure', 'hypothesis', 'note', 'claim']);
const STORE_KIND = {
  invariant: 'claim', pattern: 'claim', 'anti-pattern': 'claim', experience: 'note',
  concept: 'concept', procedure: 'procedure', hypothesis: 'hypothesis', note: 'note', claim: 'claim'
};

const text = (value, label, max = 2000, required = false) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new Error(`Invalid ${label}`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw new Error(`Invalid ${label}`);
  return value.trim();
};
const strings = (value, label, max = 40, itemMax = 500) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error(`Invalid ${label}`);
  return [...new Set(value.map((item) => text(item, label, itemMax, true)))];
};
const idList = (value, label, max = 40) => strings(value, label, max, 120)
  .map((item) => requireId(item, label));
const id = (value, label) => requireId(value, label);

export function experienceDedupeKey(record) {
  return sha256(canonical({
    sourceRunId: record.sourceRunId,
    projectId: record.projectId,
    taskId: record.taskId ?? null,
    outcome: record.observedOutcome?.status ?? 'unknown',
    evidenceRefs: [...(record.evidenceRefs ?? [])].sort()
  }));
}

export function normalizeExperience(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Experience must be an object');
  const outcome = input.observedOutcome ?? {};
  if (!OUTCOMES.has(outcome.status)) throw new Error('Invalid observed outcome');
  const record = {
    contract: EXPERIENCE_CONTRACT,
    id: input.id ?? null,
    sourceRunId: text(input.sourceRunId, 'sourceRunId', 200, true),
    projectId: id(input.projectId, 'projectId'),
    taskId: input.taskId == null ? null : text(input.taskId, 'taskId', 200, true),
    domainIds: idList(input.domainIds ?? [], 'domainIds', 20),
    observedProblem: text(input.observedProblem, 'observedProblem', 1200, true),
    actionSummary: text(input.actionSummary, 'actionSummary', 2000),
    observedOutcome: {
      status: outcome.status,
      source: text(outcome.source ?? 'owner-store', 'outcome source', 80, true),
      testStatus: outcome.testStatus ?? null,
      executionStatus: outcome.executionStatus ?? null,
      repairStatus: outcome.repairStatus ?? null
    },
    evidenceRefs: strings(input.evidenceRefs ?? [], 'evidenceRefs', 40, 500),
    environment: {
      primaryDomain: input.environment?.primaryDomain ?? null,
      profileId: input.environment?.profileId ?? null,
      imageDigestPrefix: input.environment?.imageDigestPrefix ?? null,
      runtime: input.environment?.runtime ?? 'unknown'
    },
    facts: strings(input.facts ?? [], 'facts', 40, 500),
    inferences: strings(input.inferences ?? [], 'inferences', 40, 500),
    unknowns: strings(input.unknowns ?? [], 'unknowns', 40, 500),
    createdAt: input.createdAt ?? new Date().toISOString(),
    collectorVersion: input.collectorVersion ?? COLLECTOR_VERSION
  };
  record.dedupeKey = experienceDedupeKey(record);
  return record;
}

// ---- 经验（Lesson）：执行记录 → 现象 / 机制 / 对策 + 证据引用 ----

const LESSON_VERIFICATION = new Set(['unverified', 'inferred']);

/**
 * 现象短句规范化：压平空白、去掉首尾引号与句尾标点。
 * 展示与去重共用这一次规范化，避免「同一现象两种写法」各自成条。
 */
export function normalizePhenomenon(value) {
  const flat = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return flat
    .replace(/^["'“”‘’「」『』]+/u, '')
    .replace(/["'“”‘’「」『』。．.，,；;：:、]+$/u, '')
    .trim()
    .slice(0, 160);
}

/**
 * 去重键取「规范化现象短句 + 作用域」，而不是整段文本的哈希。
 * 本票只产出项目级经验；真正合并证据与升域留给后续票，这里先把键固定下来。
 */
export function lessonDedupeKey(lesson) {
  return sha256(canonical({
    contract: LESSON_CONTRACT,
    phenomenon: normalizePhenomenon(lesson?.phenomenon).toLowerCase(),
    layer: lesson?.scope?.layer ?? 'project',
    projectId: lesson?.scope?.projectId ?? null
  }));
}

/** 提炼器的原始产出：三个必填字段 + 它认为能支撑结论的证据引用。 */
export function normalizeLessonDraft(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Lesson draft must be an object');
  const phenomenon = normalizePhenomenon(text(input.phenomenon ?? input.observedProblem, 'lesson phenomenon', 400, true));
  if (!phenomenon) throw new Error('Invalid lesson phenomenon');
  const layer = input.scope?.layer ?? input.scopeLayer ?? 'project';
  if (!LAYERS.has(layer)) throw new Error('Invalid lesson scope layer');
  return {
    phenomenon,
    mechanism: text(input.mechanism ?? input.cause, 'lesson mechanism', 1000, true),
    countermeasure: text(input.countermeasure ?? input.action, 'lesson countermeasure', 1000, true),
    layer,
    domainIds: idList(input.domainIds ?? [], 'lesson domainIds', 20),
    evidenceRefs: strings(input.evidenceRefs ?? [], 'lesson evidenceRefs', 40, 500),
    facts: strings(input.facts ?? [], 'lesson facts', 40, 500),
    inferences: strings(input.inferences ?? [], 'lesson inferences', 40, 500),
    unknowns: strings(input.unknowns ?? [], 'lesson unknowns', 40, 500)
  };
}

/**
 * 落库前的完整经验记录。规则来自 ADR-0007：
 * - 追不到证据的只能算「推断」（inferred），永远不进入待验证候选（candidate）；
 * - 系统不会自动把经验标成已验证，人的确认留在后续票里。
 */
export function normalizeLesson(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Lesson must be an object');
  const scope = input.scope ?? {};
  const layer = scope.layer ?? 'project';
  if (!LAYERS.has(layer)) throw new Error('Invalid lesson scope layer');
  const verificationStatus = input.verificationStatus ?? 'inferred';
  if (!LESSON_VERIFICATION.has(verificationStatus)) throw new Error('Invalid lesson verification status');
  const evidenceRefs = strings(input.evidenceRefs ?? [], 'lesson evidenceRefs', 40, 500);
  if (verificationStatus === 'unverified' && evidenceRefs.length === 0) {
    throw new Error('Lesson evidence is required before it can be marked unverified');
  }
  const projectId = input.projectId == null ? null : id(input.projectId, 'lesson projectId');
  const scopedProjectId = scope.projectId == null ? null : id(scope.projectId, 'lesson scope projectId');
  if (layer === 'project' && !scopedProjectId) throw new Error('Project lessons require a project scope');
  if (layer === 'domain' && scopedProjectId !== null) throw new Error('Domain lessons cannot belong to one project');
  if (projectId !== null && scopedProjectId !== null && projectId !== scopedProjectId) {
    throw new Error('Lesson scope must match its project');
  }
  const phenomenon = normalizePhenomenon(text(input.phenomenon, 'lesson phenomenon', 400, true));
  if (!phenomenon) throw new Error('Invalid lesson phenomenon');
  const lesson = {
    contract: LESSON_CONTRACT,
    id: input.id ?? null,
    projectId,
    sourceRecordId: text(input.sourceRecordId, 'lesson sourceRecordId', 200, true),
    phenomenon,
    mechanism: text(input.mechanism, 'lesson mechanism', 1000, true),
    countermeasure: text(input.countermeasure, 'lesson countermeasure', 1000, true),
    scope: { layer, projectId: scopedProjectId, domainIds: idList(scope.domainIds ?? [], 'lesson scope domainIds', 20) },
    verificationStatus,
    evidenceRefs,
    // 模型给了但追不到执行记录的引用，留档审计，不当作证据。
    untraceableRefs: strings(input.untraceableRefs ?? [], 'lesson untraceableRefs', 40, 500),
    facts: strings(input.facts ?? [], 'lesson facts', 40, 500),
    inferences: strings(input.inferences ?? [], 'lesson inferences', 40, 500),
    unknowns: strings(input.unknowns ?? [], 'lesson unknowns', 40, 500),
    sourceRecord: {
      status: input.sourceRecord?.status ?? null,
      testStatus: input.sourceRecord?.testStatus ?? null,
      occurredAt: input.sourceRecord?.occurredAt ?? null,
      taskTitle: input.sourceRecord?.taskTitle ?? null
    },
    extractor: typeof input.extractor === 'string' ? text(input.extractor, 'lesson extractor', 120) : null,
    createdAt: input.createdAt ?? new Date().toISOString()
  };
  lesson.dedupeKey = lessonDedupeKey(lesson);
  return lesson;
}

export function normalizeCandidateDraft(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Candidate draft must be an object');
  const proposedLayer = input.proposedLayer ?? 'project';
  if (!LAYERS.has(proposedLayer)) throw new Error('Invalid proposed layer');
  const rawKind = input.kind ?? 'pattern';
  if (!KINDS.has(rawKind)) throw new Error('Invalid candidate kind');
  const confidence = input.confidence === undefined ? 0.5 : Number(input.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('Invalid confidence');
  return {
    title: text(input.title, 'candidate title', 200, true),
    claim: text(
      input.claim ?? input.statement ?? input.content ?? input.summary ?? input.title,
      'candidate claim', 8000, true
    ),
    kind: rawKind,
    proposedLayer,
    applicability: Array.isArray(input.applicability)
      ? strings(input.applicability, 'applicability', 20, 300)
      : strings([], 'applicability'),
    exceptions: strings(input.exceptions ?? [], 'exceptions', 20, 300),
    confidence,
    verificationStatus: input.verificationStatus === 'needs_reverification' ? 'needs_reverification' : 'unverified',
    contradictions: strings(input.contradictions ?? [], 'contradictions', 20, 300),
    keywords: strings(input.keywords ?? [], 'keywords', 20, 80),
    evidenceRefs: strings(input.evidenceRefs ?? [], 'candidate evidenceRefs', 40, 500),
    facts: strings(input.facts ?? [], 'candidate facts', 40, 500),
    inferences: strings(input.inferences ?? [], 'candidate inferences', 40, 500),
    unknowns: strings(input.unknowns ?? [], 'candidate unknowns', 40, 500),
    validationSuggestions: strings(input.validationSuggestions ?? [], 'validation suggestions', 20, 500)
  };
}

/**
 * 把候选草稿映射到现有 PersonalKnowledgeStore proposal payload。
 * 自动候选永远不能直接是 verified；晋升仍需 Owner 审核。
 */
export function candidateToProposal({ draft, projectId, domainIds, sourceExperienceIds, harvestRunId, playbook = 'edae', steps = [] }) {
  const normalized = normalizeCandidateDraft(draft);
  const layer = normalized.proposedLayer;
  const scope = layer === 'project' ? 'project' : 'domain';
  const contradictionIds = normalized.contradictions.filter((item) => {
    try { requireId(item); return true; } catch { return false; }
  });
  const evidenceRefs = [...new Set([
    ...normalized.evidenceRefs,
    ...sourceExperienceIds.map((item) => `experience:${item}`)
  ])];
  const payload = {
    title: normalized.title,
    content: normalized.claim,
    kind: STORE_KIND[normalized.kind] ?? 'claim',
    layer,
    scope,
    projectId: layer === 'project' ? requireId(projectId, 'projectId') : null,
    domains: idList(domainIds, 'domainIds', 20),
    tags: [...new Set([normalized.kind, ...normalized.keywords])],
    evidenceRefs,
    verificationStatus: normalized.verificationStatus,
    relations: contradictionIds.length ? { contradicts: contradictionIds } : {},
    sourceRef: `knowledge-loop:${harvestRunId}`
  };
  const meta = {
    contract: CANDIDATE_CONTRACT,
    sourceExperienceIds,
    proposedLayer: layer,
    proposedKind: normalized.kind,
    confidence: normalized.confidence,
    contradictions: normalized.contradictions,
    revision: 1,
    verificationStatus: normalized.verificationStatus,
    harvestRunId,
    playbook,
    steps,
    applicability: normalized.applicability,
    exceptions: normalized.exceptions,
    facts: normalized.facts,
    inferences: normalized.inferences,
    unknowns: normalized.unknowns,
    validationSuggestions: normalized.validationSuggestions
  };
  return { payload, meta };
}

export function normalizeUsage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Usage must be an object');
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error('Invalid usage revision');
  const applicabilityResult = input.applicabilityResult ?? 'applicable';
  if (!['applicable', 'needs_verification'].includes(applicabilityResult)) throw new Error('Invalid applicability result');
  const observedBenefit = input.observedBenefit ?? 'unknown';
  if (!BENEFITS.has(observedBenefit)) throw new Error('Invalid observed benefit');
  return {
    contract: USAGE_CONTRACT,
    knowledgeId: id(input.knowledgeId, 'knowledgeId'),
    revision: input.revision,
    targetRunId: text(input.targetRunId, 'targetRunId', 200, true),
    projectId: id(input.projectId, 'projectId'),
    retrievalReason: text(input.retrievalReason, 'retrievalReason', 2000, true),
    applicabilityResult,
    contextSnapshotId: text(input.contextSnapshotId, 'contextSnapshotId', 200, true),
    outcomeEvidenceRefs: strings(input.outcomeEvidenceRefs ?? [], 'outcomeEvidenceRefs', 40, 500),
    benefitEvidenceRefs: strings(input.benefitEvidenceRefs ?? [], 'benefitEvidenceRefs', 40, 500),
    observedBenefit,
    unresolvedQuestions: strings(input.unresolvedQuestions ?? [], 'unresolvedQuestions', 20, 500)
  };
}

export function normalizeFeedback(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Feedback must be an object');
  if (!OUTCOMES.has(input.outcome)) throw new Error('Invalid feedback outcome');
  if (!BENEFITS.has(input.observedBenefit)) throw new Error('Invalid feedback benefit');
  const proposedEvolution = input.proposedEvolution ?? 'none';
  if (!['promote', 'demote', 'revise', 'none'].includes(proposedEvolution)) throw new Error('Invalid proposed evolution');
  return {
    contract: FEEDBACK_CONTRACT,
    usageId: text(input.usageId, 'usageId', 200, true),
    outcome: input.outcome,
    observedBenefit: input.observedBenefit,
    evidenceRefs: strings(input.evidenceRefs ?? [], 'feedback evidenceRefs', 40, 500),
    benefitEvidenceRefs: strings(input.benefitEvidenceRefs ?? [], 'feedback benefitEvidenceRefs', 40, 500),
    proposedEvolution,
    rationale: text(input.rationale, 'feedback rationale', 2000)
  };
}

/** 从模型文本中提取严格 JSON；允许代码围栏，但拒绝无对象输出。 */
export function parseJsonObject(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Empty model output');
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('No JSON object found');
  try {
    const parsed = JSON.parse(value.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Not an object');
    return parsed;
  } catch (error) {
    throw new Error(`Invalid knowledge JSON: ${error.message}`);
  }
}
