# 技术债（v1.1 OpenClaw-first，截至 2026-11-08）

本轮优先级：**业务闭环 > 用户体验 > 代码复用 > 非关键防御性加固**。
以下项目已识别、当前**不扩大实现**，留待后续版本。

## 安全 / 审计

1. **apply 审计不与文件写入原子**：批准决策写在业务事务内；`apply` 涉及文件系统，无法与数据库共事务。
   后续可在 apply 前后写状态行 + 对账命令。
2. **拒绝决策未写 `owner_decision_audit`**：目前只覆盖 job/patch/sandbox/repair 的 approve。
   reject 仍写各自的 job/proposal/sandbox oplog。
3. **审批令牌是持有者凭据，不是人员身份**：多用户场景需要把令牌绑定到已验证的操作者身份
   （OpenClaw profile 或设备签名）。
4. **未接入 `plugin.approval.*` 原生审批**：当前用独立审批令牌满足隔离要求。
   等 OpenClaw 暴露可由 UI 直接发起并等待结果的审批 API 后，可把“审批令牌”替换为 operator scope 收据。
5. **插件未强制工具策略**：Owner 会话的 `exec`/文件读取/浏览器 deny 列表写在 README，
   但插件无法验证它；需要在 Gateway 配置层强制。
6. **HTTPS Gateway + sidecar 混内容**：浏览器直连要求 loopback HTTP；TLS 部署需要 sidecar TLS 或同源反代。
7. **审计来源是 claimed**：`X-Owner-Origin` 仍由调用方自报；已与 principal 分离，但没有签名验证。

## 业务 / 体验

8. **页面靠手动 Refresh**：没有 SSE/WebSocket 推送；OpenClaw 的 `feature.watch` 需要插件事件。
9. **没有 job 创建表单**：提交走聊天工具；页面只做审批与查看。
10. **Repair 只到“批准”**：批准后会创建 repair job，但 UI 不展示 worker 执行进度；
    需要 worker 侧事件或轮询。
11. **多轮修复（L4）未做**：仍是一轮 `iteration=1`。
12. **模型身份未持久化**：Proposal/Cycle 不记录 provider/model（沿用 #14 的结论）。

## 工程

13. **浏览器 E2E 未进 CI**：需要浏览器 channel + 安装 276 MB 插件；当前作为本地/发布前证据。
14. **Sidecar 关闭是尽力而为**：Windows 下 Ctrl+C 不保证 SQLite 优雅关闭；依赖 WAL 恢复。
15. **插件安装体积**：路径安装会复制 `node_modules`（约 276 MB）；后续可提供精简包或 `--link` 的稳定支持。

## 第三轮 Review（5813975671，2026-11-07）新增

PR #17 的客户端 PoC 验收已通过；以下为明确保留、本轮不扩展的非阻断项：

16. **完整 P3 用户旅程未跑通**：当前浏览器 E2E 从“预置项目”开始，覆盖 Job 审批 → 已应用 Patch 的只读 Diff → 失败 Sandbox 展示 → Repair 批准。
    尚未在浏览器中从聊天实际创建 `code-patch` Job、审批/应用新 Patch、发起并审批 Sandbox、
    驱动 Repair Worker 生成新补丁并复测至 pass。下一阶段以这条真实旅程验收。
17. **状态更新体验**：页面仍是手动 Refresh；Repair `queued` 后没有 Worker 进度、测试日志与最终结果。
    优先复用 OpenClaw 现有 feature/event/订阅能力，或短期轻量轮询，不重写 WebSocket/Gateway。
18. **E2E 断言稳健性**：`scripts/e2e/openclaw-ui.mjs` 写死了 proposal hash `6185af42`；
    页面内任意 `queued` 也可能被 Job 的 `queued` 误满足。下一轮改为从 seed/API 返回实际 hash，
    并精确核对 repair cycle id/status 或直接查询 sidecar 数据。
19. **发布前证据**：浏览器 E2E 目前只在本地运行，GitHub CI 尚未执行该脚本，也没有 CI 可核验的截图/录屏。
    下一阶段在目标开发机保留产物并演示，不把“脚本存在”当作“发布质量独立验收完成”。
20. **适用范围**：当前只适用于单机可信开发 PoC；不要标注为多用户/公网安全方案。
21. **合并依赖**：#15 是 #16/#17 的 base；必须先合并 #15，再显式核对 #16/#17 对 `main` 的最终差异并重跑 CI，
    不假设 GitHub 自动改基。
