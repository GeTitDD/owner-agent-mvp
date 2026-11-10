// 项目画像：把 pstack 只读分析的输出整理成普通用户能读的结构。
//
// 这里只做确定性的字段映射与过期判断；是否重新理解由 UI 触发。

/** 取第一句话作为一句话介绍。 */
export function oneLinerOf(text, fallback = '') {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (!value) return String(fallback ?? '').slice(0, 120);
  const sentence = value.split(/(?<=[。！？.!?])\s*/u)[0] ?? value;
  return sentence.slice(0, 120);
}

const unique = (items) => [...new Set(items.filter(Boolean))];

/**
 * 把一次 pstack 结果 + 仓库事实映射成 Project Brief。
 * @param {object} input
 * @param {{id:string,name:string}} input.project
 * @param {object} input.result PlaybookRunner 的结果
 * @param {object} [input.repoFacts] 由主进程读取的仓库事实
 */
export function buildProjectBrief({ project, result, repoFacts = {} }) {
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const nextSteps = Array.isArray(result?.nextSteps) ? result.nextSteps : [];
  const modules = findings.slice(0, 6).map((finding) => ({
    name: String(finding?.title ?? '').slice(0, 120),
    role: String(finding?.detail ?? '').slice(0, 300),
    paths: unique((finding?.evidence ?? []).map((item) => String(item).slice(0, 200)))
  })).filter((item) => item.name || item.role);
  const scripts = Array.isArray(repoFacts.scripts) ? repoFacts.scripts : [];
  const howToRun = scripts.length
    ? scripts.slice(0, 6)
    : nextSteps.slice(0, 4).map((step) => String(step).slice(0, 200));
  return {
    oneLiner: oneLinerOf(result?.summary, project?.name ?? ''),
    whatItIs: String(result?.summary ?? '').slice(0, 2000),
    howToRun,
    modules,
    conventions: nextSteps.slice(0, 6).map((step) => String(step).slice(0, 300)),
    verify: {
      commands: (repoFacts.testCommands ?? []).slice(0, 6),
      criteria: (repoFacts.testCriteria ?? []).slice(0, 6)
    },
    risks: (result?.risks ?? []).slice(0, 6).map((risk) => String(risk).slice(0, 300)),
    unknowns: (repoFacts.unknowns ?? []).slice(0, 6),
    evidence: unique([
      ...findings.flatMap((finding) => finding?.evidence ?? []),
      ...(repoFacts.evidence ?? [])
    ]).slice(0, 16),
    sourceRuns: result?.runId ? [result.runId] : [],
    confidence: result?.status === 'ok' ? '中' : '低',
    generatedFrom: 'pstack:how'
  };
}

/**
 * 画像是否过期：生成时的 commit 与当前 HEAD 不一致，或工作区有未提交改动。
 */
export function briefIsStale(brief, { head = '', dirty = false } = {}) {
  if (!brief) return true;
  if (dirty) return true;
  if (!brief.basedOnCommit || !head) return false;
  return String(brief.basedOnCommit) !== String(head);
}
