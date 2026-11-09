// WriterAgent：受控的“写入子 Agent”。
//
// 目标：Owner 默认没有写能力；当任务确实需要写文件时，交给一个只读+受限写入的子 Agent，
// 在**一次性 git worktree** 里改文件，宿主再把 diff 变成待审批的 PatchProposal。
//
// 安全不变量：
// - 只在隔离 worktree 内运行，真实项目目录不可见；
// - 工具是自定义的 own_* 版本，所有 path 参数都限制在 worktree 内（拒绝绝对路径与 ..，
//   存在路径还会做 realpath 校验，防止符号链接逃逸）；
// - 没有 bash / powershell / 网络工具；
// - Agent 只“写文件”，不执行任何命令；宿主随后用 git status 采集变更并交给既有审批链。
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, realpathSync, statSync, mkdirSync } from 'node:fs';
import { resolvePiModel } from './pi-model-catalog.mjs';
import { PATCH_LIMITS } from './patch-protocol.mjs';

const WRITER_TOOL_NAMES = Object.freeze([
  'own_read', 'own_write', 'own_edit', 'own_ls', 'own_find', 'own_grep'
]);

const realpathNative = (value) => {
  try {
    return (realpathSync.native ?? realpathSync)(value);
  } catch {
    return path.resolve(value);
  }
};

const normalizeCase = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);

const inside = (root, target) => {
  const realRoot = normalizeCase(realpathNative(root));
  let probe = path.resolve(target);
  const tail = [];
  // 目标文件可能尚不存在：向上找到最近的存在祖先做 realpath，再拼回剩余段。
  while (!existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    tail.unshift(path.basename(probe));
    probe = parent;
  }
  const resolved = normalizeCase(path.join(realpathNative(probe), ...tail));
  return resolved === realRoot || resolved.startsWith(`${realRoot}${path.sep}`);
};

const confine = (root, value) => {
  const input = String(value ?? '.').trim() || '.';
  // 绝对路径一律拒绝：写入子 Agent 只认 workspace 相对路径。
  if (path.isAbsolute(input)) throw new Error('path outside workspace');
  const absolute = path.resolve(root, input);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('path outside workspace');
  if (!inside(root, absolute)) throw new Error('path outside workspace');
  return relative || '.';
};

const confineTool = (base, name, root) => ({
  ...base,
  name,
  label: name,
  description: `${base.description} Paths are confined to the isolated workspace.`,
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const next = { ...(params ?? {}) };
    if (typeof next.path === 'string' && next.path.trim()) next.path = confine(root, next.path);
    return base.execute(toolCallId, next, signal, onUpdate, { ...ctx, cwd: root });
  }
});

export function createWriterSessionFactory({ model = '' } = {}) {
  return {
    requiresModel: true,
    async create({ cwd, signal } = {}) {
      const sdk = await import('@earendil-works/pi-coding-agent');
      const agentDir = mkdtempSync(path.join(os.tmpdir(), 'owner-writer-agent-'));
      const created = (async () => {
        const loader = new sdk.DefaultResourceLoader({
          cwd,
          agentDir,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          appendSystemPrompt: [
            'You are a contained writing sub-agent for Owner.',
            'You may only modify files inside the isolated workspace using the own_write / own_edit tools.',
            'Paths are workspace-relative; absolute paths and .. are rejected.',
            'You cannot run commands or access the network. Do not attempt to.',
            'Make the smallest coherent change. When finished, stop; the host will collect the diff and ask the Owner for approval.'
          ]
        });
        try {
          await loader.reload();
          const customTools = [
            confineTool(sdk.createReadToolDefinition(cwd), 'own_read', cwd),
            confineTool(sdk.createWriteToolDefinition(cwd), 'own_write', cwd),
            confineTool(sdk.createEditToolDefinition(cwd), 'own_edit', cwd),
            confineTool(sdk.createLsToolDefinition(cwd), 'own_ls', cwd),
            confineTool(sdk.createFindToolDefinition(cwd), 'own_find', cwd),
            confineTool(sdk.createGrepToolDefinition(cwd), 'own_grep', cwd)
          ];
          const { session } = await sdk.createAgentSession({
            cwd,
            tools: [...WRITER_TOOL_NAMES],
            customTools,
            sessionManager: sdk.SessionManager.inMemory(),
            resourceLoader: loader,
            ...(model ? { model: resolvePiModel(model) } : {})
          });
          const active = typeof session.getActiveToolNames === 'function'
            ? [...session.getActiveToolNames()]
            : null;
          if (!active || WRITER_TOOL_NAMES.some((name) => !active.includes(name))) {
            session.dispose?.();
            throw new Error('writer tools are not active');
          }
          const unexpected = active.filter((name) => !WRITER_TOOL_NAMES.includes(name));
          if (unexpected.length) {
            session.dispose?.();
            throw new Error(`writer tools outside allowlist: ${unexpected.join(',')}`);
          }
          let disposed = false;
          return {
            sessionId: () => String(session.sessionId ?? ''),
            prompt: (value) => session.prompt(value),
            abort: () => session.abort?.(),
            activeTools: () => active,
            getLastText: () => String(session.getLastAssistantText?.() ?? ''),
            get model() { return session.model ? `${session.model.provider}/${session.model.id}` : 'unknown'; },
            dispose() {
              if (disposed) return;
              disposed = true;
              try { session.dispose?.(); } finally {
                try { rmSync(agentDir, { recursive: true, force: true }); } catch { /* best effort */ }
              }
            }
          };
        } catch (error) {
          try { rmSync(agentDir, { recursive: true, force: true }); } catch { /* ignore */ }
          throw error;
        }
      })();
      if (signal) {
        const disposeLate = () => {
          created.then((session) => { try { session.abort?.(); } catch { /* ignore */ } session.dispose(); })
            .catch(() => { try { rmSync(agentDir, { recursive: true, force: true }); } catch { /* ignore */ } });
        };
        if (signal.aborted) disposeLate();
        else signal.addEventListener('abort', disposeLate, { once: true });
      }
      return created;
    }
  };
}

