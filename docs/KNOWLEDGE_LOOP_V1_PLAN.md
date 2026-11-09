# Owner Knowledge Loop v1.0 — 架构与实施计划

- 日期：2026-11-08
- 基线：`main@8c14707`（独立知识闭环分支 `feat/v1.3-knowledge-loop`）
- pstack-pi：`main@c0fad96`，version `0.2.0`
- 目标：证明 `Agent Run → Experience → Candidate → Verification → Domain Knowledge → Retrieval & Reuse → Outcome Feedback → Evolution` 真实运行。

## 1. 复用边界

| 能力 | 现有资产 | 本轮做法 |
| --- | --- | --- |
| 知识存储 | `PersonalKnowledgeStore`（personal_units/revisions/proposals） | **原样复用**，只增加 experience/usage/feedback 表与 proposal meta 列 |
| 候选审批 | `personal_proposals` + `reviewProposal` | **原样复用**；Knowledge Candidate 就是 pending proposal |
| 证据/运行 | `OwnerStore` 的 job/sandbox/repair/evidence | **原样复用**，Experience 只保存摘要与引用 |
| 适用性 | `src/applicability.mjs` | **原样复用** predicates / not_applicable / conflict |
| 上下文编译 | `src/compiler.mjs` + `workspace-overlay.mjs` | **原样复用**；overlay 把个人知识作为动态项目知识 |
| 检索 | `engine.retrieve` / `scopedSearch` | **原样复用** |
| Pi 执行 | `DefaultPiSessionFactory` / `PatchProposalAgent` | **复用**；新增只读 harvest session 适配器 |
| pstack | EDAE / Reflect / Eval / decision log | **借鉴并薄适配**；不自动修改 pstack Skill |
| Workbench | 现有知识 CRUD/proposals/compile API | **扩展只读视图**，不新造知识 UI 引擎 |
| Companion | 独立分支 #22 | Phase 6 在其上增加最小知识入口 |

不新建：KnowledgeStore、CandidateStore、Context Compiler、Agent Harness、调度器、第二套聊天。

## 2. 数据契约

### 2.1 Experience Record

持久化在 `knowledge_experiences`；`payload` 为规范化 JSON。

```json
{
  "id": "exp_...",
  "sourceRunId": "sandbox-run-id | job-id",
  "projectId": "project-id",
  "taskId": "owner-task-id-or-null",
  "domainIds": ["software-engineering"],
  "observedProblem": "短摘要",
  "actionSummary": "做了什么（不含原始对话）",
  "observedOutcome": {
    "status": "succeeded|failed|repaired|cancelled|rejected|unknown",
    "source": "owner-store",
    "testStatus": "pass|fail|unknown|null",
    "executionStatus": "completed|failed|unknown|null",
    "repairStatus": "tested_pass|tested_fail|unknown|null"
  },
  "evidenceRefs": ["sandbox:<id>", "patch:<id>", "evidence:<id>:stdout"],
  "environment": {
    "primaryDomain": "software-engineering",
    "profileId": "node-smoke",
    "imageDigestPrefix": "sha256:...",
    "runtime": "node|unknown"
  },
  "facts": { "storeFieldsObserved": [] },
  "inferences": {},
  "unknowns": ["没有测试证据"],
  "createdAt": "ISO8601",
  "dedupeKey": "sha256(canonical(identity))",
  "collectorVersion": "1.0.0"
}
```

不变量：
- `observedOutcome.status` 只能由 Owner Store 的测试/执行状态推导，不能由模型自报。
- 同一 `sourceRunId + outcome + evidenceRefs` 重复采集返回已有记录。
- 原始 prompt、工具输出、密钥不进入 Experience。

### 2.2 Knowledge Candidate

候选复用 `personal_proposals`：

```json
{
  "id": "proposal-id",
  "targetId": null,
  "status": "pending",
  "payload": {
    "title": "...",
    "content": "claim",
    "kind": "claim|procedure|concept|note|hypothesis",
    "layer": "project|applied|domain",
    "scope": "project|domain",
    "projectId": "project-id|null",
    "domains": ["software-engineering"],
    "tags": ["retry", "off-by-one"],
    "evidenceRefs": ["sandbox:...", "exp:..."],
    "verificationStatus": "unverified|needs_reverification",
    "relations": { "contradicts": ["knowledge-id"], "specializes": [] },
    "sourceRef": "knowledge-loop:<harvestRunId>"
  },
  "meta": {
    "contract": "knowledge-candidate/v1",
    "sourceExperienceIds": ["exp_..."],
    "proposedLayer": "project|applied|domain",
    "confidence": 0.0,
    "contradictions": ["..."],
    "revision": 1,
    "verificationStatus": "unverified",
    "harvestRunId": "harvest-id",
    "playbook": "edae",
    "steps": ["确定边界", "先评估", "调查设计", "实现记录", "验证", "回流"],
    "validationSuggestions": ["..."],
    "facts": [],
    "inferences": [],
    "unknowns": []
  }
}
```

