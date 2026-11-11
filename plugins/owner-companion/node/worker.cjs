// Owner Companion 插件的 Node 工作进程。
//
// 这里就是「本地服务」：数据、扫描、画像、图谱全在本进程内完成，
// 不再依赖桌面端的 47831 桥。页面与 main.js 只通过 JSON-RPC 访问。
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');
const readline = require('node:readline');

const execFileAsync = promisify(execFile);
const PKG_VERSION = '0.2.0';

const libUrl = (name) => pathToFileURL(path.join(__dirname, 'lib', name)).href;
let libsPromise = null;
let store = null;

const loadLibs = async () => {
  libsPromise ??= (async () => {
    const [storeModule, scanModule, briefModule, diagramModule] = await Promise.all([
      import(libUrl('store.mjs')),
      import(libUrl('scan.mjs')),
      import(libUrl('brief.mjs')),
      import(libUrl('diagrams.mjs'))
    ]);
    return { storeModule, scanModule, briefModule, diagramModule };
  })();
  return libsPromise;
};

const getStore = async () => {
  if (store) return store;
  const libs = await loadLibs();
  store = libs.storeModule.openStore();
  return store;
};

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

const gitHead = async (root) => {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      timeout: 2000, windowsHide: true
    });
    return stdout.trim();
  } catch {
    return '';
  }
};

const nextActionFor = ({ project, brief, briefStale, ideas }) => {
  if (!project) {
    return { title: '先添加一个项目', detail: '在插件设置里填写项目目录', command: 'add-project' };
  }
  if (!brief) {
    return { title: '生成项目画像', detail: '本地扫描 README、脚本与目录，不调用模型', command: 'brief' };
  }
  if (briefStale) {
    return { title: '刷新项目画像', detail: '代码已更新，画像可能过期', command: 'brief' };
  }
  const todo = ideas.filter((idea) => idea.status === 'todo').length;
  if (todo > 0) {
    return { title: `整理 ${todo} 条想法`, detail: '采纳、搁置，或复制到 Cindy 聊天里讨论', command: 'ideas' };
  }
  return { title: '在 Cindy 里继续讨论', detail: '让 Agent 用 owner_* 工具读取项目上下文', command: 'chat' };
};

