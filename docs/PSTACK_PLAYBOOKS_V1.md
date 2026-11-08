# pstack Playbook 按钮 v1（Companion）

面板里的「项目 Playbook」把 pstack 的 skill 变成按钮：进入项目后一键做只读分析，拿到与该项目直接相关的结论；需要改文件时不直接改，先生成提案等你批准。

## 1. 范围

12 个按钮，分 4 组（按钮文字是中文短标签，tooltip 是完整说明）：

| 组 | 按钮 | 对应 pstack skill |
| --- | --- | --- |
| 分析 | 结构走读 / 架构草图 / 设计来由 | `how` / `architect` / `why` |
| 验证 | 怎么验收 / 测试先行 / 数据体检 | `verify-app` / `tdd` / `benchmark-checklist` |
| 修复 | 根因定位 / 影响面 / 防复发 | `principle-fix-root-causes` / `blast-radius` / `correct` |
| 沉淀 | 复盘 / 讲清楚 / 文档体检 | `reflect` / `teach` / `technical-writing` |

pstack 仓库里另外 43 个 skill 没有进面板；它们仍然可以通过 `PSTACK_DIR` 被 Harvest 使用。

## 2. 读：一键拿项目信息

点按钮后：

1. 主进程用**当前项目根目录**创建一次性 Pi 会话；
2. 会话只放行 `read / grep / find / ls` 四个工具，`write / edit / bash / powershell` 被显式排除；
3. 创建后再核对一次 `getActiveToolNames()`，出现白名单外的工具直接中止（fail closed）；
4. 目标 skill 的 `SKILL.md` 正文注入 system prompt，固定 JSON 输出契约；
5. 结果落盘到 `%APPDATA%\owner-agent-mvp\playbooks\<runId>.json`。

面板先显示摘要 + 最多 3 条发现；「完整报告」给出全部发现、风险、下一步和模型原始输出。

**证据核验**：模型给的 `path:line` 引用会被逐个检查是否真实存在于项目根目录内；不存在的引用在界面上标灰划线，避免编造路径被当成事实。

## 3. 改：HITL 只有一条路

「生成改动提案」不会写文件，只做一件事：复用现有任务链路创建 `code-patch` Job。

```
按钮 → 诊断摘要 → 你确认 → 创建 Job（pending_approval）
     → 你批准 Job → Worker 生成补丁
     → 你批准补丁 → 应用到项目 → 沙箱测试 → 结果回写
```

任何增删改都必须经过这两次显式批准；panel 侧没有审批令牌，令牌只存在于主进程，渲染进程拿不到。

## 4. 成本、进度与失败

- 每次点击 = 一次真实模型调用。小项目约 10–30 秒，大仓库实测 2 分 48 秒（`architect` 在 12 万行级 Godot 仓库上）。
- 运行中面板显示已用秒数，并提供「取消」；取消会真正中止会话，而不是只隐藏转圈。
- 超时预算：默认 4 分钟，`architect` 5 分钟；可用 `OWNER_PLAYBOOK_TIMEOUT_MS` 覆盖默认值。
- 失败返回结构化分类：`timeout` / `canceled` / `auth-error` / `network-error` / `readonly-violation` / `session-error`，并附一句可执行建议 + 「重试」按钮；不会把上游原文塞进 UI。
- 找不到 pstack skills 目录时按钮禁用，提示设置 `PSTACK_DIR`。

## 5. 验证

```powershell
# 单元测试（不调模型）
node --test tests/pstack-playbooks.test.mjs

# 真实 Electron + 真实模型 + HITL 断言
$env:EVIDENCE_DIR='<证据目录>'
node scripts/e2e/desktop-playbooks.mjs
```

E2E 覆盖：12 个按钮/4 组渲染 → 真实只读分析（摘要 + 证据引用）→ 无可编造路径 → 运行中取消 → 生成提案 → 关库后确认 Job 停在 `pending_approval` 且没有补丁提案。

证据规范化：模型给出的 `` `path` ``、`path:12`、`path#L3`、`path（第 12 行）` 都会归一到文件路径再核验。

## 6. 边界

- 这是 **pstack-inspired 薄适配**：只复用 Skill 文本与只读纪律，没有执行 pstack 原生的 subagent/todo/Reflect 引擎，也不修改 pstack 仓库。
- 未做：流式输出、并发多个 playbook、结果自动写入知识库、按 playbook 单独配置模型。
- 未验证：macOS；超大仓库（>10 万文件）耗时。
