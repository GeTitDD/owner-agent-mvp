// Owner Companion 的电子脑：页面 ↔ Node worker 转发 + Agent 工具。
//
// 数据与计算都在 node/worker.cjs（本地 Node 进程）里，这里只做消息路由与结果裁剪。
const CHANNEL = 'owner-companion';
const channel = new BroadcastChannel(CHANNEL);
const NODE_TIMEOUT_MS = 20000;

const forward = async (method, params = {}) => {
  const response = await cindy.node.request({
    method,
    params,
    timeoutMs: NODE_TIMEOUT_MS
  });
  if (!response || response.ok === false) {
    throw new Error(String(response?.message ?? '本地服务没有响应'));
  }
  return response.result;
};

channel.onmessage = async (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'req' || !msg.reqId) return;
  try {
    const result = await forward(msg.method, msg.params ?? {});
    channel.postMessage({ type: 'res', reqId: msg.reqId, ok: true, result });
  } catch (error) {
    channel.postMessage({
      type: 'res',
      reqId: msg.reqId,
      ok: false,
      error: String(error?.message ?? error)
    });
  }
};

const slimOverview = (overview) => ({
  project: overview.project,
  nextAction: overview.nextAction,
  brief: overview.brief ? {
    oneLiner: overview.brief.oneLiner,
    howToRun: (overview.brief.howToRun ?? []).slice(0, 6),
    risks: (overview.brief.risks ?? []).slice(0, 4),
    stale: overview.brief.stale === true
  } : null,
  counts: {
    ideas: overview.ideas.length,
    todoIdeas: overview.ideas.filter((idea) => idea.status === 'todo').length,
    knowledge: overview.knowledge.knowledge,
    verified: overview.knowledge.verified,
    candidates: overview.knowledge.candidates
  },
  ideas: overview.ideas.slice(0, 12).map((idea) => ({
    id: idea.id, title: idea.title, status: idea.status
  })),
  diagrams: overview.diagrams.map((diagram) => ({
    kind: diagram.kind, title: diagram.title, version: diagram.version
  }))
});

// ---- 聊天卡片 ----
// 卡片是纯 HTML + CSS，主机剥掉所有脚本；交互只能通过 data-ghost-action 声明。

const IDEA_STATUS_LABEL = {
  todo: '待讨论', doing: '进行中', blocked: '受阻', done: '已完成', failed: '失败'
};

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

// 卡片宽度约 460px，超出部分按行数估算高度；文本先截断，避免一张卡被长段落撑爆。
const clip = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const lineCount = (value, perLine) => Math.max(1, Math.ceil(clip(value, 400).length / perLine));

const CARD_TEXT = 'var(--text-primary, #1a1a1a)';
const CARD_MUTED = 'var(--text-secondary, #6b6b6b)';
const CARD_BORDER = 'var(--border-default, #e4e4e0)';
const CARD_SURFACE = 'var(--surface, #f7f7f5)';

const cardButton = (actionId, label, { prompt = '', primary = false } = {}) => {
  const promptAttr = prompt ? ` data-ghost-prompt="${esc(prompt)}"` : '';
  const primaryAttr = primary ? ' data-ghost-primary' : '';
  const weight = primary ? '600' : '500';
  return `<button data-ghost-action="${esc(actionId)}"${promptAttr}${primaryAttr}`
    + ` style="display:inline-flex;align-items:center;padding:6px 12px;border-radius:8px;`
    + `border:1px solid ${CARD_BORDER};background:${primary ? CARD_SURFACE : 'transparent'};`
    + `color:${CARD_TEXT};font:${weight} 12.5px/1.2 inherit;cursor:pointer">${esc(label)}</button>`;
};

const cardButtonRow = (buttons) => `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">${buttons.join('')}</div>`;

const workingCard = (text) => `<div style="padding:14px 16px;font-size:13px;color:${CARD_MUTED}">${esc(text)}</div>`;

