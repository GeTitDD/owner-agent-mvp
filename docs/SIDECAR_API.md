# Owner Sidecar API（v1.1 / PoC）

`ownerctl serve` 启动一个**只监听 127.0.0.1** 的 HTTP 适配层，供 OpenClaw Feature Plugin 调用。
它不新增业务规则：所有状态迁移仍由 `OwnerStore` 与 v1.0 服务层决定。

```bash
# 启动（token 缺省时写入 <db 目录>/sidecar.token，权限 0600）
node bin/ownerctl.mjs serve --port 47830

# 或显式指定
OWNER_AGENT_SIDECAR_TOKEN=... node bin/ownerctl.mjs serve --port 47830
```

## 1. 安全模型

| 项 | 规则 |
| --- | --- |
| 绑定地址 | 只能是 `127.0.0.1`，传入其他地址直接报错 |
| 鉴权 | 所有请求必须带 `Authorization: Bearer <token>` |
| Host | 必须是 `127.0.0.1` / `localhost` / `[::1]`，且端口匹配 |
| Origin | 浏览器请求必须同源；插件后端不带 Origin |
| Body | JSON，≤ 256 KiB |
| 审批 | 必须携带 Owner 冻结的 64-hex 哈希；不接受"无哈希批准" |
| 审计 | 写操作成功后在 Owner 事件流追加 `kind: api_call`，含 `origin` |

`origin` 通过请求头传入（可选）：

```json
X-Owner-Origin: {"gatewayInstanceId":"gw-1","sessionKey":"agent:main:owner","runId":"run-1","operatorId":"owner","pluginVersion":"0.1.0"}
```

允许的键只有 `gatewayInstanceId`、`sessionKey`、`runId`、`operatorId`、`pluginVersion`；总长度 ≤ 1 KiB。
写入时会同时把 `actor` 记为 `openclaw:<operatorId>/<sessionKey>`（截断 80 字符）。

## 2. 端点

### 只读

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/owner/v1/health` | 存活、版本、pid |
| GET | `/owner/v1/summary` | Owner 汇总计数 |
| GET | `/owner/v1/projects` | 项目列表 |
| GET | `/owner/v1/tasks?projectId=` | 任务列表 |
| GET | `/owner/v1/events?projectId=&limit=` | 事件（含 `api_call` 审计） |
| GET | `/owner/v1/workspaces?projectId=&status=&limit=` | Worktree 记录 |
| GET | `/owner/v1/jobs?projectId=&status=&limit=` | Job 列表 |
| GET | `/owner/v1/jobs/:id` | Job 详情（含 attempts / events） |
| GET | `/owner/v1/patches?projectId=&status=&limit=` | 补丁提案列表 |
| GET | `/owner/v1/patches/:id[?content=1]` | 提案详情（默认不含完整内容） |
| GET | `/owner/v1/repair-cycles?projectId=&status=&limit=` | 修复周期列表 |
| GET | `/owner/v1/repair-cycles/:id` | 修复周期详情 |
| GET | `/owner/v1/sandbox-runs?projectId=&status=&limit=` | 沙箱运行列表 |
| GET | `/owner/v1/sandbox-runs/:id[?logs=1]` | 沙箱运行详情（可选 stdout/stderr） |

### 写入

| 方法 | 路径 | Body | 说明 |
| --- | --- | --- | --- |
| POST | `/owner/v1/jobs` | `{projectId, jobType, title, payload, idempotencyKey, ownerTaskId}` | 创建 Job（进入 `pending_approval`） |
| POST | `/owner/v1/jobs/:id/approve` | — | Owner 批准 Job |
| POST | `/owner/v1/jobs/:id/reject` | `{reason}` | 拒绝 Job |
| POST | `/owner/v1/patches/:id/approve` | `{hash}` | 批准并应用补丁（幂等） |
| POST | `/owner/v1/patches/:id/reject` | `{reason}` | 拒绝提案 |
| POST | `/owner/v1/repair-cycles/:id/approve` | `{hash}` | 批准修复周期（创建 repair Job） |
| POST | `/owner/v1/sandbox-runs` | `{proposalId, profile?, includePaths?, imageDigest?, repairCycleId?}` | 生成快照并创建待审批运行 |
| POST | `/owner/v1/sandbox-runs/:id/approve` | `{hash}` | 复核快照并按哈希批准运行 |

## 3. 示例

```bash
TOKEN=$(cat ~/.domain-context/sidecar.token)

curl -s -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:47830/owner/v1/summary

curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'X-Owner-Origin: {"gatewayInstanceId":"gw-1","sessionKey":"agent:main:owner","runId":"run-1","operatorId":"owner"}' \
  -d '{"projectId":"demo","jobType":"status-note","title":"From OpenClaw","payload":{"note":"hi"},"idempotencyKey":"oc-1","ownerTaskId":"<task-id>"}' \
  http://127.0.0.1:47830/owner/v1/jobs
```

## 4. 状态码

| 码 | 含义 |
| --- | --- |
| 200 / 201 | 成功（创建为 201；幂等重放为 200 + `duplicate: true`） |
| 400 | 参数/JSON/哈希格式错误，或 Origin 字段非法 |
| 401 | 缺少或错误的 bearer token |
| 403 | 非 loopback Host，或跨站 Origin |
| 404 | 未知对象或路由 |
| 405 | 方法不允许 |
| 409 | 状态冲突（哈希不匹配、状态不允许、快照漂移） |
| 413 / 415 | Body 过大 / Content-Type 不是 JSON |
| 500 | 未预期的内部错误 |

## 5. 已知限制（PoC）

- 单进程、单写者：与 `ownerctl` 其他命令同时运行时依靠 SQLite `BEGIN IMMEDIATE` 串行化。
- 不做分页游标，只有 `limit`。
- 没有 WebSocket/SSE；插件页面用轮询（PoC 足够）。
- 审计写失败只记录到 stderr，不阻断主操作（主操作本身已有 Job/Proposal 审计）。
- 尚未实现 sandbox 运行与 repair cycle 的完整状态订阅，见 P3。
