# Owner Companion v1.0 — 交付报告

- 日期：2026-11-08
- 基线：`main@8c14707` + PR #21（P3.1）之上的 Companion 分支
- 运行环境：Windows 11（10.0.26100）、Electron 45.2.3、Node 22.20、Docker 29.4.3、Pi 默认模型
- 结论：**四条核心 SOP 已通过真实桌面交互验收；Windows 内部 Release Candidate 便携包已生成，并作为私有 CI Artifact 提供；macOS 未验证（见缺口）。**

## 1. 产品形态

Electron 桌宠 + 进程内 Owner Runtime：

- 透明、无边框、置顶、不抢焦点、可拖动、托盘、位置持久化；
- 五种状态：空闲 / 工作中 / 等待决定 / 已完成 / 异常；
- L1 面板：交办、决策、异常恢复、进展与成果；
- L2：打开 OpenClaw Control UI（未连接时回退到 Workbench）；
- 审批令牌只存在主进程；渲染进程通过受控 IPC 操作；
- 旧 Workbench 的 companion 悬浮问答与 `companion.*` 静态页均已移除，L2 聊天统一交给 OpenClaw，避免第二套聊天状态。

## 2. 四条 SOP 验收

桌面 E2E：`npm run e2e:desktop`（真实 Electron 窗口 + 真实 Docker + 真实 Pi）。

| SOP | 验收 | 证据 |
| --- | --- | --- |
| SOP-1 交办任务 | 空 Job 项目，从面板输入“Fix the failing retry test” → 创建 Job，无 CLI | E2E `SOP-1 job created from the pet` |
| SOP-2 处理决策 | Job 批准 → Patch Diff 审阅/批准/应用 → Sandbox 审批；拒绝路径存在 | E2E 前 6 项断言；截图 `01/02` |
| SOP-3 异常恢复 | 真实 Docker 失败 → 创建修复 → 批准 → 真实 Pi 生成修复补丁 → 应用 → 复测 pass | E2E `source sandbox failed` … `repair retest passed`；截图 `04/05/06` |
| SOP-4 进展与成果 | 状态自动刷新；结果面板含 tested_pass、两个 Diff、两份测试输出；重启后任务保留（外壳 E2E 实际重启） | E2E `result modal shows tested_pass/test output`；截图 `07` |

**真实 Pi 记录**：
- 第一次运行（任务文案为“Add a clarifying comment”）模型只加了注释，复测 `tested_fail`。说明任务措辞会直接影响修复行为。
- 第二次运行（文案改为“Fix the failing retry test”）模型输出正确的 off-by-one 修复，复测 `tested_pass`。
- 两次都未自动 commit / push / merge。

### 2.1 发布前 RC 收尾（Review #5816357081）

**自动创建 Sandbox 失败不再伪装成功**
- 默认快照配置改为 `package.json`；`tests/sandbox-smoke.test.mjs` 作为 node-smoke 固定路径自动加入，不再要求用户手工填写。
- 面板会按当前项目检查测试配置；缺少文件时在交办区显示警告，并在任务创建提示中列出缺少路径。
- 补丁应用结果与测试创建结果分开返回：补丁已应用但测试创建失败时，弹窗明确显示“已应用 / 创建失败 / 原因 / 缺少文件”，提供「打开测试配置」和「重试创建测试」，重试走已有 `companion:create-sandbox`，不会重复应用补丁。
- 回归：`npm run e2e:desktop:sandbox-config`（fake source，不跑 Docker）。

**多项目状态与成果隔离**
- 任务链（Job → Patch → Sandbox → Repair → Result）只聚合 `config.projectId` 对应的项目。
- 桌宠“工作中/完成/异常”和阶段摘要只反映当前项目；Worker 在别的项目上运行时不会把当前项目标成工作中。
- 全局待办仍保留，但每张卡明确标注「当前项目 / 其他项目 · 项目名」。
- 回归：`npm run e2e:desktop:multiproject`（双项目，p31 空闲 + p32 待审批）。

**模型切换生效**
- Worker 空闲时保存设置会直接更新提案 Agent 的模型并提示“模型已切换”。
- Worker 正在执行时不会打断当前任务，模型在任务结束后自动应用，并提示“将在当前任务结束后生效”。

## 3. 客户端外壳验收

`npm run e2e:desktop:shell`：

