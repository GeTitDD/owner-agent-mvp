// Owner Companion 的 MCP 服务：把现有 Node worker 的工具暴露给 OpenClaw。
//
// 为什么这样做：
// - Owner 的数据、扫描、画像、图谱、GitHub、补丁、测试都已经在 worker 里；
// - OpenClaw 支持 stdio MCP server，Telegram / Control UI 里的 Agent 都能直接调用；
// - 这里只做协议转换和结果裁剪，不复制业务逻辑。
//
// 运行位置：Windows 上的 Node（由 WSL 里的 OpenClaw 通过 /mnt/c/... 启动），
// 因此项目路径、~/.owner-companion 都与现有数据完全一致，不需要路径翻译。

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPanel } from './panel.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const workerPath = path.join(repoRoot, 'plugins', 'owner-companion', 'node', 'worker.cjs');
const manifestPath = path.join(repoRoot, 'plugins', 'owner-companion', 'ghost.json');
const SERVER_VERSION = '0.1.0';

const workerEnv = {
  ...process.env,
  OWNER_COMPANION_DIR: process.env.OWNER_COMPANION_DIR
    || path.join(process.env.USERPROFILE || 'C:\\Users\\Administrator', '.owner-companion')
};

// ---- worker 子进程：把 MCP 调用转成 worker 的 JSON-RPC ----
let child = null;
let seq = 0;
const pending = new Map();

