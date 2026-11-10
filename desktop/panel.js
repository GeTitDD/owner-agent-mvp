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
  let refreshing = false;
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
    // 没有待决定事项时不再占一整块空位，把顶部留给项目列表。
    $('needsSection').hidden = pending === 0;
    $('needsCount').textContent = String(pending);
    $('needsChip').classList.toggle('warn', pending > 0);
    $('needsHint').textContent = pending > 0
      ? `有 ${pending} 项需要你确认；写入、补丁与测试在批准前不会改变真实项目。`
      : '现在没有需要你决定的事项。写入、补丁、测试和修复都会先停在这里。';
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
    $('setup').hidden = hasProjects;
    $('composeSection').hidden = !hasProjects;
    $('submitTask').disabled = !hasProjects;
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

  const QUEUE_STATUS = {
    todo: '待办', doing: '进行中', blocked: '等你批准', done: '完成', failed: '失败'
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

  const renderQueue = () => {
    const list = $('queueList');
    if (!list) return;
    const items = view?.queue ?? [];
    const active = items.filter((item) => ['todo', 'doing', 'blocked'].includes(item.status)).length;
    $('queueBadge').textContent = String(active);
    $('queueBadge').title = `共 ${items.length} 条`;
    list.replaceChildren();
    if (!items.length) {
      list.append(el('div', 'queue-empty', '还没有待办。加一条消息或任务，之后可以逐条交办。'));
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
      meta.append(el('span', `queue-status ${item.status}`, QUEUE_STATUS[item.status] ?? item.status));
      if (item.linkedJobId) meta.append(el('span', 'queue-job', `Job ${String(item.linkedJobId).slice(0, 8)}`));
      if (item.createdAt) meta.append(el('span', 'queue-time', formatRelative(item.createdAt) || ''));
      main.append(title, meta);
      const actions = el('div', 'queue-actions');
      const move = (direction) => queueAction(
        () => window.companion.queue.move({ id: item.id, direction }),
        null
      );
      const up = el('button', 'queue-action', '↑');
      up.type = 'button'; up.title = '上移'; up.disabled = item.position === 1;
      up.onclick = () => { void move('up'); };
      const down = el('button', 'queue-action', '↓');
      down.type = 'button'; down.title = '下移';
      down.onclick = () => { void move('down'); };
      actions.append(up, down);
      if (['todo', 'failed'].includes(item.status)) {
        const dispatch = el('button', 'queue-action primary', '交办');
        dispatch.type = 'button';
        dispatch.onclick = async () => {
          dispatch.disabled = true;
          dispatch.textContent = '…';
          const result = await queueAction(
            () => window.companion.queue.dispatch({ id: item.id }),
            (value) => value?.mode === 'write-request'
              ? '已创建写请求，等你批准'
              : value?.mode === 'answer'
                ? '已给出只读结论'
                : value?.mode === 'triage-error'
                  ? `交办失败：${value.summary ?? '请查看详情'}`
                  : '已交办'
          );
          if (!result) { dispatch.disabled = false; dispatch.textContent = '交办'; }
        };
        actions.append(dispatch);
      }
      if (item.status !== 'done') {
        const done = el('button', 'queue-action', '完成');
        done.type = 'button';
        done.onclick = () => {
          void queueAction(() => window.companion.queue.update({ id: item.id, status: 'done' }), () => '已标记完成');
        };
        actions.append(done);
      } else {
        const reopen = el('button', 'queue-action', '重开');
        reopen.type = 'button';
        reopen.onclick = () => {
          void queueAction(() => window.companion.queue.update({ id: item.id, status: 'todo' }), () => '已重新加入待办');
        };
        actions.append(reopen);
      }
      const remove = el('button', 'queue-action danger', '×');
      remove.type = 'button'; remove.title = '删除';
      remove.onclick = () => {
        void queueAction(() => window.companion.queue.remove({ id: item.id }), () => '已删除待办');
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
      () => window.companion.queue.add({ projectId, title }),
      () => '已加入待办'
    );
  };

  const DIAGRAM_LABELS = {
    dependency: '依赖图', control: '控制流图', dataflow: '数据流图',
    state: '状态图', sequence: '时序图'
  };
  const DIAGRAM_KINDS = ['dependency', 'control', 'dataflow', 'state', 'sequence'];
  let activeDiagramKind = 'dependency';
  let diagramRenderToken = 0;
  let lastDiagramKey = '';
  const autoDependencyProjects = new Set();
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

  const renderDiagramSvg = async (diagram) => {
    const box = $('diagramView');
    const token = ++diagramRenderToken;
    const key = diagram
      ? `${activeDiagramKind}:${diagram.version}:${diagram.mermaid.length}`
      : `none:${activeDiagramKind}`;
    if (key === lastDiagramKey && (box.querySelector('svg') || box.querySelector('.diagram-empty'))) return;
    lastDiagramKey = key;
    box.replaceChildren();
    if (!diagram) {
      const empty = el('div', 'diagram-empty');
      empty.append(el('div', undefined, `还没有${DIAGRAM_LABELS[activeDiagramKind]}`));
      const generate = el('button', 'primary small', activeDiagramKind === 'dependency' ? '扫描依赖' : `生成${DIAGRAM_LABELS[activeDiagramKind]}`);
      generate.type = 'button';
      generate.onclick = () => { void generateDiagram(activeDiagramKind); };
      empty.append(generate);
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
    const generated = (view?.diagrams ?? []).length;
    $('diagramBadge').textContent = `${generated}/5`;
    $('diagramBadge').title = `已生成 ${generated} / 5 类图谱`;
    renderDiagramTabs();
    const diagram = currentDiagram();
    const scope = $('diagramScope');
    if (document.activeElement !== scope && !scope.value) scope.value = diagram?.scope ?? 'project';
    $('diagramGenerate').disabled = false;
    $('diagramCopy').disabled = !diagram;
    $('diagramExport').disabled = !diagram;
    renderDiagramMeta(diagram);
    void renderDiagramSvg(diagram);
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
    const projectId = view?.config?.projectId ?? '';
    if (!projectId) { toast('先选择一个项目。'); return; }
    const scope = String($('diagramScope').value ?? '').trim() || 'project';
    const box = $('diagramView');
    box.replaceChildren(el('div', 'diagram-loading',
      `正在生成${DIAGRAM_LABELS[kind]}…${kind === 'dependency' ? '' : '（只读分析，可在 Playbook 区取消）'}`));
    $('diagramGenerate').disabled = true;
    try {
      const result = kind === 'dependency'
        ? await window.companion.diagrams.dependency({ projectId })
        : await window.companion.diagrams.generate({ projectId, kind, scope });
      await refresh();
      if (!silent) toast(`${DIAGRAM_LABELS[kind]}已生成`, 4200);
      return result;
    } catch (error) {
      const message = String(error?.message ?? error);
      box.replaceChildren();
      const empty = el('div', 'diagram-empty');
      empty.append(el('div', undefined, `生成失败：${message}`));
      const retry = el('button', 'primary small', '重试');
      retry.type = 'button';
      retry.onclick = () => { void generateDiagram(kind); };
      empty.append(retry);
      box.append(empty);
      toast(message, 7000);
      return null;
    } finally {
      $('diagramGenerate').disabled = false;
    }
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
        nodes.push(el('p', 'pending-summary', '候选需要人工审阅；请打开完整知识库。'));
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
    if (item.next) nodes.push(el('p', 'pending-next', `批准后：${item.next}`));
    const close = el('button', 'ghost', '关闭');
    close.onclick = closeModal;
    const approve = el('button', 'primary', '去批准');
    approve.onclick = () => { closeModal(); openApproval(item); };
    openModal('审阅请求', nodes, [close, approve]);
  };


  const pendingCard = (item) => {
    const tier = tierClass(item.tier);
    const card = el('div', `pending-card tier-${tier}`);
    const head = el('div', 'pending-head');
    head.append(el('div', 'pending-title', item.title));
    head.append(el('span', `tier-badge ${tier}`, tierLabel(item.tier)));
    card.append(head);
    if (item.projectName) {
      const current = item.projectId === view?.config?.projectId;
      card.append(el('div', 'pending-project',
        current ? `当前项目 · ${item.projectName}` : `其他项目 · ${item.projectName}`));
    }
    card.append(el('div', 'pending-summary',
      item.hash ? `${item.summary} · ${fmtHash(item.hash)}` : item.summary));
    if (item.next) card.append(el('div', 'pending-next', `批准后：${item.next}`));
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
    for (const item of pending) list.append(pendingCard(item));
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
    $('composerModel').textContent = model;
    $('composerModel').title = `当前模型：${model}`;
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

  $('submitTask').onclick = async () => {
    const text = taskInput.value.trim();
    if (!text) { toast('先写下要交办的事情。'); return; }
    const projectId = $('projectSelect').value;
    const button = $('submitTask');
    const hint = $('composerHint');
    button.disabled = true;
    button.classList.add('sending');
    const startedAt = Date.now();
    const tick = () => {
      hint.textContent = `只读分析中… ${Math.round((Date.now() - startedAt) / 1000)}s（不写文件）`;
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    try {
      // 先只读分析：需要写入时后台会生成 pending_approval 的写请求（HITL）。
      const result = await window.companion.submit({ text, projectId });
      taskInput.value = '';
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
      autoGrow();
      lastAnswer = result ?? null;
      renderAnswer(lastAnswer);
      if (result?.mode === 'write-request') {
        const missing = result?.testConfig?.missing ?? [];
        toast(missing.length
          ? `只读分析完成；已发起写请求，批准后子 Agent 才会动手。测试配置还缺 ${missing.join(', ')}。`
          : '只读分析完成；已发起写请求，批准后子 Agent 才会动手。', 7000);
      } else if (result?.mode === 'answer') {
        toast('只读分析完成，没有改动任何文件。', 4000);
      } else {
        toast(result?.advice || result?.summary || '只读分析失败，请重试。', 7000);
      }
      await refresh();
    } catch (error) {
      toast(String(error?.message ?? error), 5000);
    } finally {
      window.clearInterval(timer);
      hint.textContent = '先只读分析；需要写入时再请你批准';
      button.disabled = false;
      button.classList.remove('sending');
      taskInput.focus();
    }
  };

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

  const openSettings = async (focusSkin = false) => {
    try {
      const data = await window.companion.settings.get();
      $('gatewayUrl').value = data.gatewayUrl ?? '';
      $('model').value = data.model ?? '';
      $('allowedPaths').value = data.allowedPaths ?? 'src/';
      $('sandboxMode').value = data.sandboxMode ?? 'auto';
      $('includePaths').value = (data.includePaths ?? []).join(',');
      $('knowledgeAutoHarvest').checked = data.knowledgeAutoHarvest === true;
      renderServiceGrid($('serviceGrid'), data.services);
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
  $('scopeProfile').onclick = () => { void openSettings(); };
  $('scopePaths').onclick = () => { void openSettings(); };
  $('closeSettings').onclick = () => { $('settings').hidden = true; };
  $('hidePanel').onclick = () => window.companion.hidePanel();
  $('openFull').onclick = () => { void window.companion.openFull().catch((error) => toast(String(error.message ?? error))); };
  $('openFullInline').onclick = $('openFull').onclick;
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

  window.companion.onOpenSettings(() => { void openSettings(true); });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!$('modal').hidden) closeModal();
      else if (!$('settings').hidden) $('settings').hidden = true;
      else window.companion.hidePanel();
    }
  });

  void refresh().then(() => { void loadPlaybooks(); });
  window.setInterval(refresh, 2000);
})();
