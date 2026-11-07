# v1.1 真实链路验收报告（首轮）

- 日期：2026-11-07
- 基线：`main@77a6541`（PR #10 合并提交）
- 跟踪 Issue：[#14](https://github.com/GeTitDD/owner-agent-mvp/issues/14)
- 驱动：`scripts/acceptance/e2e-repair.mjs`
- Fixture：`scripts/acceptance/make-fixture.mjs`

## 1. 环境

| 项 | 值 |
| --- | --- |
| 宿主 | Windows，Docker Linux containers |
| Node | 22.20.0 |
| Pi SDK | `@earendil-works/pi-coding-agent` 1.5.x（已安装） |
| 模型 | 未传 `--model`，使用 Pi 默认 `zai-coding-cn/glm-5.3` |
| 沙箱镜像 | `node:22-alpine` @ `sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202` |
| 测试 profile | `node-smoke` |

> 产品尚未持久化模型标识（#14 G8），上表模型来自 Pi 全局配置，不是从 Proposal/Cycle 读出的审计值。

## 2. 结果

| 级别 | 模型 | 沙箱 | 结果 | 关键证据 |
| --- | --- | --- | --- | --- |
| L1 | Fake | 真实 Docker | **PASS** | 源 run `completed/completed/fail` → 修复 run `completed/completed/pass`，cycle `tested_pass` |
| L2 | 真实 Pi | Fake provider | **PASS** | proposal 仅含 `src/retry.js`，`proposal_ready`，协议/scope 校验通过 |
| L3 | 真实 Pi | 真实 Docker | **PASS** | 真实容器 fail → pass，cycle `tested_pass`，测试 hash 不变 |

L3 是核心闸门，已通过。L2 与 L3 各产生 1 次真实模型调用。

## 3. L3 证据摘要

```json
{
  "level": 3,
  "model": "sdk-default",
  "profileId": "node-smoke",
  "imageDigest": "sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202",
  "fixtureBase": "936503571f7124b13f2ab4b90a5ba6b77f240a05",
  "sourceStatus": { "status": "completed", "execution": "completed", "test": "fail", "exitCode": 1 },
  "repairStatus": { "status": "completed", "execution": "completed", "test": "pass", "exitCode": 0 },
  "testIntegrity": {
    "path": "tests/sandbox-smoke.test.mjs",
    "baseSha256": "659f66e5f5ecc5321a4fba57935266975c4c835118ec9c65da0c6c4abfcb19a1",
    "repairSha256": "659f66e5f5ecc5321a4fba57935266975c4c835118ec9c65da0c6c4abfcb19a1",
    "equal": true
  },
  "sourceWorktreeUnchanged": true,
  "ownerTaskStatus": "todo",
  "durationMs": 38119
}
```

说明：

- 每次运行使用全新的临时 fixture，因此 `fixtureBase` 每次不同；这不影响结论。
- 源 run 的失败来自 base 上的真实 off-by-one bug；源补丁只加注释，不修 bug。
- 修复提案由真实模型生成，只修改 `src/retry.js`；测试文件由 base 提交并通过 `--include` 进入快照。
- 复测快照中的测试 hash 与 base 完全一致，排除"改弱测试"路径。
- 源 Worktree 未被修改；OwnerTask 仍为 `todo`；Job/Event/oplog 不含原始日志。

## 4. 本次证明了什么

1. 真实 Pi 生成的完整替换提案能通过 v0.8 的全部宿主校验（路径、scope、大小、哈希）。
2. 真实 Docker 沙箱能在同一 profile / image / includePaths 下复现 `fail → pass`。
3. repair 的哈希链、单事务审批、模型前复核在真实模型与真实容器组合下成立。
4. 测试完整性可以被外部断言：修复前后测试文件 sha256 相等。
5. 闭环结束后没有自动 commit/push/PR/merge，OwnerTask 不被自动修改。

## 5. 本次没有证明什么

- 真实模型的**多轮**可靠性：只跑了 1 轮；L4 未执行。
- 任意真实仓库的兼容性：只验证了零依赖、固定测试入口、≤50 文件的小项目。
- 依赖 `node_modules` 的项目：沙箱无网络、不安装依赖，当前不支持。
- 任意测试入口：profile 固定为 `tests/sandbox-*.test.mjs`。
- 模型身份审计：Proposal/Cycle 未持久化 provider/model。
- 成本上限：只有 timeout 与 iteration 限制，没有 token/cost 预算。
- 内核级隔离：沿用 v0.9 的容器边界，不覆盖容器逃逸。

## 6. 发现的问题（按严重度）

| # | 问题 | 归属 |
| --- | --- | --- |
| 1 | 测试完整性只靠验收脚本断言，产品层没有不变量 | #14 后续 Issue（test-integrity） |
| 2 | 固定 TestProfile 无法覆盖真实项目布局 | #14 后续 Issue（custom-profile） |
| 3 | Proposal/Cycle 不记录模型身份 | #14 后续 Issue（model-provenance） |
| 4 | 无 token/cost 预算 | #14 后续 Issue（budget） |
| 5 | `maxOutputChars` < 合法提案总字节上限 | #14 后续 Issue（output-limit） |
| 6 | 材料只读 20 个文件，真实 `src/` 可能看不全 | #14 后续 Issue（material-coverage） |
| 7 | repair sandbox 校验在事务外（TOCTOU） | #11 |
| 8 | `completeSandboxRun` 允许非法状态三元组 | #12 |
| 9 | 同一失败证据只能提交一次 | #13 |

## 7. 复现

```bash
node scripts/acceptance/e2e-repair.mjs --level 1 --out /tmp/evidence-l1.json
node scripts/acceptance/e2e-repair.mjs --level 2 --out /tmp/evidence-l2.json
node scripts/acceptance/e2e-repair.mjs --level 3 --out /tmp/evidence-l3.json
```

详见 [验收手册](ACCEPTANCE_E2E.md)。