const renderOverviewCard = (overview, { note = '', tone = 'normal' } = {}) => {
  const project = overview.project ?? { name: '还没有项目', root: '' };
  const counts = overview.counts ?? {};
  const brief = overview.brief;
  const stale = brief?.stale === true;
  const next = overview.nextAction ?? null;
  const ideas = (overview.ideas ?? []).slice(0, 4);
  const risks = (brief?.risks ?? []).slice(0, 3);
  const howToRun = (brief?.howToRun ?? []).slice(0, 2);
  const pieces = [];

  pieces.push(`<div data-ghost-width="full" style="padding:14px 16px 16px;color:${CARD_TEXT};font-size:13px;line-height:1.6">`);

  // 标题行：项目名 + 统计
  pieces.push('<div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap">');
  pieces.push(`<div style="font-size:15px;font-weight:600">${esc(project.name)}</div>`);
  pieces.push(`<div style="font-size:12px;color:${CARD_MUTED}">`
    + `想法 ${Number(counts.ideas ?? 0)} · 知识 ${Number(counts.knowledge ?? 0)}`
    + `${Number(counts.candidates ?? 0) > 0 ? ` · 待审核 ${Number(counts.candidates)}` : ''}`
    + '</div>');
  pieces.push('</div>');

  if (project.root) {
    pieces.push(`<div style="font-size:11.5px;color:${CARD_MUTED};margin-top:2px;word-break:break-all">${esc(project.root)}</div>`);
  }

  if (brief?.oneLiner) {
    pieces.push(`<p style="margin:10px 0 0">${esc(clip(brief.oneLiner, 150))}</p>`);
  } else {
    pieces.push(`<p style="margin:10px 0 0;color:${CARD_MUTED}">还没有项目画像，点「重新扫描」生成（只读本地文件，不调用模型）。</p>`);
  }

  if (stale) {
    pieces.push(`<p style="margin:8px 0 0;font-size:12px;color:${CARD_MUTED}">代码在画像之后有提交，建议刷新。</p>`);
  }

  if (next?.title) {
    pieces.push(`<div style="margin-top:10px;padding:8px 10px;border-radius:8px;background:${CARD_SURFACE}">`
      + `<div style="font-size:11px;color:${CARD_MUTED};letter-spacing:.04em">下一步</div>`
      + `<div style="font-weight:600;margin-top:1px">${esc(next.title)}</div>`
      + `${next.detail ? `<div style="font-size:12px;color:${CARD_MUTED}">${esc(clip(next.detail, 56))}</div>` : ''}`
      + '</div>');
  }

  if (risks.length) {
    pieces.push(`<div style="margin-top:10px;font-size:12px;color:${CARD_MUTED}">风险</div>`);
    pieces.push('<ul style="margin:2px 0 0;padding-left:18px">'
      + risks.map((risk) => `<li>${esc(clip(risk, 64))}</li>`).join('') + '</ul>');
  }

  if (ideas.length) {
    pieces.push(`<div style="margin-top:10px;font-size:12px;color:${CARD_MUTED}">最近想法</div>`);
    pieces.push('<ul style="margin:2px 0 0;padding-left:18px">'
      + ideas.map((idea) => `<li>${esc(clip(idea.title, 42))}`
        + `<span style="color:${CARD_MUTED};font-size:11.5px"> · ${esc(IDEA_STATUS_LABEL[idea.status] ?? idea.status)}</span>`
        + '</li>').join('')
      + '</ul>');
  }

  if (howToRun.length) {
    pieces.push(`<div style="margin-top:10px;font-size:12px;color:${CARD_MUTED}">怎么跑</div>`);
    pieces.push('<ul style="margin:2px 0 0;padding-left:18px">'
      + howToRun.map((line) => `<li><code style="font-size:11.5px">${esc(clip(line, 64))}</code></li>`).join('') + '</ul>');
  }

  if (note) {
    const color = tone === 'error' ? '#b42318' : CARD_MUTED;
    pieces.push(`<p style="margin:10px 0 0;font-size:12px;color:${color}">${esc(note)}</p>`);
  }

  const projectId = String(project.id ?? '');
  if (projectId) {
    pieces.push(cardButtonRow([
      cardButton(`brief:refresh:${projectId}`, brief ? '重新扫描' : '生成画像', { primary: true }),
      cardButton(`idea:add:${projectId}`, '记想法', { prompt: '一句话描述这个想法' }),
      cardButton(`open:task:${projectId}`, '打开 Owner 面板')
    ]));
  }

  pieces.push('</div>');

  // 高度估算：按 13px 中文约 30 字/行、12px 约 34 字/行折算，尽量贴近真实高度。
  const height = 30 // 上下内边距
    + 24 // 标题行
    + (project.root ? 18 : 0)
    + (brief?.oneLiner ? lineCount(brief.oneLiner, 30) * 21 + 10 : 34)
    + (stale ? 20 : 0)
    + (next?.title ? 52 + (next.detail ? lineCount(next.detail, 34) * 18 : 0) : 0)
    + (risks.length ? 20 + risks.reduce((sum, risk) => sum + lineCount(clip(risk, 64), 34) * 18, 0) : 0)
    + (ideas.length ? 20 + ideas.length * 21 : 0)
    + (howToRun.length ? 20 + howToRun.reduce((sum, line) => sum + lineCount(clip(line, 64), 34) * 18, 0) : 0)
    + (note ? 16 + lineCount(note, 34) * 18 : 0)
    + (projectId ? 14 + 34 : 0);

  return { html: pieces.join(''), height: Math.min(880, Math.max(160, Math.round(height))) };
};

