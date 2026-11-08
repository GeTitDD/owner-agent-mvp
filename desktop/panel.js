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
    $('playbookSection').hidden = !hasProjects;
    const testConfig = view?.testConfig;
    const missing = testConfig?.missing ?? [];
    $('testWarning').hidden = !(hasProjects && testConfig && testConfig.ok === false);
    if (hasProjects && testConfig && testConfig.ok === false) {
      $('testWarningText').textContent = missing.length
        ? `测试配置缺少 ${missing.join(', ')}；补丁应用后无法创建沙箱。`
        : '还没有可用的测试配置；补丁应用后无法创建沙箱。';
    }
    $('footerStatus').textContent = view?.services?.docker
      ? '本地服务已启动 · Docker 可用'
      : '本地服务已启动 · Docker 未检测到';
    const knowledge = view?.knowledge;
    const candidates = knowledge?.counts?.candidates ?? 0;
    $('knowledgeBadge').textContent = String(candidates);
    $('knowledgeBadge').hidden = !knowledge?.available || candidates === 0;
    if (knowledge?.available) {
      $('knowledgeSummaryText').textContent =
        `经验 ${knowledge.counts.experiences ?? 0} 条 · 待提炼 ${knowledge.counts.pendingHarvest ?? 0} 条 · ` +
        `已验证 ${knowledge.counts.verified} 条 · 候选 ${candidates} 条 · ` +
        `复用 ${knowledge.counts.usages} 次（正反馈 ${knowledge.counts.positiveUsages}）`;
    } else {
      $('knowledgeSummaryText').textContent = '知识库尚未建立；完成任务后会自动采集经验，提炼可自动或进入待提炼队列。';
    }
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

  const playbookButtonState = (busy) => {
    for (const button of document.querySelectorAll('.playbook-btn')) {
      button.disabled = busy || !playbookCatalog?.skillsAvailable;
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
      const propose = el('button', 'primary small', '生成改动提案');
      propose.onclick = () => { confirmPlaybookProposal(result); };
      actions.append(propose);
    }
    box.append(actions);
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

  const runPlaybook = async (id) => {
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
      $('playbookHint').textContent = `正在运行「${playbookLabelOf(id)}」· ${seconds}s（只读，可取消）`;
    };
    tick();
    playbookTimer = window.setInterval(tick, 1000);
    try {
      const result = await window.companion.playbooks.run({ playbookId: id, projectId });
      playbookCurrent = result;
      playbookProjectId = projectId;
      renderPlaybookResult();
      if (result.status !== 'ok') toast(result.summary, 6000);
    } catch (error) {
      toast(String(error?.message ?? error), 6000);
    } finally {
      if (playbookTimer) { window.clearInterval(playbookTimer); playbookTimer = null; }
      playbookBusy = false;
      playbookRunningId = '';
      $('playbookCancel').hidden = true;
      playbookButtonState(false);
      $('playbookHint').textContent = '一键只读分析当前项目；改动会先生成提案等你批准。';
      void loadPlaybooks();
    }
  };

  const loadPlaybooks = async () => {
    const projectId = view?.config?.projectId ?? '';
    try {
      playbookCatalog = await window.companion.playbooks.list({ projectId });
      renderPlaybookButtons();
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

  const pendingCard = (item) => {
    const card = el('div', 'pending-card');
    if (item.kind.startsWith('patch')) card.classList.add('patch');
    if (item.kind === 'repair-create') card.classList.add('error');
    card.append(el('div', 'pending-title', item.title));
    if (item.projectName) {
      const current = item.projectId === view?.config?.projectId;
      card.append(el('div', 'pending-project',
        current ? `当前项目 · ${item.projectName}` : `其他项目 · ${item.projectName}`));
    }
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
      const created = await window.companion.createJob({ text, projectId });
      $('taskInput').value = '';
      const missing = created?.testConfig?.missing ?? [];
      if (created?.testConfig?.ok === false) {
        toast(missing.length
          ? `任务已创建；测试配置缺少 ${missing.join(', ')}，补丁应用后将无法创建沙箱。`
          : '任务已创建；但还没有可用的测试配置，补丁应用后将无法创建沙箱。', 7000);
      } else {
        toast('任务已创建，等你批准后开始');
      }
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
    const projectId = $('projectSelect').value;
    try {
      await window.companion.settings.set({ projectId });
    } catch { /* non-blocking */ }
    // 切项目后旧结论不再适用，先清空再按新项目重新加载。
    playbookCurrent = null;
    playbookProjectId = projectId;
    renderPlaybookResult();
    await refresh();
    void loadPlaybooks();
  };

  const openSettings = async () => {
    try {
      const data = await window.companion.settings.get();
      $('gatewayUrl').value = data.gatewayUrl ?? '';
      $('model').value = data.model ?? '';
      $('allowedPaths').value = data.allowedPaths ?? 'src/';
      $('includePaths').value = (data.includePaths ?? []).join(',');
      $('knowledgeAutoHarvest').checked = data.knowledgeAutoHarvest === true;
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
      const saved = await window.companion.settings.set({
        gatewayUrl: $('gatewayUrl').value,
        model: $('model').value,
        allowedPaths: $('allowedPaths').value,
        includePaths: $('includePaths').value,
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
  $('addProjectSettings').onclick = () => { void pickProject(); };
  $('retryServices').onclick = () => { void openSettings(); };
  $('fixTestConfig').onclick = () => { void openSettings(); };
  for (const button of document.querySelectorAll('[data-knowledge]')) {
    button.onclick = () => { void askKnowledge(button.dataset.knowledge); };
  }
  $('openKnowledge').onclick = () => {
    void window.companion.knowledge.open().catch((error) => toast(String(error.message ?? error)));
  };

  $('playbookCancel').onclick = async () => {
    if (!playbookRunningId) return;
    try {
      const result = await window.companion.playbooks.cancel({ playbookId: playbookRunningId });
      toast(result?.canceled ? '已请求取消，正在中止会话…' : '当前没有正在运行的 playbook');
    } catch (error) {
      toast(String(error?.message ?? error), 5000);
    }
  };

  window.companion.onOpenSettings(() => { void openSettings(); });

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
