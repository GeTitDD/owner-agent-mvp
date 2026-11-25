(() => {
  const $ = (id) => document.getElementById(id);
  const stateText = {
    idle: '空闲',
    working: '工作中',
    waiting: '等你决定',
    done: '已完成',
    error: '遇到异常'
  };
  // 终态 / 审批态 / 相位的判定只在 src/execution-status.mjs 一处（ESM 经典脚本读不到，
  // 但主进程已经把结果算进快照的 view.executions）。这里不再维护任何状态集合：
  // 页头计数与工作区「运行」入口都直接用快照里已筛好的非终态执行。
  // 补丁待办：补丁提案与补丁应用都算「待审补丁」（沿用详情卡时代的口径）。
  const PATCH_ENTRY_KINDS = new Set(['patch', 'patch-apply']);
  const countOf = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  let view = null;
  let panelMode = 'knowledge';
  let refreshing = false;
  let refreshPending = false;
  let composerBusy = false;
  let toastTimer = null;
  // 两个互不影响的显式状态（ADR-0006：显示 A 不等于改 B）：
  // - 视图项目：工作区看哪个项目；空＝看第一个，刷新不记忆。
  // - 交办目标：只能由「交办到 …」菜单设置；空＝未选，发送被拦。
  let viewProjectId = '';
  let handoffProjectId = '';

  const toast = (text, ms = 2600) => {
    const node = $('toast');
    node.textContent = text;
    node.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, ms);
  };

  const fmtHash = (hash) => (hash ? `${hash.slice(0, 12)}…${hash.slice(-6)}` : '—');
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const renderServiceGrid = (container, services) => {
    container.replaceChildren();
    const rows = [
      ['Docker', services?.docker ? '可用' : '未检测到', services?.docker ? 'ok' : 'bad'],
      ['OpenClaw Gateway', services?.gateway ? '可连接' : '未连接（L2 可选）', services?.gateway ? 'ok' : 'warn'],
      ['Pi 模型', services?.model ?? (services?.pi ? 'Pi 默认模型' : '未检测到'), services?.pi ? 'ok' : 'warn']
    ];
    for (const [label, text, tone] of rows) {
      const row = el('div', 'service-row');
      row.append(el('span', undefined, label));
      row.append(el('span', `service-state ${tone}`, text));
      container.append(row);
    }
  };

  const applyState = () => {
    const state = view?.state ?? 'idle';
    $('stateDot').className = `state-dot ${state}`;
    $('stateText').textContent = stateText[state] ?? '空闲';
    $('activityPhase').className = `state-dot ${state}`;
    $('activityLabel').textContent = stateText[state] ?? '空闲';
    $('stage').textContent = view?.stage ?? '正在读取状态…';
    $('workerLabel').textContent = view?.worker?.label ? `Worker · ${view.worker.label}` : 'Worker 空闲';
    const pending = view?.pending?.length ?? 0;
    $('pendingCount').textContent = `${pending} 项待决定`;
    $('needsCount').textContent = String(pending);
    $('needsChip').classList.toggle('warn', pending > 0);
    // 待办块自己的标题、计数与空态跟着操作区视图模型走（见 renderOps）；
    // 这里只维护页头计数，避免同一件事在两处各算一遍。
    const running = view?.worker?.running;
    const playbookRunning = view?.playbook?.running === true;
    // 页头的「运行中」直接读主进程筛好的非终态执行（execution-status.mjs 的语义），
    // 不在本层再判一次状态；chain 只用来判断「有没有最近任务」这句文案。
    const executions = Array.isArray(view?.executions) ? view.executions : [];
    const chainItems = [view?.chain?.job, view?.chain?.patch, view?.chain?.sandbox, view?.chain?.cycle]
      .filter(Boolean);
    const totalSteps = chainItems.length;
    const activeCount = executions.length + (playbookRunning ? 1 : 0);
    $('runningBadge').textContent = String(activeCount || totalSteps);
    $('runningCount').textContent = String(activeCount);
    $('runningChip').classList.toggle('active', Boolean(running || playbookRunning || executions.length > 0));
    $('runningTitle').textContent = (executions.length > 0 || playbookRunning)
      ? '运行中'
      : (totalSteps > 0 ? '最近任务' : '运行中');
    const hasProjects = (view?.projects?.length ?? 0) > 0;
    // 设置向导随 #73 搬进设置面板，不再占工作区；它现在总能打开，不跟「有没有项目」联动。
    $('composeSection').hidden = !hasProjects || panelMode !== 'focus';
    $('submitTask').disabled = composerBusy || !hasProjects;
    $('queueSection').hidden = !hasProjects;
    $('playbookSection').hidden = !hasProjects;
    const testConfig = view?.testConfig;
    const missing = testConfig?.missing ?? [];
    const showWarning = Boolean(hasProjects && testConfig && testConfig.enabled && testConfig.ok === false);
    const showMuted = Boolean(hasProjects && testConfig && !testConfig.enabled);
    $('testWarning').hidden = !(showWarning || showMuted);
    $('testWarning').classList.toggle('muted', !showWarning && showMuted);
    if (showWarning) {
      $('testWarningText').textContent = missing.length
        ? `测试配置缺少 ${missing.join(', ')}；补丁应用后无法创建沙箱。`
        : '还没有可用的测试配置；补丁应用后无法创建沙箱。';
    } else if (showMuted) {
      // ecosystem 缺失时（包括沙箱计划给的占位 'unknown'）不要打印括号里的占位词。
      const ecosystem = testConfig.ecosystem && testConfig.ecosystem !== 'unknown'
        ? testConfig.ecosystem
        : '';
      $('testWarningText').textContent = testConfig.reason === 'disabled'
        ? '已按设置跳过沙箱测试；补丁只做人工验证。'
        : ecosystem
          ? `这个项目（${ecosystem}）没有可用沙箱 profile；补丁只做人工验证。`
          : '这个项目还没有可用的沙箱 profile；补丁只做人工验证。';
    }
    const sandboxSelect = $('sandboxModeSelect');
    if (sandboxSelect) {
      const projectMode = view?.config?.sandboxProjectMode || 'auto';
      const allowedModes = ['auto', 'off', 'node-smoke', 'godot-headless', 'python-pytest'];
      sandboxSelect.value = allowedModes.includes(projectMode) ? projectMode : 'auto';
      sandboxSelect.disabled = !hasProjects;
    }
    $('sandboxDetect').hidden = !(showWarning || showMuted);
    const profileValue = typeof testConfig?.profile === 'string'
      ? testConfig.profile
      : testConfig?.profile?.id;
    const configuredMode = view?.config?.sandboxProjectMode || view?.config?.sandboxMode || 'auto';
    const profileLabel = profileValue || (configuredMode === 'auto' ? 'auto' : configuredMode);
    const profileButton = $('scopeProfile');
    if (profileButton) {
      profileButton.textContent = `沙箱 ${profileLabel}`;
      profileButton.title = `沙箱 profile：${profileLabel}${testConfig?.projectDir ? ` · projectDir=${testConfig.projectDir}` : ''}`;
      profileButton.disabled = !hasProjects;
    }
    const pathsButton = $('scopePaths');
    if (pathsButton) {
      const paths = view?.config?.allowedPaths || 'src/';
      pathsButton.textContent = `范围 ${paths}`;
      pathsButton.title = `允许修改的路径：${paths}`;
      pathsButton.disabled = !hasProjects;
    }
    $('footerStatus').textContent = view?.services?.docker
      ? '本地服务已启动 · Docker 可用'
      : '本地服务已启动 · Docker 未检测到';
    const knowledge = view?.knowledge;
    const candidates = knowledge?.counts?.candidates ?? 0;
    $('knowledgeBadge').textContent = String(candidates);
    $('knowledgeBadge').hidden = !knowledge?.available || candidates === 0;
    if (knowledge?.available) {
      const counts = knowledge.counts ?? {};
      $('knowledgeSummaryText').textContent =
        `本项目：经验 ${counts.lessons ?? 0} 条 · ` +
        `知识 ${counts.knowledge ?? 0} 条（已验证 ${counts.verified ?? 0} 条）· 候选 ${candidates} 条 · ` +
        `复用 ${counts.usages ?? 0} 次（正反馈 ${counts.positiveUsages ?? 0}）\n` +
        `共享知识 ${counts.sharedKnowledge ?? 0} 条（已验证 ${counts.sharedVerified ?? 0} 条）`;
    } else {
      $('knowledgeSummaryText').textContent = '知识库尚未建立；完成任务并提炼执行记录后，这里会显示摘要。';
    }
  };

  // 选项目只剩工作区顶部一处（#73）：旧的「搜索 + 按来源主机分组列表 + 添加」段已删除，
  // 切换标签由 renderFocusMode → renderWorkProjectBar 画。
  // 这里只负责把底部「交办到 …」的项目名跟快照同步（项目被删时回到「未选项目」）。
  const renderProjects = () => { renderComposerTarget(); };

  /** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 月-日。 */
  const formatRelative = (value) => {
    const at = Date.parse(String(value ?? ''));
    if (!Number.isFinite(at)) return '';
    const diff = Date.now() - at;
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
    if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
    return new Date(at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  };

  const queueAction = async (action, success) => {
    try {
      const result = await action();
      await refresh();
      // refresh 可能被轮询占用而提前返回；队列单独重载一次，确保操作立刻可见。
      try {
        const snapshot = await window.companion.snapshot();
        view = { ...view, queue: snapshot.queue };
        renderQueue();
      } catch { /* 下一次轮询会补上 */ }
      if (success) toast(success(result), 4200);
      return result;
    } catch (error) {
      toast(String(error?.message ?? error), 6000);
      return null;
    }
  };

  // 想法池状态：复用队列状态机，只是文案按「想法」解释。
  const IDEA_STATUS = {
    todo: '新想法', doing: '讨论中', blocked: '搁置', done: '已采纳', failed: '失败'
  };
  const IDEA_SOURCE = { conversation: '对话', owner: '手动' };

  const renderQueue = () => {
    const list = $('queueList');
    if (!list) return;
    const items = (view?.queue ?? []).filter((item) => item.kind === 'idea');
    const active = items.filter((item) => ['todo', 'doing', 'blocked'].includes(item.status)).length;
    $('queueBadge').textContent = String(active);
    $('queueBadge').title = `共 ${items.length} 条想法`;
    list.replaceChildren();
    if (!items.length) {
      list.append(el('div', 'queue-empty', '还没有想法。和 Agent 讨论时提到的改进会自动收在这里。'));
      return;
    }
    for (const item of items) {
      const row = el('div', 'queue-item');
      row.dataset.id = item.id;
      row.dataset.status = item.status;
      const dot = el('span', 'queue-dot');
      const main = el('div', 'queue-main');
      const title = el('div', 'queue-title', item.title);
      const meta = el('div', 'queue-meta');
      meta.append(el('span', `queue-status ${item.status}`, IDEA_STATUS[item.status] ?? item.status));
      meta.append(el('span', 'queue-source', IDEA_SOURCE[item.source] ?? item.source));
      if (item.createdAt) meta.append(el('span', 'queue-time', formatRelative(item.createdAt) || ''));
      main.append(title, meta);
      const actions = el('div', 'queue-actions');
      if (item.status !== 'doing') {
        const discuss = el('button', 'queue-action primary', '讨论');
        discuss.type = 'button';
        discuss.onclick = () => {
          void window.companion.queue.update({ id: item.id, status: 'doing' }).then(() => refresh());
          void sendMessage(`讨论这条改进想法（只讨论，不要改代码）：${item.title}`, { capture: false });
        };
        actions.append(discuss);
      }
      if (item.status !== 'done') {
        const adopt = el('button', 'queue-action', '采纳');
        adopt.type = 'button';
        adopt.title = '标记为已采纳，便于以后整理';
        adopt.onclick = () => {
          void queueAction(() => window.companion.queue.update({ id: item.id, status: 'done' }), () => '已标记采纳');
        };
        actions.append(adopt);
      }
      if (item.status === 'todo' || item.status === 'doing') {
        const park = el('button', 'queue-action', '搁置');
        park.type = 'button';
        park.onclick = () => {
          void queueAction(() => window.companion.queue.update({ id: item.id, status: 'blocked' }), () => '已搁置');
        };
        actions.append(park);
      }
      if (item.status === 'blocked' || item.status === 'done') {
        const reopen = el('button', 'queue-action', '重开');
        reopen.type = 'button';
        reopen.onclick = () => {
          void queueAction(() => window.companion.queue.update({ id: item.id, status: 'todo' }), () => '已重新打开');
        };
        actions.append(reopen);
      }
      const remove = el('button', 'queue-action danger', '×');
      remove.type = 'button'; remove.title = '删除';
      remove.onclick = () => {
        void queueAction(() => window.companion.queue.remove({ id: item.id }), () => '已删除想法');
      };
      actions.append(remove);
      row.append(dot, main, actions);
      list.append(row);
    }
  };

  const addQueueItem = async () => {
    const input = $('queueInput');
    const title = String(input.value ?? '').trim();
    if (!title) return;
    const projectId = view?.config?.projectId ?? '';
    if (!projectId) { toast('先选择一个项目。'); return; }
    input.value = '';
    await queueAction(
      () => window.companion.queue.add({ projectId, title, kind: 'idea' }),
      () => '已记下想法'
    );
  };

  const DIAGRAM_LABELS = {
    dependency: '依赖图', control: '控制流图', dataflow: '数据流图',
    state: '状态图', sequence: '时序图'
  };
  const DIAGRAM_KINDS = ['dependency', 'control', 'dataflow', 'state', 'sequence'];
  let activeDiagramKind = 'dependency';
  let diagramRenderToken = 0;
  const autoDependencyProjects = new Set();
  // 正在生成的图谱：refresh 每 2 秒轮询一次，必须记住生成中状态，
  // 否则轮询会把「正在生成」覆盖回空状态，看起来像点了没反应。
  const diagramJobs = new Map();
  // 生成失败信息同样要跨轮询保留，用户才能看到错误并点重试。
  const diagramErrors = new Map();
  let diagramProjectId = '';
  if (window.mermaid) {
    window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
  }

  const currentDiagram = () => (view?.diagrams ?? []).find((item) => item.kind === activeDiagramKind) ?? null;

  const renderDiagramTabs = () => {
    const tabs = $('diagramTabs');
    tabs.replaceChildren();
    for (const kind of DIAGRAM_KINDS) {
      const button = el('button', `diagram-tab${kind === activeDiagramKind ? ' active' : ''}`, DIAGRAM_LABELS[kind]);
      button.type = 'button';
      button.dataset.kind = kind;
      button.onclick = () => {
        activeDiagramKind = kind;
        const diagram = currentDiagram();
        $('diagramScope').value = diagram?.scope ?? 'project';
        renderDiagrams();
      };
      tabs.append(button);
    }
  };

  const renderDiagramMeta = (diagram) => {
    const meta = $('diagramMeta');
    meta.replaceChildren();
    if (!diagram) return;
    const parts = [
      `v${diagram.version}`,
      diagram.confidence === 'high' ? '高置信' : diagram.confidence === 'low' ? '低置信' : '中置信',
      diagram.source || '未知来源',
      `更新于 ${formatRelative(diagram.generatedAt ?? diagram.updatedAt) || '—'}`
    ];
    if (diagram.stale) parts.push('代码已更新，建议重新生成');
    if (diagram.unknowns?.length) parts.push(`未知 ${diagram.unknowns.length} 项`);
    meta.textContent = parts.join(' · ');
    meta.title = (diagram.unknowns ?? []).join('\n');
  };

  const diagramLoadingText = (kind, startedAt) => {
    if (kind === 'dependency') return '正在扫描依赖…';
    const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    return `正在生成${DIAGRAM_LABELS[kind]}…已用 ${seconds}s，通常需要 30–120 秒`;
  };

  // Electron IPC 会给错误加一长串前缀，展示给用户前先去掉。
  const cleanIpcError = (value) => String(value ?? '')
    .replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/u, '')
    .trim();

  const renderDiagramSvg = async (diagram) => {
    const box = $('diagramView');
    const token = ++diagramRenderToken;
    const kind = activeDiagramKind;
    const job = diagramJobs.get(kind);
    const jobActive = job && job.projectId === (view?.config?.projectId ?? '');
    const errorMessage = diagramErrors.get(kind) ?? '';
    // 用 dataset 记录当前渲染的内容，避免 2 秒轮询把「生成中/失败」覆盖成空状态。
    const key = diagram
      ? `svg:${kind}:${diagram.version}:${diagram.mermaid.length}:${diagram.updatedAt ?? ''}`
      : jobActive ? `busy:${kind}` : errorMessage ? `error:${kind}` : `none:${kind}`;
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.dataset.view = kind;
    box.replaceChildren();
    if (!diagram) {
      if (jobActive) {
        box.append(el('div', 'diagram-loading', diagramLoadingText(kind, job.startedAt)));
        return;
      }
      const empty = el('div', 'diagram-empty');
      if (errorMessage) {
        empty.append(el('div', undefined, `生成失败：${errorMessage}`));
        const retry = el('button', 'primary small', '重试');
        retry.type = 'button';
        retry.onclick = () => { void generateDiagram(kind); };
        empty.append(retry);
      } else {
        empty.append(el('div', undefined, `还没有${DIAGRAM_LABELS[kind]}`));
        const generate = el('button', 'primary small',
          kind === 'dependency' ? '扫描依赖' : `生成${DIAGRAM_LABELS[kind]}`);
        generate.type = 'button';
        generate.onclick = () => { void generateDiagram(kind); };
        empty.append(generate);
      }
      box.append(empty);
      return;
    }
    box.append(el('div', 'diagram-loading', '正在渲染…'));
    if (!window.mermaid) {
      box.replaceChildren(el('pre', 'diff', diagram.mermaid));
      return;
    }
    try {
      const { svg } = await window.mermaid.render(`diagram-svg-${Date.now()}`, diagram.mermaid);
      if (token !== diagramRenderToken) return;
      box.innerHTML = svg;
    } catch (error) {
      if (token !== diagramRenderToken) return;
      box.replaceChildren(
        el('div', 'diagram-empty', `渲染失败：${String(error?.message ?? error)}`),
        el('pre', 'diff', diagram.mermaid)
      );
    }
  };

  const renderDiagrams = () => {
    const section = $('diagramSection');
    if (!section) return;
    const projectId = view?.config?.projectId ?? '';
    if (!projectId) { section.hidden = true; return; }
    section.hidden = false;
    if (diagramProjectId !== projectId) {
      diagramProjectId = projectId;
      diagramErrors.clear();
    }
    const generated = (view?.diagrams ?? []).length;
    $('diagramBadge').textContent = `${generated}/5`;
    $('diagramBadge').title = `已生成 ${generated} / 5 类图谱`;
    renderDiagramTabs();
    const diagram = currentDiagram();
    const busy = diagramJobs.get(activeDiagramKind)?.projectId === projectId;
    const scope = $('diagramScope');
    if (document.activeElement !== scope && !scope.value) scope.value = diagram?.scope ?? 'project';
    $('diagramGenerate').disabled = busy;
    $('diagramGenerate').textContent = busy ? '生成中…' : '生成/重新生成';
    $('diagramCopy').disabled = !diagram;
    $('diagramExport').disabled = !diagram;
    renderDiagramMeta(diagram);
    void renderDiagramSvg(diagram);
    // 轮询期间不要把正在生成的按钮重置成可点状态。
    if (busy) return;
    if (activeDiagramKind === 'dependency' && !diagram && !autoDependencyProjects.has(projectId)) {
      autoDependencyProjects.add(projectId);
      void generateDiagram('dependency', { silent: true });
    }
  };

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    }
  };

  const generateDiagram = async (kind, { silent = false } = {}) => {
    if (diagramJobs.has(kind)) {
      toast(`${DIAGRAM_LABELS[kind]}正在生成，请稍候。`, 2600);
      return null;
    }
    const projectId = view?.config?.projectId ?? '';
    if (!projectId) { toast('先选择一个项目。'); return null; }
    const scope = String($('diagramScope').value ?? '').trim() || 'project';
    const job = { startedAt: Date.now(), ticker: 0, projectId };
    diagramJobs.set(kind, job);
    diagramErrors.delete(kind);
    $('diagramGenerate').disabled = true;
    $('diagramGenerate').textContent = '生成中…';
    void renderDiagramSvg(currentDiagram());
    // 每秒刷新已用时间，让用户知道任务还在跑。
    job.ticker = window.setInterval(() => {
      if (kind !== activeDiagramKind) return;
      const node = $('diagramView').querySelector('.diagram-loading');
      if (node) node.textContent = diagramLoadingText(kind, job.startedAt);
    }, 1000);
    let saved = null;
    let failure = '';
    try {
      saved = kind === 'dependency'
        ? await window.companion.diagrams.dependency({ projectId })
        : await window.companion.diagrams.generate({ projectId, kind, scope });
    } catch (error) {
      failure = cleanIpcError(error?.message ?? error) || '未知错误';
      diagramErrors.set(kind, failure);
      toast(`生成${DIAGRAM_LABELS[kind]}失败：${failure}`, 8000);
    } finally {
      window.clearInterval(job.ticker);
      diagramJobs.delete(kind);
    }
    // 先把结果合并进本地视图，避免 refresh 正在轮询时新图迟迟不显示。
    if (saved?.kind && view && view.config?.projectId === projectId) {
      view.diagrams = [
        ...(view.diagrams ?? []).filter((item) => item.kind !== saved.kind),
        saved
      ];
    }
    renderDiagrams();
    void refresh();
    if (saved && !silent) {
      const primary = view?.config?.model ?? '';
      toast(saved.usedModel && saved.usedModel !== primary
        ? `${DIAGRAM_LABELS[kind]}已生成（使用 ${saved.usedModel}）`
        : `${DIAGRAM_LABELS[kind]}已生成`, 5200);
    }
    return saved ?? null;
  };

  $('diagramGenerate').onclick = () => { void generateDiagram(activeDiagramKind); };
  $('diagramCopy').onclick = async () => {
    const diagram = currentDiagram();
    if (!diagram) return;
    const ok = await copyText(diagram.mermaid);
    toast(ok ? 'Mermaid 已复制' : '复制失败，请手动选择', 3000);
  };
  $('diagramExport').onclick = () => {
    const svg = document.querySelector('#diagramView svg');
    if (!svg) { toast('还没有可导出的图。'); return; }
    const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `owner-diagram-${activeDiagramKind}.svg`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  };

  const knowledgeCache = new Map();
  const summaryLoading = new Set();
  const githubActivityCache = new Map();
  const githubLoading = new Set();

  const openGithub = (url) => {
    if (!url) return;
    void window.companion.openExternal(url)
      .catch((error) => toast(String(error?.message ?? error)));
  };

  const githubRow = (kind, item) => {
    const row = el('button', 'github-item');
    row.type = 'button';
    row.append(el('span', `github-kind ${kind}`, kind === 'issue' ? `#${item.number}` : `PR #${item.number}`));
    row.append(el('span', 'github-item-title', item.title || '（无标题）'));
    row.append(el('span', 'github-item-time', formatRelative(item.updatedAt) || ''));
    row.onclick = () => openGithub(item.url);
    return row;
  };

  const loadGithubActivity = async (projectId) => {
    if (!projectId || githubLoading.has(projectId)) return;
    githubLoading.add(projectId);
    try {
      const data = await window.companion.github.activity({ projectId });
      githubActivityCache.set(projectId, data);
      if ((view?.config?.projectId ?? '') === projectId) renderProjectGithub();
    } catch (error) {
      githubActivityCache.set(projectId, {
        linked: true, issues: [], prs: [], issueCount: 0, prCount: 0,
        error: String(error?.message ?? error)
      });
      if ((view?.config?.projectId ?? '') === projectId) renderProjectGithub();
    } finally {
      githubLoading.delete(projectId);
    }
  };

  /** 当前项目的 GitHub Issues / PR（只读）。 */
  const renderProjectGithub = () => {
    const box = $('githubPanel');
    if (!box) return;
    const projectId = view?.config?.projectId ?? '';
    const project = (view?.projects ?? []).find((item) => item.id === projectId);
    if (!project?.github) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.replaceChildren();
    const data = githubActivityCache.get(projectId);
    const head = el('div', 'github-head');
    head.append(el('span', 'github-title', 'GitHub'));
    const repo = el('button', 'github-repo', project.github.nameWithOwner);
    repo.type = 'button';
    repo.title = '在浏览器打开仓库';
    repo.onclick = () => openGithub(project.github.url);
    head.append(repo);
    if (data) {
      head.append(el('span', 'github-count', `Issues ${data.issueCount >= 20 ? '20+' : data.issueCount}`));
      head.append(el('span', 'github-count', `PR ${data.prCount >= 20 ? '20+' : data.prCount}`));
    }
    box.append(head);
    if (!data) {
      box.append(el('div', 'github-empty', '正在读取 Issues / PR…'));
      void loadGithubActivity(projectId);
      return;
    }
    if (data.error) box.append(el('div', 'github-empty', data.error));
    if (!data.issues?.length && !data.prs?.length) {
      if (!data.error) box.append(el('div', 'github-empty', '没有打开的 Issues 或 PR。'));
      return;
    }
    const list = el('div', 'github-list');
    for (const issue of data.issues ?? []) list.append(githubRow('issue', issue));
    for (const pr of data.prs ?? []) list.append(githubRow('pr', pr));
    box.append(list);
  };

  const knowledgeForProject = (projectId) => {
    const cached = knowledgeCache.get(projectId);
    if (cached) return cached;
    if (view?.knowledge && view.knowledge.projectId === projectId) return view.knowledge;
    return null;
  };

  const loadProjectSummary = async (projectId) => {
    if (!projectId || summaryLoading.has(projectId)) return;
    summaryLoading.add(projectId);
    try {
      const data = await window.companion.knowledge.summary({ projectId });
      knowledgeCache.set(projectId, data);
      if ((view?.config?.projectId ?? '') === projectId) renderProjectSummary();
    } catch { /* 知识库不可用时不阻塞项目列表 */ }
    finally { summaryLoading.delete(projectId); }
  };

  /** 项目画像：普通用户视角的“是什么 / 怎么跑 / 怎么验收”。 */
  const renderProjectBrief = () => {
    const box = $('projectBrief');
    if (!box) return;
    const projectId = view?.config?.projectId ?? '';
    const project = (view?.projects ?? []).find((item) => item.id === projectId);
    if (!project) {
      box.hidden = true;
      return;
    }
    const brief = view?.brief;
    box.hidden = false;
    box.replaceChildren();
    const head = el('div', 'brief-head');
    head.append(el('span', 'brief-title', '项目画像'));
    if (brief?.stale) head.append(el('span', 'brief-badge warn', '已过期'));
    else if (brief) {
      head.append(el('span', 'brief-badge', `更新于 ${formatRelative(brief.generatedAt) || '—'}`));
    }
    const action = el('button', 'ghost small', brief ? '重新理解' : '一键理解');
    action.type = 'button';
    action.title = '快速扫描 README / package.json / 目录结构，不调用模型';
    action.onclick = () => { void generateBrief(false); };
    head.append(action);
    const deep = el('button', 'ghost small', '深度理解');
    deep.type = 'button';
    deep.title = '调用模型做完整结构走读；耗时较长，可取消';
    deep.onclick = () => { void generateBrief(true); };
    head.append(deep);
    box.append(head);
    if (!brief) {
      box.append(el('div', 'brief-empty',
        '还没有项目画像。一键理解会看代码和文档，给出“是什么、怎么跑、关键模块、怎么验收”。'));
      return;
    }
    box.append(el('div', 'brief-one', brief.oneLiner || ''));
    if (brief.whatItIs && brief.whatItIs !== brief.oneLiner) {
      box.append(el('div', 'brief-text', brief.whatItIs));
    }
    const section = (label, content) => {
      const row = el('div', 'brief-row');
      row.append(el('span', 'brief-label', label));
      row.append(content);
      box.append(row);
    };
    if (brief.howToRun?.length) {
      const list = el('span', 'brief-chips');
      for (const item of brief.howToRun.slice(0, 4)) list.append(el('code', 'brief-chip', item));
      section('怎么跑', list);
    }
    if (brief.modules?.length) {
      const list = el('span', 'brief-modules');
      for (const module of brief.modules.slice(0, 3)) {
        list.append(el('span', 'brief-module', `${module.name}${module.role ? ` · ${module.role}` : ''}`));
      }
      section('关键模块', list);
    }
    if (brief.verify?.commands?.length) {
      const list = el('span', 'brief-chips');
      for (const command of brief.verify.commands.slice(0, 3)) {
        list.append(el('code', 'brief-chip', command));
      }
      section('怎么验收', list);
    }
    if (brief.risks?.length) {
      section('风险', el('span', 'brief-text', brief.risks.slice(0, 2).join('；')));
    }
    if (brief.unknowns?.length) {
      section('还不确定', el('span', 'brief-text', brief.unknowns.slice(0, 2).join('；')));
    }
    const details = el('details', 'brief-details');
    details.append(el('summary', undefined, '查看依据与版本'));
    details.append(el('div', 'brief-evidence',
      `依据：${(brief.evidence ?? []).slice(0, 8).join(' · ') || '—'}`));
    details.append(el('div', 'brief-evidence',
      `来源：${brief.generatedFrom === 'local-scan' ? '本地快速扫描' : '模型深度分析'} · 版本 r${brief.version ?? 1} · 基于 ${String(brief.basedOnCommit ?? '').slice(0, 8) || '—'}`));
    box.append(details);
  };

  /** 一键理解：默认本地快速画像；deep=true 才跑模型结构走读。 */
  const generateBrief = async (deep = false) => {
    const projectId = view?.config?.projectId ?? '';
    if (!projectId) { toast('先选择一个项目。'); return; }
    if (deep) {
      if (!playbookCatalog?.skillsAvailable) { toast('未找到 pstack skills 目录。'); return; }
      void runPlaybook('how', { brief: true });
      return;
    }
    try {
      await window.companion.projectBrief.local({ projectId });
      await refresh();
      toast('已生成项目画像（快速扫描）', 4200);
    } catch (error) {
      toast(String(error?.message ?? error), 6000);
    }
  };

  const openKnowledgeTidy = async () => {
    const projectId = view?.config?.projectId ?? '';
    if (!projectId) { toast('先选择一个项目。'); return; }
    try {
      const report = await window.companion.knowledge.tidy({ projectId });
      const counts = report.counts ?? {};
      const nodes = [
        el('p', 'result-summary',
          `重复 ${counts.duplicates ?? 0} 组 · 需复核 ${counts.stale ?? 0} 条 · 冲突 ${counts.conflicts ?? 0} 条 · 未验证 ${counts.unverified ?? 0} 条`),
        el('p', 'pending-summary', '整理只做扫描和建议，不会自动合并、删除或改写知识。')
      ];
      if (report.duplicates?.length) {
        nodes.push(el('div', 'section-title', '可能重复'));
        for (const pair of report.duplicates) {
          nodes.push(el('div', 'tidy-item',
            `${pair.a.title}  ↔  ${pair.b.title}（相似度 ${pair.score}）`));
        }
      }
      if (report.stale?.length) {
        nodes.push(el('div', 'section-title', '需要复核'));
        for (const item of report.stale) nodes.push(el('div', 'tidy-item', item.title));
      }
      if (report.conflicts?.length) {
        nodes.push(el('div', 'section-title', '冲突'));
        for (const item of report.conflicts) nodes.push(el('div', 'tidy-item', item.title));
      }
      if (!counts.duplicates && !counts.stale && !counts.conflicts && !counts.unverified) {
        nodes.push(el('p', 'pending-summary', '知识库很干净，没有需要整理的内容。'));
      }
      const close = el('button', 'ghost', '关闭');
      close.onclick = closeModal;
      const open = el('button', 'primary', '去知识库处理');
      open.onclick = () => {
        closeModal();
        void window.companion.knowledge.open().catch((error) => toast(String(error?.message ?? error)));
      };
      openModal('整理项目知识', nodes, [close, open]);
    } catch (error) {
      toast(String(error?.message ?? error), 6000);
    }
  };

  /** 下一步建议：只展示一个最值得做的动作。 */
  const renderNextAction = () => {
    const box = $('nextActionCard');
    if (!box) return;
    const action = view?.nextAction;
    if (!action) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.dataset.tone = action.tone ?? 'muted';
    box.replaceChildren();
    const text = el('div', 'next-action-text');
    text.append(el('div', 'next-action-label', action.label));
    if (action.detail) text.append(el('div', 'next-action-detail', action.detail));
    box.append(text);
    const labels = {
      understand: '开始理解', tidy: '去整理', decide: '去处理',
      queue: '去交办', deliver: '创建 PR', inspect: '查看结果', compose: '去交办', wait: '进行中'
    };
    const button = el('button', 'primary small', labels[action.command] ?? '去做');
    button.type = 'button';
    if (action.command === 'wait') button.disabled = true;
    button.onclick = () => {
      if (action.command === 'understand') void generateBrief(false);
      else if (action.command === 'tidy') void openKnowledgeTidy();
      else if (action.command === 'queue') {
        $('queueSection')?.scrollIntoView({ block: 'start' });
        $('queueInput')?.focus();
      } else if (action.command === 'decide') {
        const section = $('needsSection');
        if (section && !section.hidden) section.scrollIntoView({ block: 'start' });
      } else if (action.command === 'deliver') {
        if (action.cycleId) void openPrPreview(action.cycleId);
        else $('resultSection')?.scrollIntoView({ block: 'start' });
      } else if (action.command === 'inspect') {
        if (view?.result?.cycleId) void openResult(view.result.cycleId);
      } else if (action.command === 'compose') {
        $('composeSection')?.scrollIntoView({ block: 'center' });
        $('taskInput')?.focus();
      }
    };
    box.append(button);
  };

  const renderProjectSummary = () => {
    const box = $('projectSummary');
    if (!box) return;
    const projectId = view?.config?.projectId ?? '';
    const project = (view?.projects ?? []).find((item) => item.id === projectId);
    if (!projectId || !project) {
      box.hidden = true;
      return;
    }
    const data = knowledgeForProject(projectId);
    box.hidden = false;
    box.replaceChildren();

    const head = el('div', 'summary-head');
    head.append(el('span', 'summary-title', '知识摘要'));
    head.append(el('span', 'summary-meta',
      data?.lastKnowledgeAt ? `更新于 ${formatRelative(data.lastKnowledgeAt)}` : ''));
    const openAll = el('button', 'ghost small', '完整知识库');
    openAll.type = 'button';
    openAll.onclick = () => {
      void window.companion.knowledge.open().catch((error) => toast(String(error?.message ?? error)));
    };
    head.append(openAll);
    box.append(head);

    if (!data) {
      box.append(el('div', 'summary-empty', '正在读取知识摘要…'));
      void loadProjectSummary(projectId);
      return;
    }
    if (!data.available) {
      box.append(el('div', 'summary-empty', '知识库尚未建立；完成一次任务后会自动采集经验。'));
      return;
    }

    const counts = data.counts ?? {};
    const chips = el('div', 'summary-chips');
    chips.append(
      el('span', 'summary-chip', `经验 ${counts.lessons ?? 0}`),
      el('span', 'summary-chip', `知识 ${counts.knowledge ?? 0}`),
      el('span', 'summary-chip ok', `已验证 ${counts.verified ?? 0}`),
      el('span', 'summary-chip', `候选 ${counts.candidates ?? 0}`),
      el('span', 'summary-chip', `复用 ${counts.usages ?? 0}`)
    );
    box.append(chips);

    const units = data.topKnowledge ?? [];
    if (units.length) {
      const list = el('div', 'summary-items');
      for (const unit of units) {
        const item = el('button', 'summary-item');
        item.type = 'button';
        item.title = unit.title;
        const dot = el('span', 'summary-dot');
        dot.dataset.status = unit.status ?? 'unverified';
        item.append(
          dot,
          el('span', 'summary-item-text', unit.title),
          el('span', 'summary-time', formatRelative(unit.updatedAt) || '')
        );
        item.onclick = () => { void openKnowledgeDetail(unit.id); };
        list.append(item);
      }
      box.append(list);
    } else {
      const lessons = (data.recentLessons ?? []).slice(0, 3);
      if (lessons.length) {
        const list = el('div', 'summary-items');
        for (const lesson of lessons) {
          const item = el('div', 'summary-item static');
          const dot = el('span', 'summary-dot');
          dot.dataset.status = lesson.status === 'verified' ? 'verified'
            : lesson.status === 'unverified' ? 'unverified' : 'inferred';
          item.append(
            dot,
            el('span', 'summary-item-text', lesson.title),
            el('span', 'summary-time', formatRelative(lesson.createdAt) || '')
          );
          list.append(item);
        }
        box.append(list);
      } else {
        box.append(el('div', 'summary-empty',
          '还没有经验；完成任务后可以从执行记录提炼「现象 → 机制 → 对策」。'));
      }
    }

    if (data.tags?.length) {
      const tags = el('div', 'summary-tags');
      for (const item of data.tags) tags.append(el('span', 'summary-tag', `#${item.tag}`));
      box.append(tags);
    }

    if ((counts.candidates ?? 0) > 0) {
      const candidateRow = el('button', 'summary-candidate');
      candidateRow.type = 'button';
      candidateRow.append(
        el('span', undefined, `候选 ${counts.candidates} 条待审核`),
        el('span', 'summary-candidate-go', '去知识库')
      );
      candidateRow.onclick = () => {
        void window.companion.knowledge.open().catch((error) => toast(String(error?.message ?? error)));
      };
      box.append(candidateRow);
    }

    const foot = el('div', 'summary-foot');
    foot.append(el('span', 'summary-shared',
      `共享知识 ${counts.sharedKnowledge ?? 0} 条（已验证 ${counts.sharedVerified ?? 0}）`));
    box.append(foot);
  };

  const detailRows = (rows) => {
    const list = el('dl', 'detail-rows');
    for (const [label, value] of rows) {
      list.append(el('dt', undefined, label));
      list.append(el('dd', undefined, value));
    }
    return list;
  };

  const openModal = (title, bodyNodes, footNodes) => {
    $('modalTitle').textContent = title;
    $('modalBody').replaceChildren(...bodyNodes);
    $('modalFoot').replaceChildren(...footNodes);
    $('modal').hidden = false;
  };
  const closeModal = () => { $('modal').hidden = true; };

  const runDecision = async (input, successText = '') => {
    try {
      const result = await window.companion.decide(input);
      closeModal();
      await refresh();
      if (successText) toast(successText);
      return { ok: true, result };
    } catch (error) {
      toast(String(error?.message ?? error), 5000);
      return { ok: false, error };
    }
  };

  const showSandboxFailure = (result, proposalId) => {
    const missing = result?.testConfig?.missing ?? [];
    const nodes = [
      el('p', 'result-summary',
        '补丁已经应用，但测试没有创建。补齐测试配置后可以在这里重试，不必重新应用补丁。'),
      detailRows([
        ['补丁状态', '已应用'],
        ['测试创建', '失败'],
        ['原因', result?.sandboxError || '未知错误'],
        ['缺少文件', missing.join(', ') || '—']
      ]),
      el('p', 'pending-summary',
        'node-smoke 固定运行 tests/sandbox-smoke.test.mjs；也可以在设置里调整快照包含的文件。')
    ];
    const later = el('button', 'ghost', '稍后处理');
    later.onclick = closeModal;
    const configure = el('button', 'ghost', '打开测试配置');
    configure.onclick = () => { closeModal(); void openSettings(); };
    const retry = el('button', 'primary', '重试创建测试');
    retry.onclick = async () => {
      retry.disabled = true;
      try {
        await window.companion.createSandbox({ proposalId });
        closeModal();
        toast('测试已创建，等你批准后运行');
        await refresh();
      } catch (error) {
        retry.disabled = false;
        toast(String(error?.message ?? error), 6000);
      }
    };
    openModal('补丁已应用，但测试未创建', nodes, [later, configure, retry]);
  };

  const confirmDecision = ({ title, rows, hash, confirmLabel, success, input, reason, extraNodes = [] }) => {
    const nodes = [detailRows(rows), ...extraNodes];
    if (hash) nodes.push(el('pre', 'diff', `hash: ${hash}`));
    const wrap = el('label', 'confirm-row');
    const checkbox = el('input');
    checkbox.type = 'checkbox';
    wrap.append(checkbox, el('span', undefined, '我已核对上面的信息，确认继续。'));
    nodes.push(wrap);
    if (reason) {
      const textarea = el('textarea');
      textarea.rows = 2;
      textarea.placeholder = '拒绝原因（可选）';
      textarea.id = 'rejectReason';
      nodes.push(textarea);
    }
    const cancel = el('button', 'ghost', '取消');
    cancel.onclick = closeModal;
    const confirm = el('button', 'primary', confirmLabel);
    confirm.disabled = true;
    checkbox.onchange = () => { confirm.disabled = !checkbox.checked; };
    confirm.onclick = () => {
      const payload = { ...input };
      if (reason) payload.reason = $('rejectReason')?.value?.trim() ?? '';
      void runDecision(payload, success);
    };
    openModal(title, nodes, [cancel, confirm]);
  };

  const openPatch = async (item) => {
    try {
      const patch = await window.companion.patchDetail({ id: item.id });
      const applying = item.kind === 'patch-apply' || patch.status === 'approved';
      const rows = [
        ['Proposal', patch.id],
        ['Status', patch.status],
        ['Base', patch.base_sha ?? '—'],
        ['Proposal hash', patch.proposal_hash ?? '—'],
        ['Approved hash', patch.approved_hash ?? '—'],
        ['Paths', (patch.files ?? []).map((file) => file.path).join(', ') || '—']
      ];
      const nodes = [detailRows(rows)];
      if (patch.proposal_diff) {
        nodes.push(el('div', 'section-title', '冻结 Diff'));
        nodes.push(el('pre', 'diff', patch.proposal_diff));
      }
      const wrap = el('label', 'confirm-row');
      const checkbox = el('input');
      checkbox.type = 'checkbox';
      wrap.append(checkbox, el('span', undefined, '我已审阅上面的 Diff 与 hash。'));
      nodes.push(wrap);
      const cancel = el('button', 'ghost', '取消');
      cancel.onclick = closeModal;
      const approve = el('button', 'primary', applying ? '应用并请求测试' : '批准补丁');
      approve.disabled = true;
      checkbox.onchange = () => { approve.disabled = !checkbox.checked; };
      approve.onclick = async () => {
        const kind = applying ? 'patch-apply' : 'patch';
        const outcome = await runDecision({
          kind,
          id: patch.id,
          hash: patch.proposal_hash,
          action: 'approve'
        });
        if (!outcome.ok) return;
        if (!applying) {
          toast('补丁已批准；再次审阅即可应用');
          return;
        }
        if (outcome.result?.testSkipped) {
          toast('补丁已应用；按当前沙箱设置跳过测试（仅人工验证）', 6000);
          await refresh();
          return;
        }
        if (outcome.result?.testRequested === false) {
          showSandboxFailure(outcome.result, patch.id);
          return;
        }
        toast('补丁已应用，测试已创建，等你批准后运行');
      };
      openModal(applying ? '应用补丁' : '审阅补丁', nodes, [cancel, approve]);
    } catch (error) {
      toast(String(error?.message ?? error), 5000);
    }
  };

  const knowledgeItem = (item) => {
    const button = el('button', 'knowledge-item');
    button.type = 'button';
    button.append(el('strong', undefined, item.title));
    button.append(el('span', undefined,
      `${item.type === 'lesson' ? '经验' : item.type === 'candidate' ? '候选' : '知识'} · ` +
      `${item.status ?? 'unknown'}${item.layer ? ` · ${item.layer}` : ''}` +
      `${item.revision ? ` · r${item.revision}` : ''}`));
    if (item.detail) button.append(el('span', undefined, item.detail));
    button.onclick = () => { void openKnowledgeDetail(item.id); };
    return button;
  };

  const openKnowledgeDetail = async (id) => {
    try {
      const data = await window.companion.knowledge.detail({ id });
      const nodes = [];
      if (data.kind === 'knowledge') {
        nodes.push(el('p', 'result-summary', data.item.content));
        nodes.push(detailRows([
          ['层级', data.item.layer],
          ['范围', data.item.scope === 'project' ? `项目 ${data.item.projectId}` : data.item.scope],
          ['验证', data.item.verificationStatus],
          ['版本', `r${data.item.revision}`],
          ['证据', String((data.item.evidenceRefs ?? []).length)],
          ['复用', String(data.usages.length)]
        ]));
        if (data.item.evidenceRefs?.length) nodes.push(el('pre', 'diff', data.item.evidenceRefs.join('\n')));
        if (data.usages.length) {
          nodes.push(el('div', 'section-title', '复用记录'));
          nodes.push(el('pre', 'diff', data.usages.map((usage) =>
            `${usage.projectId} · ${usage.observedBenefit} · ${usage.targetRunId}`).join('\n')));
        }
      } else if (data.kind === 'lesson') {
        nodes.push(el('p', 'result-summary', data.item.phenomenon));
        nodes.push(detailRows([
          ['项目', data.item.projectId],
          ['作用域', data.item.scope?.layer === 'domain' ? '领域共享' : '项目'],
          ['状态', data.item.verificationStatus],
          ['来源记录', data.item.sourceRecordId],
          ['创建', data.item.createdAt]
        ]));
        for (const [title, values] of [
          ['机制', [data.item.mechanism]],
          ['对策', [data.item.countermeasure]],
          ['已观察事实', data.item.facts ?? []],
          ['模型推断', data.item.inferences ?? []],
          ['未知', data.item.unknowns ?? []]
        ]) {
          const lines = (values ?? []).filter(Boolean);
          if (!lines.length) continue;
          nodes.push(el('div', 'section-title', title));
          nodes.push(el('pre', 'diff', lines.join('\n')));
        }
        const evidence = data.evidence ?? [];
        if (evidence.length) {
          nodes.push(el('div', 'section-title', '证据'));
          nodes.push(el('pre', 'diff', evidence.map((item) =>
            `${item.ref}${item.kind ? ` · ${item.kind}` : ''}${item.excerpt ? `\n${item.excerpt}` : ''}`).join('\n\n')));
        }
      } else {
        nodes.push(detailRows([
          ['候选', data.item.payload?.title ?? data.item.id],
          ['层级', data.item.payload?.layer],
          ['状态', data.item.status],
          ['置信度', String(data.item.meta?.confidence ?? 'unknown')]
        ]));
        nodes.push(el('p', 'pending-summary', '候选需要人工审阅；关闭详情后可在列表里直接接受或拒绝。'));
      }
      const close = el('button', 'ghost', '关闭');
      close.onclick = closeModal;
      const workbench = el('button', 'primary', '完整知识库');
      workbench.onclick = () => { closeModal(); void window.companion.knowledge.open(); };
      openModal('知识详情', nodes, [close, workbench]);
    } catch (error) {
      toast(String(error?.message ?? error), 5000);
    }
  };

  const askKnowledge = async (kind) => {
    try {
      const result = await window.companion.knowledge.ask({
        kind,
        projectId: view?.config?.projectId ?? '',
        domain: view?.config?.domain ?? ''
      });
      const nodes = [el('p', 'result-summary', result.answer)];
      if (result.items?.length) {
        const list = el('div', 'knowledge-list');
        for (const item of result.items.slice(0, 12)) list.append(knowledgeItem(item));
        nodes.push(list);
      }
      const close = el('button', 'ghost', '关闭');
      close.onclick = closeModal;
      const workbench = el('button', 'primary', '完整知识库');
      workbench.onclick = () => { closeModal(); void window.companion.knowledge.open(); };
      openModal(kind === 'today' ? '今天学到了什么' : kind === 'verified' ? '验证与复用' : '知识', nodes, [close, workbench]);
    } catch (error) {
      toast(String(error?.message ?? error), 5000);
    }
  };

  // ---- pstack Playbook ----

  let playbookCatalog = null;
  let playbookBusy = false;
  let playbookCurrent = null;
  let playbookProjectId = '';
  let playbookRunningId = '';
  let playbookTimer = null;
  let playbookStartedAt = 0;

  const playbookLabelOf = (id) => {
    for (const group of playbookCatalog?.groups ?? []) {
      const found = group.items.find((item) => item.id === id);
      if (found) return found.label;
    }
    return id;
  };

  // 一键“运行 + 沉淀”的预设：覆盖项目理解、结构、根因、验收四类知识。
  const DISTILL_PRESETS = Object.freeze([
    'reflect',
    'how',
    'principle-fix-root-causes',
    'verify-app'
  ]);

  const playbookButtonState = (busy) => {
    for (const button of document.querySelectorAll('.playbook-btn, .distill-chip')) {
      button.disabled = busy || !playbookCatalog?.skillsAvailable;
    }
    const reflect = $('reflectDistill');
    if (reflect) reflect.disabled = busy || !playbookCatalog?.skillsAvailable;
  };

  const renderDistillPresets = () => {
    const box = $('distillPresets');
    if (!box) return;
    box.replaceChildren();
    box.append(el('span', 'distill-presets-label', '一键沉淀'));
    for (const id of DISTILL_PRESETS) {
      const button = el('button', 'distill-chip', playbookLabelOf(id));
      button.type = 'button';
      button.dataset.playbook = id;
      button.title = `运行「${playbookLabelOf(id)}」并自动沉淀为项目知识候选`;
      button.onclick = () => { reflectAndDistill(id); };
      box.append(button);
    }
  };

  const renderPlaybookButtons = () => {
    const container = $('playbookGroups');
    container.replaceChildren();
    if (!playbookCatalog) return;
    if (!playbookCatalog.skillsAvailable) {
      $('playbookHint').textContent = '未找到 pstack skills 目录；设置 PSTACK_DIR 后再试。';
      return;
    }
    $('playbookHint').textContent = '一键只读分析所选项目；改动会先生成提案等你批准。';
    for (const group of playbookCatalog.groups) {
      const wrap = el('div', 'playbook-group');
      wrap.append(el('span', 'playbook-group-label', group.label));
      const grid = el('div', 'playbook-grid');
      for (const item of group.items) {
        const button = el('button', 'playbook-btn', item.label);
        button.type = 'button';
        button.title = `${item.title}\n${item.hint}`;
        button.dataset.playbook = item.id;
        const last = playbookCatalog.lastRuns?.[item.id];
        if (last) button.classList.add(last.status === 'ok' ? 'has-run' : 'has-error');
        button.onclick = () => { void runPlaybook(item.id); };
        grid.append(button);
      }
      wrap.append(grid);
      container.append(wrap);
    }
    playbookButtonState(false);
  };

  const playbookEvidenceChips = (finding) => {
    if (!finding.evidence?.length) return null;
    const wrap = el('div', 'playbook-evidence');
    for (const ref of finding.evidence.slice(0, 4)) {
      const check = finding.evidenceChecks?.find((item) => item.ref === ref);
      const chip = el('span', `evidence-chip ${check?.exists === false ? 'missing' : 'ok'}`, ref);
      chip.title = check?.exists === false ? '该路径在项目里不存在，结论可能不可靠' : '路径已存在';
      wrap.append(chip);
    }
    return wrap;
  };

  const renderPlaybookResult = () => {
    const box = $('playbookResult');
    if (!playbookCurrent) { box.hidden = true; box.replaceChildren(); return; }
    const result = playbookCurrent;
    box.hidden = false;
    box.replaceChildren();
    box.append(el('div', 'playbook-result-head',
      `${result.playbookLabel} · ${result.status === 'ok' ? `${result.durationMs} ms` : '失败'}`));
    box.append(el('p', 'playbook-summary', result.summary));
    for (const finding of (result.findings ?? []).slice(0, 3)) {
      const row = el('div', 'playbook-finding');
      row.append(el('strong', undefined, finding.title));
      if (finding.detail) row.append(el('span', undefined, finding.detail));
      const chips = playbookEvidenceChips(finding);
      if (chips) row.append(chips);
      box.append(row);
    }
    if ((result.findings ?? []).length > 3) {
      box.append(el('span', 'playbook-more', `还有 ${result.findings.length - 3} 条，见完整报告`));
    }
    const actions = el('div', 'playbook-actions');
    if (result.status !== 'ok') {
      if (result.advice) {
        box.append(el('p', 'playbook-advice', result.advice));
      }
      const retry = el('button', 'primary small', '重试');
      retry.onclick = () => { void runPlaybook(result.playbookId); };
      actions.append(retry);
    }
    const full = el('button', 'ghost small', '完整报告');
    full.onclick = () => { void openPlaybookReport(result.runId); };
    actions.append(full);
    if (result.status === 'ok' && result.summary) {
      const distill = el('button', 'primary small', '沉淀为项目知识');
      distill.title = '把这次只读分析的结论写成项目知识候选（未验证，需你审核）';
      distill.onclick = () => { void distillPlaybook(result); };
      actions.append(distill);
      const propose = el('button', 'ghost small', '生成改动提案');
      propose.onclick = () => { confirmPlaybookProposal(result); };
      actions.append(propose);
    }
    box.append(actions);
  };

  /** pstack 结果 → 项目知识候选（pending），不自动验证、不写文件。 */
  const distillPlaybook = async (result) => {
    const projectId = playbookProjectId || view?.config?.projectId || '';
    if (!projectId) { toast('先选择一个项目。'); return; }
    try {
      const saved = await window.companion.playbooks.distill({
        projectId,
        playbookId: result.playbookId,
        runId: result.runId,
        summary: result.summary,
        findings: result.findings ?? [],
        risks: result.risks ?? [],
        nextSteps: result.nextSteps ?? []
      });
      knowledgeCache.delete(projectId);
      await refresh();
      toast(saved?.duplicate ? '这条结果已经在知识候选里' : '已加入项目知识候选（未验证）', 4000);
    } catch (error) {
      toast(String(error?.message ?? error), 6000);
    }
  };

  const openPlaybookReport = async (runId) => {
    try {
      const report = await window.companion.playbooks.report({ runId });
      const nodes = [
        el('p', 'result-summary', report.summary),
        detailRows([
          ['Playbook', `${report.playbookLabel} (${report.playbookId})`],
          ['项目', report.projectId],
          ['模型', report.model],
          ['耗时', `${report.durationMs} ms`],
          ['格式', report.format ?? 'unknown'],
          ['文本哈希', fmtHash(report.textHash)]
        ])
      ];
      if (report.findings?.length) {
        nodes.push(el('div', 'section-title', '关键发现'));
        for (const finding of report.findings) {
          const row = el('div', 'playbook-finding');
          row.append(el('strong', undefined, finding.title));
          if (finding.detail) row.append(el('span', undefined, finding.detail));
          const chips = playbookEvidenceChips(finding);
          if (chips) row.append(chips);
          nodes.push(row);
        }
      }
      if (report.risks?.length) {
        nodes.push(el('div', 'section-title', '风险与未知'));
        nodes.push(el('pre', 'diff', report.risks.join('\n')));
      }
      if (report.nextSteps?.length) {
        nodes.push(el('div', 'section-title', '建议下一步'));
        nodes.push(el('pre', 'diff', report.nextSteps.join('\n')));
      }
      if (report.text) {
        nodes.push(el('div', 'section-title', '模型原始输出'));
        nodes.push(el('pre', 'diff', report.text.slice(0, 6000)));
      }
      const close = el('button', 'ghost', '关闭');
      close.onclick = closeModal;
      openModal(`${report.playbookLabel} · 完整报告`, nodes, [close]);
    } catch (error) {
      toast(String(error?.message ?? error), 5000);
    }
  };

  const confirmPlaybookProposal = (result) => {
    const nodes = [
      el('p', 'result-summary',
        '这一步会创建任务并生成补丁提案；在你批准前不会改动任何文件。'),
      el('p', 'pending-summary', result.summary),
      el('p', 'pending-summary',
        `批准后由 Worker 生成补丁，再经你二次批准才会应用到项目，并进入沙箱验证。`)
    ];
    const cancel = el('button', 'ghost', '取消');
    cancel.onclick = closeModal;
    const confirm = el('button', 'primary', '创建提案任务');
    confirm.onclick = async () => {
      confirm.disabled = true;
      try {
        const created = await window.companion.playbooks.propose({
          playbookId: result.playbookId,
          projectId: view?.config?.projectId ?? '',
          summary: result.summary
        });
        closeModal();
        const missing = created?.testConfig?.missing ?? [];
        toast(missing.length
          ? `任务已创建，等你批准；测试配置还缺 ${missing.join(', ')}`
          : '任务已创建，等你批准后才会生成补丁。', 5200);
        await refresh();
      } catch (error) {
        confirm.disabled = false;
        toast(String(error?.message ?? error), 6000);
      }
    };
    openModal('生成改动提案（需要你批准）', nodes, [cancel, confirm]);
  };

  const runPlaybook = async (id, { distill = false, brief = false } = {}) => {
    if (playbookBusy) { toast('上一个 playbook 还在运行。'); return; }
    if (!playbookCatalog?.skillsAvailable) { toast('未找到 pstack skills 目录。'); return; }
    const projectId = view?.config?.projectId ?? '';
    if (!projectId) { toast('先选择一个项目。'); return; }
    playbookBusy = true;
    playbookRunningId = id;
    playbookStartedAt = Date.now();
    playbookButtonState(true);
    $('playbookCancel').hidden = false;
    const tick = () => {
      const seconds = Math.round((Date.now() - playbookStartedAt) / 1000);
      $('playbookHint').textContent = brief
        ? `正在理解项目「${playbookLabelOf(id)}」· ${seconds}s（只读，可取消）`
        : distill
          ? `正在复盘并沉淀「${playbookLabelOf(id)}」· ${seconds}s（只读，可取消）`
          : `正在运行「${playbookLabelOf(id)}」· ${seconds}s（只读，可取消）`;
    };
    tick();
    playbookTimer = window.setInterval(tick, 1000);
    try {
      const result = await window.companion.playbooks.run({ playbookId: id, projectId, distill, brief });
      playbookCurrent = result;
      playbookProjectId = projectId;
      renderPlaybookResult();
      if (result.status !== 'ok') {
        toast(result.summary, 6000);
      } else if (brief) {
        if (result.brief?.error) {
          toast(`分析完成，但画像保存失败：${result.brief.error}`, 6000);
        } else {
          await refresh();
          toast('项目画像已更新', 4200);
        }
      } else if (distill) {
        if (result.distill?.candidateId) {
          knowledgeCache.delete(projectId);
          await refresh();
          toast(result.distill.duplicate
            ? `这次「${playbookLabelOf(id)}」已经在知识候选里`
            : `「${playbookLabelOf(id)}」完成，已沉淀为项目知识候选（未验证）`, 5200);
        } else if (result.distill?.error) {
          toast(`复盘完成，但沉淀失败：${result.distill.error}`, 6000);
        }
      }
    } catch (error) {
      toast(String(error?.message ?? error), 6000);
    } finally {
      if (playbookTimer) { window.clearInterval(playbookTimer); playbookTimer = null; }
      playbookBusy = false;
      playbookRunningId = '';
      $('playbookCancel').hidden = true;
      playbookButtonState(false);
      $('playbookHint').textContent = '一键只读分析所选项目；结论可沉淀为项目知识，改动会先生成提案等你批准。';
      void loadPlaybooks();
    }
  };

  /** 一键“运行 + 沉淀”：默认跑复盘，也可指定结构走读/根因定位/验收。 */
  const reflectAndDistill = (playbookId = 'reflect') => {
    if (!view?.config?.projectId) { toast('先选择一个项目。'); return; }
    void runPlaybook(playbookId, { distill: true });
  };

  const loadPlaybooks = async () => {
    const projectId = view?.config?.projectId ?? '';
    try {
      playbookCatalog = await window.companion.playbooks.list({ projectId });
      renderPlaybookButtons();
      renderDistillPresets();
      playbookButtonState(playbookBusy);
      if (playbookProjectId && playbookProjectId !== projectId) {
        playbookCurrent = null;
        playbookProjectId = projectId;
        renderPlaybookResult();
      }
    } catch (error) {
      playbookCatalog = null;
      $('playbookHint').textContent = `Playbook 不可用：${String(error?.message ?? error)}`;
    }
  };

  const openResult = async (cycleId) => {    try {
      const data = await window.companion.result({ cycleId });
      const summary = data.cycle.status === 'tested_pass'
        ? '修复已完成，复测通过。下面是源补丁、修复补丁和测试输出。'
        : data.cycle.status === 'tested_fail'
          ? '修复后测试仍未通过，请查看输出并决定下一步。'
          : `当前状态：${data.cycle.status}`;
      const nodes = [
        el('p', 'result-summary', summary),
        detailRows([
          ['Cycle', data.cycle.id],
          ['状态', data.cycle.status],
          ['范围', (data.cycle.scope ?? []).join(', ') || '—'],
          ['Approval hash', data.cycle.approval_hash ?? data.cycle.approvalHash ?? '—'],
          ['源测试', data.sourceRun ? `${data.sourceRun.status}/${data.sourceRun.execution}/${data.sourceRun.test}` : '—'],
          ['修复测试', data.repairRun ? `${data.repairRun.status}/${data.repairRun.execution}/${data.repairRun.test}` : '未开始']
        ])
      ];
      const block = (title, text) => {
        if (!text) return;
        nodes.push(el('div', 'section-title', title));
        nodes.push(el('pre', 'diff', text));
      };
      block('源补丁 Diff', data.sourcePatch?.diff);
      block('源测试输出', [data.sourceRun?.stdout, data.sourceRun?.stderr].filter(Boolean).join('\n'));
      block('修复补丁 Diff', data.repairPatch?.diff);
      block('修复测试输出', [data.repairRun?.stdout, data.repairRun?.stderr].filter(Boolean).join('\n'));
      const close = el('button', 'primary', '关闭');
      close.onclick = closeModal;
      openModal('执行结果', nodes, [close]);
    } catch (error) {
      toast(String(error?.message ?? error), 5000);
    }
  };

  const tierLabel = (tier) => ({ write: '写请求', run: '测试运行', danger: '高风险' }[tier] ?? '需批准');
  const tierClass = (tier) => ['write', 'run', 'danger'].includes(tier) ? tier : 'write';
  /**
   * 唯一一处「状态 → 色调 / 文案」映射（显示层）。
   *
   * 语义来源仍是 src/execution-status.mjs（终态 / 等审批 / 在场 / 相位）；panel.js 是
   * 经典脚本读不到 ESM，所以这里只做显示翻译，不再另存状态集合或第二份判断。
   * 操作区运行中块的颜色直接读模型给的 phase（见 OPS_PHASE），与这里不重叠。
   */
  const statusMeta = (status) => {
    const value = String(status ?? '').toLowerCase();
    if (['succeeded', 'completed', 'tested_pass', 'applied'].includes(value)) return { tone: 'done', label: '完成' };
    if (['running', 'leased', 'provisioning', 'collecting', 'test_pending'].includes(value)) return { tone: 'running', label: '进行中' };
    if (['failed', 'cancelled', 'tested_fail', 'needs_reconciliation'].includes(value)) return { tone: 'failed', label: '失败' };
    if (value === 'cancel_requested') return { tone: 'pending', label: '停止中' };
    if (['pending_approval', 'proposal_ready', 'approved', 'queued'].includes(value)) return { tone: 'pending', label: '等你' };
    return { tone: 'muted', label: status ? String(status) : '未知' };
  };
  const statusGlyph = (tone) => ({ done: '✓', running: '▶', failed: '×', pending: '○', muted: '·' }[tone] ?? '·');

  const taskPlan = (item) => {
    const plan = el('div', 'task-plan');
    plan.append(el('div', 'section-title', '计划'));
    const steps = [
      '只读分诊：读取项目、检查证据（已完成）',
      item.kind === 'job' ? '你批准写请求（HITL）' : '你确认这一步',
      '写入子 Agent 在隔离 worktree 内改文件',
      '生成补丁提案，等你再次审批',
      '应用补丁，然后创建沙箱测试'
    ];
    for (const [index, text] of steps.entries()) {
      const row = el('div', 'plan-step');
      row.append(el('span', 'plan-index', String(index + 1)));
      row.append(el('span', undefined, text));
      plan.append(row);
    }
    return plan;
  };

  const renderRunning = () => {
    const list = $('runningList');
    if (!list) return;
    list.replaceChildren();
    const chain = view?.chain ?? {};
    const steps = [];
    if (view?.playbook?.running) {
      steps.push({
        label: 'pstack',
        detail: view.playbook.title,
        meta: '只读分析',
        status: 'running'
      });
    }
    if (chain.job) {
      steps.push({
        label: '任务', detail: chain.job.title,
        meta: chain.job.jobType, status: chain.job.status
      });
    }
    if (chain.patch) {
      steps.push({
        label: '补丁', detail: (chain.patch.files ?? []).join(', ') || chain.patch.id.slice(0, 8),
        meta: 'diff', status: chain.patch.status
      });
    }
    if (chain.sandbox) {
      steps.push({
        label: '测试', detail: `${chain.sandbox.profile || 'sandbox'}${chain.sandbox.testStatus ? ` · 测试 ${chain.sandbox.testStatus}` : ''}`,
        meta: chain.sandbox.exitCode === null || chain.sandbox.exitCode === undefined ? '' : `exit ${chain.sandbox.exitCode}`,
        status: chain.sandbox.status
      });
    }
    if (chain.cycle) {
      steps.push({
        label: '修复', detail: (chain.cycle.scope ?? []).join(', ') || '有界修复',
        meta: 'repair', status: chain.cycle.status
      });
    }
    if (steps.length === 0) {
      $('runningTitle').textContent = '运行中';
      list.append(el('div', 'ledger-empty', '现在没有运行中的任务。交办后会在这里看到步骤账本。'));
      return;
    }
    // 「正在跑」以主进程筛好的非终态执行为准（本项目），不在这一层再抄一份状态集合。
    // 账本里的 chain 可能退回最近一条已终态记录，所以不能拿它判断。
    const projectId = workspaceProject()?.id ?? '';
    const hasActive = view?.playbook?.running === true
      || (Array.isArray(view?.executions) ? view.executions : [])
        .some((item) => !projectId || item.projectId === projectId);
    $('runningTitle').textContent = hasActive ? '运行中' : '最近任务';
    steps.forEach((step, index) => {
      const meta = statusMeta(step.status);
      const row = el('div', `ledger-step ${meta.tone}`);
      row.append(el('span', 'ledger-index', String(index + 1)));
      row.append(el('span', `step-glyph ${meta.tone}`, statusGlyph(meta.tone)));
      const body = el('div', 'ledger-body');
      body.append(el('strong', undefined, step.label));
      body.append(el('span', 'ledger-detail', step.detail || ''));
      row.append(body);
      row.append(el('span', `ledger-status ${meta.tone}`, meta.label));
      list.append(row);
    });
  };

  const openApproval = (item) => {
    if (item.kind === 'job') {
      return confirmDecision({
        title: `批准写请求：${item.title}`,
        rows: [
          ['项目', item.projectName || item.projectId],
          ['类型', item.jobType || 'code-write'],
          ['写入意图', item.intent || item.title],
          ['目标文件', item.targets || '由子 Agent 在允许范围内选择'],
          ['允许范围', item.allowedPaths || '—'],
          ['只读分析', item.analysisSummary || '—']
        ],
        extraNodes: [taskPlan(item)],
        confirmLabel: '批准写请求',
        success: '写请求已批准，Worker 会启动写入子 Agent',
        input: { kind: 'job', id: item.id, action: 'approve' }
      });
    }
    if (item.kind === 'sandbox') {
      return confirmDecision({
        title: `批准测试 ${item.id.slice(0, 8)}`,
        rows: [
          ['项目', item.projectName || item.projectId],
          ['沙箱', item.profile || 'node-smoke'],
          ['说明', item.summary]
        ],
        extraNodes: [el('p', 'pending-next', '批准后：Docker 沙箱内运行测试并收集证据；失败会进入修复选项。')],
        hash: item.hash,
        confirmLabel: '批准测试',
        success: '测试已批准，Worker 会自动运行',
        input: { kind: 'sandbox', id: item.id, hash: item.hash, action: 'approve' }
      });
    }
    if (item.kind === 'repair') {
      return confirmDecision({
        title: `批准修复 ${item.id.slice(0, 8)}`,
        rows: [
          ['项目', item.projectName || item.projectId],
          ['修复范围', item.scope || '源测试允许范围'],
          ['说明', item.summary]
        ],
        extraNodes: [el('p', 'pending-next', '批准后：在原 base 上生成新补丁，再审批、应用、复测。')],
        hash: item.hash,
        confirmLabel: '批准修复',
        success: '修复已批准，Worker 会自动生成新补丁',
        input: { kind: 'repair', id: item.id, hash: item.hash, action: 'approve' }
      });
    }
    if (item.kind === 'repair-create') {
      return confirmDecision({
        title: `从失败测试创建修复 ${item.id.slice(0, 8)}`,
        rows: [
          ['项目', item.projectName || item.projectId],
          ['源运行', item.id],
          ['说明', item.summary]
        ],
        extraNodes: [el('p', 'pending-next', '创建后：基于失败证据生成新补丁，仍需你批准。')],
        confirmLabel: '创建',
        success: '修复周期已创建，接下来需要你批准',
        input: { kind: 'repair-create', id: item.id, action: 'create' }
      });
    }
    return openPatch(item);
  };

  const openPendingDetail = (item) => {
    if (item.kind === 'patch' || item.kind === 'patch-apply') {
      void openPatch(item);
      return;
    }
    const rows = [
      ['项目', item.projectName || item.projectId],
      ['类型', item.jobType || item.kind],
      ['当前状态', item.summary],
      ['风险', tierLabel(item.tier)]
    ];
    if (item.intent) rows.push(['写入意图', item.intent]);
    if (item.targets) rows.push(['目标文件', item.targets]);
    if (item.allowedPaths) rows.push(['允许范围', item.allowedPaths]);
    if (item.analysisSummary) rows.push(['只读分析', item.analysisSummary]);
    if (item.profile) rows.push(['沙箱', item.profile]);
    if (item.scope) rows.push(['修复范围', item.scope]);
    const nodes = [detailRows(rows)];
    if (item.kind === 'job') nodes.push(taskPlan(item));
    if (item.next) {
      const nextText = String(item.next).replace(/^批准后[：:]\s*/u, '');
      nodes.push(el('p', 'pending-next', `批准后：${nextText}`));
    }
    const close = el('button', 'ghost', '关闭');
    close.onclick = closeModal;
    const approve = el('button', 'primary', '去批准');
    approve.onclick = () => { closeModal(); openApproval(item); };
    openModal('审阅请求', nodes, [close, approve]);
  };


  const pendingCard = (item, { grouped = false } = {}) => {
    const tier = tierClass(item.tier);
    const card = el('div', `pending-card tier-${tier}`);
    const head = el('div', 'pending-head');
    head.append(el('div', 'pending-title', item.title));
    head.append(el('span', `tier-badge ${tier}`, tierLabel(item.tier)));
    card.append(head);
    // 没有全局「当前项目」了：卡片只标项目名，不再分「当前/其他」两堆。
    if (item.projectName && !grouped) {
      card.append(el('div', 'pending-project', item.projectName));
    }
    card.append(el('div', 'pending-summary',
      item.hash ? `${item.summary} · ${fmtHash(item.hash)}` : item.summary));
    if (item.next) {
      const nextText = String(item.next).replace(/^批准后[：:]\s*/u, '');
      card.append(el('div', 'pending-next', `批准后：${nextText}`));
    }
    const actions = el('div', 'pending-actions');
    const detail = el('button', 'ghost small', '详情');
    detail.onclick = () => openPendingDetail(item);
    actions.append(detail);
    if (item.kind === 'job') {
      const approve = el('button', 'primary', '批准任务');
      approve.onclick = () => openApproval(item);
      const reject = el('button', 'danger', '拒绝');
      reject.onclick = () => confirmDecision({
        title: `拒绝任务：${item.title}`,
        rows: [['任务', item.title], ['说明', item.summary]],
        confirmLabel: '确认拒绝',
        success: '任务已拒绝',
        reason: true,
        input: { kind: 'job', id: item.id, action: 'reject' }
      });
      actions.append(approve, reject);
    } else if (item.kind === 'patch' || item.kind === 'patch-apply') {
      const review = el('button', 'primary', item.kind === 'patch' ? '审阅 Diff' : '应用并请求测试');
      review.onclick = () => { void openPatch(item); };
      const reject = el('button', 'danger', '拒绝');
      reject.onclick = () => confirmDecision({
        title: `拒绝补丁 ${item.id.slice(0, 8)}`,
        rows: [['补丁', item.id], ['hash', item.hash]],
        confirmLabel: '确认拒绝',
        success: '补丁已拒绝',
        reason: true,
        input: { kind: 'patch', id: item.id, action: 'reject' }
      });
      actions.append(review, reject);
    } else if (item.kind === 'sandbox') {
      const approve = el('button', 'primary', '批准测试');
      approve.onclick = () => openApproval(item);
      actions.append(approve);
    } else if (item.kind === 'repair') {
      const approve = el('button', 'primary', '批准修复');
      approve.onclick = () => openApproval(item);
      actions.append(approve);
    } else if (item.kind === 'repair-create') {
      const create = el('button', 'primary', '创建修复周期');
      create.onclick = () => openApproval(item);
      actions.append(create);
    }
    card.append(actions);
    return card;
  };

  // 操作区视图模型最近一次的输出：待办的标题 / 计数 / 空态与列表都从同一份模型读，
  // 不再出现「模型说空了、列表却还有」的两套来源（见 renderOps）。
  let opsModel = null;

  const renderPending = () => {
    const list = $('pendingList');
    list.replaceChildren();
    // 输入统一来自模型：空态由模型的 pendingBlock.empty 决定，这里只按 items 画。
    const block = opsModel?.blocks?.find((item) => item.key === 'pending');
    const pending = Array.isArray(block?.items) ? block.items : [];
    if (pending.length === 0) return;

    // 分组与首组展开是纯函数（pending-groups.cjs）；首组 = 第一条待办所属项目。
    const model = window.OwnerPendingGroups?.groupPending(pending);
    if (!model) return;
    if (model.single) {
      for (const group of model.groups) {
        for (const item of group.items) list.append(pendingCard(item));
      }
      return;
    }

    for (const group of model.groups) {
      const details = el('details', 'pending-group');
      details.open = group.open;
      const summary = el('summary', 'pending-group-head');
      summary.append(el('span', 'pending-group-name', group.name));
      summary.append(el('span', 'pending-group-count', `${group.items.length} 件`));
      details.append(summary);
      const body = el('div', 'pending-group-body');
      for (const item of group.items) body.append(pendingCard(item, { grouped: true }));
      details.append(body);
      list.append(details);
    }
  };

  // ---- 专注：操作区（两区骨架的上半区） ----
  //
  // 组装一律走 src/focus-ops.mjs 的 focusOpsView（由 focus-ops-host.mjs 挂到
  // window.OwnerFocusOps）：三段块、固定顺序、空态文案都在模型里，渲染层只画。
  // 运行中由 #70 接；#71 接待提炼：数据来自 #58 的既有 IPC，阈值判定仍只在
  // src/knowledge-loop/on-demand.mjs，面板不重算。
  //
  // 提议攒得慢（要 ≥3 条未提炼执行记录），没必要跟 2 秒轮询：给一个取数窗口，
  // 过期才再读一次；读失败保留上一次结果，不挡待办与运行中。
  const OPS_PROPOSAL_TTL = 15000;
  let opsProposals = [];
  let opsProposalAt = 0;
  let opsProposalLoading = false;

  const loadOpsProposals = async () => {
    if (opsProposalLoading) return;
    if (Date.now() - opsProposalAt < OPS_PROPOSAL_TTL) return;
    opsProposalLoading = true;
    try {
      // 操作区跨项目：要显式 allProjects 拿全部项目的提议（不带项目筛选）。
      const data = await window.companion.knowledge.distillProposals({ allProjects: true });
      opsProposals = Array.isArray(data?.proposals) ? data.proposals : [];
    } catch {
      // 提议只是提示：读不到就沿用上一次的结果。
    } finally {
      opsProposalLoading = false;
      opsProposalAt = Date.now();
      if (panelMode === 'focus') renderOps();
    }
  };

  // 「去提炼」只跳转，不写库、不触发提炼：复用现有的模式切换与知识页刷新，
  // 把知识页的项目筛选定位到这条提议的项目上。
  const jumpToKnowledgeProposals = (projectId) => {
    const id = String(projectId ?? '');
    // 知识页的项目筛选就是「定位到项目」：先选中，再交给 setMode 触发的刷新画出来。
    if (id) knowledgeBrowseProject = id;
    setMode('knowledge');
    const node = $('knowledgeBrowse') ?? $('modeB');
    if (node) window.setTimeout(() => node.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60);
  };

  // 一条提议：项目 + 条数 + 「去提炼」。条数与文案来自模型，这里只补项目显示名。
  const proposalRow = (item) => {
    const row = el('div', 'proposal-card');
    const body = el('div', 'proposal-text');
    body.append(el('div', 'proposal-title',
      `${projectLabel(item.projectId)} · 已积 ${item.count} 条未提炼`));
    body.append(el('p', 'proposal-hint', '只提示，不会自动提炼。去知识页看看要不要提炼。'));
    row.append(body);
    const go = el('button', 'proposal-go', '去提炼');
    go.type = 'button';
    go.dataset.project = item.projectId;
    go.onclick = () => jumpToKnowledgeProposals(item.projectId);
    row.append(go);
    return row;
  };

  // 待提炼块：每个达到阈值的项目一行；没有提议时整段消失，不留占位。
  const renderOpsProposing = (block) => {
    const section = $('proposeSection');
    const list = $('proposeList');
    if (!section || !list) return;
    const items = block?.items ?? [];
    section.hidden = items.length === 0;
    list.replaceChildren();
    if (!items.length) return;
    $('opsProposeTitle').textContent = block.title;
    $('proposeBadge').textContent = String(block.count);
    $('proposeBadge').hidden = block.count === 0;
    for (const item of items) list.append(proposalRow(item));
  };

  // 运行中的相位（stuck / stopping / queued / running）由模型给出语义，
  // 中文与颜色留在这一层——改文案不用动纯函数，也不重算状态。
  const OPS_PHASE = {
    stuck: { label: '卡住', tone: 'stuck' },
    stopping: { label: '停止中', tone: 'stopping' },
    queued: { label: '排队中', tone: 'queued' },
    running: { label: '执行中', tone: 'running' }
  };
  const OPS_KIND = { job: '任务', patch: '补丁', sandbox: '沙箱测试', cycle: '修复', execution: '执行' };

  const openExecutionDetail = (item) => {
    const phase = OPS_PHASE[item.phase] ?? OPS_PHASE.running;
    const rows = [
      ['项目', item.projectName || item.projectId || '—'],
      ['类型', OPS_KIND[item.kind] ?? item.kind],
      ['状态', `${item.status}（${phase.label}）`],
      ['最近更新', item.at ? String(item.at).replace('T', ' ').slice(0, 19) : '—'],
      ['编号', item.id || '—']
    ];
    if (item.detail) rows.push(['详情', item.detail]);
    const nodes = [detailRows(rows)];
    if (item.phase === 'stuck') {
      nodes.push(el('p', 'pending-next',
        '租约已过期或需要核对：系统不会自动重试，处理后再重新发起。'));
    }
    // 停止动作按现状没有可用 IPC：侧车只暴露了批准/拒绝，只有 playbook 能取消。
    // 因此这里只给「查看」，不画一个点了会报错的停止按钮。
    const close = el('button', 'ghost', '关闭');
    close.onclick = closeModal;
    openModal('执行详情', nodes, [close]);
  };

  const opsRunRow = (item) => {
    const phase = OPS_PHASE[item.phase] ?? OPS_PHASE.running;
    const row = el('div', `ops-run tone-${phase.tone}`);
    const body = el('div', 'ops-run-body');
    body.append(el('strong', 'ops-run-title', item.title));
    const meta = [item.projectName || item.projectId, OPS_KIND[item.kind] ?? item.kind]
      .filter(Boolean).join(' · ');
    if (meta) body.append(el('div', 'ops-run-meta', meta));
    row.append(body);
    row.append(el('span', `ops-run-phase ${phase.tone}`, phase.label));
    const detail = el('button', 'ghost small', '查看');
    detail.onclick = () => openExecutionDetail(item);
    row.append(detail);
    return row;
  };

  // 操作区是否「三类块全空」：由 renderOps 从视图模型写入。
  // 结果下钻也算操作区的内容，所以这两处一起决定要不要把整区压成一行。
  let opsBodyEmpty = true;

  /**
   * 操作区空态：三类块全空且没有结果下钻时才压成一行（区头与外框一起收掉）。
   * 有结果时保留区头——否则「操作结果」会孤零零挂在一句空态下面。
   */
  const applyOpsEmptyState = () => {
    const zone = $('opsZone');
    const body = $('opsBody');
    const emptyLine = $('opsEmpty');
    const drill = $('opsDrill');
    if (!zone || !body || !emptyLine) return;
    const drillShown = Boolean(drill && !drill.hidden);
    const collapse = opsBodyEmpty && !drillShown;
    zone.classList.toggle('ops-empty', collapse);
    body.hidden = opsBodyEmpty;
    emptyLine.hidden = !opsBodyEmpty;
  };

  /**
   * 结果下钻区（#73）：答案卡 / 会话 / 最近结果三者都有各自的 hidden，
   * 三者都空时整段不出现；有任何一个就露出区头，并把操作区的空态重新算一遍。
   */
  const updateOpsDrill = () => {
    const drill = $('opsDrill');
    if (!drill) return;
    const shown = ['answerSection', 'timelineSection', 'resultSection']
      .some((id) => $(id)?.hidden === false);
    drill.hidden = !shown;
    applyOpsEmptyState();
  };

  const renderOps = () => {
    const zone = $('opsZone');
    const body = $('opsBody');
    const emptyLine = $('opsEmpty');
    if (!zone || !body || !emptyLine) return;
    const api = window.OwnerFocusOps;
    // 模块脚本可能还没执行完：这一帧不画，等 owner-focus-ops-ready 或下一次轮询。
    if (!api?.focusOpsView) return;
    const model = api.focusOpsView({
      projectId: viewProjectId,
      pending: view?.pending ?? [],
      // 跨项目的非终态执行由主进程快照提供（view.executions）；
      // 不拿 view.chain 硬凑——它只装当前项目、每类最多一条。
      executions: view?.executions ?? [],
      proposals: opsProposals
    });
    // 三类块全空时压成一行：文案来自模型，卡片外框由 .ops-empty 去掉。
    // 但「结果下钻」也算操作区的内容，有结果时保留区头（见 applyOpsEmptyState）。
    opsModel = model;
    opsBodyEmpty = model.empty;
    emptyLine.textContent = model.empty ? model.emptyText : '';
    applyOpsEmptyState();
    const blockOf = (key) => model.blocks.find((block) => block.key === key);
    const pendingBlock = blockOf('pending');
    const needsSection = $('needsSection');
    if (pendingBlock && needsSection) {
      // 待办为空时整段收起（连标题与说明一起），与运行中 / 待提炼一致，不留占位。
      // 三类全空时整个 opsBody 已经隐藏，两种空态不会互相打架（见 applyOpsEmptyState）。
      needsSection.hidden = pendingBlock.empty;
      // 标题与计数也读模型：以后块里加内容时不会出现「标题写死、数字另算」。
      $('opsPendingTitle').textContent = pendingBlock.title;
      $('pendingBadge').textContent = String(pendingBlock.count);
      $('pendingBadge').hidden = pendingBlock.count === 0;
    }
    // 待办列表与待办块同源：都吃模型里的 items（分组仍交给 pending-groups.cjs）。
    renderPending();
    // 运行中块：没有非终态执行时整段 hidden，不留标题、说明和空壳。
    const runningBlock = blockOf('running');
    const runningSection = $('opsRunning');
    if (runningBlock && runningSection) {
      runningSection.hidden = runningBlock.empty;
      $('opsRunningTitle').textContent = runningBlock.title;
      $('opsRunningBadge').textContent = String(runningBlock.count);
      const list = $('opsRunningList');
      list.replaceChildren();
      if (!runningBlock.empty) {
        for (const item of runningBlock.items) list.append(opsRunRow(item));
      }
    }

    renderOpsProposing(blockOf('proposing'));
    // 数据过期时补读一次；只在专注页、且快照已到（要拿项目显示名）时取。
    if (panelMode === 'focus' && view) void loadOpsProposals();
  };

  const renderActivity = () => {
    const box = $('activityLines');
    box.replaceChildren();
    const kindLabel = { user: '你', assistant: '助手', status: '状态', tool: '工具' };
    for (const line of view?.activity ?? []) {
      const row = el('div', `activity-line kind-${line.kind}`);
      row.append(el('span', 'activity-kind', kindLabel[line.kind] ?? line.kind));
      row.append(el('span', 'activity-text', line.text));
      box.append(row);
    }
    const model = view?.config?.model || 'Pi 默认模型';
    const modelChip = $('composerModel');
    if (modelChip) {
      modelChip.textContent = model;
      modelChip.title = `当前模型：${model}`;
    }
  };

  const fmtTime = (value) => {
    const at = new Date(String(value ?? ''));
    if (Number.isNaN(at.getTime())) return '';
    return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const showTimelineItem = async (item) => {
    try {
      const nodes = [el('p', 'result-summary', item.title), detailRows([
        ['类型', item.tool],
        ['状态', item.detail],
        ['时间', String(item.at ?? '').replace('T', ' ').slice(0, 19)]
      ])];
      if (item.ref?.type === 'patch') {
        const patch = await window.companion.patchDetail({ id: item.ref.id });
        nodes.push(detailRows([
          ['Paths', (patch.files ?? []).map((file) => file.path).join(', ') || '—'],
          ['Proposal hash', patch.proposal_hash ?? '—']
        ]));
        if (patch.proposal_diff) {
          nodes.push(el('div', 'section-title', 'Diff'));
          nodes.push(el('pre', 'diff', patch.proposal_diff));
        }
      }
      const close = el('button', 'ghost', '关闭');
      close.onclick = closeModal;
      openModal('会话详情', nodes, [close]);
    } catch (error) {
      toast(String(error?.message ?? error), 5000);
    }
  };

  const renderTimeline = () => {
    const section = $('timelineSection');
    const list = $('timeline');
    const items = view?.timeline ?? [];
    list.replaceChildren();
    section.hidden = items.length === 0;
    $('timelineCount').textContent = String(items.length);
    // 会话是操作留下的记录：有记录才出现，而且放在操作区的下钻位置（#73）。
    updateOpsDrill();
    const toolLabel = { job: '任务', patch: '补丁', test: '测试', repair: '修复' };
    for (const item of items) {
      if (item.kind === 'user') {
        const row = el('article', 'msg msg-user');
        const head = el('header', 'msg-head');
        head.append(el('span', 'msg-role', '你'));
        head.append(el('time', 'msg-time', fmtTime(item.at)));
        row.append(head, el('p', 'msg-body', item.title));
        if (item.detail) row.append(el('p', 'msg-sub', item.detail));
        list.append(row);
        continue;
      }
      const card = el('details', 'msg msg-tool');
      const summary = el('summary', 'tool-row');
      summary.append(el('span', `tool-dot tone-${item.tone ?? 'muted'}`));
      summary.append(el('span', 'tool-name', toolLabel[item.tool] ?? item.tool));
      summary.append(el('span', 'tool-detail', item.detail));
      summary.append(el('time', 'msg-time', fmtTime(item.at)));
      card.append(summary);
      const body = el('div', 'tool-body');
      const more = el('button', 'ghost small', '查看详情');
      more.onclick = () => { void showTimelineItem(item); };
      body.append(more);
      card.append(body);
      list.append(card);
    }
  };

  /** 创建 GitHub PR 的预览与二次确认；只有勾选后才允许推送。 */
  const openPrPreview = async (cycleId) => {
    try {
      const preview = await window.companion.github.prPreview({ cycleId });
      const nodes = [
        el('p', 'result-summary',
          '将推送一个新分支并创建 Draft PR；不会合并，也不会写入 main。'),
        detailRows([
          ['仓库', `${preview.repo}${preview.private ? '（私有）' : ''}`],
          ['分支', `${preview.base} ← ${preview.head}`],
          ['文件', (preview.files ?? []).join(', ') || '—'],
          ['变更统计', preview.stat || '—'],
          ['Commit', preview.draft.commitMessage],
          ['PR 标题', preview.draft.title]
        ]),
        el('pre', 'diff', preview.draft.body)
      ];
      const confirmRow = el('label', 'pr-confirm');
      const checkbox = el('input');
      checkbox.type = 'checkbox';
      confirmRow.append(checkbox, el('span', undefined, '我确认推送到 GitHub 并创建 Draft PR'));
      nodes.push(confirmRow);
      const cancel = el('button', 'ghost', '取消');
      cancel.onclick = closeModal;
      const create = el('button', 'primary', '创建 Draft PR');
      create.disabled = true;
      checkbox.onchange = () => { create.disabled = !checkbox.checked; };
      create.onclick = async () => {
        create.disabled = true;
        create.textContent = '推送中…';
        try {
          const result = await window.companion.github.prCreate({
            cycleId,
            previewHash: preview.previewHash,
            confirm: true
          });
          closeModal();
          if (result.url) {
            toast('Draft PR 已创建', 5000);
            void window.companion.openExternal(result.url)
              .catch((error) => toast(String(error?.message ?? error)));
          } else if (result.error) {
            toast(`分支已推送，但创建 PR 失败：${result.error}`, 8000);
          } else {
            toast('分支已推送', 5000);
          }
          await refresh();
        } catch (error) {
          create.disabled = false;
          create.textContent = '创建 Draft PR';
          toast(String(error?.message ?? error), 7000);
        }
      };
      openModal('创建 GitHub PR（需要确认）', nodes, [cancel, create]);
    } catch (error) {
      toast(String(error?.message ?? error), 6000);
    }
  };

  const renderResult = () => {
    const section = $('resultSection');
    const card = $('resultCard');
    card.replaceChildren();
    if (!view?.result) {
      section.hidden = true;
      updateOpsDrill();
      return;
    }
    section.hidden = false;
    updateOpsDrill();
    card.append(el('span', undefined, view.result.label));
    const button = el('button', undefined, '查看结果');
    button.onclick = () => { void openResult(view.result.cycleId); };
    card.append(button);
    if (view.result.testStatus === 'pass') {
      const pr = el('button', 'ghost small', '创建 PR');
      pr.title = '复测通过后，把补丁分支推送到 GitHub 并创建 Draft PR';
      pr.onclick = () => { void openPrPreview(view.result.cycleId); };
      card.append(pr);
    }
  };

  const refresh = async () => {
    // 刷新进行中又来了新选择：标记一次补刷，避免这次选择被正在跑的旧请求吞掉。
    if (refreshing) { refreshPending = true; return; }
    refreshing = true;
    try {
      // 只把「视图项目」传给快照；交办目标不参与取数，也不读配置里的旧值。
      view = await window.companion.snapshot({ projectId: viewProjectId });
      const projects = view?.projects ?? [];
      // 视图项目被删：回到默认第一个；交办目标被删：回到未选（发送需要重选）。
      if (viewProjectId && !window.OwnerPanelSelection?.findProject(projects, viewProjectId)) {
        viewProjectId = '';
      }
      if (handoffProjectId && !window.OwnerPanelSelection?.findProject(projects, handoffProjectId)) {
        handoffProjectId = '';
        renderComposerTarget();
      }
      // #84：视图项目变了才算「进入项目」——这时才重算差异并推进水位。
      // 快照自己的 2 秒轮询不重算，否则差异会被下一次刷新吃掉。
      const entryProjectId = String(view?.config?.projectId ?? '');
      if (entryProjectId !== sinceSeenProjectId) void loadSinceSeen(entryProjectId);
      if (view?.knowledge?.projectId) knowledgeCache.set(view.knowledge.projectId, view.knowledge);
      // 知识数量变了就重读一次浏览列表，避免用户在别处提炼/确认后看到旧列表。
      const knowledgeSignature = JSON.stringify(view?.knowledge?.counts ?? {});
      if (panelMode === 'knowledge' && knowledgeBrowseData && knowledgeSignature !== knowledgeBrowseSignature) {
        void loadKnowledgeBrowse();
      }
      knowledgeBrowseSignature = knowledgeSignature;
      applyState();
      renderActivity();
      renderTimeline();
      renderProjects();
      renderProjectBrief();
      renderProjectSummary();
      renderProjectGithub();
      renderNextAction();
      renderQueue();
      renderDiagrams();
      renderOps();
      renderRunning();
      renderResult();
      if (panelMode === 'focus') renderFocusMode();
      if (panelMode === 'chat') renderChatCards();
    } catch (error) {
      $('stateDot').className = 'state-dot error';
      $('stateText').textContent = '连接异常';
      $('stage').textContent = String(error?.message ?? error);
    } finally {
      refreshing = false;
      // 补一次刷新，让最新的项目选择生效。
      if (refreshPending) {
        refreshPending = false;
        void refresh();
      }
    }
  };

  // ---- 只读分析结果（Composer 交办的分诊结论） ----

  let lastAnswer = null;

  const renderAnswer = (result) => {
    const section = $('answerSection');
    const card = $('answerCard');
    card.replaceChildren();
    if (!result) {
      section.hidden = true;
      updateOpsDrill();
      return;
    }
    section.hidden = false;
    updateOpsDrill();
    // 答案落在操作区的下钻位置（#73）：在专注页时滚到眼前，避免用户以为「没反应」。
    if (panelMode === 'focus') {
      window.setTimeout(() => {
        $('answerSection')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }, 80);
    }
    $('answerBadge').textContent = result.mode === 'write-request'
      ? '写请求'
      : result.mode === 'triage-error' ? '失败' : '只读';
    if (result.summary) card.append(el('p', 'result-summary', result.summary));
    if (result.intent) card.append(el('p', 'pending-summary', `写入计划：${result.intent}`));
    if (result.targets?.length) {
      card.append(el('p', 'pending-summary', `目标文件：${result.targets.join(', ')}`));
    }
    for (const finding of (result.findings ?? []).slice(0, 3)) {
      const row = el('div', 'playbook-finding');
      row.append(el('strong', undefined, finding.title));
      if (finding.detail) row.append(el('span', undefined, finding.detail));
      const chips = playbookEvidenceChips(finding);
      if (chips) row.append(chips);
      card.append(row);
    }
    if (result.questions?.length) {
      card.append(el('p', 'pending-summary', `需要你补充：${result.questions.join('；')}`));
    }
    if (result.advice) card.append(el('p', 'result-summary', result.advice));
    if (result.mode === 'write-request') {
      card.append(el('p', 'pending-summary',
        '已生成写请求，在「需要你决定」里批准后才会调用写入子 Agent；补丁仍要再批准一次。'));
    }
    const actions = el('div', 'playbook-actions');
    if (typeof result.durationMs === 'number') {
      actions.append(el('span', 'playbook-more', `只读分析 ${result.durationMs} ms`));
    }
    if (actions.childNodes.length) card.append(actions);
  };

  // ---- Composer（Cindy ComposerCard / ListComposerTextarea 行为） ----

  const DRAFT_KEY = 'owner-companion-draft';
  const taskInput = $('taskInput');

  const autoGrow = () => {
    taskInput.style.height = 'auto';
    taskInput.style.height = `${Math.min(160, taskInput.scrollHeight)}px`;
  };

  const applyEdit = (edit) => {
    taskInput.value = edit.value;
    taskInput.dispatchEvent(new Event('input', { bubbles: true }));
    taskInput.setSelectionRange(edit.caret, edit.caret);
  };

  const restoreDraft = () => {
    try {
      const saved = localStorage.getItem(DRAFT_KEY);
      if (saved) { taskInput.value = saved; autoGrow(); }
    } catch { /* 本地草稿不可用不影响发送 */ }
  };

  const setComposerBusy = (busy) => {
    composerBusy = busy;
    const button = $('submitTask');
    const hint = $('composerHint');
    button.disabled = busy;
    button.classList.toggle('sending', busy);
    if (!hint) return;
    hint.hidden = !busy;
    if (!busy) hint.textContent = '';
  };

  // ---- 交办目标：显式选择，不写回配置 ----
  const handoffProjects = () => (view?.projects ?? []);
  /**
   * 交办目标：唯一解析处。不同入口只是传入不同的显式项目 id——
   * 专注输入框传 handoffProjectId，对话传会话绑定的 projectId。
   * 没选、项目已删都返回 null，调用方必须就地拦下，不回退第一个。
   */
  const handoffTarget = (projectId = handoffProjectId) => window.OwnerPanelSelection
    ?.submitProject(handoffProjects(), projectId) ?? null;

  /** 画交办按钮：没选时明确写「未选项目」，不假装已经选了第一个。 */
  const renderComposerTarget = () => {
    const button = $('handoffTarget');
    const nameNode = $('handoffTargetName');
    if (!button || !nameNode) return;
    const target = handoffTarget();
    nameNode.textContent = window.OwnerPanelSelection?.targetLabel(target)
      ?? (target?.name || '未选项目');
    button.dataset.projectId = target?.id ?? '';
    button.classList.toggle('needs-pick', !target);
    button.title = target
      ? `这次交办到「${target.name}」；选择不会写回配置`
      : '先选择这次交办到哪个项目（选择不会写回配置）';
  };

  const closeHandoffMenu = () => {
    const menu = $('handoffTargetMenu');
    if (!menu) return;
    menu.hidden = true;
    menu.replaceChildren();
    $('handoffTarget')?.setAttribute('aria-expanded', 'false');
  };

  /** 展开项目菜单：列表来自快照，点哪条就把这条显式设成交办目标。 */
  const openHandoffMenu = () => {
    const menu = $('handoffTargetMenu');
    const button = $('handoffTarget');
    if (!menu || !button) return;
    if (!menu.hidden) { closeHandoffMenu(); return; }
    const projects = handoffProjects();
    menu.replaceChildren();
    if (!projects.length) {
      menu.append(el('p', 'composer-project-empty', '还没有项目；先到设置里添加一个。'));
    }
    for (const project of projects) {
      const item = el('button', 'composer-project-option', project.name || project.id);
      item.type = 'button';
      item.dataset.project = project.id;
      item.setAttribute('role', 'option');
      // 选中标记只看「交办目标」，与工作区正在看哪个项目无关。
      const selected = project.id === handoffProjectId;
      item.setAttribute('aria-selected', selected ? 'true' : 'false');
      item.classList.toggle('on', selected);
      if (project.pending > 0) {
        item.append(el('span', 'composer-project-count', String(project.pending)));
      }
      item.onclick = () => selectHandoffProject(project.id);
      menu.append(item);
    }
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
  };

  const sendMessage = async (rawText, { capture = true } = {}) => {
    const text = String(rawText ?? '').trim();
    if (!text) { toast('先写点什么。'); return null; }
    // 交办必须显式选项目：没选就地拦下，不悄悄回退到第一个。
    const target = handoffTarget();
    if (!target) {
      renderComposerTarget();
      toast('先选择这次要交办的项目。');
      return null;
    }
    const projectId = target.id;
    setComposerBusy(true);
    // 先清空输入框：模型分析可能要几十秒，不能让它一直占着草稿。
    taskInput.value = '';
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    autoGrow();
    const startedAt = Date.now();
    const hint = $('composerHint');
    const tick = () => {
      if (hint) hint.textContent = `分析中… ${Math.round((Date.now() - startedAt) / 1000)}s`;
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    try {
      // 先只读分析：需要写入时后台会生成 pending_approval 的写请求（HITL）。
      const result = await window.companion.submit({ text, projectId, captureIdea: capture });
      lastAnswer = result ?? null;
      renderAnswer(lastAnswer);
      const captured = Boolean(result?.capturedIdea);
      const suffix = captured ? ' · 已记为想法' : '';
      if (result?.mode === 'write-request') {
        const missing = result?.testConfig?.missing ?? [];
        toast(missing.length
          ? `分析完成；已发起写请求，批准后才会动手。测试配置还缺 ${missing.join(', ')}。${suffix}`
          : `分析完成；已发起写请求，批准后才会动手。${suffix}`, 7000);
      } else if (result?.mode === 'answer') {
        toast(`已回复${suffix}`, 4200);
      } else {
        toast(`${result?.advice || result?.summary || '分析失败，请重试。'}${suffix}`, 7000);
      }
      await refresh();
      return result;
    } catch (error) {
      // 失败时把刚才的内容放回去，避免用户重写。
      if (!taskInput.value.trim()) {
        taskInput.value = text;
        try { localStorage.setItem(DRAFT_KEY, text); } catch { /* ignore */ }
        autoGrow();
      }
      toast(String(error?.message ?? error), 5000);
      return null;
    } finally {
      window.clearInterval(timer);
      setComposerBusy(false);
      taskInput.focus();
    }
  };

  $('submitTask').onclick = () => { void sendMessage(taskInput.value); };
  $('handoffTarget').onclick = (event) => {
    event.stopPropagation();
    openHandoffMenu();
  };
  // 点击菜单外部收起，避免浮层挡着输入框。
  document.addEventListener('click', (event) => {
    const menu = $('handoffTargetMenu');
    if (!menu || menu.hidden) return;
    if (menu.contains(event.target) || $('handoffTarget')?.contains(event.target)) return;
    closeHandoffMenu();
  });

  taskInput.addEventListener('input', () => {
    autoGrow();
    try { localStorage.setItem(DRAFT_KEY, taskInput.value); } catch { /* ignore */ }
  });

  taskInput.addEventListener('keydown', (event) => {
    if (event.isComposing) return; // 输入法组字期间不拦截
    const list = window.OwnerComposerList;
    const start = taskInput.selectionStart;
    const end = taskInput.selectionEnd;
    if (event.key === 'Enter') {
      if (event.shiftKey || event.altKey) {
        const edit = list?.computeTextareaContinuation(taskInput.value, start, end);
        if (edit) {
          event.preventDefault();
          applyEdit(edit);
          return;
        }
        if (event.altKey) {
          // Alt+Enter 一律当换行消费，避免落入“Enter=发送”。
          event.preventDefault();
          const next = `${taskInput.value.slice(0, start)}\n${taskInput.value.slice(end)}`;
          applyEdit({ value: next, caret: start + 1 });
        }
        return; // Shift+Enter 交给默认换行
      }
      event.preventDefault();
      $('submitTask').click();
      return;
    }
    if (event.key === 'Backspace' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      const edit = list?.computeTextareaBackspace(taskInput.value, start, end);
      if (edit) {
        event.preventDefault();
        applyEdit(edit);
      }
    }
  });

  restoreDraft();
  autoGrow();

  /**
   * 切换视图项目：只影响工作区看哪个项目，不碰交办目标，也不写配置。
   */
  const selectViewProject = async (projectId) => {
    const id = String(projectId ?? '');
    if (!id) return;
    if (id === viewProjectId) return;
    viewProjectId = id;
    // 换项目后旧结论不再适用，先清空再按新项目重新加载。
    playbookCurrent = null;
    playbookProjectId = id;
    renderPlaybookResult();
    lastAnswer = null;
    renderAnswer(null);
    await refresh();
    void loadPlaybooks();
  };

  /**
   * 设置交办目标：只影响「交办到 …」，不影响工作区正在看的项目。
   * 这是交办目标唯一的写入点；选择只存在内存里，不写 companion.json。
   */
  const selectHandoffProject = (projectId) => {
    const id = String(projectId ?? '');
    if (!id) return;
    closeHandoffMenu();
    handoffProjectId = id;
    renderComposerTarget();
  };

  const renderMobileInfo = async (refresh = false) => {
    const box = $('mobileInfo');
    if (!box) return;
    try {
      const info = refresh
        ? await window.companion.mobile.refresh()
        : await window.companion.mobile.info();
      if (!info?.enabled) {
        box.textContent = info?.reason || '手机桥未启动';
        return;
      }
      const urls = (info.urls ?? []).map((item) => item.url);
      const primary = urls[0] ?? `http://<电脑IP>:${info.port}`;
      const spare = urls.slice(1);
      const devices = info.devices?.length ?? 0;
      box.textContent = [
        `地址：${primary}${spare.length ? `（备用：${spare.join('、')}）` : ''}`,
        `配对码：${info.code}（10 分钟内有效）`,
        devices ? `已配对 ${devices} 台设备` : '还没有设备配对'
      ].join('\n');
    } catch (error) {
      box.textContent = String(error?.message ?? error);
    }
  };

  const openSettings = async (focusSkin = false) => {
    try {
      const data = await window.companion.settings.get();
      $('gatewayUrl').value = data.gatewayUrl ?? '';
      $('model').value = data.model ?? '';
      $('diagramModel').value = data.diagramModel ?? '';
      $('allowedPaths').value = data.allowedPaths ?? 'src/';
      $('sandboxMode').value = data.sandboxMode ?? 'auto';
      $('includePaths').value = (data.includePaths ?? []).join(',');
      renderServiceGrid($('serviceGrid'), data.services);
      await renderMobileInfo();
      await renderMascotGrid();
      $('settings').hidden = false;
      if (focusSkin) {
        setTimeout(() => {
          try { $('mascotGrid').scrollIntoView({ block: 'center' }); } catch { /* best effort */ }
        }, 50);
      }
    } catch (error) {
      toast(String(error?.message ?? error), 5000);
    }
  };

  $('refreshMascots').onclick = async () => {
    await renderMascotGrid();
    toast('已重新扫描皮肤目录');
  };

  $('importMascot').onclick = async () => {
    try {
      const result = await window.companion.mascots.import();
      if (result?.canceled) return;
      await renderMascotGrid();
      toast(`已导入并切换到 ${result?.label ?? result?.skin ?? '新皮肤'}`);
      await refresh();
    } catch (error) {
      toast(String(error?.message ?? error), 6000);
    }
  };

  const renderMascotGrid = async () => {
    const grid = $('mascotGrid');
    grid.replaceChildren(el('span', 'mascot-loading', '正在读取皮肤…'));
    try {
      const catalog = await window.companion.mascots.list();
      grid.replaceChildren();
      const custom = catalog.skins.filter((skin) => !skin.builtin).length;
      const count = $('mascotCount');
      if (count) {
        count.textContent = `共 ${catalog.skins.length} 个 · 自定义 ${custom}`;
        count.title = `自定义皮肤目录：${catalog.userDir ?? ''}`;
      }
      for (const skin of catalog.skins) {
        const option = el('button', 'mascot-option');
        option.type = 'button';
        option.dataset.skin = skin.id;
        option.dataset.kind = skin.kind ?? 'static';
        option.title = skin.builtin ? `${skin.label}（内置）` : `${skin.label}（自定义）`;
        if (skin.id === catalog.current) option.classList.add('selected');
        if (skin.kind === 'sprite' && skin.sprite) {
          if (skin.thumb) {
            const image = el('img');
            image.src = skin.thumb;
            image.alt = skin.label;
            image.draggable = false;
            image.loading = 'lazy';
            option.append(image, el('span', undefined, skin.label));
          } else {
            const thumb = el('span', 'mascot-thumb sprite');
            thumb.style.backgroundImage = `url("${skin.url}")`;
            thumb.style.backgroundSize = `${(skin.sprite.columns ?? 8) * 100}% ${(skin.sprite.rows ?? 9) * 100}%`;
            thumb.style.backgroundPosition = '0 0';
            option.append(thumb, el('span', undefined, skin.label));
          }
        } else {
          const image = el('img');
          image.src = skin.url;
          image.alt = skin.label;
          image.draggable = false;
          image.loading = 'lazy';
          option.append(image, el('span', undefined, skin.label));
        }
        option.onclick = async () => {
          try {
            await window.companion.mascots.set({ skin: skin.id });
            await renderMascotGrid();
            toast(`桌宠已切换为 ${skin.label}`);
            await refresh();
          } catch (error) {
            toast(String(error?.message ?? error), 5000);
          }
        };
        grid.append(option);
      }
      if (!catalog.skins.length) grid.append(el('span', 'mascot-loading', '没有可用皮肤'));
    } catch (error) {
      grid.replaceChildren(el('span', 'mascot-loading', String(error?.message ?? error)));
    }
  };

  $('openSettings').onclick = () => { void openSettings(); };
  $('kbRefresh').onclick = () => { void loadKnowledgeBrowse(); };
  $('skillRefresh').onclick = () => { void loadSkillCatalog({ refresh: true }); };
  $('mobileRefreshCode').onclick = () => { void renderMobileInfo(true); };
  $('closeSettings').onclick = () => { $('settings').hidden = true; };
  $('hidePanel').onclick = () => window.companion.hidePanel();
  $('openFull').onclick = () => { void window.companion.openFull().catch((error) => toast(String(error.message ?? error))); };
  $('quit').onclick = () => window.companion.quit();

  const openDiagnostics = async () => {
    try {
      const data = await window.companion.diagnostics();
      const sandbox = data.sandbox ?? {};
      const nodes = [
        el('div', 'section-title', '环境'),
        detailRows([
          ['版本', data.version],
          ['userData', data.userData],
          ['模型', data.model || 'Pi 默认'],
          ['项目', data.project ? `${data.project.id} · ${data.project.root}` : '未注册']
        ]),
        el('div', 'section-title', '沙箱'),
        detailRows([
          ['策略', sandbox.mode ?? 'auto'],
          ['profile', sandbox.profile ?? '无'],
          ['项目子目录', sandbox.projectDir || '（仓库根）'],
          ['状态', sandbox.reason ?? 'unknown'],
          ['缺失', (sandbox.missing ?? []).join(', ') || '—']
        ]),
        el('div', 'section-title', '服务'),
        detailRows([
          ['Docker', data.services?.docker ? '可用' : '不可用'],
          ['Gateway', data.services?.gateway ? '可连接' : '未连接'],
          ['Pi 模型', data.services?.model ?? 'unknown']
        ]),
        el('div', 'section-title', '最近任务'),
        el('pre', 'diff', (data.jobs ?? []).map((job) =>
          `${job.status.padEnd(18)} ${String(job.updatedAt ?? '').slice(0, 19)}  ${job.title}`).join('\n') || '暂无'),
        el('div', 'section-title', '最近测试'),
        el('pre', 'diff', (data.sandboxRuns ?? []).map((run) =>
          `${String(run.status).padEnd(12)} test=${run.testStatus ?? 'unknown'} exit=${run.exitCode ?? '-'} ${run.profile}`).join('\n') || '暂无'),
        el('div', 'section-title', 'Playbook 运行'),
        el('pre', 'diff', (data.playbooks ?? []).map((run) =>
          `${String(run.status).padEnd(6)} ${run.category || '-'} ${run.durationMs ?? 0}ms ${run.playbookId} · ${run.summary}`).join('\n') || '暂无')
      ];
      const close = el('button', 'ghost', '关闭');
      close.onclick = closeModal;
      const copy = el('button', 'primary', '复制 JSON');
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
          toast('诊断信息已复制');
        } catch (error) {
          toast(String(error?.message ?? error), 5000);
        }
      };
      openModal('运行诊断', nodes, [close, copy]);
    } catch (error) {
      toast(String(error?.message ?? error), 5000);
    }
  };
  $('diagnostics').onclick = () => { void openDiagnostics(); };

  const detectSandboxPlan = async () => {
    const projectId = view?.config?.projectId ?? '';
    if (!projectId) { toast('先选择一个项目。'); return; }
    const button = $('sandboxDetect');
    button.disabled = true;
    button.textContent = '识别中…';
    try {
      const suggestion = await window.companion.sandbox.detect({ projectId });
      const nodes = [
        el('p', 'result-summary', 'Agent 只给出建议；采用后才会写入本项目的沙箱设置，运行仍需你手动触发。'),
        detailRows([
          ['profile', suggestion.profile],
          ['镜像', suggestion.image],
          ['项目子目录', suggestion.projectDir || '（仓库根）'],
          ['置信度', suggestion.confidence ?? 'unknown'],
          ['依据', suggestion.reason || '—']
        ])
      ];
      const cancel = el('button', 'ghost', '取消');
      cancel.onclick = closeModal;
      const adopt = el('button', 'primary', '采用建议');
      adopt.onclick = async () => {
        adopt.disabled = true;
        try {
          await window.companion.settings.set({
            sandboxProjectMode: { projectId, mode: suggestion.profile },
            sandboxProjectDir: { projectId, dir: suggestion.projectDir }
          });
          closeModal();
          await refresh();
          toast(`已采用 ${suggestion.profile}（${suggestion.projectDir || '仓库根'}）`);
        } catch (error) {
          adopt.disabled = false;
          toast(String(error?.message ?? error), 5000);
        }
      };
      openModal('Agent 建议的沙箱方案', nodes, [cancel, adopt]);
    } catch (error) {
      toast(String(error?.message ?? error), 6000);
    } finally {
      button.disabled = false;
      button.textContent = '让 Agent 识别';
    }
  };
  $('sandboxDetect').onclick = () => { void detectSandboxPlan(); };
  $('closeModal').onclick = closeModal;
  $('modal').addEventListener('click', (event) => { if (event.target === $('modal')) closeModal(); });

  $('saveSettings').onclick = async () => {
    try {
      const saved = await window.companion.settings.set({
        gatewayUrl: $('gatewayUrl').value,
        model: $('model').value,
        diagramModel: $('diagramModel').value,
        allowedPaths: $('allowedPaths').value,
        includePaths: $('includePaths').value,
        sandboxMode: $('sandboxMode').value
      });
      $('settings').hidden = true;
      if (saved?.modelPending) toast('设置已保存；模型将在当前任务结束后生效', 6000);
      else if (saved?.modelChanged) toast('设置已保存，模型已切换');
      else toast('设置已保存');
      await refresh();
    } catch (error) {
      toast(String(error?.message ?? error), 5000);
    }
  };

  const pickProject = async () => {
    try {
      const project = await window.companion.settings.addProject();
      if (project) {
        toast(`已添加项目 ${project.name}`);
        await refresh();
        $('settings').hidden = true;
      }
    } catch (error) {
      toast(String(error?.message ?? error), 5000);
    }
  };
  $('addProject').onclick = () => { void pickProject(); };
  $('addProjectTop').onclick = () => { void pickProject(); };
  $('retryServices').onclick = () => { void openSettings(); };
  $('fixTestConfig').onclick = () => { void openSettings(); };
  $('sandboxModeSelect').onchange = async () => {
    const projectId = view?.config?.projectId ?? '';
    if (!projectId) return;
    try {
      await window.companion.settings.set({
        sandboxProjectMode: { projectId, mode: $('sandboxModeSelect').value }
      });
      await refresh();
      toast($('sandboxModeSelect').value === 'off'
        ? '本项目已跳过沙箱测试；补丁只做人工验证'
        : '本项目的沙箱策略已更新');
    } catch (error) {
      toast(String(error?.message ?? error), 5000);
    }
  };
  for (const button of document.querySelectorAll('[data-knowledge]')) {
    button.onclick = () => { void askKnowledge(button.dataset.knowledge); };
  }
  $('openKnowledge').onclick = () => {
    void window.companion.knowledge.open().catch((error) => toast(String(error.message ?? error)));
  };

  $('tidyKnowledge').onclick = () => { void openKnowledgeTidy(); };
  $('queueAdd').onclick = () => { void addQueueItem(); };
  $('queueInput').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void addQueueItem();
  });
  $('reflectDistill').onclick = () => { reflectAndDistill('reflect'); };

  $('playbookCancel').onclick = async () => {
    if (!playbookRunningId) return;
    try {
      const result = await window.companion.playbooks.cancel({ playbookId: playbookRunningId });
      toast(result?.canceled ? '已请求取消，正在中止会话…' : '当前没有正在运行的 playbook');
    } catch (error) {
      toast(String(error?.message ?? error), 5000);
    }
  };

  // ---- 专注：工作区（项目名 / 切换 / 四个入口） ----
  //
  // 只读详情卡已删除（#72）：工作区是唯一看到项目的地方。卡片原来的四个入口
  // （知识 / 测试 / 补丁 / 运行）留在工作区顶部，计数直接读当前快照，不再单独取一份。
  //
  // 入口跳转：知识去知识模式的浏览页；补丁去操作区的待办（#72：待办块没有待办时整段
  // 收起，所以指向操作区本身，落到「没有要你处理的事」那行而不是消失的块）；
  // 测试与运行去工作区的运行账本。目标找不到（或不在屏幕上）就退回该模式顶部。
  const FOCUS_JUMP = {
    knowledge: ['knowledge', 'knowledgeBrowse'],
    tests: ['focus', 'runningSection'],
    patches: ['focus', 'opsZone'],
    runs: ['focus', 'runningSection']
  };

  // 项目切换标签的重建键：只在项目 / 选中项 / 待办数变化时重画，避免轮询闪烁。
  let focusTabsKey = '';

  const focusProjects = () => (Array.isArray(view?.projects) ? view.projects : []);

  /**
   * 工作区当前展示的项目。快照是按「视图项目」取的，所以以快照回来的
   * config.projectId 为准；它对不上时（项目刚被删）再退回内存里的视图项目 / 第一个。
   * 详情卡删除后，项目名、切换标签与四个计数都用同一个口径，不会出现「标签说 A、数据是 B」。
   */
  const workspaceProject = () => {
    const projects = focusProjects();
    if (!projects.length) return null;
    const activeId = String(view?.config?.projectId ?? '');
    const active = projects.find((item) => item.id === activeId);
    if (active) return active;
    return window.OwnerPanelSelection
      ? window.OwnerPanelSelection.viewProject(projects, viewProjectId)
      : projects[0] ?? null;
  };

  /** 点工作区里的项目标签：只切视图项目，绝不影响交办目标。 */
  const selectFocusProject = (projectId) => {
    void selectViewProject(projectId);
  };

  /** 入口点击：跳到它原来的位置，不在工作区里重画第二份内容。 */
  const focusJump = (key) => {
    const target = FOCUS_JUMP[key];
    if (!target) return;
    const [mode, sectionId] = target;
    setMode(mode);
    // 目标小节可能被收进别的模式，也可能因为空态被整段 hidden（例如没有待办时的待办块）。
    // 找不到、或在屏幕上占不到位置，就把该模式自己的滚动容器拉回顶部，不留死跳转：
    // 专注模式的滚动容器是 .a-wrap，其余模式是 .scroll。
    const found = $(sectionId);
    const container = $(MODE_VIEW[mode]);
    const top = container?.querySelector('.a-wrap, .scroll') ?? container ?? null;
    window.setTimeout(() => {
      if (found && found.getClientRects().length > 0) {
        found.scrollIntoView({ block: 'start', behavior: 'smooth' });
      } else if (top) {
        top.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }, 60);
  };

  /**
   * 工作区顶部：项目名 + 项目切换。
   *
   * 「工作区永远是某个项目」：项目名总是写出来。项目只有一个时不显示切换控件——
   * 没有第二个可切，多一个按钮只会让人以为能换。
   * 切换沿用卡片时代的那套标签与 selectViewProject：只改视图项目，
   * 交办目标 handoffProjectId 仍由「交办到 …」菜单独占（ADR-0006）。
   */
  const renderWorkProjectBar = () => {
    const bar = $('workProjectBar');
    const name = $('workProjectName');
    const tabs = $('fdTabs');
    if (!bar || !name || !tabs) return;
    const project = workspaceProject();
    // 没有项目：工作区只剩添加项目的引导，不写一个假的项目名。
    if (!project) {
      bar.hidden = true;
      tabs.replaceChildren();
      focusTabsKey = '';
      return;
    }
    bar.hidden = false;
    name.textContent = project.name || project.id;
    const tabsModel = focusProjects().map((item) => ({
      id: item.id,
      name: item.name || item.id,
      pending: countOf(item.pending),
      selected: item.id === project.id
    }));
    // 只有一个项目：只留名字，不生成任何切换按钮（没有第二个可切）。
    if (tabsModel.length < 2) {
      tabs.hidden = true;
      tabs.replaceChildren();
      focusTabsKey = '';
      return;
    }
    tabs.hidden = false;
    // 项目列表很短，直接平铺；只在项目 / 选中项 / 待办数变化时重建，避免轮询闪烁。
    const tabsKey = JSON.stringify(tabsModel);
    if (tabsKey === focusTabsKey) return;
    focusTabsKey = tabsKey;
    tabs.replaceChildren(...tabsModel.map((tab) => {
      const button = el('button', `fd-tab${tab.selected ? ' on' : ''}`, tab.name);
      button.type = 'button';
      button.dataset.project = tab.id;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', tab.selected ? 'true' : 'false');
      button.title = tab.pending > 0 ? `${tab.name} · ${tab.pending} 件待办` : tab.name;
      if (tab.pending > 0) button.append(el('span', 'fd-tab-count', String(tab.pending)));
      button.onclick = () => selectFocusProject(tab.id);
      return button;
    }));
  };

  /**
   * 四个入口（知识 / 测试 / 补丁 / 运行）的计数与状态句。
   *
   * 详情卡删除后这些数字不再由 focus-detail.cjs 算，直接读按视图项目取回的快照 view：
   * - 知识：view.knowledge.counts（知识优先，没有就退经验；与卡片口径一致）；
   * - 测试 / 补丁 / 运行：view.counts（主进程按项目过滤，受 limit=20 取数窗口限制）；
   * - 状态句：view.chain 与 view.pending。
   * 缺数据（还没有快照 / 还没有项目）时一律给 0 与空态文案，不让面板崩在半路上。
   */
  const workEntryRows = () => {
    const project = workspaceProject();
    const projectId = project?.id ?? '';
    const counts = view?.counts ?? {};
    const knowledge = view?.knowledge?.counts ?? {};
    const pending = (Array.isArray(view?.pending) ? view.pending : [])
      .filter((item) => item.projectId === projectId);
    const chain = view?.chain ?? {};
    const pendingPatches = pending.filter((item) => PATCH_ENTRY_KINDS.has(item.kind)).length;
    // chain 在没有进行中项时会退回最近一条，不能「有 chain」就当在跑。
    // 非终态执行已在主进程按 execution-status.mjs 筛好（view.executions），这里只数本项目几条。
    const activeChain = (Array.isArray(view?.executions) ? view.executions : [])
      .filter((item) => item.projectId === projectId).length;
    // 主进程给快照的是 testStatus（camelCase）；仍兼容原始行的 test_status。
    const testStatus = String(chain?.sandbox?.testStatus ?? chain?.sandbox?.test_status ?? '');
    const testNote = testStatus === 'pass'
      ? '最近通过'
      : testStatus === 'fail'
        ? '最近未通过'
        : chain?.sandbox
          ? '最近未完成'
          : '还没跑过';
    const patchStatus = String(chain?.patch?.status ?? '');
    const patchNote = pendingPatches > 0
      ? `待审 ${pendingPatches}`
      : patchStatus === 'applied'
        ? '最近已应用'
        : patchStatus
          ? `最近 ${patchStatus}`
          : '还没有补丁';
    return [
      {
        key: 'knowledge',
        label: '知识',
        count: countOf(knowledge.knowledge) || countOf(knowledge.experiences),
        note: `候选 ${countOf(knowledge.candidates)} · 已验 ${countOf(knowledge.verified)}`
      },
      { key: 'tests', label: '测试', count: countOf(counts.tests), note: testNote },
      { key: 'patches', label: '补丁', count: countOf(counts.patches), note: patchNote },
      {
        key: 'runs',
        label: '运行',
        count: countOf(counts.jobs),
        note: activeChain > 0 ? `进行中 ${activeChain}` : '空闲'
      }
    ];
  };

  /**
   * 把四个计数写进工作区里的入口（静态结构写在 panel.html，只在这里填数）：
   * 没有项目时整段收起，不画一排 0；计数为 0 时照常显示 0 与空态文案。
   */
  const renderWorkEntries = () => {
    const holder = $('workEntries');
    if (!holder) return;
    const project = workspaceProject();
    holder.hidden = !project;
    if (!project) return;
    for (const row of workEntryRows()) {
      const button = holder.querySelector(`.work-entry[data-entry="${row.key}"]`);
      if (!button) continue;
      const count = button.querySelector('.work-entry-count');
      const note = button.querySelector('.work-entry-note');
      if (count) count.textContent = String(row.count);
      if (note) note.textContent = row.note;
      button.title = `${row.label} · ${row.count} · ${row.note}`;
      button.onclick = () => focusJump(row.key);
    }
  };

  // ---- 自上次看过（#84） ----
  //
  // 语义：进入项目时先算差异、再把水位推到当前（顺序在 src/memory/since-last-seen.mjs 里）。
  // 因此这里只在「视图项目变了」时调用有副作用的 IPC；快照每 2 秒刷新一次，如果刷新也重算，
  // 差异最多活 2 秒就被自己吃掉——那正是这个功能最典型的 bug。
  // 形态判定（首次查看 / 三类全空压成一行）来自 window.OwnerSinceSeen，不在渲染里另写一套。
  let sinceSeenProjectId = '';
  let sinceSeenData = null;
  let sinceSeenError = '';
  let sinceSeenToken = 0;

  /** 「上次看过」的时刻：当天只给时分，跨天补月/日，避免旧水位看起来像刚发生。 */
  const fmtSeenMoment = (value) => {
    const at = new Date(String(value ?? ''));
    if (Number.isNaN(at.getTime())) return '';
    const sameDay = at.toDateString() === new Date().toDateString();
    return sameDay
      ? fmtTime(value)
      : `${at.getMonth() + 1}/${at.getDate()} ${fmtTime(value)}`;
  };

  const sinceSeenGroup = (group) => {
    const box = el('div', 'since-seen-group');
    const head = el('div', 'since-seen-group-head');
    head.append(el('span', undefined, group.title));
    head.append(el('span', 'count', `${group.count} 条`));
    box.append(head);
    const list = el('ul', 'since-seen-items');
    for (const item of group.items) {
      const row = el('li', 'since-seen-item');
      row.append(el('span', 'since-seen-item-text', item.text));
      const at = fmtSeenMoment(item.at);
      if (at) row.append(el('span', 'since-seen-item-at', at));
      list.append(row);
    }
    box.append(list);
    if (group.more > 0) {
      box.append(el('p', 'since-seen-more', `还有 ${group.more} 条，只列最近 ${group.items.length} 条。`));
    }
    return box;
  };

  /**
   * 画「自上次看过」。
   * - 数据只画当前视图项目的那一份：换项目时旧结论立刻收掉，不把 A 的差异留在 B 上；
   * - 首次查看 / 算不全 / 三类全空 三种文案由 sinceSeenSection 决定，这里只填 DOM；
   * - 三类全空时给整段加 .compact，CSS 去掉外框与标题，只留一行，不占一块卡片。
   */
  const renderSinceSeen = () => {
    const holder = $('sinceLastSeen');
    if (!holder) return;
    const project = workspaceProject();
    const projectId = project?.id ?? '';
    const model = window.OwnerSinceSeen;
    holder.classList.remove('compact');
    const hide = () => {
      holder.hidden = true;
      $('sinceSeenGroups').replaceChildren();
    };
    if (!projectId || projectId !== sinceSeenProjectId) { hide(); return; }
    if (sinceSeenError) {
      holder.hidden = false;
      $('sinceSeenTitle').textContent = '自上次看过';
      $('sinceSeenMeta').textContent = '';
      $('sinceSeenLine').hidden = true;
      $('sinceSeenNote').hidden = false;
      $('sinceSeenNote').textContent = `这次没能算出变化窗口：${sinceSeenError}`;
      $('sinceSeenGroups').replaceChildren();
      return;
    }
    // 还在读取或模块尚未就绪：先收起，等结果 / ready 事件补画，不画半截。
    if (!sinceSeenData || !model?.sinceSeenSection) { hide(); return; }
    const section = model.sinceSeenSection(sinceSeenData);
    holder.hidden = false;
    holder.classList.toggle('compact', section.compressed);
    $('sinceSeenTitle').textContent = section.headline;
    $('sinceSeenMeta').textContent = section.firstView
      ? '从这次开始记'
      : (section.since ? `上次看过 ${fmtSeenMoment(section.since)}` : '');
    const line = $('sinceSeenLine');
    line.textContent = section.compressed ? section.compactLine : section.line;
    line.hidden = !line.textContent;
    const note = $('sinceSeenNote');
    note.textContent = section.note;
    note.hidden = !section.note;
    $('sinceSeenGroups').replaceChildren(...section.groups.map(sinceSeenGroup));
  };

  /**
   * 读一次「自上次看过」：这个 IPC 会推进水位，所以只有「进入项目」才调用。
   * 请求期间换了项目就丢掉旧结果（token），不让 A 的差异画到 B 上。
   */
  const loadSinceSeen = async (projectId) => {
    const id = String(projectId ?? '');
    const token = (sinceSeenToken += 1);
    sinceSeenProjectId = id;
    sinceSeenData = null;
    sinceSeenError = '';
    renderSinceSeen();
    if (!id) return;
    try {
      const data = await window.companion.sinceLastSeen({ projectId: id });
      if (token !== sinceSeenToken) return;
      sinceSeenData = data;
    } catch (error) {
      if (token !== sinceSeenToken) return;
      sinceSeenError = String(error?.message ?? error)
        .replace(/^Error invoking remote method '[^']+':\s*/, '');
    }
    if (token !== sinceSeenToken) return;
    renderSinceSeen();
  };

  // ---- 三种视图模式：专注（A） / 待办（B） / 对话（C） ----
  // ---- 知识模式：浏览与筛选（只读本地 SQLite） ----

  const PROJECT_PREFIX = /^project\./u;
  const projectLabel = (id) => {
    const key = String(id ?? '');
    const known = (view?.projects ?? []).find((project) => project.id === key);
    if (known?.name) return known.name;
    const short = key.replace(PROJECT_PREFIX, '');
    return short.length > 22 ? `${short.slice(0, 22)}…` : (short || '未归属项目');
  };

  let knowledgeBrowseData = null;
  let knowledgeBrowseProject = '';
  let knowledgeBrowseToken = 0;
  let knowledgeBrowseSignature = '';

  // 候选条目带审核动作；经验条目带「提升为候选」；其余条目仍是整行按钮，点开看详情。
  const knowledgeItemRow = (item) => {
    const row = el('div', 'kb-item');
    const main = el('button', 'kb-item-main');
    main.type = 'button';
    main.dataset.id = item.id;
    main.append(el('span', 'kb-item-title', item.title));
    const meta = el('span', 'kb-item-meta', item.detail);
    // 「全部」视图下补项目名，避免同名条目看不出属于哪个项目。
    if (!knowledgeBrowseProject && item.projectId) {
      meta.textContent += ` · ${projectLabel(item.projectId)}`;
    }
    main.append(meta);
    main.onclick = () => { void openKnowledgeDetail(item.id); };
    row.append(main);

    if (item.kind === 'candidate') {
      const actions = el('div', 'kb-item-actions');
      const accept = el('button', 'kb-act accept', '接受');
      const reject = el('button', 'kb-act reject', '拒绝');
      accept.type = 'button';
      reject.type = 'button';
      // 不做乐观更新：只有 IPC 成功后才重新读库；失败时按钮恢复、条目留在原分组。
      const decide = async (decision) => {
        accept.disabled = true;
        reject.disabled = true;
        try {
          const result = await window.companion.knowledge.review({ id: item.id, decision });
          if (!result?.ok) {
            toast(result?.reason ?? '审核失败，请稍后再试。', 6000);
            accept.disabled = false;
            reject.disabled = false;
            return;
          }
          toast(decision === 'approved' ? '已接受候选，成为待验证的知识' : '已拒绝候选', 4000);
          await loadKnowledgeBrowse();
        } catch (error) {
          toast(String(error?.message ?? error), 6000);
          accept.disabled = false;
          reject.disabled = false;
        }
      };
      accept.onclick = () => { void decide('approved'); };
      reject.onclick = () => { void decide('rejected'); };
      actions.append(accept, reject);
      row.append(actions);
    }

    // #61：每条经验都能一键提为知识候选（走既有审核流，不自动接受）。
    if (item.kind === 'lesson') {
      const actions = el('div', 'kb-item-actions');
      const promote = el('button', 'kb-act promote', '提升为候选');
      promote.type = 'button';
      promote.onclick = async () => {
        promote.disabled = true;
        try {
          const result = await window.companion.knowledge.promoteLesson({ lessonId: item.id });
          toast(result?.created
            ? '已提交为知识候选，等待审核'
            : (result?.reason === 'approved' ? '这条经验已经落成知识，不再重复提交' : '这条经验已有待审候选，未重复提交'),
          4000);
          await loadKnowledgeBrowse();
        } catch (error) {
          toast(String(error?.message ?? error), 6000);
          promote.disabled = false;
        }
      };
      actions.append(promote);
      row.append(actions);
    }
    return row;
  };

  // 把纯视图模型渲染成卡片；这里只做 DOM 与项目显示名，不重新计算归属。
  const knowledgeGroupCard = (group) => {
    const card = el('section', `kb-group kb-${group.key}`);
    const head = el('div', 'kb-group-head');
    head.append(el('h4', 'kb-group-name', group.label));
    head.append(el('span', 'kb-group-count', `${group.count} 条`));
    card.append(head);
    if (group.items.length === 0) {
      card.append(el('p', 'kb-group-empty', group.emptyHint));
      return card;
    }
    const list = el('div', 'kb-list');
    for (const item of group.items) list.append(knowledgeItemRow(item));
    card.append(list);
    if (group.truncated) {
      card.append(el('p', 'kb-group-more', `共 ${group.count} 条，只显示最近 ${group.shown} 条。`));
    }
    return card;
  };

  const renderKnowledgeBrowse = () => {
    const holder = $('kbGroups');
    const filters = $('kbFilters');
    holder.replaceChildren();
    filters.replaceChildren();
    const data = knowledgeBrowseData;

    const chip = (id, label, count) => {
      const button = el('button', `kb-chip${id === knowledgeBrowseProject ? ' on' : ''}`);
      button.type = 'button';
      button.append(el('span', undefined, label));
      if (count !== undefined) button.append(el('span', 'kb-chip-count', String(count)));
      button.onclick = () => {
        if (knowledgeBrowseProject === id) return;
        knowledgeBrowseProject = id;
        void loadKnowledgeBrowse();
      };
      return button;
    };

    if (!data) {
      filters.append(chip('', '全部'));
      holder.append(el('p', 'kb-loading', '正在读取本地知识库…'));
      return;
    }

    $('kbTotal').textContent = String(data.totals?.all ?? 0);
    filters.append(chip('', '全部', data.overall?.all ?? data.totals?.all ?? 0));
    for (const project of data.projects ?? []) {
      filters.append(chip(project.id, projectLabel(project.id), project.count));
    }
    // 从操作区「去提炼」跳进来的项目可能还没有任何知识条目（只有未提炼的执行记录）：
    // 补一个 0 条的筛选按钮，否则「定位到项目」看起来像没生效。
    if (knowledgeBrowseProject
      && !(data.projects ?? []).some((project) => project.id === knowledgeBrowseProject)) {
      filters.append(chip(knowledgeBrowseProject, projectLabel(knowledgeBrowseProject), 0));
    }

    if (!data.available) {
      const empty = el('div', 'kb-empty');
      empty.append(el('div', 'kb-empty-title', '知识库还没有初始化'));
      empty.append(el('div', 'kb-empty-sub', data.empty?.detail ?? '本地 SQLite 打不开时这里只显示说明。'));
      holder.append(empty);
      return;
    }

    if (data.empty) {
      const empty = el('div', 'kb-empty');
      empty.append(el('div', 'kb-empty-title', data.empty.title));
      empty.append(el('div', 'kb-empty-sub', data.empty.detail));
      holder.append(empty);
    }
    // 即使全空也保留三组与计数，让「候选 / 已验证 / 经验」的结构始终可见。
    for (const group of data.groups ?? []) holder.append(knowledgeGroupCard(group));
  };

  const loadKnowledgeBrowse = async () => {
    const token = ++knowledgeBrowseToken;
    const started = performance.now();
    try {
      const data = await window.companion.knowledge.browse({ projectId: knowledgeBrowseProject });
      if (token !== knowledgeBrowseToken) return;
      knowledgeBrowseData = data;
      // 提议只在操作区出现（#71 是「搬」不是「复制」）：知识页不再读提议信号，
      // 这里只留三层浏览所需的读库结果。
      // 所选项目在新数据里已经不存在时才退回「全部」。项目还在、只是还没有
      // 知识条目时保留筛选：从操作区「去提炼」跳过来时，那个项目很可能正是空的。
      const projectExists = (data.projects ?? []).some((item) => item.id === knowledgeBrowseProject)
        || (view?.projects ?? []).some((item) => item.id === knowledgeBrowseProject);
      if (knowledgeBrowseProject && !projectExists) {
        knowledgeBrowseProject = '';
        void loadKnowledgeBrowse();
        return;
      }
      renderKnowledgeBrowse();
      const elapsed = Math.round(performance.now() - started);
      // #42 AC4：一屏知识列表要在 1 秒内渲染完。超时留下痕迹，e2e 直接读这两个属性。
      $('knowledgeBrowse').dataset.renderMs = String(elapsed);
      $('knowledgeBrowse').dataset.renderBudget = elapsed <= 1000 ? 'ok' : 'over';
    } catch (error) {
      if (token !== knowledgeBrowseToken) return;
      knowledgeBrowseData = null;
      const holder = $('kbGroups');
      holder.replaceChildren();
      const box = el('div', 'kb-empty');
      box.append(el('div', 'kb-empty-title', '读取知识库失败'));
      box.append(el('div', 'kb-empty-sub', String(error?.message ?? error)));
      holder.append(box);
    }
  };

  // ---- 技能目录：三处来源合并的只读列表 ----

  let skillCatalogData = null;
  let skillCatalogToken = 0;

  // 对话的隐式技能：由服务端给出（配置或默认七个），面板只读。
  const skillImplicitIds = () => (
    Array.isArray(skillCatalogData?.implicitSkillIds) ? skillCatalogData.implicitSkillIds : []
  );

  // 只渲染主进程给的数据；来源标签与缺失标注都由视图模型算好，面板不重新判断。
  const renderSkillCatalog = () => {
    const holder = $('skillGroups');
    holder.replaceChildren();
    const data = skillCatalogData;
    if (!data) {
      holder.append(el('p', 'kb-loading', '正在扫描技能目录…'));
      return;
    }
    $('skillTotal').textContent = String(data.totals?.all ?? 0);
    const missingTotal = data.totals?.missing ?? 0;
    $('skillMissing').hidden = missingTotal === 0;
    $('skillMissing').textContent = `${missingTotal} 个缺失`;

    if (data.empty) {
      const empty = el('div', 'kb-empty');
      empty.append(el('div', 'kb-empty-title', data.empty.title));
      empty.append(el('div', 'kb-empty-sub', data.empty.detail));
      holder.append(empty);
    }

    for (const group of data.groups ?? []) {
      const card = el('section', `skill-group skill-${group.key}`);
      const head = el('div', 'kb-group-head');
      head.append(el('h4', 'kb-group-name', group.label));
      head.append(el('span', 'kb-group-count',
        group.missing ? `${group.count} 个 · 缺失 ${group.missing}` : `${group.count} 个`));
      card.append(head);
      if (!group.items.length) {
        card.append(el('p', 'kb-group-empty', '这一处没有声明的技能。'));
        holder.append(card);
        continue;
      }
      const list = el('div', 'skill-list');
      for (const item of group.items) {
        // 用原生 details：点开即展开，不需要额外按钮，也就没有编辑/运行入口。
        const row = el('details', `skill-item${item.missing ? ' is-missing' : ''}`);
        row.dataset.skill = item.id;
        const summary = el('summary', 'skill-summary');
        summary.append(el('span', 'skill-name', item.name));
        summary.append(el('span', 'skill-source', item.sourceLabel));
        if (!item.missing) {
          const implicit = skillImplicitIds();
          const box = el('input', 'skill-implicit');
          box.type = 'checkbox';
          box.title = '用于对话（隐式可用，最多 12 个）';
          box.setAttribute('aria-label', `把 ${item.name} 用于对话`);
          box.checked = implicit.includes(item.id);
          box.onclick = (event) => event.stopPropagation();
          box.onchange = async () => {
            const next = new Set(skillImplicitIds());
            if (box.checked) next.add(item.id);
            else next.delete(item.id);
            const picked = [...next];
            if (picked.length > 12) {
              box.checked = false;
              toast('对话技能最多 12 个：再多会把提示词撑爆。', 6000);
              return;
            }
            try {
              await window.companion.settings.set({ chatSkills: picked });
              if (skillCatalogData) skillCatalogData.implicitSkillIds = picked;
              void loadSkillCatalog();
            } catch (error) {
              box.checked = !box.checked;
              toast(String(error?.message ?? error), 6000);
            }
          };
          summary.append(box);
        }
        // playbook 本来就没有 skill 目录（面板按钮直接生成），如实标注，不当成缺失报警。
        if (item.playbookOnly) {
          summary.append(el('span', 'skill-badge-playbook', 'playbook · 无 skill 目录'));
        } else if (item.missing) {
          summary.append(el('span', 'skill-badge-missing', '缺失'));
        }
        row.append(summary);
        const detail = el('div', 'skill-detail');
        const rows = el('dl', 'detail-rows');
        const addRow = (label, value, className) => {
          rows.append(el('dt', undefined, label));
          rows.append(el('dd', className, value));
        };
        addRow('来源',
          item.origin && item.origin !== item.sourceLabel ? `${item.sourceLabel} · ${item.origin}` : item.sourceLabel);
        addRow('路径',
          item.playbookOnly
            ? '（playbook · 无 skill 目录）'
            : (item.path || '（没有可指向的路径）'),
          'skill-path');
        addRow('描述',
          item.description || (item.playbookOnly
            ? '由面板按钮直接生成，不读 SKILL.md。'
            : (item.missing ? '（技能缺失，没有描述）' : '（SKILL.md 没有写描述）')),
          'skill-desc');
        detail.append(rows);
        if (item.missing) detail.append(el('p', 'skill-missing-reason', `缺失原因：${item.reason}`));
        row.append(detail);
        list.append(row);
      }
      card.append(list);
      if (group.truncated) {
        card.append(el('p', 'kb-group-more',
          `共 ${group.count} 个，只显示前 ${group.shown} 个（缺失的排在最前）。`));
      }
      holder.append(card);
    }
  };

  const loadSkillCatalog = async ({ refresh = false } = {}) => {
    const token = ++skillCatalogToken;
    try {
      const data = await window.companion.skills.catalog({ refresh });
      if (token !== skillCatalogToken) return;
      skillCatalogData = data;
      renderSkillCatalog();
      $('skillCatalog').dataset.scanState = data.cached ? 'cached' : 'fresh';
    } catch (error) {
      if (token !== skillCatalogToken) return;
      skillCatalogData = null;
      const holder = $('skillGroups');
      holder.replaceChildren();
      const box = el('div', 'kb-empty');
      box.append(el('div', 'kb-empty-title', '扫描技能目录失败'));
      box.append(el('div', 'kb-empty-sub', String(error?.message ?? error)));
      holder.append(box);
    }
  };

  // ---- 三种视图模式：专注 / 知识 / 对话（与 ADR-0006 同名，不用再猜 A/B/C） ----

  const MODE_VIEW = { focus: 'modeA', knowledge: 'modeB', chat: 'modeC' };

  const setMode = (next, { persist = true } = {}) => {
    const mode = MODE_VIEW[next] ? next : 'knowledge';
    panelMode = mode;
    if (persist) {
      try { localStorage.setItem('panelMode', mode); } catch { /* ignore */ }
    }
    for (const [key, id] of Object.entries(MODE_VIEW)) {
      const node = $(id);
      if (node) node.hidden = key !== mode;
    }
    for (const button of document.querySelectorAll('#modeBar button')) {
      button.classList.toggle('on', button.dataset.mode === mode);
    }
    const hasProjects = (view?.projects?.length ?? 0) > 0;
    // 交办输入框只属于专注；对话模式用自己的输入，知识模式只读。
    $('composeSection').hidden = !hasProjects || mode !== 'focus';
    if (mode === 'focus') renderFocusMode();
    if (mode === 'knowledge') {
      void loadKnowledgeBrowse();
      // 主进程缓存一分钟；这里每次进入知识模式都读一次，顺便把上一次扫描结果带回来。
      void loadSkillCatalog();
    }
    if (mode === 'chat') {
      // 会话列表来自本地库：切换到对话模式时恢复上次会话。
      void ensureChatSession();
      renderChatCards();
      renderChatHandoff();
    }
  };

  // 专注页两区：上半区操作区（待办 / 运行中 / 待提炼），下半区工作区
  // （项目名 + 切换 + 四个入口 + 项目各段）。容器写在 panel.html。
  const renderFocusMode = () => {
    renderOps();
    renderWorkProjectBar();
    renderWorkEntries();
    renderSinceSeen();
  };

  // ---- 对话：会话持久化（按项目分组、切换、重命名、删除） ----
  const CHAT_SESSION_KEY = 'owner-chat-session';
  // 与主进程 chat-sessions.mjs 的默认标题保持一致，仅用于判断是否需要「新建」提示。
  const CHAT_DEFAULT_TITLE = '新会话';
  const chatLog = [];
  let chatGreeted = false;
  let chatBusy = false;
  let chatSessions = [];
  let activeChatSessionId = '';
  let chatSessionsBound = false;
  // 「交办」开关：一次性动作，只放内存。关＝只回答；开＝这次发送走审批链路建任务。
  let chatHandoffArmed = window.OwnerChatHandoff?.DEFAULT_ARMED === true;
  // 只有真正把消息画进 transcript 后，才认为会话已打开；否则重启后只会恢复标题却空着。
  let chatSessionOpened = '';

  const chatProjectName = (projectId) =>
    view?.projects?.find((item) => item.id === projectId)?.name || projectId || '未绑定项目';
  const activeChatSession = () =>
    chatSessions.find((item) => item.id === activeChatSessionId) ?? null;

  /** 对话的交办目标 = 会话显式绑定项目的交办目标；没绑定或项目已删时为 null。 */

  /**
   * 画「交办」开关：默认关闭；打开时把目标项目与「这次发送会建任务」写在输入框旁。
   * 只改 DOM，不写 localStorage / companion.json——重启后必然回到关闭。
   */
  const renderChatHandoff = () => {
    const button = $('cHandoff');
    if (!button) return;
    const api = window.OwnerChatHandoff;
    const target = handoffTarget(activeChatSession()?.projectId);
    button.setAttribute('aria-pressed', chatHandoffArmed ? 'true' : 'false');
    button.title = chatHandoffArmed
      ? '这次发送会生成一条待批准任务（走审批）；发送后开关自动关闭'
      : '打开后这次发送会生成一条待批准任务（走审批）；关掉就只是提问';
    const label = $('cHandoffTarget');
    if (label) {
      label.hidden = !chatHandoffArmed;
      label.textContent = target
        ? `交办到 ${target.name || target.id}`
        : '未选项目：先新建会话并选项目';
    }
    const send = $('cSend');
    if (send) send.textContent = api?.sendLabel(chatHandoffArmed) ?? '发送';
    const input = $('cInput');
    if (input) {
      // 输入框变窄（多了开关和项目名），占位文案压到一行内，避免被截断成两行。
      input.placeholder = chatHandoffArmed ? '要改什么…' : '问项目里的事，只读回答…';
    }
  };
  // 列表时间：当天只显示时分，跨天补上月/日，避免旧会话看起来像刚发生。
  const chatWhen = (value) => {
    const at = new Date(String(value ?? ''));
    if (Number.isNaN(at.getTime())) return '';
    const today = new Date();
    const sameDay = at.toDateString() === today.toDateString();
    return sameDay
      ? fmtTime(value)
      : `${at.getMonth() + 1}/${at.getDate()}`;
  };

  const chatAppend = (role, text, { status = 'ok', citations = null } = {}) => {
    chatLog.push({ role, text });
    const node = el('div', `c-msg ${role}${status === 'error' ? ' error' : ''}`, text);
    $('cTranscript').append(node);
    // 已核对的引用单独一行展示，避免把模型猜的路径当成事实。
    if (Array.isArray(citations) && citations.length) {
      const row = el('div', 'c-cites');
      for (const cite of citations.slice(0, 8)) {
        row.append(el('span', 'c-cite', cite.line ? `${cite.path}:${cite.line}` : cite.path));
      }
      $('cTranscript').append(row);
    }
    $('cTranscript').scrollTop = $('cTranscript').scrollHeight;
    return node;
  };

  const renderChatMessages = (messages) => {
    $('cTranscript').replaceChildren();
    chatLog.length = 0;
    for (const message of messages ?? []) {
      chatAppend(message.role === 'user' ? 'me' : 'bot', message.text, {
        status: message.status,
        citations: message.citations
      });
    }
  };

  /** 列表分组：项目顺序跟随专注模式，组内按最近更新排。 */
  const renderChatSessionList = () => {
    const holder = $('cSessionList');
    holder.replaceChildren();
    $('cSessionCount').textContent = String(chatSessions.length);
    const current = activeChatSession();
    $('cSessionTitle').textContent = current
      ? `${chatProjectName(current.projectId)} · ${current.title}`
      : '还没有会话';
    if (!chatSessions.length) {
      holder.append(el(
        'div',
        'c-session-empty',
        '还没有会话。点右上角「新建」先选项目再开始；每个会话只属于一个项目，删除会话不影响项目数据。'
      ));
      return;
    }
    const groups = new Map();
    for (const session of chatSessions) {
      if (!groups.has(session.projectId)) groups.set(session.projectId, []);
      groups.get(session.projectId).push(session);
    }
    const order = (view?.projects ?? []).map((item) => item.id);
    for (const projectId of groups.keys()) {
      if (!order.includes(projectId)) order.push(projectId);
    }
    for (const projectId of order) {
      const items = groups.get(projectId);
      if (!items?.length) continue;
      const group = el('div', 'c-session-group');
      const head = el('div', 'c-session-group-head');
      head.append(el('span', undefined, chatProjectName(projectId)));
      head.append(el('span', undefined, `${items.length} 个会话`));
      group.append(head);
      for (const session of items) {
        const row = el('div', `c-session-item${session.id === activeChatSessionId ? ' on' : ''}`);
        row.dataset.sessionId = session.id;
        const open = el('button', 'c-session-open', session.title);
        open.title = `切换到这个会话（${session.messageCount} 条消息）`;
        open.onclick = () => { void openChatSession(session.id); };
        const meta = el('span', 'c-session-meta',
          `${session.messageCount} 条 · ${chatWhen(session.updatedAt)}`);
        const rename = el('button', 'c-session-action', '改名');
        rename.onclick = () => openRenameChatSession(session);
        const remove = el('button', 'c-session-action', '删除');
        remove.onclick = () => openDeleteChatSession(session);
        row.append(open, meta, rename, remove);
        group.append(row);
      }
      holder.append(group);
    }
  };

  const loadChatSessions = async () => {
    try {
      const result = await window.companion.chat.sessions.list();
      chatSessions = Array.isArray(result?.items) ? result.items : [];
    } catch (error) {
      chatSessions = [];
      toast(`会话列表读取失败：${String(error?.message ?? error)}`, 5000);
    }
    renderChatSessionList();
    renderChatHandoff();
  };

  const openChatSession = async (id, { silent = false } = {}) => {
    try {
      const session = await window.companion.chat.sessions.get({ id });
      activeChatSessionId = session.id;
      chatSessionOpened = session.id;
      chatGreeted = true;
      try { localStorage.setItem(CHAT_SESSION_KEY, session.id); } catch { /* 本地记忆失败不影响会话 */ }
      renderChatMessages(session.messages);
      if (!(session.messages ?? []).length) {
        chatAppend(
          'bot',
          session.title === CHAT_DEFAULT_TITLE
            ? `这是新建的会话，绑定 ${chatProjectName(session.projectId)}。直接问就行。`
            : `这是「${session.title}」，绑定 ${chatProjectName(session.projectId)}。直接问就行。`
        );
      }
      renderChatSessionList();
      renderChatHandoff();
      $('cTranscript').scrollTop = $('cTranscript').scrollHeight;
      return session;
    } catch (error) {
      if (!silent) toast(String(error?.message ?? error), 5000);
      return null;
    }
  };

  /** 进入对话模式时恢复上次会话；没有历史就落到最近一次创建。 */
  const ensureChatSession = async () => {
    if (!chatSessionsBound) {
      chatSessionsBound = true;
      try {
        activeChatSessionId = localStorage.getItem(CHAT_SESSION_KEY) ?? '';
      } catch { activeChatSessionId = ''; }
    }
    await loadChatSessions();
    const current = activeChatSession();
    // 只有 transcript 已经画过这个会话才提前返回；否则重启后会只剩标题、正文空白。
    if (current && chatSessionOpened === current.id) return;
    if (!chatSessions.length) {
      activeChatSessionId = '';
      chatSessionOpened = '';
      renderChatHandoff();
      if (!chatLog.length) {
        chatGreeted = false;
        greetChatOnce();
      }
      return;
    }
    await openChatSession((current ?? chatSessions[0]).id, { silent: true });
  };

  const openNewChatSession = ({ draft = '' } = {}) => {
    const projects = view?.projects ?? [];
    if (!projects.length) {
      toast('先添加一个项目：会话必须绑定项目。', 5000);
      return;
    }
    // ADR-0006：新建会话必须多一次显式选择。默认空选项，不做静默预选。
    const select = el('select');
    const placeholder = el('option', undefined, '请选择项目');
    placeholder.value = '';
    placeholder.disabled = true;
    placeholder.selected = true;
    select.append(placeholder);
    for (const project of projects) {
      const option = el('option', undefined, project.name || project.id);
      option.value = project.id;
      select.append(option);
    }
    select.value = '';
    const title = el('input');
    title.maxLength = 60;
    title.placeholder = '留空则用第一个问题自动命名';
    const projectField = el('label', 'c-field');
    projectField.append(el('span', undefined, '绑定项目'), select);
    const titleField = el('label', 'c-field');
    titleField.append(el('span', undefined, '标题（可选）'), title);
    const note = el('p', 'c-field-note',
      '会话只保存消息文本与时间，不改动项目数据；删除会话也不会影响项目。');
    const cancel = el('button', 'ghost', '取消');
    cancel.onclick = closeModal;
    const create = el('button', 'primary', '新建会话');
    // 没选项目就不能创建：按钮的禁用状态只由这一个显式选择决定。
    create.disabled = true;
    select.onchange = () => { create.disabled = !select.value; };
    create.onclick = async () => {
      if (!select.value) return;
      create.disabled = true;
      try {
        const session = await window.companion.chat.sessions.create({
          projectId: select.value,
          title: title.value
        });
        closeModal();
        chatSessionsBound = true;
        await loadChatSessions();
        await openChatSession(session.id);
        $('cSessionList').hidden = true;
        $('cSessionsToggle').setAttribute('aria-expanded', 'false');
        if (draft) {
          $('cInput').value = draft;
          void sendChat();
        } else {
          $('cInput').focus();
        }
      } catch (error) {
        create.disabled = false;
        toast(String(error?.message ?? error), 6000);
      }
    };
    openModal('新建会话', [projectField, titleField, note], [cancel, create]);
    // 焦点落在项目选择上：先选项目，再（可选）填标题。
    select.focus();
  };

  const openRenameChatSession = (session) => {
    const input = el('input');
    input.maxLength = 60;
    input.value = session.title;
    const field = el('label', 'c-field');
    field.append(el('span', undefined, '标题'), input);
    const cancel = el('button', 'ghost', '取消');
    cancel.onclick = closeModal;
    const save = el('button', 'primary', '保存');
    save.onclick = async () => {
      const value = input.value.trim();
      if (!value) { toast('标题不能为空。'); return; }
      save.disabled = true;
      try {
        await window.companion.chat.sessions.rename({ id: session.id, title: value });
        closeModal();
        await loadChatSessions();
        toast('已重命名');
      } catch (error) {
        save.disabled = false;
        toast(String(error?.message ?? error), 5000);
      }
    };
    openModal('重命名会话', [field], [cancel, save]);
    input.focus();
    input.select();
  };

  const openDeleteChatSession = (session) => {
    const wasActive = session.id === activeChatSessionId;
    const text = el('p', 'c-field-note',
      `只删除「${session.title}」这段对话（${session.messageCount} 条消息），不会删除项目，也不会改动项目数据。`);
    const cancel = el('button', 'ghost', '取消');
    cancel.onclick = closeModal;
    const remove = el('button', 'primary', '删除会话');
    remove.onclick = async () => {
      remove.disabled = true;
      try {
        await window.companion.chat.sessions.remove({ id: session.id });
        closeModal();
        if (wasActive) {
          activeChatSessionId = '';
          chatSessionOpened = '';
          try { localStorage.removeItem(CHAT_SESSION_KEY); } catch { /* ignore */ }
        }
        await loadChatSessions();
        if (!wasActive) {
          toast('已删除这段会话，项目数据未受影响');
          return;
        }
        const next = chatSessions[0];
        if (next) await openChatSession(next.id, { silent: true });
        else {
          renderChatMessages([]);
          chatGreeted = false;
          greetChatOnce();
        }
        toast('已删除这段会话，项目数据未受影响');
      } catch (error) {
        remove.disabled = false;
        toast(String(error?.message ?? error), 5000);
      }
    };
    openModal('删除会话', [text], [cancel, remove]);
  };

  const greetChatOnce = () => {
    if (chatGreeted) return;
    chatGreeted = true;
    const pending = view?.pending?.length ?? 0;
    const project = view?.projects?.find((item) => item.id === view?.activeProjectId) ?? view?.projects?.[0];
    if (!project) {
      chatAppend('bot', '还没有登记项目。切到「专注」展开工作区，先添加一个目录。');
      return;
    }
    const lines = [`我在看 ${project.name || project.id}。`];
    lines.push('这里只能读文件：可以查代码和配置来回答，但不会改任何东西；要改请打开输入框左边的「交办」开关，生成待批准任务。');
    lines.push('会话会保存在本地：左上角「会话」按项目列出，可新建、切换、改名或删除。');
    const model = String(view?.config?.model ?? '').trim();
    if (!model) {
      // 没有模型时不假装能回答：直接说明缺什么、去哪里补。
      lines.push('现在还没有配置模型，暂时没法读文件回答。先打开设置选一个模型（需要 Pi 登录或 API key），再回来提问。');
      chatAppend('bot', lines.join('\n'));
      const row = el('div', 'c-greet-actions');
      const open = el('button', 'c-yes', '打开设置');
      open.onclick = () => { $('openSettings').click(); };
      row.append(open);
      $('cTranscript').append(row);
      $('cTranscript').scrollTop = $('cTranscript').scrollHeight;
      return;
    }
    lines.push(pending > 0 ? `现在有 ${pending} 件事等你决定，列在下面。` : '现在没有需要你决定的事。');
    lines.push('直接点「新建」开一个会话，或用左上角切到已有的会话。');
    chatAppend('bot', lines.join('\n'));
  };

  const renderChatCards = () => {
    const holder = $('cCards');
    holder.replaceChildren();
    const pending = Array.isArray(view?.pending) ? view.pending : [];
    for (const item of pending.slice(0, 3)) {
      const card = el('div', 'c-card');
      card.append(el('div', 'c-kicker', item.kind === 'patch' ? '补丁待审' : item.kind === 'job' ? '任务待批' : '待确认'));
      card.append(el('div', 'c-title', item.title || item.id));
      if (item.summary) card.append(el('div', 'c-sub', item.summary));

      const row = el('div', 'c-actions');
      const yes = el('button', 'c-yes', '批准');
      const no = el('button', 'c-no', '拒绝');
      const decide = async (action) => {
        yes.disabled = true;
        no.disabled = true;
        try {
          await window.companion.decide({ kind: item.kind, id: item.id, action, hash: item.hash || '' });
          chatAppend('bot', `${action === 'approve' ? '已批准' : '已拒绝'}：${item.title || item.id}`);
          await refresh();
        } catch (error) {
          chatAppend('bot', `操作失败：${String(error?.message ?? error)}`);
          yes.disabled = false;
          no.disabled = false;
        }
      };
      yes.onclick = () => { void decide('approve'); };
      no.onclick = () => { void decide('reject'); };
      row.append(yes, no);
      card.append(row);
      holder.append(card);
    }
  };

  /**
   * 交办路径：把这句话交给既有审批链路（companion:submit）。
   * 主进程照旧先只读分诊，需要写入时才生成 pending_approval 写请求；
   * 这里既不新建任务类型，也不绕过批准——只是把「要不要建任务」的决定权从模型挪到人手上。
   */
  const handoffChat = async (session, text) => {
    const target = handoffTarget(session?.projectId);
    if (!target) {
      // 沿用 #41：没选项目就拦下，不静默落到第一个项目。
      renderChatHandoff();
      toast('先选这次要交办的项目：会话还没绑定可用项目。', 5000);
      return;
    }
    chatBusy = true;
    $('cSend').disabled = true;
    $('cInput').value = '';
    chatAppend('me', text);
    // 交办与普通提问一样落会话库：先存问题，重启后至少能看见自己问过什么。
    const persist = (role, body, status = 'ok') =>
      window.companion.chat.sessions.append({ id: session.id, role, text: body, status });
    const thinking = el('div', 'c-msg bot',
      `正在交办到 ${target.name || target.id}：先只读分析，再生成待批准任务…`);
    try {
      await persist('user', text);
      $('cTranscript').append(thinking);
      $('cTranscript').scrollTop = $('cTranscript').scrollHeight;
      // captureIdea: false —— 交办是明确的动作，不该再被当成一条「想法」重复收集。
      const result = await window.companion.submit({
        text,
        projectId: target.id,
        captureIdea: false
      });
      thinking.remove();
      const kind = window.OwnerChatHandoff?.resultKind(result) ?? 'error';
      let reply = '';
      let status = 'ok';
      if (kind === 'task') {
        reply = `已生成待批准任务「${result.intent || text.slice(0, 40)}」（${result.jobId}）。\n`
          + '它在「专注」的待办里等你批准，批准之前不会改动任何文件；'
          + '这次交办和结果都保存在本会话里，重启后仍能看到。';
        toast('已生成待批准任务；到专注页待办里批准后才会动手', 6000);
        // 立刻刷新快照，专注页待办能马上看到这条任务，而不是等下一次轮询。
        await refresh();
      } else if (kind === 'answer') {
        reply = `这次分诊判断不需要改文件，只回答、没有生成任务：\n${result?.summary || '（没有结论）'}`;
      } else {
        reply = `交办没跑通，没有生成任务：${result?.advice || result?.summary || '请检查模型配置后重试。'}`;
        status = 'error';
      }
      chatAppend('bot', reply, { status });
      try {
        await persist('assistant', reply, status);
      } catch (error) {
        toast(`会话记录写入失败：${String(error?.message ?? error)}`, 6000);
      }
      await loadChatSessions();
    } catch (error) {
      thinking.remove();
      // 失败时把内容放回输入框，别让人重写。
      if (!$('cInput').value.trim()) $('cInput').value = text;
      const reply = `交办失败，没有生成任务：${String(error?.message ?? error)}`;
      chatAppend('bot', reply, { status: 'error' });
      // 答不上模型时也要把「失败」写进去，避免历史里只剩一条孤零零的提问。
      try {
        await persist('assistant', reply, 'error');
      } catch { /* 存储不可用时已经在正文里说明失败原因 */ }
    } finally {
      chatBusy = false;
      $('cSend').disabled = false;
      $('cInput').focus();
      // 一次性动作：这次发送之后开关一定回到关闭（含失败），不会悄悄对下一条生效。
      const next = window.OwnerChatHandoff?.consume(chatHandoffArmed) ?? { armed: false };
      chatHandoffArmed = next.armed === true;
      renderChatHandoff();
    }
  };

  const sendChat = async () => {
    const text = $('cInput').value.trim();
    if (!text || chatBusy) return;
    const session = activeChatSession();
    if (!session) {
      // 没有会话时不偷偷落到某个项目：先让 Owner 明确选项目。
      openNewChatSession({ draft: text });
      return;
    }
    // 两条互斥路径：开关关＝只回答（只读会话，绝不建任务）；开＝走交办。
    if ((window.OwnerChatHandoff?.routeOf(chatHandoffArmed) ?? 'answer') === 'handoff') {
      await handoffChat(session, text);
      return;
    }
    chatBusy = true;
    $('cSend').disabled = true;
    $('cInput').value = '';
    chatAppend('me', text);
    const thinking = el('div', 'c-msg bot', '正在读项目文件…');
    $('cTranscript').append(thinking);
    $('cTranscript').scrollTop = $('cTranscript').scrollHeight;
    try {
      // 对话模式走只读 Pi 会话；消息由主进程写进本地会话库。
      const result = await window.companion.chat.ask({
        sessionId: session.id,
        question: text,
        projectId: session.projectId
      });
      thinking.remove();
      if (result?.status === 'ok') {
        chatAppend('bot', result.answer || '没有结论。', { citations: result.citations });
      } else {
        // no-model / auth-error 等都由主进程给出可执行提示，这里原样展示。
        chatAppend('bot', result?.advice || '这次没跑通，可以再说一次。', { status: 'error' });
      }
      // 首个问题会自动命名，列表需要同步刷新。
      await loadChatSessions();
    } catch (error) {
      thinking.remove();
      chatAppend('bot', `失败：${String(error?.message ?? error)}`, { status: 'error' });
    } finally {
      chatBusy = false;
      $('cSend').disabled = false;
      $('cInput').focus();
    }
  };

  $('cSessionsToggle').onclick = () => {
    const list = $('cSessionList');
    const next = list.hidden;
    list.hidden = !next;
    $('cSessionsToggle').setAttribute('aria-expanded', String(next));
    if (next) void loadChatSessions();
  };
  $('cSessionNew').onclick = () => openNewChatSession();


  for (const button of document.querySelectorAll('#modeBar button')) {
    button.onclick = () => setMode(button.dataset.mode);
  }
  $('cSend').onclick = () => { void sendChat(); };
  // 「交办」开关只翻内存标记：不写 localStorage，重启必然回到关闭。
  $('cHandoff').onclick = () => {
    chatHandoffArmed = !chatHandoffArmed;
    renderChatHandoff();
    if (chatHandoffArmed && !handoffTarget(activeChatSession()?.projectId)) {
      toast('这个会话还没绑定可用项目；先新建会话并选项目。', 5000);
    }
    $('cInput').focus();
  };
  $('cInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendChat();
    }
  });

  window.companion.onOpenSettings(() => { void openSettings(true); });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      // 交办项目菜单打开时，Esc 只收起菜单，别把整个面板一起藏掉。
      const menu = $('handoffTargetMenu');
      if (menu && !menu.hidden) { closeHandoffMenu(); return; }
      if (!$('modal').hidden) closeModal();
      else if (!$('settings').hidden) $('settings').hidden = true;
      else window.companion.hidePanel();
    }
  });

  // 操作区模型是 ESM（src/focus-ops.mjs），由 focus-ops-host.mjs 挂到 window；
  // 模块脚本晚于本脚本执行，就绪时补画一次，不用等下一次 2 秒轮询。
  window.addEventListener('owner-focus-ops-ready', () => {
    if (panelMode === 'focus') renderOps();
  });

  // 「自上次看过」的形态判定也是 ESM（src/memory/since-last-seen.mjs），
  // 就绪前已算好的数据在这里补画一次，不用等下一次进入项目。
  window.addEventListener('owner-since-seen-ready', () => {
    if (panelMode === 'focus') renderSinceSeen();
  });

  void refresh().then(() => {
    try { setMode(localStorage.getItem('panelMode') || 'knowledge', { persist: false }); } catch { setMode('knowledge', { persist: false }); }
    void loadPlaybooks();
  });
  window.setInterval(refresh, 2000);
})();
