// 经验（Lesson）提炼：把一条执行记录 + 它引用的证据，变成「现象 → 机制 → 对策」。
//
// 输入不是任务标题：失败日志片段、补丁 diff 摘要、测试退出码都在证据里。
// 提炼器可注入（`extractor`）：测试用假提炼器，不联网、不调真实模型。
// 失败不静默丢弃：执行记录不落表，也没有「已提炼」标记，只要没写出经验行，
// 它下次仍然在待提炼队列里；失败原因随结果一起返回。
import { requireId } from '../utils.mjs';
import { listExecutionRecords, EXECUTION_RECORD_LIMIT } from './execution-records.mjs';
import { normalizeLesson, normalizeLessonDraft } from './contracts.mjs';

export const LESSON_EXTRACTOR_VERSION = '1.0.0';
/** 证据片段截断上限：提炼只读摘要，不把整份日志或 diff 塞进模型。 */
const CLIP = { stdout: 800, stderr: 600, diff: 400, summary: 400 };
const DISTILL_LIMIT = 20;

const nowIso = () => new Date().toISOString();
const clip = (value, max) => String(value ?? '').replace(/\u0000/gu, '').slice(0, max);
const splitRef = (ref) => {
  const [prefix, id, extra] = String(ref).split(':');
  return { prefix, id, extra };
};

/** 补丁 diff 摘要：只留增删行，最多 6 行。 */
function diffSummary(diff) {
  const lines = String(diff ?? '').split(/\r?\n/u)
    .filter((line) => /^[+-]/u.test(line) && !/^(\+\+\+|---)/u.test(line))
    .map((line) => line.trim());
  return clip(lines.slice(0, 6).join(' | '), CLIP.diff);
}

const filePaths = (patch) => (patch?.files ?? [])
  .map((file) => (typeof file === 'string' ? file : file?.path ?? file?.file))
  .filter(Boolean);

export class LessonDistiller {
  constructor({
    ownerStore, personalStore, extractor = null, model = '',
    listRecords = listExecutionRecords, clock = nowIso, logger = console
  } = {}) {
    if (!ownerStore || !personalStore) throw new Error('ownerStore and personalStore are required');
    this.owner = ownerStore;
    this.personal = personalStore;
    this.extractor = extractor;
    this.model = model;
    this.listRecords = listRecords;
    this.clock = clock;
    this.logger = logger;
  }

  /**
   * 待提炼队列：项目里已终态、但还没有对应经验行的执行记录，按时间倒序。
   * 队列本身不落表——执行记录是 owner store 的投影，提炼状态由经验表反推。
   */
  queue({ projectId, limit = EXECUTION_RECORD_LIMIT } = {}) {
    const id = String(projectId ?? '').trim();
    if (!id) throw new Error('projectId is required');
    const { records, truncated } = this.listRecords({ ownerStore: this.owner, projectId: id, limit });
    const distilled = new Set(this.personal.lessonedRecordIds({ projectId: id }));
    const pending = records.filter((record) => !distilled.has(record.id));
    return { projectId: id, records: pending, total: pending.length, truncated };
  }

