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
      projectId: String(args?.projectId ?? '')
    });
    return {
      items: result.items.slice(0, 15).map((entry) => ({
        id: entry.id,
        title: entry.title,
        status: entry.status,
        tags: entry.tags
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
