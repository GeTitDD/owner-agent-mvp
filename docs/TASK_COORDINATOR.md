# Durable Task Coordinator（v0.6 / P0）

对应 Issue：[GeTitDD/owner-agent-mvp#1]。本阶段只交付**控制面 + FakeWorker 端到端闭环**：可持久化、可审核、崩溃后可恢复判定的 Job 生命周期。**不含**真实 Pi/Shell 执行器、自动调度、模型自治；Worker 承领的 Job 不会触碰项目文件，也不会获得 Owner 权限。

## 领域模型

| 实体 | 存储 | 说明 |
|---|---|---|
| OwnerTask | `owner_tasks`（v0.5 原表） | 人的目标/待办。`agent_settled` 与 Worker 成功**都不会**把它自动置为 done。 |
| ExecutionJob | `owner_jobs` | 一次明确授权的执行请求。绑定已登记 `project_id`，可选 `owner_task_id`，全库唯一 `id`，`(project_id, idempotency_key)` 唯一。 |
| JobAttempt | `owner_job_attempts` | 一次 Worker 承领/执行尝试。`UNIQUE(job_id, attempt)`，attempt 严格递增，历史永久保留。 |
| Job 审计事件 | `owner_job_events` | 每次状态迁移的追加记录（actor / action / detail / at）。detail 为脱敏短文本。 |
| Project Agent Run | `owner_runs`（v0.5 原表） | Pi 等执行器的运行记录。与 Job 是**引用关系**（未来通过 attempt 扩展关联），不复用其状态机。 |

## 状态机

```
pending_approval ──approve──▶ queued ──claim──▶ leased ──start──▶ running ──▶ succeeded / failed
       │                        │                 │                    │
       ├──reject──▶ rejected     ├──cancel──▶ cancelled   │                    ├──cancel request──▶ cancel_requested
       ├──cancel──▶ cancelled    (租约到期 + reconcile 扫描)│                    │                      │
       └─(终态)                              ▼            │                      │                      ├──worker confirm──▶ cancelled
                              needs_reconciliation ◀─────┴──────────────────────┘        ├──结果仍可提交──▶ succeeded / failed
                              （隔离区，绝不自动重执行；**栅栏隔离整个项目**：                          └─(终态)
                               同项目其他 Job 一律禁止 approve/claim，直到人工裁定）
                                  │
                                  ├──requeue──▶ queued（第 attempt+1 次尝试）
                                  ├──cancel ──▶ cancelled
                                  └──fail   ──▶ failed
```

允许的迁移与前置条件（全部在 `BEGIN IMMEDIATE` 事务内校验 + CAS 条件更新， 违反一律 HTTP 语义错误码）：

| From | Action | To | 前置条件 |
|---|---|---|---|
| pending_approval | approve | queued | **项目栅栏：同项目无 `needs_reconciliation` Job**；且管道内 active Job（queued/leased/running/cancel_requested）数 < `maxActiveJobsPerProject`（默认 1） |
| pending_approval | reject | rejected | —（终态；理由入审计） |
| pending_approval / queued | requestCancel | cancelled | 尚未执行，直接终态 |
| queued | claim | leased | **项目栅栏同上**；项目内 active Job 数 < `maxActiveJobsPerProject`（claim 与 approve 共同尊重该参数）；CAS `WHERE status='queued'`；创建 attempt N+1 并记录租约 |
| leased | start | running | 仅 attempt 属主 Worker；attempt 处于 claimed |
| leased / running / cancel_requested | heartbeat | （不变） | 仅属主 Worker；attempt claimed/running；租约未过期——**cancel_requested 亦续租**（v0.7：abort 等待期间不能被扫描隔离） |
| running | report(succeeded/failed) | 同名终态 | 仅属主 Worker、仅最新 attempt、attempt 处于 running、租约未过期 |
| running / cancel_requested | report(succeeded/failed) | 同名终态 | Worker 无视停止请求完成时，如实记录真实结果 |
| leased / running | requestCancel | cancel_requested | 「请求取消」≠「已停止」；Worker 须显式确认 |
| cancel_requested | worker confirm | cancelled | 仅属主 Worker；attempt claimed/running |
| cancel_requested | worker abandon（FakeWorker 返回 cancelled 但无请求） | failed | 无请求的自行放弃按失败记录，防止 Worker 用 cancel 伪造成功语义 |
| leased / running / cancel_requested | 租约到期 + 显式 reconcile 扫描 | needs_reconciliation | **绝不自动重执行**；attempt 标记 orphaned |
| needs_reconciliation | reconcile(requeue/cancel/fail) | queued / cancelled / failed | requeue **必须携带非空安全复核理由**（崩溃恢复可能重复未知外部副作用，理由入审计）；仍受同项目 active 限制约束；全部入审计 |
| succeeded / failed / cancelled / rejected | — | — | 终态，任何迟到结果都被拒绝 |

**迟到结果防护**：report/confirm/heartbeat 要求 `attempt == job.last_attempt` 且 attempt 处于非终态；attempt 为 orphaned 或 job 已离开 running 态时一律 409。旧的 attempt 永远无法覆盖新 attempt 或终态。

## 存储约束与迁移

- 三张新表全部 `CREATE TABLE IF NOT EXISTS`，在 `OwnerStore` 构造器内与既有表同批执行：**迁移天然可重入**，旧 v0.5 数据库首次用新代码打开即获得新表，原数据、原接口零改动。
- 外键启用（`PRAGMA foreign_keys=ON`），jobs/attempts/events 均带 `REFERENCES` 与 CHECK 约束；`UNIQUE(project_id,idempotency_key)` 是幂等性的最终防线（应用层先查重给出更友好的 409 文案）。
- 关键索引：`(project_id,status,created_at)` 支撑 FIFO 承领；`(status,created_at)` 支撑过期扫描与总览。
- 并发正确性：所有状态迁移使用 `BEGIN IMMEDIATE` 写事务 + 条件 UPDATE（CAS，检查 `changes===1`）。多进程/多连接竞争同一 Job 时，SQLite 单写者串行化保证只有一个 claim 成功；同项目最多 `maxActiveJobsPerProject` 个 active Job（默认 1，**claim 与 approve 共同尊重该配置**），多项目互不阻塞。
- 幂等键语义：幂等身份 = `(project_id, idempotency_key, job_type, canonical payload, owner_task_id)` 五元组——同项目内五元组全同的重复提交返回原 Job（`duplicate:true`）；同 key 但 payload 或**目标 OwnerTask 不同** → 409 冲突；不同项目相同 key 是不同 Job。payload 以 sorted-keys canonical JSON 存储，比较不受键序影响。`title` 是纯展示字段，不参与幂等判断（重复提交不会改写已存 title）。
- 时间注入：**所有 Job 方法（含 `createJob`）**均接受 `now` / `leaseMs` 参数（默认真实时钟），租约比较使用 ISO 字符串序，测试用 fake clock，**无 sleep**。
- **租约边界统一**：`start` / `heartbeat` / `report` / `confirmCancel` 全部要求 `lease_until >= now`——租约过期后旧 Worker 在 reconcile 扫描前也无法做任何迁移，必须走人工裁定路径。

## WorkerAdapter 契约（`src/job-worker.mjs`）

```
WorkerAdapter = {
  id: string,                       // 稳定 Worker 标识（进 attempt 与审计）
  runOnce({projectId, behavior})    // 手动触发一次：claim → (可选 pre-start 取消检查) → start → behavior → report/confirm
}
```

- **FakeWorker**：behavior 可注入 `succeeded | failed | cancelled | crash` 与 result note；`crash` 抛出 `FakeWorkerCrash`，不报告任何结果，租约留给显式 reconcile——精确模拟执行器死亡。
- Worker 只见到脱敏 Job 行（payload/类型/标题），拿不到 Owner 凭据；payload 是纯数据，Worker 不会把它当命令执行。
- **没有任何自动启动路径**：Resident 保持只读，不调用 Worker；执行只能由 Owner 显式 `run-once`（CLI）或未来显式授权的调度器触发。

## CLI（`bin/ownerctl.mjs`）

```bash
# 提交（默认 pending_approval；--key 为项目内幂等键，必填）
node bin/ownerctl.mjs job-submit --project my-project --type noop --title '重放幂等检查' --payload '{"scope":"retry"}' --key run-20260601 [--task <ownerTaskId>]

# 审批 / 拒绝
node bin/ownerctl.mjs job-approve --id <JOB_ID>
node bin/ownerctl.mjs job-reject --id <JOB_ID> --reason '类型不允许'

# 查询
node bin/ownerctl.mjs jobs [--project P] [--status pending_approval]
node bin/ownerctl.mjs job --id <JOB_ID>        # 含 attempts 与审计事件
node bin/ownerctl.mjs summary                   # 含 activeJobs / pendingJobApprovals / stuckJobs

# 手动执行一次（FakeWorker；behavior 可注入 succeeded/failed/cancelled/crash）
node bin/ownerctl.mjs run-once --project my-project --worker demo-worker --behavior succeeded

# 取消与裁定
node bin/ownerctl.mjs job-cancel --id <JOB_ID>                          # queued 前直接取消；执行中转为 cancel_requested
node bin/ownerctl.mjs jobs-reconcile                                    # 扫描租约过期 → needs_reconciliation
node bin/ownerctl.mjs job-reconcile --id <JOB_ID> --decision requeue|cancel|fail [--reason '...']
```

端到端演示（临时库 + fake clock，零外部依赖）：

```bash
npm run demo:jobs
```

## Owner 总览集成

- `summary()` 的 Job 计数（`activeJobs / pendingJobApprovals / stuckJobs / totalJobs`）全部来自 SQL `COUNT/GROUP BY` **全表聚合**，与列表分页上限无关；每项目 `jobs` 切片是 SQL 级 `LIMIT 8` 查询（只增字段，v0.5 消费方兼容）；`/api/owner/summary` 自动携带。
- `listJobs` 的 status/projectId 过滤在 SQL `WHERE` 中完成（不再"先 LIMIT 后 JS 过滤"）；`listJobsWithExpiredLeases` 提供过期租约定向查询。
- `OwnerAgent.attention()` 新增三类注意力项：`job-stuck` 与 `job-lease-expired`（high，标题计数为**同过滤条件的 SQL COUNT 真值**，evidence 列表显式封顶 100）、`job-approval`（normal，计数同样来自全表聚合）。
- `OwnerAgent.answer()` 新增 Job 查询分支（关键词 执行/job/队列），头部数字为全表聚合，回答引用 `job:<id>` 持久化记录。

## 测试

`tests/task-coordinator.test.mjs`，19 项确定性测试（fake clock，无 sleep），覆盖 Issue 要求的全部不变量，另含 5 项针对首轮 Review 反馈的回归测试（[review r1 #1/#2/#3/#5/#6]：审计时间、过期租约封禁 start/confirm、幂等身份含目标 Task、超限计数精确性、requeue 强制理由）。原有 62 项测试保持通过，全量 **81/81**。

`npm run demo:jobs` 演示带 20 项显式断言，任何关键状态不符合预期即 `[FAIL]` 并以非零退出码结束。

## 已知限制与剩余风险

- `run-once` 是单次手动执行；没有守护式调度队列，没有真正的多进程压力测试（用双连接模拟）。
- 审批/裁定目前只在 CLI；Workbench HTTP 与 Companion UI 尚无 Job 操作入口（summary 已可见）。
- Resident 仍为只读：租约过期只产生注意力提醒，标记动作需显式 `jobs-reconcile`。若未来希望在 Resident tick 中自动标记，需先修订「Resident 不做变更」的既定不变量。
- `cancel_requested` 下 Worker 完成时会把真实结果（succeeded/failed）入账；「取消请求被无视」目前只有审计可查，没有告警升级。
- Job 类型白名单（`noop / status-note / fake-analysis`）刻意极简；接入真实执行器前需要扩展类型注册与每类型 payload 校验。
