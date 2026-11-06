# Sandboxed Test Runner（v0.9 / P0）

对应 Issue [#7]。本阶段把 v0.8 的“已应用补丁”接到**受限执行后端**：Owner 显式批准一个固定 TestProfile 与输入快照，可信宿主只构造固定容器 argv，项目测试只在 Linux 容器内运行；宿主进程、主工作区与 Worktree host process 都不执行项目测试。

> **边界声明**：容器隔离不是“抵御一切内核逃逸”的 OS 沙箱。P0 验证的是容器级约束（非 root、无网络、只读 rootfs、drop caps、no-new-privileges、资源上限、最小挂载）；宿主 Docker daemon 的 root 权限是已声明的残余风险。

## 1. 后端与威胁模型

- **真实后端**：Docker CLI（固定 argv）。不使用 shell，不接受自由命令/网络/挂载/入口参数。
- 镜像必须用 **digest** 绑定（`sha256:<64 hex>`）；`docker image inspect <digest>` 预检失败即 fail closed；运行使用 `--pull=never`。
- 默认接受 rootful Docker（容器内仍为非 root UID），记录 `securityOptions/rootless`；设置
  `OWNER_AGENT_SANDBOX_REQUIRE_ROOTLESS=1` 时非 rootless daemon 直接拒绝。
- Windows/macOS 没有经验证的隔离后端时只用 Fake；**绝不降级到 host exec**。
- 容器约束：
  ```
  --network none --read-only --user 65534:65534 --cap-drop ALL
  --security-opt no-new-privileges:true
  --pids-limit N --memory M --memory-swap M --cpus C
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=T
  --mount type=bind,src=<snapshot>/input,dst=/workspace,readonly
  --workdir /workspace --env HOME=/tmp --env NO_COLOR=1 --env TZ=UTC
  --init --stop-timeout 1 --ulimit nofile=256:256
  ```
- 不挂 Docker socket、SSH、host home、credential store、Owner DB、其它项目。

## 2. SandboxProvider 接口

```text
preflight(profile) -> { ok, capabilities, provider, rootless, cgroupVersion }
create(runSpec)    -> { providerRunId, name }
start(handle)      -> { started: true }
inspect(handle)    -> { state: running|created|exited|missing, exitCode?, signal?, oomKilled? }
stop(handle)       -> { confirmed: boolean }
collect(handle)    -> { stdout, stderr, exitCode, signal, oomKilled }
dispose(handle)    -> { confirmed: boolean }
```

- `stop` 重新核对 `owner.sandbox/owner.run/owner.project/owner.attempt` 标签，轮询 `inspect` 直到确认非运行；未确认不 `rm -f`、不释放 fence。
- `dispose` 仅在确认非运行后移除；已消失视为幂等成功。
- Fake provider 实现同一接口，供跨平台确定性测试。

## 3. TestProfile 与权限

P0 只允许 Owner 侧内置 profile：

| profile | command | 用途 |
| --- | --- | --- |
| `node-smoke` | `node --test tests/sandbox-smoke.test.mjs` | 最小成功 fixture |
| `node-fail` | `node --test tests/sandbox-fail.test.mjs` | 真实断言失败 fixture（completed + fail） |
| `node-probe` | `node --test tests/sandbox-probe.test.mjs` | 真实隔离探针 |

- `command` 是数组，`command[0]` 仅允许 `node`；不拼接 shell，不接受 CLI 自由命令。
- 不运行 `npm install`/postinstall/项目脚本；依赖必须预置在可信镜像。
- 默认上限：timeout 30s、memory 128 MiB、cpus 1、pids 64、tmpfs 32 MiB、stdout/stderr 各 64 KiB。
- `profileHash` + `imageDigest` + `snapshotHash` + limits 组成不可漂移的 test plan；任一变化使审批失效。

## 4. InputSnapshot

- 仅从 **applied** Proposal/Workspace 制作；提交前重新执行 `WorkspaceBroker.verifyApplied`。
- 快照 = Proposal 变更文件 + Owner `--include` 的精确文件（P0 不接受目录/glob）；上限 50 文件 / 2 MiB，单文件 256 KiB。
- 每个路径复用 `inspectSafePath`/`readSafeMaterial`：拒绝 symlink/junction/hardlink、大小写别名、绝对路径/`..`、`.git`/`.pi`/`.env`/密钥、非法 UTF-8；先验 hash 再落盘。
- 快照写入 `~/.owner-agent/sandbox/<runId>/input/`：目录 0555、文件 0444，父目录 0700；`marker.json` + `snapshot_manifest` 绑定 run/hash。
- 审批与运行前均重新计算 manifest hash；快照被改写则 `failed`/拒绝启动。
- `sandbox-cleanup --confirm 1` 只有在 marker 匹配时才递归删除快照；被替换的目录不会被删。

## 5. 状态机

```
pending_approval → queued → provisioning → running → collecting → completed
      │                 │           │            │
      ├─reject→ rejected│           ├─fail→ failed
      │                 └─cancel──→ cancelled（仅确认停止后）
      └────────────────────────────→ needs_reconciliation（崩溃/超时/停止未确认）

execution_status: completed | timeout | cancelled | failed | unknown
test_status:      pass | fail | unknown
```

- 非零测试退出是有效结果：`status=completed`、`execution_status=completed`、`test_status=fail`。
- 基础设施失败（preflight/create/start/collect/inspect）才 `status=failed`。
- cancel/timeout 只停止 RunID 对应容器并等待 `inspect` 确认；未确认 → `needs_reconciliation`，保留容器与证据，同项目新 sandbox/code-patch 均被 fence。
- 启动时 `recoverInterruptedSandboxRuns()` 把 `provisioning/running/collecting` → `needs_reconciliation`；不自动重跑/删除未知容器。
- Owner `sandbox-reconcile --decision confirm-stopped|discard` 仅在 provider 确认非运行并 dispose 后落 `failed`。

## 6. Evidence 与隐私

- 证据 artifact 仅 Owner 私有：`stdout`、`stderr`、`snapshot_manifest`、`result`（执行/测试状态摘要，不含日志正文）。
- stdout/stderr：字节/行上限、UTF-8 清洗、`api_key/token/secret/password/Bearer` 脱敏、截断标记、内容 hash；原始字节数单独记录。
- Run 行只存状态、exit/signal、耗时、资源上限、证据 hash/引用、截断标记；Job/Event/oplog **不写日志正文**。
- 结果不自动晋升知识域、不作为模型上下文、不自动完成 OwnerTask。

## 7. CLI

```bash
# 1) 已 applied 的 proposal 提交 sandbox 计划（镜像必须 digest）
node bin/ownerctl.mjs sandbox-submit --proposal <PROPOSAL_ID> \
  --profile node-smoke --image-digest sha256:<64hex> [--include tests/a.test.mjs]
node bin/ownerctl.mjs sandbox-show --id <RUN_ID>

# 2) Owner 审批（绑定 approval hash）
node bin/ownerctl.mjs sandbox-approve --id <RUN_ID> --hash <APPROVAL_HASH>

# 3) 受控执行（真实后端需要 Linux Docker；无后端 fail closed）
node bin/ownerctl.mjs sandbox-run-once --project my-proj

# 4) 查看/取消/裁定/清理
node bin/ownerctl.mjs sandboxes --project my-proj
node bin/ownerctl.mjs sandbox-show --id <RUN_ID> --logs 1
node bin/ownerctl.mjs sandbox-cancel --id <RUN_ID>
node bin/ownerctl.mjs sandbox-reconcile --id <RUN_ID> --decision confirm-stopped --reason "已核对容器已停止"
node bin/ownerctl.mjs sandbox-cleanup --id <RUN_ID> --confirm 1
```

`--network`、`--mount`、`--privileged`、entrypoint、任意命令字符串都不存在；新增能力必须改代码与 review。

## 8. 测试与 CI

- Fake/协议测试（Ubuntu + Windows）：未批准零 provider 调用、pass/fail 区分、approval/profile/snapshot 漂移、cancel、timeout、未确认停止、lease/崩溃恢复、项目 fence、日志截断/脱敏/哈希、preflight unsupported、快照改写。
- Linux 实跑（Ubuntu CI `sandbox-real`）：`docker pull node:22-alpine`，解析 digest，运行 `node-smoke` 与 `node-probe`；探针覆盖非 root、零 capabilities、no-new-privileges、只读 `/workspace`、仅 `/tmp` 可写、无网络、无 Docker socket、无 `/root` 访问、cgroup 限制可见。
- 本地：`npm run demo:sandbox`（Fake，零 Docker/模型调用）；真实 backend 可通过
  `OWNER_AGENT_SANDBOX_REAL=1 OWNER_AGENT_SANDBOX_IMAGE_DIGEST=sha256:... npm run test:sandbox:real` 运行。

## 9. 已知限制 / 明确不做

- 容器不能抵御内核/运行时逃逸；rootful daemon 是残余风险，生产建议 rootless 或隔离宿主机。
- Windows 原生沙箱、K8s、分布式调度、多语言依赖构建、npm install、任意测试模板均不做。
- 不提供模型执行工具；不自动 merge/PR/知识晋升。
- 单进程 CLI 假设；多进程并发迁移需要额外进程锁。
- 镜像必须预先存在（`--pull=never`）；CI 负责拉取可信镜像，沙箱内不联网。
