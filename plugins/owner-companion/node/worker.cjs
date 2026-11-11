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
const PKG_VERSION = '0.4.1';

const libUrl = (name) => pathToFileURL(path.join(__dirname, 'lib', name)).href;
let libsPromise = null;
let store = null;

const loadLibs = async () => {
  libsPromise ??= (async () => {
    const [storeModule, scanModule, briefModule, diagramModule, githubModule, patchModule] = await Promise.all([
      import(libUrl('store.mjs')),
      import(libUrl('scan.mjs')),
      import(libUrl('brief.mjs')),
      import(libUrl('diagrams.mjs')),
      import(libUrl('github.mjs')),
      import(libUrl('patch.mjs'))
    ]);
    return { storeModule, scanModule, briefModule, diagramModule, githubModule, patchModule };
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

let services = null;
const getServices = async () => {
  if (services) return services;
  const libs = await loadLibs();
  services = {
    github: libs.githubModule.createGithub(),
    patch: libs.patchModule.createPatchService(),
    validateDiff: libs.patchModule.validateDiff
  };
  return services;
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

  /** 任务页签上次停留的项目；页面加载时先问它，避免刷新后跳回第一个项目。 */
  async 'owner/projects/focus/get'(params) {
    const data = await getStore();
    return { projectId: data.getFocusedProject(String(params?.sessionId || '')) };
  },

  async 'owner/projects/focus/set'(params) {
    const data = await getStore();
    return data.setFocusedProject(String(params?.sessionId || ''), String(params?.projectId || ''));
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
        knowledge: knowledge.filter((entry) => entry.status === 'unverified' || entry.status === 'verified').length,
        verified: knowledge.filter((entry) => entry.status === 'verified').length,
        unverified: knowledge.filter((entry) => entry.status === 'unverified').length,
        proposed: knowledge.filter((entry) => entry.status === 'proposed').length,
        experiences: data.listExperiences(project.id).length,
        candidates: knowledge.filter((entry) => entry.status === 'proposed').length
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
    const projectId = String(params?.projectId || '');
    const status = String(params?.status || '');
    return {
      items: data.listKnowledge(projectId, status),
      tidy: String(params?.tidy || '') === '1' ? data.tidyKnowledge(projectId) : null,
      experiences: data.listExperiences(projectId).slice(0, 20)
    };
  },

  async 'owner/knowledge/propose'(params) {
    const data = await getStore();
    const projectId = String(params?.projectId || '');
    if (!data.getProject(projectId)) throw fail('项目不存在', 404);
    const title = String(params?.title || '').trim();
    if (!title) throw fail('知识标题不能为空', 400);
    return data.proposeKnowledge({
      projectId,
      title,
      body: String(params?.body || ''),
      tags: params?.tags ?? [],
      evidence: params?.evidence ?? []
    });
  },

  async 'owner/knowledge/review'(params) {
    const data = await getStore();
    const decision = String(params?.decision || '');
    if (!['accept', 'reject'].includes(decision)) throw fail('decision 必须是 accept 或 reject', 400);
    return data.reviewKnowledge(String(params?.id || ''), decision, String(params?.reviewer || 'local-user'));
  },

  async 'owner/knowledge/verify'(params) {
    const data = await getStore();
    return data.verifyKnowledge(String(params?.id || ''));
  },

  async 'owner/knowledge/tidy'(params) {
    const data = await getStore();
    return data.tidyKnowledge(String(params?.projectId || ''));
  },

  async 'owner/knowledge/search'(params) {
    const data = await getStore();
    return { items: data.searchKnowledge(String(params?.query || ''), String(params?.projectId || '')) };
  },

  async 'owner/experiences/list'(params) {
    const data = await getStore();
    const distilled = params?.distilled === undefined ? undefined : params.distilled === true;
    return { items: data.listExperiences(String(params?.projectId || ''), { distilled }) };
  },

  async 'owner/experiences/add'(params) {
    const data = await getStore();
    const projectId = String(params?.projectId || '');
    if (!data.getProject(projectId)) throw fail('项目不存在', 404);
    const text = String(params?.text || '').trim();
    if (!text) throw fail('经验内容不能为空', 400);
    return data.addExperience({
      projectId,
      text,
      outcome: String(params?.outcome || 'unknown'),
      source: 'cindy'
    });
  },

  async 'owner/experiences/distilled'(params) {
    const data = await getStore();
    return data.markExperienceDistilled(String(params?.id || ''));
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
  },

  async 'owner/github/status'(params) {
    const data = await getStore();
    const project = data.getProject(String(params?.projectId || ''));
    if (!project) throw fail('项目不存在', 404);
    const svc = await getServices();
    try {
      const [repo, issues, prs, preview] = await Promise.all([
        svc.github.repoSlug(project.root),
        svc.github.listIssues(project.root, { limit: 5 }),
        svc.github.listPrs(project.root, { limit: 5 }),
        svc.github.preview(project.root)
      ]);
      const value = { ok: true, repo, issues, prs, preview };
      data.setGithub(project.id, value);
      return value;
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  },

  async 'owner/github/pr/create'(params) {
    const data = await getStore();
    const project = data.getProject(String(params?.projectId || ''));
    if (!project) throw fail('项目不存在', 404);
    const svc = await getServices();
    return svc.github.createDraftPr(project.root, {
      base: String(params?.base || 'main'),
      title: String(params?.title || ''),
      body: String(params?.body || ''),
      confirm: params?.confirm === true
    });
  },

  async 'owner/patches/list'(params) {
    const data = await getStore();
    return {
      items: data.listPatches(String(params?.projectId || ''), String(params?.status || ''))
    };
  },

  async 'owner/patches/propose'(params) {
    const data = await getStore();
    const project = data.getProject(String(params?.projectId || ''));
    if (!project) throw fail('项目不存在', 404);
    const svc = await getServices();
    const diff = svc.validateDiff(params?.diff);
    return data.addPatch({
      projectId: project.id,
      title: String(params?.title || '代码改动'),
      diff,
      baseCommit: String(params?.baseCommit || await gitHead(project.root)),
      source: 'cindy'
    });
  },

  async 'owner/patches/apply'(params) {
    const data = await getStore();
    const patch = data.getPatch(String(params?.id || ''));
    if (!patch) throw fail('补丁提案不存在', 404);
    if (patch.status !== 'pending') throw fail('这条提案已经处理过', 409);
    const project = data.getProject(patch.projectId);
    if (!project) throw fail('项目不存在', 404);
    const svc = await getServices();
    await svc.patch.apply(project.root, patch.diff, { baseCommit: patch.baseCommit });
    return data.updatePatch(patch.id, { status: 'applied' });
  },

  async 'owner/patches/reject'(params) {
    const data = await getStore();
    const patch = data.getPatch(String(params?.id || ''));
    if (!patch) throw fail('补丁提案不存在', 404);
    return data.updatePatch(patch.id, { status: 'rejected', note: String(params?.note || '') });
  },

  async 'owner/tests/run'(params) {
    const data = await getStore();
    const project = data.getProject(String(params?.projectId || ''));
    if (!project) throw fail('项目不存在', 404);
    const svc = await getServices();
    const result = await svc.patch.runTests(project.root, {
      command: String(params?.command || ''),
      timeoutMs: Number(params?.timeoutMs) || 120000
    });
    const saved = data.addTestRun({
      projectId: project.id,
      command: result.command,
      ok: result.ok,
      code: result.code ?? 0,
      durationMs: result.durationMs,
      output: result.output
    });
    return saved;
  },

  async 'owner/tests/list'(params) {
    const data = await getStore();
    return { items: data.listTestRuns(String(params?.projectId || '')) };
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
