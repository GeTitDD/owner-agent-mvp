# 设计参考：Knowledge Maintenance & Provenance v1

> 目标不是引入这些系统，而是借用它们的领域模型，补上 Owner 在“来源、版本、维护、同步”上的缺口。
> 结论先行：**只借鉴模型，不引入新依赖**；所有能力落在现有 SQLite + 现有知识存储之上。

| 参考 | 值得复用的机制 | 本项目如何借鉴 | 为什么不直接引入 |
| --- | --- | --- | --- |
| **DataHub** | URN 作为实体身份；Metadata Aspect 可版本化；Change Log 记录元数据变更 | `sourceId = hash(namespace, type, objectId)` 作为稳定来源身份；每次观察写一行不可变 observation；采纳/重验证也是追加记录 | DataHub 需要图存储、Kafka、GMS 服务；对单机 Owner 是数量级过重，且会把知识数据搬到第二个系统 |
| **OpenMetadata** | Entity Version、Change Description、History；版本之间可 diff | 复用现有 `personal_revisions`（每修订一行、带 payload_hash）；新增 `knowledge_adoptions` 明确“Owner 采纳了哪一版”，与 Head 分离 | OpenMetadata 的版本模型绑定其实体 schema 与 UI；我们已有自己的 revisions 表，重建会丢失既有数据 |
| **OpenLineage** | Namespace / Job / Run / Dataset + Facets；运行事件是追加式 | `SourceDescriptor` 区分 namespace、objectId、sourceVersion（Run ID / commit SHA）；Run 来源用 `owner://project/<id>/sandbox-run/<run>` 定位 | OpenLineage 是事件协议，需要 collector 与后端；Owner 的 Run 证据已经在 OwnerStore 里，导出成事件只会增加一层不一致 |
| **Dolt** | Commit / Branch / Diff / Merge；内容寻址 | 修订历史天然是线性 commit 链；同步用 payload_hash 做共同祖先判定，fast-forward vs diverged；分叉走三方字段合并 | Dolt 是完整数据库引擎；为知识表再嵌一个 SQL 引擎会破坏现有事务与迁移路径 |
| **Automerge** | Local-first、离线可用、并发修改自动合并、冲突可保留 | 导出包携带完整修订历史；导入按 hash 前缀判断关系；冲突**保留双方**并落 `knowledge_conflicts`，不静默覆盖 | 引入 CRDT 需要把所有知识改成 CRDT 文档，既有 JSON 列与 Workbench 编辑路径都要重写；v1 的“线性历史 + 三方合并”已能覆盖当前单用户多设备场景 |
| **W3C PROV** | Entity / Activity / Agent / Derivation；来源可递归追溯 | 知识修订 = Entity，采集/观察 = Activity，设备/Agent/Owner = Agent，`derived_from` 等关系落在 `knowledge_source_links`；`explain` 输出可读的 derivation 链 | 完整 PROV-O 是 RDF 本体，需要三元组存储与查询；这里只实现其最小关系集，用关系表表达 |

## 由此形成的取舍

1. **身份分层而不是统一 URN**：`knowledgeId`、`projectIdentity`、`sourceId`、`observationId` 各自独立，避免用路径或短字符串硬凑全局唯一。
2. **观察与身份分离**：同一个 `sourceId` 可以有多个 `observationId`；旧 `evidenceRefs` 只当作 Legacy Ref，绝不推断版本。
3. **采纳与 Head 分离**：Owner 采纳的修订不随编辑漂移；漂移在 `explain` 中显式报告。
4. **变更只排队，不自动改**：来源更新只生成 `pending` 重验证项，只有 Owner 接受才产生 `needs_reverification` 修订。
5. **同步不静默覆盖**：hash 校验 → fast-forward → 三方合并 → 冲突保留，四段式；任何一步失败都拒绝写入该单元。
6. **不新增运行时依赖**：SQLite、`node:crypto`、`git`、`gh` 均为已有能力；没有消息队列、没有独立服务、没有第二套存储。

## 明确没有采用的部分

- 没有实现 DataHub 的 Aspect 模型（多租户、schema registry）。
- 没有实现 OpenMetadata 的完整实体版本 UI 与工作流。
- 没有实现 OpenLineage 的事件发送与 collector。
- 没有实现 Dolt 的分支/合并策略（branch 语义对单用户 Owner 暂无收益）。
- 没有实现 Automerge 的自动合并算法与二进制文档格式。
- 没有实现完整 PROV-O 导出（只保留可追溯的最小关系集）。
