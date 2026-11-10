// pstack Playbook 的只读 Pi 会话。
//
// 与 DefaultPiSessionFactory 相同的隔离策略（每次一个空 agentDir、不加载全局扩展/
// 项目扩展/上下文文件），但显式放行 read/grep/find/ls 四个只读工具，并把目标
// pstack Skill 的正文注入 system prompt。
//
// 不变量：写文件、执行命令、联网的工具一律不注册；创建后再次核对 activeTools，
// 出现任何非白名单工具就中止（fail closed）。
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { resolvePiModel } from '../pi-model-catalog.mjs';
import { READONLY_TOOLS, FORBIDDEN_TOOLS } from './playbooks.mjs';

// pstack skills 目录：与 Knowledge Harvest 共用同一套解析规则。
export function resolvePstackSkillsDir(explicit = process.env.PSTACK_DIR) {
  const candidates = [
    explicit ? path.join(explicit, 'skills') : '',
    explicit ?? '',
    path.resolve(process.cwd(), '..', 'pstack-pi', 'skills'),
    'D:\\nautilus_trader\\.tmp\\opencode\\pstack-pi\\skills'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && existsSync(path.join(candidate, 'poteto-mode', 'SKILL.md'))) return candidate;
    } catch { /* 继续找下一个候选目录 */ }
  }
  return null;
}

/** 读取某个 playbook 对应的 SKILL.md 正文（去掉 front-matter），限制长度。 */
export function readSkillBody(skillsDir, skillId, maxChars = 6000) {
  if (!skillsDir) return { body: '', source: '', hashInput: '' };
  const file = path.join(skillsDir, skillId, 'SKILL.md');
  if (!existsSync(file)) return { body: '', source: file, hashInput: '' };
  const raw = readFileSync(file, 'utf8');
  const withoutFrontMatter = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '');
  const body = withoutFrontMatter.trim();
  return {
    body: body.length > maxChars ? `${body.slice(0, maxChars)}\n…（已截断）` : body,
    source: file,
    hashInput: raw
  };
}

/** 只读会话工厂。skillsDir/skillBody 由调用方注入，便于测试。 */
export function createReadonlySessionFactory({ playbook, skillsDir, python = false, noTools = false } = {}) {
  const skill = readSkillBody(skillsDir, playbook?.id ?? '');
  const directive = [
    'You are a read-only project analyst for Owner Companion.',
    noTools
      ? 'This run has NO tools. Answer only from the provided digest; mark anything outside it as unknown.'
      : 'You may inspect the repository with read, grep, find and ls only.',
    python && !noTools
      ? 'You may also run own_python: a restricted Python 3.14 subset with the repository mounted READ-ONLY at /workspace. No third-party packages, class inheritance, generators, @classmethod/property, del, or network.'
      : '',
    'You cannot write files, run commands, or access the network. If a step would need that, say so instead of guessing.',
    'Ground every claim in something you actually read; cite `path` or `path:line`.',
    'Never invent files, commands, metrics or test results.',
    skill.body ? `\n# pstack skill: ${playbook.id}\n${skill.body}` : ''
  ].filter(Boolean).join('\n');

  return {
    requiresModel: true,
    skillsDir,
    skillSource: skill.source,
    skillHashInput: skill.hashInput,
    async create({ cwd, model, signal } = {}) {
      const sdk = await import('@earendil-works/pi-coding-agent');
      const agentDir = mkdtempSync(path.join(os.tmpdir(), 'owner-playbook-agent-'));
      const created = (async () => {
        let pyRunner = null;
        if (python && !noTools) {
          try {
            const { createMontyRunner } = await import('../monty-runner.mjs');
            pyRunner = await createMontyRunner({ cwd, mode: 'read-only' });
          } catch {
            pyRunner = null;
          }
        }
        const allowedTools = noTools ? [] : [...READONLY_TOOLS, ...(pyRunner ? ['own_python'] : [])];
        const loader = new sdk.DefaultResourceLoader({
          cwd,
          agentDir,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          appendSystemPrompt: [directive]
        });
        try {
          await loader.reload();
          const customTools = [];
          if (pyRunner) {
            const { Type } = await import('typebox');
            customTools.push({
              name: 'own_python',
              label: 'own_python',
              description: 'Run Python in an isolated interpreter. The repository is mounted READ-ONLY at /workspace. No network, no environment variables, restricted Python 3.14 subset.',
              promptSnippet: 'Run read-only Python against the repository',
              promptGuidelines: [
                'Use own_python only for deterministic computation or statistics over files you have read.',
                'No third-party packages, no class inheritance, no generators, no del.'
              ],
              parameters: Type.Object({
                code: Type.String({ description: 'Python source to execute inside the sandbox' })
              }),
              async execute(_toolCallId, { code }) {
                const { output, result } = await pyRunner.run(code);
                const text = [
                  output ? `--- stdout ---\n${output}` : '',
                  result ? `--- result ---\n${result}` : ''
                ].filter(Boolean).join('\n') || '(no output)';
                return { content: [{ type: 'text', text }] };
              }
            });
          }
          const { session } = await sdk.createAgentSession({
            cwd,
            tools: allowedTools,
            ...(customTools.length ? { customTools } : {}),
            excludeTools: [...FORBIDDEN_TOOLS],
            sessionManager: sdk.SessionManager.inMemory(),
            resourceLoader: loader,
            ...(model ? { model: resolvePiModel(model) } : {})
          });
          // 二次核对：只读白名单之外出现任何工具都直接失败。
          const active = typeof session.getActiveToolNames === 'function'
            ? [...session.getActiveToolNames()]
            : null;
          if (active === null) {
            session.dispose?.();
            await pyRunner?.close();
            throw new Error('readonly-tools-unverified');
          }
          const unexpected = active.filter((name) => !allowedTools.includes(name));
          if (unexpected.length) {
            session.dispose?.();
            await pyRunner?.close();
            throw new Error(`readonly-tools-violation: ${unexpected.join(',')}`);
          }
          let disposed = false;
          const lastMessage = () => {
            const messages = session.messages ?? [];
            const last = messages[messages.length - 1];
            if (!last) return null;
            return {
              role: last.role ?? last.type ?? 'unknown',
              stopReason: last.stopReason ?? null,
              errorMessage: last.errorMessage ?? null,
              hasText: Array.isArray(last.content)
                ? last.content.some((part) => part?.type === 'text' && String(part.text ?? '').trim())
                : Boolean(String(last.content ?? '').trim())
            };
          };
          return {
            sessionId: () => String(session.sessionId ?? ''),
            prompt: (value) => session.prompt(value),
            abort: () => session.abort?.(),
            activeTools: () => active,
            lastMessage,
            getLastText: () => String(session.getLastAssistantText?.() ?? ''),
            get model() { return session.model ? `${session.model.provider}/${session.model.id}` : 'unknown'; },
            dispose() {
              if (disposed) return;
              disposed = true;
              try { session.dispose?.(); } finally {
                if (pyRunner) pyRunner.close().catch(() => {});
                try { rmSync(agentDir, { recursive: true, force: true }); } catch { /* 最佳努力清理 */ }
              }
            }
          };
        } catch (error) {
          try { await pyRunner?.close(); } catch { /* ignore */ }
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
