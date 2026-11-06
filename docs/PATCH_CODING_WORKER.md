# Patch-first Coding Worker（v0.8 / P0）

对应 Issue [#5]。本阶段在 v0.5–v0.7 的项目登记、任务/Job/Attempt 审批、租约、审计与 Pi 隔离执行之上，新增**受控代码补丁提案**：

```
OwnerTask → code-patch Job（人工审批）→ 固定 base 的独立 Worktree
          → 无工具 Pi Session 生成结构化提案 → 宿主验证
          → Owner 二次审批（绑定 proposal hash）→ 宿主在 Worktree 应用
          → 独立复验 + 只读 Diff 证据 → Owner 显式回收
```

核心边界：

- **不修改原项目主工作区**，不自动 commit/push/PR/merge，不运行项目测试或任意 Shell。
- 模型只有“提出补丁”的权限；**真正写文件只发生在 Owner `patch-approve` 后的宿主操作**。
- Worktree **只隔离工作树与索引，不是 OS sandbox**。本阶段不给模型工具、不执行项目代码，真正沙箱化留到后续 Sandboxed Test Runner。
- `Job succeeded` 只表示“提案已原子保存”，**不等于代码已修改，也不等于 OwnerTask 完成**。

## 1. WorkspaceBroker：工作区边界

- 位置固定为 `~/.owner-agent/workspaces/<projectId>/<jobId>/a<attempt>/`（可用
  `OWNER_AGENT_WORKSPACES_DIR` 覆盖）。**绝不在原项目目录下创建临时工作区**。
- `projectId` / `jobId` / `attempt` 全部经过字符集校验；最终路径再做包含性检查，
  防止 `..`、绝对路径或拼接逃逸。
- **父链无链接**：在任何 `mkdir` / Git 操作前，从 `workspacesRoot` 到目标父目录逐级
  `lstat`，拒绝 symlink / junction / 非目录；目录逐层创建后再次核验 `realpath`。
  即使 `<workspacesRoot>/<projectId>` 被替换为链接，也不会先写到链接目标再检查。
- 所有 Git 操作使用 `execFile('git', [固定参数])`，**不经过 shell**，也不把 Git 交给模型；
  同时固定 `core.hooksPath` 到 Owner 私有空目录、关闭 `core.fsmonitor`。
- **Git filter 默认拒绝**：扫描 **所有 attributes 来源**（tracked/untracked `.gitattributes`、
  `$GIT_DIR/info/attributes`、`core.attributesFile`、XDG 默认 attributes），只要出现
  `filter=` / 裸 `filter` 属性就拒绝 worktree 操作；即使当前没有 tracked 匹配文件，未来
  新增 `docs/new.txt` 也不会绕过（配置项测试）。同时 `patch-protocol` 将
  `.gitattributes` 加入 deny-list，提案不能修改属性语义。LFS 等需要 filter 的仓库暂不
  支持，后续应由安全 materialization 处理。
- 创建前依次拒绝：
  1. 未登记 / 根目录缺失 / 根身份漂移（复用 v0.7 `.owner-root-identity` 文件身份）；
  2. `git rev-parse --show-toplevel` 与登记根不一致；
  3. 可执行 Git filter（见上）；
  4. 工作树脏（排除 v0.7 的 `.owner-root-identity` 标记）；
  5. 显式 `payload.baseSha` 不是 40-hex，或与当时 `HEAD` 不一致；
  6. 目标 worktree 路径 / 受控分支已存在。
- 创建命令固定为：
  ```
  git worktree add -b owner/job-<jobId>-a<attempt> <isolated-path> <baseSha>
  ```
  受控分支前缀 `owner/` 便于审计和清理；attempt 后缀避免重名。
- 失败时只清理本次已创建的 worktree 和分支，不触碰项目根。
- `workspace-inspect` 只返回元数据、HEAD、是否脏、是否存活；`workspace-cleanup` 必须
  `--confirm 1`，且：
  - 路径与受控分支都必须与由 `projectId/jobId/attempt` 重新推导的值一致（防 DB 篡改）；
  - 拒绝清理仍在 `proposed/approved/applying/needs_reconciliation` 的提案；
  - **删除前证明物理目录仍是登记的 Git worktree**：`.git` 文件必须指向项目
    `common-dir/worktrees/...`，且该 gitdir 的反向 `gitdir` 文件指回同一 `.git`；
  - 只有上述身份成立才执行 `worktree remove --force`；若路径被替换为普通目录，
    **不做任何递归删除**，保留现场并报错；随后删除受控分支并 `worktree prune`。
- 并发/隔离：每个 Attempt 一个 worktree；不同项目、不同 Attempt 路径天然分离。

## 2. Patch 协议与路径/哈希不变量

模型输出契约（唯一允许的结构）：

```json
{
  "files": [
    { "path": "src/app.js", "action": "modify", "content": "完整新文件内容" },
    { "path": "src/new.js", "action": "add", "content": "完整新文件内容" }
  ]
}
```

- 仅支持 `add` / `modify`；P0 不支持 rename、delete、binary、子模块。
- 上限：≤ 5 个文件，单文件 ≤ 64 KiB，总补丁 ≤ 256 KiB，路径 ≤ 200 字符。
- **old/new SHA 全部由宿主计算**：读取 Worktree 当前文件得到 `old_sha`，对模型内容计算
  `new_sha`；模型提供的任何 old/hash 字段都不被信任。
- `proposal_hash = sha256(canonicalJSON(paths + actions + old_sha + new_sha))`。
  Owner 审批必须传入该 hash；任何文件、动作或哈希变化都会使旧审批失效。
- 路径规范化与拒绝规则：
  - 统一 `/` 分隔（反斜杠视作分隔符），拒绝绝对路径、盘符、UNC、空段、`.`、`..`；
  - 拒绝控制字符、尾随点/空格、Windows 保留设备名、NTFS ADS（`:`）；
  - 最低 deny-list：`.git`、`.pi`、`.owner-root-identity`、`.env`/`.env.*`、
    含 `secret`/`credential` 的段、`.pem/.key/.pfx/.p12/.crt/.der/.jks/.keystore/.kdbx`、
    `id_rsa*`、`.npmrc`、`.pypirc`、`.netrc`、`.git-credentials`；
  - 白名单匹配：精确文件或目录前缀；大小写折叠后匹配，并拒绝大小写变体冲突；
  - 父链逐级 `lstat`：必须是真实目录、拼写与磁盘一致、`realpath` 仍在 Worktree 内；
    拒绝 symlink / junction / 非目录；
  - `modify` 目标必须是普通文件，拒绝 symlink、硬链接（`nlink > 1`）、二进制（NUL）；
  - `add` 目标必须不存在，父目录必须已存在（P0 不创建目录），并拒绝大小写变体已存在。
- **模型材料读取复用同一套路径检查**：显式批准的 `docs/link/private.txt` 会先逐级校验
  父链；中间目录是 symlink/junction、目标硬链接、非 UTF-8 或 NUL 内容都 fail-closed，
  不会“空读”后继续生成。目录遍历中的链接/非法子项跳过，显式批准路径则整次 attempt 失败。
- 提案 diff 由宿主用 `git diff --no-index` 针对临时 old/new 文件生成，路径头改写为
  仓库相对路径；审批前 Owner 即可查看受控 unified diff。
- 存储：
  - `owner_patch_proposals.files` 只存 `{path, action, old_sha, new_sha, bytes}` 元数据；
  - 补丁全文与新内容只存 `owner_patch_artifacts`（`proposal` / `proposal_diff` /
    `applied_diff`），以内容 hash 引用；
  - Job / Attempt / Event / oplog 只出现 `proposal:<id> sha:<8> files:<n>` 之类引用，
    **不存源码、Prompt、密钥、工具输出**。

## 3. 三条状态机（不混用）

```
ExecutionJob（v0.6 原样）
  pending_approval → queued → leased → running → succeeded
                                             ├→ failed / cancelled
                                             └→ needs_reconciliation

PatchProposal（v0.8）
  proposed ──approve──→ approved ──host apply──→ applying ──verify──→ applied
      │                     │                       │
      └──reject──→ rejected └──precheck fail──→ apply_failed
                              applying ──crash/异常──→ needs_reconciliation
                              needs_reconciliation ──Owner──→ applied | apply_failed

Workspace
  active ──terminal proposal + Owner cleanup──→ cleaned
  active ──quarantine/异常证据──→ quarantined ──Owner cleanup──→ cleaned
```

- Worker 只创建 `proposed`；取消/失联/超时/未确认停止**永不 apply**，Worktree 转
  `quarantined` 留证。取消只有在 **generator 最终结果**已返回（且不是后来的
  `unconfirmed-stop`）后才能 `confirmJobCancelled`；`cancelSeen` 先赢 race 不足以判定
  停止，prompt 仍悬挂或最终返回 `unconfirmed-stop` 时返回 fenced，交给租约/人工裁定。
- 项目栅栏同时覆盖 Job 与 PatchProposal：`owner_jobs.needs_reconciliation` **或**
  `owner_patch_proposals.status IN ('applying','needs_reconciliation')` 都会阻止同项目
  新 Job 的批准与 claim；不同项目不受影响，Owner 裁定后解除。
- 命令：`code-submit`、`run-once --worker patch`、`patches`、`patch-show`、
  `patch-approve`、`patch-apply`、`patch-reject`、`patch-reconcile`、`patch-recover`、
  `workspaces`、`workspace-inspect`、`workspace-quarantine`、`workspace-cleanup`。

## 4. Apply 与崩溃恢复

- `patch-approve --id --hash`：
  1. Store 校验 `expectedHash === proposal_hash`，`proposed → approved`；
  2. Host 重新核验项目根身份、可执行 Git filter、Worktree HEAD = base、提案 artifact
     hash、文件元数据、allowed scope、父链/链接/大小写、old hash；
  3. 通过后才持久化 `applying`，再逐文件写入，并为每个文件写 oplog（只记路径/动作）；
  4. 用 `git add --intent-to-add .` + `git diff --name-only -z` 独立复验变更路径集合，
     再逐文件复验 `new_sha`，最后取 unified diff 存为 `applied_diff`，才落 `applied`。
- **approved → applying 崩溃窗口**：`patch-apply --id --hash` 提供显式、幂等、同 hash
  绑定的 resume 操作；`patch-approve` 重跑也会识别 `approved` 状态并继续 apply。
  启动恢复只处理 `applying`，**不会自动 apply 一个已批准的提案**。已 `applied` 的重复
  `patch-apply` 返回既有结果，不会再次写文件。
- 任何 `applying` 之后的异常都 fail-closed：
  - 不自动重放、不自动回滚；
  - 提案 → `needs_reconciliation`，Worktree → `quarantined`；
  - Owner 用 `patch-reconcile --decision confirm-applied`（宿主重新核验后确认）或
    `--decision discard` 裁定。
- 进程重启时 CLI 会执行 `recoverInterruptedPatchApplies()`：任何遗留 `applying`
  都转 `needs_reconciliation` 并隔离 Worktree；也提供显式 `patch-recover`。
- 明确声明：SQLite 与文件系统无法跨资源原子，本设计**不声称恰好一次**；只保证
  “可判定 + Owner 显式裁定”，且**绝不自动重试**。

## 5. Pi Session 复用与 v0.7 技术债

- `PatchProposalAgent` 默认复用 `DefaultPiSessionFactory`：
  - 一次性空 `agentDir`；
  - `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles`；
  - `noTools:true` + `inMemory` Session；
  - `activeTools()` 必须为数组且为空；未知/非空即 fail-closed，绝不 prompt。
- `abort()` 按 v0.7 模式处理：异步 abort + 有界 stop-confirm；无法确认停止则不报告成功，
  让租约自然过期进入人工裁定。所有计时器句柄都在 `generate()` / `runOnce()` 局部
  变量中，并在 `finally` 清理。
- 真实模型调用只在 `run-once --worker patch --allow-model 1` 时允许；默认 Fake/CI
  零模型、零费用。注入非默认 factory 的测试/演示不触发真实调用。
- 共用安全边界：项目根身份检查抽到 `src/project-identity.mjs`，v0.7 Pi Worker 与
  v0.8 Broker/Worker 使用同一实现；既有 `pi-analysis` 测试保持通过。

## 6. 快速演示与手动命令

```bash
npm run demo:patch        # fake agent，端到端零模型调用
```

手动流程（真实模型需显式授权）：

```bash
# 1) 登记项目 + 任务，提交 code-patch（base 必须是当前 HEAD）
node bin/ownerctl.mjs register --id my-proj --name "My Project" --root /abs/path
node bin/ownerctl.mjs task --project my-proj --title "修复重试上限"
node bin/ownerctl.mjs code-submit --project my-proj --task <TASK_ID> \
  --base <40-hex-HEAD> --paths "src/,README.md" --focus "只改重试逻辑" --key patch-1

# 2) 审批 Job，再运行 Worker（真实 Pi 必须 --allow-model 1）
node bin/ownerctl.mjs job-approve --id <JOB_ID>
node bin/ownerctl.mjs run-once --worker patch --project my-proj --allow-model 1

# 3) Owner 审核 proposal + diff，二次审批并应用
node bin/ownerctl.mjs patches --project my-proj
node bin/ownerctl.mjs patch-show --id <PROPOSAL_ID>
node bin/ownerctl.mjs patch-approve --id <PROPOSAL_ID> --hash <PROPOSAL_HASH>
node bin/ownerctl.mjs patch-show --id <PROPOSAL_ID>       # 此时含 applied_diff

# 4) 检查与回收
node bin/ownerctl.mjs workspaces --project my-proj
node bin/ownerctl.mjs workspace-inspect --id <WORKSPACE_ID>
node bin/ownerctl.mjs workspace-cleanup --id <WORKSPACE_ID> --confirm 1
```

崩溃/中断裁定：

```bash
node bin/ownerctl.mjs patch-recover
node bin/ownerctl.mjs patch-apply --id <PROPOSAL_ID> --hash <PROPOSAL_HASH>   # approved→applying 崩溃恢复
node bin/ownerctl.mjs patch-reconcile --id <PROPOSAL_ID> --decision confirm-applied --reason "已核对 Diff"
node bin/ownerctl.mjs patch-reconcile --id <PROPOSAL_ID> --decision discard --reason "放弃"
```

## 7. 测试映射（Issue #5 验收）

| Issue 验收 | 覆盖 |
| --- | --- |
| 未批准/未授权真实模型时零 Session、零 Worktree、零外部 Git | `[patch#1]` |
| 从批准 SHA 创建 Worktree；原项目/main 不变；脏树/base 漂移拒绝 | `[patch#2]` `[patch#3]` |
| traversal/绝对路径/symlink/hardlink/case-alias/.git/敏感文件/大小限制 | `[patch#4]` `[patch#5]` |
| 改哈希审批失效；拒绝不应用；仅在对应 Worktree 应用一次；崩溃可裁定 | `[patch#6]` `[patch#7]` `[patch#8]` |
| 跨项目/跨 Attempt 不能读取或应用另一项目补丁 | `[patch#9]` |
| 取消/失联/过期租约/迟到输出/未确认停止：不应用、不释放隔离 | `[patch#10]` `[patch#14]` `[patch#21]` |
| filter 模式只匹配“未来新增文件”时仍在 checkout/diff 前拒绝 | `[patch#22]` `[patch#23]` |
| OwnerTask 原状态；Job 成功仅表示提案存储；审计无源码/Prompt/密钥 | `[patch#2]` `[patch#20]` |
| 模型材料读取的父链 symlink/hardlink/UTF-8 防护 | `[patch#13]` |
| Git filter 不执行（恶意 smudge 外部 marker 不存在） | `[patch#15]` |
| workspaces root 父链 symlink 在任何写入前拒绝 | `[patch#16]` |
| PatchProposal applying/needs 进入项目 fence，异项目不受影响 | `[patch#17]` |
| cleanup 不删除被替换的普通目录（sentinel 保留） | `[patch#18]` |
| approved→applying 崩溃窗口可显式 resume | `[patch#19]` |
| Windows + Linux 路径/symlink 行为 | 同一测试在 CI 的 `ubuntu-latest` + `windows-latest` 运行；无权限的主机自动跳过 symlink 分支 |
| `npm run check` / `npm test` / demos / CI | `npm run check`、`npm test`、`demo:jobs`、`demo:pi`、`demo:patch` |

可选真实 Pi 冒烟（严格 opt-in，默认跳过）：

```bash
OWNER_AGENT_REAL_PATCH_TEST=1 npm test   # 需要已配置的 Pi 凭据，会产生真实费用
```

## 8. 已知限制 / 明确不做

- Worktree 不是 OS sandbox：模型无工具、宿主不执行项目代码，但同进程仍具有 Owner 权限。
  Git hooks 已禁用，且带 `filter` 属性的仓库默认拒绝 worktree 操作；LFS 等需要 filter 的
  仓库暂不支持，后续由安全 materialization 处理。真正隔离的测试执行器留到后续 Issue。
- 真实 Pi 的 JSON 输出可靠性未承诺；解析失败即失败，不做“宽松猜测”。
- P0 不创建目录、不支持 rename/delete/binary/子模块；不支持多提案版本线。
- SQLite 与文件系统不做跨资源事务；崩溃恢复依赖 Owner 显式裁定。
- 单进程 CLI 假设：启动时的 `applying` 扫描按“上一进程已死亡”处理；多进程同时使用时
  需额外的进程锁（未在本 Issue 范围）。
- `.owner-root-identity` 仍由 v0.7 登记写入项目根；Broker 的干净检查排除它，不新增主工作区
  写入。是否迁移到 Owner 侧留待后续 Issue。