- 位置从 `companion.json` 恢复（220,180）；
- 桌宠 `focusable=false`、启动不抢焦点；
- 面板默认隐藏；可打开；桌宠可隐藏与召回；
- 预置待审批 Job 后重启（同一 `userData` / SQLite）：位置保持 220,180，任务仍在面板中，且仍不抢焦点；
- Worker 空闲时切换模型立即生效（`modelChanged=true / modelApplied=true / modelPending=false`）；
- 托盘菜单：显示桌宠、打开面板、完整工作台、设置、退出。

未验证：多显示器实机（当前环境单屏）；缩放/DPI 仅按 Electron 默认处理。

### 3.1 三轮真实 UX 迭代

每一轮都在真实 Electron 窗口/打包产物上运行，记录问题后修复并回归。

**第 1 轮：首次启动与面板**
- 发现：`.setup { display:grid }` 覆盖 `[hidden]`，已有项目时仍显示「先添加项目」。
- 发现：Worker 状态直接显示英文 kind；「聊天」按钮语义与 L2 不符。
- 修复：统一 `[hidden]` 优先级；Worker 状态中文化；按钮改为「工作台」；无项目时隐藏交办区并展示 Docker/模型自检。

**第 2 轮：完整业务闭环**
- 发现：应用补丁后自动创建 Sandbox 调用了未定义函数，异常被吞掉，用户卡在“下一项”。
- 发现：任务文案为“Add a clarifying comment”时，真实 Pi 只加注释，复测 `tested_fail`；界面当时只展示成功结果。
- 修复：补上 `createSandbox`；失败结果也进入结果卡并展示 `tested_fail`；E2E 改用真实意图文案并保留失败现场截图。

**第 3 轮：打包产物与长期状态**
- 发现：打包后 `domains/` 未包含在 asar，L2 Workbench 打不开。
- 发现：很久以前的失败/成功会让桌宠永久停在异常/完成状态；可选 Gateway 未连接被标成错误色。
- 修复：`files` 增加 `domains/`、`examples/`；状态只反映最近 30 分钟；Gateway 未连接改为警示色并标注“L2 可选”；结果弹窗增加自然语言摘要。

**第 4 轮：发布前 RC 复审**
- 发现：自动建沙箱失败仍提示“已请求测试”；默认快照配置像测试 fixture 专用。
- 发现：多项目时不同项目的 Job/Patch/Run/Cycle 被拼成一条状态旅程。
- 发现：保存模型后 Worker 仍使用旧模型。
- 修复：拆分应用/测试结果并增加重试与配置引导；任务链按当前项目过滤、全局待办加项目标签；模型空闲立即生效、忙碌时任务结束后生效。
- 回归：新增 `e2e:desktop:sandbox-config` 与 `e2e:desktop:multiproject`，并重跑真实 Docker + 真实 Pi 主链路。

四轮后回归：桌面 SOP-1..4、外壳、Sandbox 配置失败、多项目隔离、打包启动均通过；无已知阻断四条 SOP 的 P0/P1。

首次配置的诊断入口：无项目时展示 Docker / OpenClaw / 模型自检；设置页每次打开都会重新探测，并提供「重新检测」按钮，不需要重启应用。

## 4. 打包

```bash
npm run desktop:pack   # Windows x64 portable
```

产物：

- `dist-companion/OwnerCompanion-1.0.0-portable.exe`（约 122 MB）
- `dist-companion/win-unpacked/Owner Companion.exe`（可直接运行）

已实测打包后的应用可启动、创建 DB、截图、退出；`node:sqlite` 在 Electron 内可用。最终提交对应的 portable EXE（122,171,431 字节，本地构建 SHA256 `f7369064266831f5f6a49bc7e674c3923bfeb9f9c80e7b2d57ad4874b01da209`）与 `win-unpacked` 均已实机启动验证。

**私有 CI Artifact（Windows RC）**
- CI job `desktop-package` 在 `windows-latest` 执行 `npm run desktop:pack`；
- run `42446149023`（code commit `92e68d2b5faeeca50fa139705da8e92232799d27`）；
- artifact：`OwnerCompanion-1.0.0-portable-92e68d2b5faeeca50fa139705da8e92232799d27`（Artifact ID `13603543346`，122,191,416 字节）；
- 解压后 EXE SHA256：`020b39d92c060419682b003c06b029cec7b91fb87ba72b4334007cd494ea643c`；
- `SHA256SUMS.txt` 记录该 SHA256、对应 commit 与 run id；
- 仓库为私有，需登录有权限的 GitHub 账号在 Actions 运行页下载；不做公开发布。

限制：

