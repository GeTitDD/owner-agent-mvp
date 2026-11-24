(() => {
  const $ = (id) => document.getElementById(id);
  const stateText = {
    idle: '空闲',
    working: '工作中',
    waiting: '等你决定',
    done: '已完成',
    error: '遇到异常'
  };
  let view = null;
  let panelMode = 'B';
  let refreshing = false;
  let composerBusy = false;
  let toastTimer = null;

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
    $('pendingBadge').textContent = String(pending);
    $('pendingBadge').hidden = pending === 0;
    // 待办是专注页第一张卡：没有待办时卡片留着，用一句话说明，别让专注页只剩详情。
    $('needsSection').hidden = false;
    $('pendingList').hidden = pending === 0;
    $('needsHint').hidden = false;
    $('needsCount').textContent = String(pending);
    $('needsChip').classList.toggle('warn', pending > 0);
    $('needsHint').textContent = pending === 0
      ? '现在没有需要你决定的事；下面可以看这个项目的样子。'
      : `有 ${pending} 项需要你确认；写入、补丁与测试在批准前不会改变真实项目。`;
    const running = view?.worker?.running;
    const playbookRunning = view?.playbook?.running === true;
    const chainItems = [view?.chain?.job, view?.chain?.patch, view?.chain?.sandbox, view?.chain?.cycle]
      .filter(Boolean);
    const activeStatuses = new Set(['running', 'leased', 'provisioning', 'collecting', 'test_pending', 'queued']);
    const activeSteps = chainItems.filter((item) => activeStatuses.has(String(item.status ?? '').toLowerCase())).length;
    const totalSteps = chainItems.length;
    const activeCount = activeSteps + (playbookRunning ? 1 : 0);
    $('runningBadge').textContent = String(activeCount || totalSteps);
    $('runningCount').textContent = String(activeCount);
    $('runningChip').classList.toggle('active', Boolean(running || playbookRunning || activeSteps > 0));
    $('runningTitle').textContent = (activeSteps > 0 || playbookRunning)
      ? '运行中'
      : (totalSteps > 0 ? '最近任务' : '运行中');
    const hasProjects = (view?.projects?.length ?? 0) > 0;
    // 没有项目时自动展开工作区，否则添加项目的入口会被折叠在下面。
    if (!hasProjects && $('workspaceToggle')) $('workspaceToggle').open = true;
    $('setup').hidden = hasProjects;
    $('composeSection').hidden = !hasProjects || panelMode !== 'A';
    $('submitTask').disabled = composerBusy || !hasProjects;
    $('queueSection').hidden = !hasProjects;
    if (!hasProjects) renderServiceGrid($('setupServices'), view?.services);
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
      $('testWarningText').textContent = testConfig.reason === 'disabled'
        ? '已按设置跳过沙箱测试；补丁只做人工验证。'
        : `当前项目（${testConfig.ecosystem || 'unknown'}）没有可用沙箱 profile；补丁只做人工验证。`;
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
        `本项目：经验 ${counts.experiences ?? 0} 条 · 待提炼 ${counts.pendingHarvest ?? 0} 条 · ` +
        `知识 ${counts.knowledge ?? 0} 条（已验证 ${counts.verified ?? 0} 条）· 候选 ${candidates} 条 · ` +
        `复用 ${counts.usages ?? 0} 次（正反馈 ${counts.positiveUsages ?? 0}）\n` +
        `共享知识 ${counts.sharedKnowledge ?? 0} 条（已验证 ${counts.sharedVerified ?? 0} 条）`;
      const harvest = $('harvestNow');
      harvest.disabled = (counts.pendingHarvest ?? 0) === 0;
      harvest.textContent = '立即提炼';
      harvest.title = (counts.pendingHarvest ?? 0) === 0
        ? '当前项目没有待提炼经验：先完成一次终态任务'
        : `把当前项目 ${counts.pendingHarvest} 条经验提炼成待审核候选`;
    } else {
      $('knowledgeSummaryText').textContent = '知识库尚未建立；完成任务后会自动采集经验，提炼可自动或进入待提炼队列。';
      $('harvestNow').disabled = true;
    }
  };

  const collapsedHosts = new Set();

  const renderProjects = () => {
    const select = $('projectSelect');
    const projects = view?.projects ?? [];
    const selected = view?.config?.projectId ?? projects[0]?.id ?? '';
    select.replaceChildren();
    for (const project of projects) {
      const option = el('option', undefined, project.name);
      option.value = project.id;
      option.selected = project.id === selected;
      select.append(option);
    }
    select.disabled = projects.length === 0;

    // 顶部按来源主机分组：组头是主机，组内是项目（最近进展 + 时间）。
    const list = $('projectList');
    if (!list) return;
    const query = ($('projectSearch')?.value ?? '').trim().toLowerCase();
    const visible = projects.filter((project) => !query
      || `${project.name} ${project.root} ${project.progress}`.toLowerCase().includes(query));
    const groups = new Map();
    for (const project of visible) {
      const key = project.hostLabel || project.host || '其它来源';
      if (!groups.has(key)) groups.set(key, { local: project.hostLocal === true, rows: [] });
      groups.get(key).rows.push(project);
    }
    const ordered = [...groups.entries()].sort((a, b) =>
      Number(b[1].local) - Number(a[1].local) || a[0].localeCompare(b[0]));
    list.replaceChildren();
    if (!visible.length) {
      list.append(el('p', 'section-sub',
        projects.length ? '没有匹配的项目。' : '还没有项目；添加一个本地 Git 仓库后就能在这里切换。'));
    }
    for (const [host, group] of ordered) {
      group.rows.sort((a, b) => String(b.lastEventAt).localeCompare(String(a.lastEventAt)));
      const wrap = el('div', 'project-group');
      const head = el('button', 'project-group-head');
      head.type = 'button';
      head.dataset.host = host;
      head.setAttribute('aria-expanded', String(!collapsedHosts.has(host)));
      head.append(
        el('span', 'group-caret', collapsedHosts.has(host) ? '▸' : '▾'),
        el('span', 'group-name', host),
        el('span', 'group-count', String(group.rows.length))
      );
      head.onclick = () => {
        if (collapsedHosts.has(host)) collapsedHosts.delete(host);
        else collapsedHosts.add(host);
        renderProjects();
      };
      wrap.append(head);
      if (!collapsedHosts.has(host)) {
        const body = el('div', 'project-rows');
        for (const project of group.rows) {
          const wrapper = el('div', 'project-row-wrap');
          const row = el('button', 'project-row');
          row.type = 'button';
          row.dataset.project = project.id;
          row.title = project.root || project.name;
          if (project.id === selected) row.classList.add('selected');
          const dot = el('span', 'project-dot');
          dot.dataset.tone = project.pending > 0 ? 'warn' : (project.progressTone ?? 'muted');
          const main = el('span', 'row-main');
          const top = el('span', 'row-top');
          top.append(el('span', 'row-name', project.name));
          if (project.pending > 0) top.append(el('span', 'row-badge warn', `${project.pending} 待你`));
          else if (project.progressTone === 'active') top.append(el('span', 'row-badge active', '进行中'));
          const time = el('span', 'row-time', formatRelative(project.lastEventAt) || '暂无时间');
          time.title = project.lastEventAt
            ? new Date(project.lastEventAt).toLocaleString('zh-CN') : '';
          top.append(time);
          const progress = el('span', 'row-progress', project.progress || '还没有任务记录');
          progress.dataset.tone = project.progressTone ?? 'muted';
          main.append(top, progress);
          row.append(dot, main);
          row.onclick = () => { void selectProject(project.id); };
          wrapper.append(row);
          if (project.github) {
            const gh = el('button', 'project-gh', project.github.available ? 'GH' : 'GH?');
            gh.type = 'button';
            gh.dataset.state = project.github.available ? 'ok' : 'unknown';
            gh.title = project.github.available
              ? `${project.github.nameWithOwner} · ${project.github.private ? '私有' : '公开'}`
                + `${project.github.defaultBranch ? ` · 默认分支 ${project.github.defaultBranch}` : ''}`
                + `${Number.isFinite(project.github.stars) ? ` · ★ ${project.github.stars}` : ''}`
                + `${project.github.lastCommit ? `\n${project.github.lastCommit}` : ''}`
                + '\n点击打开 GitHub'
              : `${project.github.nameWithOwner}\n${project.github.error || 'gh 暂时无法读取状态'}`
                + '\n点击打开 GitHub';
            gh.onclick = (event) => {
              event.stopPropagation();
              void window.companion.openExternal(project.github.url)
                .catch((error) => toast(String(error?.message ?? error)));
            };
            wrapper.append(gh);
          }
          body.append(wrapper);
        }
        wrap.append(body);
      }
      list.append(wrap);
    }
    const badge = $('projectBadge');
    if (badge) badge.textContent = String(projects.length);
  };

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
      const pending = view?.knowledge?.counts?.pendingHarvest ?? 0;
      if (pending > 0) {
        nodes.push(el('p', 'pending-summary', `还有 ${pending} 条待提炼经验，可以先提炼成候选。`));
      }
      const close = el('button', 'ghost', '关闭');
      close.onclick = closeModal;
      const harvest = el('button', 'primary', '立即提炼');
      harvest.disabled = pending === 0;
      harvest.onclick = () => {
        closeModal();
        void harvestNow();
      };
      const open = el('button', 'primary', '去知识库处理');
      open.onclick = () => {
        closeModal();
        void window.companion.knowledge.open().catch((error) => toast(String(error?.message ?? error)));
      };
      openModal('整理项目知识', nodes, pending > 0 ? [close, harvest, open] : [close, open]);
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
      el('span', 'summary-chip', `经验 ${counts.experiences ?? 0}`),
      el('span', 'summary-chip', `知识 ${counts.knowledge ?? 0}`),
      el('span', 'summary-chip ok', `已验证 ${counts.verified ?? 0}`),
      el('span', 'summary-chip warn', `待提炼 ${counts.pendingHarvest ?? 0}`),
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
      const experiences = (data.recentExperiences ?? []).slice(0, 3);
      if (experiences.length) {
        const list = el('div', 'summary-items');
        for (const experience of experiences) {
          const item = el('div', 'summary-item static');
          const dot = el('span', 'summary-dot');
          dot.dataset.status = experience.outcome === 'repaired' || experience.outcome === 'succeeded'
            ? 'verified' : 'unverified';
          item.append(
            dot,
            el('span', 'summary-item-text', experience.title),
            el('span', 'summary-time', formatRelative(experience.createdAt) || '')
          );
          list.append(item);
        }
        box.append(list);
      } else {
        box.append(el('div', 'summary-empty',
          '还没有收集到该项目的经验；完成一次任务后会自动采集，也可以点「提炼」生成候选。'));
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
    const pending = counts.pendingHarvest ?? 0;
    const harvest = el('button', 'ghost small', pending > 0 ? `提炼 ${pending} 条` : '提炼');
    harvest.type = 'button';
    harvest.disabled = pending === 0;
    harvest.title = pending === 0 ? '当前项目没有待提炼经验' : '把待提炼经验提炼成待审核候选';
    harvest.onclick = () => { void harvestNow(); };
    foot.append(harvest);
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
      `${item.type === 'experience' ? '经验' : item.type === 'candidate' ? '候选' : '知识'} · ` +
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
      } else if (data.kind === 'experience') {
        nodes.push(el('p', 'result-summary', data.item.observedProblem));
        nodes.push(detailRows([
          ['项目', data.item.projectId],
          ['结果', data.item.observedOutcome?.status],
          ['测试', data.item.observedOutcome?.testStatus ?? 'unknown'],
          ['执行', data.item.observedOutcome?.executionStatus ?? 'unknown'],
          ['创建', data.item.createdAt]
        ]));
        for (const [title, values] of [
          ['已观察事实', data.item.facts ?? []],
          ['模型推断', data.item.inferences ?? []],
          ['未知', data.item.unknowns ?? []]
        ]) {
          if (!values.length) continue;
          nodes.push(el('div', 'section-title', title));
          nodes.push(el('pre', 'diff', values.join('\n')));
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

  // ---- 手动提炼（只生成候选，不自动验证） ----

  const showHarvestResult = (result) => {
    const nodes = [
      el('p', 'result-summary',
        `已处理 ${result.experienceCount} 条经验，生成 ${result.candidates?.length ?? 0} 条候选。`),
      el('p', 'pending-summary',
        '候选仍是「待审核」状态：需要你在完整知识库里逐条批准；批准也不等于已验证。')
    ];
    if (result.invalid?.length) {
      nodes.push(el('pre', 'diff',
        `跳过 ${result.invalid.length} 条无效候选：\n${result.invalid.map((item) => item.error).join('\n')}`));
    }
    if (result.candidates?.length) {
      const list = el('div', 'knowledge-list');
      for (const item of result.candidates) {
        const row = el('div', 'knowledge-item');
        row.append(el('strong', undefined, item.title));
        row.append(el('span', undefined,
          `候选 · ${item.layer ?? 'project'} · 置信度 ${item.confidence ?? 'unknown'}`));
        list.append(row);
      }
      nodes.push(list);
    }
    const close = el('button', 'ghost', '关闭');
    close.onclick = closeModal;
    const workbench = el('button', 'primary', '去知识库审核');
    workbench.onclick = () => { closeModal(); void window.companion.knowledge.open(); };
    openModal('提炼完成（待审核候选）', nodes, [close, workbench]);
  };

  const harvestNow = async () => {
    const projectId = view?.config?.projectId ?? '';
    const pending = view?.knowledge?.counts?.pendingHarvest ?? 0;
    if (!projectId) { toast('先选择一个项目。'); return; }
    if (pending === 0) { toast('当前项目没有待提炼经验。'); return; }
    const nodes = [
      el('p', 'result-summary', `将用当前模型把本项目的 ${pending} 条待提炼经验整理成候选。`),
      el('p', 'pending-summary', '提炼只会生成待审核候选，不会写入已验证知识；模型调用可能需要几十秒。')
    ];
    const cancel = el('button', 'ghost', '取消');
    cancel.onclick = closeModal;
    const start = el('button', 'primary', '开始提炼');
    start.onclick = async () => {
      start.disabled = true;
      start.textContent = '提炼中…';
      const button = $('harvestNow');
      button.disabled = true;
      button.textContent = '提炼中…';
      try {
        const result = await window.companion.knowledge.harvest({ projectId });
        closeModal();
        await refresh();
        showHarvestResult(result);
      } catch (error) {
        start.disabled = false;
        start.textContent = '开始提炼';
        toast(String(error?.message ?? error), 8000);
      } finally {
        button.textContent = '立即提炼';
        button.disabled = (view?.knowledge?.counts?.pendingHarvest ?? 0) === 0;
      }
    };
    openModal('提炼经验（只生成候选）', nodes, [cancel, start]);
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
    $('playbookHint').textContent = '一键只读分析当前项目；改动会先生成提案等你批准。';
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
    const projectId = view?.config?.projectId ?? $('projectSelect').value ?? '';
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
      $('playbookHint').textContent = '一键只读分析当前项目；结论可沉淀为项目知识，改动会先生成提案等你批准。';
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
  const statusMeta = (status) => {
    const value = String(status ?? '').toLowerCase();
    if (['succeeded', 'completed', 'tested_pass', 'applied'].includes(value)) return { tone: 'done', label: '完成' };
    if (['running', 'leased', 'provisioning', 'collecting', 'test_pending'].includes(value)) return { tone: 'running', label: '进行中' };
    if (['failed', 'cancelled', 'tested_fail', 'needs_reconciliation'].includes(value)) return { tone: 'failed', label: '失败' };
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
    const activeStatuses = new Set(['running', 'leased', 'provisioning', 'collecting', 'test_pending', 'queued']);
    const hasActive = steps.some((step) => activeStatuses.has(String(step.status ?? '').toLowerCase()));
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
    // 分组展示时项目名已经在组标题上，卡片里不再重复，也不再提「当前项目」。
    if (item.projectName && !grouped) {
      const current = item.projectId === view?.config?.projectId;
      card.append(el('div', 'pending-project',
        current ? `当前项目 · ${item.projectName}` : `其他项目 · ${item.projectName}`));
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

  const renderPending = () => {
    const list = $('pendingList');
    list.replaceChildren();
    const pending = view?.pending ?? [];
    if (pending.length === 0) return;

    // 按项目分组；只有一个项目时退化成普通列表，不显示多余的分组标题。
    const groups = new Map();
    for (const item of pending) {
      const key = String(item.projectId || '');
      if (!groups.has(key)) {
        groups.set(key, { name: item.projectName || key || '未命名项目', items: [] });
      }
      groups.get(key).items.push(item);
    }

    if (groups.size === 1) {
      for (const group of groups.values()) {
        for (const item of group.items) list.append(pendingCard(item));
      }
      return;
    }

    let first = true;
    for (const group of groups.values()) {
      const details = el('details', 'pending-group');
      details.open = first;
      first = false;
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
      return;
    }
    section.hidden = false;
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
    if (refreshing) return;
    refreshing = true;
    try {
      view = await window.companion.snapshot();
      if (view?.knowledge?.projectId) knowledgeCache.set(view.knowledge.projectId, view.knowledge);
      // 知识数量变了就重读一次浏览列表，避免用户在别处提炼/确认后看到旧列表。
      const knowledgeSignature = JSON.stringify(view?.knowledge?.counts ?? {});
      if (panelMode === 'B' && knowledgeBrowseData && knowledgeSignature !== knowledgeBrowseSignature) {
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
      renderPending();
      renderRunning();
      renderResult();
      if (panelMode === 'A') renderModeA();
      if (panelMode === 'C') renderChatCards();
    } catch (error) {
      $('stateDot').className = 'state-dot error';
      $('stateText').textContent = '连接异常';
      $('stage').textContent = String(error?.message ?? error);
    } finally {
      refreshing = false;
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
      return;
    }
    section.hidden = false;
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

  const sendMessage = async (rawText, { capture = true } = {}) => {
    const text = String(rawText ?? '').trim();
    if (!text) { toast('先写点什么。'); return null; }
    const projectId = $('projectSelect').value;
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

  const selectProject = async (projectId) => {
    if (!projectId || projectId === (view?.config?.projectId ?? '')) return;
    try {
      await window.companion.settings.set({ projectId });
    } catch { /* non-blocking */ }
    // 切项目后旧结论不再适用，先清空再按新项目重新加载。
    playbookCurrent = null;
    playbookProjectId = projectId;
    renderPlaybookResult();
    lastAnswer = null;
    renderAnswer(null);
    await refresh();
    void loadPlaybooks();
  };

  $('projectSelect').onchange = () => { void selectProject($('projectSelect').value); };
  $('projectSearch').oninput = () => { renderProjects(); };

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
      $('knowledgeAutoHarvest').checked = data.knowledgeAutoHarvest === true;
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
        sandboxMode: $('sandboxMode').value,
        knowledgeAutoHarvest: $('knowledgeAutoHarvest').checked
      });
      $('settings').hidden = true;
      if (saved?.knowledgeAutoHarvest) toast('设置已保存；自动提炼会在模型可用时低频运行', 6000);
      else if (saved?.modelPending) toast('设置已保存；模型将在当前任务结束后生效', 6000);
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
  $('addProjectSettings').onclick = () => { void pickProject(); };
  $('retryServices').onclick = () => { void openSettings(); };
  $('fixTestConfig').onclick = () => { void openSettings(); };
  $('sandboxModeSelect').onchange = async () => {
    const projectId = view?.config?.projectId ?? $('projectSelect').value ?? '';
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

  $('harvestNow').onclick = () => { void harvestNow(); };
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

  // ---- 专注：项目详情卡（只读） ----
  //
  // 专注页第一张卡是待办（列表由 renderPending 画），这张是第二张。
  // 卡片只影响自己：选中哪个项目不写回配置、不记忆，刷新后回到第一个。
  // 九块内容里只有画像 / 图谱 / 想法 / Playbook 渲染正文；知识 / 测试 / 补丁 /
  // 运行只给入口与计数，点击跳到对应模式或小节，避免同屏两份内容。

  // 详情卡的取数节奏：卡片内容变化慢，没必要跟着 2 秒轮询。
  const FOCUS_DETAIL_TTL = 15000;
  // 入口跳转：知识去知识模式（B）的浏览页；补丁回专注的待办卡；
  // 测试与运行在知识模式里折叠的工作区。目标找不到就退回该模式顶部。
  const FOCUS_JUMP = {
    knowledge: ['B', 'knowledgeBrowse'],
    tests: ['B', 'runningSection'],
    patches: ['A', 'needsSection'],
    runs: ['B', 'runningSection']
  };

  let focusProjectId = '';
  // 这张卡自己的快照：只用来画详情，不参与全局 view、也不改配置。
  let focusDetail = null;
  let focusDetailAt = 0;
  let focusDetailLoading = false;
  let focusDetailToken = 0;
  let focusPlaybook = null;
  let focusPlaybookLoading = '';
  let focusRenderedKey = '';
  let focusTabsKey = '';
  let focusMoreOpen = false;
  const focusDiagramCache = new Map();
  let focusDiagramToken = 0;

  const focusProjects = () => (Array.isArray(view?.projects) ? view.projects : []);

  /** 当前展示的项目：没选过、或选中的项目没了，都回到第一个。 */
  const focusProject = () => {
    const projects = focusProjects();
    if (!projects.length) return null;
    return projects.find((item) => item.id === focusProjectId) ?? projects[0];
  };

  /** 点列表切换：只换这张卡看的项目，不写回配置。 */
  const selectFocusProject = (projectId) => {
    if (!projectId) return;
    if (projectId !== focusProject()?.id) {
      focusProjectId = projectId;
      // 换项目后旧数据一律作废，避免把 A 的内容画在 B 名下。
      focusDetail = null;
      focusDetailAt = 0;
      focusRenderedKey = '';
      focusMoreOpen = false;
    }
    renderFocusDetail();
    void loadFocusDetail();
  };

  const loadFocusDetail = async () => {
    const project = focusProject();
    if (!project) return;
    const token = ++focusDetailToken;
    focusDetailLoading = true;
    try {
      const snapshot = await window.companion.snapshot({ projectId: project.id });
      // 迟到的响应可能已经换了项目，直接丢掉。
      if (token !== focusDetailToken) return;
      focusDetail = snapshot;
      focusDetailAt = Date.now();
    } catch {
      // 单张卡取数失败不打断整个面板；记个时间，过几秒再试。
      if (token === focusDetailToken) focusDetailAt = Date.now();
    } finally {
      if (token === focusDetailToken) {
        focusDetailLoading = false;
        renderFocusDetail();
      }
    }
  };

  const loadFocusPlaybook = async (projectId) => {
    if (!projectId || focusPlaybookLoading === projectId) return;
    focusPlaybookLoading = projectId;
    try {
      const catalog = await window.companion.playbooks.list({ projectId });
      focusPlaybook = { projectId, catalog };
    } catch {
      focusPlaybook = { projectId, catalog: null };
    } finally {
      focusPlaybookLoading = '';
      renderFocusDetail();
    }
  };

  /** 入口点击：跳到「待办」里对应的位置，不在卡片里重画第二份。 */
  const focusJump = (key) => {
    const target = FOCUS_JUMP[key];
    if (!target) return;
    const [mode, sectionId] = target;
    setMode(mode);
    // 目标小节以后可能被并到别的模式里；找不到就退回该模式顶部，不留死跳转。
    const node = $(sectionId) ?? $(`mode${mode}`);
    if (!node) return;
    // 只有目标在折叠的工作区里时才需要先展开，否则会把用户带到无关的区域。
    const workspace = $('workspaceToggle');
    if (workspace && workspace.contains(node)) workspace.open = true;
    window.setTimeout(() => node.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60);
  };

  const fdBlock = (title, badge, body, { open = true, onToggle = null } = {}) => {
    const box = document.createElement('details');
    box.className = 'fd-block';
    box.open = open;
    const summary = el('summary', 'fd-block-head');
    summary.append(el('span', 'fd-block-title', title));
    if (badge) summary.append(el('span', 'fd-block-badge', badge));
    box.append(summary);
    const content = el('div', 'fd-block-body');
    if (body) content.append(body);
    box.append(content);
    if (onToggle) box.addEventListener('toggle', () => onToggle(box.open));
    return box;
  };

  const fdEmpty = (text) => el('p', 'fd-empty', text);

  const fdChips = (values, className = 'fd-chip') => {
    const wrap = el('span', 'fd-chips');
    for (const value of values) wrap.append(el('code', className, value));
    return wrap;
  };

  const fdBriefBody = (brief) => {
    if (brief.state !== 'ready') return fdEmpty(brief.hint);
    const wrap = el('div', 'fd-brief');
    if (brief.oneLiner) wrap.append(el('p', 'fd-brief-one', brief.oneLiner));
    else if (brief.whatItIs) wrap.append(el('p', 'fd-brief-one', brief.whatItIs));
    const row = (label, content) => {
      const line = el('div', 'fd-row');
      line.append(el('span', 'fd-label', label));
      line.append(content);
      wrap.append(line);
    };
    if (brief.howToRun.length) row('怎么跑', fdChips(brief.howToRun));
    if (brief.modules.length) {
      row('关键模块', fdChips(brief.modules.map((module) =>
        module.role ? `${module.name} · ${module.role}` : module.name), 'fd-chip'));
    }
    if (brief.verify.length) row('怎么验收', fdChips(brief.verify));
    if (brief.risks.length) row('风险', el('span', 'fd-text', brief.risks.join('；')));
    if (brief.unknowns.length) row('还不确定', el('span', 'fd-text', brief.unknowns.join('；')));
    return wrap;
  };

  /** 图谱：复用 mermaid 渲染，按「项目 + 类型 + 源码」缓存，轮询不重画。 */
  const fdRenderDiagram = (container, diagram, projectId) => {
    if (diagram.state !== 'ready' || !diagram.mermaid) {
      container.append(fdEmpty(diagram.hint || '还没有图谱。'));
      return;
    }
    const key = `${projectId}|${diagram.kind}|${diagram.mermaid}`;
    const cached = focusDiagramCache.get(key);
    if (cached) {
      container.innerHTML = cached;
      return;
    }
    const token = ++focusDiagramToken;
    container.append(el('div', 'fd-empty', '正在渲染图谱…'));
    void window.mermaid.render(`fd-diagram-${Date.now()}`, diagram.mermaid)
      .then(({ svg }) => {
        focusDiagramCache.set(key, svg);
        // 缓存只留最近几张，避免一直涨。
        if (focusDiagramCache.size > 12) {
          focusDiagramCache.delete(focusDiagramCache.keys().next().value);
        }
        if (token === focusDiagramToken && container.isConnected) container.innerHTML = svg;
      })
      .catch(() => {
        if (token === focusDiagramToken && container.isConnected) {
          container.replaceChildren(fdEmpty('图谱渲染失败，可以到待办里重新生成。'));
        }
      });
  };

  const fdEntriesBody = (entries) => {
    const list = el('div', 'fd-entries');
    for (const entry of entries) {
      const row = el('button', 'fd-entry');
      row.type = 'button';
      row.title = `跳到${entry.label}${entry.note ? ` · ${entry.note}` : ''}`;
      row.append(el('span', 'fd-entry-label', entry.label));
      row.append(el('span', 'fd-entry-count', String(entry.count)));
      row.append(el('span', 'fd-entry-note', entry.note));
      row.append(el('span', 'fd-entry-go', '›'));
      row.onclick = () => focusJump(entry.key);
      list.append(row);
    }
    return list;
  };

  const fdIdeasBody = (ideas) => {
    if (!ideas.items.length) return fdEmpty(ideas.hint || '还没有想法。');
    const list = el('div', 'fd-ideas');
    for (const idea of ideas.items) {
      const row = el('div', 'fd-idea');
      row.append(el('span', `fd-idea-status s-${idea.status}`, idea.statusLabel));
      row.append(el('span', 'fd-idea-title', idea.title));
      list.append(row);
    }
    return list;
  };

  const fdPlaybookBody = (playbook) => {
    const wrap = el('div', 'fd-playbook');
    if (playbook.running) {
      wrap.append(el('div', 'fd-running', `正在跑：${playbook.runningTitle || 'Playbook'}`));
    }
    if (!playbook.available) {
      wrap.append(fdEmpty(playbook.hint || 'Playbook 不可用。'));
      return wrap;
    }
    if (!playbook.lastRuns.length) {
      wrap.append(fdEmpty('这个项目还没跑过 Playbook；可以到待办里跑一次。'));
    }
    for (const run of playbook.lastRuns) {
      const row = el('div', 'fd-run');
      row.append(el('span', `fd-run-status s-${run.status || 'unknown'}`, run.status || '—'));
      row.append(el('span', 'fd-run-label', run.label));
      row.append(el('span', 'fd-run-time',
        formatRelative(run.startedAt) || ''));
      wrap.append(row);
    }
    return wrap;
  };

  const fdGithubBody = (github) => {
    if (!github.linked) return fdEmpty(github.hint);
    const wrap = el('div', 'fd-github');
    const head = el('div', 'fd-github-head');
    const repo = el('button', 'fd-github-repo', github.nameWithOwner);
    repo.type = 'button';
    repo.title = '在浏览器打开仓库';
    repo.onclick = () => openGithub(github.url);
    head.append(repo);
    if (!github.loading) {
      head.append(el('span', 'fd-github-count', `Issues ${github.issueCount}`));
      head.append(el('span', 'fd-github-count', `PR ${github.prCount}`));
    }
    wrap.append(head);
    if (github.loading) wrap.append(fdEmpty(github.hint));
    else if (github.error) wrap.append(fdEmpty(github.error));
    else if (!github.items.length) wrap.append(fdEmpty('没有打开的 Issues 或 PR。'));
    for (const item of github.items) {
      const row = el('button', 'fd-github-item');
      row.type = 'button';
      row.append(el('span', `fd-github-kind k-${item.kind}`,
        item.kind === 'issue' ? `#${item.number}` : `PR #${item.number}`));
      row.append(el('span', 'fd-github-title', item.title || '（无标题）'));
      row.onclick = () => openGithub(item.url);
      wrap.append(row);
    }
    return wrap;
  };

  const fdTestsBody = (tests) => {
    const wrap = el('div', 'fd-tests');
    wrap.append(el('p', 'fd-text',
      `沙箱测试：${tests.enabled ? (tests.ok ? '可用' : '配置不完整') : '已关闭'}${tests.profile ? ` · ${tests.profile}` : ''}`));
    if (tests.missing.length) {
      wrap.append(el('p', 'fd-text warn', `缺：${tests.missing.join('、')}`));
    }
    wrap.append(el('p', 'fd-empty', tests.hint));
    const button = el('button', 'ghost small', '跳到测试配置');
    button.type = 'button';
    button.onclick = () => openSettings();
    wrap.append(button);
    return wrap;
  };

  /** 画整张卡：数据没变就不重建，避免每 2 秒把图重新渲染一遍。 */
  const renderFocusDetail = () => {
    const card = $('focusDetail');
    if (!card) return;
    const project = focusProject();
    const model = window.OwnerFocusDetail?.buildFocusDetail({
      projects: focusProjects(),
      selectedId: focusProjectId,
      detail: focusDetail,
      playbook: focusPlaybook,
      github: project ? githubActivityCache.get(project.id) ?? null : null
    });
    if (!model) return;

    // 没有项目：只给添加项目的引导，别画一个空壳卡片。
    if (!model.hasProjects) {
      card.hidden = false;
      if (focusRenderedKey === 'guide') return;
      focusRenderedKey = 'guide';
      $('fdTabs').replaceChildren();
      $('fdHint').textContent = '';
      const body = $('fdBody');
      body.replaceChildren();
      const guide = el('div', 'fd-guide');
      guide.append(el('div', 'fd-guide-title', model.guide.title));
      guide.append(el('p', 'fd-guide-text', model.guide.text));
      const add = el('button', 'primary small', model.guide.actionLabel);
      add.type = 'button';
      add.onclick = () => { void pickProject(); };
      guide.append(add);
      body.append(guide);
      return;
    }

    // 详情过期，或换过项目但还没取到：发起一次按项目的快照请求。
    const stale = !focusDetail || focusDetail.config?.projectId !== model.projectId
      || Date.now() - focusDetailAt > FOCUS_DETAIL_TTL;
    if (project && stale && !focusDetailLoading) void loadFocusDetail();

    card.hidden = false;
    // 项目列表很短，直接平铺；多了也只在卡片内横向换行，不影响别的模式。
    // 只在项目/选中项/待办数变化时重建，避免轮询把按钮闪烁一遍。
    const tabsKey = JSON.stringify(model.tabs);
    if (tabsKey !== focusTabsKey) {
      focusTabsKey = tabsKey;
      $('fdTabs').replaceChildren(...model.tabs.map((tab) => {
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
    }
    $('fdHint').textContent = model.detailReady ? '' : '正在读取…';

    const key = JSON.stringify(model);
    if (key === focusRenderedKey) return;
    focusRenderedKey = key;

    const body = $('fdBody');
    body.replaceChildren();

    // 画像 / 图谱 / 想法 / Playbook 默认展开。
    body.append(fdBlock('画像', model.brief.stale ? '已过期' : '', fdBriefBody(model.brief)));

    const diagramBox = el('div', 'fd-diagram');
    fdRenderDiagram(diagramBox, model.diagram, model.projectId);
    body.append(fdBlock('图谱', model.diagram.state === 'ready' ? model.diagram.label : '',
      diagramBox));

    body.append(fdBlock('想法', model.ideas.total ? String(model.ideas.active || model.ideas.total) : '',
      fdIdeasBody(model.ideas)));

    body.append(fdBlock('Playbook', model.playbook.running ? '运行中' : '',
      fdPlaybookBody(model.playbook)));

    // 知识 / 测试 / 补丁 / 运行：只给入口与计数，不重复渲染内容。
    body.append(el('div', 'fd-section-title', '入口'));
    body.append(fdEntriesBody(model.entries));

    // GitHub 与测试配置折叠在「更多」里。
    const more = el('div', 'fd-more');
    more.append(el('div', 'fd-more-label', 'GitHub'));
    more.append(fdGithubBody(model.more.github));
    more.append(el('div', 'fd-more-label', '测试'));
    more.append(fdTestsBody(model.more.tests));
    body.append(fdBlock('更多', '', more, {
      open: focusMoreOpen,
      onToggle: (open) => {
        focusMoreOpen = open;
        if (open) void loadGithubActivity(model.projectId);
      }
    }));
    if (focusMoreOpen) void loadGithubActivity(model.projectId);

    // Playbook 目录按所选项目取；取过就不再重复。
    if (!focusPlaybook || focusPlaybook.projectId !== model.projectId) {
      void loadFocusPlaybook(model.projectId);
    }
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

  // 候选条目带审核动作；其余条目仍是整行按钮，点开看详情。
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
          toast(decision === 'approved' ? '已接受候选，移到待验证知识' : '已拒绝候选', 4000);
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
      // 所选项目在新数据里已经不存在（例如知识被清空）时退回「全部」。
      if (knowledgeBrowseProject && !(data.projects ?? []).some((item) => item.id === knowledgeBrowseProject)) {
        knowledgeBrowseProject = '';
        void loadKnowledgeBrowse();
        return;
      }
      renderKnowledgeBrowse();
      $('knowledgeBrowse').dataset.renderMs = String(Math.round(performance.now() - started));
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
        if (item.missing) summary.append(el('span', 'skill-badge-missing', '缺失'));
        row.append(summary);
        const detail = el('div', 'skill-detail');
        const rows = el('dl', 'detail-rows');
        const addRow = (label, value, className) => {
          rows.append(el('dt', undefined, label));
          rows.append(el('dd', className, value));
        };
        addRow('来源',
          item.origin && item.origin !== item.sourceLabel ? `${item.sourceLabel} · ${item.origin}` : item.sourceLabel);
        addRow('路径', item.path || '（没有可指向的路径）', 'skill-path');
        addRow('描述', item.description || (item.missing ? '（技能缺失，没有描述）' : '（SKILL.md 没有写描述）'), 'skill-desc');
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

  // ---- 三种视图模式：专注（A） / 知识（B） / 对话（C） ----

  const MODE_IDS = { A: 'modeA', B: 'modeB', C: 'modeC' };

  const setMode = (next, { persist = true } = {}) => {
    const mode = MODE_IDS[next] ? next : 'B';
    panelMode = mode;
    if (persist) {
      try { localStorage.setItem('panelMode', mode); } catch { /* ignore */ }
    }
    for (const [key, id] of Object.entries(MODE_IDS)) {
      const node = $(id);
      if (node) node.hidden = key !== mode;
    }
    for (const button of document.querySelectorAll('#modeBar button')) {
      button.classList.toggle('on', button.dataset.mode === mode);
    }
    const hasProjects = (view?.projects?.length ?? 0) > 0;
    // 交办输入框只属于专注；对话模式用自己的输入，知识模式只读。
    $('composeSection').hidden = !hasProjects || mode !== 'A';
    if (mode === 'A') renderModeA();
    if (mode === 'B') {
      void loadKnowledgeBrowse();
      // 主进程缓存一分钟；这里每次进入知识模式都读一次，顺便把上一次扫描结果带回来。
      void loadSkillCatalog();
    }
    if (mode === 'C') {
      // 会话列表来自本地库：切换到对话模式时恢复上次会话。
      void ensureChatSession();
      renderChatCards();
    }
  };

  // 专注页两张卡：第一张待办（列表由 renderPending 画），第二张所选项目的只读详情。
  // 旧的「单一下一步」首卡已被待办卡取代，这里不再重建。
  const renderModeA = () => {
    renderFocusDetail();
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
  // 只有真正把消息画进 transcript 后，才认为会话已打开；否则重启后只会恢复标题却空着。
  let chatSessionOpened = '';

  const chatProjectName = (projectId) =>
    view?.projects?.find((item) => item.id === projectId)?.name || projectId || '未绑定项目';
  const activeChatSession = () =>
    chatSessions.find((item) => item.id === activeChatSessionId) ?? null;
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
    const select = el('select');
    for (const project of projects) {
      const option = el('option', undefined, project.name || project.id);
      option.value = project.id;
      select.append(option);
    }
    select.value = view?.config?.projectId || projects[0].id;
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
    create.onclick = async () => {
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
    title.focus();
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
    lines.push('这里只能读文件：可以查代码和配置来回答，但不会改任何东西；要改请去「交办」走审批。');
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

  const sendChat = async () => {
    const text = $('cInput').value.trim();
    if (!text || chatBusy) return;
    const session = activeChatSession();
    if (!session) {
      // 没有会话时不偷偷落到某个项目：先让 Owner 明确选项目。
      openNewChatSession({ draft: text });
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
  $('cInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendChat();
    }
  });

  window.companion.onOpenSettings(() => { void openSettings(true); });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!$('modal').hidden) closeModal();
      else if (!$('settings').hidden) $('settings').hidden = true;
      else window.companion.hidePanel();
    }
  });

  void refresh().then(() => {
    try { setMode(localStorage.getItem('panelMode') || 'B', { persist: false }); } catch { setMode('B', { persist: false }); }
    void loadPlaybooks();
  });
  window.setInterval(refresh, 2000);
})();
