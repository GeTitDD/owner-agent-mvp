# 真实项目端到端验收手册（v1.1 / #14）

本手册描述如何用真实模型与真实 Linux 容器验证 v1.0 的 Patch–Test–Repair 闭环。它不引入新的运行时能力，只调用现有 Owner CLI / Store / Worker。

## 1. 验收分级

| 级别 | 模型 | 沙箱 | 验证目标 | 闸门 |
| --- | --- | --- | --- | --- |
| L1 | Fake（确定性提案） | 真实 Docker | repair 状态链在真实容器中成立 | 必过 |
| L2 | 真实 Pi | Fake provider | 真实模型输出能通过协议、scope、哈希校验 | 必过 |
| L3 | 真实 Pi（仅 repair） | 真实 Docker | 真实容器里 fail → pass，且测试未被改弱 | **核心闸门** |
| L4 | 真实 Pi（source + repair） | 真实 Docker | 全真实可靠性统计 | 可选 |

L2 只证明"模型输出合法"，不证明"模型能修好"；语义验收以 L3 为准。

## 2. Fixture 不变量

`scripts/acceptance/make-fixture.mjs` 生成一个零依赖 Node 仓库：

- `src/retry.js` 含真实 off-by-one bug；
- `tests/sandbox-smoke.test.mjs` 已提交且当前失败；
- `package.json` 声明 `type: module`（并作为 `--include` 进入快照）；
- `.gitignore` 包含 `.owner-root-identity`；
- 固定 `core.autocrlf=false`，保证 base 文件与容器内文件按字节一致。

**为什么 bug 和测试都在 base**：repair 的 Worktree 从原 base 创建，源补丁引入的 bug 不会存在于新 Worktree。只有 base 上的 bug 才能被真实修复；只有把测试提交在 base 且排除出 repair scope，才能防止"改弱测试"换取 `tested_pass`。

## 3. 前置条件

- Node.js 22.13+
- L1/L3：Linux Docker（Docker Desktop 的 Linux containers 也可）+ `node:22-alpine` 镜像
- L2/L3：Pi SDK 已安装且模型凭据可用（沿用 Pi 默认认证链）
- 建议在 WSL2 / Ubuntu 上执行；Windows 宿主也可运行，但快照权限是 best-effort

## 4. 运行

```bash
# L1：零模型费用
node scripts/acceptance/e2e-repair.mjs --level 1 --out /tmp/evidence-l1.json

# L2：一次真实模型调用
node scripts/acceptance/e2e-repair.mjs --level 2 --out /tmp/evidence-l2.json

# L3：真实模型 + 真实容器（核心）
node scripts/acceptance/e2e-repair.mjs --level 3 --out /tmp/evidence-l3.json

# 可选：显式模型与超时
node scripts/acceptance/e2e-repair.mjs --level 3 --model provider/model --timeout 240000
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--level 1\|2\|3` | 验收级别，默认 3 |
| `--model <provider/model>` | 传给 Pi SDK；缺省用 SDK 默认 |
| `--timeout <ms>` | 修复提案生成超时，默认 180000 |
| `--image-digest sha256:...` | 覆盖 Docker 镜像 digest；缺省从 `node:22-alpine` 解析 |
| `--out <path>` | 写出 machine-readable evidence JSON |
| `--keep` | 保留临时目录用于排查（默认清理） |

所有状态都在一次性临时目录内（`os.tmpdir()`），不会写入默认的 `~/.owner-agent`。

## 5. 每级断言

共同断言：

- 源 run：`completed / completed / fail`，stdout 含真实断言失败；
- repair cycle：`pending_approval → queued → proposal_ready → applied → test_pending → tested_pass`；
- repair proposal 只改 `src/`，不碰 `tests/`；
- 复测快照中 `tests/sandbox-smoke.test.mjs` 的 sha256 == base 版本；
- 源 applied Worktree 内容不变；
- OwnerTask 保持 `todo`；
- Job / Event / oplog 不含原始测试日志；
- 结束后无临时目录残留（除非 `--keep`）。

L1/L3 额外断言真实 Docker：

- preflight `ok`；
- 源 run stdout 含断言失败标记；
- 复测 stdout 含通过标记；
- `execution_status` 与 `test_status` 分离正确。

## 6. Evidence 字段

`--out` 写出的 JSON 包含：

- `level`、`model`、`imageDigest`、`profileId`；
- `fixtureBase`、`fixtureTestSha256`；
- 源 Job/Proposal/Workspace/Run id 与 hash；
- `cycleId`、`approvalHash`、repair Job/Proposal/Workspace/Run id；
- `sourceStatus` / `repairStatus`（status、execution、test、exitCode）；
- `testIntegrity`（base 与 repair 的测试 hash、是否相等）；
- `sourceWorktreeUnchanged`、`ownerTaskStatus`、`durationMs`。

## 7. 已知限制

- 仅支持现有固定 TestProfile（`node-smoke` / `node-fail` / `node-probe`），不是通用仓库测试能力。
- 快照只含提案文件 + `--include` 精确文件，上限 50 文件 / 2 MiB；无 `node_modules`、无网络。
- 模型身份未持久化到 Proposal/Cycle（见 #14 G8）；报告中的模型来自 CLI 参数或 Pi 默认配置。
- L4 的 source 与 repair 均由真实模型生成，结果具有随机性，不适合作为硬闸门。
- 容器隔离沿用 v0.9 的能力边界，不抵御内核/运行时逃逸。

## 8. 清理

脚本默认删除整个临时目录（含 SQLite、Worktree、快照）。排查时使用 `--keep`，随后手动删除输出的临时路径。

若在真实项目上手工复现，请使用隔离环境：

```bash
export OWNER_AGENT_DB=/tmp/accept/owner.sqlite
export OWNER_AGENT_WORKSPACES_DIR=/tmp/accept/workspaces
export OWNER_AGENT_SANDBOX_DIR=/tmp/accept/sandbox
```

并显式执行 `workspace-cleanup --confirm 1` 与 `sandbox-cleanup --confirm 1`。