- **未签名**（无代码签名证书），Windows 可能提示未知发布者；
- 使用 Electron 默认图标；
- 未生成 NSIS 安装器（portable 单文件可运行）；
- **macOS 未构建/未验证**：当前环境无 Apple Silicon/签名与 notarization 条件。可运行替代物：在 macOS 上 `npm install && npm run desktop` 从源码运行（未在本机验证）。

macOS（未执行）：

```bash
npx electron-builder --mac dmg --arm64
# 需要 Apple Developer ID、notarization 凭据；未提供则产物不可分发给最终用户
```

## 5. 自动化与证据

| 项 | 结果 |
| --- | --- |
| Owner 内核测试 | 194 tests / 191 pass / 3 skip / 0 fail（含 Worker、sidecar） |
| `npm run check` | 通过 |
| 4 个业务 demo | 通过 |
| OpenClaw 插件 build/validate | 通过（P3.1 PR） |
| 浏览器 E2E（OpenClaw Control UI） | P3.1 通过 |
| 桌面 E2E（Electron） | **通过**（SOP-1..4） |
| 外壳 E2E | **通过**（位置/焦点/隐藏/召回/重启保留/模型切换） |
| Sandbox 配置失败回归 | **通过**（错误反馈 + 配置警告 + 重试创建） |
| 多项目隔离回归 | **通过**（当前项目链、其他项目待办标签） |
| 打包应用启动 | **通过** |
| CI（PR #22） | run `42446149023` 全绿：plugin / sandbox-real / ubuntu test / windows test / desktop-package |

截图：`docs/assets/companion/`。

## 6. 已知问题 / 非阻断

1. 未签名、默认图标、无安装器（P2）。
2. macOS 未验证（外部条件）。
3. L1 仍是 2s 轮询，不是 OpenClaw `feature.watch`（P3.2）。
4. 状态“完成/异常”只保留 30 分钟，随后回到空闲；历史结果仍在结果卡中。
5. 多显示器只做了 clamp 逻辑，未实机验证。
6. 真实模型可靠性：任务措辞不当会得到“只加注释”的补丁；需要在任务模板/提示上继续优化。
7. 桌面 E2E 未进 CI（需要桌面会话 + Electron + Docker）。
8. 首次配置的项目选择使用系统目录对话框，无法在无头 CI 中自动化。
9. `node-smoke` profile 固定运行 `tests/sandbox-smoke.test.mjs`；陌生项目需要提供该文件，自定义测试命令留待后续 profile 扩展。
10. Windows RC 仅通过私有 CI Artifact 分发；未签名、未做公开 Release。

## 7. 复现命令

```bash
npm install
npm run desktop            # 开发运行
npm run e2e:desktop:shell  # 外壳验收
npm run e2e:desktop:sandbox-config  # 沙箱创建失败反馈与重试
npm run e2e:desktop:multiproject    # 多项目状态隔离
npm run e2e:desktop        # 四条 SOP（真实 Docker + 真实 Pi）
npm run desktop:pack       # Windows portable
```

第一次启动：

1. 桌宠出现；点击打开面板；
2. “选择项目目录”添加一个 Git 仓库；
3. 设置里确认 Docker / 模型；OpenClaw 可选（L2）；
4. 输入任务 → 批准 → 按提示处理补丁/测试/修复。

## 8. DoD 对照

| DoD | 状态 |
| --- | --- |
| 四条 SOP 真实交互 | ✅ |
| 新项目从桌宠发起第一条 Coding Job | ✅ |
| 无 CLI 正常交互 | ✅ |
| Job → Patch → Sandbox → Repair → Retest → Result 真实成功 | ✅ |
| 不绕过人工审批 | ✅ |
| 关闭重开状态不丢 | ✅（SQLite；外壳 E2E 实际重启验证） |
| 启动/拖动/收起/隐藏/召回 | ✅（多显示器未实测） |
| 托盘/窗口/状态 | ✅ |
| 闲置不频繁请求模型 | ✅（2s 仅本地 HTTP；Worker 空闲不调用模型） |
| 不抢焦点 | ✅ |
| 三轮 UX | ✅（四轮：外壳 / 桌面 E2E / 打包 / RC 复审） |
| 无 P0/P1 | ✅（当前无阻断） |
| Windows 分发包 | ✅（未签名 portable；私有 CI Artifact + SHA256） |
| macOS 分发包 | ❌ 未验证，已说明缺口 |
| 首次配置说明 | ✅ |
| 自动化/真实模型记录 | ✅ |
| 截图/演示材料 | ✅ |
| Release Notes | ✅ |
| 构建命令/证据 | ✅ |
