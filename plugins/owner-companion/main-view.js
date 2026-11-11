/* global OwnerBridge */
(() => {
  const $ = (id) => document.getElementById(id);
  const call = (method, params, timeoutMs) => OwnerBridge.call(method, params, timeoutMs);

  const state = {
    overview: null,
    projectId: '',
    paired: false,
    busy: false,
    messages: [],
    elapsed: 0,
    timer: 0
  };

  const STATUS_LABEL = {
    todo: '新想法', doing: '讨论中', blocked: '搁置', done: '已采纳', failed: '失败'
  };
  const DIAGRAM_LABEL = {
    dependency: '依赖图', control: '控制流', dataflow: '数据流', state: '状态图', sequence: '时序图'
  };

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
  };

  const renderNextAction = () => {
    const card = $('nextActionCard');
    const action = state.overview?.nextAction;
    if (!action) { card.hidden = true; return; }
    card.hidden = false;
    card.innerHTML = `
      <div class="action-label">下一步</div>
      <div class="action-title">${esc(action.title || action.label || '')}</div>
      ${action.detail ? `<div class="action-detail">${esc(action.detail)}</div>` : ''}
    `;
  };

  const renderBrief = () => {
    const brief = state.overview?.brief;
    const box = $('briefBody');
    if (!brief) {
      box.textContent = '电脑端还没有生成画像。在桌面点一次「理解项目」即可。';
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

  const renderKnowledge = () => {
    const counts = state.overview?.knowledge ?? {};
    $('knowledgeBody').innerHTML = `
      <div class="line">经验 ${esc(counts.experiences ?? 0)} · 知识 ${esc(counts.knowledge ?? 0)}（已验证 ${esc(counts.verified ?? 0)}）</div>
      <div class="line muted small">待提炼 ${esc(counts.pendingHarvest ?? 0)} · 候选 ${esc(counts.candidates ?? 0)} · 复用 ${esc(counts.usages ?? 0)}</div>
    `;
    const diagrams = state.overview?.diagrams ?? [];
    $('diagramList').innerHTML = diagrams.map((diagram) => (
      `<span class="chip">${esc(DIAGRAM_LABEL[diagram.kind] ?? diagram.kind)} · v${esc(diagram.version)}</span>`
    )).join('');
  };

  const renderIdeas = () => {
    const list = $('ideaList');
    const ideas = state.overview?.ideas ?? [];
    if (!ideas.length) {
      list.innerHTML = '<div class="muted small">还没有想法。和 Agent 讨论时提到的改进会自动进这里。</div>';
      return;
    }
    list.innerHTML = ideas.map((idea) => `
      <div class="idea" data-id="${esc(idea.id)}">
        <div class="idea-head">
          <div class="idea-title">${esc(idea.title)}</div>
          <div class="idea-status status-${esc(idea.status)}">${esc(STATUS_LABEL[idea.status] ?? idea.status)}</div>
        </div>
        <div class="idea-meta">${esc(idea.source === 'conversation' ? '对话' : idea.source === 'mobile' ? '手机' : '手动')}</div>
        <div class="idea-actions">
          <button type="button" class="primary-link" data-action="discuss">讨论</button>
          ${idea.status !== 'done' ? '<button type="button" data-action="done">采纳</button>' : ''}
          ${idea.status === 'todo' || idea.status === 'doing'
            ? '<button type="button" data-action="blocked">搁置</button>'
            : '<button type="button" data-action="todo">重开</button>'}
          <button type="button" class="danger" data-action="delete">删除</button>
        </div>
      </div>
    `).join('');
  };

  const renderMessages = () => {
    const box = $('chatMessages');
    if (!state.messages.length && !state.busy) {
      box.innerHTML = '<div class="muted small">可以问进度，也可以说说改进想法；写操作需要回电脑批准。</div>';
      return;
    }
    box.innerHTML = state.messages.map((message) => (
      `<div class="msg ${message.role}">${esc(message.text)}</div>`
    )).join('') + (state.busy
      ? `<div class="msg agent">分析中… ${esc(state.elapsed)}s</div>`
      : '');
    box.scrollTop = box.scrollHeight;
  };

  const render = () => {
    renderProjectSelect();
    renderNextAction();
    renderBrief();
    renderIdeas();
    renderKnowledge();
    renderMessages();
  };

  const load = async () => {
    setStatus('同步中…');
    try {
      const status = await call('owner/status', {}, 10000);
      state.paired = Boolean(status?.paired);
      $('connectHint').hidden = state.paired;
      if (!state.paired) {
        setStatus('未连接', 'bad');
        return;
      }
      const overview = await call('owner/overview', { projectId: state.projectId }, 40000);
      state.overview = overview;
      state.projectId = overview?.activeProjectId || state.projectId;
      render();
      setStatus('已连接', 'ok');
    } catch (error) {
      setStatus('连接失败', 'bad');
      toast(`同步失败：${String(error?.message ?? error)}`);
    }
  };

  const sendChat = async (text) => {
    const value = String(text ?? '').trim();
    if (!value || state.busy) return;
    state.messages.push({ role: 'user', text: value });
    state.busy = true;
    state.elapsed = 0;
    renderMessages();
    const startedAt = Date.now();
    state.timer = setInterval(() => {
      state.elapsed = Math.round((Date.now() - startedAt) / 1000);
      renderMessages();
    }, 1000);
    try {
      const result = await call('owner/chat', { projectId: state.projectId, text: value }, 210000);
      const answer = result?.summary || result?.advice || '（没有返回内容）';
      const extra = result?.mode === 'write-request'
        ? '\n\n写请求已创建，需要回电脑上批准后才会执行。'
        : result?.mode === 'triage-error'
          ? '\n\n分析没有完成，可以重试。'
          : '';
      state.messages.push({ role: 'agent', text: `${answer}${extra}` });
    } catch (error) {
      state.messages.push({ role: 'agent', text: `失败：${String(error?.message ?? error)}` });
    } finally {
      clearInterval(state.timer);
      state.busy = false;
      renderMessages();
      void load();
    }
  };

  const addIdea = async () => {
    const input = $('ideaInput');
    const title = String(input.value ?? '').trim();
    if (!title) return;
    input.value = '';
    try {
      await call('owner/ideas/add', { projectId: state.projectId, title }, 20000);
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

  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('#ideaList button[data-action]');
    if (!button) return;
    const ideaId = button.closest('.idea')?.dataset.id;
    const idea = (state.overview?.ideas ?? []).find((item) => item.id === ideaId);
    if (!idea) return;
    const action = button.dataset.action;
    if (action === 'discuss') {
      $('chatInput').value = `讨论这条改进想法（只讨论，不要改代码）：${idea.title}`;
      $('chatInput').focus();
      return;
    }
    void updateIdea(idea, action);
  });

  $('refreshButton').addEventListener('click', () => { void load(); });
  $('projectSelect').addEventListener('change', (event) => {
    state.projectId = event.target.value;
    state.messages = [];
    void load();
  });
  $('ideaAdd').addEventListener('click', () => { void addIdea(); });
  $('ideaInput').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void addIdea();
  });
  $('chatSend').addEventListener('click', () => {
    const value = $('chatInput').value;
    $('chatInput').value = '';
    void sendChat(value);
  });
  $('chatInput').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    const value = $('chatInput').value;
    $('chatInput').value = '';
    void sendChat(value);
  });

  void load();
})();
