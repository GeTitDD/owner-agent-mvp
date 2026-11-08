// Knowledge Eval：固定任务、固定模型与测试命令下的 A/B/C 对照。
//
// 评估对象是 Owner Knowledge Loop 的复用效果，不是 pstack 是否执行了 playbook。
// 每个 variant 只改变注入的知识上下文，其他输入保持一致。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { estimateTokens, sha256 } from '../utils.mjs';
import { PatchProposalAgent } from '../patch-proposal-agent.mjs';

const DEFAULT_TEST_COMMAND = ['node', '--test', 'tests/sandbox-smoke.test.mjs'];

function safeJoin(root, relative) {
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`Path escapes task root: ${relative}`);
  return target;
}

function readMaterial(root, allowedPaths) {
  const material = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        if (allowedPaths.some((allowed) => relative === allowed || relative.startsWith(`${allowed.replace(/\/$/u, '')}/`))) walk(absolute);
      } else if (entry.isFile()) {
        if (!allowedPaths.some((allowed) => relative === allowed || relative.startsWith(`${allowed.replace(/\/$/u, '')}/`))) continue;
        const stat = fs.statSync(absolute);
        if (stat.size > 120000) continue;
        material.push({ path: relative, content: fs.readFileSync(absolute, 'utf8') });
      }
    }
  };
  for (const allowed of allowedPaths) {
    const absolute = safeJoin(root, allowed);
    if (!fs.existsSync(absolute)) continue;
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) walk(absolute);
    else if (stat.isFile()) material.push({ path: allowed, content: fs.readFileSync(absolute, 'utf8') });
  }
  return material.slice(0, 40);
}

function applyFiles(root, files) {
  const written = [];
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') throw new Error('Invalid proposal file');
    if (file.action !== 'add' && file.action !== 'modify') throw new Error('Invalid proposal action');
    const target = safeJoin(root, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, 'utf8');
    written.push(file.path);
  }
  return written;
}

function classifyFailure({ exitCode, stdout, stderr }) {
  const text = `${stdout}\n${stderr}`;
  if (exitCode === 0) return 'none';
  if (/ERR_ASSERTION|AssertionError|assert\./u.test(text)) return 'assertion-failure';
  if (/Cannot find module|MODULE_NOT_FOUND/u.test(text)) return 'missing-module';
  if (/SyntaxError/u.test(text)) return 'syntax-error';
  if (/timed out|ETIMEDOUT/u.test(text)) return 'timeout';
  return 'test-failure';
}

export class KnowledgeEvalRunner {
  constructor({ personalStore, proposalAgentFactory = null, model = '', timeoutMs = 180000 } = {}) {
    if (!personalStore) throw new Error('personalStore is required');
    this.personal = personalStore;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.proposalAgentFactory = proposalAgentFactory ?? (() => new PatchProposalAgent({ model, timeoutMs }));
  }

