// 定时整理的「理解」层（#119）：把变更队列交给注入的提炼器，产出候选，提交到既有候选入口。
//
// 三条边界写在这里，上面几层不用再想：
// 1. 不读内容：本文件只拿队列里的条目（kind / ref / 时间 / detail），真要读内容由注入的提炼器去做。
//    没注入提炼器时走兜底——只把「这段时间看到了什么」列成一条记录，不解释、不总结。
// 2. 只产候选：草稿先过 knowledge-loop 的 candidateToProposal，再走 PersonalKnowledgeStore.submitProposal，
//    落在 personal_proposals 的 pending 上等人工确认。绝不 create / update 正式知识（父 spec #102 第 14 条）。
// 3. 失败不动队列：候选全部提交完，最后才清空队列。中途失败队列原样留着，下次补跑；
//    已经提交成功的那几条靠 meta.draftKey 认出来，重试不会再建一遍（不新增表、不新增依赖）。
//
// 队列清空（推进「已整理到哪」）放在这里而不是存储层：先提交后清空是一个动作，
// 分到两处迟早会有人只做前一半（ADR-0008 的「先算后推」同一类错误）。
import { canonical, flatText, sha256 } from '../utils.mjs';
import { localDayKey } from '../observer/time.mjs';
import { CANDIDATE_CONTRACT, candidateToProposal } from '../knowledge-loop/contracts.mjs';
import { normalizeWatchTarget } from './target.mjs';

/** 候选 meta 上的 playbook 标记：审核页据此看出「这批候选是定时整理出来的」。 */
export const TIDY_PLAYBOOK = 'watch-tidy';

/** 三类变更的中文说法：兜底文案与运行附注共用一份。 */
const KIND_WORDS = Object.freeze({ added: '新增', modified: '修改', deleted: '删除' });

