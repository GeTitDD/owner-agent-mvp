# Knowledge Harvest Playbook（pstack 兼容）

本 playbook 是 Owner Knowledge Loop 的提炼工作流。它复用 pstack 的 EDAE、Reflect 与 decision-log 纪律，但不修改 pstack 的全局 Skill。

## pstack 接入边界

- 固定来源：`GeTitDD/pstack-pi@c0fad96`（npm `0.2.0`）。
- 实际使用：EDAE 六步、Reflect 三个视角作为只读 session 的 system prompt；加载 pstack `skills/` 目录；用同列 TSV 记录决策。
- 未执行：原生 `pstack_todo` 工具、`/reflect` 命令、Cursor `/loop`。Harvest session 是 `noTools` 只读会话。
- 因此文档与 UI 只称 **pstack-inspired 薄适配**，不说“pstack 已驱动自动学习”。

## 何时使用

- 一次 Sandbox / Job 结束后，需要判断是否值得留下长期经验。
- 失败修复、重复错误、跨项目复用后出现反例。
- 不用于自动发布知识；只生成 pending 候选。

## 六步（EDAE）

1. **确定边界**：项目、任务、Run、测试证据与适用环境。
2. **先评估**：确认是否存在 passed 测试或可定位失败证据；没有则只记录 unknown。
3. **调查设计**：读取 Experience、证据摘要、已有知识，识别重复/冲突。
4. **按验证单元实现**：生成结构化候选，不写代码、不改 Skill。
5. **验证行为**：标注 facts / inferences / unknowns、例外、反例与验证建议。
6. **交付与回流**：候选进入 `personal_proposals`，等待 Owner 审核；验证后再写 usage/feedback。

## 三个 Reflect 视角

- Judgment：主张是否被证据支持？是否只是模型自信？
- Tooling：机制是否可复现？证据是否来自真实运行？
- Divergent：什么反例会让它失效？适用条件是否需要收紧？

## 输出契约

```json
{"candidates":[{"title":"...","claim":"...","kind":"pattern|anti-pattern|invariant|experience|concept|procedure|hypothesis",
"proposedLayer":"project|applied|domain","applicability":["..."],"exceptions":["..."],
"confidence":0.0,"contradictions":["..."],"keywords":["..."],"evidenceRefs":["sandbox:..."],
"facts":["..."],"inferences":["..."],"unknowns":["..."],"validationSuggestions":["..."]}]}
```

- 最多 5 个候选。
- 每项必须有 `title` 和 `claim`；claim 不得省略，也不能只写在 title 里。
- claim 必须保留证据中的关键常量、默认值、文件名和测试断言，不用 N/某个值占位。
- 单项目证据只能 `project`；**两个独立项目各自有 passed/repaired 证据**才建议 `applied`；三个以上才建议 `domain`。A pass + B fail 不够。
- 任何自动候选都是 `unverified`。
- `evidenceRefs` 只能引用 Experience 中出现的 ref。
- 不保存原始 prompt、工具输出或密钥。

## 审核与验证

```bash
node bin/knowledgectl.mjs approve --knowledge-db <db> --proposal <id>
node bin/knowledgectl.mjs verify --knowledge-db <db> --knowledge-id <id> --evidence sandbox:<run>
```

approve 与 verify 分离；Owner 可在 Workbench 中拒绝、修订或查看版本。

## 回滚 / 禁用

- 不运行 `knowledgectl harvest` 即停止新候选生成。
- 不设置 `OWNER_KNOWLEDGE_USAGE=1` 即停止 Pi 编译期的 usage 记录。
- 所有 schema 变更都是新增表/列；旧库仍可打开，旧候选不受影响。
- 已发布/已验证知识通过现有 `revert`/修订机制恢复；不会自动删除 revision。
- 不自动修改 pstack `skills/**`；如需改变提炼纪律，在本文件与 `harvest.mjs` 中迭代并重新评审。
