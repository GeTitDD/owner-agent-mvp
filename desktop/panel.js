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
    $('stage').textContent = view?.stage ?? '正在读取状态…';
    $('workerLabel').textContent = view?.worker?.label ? `Worker · ${view.worker.label}` : 'Worker 空闲';
    const pending = view?.pending?.length ?? 0;
    $('pendingCount').textContent = `${pending} 项待决定`;
    $('pendingBadge').textContent = String(pending);
    $('pendingBadge').hidden = pending === 0;
    const hasProjects = (view?.projects?.length ?? 0) > 0;
    $('setup').hidden = hasProjects;
    $('composeSection').hidden = !hasProjects;
    $('submitTask').disabled = !hasProjects;
    if (!hasProjects) renderServiceGrid($('setupServices'), view?.services);
    $('footerStatus').textContent = view?.services?.docker
      ? '本地服务已启动 · Docker 可用'
      : '本地服务已启动 · Docker 未检测到';
  };

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

  const runDecision = async (input, successText) => {
    try {
      await window.companion.decide(input);
      closeModal();
      toast(successText);
      await refresh();
    } catch (error) {
      toast(String(error?.message ?? error), 5000);
    }
  };

  const confirmDecision = ({ title, rows, hash, confirmLabel, success, input, reason }) => {
    const nodes = [detailRows(rows)];
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
      approve.onclick = () => {
        const kind = applying ? 'patch-apply' : 'patch';
        void runDecision({
          kind,
          id: patch.id,
          hash: patch.proposal_hash,
          action: 'approve'
        }, applying ? '补丁已应用，已请求测试' : '补丁已批准；再次审阅即可应用');
      };
      openModal(applying ? '应用补丁' : '审阅补丁', nodes, [cancel, approve]);
    } catch (error) {
      toast(String(error?.message ?? error), 5000);
    }
  };

  const openResult = async (cycleId) => {
    try {
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

  const pendingCard = (item) => {
    const card = el('div', 'pending-card');
    if (item.kind.startsWith('patch')) card.classList.add('patch');
    if (item.kind === 'repair-create') card.classList.add('error');
    card.append(el('div', 'pending-title', item.title));
    card.append(el('div', 'pending-summary',
      item.hash ? `${item.summary} · ${fmtHash(item.hash)}` : item.summary));
    const actions = el('div', 'pending-actions');
    if (item.kind === 'job') {
      const approve = el('button', 'primary', '批准任务');
      approve.onclick = () => confirmDecision({
        title: `批准任务：${item.title}`,
        rows: [['任务', item.title], ['说明', item.summary]],
        confirmLabel: '批准',
        success: '任务已批准，Worker 会开始生成补丁',
        input: { kind: 'job', id: item.id, action: 'approve' }
      });
      const reject = el('button', 'danger', '拒绝');
      reject.onclick = () => confirmDecision({
        title: `拒绝任务：${item.title}`,
        rows: [['任务', item.title]],
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
      approve.onclick = () => confirmDecision({
        title: `批准测试 ${item.id.slice(0, 8)}`,
        rows: [['运行', item.id], ['说明', item.summary]],
        hash: item.hash,
        confirmLabel: '批准测试',
        success: '测试已批准，Worker 会自动运行',
        input: { kind: 'sandbox', id: item.id, hash: item.hash, action: 'approve' }
      });
      actions.append(approve);
    } else if (item.kind === 'repair') {
      const approve = el('button', 'primary', '批准修复');
      approve.onclick = () => confirmDecision({
        title: `批准修复 ${item.id.slice(0, 8)}`,
        rows: [['修复周期', item.id], ['说明', item.summary]],
        hash: item.hash,
        confirmLabel: '批准修复',
        success: '修复已批准，Worker 会自动生成新补丁',
        input: { kind: 'repair', id: item.id, hash: item.hash, action: 'approve' }
      });
      actions.append(approve);
    } else if (item.kind === 'repair-create') {
      const create = el('button', 'primary', '创建修复周期');
      create.onclick = () => confirmDecision({
        title: `从失败测试创建修复 ${item.id.slice(0, 8)}`,
        rows: [['源运行', item.id], ['说明', item.summary]],
        confirmLabel: '创建',
        success: '修复周期已创建，接下来需要你批准',
        input: { kind: 'repair-create', id: item.id, action: 'create' }
      });
      actions.append(create);
    }
    card.append(actions);
    return card;
  };

  const renderPending = () => {
    const list = $('pendingList');
    list.replaceChildren();
    const pending = view?.pending ?? [];
    if (pending.length === 0) {
      list.append(el('div', 'pending-summary', '现在没有需要你决定的事项。'));
      return;
    }
    for (const item of pending) list.append(pendingCard(item));
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
  };

  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      view = await window.companion.snapshot();
      applyState();
      renderProjects();
      renderPending();
      renderResult();
    } catch (error) {
      $('stateDot').className = 'state-dot error';
      $('stateText').textContent = '连接异常';
      $('stage').textContent = String(error?.message ?? error);
    } finally {
      refreshing = false;
    }
  };

  $('submitTask').onclick = async () => {
    const text = $('taskInput').value.trim();
    if (!text) { toast('先写下要交办的事情。'); return; }
    const projectId = $('projectSelect').value;
    const button = $('submitTask');
    button.disabled = true;
    try {
      await window.companion.createJob({ text, projectId });
      $('taskInput').value = '';
      toast('任务已创建，等你批准后开始');
      await refresh();
    } catch (error) {
      toast(String(error?.message ?? error), 5000);
    } finally {
      button.disabled = false;
    }
  };

  $('taskInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      $('submitTask').click();
    }
  });

  $('projectSelect').onchange = async () => {
    try {
      await window.companion.settings.set({ projectId: $('projectSelect').value });
    } catch { /* non-blocking */ }
  };

  const openSettings = async () => {
    try {
      const data = await window.companion.settings.get();
      $('gatewayUrl').value = data.gatewayUrl ?? '';
      $('model').value = data.model ?? '';
      $('allowedPaths').value = data.allowedPaths ?? 'src/';
      $('includePaths').value = (data.includePaths ?? []).join(',');
      renderServiceGrid($('serviceGrid'), data.services);
      $('settings').hidden = false;
    } catch (error) {
      toast(String(error?.message ?? error), 5000);
    }
  };

  $('openSettings').onclick = () => { void openSettings(); };
  $('closeSettings').onclick = () => { $('settings').hidden = true; };
  $('hidePanel').onclick = () => window.companion.hidePanel();
  $('openFull').onclick = () => { void window.companion.openFull().catch((error) => toast(String(error.message ?? error))); };
  $('openFullInline').onclick = $('openFull').onclick;
  $('quit').onclick = () => window.companion.quit();
  $('closeModal').onclick = closeModal;
  $('modal').addEventListener('click', (event) => { if (event.target === $('modal')) closeModal(); });

  $('saveSettings').onclick = async () => {
    try {
      await window.companion.settings.set({
        gatewayUrl: $('gatewayUrl').value,
        model: $('model').value,
        allowedPaths: $('allowedPaths').value,
        includePaths: $('includePaths').value
      });
      $('settings').hidden = true;
      toast('设置已保存');
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
  $('addProjectSettings').onclick = () => { void pickProject(); };

  window.companion.onOpenSettings(() => { void openSettings(); });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!$('modal').hidden) closeModal();
      else if (!$('settings').hidden) $('settings').hidden = true;
      else window.companion.hidePanel();
    }
  });

  void refresh();
  window.setInterval(refresh, 2000);
})();
