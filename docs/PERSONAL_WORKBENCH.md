# Personal Knowledge Workbench (v0.4)

## 目的

让个人与 Agent 使用**同一份分层领域知识资产**，同时保留“已发布领域包不可变”和“个人知识可以逐次修订”两种不同生命周期。它首先是**个人知识工作台原型**，不是多用户云服务或自动知识真实性验证系统。

## 项目知识维护的日常路径（2026-11-09）

Workbench 近期首先服务于 **Owner 对各个项目领域知识的整理、验证、修订和持续维护**，而不是自动同步“最新外部事实”。每个项目优先梳理领域、目标、依赖环境、约束、已有证据和未知项，再围绕项目经验建立 L3 知识。

推荐路径：**选择项目 → 收集真实来源 → 提炼小粒度候选 → 审核/验证 → 记录修订 → 项目内复用 → 环境或证据变化后重新检查**。Agent 的候选不自动代表 Owner 已采纳；已有项目结论也不自动升级成跨项目事实。需要跨项目复用时再明确适用条件，并按 L2/L1 的证据门槛审查。

详细规范与验收目标见 [项目领域知识提取与维护指南](PROJECT_KNOWLEDGE_MAINTENANCE.md)。当前 `main` 提供手动 CRUD、审核、修订及上下文预览；自动经验采集、Harvest/Usage/Feedback 位于尚未合并的 [PR #23](https://github.com/GeTitDD/owner-agent-mvp/pull/23)。

## 本地启动

需要 Node.js >=22.13；本地 Web 界面不需要模型 API，也不需要启动 Pi：

```bash
npm run workbench
# 浏览器打开 http://127.0.0.1:4317
```

可以指定端口和数据库目录：

```bash
DOMAIN_CONTEXT_DB=/absolute/path/knowledge.sqlite DOMAIN_WORKBENCH_PORT=4321 npm run workbench
```

默认数据库是 `~/.domain-context/index.sqlite`。WorkBench **只监听本地回环地址**，无账号系统、无远端同步、无遥测；仍应认为所有能以当前用户身份访问本机的程序有读取本地文件和本地 HTTP 服务的能力。不要直接开放到局域网或公网。

## 日常使用路径

1. **知识目录**：搜索标题、正文、标签，按领域、L1/L2/L3、个人/领域/项目/不可变包过滤；查看来源和验证状态。
2. **手工积累**：新建领域，新建笔记/概念/知识主张/假设/实验/操作流程；为知识关联多个领域。项目级知识必须提供 `projectId` 且属于 L3。
3. **不可变包派生**：已发布包和示例文件**只读**。点“派生为个人知识”后创建新 ID、保存源引用，再进行编辑。不会覆写原版。
4. **修订历史**：每次保存都会创建修订；可以查看历史并恢复旧内容，恢复行为本身仍生成新修订。两名编辑者基于同一修订写入时，旧修订写入返回 HTTP 409 而不覆盖新版。
5. **可信性**：修改已验证的正文，会把当前知识改成 `needs_reverification` 并移除当前修订的旧证据引用；历史证据保留在历史修订中。手工填写证据引用不能证明事实正确。
6. **审核中心**：Agent 或用户可提交知识提案。审批之前，提案不影响知识库；待审批的修订提案绑定目标**提交时的版本**，目标已改变则审批失败。提案不能跨项目转移知识或将项目私有知识升级成共享范围。跨作用域迁移应由用户显式编辑并承担审查责任。
7. **项目组合**：选择内置示例项目，输入研究任务，预览共享领域快照哈希、独立项目哈希、已选择的知识以及稳定和动态上下文。该视图当前只支持仓库中配置的示例项目。
8. **导出**：点击“导出 JSON”保存个人/工作区领域/项目知识及修订、领域目录、提案。**当前尚未提供 JSON 导入/恢复界面**；底层 SQLite 数据库应另行备份，尤其注意 WAL 写入期间的一致性。

## 数据和作用域

- `personal`：个人知识，默认**不**进入任何项目 Context。
- `domain`：可以被项目**显式启用**的工作区领域知识。即使启用也只作为动态项目知识，不修改领域包稳定前缀。
- `project`：绑定准确的项目 ID，只能被同 ID 的项目载入；其他项目不能检索。
- `package` / `example-project`：由版本包和仓库示例读取的**只读**知识。

项目示例的 `domain-context.json` 可以显式启用编辑态工作区知识：

```json
{
  "workspace": {
    "enabled": true,
    "importDomainIds": ["pi-sdk", "context-engineering"],
    "includeProject": true
  }
}
```

`importDomainIds` 必须同时属于项目已经导入的领域；不能借此绕过包依赖。默认不开启工作区导入。已启动的会话继续使用固定 `projectSnapshotId`；知识更新后必须启动新会话或显式管理知识快照升级。

## API（本机原型）

- `GET /api/health`, `/api/stats`, `/api/domains`, `/api/projects`
- `GET /api/knowledge?q=&domain=&layer=&scope=&status=&projectId=`，`GET /api/knowledge/:id`
- `POST /api/knowledge`，`PATCH /api/knowledge/:id`（携带 `expectedRevision`）
- `GET /api/knowledge/:id/revisions`，`POST /api/knowledge/:id/revert`，`POST /api/knowledge/:id/fork`
- `GET /api/proposals`，`POST /api/proposals`，`POST /api/proposals/:id/review`
- `POST /api/context-preview`（仅内置示例项目）

所有修改请求使用 `Content-Type: application/json` 与 `X-Workbench-Request: 1`，同源 Origin 检查和环回 Host 检查。**这些是本地原型的浏览器请求约束，不是身份鉴权或多租户安全边界。**

## 版本与可靠性约束

- 已发布领域包始终不可变；所有编辑都写入 `personal_units` 与 `personal_revisions`。
- 对现有知识的提案在提交时固定 `target_revision`。旧版数据库自动添加该列；若旧提案的基准修订未知，审批会拒绝而不是推测其有效性。
- 同一 SQLite 数据库服务于 Workbench 和 Context Engine，避免使用自定义 DB 路径时 Web 预览与 Pi 上下文出现差异。
- 项目私有知识不得自动进入共享领域包；用户显式跨域发布仍须做许可、隐私和证据审核。
- 相同输入的编译具有可复现快照，但 Prompt 缓存命中不是该系统的保证。

## 当前未实现

没有账户登录、访问控制、多设备同步、云端团队共享、语义图可视化、历史导入恢复、批量操作、多项目通用管理界面、真实 Pi + 模型 API 端到端运行，以及事实真伪的自动裁定。中文搜索目前使用简单子串匹配；性能与扩展规模未经生产验证。

## 验证

```bash
npm run check
npm test
npm run demo:layered
```

单元和 API 测试覆盖不可变知识、修订并发保护、提案版本固定、项目隔离、旧数据库迁移，以及在自定义数据库路径下的 Context 预览一致性。
