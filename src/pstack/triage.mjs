// 只读分诊：交办先由只读分析判断“是否需要写文件”，再决定是否发起 HITL 写请求。
//
// 产出契约：
//   { status, summary, needsWrite, writePlan:{intent,targets,allowedPaths,notes},
//     findings[], questions[], model, durationMs, ... }
//
// 只读保证与 Playbook 相同：read/grep/find/ls（可选只读 own_python），
// 不注册任何写工具；这里同样不触碰文件系统写入。
import { randomUUID } from 'node:crypto';
import { createReadonlySessionFactory } from './readonly-session.mjs';
import { montyAvailable } from '../monty-runner.mjs';
import {
  classifyProviderError,
  FAILURE_ADVICE,
  verifyEvidence
} from './playbook-runner.mjs';

const MAX_FINDINGS = 4;
const MAX_QUESTIONS = 3;
const clean = (value, max = 2000) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);

const asArray = (value) => (Array.isArray(value) ? value : []);

/** 组装只读分诊提示词：先分析，再判断“只回答”还是“需要写入”。 */
export function buildTriagePrompt({ task, project, python = false }) {
  return [
    `你是 Owner 的只读分析员。项目 ${project.id}（根目录 ${project.root}；主领域 ${project.domain || '未知'}）。`,
    `Owner 的交办：${clean(task, 1200)}`,
    '',
    '先只读分析这个项目，再判断这条交办是否需要修改项目文件。',
    '要求：',
    '1. 先用 read/grep/find/ls 实际查看关键文件；没有读到的内容标为未知，不要猜。',
    python
      ? '1b. 需要统计/计数/确定性计算时用 own_python；仓库以只读方式挂载在 /workspace，禁止写入、禁止第三方包。'
      : '',
    '2. 每条结论必须给证据：`相对路径` 或 `相对路径:行号`。',
    '3. 只输出 JSON，不要代码块、不要解释文字。',
    '',
    '输出格式：',
    '{"summary":"不超过120字：需要改动就写改什么，只回答就写结论",',
    ' "needsWrite":true 或 false,',
    ' "writePlan":{"intent":"一句话说明要改什么","targets":["相对路径"],',
    '   "allowedPaths":"src/ 或 docs/ 等，1-5 个逗号分隔","notes":"可选约束"},',
    ' "findings":[{"title":"结论标题","detail":"为什么/影响什么","evidence":["src/example.js:12"]}],',
    ' "questions":["信息不足时，需要 Owner 补充的点"]}',
    '',
    '判断规则：',
    '- 需要新增/修改/删除项目文件、补测试、改配置或脚本 → needsWrite=true，并给出最小写入计划。',
    '- 只是解释、查询、审查、给建议、评估风险 → needsWrite=false，writePlan 留空。',
    '- 信息不足以下结论 → needsWrite=false，并在 questions 里说明缺什么。',
    '- 即使需要写入，也不要现在动手；只提交计划，是否执行由 Owner 批准。',
    `最多 ${MAX_FINDINGS} 条 findings、${MAX_QUESTIONS} 条 questions。`
  ].filter(Boolean).join('\n');
}

/** 解析分诊输出：JSON 优先；坏 JSON 视为“无法判断”，不产生写请求。 */
export function parseTriageOutput(text) {
  const raw = String(text ?? '').trim();
  if (!raw) {
    return { format: 'empty', summary: '', needsWrite: false, writePlan: null, findings: [], questions: [] };
  }
  const withoutFence = raw.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '').trim();
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  let parsed = null;
  if (start !== -1 && end > start) {
    try { parsed = JSON.parse(withoutFence.slice(start, end + 1)); } catch { parsed = null; }
  }
  if (!parsed || typeof parsed !== 'object') {
    // 拿不到结构化结论时不猜“要不要写”，只把原文当摘要返回。
    return {
      format: 'text',
      summary: clean(raw, 800),
      needsWrite: false,
      writePlan: null,
      findings: [],
      questions: ['模型没有返回可解析的 JSON；请重试或换一个模型。']
    };
  }
  const needsWrite = parsed.needsWrite === true || parsed.needs_write === true;
  const rawPlan = parsed.writePlan ?? parsed.write_plan ?? null;
  const targets = asArray(rawPlan?.targets ?? rawPlan?.files)
    .map((item) => clean(item, 200)).filter(Boolean).slice(0, 10);
  const writePlan = needsWrite
    ? {
      intent: clean(rawPlan?.intent ?? parsed.intent ?? parsed.summary, 300),
      targets,
      allowedPaths: clean(rawPlan?.allowedPaths ?? rawPlan?.allowed_paths, 300),
      notes: clean(rawPlan?.notes, 300)
    }
    : null;
  return {
    format: 'json',
    summary: clean(parsed.summary ?? parsed.overview, 800),
    needsWrite,
    writePlan,
    findings: asArray(parsed.findings).slice(0, MAX_FINDINGS).map((item) => ({
      title: clean(item?.title ?? item?.claim ?? item, 160),
      detail: clean(item?.detail ?? item?.why ?? '', 600),
      evidence: asArray(item?.evidence ?? item?.evidenceRefs)
        .map((ref) => clean(ref, 200)).filter(Boolean).slice(0, 6)
    })),
    questions: asArray(parsed.questions).slice(0, MAX_QUESTIONS)
      .map((item) => clean(item, 300)).filter(Boolean)
  };
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

