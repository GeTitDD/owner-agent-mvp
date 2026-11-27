# 经验沉淀与复用的领域模型核对

日期：2026-11-27。范围：已经修复的经验链及其术语、证据和计量边界。
本轮只修改文档，没有修改业务代码、用户数据、同步策略或权限，也没有提交或推送。

> 后续修复见 [证据与计量交付](2026-11-27-evidence-repair-delivery.md)。本页保留修复前的发现和实验结果；下方内存命令在修复后应不再得到灵感已复现的误标，不能把历史结果当作当前行为。

## 结论

经验链的基本单位仍是「现象 → 机制 → 对策」，不需要新增任务系统、收件箱或存储层。
需要分清四个独立判断：人是否接受内容、结论有什么证据、默认共享给谁、某次任务是否因此受益。
把这四件事合成一个「已沉淀 / 已复用」状态，会让应用对经验质量给出过强承诺。

根目录 [术语表](../../GLOSSARY.md) 已对齐以下含义：

- 灵感可以人工整理成经验，但保留灵感来源；确认过的推断仍然是推断。
- 知识可以项目专用或领域共享；共享范围与适用条件分别判断。
- 候选可以已保存，等待的是内容确认；保存不等于接受，接受不等于验证或项目写入授权。
- 经验召回、本轮引用、复用记录和复用收益分别表达查到、提供依据、关联目标任务及有证据的影响。
- 跨项目复现需要独立事实证据，不因复制想法、改变共享范围或接受候选而成立。

术语表同时移除了路径、数据库、序列化格式、命令和界面布局等实现细节，保留领域含义。
原来泛称的「归档」限定为「会话归档」，避免把会话退出列表与记忆同步归档混为一谈。

## 关系与确认边界

```text
本应用终态执行记录 ──提炼并保留证据──▶ 经验
人工灵感 ──整理预览──▶ 第一次内容确认 ──▶ 经验（仍为推断）
经验 ──整理规则与适用条件──▶ 候选 ──第二次内容确认──▶ 知识
人工记录 / 外部会话中的选择理由 ──内容确认──▶ 决策类知识

项目专用 / 领域共享 ＝ 默认归属与可见范围
待验证 / 推断 / 已验证 / 有争议等 ＝ 相应条目的证据判断
生效中 / 已被取代 / 已放弃 ＝ 决策的有效性
```

执行记录提炼入口与人工灵感整理入口不是同一种原料；Git 提交、聊天文字不会自动成为本应用的执行记录。
以上状态名称用于解释不同维度，不能当作所有条目共用的一套枚举。
候选准备不增加第三次实质确认，内容确认也不附带项目写入或对外发送权限。

对应代码：[整理与确认](../../src/knowledge/experience-review.mjs)、
[灵感来源](../../src/idea-lesson.mjs)、[候选提升](../../src/knowledge-loop/promotion.mjs)；
对应约定：[DIRECTION](../DIRECTION.md)、[ADR-0012](../adr/0012-write-by-destination.md)。

## 实现缺口与历史冲突

| 问题 | 当前证据 | 影响与后续边界 |
| --- | --- | --- |
| 「已复现」把跨项目出现当成独立复现 | `personal-store.mjs` 的 `syncLessonReproduction` 按现象聚合项目，项目数达到 2 就打标；未区分灵感与独立事实证据 | 已用内存实验复现误标；下一批应先修判定与历史误标处理，再做界面验收。不能靠改术语把误标解释成正确行为。 |
| 桌面引用与复用计量未闭环 | `recall.mjs` 返回引用，`pi-chat.mjs` 将资料放进提示；两者不创建 Usage。`desktop/main.cjs` 的复用统计读取现有 Usage | 当前可证明本轮提供了资料，不能把聊天引用次数当作已记录复用次数，更不能称有效复用。是否把聊天引用也计量，需要先明确目标任务如何标识。 |
| Usage 不等于模型采纳 | `knowledge-loop/reuse.mjs` 的 `compileAsync` / `recordFromPlan` 在知识进入任务上下文时记 Usage，收益初始为未知 | 该记录证明提供依据，没有采纳证据；模型回答中出现引用标识，也不能单独证明对结果有帮助。 |
| 存储权威与 ADR-0002 冲突 | ADR-0002 将人工记忆内容归属 Markdown；`memory/sync-documents.mjs` 明确将 SQLite 当前记忆作为本机事实来源、Markdown 作为传输投影 | **尚未解决的架构决定冲突。** 本轮将 Memory 改为与表示方式无关的领域定义，未宣告任何新存储权威；后续须按贡献指南先在 issue 中讨论并补齐决策记录。 |
| ADR-0007 的旧限制与后续方向冲突 | 最初写「经验来自执行记录、知识只在域级」，后续方向与已完成链路支持人工灵感及项目专用知识 | 已在 ADR-0007 追加带日期的澄清，保留历史正文；没有新建一份假装刚作出的架构决策。 |

