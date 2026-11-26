// #109 生成式 UI 块的渲染层：把 shell-blocks 规范化后的模型变成可插入对话流的节点。
//
// 边界：这里只画，不判定数据合不合法（模型层已经处理），不绑事件
// （点击由 shell.js 统一代理），不读状态、不发请求。
// 于是块内按钮只能声明「选了什么」——真正的行为只有 shell.js 那一处。
(() => {
  const api = window.OwnerShellBlocks;
  if (!api) throw new Error('shell-blocks.cjs 未加载');

  const SVG_NS = 'http://www.w3.org/2000/svg';
  // 环形图的分段颜色：只从这四个令牌里取，深色模式由 CSS 变量一起换。
  const CHART_TONES = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'];
  const TONE_GLYPH = { ok: '✓', warn: '!', error: '×', pending: '·' };

  const join = (...names) => names.filter(Boolean).join(' ');

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const svgEl = (tag, attrs = {}) => {
    const node = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
    return node;
  };

  /** 每个块的外壳：类型同时写进 class 与 data-block，验收按 data-block 找块。 */
  const blockNode = (model) => {
    // 外层只挂 type-* ：块内各部件（table/code/kv…）自己用 block-* 类名，
    // 两层不能同名，否则「块容器」和「块内容」会被同一个选择器一起选中。
    const node = el('section', `block type-${model.type}`);
    node.dataset.block = model.type;
    node.dataset.blockIndex = String(model.index ?? 0);
    // #110 悬停复制：按钮只声明「复制这个块」，点击与写剪贴板都由 shell.js 代理。
    // 它跟着模型走，所以复制的是画这个块用的同一份结构，不是另抓一次 DOM。
    // 文案放在 CSS 伪元素里，块自身的 textContent 不被按钮污染（#109 按文本断言）。
    const copy = el('button', 'copy-affordance block-copy');
    copy.type = 'button';
    copy.dataset.copyBlock = '1';
    copy.setAttribute('aria-label', '复制这个块为 Markdown');
    node.append(copy);
    return node;
  };

  const headNode = (title, badge, badgeClass) => {
    const head = el('div', 'block-head');
    head.append(el('h4', '', title || '未命名块'));
    if (badge) head.append(el('span', join('block-badge', badgeClass), badge));
    return head;
  };

  const tagNode = (tag) => el('span', join('tag', tag.tone), tag.text);

  const renderCard = (model) => {
    const node = blockNode(model);
    if (model.title || model.badge) node.append(headNode(model.title, model.badge));
    if (model.sub) node.append(el('p', 'block-sub', model.sub));
    if (model.sections.length === 0) node.append(el('p', 'block-note', '这个卡片没有分组。'));
    const sections = el('div', 'block-sections');
    model.sections.forEach((section) => {
      const box = el('div', 'block-section');
      const sectionHead = el('div', 'block-section-head');
      sectionHead.append(el('b', '', section.label || '未命名分组'));
      if (section.count) sectionHead.append(el('span', '', section.count));
      box.append(sectionHead);
      if (section.items.length === 0) {
        box.append(el('div', 'block-row-empty', section.empty || '这里还没有条目。'));
      }
      section.items.forEach((item) => {
        const row = el('div', 'block-row');
        const main = el('div', 'block-row-main');
        main.append(el('div', 'block-row-title', item.title));
        if (item.tags.length > 0) {
          const meta = el('div', 'block-row-meta');
          item.tags.forEach((tag) => meta.append(tagNode(tag)));
          main.append(meta);
        }
        row.append(main);
        box.append(row);
      });
      sections.append(box);
    });
    node.append(sections);
    if (model.foot?.note) node.append(el('div', 'block-foot', model.foot.note));
    return node;
  };

  const renderTable = (model) => {
    const node = blockNode(model);
    if (model.title) node.append(headNode(model.title, `${model.rows.length} 行`));
    if (model.head.length === 0 && model.rows.length === 0) {
      node.append(el('p', 'block-note', '这个表格没有数据。'));
      return node;
    }
    // 宽表格在块内横向滚动：长内容不把整条对话流撑宽。
    const wrap = el('div', 'block-table-wrap');
    const table = el('table', 'block-table');
    if (model.head.length > 0) {
      const thead = el('thead');
      const row = el('tr');
      model.head.forEach((cell) => row.append(el('th', '', cell)));
      thead.append(row);
      table.append(thead);
    }
    const tbody = el('tbody');
    model.rows.forEach((cells) => {
      const row = el('tr');
      cells.forEach((cell) => row.append(el('td', '', cell)));
      tbody.append(row);
    });
    table.append(tbody);
    wrap.append(table);
    node.append(wrap);
    return node;
  };

  const renderKpi = (model) => {
    const node = blockNode(model);
    if (model.title) node.append(headNode(model.title));
    if (model.items.length === 0) {
      node.append(el('p', 'block-note', '还没有可看的指标。'));
      return node;
    }
    const grid = el('div', 'block-kpis');
    model.items.forEach((item) => {
      const box = el('div', 'kpi');
      box.append(el('div', 'kpi-label', item.label));
      const value = el('div', 'kpi-value', item.value);
      if (item.unit) value.append(el('span', 'kpi-unit', item.unit));
      box.append(value);
      const delta = el('div', join('kpi-delta', item.direction));
      if (item.direction === 'up') delta.append(el('span', 'kpi-arrow', '↑'));
      if (item.direction === 'down') delta.append(el('span', 'kpi-arrow', '↓'));
      delta.append(el('span', '', item.deltaText || '—'));
      box.append(delta);
      grid.append(box);
    });
    node.append(grid);
    return node;
  };

  const renderLine = (model) => {
    const node = blockNode(model);
    if (model.title) node.append(headNode(model.title, `${model.points.length} 点`));
    const wrap = el('div', 'block-chart');
    const geometry = api.lineGeometry(model.points);
    if (!geometry.ok) {
      // 点不够也把数据念出来：图表退化，数据不能跟着消失。
      const values = model.points.map((value) => `${value}${model.unit}`).join('、');
      wrap.append(el('p', 'block-note', `${geometry.reason}。数据点：${values || '无'}`));
      node.append(wrap);
      return node;
    }
    const chart = svgEl('svg', {
      class: 'line-chart', viewBox: '0 0 100 34', preserveAspectRatio: 'none', role: 'img'
    });
    chart.dataset.points = geometry.values.join(',');
    chart.dataset.unit = model.unit;
    chart.append(svgEl('line', { x1: '0', y1: '30', x2: '100', y2: '30', class: 'axis' }));
    chart.append(svgEl('polyline', {
      points: geometry.coords.map((point) => `${point.x},${point.y}`).join(' '),
      class: 'series'
    }));
    geometry.coords.forEach((point) => chart.append(svgEl('circle', {
      cx: String(point.x), cy: String(point.y), r: '0.9', class: 'dot'
    })));
    const foot = el('div', 'chart-foot');
    model.labels.forEach((label) => foot.append(el('span', '', label)));
    foot.append(el('span', 'chart-last', `末值 ${geometry.last}${model.unit}`));
    wrap.append(chart, foot);
    node.append(wrap);
    return node;
  };

  const renderDonut = (model) => {
    const node = blockNode(model);
    if (model.title) node.append(headNode(model.title));
    const geometry = api.donutGeometry(model.items);
    if (!geometry.ok) {
      const values = model.items.map((item) => `${item.label} ${item.value}`).join('、');
      node.append(el('p', 'block-note', `${geometry.reason}。分项：${values || '无'}`));
      return node;
    }
    const wrap = el('div', 'donut-wrap');
    const chart = svgEl('svg', { class: 'donut', viewBox: '0 0 42 42', role: 'img' });
    geometry.arcs.forEach((arc) => {
      const circle = svgEl('circle', {
        cx: '21', cy: '21', r: '15.9', fill: 'none', 'stroke-width': '6', pathLength: '100',
        'stroke-dasharray': arc.dasharray, 'stroke-dashoffset': arc.dashoffset,
        transform: 'rotate(-90 21 21)'
      });
      circle.style.stroke = CHART_TONES[arc.tone];
      chart.append(circle);
    });
    const total = svgEl('text', {
      x: '21', y: '22.5', 'text-anchor': 'middle', class: 'donut-total'
    });
    total.textContent = String(geometry.total);
    chart.append(total);
    const legend = el('ul', 'donut-legend');
    geometry.arcs.forEach((arc) => {
      const item = el('li');
      const swatch = el('i');
      swatch.style.background = CHART_TONES[arc.tone];
      item.append(swatch, el('span', '', arc.label || '未命名'), el('b', '', String(arc.value)));
      legend.append(item);
    });
    wrap.append(chart, legend);
    node.append(wrap);
    return node;
  };

  const renderTimeline = (model) => {
    const node = blockNode(model);
    if (model.title) node.append(headNode(model.title));
    if (model.steps.length === 0) {
      node.append(el('p', 'block-note', '这条时间线还没有步骤。'));
      return node;
    }
    const flow = el('ol', 'block-timeline');
    model.steps.forEach((step) => {
      const item = el('li', join('step', step.tone));
      item.append(el('span', 'step-dot', TONE_GLYPH[step.tone] ?? '·'));
      const body = el('div', 'step-body');
      body.append(el('div', 'step-title', step.title));
      if (step.meta) body.append(el('div', 'step-meta', step.meta));
      item.append(body);
      if (step.at) item.append(el('span', 'step-at', step.at));
      flow.append(item);
    });
    node.append(flow);
    return node;
  };

  const renderKv = (model) => {
    const node = blockNode(model);
    // #137 灵感回执上的动作要找回那条灵感：id 挂在块节点上，点击时直接读。
    if (model.ideaId) node.dataset.ideaId = model.ideaId;
    if (model.title) node.append(headNode(model.title));
    if (model.rows.length === 0) {
      node.append(el('p', 'block-note', '这里没有要列出的字段。'));
      return node;
    }
    const rows = el('dl', 'block-kv');
    model.rows.forEach((row) => {
      const item = el('div');
      item.append(el('dt', '', row.key), el('dd', '', row.value));
      rows.append(item);
    });
    node.append(rows);

    // 点过动作就收起按钮，只留记录：与提问块、确认卡同一套口径。
    if (model.answered) {
      node.append(el('p', 'review-answered', `已选择：${model.answered}`));
      return node;
    }
    if (!model.actions?.length) return node;
    // 复用审核卡的按钮样式；动作仍只声明「点了什么」，行为在对话流的点击代理里。
    const actions = el('div', 'review-actions kv-actions');
    for (const action of model.actions) {
      const button = el('button', 'review-action', action.label);
      button.type = 'button';
      button.dataset.receiptAction = action.id;
      actions.append(button);
    }
    node.append(actions);
    return node;
  };

  const renderCode = (model) => {
    const node = blockNode(model);
    if (model.title || model.lang) node.append(headNode(model.title, model.lang));
    if (model.lines.length === 0) {
      node.append(el('p', 'block-note', '这个代码块是空的。'));
      return node;
    }
    // 行号与代码分两列；长行在 pre 内横向滚动，不外溢到对话流。
    const pre = el('pre', 'block-code');
    model.lines.forEach((line, index) => {
      const row = el('div', 'cl');
      row.append(el('span', 'ln', String(index + 1)), el('span', 'lc', line));
      pre.append(row);
    });
    node.append(pre);
    return node;
  };

  const renderDiff = (model) => {
    const node = blockNode(model);
    if (model.title) node.append(headNode(model.title));
    if (model.rows.length === 0) {
      node.append(el('p', 'block-note', '这个 diff 没有行。'));
      return node;
    }
    const diff = el('div', 'block-diff');
    model.rows.forEach((row) => {
      const item = el('div', join('d-row', row.kind));
      const marker = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' ';
      item.append(el('span', 'm', marker), el('span', 't', row.text));
      diff.append(item);
    });
    node.append(diff);
    return node;
  };

  const renderTool = (model) => {
    const node = blockNode(model);
    const details = el('details', 'block-tool');
    const summary = el('summary');
    const call = el('span', 'k', `${model.name}(${model.arg})`);
    summary.append(el('span', 'call-label', '调用'), call);
    summary.append(el('span', 'hint', model.status || '点开看结果'));
    details.append(summary);
    if (model.output) details.append(el('pre', '', model.output));
    else details.append(el('p', 'block-note', '这次调用没有输出。'));
    node.append(details);
    return node;
  };

  const renderBadges = (model) => {
    const node = blockNode(model);
    if (model.title) node.append(headNode(model.title));
    if (model.items.length === 0) {
      node.append(el('p', 'block-note', '这里还没有状态。'));
      return node;
    }
    const wall = el('div', 'block-badges');
    model.items.forEach((item) => {
      const tag = el('span', join('tag', item.tone));
      tag.append(el('span', 'tag-glyph', TONE_GLYPH[item.tone] ?? '·'), el('span', '', item.text));
      wall.append(tag);
    });
    node.append(wall);
    return node;
  };

  const renderAsk = (model) => {
    const node = blockNode(model);
    node.dataset.askQuestion = model.question;
    node.append(headNode(model.question, model.answered ? '已记录' : '待你确认', 'block-badge-ask'));
    if (model.why) node.append(el('p', 'block-sub', model.why));
    if (model.tried.length > 0) {
      node.append(el('p', 'block-sub', '已经试过：'));
      const tried = el('ul', 'ask-tried');
      model.tried.forEach((item) => tried.append(el('li', '', item)));
      node.append(tried);
    }
    // 已经回答过的提问块只留记录：按钮收起，重新渲染也不会再冒出来。
    if (model.answered) {
      node.append(el('p', 'ask-answered', `已记录：${model.answered}`));
      return node;
    }
    const options = el('div', 'ask-options');
    model.options.forEach((option) => {
      const button = el('button', 'ask-option', option);
      button.type = 'button';
      button.dataset.askChoice = option;
      options.append(button);
    });
    const skip = el('button', 'ask-option ask-skip', model.skip.label);
    skip.type = 'button';
    skip.dataset.askSkip = '1';
    options.append(skip);
    node.append(options);
    if (model.options.length === 0) {
      node.append(el('p', 'block-note', '这个问题没有预设选项，直接写你的答案就行。'));
    }
    const free = el('div', 'ask-free');
    const field = el('input', 'ask-free-input');
    field.type = 'text';
    field.placeholder = model.free.placeholder;
    field.setAttribute('aria-label', model.free.label);
    field.dataset.askFree = '1';
    const submit = el('button', 'ask-option', '回答');
    submit.type = 'button';
    submit.dataset.askFreeSubmit = '1';
    free.append(field, submit);
    node.append(free);
    if (model.skip.note) node.append(el('p', 'block-note', model.skip.note));
    return node;
  };

  /**
   * 写入确认卡（#113）：标题 + 等级徽章 → 一句话结论 → 三轴 → 逐条完整路径
   * → 可折叠判据 → 四个动作。
   *
   * 只画模型，不判定风险：降级、改判、动作可用性都由 risk-card.cjs 算好。
   * 判据用原生 details，默认收起；点开是浏览器行为，不额外绑事件。
   */
  const renderRisk = (model) => {
    const node = blockNode(model);
    node.dataset.riskLevel = model.level;
    node.dataset.riskId = model.id;
    node.dataset.riskOverridden = model.overridden ? 'true' : 'false';

    const head = el('div', 'block-head');
    head.append(el('h4', '', model.title || '写入确认'));
    if (model.overridden) head.append(el('span', 'risk-change', '人工改判'));
    head.append(el('span', join('risk-badge', model.level), model.levelLabel));
    node.append(head);

    // 降级与抬档都要说明白：人看到的是「为什么不是我想要的等级」，不是只有一个红标。
    if (model.degraded && model.degradedReason) {
      node.append(el('p', 'risk-degraded', model.degradedReason));
    }
    if (model.escalated && model.escalationReason) {
      node.append(el('p', 'risk-escalated', model.escalationReason));
    }
    if (model.conclusion) node.append(el('p', 'risk-conclusion', model.conclusion));

    const axes = el('dl', 'risk-axes');
    model.axes.forEach((axis) => {
      const row = el('div', 'risk-axis');
      row.dataset.axis = axis.key;
      row.append(el('dt', '', axis.label), el('dd', '', axis.valueLabel));
      axes.append(row);
    });
    node.append(axes);

    node.append(el('div', 'risk-section-title', '写入清单（逐条完整路径）'));
    if (model.paths.length === 0) {
      node.append(el('p', 'block-note', '这张卡没有列出写入路径。'));
    } else {
      const paths = el('ul', 'risk-paths');
      model.paths.forEach((path) => {
        const item = el('li', 'risk-path', path);
        item.dataset.path = path;
        paths.append(item);
      });
      node.append(paths);
    }

    // 判据默认收起：卡片第一眼只看结论与三轴，想知道「它是不是偷懒」再展开。
    const details = el('details', 'risk-basis');
    const summary = el('summary');
    summary.append(
      el('span', '', '评级依据'),
      el('span', 'risk-basis-count', `${model.basis.length} 条`)
    );
    details.append(summary);
    const basis = el('ul', 'risk-basis-list');
    model.basis.forEach((line) => basis.append(el('li', '', line)));
    details.append(basis);
    node.append(details);

    // 点过动作就收起按钮，只留记录：与提问块同一套「点过不再冒出来」的口径。
    if (model.answered) {
      node.append(el('p', 'risk-answered', `已选择：${model.answered}`));
      return node;
    }

    const actions = el('div', 'risk-actions');
    model.actions.forEach((action) => {
      const button = el('button', join('risk-action', `risk-${action.id}`), action.label);
      button.type = 'button';
      button.dataset.riskAction = action.id;
      button.disabled = action.enabled !== true;
      if (action.reason) button.title = action.reason;
      actions.append(button);
    });
    node.append(actions);

    // 「我的判断不同」不是立刻改判：先展开一个很小的表单，写清改到哪一档、为什么。
    const form = el('div', 'risk-override');
    form.hidden = true;
    form.dataset.riskOverrideForm = '1';
    const level = el('select', 'risk-override-level');
    level.dataset.riskOverrideLevel = '1';
    level.setAttribute('aria-label', '改判等级');
    [['low', '低风险'], ['medium', '中风险'], ['high', '高风险']].forEach(([value, label]) => {
      const option = el('option', '', label);
      option.value = value;
      level.append(option);
    });
    // 默认退向更宽的一档：高 → 低是「我看过了」，低 → 中是「我更谨慎」。
    level.value = model.level === 'low' ? 'medium' : 'low';
    const note = el('input', 'risk-override-note');
    note.type = 'text';
    note.maxLength = 120;
    note.placeholder = '写下你的判断（会进会话）';
    note.dataset.riskOverrideNote = '1';
    note.setAttribute('aria-label', '改判理由');
    const submit = el('button', 'risk-override-submit', '生成新卡');
    submit.type = 'button';
    submit.dataset.riskOverrideSubmit = '1';
    form.append(level, note, submit);
    node.append(form);
    return node;
  };

  /**
   * 外发 / 删除确认卡（#116）：标题 + 硬约束徽章 → 一句「发出即收不回 / 删除不可恢复」
   * → 逐条对象 → 硬约束说明 → 动作。
   *
   * 只画模型，不判定：外发恒两项动作、删除每项一个按钮，全部由 confirm-cards.cjs 算好；
   * 这里不提供，也不认识「以后不用问」或「批量删除」。
   */
  const renderConfirm = (model) => {
    const node = blockNode(model);
    node.dataset.confirmKind = model.kind;
    node.dataset.confirmId = model.id;

    const head = el('div', 'block-head');
    head.append(el('h4', '', model.title || '确认'));
    head.append(el('span', join('confirm-badge', `confirm-${model.kind}`), model.badge));
    node.append(head);
    if (model.sequence) node.append(el('p', 'confirm-sequence', model.sequence));

    if (model.headline) node.append(el('p', 'confirm-headline', model.headline));
    if (model.conclusion) node.append(el('p', 'confirm-conclusion', model.conclusion));

    if (model.target) {
      const target = el('dl', 'confirm-target');
      const row = el('div');
      row.append(el('dt', '', '目的地'), el('dd', '', model.target));
      target.append(row);
      node.append(target);
    }

    node.append(el(
      'div',
      'confirm-section-title',
      model.kind === 'delete' ? '将删除的对象（逐条完整路径）' : '将要发出的内容（逐条完整路径）'
    ));
    if (model.items.length === 0) {
      node.append(el('p', 'block-note', '这张卡没有列出对象。'));
    } else {
      const items = el('ul', 'confirm-items');
      model.items.forEach((item, index) => {
        const row = el('li', 'confirm-item');
        row.dataset.confirmItem = String(index);
        const main = el('div', 'confirm-item-main');
        main.append(el('span', 'confirm-item-label', item.label));
        if (item.path) main.append(el('code', 'confirm-item-path', item.path));
        if (item.note) main.append(el('span', 'confirm-item-note', item.note));
        row.append(main);
        // 删除卡：每一项自己的按钮。没有「全选 / 全部删除」，批量入口根本不存在。
        const perItem = model.actions.find(
          (action) => action.id === 'delete-item' && action.index === index
        );
        if (perItem && !model.answered) {
          const button = el('button', 'confirm-item-action', perItem.label);
          button.type = 'button';
          button.dataset.confirmAction = 'delete-item';
          button.dataset.confirmIndex = String(index);
          row.append(button);
        }
        items.append(row);
      });
      node.append(items);
    }

    if (model.notices.length > 0) {
      const notices = el('ul', 'confirm-notices');
      model.notices.forEach((line) => notices.append(el('li', 'confirm-notice', line)));
      node.append(notices);
    }

    // 点过动作就收起按钮，只留记录：与提问块、风险卡同一套口径。
    if (model.answered) {
      node.append(el('p', 'confirm-answered', `已选择：${model.answered}`));
      return node;
    }

    // 共用动作只剩「发出这一次 / 取消」；删除的逐项按钮已经在每一行里。
    const shared = model.actions.filter((action) => action.id !== 'delete-item');
    if (shared.length === 0) {
      node.append(el('p', 'block-note', '这张卡没有可点的动作。'));
      return node;
    }
    const actions = el('div', 'confirm-actions');
    shared.forEach((action) => {
      const classes = ['confirm-action'];
      if (action.primary) classes.push('primary');
      if (action.cancel) classes.push('cancel');
      const button = el('button', join(...classes), action.label);
      button.type = 'button';
      button.dataset.confirmAction = action.id;
      actions.append(button);
    });
    node.append(actions);
    return node;
  };

  /**
   * 分享回执（#126）：结果徽章 → 目标 / 会话 / 条数 / 结果 / 原因 / 时间 → 「重试」。
   *
   * 只画模型：能不能重试由 shell-blocks 按状态与草稿 id 算好。重试按钮只声明「用哪份草稿」，
   * 真正的行为（再出一张外发确认卡）在 shell-stream 的 retryShare 一处。
   */
  const renderShare = (model) => {
    const node = blockNode(model);
    node.dataset.shareStatus = model.status;
    node.dataset.shareDraft = model.draftId;

    const META = {
      sent: { label: '已分享', cls: 'share-ok', result: '已发出（飞书 code 0）' },
      failed: { label: '失败', cls: 'share-failed', result: '未发出' },
      cancelled: { label: '已取消', cls: 'share-cancelled', result: '未发出（0 处）' }
    };
    const meta = META[model.status] ?? META.failed;

    const head = el('div', 'block-head');
    head.append(el('h4', '', model.title || '分享回执'));
    head.append(el('span', join('share-badge', meta.cls), meta.label));
    node.append(head);

    const rows = el('dl', 'block-kv share-rows');
    const addRow = (key, value) => {
      if (!value) return;
      const item = el('div');
      item.append(el('dt', '', key), el('dd', '', value));
      rows.append(item);
    };
    addRow('目标', model.target);
    addRow('会话', model.session);
    addRow('条数', model.count > 0 ? `${model.count} 条` : '');
    addRow('结果', meta.result);
    addRow('原因', model.status === 'failed' ? model.detail : '');
    addRow('时间', model.at);
    node.append(rows);

    node.append(el(
      'p',
      'share-note',
      model.status === 'sent'
        ? '回执留在流里：会话、条数、结果都在，重发要重新勾选。'
        : '原文与选择都还留着；重试会重新过一次外发确认，不会自动发出。'
    ));

    // 点过动作就收起按钮，只留记录：与提问块、确认卡同一套口径。
    if (model.answered) {
      node.append(el('p', 'share-answered', `已选择：${model.answered}`));
      return node;
    }
    if (model.canRetry !== true) return node;

    const actions = el('div', 'share-actions');
    const retry = el('button', 'share-retry', '重试');
    retry.type = 'button';
    retry.dataset.shareRetry = model.draftId;
    actions.append(retry);
    node.append(actions);
    return node;
  };

  const renderUnknown = (model) => {
    const node = blockNode(model);
    node.append(el('p', 'block-note', model.text));
    return node;
  };

  /**
   * 经验 / 候选审核卡：标题 + 行 + 动作；点过的卡只留记录。
   * 动作的语义由调用方处理（提升为候选 / 接受 / 拒绝），这里只画。
   */
  const renderReview = (model) => {
    const node = blockNode(model);
    node.dataset.reviewKind = model.kind;
    if (model.lessonId) node.dataset.lessonId = model.lessonId;
    if (model.proposalId) node.dataset.proposalId = model.proposalId;

    const head = el('div', 'block-head');
    head.append(el('h4', '', model.title));
    head.append(el('span', `review-kind kind-${model.kind}`,
      model.kind === 'candidate' ? '待审核' : '经验'));
    node.append(head);

    if (model.rows.length) {
      const rows = el('dl', 'review-rows');
      for (const row of model.rows) {
        const item = el('div', 'review-row');
        item.append(el('dt', '', row[0]));
        item.append(el('dd', '', row.slice(1).join(' ')));
        rows.append(item);
      }
      node.append(rows);
    }

    if (model.answered) {
      node.append(el('p', 'review-answered', `已选择：${model.answered}`));
      return node;
    }

    const actions = el('div', 'review-actions');
    for (const action of model.actions) {
      const button = el('button', 'review-action', action.label);
      button.type = 'button';
      button.dataset.reviewAction = action.id;
      actions.append(button);
    }
    node.append(actions);
    if (model.note) node.append(el('p', 'block-note', model.note));
    return node;
  };

  const RENDERERS = {
    card: renderCard,
    table: renderTable,
    kpi: renderKpi,
    line: renderLine,
    donut: renderDonut,
    timeline: renderTimeline,
    kv: renderKv,
    code: renderCode,
    diff: renderDiff,
    tool: renderTool,
    badges: renderBadges,
    ask: renderAsk,
    review: renderReview,
    risk: renderRisk,
    confirm: renderConfirm,
    share: renderShare,
    unknown: renderUnknown
  };

  const renderBlock = (model) => (RENDERERS[model.type] ?? renderUnknown)(model);

  /**
   * 一条回复里的块：返回 DocumentFragment（没有块就是空片段）。
   * 文字气泡仍由 shell.js 画，这里只管块。
   */
  const renderReply = (message) => {
    const fragment = document.createDocumentFragment();
    const model = api.normalizeReply(message);
    if (model.blocks.length === 0) return fragment;
    const container = el('div', 'blocks');
    model.blocks.forEach((block) => container.append(renderBlock(block)));
    fragment.append(container);
    return fragment;
  };

  window.OwnerShellBlocksView = { renderReply, renderBlock };
})();
