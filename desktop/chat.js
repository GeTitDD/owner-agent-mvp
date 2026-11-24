// 形态 C：对话即界面。所有操作都是一条消息里的卡片，没有页签。
// 复用现有 IPC：snapshot / submit / decide。
(() => {
  const transcript = document.getElementById('transcript');
  const decisions = document.getElementById('decisions');
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  const projectSelect = document.getElementById('projectSelect');
  let view = null;
  let busy = false;

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const scrollToEnd = () => {
    transcript.scrollTop = transcript.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
  };

  const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

  const say = (role, text, meta) => {
    const node = el('div', `msg ${role}`);
    if (meta) node.append(el('span', 'meta', meta));
    node.append(document.createTextNode(text));
    transcript.append(node);
    scrollToEnd();
    return node;
  };

  const currentProject = () => String(projectSelect.value || view?.projects?.[0]?.id || '');

  /** 待决定卡片：只从最新快照渲染，避免对话里堆积过期按钮。 */
  const renderDecisions = () => {
    decisions.replaceChildren();
    const pending = Array.isArray(view?.pending) ? view.pending : [];
    if (!pending.length) return;

    for (const item of pending.slice(0, 3)) {
      const card = el('div', 'card');
      card.append(el('div', 'kicker', item.kind === 'patch' ? '补丁待审' : item.kind === 'job' ? '任务待批' : '待确认'));
      card.append(el('h3', undefined, item.title || '未命名'));
      card.append(el('p', undefined, item.summary || ''));

      const row = el('div', 'row');
      const yes = el('button', 'yes', '批准');
      const no = el('button', 'no', item.kind === 'patch' ? '拒绝' : '拒绝');
      const decide = async (action) => {
        yes.disabled = true;
        no.disabled = true;
        try {
          await window.companion.decide({
            kind: item.kind,
            id: item.id,
            action,
            hash: item.hash || '',
          });
          say('sys', `${action === 'approve' ? '已批准' : '已拒绝'}：${item.title || item.id}`);
          await refresh();
        } catch (error) {
          say('sys', `操作失败：${String(error?.message ?? error)}`);
          yes.disabled = false;
          no.disabled = false;
        }
      };
      yes.onclick = () => { void decide('approve'); };
      no.onclick = () => { void decide('reject'); };
      row.append(yes, no);
      card.append(row);
      decisions.append(card);
    }

    if (pending.length > 3) {
      decisions.append(el('div', 'card', `还有 ${pending.length - 3} 项，请到面板里处理。`));
    }
  };

  const fillProjects = () => {
    const projects = Array.isArray(view?.projects) ? view.projects : [];
    const current = projectSelect.value;
    projectSelect.replaceChildren();
    for (const project of projects) {
      const option = el('option', undefined, project.name || project.id);
      option.value = project.id;
      projectSelect.append(option);
    }
    if (current && projects.some((p) => p.id === current)) projectSelect.value = current;
  };

  const refresh = async () => {
    view = await window.companion.snapshot();
    fillProjects();
    renderDecisions();
  };

  const greet = () => {
    const pending = view?.pending?.length ?? 0;
    const projects = view?.projects?.length ?? 0;
    if (!projects) {
      say('bot', '还没有登记项目。先去面板里添加一个目录，我就能开始观察了。');
      return;
    }
    const project = view?.projects?.find((p) => p.id === currentProject()) ?? view.projects[0];
    const lines = [
      `我在看 ${project?.name || project?.id || '这个项目'}。`,
      pending > 0 ? `现在有 ${pending} 件事等你决定，列在下面。` : '现在没有需要你决定的事。',
      '你可以直接问，也可以让我去查项目状态。',
    ];
    say('bot', lines.join('\n'), stamp());
  };

  const submit = async () => {
    const text = input.value.trim();
    if (!text || busy) return;
    busy = true;
    send.disabled = true;
    input.value = '';
    say('me', text);
    const thinking = say('sys', '正在分析…');
    try {
      const result = await window.companion.submit({ text, projectId: currentProject() });
      thinking.remove();
      if (result?.mode === 'answer') {
        say('bot', result.summary || '没有结论。', stamp());
        for (const finding of result.findings ?? []) {
          if (finding) say('bot', String(finding), '发现');
        }
      } else if (result?.mode === 'write-request') {
        say('bot', '需要改代码，我先建了一个待批准的写请求；批准后才会动手。', stamp());
      } else {
        say('bot', result?.advice || result?.summary || '这次没跑通，可以再说一次。', stamp());
      }
      await refresh();
    } catch (error) {
      thinking.remove();
      say('sys', `失败：${String(error?.message ?? error)}`);
    } finally {
      busy = false;
      send.disabled = false;
      input.focus();
    }
  };

  send.onclick = () => { void submit(); };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  });

  (async () => {
    try {
      await refresh();
    } catch {
      say('sys', '本地服务未就绪，稍后重试。');
      return;
    }
    greet();
  })();
  setInterval(() => { void refresh().catch(() => {}); }, 5000);
})();