const gitStatus = (cwd) => {
  const output = execFileSync('git', ['-C', cwd, 'status', '--porcelain', '-z', '--untracked-files=all'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
  const entries = [];
  for (const chunk of output.split('\0')) {
    if (!chunk) continue;
    const code = chunk.slice(0, 2);
    const file = chunk.slice(3);
    entries.push({ code, file });
  }
  return entries;
};

export class WriterAgent {
  constructor({
    model = '',
    timeoutMs = 180000,
    maxFiles = PATCH_LIMITS.maxFiles,
    maxFileBytes = PATCH_LIMITS.maxFileBytes,
    sessionFactory = null
  } = {}) {
    this.requiresModel = true;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.maxFiles = maxFiles;
    this.maxFileBytes = maxFileBytes;
    this.sessionFactory = sessionFactory ?? createWriterSessionFactory({ model });
  }

  /** 在给定的隔离 worktree 里执行一次写入任务，返回可被 PatchCodingWorker 校验的文件列表。 */
  async generate({ cwd, signal, taskTitle = '', taskNote = '', focus = '', material = [] }) {
    if (!cwd) throw new Error('cwd is required');
    const materialText = (material ?? [])
      .map((item) => `--- ${item.path} ---\n${String(item.content ?? '').slice(0, 8000)}`)
      .join('\n');
    const prompt = [
      '在隔离 worktree 内完成下面的写入任务。',
      `任务：${String(taskTitle).slice(0, 200)}`,
      taskNote ? `说明：${String(taskNote).slice(0, 800)}` : '',
      focus ? `关注点：${String(focus).slice(0, 300)}` : '',
      '约束：',
      '1. 只改与任务直接相关的文件，保持最小 diff；不要动 .git。',
      '2. 只使用 own_read / own_write / own_edit / own_ls / own_find / own_grep。',
      '3. 不要执行命令，不要访问网络。',
      '4. 完成后停止，不需要输出补丁，宿主会自动收集。',
      materialText ? `\n参考材料（可能不完整，可用 own_read 继续读）：\n${materialText}` : ''
    ].filter(Boolean).join('\n');

    const session = await this.sessionFactory.create({ cwd, signal });
    let timer = null;
    try {
      const timedOut = new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { session.abort?.(); } catch { /* ignore */ }
          reject(Object.assign(new Error('writer timeout'), { name: 'TimeoutError' }));
        }, this.timeoutMs);
      });
      await Promise.race([session.prompt(prompt), timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
      try { session.dispose(); } catch { /* ignore */ }
    }

    const entries = gitStatus(cwd);
    if (entries.length === 0) {
      throw Object.assign(new Error('writer produced no file changes'), { category: 'empty-write' });
    }
    const files = [];
    for (const entry of entries) {
      if (entry.code.includes('D') || entry.code.includes('R')) {
        throw Object.assign(new Error('writer deleted or renamed a file; not supported'), { category: 'unsafe-change' });
      }
      const relative = confine(cwd, entry.file);
      const absolute = path.resolve(cwd, relative);
      const stat = statSync(absolute);
      if (!stat.isFile()) {
        throw Object.assign(new Error('writer produced a directory entry'), { category: 'invalid-proposal' });
      }
      if (stat.size > this.maxFileBytes) {
        throw Object.assign(new Error('written file exceeds size limit'), { category: 'invalid-proposal' });
      }
      const action = entry.code.includes('?') || entry.code.includes('A') ? 'add' : 'modify';
      files.push({
        path: relative.split(path.sep).join('/'),
        action,
        content: readFileSync(absolute, 'utf8')
      });
    }
    if (files.length > this.maxFiles) {
      throw Object.assign(new Error('writer changed too many files'), { category: 'invalid-proposal' });
    }
    // 校验与后续 apply 都以“base 状态”为前提：捕获内容后把 worktree 还原，
    // 否则 add 会被判成“目标已存在”，modify 会被判成“没有变化”。
    try {
      execFileSync('git', ['-C', cwd, 'checkout', '--', '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
      execFileSync('git', ['-C', cwd, 'clean', '-fd'], { stdio: ['ignore', 'pipe', 'pipe'] });
      // 新增文件所在的目录在 base 里可能不存在：补建目录，让校验与 apply 都能按 add 处理。
      for (const file of files) {
        if (file.action !== 'add') continue;
        mkdirSync(path.dirname(path.join(cwd, file.path)), { recursive: true });
      }
    } catch (error) {
      throw Object.assign(new Error(`writer workspace could not be restored: ${error.message}`), { category: 'workspace-error' });
    }
    return { model: this.model || 'unknown', files };
  }
}
