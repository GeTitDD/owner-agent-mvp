# Knowledge Maintenance & Provenance v2 — 三轮自主验收

> 时间：2026-11-09
> 基线：`main`（含 PR #23 Knowledge Loop）
> 分支：`feat/knowledge-maintenance-provenance`（Draft PR #26）
> 范围：知识身份与来源、不可变修订、变更事件、离线同步、冲突保留与 R4 收敛、Workbench 维护界面。
> 不包含：改写 Harvest、重新设计 Agent Harness、分布式数据库、通用知识图谱、自动合并。

## 结论

| 验收轮次 | 重点 | 结果 |
| --- | --- | --- |
| 第一轮 | 数据契约、迁移与版本完整性 | 29/29 通过 |
| 第二轮 | 两设备同步、冲突与恢复 | 19/19 单测 + 16/16 E2E 检查通过 |
| 第三轮 | 真实项目维护、Compiler/Usage 回归、端到端复现 | 全量 254 tests / 251 pass / 3 skip / 0 fail；真实 git + GitHub 冒烟通过 |

最终判定：**两个独立 SQLite 环境可以可靠导出、导入、审查、修订并收敛到同一份知识；历史与来源可检查；冲突不丢失；旧会话仍指向运行时的修订。**

## CI 状态（平台侧阻塞）

2026-11-09 10:03–10:56 UTC，GitHub Actions 对本分支的所有 job 在 1–2 秒内失败，`steps=0`、`runner_name` 为空、日志不可下载（run `42598066507`、`42597866546`、`42604916699`、`42605981685`）。同一仓库 08:35 UTC 的 run `42587081508` 仍成功，判断为平台侧 runner 调度/额度问题，与本 PR 代码无关。

本地按 CI 相同步骤验证（HEAD `8a1a05a`）：

```text
npm run check        -> 0
npm test             -> 254 tests / 251 pass / 3 skip / 0 fail
npm run demo:jobs    -> 0
npm run demo:pi      -> 0
npm run demo:patch   -> 0
npm run demo:sandbox -> 0
npm run demo:repair  -> 0
npm run knowledge:sync:v2  -> 16/16
provenance smoke            -> 10/10
```

CI 恢复后需要重跑；本 PR 保持 Draft，不以平台失败作为合并依据。

---

## 第一轮：数据契约、迁移与版本完整性

### 执行

```powershell
npm run check
node --test tests/knowledge-provenance.test.mjs tests/knowledge-provenance-v2.test.mjs tests/workbench.test.mjs
```

### 结果

```text
# tests 29
# pass 29
# fail 0
```

覆盖：
- `revisionId` 对相同 `(knowledgeId, contentHash, parents, reason, actor)` 稳定，对内容/父修订变化敏感；
- 旧库打开时自动补齐 `knowledge_identities` 与 `knowledge_revision_index`，父子链正确；
- 新修订写入自动产生索引与 `create/revise` 事件；重复 `changeId` + 相同 hash 幂等，不同 hash 拒绝；
- Owner 采纳、来源链接产生可审计事件；`explain` 返回 `knowledgeId / headRevisionId / changes`；
- 文件数据库关闭重开后索引、设备 ID、冲突仍在；
- Workbench 维护 API 可读取 provenance、冲突、来源、变更，并可显式解决冲突。

### 发现与修复

1. **`next is not defined`**：`PersonalKnowledgeStore.update` 在事务块外读取块级变量。修复：在 `try` 外声明 `normalized/body/stamp/next`。
2. **导出缺少父修订**：没有 provenance 实例时 `exportBundle` 把 `parentRevisionIds` 写成 `[]`，导致另一端无法识别共同祖先。修复：导出时按本地顺序回填上一个 `revisionId` 作为父修订。
3. **迁移不伪造来源**：旧修订只补修订索引，`source` 保持 `unknown`；不推断 commit/哈希。
4. **冲突候选未进入修订索引**：分叉时远端分支只写入 `knowledge_candidates`。修复：同时以 `local_revision=NULL`、`status=candidate` 写入 `knowledge_revision_index`，保证两条分支都可见。

