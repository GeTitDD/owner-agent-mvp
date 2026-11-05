# Pi Analysis Worker（v0.7 / P0）

对应 Issue [#3]。首个**真实执行闭环**：Owner 审批 → 手动触发 → 无工具、只读 Pi Session → 有界、可哈希、项目私有的分析产物。真实模型调用只发生在显式 `--allow-model` 之下；`npm test`、CI、两个 demo 均为 fake session，**零模型请求、零费用**。

## 生命周期

```
OwnerTask(人工) ──引用──▶ ExecutionJob(pi-analysis, pending_approval)
        │                        │ Owner approve（含项目栅栏检查；**同时固定输入快照 input_snapshot**）
        │                        ▼
        │              queued ──claim(按 Worker 类型过滤)──▶ leased ──start──▶ running
        │                                                │  watchdog 自 start 起覆盖全程（含 create 阶段）
        │                                                │  PiSessionFactory.create({cwd=注册项目根})
        │                                                │  ├─ 空 agentDir + noTools:true + inMemory
        │                                                │  ├─ **显式禁用全部资源发现**（noExtensions/
        │                                                │  │  noSkills/noPromptTemplates/noThemes/
        │                                                │  │  noContextFiles——项目 .pi/extensions 与
        │                                                │  │  AGENTS.md 不会被加载，含真实施计验证）
        │                                                │  ├─ fail-closed：activeTools 必须为空（未知=不安全）
        │                                                │  ├─ watchdog：heartbeat + cancel→abort()
        │                                                │  └─ prompt 前重校验租约/取消/栅栏
        │                                    ┌───────────┴────────────┐
        │                              abort 确认                 settled / error / timeout
        │                                    ▼                            ▼
        └──(永不自动完成)◀── confirmCancel ──▶ cancelled   **原子提交** completeJobWithResult
                                            （结果 INSERT + succeeded 终态同一事务；租约失效/取消
                                             竞态不可能留下孤儿结果）→ succeeded
```

**超时停止确认**：timeout → `abort()` → 有界等待 prompt settle（`abortConfirmMs`，默认 5s）→ 确认停止才落 `failed`；**未确认停止 → 静默进入人工裁定**（会话可能仍在运行，不得释放项目执行互斥）。

## PiSessionFactory 契约

```
factory.create({cwd, model?}) -> {
  sessionId(), prompt(text), abort(), activeTools(), getLastText(), model, dispose()
}
```

- 生产实现 `DefaultPiSessionFactory`（`src/pi-session-factory.mjs`）绑定已安装 SDK；测试/演示注入 fake。
- **项目级隔离（实测）**：默认 loader 会把用户全局 agent 目录的扩展工具带入会话（本机实测 21 个）。生产路径每次 `create` 用 `mkdtemp` 建**一次性空 agentDir**，`noTools:true` + `SessionManager.inMemory()` + 该隔离 loader → 实测 active tools `[]`；dispose 时清理临时目录。
- 模型凭据仍经 SDK 默认鉴权链路（env / 全局凭据库）解析——仅用于鉴权与计费，不携带任何行为配置；扩展、skills、settings 全部隔离。
- **fail-closed**：`activeTools()` 非空（或未来发现其他未授权能力）→ `abort()+dispose()` 并以 `failed` 落账（`tool isolation verification failed (N active tools)`），绝不发送 prompt。

## 取消与心跳

- `heartbeatJob` 放行 `cancel_requested`（v0.7 预授权修订）：等待 SDK abort 确认期间必须续租，否则 abort 在途即被扫描隔离。
- watchdog 周期 `leaseMs/3`（timers 可注入，测试手动触发）：每 tick 先 heartbeat（失败即 fenced），再检测 `cancel_requested` → `session.abort()`。
- prompt 结束后：`cancel_requested` → `confirmJobCancelled`；正常完成 → 原子提交结果 + `succeeded`；error/timeout → `failed`（错误只记固定分类：`session-aborted/timeout/auth-error/network-error/session-error`，不落上游 message 原文）；timeout 后确认窗口内**继续心跳**，无法确认停止才停止续租并进入人工裁定。
- fenced（租约丢失）：中止会话、**不存产物、不报告**，交 reconcile。

## 存储与最小化

- `owner_job_attempts` 增列 `session_id`（守卫式 ALTER，可重入；仅非敏感会话 id）；`owner_jobs` 增列 `input_snapshot`（审批事务内固定任务标题/说明，批准后的任务编辑不影响已批 Job）。
- 新表 `owner_job_results`：项目私有产物（content ≤65536 字符、sha256 content_hash、model、truncated 标记、usage 默认 `unknown`——SDK usage 不可得时不编造）。
- Job 行与审计事件只引用 `chars:<n>; tools:0; usage:unknown`；**prompt、回答原文、密钥、工具 I/O、上游错误消息原文一律不入库**——错误只记固定分类（`session-aborted/timeout/auth-error/network-error/session-error`，有测试断言）。
- 成功路径使用 `completeJobWithResult` **原子提交**：与 `reportJobResult` 相同的 Worker/Attempt/租约校验 + 结果 INSERT 在同一 `BEGIN IMMEDIATE` 事务内，租约失效/取消竞态不可能留下孤儿结果。

## 队列一致性

`claimNextJob` 支持 `allowedTypes` 过滤（SQL WHERE 下推）：Pi Worker 只承领 `pi-analysis`，FakeWorker 只承领 fake 类型——混合队列中错误类型不会被错误执行器承领后留在 leased 态（有混合队列测试）。

## 手动运行

```bash
# 真实模型（需要已配置的 Pi 凭据；--allow-model 必须显式给出）
node bin/ownerctl.mjs run-once --worker pi --project my-project --allow-model 1 [--model provider/model] [--timeout 120000]

# 只读查询
node bin/ownerctl.mjs result --id <RESULT_ID>      # 完整内容（本机 Owner 权限）
node bin/ownerctl.mjs results --job <JOB_ID>       # 元数据列表
```

## 创建期 deadline 与路径漂移

- `sessionFactory.create()` 受独立 deadline（`createTimeoutMs`，默认 30s）约束；超时即 abort 控制器、**停止续租**（租约自然过期 → `needs_reconciliation`），迟到的 session 由工厂信号 + Worker 双层 abort+dispose，**绝不 prompt**。
- 每次运行前校验注册根的文件身份（dev/ino 哈希）：目录被删除重建或替换为指向他处的链接 → `project-root-moved` 拒绝，零会话创建。
- Owner 认知入口 `ownerctl ask-pi` 与 Worker 走**同一条隔离链路**（一次性空 workDir/agentDir + noTools + 工具面 fail-closed 校验）——全局/项目扩展注入风险对该入口同样不成立（marker 对照测试锁定）。

## 真实 Pi 冒烟（可选）

```bash
OWNER_AGENT_REAL_PI_TEST=1 npm test        # 仅此环境变量+凭据可用时执行；跳过不使 CI 失败
```

冒烟流程：临时受控项目 → 注册 → OwnerTask → 审批 → `allowModel` 执行 → 断言真实 session id、非空产物、`provider/model` 标识、OwnerTask 未变。本机（隔离 agentDir + ZAI 凭据）实测 **PASS**。

## 已知隔离限制（fail-closed 声明）

- 资源发现**显式禁用**（`noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles`），并有真实施计验证：含 `.pi/extensions` 扩展与 AGENTS.md 的项目，经工厂创建的会话**不会加载它们**（对照实验：默认 loader + 显式信任则确实加载——检测手段有效，见 `tests/pi-isolation.test.mjs`）。
- `activeTools()` 若 SDK 未来不提供枚举方法，适配器返回 `null` → Worker 视为"未知"按不安全处理（不是当作空集）。
- 模型凭据来自本机 SDK 默认鉴权链路。若需要按项目隔离凭据，可改用 env 注入（如 `ZAI_API_KEY`），留待后续。
- 只读靠「无工具 + 零资源加载」结构性保证，模型本身仍可能输出误导内容——产物仅是分析文本，不执行、不发布、不影响项目文件。