  /** 执行记录引用的证据：运行摘要（含测试退出码）、stdout/stderr 片段、补丁 diff 摘要、任务标题。 */
  evidenceFor(record) {
    const found = new Map();
    // 同一个 ref 可能既有记录摘要又有运行摘要（sandbox:<id> 就是记录 ID），合并成一条可读证据。
    const add = (item) => {
      if (!item?.ref) return;
      const excerpt = clip(item.excerpt, CLIP.summary * 2);
      const existing = found.get(item.ref);
      if (!existing) {
        found.set(item.ref, { ref: item.ref, kind: item.kind, excerpt });
        return;
      }
      if (excerpt && !existing.excerpt.includes(excerpt)) {
        existing.excerpt = clip(`${existing.excerpt}；${excerpt}`, CLIP.summary * 2 + 200);
      }
    };
    // 记录自身的摘要也要能被引用：这是「证据指回具体执行记录」的锚点。
    add({
      ref: record.id, kind: 'record',
      excerpt: [
        `记录=${record.id}`,
        `status=${record.status ?? 'unknown'}`,
        `test=${record.testStatus ?? 'unknown'}`,
        (record.changedFiles ?? []).length ? `改动文件=${record.changedFiles.join(',')}` : '',
        record.taskTitle ? `任务=${record.taskTitle}` : ''
      ].filter(Boolean).join('; ')
    });
    for (const ref of record.evidenceRefs ?? []) {
      try {
        const { prefix, id, extra } = splitRef(ref);
        if (prefix === 'sandbox') {
          const run = this.owner.getSandboxRun(id);
          if (!run) continue;
          add({
            ref, kind: 'sandbox-run',
            excerpt: [
              `status=${run.status}`, `execution=${run.execution_status ?? 'unknown'}`,
              `test=${run.test_status ?? 'unknown'}`, `exit=${run.exit_code ?? 'unknown'}`,
              `profile=${run.profile_id ?? 'unknown'}`
            ].join('; ')
          });
          // 运行里挂了 stdout/stderr 就把片段一并给出，哪怕记录没有单独列 evidence:* 引用。
          const stdout = this.owner.getSandboxEvidence?.(id, 'stdout');
          if (stdout?.content) add({ ref: `evidence:${id}:stdout`, kind: 'stdout', excerpt: clip(stdout.content, CLIP.stdout) });
          const stderr = this.owner.getSandboxEvidence?.(id, 'stderr');
          if (stderr?.content) add({ ref: `evidence:${id}:stderr`, kind: 'stderr', excerpt: clip(stderr.content, CLIP.stderr) });
        } else if (prefix === 'evidence') {
          const raw = this.owner.getSandboxEvidence?.(id, extra);
          if (raw?.content) {
            add({ ref, kind: extra || 'evidence', excerpt: clip(raw.content, extra === 'stderr' ? CLIP.stderr : CLIP.stdout) });
          }
        } else if (prefix === 'patch') {
          const patch = this.owner.getPatchProposal(id);
          if (!patch) continue;
          let artifact = '';
          try {
            artifact = this.owner.getPatchArtifactContent?.(id, 'proposal_diff')
              ?? this.owner.getPatchArtifactContent?.(id, 'applied_diff') ?? '';
          } catch { artifact = ''; }
          const files = filePaths(patch);
          add({
            ref, kind: 'patch',
            excerpt: [
              `status=${patch.status ?? 'unknown'}`,
              files.length ? `文件=${files.join(',')}` : '',
              artifact ? `diff 摘要：${diffSummary(artifact)}` : ''
            ].filter(Boolean).join('; ')
          });
        } else if (prefix === 'job') {
          const detail = this.owner.getJob(id);
          if (!detail) continue;
          add({
            ref, kind: 'job',
            excerpt: [
              `status=${detail.status ?? 'unknown'}`,
              `尝试=${(detail.attempts ?? []).length}`,
              detail.title ? `标题=${detail.title}` : ''
            ].filter(Boolean).join('; ')
          });
        } else if (prefix === 'task') {
          const item = this.owner.getTask(id);
          if (!item) continue;
          add({ ref, kind: 'task', excerpt: clip(`status=${item.status ?? 'unknown'}; 标题=${item.title ?? ''}`, CLIP.summary) });
        }
      } catch { /* 取不到的证据记为缺失，不发明也不中断 */ }
    }
    return [...found.values()];
  }

  /** 项目主域：执行记录里没有域信息，域 ID 取自 owner store 的项目行。 */
  domainIdsFor(projectId) {
    try {
      const project = this.owner.getProject(projectId);
      const domain = project?.primary_domain ?? project?.primaryDomain;
      return domain ? [requireId(domain, 'domain ID')] : [];
    } catch { return []; }
  }

