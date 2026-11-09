# Owner Agent × Domain Knowledge Workbench — v1.0

> **v1.0 Patch–Test–Repair** 与 v0.6–v0.9 全部能力均已合并到 main。真实 Pi + 真实 Docker 的全链路已通过首轮 L3 验收（见 [v1.1 验收报告](docs/ACCEPTANCE_REPORT_V1.1.md)）；更大范围的真实仓库与多轮可靠性验收见 [#14](https://github.com/GeTitDD/owner-agent-mvp/issues/14)。

**以 Owner 为中心的多项目管理 Agent + 个人领域知识资产工作台 + 可选桌面宠物。** 它继承 v0.4 的分层领域知识管理、版本快照、Pi Context Adapter 与人工审核能力，新增本地常驻 Owner Runtime（事件驱动、默认不持续调用 LLM）。

## v1.0（已合并）：Patch–Test–Repair

从一次**已完成且失败**的 SandboxRun 出发，Owner 显式批准一次有界修复：新的 `code-patch` Job 在原 base 上创建全新 Worktree，模型收到上一补丁 diff 与脱敏失败证据（明确标记为不可信数据），输出完整替换提案；Owner 再次审批 apply，并再次审批 sandbox 测试。**不做自动循环、自动 apply/test/merge，也不改 OwnerTask。**

- 不可变证据链：source run/proposal/workspace/evidence/diff/snapshot/base/profile/image/includePaths + repair scope + context hash 绑定 approval hash；evidence 与 diff 内容均实际重算 sha256。
- 只允许 completed/fail；timeout/cancel/infra fail/unknown stop 不触发修复。
- 修复复测必须复用源 TestProfile/image/资源预算/includePaths，只允许快照变化。
- 最多 1 次 repair iteration；repair-of-repair 拒绝；scope 必须是源 allowlist 子集。
- `repair-approve` 的创建/批准/绑定是单个事务；Worker 调用模型前重新校验冻结 context、源证据链与 Job scope/base，失败零模型调用。
- 日志/堆栈作为 `UNTRUSTED TEST EVIDENCE` 注入，Job/Event/oplog 不写原文。
- 崩溃/取消沿用 v0.6/v0.9 的 lease/fence/reconcile；不自动重放。

```bash
npm run demo:repair   # Fake patch + Fake sandbox 端到端演示（零真实模型/Docker 调用）
```

完整 schema、哈希链、审批断点、CLI 与测试矩阵见 **[Patch–Test–Repair 文档](docs/PATCH_TEST_REPAIR.md)**。

## v1.1 方向：OpenClaw-first 客户端复用（设计评审中）

v1.1 改为复用 OpenClaw 的 Gateway、Control UI、会话、通知与桌面壳，Owner 只保留任务执行与审批权威。方案、模块级复用清单、许可证/依赖分析与两套集成方案的工作量比较见 **[OpenClaw-first 设计评审稿](docs/V1.1_OPENCLAW_FIRST.md)**。该方案**待 Owner 批准，尚未实施**。

## 真实项目端到端验收（v1.1 / #14）

现有自动化测试与 demo 使用 Fake 模型 + Fake provider；真实 Pi + 真实 Docker + Repair 的组合由验收脚本单独执行：

```bash
npm run acceptance:repair -- --level 1   # 确定性提案 + 真实 Docker，验证状态链
npm run acceptance:repair -- --level 2   # 真实 Pi 提案 + Fake provider，验证协议兼容
npm run acceptance:repair -- --level 3   # 真实 Pi 修复 + 真实 Docker，验证 fail -> pass
```

验收 fixture 的 bug 与失败测试都提交在 base，repair scope 排除 `tests/`，复测时额外校验测试文件 hash 未变，避免"改弱测试"得到 `tested_pass`。完整步骤、判据与限制见 **[端到端验收手册](docs/ACCEPTANCE_E2E.md)**；首轮 L1/L2/L3 实测结果见 **[v1.1 验收报告](docs/ACCEPTANCE_REPORT_V1.1.md)**。

## v0.9（已合并）：Sandboxed Test Runner

把已 applied 的补丁接到**受限测试执行**：Owner 批准固定 TestProfile + 镜像 digest + 有界输入快照后，可信宿主只构造固定 Docker argv，项目测试在非 root、无网络、只读 rootfs、drop caps 的 Linux 容器内运行；宿主进程不执行项目测试。

- **默认拒绝**：无 Docker/镜像 digest/preflight 失败/平台不支持 → `unsupported`，绝不降级 host exec。
- **输入不可漂移**：快照只来自 applied Proposal/Workspace + Owner 精确 `--include`，路径/链接/hash 复核；审批后改写快照会使运行失败。
- **状态分离**：`execution_status` 与 `test_status` 独立；非零测试退出是有效 `completed/fail`，基础设施失败才 `failed`。
- **安全探针**：真实 Linux CI 运行 `node-probe`，验证非 root、零 capabilities、no-new-privileges、只读 `/workspace`、仅 `/tmp` 可写、无网络、无 Docker socket、无 host root 访问。
- **崩溃/取消**：未确认停止 → `needs_reconciliation` + 项目 fence；只有显式 `sandbox-recover` 才恢复已过期租约，普通 CLI 读取不会抢占 live run；reconcile 需要 provider 查询确认/attestation，不自动重跑、不盲目删除容器。
- **证据私有**：stdout/stderr 有上限、UTF-8 清洗、secret 字段脱敏与 hash；Job/Event/oplog 不含日志正文。

```bash
npm run demo:sandbox       # Fake provider 端到端演示（零 Docker/模型调用）
npm run test:sandbox:real  # 需要 Linux Docker + OWNER_AGENT_SANDBOX_IMAGE_DIGEST，opt-in
```

完整 SandboxProvider 接口、TestProfile、状态机、证据协议与安全边界见 **[Sandboxed Test Runner 设计文档](docs/SANDBOX_TEST_RUNNER.md)**。

## v0.8（已合并）：Patch-first Coding Worker

在 v0.7 的隔离 Pi 会话之上，新增**受控代码补丁闭环**：Owner 为指定项目/任务/文件范围批准一次 `code-patch` Job，Pi 只生成**结构化补丁提案**（无工具、无 Shell、无 Git），宿主验证后进入**二次审批**；只有 Owner 用固定 `proposal_hash` 批准后，才在从批准 base 创建的**独立 Git Worktree** 中应用，并产出只读 Diff 证据。

- 原项目主工作区、`main` 与 OwnerTask 完全不动；不自动 commit/push/PR/merge。
- 路径防护：traversal/绝对路径/盘符、`.git`/`.pi`/`.env`/密钥、symlink/junction/hardlink、大小写别名、超范围/超大小文件全部由宿主拒绝；模型材料读取复用同一父链检查。
- Workspace 父链与 cleanup 身份双重校验：symlink/junction 在写入前拒绝；cleanup 必须证明物理目录仍是登记的 Git worktree，替换目录不会被递归删除。
- 带可执行 Git filter 的仓库默认拒绝 worktree 操作（含 ignored `.gitattributes` 与待新增路径 `check-attr`）；LFS 等留待后续安全 materialization。
- 审批绑定提案哈希；提案变化即审批失效；同一 Worktree 只能应用一次；`patch-apply` 显式恢复 approved→applying 崩溃窗口。
- 崩溃 fail-closed：`applying → needs_reconciliation`，Owner 显式 `patch-reconcile` 裁定，**绝不自动重放**；`applying/needs_reconciliation` 提案同时触发项目调度 fence。
- 真实 Pi 调用必须 `--allow-model 1`；CI/测试/演示全部使用 Fake agent，零模型费用。

```bash
npm run demo:patch     # fake agent 端到端：worktree → proposal → approve → apply → cleanup
```

完整工作区边界、补丁协议、三条状态机与崩溃恢复见 **[Patch Coding Worker 设计文档](docs/PATCH_CODING_WORKER.md)**。

## v0.7（已合并）：Pi Analysis Worker

首个**真实执行闭环**：审批通过的 `pi-analysis` Job 在显式 `--allow-model` 下获得一个**项目级隔离、无工具、只读**的 Pi Session，产出有界、带 sha256 的项目私有分析产物。

- 项目隔离实测：一次性空 agentDir + `noTools:true` → active tools `[]`（对照：全局配置会漏入扩展工具）；fail-closed——工具面非空即中止。
- v0.6 全部不变量保留：审批门、原子 claim、租约（`cancel_requested` 期间心跳续租）、两阶段取消（`abort()` + 确认）、fence、幂等、迟到结果拒绝、OwnerTask 不自动完成。
- 产物只存项目私有 `owner_job_results`，Job/审计仅引用 id/hash/字符数；usage 未知时如实标记。

```bash
npm run demo:pi      # fake session 端到端演示（零 API 成本）
OWNER_AGENT_REAL_PI_TEST=1 npm test   # 可选真实 Pi 冒烟（需凭据；跳过不失败）
```

完整生命周期、隔离边界、取消/心跳策略与手动真实冒烟指南见 **[Pi Worker 设计文档](docs/PI_WORKER.md)**。

## v0.6（已合并）：Durable Task Coordinator

在 v0.5 基础上新增**可持久化、可审核、崩溃可恢复的 Job 生命周期**（控制面 + FakeWorker，无真实执行器）：

- Job 默认 `pending_approval`，Owner 显式批准后才进入队列；同项目默认串行（最多 1 个 active Job），多项目可并发。
- 原子承领（SQLite 事务 + CAS）、租约与 heartbeat、过期隔离 `needs_reconciliation`、显式 requeue/cancel/fail 裁定、幂等键防重。
- `ownerctl` 新命令：`job-submit / job-approve / job-reject / jobs / job / job-cancel / jobs-reconcile / job-reconcile / run-once`。

```bash
npm run demo:jobs   # 临时库 + fake clock 的端到端演示（审批/并发/崩溃恢复/取消/幂等）
```

完整状态机、不变量、存储约束、Worker 契约与可复制命令见 **[Task Coordinator 设计文档](docs/TASK_COORDINATOR.md)**。

## 最快试用

- `npm test` — 运行全部自动化测试（无需模型 API）。
- `npm run demo:patch` — v0.8 受控 Worktree/提案/二次审批/应用/清理演示（fake agent）。
- `npm run demo:sandbox` — v0.9 输入快照/审批/Fake 执行/证据/清理演示（零 Docker 真实调用）。
- `npm run demo:repair` — v1.0 失败证据 → 修复提案 → apply → 复测的审批断点演示（Fake，零真实调用）。
- `npm run demo:owner` — 两个临时项目的注册、事件、知识迁移提案、审核演示。
- `npm run workbench` — 打开 `http://127.0.0.1:4317`。进入 **Owner Agent** 页面登记项目、任务，右下角可打开伴侣对话窗。
- `node bin/ownerctl.mjs register --id demo --name Demo --root /absolute/path/to/project --domain pi-sdk` — 登记现有本地项目。
- `OWNER_AGENT_CAPTURE=1 pi -e /absolute/path/to/owner-agent-mvp-v0.5/adapters/pi/owner-extension.mjs` — 在**已登记且受信任**项目中显式开启 Pi 元数据采集。
- 桌面宠物可选：`npm install --save-dev electron` 后执行 `npm run desktop`（本环境无法启动 Electron GUI，未做原生端到端验收）。

详见 **[Owner Agent 架构与操作指南](docs/OWNER_AGENT.md)**。

### 本版交付边界

- 已实现：Owner Project/Task Registry、事件日志和投影、轻量常驻监控、只读智能查询、跨项目知识建议/审批、Web 管理面板、可选 Electron 桌面壳；v0.6 持久化 Job 生命周期；v0.7 只读 Pi 分析；v0.8 受控 Worktree 补丁提案/二次审批/应用；v0.9 Linux 容器沙箱测试与私有证据；v1.0 单轮 Patch–Test–Repair 证据驱动修复。
- 默认推理模式：**无模型的确定性查询**。可通过 `ownerctl ask-pi` 明确调用工具禁用的 Pi SDK 认知会话（需要额外安装、配置模型；仅模拟集成测试）。
- 暂未实现：自动启动的 OS 守护进程、项目 Agent 实际调度、自动跨项目知识迁移、生产级权限认证、真实仓库与多轮可靠性验收（[#14](https://github.com/GeTitDD/owner-agent-mvp/issues/14)，L1/L2/L3 脚手架已提供）、Electron GUI 端到端测试。
- 安全原则：项目必须显式登记；Pi 采集默认关闭，只记元数据；知识建议不自动更改项目；Workbench 仅绑定 loopback。**请勿公网开放。**

---

# Domain Context × Pi Workbench (v0.4) — legacy documentation

**为个人与 Agent 长期积累可验证、可组合的领域知识，在新实验、研究和独立开发时快速获得适配具体项目环境的可信上下文。**

已实现 P0（领域包、版本快照、确定性 Compiler）、P1（Pi Extension、Skill、按需检索）、P2（证据与人工审查的知识发布）、P3（L1/L2/L3 分层和多领域组合），以及 v0.4 的 **Personal Knowledge Workbench**（本地浏览、修订、审核与知识组合预览）。**LLM 提炼通过可插拔接口接入，尚未绑定具体商业模型；发布必须人工审核，不是无监督自学习。**

## v0.4：Personal Knowledge Workbench（本地可运行）

使用 Node.js **22.13+**，无需 Pi 或模型凭据：

```bash
npm run workbench
# 在浏览器打开 http://127.0.0.1:4317
```

可选自定义本地数据库和端口：

```bash
DOMAIN_CONTEXT_DB=/absolute/path/knowledge.sqlite DOMAIN_WORKBENCH_PORT=4321 npm run workbench
```

现在可以直接在界面中**浏览、搜索、创建、编辑知识，关联多个领域，查看和恢复修订历史，派生只读领域包、审核 Agent/用户提案，以及预览示例 Pi 项目的知识上下文**。

- **已发布的领域包不可直接编辑**：派生为个人知识后再修订。
- **个人知识默认不自动进入项目**：只有项目显式开启 `workspace` 并声明领域/项目引用才会被纳入动态上下文。
- **修订和审批具备并发防护**：提案固定提交时目标版本，旧提案不得用新的当前修订绕过检查；不能悄悄修改项目归属。
- **数据只在本机**：默认存于 `~/.domain-context/index.sqlite`；支持界面导出 JSON，但**尚不支持 JSON 导入**，请定期备份原始数据库。
- **安全边界**：仅绑定回环地址，无用户认证，不能直接暴露到互联网。当前浏览器预览仅覆盖仓库自带示例项目。

完整 UI、知识数据与审核 API 文档见 **[Personal Knowledge Workbench 指南](docs/PERSONAL_WORKBENCH.md)**。

## Knowledge Maintenance & Provenance v2（当前 PR）

在既有 `PersonalKnowledgeStore` 之上增加来源身份、不可变修订索引、变更事件、Owner 采纳、重验证队列、图感知离线同步、冲突候选与会话上下文台账；不新建存储、不改 Harvest。

```powershell
node bin/knowledge-maint.mjs observe --kind git --project demo --root <repo> --path src/retry.js
node bin/knowledge-maint.mjs explain --knowledge personal.x
node bin/knowledge-maint.mjs revision list --knowledge personal.x
node bin/knowledge-maint.mjs changes list --knowledge-id personal.x
node bin/knowledge-maint.mjs conflicts list
node bin/knowledge-maint.mjs conflicts resolve --id conflict_x --decision accept-incoming
node bin/knowledge-maint.mjs sync export --project demo --out bundle.json
node bin/knowledge-maint.mjs sync export --since 2026-11-09T00:00:00.000Z --out delta.json
node bin/knowledge-maint.mjs sync import --in bundle.json --dry-run
node bin/knowledge-maint.mjs sync import --in bundle.json --allow-project demo
```

- 来源与版本设计：[docs/KNOWLEDGE_SYNC_PROTOCOL.md](docs/KNOWLEDGE_SYNC_PROTOCOL.md)
- 数据模型与 v1 基线：[docs/KNOWLEDGE_MAINTENANCE_V1.md](docs/KNOWLEDGE_MAINTENANCE_V1.md)
- 三轮验收：[docs/ACCEPTANCE_KNOWLEDGE_MAINTENANCE_V2.md](docs/ACCEPTANCE_KNOWLEDGE_MAINTENANCE_V2.md)
- 设计参考：[docs/DESIGN_REFERENCES.md](docs/DESIGN_REFERENCES.md)
- 双设备离线验收：`npm run knowledge:sync:v2`（两个独立 SQLite，无需网络）
- 真实来源验收：`node scripts/e2e/knowledge-provenance-smoke.mjs`（真实 git；GitHub 需 `gh` 登录）
- Workbench「知识维护」：冲突、待重验证、来源、同步游标

## v0.3：从共享知识升级为分层可组合知识

- **L1 Domain Knowledge：** 跨项目的概念、原理、不变量。
- **L2 Applied Knowledge：** 跨项目的模式和实验方法；可声明环境/需求适用条件。
- **L3 Project Knowledge：** 绑定特定项目的环境、需求、决策与本地知识；不自动写入共享索引。
- **多领域导入：** 按 Profile 引用知识，递归解析领域包依赖、拒绝版本冲突和循环。
- **适用性：** 显式区分 applicable / needs_verification / not_applicable / conflict；与知识是否已验证分开。
- **锁定上下文：** sharedSnapshotId / projectSnapshotId 分别锁定跨项目与项目特有知识，可以导出不可变的 Context Lock。

完整模型、配置字段、示例与边界见 **[分层知识工程指南](docs/LAYERED_KNOWLEDGE.md)**。

### 第一条端到端路径（无需模型 API）

```bash
npm run demo:layered
node bin/domainctl.mjs explain --project examples/pi-service-research
node bin/domainctl.mjs compile --project examples/pi-local-research --task "Experiment with prefix caching"
node bin/domainctl.mjs lock --project examples/pi-local-research --out /tmp/pi-context.lock.json
```

`pi-local-research` 和 `pi-service-research` 导入相同的三个领域（`pi-sdk` 是自动解析的依赖），共享同一领域快照和稳定前缀；但缓存和实验的知识在不同环境下得出不同的适用性结果。**示例知识仍标为 unverified，测试验证的是组合逻辑，不是 Pi 的真实行为或生产正确性。**

## 功能状态

| 能力 | 状态 |
|---|---|
| 领域包 manifest + published/shared 过滤 | 已实现 |
| Immutable version + Session snapshot pin | 已实现 |
| 确定性稳定上下文 + 任务动态上下文 | 已实现 |
| SQLite / FTS5 按任务检索、基本关键词排序 | 已实现 |
| 估算 Token 预算与知识跳过 | 已实现（非精确 tokenizer） |
| Pi `before_agent_start`、`resources_discover`、自定义 Tool | 已实现（模拟事件测试） |
| Pi SDK `createAgentSession()` 启动示例 | 已编写（需要 Pi 和模型环境实测） |
| Pi Trace 元数据采集、Run 结算 | **已实现（P2；按项目显式开启）** |
| Node 测试证据、手工证据、候选提案 | **已实现（P2）** |
| 可插拔 Knowledge Extractor | **已实现调用接口，未内置商业模型** |
| 人工审核、不可变版本发布、跨项目检索 | **已实现（P2）** |
| Embedding / 向量检索 | **未实现（后续可选）** |
| L1/L2/L3 分层知识与多领域 Profile | **已实现（v0.3）** |
| 项目环境、需求、决策和 L3 知识隔离 | **已实现（v0.3）** |
| 确定性的适用性判断、显式冲突 | **已实现（v0.3）** |
| 双快照标识与 Context Lock | **已实现（v0.3）** |
| 个人知识 Web UI / 人工笔记 CRUD | **已实现（v0.4，本地原型）** |
| Owner 项目/任务/事件 Registry 与只读问答 | **已实现（v0.5，本地原型）** |
| Durable Job 生命周期（审批/原子承领/租约/裁定/幂等，FakeWorker） | **已实现（v0.6，已合并）** |
| 真实 Pi 只读分析执行器（opt-in） | **已实现（v0.7，已合并）** |
| 自动调度与常驻执行器 | **未实现（后续）** |
| Provider prompt cache 命中率统计 / KV Cache 复用 | **未实现（后续）** |

## 运行环境

- Node.js **22.13+**（使用内置 `node:sqlite`，在部分 Node 22 版本仍会显示 ExperimentalWarning）
- 核心引擎与 CLI 不需要外部 npm 依赖
- Pi Extension 使用 TypeBox 1.x，执行 `npm install` 即可安装
- 若要运行 `examples/sdk-host.mjs`，需另行安装当前 Pi SDK 和配置模型凭据

### 1. 直接运行无需模型的演示

```bash
cd domain-context-pi-starter
node bin/domainctl.mjs demo
npm run demo:evolution
npm test
```

正常结果应看到三个项目**同样的** `snapshotId` / `stableHash`，但不同的 `knowledgeRefs`。运行 `npm test` 应显示所有测试通过。

### 2. 单项目上下文编译与搜索

```bash
node bin/domainctl.mjs inspect --project examples/payment-service
node bin/domainctl.mjs search --project examples/payment-service --query 'idempotency retry'
node bin/domainctl.mjs compile --project examples/payment-service --task 'Implement payment callback retry safely'
```

可通过环境变量 `DOMAIN_CONTEXT_DB=/absolute/path/to/index.sqlite` 指定索引库；默认位置为 `~/.domain-context/index.sqlite`。库中存储的是允许共享的已发布知识文本，请妥善设置文件权限。

### 3. 使用 Pi CLI 直接加载 Extension

```bash
npm install
cd examples/payment-service
pi -e ../../adapters/pi/extension.mjs
```

在 Pi 里运行 `/domain-info` 查看当前快照。提出一个如“检查支付回调幂等性”的问题后，Extension 会在 `before_agent_start` 注入领域上下文；模型需要更多材料时可以调用 `domain_recall`。Skill `reliable-retries` 通过 Pi 的 `resources_discover` 提供。

注意：Pi 可能需要你信任项目，扩展只在项目被信任时加载知识。Pi 的不同版本对应不同 System Prompt 更新行为；本适配器优先使用 `sections`，旧版自动回退到 `systemPrompt`。

### 4. 用 Pi SDK 宿主启动

```bash
npm install
npm install @earendil-works/pi-coding-agent
node examples/sdk-host.mjs examples/payment-service 'Review payment retries and idempotency'
```

SDK 示例基于官方 `createAgentSession`、`DefaultResourceLoader`、`SessionManager.inMemory()`。真正调用 LLM 时需要单独配置 Pi 的模型账号或 API 密钥；`npm test` 本身不需要。

## 跨项目如何共享

每个项目拥有独立的 `domain-context.json`，引用同一个目录中的领域包：

```json
{
  "project": { "id": "payment-service", "notes": "Project-specific constraints." },
  "domainRoot": "../../domains",
  "domains": [{ "id": "software-engineering", "version": "1.0.0" }],
  "context": { "maxTokens": 1500 }
}
```

`domains/software-engineering/1.0.0/manifest.json` 指定包含哪些知识文件和 Skills，哪些稳定知识需要 Always-on 加载。

每个知识单元都要求 `status: "published"` 且 `sharing: "shared"` 才会被加载，其他条目被忽略。项目配置不会被写回共享领域包。

**跨项目复用保证：** 只要领域包的内容、版本和编译策略保持一致，`stableContext`/`stableHash` 在三个项目中相同。`dynamicContext` 会包含具体项目的约束和匹配到的知识，因此可以不同。

**不保证：** 三个项目具有相同的稳定文本，不意味着其完整 LLM 请求前缀一致，更不意味着模型 Provider 一定发生 Prompt Cache 命中。Pi 的默认系统上下文、工具声明、模型和历史消息也会影响缓存。

## P2：运行轨迹到知识的可审核演化

P2 的实操、命令、JSON 示例和权限边界见 **[P2_KNOWLEDGE_EVOLUTION.md](docs/P2_KNOWLEDGE_EVOLUTION.md)**。无需真实模型，可运行：

```bash
npm run demo:evolution
```

演示会在临时目录创建两个项目，执行一个真实 Node 测试，将通过验证的证据交给示例候选提炼器，再由模拟人工审核步骤发布 `1.0.1` 并在另一个项目中检索，**不会修改仓库自带的 `1.0.0` 领域包**。测试程序只验证演示代码的断言，不证明生成经验在所有生产环境中成立。

项目里必须明确配置 `"evolution": {"capture": "metadata"}` 才记录 Pi 轨迹；默认 `off`。记录仅含 `run / project / branch / snapshot` 与工具调用名称、成功失败状态、执行时长、父调用 ID；**不保存原始 Prompt、工具参数、工具输出、模型推理内容**。

项目自行提供经过复核的证据摘要，显式同意跨项目分享，至少附带一条测试通过证据，且经审查者 `approve` 后方可发布。成功结算 `agent_settled` **不代表任务成功**。本地 Node 测试证据可由 `evidence verify-test` 执行真实测试生成；命令只接受测试文件路径、不开 shell，但应仅针对可信代码库使用。

## 代码结构

```text
src/
  applicability.mjs 项目环境/需求条件与知识冲突检查
  scoped-search.mjs 跨项目 + 本地项目内存检索
  context-lock.mjs 生成可复现、可导出的知识快照锁
  loader.mjs        领域清单读取、权限筛选、快照 SHA-256
  compiler.mjs      always-on + dynamic context，hash，预算
  storage.mjs       SQLite / FTS5 检索，Session Pin
  engine.mjs        领域逻辑对外的运行接口
  evolution.mjs     Trace/Evidence/Candidate/Review SQLite 状态机
  extractor.mjs     模型无关的提炼接口（只能提案）
  verification.mjs  Node 本地测试验证工具
  publisher.mjs     原子生成下一个领域版本
adapters/pi/
  extension.mjs     Pi event 和 Tool 集成
bin/
  domainctl.mjs     CLI inspect / search / compile / demo
domains/
  software-engineering/1.0.0/
examples/
  payment-service/
  queue-worker/
  webhook-service/
  sdk-host.mjs
tests/
  workbench.test.mjs   修订、并发、审核、隔离、HTTP API 测试
  layered.test.mjs     分层、多领域依赖与项目隔离测试
  engine.test.mjs
  pi-adapter.test.mjs
```

## 版本和不变量

1. **Published 版本不可修改。** 同一个 `domain@version` 的 manifest、已发布知识和 Skill 都必须保持相同内容哈希；更改已发布知识必须生成新领域版本。
2. **Session Pin。** 相同 Session 在相同项目中只能引用同一份领域快照。快照变化后明确报错，不能悄悄切换版本。
3. **Compiler 是确定性的。** 相同快照、任务、项目资料、预算和 Compiler 版本，输出完全一致。
4. **数据范围最小化。** 索引只接收已 published/shared 的记录，检索时再次按本项目引用的领域快照过滤。
5. **稳态/动态分离。** 不把项目 ID、项目目录、即时任务放进 stableContext，避免不必要的稳定前缀变化。
6. **明确边界。** 当前预算使用启发式 Tokens 估算，真实生产请求还需结合 Provider tokenizer、工具 Schema、系统指令、消息历史、预留输出 Token 做总预算校验。

### 发布领域包的新版本

1. 复制 `domains/software-engineering/1.0.0` 为 `.../1.0.1`。
2. 修改新目录的 `manifest.json` 中 `version` 为 `1.0.1`，同时修改知识文件或 Skill。
3. 修改新项目 `domain-context.json` 中引用的版本到 `1.0.1`；已运行的会话不要无感切换。
4. 运行 `npm test` 和 `domainctl compile` 检查哈希、检索结果、长度预算，再启动新的 Pi Session。

这批演示知识是人工预置的**测试样本**，`evidenceRefs` 只是示例占位符，不能把它们误认为来自真实项目的验证证据。

## 安全与技术限制

- 不建议直接将含敏感信息的任务追踪写入共享知识库；当前版本完全不会自动采集 Pi 轨迹或自动晋升经验。
- Pi Extension 本身在宿主用户权限内运行，使用前要审查项目和扩展代码。对于未受信任项目，适配器会跳过知识包加载（在支持 `ctx.isProjectTrusted` 的 Pi 版本上）。
- SQLite FTS5 适合小规模英文关键字检索，对中文分词和语义匹配的覆盖有限。后续可接入 Embedding、混合召回和 Eval 驱动的停止条件。
- 本版本在本地以 Node 22.16 执行 49 项核心、Workbench HTTP API 与模拟 Pi 生命周期测试。环境未安装 Pi 和模型 API，**未完成 Pi 真实进程/真实 LLM 端到端验证**。
- 为保持发布版本不可变，当前 SQLite 索引不会自动覆盖已经发布的同 ID 记录；升级时创建新版本。开发中的临时版本可以使用独立的 `DOMAIN_CONTEXT_DB`。
- 当前没有数据库并发写入优化、超大规模数据索引、强多租户隔离、ACL 审计和生产部署监控。

## 后续工作

**Personal Knowledge Workbench 后续：** v0.4 已可浏览、编辑、审核、预览上下文；待补多项目外部导入、知识关系可视化、真正的知识导入/备份恢复、强认证与权限模型、项目知识向 Applied/Domain 的显式泛化提案。


**P2 增强：** 真实 LLM 提炼器、语义去重/冲突检测、可校准的证据质量评分、Eval 驱动的晋升门槛、跨项目隐藏测试。当前仅实现同 ID 冲突阻止、基础证据门槛和人工审核，不应将其当作全面的知识真实性证明。

**后续 / Cache & Routing：** 接入真实 Provider usage（cached tokens、输入输出、TTFT）、稳定前缀缓存实验、领域上下文预算优化和选择性检索；根据实际收益再考虑 LMCache / KV Block 复用。

## 官方参考

- [Pi Extensions](https://pi.dev/docs/latest/extensions)
- [Pi SDK](https://pi.dev/docs/latest/sdk)
- [Pi Skills](https://pi.dev/docs/latest/skills)
- [Pi SDK Extension example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/06-extensions.ts)
