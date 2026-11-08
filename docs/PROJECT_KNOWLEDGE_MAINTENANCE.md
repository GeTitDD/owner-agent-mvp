# 项目领域知识提取与维护指南（当前主线）

> 2026-11-09 决策。本文是近期工作规范，不表示全部步骤已实现。已合并能力以 `main` 为准；Knowledge Loop [PR #23](https://github.com/GeTitDD/owner-agent-mvp/pull/23) 和桌宠知识入口 [PR #24](https://github.com/GeTitDD/owner-agent-mvp/pull/24) 尚为 Draft。

## 产品定位与阶段目标

Owner 是 Owner **已采纳的领域知识与项目上下文**的长期记录和维护者，不是外部世界“最新事实”的真相源。代码、文档、实验与 Agent 观察提供证据及更新建议；新的外部事实或模型推断不能自动代表 Owner 已知晓或认可。

**当前阶段先逐个项目做好知识提取、验证、修订和复用。** 暂不开发统一认知状态模型、完整 Project Journal、知识图谱、自治研究调度器或第二套 Agent Harness。

## 分层与作用域

- **L3 / Project**：绑定具体 projectId 的环境、目标、版本、约束、决策和实测经验；新经验默认先存此层。
- **L2 / Applied**：多个项目独立验证过、具有明确适用条件的方法和模式。
- **L1 / Domain**：可跨项目迁移的概念、机制和一般规律，晋升需要更强的证据与审查。
- `layer` 与 `scope/sharing` 是正交维度；`applicable` 不等于 `verified`；通过测试也不能自动证明 Owner 已经采纳。

## 每个项目要维护什么

1. **项目身份与领域**：注册项目 ID、primary domain、关联领域包及版本。
2. **上下文**：目标、环境、依赖、约束、决策，以及它们是“声明”还是“实测”。
3. **项目知识**：原子化 claim / procedure / experiment、应用边界、已知例外。
4. **证据与未知项**：源文件、提交、测试、实验或终态 Run 的引用，记录时间、失败与反例；缺证据则标记未知。
5. **维护状态**：当前修订、验证状态、最近验证依据、疑似失效条件、历史复用反馈。

## 单项目闭环 SOP

**Capture → Distill → Review / Verify → Organize / Reuse → Maintain**

1. **采集**：从代码、项目文档、配置、GitHub PR、实验测试、完成的 Job/Sandbox/Repair 中收集有来源的观察。运行中任务不写成终态经验；敏感数据不自动扩散到共享层。
2. **提炼**：将观察整理为小粒度 Knowledge Candidate，至少明确项目、领域、主张、适用条件、证据、反例、未知项和来源版本（字段以现有契约为准）。自动提炼永远是待审核候选。
3. **审核与验证**：Owner 可以接受、纠错、驳回和修订；批准候选与验证正确性是不同动作，均保留可审计证据。
4. **组织与复用**：默认留在 L3。按当前项目与任务编译上下文，保留知识 ID、revision、snapshot、适用性及实际使用证据。任务成功是 outcome，不自动计为知识带来的 positive benefit。
5. **维护**：依赖升级、源文件变化、实验反驳、适用条件变化、Owner 纠错等触发复核。旧修订不覆盖；需要时标记 `needs_reverification`。跨项目晋升必须基于独立验证，明确审核；L2 至少要有两个不同项目各自 passed/repaired 的证据，L1 另需证明一般性。

## 实现现状（不要混同）

| 能力 | 状态 |
| --- | --- |
| 分层领域包、Project Context、快照、Compiler/适用性 | `main` 已有 |
| Personal Workbench 的浏览、编辑、修订、审核 | `main` 已有 |
| 任务、Sandbox、Repair 的结构化证据 | `main` 已有 |
| 自动 Experience / Harvest / Usage / Feedback / Eval | [PR #23](https://github.com/GeTitDD/owner-agent-mvp/pull/23) Draft，未合并 |
| 桌宠知识读取、待提炼队列入口 | [PR #24](https://github.com/GeTitDD/owner-agent-mvp/pull/24) Draft，未合并 |
| 完整 Owner 认知状态模型 / Project Journal / 知识图谱 | 延期，非当前主线 |

现阶段继续复用 [Owner Agent](OWNER_AGENT.md)、[Personal Workbench](PERSONAL_WORKBENCH.md)、[Layered Knowledge](LAYERED_KNOWLEDGE.md)、已有 PersonalKnowledgeStore / Context Compiler，不重建底座。

## 下一阶段可证伪的验收目标

选至少两个不同领域或环境的真实项目；能分别查看项目领域、依赖、约束、L3 知识、证据与未知；从真实来源提炼并人工修订候选，保留验证和修订历史；环境变化会产生明确的待重验证事项，不静默改变 Owner 已接受的认知；检索和上下文编译可复现，不适用/冲突知识不会被悄悄注入。若做跨项目复用，必须提供独立证据、知识 revision、目标 Run、上下文 hash，以及成功和失败的对照，不虚构收益。
