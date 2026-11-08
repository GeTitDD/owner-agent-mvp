# Owner Knowledge Loop v1.0 — 交付报告

- 日期：2026-11-08
- 分支：`feat/v1.3-knowledge-loop`（基于 `main@8c14707`）
- pstack-pi：`main@c0fad96`（version `0.2.0`）
- 结论：知识闭环的数据契约、采集、提炼、审批/验证、复用、反馈与 A/B 评估已可运行；真实 Pi 已完成一次 Harvest 和一次 Reuse；困难任务 A/B 显示知识复用带来可测差异。macOS/Companion 知识入口见后续堆叠 PR。

## 1. 复用与职责

| 能力 | 复用 |
| --- | --- |
| 知识存储 | `PersonalKnowledgeStore`（新增 experience/usage/feedback 表与 proposal meta 列） |
| 候选 | 现有 `personal_proposals` + `reviewProposal` |
| 证据/运行 | OwnerStore 的 job/sandbox/repair/evidence |
| 适用性 | `src/applicability.mjs` |
| 上下文 | `compiler.mjs` + `workspace-overlay.mjs` |
| 检索 | `engine.retrieve` / `scopedSearch` |
| Pi | `DefaultPiSessionFactory`；新增只读 Harvest session |
| pstack | EDAE/Reflect/Eval/decision-log 纪律薄适配；不改 Skill |

未新建 KnowledgeStore、CandidateStore、Context Compiler、Agent Harness 或调度器。

## 2. 数据契约

- Experience：`sourceRunId / projectId / taskId / domainIds / observedProblem / actionSummary / observedOutcome / evidenceRefs / environment / facts / inferences / unknowns / dedupeKey`。
- Knowledge Candidate：现有 proposal payload + `meta`：
  - `contract=knowledge-candidate/v1`
  - `sourceExperienceIds / proposedLayer / confidence / contradictions / revision / harvestRunId / playbook=edae / steps / validationSuggestions`
- Knowledge Usage：`knowledgeId / revision / targetRunId / projectId / retrievalReason / applicabilityResult / contextSnapshotId / outcomeEvidenceRefs / observedBenefit / unresolvedQuestions`。
- Outcome Feedback：`usageId / outcome / observedBenefit / evidenceRefs / proposedEvolution / rationale`。

自动候选永远 `unverified`；approve 与 verify 是两个显式人工步骤。

## 3. 实现模块

| 文件 | 作用 |
| --- | --- |
| `src/personal-store.mjs` | 三张 Loop 表、proposal meta、幂等 API |
| `src/knowledge-loop/contracts.mjs` | 契约校验与候选映射 |
| `src/knowledge-loop/experience.mjs` | 从 Sandbox/Job 采集经验 |
| `src/knowledge-loop/pi-harvest-session.mjs` | 只读 Pi Harvest，加载 pstack skills |
| `src/knowledge-loop/harvest.mjs` | EDAE 步骤、证据整理、候选生成 |
| `src/knowledge-loop/reuse.mjs` | 编译上下文、Usage 记录 |
| `src/knowledge-loop/feedback.mjs` | Outcome Feedback、晋升/降级建议 |
| `src/knowledge-loop/eval.mjs` | A/B/C Runner 与指标 |
| `src/knowledge-loop/decision-log.mjs` | 与 pstack 同列 TSV |
| `bin/knowledgectl.mjs` | collect/harvest/approve/verify/reuse/feedback |
| `adapters/pi/extension.mjs` | 编译时记录 Usage（`OWNER_KNOWLEDGE_USAGE=1`） |
| `src/workbench-server.mjs` | 只读 experiences/candidates/usages/loop-summary API |

## 4. 自动化验证

- `npm run check`：通过。
- `npm test`：202 tests / 199 pass / 3 skip / 0 fail（含合并后的 knowledge-loop 测试）。
- `npm run knowledge:demo`：确定性三项目闭环通过。
  - 4 条 Experience（修复、失败、两个通过）
  - L3 候选 → 审核/验证
  - L2 候选 → 审核/验证
  - 3 个项目复用，4 条 usage，4 条正反馈
  - 提出 L2→L1 晋升建议
