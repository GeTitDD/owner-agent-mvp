# Owner Knowledge Loop v1.0 — A/B/C 评估报告

- 日期：2026-11-08
- 模型：`zai-coding-cn/glm-5.3`（除非另注）
- 固定条件：同一 fixture、同一测试命令、同一 exec 预算；Variant 只增加知识上下文。
- Token 为 `estimateTokens` 保守估算，不是 provider 计费值。

## 1. 通用三任务

| Variant | runs | success | rework | irrelevant injection | misapplication | knowledge tokens | mean latency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline | 3 | 3/3 | 0 | 0 | 0 | 0 | 6.4s |
| Knowledge | 2 | 2/2 | 0 | 0 | 0 | 569 | 4.1s |
| Forced misleading | 1 | 1/1 | 0 | 1（强制） | 0 | 29 | 5.9s |

任务：

1. helpful：修复 `src/retry.js` 的 off-by-one。
2. irrelevant：给 `src/format.js` 加注释；测试为 no-op。
3. misleading：修复 retry，但强制注入“`i < attempts - 1` 永远正确”的错误建议。

结论：

- 强模型在通用 helpful 任务上无需知识也能成功，**未观察到成功率提升**。
- 修复相关性阈值后，irrelevant 任务注入 0 条本地知识。
- 模型忽略了 forced misleading 的建议，未产生可测负向影响；misapplication=0。
- 因此不能宣称“通用任务上知识复用有效”。

## 2. 真实 A→B 学习链（主证据）

流程：

1. A 项目隐藏约定 fixture（默认 attempts=7）失败 + 人工修复通过。
2. 采集 A 的 fail/repaired Experience。
3. 真实 Pi Harvest → project 候选 → Owner 审核/验证 → L3。
4. B 独立项目无知识执行同一任务 → baseline fail（真实 Pi）。
5. 采集 B 失败 Experience；Harvest(A+B) **仍是 project**，因为 B 只有失败证据。
6. B 用 L3 内容做显式 validation-injection → pass；持久化 eval run 并采集 B pass Experience。
7. Harvest(A pass + B pass) → applied → L2。
8. B 通过 Compiler/overlay 正常检索 L2；同一任务/模型/测试执行 → pass。
9. Usage 绑定知识版 eval run；controlled comparison（baseline failed / variant succeeded）→ benefit=positive。

| 阶段 | 结果 |
| --- | --- |
| A Experience | fail + repaired |
| A Harvest | `harvest_68bf...` → L3 `personal.dc71...` |
| B baseline | fail，exit 1 |
| A+B baseline Harvest | `harvest_b12f...` → **project**，不晋升 |
| B validation | `eval_b_validation_9ff5...` → pass；B pass Experience |
| A+B pass Harvest | `harvest_417a...` → L2 `personal.0e03...` |
| B reuse | `eval_b_reuse_0c7f...`；dynamicContext 含 L2 |
| B knowledge | pass，exit 0 |
| Feedback | outcome=succeeded，benefit=positive，证据 `eval:eval_b_reuse...` |

结论：这是由真实执行证据驱动、经 Harvest/审批/验证、在另一个项目被实际检索并改变结果的 A→B 学习链。**范围是“B 已失败后进行跨项目知识迁移”，不是“A 学会后让 B 首次运行预防失败”。** 样本量 1，仍不外推。

## 3. Oracle Control：不可从源码推断的项目约定

此实验直接预置答案并人工 verified，仅用于测量“有答案时的上限”，**不作为学习链证据**。

Fixture：

- `src/retry.js` 默认 `attempts = 1`；
- 测试断言恰好 7 次调用；
- 仅看源码无法推断“7”这个项目约定。

知识：

> In this retry fixture family, the default attempt count is 7. When attempts is omitted, default to 7 and loop with i < attempts.

| Variant | success | test exit | rework | knowledge refs | tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Baseline | **false** | 1 | 1 | 0 | 0 |
| Knowledge | **true** | 0 | 0 | 3 | 633 |

结论：Oracle 上限对照显示答案注入可使 baseline fail → knowledge pass；它不证明 Owner 从 A 学到并迁移。

## 4. 负向案例与失败分析

- 第一版本地检索对 claim 的 0.2 分命中也会注入，导致“加注释”任务拿到 retry 知识；阈值提高到 title/keyword 命中（score ≥ 3）后，irrelevant injection 降为 0。
- Forced misleading 没有造成失败，说明该模型会忽略与代码直接冲突的建议；这不能证明所有模型都会忽略，因此保留为负向对照而非安全结论。
- 通用任务无提升的原因：模型能力足够覆盖小型 fixture；知识的主要价值在项目约定、历史失败与非显然约束，当前任务集未充分覆盖这些分布。

## 5. 后续实验设计

1. 增加“不可从源码推断的约定/隐藏测试契约”任务集，样本量 ≥ 5。
2. 引入较弱 baseline 模型，报告模型 × 知识交互，而不是只报告单模型。
3. 增加返工次数与 token 成本的双指标；本轮只有单次生成，返工上限为 1。
4. 对 forced misleading 做多模型重复，测量错误适用率。
5. 在第三个独立代码库上验证 L2→L1 晋升后的复用效果。

## 6. 证据索引

- 真实 A→B：`ab-report.json`、`ab-decisions.tsv`；root `knowledge-ab-learning6`；eval runs `eval_b_validation_9ff5...`、`eval_b_reuse_0c7f...`。
- 通用评估：`eval-report-2.json`（本地运行产物，未提交；摘要见本文件）。
- Oracle Control：`eval-hard-report.json`（baseline exit 1，knowledge exit 0）。
- 真实 Harvest：`harvest_53ef6399aa3d4b1582c0d201`。
- 真实 Reuse：`real-reuse-b.json`。
- 真实 acceptance level 2：`knowledge-acceptance-l2b/acceptance.json`。