---

## 第二轮：两设备同步、冲突与恢复

### 执行

```powershell
node --test tests/knowledge-sync.test.mjs tests/knowledge-sync-v2.test.mjs
npm run knowledge:sync:v2
```

### 结果

```text
# tests 19
# pass 19
# fail 0
```

双设备 E2E（`scripts/e2e/knowledge-sync-v2.mjs`，两个独立 SQLite）：**16/16 检查通过**。

覆盖：
- A 建立 R1 + 本地文件来源 + 采纳；B 导入后保留 `knowledgeId`、来源、修订与采纳；
- B 形成 R2 候选，不自动替代已采纳 R1；
- A 离线形成 R3；
- A→B 识别共同祖先 R1，保留 R2/R3 两条分支与来源，本地 Head 不动；
- Owner 采用远端 → 双亲 R4，来源链接保留，仍需显式采纳；
- B→A 按“父修订包含 A 的 Head”识别为后代并追加，两端收敛；
- 旧 Session 仍引用 R1，并报告 `revision-changed` + 当时 `payloadHash`；
- 重复导入 `unchanged`，不产生新修订；事件重复导入 `applied=0, duplicates>0`；
- 篡改内容/哈希的 Bundle 整条拒绝；
- `allowedProjectIds` 拒绝越权项目数据；
- 增量导出只包含游标后变更的单元；
- JSONL 往返可导入，坏行整包拒绝；
- dry-run 不写候选、冲突或修订。

### 发现与修复

1. **图感知分类把远端修订误判为“本地已知”**：`classifyGraph` 的 known 集合包含了 incoming 自己。修复：单独传入本地 `localIds`。
2. **无 provenance 的调用方崩溃**：纯 `PersonalKnowledgeStore` 导入 v2 时访问 `provenance.db`。修复：退回线性前缀分类。
3. **非冲突元数据被一律排队**：旧行为会三方合并，新图逻辑最初把所有分叉都变成冲突。修复：仅 `diverged` 且字段级无冲突时生成合并修订；正文/验证/采纳冲突仍进入队列；`unrelated` 永不自动合并。
4. **候选来源丢失**：远端分支的来源包没有挂到 R4。修复：`resolveConflict` 导入候选 `sourceBundle` 并重新链接到新修订。
5. **部分导入失败**：单元写入与修订写入在事务内；失败的单元记入 `report.errors`，其余继续；事件按 `changeId` 幂等，可安全重试。

---

## 第三轮：真实项目知识维护、Compiler/Usage 回归与端到端复现

### 执行

```powershell
npm test
node scripts/e2e/knowledge-provenance-smoke.mjs
npm run knowledge:sync:v2
```

### 结果

```text
# tests 254
# pass 251
# skip 3
# fail 0
```

真实来源冒烟（`knowledge-provenance-smoke.mjs`）10/10：
- 项目身份：`git-first-commit`；
- 真实 git 文件：commit + blob SHA；
- Owner 采纳 R1；
- 改文件并提交 → 恰好 1 条 `pending` 重验证，知识 Head 不变；
- 接受重验证 → `needs_reverification` 新修订；
- `explain` 报告来源版本、采纳修订与 drift；
- 导出/导入保留 ID 与历史；二次导入幂等；
- 真实 GitHub commit：`5d5356af2f1e17fb5e36f87737fbe683a5dd494b`。

Compiler / Usage 回归：
- `KnowledgeReuse` 的 `knowledgeRefs` 继续使用 `workspace:<knowledgeId>:r<n>`；
- 新增测试：编译后 B 设备产生新版本并同步到 A，旧 Session 的 `KnowledgeContextLedger` 仍指向 R1；
- 同步后才写入的 Usage/Feedback 仍指向当时使用的 `revision=1`，不会自动改挂新 Head；
- 旧 Usage 的 `payloadHash` 与 `getRevision(R1).payloadHash` 一致，可复现当时上下文；
- L1/L2/L3、project scope、verification、applicability 与人工审批语义未改动。

