// pstack Playbook 注册表（面板按钮的唯一数据源）。
//
// 只做“薄适配”：每个按钮对应一个 pstack Skill 目录，运行时把该 Skill 的
// SKILL.md 正文注入只读会话的 system prompt；不改动 pstack 仓库，也不假装
// 已执行 pstack 原生的 subagent/todo 机制。
//
// id 必须与 pstack skills/<id>/SKILL.md 的目录名一致。
export const PLAYBOOK_GROUPS = [
  { id: 'analyze', label: '分析', hint: '先看懂项目再动手' },
  { id: 'verify', label: '验证', hint: '用证据代替自我声明' },
  { id: 'fix', label: '修复', hint: '只读诊断，改动需你批准' },
  { id: 'distill', label: '沉淀', hint: '把项目知识写清楚' }
];

export const PLAYBOOKS = Object.freeze([
  {
    id: 'how',
    label: '结构走读',
    group: 'analyze',
    title: '这个项目是怎么运转的',
    hint: '回答“X 是怎么工作的”，给出子系统架构与调用链。',
    focus: '说明主要模块职责、入口、运行时数据流，以及新人上手需要的心理模型。'
  },
  {
    id: 'architect',
    label: '架构草图',
    group: 'analyze',
    title: '当前架构与可演进形状',
    hint: '先画类型、签名与模块边界，再谈改动。',
    focus: '画出模块边界与关键类型/函数签名，指出结构上明显的耦合或错位。'
  },
  {
    id: 'why',
    label: '设计来由',
    group: 'analyze',
    title: '这些设计为什么变成现在这样',
    hint: '从代码与提交历史推断取舍与约束。',
    focus: '指出可验证的设计动机与权衡；无法从仓库证明的部分必须标为未知。'
  },
  {
    id: 'verify-app',
    label: '怎么验收',
    group: 'verify',
    title: '这个项目应该怎么验收',
    hint: '给出可复现的启动方式、输入与通过判据。',
    focus: '给出启动命令、最小输入、观察点与通过判据；指出当前缺失的验收环节。'
  },
  {
    id: 'tdd',
    label: '测试先行',
    group: 'verify',
    title: '哪里值得补一个失败测试',
    hint: '找出清晰、便宜、能先红后绿的测试点。',
    focus: '列出值得补的回归测试点，说明失败前置条件与为什么成本低；不适合补测试的地方要直说。'
  },
  {
    id: 'benchmark-checklist',
    label: '数据体检',
    group: 'verify',
    title: '现有性能/测试数字可信吗',
    hint: '检查测量方法、重复性与相关性。',
    focus: '检查仓库里的测试与基准是否可重复、是否有对照、结论是否被数据支持。'
  },
  {
    id: 'principle-fix-root-causes',
    label: '根因定位',
    group: 'fix',
    title: '这些症状的根因在哪',
    hint: '只读诊断：追到根因，不写补丁。',
    focus: '对每个可观察症状给出根因假设与验证方法；区分根因与症状补丁。'
  },
  {
    id: 'blast-radius',
    label: '影响面',
    group: 'fix',
    title: '改动会影响哪些地方',
    hint: '找出跨文件、跨模块的连带影响。',
    focus: '列出改动可能的连带影响、受影响的调用方与需要回归验证的行为。'
  },
  {
    id: 'correct',
    label: '防复发',
    group: 'fix',
    title: '哪些错误会被反复犯',
    hint: '把重复错误变成结构约束。',
    focus: '找出仓库里容易被重复犯的错误，并建议用类型/结构/测试而非文档来阻止。'
  },
  {
    id: 'reflect',
    label: '复盘',
    group: 'distill',
    title: '这个项目有哪些值得沉淀的经验',
    hint: '把一次性做法提炼成可复用规则。',
    focus: '提炼可复用的技术经验，注明适用条件与例外；一次性事项不算经验。'
  },
  {
    id: 'teach',
    label: '讲清楚',
    group: 'distill',
    title: '把这个项目讲给新人听',
    hint: '用平实语言解释是什么、怎么跑、为什么。',
    focus: '用平实语言解释项目是什么、怎么运转、为什么这样设计，按重要性排序。'
  },
  {
    id: 'technical-writing',
    label: '文档体检',
    group: 'distill',
    title: '现有文档该怎么改',
    hint: '按 Diátaxis 与开发者文风检查文档。',
    focus: '检查 README/文档的结构与可读性，指出缺失的教程、操作、参考或解释类型文档。'
  }
]);

const byId = new Map(PLAYBOOKS.map((item) => [item.id, item]));

/** 按 id 取 playbook；未知 id 返回 null，调用方必须拒绝。 */
export function getPlaybook(id) {
  return byId.get(String(id ?? '')) ?? null;
}

/** 面板需要的列表：分组顺序稳定，便于 UI 直接渲染。 */
export function listPlaybooks() {
  return PLAYBOOK_GROUPS.map((group) => ({
    ...group,
    items: PLAYBOOKS.filter((item) => item.group === group.id)
      .map(({ id, label, title, hint, focus }) => ({ id, label, title, hint, focus }))
  }));
}

/** 只读会话允许使用的工具；写/执行类工具必须始终缺席。 */
export const READONLY_TOOLS = Object.freeze(['read', 'grep', 'find', 'ls']);
export const FORBIDDEN_TOOLS = Object.freeze(['write', 'edit', 'bash', 'powershell']);

/** 面板“生成改动提案”使用的任务文本：保留 playbook 出处，便于回溯。 */
export function buildProposalText(playbook, summary, maxChars = 200) {
  const body = String(summary ?? '').replace(/\s+/gu, ' ').trim();
  if (!playbook || !body) return '';
  return `[playbook:${playbook.id}] ${playbook.title}：${body}`.slice(0, maxChars);
}
