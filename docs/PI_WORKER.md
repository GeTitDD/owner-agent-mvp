# Pi Analysis Worker（v0.7 / P0）

对应 Issue [#3]。首个**真实执行闭环**：Owner 审批 → 手动触发 → 无工具、只读 Pi Session → 有界、可哈希、项目私有的分析产物。真实模型调用只发生在显式 `--allow-model` 之下；`npm test`、CI、两个 demo 均为 fake session，**零模型请求、零费用**。

## 生命周期

```
OwnerTask(人工) ──引用──▶ ExecutionJob(pi-analysis, pending_approval)
        │                        │ Owner approve（含项目栅栏检查）
        │                        ▼
        │              queued ──claim──▶ leased ──start──▶ running
        │                                                │  PiSessionFactory.create({cwd=注册项目根})
        │                                                │  ├─ 空 agentDir + noTools:true + inMemory
        │                                                │  ├─ fail-closed：activeTools 必须为空
        │                                                │  ├─ watchdog(leaseMs/3)：heartbeat + cancel→abort()
        │                                                │  └─ prompt(受控模板) / timeout
        │                                    ┌───────────┴────────────┐
        │                              abort 确认                 settled / error / timeout
        │                                    ▼                            ▼
        └──(永不自动完成)◀── confirmCancel ──▶ cancelled      addJobResult(哈希+有界) → succeeded
```

Worker 失联（heartbeat 失败 / 进程丢失）：立即 `session.abort()` 停止花费、**静默停止不报告**，由 `jobs-reconcile` 扫描进入 `needs_reconciliation`；重排队必须附安全复核理由。迟到结果被 v0.6 状态机拒绝。

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
- prompt 结束后：`cancel_requested` → `confirmJobCancelled`；正常完成 → 存结果 + `succeeded`；error/timeout → `failed`（错误分类脱敏记录：仅 name+首 120 字符）。
- fenced（租约丢失）：中止会话、**不存产物、不报告**，交 reconcile。

## 存储与最小化

- `owner_job_attempts` 增列 `session_id`（守卫式 ALTER，可重入；仅非敏感会话 id）。
- 新表 `owner_job_results`：项目私有产物（content ≤65536 字符、sha256 content_hash、model、truncated 标记、usage 默认 `unknown`——SDK usage 不可得时不编造）。
- Job 行与审计事件只引用 `result:<id> sha:<8位> chars:<n>; tools:0; usage:unknown`；**prompt、回答原文、密钥、工具 I/O 一律不入库**（测试断言）。

## 手动运行

```bash
# 真实模型（需要已配置的 Pi 凭据；--allow-model 必须显式给出）
node bin/ownerctl.mjs run-once --worker pi --project my-project --allow-model 1 [--model provider/model] [--timeout 120000]

# 只读查询
node bin/ownerctl.mjs result --id <RESULT_ID>      # 完整内容（本机 Owner 权限）
node bin/ownerctl.mjs results --job <JOB_ID>       # 元数据列表
```

## 真实 Pi 冒烟（可选）

```bash
OWNER_AGENT_REAL_PI_TEST=1 npm test        # 仅此环境变量+凭据可用时执行；跳过不使 CI 失败
```

冒烟流程：临时受控项目 → 注册 → OwnerTask → 审批 → `allowModel` 执行 → 断言真实 session id、非空产物、`provider/model` 标识、OwnerTask 未变。本机（隔离 agentDir + ZAI 凭据）实测 **PASS**。

## 已知隔离限制（fail-closed 声明）

- `tools:[]/noTools` 只约束内置工具；**扩展可通过生命周期钩子产生非工具行为**，本方案靠一次性空 agentDir 使扩展集合为空来消除，且每轮以 `activeTools()===[]` 验证工具面。若未来 SDK 出现绕过该验证的加载路径，应视为安全问题处理。
- 模型凭据来自本机 SDK 默认鉴权链路。若需要按项目隔离凭据，可改用 env 注入（如 `ZAI_API_KEY`），留待后续。
- 只读靠「无工具 + 空扩展」保证，模型本身仍可能输出误导内容——产物仅是分析文本，不执行、不发布、不影响项目文件。
