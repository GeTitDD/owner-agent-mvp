// #124 `@@` →「关联项目」：先选项目，再为它选资料（或让 Agent 自己找），结果做成
// 输入框上方的胶囊；发送时进入 prompt 的「## 关联项目」段。
//
// 边界：
// - 纯函数：草稿状态迁移（项目展开 / 资料勾选 / 自动找互斥）、胶囊合并与移除、
//   prompt 段的组装、从库视图里取四类资料计数——都可以脱离 Electron 断言；
// - 卡片里的 DOM：项目行就地展开、资料勾选框、提交按钮；容器与按键优先级仍在
//   shell-at.cjs / shell-compose.cjs，本文件不碰；
// - 胶囊的读模型与发送拼接都在这里，输入区只在发送时读一次（ctx.ui.atProject）。
//
// 资料分类与计数不另写一套口径：主进程用 src/project-library.mjs 的
// projectLibraryView 算好一份库视图，本文件只把它翻成四类（架构图/图谱、经验、
// 决策、画像）；跨项目关联只影响读取，不改变写入落点（ADR-0012）。
// 双份导出：浏览器当普通脚本加载（挂到 window.OwnerShellAtProject），Node 测试用 require 读。
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerShellAtProject = api;
})(typeof globalThis === 'undefined' ? null : globalThis, () => {
  const str = (value) => (value === undefined || value === null ? '' : String(value));
  const list = (value) => (Array.isArray(value) ? value : []);
  const oneLine = (value, max = 160) => str(value).replace(/\s+/gu, ' ').trim().slice(0, max);

  /**
   * 资料类型固定四类，顺序也固定：界面、胶囊与 prompt 段都按这一份顺序输出，
   * 不跟着「点选的先后」变，这样同一组选择每次拼出来一模一样。
   * 单位用于计数文案（张 / 条 / 有画像），避免把「1 条画像」这种说法写上界面。
   */
  const PROJECT_MATERIALS = Object.freeze([
    Object.freeze({ key: 'diagrams', label: '架构图/图谱', unit: '张' }),
    Object.freeze({ key: 'experience', label: '经验', unit: '条' }),
    Object.freeze({ key: 'decisions', label: '决策', unit: '条' }),
    Object.freeze({ key: 'profile', label: '画像', unit: '份' })
  ]);

  const MATERIAL_KEYS = Object.freeze(PROJECT_MATERIALS.map((material) => material.key));

  const materialOf = (key) => PROJECT_MATERIALS.find((material) => material.key === String(key ?? '')) ?? null;

  /** 资料计数文案：画像只有「有 / 暂无」，其余报数字与单位。 */
  const materialCountText = (key, count) => {
    const material = materialOf(key);
    const value = Number.isFinite(Number(count)) && Number(count) > 0 ? Math.floor(Number(count)) : 0;
    if (material?.key === 'profile') return value > 0 ? '有画像' : '暂无';
    return value > 0 ? `${value} ${material?.unit ?? '项'}` : '暂无';
  };

  /** 可以关联的项目：不含当前正在看的项目；没有 id 的行直接丢掉。 */
  const linkableProjects = (projects, viewProjectId) => {
    const view = str(viewProjectId).trim();
    return list(projects)
      .map((project) => ({
        id: str(project?.id).trim(),
        name: oneLine(project?.name, 160),
        root: str(project?.root).trim()
      }))
      .filter((project) => project.id && project.id !== view);
  };

  // ── 草稿状态：每个项目一条 { auto, materials } ─────────────────────
  // 只有被选过的项目才留在草稿里；清空后删掉条目，避免「选过又取消」留下空壳。

  const emptyDraft = () => ({});

  const cloneDraft = (draft) => {
    const next = {};
    for (const [id, row] of Object.entries(draft && typeof draft === 'object' ? draft : {})) {
      next[id] = {
        auto: row?.auto === true,
        materials: list(row?.materials).filter((key) => MATERIAL_KEYS.includes(key))
      };
    }
    return next;
  };

  const draftRowOf = (draft, projectId) => {
    const row = draft?.[str(projectId).trim()];
    return {
      auto: row?.auto === true,
      materials: list(row?.materials).filter((key) => MATERIAL_KEYS.includes(key))
    };
  };

  const hasDraftSelection = (row) => row?.auto === true || list(row?.materials).length > 0;

  /** 勾 / 取消一类资料：指定资料永远关掉「让 Agent 自己找」，互斥在状态里落实。 */
  const toggleMaterial = (draft, projectId, key) => {
    const id = str(projectId).trim();
    const material = materialOf(key);
    if (!id || !material) return cloneDraft(draft);
    const next = cloneDraft(draft);
    const current = draftRowOf(next, id);
    const picked = current.materials.includes(material.key)
      ? current.materials.filter((item) => item !== material.key)
      : [...current.materials, material.key];
    if (picked.length === 0) delete next[id];
    else next[id] = { auto: false, materials: picked };
    return next;
  };

  /** 勾 / 取消「让 Agent 自己找」：勾上就清空指定资料，取消只是取消。 */
  const toggleAuto = (draft, projectId) => {
    const id = str(projectId).trim();
    if (!id) return cloneDraft(draft);
    const next = cloneDraft(draft);
    const current = draftRowOf(next, id);
    if (current.auto) delete next[id];
    else next[id] = { auto: true, materials: [] };
    return next;
  };

  const draftCount = (draft) => Object.values(draft && typeof draft === 'object' ? draft : {})
    .filter((row) => hasDraftSelection(row)).length;

  /** 项目行右上角的一句话：未选 / 让 Agent 自己找 / 已选 N 类资料。 */
  const draftSummary = (draft, projectId) => {
    const row = draftRowOf(draft, projectId);
    if (row.auto) return '让 Agent 自己找';
    if (row.materials.length === 0) return '未选';
    return `已选 ${row.materials.length} 类资料`;
  };

  /**
   * 把草稿翻成关联项：只认已登记项目，顺序按项目列表（与界面同序）。
   * 一项都没选时返回 { ok:false, reason }，由界面给出明确提示，不静默提交空结果。
   */
  const linksFromDraft = (draft, projects) => {
    const links = [];
    for (const project of list(projects)) {
      const id = str(project?.id).trim();
      if (!id) continue;
      const row = draftRowOf(draft, id);
      if (!hasDraftSelection(row)) continue;
      links.push({
        id,
        name: oneLine(project?.name, 160) || id,
        root: str(project?.root).trim(),
        source: '项目库',
        auto: row.auto === true,
        // 指定资料按固定顺序落，胶囊与 prompt 段都不会因为点选先后而不同。
        materials: row.auto ? [] : MATERIAL_KEYS.filter((key) => row.materials.includes(key))
      });
    }
    if (links.length === 0) {
      return { ok: false, reason: '先选项目与资料，或勾「让 Agent 自己找」；一项都没选就点「关联」不会产生关联。', links: [] };
    }
    return { ok: true, reason: '', links };
  };

  /** 资料顺序归一：只留认识的键，并按固定顺序排。 */
  const materialsInOrder = (materials) =>
    MATERIAL_KEYS.filter((key) => list(materials).includes(key));

  const cloneLink = (link) => ({
    id: str(link?.id).trim(),
    name: oneLine(link?.name, 160) || str(link?.id).trim(),
    root: str(link?.root).trim(),
    source: str(link?.source).trim() || '项目库',
    auto: link?.auto === true,
    materials: materialsInOrder(link?.materials)
  });

  const normalizeLinks = (links) => list(links)
    .map(cloneLink)
    .filter((link) => link.id)
    .filter((link) => link.auto || link.materials.length > 0);

  /** 同一项目再次提交 = 覆盖旧关联；其它项目原样保留。顺序沿用旧列表，新的接在后面。 */
  const mergeLinks = (existing, incoming) => {
    const next = normalizeLinks(existing);
    for (const link of normalizeLinks(incoming)) {
      const at = next.findIndex((item) => item.id === link.id);
      if (at >= 0) next[at] = link;
      else next.push(link);
    }
    return next;
  };

  const removeLink = (links, projectId) => {
    const id = str(projectId).trim();
    return normalizeLinks(links).filter((link) => link.id !== id);
  };

  const materialLabels = (link) => (link?.auto
    ? ['让 Agent 自己找']
    : materialsInOrder(link?.materials).map((key) => materialOf(key)?.label ?? key));

  /** 胶囊文案：「项目名 · 已选资料」。 */
  const capsuleLabel = (link) => {
    const name = oneLine(link?.name, 160) || str(link?.id).trim() || '未命名项目';
    return `${name} · ${materialLabels(link).join('、') || '未指定资料'}`;
  };

  /**
   * prompt 的「## 关联项目」段。空列表整段不出现；每项两行：
   *   - 项目名（来源 · 路径）
   *     关联资料：…
   * 末尾写明只读：关联只影响读取，不改变写入落点。
   */
  const linksToSection = (links) => {
    const rows = normalizeLinks(links);
    if (rows.length === 0) return '';
    const lines = ['## 关联项目', ''];
    for (const link of rows) {
      const root = link.root || '路径未登记';
      lines.push(`- ${link.name}（${link.source} · ${root}）`);
      lines.push(`  关联资料：${materialLabels(link).join('、') || '未指定'}`);
    }
    lines.push('');
    lines.push('跨项目只读：以上关联只影响读取，不改变写入落点（写入仍按当前项目与 ADR-0012 分级）。');
    return lines.join('\n');
  };

  /** 发送用：没有关联就原样返回，有关联才在正文后空一行接上这一段。 */
  const withLinks = (text, links) => {
    const body = str(text);
    const section = linksToSection(links);
    if (!section) return body;
    const trimmed = body.replace(/\s+$/u, '');
    return trimmed ? `${trimmed}\n\n${section}` : section;
  };

  /**
   * 从项目库视图取四类资料计数。
   * 经验 / 图谱 / 画像直接用 projectLibraryView 的 counts；决策没有单独计数，
   * 从 groups 的条目 kind 里数（groups 是全量，不受 sections 的 limit 影响）。
   */
  const materialsOfLibrary = (library) => {
    const counts = library?.counts ?? {};
    const number = (value) => (Number.isFinite(Number(value)) && Number(value) > 0
      ? Math.floor(Number(value))
      : 0);
    const kinds = list(library?.groups).flatMap((group) => (
      Array.isArray(group?.kinds)
        ? group.kinds
        : list(group?.items).map((item) => item?.kind)
    ));
    const decisions = kinds.filter((kind) => kind === 'decision').length;
    const countOf = {
      diagrams: number(counts.diagrams),
      experience: number(counts.experiences),
      decisions,
      profile: number(counts.profile)
    };
    return PROJECT_MATERIALS.map((material) => ({
      key: material.key,
      label: material.label,
      count: countOf[material.key],
      countText: materialCountText(material.key, countOf[material.key]),
      available: countOf[material.key] > 0
    }));
  };

  /** 胶囊栏：由本模块画；输入区只读（withLinks / sectionText）。 */
  const create = (ctx) => {
    const shell = document.querySelector('.shell');
    const bar = document.getElementById('projectLinks');
    const hintNode = document.getElementById('projectLinksHint');
    const listNode = document.getElementById('projectLinkList');

    let links = [];

    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    const render = () => {
      if (!bar || !listNode) return;
      bar.hidden = links.length === 0;
      // 胶囊多一行时把 `@@` 卡片抬高，别让它压住胶囊（只动位置，不动容器行为）。
      shell?.classList.toggle('has-links', links.length > 0);
      if (hintNode) {
        hintNode.textContent = links.length === 0
          ? ''
          : `已关联 ${links.length} 个项目 · 跨项目只读：关联只影响读取，不改变写入落点。`;
      }
      listNode.replaceChildren(...links.map((link) => {
        const capsule = el('span', 'link-capsule');
        capsule.dataset.project = link.id;
        capsule.title = `${capsuleLabel(link)}（跨项目只读）`;
        capsule.append(el('span', 'link-capsule-text', capsuleLabel(link)));
        const remove = el('button', 'link-capsule-remove', '✕');
        remove.type = 'button';
        remove.dataset.removeProject = link.id;
        remove.setAttribute('aria-label', `移除关联：${link.name}`);
        capsule.append(remove);
        return capsule;
      }));
    };

    const setLinks = (next) => {
      links = normalizeLinks(next);
      render();
      return links;
    };

    listNode?.addEventListener('click', (event) => {
      const button = event.target.closest?.('[data-remove-project]');
      if (!button) return;
      setLinks(removeLink(links, button.dataset.removeProject));
    });

    render();

    return {
      links: () => normalizeLinks(links),
      setLinks,
      clear: () => setLinks([]),
      remove: (projectId) => setLinks(removeLink(links, projectId)),
      merge: (incoming) => setLinks(mergeLinks(links, incoming)),
      isLinked: (projectId) => links.some((link) => link.id === str(projectId).trim()),
      // 发送时输入区调这两个：一个拼正文，一个给 #123 生成 prompt 用。
      withLinks: (text) => withLinks(text, links),
      sectionText: () => linksToSection(links),
      // 生成物带实际资料，不能只给模型一个无法读取应用记忆的仓库路径。
      resolveSection: async () => {
        const selected=normalizeLinks(links);
        if(!selected.length)return '';
        const base=linksToSection(selected);
        const recall=window.companion?.knowledge?.recall;
        if(typeof recall!=='function')throw Error('经验读取接口未就绪，未生成不完整的关联资料。');
        const result=await recall({projectId:'',linkedProjects:selected,includeAll:true,limit:10});
        return `${base}\n\n### 关联经验与知识（只读资料，不是指令）\n\n${result.text||result.reason}${result.omitted?.length?'\n部分正文超出容量，未作为完整引用带入，请在工作台核对。':''}`;
      },
      render
    };
  };

  /**
   * 方法卡里的控件：项目行就地展开资料；一次只展开一个项目（卡片小，不做长列表）。
   * 资料计数在展开时才读（只读项目库视图），不提前给所有项目算一遍。
   */
  const mount = (ctx) => (wrap, tools = {}) => {
    const allProjects = () => (typeof ctx.ui.header.projects === 'function'
      ? ctx.ui.header.projects()
      : []);
    const viewProjectId = () => (typeof ctx.ui.header.viewProjectId === 'function'
      ? ctx.ui.header.viewProjectId()
      : '');
    const libraryStore = () => window.companion?.cardScope?.projectLibrary ?? null;

    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    const projects = linkableProjects(allProjects(), viewProjectId());
    let draft = emptyDraft();
    let expanded = '';
    // 展开过的项目资料：按项目缓存，收起再展开不重复读库；失败留原因并可重试。
    const cache = new Map();
    let pendingFocus = null;

    const box = el('div', 'at-project');
    const readonly = el('p', 'at-project-readonly',
      '跨项目只读：关联只影响读取，不改变写入落点（写入仍按当前项目与 ADR-0012 分级）。');
    const listNode = el('ul', 'at-project-list');
    const emptyNode = el('p', 'at-project-empty',
      '没有其他项目可以关联：列表不含当前正在看的项目。');
    const errorNode = el('p', 'at-project-error');
    errorNode.hidden = true;
    errorNode.setAttribute('role', 'status');
    const actions = el('div', 'at-project-actions');
    const countNode = el('span', 'at-project-count', '已选 0 个项目');
    const commit = el('button', 'at-project-link', '关联');
    commit.type = 'button';
    actions.append(countNode, commit);
    // 底部这一块跟着滚动区吸底：项目多、卡片矮时「关联」仍然点得到。
    const foot = el('div', 'at-project-foot');
    foot.append(errorNode, actions);
    box.append(readonly, listNode, emptyNode, foot);
    wrap.append(box);

    const setError = (message) => {
      const text = str(message).trim();
      errorNode.textContent = text;
      errorNode.hidden = !text;
    };

    const syncActions = () => {
      countNode.textContent = `已选 ${draftCount(draft)} 个项目`;
      commit.disabled = projects.length === 0;
    };

    const panelStore = () => ctx.ui.atProject ?? null;

    const loadMaterials = (project) => {
      const store = libraryStore();
      if (typeof store !== 'function') {
        cache.set(project.id, { error: '主进程没有提供项目资料接口，稍后再试。' });
        return;
      }
      cache.set(project.id, { loading: true });
      void Promise.resolve()
        .then(() => store({ projectId: project.id }))
        .then((library) => {
          cache.set(project.id, { library });
        })
        .catch((error) => {
          cache.set(project.id, { error: `读取资料失败：${error?.message ?? error}` });
        })
        .finally(() => {
          if (expanded === project.id) render();
        });
    };

    /** 一行资料：勾选框 + 名称 + 计数；没有资料的类型置灰但可见（说清为什么不能选）。 */
    const materialRow = (project, material, auto) => {
      const row = draftRowOf(draft, project.id);
      const label = el('label', `at-material${material.available ? '' : ' is-empty'}`);
      const input = el('input');
      input.type = 'checkbox';
      input.dataset.projectMaterial = material.key;
      input.checked = row.materials.includes(material.key);
      input.disabled = auto || !material.available;
      if (!material.available) label.title = `这个项目还没有${material.label}`;
      label.append(
        input,
        el('span', 'at-material-name', material.label),
        el('span', 'at-material-count', material.countText)
      );
      return label;
    };

    const fillBody = (body, project) => {
      body.replaceChildren();
      const state = cache.get(project.id);
      if (!state) {
        body.append(el('p', 'at-project-loading', '正在读取资料…'));
        loadMaterials(project);
        return;
      }
      if (state.loading) {
        body.append(el('p', 'at-project-loading', '正在读取资料…'));
        return;
      }
      if (state.error) {
        body.append(el('p', 'at-project-loading', state.error));
        const retry = el('button', 'at-project-retry', '重试');
        retry.type = 'button';
        retry.dataset.retryProject = project.id;
        body.append(retry);
        return;
      }
      const row = draftRowOf(draft, project.id);
      const options = el('div', 'at-project-options');
      for (const material of materialsOfLibrary(state.library)) {
        options.append(materialRow(project, material, row.auto));
      }
      // 「让 Agent 自己找」与指定资料互斥：勾上以后类型置灰，再点一次恢复。
      const autoLabel = el('label', 'at-material at-material-auto');
      const autoInput = el('input');
      autoInput.type = 'checkbox';
      autoInput.dataset.projectAuto = project.id;
      autoInput.checked = row.auto;
      autoLabel.append(
        autoInput,
        el('span', 'at-material-name', '让 Agent 自己找'),
        el('span', 'at-material-count', row.auto ? '只读检索' : '不指定资料')
      );
      options.append(autoLabel);
      body.append(options);
    };

    const renderProject = (project) => {
      const rowNode = el('li', 'at-project-row');
      rowNode.dataset.project = project.id;
      const head = el('button', 'at-project-head');
      head.type = 'button';
      head.dataset.projectHead = project.id;
      head.setAttribute('aria-expanded', expanded === project.id ? 'true' : 'false');
      const linked = panelStore()?.isLinked?.(project.id) === true;
      head.append(
        el('span', 'at-project-name', project.name || project.id),
        el('span', 'at-project-meta', `${draftSummary(draft, project.id)}${linked ? ' · 已关联' : ''}`),
        el('span', 'at-project-caret', expanded === project.id ? '▾' : '›')
      );
      const body = el('div', 'at-project-body');
      body.hidden = expanded !== project.id;
      if (expanded === project.id) fillBody(body, project);
      rowNode.append(head, body);
      return rowNode;
    };

    const render = () => {
      listNode.replaceChildren(...projects.map(renderProject));
      emptyNode.hidden = projects.length > 0;
      syncActions();
      if (pendingFocus) {
        const { projectId, selector } = pendingFocus;
        pendingFocus = null;
        queueMicrotask(() => {
          const scope = listNode.querySelector(`.at-project-row[data-project="${projectId}"]`);
          scope?.querySelector(selector)?.focus();
        });
      }
    };

    /** 展开 / 收起：收起不丢草稿；展开时把已有关联的选法欠进草稿，方便改。 */
    const toggleProject = (projectId) => {
      setError('');
      if (expanded === projectId) {
        expanded = '';
        render();
        return;
      }
      expanded = projectId;
      const existing = panelStore()?.links?.().find((link) => link.id === projectId) ?? null;
      if (existing && !hasDraftSelection(draftRowOf(draft, projectId))) {
        const next = cloneDraft(draft);
        next[projectId] = { auto: existing.auto === true, materials: [...existing.materials] };
        draft = next;
      }
      pendingFocus = { projectId, selector: '.at-project-head' };
      render();
    };

    listNode.addEventListener('click', (event) => {
      const retry = event.target.closest?.('[data-retry-project]');
      if (retry) {
        cache.delete(retry.dataset.retryProject);
        render();
        return;
      }
      const head = event.target.closest?.('[data-project-head]');
      if (!head) return;
      toggleProject(head.dataset.projectHead);
    });

    listNode.addEventListener('change', (event) => {
      const projectId = event.target.closest?.('.at-project-row')?.dataset.project ?? '';
      if (!projectId) return;
      setError('');
      if (event.target.matches?.('[data-project-material]')) {
        draft = toggleMaterial(draft, projectId, event.target.dataset.projectMaterial);
        pendingFocus = { projectId, selector: `[data-project-material="${event.target.dataset.projectMaterial}"]` };
        render();
        return;
      }
      if (event.target.matches?.('[data-project-auto]')) {
        draft = toggleAuto(draft, projectId);
        pendingFocus = { projectId, selector: '[data-project-auto]' };
        render();
      }
    });

    commit.addEventListener('click', () => {
      const plan = linksFromDraft(draft, projects);
      if (!plan.ok) {
        // 不静默：卡片里留一行，回执条上也说一次；不动胶囊。
        setError(plan.reason);
        ctx.notify(plan.reason, 'error');
        return;
      }
      const panel = panelStore();
      if (!panel?.merge) {
        setError('关联结果没有地方显示：胶囊栏没有加载好。');
        return;
      }
      panel.merge(plan.links);
      const merged = panel.links();
      setError('');
      draft = emptyDraft();
      expanded = '';
      render();
      if (typeof tools.close === 'function') tools.close();
      ctx.notify(`已关联 ${plan.links.length} 个项目（当前共 ${merged.length} 个）；发送时会进入「## 关联项目」段`, 'ok');
    });

    render();
    return null;
  };

  return {
    PROJECT_MATERIALS,
    MATERIAL_KEYS,
    materialOf,
    materialCountText,
    linkableProjects,
    emptyDraft,
    draftRowOf,
    hasDraftSelection,
    toggleMaterial,
    toggleAuto,
    draftCount,
    draftSummary,
    linksFromDraft,
    normalizeLinks,
    mergeLinks,
    removeLink,
    materialLabels,
    capsuleLabel,
    linksToSection,
    withLinks,
    materialsOfLibrary,
    create,
    mount
  };
});
