# Owner Sidecar API（v1.1 / PoC）

`ownerctl serve` 启动一个**只监听 127.0.0.1** 的 HTTP 适配层，供 OpenClaw Feature Plugin 与
Control UI 使用。它不新增业务规则：所有状态迁移仍由 `OwnerStore` 与 v1.0 服务层决定。

```bash
node bin/ownerctl.mjs serve --port 47830
# 读取令牌：<db 目录>/sidecar.token   （插件后端使用）
# 审批令牌：<db 目录>/approval.token  （只给操作员，插件后端不读取）
```

## 1. 两枚令牌（授权隔离）

| 令牌 | 文件 | 持有者 | 能力 |
| --- | --- | --- | --- |
| 读取令牌 | `sidecar.token` | 插件后端（OpenClaw 进程） | GET、提交 Job、创建沙箱运行 |
| 审批令牌 | `approval.token` | **操作员**（浏览器 sessionStorage） | approve / apply / reject |

规则：

- 决策接口只认 `X-Owner-Approval-Token`，**读取令牌不能替代**；未配置审批令牌时返回 `503`。
- 审批令牌不进入插件进程、不写日志、不经过 Gateway RPC。浏览器直接从 Control UI 调用 sidecar。
- 即使模型通过其它工具读到 `sidecar.token`，也只能读取与提交，无法完成审批。

> 这是对 PR #17 第一轮 Review 阻断 1 的修复：审批能力不再由与模型共享主体的 bearer 授权。

## 2. 网络与 CORS

| 项 | 规则 |
| --- | --- |
| 绑定地址 | 只能是 `127.0.0.1` |
| Host | 必须是 `127.0.0.1` / `localhost` / `[::1]`，且端口匹配 |
| 浏览器 Origin | 只允许 `http://127.0.0.1:*` / `http://localhost:*` / `http://[::1]:*` |
| CORS | 允许 `authorization`、`content-type`、`x-owner-origin`、`x-owner-approval-token` |
| Body | JSON，≤ 256 KiB |

浏览器直连要求 Control UI 与 sidecar 同为 loopback HTTP。若 Gateway 使用 HTTPS，需要给 sidecar
加 TLS 或同源反向代理（当前 PoC 未实现）。

## 3. 审计模型

- 审批决策写入 `owner_decision_audit`，与业务状态变更**在同一个 `BEGIN IMMEDIATE` 事务内**；
  审计写入失败会让整个决策回滚（fail closed）。
- `principal_kind` / `principal_id`：授权主体（`approval-token` / `local-cli`）。
- `claimed_origin` / `origin_trust`：调用方自报的 gateway/session/run/operator，标记为 `claimed`，
  只作线索，不当作已认证身份。
- `GET /owner/v1/decisions?subjectType=&subjectId=` 可读取审计记录。

`X-Owner-Origin` 对所有写操作必填；缺失返回 `400`。

## 4. 端点

### 只读（读取令牌）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/owner/v1/health` | 存活、版本、`approvalMode` |
| GET | `/owner/v1/summary` | Owner 汇总计数 |
| GET | `/owner/v1/projects` | 项目列表 |
| GET | `/owner/v1/tasks?projectId=` | 任务列表 |
| GET | `/owner/v1/events?projectId=&limit=` | 事件 |
| GET | `/owner/v1/decisions?subjectType=&subjectId=&limit=` | 决策审计 |
| GET | `/owner/v1/workspaces?projectId=&status=&limit=` | Worktree 记录 |
| GET | `/owner/v1/jobs?projectId=&status=&limit=` | Job 列表 |
| GET | `/owner/v1/jobs/:id` | Job 详情 |
| GET | `/owner/v1/patches?projectId=&status=&limit=` | 补丁提案列表 |
| GET | `/owner/v1/patches/:id[?content=1]` | 提案详情（含 `proposal_diff`） |
| GET | `/owner/v1/repair-cycles?projectId=&status=&limit=` | 修复周期列表 |
| GET | `/owner/v1/repair-cycles/:id` | 修复周期详情 |
| GET | `/owner/v1/sandbox-runs?projectId=&status=&limit=` | 沙箱运行列表 |
| GET | `/owner/v1/sandbox-runs/:id[?logs=1]` | 沙箱运行详情 |

### 提交（读取令牌）

| 方法 | 路径 | Body |
| --- | --- | --- |
| POST | `/owner/v1/jobs` | `{projectId, jobType, title, payload, idempotencyKey, ownerTaskId}` |
| POST | `/owner/v1/sandbox-runs` | `{proposalId, profile?, includePaths?, imageDigest?, repairCycleId?}` |

### 决策（审批令牌）

| 方法 | 路径 | Body | 说明 |
| --- | --- | --- | --- |
| POST | `/owner/v1/jobs/:id/approve` | — | 批准 Job |
| POST | `/owner/v1/jobs/:id/reject` | `{reason}` | 拒绝 Job |
| POST | `/owner/v1/patches/:id/approve` | `{hash}` | **只批准，不写文件** |
| POST | `/owner/v1/patches/:id/apply` | `{hash}` | 应用已批准提案（同一 hash） |
| POST | `/owner/v1/patches/:id/reject` | `{reason}` | 拒绝提案 |
| POST | `/owner/v1/repair-cycles/:id/approve` | `{hash}` | 批准修复周期 |
| POST | `/owner/v1/sandbox-runs/:id/approve` | `{hash}` | 批准沙箱运行 |

`approve` 与 `apply` 分开：第一次点击只冻结批准，操作员看完 Diff 后再次明确点击才写文件。

## 5. 状态码

| 码 | 含义 |
| --- | --- |
| 200 / 201 | 成功（幂等重放为 200） |
| 400 | 参数/JSON/哈希格式错误，缺少 `X-Owner-Origin` |
| 401 | 读取接口缺少或错误的读取令牌 |
| 403 | 非 loopback Host/Origin；决策缺少或错误的审批令牌 |
| 404 | 未知对象或路由 |
| 405 | 方法不允许 |
| 409 | 状态冲突（哈希不匹配、状态不允许、快照漂移） |
| 413 / 415 | Body 过大 / Content-Type 不是 JSON |
| 503 | 决策接口未配置审批令牌 |

## 6. 已知限制（PoC）

- 单进程、单写者；与 `ownerctl` 其它命令并发时依靠 SQLite `BEGIN IMMEDIATE` 串行化。
- `apply` 涉及文件系统写入，无法与审计行做成同一数据库事务；批准决策本身是原子的。
- 浏览器直连依赖 loopback HTTP；HTTPS Gateway 需要额外方案。
- 没有 WebSocket/SSE；页面靠手动 Refresh。
- 审批令牌是持有者凭据，不是人员身份证明；多用户场景需要再叠一层身份。