- 幂等：同一 Run 重复采集不重复；同一 Experience 组合重复 Harvest 返回已有候选；同一 usage key 幂等。
- 数据兼容：`personal_proposals` 自动增加 `meta_json`；旧库仍可打开。

## 5. 真实 Pi 证据

### 5.1 真实 Pi Run 采集

运行 root：`D:\nautilus_trader\.tmp\opencode\knowledge-acceptance-l2b`

- `scripts/acceptance/e2e-repair.mjs --level 2`：源补丁确定性、Sandbox provider 为 fake，**修复提案由真实 Pi（glm-5.3）生成**。
- 修复补丁 `c06b9867-3e2b-4c58-b8cd-f0a58eb08bac`，repair run `completed/completed/pass`。
- 从同一 OwnerStore 直接采集：
  - `exp_7537a0d9e80f4ae0a3410fd1`：源测试 fail；
  - `exp_b36ce1405eec434d92a5ebb0`：修复后 pass / `repaired`。
- 真实 Pi Harvest（`harvest_313d6d093b3a4473ad7d9e47`）从这两条 Experience 生成 2 个 project 候选，包含：
  - “计数式重试 off-by-one：attempts 为总次数时，排他上界必须等于 attempts”；
  - 证据引用源/修复 stdout、两个补丁 diff、snapshot manifest 哈希一致性。
- 说明：该验收的 sandbox 结果为 fake provider 固定输出；模型提案与证据链是真实的，未把它写成真实 Docker 执行。

### 5.2 真实 Harvest + 跨项目候选

运行 root：`D:\nautilus_trader\.tmp\opencode\knowledge-loop-demo-real`

- 输入 3 条 Experience：demo-a 源失败、demo-a 修复通过、demo-b 通过（fixture Sandbox）。
- 模型：`zai-coding-cn/glm-5.3`。
- Harvest run：`harvest_53ef6399aa3d4b1582c0d201`。
- 产出 applied 候选：`4f7d5e76-0f96-49ec-a58c-0c1e9e8decf8`，主张 `attempts - 1` → `attempts`。
- Owner 审核后单元：`personal.80f1093f88644ea8a85a50ff`，revision 2，`verified`。

### 5.3 真实 Reuse

- 项目 B 编译任务：`retry withRetry attempts loop off-by-one`。
- `dynamicContext` 包含 verified 单元，标签 `[applied layer; verification=verified; ELIGIBLE]`。
- 记录 usage：`targetRunId=run-demo-b-pass`，`contextSnapshotId=407db8...`，`applicabilityResult=applicable`。
- 证据文件：`real-reuse-b.json`。

## 6. A/B/C 评估

固定任务、模型 `zai-coding-cn/glm-5.3`、同一 fixture 与测试命令。

### 6.1 通用任务

| Variant | runs | success | rework | irrelevant injection | misapplication | knowledge tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline | 3 | 3/3 | 0 | 0 | 0 | 0 |
| Knowledge | 2 | 2/2 | 0 | 0 | 0 | 569 |
| Forced misleading | 1 | 1/1 | 0 | 0 | 0 | 29 |

结论：在强基线上，helpful 任务没有成功率提升；irrelevant 任务在相关性阈值修复后注入 0 条；forced misleading 被模型忽略，未造成失败。**不宣称通用任务上的效果提升。**

### 6.2 困难任务（不可从源码推断的项目约定）

任务：fixture 默认 `attempts = 1`，测试要求 7 次；知识明确“该 fixture 家族默认尝试次数为 7”。

| Variant | success | rework | knowledge refs |
| --- | ---: | ---: | ---: |
| Baseline | **false** | 1 | 0 |
| Knowledge | **true** | 0 | 3 |

证据：`eval-hard-report.json`（baseline exit 1，knowledge exit 0）。这是本轮唯一可支持的“知识复用有效”结论，且只在明确适用约定的任务上成立。

## 7. 三轮迭代

