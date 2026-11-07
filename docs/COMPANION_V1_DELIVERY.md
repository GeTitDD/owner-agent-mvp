# Owner Companion v1.0 — 交付报告

- 日期：2026-11-08
- 基线：`main@8c14707` + PR #21（P3.1）之上的 Companion 分支
- 运行环境：Windows 11（10.0.26100）、Electron 45.2.3、Node 22.20、Docker 29.4.3、Pi 默认模型
- 结论：**四条核心 SOP 已通过真实桌面交互验收；Windows 便携包已生成；macOS 未验证（见缺口）。**

## 1. 产品形态

Electron 桌宠 + 进程内 Owner Runtime：

- 透明、无边框、置顶、不抢焦点、可拖动、托盘、位置持久化；
- 五种状态：空闲 / 工作中 / 等待决定 / 已完成 / 异常；
- L1 面板：交办、决策、异常恢复、进展与成果；
- L2：打开 OpenClaw Control UI（未连接时回退到 Workbench）；
- 审批令牌只存在主进程；渲染进程通过受控 IPC 操作。

## 2. 四条 SOP 验收

桌面 E2E：`npm run e2e:desktop`（真实 Electron 窗口 + 真实 Docker + 真实 Pi）。

| SOP | 验收 | 证据 |
| --- | --- | --- |
| SOP-1 交办任务 | 空 Job 项目，从面板输入“Fix the failing retry test” → 创建 Job，无 CLI | E2E `SOP-1 job created from the pet` |
| SOP-2 处理决策 | Job 批准 → Patch Diff 审阅/批准/应用 → Sandbox 审批；拒绝路径存在 | E2E 前 6 项断言；截图 `01/02` |
| SOP-3 异常恢复 | 真实 Docker 失败 → 创建修复 → 批准 → 真实 Pi 生成修复补丁 → 应用 → 复测 pass | E2E `source sandbox failed` … `repair retest passed`；截图 `04/05/06` |
| SOP-4 进展与成果 | 状态自动刷新；结果面板含 tested_pass、两个 Diff、两份测试输出；重启后数据仍在 SQLite | E2E `result modal shows tested_pass/test output`；截图 `07` |

**真实 Pi 记录**：
- 第一次运行（任务文案为“Add a clarifying comment”）模型只加了注释，复测 `tested_fail`。说明任务措辞会直接影响修复行为。
- 第二次运行（文案改为“Fix the failing retry test”）模型输出正确的 off-by-one 修复，复测 `tested_pass`。
- 两次都未自动 commit / push / merge。

## 3. 客户端外壳验收

`npm run e2e:desktop:shell`：

- 位置从 `companion.json` 恢复（220,180）；
- 桌宠 `focusable=false`、启动不抢焦点；
- 面板默认隐藏；可打开；桌宠可隐藏与召回；
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

三轮后回归：桌面 SOP-1..4、外壳、打包启动均通过；无已知阻断四条 SOP 的 P0/P1。

## 4. 打包

```bash
npm run desktop:pack   # Windows x64 portable
```

产物：

- `dist-companion/OwnerCompanion-1.0.0-portable.exe`（约 122 MB）
- `dist-companion/win-unpacked/Owner Companion.exe`（可直接运行）

已实测打包后的应用可启动、创建 DB、截图、退出；`node:sqlite` 在 Electron 内可用。最终提交对应的 portable EXE（122,170,475 字节）与 `win-unpacked` 均已实机启动验证。

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
| 外壳 E2E | **通过** |
| 打包应用启动 | **通过** |
| CI（PR #22） | run `42426257732` 全绿：plugin / sandbox-real / ubuntu test / windows test |

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

## 7. 复现命令

```bash
npm install
npm run desktop            # 开发运行
npm run e2e:desktop:shell  # 外壳验收
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
| 关闭重开状态不丢 | ✅（SQLite） |
| 启动/拖动/收起/隐藏/召回 | ✅（多显示器未实测） |
| 托盘/窗口/状态 | ✅ |
| 闲置不频繁请求模型 | ✅（2s 仅本地 HTTP；Worker 空闲不调用模型） |
| 不抢焦点 | ✅ |
| 三轮 UX | ✅（外壳 smoke / 桌面 E2E / 打包实测） |
| 无 P0/P1 | ✅（当前无阻断） |
| Windows 分发包 | ✅（未签名 portable） |
| macOS 分发包 | ❌ 未验证，已说明缺口 |
| 首次配置说明 | ✅ |
| 自动化/真实模型记录 | ✅ |
| 截图/演示材料 | ✅ |
| Release Notes | ✅ |
| 构建命令/证据 | ✅ |
