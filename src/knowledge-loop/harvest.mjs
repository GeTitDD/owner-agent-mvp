// Knowledge Harvest（已退役）。
//
// ADR-0007 的提炼方向是「执行记录 → 经验（lesson/v1）」按需触发；这里从 experience/v1
// 拼证据再产出候选的旧链路在 #62 停写：旧表 knowledge_experiences 已退役，它的唯一输入
// 因此消失，运行时的自动 Harvest 也已摘除。新链路见 src/knowledge-loop/lesson.mjs。
//
// 文件保留（不删除）供对照与最终代码审查决定去留；harvest() 会直接报「已退役」，
// 不再读旧经验表、不调模型、不写候选。
import { randomUUID } from 'node:crypto';
import { canonical, sha256 } from '../utils.mjs';
import {
  candidateToProposal, normalizeCandidateDraft, parseJsonObject,
  CANDIDATE_CONTRACT
} from './contracts.mjs';
import { createHarvestSessionFactory, HARVEST_DISCIPLINE, resolvePstackSkillsDir } from './pi-harvest-session.mjs';

export const HARVEST_VERSION = '1.3.0';
export const HARVEST_STEPS = [
  '确定任务边界与可用证据',
  '判断是否存在值得长期保留的经验',
  '提取主张、适用条件与例外',
  '搜索已有知识并识别重复/冲突',
  '生成结构化 Knowledge Candidate',
  '标记未知与后续验证建议'
];

const clip = (value, max = 3000) => String(value ?? '').slice(0, max);

function classifyEvidenceRef(ref) {
  if (/^sandbox:/u.test(ref)) return 'sandbox';
  if (/^job:/u.test(ref)) return 'job';
  if (/^patch:/u.test(ref)) return 'patch';
  if (/^repair:/u.test(ref)) return 'repair';
  if (/^evidence:/u.test(ref)) return 'test-evidence';
  if (/^task:/u.test(ref)) return 'task';
  if (/^experience:/u.test(ref)) return 'experience';
  return 'other';
}

export class KnowledgeHarvester {
  constructor({
    ownerStore, personalStore, sessionFactory = null,
    model = '', pstackDir = process.env.PSTACK_DIR,
    timeoutMs = 300000, allowModel = false, clock = () => new Date().toISOString(), logger = console
  } = {}) {
    if (!ownerStore || !personalStore) throw new Error('ownerStore and personalStore are required');
    this.owner = ownerStore;
    this.personal = personalStore;
    this.sessionFactory = sessionFactory ?? createHarvestSessionFactory({ pstackDir });
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.allowModel = allowModel;
    this.clock = clock;
    this.logger = logger;
  }

  evidenceFor(experiences) {
    const refs = new Set(experiences.flatMap((item) => item.evidenceRefs ?? []));
    const evidence = [];
    for (const ref of refs) {
      const kind = classifyEvidenceRef(ref);
      const [, id, extra] = ref.split(':');
      try {
        if (kind === 'sandbox') {
          const run = this.owner.getSandboxRun(id);
          if (!run) continue;
          const stdout = this.owner.getSandboxEvidence(id, 'stdout');
          const stderr = this.owner.getSandboxEvidence(id, 'stderr');
          evidence.push({
            ref, kind,
            summary: [
              `status=${run.status}; execution=${run.execution_status}; test=${run.test_status}`,
              `profile=${run.profile_id}; image=${clip(run.image_digest, 24)}`,
              stdout?.content ? `stdout:\n${clip(stdout.content, 2500)}` : '',
              stderr?.content ? `stderr:\n${clip(stderr.content, 1500)}` : ''
            ].filter(Boolean).join('\n')
          });
        } else if (kind === 'job') {
          const job = this.owner.getJob(id);
          if (!job) continue;
          evidence.push({
            ref, kind,
            summary: `status=${job.status}; attempts=${job.attempts.length}; title=${job.title}; ` +
              job.attempts.map((a) => `attempt ${a.attempt}:${a.status}:${clip(a.result_note, 200)}`).join(' | ')
          });
        } else if (kind === 'patch') {
          const patch = this.owner.getPatchProposal(id);
          if (!patch) continue;
          const diff = this.owner.getPatchArtifactContent?.(id, 'proposal_diff')
            ?? this.owner.getPatchArtifactContent?.(id, 'applied_diff')
            ?? '';
          evidence.push({
            ref, kind,
            summary: `status=${patch.status}; paths=${(patch.files ?? []).map((f) => f.path).join(',')}; hash=${clip(patch.proposal_hash, 16)}` +
              (diff ? `\ndiff:\n${clip(diff, 3000)}` : '')
          });
        } else if (kind === 'repair') {
          const cycle = this.owner.getRepairCycle(id);
          if (!cycle) continue;
          evidence.push({
            ref, kind,
            summary: `status=${cycle.status}; scope=${(cycle.repairScope ?? []).join(',')}; error=${cycle.error_code || 'none'}`
          });
        } else if (kind === 'test-evidence') {
          const raw = this.owner.getSandboxEvidence(id, extra);
          if (raw) evidence.push({ ref, kind, summary: `${extra}: ${clip(raw.content, 2000)}` });
        }
      } catch { /* missing evidence is recorded as unknown, not invented */ }
    }
    return evidence;
  }

