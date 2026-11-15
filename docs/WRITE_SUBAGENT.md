# 受控写入子 Agent（Writer Sub-agent v1）

Owner 默认只读：分析、检索、提案都可以，但不能直接改文件。
当任务确实需要“写一点东西”时，走下面这条受控链路，而不是给主 Agent 开写权限。

## 0. Python 执行（Monty）

WriterAgent 额外提供 `own_python` 工具，底层是 [Monty](https://github.com/pydantic/monty)：

- MIT、Rust 实现的 **Python 3.14 子集**解释器，跑在独立 worker 子进程；
- 沙箱内没有环境变量与网络；只有当前 worktree 被挂载到 `/workspace`（可读写）；
- 资源上限：内存 128MB、单次 8s、递归 200、stdout 上限 256KB；
- 限制：无三方包、无类继承、无生成器、无 `@classmethod/@staticmethod/@property`、无 `del`。

它适合“确定性计算 / 格式转换”，不负责跑项目测试。项目测试仍然走 Docker 沙箱 profile。

原生包需要在打包时 `asarUnpack`（`package.json → build.asarUnpack`），否则会去 `app.asar`
里找 `monty.exe` 而失败。打包后自检：

```powershell
npx electron-builder --win dir --x64
node scripts\e2e\monty-packaged-smoke.mjs --no-build   # 期望 ok=true / result=5050 / packaged=true
```

`resolveMontyBinaryPath()` 会把路径改写到 `app.asar.unpacked`；也可用 `MONTY_BIN` 显式指定。

同一 runner 也用于**只读分析**：Playbook 的 `own_python` 以 `read-only` 挂载仓库，
只做统计/计数/确定性计算，写入会被文件系统拒绝。

## 1. 链路

```
你直接在 Composer 交办（没有「写入」开关）
  → 只读分诊（read/grep/find/ls + 只读 own_python）
  → 不需要写入？直接给结论，不创建 Job、不动文件
  → 需要写入 → 自动生成写请求（code-write Job，pending_approval，HITL）
  → 你批准写请求
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

- 工具：`own_read / own_write / own_edit / own_ls / own_find / own_grep`（自定义工具，显式白名单）；可选 `own_python`（Monty）。
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

- 面板 Composer **没有「写入」开关**：每次交办先跑只读分诊（`src/pstack/triage.mjs`）。
- 分诊结论只需要回答 → 直接返回结论，不创建 Job、不写文件。
- 分诊结论需要改文件 → 自动创建 `code-write` **写请求**（`pending_approval`，即 HITL）。
- 你在「需要你决定」里批准写请求后，Worker 才会启动 WriterAgent；模型不可用时失败而不是降级。
- 生成的仍然是普通 PatchProposal：审批、hash 绑定、沙箱测试、修复循环全部复用。

## 5. 边界

- 写入只发生在 worktree；磁盘上的真实项目在批准前不变。
- 不支持删除/重命名/二进制写入（v1）。
- 没有命令执行能力，因此不能“跑脚本生成文件”；需要执行的场景仍走沙箱测试链路。
- `code-write` 与 `code-patch` 共用同一套 allowedPaths 与提案上限。
