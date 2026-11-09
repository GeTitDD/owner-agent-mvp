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
import { montyAvailable } from '../monty-runner.mjs';

const MAX_FINDINGS = 5;
const MAX_RISKS = 3;
const MAX_NEXT_STEPS = 4;

const clean = (value, max = 2000) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);

/** 组装只读分析提示词：项目边界 + playbook 目标 + 固定 JSON 输出契约。 */
export function buildPlaybookPrompt({ playbook, project, task = '', python = false }) {
  return [
    `只读分析项目 ${project.id}（根目录 ${project.root}；主领域 ${project.domain || '未知'}）。`,
    `本次执行 pstack playbook「${playbook.title}」（${playbook.id}）：${playbook.hint}`,
    `分析重点：${playbook.focus}`,
    task ? `本次关注：${clean(task, 300)}` : '',
    '',
    '要求：',
    '1. 先用 read/grep/find/ls 实际查看关键文件再下结论；没有读到的内容标为未知。',
    python
      ? '1b. 需要统计/计数/确定性计算时用 own_python；仓库以只读方式挂载在 /workspace，禁止写入、禁止第三方包。'
      : '',
    '2. 每条结论必须给证据：`相对路径` 或 `相对路径:行号`。',
    '3. 只输出 JSON，不要代码块、不要解释文字。',
    `4. 控制成本：先看 README/入口/配置，最多读 ${playbook.maxFiles ?? 20} 个文件；需要更多就说明还缺什么。`,
    playbook.budget ? `5. ${playbook.budget}` : '',
    '',
    '输出格式：',
    '{"summary":"不超过120字、与本项目直接相关的结论",',
    ' "findings":[{"title":"结论标题","detail":"为什么成立/影响什么","evidence":["src/example.js:12"]}],',
    ' "risks":["风险或未知项"],',
    ' "nextSteps":["建议的下一步，可执行"]}',
    `最多 ${MAX_FINDINGS} 条 findings、${MAX_RISKS} 条 risks、${MAX_NEXT_STEPS} 条 nextSteps。`,
    '除证据确实不足外，findings 至少给 3 条，每条都要能落到具体文件。',
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

/** 证据引用规范化：去掉包裹符号、行号后缀与“第 N 行”之类修饰。 */
export const normalizeEvidenceRef = (ref) => String(ref ?? '')
  .trim()
  .replace(/^[`'"“”‘’]+|[`'"“”‘’]+$/gu, '')
  .replace(/[（(]\s*(?:line|第)?\s*\d+\s*(?:行)?\s*[)）]/giu, '')
  .replace(/#L\d+$/iu, '')
  .replace(/:\d+(?:-\d+)?$/u, '')
  .trim();

/** 证据引用落地检查：只认项目根目录内的相对路径，越界或不存在都标为未验证。 */
export function verifyEvidence(projectRoot, findings) {
  const root = path.resolve(projectRoot);
  const check = (ref) => {
    const file = normalizeEvidenceRef(String(ref).split(':')[0]);
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
  if (error?.category) return error.category;
  const name = String(error?.name ?? '');
  const message = String(error?.message ?? '');
  if (/timeout/iu.test(name) || /timeout/iu.test(message)) return 'timeout';
  if (/abort/iu.test(name) || /cancel/iu.test(message)) return 'canceled';
  if (/readonly-tools/u.test(message)) return 'readonly-violation';
  if (/no api key|api key|relogin|auth|permission|forbidden/iu.test(message)) return 'auth-error';
  if (/network|fetch|connection|socket|dns/iu.test(message)) return 'network-error';
  return 'session-error';
};

/** 把上游错误归到受控分类；只保留额度重置时间这类非敏感信息。 */
export function classifyProviderError(rawMessage) {
  const raw = String(rawMessage ?? '');
  if (/429|1310|quota|rate.?limit|使用上限|额度/iu.test(raw)) {
    const reset = /(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)/u.exec(raw);
    return {
      category: 'quota-exceeded',
      detail: reset ? `额度将于 ${reset[1]} 重置。` : ''
    };
  }
  if (/401|403|unauthorized|invalid api key|no api key|relogin/iu.test(raw)) return { category: 'auth-error', detail: '' };
  if (/timeout|ETIMEDOUT/iu.test(raw)) return { category: 'timeout', detail: '' };
  return { category: 'session-error', detail: '' };
}

export class PlaybookRunner {
  constructor({
    model = '',
    skillsDir = process.env.PSTACK_DIR,
    timeoutMs = Number(process.env.OWNER_PLAYBOOK_TIMEOUT_MS) || 240000,
    logger = console,
    python = true,
    sessionFactoryFor = null
  } = {}) {
    this.model = model;
    this.skillsDir = skillsDir;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.python = python;
    this.sessionFactoryFor = sessionFactoryFor ?? ((playbook, resolvedSkillsDir, options = {}) =>
      createReadonlySessionFactory({
        playbook,
        skillsDir: resolvedSkillsDir,
        python: options.python ?? this.python
      }));
  }

  get skillsAvailable() {
    return Boolean(resolvePstackSkillsDir(this.skillsDir));
  }

  /** 执行一个 playbook。任何失败都返回结构化 error，不抛给 IPC 层裸奔。 */
  async run({ playbookId, project, task = '', model = this.model, signal } = {}) {
    const playbook = getPlaybook(playbookId);
    if (!playbook) throw new Error(`Unknown playbook: ${playbookId}`);
    if (!project?.root) throw new Error('Project root is required');
    const skillsDir = resolvePstackSkillsDir(this.skillsDir);
    if (!skillsDir) throw new Error('pstack skills directory not found');
    const runId = `pb_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const startedAt = new Date().toISOString();
    const python = this.python && await montyAvailable();
    const prompt = buildPlaybookPrompt({ playbook, project, task, python });
    const factory = this.sessionFactoryFor(playbook, skillsDir, { python });
    // 大仓库需要更长预算；单个 playbook 可以覆盖全局默认。
    const timeoutMs = Number(playbook.timeoutMs) > 0 ? Number(playbook.timeoutMs) : this.timeoutMs;
    let session = null;
    let timer = null;
    let cancelListener = null;
    const began = Date.now();
    const stopSession = () => {
      try { session?.abort?.(); } catch { /* 中止失败也要继续 dispose */ }
    };
    try {
      if (signal?.aborted) throw Object.assign(new Error('playbook canceled'), { name: 'AbortError' });
      session = await factory.create({ cwd: project.root, model });
      const timedOut = new Promise((_, reject) => {
        timer = setTimeout(() => {
          // 先真正中止会话，避免超时后模型继续跑、继续计费。
          stopSession();
          reject(Object.assign(new Error('playbook timeout'), { name: 'TimeoutError' }));
        }, timeoutMs);
      });
      const canceled = new Promise((_, reject) => {
        if (!signal) return;
        cancelListener = () => {
          stopSession();
          reject(Object.assign(new Error('playbook canceled'), { name: 'AbortError' }));
        };
        signal.addEventListener('abort', cancelListener, { once: true });
      });
      await Promise.race([session.prompt(prompt), timedOut, canceled]);
      // 上游可能以“空内容 + stopReason=error”结束（额度、鉴权、网络）；必须显式失败，
      // 不能伪装成“模型没有给出结论”。
      const last = session.lastMessage?.();
      if (last?.stopReason === 'error') {
        const classified = classifyProviderError(last.errorMessage);
        throw Object.assign(new Error('provider error'), {
          name: 'ProviderError',
          category: classified.category,
          detail: classified.detail
        });
      }
      const text = session.getLastText();
      if (!String(text).trim()) {
        throw Object.assign(new Error('empty model response'), { name: 'EmptyResponseError', category: 'empty-response' });
      }
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
      const category = classifyError(error);
      const advice = [FAILURE_ADVICE[category] ?? FAILURE_ADVICE['session-error'], error?.detail]
        .filter(Boolean).join(' ');
      return {
        runId,
        playbookId: playbook.id,
        playbookLabel: playbook.label,
        playbookTitle: playbook.title,
        projectId: project.id,
        status: 'error',
        category,
        summary: `执行失败：${category}`,
        advice,
        detail: error?.detail ?? '',
        findings: [],
        risks: [],
        nextSteps: [],
        model: model || 'unknown',
        startedAt,
        durationMs: Date.now() - began,
        timeoutMs,
        promptHash: sha256(prompt),
        textHash: ''
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && cancelListener) signal.removeEventListener('abort', cancelListener);
      try { session?.dispose(); } catch { /* ignore */ }
    }
  }
}

// 失败后给用户可执行的一句话，而不是只显示分类名。
export const FAILURE_ADVICE = {
  timeout: '项目较大时先用「结构走读」缩小范围，或直接重试；单次预算已提高到 4 分钟。',
  canceled: '已按你的要求中止；可以换个更小的 playbook 再试。',
  'readonly-violation': '只读工具校验失败，已中止；这属于客户端缺陷，请不要继续执行写操作。',
  'auth-error': '模型凭据不可用：到设置里检查模型，或重新登录 Pi。',
  'network-error': '模型服务连接失败：检查代理/网络后重试。',
  'quota-exceeded': '模型额度已用尽（429）。换一个模型，或等额度重置后再试。',
  'empty-response': '模型返回了空内容：可能是额度、网络或上下文问题；先重试，仍为空就换模型。',
  'session-error': '模型会话异常：重试一次；持续失败时换模型或缩小分析范围。'
};
