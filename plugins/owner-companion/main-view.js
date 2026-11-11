/* global OwnerBridge */
(() => {
  const $ = (id) => document.getElementById(id);
  const call = (method, params, timeoutMs) => OwnerBridge.call(method, params, timeoutMs);

  const state = {
    overview: null,
    projectId: '',
    mermaid: '',
    knowledge: [],
    experiences: [],
    knowledgeTab: 'proposed',
    tidy: null,
    github: null,
    patches: [],
    tests: [],
    testOutput: ''
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

  const KNOWLEDGE_STATUS = {
    proposed: '待审核', unverified: '未验证', verified: '已验证', rejected: '已拒绝'
  };

  const renderKnowledgeTabs = () => {
    const counts = state.overview?.knowledge ?? {};
    $('proposedCount').textContent = counts.proposed ? `(${counts.proposed})` : '';
    for (const button of document.querySelectorAll('[data-knowledge-tab]')) {
      button.classList.toggle('active', button.dataset.knowledgeTab === state.knowledgeTab);
    }
  };

  const renderKnowledge = () => {
    renderKnowledgeTabs();
    const counts = state.overview?.knowledge ?? {};
    $('knowledgeCount').textContent =
      `待审 ${counts.proposed ?? 0} · 未验证 ${counts.unverified ?? 0} · 已验证 ${counts.verified ?? 0}`;
    $('knowledgeBody').innerHTML = `
      <div class="line">经验 ${esc(counts.experiences ?? 0)} 条 · 知识 ${esc(counts.knowledge ?? 0)} 条</div>
      <div class="line muted small">候选需要你接受后才会进入知识；接受不等于已验证。</div>
    `;

    const list = $('knowledgeList');
    if (state.knowledgeTab === 'proposed') {
      const items = state.knowledge.filter((entry) => entry.status === 'proposed');
      list.innerHTML = items.length
        ? items.map((entry) => `
          <div class="knowledge-item" data-id="${esc(entry.id)}">
            <div class="line">${esc(entry.title)}</div>
            ${entry.body ? `<div class="muted small">${esc(String(entry.body).slice(0, 200))}</div>` : ''}
            <div class="idea-actions">
              <button type="button" class="primary-link" data-knowledge-action="accept">接受</button>
              <button type="button" class="danger" data-knowledge-action="reject">拒绝</button>
            </div>
          </div>
        `).join('')
        : '<div class="muted small">没有待审核候选。让 Cindy 提炼一轮试试。</div>';
    } else if (state.knowledgeTab === 'knowledge') {
      const items = state.knowledge.filter((entry) => entry.status !== 'proposed');
      list.innerHTML = items.length
        ? items.map((entry) => `
          <div class="knowledge-item" data-id="${esc(entry.id)}">
            <div class="line">${esc(entry.title)}</div>
            <div class="muted small">
              ${esc(KNOWLEDGE_STATUS[entry.status] ?? entry.status)}
              ${entry.tags?.length ? ` · ${esc(entry.tags.join(' / '))}` : ''}
            </div>
            ${entry.status === 'unverified'
              ? '<div class="idea-actions"><button type="button" class="primary-link" data-knowledge-action="verify">标记已验证</button></div>'
              : ''}
          </div>
        `).join('')
        : '<div class="muted small">还没有知识。</div>';
    } else {
      list.innerHTML = state.experiences.length
        ? state.experiences.map((entry) => `
          <div class="knowledge-item">
            <div class="line">${esc(String(entry.text).slice(0, 200))}</div>
            <div class="muted small">${esc(entry.outcome)} · ${entry.distilled ? '已提炼' : '未提炼'}</div>
          </div>
        `).join('')
        : '<div class="muted small">还没有经验。和 Cindy 讨论后让它用 owner_experience_add 记录。</div>';
    }

    const report = $('tidyReport');
    if (state.tidy) {
      const parts = [];
      if (state.tidy.duplicates?.length) parts.push(`重复标题 ${state.tidy.duplicates.length} 组`);
      if (state.tidy.short?.length) parts.push(`内容过短 ${state.tidy.short.length} 条`);
      if (state.tidy.unverified?.length) parts.push(`未验证 ${state.tidy.unverified.length} 条`);
      if (state.tidy.proposed?.length) parts.push(`待审核 ${state.tidy.proposed.length} 条`);
      report.textContent = parts.length ? parts.join(' · ') : '没有发现需要整理的问题';
      report.hidden = false;
    } else {
      report.hidden = true;
    }
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

  const renderGithub = () => {
    const box = $('githubBody');
    const lists = $('githubLists');
    lists.replaceChildren();
    const github = state.github;
    if (!github) {
      box.textContent = '正在读取…';
      return;
    }
    if (!github.ok) {
      box.textContent = `GitHub 不可用：${github.error}`;
      return;
    }
    box.innerHTML = `
      <div class="line">${esc(github.repo)}</div>
      <div class="line muted small">分支 ${esc(github.preview?.branch ?? '')} · ${github.preview?.clean ? '工作区干净' : '有未提交改动'}</div>
    `;
    const rows = [
      ...(github.issues ?? []).map((issue) => `#${issue.number} ${issue.title}`),
      ...(github.prs ?? []).map((pr) => `PR #${pr.number}${pr.draft ? '（Draft）' : ''} ${pr.title}`)
    ].slice(0, 8);
    lists.innerHTML = rows.length
      ? rows.map((row) => `<div class="muted small line">· ${esc(row)}</div>`).join('')
      : '<div class="muted small">没有打开的 Issue 或 PR。</div>';
  };

  const renderPatches = () => {
    const pending = state.patches.filter((entry) => entry.status === 'pending');
    $('patchBody').textContent = pending.length
      ? `${pending.length} 条待处理补丁；应用前请先确认。`
      : '没有待处理补丁。';
    $('patchList').innerHTML = pending.map((entry) => `
      <div class="knowledge-item" data-patch-id="${esc(entry.id)}">
        <div class="line">${esc(entry.title)}</div>
        <pre class="patch-diff">${esc(String(entry.diff ?? '').slice(0, 1600))}</pre>
        <div class="idea-actions">
          <button type="button" class="primary-link" data-patch-action="apply">应用</button>
          <button type="button" class="danger" data-patch-action="reject">拒绝</button>
        </div>
      </div>
    `).join('');
    const last = state.tests[0];
    if (last) {
      state.testOutput = `${last.ok ? '通过' : '失败'} · ${last.command} · ${Math.round(last.durationMs / 1000)}s\n${last.output}`;
    }
    const output = $('testOutput');
    if (state.testOutput) {
      output.textContent = state.testOutput;
      output.hidden = false;
    } else {
      output.hidden = true;
    }
  };

  const render = () => {
    renderProjectSelect();
    renderNextAction();
    renderBrief();
    renderIdeas();
    renderKnowledge();
    renderDiagrams();
    renderGithub();
    renderPatches();
  };

  const load = async () => {
    setStatus('同步中…');
    try {
      const overview = await call('owner/projects/overview', { projectId: state.projectId }, 20000);
      state.overview = overview;
      state.projectId = overview?.activeProjectId || '';
      if (state.projectId) {
        const [knowledge, github, patches, tests] = await Promise.all([
          call('owner/knowledge/list', { projectId: state.projectId }, 20000),
          call('owner/github/status', { projectId: state.projectId }, 30000)
            .catch((error) => ({ ok: false, error: String(error?.message ?? error) })),
          call('owner/patches/list', { projectId: state.projectId }, 20000).catch(() => ({ items: [] })),
          call('owner/tests/list', { projectId: state.projectId }, 20000).catch(() => ({ items: [] }))
        ]);
        state.knowledge = knowledge.items ?? [];
        state.experiences = knowledge.experiences ?? [];
        state.github = github;
        state.patches = patches.items ?? [];
        state.tests = tests.items ?? [];
      } else {
        state.knowledge = [];
        state.experiences = [];
        state.github = null;
        state.patches = [];
        state.tests = [];
      }
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

  const knowledgeAction = async (id, action) => {
    try {
      if (action === 'verify') await call('owner/knowledge/verify', { id }, 20000);
      else await call('owner/knowledge/review', { id, decision: action }, 20000);
      await load();
    } catch (error) {
      toast(`操作失败：${String(error?.message ?? error)}`);
    }
  };

  const tidyKnowledge = async () => {
    if (!state.projectId) return;
    try {
      state.tidy = await call('owner/knowledge/tidy', { projectId: state.projectId }, 20000);
      renderKnowledge();
    } catch (error) {
      toast(`整理失败：${String(error?.message ?? error)}`);
    }
  };

  const distillPrompt = async () => {
    const text = '请根据我们这轮讨论：先用 owner_experience_add 记录可复用经验，'
      + '再用 owner_knowledge_propose 提炼 1-3 条候选（标题 + 细节 + 证据），不要直接写 owner_knowledge_add。';
    try {
      await navigator.clipboard.writeText(text);
      toast('提炼指令已复制，粘贴到 Cindy 聊天里发送');
    } catch {
      toast(text);
    }
  };

  const patchAction = async (id, action) => {
    if (action === 'apply' && !$('patchConfirm').checked) {
      toast('先勾选「我确认应用补丁会写入项目文件」');
      return;
    }
    try {
      if (action === 'apply') await call('owner/patches/apply', { id }, 30000);
      else await call('owner/patches/reject', { id }, 20000);
      await load();
      toast(action === 'apply' ? '补丁已应用' : '补丁已拒绝');
    } catch (error) {
      toast(`操作失败：${String(error?.message ?? error)}`);
    }
  };

  const runTests = async () => {
    if (!state.projectId) return;
    const command = String($('testCommand').value ?? '').trim();
    $('testsRun').disabled = true;
    toast('正在运行测试…');
    try {
      const result = await call('owner/tests/run', { projectId: state.projectId, command }, 320000);
      state.testOutput = `${result.ok ? '通过' : '失败'} · ${result.command} · ${Math.round(result.durationMs / 1000)}s\n${result.output}`;
      $('testOutput').textContent = state.testOutput;
      $('testOutput').hidden = false;
      await load();
    } catch (error) {
      toast(`测试失败：${String(error?.message ?? error)}`);
    } finally {
      $('testsRun').disabled = false;
    }
  };

  const createPr = async () => {
    if (!$('prConfirm').checked) {
      toast('先勾选「我确认只创建 Draft PR」');
      return;
    }
    if (!state.projectId) return;
    const title = String($('prTitle').value ?? '').trim();
    const base = String($('prBase').value ?? '').trim() || 'main';
    $('prCreate').disabled = true;
    $('prResult').textContent = '创建中…';
    try {
      const result = await call('owner/github/pr/create', {
        projectId: state.projectId, base, title, confirm: true
      }, 120000);
      $('prResult').textContent = `已创建：${result.url}`;
      await load();
    } catch (error) {
      $('prResult').textContent = `失败：${String(error?.message ?? error)}`;
    } finally {
      $('prCreate').disabled = false;
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
    const tab = event.target.closest?.('[data-knowledge-tab]');
    if (tab) {
      state.knowledgeTab = tab.dataset.knowledgeTab;
      renderKnowledge();
      return;
    }
    const knowledgeButton = event.target.closest?.('#knowledgeList [data-knowledge-action]');
    if (knowledgeButton) {
      const id = knowledgeButton.closest('.knowledge-item')?.dataset.id;
      if (id) void knowledgeAction(id, knowledgeButton.dataset.knowledgeAction);
      return;
    }
    const patchButton = event.target.closest?.('#patchList [data-patch-action]');
    if (patchButton) {
      const id = patchButton.closest('.knowledge-item')?.dataset.patchId;
      if (id) void patchAction(id, patchButton.dataset.patchAction);
      return;
    }
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
  $('knowledgeTidy').addEventListener('click', () => { void tidyKnowledge(); });
  $('knowledgeDistill').addEventListener('click', () => { void distillPrompt(); });
  $('githubRefresh').addEventListener('click', () => { void load(); });
  $('prCreate').addEventListener('click', () => { void createPr(); });
  $('testsRun').addEventListener('click', () => { void runTests(); });
  $('diagramScan').addEventListener('click', () => { void scanDiagram(); });
  $('diagramCopy').addEventListener('click', () => { void copyDiagram(); });

  // 卡片上点「打开 Owner 面板」时，main.js 会广播要聚焦的项目，页签直接切过去。
  try {
    const channel = new BroadcastChannel('owner-companion');
    channel.onmessage = (event) => {
      const message = event.data;
      if (!message || message.type !== 'focus-project' || !message.projectId) return;
      if (message.projectId === state.projectId) return;
      state.projectId = message.projectId;
      void load();
    };
  } catch {
    // 旧宿主没有 BroadcastChannel 时按默认项目显示。
  }

  void load();
})();
