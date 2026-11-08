# Owner Companion v1.0.0 — Release Notes

- 日期：2026-11-08
- 平台：Windows 10/11 x64（便携包）；macOS 未验证
- 形态：Electron 桌宠 + 进程内 Owner Runtime

## 亮点

### 桌宠
- 透明、无边框、置顶、不抢焦点；
- 拖动、托盘、位置持久化、单实例；
- 五种状态：空闲 / 工作中 / 等待决定 / 已完成 / 异常；
- 点击展开 L1 快捷面板。

### 四条 SOP
1. **交办任务**：在面板输入自然语言 → 创建 OwnerTask + Coding Job；不需要 Job Type/Base SHA/JSON。
2. **处理决策**：Job/Patch/Sandbox/Repair 的审批卡；Patch 显示冻结 Diff；批准与应用分离。
3. **异常恢复**：测试失败 → 创建修复 → 批准 → 常驻 Worker 自动生成修复补丁 → 复测。
4. **进展与成果**：自动刷新；阶段摘要；结果面板含 Diff 与测试输出；重启后任务不丢（外壳 E2E 实际重启验证）。

### 运行时
- 进程内启动 Owner sidecar + 常驻 Worker，复用 v1.1 的 Patch/Sandbox/Repair 执行器；
- 审批令牌只在 Electron 主进程，渲染进程通过受控 IPC 操作；
- OpenClaw 不是 L1 的依赖：L2「完整工作台」才连接 Gateway，未连接时回退 Workbench；
- 旧 Workbench 的 companion 悬浮问答与静态页已移除，避免第二套聊天状态。

## 安装 / 运行

```bash
npm install
npm run desktop
```

首次使用：

1. 点击桌宠打开面板；
2. 选择项目目录（Git 仓库）；
3. 在设置中确认 Docker 与模型；OpenClaw 可选；
4. 输入任务并批准。

## 打包

```bash
npm run desktop:pack
```

产物：`dist-companion/OwnerCompanion-1.0.0-portable.exe`（未签名，Electron 默认图标）。

macOS：

```bash
npx electron-builder --mac dmg --arm64
```

需要 Apple Developer ID 与 notarization 凭据；当前未验证。

## 已知问题

- 未签名；Windows 可能提示未知发布者。
- 未做多显示器实机验证。
- L1 使用 2s 轮询（P3.2 计划换 `feature.watch`）。
- 真实模型对任务措辞敏感；措辞不当可能得到“只加注释”的补丁。
- 桌面 E2E 未进 CI（需要桌面会话 + Electron + Docker）。
- macOS 未构建/未签名验证。

## 验证

- 内核测试 194 / 191 pass / 3 skip；
- 桌面 E2E（SOP-1..4，真实 Docker + 真实 Pi）通过；
- 外壳 E2E（位置/焦点/隐藏/召回/重启保留）通过；
- 打包应用启动通过。
