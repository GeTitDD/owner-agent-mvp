// Knowledge Loop 常驻扫描：复用现有 Owner Runtime 的低频 tick，不新建调度器。
//
// 每次 tick：
// 1. 幂等采集已完成 Job/Sandbox 的 Experience；
// 2. 计算尚未进入 Harvest 的待提炼 Experience；
// 3. 若显式允许且配置了模型，按项目自动 Harvest；否则只保留待提炼队列。
import { ExperienceCollector } from './experience.mjs';
import { KnowledgeHarvester } from './harvest.mjs';

const nowIso = () => new Date().toISOString();

export class KnowledgeLoopRuntime {
  constructor({
    ownerStore, personalStore, harvester = null, collector = null,
    model = '', allowHarvest = false, minExperiences = 2,
    clock = nowIso, logger = console, retryAfterMs = 10 * 60 * 1000
  } = {}) {
    if (!ownerStore || !personalStore) throw new Error('ownerStore and personalStore are required');
    this.owner = ownerStore;
    this.personal = personalStore;
    this.collector = collector ?? new ExperienceCollector(ownerStore, personalStore, { clock });
    this.harvester = harvester ?? (allowHarvest
      ? new KnowledgeHarvester({ ownerStore, personalStore, model, allowModel: true })
      : null);
    this.model = model;
    this.allowHarvest = allowHarvest;
    this.minExperiences = Math.max(1, minExperiences);
    this.clock = clock;
    this.logger = logger;
    this.retryAfterMs = retryAfterMs;
    this.attempts = new Map();
    this.running = false;
    this.last = null;
  }

  pendingExperiences() {
    const harvested = new Set(this.personal.listHarvestRuns(1000).flatMap((run) => run.experienceIds ?? []));
    return this.personal.listExperiences({ limit: 1000 })
      .filter((experience) => !harvested.has(experience.id));
  }

  harvestKey(experiences) {
    return experiences.map((item) => item.id).sort().join('|');
  }

  shouldAttempt(experiences) {
    const key = this.harvestKey(experiences);
    const previous = this.attempts.get(key);
    return !previous || Date.now() - previous > this.retryAfterMs;
  }

  maybeHarvest(pending) {
    if (!this.allowHarvest || !this.harvester || pending.length < this.minExperiences) {
      return { harvested: 0, candidates: 0, skipped: true };
    }
    const projectIds = [...new Set(pending.map((experience) => experience.projectId))];
    for (const projectId of projectIds) {
      const experiences = this.personal.listExperiences({ projectId, limit: 1000 });
      if (experiences.length < this.minExperiences || !this.shouldAttempt(experiences)) continue;
      const key = this.harvestKey(experiences);
      this.attempts.set(key, Date.now());
      try {
        const result = this.harvester.harvest({
          experienceIds: experiences.map((item) => item.id),
          projectId,
          domainId: experiences[0]?.domainIds?.[0] ?? 'software-engineering',
          allowModel: true,
          model: this.model
        });
        return Promise.resolve(result).then((value) => ({
          harvested: 1,
          candidates: value?.candidates?.length ?? 0,
          harvestRunId: value?.harvestRun?.id ?? null
        }));
      } catch (error) {
        this.logger.warn?.('knowledge auto-harvest skipped:', error.message);
        return { harvested: 0, candidates: 0, error: error.message };
      }
    }
    return { harvested: 0, candidates: 0, skipped: true };
  }

  async tick({ projectId = '', limit = 200 } = {}) {
    if (this.running) return { skipped: true, reason: 'busy', last: this.last };
    this.running = true;
    const startedAt = this.clock();
    try {
      const projects = projectId ? [{ id: projectId }] : this.owner.listProjects();
      const collected = [];
      const errors = [];
      for (const project of projects) {
        try {
          collected.push(...this.collector.collectProject(project.id, { limit }));
        } catch (error) {
          errors.push({ projectId: project.id, error: error.message });
        }
      }
      const pending = this.pendingExperiences();
      let harvest = { harvested: 0, candidates: 0, skipped: true };
      if (pending.length >= this.minExperiences) {
        try {
          harvest = await this.maybeHarvest(pending);
        } catch (error) {
          harvest = { harvested: 0, candidates: 0, error: error.message };
        }
      }
      const result = {
        at: startedAt,
        projects: projects.length,
        collected: collected.length,
        newExperiences: collected.filter((item) => item.duplicate !== true).length,
        pending: pending.length,
        harvest,
        errors
      };
      this.last = result;
      return result;
    } finally {
      this.running = false;
    }
  }

  status() {
    const pending = (() => {
      try { return this.pendingExperiences().length; } catch { return null; }
    })();
    return {
      last: this.last,
      pending,
      allowHarvest: this.allowHarvest,
      model: this.model || 'default'
    };
  }

  setAutoHarvest(enabled, { model = this.model } = {}) {
    this.allowHarvest = Boolean(enabled);
    if (model) this.model = model;
    if (this.allowHarvest && !this.harvester) {
      this.harvester = new KnowledgeHarvester({
        ownerStore: this.owner, personalStore: this.personal,
        model: this.model, allowModel: true
      });
    }
    return this.status();
  }
}