  existingKnowledge({ domainId, experiences, limit = 20 }) {
    const query = experiences.map((item) => item.observedProblem).join(' ').slice(0, 500);
    const units = this.personal.list({ q: query, domain: domainId, limit: Math.max(limit * 3, 60) });
    return units.slice(0, limit).map((item) => ({
      id: item.id, revision: item.revision, title: item.title, content: item.content,
      layer: item.layer, scope: item.scope, projectId: item.projectId,
      verificationStatus: item.verificationStatus, tags: item.tags,
      relations: item.relations, evidenceRefs: item.evidenceRefs
    }));
  }

  buildPrompt({ experiences, evidence, existingKnowledge, projectId, domainId }) {
    return [
      '你是 Owner Agent 的 Knowledge Harvest 提炼器。只读；不得执行命令、写文件或访问网络。',
      '遵守以下 pstack 纪律：',
      HARVEST_DISCIPLINE,
      '',
      '工作阶段：',
      ...HARVEST_STEPS.map((step, index) => `${index + 1}. ${step}`),
      '',
      '请严格区分：',
      '- facts：Owner Store 或测试直接观察到的事实；',
      '- inferences：你的推断，必须标注为推断；',
      '- unknowns：证据不足、无法确认的内容。',
      '不要把模型自述“成功”当作成功证据；只有测试通过才算成功证据。',
      '优先提炼能解释 observedProblem、失败机制、有效修复和适用条件的可复用技术经验；',
      'claim 必须保留证据中的关键常量、默认值、文件名和测试断言；不要用 N、某个值等占位符替代。',
      '每项候选必须同时包含 title 和 claim；claim 不得省略，也不能只把主张写在 title 里。',
      '只有在没有技术机制证据时，才提炼流程或验证纪律。',
      '不要复制原始 prompt、工具输出或任何密钥；证据只引用 ref。',
      '如果经验只支持一个项目事实，proposedLayer 必须是 project；',
      '只有至少两个独立项目都有通过证据时，才可建议 applied；domain 需要三个以上独立项目。',
      '跨项目候选不要写项目 ID；用运行时、代码形态、测试契约描述适用条件。',
      '如果与现有知识冲突，必须在 contradictions 中列出，并降低置信度。',
      '',
      `项目：${projectId}`,
      `领域：${domainId}`,
      '',
      'Experience（已结构化）：',
      JSON.stringify(experiences, null, 2),
      '',
      'Evidence 摘要（只读引用，不含完整原始输出）：',
      JSON.stringify(evidence, null, 2),
      '',
      '现有知识（用于去重与冲突检查）：',
      JSON.stringify(existingKnowledge, null, 2),
      '',
      '只输出一个 JSON 对象：',
      '{"candidates":[{"title":"...","claim":"...","kind":"invariant|pattern|anti-pattern|experience|concept|procedure|hypothesis",',
      '"proposedLayer":"project|applied|domain","applicability":["..."],"exceptions":["..."],',
      '"confidence":0.0,"contradictions":["..."],"keywords":["..."],"evidenceRefs":["..."],',
      '"facts":["..."],"inferences":["..."],"unknowns":["..."],"validationSuggestions":["..."]}]}',
      '最多 5 个候选；没有值得长期保留的经验时输出 {"candidates":[]}。',
      'evidenceRefs 只能使用上面出现的 ref（sandbox:/job:/patch:/repair:/evidence:/task:/experience:）。'
    ].join('\n');
  }

