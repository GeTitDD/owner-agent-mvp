// 只读的 Knowledge Harvest Pi Session。
//
// 与 DefaultPiSessionFactory 相同的隔离策略（empty agentDir、noTools、无项目扩展），
// 但额外加载 pstack 的 skill 目录，并把 EDAE/Reflect 纪律写入 system prompt。
// 不自动修改 pstack Skill，也不允许写文件或执行命令。
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolvePiModel } from '../pi-model-catalog.mjs';

export const HARVEST_DISCIPLINE = [
  'You are a read-only knowledge harvester. You cannot write files, run commands, or access the network.',
  'Follow the pstack EDAE discipline: define boundaries, establish verification evidence, investigate, implement only as structured knowledge, verify behavior, and feed back lessons.',
  'Apply the three Reflect lenses: judgment (is the claim justified?), tooling (is the mechanism reproducible?), and divergent (what counterexample would break it?).',
  'Separate observed facts from inferences and unknowns. A passing test is the only evidence of success; model self-report is not.',
  'Prefer a narrow, testable claim with explicit applicability and exceptions over a broad slogan.',
  'If the evidence is insufficient, return no candidate rather than guessing.'
].join('\n');

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
    } catch { /* keep looking */ }
  }
  return null;
}

export function createHarvestSessionFactory({ pstackDir = process.env.PSTACK_DIR } = {}) {
  const skillsDir = resolvePstackSkillsDir(pstackDir);
  return {
    requiresModel: true,
    skillsDir,
    async create({ cwd, model, signal } = {}) {
      const sdk = await import('@earendil-works/pi-coding-agent');
      const agentDir = mkdtempSync(path.join(os.tmpdir(), 'owner-harvest-agent-'));
      const created = (async () => {
        const loader = new sdk.DefaultResourceLoader({
          cwd,
          agentDir,
          noExtensions: true,
          noSkills: true,
          additionalSkillPaths: skillsDir ? [skillsDir] : [],
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          appendSystemPrompt: [HARVEST_DISCIPLINE]
        });
        try {
          await loader.reload();
          const { session } = await sdk.createAgentSession({
            cwd,
            noTools: true,
            sessionManager: sdk.SessionManager.inMemory(),
            resourceLoader: loader,
            ...(model ? { model: resolvePiModel(model) } : {})
          });
          let disposed = false;
          return {
            sessionId: () => String(session.sessionId ?? ''),
            prompt: (value) => session.prompt(value),
            abort: () => session.abort?.(),
            activeTools: () => typeof session.getActiveToolNames === 'function'
              ? [...session.getActiveToolNames()]
              : null,
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
