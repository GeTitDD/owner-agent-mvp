/* global OwnerBridge */
(() => {
  const $ = (id) => document.getElementById(id);
  const call = (method, params, timeoutMs) => OwnerBridge.call(method, params, timeoutMs);
  const sessionId = new URLSearchParams(location.search).get('session') ?? '';

  // 记住这个任务页签停留的项目，刷新或重开时直接回到它。
  const rememberFocus = async (projectId) => {
    if (!projectId) return;
    try {
      await call('owner/projects/focus/set', { sessionId, projectId }, 5000);
    } catch {
      // 旧宿主没有这个方法时忽略，不影响页面。
    }
  };

  const state = {
    overview: null,
    projectId: '',
    mermaid: '',
    knowledge: [],
    experiences: [],
    knowledgeTab: 'proposed',
    tidy: null,
    diagramKind: '',
    diagramCache: {},
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

  const copyText = async (value) => {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // 沙箱/无权限时退回选中 + execCommand。
    }
    try {
      const area = document.createElement('textarea');
      area.value = value;
      area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.append(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      if (ok) return true;
    } catch {
      // execCommand 也被拦时，交给 Node 侧写系统剪贴板。
    }
    try {
      const result = await call('owner/clipboard', { text: value }, 8000);
      return Boolean(result?.ok);
    } catch {
      return false;
    }
  };

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

  // ---- 图预览：用本地 SVG 画，不依赖外网 mermaid ----
  const trim = (value, max) => {
    const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  };

  const DIAGRAM_DEFS = '<defs><marker id="owner-arrow" viewBox="0 0 10 10" refX="9" refY="5"'
    + ' markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
    + '<path d="M0 0L10 5L0 10z" fill="var(--text-2, #525252)"/></marker></defs>';

  const svgText = (x, y, text, options = {}) => {
    const { size = 12, fill = 'var(--text)', anchor = 'start', weight = 400 } = options;
    return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}"`
      + ` font-weight="${weight}">${esc(text)}</text>`;
  };

  /** 盒子的出边点：从中心连线与盒子边界的交点。 */
  const edgePoint = (from, to) => {
    const dx = (to.x + to.w / 2) - (from.x + from.w / 2);
    const dy = (to.y + to.h / 2) - (from.y + from.h / 2);
    const angle = Math.atan2(dy, dx);
    const hw = from.w / 2;
    const hh = from.h / 2;
    const cos = Math.abs(Math.cos(angle)) || 1e-6;
    const sin = Math.abs(Math.sin(angle)) || 1e-6;
    const scale = Math.min(hw / cos, hh / sin);
    return {
      x: from.x + from.w / 2 + Math.cos(angle) * scale,
      y: from.y + from.h / 2 + Math.sin(angle) * scale
    };
  };

  /** 流程类图（依赖 / 控制流 / 数据流）：按依赖层级分列。 */
﻿  /** 流程类图（依赖 / 控制流 / 数据流）：按依赖层级自上而下分行，适合窄面板。 */
  const flowSvg = (data) => {
    const nodes = (data?.nodes ?? []).filter((node) => node && node.id);
    if (!nodes.length) return '';
    const edges = (data?.edges ?? []).filter((edge) => edge && edge.from && edge.to);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const out = new Map(nodes.map((node) => [node.id, []]));
    const indeg = new Map(nodes.map((node) => [node.id, 0]));
    for (const edge of edges) {
      if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
      out.get(edge.from).push(edge.to);
      indeg.set(edge.to, (indeg.get(edge.to) ?? 0) + 1);
    }
    // 从入度为 0 的节点开始做“最长路径”分层；有环时靠步数上限兜底。
    const level = new Map();
    const roots = nodes.filter((node) => (indeg.get(node.id) ?? 0) === 0).map((node) => node.id);
    const queue = roots.length ? [...roots] : [nodes[0].id];
    for (const id of queue) level.set(id, 0);
    let guard = 0;
    while (queue.length && guard < nodes.length * 10 + 50) {
      const id = queue.shift();
      guard += 1;
      const base = level.get(id) ?? 0;
      for (const next of out.get(id) ?? []) {
        if ((level.get(next) ?? -1) < base + 1) {
          level.set(next, base + 1);
          queue.push(next);
        }
      }
    }
    for (const node of nodes) if (!level.has(node.id)) level.set(node.id, 0);

    const columns = [];
    for (const node of nodes) {
      const index = level.get(node.id) ?? 0;
      (columns[index] ??= []).push(node);
    }
    // 一层最多放 4 个，超出的拆到下一行，避免一条链拉得又宽又长。
    const rows = [];
    for (const column of columns.filter(Boolean)) {
      for (let start = 0; start < column.length; start += 4) {
        rows.push(column.slice(start, start + 4));
      }
    }

    const labelOf = (node) => String(node.label || node.id);
    const boxW = 150;
    const boxH = 34;
    const gapX = 16;
    const gapY = 40;
    const pad = 16;
    const rowWidths = rows.map((row) => row.length * boxW + (row.length - 1) * gapX);
    const W = Math.max(...rowWidths, 320) + pad * 2;
    const pos = new Map();
    let y = pad;
    rows.forEach((row, rowIndex) => {
      let x = (W - rowWidths[rowIndex]) / 2;
      for (const node of row) {
        pos.set(node.id, { x, y, w: boxW, h: boxH });
        x += boxW + gapX;
      }
      y += boxH + gapY;
    });
    const H = y - gapY + pad;

    const parts = [];
    for (const edge of edges) {
      const a = pos.get(edge.from);
      const b = pos.get(edge.to);
      if (!a || !b || edge.from === edge.to) continue;
      let d;
      let labelX;
      let labelY;
      if (Math.abs(a.y - b.y) < 1) {
        // 同一行：从右侧绕到左侧上方。
        const sx = a.x + a.w;
        const sy = a.y + a.h / 2;
        const tx = b.x;
        const ty = b.y + b.h / 2;
        const lift = 26;
        d = `M${sx} ${sy} C${sx + 24} ${sy - lift} ${tx - 24} ${ty - lift} ${tx} ${ty}`;
        labelX = (sx + tx) / 2;
        labelY = sy - lift * 0.7;
      } else {
        const forward = b.y > a.y;
        const sx = a.x + a.w / 2;
        const sy = forward ? a.y + a.h : a.y;
        const tx = b.x + b.w / 2;
        const ty = forward ? b.y : b.y + b.h;
        const bend = Math.max(18, Math.abs(ty - sy) / 2);
        d = forward
          ? `M${sx} ${sy} C${sx} ${sy + bend} ${tx} ${ty - bend} ${tx} ${ty}`
          : `M${sx} ${sy} C${sx + 70} ${sy} ${tx + 70} ${ty} ${tx} ${ty}`;
        labelX = (sx + tx) / 2;
        labelY = (sy + ty) / 2 - 5;
      }
      parts.push(`<path d="${d}" fill="none" stroke="var(--text-2, #525252)" stroke-width="1.2" marker-end="url(#owner-arrow)"/>`);
      if (edge.label) {
        parts.push(`<text x="${labelX}" y="${labelY}" font-size="10" fill="var(--muted)" text-anchor="middle"`
          + ` paint-order="stroke" stroke="var(--surface)" stroke-width="3">${esc(trim(edge.label, 20))}</text>`);
      }
    }
    for (const node of nodes) {
      const box = pos.get(node.id);
      if (!box) continue;
      const dashed = node.type === 'decision' ? ' stroke-dasharray="4 3"' : '';
      parts.push('<g>');
      parts.push(`<title>${esc(labelOf(node))}</title>`);
      parts.push(`<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="9"`
        + ` fill="var(--surface)" stroke="var(--line)"${dashed}/>`);
      parts.push(svgText(box.x + box.w / 2, box.y + box.h / 2 + 4, trim(labelOf(node), 20), { anchor: 'middle' }));
      parts.push('</g>');
    }
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">${DIAGRAM_DEFS}${parts.join('')}</svg>`;
  };


  const sequenceSvg = (data) => {
    const participants = (data?.participants ?? []).filter((item) => item && item.id);
    const messages = (data?.messages ?? []).filter((item) => item && item.from && item.to);
    if (!participants.length) return '';
    const pad = 18;
    const gap = 26;
    const headH = 34;
    const rowH = 32;
    let cursor = pad;
    const columns = [];
    const pos = new Map();
    for (const participant of participants) {
      const width = Math.min(190, Math.max(110, String(participant.label || participant.id).length * 7 + 20));
      columns.push({ participant, x: cursor, w: width });
      pos.set(participant.id, { x: cursor, w: width });
      cursor += width + gap;
    }
    const W = Math.max(340, cursor - gap + pad);
    const top = 16;
    const H = top + headH + 30 + messages.length * rowH + 16;
    const parts = [];
    for (const column of columns) {
      const cx = column.x + column.w / 2;
      parts.push(`<line x1="${cx}" y1="${top + headH}" x2="${cx}" y2="${H - 12}" stroke="var(--line)" stroke-dasharray="4 4"/>`);
      parts.push(`<rect x="${column.x}" y="${top}" width="${column.w}" height="${headH}" rx="8" fill="var(--surface)" stroke="var(--line)"/>`);
      parts.push(svgText(cx, top + headH / 2 + 4, trim(column.participant.label || column.participant.id, 18), { anchor: 'middle' }));
    }
    messages.forEach((message, index) => {
      const a = pos.get(message.from);
      const b = pos.get(message.to);
      if (!a || !b) return;
      const y = top + headH + 30 + index * rowH;
      const ax = a.x + a.w / 2;
      const bx = b.x + b.w / 2;
      if (message.from === message.to) {
        parts.push(`<path d="M${ax} ${y} h18 v18 h-18" fill="none" stroke="var(--text-2)" stroke-width="1.2" marker-end="url(#owner-arrow)"/>`);
        parts.push(svgText(ax + 26, y + 6, trim(message.text, 26), { size: 10.5 }));
      } else {
        parts.push(`<line x1="${ax}" y1="${y}" x2="${bx}" y2="${y}" stroke="var(--text-2)" stroke-width="1.2" marker-end="url(#owner-arrow)"/>`);
        parts.push(svgText((ax + bx) / 2, y - 6, trim(message.text, 30), { anchor: 'middle', size: 10.5 }));
      }
    });
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">${DIAGRAM_DEFS}${parts.join('')}</svg>`;
  };

  /** 状态机：状态排成一圈，转移画箭头。 */
  const stateSvg = (data) => {
    const states = (data?.states ?? []).filter((item) => item && item.id);
    const transitions = (data?.transitions ?? []).filter((item) => item && item.from && item.to);
    if (!states.length) return '';
    const count = states.length;
    const W = 760;
    const radius = Math.max(150, Math.min(280, 50 + count * 24));
    const cx = W / 2;
    const cy = radius * 0.92 + 30;
    const H = cy * 2 + 20;
    const boxW = 128;
    const boxH = 38;
    const pos = new Map();
    states.forEach((state, index) => {
      const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
      pos.set(state.id, {
        x: cx + Math.cos(angle) * radius - boxW / 2,
        y: cy + Math.sin(angle) * radius * 0.82 - boxH / 2,
        w: boxW,
        h: boxH
      });
    });
    const parts = [];
    for (const transition of transitions) {
      const a = pos.get(transition.from);
      const b = pos.get(transition.to);
      if (!a || !b) continue;
      if (transition.from === transition.to) {
        const x = a.x + a.w / 2;
        const y = a.y;
        parts.push(`<path d="M${x - 8} ${y} c-6 -26 22 -26 16 0" fill="none" stroke="var(--text-2)" stroke-width="1.2" marker-end="url(#owner-arrow)"/>`);
        continue;
      }
      const start = edgePoint(a, b);
      const end = edgePoint(b, a);
      parts.push(`<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" stroke="var(--text-2)" stroke-width="1.2" marker-end="url(#owner-arrow)"/>`);
      if (transition.trigger) {
        parts.push(`<text x="${(start.x + end.x) / 2}" y="${(start.y + end.y) / 2 - 5}" font-size="10"`
          + ` fill="var(--muted)" text-anchor="middle" paint-order="stroke" stroke="var(--surface)" stroke-width="3">`
          + `${esc(trim(transition.trigger, 20))}</text>`);
      }
    }
    for (const state of states) {
      const box = pos.get(state.id);
      const isStart = state.kind === 'start';
      const isEnd = state.kind === 'end';
      parts.push('<g>');
      parts.push(`<title>${esc(state.label || state.id)}</title>`);
      parts.push(`<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="${isStart || isEnd ? 19 : 9}"`
        + ` fill="var(--surface)" stroke="${isEnd ? 'var(--danger, #c0392b)' : 'var(--line)'}"/>`);
      parts.push(svgText(box.x + box.w / 2, box.y + box.h / 2 + 4, trim(state.label || state.id, 16), { anchor: 'middle' }));
      parts.push('</g>');
    }
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">${DIAGRAM_DEFS}${parts.join('')}</svg>`;
  };

  const diagramSvg = (diagram) => {
    if (!diagram?.data) return '';
    if (diagram.kind === 'sequence') return sequenceSvg(diagram.data);
    if (diagram.kind === 'state') return stateSvg(diagram.data);
    return flowSvg(diagram.data);
  };

  const applyDiagram = (diagram) => {
    state.mermaid = String(diagram?.mermaid ?? '');
    const meta = (state.overview?.diagrams ?? []).find((item) => item.kind === diagram.kind);
    $('diagramMeta').innerHTML = `<div class="line">${esc(meta?.title || diagram.title || '图')}</div>`
      + `<div class="line muted small">${esc(meta?.summary || diagram.summary || '')}</div>`;
    const svg = diagramSvg(diagram);
    $('diagramCanvas').innerHTML = svg
      || '<div class="muted small">这张图没有可预览的结构化数据，点「查看源码」或「复制 Mermaid」。</div>';
    const source = $('diagramSource');
    source.textContent = state.mermaid;
    source.hidden = true;
    $('diagramToggle').textContent = '查看源码';
  };

  const selectDiagram = async (kind) => {
    const meta = (state.overview?.diagrams ?? []).find((item) => item.kind === kind);
    if (!meta || !state.projectId) return;
    state.diagramKind = kind;
    for (const chip of document.querySelectorAll('#diagramList .chip')) {
      chip.classList.toggle('active', chip.dataset.kind === kind);
    }
    const key = `${kind}:${meta.version}`;
    let diagram = state.diagramCache[key];
    if (!diagram) {
      try {
        diagram = await call('owner/diagrams/get', { projectId: state.projectId, kind }, 20000);
        state.diagramCache[key] = diagram;
      } catch (error) {
        $('diagramCanvas').innerHTML = `<div class="muted small">读取失败：${esc(String(error?.message ?? error))}</div>`;
        return;
      }
    }
    applyDiagram(diagram);
  };

  const renderDiagrams = () => {
    const diagrams = state.overview?.diagrams ?? [];
    $('diagramBadge').textContent = diagrams.length ? `${diagrams.length} 张` : '';
    const list = $('diagramList');
    list.replaceChildren();
    for (const diagram of diagrams) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `chip${diagram.kind === state.diagramKind ? ' active' : ''}`;
      button.dataset.kind = diagram.kind;
      button.textContent = `${DIAGRAM_LABEL[diagram.kind] ?? diagram.kind} · v${diagram.version}`;
      button.addEventListener('click', () => { void selectDiagram(diagram.kind); });
      list.append(button);
    }
    if (!diagrams.length) {
      $('diagramMeta').textContent = '还没有生成依赖图。';
      $('diagramCanvas').innerHTML = '';
      $('diagramSource').hidden = true;
      state.diagramKind = '';
      return;
    }
    if (!state.diagramKind || !diagrams.some((item) => item.kind === state.diagramKind)) {
      state.diagramKind = diagrams[0].kind;
    }
    void selectDiagram(state.diagramKind);
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
      void rememberFocus(state.projectId);
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
    if (await copyText(text)) toast('提炼指令已复制，粘贴到 Cindy 聊天里发送');
    else toast('复制失败，请手动选中指令文本');
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
    if (await copyText(text)) toast('已复制，粘贴到 Cindy 聊天里继续');
    else toast('复制失败，请手动选中想法文本');
  };

  const scanDiagram = async () => {
    if (!state.projectId) return;
    $('diagramScan').disabled = true;
    toast('正在扫描依赖…');
    try {
      const diagram = await call('owner/diagrams/dependency', { projectId: state.projectId }, 20000);
      state.diagramCache = {};
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
    if (await copyText(state.mermaid)) {
      toast('Mermaid 已复制');
      return;
    }
    $('diagramSource').hidden = false;
    $('diagramToggle').textContent = '收起源码';
    toast('复制被宿主拦下了，已展开源码，请按 Ctrl+C');
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
  $('diagramToggle').addEventListener('click', () => {
    const source = $('diagramSource');
    source.hidden = !source.hidden;
    $('diagramToggle').textContent = source.hidden ? '查看源码' : '收起源码';
  });

  // 页面启动：优先恢复这个任务上次的项目，没有记录才用默认项目。
  const init = async () => {
    if (!state.projectId) {
      try {
        const focused = await call('owner/projects/focus/get', { sessionId }, 5000);
        state.projectId = focused?.projectId ?? '';
      } catch {
        // 旧宿主忽略：按默认项目加载。
      }
    }
    await load();
  };

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

  void init();
})();