- 候选默认 `project` layer、`unverified`。
- 只有多个独立项目证据才建议 `applied`；L1 需要更强证据且仍由 Owner 审批。
- 冲突候选必须标记 `relations.contradicts` 或 `meta.contradictions`，不得静默强化。

### 2.3 Knowledge Usage

持久化在 `knowledge_usages`：

```json
{
  "id": "usage-id",
  "knowledgeId": "personal.xxx",
  "revision": 3,
  "targetRunId": "session-or-sandbox-run-id",
  "projectId": "project-id",
  "retrievalReason": "task text",
  "applicabilityResult": "applicable|needs_verification",
  "contextSnapshotId": "compilationHash",
  "outcomeEvidenceRefs": ["sandbox:..."],
  "observedBenefit": "positive|negative|neutral|unknown",
  "unresolvedQuestions": ["..."],
  "createdAt": "ISO8601"
}
```

`(knowledgeId, revision, targetRunId, contextSnapshotId)` 唯一，重复记录幂等。

### 2.4 Outcome Feedback

持久化在 `knowledge_feedback`，追加式：

```json
{
  "usageId": "usage-id",
  "outcome": "succeeded|failed|repaired|cancelled|unknown",
  "observedBenefit": "positive|negative|neutral|unknown",
  "evidenceRefs": ["sandbox:..."],
  "proposedEvolution": "promote|demote|revise|none",
  "rationale": "..."
}
```

## 3. 模块

| 模块 | 职责 |
| --- | --- |
| `src/knowledge-loop/contracts.mjs` | 三个契约的校验、规范化、去重键 |
| `src/knowledge-loop/experience.mjs` | 从 OwnerStore 采集 Experience |
| `src/knowledge-loop/harvest.mjs` | pstack EDAE/Reflect 风格提炼、候选生成 |
| `src/knowledge-loop/reuse.mjs` | 检索、编译、Usage 记录 |
| `src/knowledge-loop/feedback.mjs` | Outcome Feedback、晋升/降级建议 |
| `src/knowledge-loop/eval.mjs` | A/B runner 与指标 |
| `src/knowledge-loop/decision-log.mjs` | 与 pstack decision-log 同列的 TSV |
| `bin/knowledgectl.mjs` | 本地 CLI：collect/harvest/reuse/feedback/eval |
| `adapters/pi/extension.mjs` | 编译时记录 Usage（可选，默认关闭） |
| `src/personal-store.mjs` | 最小 schema 扩展 |
| `src/patch-proposal-agent.mjs` | 可选 `knowledgeContext` 注入（Eval 用） |

## 4. 阶段与验收

| 阶段 | 交付 | 验收 |
| --- | --- | --- |
| P1 契约与采集 | 三张表、采集器、幂等 | 成功/失败/修复三种结局各一条 Experience |
| P2 Harvest | harvest session + 严格 JSON + proposal | 真实 Pi 从失败修复生成可查询候选 |
| P3 分层/验证/演化 | 晋升/降级/冲突建议 | 两项目证据→L2 建议；反例→降级建议 |
| P4 复用 | overlay 检索 + Usage | 任务 B 上下文含任务 A 知识，并记录 usage |
| P5 Eval | A/B/C 固定任务与指标 | 三类任务、原始结果、负向案例、报告 |
| P6 Companion | 四个知识问答入口 | 真实 Electron 截图与证据 |
| P7 三轮迭代 | 采集→提炼→验证→复用→Eval→修复 | 每轮瓶颈、修复、回归 |

## 5. Eval 设计

固定任务集：

- `helpful`：知识直接适用，期望 Variant B 更快/更少返工。
- `irrelevant`：知识无关，期望不注入，A/B 无差异。
- `misleading`：知识表面相似但适用条件不满足；期望 Variant B 不注入；另设 Variant C 强制注入作为负向对照。

对照组：

- A：不注入积累知识。
- B：注入经过 applicability + verification 过滤的知识。
- C（仅 misleading）：强制注入错误知识，证明负向影响。

指标：成功率、测试通过、返工次数、错误类型、无关注入率、错误适用率、估算 token、延迟。报告样本量与波动；无改善时如实记录。

## 6. 检查点

- 每阶段完成后更新本文件的“状态”与 `docs/knowledge-loop/decisions.tsv`。
- 不合并 main，不自动发布私有知识，不自动修改 pstack 全局 Skill。
- 真实 Pi 调用次数受控；Fake 用于高频回归。