/** 兜底清单最多列这么多条：再多也只是「一屏清单」，不是结论。 */
const MAX_FALLBACK_ITEMS = 20;
/** 队列条目的 ref 上限沿用 store.mjs；证据引用一条最多 500 字符。 */
const MAX_EVIDENCE = 40;
const CLAIM_LIMIT = 7800;
const TITLE_LIMIT = 160;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const textOf = (value) => (typeof value === 'string' ? value.trim() : '');
const clip = (value, max) => {
  const text = flatText(value).replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/gu, '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** 对象的显示名：不反解 ref，按类型取各自的字段（与心跳卡片同一套叫法）。 */
const labelOf = (target) => {
  if (!isObject(target)) return '';
  if (target.type === 'project') return textOf(target.projectId) || textOf(target.ref);
  if (target.type === 'session') {
    return [textOf(target.source), textOf(target.sessionId)].filter(Boolean).join(':') || textOf(target.ref);
  }
  if (target.type === 'github') {
    return textOf(target.nameWithOwner)
      || [textOf(target.owner), textOf(target.repo)].filter(Boolean).join('/')
      || textOf(target.ref);
  }
  return textOf(target.ref);
};

/**
 * 一次整理的幂等键：目标 + 队列头部的 seq。
 *
 * 为什么取头部而不是「首批-末批」：整理失败时队列一条都没删，头部 seq 稳定，
 * 于是重试算出来的键与失败那次一样，已经提交过的候选能被认出来；清空之后新入库的
 * seq 只会更大（AUTOINCREMENT），下一批自然是另一个键。
 */
export function tidyRunId(target, changes = []) {
  const normalized = normalizeWatchTarget(target);
  const list = Array.isArray(changes) ? changes : [];
  const head = Number.isSafeInteger(list[0]?.seq) ? list[0].seq : 0;
  return `watch:${normalized.ref}:since-${head}`;
}

/** 一条草稿的键：同一批里标题与正文相同就是同一条候选，重试时据此跳过。 */
const draftKeyOf = (runId, payload) => sha256(canonical({
  runId,
  title: payload?.title ?? '',
  claim: payload?.content ?? ''
}));

/**
 * 兜底提炼器：没有注入提炼器时用。
 * 只写「这段时间看到了什么」——三类计数加一份清单，不猜结论、不给因果。
 * 给成这样是因为宁可产出一条低价值的记录让人划掉，也不要在没有模型时静默丢掉一批变化。
 */
export function fallbackDistill({ target = null, changes = [], at = new Date() } = {}) {
  const list = Array.isArray(changes) ? changes.filter(isObject) : [];
  if (list.length === 0) return [];
  const counts = { added: 0, modified: 0, deleted: 0 };
  for (const change of list) {
    if (Object.prototype.hasOwnProperty.call(counts, change.kind)) counts[change.kind] += 1;
  }
  const lines = [
    `共 ${list.length} 条变更（新增 ${counts.added} / 修改 ${counts.modified} / 删除 ${counts.deleted}）。`
  ];
  for (const change of list.slice(0, MAX_FALLBACK_ITEMS)) {
    const word = KIND_WORDS[change.kind] ?? String(change.kind ?? '');
    const when = textOf(change.at);
    lines.push(`- ${word} ${textOf(change.ref)}${when ? `（${when}）` : ''}`);
  }
  if (list.length > MAX_FALLBACK_ITEMS) lines.push(`（还有 ${list.length - MAX_FALLBACK_ITEMS} 条没列出）`);
  const isProject = target?.type === 'project' && textOf(target.projectId);
  return [{
    title: clip(`${labelOf(target) || '监控对象'} 的变更记录（${localDayKey(at)}）`, TITLE_LIMIT),
    claim: clip(lines.join('\n'), CLAIM_LIMIT),
    // 记录类：这批条目本身是事实，结论要人看过再定，所以不给它 claim 的身份。
    kind: 'note',
    proposedLayer: isProject ? 'project' : 'applied',
    confidence: 0.2,
    evidenceRefs: list.slice(0, MAX_EVIDENCE).map((change) => `watch:${textOf(change.key) || textOf(target?.ref)}:${change.seq}`),
    keywords: ['监控'],
    unknowns: [],
    validationSuggestions: ['这批只是「看到了什么」；要不要沉淀成结论，由审核时决定。']
  }];
}

/** 队列条目 → 证据引用：让候选能回到它来自哪几条变化。 */
const queueEvidence = (changes) => changes
  .filter((change) => Number.isSafeInteger(change?.seq) && textOf(change?.key))
  .slice(0, MAX_EVIDENCE)
  .map((change) => `watch:${textOf(change.key)}:${change.seq}`);

/** 提炼器返回空值时按「这批整理不出候选」处理：不是失败，队列照常推进。 */
const draftsOf = (distill, { target, changes, at }) => {
  const output = (typeof distill === 'function' ? distill : fallbackDistill)({ target, changes, at });
  if (output === undefined || output === null) return [];
  if (!Array.isArray(output)) throw new Error('提炼器必须返回草稿数组（或 null 表示这批没有候选）');
  return output;
};

/**
 * 把当前队列整理成候选并提交到候选入口。
 *
 * @param {object} input
 * @param {object} input.store WatchStateStore（需要 listChanges / clearChanges）
 * @param {object} input.target 监控对象描述符（project / session / github）
 * @param {object} input.personalStore PersonalKnowledgeStore（需要 submitProposal / proposals）
 * @param {(input:{target:object, changes:object[], at:Date}) => object[]|null} [input.distill]
 *   注入的提炼器；不给时用 fallbackDistill
 * @param {string|number|Date} [input.at] 这次整理的时刻（写进候选 meta）
 * @param {string} [input.actor] 提交者标识
 * @param {number} [input.limit] 这一批最多读多少条队列
 * @param {string} [input.plannedAt] 这次对应的计划时刻（写进候选 meta）
 * @param {boolean} [input.late] 这次是不是迟到补跑（写进候选 meta）
 * @returns {{ok:true, empty:boolean, changes:number, drafts:number, submitted:object[],
 *   skipped:number, rejected:object[], runId:string}
 *   | {ok:false, code:string, reason:string, changes:number, submitted:object[], queueKept:true}}
 */
export function tidyQueue({
  store, target, personalStore = null, distill = null, at = new Date(), actor = 'watch', limit = 200,
  plannedAt = '', late = false
} = {}) {
  if (!store || typeof store.listChanges !== 'function' || typeof store.clearChanges !== 'function') {
    throw new Error('缺少监控状态存储（需要 WatchStateStore）');
  }
  const normalized = normalizeWatchTarget(target);
  const changes = store.listChanges(normalized, { limit });
  const runId = tidyRunId(normalized, changes);
  if (changes.length === 0) {
    return { ok: true, empty: true, changes: 0, drafts: 0, submitted: [], skipped: 0, rejected: [], runId };
  }
  if (!personalStore || typeof personalStore.submitProposal !== 'function') {
    return {
      ok: false,
      code: 'candidate',
      reason: '候选入口不可用（知识库未初始化），队列没动，可以再试。',
      changes: changes.length,
      submitted: [],
      queueKept: true
    };
  }

  // ① 先提炼。提炼器抛错就当这次没成：队列一条不动。
  let drafts;
  try {
    drafts = draftsOf(distill, { target: normalized, changes, at });
  } catch (error) {
    return {
      ok: false,
      code: 'distill',
      reason: `${error?.message ?? error}（队列没动，可以再试）`,
      changes: changes.length,
      submitted: [],
      queueKept: true
    };
  }

  // ② 上次失败时已经提交过的候选：同一批、同一键的直接跳过，不建第二份。
  const submittedKeys = new Set(
    (typeof personalStore.proposals === 'function' ? personalStore.proposals('pending') : [])
      .filter((proposal) => proposal?.meta?.harvestRunId === runId)
      .map((proposal) => textOf(proposal?.meta?.draftKey))
      .filter(Boolean)
  );

  const projectId = normalized.type === 'project' ? normalized.projectId : '';
  const watchEvidence = queueEvidence(changes);
  const submitted = [];
  const rejected = [];
  let skipped = 0;

  // ③ 逐条提交。提交失败直接返回：已提交的那几条留着，队列不清，下次补跑靠键去重。
  for (const [index, draft] of drafts.entries()) {
    if (!isObject(draft)) {
      rejected.push({ index, reason: '草稿不是对象' });
      continue;
    }
    let mapped;
    try {
      mapped = candidateToProposal({
        draft: {
          // 没有项目归属的对象（会话 / GitHub）只能落 applied：候选不能凭想象挂到某个项目上。
          ...draft,
          proposedLayer: projectId ? (draft.proposedLayer ?? 'project') : 'applied',
          // 提炼器没给证据时补上队列条目：候选要能回到它来自哪几条变化。
          evidenceRefs: Array.isArray(draft.evidenceRefs) && draft.evidenceRefs.length > 0
            ? draft.evidenceRefs
            : watchEvidence
        },
        projectId: projectId || null,
        domainIds: [],
        sourceExperienceIds: [],
        harvestRunId: runId,
        playbook: TIDY_PLAYBOOK,
        steps: []
      });
    } catch (error) {
      // 单条草稿形状坏了不该拖垮整批：记下来，其余照常。
      rejected.push({ index, reason: `${error?.message ?? error}` });
      continue;
    }
    const draftKey = draftKeyOf(runId, mapped.payload);
    if (submittedKeys.has(draftKey)) {
      skipped += 1;
      continue;
    }
    let proposal;
    try {
      proposal = personalStore.submitProposal({
        targetId: null,
        payload: mapped.payload,
        actor,
        note: `定时整理：队列头部 #${changes[0].seq}（${changes.length} 条变更）`,
        meta: {
          ...mapped.meta,
          contract: CANDIDATE_CONTRACT,
          watch: {
            ref: normalized.ref,
            type: normalized.type,
            plannedAt: textOf(plannedAt),
            at: new Date(at).toISOString(),
            late: Boolean(late)
          },
          draftKey
        }
      });
    } catch (error) {
      return {
        ok: false,
        code: 'candidate',
        reason: `${error?.message ?? error}（队列没动，可以再试）`,
        changes: changes.length,
        submitted,
        queueKept: true
      };
    }
    submitted.push(proposal);
    submittedKeys.add(draftKey);
  }

  // ④ 候选都落地了才清队列：从这一刻起这批变化算「整理过了」。
  store.clearChanges(normalized);
  return {
    ok: true,
    empty: submitted.length === 0,
    changes: changes.length,
    drafts: drafts.length,
    submitted,
    skipped,
    rejected,
    runId
  };
}
