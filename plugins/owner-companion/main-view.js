/* global OwnerBridge */
(() => {
  const $ = (id) => document.getElementById(id);
  const call = (method, params, timeoutMs) => OwnerBridge.call(method, params, timeoutMs);

  const state = {
    overview: null,
    projectId: '',
    mermaid: ''
  };

  const STATUS_LABEL = {
    todo: '新想法', doing: '讨论中', blocked: '搁置', done: '已采纳', failed: '失败'
  };
  const DIAGRAM_LABEL = { dependency: '依赖图' };

  const esc = (value) => String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');

  const toast = (text) => {
    const node = $('toast');
    node.textContent = String(text ?? '');
    node.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { node.hidden = true; }, 4200);
  };

  const setStatus = (text, tone = '') => {
    $('statusText').textContent = text;
    $('statusDot').className = `dot ${tone}`.trim();
  };

  const renderProjectSelect = () => {
    const select = $('projectSelect');
    const projects = state.overview?.projects ?? [];
    select.replaceChildren();
    for (const project of projects) {
      const option = document.createElement('option');
      option.value = project.id;
      option.textContent = project.name || project.id;
      if (project.id === state.overview?.activeProjectId) option.selected = true;
      select.append(option);
    }
    select.hidden = projects.length === 0;
    $('emptyHint').hidden = projects.length > 0;
    $('nextActionCard').hidden = projects.length === 0;
  };

  const renderNextAction = () => {
    const card = $('nextActionCard');
    const action = state.overview?.nextAction;
    if (!action || !state.overview?.project) { card.hidden = true; return; }
    card.hidden = false;
    card.innerHTML = `
      <div class="action-label">下一步</div>
      <div class="action-title">${esc(action.title || '')}</div>
      ${action.detail ? `<div class="action-detail">${esc(action.detail)}</div>` : ''}
    `;
  };

  const renderBrief = () => {
    const brief = state.overview?.brief;
    const box = $('briefBody');
    if (!brief) {
      box.textContent = '还没有画像。点「重新扫描」会本地读取 README、脚本与目录，不调用模型。';
      return;
    }
    const runs = (brief.howToRun ?? []).slice(0, 5)
      .map((line) => `<div class="line">· ${esc(String(line).slice(0, 180))}</div>`).join('');
    const risks = (brief.risks ?? []).slice(0, 3)
      .map((line) => `<div class="line">· ${esc(line)}</div>`).join('');
    box.innerHTML = `
      ${brief.stale ? '<div class="line small warn">代码已更新，画像可能过期</div>' : ''}
      <div class="line">${esc(brief.oneLiner || brief.whatItIs || '暂无摘要')}</div>
      ${runs ? `<div class="line small muted mt">怎么跑</div>${runs}` : ''}
      ${risks ? `<div class="line small muted mt">风险</div>${risks}` : ''}
    `;
  };

  const renderIdeas = () => {
    const list = $('ideaList');
    const ideas = state.overview?.ideas ?? [];
    if (!ideas.length) {
      list.innerHTML = '<div class="muted small">还没有想法。记下一条，或在 Cindy 聊天里让 Agent 用 owner_idea_add 记录。</div>';
      return;
    }
    list.innerHTML = ideas.map((idea) => `
      <div class="idea" data-id="${esc(idea.id)}">
        <div class="idea-head">
          <div class="idea-title">${esc(idea.title)}</div>
          <div class="idea-status status-${esc(idea.status)}">${esc(STATUS_LABEL[idea.status] ?? idea.status)}</div>
        </div>
        <div class="idea-meta">${esc(idea.source === 'cindy' ? 'Cindy' : idea.source === 'manual' ? '手动' : idea.source)}</div>
        <div class="idea-actions">
          <button type="button" class="primary-link" data-action="copy">复制去讨论</button>
          ${idea.status !== 'done' ? '<button type="button" data-action="done">采纳</button>' : ''}
          ${idea.status === 'todo' || idea.status === 'doing'
            ? '<button type="button" data-action="blocked">搁置</button>'
            : '<button type="button" data-action="todo">重开</button>'}
          <button type="button" class="danger" data-action="delete">删除</button>
        </div>
      </div>
    `).join('');
  };

  const renderKnowledge = () => {
    const counts = state.overview?.knowledge ?? {};
    $('knowledgeCount').textContent = `${counts.knowledge ?? 0} 条 · 已验证 ${counts.verified ?? 0}`;
    $('knowledgeBody').innerHTML = `
      <div class="line">知识 ${esc(counts.knowledge ?? 0)} 条（已验证 ${esc(counts.verified ?? 0)}）</div>
      <div class="line muted small">知识只保存在插件目录，不写项目文件。</div>
    `;
    const items = state.overview?.knowledgeItems ?? [];
    $('knowledgeList').innerHTML = items.length
      ? items.map((entry) => `
        <div class="knowledge-item">
          <div class="line">${esc(entry.title)}</div>
          <div class="muted small">${esc(entry.status === 'verified' ? '已验证' : '未验证')}${entry.tags?.length ? ` · ${esc(entry.tags.join(' / '))}` : ''}</div>
        </div>
      `).join('')
      : '<div class="muted small">还没有知识笔记。</div>';
  };

  const renderDiagrams = () => {
    const diagrams = state.overview?.diagrams ?? [];
    $('diagramBadge').textContent = diagrams.length ? `${diagrams.length} 张` : '';
    $('diagramList').innerHTML = diagrams.map((diagram) => (
      `<span class="chip">${esc(DIAGRAM_LABEL[diagram.kind] ?? diagram.kind)} · v${esc(diagram.version)}</span>`
    )).join('');
    if (!diagrams.length) {
      $('diagramBody').textContent = '还没有生成依赖图。';
      return;
    }
    const latest = diagrams[0];
    $('diagramBody').innerHTML = `
      <div class="line">${esc(latest.title || '依赖图')}</div>
      <div class="line muted small">${esc(latest.summary || '')}</div>
    `;
  };

  const render = () => {
    renderProjectSelect();
    renderNextAction();
    renderBrief();
    renderIdeas();
    renderKnowledge();
    renderDiagrams();
  };

  const load = async () => {
    setStatus('同步中…');
    try {
      const overview = await call('owner/projects/overview', { projectId: state.projectId }, 20000);
      state.overview = overview;
      state.projectId = overview?.activeProjectId || '';
      render();
      setStatus('已连接', 'ok');
    } catch (error) {
      setStatus('读取失败', 'bad');
      toast(`读取失败：${String(error?.message ?? error)}`);
    }
  };

  const showAddProject = (show) => {
    $('addProjectCard').hidden = !show;
    $('addProjectError').hidden = true;
    if (show) $('projectPath').focus();
  };

  const addProject = async () => {
    const value = String($('projectPath').value ?? '').trim();
    if (!value) return;
    try {
      const result = await call('owner/projects/add', { path: value }, 20000);
      $('projectPath').value = '';
      showAddProject(false);
      state.projectId = result?.project?.id ?? state.projectId;
      await load();
      toast('项目已添加');
    } catch (error) {
      const node = $('addProjectError');
      node.textContent = String(error?.message ?? error);
      node.hidden = false;
    }
  };

  const refreshBrief = async () => {
    if (!state.projectId) return;
    $('briefRefresh').disabled = true;
    toast('正在扫描…');
    try {
      await call('owner/brief/refresh', { projectId: state.projectId }, 20000);
      await load();
      toast('画像已更新');
    } catch (error) {
      toast(`扫描失败：${String(error?.message ?? error)}`);
    } finally {
      $('briefRefresh').disabled = false;
    }
  };

  const addIdea = async () => {
    const input = $('ideaInput');
    const title = String(input.value ?? '').trim();
    if (!title || !state.projectId) return;
    input.value = '';
    try {
      await call('owner/ideas/add', { projectId: state.projectId, title }, 20000);
      await load();
    } catch (error) {
      toast(`保存失败：${String(error?.message ?? error)}`);
    }
  };

  const addKnowledge = async () => {
    const input = $('knowledgeInput');
    const title = String(input.value ?? '').trim();
    if (!title || !state.projectId) return;
    input.value = '';
    try {
      await call('owner/knowledge/add', { projectId: state.projectId, title }, 20000);
      await load();
    } catch (error) {
      toast(`保存失败：${String(error?.message ?? error)}`);
    }
  };

  const updateIdea = async (idea, action) => {
    try {
      if (action === 'delete') await call('owner/ideas/remove', { id: idea.id }, 20000);
      else await call('owner/ideas/status', { id: idea.id, status: action }, 20000);
      await load();
    } catch (error) {
      toast(`操作失败：${String(error?.message ?? error)}`);
    }
  };

  const copyForChat = async (idea) => {
    const text = `讨论这条改进想法（只讨论，不要改代码）：${idea.title}`;
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制，粘贴到 Cindy 聊天里继续');
    } catch {
      toast(text);
    }
  };

  const scanDiagram = async () => {
    if (!state.projectId) return;
    $('diagramScan').disabled = true;
    toast('正在扫描依赖…');
    try {
      const diagram = await call('owner/diagrams/dependency', { projectId: state.projectId }, 20000);
      state.mermaid = String(diagram?.mermaid ?? '');
      await load();
      toast(`依赖图已生成：${diagram?.summary ?? ''}`);
    } catch (error) {
      toast(`扫描失败：${String(error?.message ?? error)}`);
    } finally {
      $('diagramScan').disabled = false;
    }
  };

  const copyDiagram = async () => {
    if (!state.mermaid) {
      toast('先生成依赖图');
      return;
    }
    try {
      await navigator.clipboard.writeText(state.mermaid);
      toast('Mermaid 已复制');
    } catch {
      toast('复制失败，请手动选择');
    }
  };

  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('#ideaList button[data-action]');
    if (!button) return;
    const ideaId = button.closest('.idea')?.dataset.id;
    const idea = (state.overview?.ideas ?? []).find((item) => item.id === ideaId);
    if (!idea) return;
    const action = button.dataset.action;
    if (action === 'copy') { void copyForChat(idea); return; }
    void updateIdea(idea, action);
  });

  $('refreshButton').addEventListener('click', () => { void load(); });
  $('addProjectButton').addEventListener('click', () => showAddProject($('addProjectCard').hidden));
  $('projectCancel').addEventListener('click', () => showAddProject(false));
  $('projectAdd').addEventListener('click', () => { void addProject(); });
  $('projectPath').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void addProject();
  });
  $('projectSelect').addEventListener('change', (event) => {
    state.projectId = event.target.value;
    void load();
  });
  $('briefRefresh').addEventListener('click', () => { void refreshBrief(); });
  $('ideaAdd').addEventListener('click', () => { void addIdea(); });
  $('ideaInput').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void addIdea();
  });
  $('knowledgeAdd').addEventListener('click', () => { void addKnowledge(); });
  $('knowledgeInput').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void addKnowledge();
  });
  $('diagramScan').addEventListener('click', () => { void scanDiagram(); });
  $('diagramCopy').addEventListener('click', () => { void copyDiagram(); });

  void load();
})();