### 发现与修复

1. **Workbench 维护 UI 缺失**：新增 `/api/maintenance/*` 与「知识维护」标签页（冲突、待重验证、来源、同步游标）；不重做知识编辑器。
2. **维护测试变量未声明**：补 `let conflicts/resolved/explained/sources/changes`，避免 ESM 严格模式下隐式全局报错。
3. **作用域测试需重算哈希**：合法越权 Bundle 必须重新计算 `payloadHash/revisionId`，否则先被完整性校验拒绝，测不到作用域分支。

---

## 复审修复（PR #26 Review，HEAD b37ab75）

针对复审指出的四组问题，先写失败测试再修复；回归文件：`tests/knowledge-consistency-review.test.mjs`（8 个用例）。

| 问题 | 修复 | 回归 |
| --- | --- | --- |
| dry-run 写库；项目/事件/来源/快照作用域不完整 | `ensureProject`、`importEvents`、游标全部移到 `apply` 门后；预检所有修订；事件按 `knowledgeId` 过滤；来源/快照按项目过滤；无项目来源只允许被授权单元引用 | dry-run 前后 14 张表计数完全一致；越权包不写 project/event/source/snapshot |
| 远端整数 revision 被当作本地身份 | 导出 `links/adoptions` 携带 `revisionId`；导入建立 `revisionId → local_revision` 映射；缺失目标写入 `knowledge_pending_links` / `knowledge_pending_adoptions`，落地后解析 | A/B 本地 revision 号不同时，R4 来源与采纳仍指向正确内容；缺失目标不猜数字 |
| Compiler 消费未采纳 Head | Workspace Overlay 优先读取 `knowledge_adoptions.adopted_revision` 的不可变修订；无采纳记录才沿用 Head；`requireAdoption` 可强制 | 采纳 R1、Head 漂移到 R2 后，Compiler 仍只注入 `workspace:id:r1` 的 R1 内容与验证状态 |
| Reuse/Ledger 漂移；proposal 审批漏钩子 | `retrieve/compileAsync/recordFromPlan` 使用计划中的 `ref.revision`；Ledger 从锁定修订读取 `payloadHash/verificationStatus`；`reviewProposal` 批准后调用 `onRevision` | 编译后 Head 变化，旧计划 Usage 仍是 R1；真实 Harvest 提案 → 批准 → 同步 → 复用使用 R2；批准立即产生索引与事件 |

说明：
- `listChanges` 增加 `rowid` 兜底排序，避免同一毫秒内 create/revise 乱序。
- 复审修复不改变产品范围；仍保持 Draft，不自动合并。



| Phase | 交付 | 证据 |
| --- | --- | --- |
| 0 基线调查 | 复用 PersonalKnowledgeStore/Workbench/Compiler；未重复实现 #23 | 本报告与 PR 描述 |
| 1 身份与来源 | `knowledgeId/revisionId/revision/schemaVersion/sourceId/sourceSystem/sourceType/sourceLocator/sourceVersion/sourceContentHash/observedAt/recordedAt/actorId/sessionId/runId/deviceId/parentRevisionIds` | `src/knowledge/sources.mjs`、JSON Schema |
| 2 修订与生命周期 | 不可变索引、父子、原因/主体、来源变更、采纳、回溯、冲突、失效、降级 | `provenance-schema.mjs`、`provenance.mjs`、迁移测试 |
| 3 变更协议 | `changeId`、base/result、actor/origin、时间、payloadHash、schemaVersion；幂等与重放保护 | `knowledge_changes`、事件测试 |
| 4 可移植同步 | 快照/增量、JSON/JSONL、游标、幂等、恢复、冲突、完整性、双库 | `sync.mjs`、`knowledge-sync-v2.mjs` |
| 5 Compiler/Usage | 锁定 `revisionId` + `payloadHash`；旧 Session/跨设备/后写 Usage | `context-ledger.mjs`、同步 v2 测试 |
| 6 维护界面 | 来源、修订时间线、差异、同步状态、冲突解决、重验证列表 | Workbench「知识维护」/API |
| 7 端到端 | R1→R2/R3→冲突→R4→收敛；异常/篡改/越权/重复/乱序 | 16/16 E2E 检查 |

