// Knowledge Loop 常驻扫描（已退役）。
//
// ADR-0007 / #62：旧的采集链（扫描已终态 Run/Job → ExperienceCollector 写 knowledge_experiences
// → 自动 Harvest 出候选）已停写，旧经验表的读路径也已摘除。新链路不再自动采集：提炼由人在
// 「执行记录 → 经验（lesson/v1）」上按需触发（LessonDistiller / distillOnDemand）。
//
// 这个类保留原有的构造与 tick/status/setAutoHarvest 形状，避免桌面端与 owner-resident 的
// 调度代码在收尾阶段被迫一起改；tick 现在只报告退役状态：不读旧表、不写库、不调模型。
const nowIso = () => new Date().toISOString();

export class KnowledgeLoopRuntime {
  constructor({
    ownerStore, personalStore, model = '', logger = console,
    clock = nowIso
  } = {}) {
    if (!ownerStore || !personalStore) throw new Error('ownerStore and personalStore are required');
    this.owner = ownerStore;
    this.personal = personalStore;
    this.model = model;
    this.logger = logger;
    this.clock = clock;
    // 退役标志：调用方（面板摘要、脚本报告）据此知道自动采集/自动提炼不再发生。
    this.retired = true;
    this.allowHarvest = false;
    this.running = false;
    this.last = null;
  }

  /** 一次空的退役 tick：保住旧形状，不再扫描采集，也不产生待提炼队列。 */
  async tick({ projectId = '' } = {}) {
    if (this.running) return { skipped: true, reason: 'busy', last: this.last };
    this.running = true;
    try {
      const result = {
        at: this.clock(),
        retired: true,
        projectId: String(projectId ?? ''),
        projects: 0,
        collected: 0,
        newExperiences: 0,
        pending: 0,
        harvest: { harvested: 0, candidates: 0, skipped: true, retired: true },
        errors: []
      };
      this.last = result;
      return result;
    } finally {
      this.running = false;
    }
  }

  status() {
    return {
      retired: true,
      last: this.last,
      pending: 0,
      allowHarvest: false,
      model: this.model || 'default'
    };
  }

  /** 自动提炼随旧链路一起退役：保留入口只为不打断既有设置调用，永远不开启。 */
  setAutoHarvest(enabled, { model = this.model } = {}) {
    this.allowHarvest = false;
    if (model) this.model = model;
    return this.status();
  }
}
