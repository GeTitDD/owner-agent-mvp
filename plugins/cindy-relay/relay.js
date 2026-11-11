/* global RelayBridge */
(() => {
  const $ = (id) => document.getElementById(id);
  const call = (method, params, timeoutMs) => RelayBridge.call(method, params, timeoutMs);
  const sessionFromUrl = new URLSearchParams(location.search).get('session') ?? '';

  const state = {
    sessionId: sessionFromUrl,
    source: null,
    scope: 'new',
    targetKind: 'project',
    targets: [],
    selected: null,
    route: null,
    models: [],
    permissionMode: 'ask',
    pending: [],
    all: [],
    sending: false,
    requestKey: '',
    createdTaskId: '',
    createdRevision: 0,
    attachments: { supported: false, items: [] },
    attachmentsSupported: null,
    prefs: {}
  };

  const esc = (value) => String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');

  const clip = (value, max) => {
    const text = String(value ?? '');
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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

  const timeText = (iso) => {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  const roleLabel = (role) => (role === 'assistant' ? '助手' : '我');

  // 引用格式：带角色和时间，原样保留文本。
  const formatQuote = (messages) => {
    return messages.map((message) => {
      const head = `[${roleLabel(message.role)} · ${timeText(message.at)}${message.model ? ` · ${message.model}` : ''}]`;
      return `${head}\n${message.text}`;
    }).join('\n\n');
  };

  const selectedMessages = () => (state.scope === 'all' ? state.all : state.pending);

  const attachmentSince = () => (state.scope === 'all'
    ? ''
    : (state.pending[0]?.at ?? state.source?.lastRelayAt ?? ''));

  const renderAttachments = () => {
    const hint = $('attachHint');
    const images = state.attachments.items;
    const files = state.attachments.files ?? [];
    if (!images.length && !files.length) {
      hint.textContent = '';
      hint.hidden = true;
      return;
    }
    hint.hidden = false;
    const parts = [];
    if (images.length) {
      const size = images.reduce((sum, item) => sum + (item.bytes || 0), 0);
      parts.push(`${images.length} 张图片（约 ${Math.max(1, Math.round(size / 1024))} KB）`);
    }
    if (files.length) {
      const textCount = files.filter((file) => file.text).length;
      parts.push(`${files.length} 个文件（${textCount ? `${textCount} 个文本会附内容，` : ''}其余给路径）`);
    }
    hint.textContent = `含 ${parts.join('、')}，会随引用一起转交`;
  };

  const loadAttachments = async () => {
    if (!state.sessionId) {
      state.attachments = { supported: false, items: [], files: [] };
      renderAttachments();
      return;
    }
    try {
      const result = await call('relay/attachments/list', {
        sessionId: state.sessionId,
        since: attachmentSince()
      }, 12000);
      state.attachments = {
        supported: Boolean(result?.supported),
        items: Array.isArray(result?.items) ? result.items : [],
        files: Array.isArray(result?.files) ? result.files : []
      };
    } catch {
      state.attachments = { supported: false, items: [], files: [] };
    }
    renderAttachments();
  };

  const loadCapabilities = async () => {
    try {
      const caps = await call('cindy/tasks/capabilities', {}, 8000);
      state.attachmentsSupported = Boolean(caps?.messageAttachments?.kinds?.includes('image'));
    } catch {
      state.attachmentsSupported = false;
    }
  };

  const quoteForSend = (limit = 32000) => {
    const messages = selectedMessages();
    const blocks = [];
    let used = 0;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      const block = formatQuote([message]);
      if (used + block.length > limit && blocks.length > 0) break;
      blocks.unshift(block);
      used += block.length + 2;
    }
    const skipped = messages.length - blocks.length;
    return `${skipped > 0 ? `（前 ${skipped} 条已省略）\n\n` : ''}${blocks.join('\n\n')}`;
  };

  const renderSource = () => {
    const source = state.source;
    const messages = selectedMessages();
    $('sourceMeta').textContent = source?.lastRelayAt
      ? `上次转交 ${timeText(source.lastRelayAt)}`
      : '还没有转交过';
    $('sourceEmpty').hidden = (source?.total ?? 0) > 0;
    $('quoteMeta').textContent = `${messages.length} 条 · ${messages.reduce((sum, m) => sum + m.text.length, 0)} 字`;
    const list = $('quoteList');
    list.replaceChildren();
    for (const message of messages.slice(-80)) {
      const item = document.createElement('div');
      item.className = `msg ${message.role === 'assistant' ? 'agent' : 'user'}`;
      item.innerHTML = `<div class="msg-head">${esc(roleLabel(message.role))} · ${esc(timeText(message.at))}`
        + `${message.model ? ` · ${esc(message.model)}` : ''}</div>`
        + `<div class="msg-body">${esc(message.text)}</div>`;
      list.append(item);
    }
    updateSendState();
  };

  const targetKindLabel = { project: '项目', new: '新任务', task: '任务', bot: '伙伴' };

  const renderTargets = () => {
    const list = $('targetList');
    list.replaceChildren();
    if (!state.targets.length) {
      const empty = document.createElement('div');
      empty.className = 'muted small';
      empty.textContent = state.targetError || `没有可用的${targetKindLabel[state.targetKind]}目标`;
      list.append(empty);
      return;
    }
    for (const target of state.targets) {
      const label = document.createElement('label');
      label.className = 'target';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'target';
      input.value = `${target.kind}:${target.id}`;
      input.checked = state.selected?.id === target.id && state.selected?.kind === target.kind;
      input.addEventListener('change', () => {
        state.selected = { kind: target.kind, id: target.id, label: target.label };
        state.requestKey = '';
        void savePrefs();
        updateSendState();
      });
      const text = document.createElement('span');
      text.innerHTML = `<b>${esc(target.label)}</b>${target.detail ? `<span class="muted small">${esc(target.detail)}</span>` : ''}`;
      label.append(input, text);
      list.append(label);
    }
  };

  const routeLabel = (route) => {
    if (!route) return '默认';
    return `${route.agentKind ?? 'agent'} / ${route.model ?? ''}${route.effort ? ` · ${route.effort}` : ''}`;
  };

  const renderRoutes = () => {
    const select = $('routeSelect');
    select.replaceChildren();
    const fallback = document.createElement('option');
    fallback.value = '';
    fallback.textContent = '默认（沿用项目新任务设置）';
    select.append(fallback);
    for (const item of state.models) {
      const option = document.createElement('option');
      option.value = item.id ?? routeLabel(item.route);
      option.textContent = routeLabel(item.route);
      select.append(option);
    }
    const currentId = state.route?.id
      ?? state.models.find((item) => routeLabel(item.route) === routeLabel(state.route))?.id
      ?? '';
    select.value = currentId;
  };

  const renderRoute = () => {
    for (const button of document.querySelectorAll('#targetTabs button')) {
      button.classList.toggle('active', button.dataset.kind === state.targetKind);
    }
    const needsRoute = state.targetKind === 'project' || state.targetKind === 'new';
    $('routeRow').hidden = !needsRoute;
    $('permissionField').hidden = !needsRoute;
    $('permissionMode').value = state.permissionMode || 'ask';
    $('titleField').hidden = state.targetKind !== 'new';
    $('targetList').hidden = state.targetKind === 'new';
  };

  const updateSendState = () => {
    const count = selectedMessages().length;
    const hasTarget = state.targetKind === 'new' ? true : Boolean(state.selected);
    const ready = Boolean(state.sessionId && count && hasTarget && !state.sending);
    $('sendButton').disabled = !ready;
    $('sendHint').textContent = state.sending
      ? '发送中…'
      : (hasTarget ? (count ? '' : '没有可转交的内容') : '先选一个目标');
  };

  const savePrefs = async () => {
    try {
      await call('relay/prefs/set', {
        patch: {
          targetKind: state.targetKind,
          target: state.selected ? { kind: state.selected.kind, id: state.selected.id, label: state.selected.label } : null,
          route: state.route,
          permissionMode: state.permissionMode
        }
      }, 5000);
    } catch { /* 偏好保存失败不影响主流程 */ }
  };

  const loadTargets = async () => {
    state.targetError = '';
    try {
      const result = await call('cindy/targets/list', { targetKind: state.targetKind }, 15000);
      state.targets = Array.isArray(result?.targets) ? result.targets : [];
      if (state.targetKind === 'project' && !state.targets.length) {
        state.targetError = '还没有 Cindy 项目。可以先去「项目」里添加目录，或直接切到「新任务」。';
      }
      const saved = state.prefs?.target;
      const match = state.targets.find((target) => target.kind === (saved?.kind ?? state.targetKind) && target.id === saved?.id);
      if (match && !state.selected) state.selected = { kind: match.kind, id: match.id, label: match.label };
    } catch (error) {
      state.targets = [];
      state.targetError = `读取${targetKindLabel[state.targetKind]}失败：${String(error?.message ?? error)}`;
    }
    renderTargets();
    updateSendState();
  };

  const loadRoutes = async () => {
    try {
      const result = await call('cindy/tasks/models', {}, 15000);
      state.models = Array.isArray(result?.models) ? result.models : [];
    } catch {
      state.models = [];
    }
    renderRoutes();
  };

  const load = async () => {
    setStatus('同步中…');
    // 任务页签只有一个来源，不需要选任务；主视图才显示任务下拉。
    if (sessionFromUrl) $('sessionSelect').hidden = true;
    try {
      if (!state.sessionId) {
        const list = await call('relay/sessions/list', {}, 8000);
        const sessions = list.sessions ?? [];
        const select = $('sessionSelect');
        select.replaceChildren();
        for (const session of sessions) {
          const option = document.createElement('option');
          option.value = session.id;
          option.textContent = `${session.label}（${session.pending} 条待转交）`;
          select.append(option);
        }
        select.hidden = sessions.length === 0;
        state.sessionId = sessions[0]?.id ?? '';
      }
      if (!state.sessionId) {
        state.source = null;
        renderSource();
        setStatus('没有任务记录', 'bad');
        return;
      }
      const source = await call('relay/sessions/state', { sessionId: state.sessionId }, 8000);
      state.source = source;
      state.pending = source.pending ?? [];
      const all = await call('relay/sessions/all', { sessionId: state.sessionId }, 8000);
      state.all = all.messages ?? [];
      const prefs = await call('relay/prefs/get', {}, 5000).catch(() => ({ prefs: {} }));
      state.prefs = prefs.prefs ?? {};
      if (!state.route && state.prefs.route) state.route = state.prefs.route;
      if (state.prefs.permissionMode) state.permissionMode = state.prefs.permissionMode;
      if (['project', 'new', 'task', 'bot'].includes(state.prefs.targetKind)) {
        state.targetKind = state.prefs.targetKind;
      }
      renderSource();
      void loadAttachments();
      renderRoute();
      setStatus('已连接', 'ok');
      await loadRoutes();
      if (state.attachmentsSupported === null) await loadCapabilities();
      if (state.targetKind !== 'new') await loadTargets();
      else { renderTargets(); updateSendState(); }
      await loadHistory();
    } catch (error) {
      setStatus('读取失败', 'bad');
      toast(`读取失败：${String(error?.message ?? error)}`);
    }
  };

  const loadHistory = async () => {
    try {
      const result = await call('relay/relays/list', { limit: 10 }, 8000);
      const list = $('historyList');
      list.replaceChildren();
      const relays = result.relays ?? [];
      if (!relays.length) {
        const empty = document.createElement('div');
        empty.className = 'muted small';
        empty.textContent = '还没有转交记录';
        list.append(empty);
        return;
      }
      for (const relay of relays) {
        const item = document.createElement('div');
        item.className = 'history-item';
        item.innerHTML = `<div class="history-head"><b>${esc(relay.target?.label ?? '未记录目标')}</b>`
          + `<span class="muted small">${esc(timeText(relay.createdAt))}</span></div>`
          + `<div class="muted small">来自 ${esc(relay.sessionLabel || '')} · ${relay.chars} 字`
          + `${relay.taskId ? ` · 任务 ${esc(relay.taskId.slice(0, 8))}` : ''}</div>`;
        list.append(item);
      }
    } catch { /* 历史失败不阻塞页面 */ }
  };

  const send = async () => {
    const isNew = state.targetKind === 'new';
    const target = state.selected;
    const messages = selectedMessages();
    if ((!isNew && !target) || !messages.length || state.sending) return;
    const note = String($('noteInput')?.value ?? '').trim();
    const quote = quoteForSend();
    if (!quote) {
      toast('没有可转交的内容');
      return;
    }
    state.sending = true;
    updateSendState();
    const firstUser = messages.find((message) => message.role === 'user');
    const titleBase = (isNew ? String($('titleInput')?.value ?? '').trim() : '') || note
      || firstUser?.text || '继续这个任务';
    const title = clip(titleBase.replace(/\s+/gu, ' '), 40);
    const requestKey = state.requestKey || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
    state.requestKey = requestKey;
    const sourceLink = state.sessionId
      ? `\n\n来源任务：[${state.source?.label || '原任务'}](cindy://session/${state.sessionId})`
      : '';
    const text = `自「${state.source?.label || '当前任务'}」转交的上下文，见附带资料。${note ? `\n\n备注：${note}` : ''}${sourceLink}`;
    const formatBytes = (value) => {
      const size = Number(value) || 0;
      if (size >= 1024 * 1024) return `${(size / 1048576).toFixed(1)} MB`;
      if (size >= 1024) return `${Math.round(size / 1024)} KB`;
      return `${size} B`;
    };
    let attachmentPayload = [];
    let fileBlock = '';
    const fileCount = state.attachments.files?.length ?? 0;
    if (state.attachments.items.length || fileCount) {
      const read = await call('relay/attachments/read', {
        sessionId: state.sessionId,
        since: attachmentSince()
      }, 30000).catch(() => null);
      if (state.attachments.items.length && state.attachmentsSupported !== false) {
        attachmentPayload = (read?.attachments ?? []).map(({ base64, name }) => ({ base64, name }));
      }
      const files = read?.files ?? [];
      if (files.length) {
        const lines = files.map((file) => `- ${file.path}（${file.name}，${formatBytes(file.bytes)}）`);
        fileBlock = `\n\n[引用文件]\n${lines.join('\n')}`;
        const inlined = files.filter((file) => file.text && file.content);
        if (inlined.length) {
          fileBlock += '\n\n' + inlined
            .map((file) => `[文件内容：${file.name}]\n\`\`\`\n${file.content.slice(0, 12000)}\n\`\`\``)
            .join('\n\n');
        }
      }
    }
    const contextText = (quote + fileBlock).slice(0, 32000);
    try {
      let result;
      if (isNew) {
        // 独立任务：插件先建任务，再投递；建好但发送失败时保留 taskId 只重发。
        let taskId = state.createdTaskId;
        let revision = state.createdRevision;
        if (!taskId) {
          const created = await call('cindy/tasks/create', {
            requestKey: `create-${requestKey}`,
            title,
            ...(state.route ? { route: state.route } : {}),
            ...(state.permissionMode !== 'ask' ? { permissionMode: state.permissionMode } : {})
          }, 60000);
          taskId = created?.taskId ?? created?.sessionId ?? created?.task?.id ?? '';
          revision = Number(created?.revision) || 0;
          if (!taskId) {
            toast(created?.message || created?.errorCode || '任务创建失败');
            state.sending = false;
            updateSendState();
            return;
          }
          state.createdTaskId = taskId;
          state.createdRevision = revision;
        }
        const sendOnce = (expectedRevision) => call('cindy/tasks/send', {
          taskId,
          requestKey: `send-${requestKey}`,
          text,
          context: contextText,
          ...(expectedRevision ? { expectedRevision } : {}),
          ...(attachmentPayload.length ? { attachments: attachmentPayload } : {})
        }, 120000);
        let sent;
        try {
          sent = await sendOnce(revision);
        } catch (error) {
          // 任务被别处改动过：读一次最新 revision 再重发（同 requestKey）。
          const current = await call('cindy/tasks/get', { taskId }, 15000).catch(() => null);
          const latest = Number(current?.revision) || 0;
          if (!latest || latest === revision) throw error;
          sent = await sendOnce(latest);
        }
        if (sent?.ok === false) {
          toast(sent?.message || sent?.errorCode || '发送没有被接受');
          state.sending = false;
          updateSendState();
          return;
        }
        result = { accepted: true, taskId };
      } else {
        const payload = {
          target: { kind: target.kind, id: target.id },
          requestKey,
          text,
          context: contextText,
          ...(attachmentPayload.length ? { attachments: attachmentPayload } : {})
        };
        if (target.kind === 'project') {
          payload.title = title;
          if (state.route) payload.route = state.route;
          if (state.permissionMode && state.permissionMode !== 'ask') payload.permissionMode = state.permissionMode;
        }
        result = await call('cindy/targets/send', payload, 120000);
      }
      if (!result?.accepted) {
        toast(result?.message || result?.errorCode || '发送没有被接受');
        state.sending = false;
        updateSendState();
        return;
      }
      await call('relay/relays/mark', {
        sessionId: state.sessionId,
        target: isNew
          ? { kind: 'task', id: result.taskId, label: title }
          : { kind: target.kind, id: target.id, label: target.label },
        note,
        chars: contextText.length,
        taskId: result.taskId ?? '',
        requestKey
      }, 8000).catch(() => {});
      state.requestKey = '';
      state.createdTaskId = '';
      state.createdRevision = 0;
      state.sending = false;
      $('noteInput').value = '';
      toast(isNew || target.kind === 'project'
        ? `已建立新任务 ${String(result.taskId).slice(0, 8)}`
        : `已投递到「${target.label}」`);
      await load();
    } catch (error) {
      const message = String(error?.message ?? error);
      // TASK_BUSY 用同一个 requestKey 重试即可，不清空。
      if (!/TASK_BUSY/u.test(message)) state.requestKey = '';
      state.sending = false;
      updateSendState();
      toast(`发送失败：${message}`);
    }
  };

  const switchKind = async (kind) => {
    if (kind === state.targetKind) return;
    state.targetKind = kind;
    state.selected = null;
    state.requestKey = '';
    renderRoute();
    if (kind === 'new') {
      const first = state.pending[0] ?? state.all[0];
      if (!$('titleInput').value) {
        $('titleInput').value = clip((first?.text ?? '转交任务').replace(/\s+/gu, ' '), 40);
      }
    }
    await savePrefs();
    if (kind !== 'new') await loadTargets();
    updateSendState();
  };

  $('refreshButton').addEventListener('click', () => { void load(); });
  $('sendButton').addEventListener('click', () => { void send(); });
  $('titleInput').addEventListener('input', () => { state.requestKey = ''; });
  $('routeSelect').addEventListener('change', async (event) => {
    const id = event.target.value;
    const chosen = state.models.find((item) => (item.id ?? routeLabel(item.route)) === id);
    state.route = chosen?.route ?? null;
    state.requestKey = '';
    await savePrefs();
  });
  $('copyQuote').addEventListener('click', async () => {
    const quote = quoteForSend();
    try {
      await navigator.clipboard.writeText(quote);
      toast('已复制引用');
    } catch {
      toast('复制失败，可手动选中文本');
    }
  });
  $('clearButton').addEventListener('click', async () => {
    if (!state.sessionId) return;
    try {
      await call('relay/sessions/clear', { sessionId: state.sessionId }, 8000);
      toast('已清空本任务的记录');
      await load();
    } catch (error) {
      toast(`清空失败：${String(error?.message ?? error)}`);
    }
  });
  $('sessionSelect').addEventListener('change', (event) => {
    state.sessionId = event.target.value;
    state.selected = null;
    state.requestKey = '';
    void load();
  });
  for (const button of document.querySelectorAll('#targetTabs button')) {
    button.addEventListener('click', () => { void switchKind(button.dataset.kind); });
  }
  for (const input of document.querySelectorAll('input[name="scope"]')) {
    input.addEventListener('change', () => {
      state.scope = input.value;
      renderSource();
      void loadAttachments();
    });
  }
  $('permissionMode').addEventListener('change', (event) => {
    state.permissionMode = event.target.value;
    void savePrefs();
  });

  void load();
})();