const cardTimestamps = new Map();

// 让已打开的 Owner 页签/面板跟随卡片切到同一个项目。
const focusProject = (projectId) => {
  if (!projectId) return;
  try {
    channel.postMessage({ type: 'focus-project', projectId });
  } catch {
    // 广播失败不影响卡片本身。
  }
};

// 把项目记到任务页签的存储里，页面重开或刷新后仍然停在这个项目。
const pinProject = async (sessionId, projectId) => {
  if (!projectId) return;
  try {
    await forward('owner/projects/focus/set', {
      sessionId: String(sessionId ?? ''),
      projectId
    });
  } catch {
    // 旧版 worker 没有这个方法时忽略。
  }
};

// 同一张卡两版之间至少隔 1.1 秒，否则主机会静默丢弃。
const sendCard = async (payload) => {
  const last = cardTimestamps.get(payload.callId) ?? 0;
  const gap = Date.now() - last;
  if (gap < 1100) await new Promise((resolve) => setTimeout(resolve, 1100 - gap));
  cardTimestamps.set(payload.callId, Date.now());
  cindy.send(payload);
};

const tools = {
  async owner_projects() {
    const result = await forward('owner/projects/list');
    return {
      projects: result.projects.map((project) => ({
        id: project.id,
        name: project.name,
        root: project.root
      }))
    };
  },

  async owner_project_overview(args) {
    const result = await forward('owner/projects/overview', {
      projectId: String(args?.projectId ?? '')
    });
    return slimOverview(result);
  },

  async owner_brief_refresh(args) {
    const result = await forward('owner/brief/refresh', {
      projectId: String(args?.projectId ?? '')
    });
    return {
      project: result.project,
      brief: {
        oneLiner: result.brief.oneLiner,
        howToRun: (result.brief.howToRun ?? []).slice(0, 6),
        risks: (result.brief.risks ?? []).slice(0, 4)
      }
    };
  },

  async owner_ideas(args) {
    const result = await forward('owner/ideas/list', {
      projectId: String(args?.projectId ?? ''),
      status: String(args?.status ?? '')
    });
    return {
      ideas: result.ideas.map((idea) => ({
        id: idea.id, title: idea.title, status: idea.status, source: idea.source
      }))
    };
  },

  async owner_idea_add(args) {
    const projectId = String(args?.projectId ?? '');
    const title = String(args?.title ?? '').trim();
    if (!title) throw new Error('想法内容不能为空');
    const idea = await forward('owner/ideas/add', { projectId, title });
    return { id: idea.id, title: idea.title, status: idea.status };
  },

  async owner_idea_status(args) {
    const idea = await forward('owner/ideas/status', {
      id: String(args?.id ?? ''),
      status: String(args?.status ?? '')
    });
    return { id: idea.id, title: idea.title, status: idea.status };
  },

  async owner_knowledge(args) {
    const result = await forward('owner/knowledge/list', {
      projectId: String(args?.projectId ?? ''),
      status: String(args?.status ?? '')
    });
    return {
      items: result.items.slice(0, 15).map((entry) => ({
        id: entry.id,
        title: entry.title,
        status: entry.status,
        tags: entry.tags
      })),
      experiences: result.experiences.slice(0, 10).map((entry) => ({
        id: entry.id, text: String(entry.text).slice(0, 160), distilled: entry.distilled
      }))
    };
  },

  async owner_knowledge_propose(args) {
    const entry = await forward('owner/knowledge/propose', {
      projectId: String(args?.projectId ?? ''),
      title: String(args?.title ?? ''),
      body: String(args?.body ?? ''),
      tags: args?.tags ?? [],
      evidence: args?.evidence ?? []
    });
    return { id: entry.id, title: entry.title, status: entry.status };
  },

  async owner_knowledge_tidy(args) {
    return forward('owner/knowledge/tidy', { projectId: String(args?.projectId ?? '') });
  },

  async owner_knowledge_search(args) {
    const result = await forward('owner/knowledge/search', {
      query: String(args?.query ?? ''),
      projectId: String(args?.projectId ?? '')
    });
    return {
      items: result.items.slice(0, 10).map((entry) => ({
        id: entry.id, title: entry.title, status: entry.status
      }))
    };
  },

  async owner_experience_add(args) {
    const entry = await forward('owner/experiences/add', {
      projectId: String(args?.projectId ?? ''),
      text: String(args?.text ?? ''),
      outcome: String(args?.outcome ?? 'unknown')
    });
    return { id: entry.id, outcome: entry.outcome, distilled: entry.distilled };
  },

  async owner_experience_list(args) {
    const result = await forward('owner/experiences/list', {
      projectId: String(args?.projectId ?? ''),
      distilled: args?.distilled
    });
    return {
      items: result.items.slice(0, 15).map((entry) => ({
        id: entry.id,
        text: String(entry.text).slice(0, 200),
        outcome: entry.outcome,
        distilled: entry.distilled
      }))
    };
  },

  async owner_knowledge_add(args) {
    const projectId = String(args?.projectId ?? '');
    const title = String(args?.title ?? '').trim();
    if (!title) throw new Error('知识标题不能为空');
    const entry = await forward('owner/knowledge/add', {
      projectId,
      title,
      body: String(args?.body ?? ''),
      tags: args?.tags ?? []
    });
    return { id: entry.id, title: entry.title, status: entry.status };
  },

  async owner_diagram(args) {
    const projectId = String(args?.projectId ?? '');
    const diagram = await forward('owner/diagrams/dependency', { projectId });
    return {
      kind: diagram.kind,
      summary: diagram.summary,
      version: diagram.version,
      mermaid: String(diagram.mermaid ?? '').slice(0, 20000)
    };
  },

  async owner_github_status(args) {
    const projectId = String(args?.projectId ?? '');
    const result = await forward('owner/github/status', { projectId });
    if (!result.ok) throw new Error(result.error || 'GitHub 读取失败');
    return {
      repo: result.repo,
      issues: result.issues.slice(0, 5).map((item) => ({
        number: item.number, title: item.title, state: item.state
      })),
      prs: result.prs.slice(0, 5).map((item) => ({
        number: item.number, title: item.title, draft: item.draft, state: item.state
      })),
      branch: result.preview.branch,
      clean: result.preview.clean
    };
  },

  async owner_patches(args) {
    const result = await forward('owner/patches/list', {
      projectId: String(args?.projectId ?? ''),
      status: String(args?.status ?? 'pending')
    });
    return {
      items: result.items.map((entry) => ({
        id: entry.id, title: entry.title, status: entry.status, createdAt: entry.createdAt
      }))
    };
  },

  async owner_patch_propose(args) {
    const entry = await forward('owner/patches/propose', {
      projectId: String(args?.projectId ?? ''),
      title: String(args?.title ?? '代码改动'),
      diff: String(args?.diff ?? '')
    });
    return { id: entry.id, title: entry.title, status: entry.status, baseCommit: entry.baseCommit };
  },

  async owner_test_run(args) {
    const result = await forward('owner/tests/run', {
      projectId: String(args?.projectId ?? ''),
      command: String(args?.command ?? ''),
      timeoutMs: Number(args?.timeoutMs) || 120000
    });
    return {
      ok: result.ok,
      command: result.command,
      durationMs: result.durationMs,
      output: String(result.output ?? '').slice(-3000)
    };
  }
};