const startWorker = () => {
  if (child && !child.killed) return child;
  child = spawn(process.execPath, [workerPath], {
    cwd: repoRoot,
    env: workerEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(String(message.error.message || 'worker error')));
    else entry.resolve(message.result);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[owner-worker] ${chunk}`);
  });
  child.on('exit', () => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('worker 已退出'));
    }
    pending.clear();
    child = null;
  });
  return child;
};

const callWorker = (method, params = {}, timeoutMs = 30000) => new Promise((resolve, reject) => {
  const proc = startWorker();
  const id = ++seq;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`worker 超时：${method}`));
  }, timeoutMs);
  pending.set(id, { resolve, reject, timer });
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});

const panel = createPanel({ callWorker });

// ---- 工具定义（描述面向聊天场景：让 Agent 简短总结，而不是贴 JSON） ----
const ghost = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const ghostTools = new Map((ghost.tools || []).map((tool) => [tool.name, tool]));

const extraTools = [
  {
    name: 'owner_experience_list',
    description: '列出项目记录的原始经验（可只看未提炼的）。只读。',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '项目 id' },
        distilled: { type: 'boolean', description: 'true 只看已提炼，false 只看未提炼' }
      }
    },
    method: 'owner/experiences/list'
  },
  {
    name: 'owner_diagrams',
    description: '列出项目已有的图（依赖图 / 控制流 / 数据流 / 时序 / 状态机）。只读。',
    parameters: {
      type: 'object',
      properties: { projectId: { type: 'string', description: '项目 id' } }
    },
    method: 'owner/diagrams/list'
  },
  {
    name: 'owner_patches',
    description: '列出项目的补丁提案（默认待审核）。只读。',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '项目 id' },
        status: { type: 'string', description: 'pending / applied / rejected，默认 pending' }
      }
    },
    method: 'owner/patches/list'
  },
  {
    name: 'owner_idea_remove',
    description: '删除一条想法。用户明确说要删时才调用。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '想法 id' } },
      required: ['id']
    },
    method: 'owner/ideas/remove'
  },
  {
    name: 'owner_knowledge_review',
    description: '审核知识候选：接受（转为未验证）或拒绝。用户要求时调用。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '知识条目 id' },
        decision: { type: 'string', description: 'accept / reject' }
      },
      required: ['id', 'decision']
    },
    method: 'owner/knowledge/review'
  },
  {
    name: 'owner_knowledge_verify',
    description: '把一条未验证知识标记为已验证。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '知识条目 id' } },
      required: ['id']
    },
    method: 'owner/knowledge/verify'
  },
  {
    name: 'owner_patch_propose_worktree',
    description: '把项目工作区当前改动（相对 HEAD 的 git diff）保存为待审核补丁提案。只读工作区，不改文件。',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '项目 id' },
        title: { type: 'string', description: '提案标题，可省略' }
      }
    },
    method: 'owner/patches/propose-worktree'
  },
  {
    name: 'owner_patch_apply',
    description: '把一条待审核补丁应用到项目工作区。危险操作，必须先把补丁内容告诉用户并得到明确同意，且 confirm 传 true。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '补丁 id' },
        confirm: { type: 'boolean', description: '用户已明确同意时传 true' }
      },
      required: ['id', 'confirm']
    },
    method: 'owner/patches/apply'
  },
  {
    name: 'owner_patch_reject',
    description: '拒绝一条待审核补丁。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '补丁 id' },
        note: { type: 'string', description: '拒绝原因，可省略' }
      },
      required: ['id']
    },
    method: 'owner/patches/reject'
  },
  {
    name: 'owner_github_pr',
    description: '把当前分支推上去并创建草稿 PR。危险操作，必须先把分支和标题告诉用户并得到明确同意，且 confirm 传 true。',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '项目 id' },
        base: { type: 'string', description: '目标分支，默认 main' },
        title: { type: 'string', description: 'PR 标题' },
        body: { type: 'string', description: 'PR 说明' },
        confirm: { type: 'boolean', description: '用户已明确同意时传 true' }
      },
      required: ['projectId', 'confirm']
    },
    method: 'owner/github/pr/create'
  },
  {
    name: 'owner_project_add',
    description: '登记一个本地项目目录。用户给出绝对路径时调用。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '项目根目录绝对路径' },
        name: { type: 'string', description: '显示名，可省略' }
      },
      required: ['path']
    },
    method: 'owner/projects/add'
  },
  {
    name: 'owner_project_remove',
    description: '从 Owner 里移除一个项目（不删磁盘文件）。用户明确要求时调用。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '项目 id' } },
      required: ['id']
    },
    method: 'owner/projects/remove'
  },
  {
    name: 'owner_tests',
    description: '列出项目最近的测试运行记录。只读。',
    parameters: {
      type: 'object',
      properties: { projectId: { type: 'string', description: '项目 id' } }
    },
    method: 'owner/tests/list'
  }
];

const methods = {
  owner_projects: 'owner/projects/list',
  owner_project_overview: 'owner/projects/overview',
  owner_brief_refresh: 'owner/brief/refresh',
  owner_ideas: 'owner/ideas/list',
  owner_idea_add: 'owner/ideas/add',
  owner_idea_status: 'owner/ideas/status',
  owner_knowledge: 'owner/knowledge/list',
  owner_knowledge_add: 'owner/knowledge/add',
  owner_knowledge_propose: 'owner/knowledge/propose',
  owner_knowledge_tidy: 'owner/knowledge/tidy',
  owner_knowledge_search: 'owner/knowledge/search',
  owner_experience_add: 'owner/experiences/add',
  owner_diagram: 'owner/diagrams/dependency',
  owner_github_status: 'owner/github/status',
  owner_patch_propose: 'owner/patches/propose',
  owner_test_run: 'owner/tests/run'
};
for (const tool of extraTools) methods[tool.name] = tool.method;

const toolList = [];
for (const [name, method] of Object.entries(methods)) {
  const declared = ghostTools.get(name);
  const extra = extraTools.find((tool) => tool.name === name);
  const description = declared?.description || extra?.description || name;
  const parameters = declared?.parameters || extra?.parameters || {
    type: 'object',
    properties: {},
    additionalProperties: true
  };
  toolList.push({
    name,
    description: `${description} 适合在聊天里用简短中文总结，不要贴原始 JSON。`,
    inputSchema: parameters
  });
}

toolList.push({
  name: 'owner_panel',
  description: '打开或刷新 Owner 的 Telegram 按钮面板。用户说「打开 Owner 面板 / 项目面板」时调用；收到以 callback_data: owner: 开头的消息时，把整串传给 callback 参数；面板提示「请直接发消息」时，把用户下一条文本传给 text 参数。',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'menu / open / overview / ideas / knowledge / diagrams / github / tests / patches / projects / scan 等' },
      projectId: { type: 'string', description: '项目 id' },
      id: { type: 'string', description: '条目 id（想法 / 知识 / 补丁）' },
      callback: { type: 'string', description: 'card-action 原文，例如 owner:overview:cultivation-agent' },
      text: { type: 'string', description: '面板等待输入时，用户发来的文本' }
    }
  }
});

// ---- 结果裁剪：Telegram / 手机上下文有限 ----
const clip = (value, max) => {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const slim = (name, result) => {
  if (!result || typeof result !== 'object') return result;
  if (name === 'owner_projects') {
    return { projects: (result.projects || []).map((p) => ({ id: p.id, name: p.name, root: p.root })) };
  }
  if (name === 'owner_project_overview') {
    return {
      project: result.project,
      activeProjectId: result.activeProjectId,
      oneLiner: result.brief?.oneLiner,
      howToRun: (result.brief?.howToRun || []).slice(0, 4),
      risks: (result.brief?.risks || []).slice(0, 3),
      stale: result.brief?.stale,
      nextAction: result.nextAction,
      counts: result.knowledge,
      ideas: (result.ideas || []).slice(0, 8).map((idea) => ({
        id: idea.id, title: idea.title, status: idea.status
      })),
      diagrams: (result.diagrams || []).map((d) => ({
        kind: d.kind, title: d.title, version: d.version
      }))
    };
  }
  if (name === 'owner_ideas') {
    return { ideas: (result.ideas || []).map((idea) => ({
      id: idea.id, title: idea.title, status: idea.status, source: idea.source
    })) };
  }
  if (name === 'owner_knowledge') {
    return {
      items: (result.items || []).slice(0, 15).map((entry) => ({
        id: entry.id, title: entry.title, status: entry.status, tags: entry.tags
      })),
      experiences: (result.experiences || []).slice(0, 10).map((entry) => ({
        id: entry.id, text: clip(entry.text, 160), distilled: entry.distilled
      }))
    };
  }
  if (name === 'owner_diagram') {
    return {
      kind: result.kind,
      summary: result.summary,
      version: result.version,
      mermaid: clip(result.mermaid, 8000)
    };
  }
  if (name === 'owner_github_status') {
    return {
      repo: result.repo,
      branch: result.preview?.branch,
      clean: result.preview?.clean,
      issues: (result.issues || []).slice(0, 5).map((i) => ({
        number: i.number, title: i.title, state: i.state
      })),
      prs: (result.prs || []).slice(0, 5).map((p) => ({
        number: p.number, title: p.title, draft: p.draft, state: p.state
      }))
    };
  }
  if (name === 'owner_test_run') {
    return {
      ok: result.ok,
      command: result.command,
      durationMs: result.durationMs,
      output: clip(result.output, 2500)
    };
  }
  if (name === 'owner_patches') {
    return { items: (result.items || []).map((entry) => ({
      id: entry.id, title: entry.title, status: entry.status, createdAt: entry.createdAt
    })) };
  }
  if (name === 'owner_tests') {
    return { items: (result.items || []).slice(0, 5).map((entry) => ({
      ok: entry.ok, command: entry.command, durationMs: entry.durationMs, at: entry.at
    })) };
  }
  if (name === 'owner_patch_propose_worktree' || name === 'owner_patch_apply' || name === 'owner_patch_reject') {
    return { id: result.id, title: result.title, status: result.status };
  }
  if (name === 'owner_knowledge_review' || name === 'owner_knowledge_verify') {
    return { id: result.id, title: result.title, status: result.status };
  }
  if (name === 'owner_github_pr') {
    return { ok: result.ok, repo: result.repo, branch: result.branch, url: result.url };
  }
  return result;
};

// ---- MCP stdio 协议 ----
const send = (payload) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

const handleToolCall = async (id, params) => {
  const name = String(params?.name || '');
  const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
  if (name === 'owner_panel') {
    const result = await panel.handle(args);
    reply(id, {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: result.ok !== true
    });
    return;
  }
  const method = methods[name];
  if (!method) {
    replyError(id, -32602, `未知工具：${name}`);
    return;
  }
  // 危险工具必须有显式 confirm，避免 Agent 自己脑补「用户同意了」。
  if ((name === 'owner_patch_apply' || name === 'owner_github_pr') && args.confirm !== true) {
    reply(id, {
      content: [{ type: 'text', text: '需要 confirm: true；先向用户说明将发生什么并得到明确同意。' }],
      isError: true
    });
    return;
  }
  const timeout = name === 'owner_test_run' ? 180000 : 30000;
  const payload = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined && value !== null) payload[key] = value;
  }
  try {
    const result = await callWorker(method, payload, timeout);
    const text = JSON.stringify(slim(name, result));
    reply(id, {
      content: [{ type: 'text', text: clip(text, 12000) }],
      isError: false
    });
  } catch (error) {
    reply(id, {
      content: [{ type: 'text', text: `工具执行失败：${String(error?.message ?? error)}` }],
      isError: true
    });
  }
};

const handle = async (message) => {
  const { id, method, params } = message || {};
  if (!method) return;
  if (message.jsonrpc !== '2.0') return;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: String(params?.protocolVersion || '2024-11-05'),
      capabilities: { tools: {} },
      serverInfo: { name: 'owner-companion', version: SERVER_VERSION }
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') {
    reply(id, {});
    return;
  }
  if (method === 'tools/list') {
    reply(id, { tools: toolList });
    return;
  }
  if (method === 'tools/call') {
    await handleToolCall(id, params);
    return;
  }
  if (method === 'resources/list') {
    reply(id, { resources: [] });
    return;
  }
  if (method === 'prompts/list') {
    reply(id, { prompts: [] });
    return;
  }
  replyError(id, -32601, `未知方法：${method}`);
};

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try { message = JSON.parse(text); } catch { return; }
  if (Array.isArray(message)) {
    for (const item of message) void handle(item);
    return;
  }
  void handle(message);
});

rl.on('close', () => {
  child?.kill();
  setTimeout(() => process.exit(0), 50);
});

process.on('SIGINT', () => { child?.kill(); process.exit(0); });
process.on('SIGTERM', () => { child?.kill(); process.exit(0); });