  async runExtractor({ prompt, cwd }) {
    if (!this.allowModel) throw new Error('Knowledge harvest model is disabled; pass allowModel=true or inject an extractor');
    const controller = new AbortController();
    let session = null;
    let timer = null;
    try {
      session = await this.sessionFactory.create({ cwd, model: this.model || undefined, signal: controller.signal });
      let tools = null;
      try { tools = session.activeTools(); } catch { tools = null; }
      if (!Array.isArray(tools) || tools.length > 0) {
        try { session.abort?.(); } catch { /* ignore */ }
        throw new Error(tools === null
          ? 'Harvest tool isolation verification unavailable; refusing to prompt'
          : `Harvest tool isolation failed (${tools.length} active tools)`);
      }
      const settled = session.prompt(prompt).then(() => ({ ok: true })).catch((error) => ({ ok: false, error }));
      const result = await Promise.race([
        settled,
        new Promise((resolve) => {
          timer = setTimeout(() => { controller.abort(); resolve({ timedOut: true }); }, this.timeoutMs);
        })
      ]);
      if (result.timedOut) {
        try { session.abort?.(); } catch { /* ignore */ }
        throw new Error('Knowledge harvest timed out');
      }
      if (!result.ok) throw result.error ?? new Error('Knowledge harvest prompt failed');
      const text = String(session.getLastText?.() ?? '');
      if (!text.trim()) throw new Error('Knowledge harvest returned empty output');
      return { text, model: String(session.model ?? 'unknown') };
    } finally {
      if (timer !== null) clearTimeout(timer);
      try { session?.dispose(); } catch { /* best effort */ }
    }
  }

