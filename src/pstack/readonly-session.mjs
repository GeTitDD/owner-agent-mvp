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
export function createReadonlySessionFactory({ playbook, skillsDir } = {}) {
  const skill = readSkillBody(skillsDir, playbook?.id ?? '');
  const directive = [
    'You are a read-only project analyst for Owner Companion.',
    'You may inspect the repository with read, grep, find and ls only.',
    'You cannot write files, run commands, or access the network. If a step would need that, say so instead of guessing.',
    'Ground every claim in something you actually read; cite `path` or `path:line`.',
    'Never invent files, commands, metrics or test results.',
    skill.body ? `\n# pstack skill: ${playbook.id}\n${skill.body}` : ''
  ].join('\n');

  return {
    requiresModel: true,
    skillsDir,
    skillSource: skill.source,
    skillHashInput: skill.hashInput,
    async create({ cwd, model, signal } = {}) {
      const sdk = await import('@earendil-works/pi-coding-agent');
      const agentDir = mkdtempSync(path.join(os.tmpdir(), 'owner-playbook-agent-'));
      const created = (async () => {
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
          const { session } = await sdk.createAgentSession({
            cwd,
            tools: [...READONLY_TOOLS],
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
            throw new Error('readonly-tools-unverified');
          }
          const unexpected = active.filter((name) => !READONLY_TOOLS.includes(name));
          if (unexpected.length) {
            session.dispose?.();
            throw new Error(`readonly-tools-violation: ${unexpected.join(',')}`);
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
                try { rmSync(agentDir, { recursive: true, force: true }); } catch { /* 最佳努力清理 */ }
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
