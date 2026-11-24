// 专注模式「项目详情卡」的视图模型：纯函数，不碰 DOM、不发请求。
//
// 为什么单独一个文件：卡片的九块内容需要能脱离 Electron 单独验证（选哪个项目、
// 详情是否属于这个项目、四个入口的计数、哪些块默认展开）。渲染细节留在 panel.js。
//
// 双份导出：浏览器当普通脚本加载（挂到 window.OwnerFocusDetail），
// Node 测试用 require 直接读；.cjs 保证 node 侧不会被当成 ESM。
(function attach(root, factory) {
  // 浏览器里由 panel.html 先加载 panel-selection.cjs；Node 测试直接 require。
  // 顺序不对时立刻失败，避免卡片悄悄退回「自己再写一份选择规则」。
  const selection = typeof module === 'object' && module.exports
    ? require('./panel-selection.cjs')
    : root?.OwnerPanelSelection;
  if (!selection) throw new Error('focus-detail needs panel-selection.cjs loaded first');
  const api = factory(selection);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerFocusDetail = api;
})(typeof globalThis === 'undefined' ? null : globalThis, (selection) => {
  // 与 panel.js 里的图谱标签保持一致；这里重复一份是为了让模型自己就能出文案。
  const DIAGRAM_LABELS = {
    dependency: '依赖图',
    control: '控制流图',
    dataflow: '数据流图',
    state: '状态图',
    sequence: '时序图'
  };
  const DIAGRAM_ORDER = ['dependency', 'control', 'dataflow', 'state', 'sequence'];

  const IDEA_STATUS = {
    todo: '新想法',
    doing: '讨论中',
    blocked: '搁置',
    done: '已采纳',
    failed: '失败'
  };

  // 与 panel.js 顶部一致的「进行中」状态集合：只用来数链上有几件事在跑。
  const ACTIVE_STATUSES = new Set([
    'running', 'leased', 'provisioning', 'collecting', 'test_pending', 'queued'
  ]);

  const PATCH_ENTRY_KINDS = new Set(['patch', 'patch-apply']);
  const TEST_ENTRY_KINDS = new Set(['sandbox', 'repair-create']);

  const GUIDE = {
    title: '还没有项目',
    text: '添加一个本地 Git 仓库后，这里会显示它的画像、图谱、想法和 Playbook。',
    actionLabel: '添加项目'
  };

  const asArray = (value) => (Array.isArray(value) ? value : []);
  const num = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const text = (value) => (typeof value === 'string' ? value : '');

  /** 选中的项目：显式选过且存在就用它，否则退回第一个；都不存在时为 null。 */
  const pickProject = (projects, selectedId) => selection.viewProject(projects, selectedId);

  const buildTabs = (projects, selectedId) => projects.map((item) => ({
    id: item.id,
    name: item.name || item.id,
    pending: num(item.pending),
    selected: item.id === selectedId
  }));

  const buildBrief = (brief, ready) => {
    if (!ready) return { state: 'loading', oneLiner: '', hint: '正在读取项目画像…' };
    if (!brief) {
      return {
        state: 'empty',
        oneLiner: '',
        hint: '还没有项目画像。点「一键理解」看代码和文档，给出是什么、怎么跑、怎么验收。'
      };
    }
    return {
      state: 'ready',
      stale: brief.stale === true,
      oneLiner: text(brief.oneLiner || brief.whatItIs),
      whatItIs: text(brief.whatItIs),
      howToRun: asArray(brief.howToRun).slice(0, 4),
      modules: asArray(brief.modules).slice(0, 3).map((module) => ({
        name: text(module?.name),
        role: text(module?.role)
      })),
      verify: asArray(brief.verify?.commands).slice(0, 3),
      risks: asArray(brief.risks).slice(0, 2),
      unknowns: asArray(brief.unknowns).slice(0, 2),
      generatedAt: text(brief.generatedAt),
      generatedFrom: text(brief.generatedFrom),
      version: num(brief.version) || 1,
      hint: ''
    };
  };

  /** 图谱：默认依赖图，没有就退到第一个已生成的类型。 */
  const buildDiagram = (diagrams, ready) => {
    const kinds = DIAGRAM_ORDER.map((kind) => ({
      kind,
      label: DIAGRAM_LABELS[kind],
      state: asArray(diagrams).some((item) => item.kind === kind) ? 'ready' : 'empty'
    }));
    if (!ready) {
      return { state: 'loading', kind: '', label: '', mermaid: '', kinds, hint: '正在读取项目图谱…' };
    }
    const list = asArray(diagrams);
    const active = list.find((item) => item.kind === 'dependency')
      ?? list.find((item) => DIAGRAM_ORDER.includes(item.kind))
      ?? null;
    if (!active) {
      return {
        state: 'empty',
        kind: 'dependency',
        label: DIAGRAM_LABELS.dependency,
        mermaid: '',
        kinds,
        hint: '还没有项目图谱。图谱在待办的工作区里生成，生成后这里直接展开。'
      };
    }
    return {
      state: 'ready',
      kind: active.kind,
      label: DIAGRAM_LABELS[active.kind] ?? active.kind,
      mermaid: text(active.mermaid),
      generatedAt: text(active.generatedAt),
      stale: active.stale === true,
      kinds: kinds.map((item) => ({ ...item, selected: item.kind === active.kind })),
      hint: ''
    };
  };

  const buildIdeas = (queue, ready) => {
    if (!ready) return { total: 0, active: 0, items: [], hint: '正在读取想法…' };
    const ideas = asArray(queue).filter((item) => item.kind === 'idea');
    const activeStatuses = ['todo', 'doing', 'blocked'];
    // 活跃的排前面，已采纳/失败沉到后面；卡片只列前 4 条。
    const ordered = ideas.slice().sort((a, b) => {
      const rank = (item) => (activeStatuses.includes(item.status) ? 0 : 1);
      return rank(a) - rank(b);
    });
    return {
      total: ideas.length,
      active: ideas.filter((item) => activeStatuses.includes(item.status)).length,
      items: ordered.slice(0, 4).map((item) => ({
        id: text(item.id),
        title: text(item.title),
        status: text(item.status) || 'todo',
        statusLabel: IDEA_STATUS[item.status] ?? '新想法'
      })),
      hint: ideas.length ? '' : '还没有想法。在待办里聊到或手动记下一条，会出现在这里。'
    };
  };

  const buildPlaybook = (playbookInput, detail, ready) => {
    const running = detail?.playbook?.running === true;
    const runningTitle = running ? text(detail.playbook.title) : '';
    if (!ready) {
      return { available: false, running, runningTitle, lastRuns: [], hint: '正在读取 Playbook…' };
    }
    const catalog = playbookInput?.catalog ?? null;
    if (!catalog) {
      return {
        available: false,
        running,
        runningTitle,
        lastRuns: [],
        hint: '正在读取 Playbook 目录…'
      };
    }
    if (!catalog.skillsAvailable) {
      return {
        available: false,
        running,
        runningTitle,
        lastRuns: [],
        hint: '未找到 pstack skills 目录；设置 PSTACK_DIR 后再试。'
      };
    }
    const labels = new Map();
    const names = [];
    for (const group of asArray(catalog.groups)) {
      for (const item of asArray(group?.items)) {
        labels.set(item.id, item.label || item.id);
        names.push(item.id);
      }
    }
    const lastRuns = Object.entries(catalog.lastRuns ?? {})
      .filter(([id]) => labels.has(id))
      .map(([id, run]) => ({
        id,
        label: labels.get(id) ?? id,
        status: text(run?.status),
        summary: text(run?.summary),
        startedAt: text(run?.startedAt)
      }))
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .slice(0, 3);
    return {
      available: true,
      running,
      runningTitle,
      count: names.length,
      lastRuns,
      hint: names.length ? '' : 'Playbook 目录是空的。'
    };
  };

  /** 四个入口：只给计数和一句状态，内容不在这里重复渲染。 */
  const buildEntries = (detail, ready) => {
    if (!ready) {
      return [
        { key: 'knowledge', label: '知识', count: 0, note: '正在读取…' },
        { key: 'tests', label: '测试', count: 0, note: '正在读取…' },
        { key: 'patches', label: '补丁', count: 0, note: '正在读取…' },
        { key: 'runs', label: '运行', count: 0, note: '正在读取…' }
      ];
    }

    const projectId = detail?.config?.projectId ?? '';
    const counts = detail?.counts ?? {};
    const knowledge = detail?.knowledge?.counts ?? {};
    const pending = asArray(detail?.pending).filter((item) => item.projectId === projectId);
    const chain = detail?.chain ?? {};

    const pendingOf = (kinds) => pending.filter((item) => kinds.has(item.kind)).length;
    const activeChain = ['job', 'patch', 'sandbox', 'cycle']
      .map((key) => chain[key])
      .filter((item) => item && ACTIVE_STATUSES.has(String(item.status ?? '').toLowerCase()))
      .length;

    const testStatus = String(chain?.sandbox?.test_status ?? '');
    const testNote = testStatus === 'pass'
      ? '最近通过'
      : testStatus === 'fail'
        ? '最近未通过'
        : chain?.sandbox
          ? '最近未完成'
          : '还没跑过';

    const pendingPatches = pendingOf(PATCH_ENTRY_KINDS);
    const patchStatus = String(chain?.patch?.status ?? '');
    const patchNote = pendingPatches > 0
      ? `待审 ${pendingPatches}`
      : patchStatus === 'applied'
        ? '最近已应用'
        : patchStatus
          ? `最近 ${patchStatus}`
          : '还没有补丁';

    const knowledgeCount = num(knowledge.knowledge) || num(knowledge.experiences);

    return [
      {
        key: 'knowledge',
        label: '知识',
        count: knowledgeCount,
        note: `候选 ${num(knowledge.candidates)} · 已验证 ${num(knowledge.verified)}`
      },
      {
        key: 'tests',
        label: '测试',
        // 沙箱测试次数来自快照里按项目过滤后的计数。
        count: num(counts.tests),
        note: testNote
      },
      { key: 'patches', label: '补丁', count: num(counts.patches), note: patchNote },
      {
        key: 'runs',
        label: '运行',
        count: num(counts.jobs),
        note: activeChain > 0 ? `进行中 ${activeChain}` : '空闲'
      }
    ];
  };

  const buildGithub = (project, activity) => {
    const github = project?.github ?? null;
    if (!github?.available && !github?.nameWithOwner) {
      return {
        linked: false,
        hint: '还没有关联 GitHub。在设置里给项目配上仓库后，这里会显示 Issues 和 PR。'
      };
    }
    const issues = asArray(activity?.issues);
    const prs = asArray(activity?.prs);
    const items = [
      ...issues.map((item) => ({ kind: 'issue', number: num(item.number), title: text(item.title), url: text(item.url) })),
      ...prs.map((item) => ({ kind: 'pr', number: num(item.number), title: text(item.title), url: text(item.url) }))
    ].slice(0, 3);
    return {
      linked: true,
      nameWithOwner: text(github.nameWithOwner),
      url: text(github.url),
      issueCount: num(activity?.issueCount),
      prCount: num(activity?.prCount),
      error: text(activity?.error),
      loading: !activity,
      items,
      hint: activity ? '' : '正在读取 Issues / PR…'
    };
  };

  const buildTests = (detail, ready) => {
    if (!ready) return { enabled: false, ok: false, profile: '', missing: [], hint: '正在读取测试配置…' };
    const config = detail?.testConfig ?? null;
    if (!config) {
      return { enabled: false, ok: false, profile: '', missing: [], hint: '还没有测试配置。' };
    }
    return {
      enabled: config.enabled === true,
      ok: config.ok === true,
      profile: text(config.profile),
      missing: asArray(config.missing),
      hint: config.enabled
        ? config.ok ? '沙箱测试可用。' : '测试配置还不完整。'
        : '这个项目的沙箱测试已关闭，只做人工验证。'
    };
  };

  function buildFocusDetail(input = {}) {
    const projects = asArray(input.projects).filter((item) => item && item.id);
    const expanded = { brief: true, diagram: true, ideas: true, playbook: true };

    if (!projects.length) {
      return { hasProjects: false, guide: { ...GUIDE }, tabs: [], expanded };
    }

    const project = pickProject(projects, input.selectedId);
    const projectId = project.id;
    // 详情只认本项目：别把上一个项目的数据画到新项目下面。
    const detail = input.detail && input.detail.config?.projectId === projectId
      ? input.detail
      : null;
    const ready = Boolean(detail);
    // Playbook 目录按项目取，同样不接受别的项目的那份。
    const playbookInput = input.playbook && input.playbook.projectId === projectId
      ? input.playbook
      : null;

    return {
      hasProjects: true,
      detailReady: ready,
      guide: null,
      projectId,
      projectName: project.name || projectId,
      root: text(project.root),
      hostLabel: text(project.hostLabel),
      goal: text(project.goal),
      tabs: buildTabs(projects, projectId),
      expanded,
      brief: buildBrief(detail?.brief ?? null, ready),
      diagram: buildDiagram(detail?.diagrams, ready),
      ideas: buildIdeas(detail?.queue, ready),
      playbook: buildPlaybook(playbookInput, detail, ready),
      entries: buildEntries(detail, ready),
      more: {
        github: buildGithub(project, input.github ?? null),
        tests: buildTests(detail, ready)
      }
    };
  }

  return { buildFocusDetail, DIAGRAM_LABELS, DIAGRAM_ORDER };
});