cindy.onHostMessage(async (message) => {
  if (message?.type === 'event' && message.name === 'card-action') {
    await handleCardAction(message);
    return;
  }
  if (message?.type !== 'tool-call') return;
  const handler = tools[message.tool];
  if (!handler) {
    cindy.send({
      type: 'tool-result',
      callId: message.callId,
      ok: false,
      message: `未知工具：${message.tool}`
    });
    return;
  }

  const withCard = message.tool === 'owner_project_overview';
  if (withCard) {
    // 过程卡也走 sendCard，保证与交卷卡之间满足主机的 1 秒限速。
    await sendCard({
      type: 'card-update',
      callId: message.callId,
      state: 'working',
      html: workingCard('正在读取项目…'),
      height: 80
    });
  }

  try {
    const result = await handler(message.args ?? {});
    if (withCard) {
      const card = renderOverviewCard(result);
      await sendCard({
        type: 'card-update',
        callId: message.callId,
        v: 2,
        state: 'done',
        html: card.html,
        height: card.height
      });
    }
    cindy.send({ type: 'tool-result', callId: message.callId, ok: true, result });
  } catch (error) {
    const messageText = String(error?.message ?? error);
    if (withCard) {
      const card = renderOverviewCard(
        { project: { name: '读取失败' }, counts: {}, ideas: [] },
        { note: messageText, tone: 'error' }
      );
      await sendCard({
        type: 'card-update',
        callId: message.callId,
        v: 2,
        state: 'done',
        html: card.html,
        height: card.height
      });
    }
    cindy.send({
      type: 'tool-result',
      callId: message.callId,
      ok: false,
      message: messageText
    });
  }
});

