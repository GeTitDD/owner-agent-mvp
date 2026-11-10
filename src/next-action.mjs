// 下一步建议：把内部状态翻译成一个普通用户能理解的动词。
//
// 只做展示决策，不执行动作；UI 根据 command 触发对应能力。

/**
 * @param {object} input
 * @param {number} [input.pending] 待审批数量
 * @param {boolean} [input.playbookRunning] pstack 是否运行中
 * @param {object|null} [input.brief] 项目画像
 * @param {boolean} [input.briefStale] 画像是否过期
 * @param {object} [input.knowledge] 知识摘要 counts
 * @param {object|null} [input.result] 最近结果
 * @param {string} [input.state] Owner 五态
 * @param {string} [input.cycleId] 最近结果对应的修复周期
 */
export function nextActionFor({
  pending = 0,
  playbookRunning = false,
  brief = null,
  briefStale = false,
  knowledge = {},
  result = null,
  state = 'idle',
  cycleId = ''
} = {}) {
  if (pending > 0) {
    return { command: 'decide', label: `有 ${pending} 项等你决定`, detail: '写入、补丁、测试或修复需要你点头。', tone: 'warn' };
  }
  if (playbookRunning) {
    return { command: 'wait', label: '正在分析项目…', detail: 'pstack 只读分析进行中，可以继续做别的事。', tone: 'active' };
  }
  if (!brief || briefStale) {
    return {
      command: 'understand',
      label: brief ? '项目画像已过期，重新理解一下' : '花一分钟理解这个项目',
      detail: brief ? '代码有新的提交或未提交改动。' : '生成项目画像：是什么、怎么跑、关键模块、怎么验收。',
      tone: 'active'
    };
  }
  const tidyCount = (knowledge.pendingHarvest ?? 0) + (knowledge.candidates ?? 0);
  if (tidyCount > 0) {
    return {
      command: 'tidy',
      label: `整理 ${tidyCount} 条项目知识`,
      detail: '有待提炼经验或候选，整理后更容易被下次任务复用。',
      tone: 'warn'
    };
  }
  if (result?.testStatus === 'pass') {
    return {
      command: 'deliver',
      label: '测试已通过，可以交付',
      detail: '把补丁分支推送到 GitHub 并创建 Draft PR。',
      tone: 'ok',
      cycleId: result.cycleId ?? cycleId
    };
  }
  if (state === 'error') {
    return {
      command: 'inspect',
      label: '有失败结果，查看并修复',
      detail: '打开结果详情，必要时创建修复周期。',
      tone: 'error'
    };
  }
  return {
    command: 'compose',
    label: '暂无待办，可以交办新任务',
    detail: '也可以先理解项目或整理知识。',
    tone: 'muted'
  };
}
