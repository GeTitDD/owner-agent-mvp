// Composer 交办编排：先只读分诊，再决定“直接回答”还是“发起 HITL 写请求”。
//
// 这里不碰文件系统：分诊 runner 与写请求创建都由调用方注入，便于单元测试。
import path from 'node:path';

/** 规范化写入范围：1-5 个相对路径；非法值回退到设置里的 allowedPaths。 */
export function normalizeAllowedPaths(value, fallback = 'src/') {
  const entries = String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !path.isAbsolute(part) && !part.split(/[\\/]/u).includes('..'));
  const picked = entries.slice(0, 5);
  return (picked.length ? picked.join(',') : (fallback || 'src/')).slice(0, 300);
}

/**
 * @param {object} options
 * @param {string} options.text 交办文本
 * @param {{id:string, root:string, domain?:string}} options.project
 * @param {{run: Function}} options.triageRunner 只读分诊执行器
 * @param {Function} options.createWriteRequest 创建 pending_approval 写请求
 */
export async function submitCompanionTask({ text, project, triageRunner, createWriteRequest }) {
  const value = String(text ?? '').trim();
  if (!value) throw new Error('请先输入要交办的事情。');
  if (value.length > 1200) throw new Error('交办最多 1200 字。');
  if (!project?.root) throw new Error('项目目录不可用。');

  const triage = await triageRunner.run({
    task: value,
    project: { id: project.id, root: project.root, domain: project.domain ?? '' }
  });

  if (triage.status !== 'ok') {
    return {
      mode: 'triage-error',
      category: triage.category,
      summary: triage.summary,
      advice: triage.advice,
      runId: triage.runId,
      durationMs: triage.durationMs
    };
  }

  if (!triage.needsWrite) {
    return {
      mode: 'answer',
      summary: triage.summary,
      findings: triage.findings,
      questions: triage.questions,
      model: triage.model,
      durationMs: triage.durationMs,
      runId: triage.runId
    };
  }

  const plan = triage.writePlan ?? {};
  const intent = String(plan.intent || value).slice(0, 300);
  const targets = Array.isArray(plan.targets) ? plan.targets.slice(0, 10) : [];
  const created = await createWriteRequest({
    project,
    text: value,
    title: `写请求：${intent}`,
    intent,
    targets,
    allowedPaths: plan.allowedPaths,
    analysisRunId: triage.runId,
    analysisSummary: triage.summary
  });
  return {
    mode: 'write-request',
    jobId: created.jobId,
    status: created.status,
    summary: triage.summary,
    intent,
    targets,
    findings: triage.findings,
    questions: triage.questions,
    model: triage.model,
    durationMs: triage.durationMs,
    runId: triage.runId
  };
}
