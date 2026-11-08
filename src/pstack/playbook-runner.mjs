// pstack Playbook 执行器：只读分析 + 结构化结果。
//
// 产出契约（面板卡片与完整报告都基于它）：
//   { runId, playbookId, projectId, status, summary, findings[], risks[],
//     nextSteps[], model, startedAt, durationMs, evidence[] }
//
// 只读保证来自 readonly-session.mjs 的工具白名单；这里不触碰文件系统写入。
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { getPlaybook } from './playbooks.mjs';
import { createReadonlySessionFactory, resolvePstackSkillsDir } from './readonly-session.mjs';
import { sha256 } from '../utils.mjs';

const MAX_FINDINGS = 5;
const MAX_RISKS = 3;
const MAX_NEXT_STEPS = 4;

const clean = (value, max = 2000) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);

/** 组装只读分析提示词：项目边界 + playbook 目标 + 固定 JSON 输出契约。 */
export function buildPlaybookPrompt({ playbook, project, task = '' }) {
  return [
    `只读分析项目 ${project.id}（根目录 ${project.root}；主领域 ${project.domain || '未知'}）。`,
    `本次执行 pstack playbook「${playbook.title}」（${playbook.id}）：${playbook.hint}`,
    `分析重点：${playbook.focus}`,
    task ? `本次关注：${clean(task, 300)}` : '',
    '',
    '要求：',
    '1. 先用 read/grep/find/ls 实际查看关键文件再下结论；没有读到的内容标为未知。',
    '2. 每条结论必须给证据：`相对路径` 或 `相对路径:行号`。',
    '3. 只输出 JSON，不要代码块、不要解释文字。',
    '4. 控制成本：先看 README/入口/配置，最多读 20 个文件；不够就说明还缺什么。',
    '',
    '输出格式：',
    '{"summary":"不超过120字、与本项目直接相关的结论",',
    ' "findings":[{"title":"结论标题","detail":"为什么成立/影响什么","evidence":["src/example.js:12"]}],',
    ' "risks":["风险或未知项"],',
    ' "nextSteps":["建议的下一步，可执行"]}',
    `最多 ${MAX_FINDINGS} 条 findings、${MAX_RISKS} 条 risks、${MAX_NEXT_STEPS} 条 nextSteps。`,
    '如果证据不足以支持任何结论，返回 summary 说明缺什么，findings 留空。'
  ].filter(Boolean).join('\n');
}

const asArray = (value) => (Array.isArray(value) ? value : []);

const normalizeFinding = (item) => {
  if (typeof item === 'string') {
    return { title: clean(item, 160), detail: '', evidence: [] };
  }
  return {
    title: clean(item?.title ?? item?.claim ?? item?.name, 160),
    detail: clean(item?.detail ?? item?.why ?? item?.impact, 600),
    evidence: asArray(item?.evidence ?? item?.evidenceRefs)
      .map((ref) => clean(ref, 200)).filter(Boolean).slice(0, 6)
  };
};

/** 解析模型输出：优先 JSON，退化为 Markdown 小节，再退化为纯文本摘要。 */
export function parsePlaybookOutput(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { format: 'empty', summary: '', findings: [], risks: [], nextSteps: [] };
  const withoutFence = raw.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '').trim();
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(withoutFence.slice(start, end + 1));
      return {
        format: 'json',
        summary: clean(parsed.summary ?? parsed.overview, 800),
        findings: asArray(parsed.findings).slice(0, MAX_FINDINGS).map(normalizeFinding),
        risks: asArray(parsed.risks).slice(0, MAX_RISKS).map((item) => clean(item, 300)).filter(Boolean),
        nextSteps: asArray(parsed.nextSteps ?? parsed.next_steps)
          .slice(0, MAX_NEXT_STEPS).map((item) => clean(item, 300)).filter(Boolean)
      };
    } catch { /* 落回 Markdown 解析 */ }
  }
  const sections = new Map();
  let current = 'summary';
  for (const line of raw.split(/\r?\n/u)) {
    const heading = line.match(/^#{1,4}\s*(.+?)\s*$/u);
    if (heading) {
      const title = heading[1];
      current = /发现|问题|结论/u.test(title) ? 'findings'
        : /风险|未知/u.test(title) ? 'risks'
          : /下一步|建议/u.test(title) ? 'nextSteps' : 'summary';
      continue;
    }
    if (!sections.has(current)) sections.set(current, []);
    sections.get(current).push(line);
  }
  const bullets = (lines = []) => lines
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/u, '').trim())
    .filter(Boolean);
  const summaryText = (sections.get('summary') ?? []).join('\n').trim();
  const findings = bullets(sections.get('findings'))
    .slice(0, MAX_FINDINGS)
    .map((line) => normalizeFinding(line));
  return {
    format: 'markdown',
    summary: clean(summaryText, 800) || clean(raw, 400),
    findings,
    risks: bullets(sections.get('risks')).slice(0, MAX_RISKS),
    nextSteps: bullets(sections.get('nextSteps')).slice(0, MAX_NEXT_STEPS)
  };
}

