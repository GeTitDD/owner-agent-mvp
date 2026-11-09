# Knowledge Sync Protocol v2（离线优先）

> 范围：Owner 已采纳的领域知识与项目上下文，不镜像外部世界的最新事实。
> 基线：PersonalKnowledgeStore / Knowledge Loop / Workbench / Context Compiler / SQLite。
> 传输层不在本协议内；v2 只定义可校验的 JSON/JSONL Bundle。

## 1. 身份分层

| 字段 | 含义 | 稳定性 |
| --- | --- | --- |
| `knowledgeId` | 知识逻辑身份 | 首次记录分配，随同步原样保留；跨设备稳定 |
| `revisionId` | 不可变修订身份 | 由内容 + 父修订 + 原因 + 主体计算；跨设备稳定 |
| `revision` | 本地单调修订号 | 仅本设备排序，**不是**全局顺序 |
| `schemaVersion` | 数据契约版本 | 每条记录/事件/Bundle 显式标注 |
| `sourceId` | 来源实体身份 | 由 `(namespace, sourceType, objectId)` 复算 |
| `observationId` | 一次来源观察 | 绑定 `sourceVersion + contentHash + captureRunId` |
| `projectIdentity` | 项目身份 | git remote → 首个 commit → local-root（逐级降级） |

`revisionId` 的计算：

```
rev_ = sha256(canonical({
  knowledgeId,
  contentHash,
  parentRevisionIds: sorted(unique(parents)),
  reason,
  actorId
}))[0..32]
```

同一知识、同一父修订、同一内容/原因/主体 → 同一 `revisionId`，因此重复导入天然去重；内容不同则天然分叉。

## 2. 来源与观察

```json
{
  "schemaVersion": 1,
  "sourceId": "src_...",
  "sourceSystem": "local-file | github | git | pi | owner | manual | unknown",
  "sourceType": "file | document | git | github | session | run | experiment | manual",
  "sourceLocator": "docs/retry.md / owner/repo@sha / run:...",
  "sourceVersion": "commit SHA / 文档版本 / 消息 ID / v1",
  "sourceContentHash": "sha256(内容) 或空",
  "observedAt": "2026-11-09T...",
  "recordedAt": "2026-11-09T...",
  "actorId": "owner | agent | ...",
  "sessionId": "可选",
  "runId": "可选",
  "deviceId": "dev_...",
  "availability": "available | unavailable | unknown"
}
```

- 未知字段一律为空字符串或 `unknown`；**不得补造** commit、版本或哈希。
- 旧 `evidenceRefs` 作为 Legacy Source Ref 保留，只解析前缀，不推断版本。
- 来源新版本或不可访问只写 `knowledge_revalidations(pending)`，不静默修改知识。

## 3. 不可变修订

`knowledge_revision_index` 为每条修订保存：

- `revision_id`、`knowledge_id`、`local_revision`（远端祖先为 `NULL`）
- `parent_revision_ids`（合并修订可有两个父）
- `reason`、`actor_id`、`device_id`、`recorded_at`
- `content_hash`、`verification_status`、`status`（active/candidate）
- 完整 `payload` 与 `payload_hash`

规则：

1. 每个 `PersonalKnowledgeStore.create/update/revert` 都会经 `onRevision` 钩子写入索引。
2. 正文变化不继承旧的 `verificationStatus`；重验证由 Owner 显式接受。
3. 不允许直接改数据库当前行绕过历史；旧库首次打开时自动补齐索引，缺失来源保持 `unknown`。
4. `knowledge_adoptions` 记录 Owner 采纳的修订，与 Head 分离；编辑后 `explain` 报告 drift。

## 4. 变更事件

`knowledge_changes` 是跨设备可交换的操作日志：

| 字段 | 说明 |
| --- | --- |
| `changeId` | 操作身份，幂等键 |
| `knowledgeId` | 目标知识身份 |
| `operation` | create / revise / adopt / link-source / observe-source / resolve-revalidation / conflict / resolve-conflict |
| `baseRevisionId` / `resultRevisionId` | 因果边 |
| `actorId` / `originSystem` / `originDevice` | 操作主体与来源 |
| `occurredAt` / `appliedAt` | 事实发生时间 / 本地写入时间 |
| `payloadHash` + `payload` | canonical payload 与 sha256 |

- 同一 `changeId` 重复导入：相同 hash → 幂等跳过；不同 hash → 拒绝（篡改）。
- 事件可以乱序到达；导入顺序不影响最终投影。

## 5. Bundle 格式