## 最终回答

1. **知识如何跨系统保持稳定身份？**
   `knowledgeId` 在首次记录时分配，随 Bundle 原样传播；`knowledge_identities` 把它绑定到本地 `unit_id`。`revisionId` 由内容、父修订、原因和主体确定，跨设备可复算。项目身份优先 git remote，其次首个 commit，最后 local-root。

2. **如何追踪每条知识的真实来源？**
   来源实体用 `sourceId = hash(namespace, sourceType, objectId)`；每次观察用 `observationId = hash(sourceId, sourceVersion, contentHash, captureRunId)`；修订通过 `knowledge_source_links` 关联观察。Git 记录 commit + blob SHA，本地文件记录内容哈希，GitHub 记录 commit/PR head SHA；无法验证时显式 `unknown`。

3. **如何区别来源版本、知识版本和运行快照？**
   - 来源版本：`sourceVersion`（commit SHA / 文件内容哈希 / 消息 ID）；
   - 知识版本：`revisionId` + 本地 `revision`；
   - 运行快照：`knowledge_context_snapshots` 记录 `compilationHash + knowledgeId + revision + payloadHash`。
   三者不互相替代；`restore` 只报告漂移，不改写历史。

4. **两个离线设备同时修改同一知识会发生什么？**
   双方各自产生新 `revisionId`。导入端按 DAG 找共同祖先；分叉时保留远端候选与来源包，写入 `knowledge_conflicts`，本地 Head 和 Owner 采纳状态都不变。不会 last-write-wins。

5. **如何保证同步不会静默改变 Owner 的已采纳认知？**
   采纳记录在 `knowledge_adoptions`，与 Head 分离；导入不覆盖已有采纳。冲突必须由 Owner 显式 `accept-local / accept-incoming / merge / dismiss`；即使生成 R4，也需要再次 `adopt`。所有变更都有不可变事件与 payloadHash。

6. **如何恢复任意旧版本并复现当时的上下文？**
   `revision list` 找到 `revisionId`，`getRevision` 返回完整 payload、来源链接与父链；`store.revert` 以新修订恢复旧内容（不删除历史）。`KnowledgeContextLedger.restore(snapshotId)` 返回当时每个引用的修订、payloadHash 与漂移状态，用于复现当时上下文。

## 残余风险

- 没有自然键时，两台设备**独立创建**的同一知识不会自动合并；身份只能通过同步传播。语义去重留给后续 Eval/人工审核。
- JSONL 目前是整文件解析，超大 Bundle 的内存占用未优化。
- 本地 `revision` 号在接收远端祖先分支后会出现“非拓扑顺序”（R2 可能排在 R3 之后）；跨设备只使用 `revisionId`，UI 以修订索引为准。
- 真实 GitHub 冒烟依赖 `gh` 登录；CI 默认不执行该网络用例。
- macOS / 超大历史（>10k 修订）/ 并发多进程写入未验证。
- 传输层未实现；未认证前不得开放公网写入。

## 复现

```powershell
npm install
npm run check
npm test
npm run knowledge:sync:v2
node scripts/e2e/knowledge-provenance-smoke.mjs   # 需要 git；GitHub 需要 gh 登录
```

证据文件：
- `EVIDENCE_DIR/knowledge-sync-v2.json`
- `EVIDENCE_DIR/provenance-smoke.json`