/** 证据引用落地检查：只认项目根目录内的相对路径，越界或不存在都标为未验证。 */
export function verifyEvidence(projectRoot, findings) {
  const root = path.resolve(projectRoot);
  const check = (ref) => {
    const file = String(ref).split(':')[0].trim();
    if (!file) return { ref, exists: false };
    const absolute = path.resolve(root, file);
    const inside = absolute === root || absolute.startsWith(`${root}${path.sep}`);
    return { ref, exists: inside && existsSync(absolute) };
  };
  return findings.map((finding) => ({
    ...finding,
    evidenceChecks: finding.evidence.map(check)
  }));
}

const classifyError = (error) => {
  const name = String(error?.name ?? '');
  const message = String(error?.message ?? '');
  if (/timeout/iu.test(name) || /timeout/iu.test(message)) return 'timeout';
  if (/abort/iu.test(name)) return 'aborted';
  if (/readonly-tools/u.test(message)) return 'readonly-violation';
  if (/No API key|auth|permission|forbidden/iu.test(message)) return 'auth-error';
  if (/network|fetch|connection|socket|dns/iu.test(message)) return 'network-error';
  return 'session-error';
};

export class PlaybookRunner {
  constructor({
    model = '',
    skillsDir = process.env.PSTACK_DIR,
    timeoutMs = 180000,
    logger = console,
    sessionFactoryFor = (playbook, resolvedSkillsDir) =>
      createReadonlySessionFactory({ playbook, skillsDir: resolvedSkillsDir })
  } = {}) {
    this.model = model;
    this.skillsDir = skillsDir;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.sessionFactoryFor = sessionFactoryFor;
  }

  get skillsAvailable() {
    return Boolean(resolvePstackSkillsDir(this.skillsDir));
  }

  /** 执行一个 playbook。任何失败都返回结构化 error，不抛给 IPC 层裸奔。 */
  async run({ playbookId, project, task = '', model = this.model } = {}) {
    const playbook = getPlaybook(playbookId);
    if (!playbook) throw new Error(`Unknown playbook: ${playbookId}`);
    if (!project?.root) throw new Error('Project root is required');
    const skillsDir = resolvePstackSkillsDir(this.skillsDir);
    if (!skillsDir) throw new Error('pstack skills directory not found');
    const runId = `pb_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const startedAt = new Date().toISOString();
    const prompt = buildPlaybookPrompt({ playbook, project, task });
    const factory = this.sessionFactoryFor(playbook, skillsDir);
    let session = null;
    let timer = null;
    const began = Date.now();
    try {
      session = await factory.create({ cwd: project.root, model });
      const timedOut = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('playbook timeout'), { name: 'TimeoutError' })), this.timeoutMs);
      });
      await Promise.race([session.prompt(prompt), timedOut]);
      const text = session.getLastText();
      const parsed = parsePlaybookOutput(text);
      const findings = verifyEvidence(project.root, parsed.findings);
      return {
        runId,
        playbookId: playbook.id,
        playbookLabel: playbook.label,
        playbookTitle: playbook.title,
        projectId: project.id,
        status: 'ok',
        format: parsed.format,
        summary: parsed.summary || '模型没有给出可用的结论。',
        findings,
        risks: parsed.risks,
        nextSteps: parsed.nextSteps,
        model: session.model ?? (model || 'unknown'),
        startedAt,
        durationMs: Date.now() - began,
        promptHash: sha256(prompt),
        textHash: sha256(text),
        text
      };
    } catch (error) {
      return {
        runId,
        playbookId: playbook.id,
        playbookLabel: playbook.label,
        playbookTitle: playbook.title,
        projectId: project.id,
        status: 'error',
        category: classifyError(error),
        summary: `执行失败：${classifyError(error)}`,
        findings: [],
        risks: [],
        nextSteps: [],
        model: model || 'unknown',
        startedAt,
        durationMs: Date.now() - began,
        promptHash: sha256(prompt),
        textHash: ''
      };
    } finally {
      if (timer) clearTimeout(timer);
      try { session?.dispose(); } catch { /* ignore */ }
    }
  }
}
