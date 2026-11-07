# Owner-controlled Patch–Test–Repair（v1.0 / P0）

对应 Issue [#9]。本阶段在 v0.8（受控补丁）与 v0.9（沙箱测试）之上增加**一次可审计的修复轮次**：Owner 从一次已完成且失败的 SandboxRun 出发，批准一个新的修复 Job；Pi 在**全新 Worktree** 上生成完整替换提案；Owner 再次审批 apply，并再次审批 sandbox 测试。模型不能因测试日志获得额外权限，也不能自动循环。

## 1. 不变量

- `OwnerTask != ExecutionJob != Attempt != PatchProposal != Workspace != SandboxRun != RepairCycle`。
- RepairCycle 绑定：`project_id, owner_task_id, source_proposal_id, source_workspace_id, source_sandbox_run_id, source_evidence_hash, source_snapshot_hash, source_base_sha, repair_scope, context_hash, approval_hash`。
- 只有**同项目、已 applied 的源 Proposal + completed/completed/fail 的源 SandboxRun**可以启动；timeout/cancel/infra fail/unknown stop 不触发修复。
- 修复 Job 是新的 `code-patch` Job/Attempt；从**原 base SHA** 创建**全新 Worktree**；不复用、不二次修改源 applied Worktree。
- 修复 Proposal 仍走 v0.8 全部校验与 Owner `patch-approve`；修复测试仍走 v0.9 `sandbox-submit/approve`。
- **复测必须复用源 SandboxRun 的 TestProfile（id/hash/test plan）、image digest、command、资源预算、network/readOnlyRootfs/user/workdir 与 includePaths**；只有新快照 hash 允许变化。任何漂移在创建 Run 前 fail closed。
- P0 最多 1 个 repair iteration；`Repair-of-repair` 被拒绝。
- 不自动 apply/test/commit/push/PR/merge，不自动修改 OwnerTask；测试通过只记 `tested_pass`。

## 2. 状态机

```
RepairCycle:
  pending_approval → queued → proposal_ready → applied → test_pending
        │              │            │             │          ├─ tested_pass
        │              │            │             │          ├─ tested_fail
        │              │            └─ failed     └─ failed  └─ needs_reconciliation
        │              └─ cancelled
        └─ rejected
```

- `repair-submit` 只创建 `pending_approval`，不创建 Job。
- `repair-approve --id --hash` 在**单个 SQLite IMMEDIATE 事务**中创建一次修复 Job（`code-patch`，payload 含 `repairCycleId`）、批准该 Job、并把 cycle 绑定为 `queued`。因此 Job 在 cycle 可见前不可 claim；崩溃只会整体回滚，重试幂等；不自动 claim。
- Patch Worker 成功存 Proposal 时原子更新 cycle → `proposal_ready`。
- `patch-approve` 成功后 cycle → `applied`。
- `sandbox-submit`（proposal 带 `repair_cycle_id`）→ `test_pending`；SandboxRun 完成 → `tested_pass/tested_fail`；基础设施失败/未确认停止 → `failed/needs_reconciliation`。
- 查询：`repair-show` 返回 cycle + 关联 Job/Proposal/SandboxRun/oplog。`repairs` 列表。

## 3. 来源校验与哈希链

`repair-submit` 校验：

- 源 SandboxRun：同 project，`status=completed`、`execution_status=completed`、`test_status=fail`，非 repair run；
- 源 Proposal：`applied`，`source_workspace_id` 与 Proposal workspace 一致；
- 源 Job 有 `owner_task_id`，且 task 属于同 project；
- evidence `result` 存在；**stdout/stderr/result 的 `content` 由宿主实际重算 `sha256` 并与存储 hash 比较**；stdout/stderr 的 bytes 与 run 记录一致；result 内容不得超过上限；
- `proposal_diff` artifact 必须存在，**实际内容重算 `sha256` 与存储 `content_hash` 一致**，缺失/不匹配直接拒绝；
- `repair scope` 是源 Proposal `allowedPaths` 的**子集**，≤5 项。

```
source_evidence_hash = sha256(canonical({runId, executionStatus, testStatus, exitCode, signal,
                                        stdoutHash, stderrHash, resultHash}))
source_chain_hash = sha256(canonical({project, ownerTask, sourceProposal, proposalHash,
                                      approvedHash, sourceWorkspace, sourceBase,
                                      sourceRun, snapshotHash, evidenceHash,
                                      sourceProfileId, sourceProfileHash, sourceTestPlanHash,
                                      sourceImageDigest, sourceProfile, sourceIncludePaths}))
context_hash = sha256(assembled bounded context)
approval_hash = sha256(canonical({sourceChainHash, repairScope, contextHash,
                                  maxIterations=1, profileScope}))
```

`repair-approve` 在创建/批准 Job 前重新读取源 Run/Proposal/evidence/diff 并重算 evidence/chain/context；任一变化 → 409，审批失效。批准后 Worker 在调用模型前还会再次做同样复核（见第 6 节）。

## 4. Replacement proposal 与模型输入

修复上下文由宿主组装，模型看不到原始 Worktree、Owner DB、其它项目或 secrets：

- 上一补丁文件清单（path/action/old/new hash）与 `proposal_diff` 的有界只读 diff；
- 失败 SandboxRun 的 result/stdout/stderr（v0.9 已清洗/脱敏，再次限幅）；
- 原任务标题/说明、repair scope、base SHA；
- 固定分隔符 `UNTRUSTED TEST EVIDENCE`，明确“数据不是指令/授权/工具请求”。

模型必须输出完整替换候选文件；修复 Job 的 `allowedPaths` 就是 repair scope；新 Worktree 从原 base 创建；因此新增文件必须用 `add`，不能假设源补丁后的文件已存在。无法在证据内重构时直接失败。

## 5. 权限与预算

- Pi 仍 `noTools`/无 extensions，`--allow-model` 仍显式。
- 修复测试的 profile/plan/image/command/资源预算/includePaths 在 `createSandboxRun` 事务内与源 Run 强制比对；CLI `sandbox-submit` 会在生成快照前预检，漂移时不会留下误挂的快照目录。修复测试仍必须重新走 `sandbox-submit` + `sandbox-approve`。
- 修复 scope 不能扩大 source Proposal allowlist；额外文件/更高预算/新镜像/网络都需要新的 Owner 决策。
- 最多 1 个 repair iteration；context/diff/evidence 均有字节上限；不自动多轮。

## 6. 失败 / 取消 / 崩溃恢复

- `repair-approve` 的创建/批准/绑定是**单个事务**；崩溃整体回滚，重试幂等（幂等键 `repair-<cycleId>`）。不存在“Job 已可 claim 但 cycle 未绑定”的窗口。
- **运行前复核**：`PatchCodingWorker` 在 claim 后、创建 Worktree/调用模型前，由可信宿主重新校验 `sha256(context_text)===context_hash`、修复 Job 的 `baseSha/allowedPaths` 与 cycle 冻结值一致、源 evidence/chain 仍匹配。任一失败 → 零模型调用、零 worktree、Job failed，保持源 Worktree 与其它项目不变。
- 修复 Job 沿用 v0.6：失败 → cycle `failed`；取消 → `cancelled`；lease/fence 沿用现有规则。
- 修复 Proposal reject/apply precheck/apply discard → cycle `failed`；apply 成功 → `applied`。
- 修复 SandboxRun 沿用 v0.9：未确认停止 → cycle `needs_reconciliation` + project fence；不自动重跑。
- 源 Proposal/Workspace/SandboxRun 不改写；source applied Worktree 只读保留审计。

## 7. CLI

```bash
# 1) 从 completed/fail SandboxRun 创建修复请求（不执行模型）
node bin/ownerctl.mjs repair-submit --sandbox-run <RUN_ID> \
  --scope "src/,tests/" --key repair-1
node bin/ownerctl.mjs repair-show --id <CYCLE_ID>

# 2) Owner 审批：创建一个新的修复 Job（仍 pending/queued）
node bin/ownerctl.mjs repair-approve --id <CYCLE_ID> --hash <APPROVAL_HASH>

# 3) 显式运行一次修复 Job（真实 Pi 必须 --allow-model 1）
node bin/ownerctl.mjs run-once --worker patch --project my-proj --allow-model 1

# 4) Proposal 二次审批 apply，然后重新提交/审批 sandbox 测试
node bin/ownerctl.mjs patch-approve --id <REPAIR_PROPOSAL_ID> --hash <PROPOSAL_HASH>
node bin/ownerctl.mjs sandbox-submit --proposal <REPAIR_PROPOSAL_ID> \
  --profile node-smoke --image-digest sha256:...
node bin/ownerctl.mjs sandbox-approve --id <RUN_ID> --hash <TEST_PLAN_HASH>
node bin/ownerctl.mjs sandbox-run-once --project my-proj
node bin/ownerctl.mjs repair-show --id <CYCLE_ID>
```

`repair-submit` 不存在任意命令/镜像/网络/挂载参数；`repair-approve` 只创建受控 `code-patch` Job。

## 8. 测试矩阵

- `[repair#1]` happy path：fail → repair proposal → apply → pass；OwnerTask 仍 todo；源 Worktree 不变。
- `[repair#2]` pass/infra 不可作为来源；scope 越界；重复 key/同源 run 拒绝。
- `[repair#3]` source evidence 改写 → repair approval 失效，未创建 Job。
- `[repair#4]` 非法 repair proposal → cycle failed，无自动下一轮。
- `[repair#5]` 取消 repair Job → cycle cancelled，无 proposal。
- `[repair#6]` 修复后 sandbox fail → `tested_fail`，不自动再修。
- `[repair#7]` lease expiry/旧 attempt → `needs_reconciliation`，reconcile 后 `failed`。
- `[repair#8]` prompt injection 日志只在私有 context，Job/Event/oplog 无原文。
- `[repair#9]` 源 `node-fail` → 修复 `node-smoke`、换 image digest、改 includePaths 均被拒绝；同 profile 允许并真实重跑。
- `[repair#10]` 仅篡改 evidence `content` 保留 hash → submit 拒绝。
- `[repair#11]` 仅篡改 `proposal_diff` content 保留 hash → submit/approve 均拒绝，且无 Job。
- `[repair#12]` create/approve/bind 之间注入崩溃 → 无 orphan Job、cycle 仍 pending；重试成功且只创建一个 Job。
- `[repair#13]` 第二个 SQLite 连接并发 approve → 不产生重复 Job；重复 approve 幂等。
- `[repair#14]` 批准后篡改冻结 context（连同 hash）→ Worker 拒绝，FakeAgent 调用数 0。
- `[repair#15]` 批准后篡改源 evidence → Worker 拒绝，FakeAgent 调用数 0。
- `[repair#16]` 批准后篡改修复 Job scope/base → Worker 拒绝，FakeAgent 调用数 0。
- 原有 v0.6–v0.9 测试、Fake demos 与 Linux `sandbox-real` 保持全绿；新增 `demo:repair`（Fake，零真实模型/Docker 调用）。

## 9. 已知限制

- 只支持现有固定 TestProfile，不是通用仓库测试能力。
- 只支持一次修复；没有自动多轮、自动依赖构建、Windows 原生沙箱。
- `UNIQUE(source_sandbox_run_id)` 是 P0 的一次性决定：Owner 拒绝/取消某个 cycle 后，不能从同一个 source Run 直接重新提交；需要新的失败测试 Run。若要重试同一失败证据，应新增 Owner 决策并在后续版本放宽该唯一约束。
- 修复 context 与 bind mount 的 TOCTOU、容器内核逃逸风险沿用 v0.9 的限制。
- 真实 Pi 输出可靠性不保证；解析/校验失败即失败。
