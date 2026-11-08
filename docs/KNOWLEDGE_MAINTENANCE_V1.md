# Knowledge Maintenance & Provenance v1

> 基线：`feat/v1.3-knowledge-loop`（PR #23，`94c0c7d`）。本 PR 栈式开发，不复制 #23 已有模块；
> 合并顺序仍建议 #23 先进入 `main`，本分支随后 rebase。

## 1. 目标与边界

Owner 是**已采纳的领域知识与项目上下文**的长期记录者，不是外部世界最新事实的镜像。
本版只做“同一份知识能被可靠识别、追溯、维护、同步和恢复”，不改 Harvest 提示词、不提高生成质量、不重做 Agent Harness。

**做**：来源身份协议、观察记录、修订↔来源绑定、Owner 采纳、来源变更重验证队列、跨设备离线同步、会话上下文快照。
**不做**：知识图谱、统一认知状态模型、Project Journal、自治研究调度、CRDT 引擎、消息队列、第二套存储。

## 2. 数据模型（加法式 Schema）

既有 `personal_units` / `personal_revisions` 原样保留；新增 8 张表，旧库打开时自动建表。

| 表 | 作用 | 关键约束 |
| --- | --- | --- |
| `knowledge_projects` | 本地 `projectId` ↔ 稳定 `projectIdentity` ↔ 别名 | `project_identity` 唯一；不同 identity 绑同一 projectId 会被拒绝 |
| `knowledge_sources` | 来源身份 | `(namespace, source_type, object_id)` 唯一；不含本地绝对路径 |
| `knowledge_source_observations` | 一次来源观察 | `(source_id, source_version, content_hash, capture_run_id)` 唯一，可幂等重放 |
| `knowledge_source_links` | 修订 ↔ 观察 | 主键 `(unit, revision, observation, relation)`；关系限定 supports / contradicts / derived_from / validates |
| `knowledge_adoptions` | Owner 当前采纳的修订 | 每个知识一行；与 Head 分离，可检测漂移 |
| `knowledge_revalidations` | 待重验证队列 | `pending` → `accepted` / `dismissed`；同一观察不重复建项 |
| `knowledge_conflicts` | 同步冲突 | 记录 base / local / incoming；冲突时本地 Head 不变 |
| `knowledge_context_snapshots` | 会话上下文台账 | `compilation_hash` + 引用列表；用于新会话恢复与漂移检测 |

所有记录都带 `payload` + `payload_hash`，导入时先校验哈希。

## 3. 身份与来源协议

```text
knowledgeId      personal.<24hex>      跨设备同步时原样保留
projectIdentity  prj_<24hex>           git-remote > git-first-commit > local-root
sourceId         src_<24hex>           hash(namespace, sourceType, objectId)
observationId    obs_<24hex>           hash(sourceId, sourceVersion, contentHash, captureRunId)
deviceId         dev_<24hex>           首次运行生成，存 ~/.domain-context/device-id
```

`SourceDescriptor` 字段：`sourceId / sourceType / namespace / objectId / sourceVersion / locator / contentHash / observedAt / captureRunId / availability`。

- `sourceVersion` 必须是不可变标识：commit SHA、blob SHA、Run ID、内容哈希、GitHub commit/PR head SHA。
- Issue 只有 `updated_at`，因此显式写成 `updated:<时间>`，不冒充不可变版本。
- 旧 `evidenceRefs` / `sourceRef` 作为 **Legacy Source Ref** 原样保留；解析器只识别前缀，绝不补造版本。

### 已实现的真实解析路径

| 来源 | 解析方式 | 版本语义 |
| --- | --- | --- |
| Git 文件 | `git rev-parse HEAD:<path>` + `origin` | commit SHA；内容哈希 = blob SHA |
| 本地文件 | 读取内容 + `sha256` | `sha256:<hash>`（内容寻址） |
| GitHub | `gh api repos/:repo/commits/:ref` / `pulls/:n` / `issues/:n` | commit SHA / PR head SHA / `updated:<ts>` |
| Owner Run | `OwnerStore.getSandboxRun` | Run ID；内容哈希覆盖终态证据字段 |
| Pi Session | `sessionId` + 可选 transcript 哈希 | 无哈希时 `session:<id>` 且 `availability=unknown` |

失败一律抛 `SourceResolveError(reason)`，调用方可以标 `unavailable`，不能写假数据。

## 4. 维护语义

### 4.1 采纳 ≠ Head

- 编辑会产生新修订，Head 前移；`knowledge_adoptions` 记录 Owner 采纳的版本。
- `explain` 同时给出 `headRevision`、`adoptedRevision`、`adoptionDrift`。
- 编辑已采纳的已验证知识时，沿用既有规则：内容变化 → `needs_reverification` 且清空证据。