  async harvest({
    experienceIds, projectId, domainId, extractor = null,
    model = this.model, allowModel = this.allowModel
  } = {}) {
    if (!Array.isArray(experienceIds) || experienceIds.length === 0) throw new Error('experienceIds are required');
    const experiences = experienceIds.map((id) => this.personal.getExperience(id));
    if (experiences.some((item) => !item)) throw new Error('Unknown experience id');
    const projectIds = [...new Set(experiences.map((item) => item.projectId))];
    const resolvedProjectId = projectId ?? projectIds[0];
    if (!projectIds.includes(resolvedProjectId) && projectIds.length > 0) {
      throw new Error('Harvest project must be one of the source experiences');
    }
    const domainIds = [...new Set(experiences.flatMap((item) => item.domainIds ?? []))];
    const resolvedDomainId = domainId ?? domainIds[0] ?? 'software-engineering';
    if (!domainIds.includes(resolvedDomainId)) domainIds.push(resolvedDomainId);
    const sortedExperienceIds = [...experienceIds].sort();
    const dedupeKey = sha256(canonical({
      contract: 'knowledge-harvest/v1',
      version: HARVEST_VERSION,
      experienceIds: sortedExperienceIds,
      projectId: resolvedProjectId,
      domainId: resolvedDomainId,
      model: model || (extractor ? 'injected' : 'none'),
      steps: HARVEST_STEPS
    }));
    const previous = this.personal.harvestRunByDedupe(dedupeKey);
    if (previous) {
      return {
        harvestRun: previous,
        candidates: previous.candidateIds.map((id) => this.personal.proposal(id)).filter(Boolean),
        duplicate: true
      };
    }

    const evidence = this.evidenceFor(experiences);
    const existingKnowledge = this.existingKnowledge({ domainId: resolvedDomainId, experiences });
    const project = this.owner.getProject(resolvedProjectId);
    const cwd = project?.root ?? process.cwd();
    const prompt = this.buildPrompt({
      experiences, evidence, existingKnowledge,
      projectId: resolvedProjectId, domainId: resolvedDomainId
    });
    const promptHash = sha256(prompt);
    const harvestId = `harvest_${randomUUID().replaceAll('-', '').slice(0, 24)}`;

    let drafts;
    let usedModel = 'injected';
    if (extractor) {
      const output = await extractor({
        experiences, evidence, existingKnowledge, steps: HARVEST_STEPS,
        projectId: resolvedProjectId, domainId: resolvedDomainId
      });
      drafts = Array.isArray(output) ? output : output?.candidates;
    } else {
      const result = await this.runExtractor({ prompt, cwd });
      usedModel = result.model;
      const parsed = parseJsonObject(result.text);
      drafts = parsed.candidates;
    }
    if (!Array.isArray(drafts)) throw new Error('Harvest output must contain a candidates array');
    if (drafts.length > 5) throw new Error('Harvest returned more than 5 candidates');

    const passedProjects = new Set(experiences
      .filter((item) => item.observedOutcome?.testStatus === 'pass' || item.observedOutcome?.status === 'repaired')
      .map((item) => item.projectId));
    const hasPassedEvidence = passedProjects.size > 0;
    const allowedRefs = new Set(experiences.flatMap((item) => item.evidenceRefs ?? []));
    const candidates = [];
    const invalid = [];
    for (const raw of drafts) {
      let normalized;
      try {
        normalized = normalizeCandidateDraft(raw);
      } catch (error) {
        invalid.push({ error: error.message, draft: raw });
        this.logger.warn?.('knowledge candidate skipped:', error.message);
        continue;
      }
      let layer = normalized.proposedLayer;
      // L2 必须由两个不同项目各自的 passed/repaired 证据支持；单个 A pass + B fail 不够。
      if (!hasPassedEvidence || passedProjects.size < 2) layer = 'project';
      if (layer === 'domain' && passedProjects.size < 3) layer = 'applied';
      // 两个独立项目的通过证据是 L2 的充分条件；但若主张/适用条件绑定具体项目 ID，
      // 仍保守保留为 project，避免把项目特例伪装成共享知识。
      const projectIds = [...new Set(experiences.map((item) => item.projectId))];
      const projectSpecific = projectIds.some((projectId) =>
        [normalized.title, normalized.claim, ...normalized.applicability, ...normalized.exceptions]
          .join(' ').includes(projectId)
      );
      if (layer === 'project' && passedProjects.size >= 2 && !projectSpecific) {
        layer = 'applied';
      }
      const evidenceRefs = (normalized.evidenceRefs ?? []).filter((ref) => allowedRefs.has(ref) || /^experience:/u.test(ref));
      const contradictions = normalized.contradictions ?? [];
      const draft = {
        ...normalized,
        proposedLayer: layer,
        evidenceRefs: [...new Set([...evidenceRefs, ...sortedExperienceIds.map((id) => `experience:${id}`)])],
        verificationStatus: contradictions.length ? 'needs_reverification' : 'unverified'
      };
      const mapped = candidateToProposal({
        draft,
        projectId: resolvedProjectId,
        domainIds,
        sourceExperienceIds: sortedExperienceIds,
        harvestRunId: harvestId,
        playbook: 'edae',
        steps: HARVEST_STEPS
      });
      const proposal = this.personal.submitProposal({
        targetId: null,
        payload: mapped.payload,
        actor: 'knowledge-harvester',
        note: `Knowledge Loop harvest ${harvestId}`,
        meta: mapped.meta
      });
      candidates.push(proposal);
    }
    const harvestRun = this.personal.addHarvestRun({
      id: harvestId,
      projectId: resolvedProjectId,
      experienceIds: sortedExperienceIds,
      dedupeKey,
      model: usedModel,
      status: candidates.length ? 'candidates' : 'empty',
      candidateIds: candidates.map((item) => item.id),
      payload: {
        contract: CANDIDATE_CONTRACT,
        harvestVersion: HARVEST_VERSION,
        promptHash,
        domainId: resolvedDomainId,
        domainIds,
        steps: HARVEST_STEPS,
        evidenceRefs: evidence.map((item) => item.ref),
        existingKnowledgeIds: existingKnowledge.map((item) => item.id),
        invalidCandidates: invalid,
        skillsDir: resolvePstackSkillsDir(),
        createdAt: this.clock()
      }
    });
    return { harvestRun, candidates, invalid, duplicate: false };
  }
}