1. **采集/候选映射**：修复 evidenceRefs 排序导致去重失效；限制单项目候选为 L3；发现 remove candidate meta 需要扩展 proposal schema。
2. **Harvest 证据质量**：真实 Pi 第一轮只看到 patch 路径，产出流程型候选；加入 proposal diff 与“技术机制优先”提示后，真实候选正确识别 `attempts - 1`。
3. **检索精度/Eval**：发现无关任务注入 0.2 分的 claim 命中；把本地知识相关性阈值提高到 3，irrelevant injection 降为 0；新增困难任务 A/B，得到 baseline fail → knowledge pass。

## 8. 已知限制

- 真实 A/B 只在单一模型（glm-5.3）与小型 fixture 上完成；样本量 1，不能外推为普遍效果。
- “知识有效”只在“项目约定不可从源码推断”的困难任务上被证明；通用 retry 任务 baseline 已完成。
- pstack 只作为纪律与 Skill 加载来源；未自动修改 pstack Skill，未调用 Cursor `/loop`。
- Companion 知识入口在堆叠分支实现；macOS 未验证。
- `node-smoke` profile 固定，真实项目需提供 `tests/sandbox-smoke.test.mjs`。
- Token 数为保守估算，不是 provider 计费值。

## 9. 复现

```bash
npm run check
npm test
npm run knowledge:demo -- --root <dir>
# 真实 Pi（需模型凭据）
node bin/knowledgectl.mjs harvest --owner-db <dir>/owner.sqlite --knowledge-db <dir>/knowledge.sqlite \
  --project demo-a --experience <id> --experience <id> --allow-model
node bin/knowledgectl.mjs approve --knowledge-db <dir>/knowledge.sqlite --proposal <id>
node bin/knowledgectl.mjs verify --knowledge-db <dir>/knowledge.sqlite --knowledge-id <id> --evidence sandbox:<id>
node bin/knowledgectl.mjs reuse --cwd <project> --project <id> --task "..." --target-run <run>
node scripts/knowledge-loop/eval-real.mjs --root <dir> --knowledge-id <id> --allow-model
node scripts/knowledge-loop/eval-hard.mjs --root <dir> --allow-model
```

## 10. DoD 对照

| DoD | 状态 |
| --- | --- |
| 真实 Pi Run 可采集为 Experience | ✅（真实 Harvest 使用了真实运行证据；采集器本身也支持 Job/Sandbox） |
| pstack 驱动 Harvest 生成结构化候选 | ✅（加载 pstack skills，EDAE/Reflect/decision log） |
| 候选进入现有知识库 | ✅（proposal → unit） |
| 查询/修订/验证/拒绝/来源追踪 | ✅（现有 PersonalKnowledgeStore + 新增视图） |
| L3→L2/L1 晋升建议 | ✅（两/三个项目正反馈触发 promotion proposal；单元测试+demo） |
| 新任务检索并使用知识 | ✅（真实 Reuse，context + usage） |
| 复用结果反向关联知识 | ✅（feedback → usage → knowledge） |
| 错误/无关/冲突负向测试 | ✅（阈值修复、forced misleading、conflict status） |
| 不重复造存储/Harness | ✅ |
| 真实 Pi 提炼案例 | ✅（harvest_53ef...） |
| 真实 Pi 复用案例 | ✅（real-reuse-b） |
| 三轮 Eval/质量迭代 | ✅（见 §7） |
| 桌宠知识入口 | ✅（堆叠 Companion 分支；四问 + 详情 + 完整知识库） |

## 11. Companion 知识入口

- 面板摘要：已验证知识数 / 候选数 / 复用次数与正反馈。
- 四个请求：今天学到什么、本项目经验、类似问题、验证与复用。
- 详情：claim、层级、verification、revision、证据、复用项目、正/负反馈。
- 候选与 Coding Job 审批分开展示；完整编辑/冲突分析打开 Workbench。
- Electron E2E：`npm run e2e:desktop:knowledge`。
- 截图：`docs/assets/companion/knowledge-list.png`、`knowledge-detail.png`。
| 安装/回滚说明 | ✅（CLI + docs） |