### 4.2 来源更新只排队

```
观察新版本 → 找出引用旧版本的修订 → 建 pending revalidation
           → Owner accepted → 生成 needs_reverification 修订
           → Owner dismissed → 仅关闭提示
```

**不会**因为外部文件变化自动改知识，也不会自动重算验证状态。

### 4.3 同步四段式

1. **完整性**：`sha256(canonical(payload)) == payloadHash`，不通过则整条拒绝。
2. **关系判定**：相等 → unchanged；本地是远端前缀 → local-ahead；远端是本地前缀 → fast-forward。
3. **三方合并**：分叉时按字段比较 base / local / incoming；只有一边变化就自动采用。
4. **冲突保留**：两边都改同一字段 → 写 `knowledge_conflicts`，本地 Head 不动，报告字段名。

### 4.4 会话恢复

`KnowledgeReuse.compileAsync` / `recordFromPlan` 可注入 `KnowledgeContextLedger`，把
`knowledgeId + revision + payloadHash + verificationStatus + compilationHash` 写入台账。
`restore(snapshotId)` 返回每个引用的漂移状态：`same | revision-changed | verification-changed | missing`。

## 5. 使用方式

```powershell
# 项目身份
node bin/knowledge-maint.mjs project register --project demo --root <repo>

# 观察来源（真实 git / 文件 / GitHub / Run / Session）
node bin/knowledge-maint.mjs observe --kind git --project demo --root <repo> --path src/retry.js
node bin/knowledge-maint.mjs observe --kind github --repo GeTitDD/owner-agent-mvp --github-kind commit --ref main --project demo

# 绑定与采纳
node bin/knowledge-maint.mjs link --knowledge personal.x --revision 2 --observation obs.y --relation supports
node bin/knowledge-maint.mjs adopt --knowledge personal.x --note "Owner accepted"

# 追溯与维护
node bin/knowledge-maint.mjs explain --knowledge personal.x
node bin/knowledge-maint.mjs revalidate list --status pending
node bin/knowledge-maint.mjs revalidate resolve --id reval.x --decision accepted

# 离线同步
node bin/knowledge-maint.mjs sync export --project demo --out bundle.json
node bin/knowledge-maint.mjs sync import --in bundle.json --dry-run
node bin/knowledge-maint.mjs sync import --in bundle.json

# 会话上下文
node bin/knowledge-maint.mjs context latest --project demo --session sess-1
node bin/knowledge-maint.mjs context restore --snapshot ctx.x
```

默认数据库与既有知识库一致：`~/.domain-context/index.sqlite`；可用 `--knowledge-db` 覆盖。
设备 ID 可用 `OWNER_DEVICE_ID` 固定（测试/CI）。

## 6. 验收证据

```powershell
node --test tests/knowledge-provenance.test.mjs   # 12 tests
node --test tests/knowledge-sync.test.mjs         # 11 tests
node scripts/e2e/knowledge-provenance-smoke.mjs   # 真实 CLI + 真实 git + 真实 GitHub
```

端到端脚本覆盖：

1. 项目身份登记（无 remote 时退到根提交）；
2. 建立知识单元（沿用既有 PersonalKnowledgeStore）；
3. 真实 git 观察，得到 commit SHA + blob SHA；
4. 绑定修订并记录 Owner 采纳；
5. 修改并提交文件后再观察 → 恰好 1 条 pending 重验证，知识 Head 不变；
6. Owner 接受重验证 → 生成 `needs_reverification` 修订；
7. `explain` 回报来源版本、采纳修订与漂移；
8. 导出 → 导入空库：知识 ID、修订历史、来源、链接、采纳全部保留；
9. 再次导入幂等；
10. 真实 GitHub commit 观察（需要 `gh` 登录与网络；失败时显式跳过）。

## 7. 已知限制 / scope out

- 同步按**单元线性历史**合并；若同一设备删除后重建修订号，会判为分叉而不是重写历史。
- 项目身份在没有 remote、也没有根提交时退到本地根哈希，此时**跨设备不可识别**，会显式标为 `local-root`。
- 导入不自动解决冲突；冲突保留在 `knowledge_conflicts`，需 Owner 在后续版本处理。
- 导出默认只含项目范围的单元；`--all` 可导出全部，但没有按领域筛选。
- 同步包**未签名**：哈希只防传输损坏与误改，不防恶意构造；跨不可信网络传输前需自行加密与认证。
- 尚未接入 Workbench UI；目前是 CLI + 可注入服务。
- 未验证：macOS、超大历史（>10k 修订）同步性能。