代码位置：[复现聚合](../../src/personal-store.mjs#L1081)、
[显式升域](../../src/personal-store.mjs#L1138)、
[召回](../../src/knowledge/recall.mjs)、[提示组装](../../src/pi-chat.mjs#L190)、
[任务复用记录](../../src/knowledge-loop/reuse.mjs)、
[收益反馈](../../src/knowledge-loop/feedback.mjs#L150)、
[本机记忆与同步投影](../../src/memory/sync-documents.mjs#L1)。

## 具体反例

| 场景 | 应得结论 | 不能推出 |
| --- | --- | --- |
| 人把「同进程状态写回排队」补成完整经验并接受 | 保存结构化经验，来源仍是原灵感，状态仍为推断 | 已验证其机制或有效性 |
| 同一想法复制到两个项目并分别整理 | 两个项目都有相关来源，需要核对来源是否独立 | 有两次独立复现 |
| 两个项目都出现旧状态覆盖，但采用了不同对策 | 现象可能复现，对策仍需分别核验 | 任一对策都已获跨项目验证 |
| A 的项目专用知识由 B 显式关联读取 | B 本轮可只读参考，保留 A 的归属与修订 | 自动升为领域共享或复制进 B |
| 召回命中，但全文超出本轮引用容量而未注入 | 找到相关条目，明确说明未提供全文 | 本轮已向模型提供完整规则 |
| 知识进入任务上下文，模型未采用 | 有提供依据的记录，是否采纳未知 | 已成功复用 |
| 使用知识的任务成功，但没有收益证据 | 任务成功，复用收益仍未知 | 因为这条知识而成功 |
| 历史会话引用 r2，当前知识已经修订或存在争议 | 历史保留原引用，本轮按当前修订、状态重新召回 | 沿用旧会话就能证明 r2 仍适用 |

真实项目中的关键边界仍是：**同进程短写操作排队，不等于跨进程互斥或 CAS**。
即使该经验被接受、共享、引用多次，也不能据此删去这条适用边界。

## 内存实验

使用 Node 22、`PersonalKnowledgeStore(':memory:')` 和真实
`promoteIdeaToLesson(..., edits)`，分别为 `project-a`、`project-b` 提供不同灵感 ID，
灵感原文、现象、机制和对策相同；没有执行任务，也没有加入执行证据。
关键步骤可用下面的临时命令重放；只使用内存库，结束时关闭：

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH node --input-type=module <<'JS'
import { PersonalKnowledgeStore } from './src/personal-store.mjs';
import { promoteIdeaToLesson } from './src/idea-lesson.mjs';
const db = new PersonalKnowledgeStore(':memory:');
const text = '并行任务的状态持久化可能互相覆盖';
const ideas = ['a', 'b'].map(id => ({ id: `idea-${id}`, rawText: text, title: '状态覆盖' }));
const owner = { getIdeaItem: id => ideas.find(x => x.id === id), getProject: id => ({ id }) };
try {
  for (const id of ['a', 'b']) {
    const result = promoteIdeaToLesson({ store: owner, personalStore: db,
      id: `idea-${id}`, projectId: `project-${id}`, edits: { phenomenon: text,
        mechanism: '多个任务各自读取旧状态再保存', countermeasure: '同进程短写操作排队' } });
    if (!result.ok) throw new Error(result.reason);
  }
  console.log(db.listLessons().map(x => ({ project: x.projectId,
    reproduced: x.reproduced, supportProjects: x.supportProjects,
    status: x.verificationStatus, scope: x.scope.layer,
    evidenceKinds: db.lessonEvidence(x.id).map(e => e.kind) })));
} finally { db.close(); }
JS
```

本轮实际结果：

| 项目 | 证据类型 | 验证状态 | 范围 | 支持项目数 | 已复现 |
| --- | --- | --- | --- | --- | --- |
| project-a | idea | inferred | project | 2 | true |
| project-b | idea | inferred | project | 2 | true |

说明复现标记确实过强，同时也验证跨项目出现不会自动升域或变为已验证。
本实验没有写入真实应用库、没有修改被观察项目、没有调用模型。

## 后续开发顺序与验收目标

1. **先修信任问题**：独立证据不足时不显示「已复现」；覆盖复制灵感、独立事实、不同对策与历史误标，并在真实界面检查徽章与证据解释。
2. **再补计量闭环**：先定义聊天引用与目标任务的关联，再确定计数名称；验证召回未注入、已注入未采纳、任务成功收益未知三种情况不能混计。
3. **补齐存储决策**：在 issue 中对齐 ADR-0002 与当前本机记忆、同步投影的关系，再决定是否修订 ADR；不借本次术语整理改变同步冲突政策。

本轮为文档建模核对，验收为文档回读、内部链接与格式检查，加上述真实存储模块的内存反例；
没有 UI 行为变更，故未制造无关截图，也未重跑上轮全量或视觉测试。
之前的 [经验链交付](2026-11-27-experience-repair-delivery.md) 仍只证明所列请求引用与界面旅程，
不扩张为真实模型采纳或收益质量已通过。