```json
{
  "contract": "knowledge-sync/v2",
  "schemaVersion": 2,
  "exportedAt": "2026-11-09T...",
  "device": "dev_a...",
  "cursor": { "since": "", "exportedAt": "...", "lastChangeAppliedAt": "..." },
  "project": { "projectId": "demo", "projectIdentity": "prj_...", "identityKind": "git-remote" },
  "units": [
    {
      "id": "personal.xxx",
      "knowledgeId": "personal.xxx",
      "revision": 2,
      "revisions": [
        {
          "revision": 1,
          "revisionId": "rev_...",
          "parentRevisionIds": [],
          "payload": { "...": "完整知识正文" },
          "payloadHash": "sha256",
          "actor": "owner",
          "note": "Created",
          "timestamp": "..."
        }
      ]
    }
  ],
  "events": [],
  "candidates": [],
  "sources": [],
  "observations": [],
  "links": [],
  "adoptions": [],
  "contextSnapshots": []
}
```

- **完整快照**：`units` 为全部（或指定项目）知识及完整修订历史。
- **增量变化**：`export --since <cursor>`，只包含游标后变更过的知识单元与事件；每条修订仍带完整内容，避免“只有 diff 无法重建”。
- **JSONL**：每行一个单元/事件对象，适合流式传输；导入端按 `id`/`changeId` 去重，分片失败可重试。
- **游标**：`cursor.lastChangeAppliedAt` 写入 `knowledge_sync_state('last-import')`，中断后从游标继续。

## 6. 导入算法

1. 校验 `contract` / `schemaVersion`（兼容 v1）。
2. 校验每个修订：`payloadHash === sha256(canonical(payload))`；v2 额外校验 `revisionId` 复算一致。
3. 校验事件：`payloadHash` 一致；`changeId` 重复且 hash 不同 → 拒绝。
4. 作用域：若传入 `allowedProjectIds`，项目不匹配的单元、来源与观察整条拒绝（`scope-not-allowed`）。个人/非项目知识不因同步获得项目授权。
5. 单元合并（图感知）：
   - 所有远端 `revisionId` 本地已知 → `unchanged`；
   - 本地 Head 是远端 Head 的祖先 → `fast-forward`（保留 `parentRevisionIds`，按本地顺序追加）；
   - 远端 Head 是本地 Head 的祖先 → `local-ahead`；
   - 存在共同祖先且双方各有新修订 → `diverged`；
   - 无共同祖先 → `unrelated`。
6. `diverged` 且字段级三方合并没有冲突 → 生成一条**元数据合并修订**（双亲），旧行为兼容。
7. 有冲突（正文、验证状态、采纳状态或同一字段双边修改）→
   - 远端 Head 写入 `knowledge_candidates`（完整 payload + 来源包）；
   - 远端分支的全部未知修订以 `local_revision=NULL`、`status=candidate` 进入不可变索引；
   - 每个冲突字段写入 `knowledge_conflicts`；
   - **本地 Head 不动**，Owner 采纳状态不动。
8. 导入来源/观察/链接/采纳/上下文快照；已存在的采纳不被覆盖。
9. 写回游标；重复导入返回 `unchanged`，不产生新修订。

## 7. 冲突解决（R4）

`resolveConflict({ id, decision })`：

- `accept-local`：保留本地 Head，候选标记 rejected；
- `accept-incoming`：用候选修订生成新修订（父 = 本地 Head + 候选）；
- `merge`：用 Owner 提供的合并内容生成新修订（父 = 本地 Head + 候选）；
- `dismiss`：只关闭提示。

新修订保留候选来源链接；Owner 仍需显式 `adopt`，冲突解决不等同于采纳。
解决后导出的是双亲修订；另一端按“父修订包含本地 Head”识别为后代并追加，从而收敛。

## 8. 恢复与回滚

- **恢复**：`knowledge-maint sync import --in <bundle> --dry-run` 先出计划；确认后去掉 `--dry-run`。
- **回滚某条知识**：`knowledge-maint revision list --knowledge <id>` 找到旧 `revisionId`，用现有 `store.revert(id, revision, expectedRevision)` 生成新修订（保留历史，不删除）。
- **回滚整库**：关闭服务，备份 SQLite，再用上一份 Bundle 导入空库；不要直接覆盖正在运行的数据库文件。
- **迁移**：旧库首次打开自动建表/补索引；迁移不会伪造来源，缺失字段保持 `unknown`。

## 9. 设计取舍（ADR）

1. **不引入分布式数据库 / 元数据平台**：SQLite + 不可变索引 + Bundle 已满足双设备离线场景；避免运维与一致性成本。
2. **逻辑身份不自动语义去重**：无自然键时，两台设备独立创建的知识不会自动合并；身份通过同步传播。语义去重留给后续 Eval/人工审核。
3. **本地 revision 与全局 revisionId 分离**：本地单调号便于 UI 与既有 API；跨设备只信 `revisionId`/parents。
4. **冲突不自动 last-write-wins**：正文/验证/采纳冲突必须进入审查队列；只有非冲突元数据允许显式规则合并。
5. **传输层后置**：先验证离线 Bundle；后续可加认证、可恢复的传输适配器，未认证不得开放公网写入。
