# Owner Companion v1.0 — Phase 0 资产审计与产品基线

- 基线：`main@8c14707`（v1.1 已合并）；P3.1 在 PR #21（未合并，本工作在其分支上继续）。
- 设计：Issue #20、PR #19。
- 目标：可安装、可日常使用的桌面宠物 Agent；四条领域无关 SOP。

## 1. 现有资产与复用结论

| 资产 | 位置 | 现状 | 复用方式 |
| --- | --- | --- | --- |
| Owner 内核 | `src/owner-store.mjs`、`patch-*`、`sandbox-*`、`repair-*` | 状态机、哈希、审批、执行器完整 | **原样复用** |
| Owner Worker | `src/worker-agent.mjs`（PR #21） | 一次推进一个已批准对象 | **原样复用**，桌面进程内常驻 |
| Sidecar | `src/sidecar-server.mjs` | 读取/审批令牌、审批、repair、worker、日志 | **原样复用**，桌面进程内启动 |
| OpenClaw 插件/页面 | `integrations/openclaw-plugin/` | 原生页面、审批、结果 | **保留为 L2**；桌宠不复制其 UI |
| Electron 桌宠壳 | `desktop/main.cjs`、`preload.cjs` | 透明小窗 + 简单面板 + 知识 workbench | **保留外壳**，重写窗口/IPC/面板 |
| 旧 companion 页面 | `web/workbench/companion.*` | 独立简易问答（`/api/owner/ask`） | **废弃**，避免第二套聊天；删除 |
| Workbench | `src/workbench-server.mjs` | 知识/项目 Web UI | 作为 L2 兜底，不进入 L1 |
| OpenClaw Gateway/Control UI | 外部安装 | 会话、聊天、历史 | **L2 原样打开**，不重写 |
| Pi / Docker | 外部 | 模型与沙箱 | 原样调用 |

**不新建**：聊天系统、任务状态机、审批系统、Gateway、Agent Harness。

## 2. 四条 SOP 的交互规格

### SOP-1 交办任务（L1）
- 单一输入框 + 项目选择（仅一个项目时自动选中）。
- 提交后由主进程：创建 OwnerTask → 读取项目 HEAD → 创建 `code-patch` Job（`allowedPaths` 来自设置，默认 `src/`）。
- 不要求用户输入 Job Type / Base SHA / OwnerTask ID / JSON。
- 缺失项目时，用系统目录选择器添加项目；缺失 Docker/模型时给出可理解提示。

### SOP-2 处理决策（L1）
- 待审批：Job、Patch（proposed/approved）、Sandbox、Repair、失败 Run 的“创建修复”。
- 卡片说明：将做什么、影响什么、批准后的下一步。
- Patch 卡片可展开冻结 Diff 与 hash；审批/应用分离。
- 同意/拒绝后立即刷新；同一待办只提示一次，不重复打扰。

### SOP-3 异常恢复（L1）
- 失败 Sandbox → “创建修复” → 审批 Repair → **常驻 Worker 自动**生成修复补丁（不需要 Advance）。
- 新补丁仍需人工审批；应用后自动创建 Sandbox，等待人工批准；Worker 自动复测。
- 全程不自动 commit/push/merge。

### SOP-4 进展与成果（L1）
- 状态：空闲 / 工作中 / 等待决定 / 已完成 / 异常。
- “当前阶段 + 下一步”一句话摘要；结果卡展示是否成功、测试结论、下一步。
- 结果详情：Diff、测试输出、时间线；复杂内容交给 L2。
- 重启后从 SQLite 恢复；通知去重。

## 3. 最小模块改动

| 文件 | 改动 |
| --- | --- |
| `desktop/main.cjs` | 重写：进程内启动 sidecar + Worker；窗口/托盘/拖拽/多显示器/位置持久化；IPC 代理（令牌不出主进程） |
| `desktop/preload.cjs` | 暴露受控 IPC |
| `desktop/pet.html/css/js` | 桌宠本体：五状态、拖动、点击、角标 |
| `desktop/panel.html/css/js` | L1：四条 SOP、设置、Diff/结果弹窗 |
| `src/sidecar-server.mjs` | 复用；不新增业务 |
| `web/workbench/companion.*` | 删除（废弃第二套聊天） |
| `package.json` | electron devDependency；desktop 相关脚本 |
| `docs/COMPANION_V1_PLAN.md` | 本文 |

## 4. 实施顺序与验收

| 阶段 | 交付 | 验收 |
| --- | --- | --- |
| P1 桌宠可用 | 透明窗、拖动、托盘、多显示器、位置持久化、五状态 | 启动/隐藏/召回；重启位置保持；不抢焦点 |
| P2 任务入口 | 进程内 sidecar + Worker；SOP-1 | 空项目 → 自然语言创建 Job，无 CLI |
| P3 决策/执行 | SOP-2/3；自动 Worker | 审批、拒绝、修复、复测到 `tested_pass` |
| P4 进展/结果 | SOP-4；2s 轮询 | 自动刷新；重启可查；结果与 Store 一致 |
| P5 UX | 三轮实测修复 | 步骤/焦点/重复通知/失败后可继续 |
| P6 打包 | Windows 分发包；macOS 说明 | 首次配置检查；可运行 |

## 5. 安全与边界

- 审批令牌只在 Electron 主进程；渲染进程只能通过受控 IPC 触发决策，拿不到令牌。
- 保留哈希绑定、approve/apply 分离、人工审批；Worker 只执行已批准对象。
- 不自建 Gateway/聊天；L2 打开 OpenClaw Control UI。
- 非关键安全/审计继续留在 `docs/TECH_DEBT.md`。

## 6. 测试策略

- 单元/契约：Worker、sidecar（已有）。
- 桌面：Playwright `_electron` 启动真实窗口，驱动桌宠/面板，截图。
- 业务：Fake 源补丁 + 真实 Pi 修复 + 真实 Docker（至少一次）。
- 打包：Windows 产物与首次启动检查；macOS 若缺环境，明确标注未验证。
