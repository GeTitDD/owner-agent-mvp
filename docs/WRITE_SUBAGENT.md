# 受控写入子 Agent（Writer Sub-agent v1）

Owner 默认只读：分析、检索、提案都可以，但不能直接改文件。
当任务确实需要“写一点东西”时，走下面这条受控链路，而不是给主 Agent 开写权限。

## 1. 链路

```
你勾选「写入」并交办
  → code-write Job（pending_approval）
  → 你批准 Job
  → 宿主创建一次性 git worktree（base 固定）
  → WriterAgent 在 worktree 内用受限工具改文件
  → 宿主收集变更 → PatchProposal（proposed）
  → 你审阅并批准补丁
  → 应用 → （可选）沙箱测试
```

主 Agent 永远不会直接接触真实项目目录；真实项目只在“批准补丁”之后由既有
`applyApprovedPatch` 写入。

## 2. 隔离与工具

WriterAgent 复用 `PatchCodingWorker` 的控制平面（lease / fencing / cancel / quarantine），
只替换“生成器”：

- 工具：`own_read / own_write / own_edit / own_ls / own_find / own_grep`（自定义工具，显式白名单）。
- 没有 `bash`、`powershell`、网络工具。
- 所有 `path` 参数先经过宿主校验：
  - 拒绝绝对路径；
  - 拒绝 `..`；
  - 已存在路径做 `realpath` 校验，拒绝符号链接逃逸；
  - 新文件校验最近存在祖先目录。
- 工具创建后核对 `getActiveToolNames()`：出现白名单之外的名称直接中止。

## 3. 变更采集与上限

- `git status --porcelain -z --untracked-files=all` 采集新增/修改文件。
- 删除、重命名一律拒绝（当前提案模型只支持 add/modify）。
- 单文件大小、文件数量沿用 `PATCH_LIMITS`。
- 零改动 → `empty-write`，不会伪造补丁。

## 4. 使用

- 面板 Composer 的「写入」开关：开启后交办生成 `code-write` Job；关闭则是原来的只读/提案路径。
- 批准 Job 后，Worker 才会启动 WriterAgent；模型不可用时失败而不是降级。
- 生成的仍然是普通 PatchProposal：审批、hash 绑定、沙箱测试、修复循环全部复用。

## 5. 边界

- 写入只发生在 worktree；磁盘上的真实项目在批准前不变。
- 不支持删除/重命名/二进制写入（v1）。
- 没有命令执行能力，因此不能“跑脚本生成文件”；需要执行的场景仍走沙箱测试链路。
- `code-write` 与 `code-patch` 共用同一套 allowedPaths 与提案上限。