  async runTask({
    taskId, projectRoot, task, allowedPaths = ['src/'], testCommand = DEFAULT_TEST_COMMAND,
    variant = 'baseline', knowledgeContext = '', knowledgeRefs = [], applicability = {}, forcedMisleading = false,
    expectKnowledge = true
  }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `knowledge-eval-${taskId}-`));
    const work = path.join(root, 'project');
    fs.cpSync(projectRoot, work, { recursive: true });
    const started = Date.now();
    let proposal = null;
    let error = null;
    let test = null;
    try {
      const agent = this.proposalAgentFactory();
      const material = readMaterial(work, allowedPaths);
      proposal = await agent.generate({
        cwd: work,
        taskTitle: task,
        taskNote: '',
        focus: task,
        material,
        knowledgeContext
      });
      const written = applyFiles(work, proposal.files ?? []);
      try {
        const stdout = execFileSync(testCommand[0], testCommand.slice(1), {
          cwd: work, encoding: 'utf8', timeout: this.timeoutMs,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        test = { exitCode: 0, stdout, stderr: '' };
      } catch (runError) {
        test = {
          exitCode: Number.isInteger(runError.status) ? runError.status : 1,
          stdout: String(runError.stdout ?? ''),
          stderr: String(runError.stderr ?? runError.message ?? '')
        };
      }
      return {
        taskId, variant, success: test.exitCode === 0,
        testExitCode: test.exitCode,
        failureType: classifyFailure(test),
        rework: test.exitCode === 0 ? 0 : 1,
        filesChanged: written,
        proposalHash: sha256(JSON.stringify(proposal.files ?? [])),
        knowledgeRefs,
        knowledgeChars: knowledgeContext.length,
        estimatedKnowledgeTokens: knowledgeContext ? estimateTokens(knowledgeContext) : 0,
        injectedKnowledge: knowledgeRefs.length,
        irrelevantInjection: knowledgeRefs.length > 0 && !expectKnowledge && !forcedMisleading,
        forcedMisleading,
        applicability,
        model: proposal.model ?? this.model ?? 'unknown',
        durationMs: Date.now() - started,
        stdoutTail: test.stdout.slice(-1200),
        stderrTail: test.stderr.slice(-1200)
      };
    } catch (runError) {
      error = runError;
      return {
        taskId, variant, success: false, testExitCode: null,
        failureType: 'execution-error', error: String(runError.message ?? runError),
        rework: 1, filesChanged: [], knowledgeRefs, knowledgeChars: knowledgeContext.length,
        estimatedKnowledgeTokens: knowledgeContext ? estimateTokens(knowledgeContext) : 0,
        injectedKnowledge: knowledgeRefs.length, irrelevantInjection: knowledgeRefs.length > 0 && !expectKnowledge && !forcedMisleading,
        forcedMisleading, applicability,
        model: this.model || 'unknown', durationMs: Date.now() - started
      };
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  async runSuite({ tasks, variants }) {
    const results = [];
    for (const task of tasks) {
      for (const variant of variants) {
        const context = typeof variant.contextProvider === 'function'
          ? await variant.contextProvider(task)
          : { text: variant.knowledgeContext ?? '', refs: variant.knowledgeRefs ?? [], applicability: variant.applicability ?? {} };
        results.push(await this.runTask({
          ...task,
          variant: variant.name,
          knowledgeContext: context.text,
          knowledgeRefs: context.refs,
          applicability: context.applicability,
          forcedMisleading: variant.forcedMisleading === true,
          expectKnowledge: task.expectKnowledge ?? true
        }));
      }
    }
    return this.summarize({ results, tasks, variants });
  }

  summarize({ results, tasks, variants }) {
    const byVariant = {};
    for (const variant of variants) {
      const rows = results.filter((row) => row.variant === variant.name);
      const injected = rows.reduce((sum, row) => sum + row.injectedKnowledge, 0);
      const irrelevant = rows.filter((row) => row.irrelevantInjection).length;
      byVariant[variant.name] = {
        runs: rows.length,
        success: rows.filter((row) => row.success).length,
        successRate: rows.length ? rows.filter((row) => row.success).length / rows.length : 0,
        rework: rows.reduce((sum, row) => sum + row.rework, 0),
        irrelevantInjectionRate: rows.length ? irrelevant / rows.length : 0,
        misapplicationRate: rows.length ? rows.filter((row) => row.forcedMisleading && !row.success).length / rows.length : 0,
        injectedKnowledge: injected,
        estimatedKnowledgeTokens: rows.reduce((sum, row) => sum + row.estimatedKnowledgeTokens, 0),
        meanDurationMs: rows.length ? Math.round(rows.reduce((sum, row) => sum + row.durationMs, 0) / rows.length) : 0
      };
    }
    return {
      contract: 'knowledge-eval/v1',
      taskCount: tasks.length,
      variantCount: variants.length,
      results,
      summary: byVariant,
      notes: [
        'Token 为保守估算，不是 provider 计费值。',
        'Baseline 与 Variant 使用同一 fixture、模型、测试命令与预算。',
        'forcedMisleading 仅用于负向对照。'
      ]
    };
  }
}
