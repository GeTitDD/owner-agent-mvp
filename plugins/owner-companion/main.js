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
    knowledge: overview.knowledge.knowledge
  },
  ideas: overview.ideas.slice(0, 12).map((idea) => ({
    id: idea.id, title: idea.title, status: idea.status
  })),
  diagrams: overview.diagrams.map((diagram) => ({
    kind: diagram.kind, title: diagram.title, version: diagram.version
  }))
});

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
  try {
    const result = await handler(message.args ?? {});
    cindy.send({ type: 'tool-result', callId: message.callId, ok: true, result });
  } catch (error) {
    cindy.send({
      type: 'tool-result',
      callId: message.callId,
      ok: false,
      message: String(error?.message ?? error)
    });
  }
});