// 卡片按钮：动作 id 形如 `brief:refresh:<projectId>` / `idea:add:<projectId>` / `open:task:<projectId>`。
const handleCardAction = async (message) => {
  const [verb, sub, ...rest] = String(message.actionId ?? '').split(':');
  const projectId = rest.join(':');
  const callId = message.callId;

  // 卡片动作不一定带 sessionId（没有声明 agent）；缺省时由主机落到台前任务。
  const overviewFor = async (note, tone = 'normal') => {
    if (!projectId) return null;
    const card = renderOverviewCard(
      slimOverview(await forward('owner/projects/overview', { projectId })),
      { note, tone }
    );
    await sendCard({ type: 'card-update', callId, v: 2, state: 'done', html: card.html, height: card.height });
    return true;
  };

  try {
    if (verb === 'brief' && sub === 'refresh' && projectId) {
      await sendCard({
        type: 'card-update',
        callId,
        v: 2,
        state: 'working',
        html: workingCard('正在扫描本地项目…'),
        height: 80
      });
      await forward('owner/brief/refresh', { projectId });
      void pinProject(message.sessionId, projectId);
      focusProject(projectId);
      await overviewFor('已重新扫描，画像已更新。');
      return;
    }

    if (verb === 'idea' && sub === 'add' && projectId) {
      const text = String(message.prompt ?? '').trim();
      // 输入文字由主机代管；旧客户端不会带 prompt，这时只在原卡上提示。
      if (!text) {
        await overviewFor('没有收到想法内容，请再点一次「记想法」并输入文字。');
        return;
      }
      const target = message.spawnCallId || callId;
      await sendCard({
        type: 'card-update',
        callId: target,
        v: 2,
        state: 'working',
        html: workingCard('正在记下想法…'),
        height: 80
      });
      const idea = await forward('owner/ideas/add', { projectId, title: text });
      void pinProject(message.sessionId, projectId);
      focusProject(projectId);
      const card = renderOverviewCard(
        slimOverview(await forward('owner/projects/overview', { projectId })),
        { note: `已记下想法：${idea.title}` }
      );
      await sendCard({ type: 'card-update', callId: target, v: 2, state: 'done', html: card.html, height: card.height });
      return;
    }

    if (verb === 'open' && sub === 'task') {
      // 先落盘，再开页签：新页签初始化时会读到这个项目，不会先闪一下默认项目。
      await pinProject(message.sessionId, projectId);
      let opened = { ok: false };
      try {
        opened = await cindy.taskView(message.sessionId ? { sessionId: message.sessionId } : {});
        if (!opened?.ok) {
          opened = await cindy.taskView(message.sessionId ? { sessionId: message.sessionId, focus: true } : { focus: true });
        }
      } catch {
        opened = { ok: false };
      }
      focusProject(projectId);
      await overviewFor(opened?.ok
        ? '已在右侧打开 Owner 页签。'
        : '没能自动打开侧边页签，点左侧导航的 Owner 即可。');
      return;
    }
  } catch (error) {
    const messageText = String(error?.message ?? error);
    if (projectId) {
      await overviewFor(messageText, 'error');
    } else {
      await sendCard({
        type: 'card-update',
        callId: message.spawnCallId || callId,
        v: 2,
        state: 'done',
        html: workingCard(`操作失败：${messageText}`),
        height: 90
      });
    }
  }
};