  /**
   * 提炼一条执行记录。
   * 成功返回 {ok:true, lesson, inferred}；失败返回 {ok:false, code, reason}，并且不写库。
   */
  async distillRecord(record, { extractor = this.extractor } = {}) {
    if (!record || typeof record !== 'object') {
      return { ok: false, code: 'invalid-record', reason: '执行记录为空，无法提炼' };
    }
    if (!extractor) {
      return {
        ok: false, code: 'extractor-unavailable',
        reason: '没有可用的经验提炼器：请注入 extractor，或显式启用模型后重试'
      };
    }
    const evidence = this.evidenceFor(record);
    let raw;
    try {
      raw = await extractor({ record, evidence });
    } catch (error) {
      const reason = `经验提炼器失败：${error?.message ?? String(error)}`;
      this.logger.warn?.(reason);
      return { ok: false, code: 'extractor-failed', reason };
    }
    let draft;
    try {
      draft = normalizeLessonDraft(raw);
    } catch (error) {
      const reason = `经验草稿不完整：${error.message}`;
      this.logger.warn?.(reason);
      return { ok: false, code: 'invalid-draft', reason };
    }
    // 只有能追回本执行记录的证据才算证据；其余引用留档为推断依据，不参与候选判定。
    const traceable = new Set(evidence.map((item) => item.ref));
    const evidenceRefs = draft.evidenceRefs.filter((ref) => traceable.has(ref));
    const untraceableRefs = draft.evidenceRefs.filter((ref) => !traceable.has(ref));
    const verificationStatus = evidenceRefs.length ? 'candidate' : 'inferred';
    const cited = evidence.filter((item) => evidenceRefs.includes(item.ref));
    let stored;
    try {
      const lesson = normalizeLesson({
        projectId: record.projectId,
        sourceRecordId: record.id,
        phenomenon: draft.phenomenon,
        mechanism: draft.mechanism,
        countermeasure: draft.countermeasure,
        // 本切片只产出项目级经验；「另一个项目复现后升域」属于后续票，这里不假装已复现。
        scope: { layer: 'project', projectId: record.projectId, domainIds: this.domainIdsFor(record.projectId) },
        verificationStatus,
        evidenceRefs,
        untraceableRefs,
        facts: draft.facts,
        inferences: draft.inferences,
        unknowns: draft.unknowns,
        sourceRecord: {
          status: record.status ?? null,
          testStatus: record.testStatus ?? null,
          occurredAt: record.occurredAt ?? null,
          taskTitle: record.taskTitle ?? null
        },
        extractor: this.model || 'injected',
        createdAt: this.clock()
      });
      stored = this.personal.addLesson(lesson, {
        evidence: cited.map((item) => ({ ref: item.ref, recordId: record.id, kind: item.kind, excerpt: item.excerpt }))
      });
    } catch (error) {
      // 落库失败同样不改队列：没有写出经验行，这条记录下次还会被提炼。
      const reason = `经验落库失败：${error?.message ?? String(error)}`;
      this.logger.warn?.(reason);
      return { ok: false, code: 'invalid-lesson', reason };
    }
    return { ok: true, lesson: stored, inferred: verificationStatus === 'inferred' };
  }

  /**
   * 按项目跑一次提炼：只处理待提炼队列里的记录，逐条隔离失败。
   * 返回值里的 pending 是本次结束后仍未提炼的记录 ID，失败时与调用前一致。
   */
  async distill({ projectId, recordIds = null, limit = DISTILL_LIMIT, extractor = this.extractor } = {}) {
    const id = String(projectId ?? '').trim();
    if (!id) throw new Error('projectId is required');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('limit must be an integer between 1 and 100');
    }
    const queue = this.queue({ projectId: id });
    const wanted = Array.isArray(recordIds) && recordIds.length ? new Set(recordIds) : null;
    const targets = (wanted ? queue.records.filter((record) => wanted.has(record.id)) : queue.records).slice(0, limit);
    const lessons = [];
    const failed = [];
    let inferred = 0;
    for (const record of targets) {
      const outcome = await this.distillRecord(record, { extractor });
      if (!outcome.ok) {
        failed.push({ recordId: record.id, code: outcome.code, reason: outcome.reason });
        continue;
      }
      lessons.push(outcome.lesson);
      if (outcome.inferred) inferred += 1;
    }
    return {
      at: this.clock(),
      projectId: id,
      attempted: targets.length,
      lessons,
      inferred,
      failed,
      pending: this.queue({ projectId: id }).records.map((record) => record.id)
    };
  }
}