const methods = {
  async 'owner/status'() {
    const data = await getStore();
    return {
      ok: true,
      version: PKG_VERSION,
      dataDir: data.dir,
      dataFile: data.file,
      projectCount: data.listProjects().length
    };
  },

  async 'owner/projects/list'() {
    const data = await getStore();
    return { projects: data.listProjects() };
  },

  async 'owner/projects/add'(params) {
    const data = await getStore();
    const root = path.resolve(String(params?.path || '').trim());
    let stat;
    try {
      stat = fs.statSync(root);
    } catch {
      throw fail(`目录不存在：${root}`, 400);
    }
    if (!stat.isDirectory()) throw fail(`不是目录：${root}`, 400);
    const { project, created } = data.addProject({ root, name: params?.name ?? '' });
    return { project, created };
  },

  async 'owner/projects/remove'(params) {
    const data = await getStore();
    if (!data.getProject(String(params?.id || ''))) throw fail('项目不存在', 404);
    return data.removeProject(String(params.id));
  },

  async 'owner/projects/overview'(params) {
    const data = await getStore();
    const projects = data.listProjects();
    const requested = String(params?.projectId || '');
    const project = data.getProject(requested) ?? projects[0] ?? null;
    if (!project) {
      return {
        version: PKG_VERSION,
        generatedAt: new Date().toISOString(),
        projects,
        activeProjectId: '',
        project: null,
        brief: null,
        nextAction: nextActionFor({ project: null, brief: null, briefStale: false, ideas: [] }),
        ideas: [],
        knowledge: { experiences: 0, knowledge: 0, verified: 0, candidates: 0 },
        diagrams: []
      };
    }
    const brief = data.getBrief(project.id);
    const head = await gitHead(project.root);
    const briefStale = Boolean(brief?.basedOnCommit && head && brief.basedOnCommit !== head);
    const ideas = data.listIdeas(project.id);
    const knowledge = data.listKnowledge(project.id);
    const diagrams = data.listDiagrams(project.id);
    return {
      version: PKG_VERSION,
      generatedAt: new Date().toISOString(),
      projects: projects.map((item) => ({ id: item.id, name: item.name, root: item.root })),
      activeProjectId: project.id,
      project: { id: project.id, name: project.name, root: project.root },
      brief: brief ? { ...brief, stale: briefStale } : null,
      nextAction: nextActionFor({ project, brief, briefStale, ideas }),
      ideas,
      knowledge: {
        experiences: 0,
        knowledge: knowledge.length,
        verified: knowledge.filter((entry) => entry.status === 'verified').length,
        candidates: 0,
        pendingHarvest: 0,
        usages: 0,
        sharedKnowledge: 0
      },
      knowledgeItems: knowledge.slice(0, 10),
      diagrams
    };
  },

  async 'owner/brief/refresh'(params) {
    const data = await getStore();
    const project = data.getProject(String(params?.projectId || ''));
    if (!project) throw fail('项目不存在', 404);
    const libs = await loadLibs();
    const scan = await libs.scanModule.scanProject(project.root);
    const brief = libs.briefModule.buildQuickBrief(scan);
    data.saveBrief(project.id, brief);
    return { project, brief };
  },

  async 'owner/ideas/list'(params) {
    const data = await getStore();
    return { ideas: data.listIdeas(String(params?.projectId || ''), String(params?.status || '')) };
  },

  async 'owner/ideas/add'(params) {
    const data = await getStore();
    const projectId = String(params?.projectId || '');
    if (!data.getProject(projectId)) throw fail('项目不存在', 404);
    const title = String(params?.title || '').trim();
    if (!title) throw fail('想法内容不能为空', 400);
    return data.addIdea({ projectId, title, body: String(params?.body || ''), source: 'cindy' });
  },

  async 'owner/ideas/status'(params) {
    const data = await getStore();
    return data.updateIdea(String(params?.id || ''), { status: String(params?.status || '') });
  },

  async 'owner/ideas/remove'(params) {
    const data = await getStore();
    return data.removeIdea(String(params?.id || ''));
  },

  async 'owner/knowledge/list'(params) {
    const data = await getStore();
    return { items: data.listKnowledge(String(params?.projectId || '')) };
  },

  async 'owner/knowledge/add'(params) {
    const data = await getStore();
    const projectId = String(params?.projectId || '');
    if (!data.getProject(projectId)) throw fail('项目不存在', 404);
    const title = String(params?.title || '').trim();
    if (!title) throw fail('知识标题不能为空', 400);
    return data.addKnowledge({
      projectId,
      title,
      body: String(params?.body || ''),
      tags: params?.tags ?? [],
      source: 'cindy'
    });
  },

  async 'owner/diagrams/dependency'(params) {
    const data = await getStore();
    const project = data.getProject(String(params?.projectId || ''));
    if (!project) throw fail('项目不存在', 404);
    const libs = await loadLibs();
    const diagram = await libs.diagramModule.scanDependencyGraph(project.root);
    const saved = data.saveDiagram(project.id, {
      kind: 'dependency',
      title: diagram.title,
      summary: diagram.summary,
      mermaid: diagram.mermaid,
      data: diagram.data,
      source: 'local-scan',
      basedOnCommit: await gitHead(project.root)
    });
    return saved;
  },

  async 'owner/diagrams/list'(params) {
    const data = await getStore();
    return { items: data.listDiagrams(String(params?.projectId || '')) };
  }
};

const reply = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

// 串行处理：避免两条请求同时写同一个 JSON 文件。
let queue = Promise.resolve();

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  queue = queue.then(async () => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }
    const handler = methods[request?.method];
    if (!handler) {
      reply({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
      return;
    }
    try {
      const result = await handler(request.params ?? {});
      reply({ jsonrpc: '2.0', id: request.id, result });
    } catch (error) {
      reply({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32000, message: String(error?.message ?? error) }
      });
    }
  });
});