/** 只读分诊执行器；失败时返回结构化 error，不抛到 IPC 裸奔。 */
export class TriageRunner {
  constructor({
    model = '',
    timeoutMs = Number(process.env.OWNER_TRIAGE_TIMEOUT_MS) || 120000,
    python = true,
    sessionFactoryFor = null
  } = {}) {
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.python = python;
    this.sessionFactoryFor = sessionFactoryFor;
  }

  async run({ task, project, model = this.model, signal } = {}) {
    const text = String(task ?? '').trim();
    if (!text) throw new Error('Task text is required');
    if (!project?.root) throw new Error('Project root is required');
    const runId = `tr_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const startedAt = new Date().toISOString();
    const began = Date.now();
    const python = this.python && await montyAvailable();
    const prompt = buildTriagePrompt({ task: text, project, python });
    const factory = this.sessionFactoryFor
      ? this.sessionFactoryFor({ project, python })
      : createReadonlySessionFactory({ playbook: { id: 'triage', title: '只读分诊' }, skillsDir: null, python });
    let session = null;
    let timer = null;
    let cancelListener = null;
    const stopSession = () => {
      try { session?.abort?.(); } catch { /* 中止失败也要继续 dispose */ }
    };
    try {
      if (signal?.aborted) throw Object.assign(new Error('triage canceled'), { name: 'AbortError' });
      session = await factory.create({ cwd: project.root, model });
      const timedOut = new Promise((_, reject) => {
        timer = setTimeout(() => {
          stopSession();
          reject(Object.assign(new Error('triage timeout'), { name: 'TimeoutError' }));
        }, this.timeoutMs);
      });
      const canceled = new Promise((_, reject) => {
        if (!signal) return;
        cancelListener = () => {
          stopSession();
          reject(Object.assign(new Error('triage canceled'), { name: 'AbortError' }));
        };
        signal.addEventListener('abort', cancelListener, { once: true });
      });
      await Promise.race([session.prompt(prompt), timedOut, canceled]);
      const last = session.lastMessage?.();
      if (last?.stopReason === 'error') {
        const classified = classifyProviderError(last.errorMessage);
        throw Object.assign(new Error('provider error'), {
          name: 'ProviderError',
          category: classified.category,
          detail: classified.detail
        });
      }
      const reply = session.getLastText();
      if (!String(reply).trim()) {
        throw Object.assign(new Error('empty model response'), {
          name: 'EmptyResponseError',
          category: 'empty-response'
        });
      }
      const parsed = parseTriageOutput(reply);
      const findings = verifyEvidence(project.root, parsed.findings);
      return {
        runId,
        status: 'ok',
        format: parsed.format,
        summary: parsed.summary || '模型没有给出可用的结论。',
        needsWrite: parsed.needsWrite,
        writePlan: parsed.writePlan,
        findings,
        questions: parsed.questions,
        model: session.model ?? (model || 'unknown'),
        startedAt,
        durationMs: Date.now() - began
      };
    } catch (error) {
      const category = classifyError(error);
      const advice = [FAILURE_ADVICE[category] ?? FAILURE_ADVICE['session-error'], error?.detail]
        .filter(Boolean).join(' ');
      return {
        runId,
        status: 'error',
        category,
        summary: `只读分析失败：${category}`,
        advice,
        detail: error?.detail ?? '',
        needsWrite: false,
        writePlan: null,
        findings: [],
        questions: [],
        durationMs: Date.now() - began
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && cancelListener) signal.removeEventListener('abort', cancelListener);
      try { session?.dispose(); } catch { /* ignore */ }
    }
  }
}
