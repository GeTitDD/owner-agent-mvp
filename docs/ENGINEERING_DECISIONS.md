# 工程决策记录（P0 / P1）

## 目标

跨项目共享经过审查的领域知识，按任务生成最小、可复现的上下文；与 Pi 的 Agent Loop / Session Tree / Tool Execution 解耦。

## 决策 001：以领域包而不是向量数据库作为资产边界

知识文本、状态、发布版本和 Skill 文件都以文件的形式显式声明。SQLite 只是可再生成的检索索引。未来换 Postgres / 向量库不修改包的语义。

## 决策 002：输出稳定/动态双分区

稳定分区只含领域版本以及 Always-on 规则；动态分区含项目介绍与任务命中的知识。共享稳定哈希可以测量编译复用，但不承诺真实 Prompt Cache 命中。

## 决策 003：先词法检索，再向量检索

FTS5 + title/keyword 门槛允许最小依赖、结果可解释；适用于原型与工程经验条目。缺点是同义词、中文分词和隐式语义迁移较弱，需要回归 Eval 后再升级。

## 决策 004：旧版本知识不可变

没有追求“热修改同版本知识”的便利，而是使用 `domain@version:knowledge_id` 唯一键。如果内容哈希变了，必须发布新版本。这样 Session Pin 和跨项目复现才有可依赖语义。

## 决策 005：Pi 只是适配器

`src/` 不导入 Pi 包；`adapters/pi/` 只使用 Pi 的生命周期、Skill discovery 和自定义 Tool 接口。未来其他 Runtime 接入不用复制编译器。

## 明确不变量

- 同一快照、相同项目、相同 task、相同预算 => `compilationHash` 不变。
- 同一共享领域快照跨项目 => `stableHash` 不变。
- 未 published/shared 的知识不能出现在任何编译结果或检索响应。
- Session Pin 后不允许在会话中暗中替换快照。
- 稳定知识超过预算时直接失败，不静默截断。
- FTS 命中必须再次通过项目所引用的快照可见集合过滤。

## 风险与待办

- Token 预算估算不是精确 tokenizer，需模型族 tokenizer 接口和预留空间。
- 当前知识记录缺少正式证据验证链、编辑工作流、权限策略，不能把手工写入 published 当作“自积累已完成”。
- 测试中的 Pi API 使用 mock，真实 Pi CLI / SDK 行为仍需联网安装依赖、接入凭据后确认。
- 查询排序目前为轻量关键词打分，语义迁移需要单独设计指标并做对照实验。
- `node:sqlite` 在 Node 22 部分次版本仍处于实验状态，生产化可改成显式依赖驱动。

---

# P2 决策补充（v0.2）

## 决策 006：轨迹采集默认关闭且仅保留元数据

Pi Extension 的运行阶段利用 `agent_start`, `tool_execution_end`, `agent_settled`。仅在项目显式设置 `evolution.capture = "metadata"` 后写入本地 SQLite；不保存用户 Prompt、工具参数、工具输出和模型思考内容。为了跨项目知识提炼，必须另外加入经过允许分享的结构化证据摘要。

## 决策 007：模型只提出 Candidate；审核才允许升级

可插拔 Extractor 只接受经过分享授权的 Evidence Summary；Candidate payload 版本哈希固定、状态只能 `candidate→approved|rejected→published`。至少一项通过的测试证据、全部关联证据共享同意、人工 reviewer 批准，是发布门槛。手工测试声明并不能被自动证明，需要组织自行强化 CI 签名与数据源权限校验。

## 决策 008：发布新版本而不是覆盖旧知识

Publisher 对旧包做白名单清理（只传递 published/shared 条目）、验证旧版本哈希、检查知识 ID 冲突、复制可信 Skill，再使用临时目录 + rename 写入新版本。旧 Session 的版本 Pin 不变。文件系统与 SQLite 不是统一事务；写入目录成功但登记失败时保留目录供显式修复，不静默回滚。

## 决策 009：验证与评估分层

`verifyNodeTest` 通过 Node 的 `--test` 运行显式指定的本地文件，记录退出状态与脚本哈希；不使用 shell。它提供可检查的测试信号，不等于证明知识在所有上下文中正确。跨项目知识迁移的真正效果仍须独立的、无数据泄漏的任务级 Eval 验证。
