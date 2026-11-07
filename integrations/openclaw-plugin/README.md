# Owner Agent × OpenClaw plugin（PoC）

OpenClaw Feature Plugin：在**原版 Control UI** 里展示 Owner Agent 的 Job、补丁提案、沙箱运行与修复周期，并提供哈希绑定的审批入口。

Owner Agent 仍是唯一权威：插件不写数据库、不做状态迁移、不缓存业务数据。

## 前置

1. Owner sidecar 运行在 loopback：

   ```bash
   node bin/ownerctl.mjs serve --port 47830
   # token 默认写入 ~/.domain-context/sidecar.token
   ```

2. OpenClaw `2026.11.1`（宿主需要 Node `>=24.16`）。

## 构建与安装

```bash
cd integrations/openclaw-plugin
npm install
npm run build
openclaw plugins install .
openclaw plugins inspect owner-agent --runtime
```

配置通过**启动 Gateway 的环境变量**（Feature Plugin 的 `configSchema` 由宿主生成，PoC 不依赖它）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `OWNER_AGENT_SIDECAR_URL` | `http://127.0.0.1:47830` | sidecar 地址，必须是 loopback |
| `OWNER_AGENT_SIDECAR_TOKEN_FILE` | `~/.domain-context/sidecar.token` | token 文件 |
| `OWNER_AGENT_SIDECAR_TOKEN` | — | 直接给 token（优先级更高，不推荐） |
| `OWNER_AGENT_OPERATOR_ID` | `owner` | 写入 Owner 审计的操作员标识 |

```bash
export OWNER_AGENT_SIDECAR_URL=http://127.0.0.1:47830
openclaw gateway
```

启用插件：

```bash
openclaw plugins enable owner-agent
```

打开 Control UI → 侧边栏 **Owner**。

## 模型可见的工具

| 工具 | 作用 |
| --- | --- |
| `owner_status` | 读取 Owner 汇总计数 |
| `owner_jobs_list` | 列出 Job |
| `owner_job_submit` | 提交 Job（进入 `pending_approval`，不会自动执行） |

**没有审批工具**。`jobsApprove` / `patchApprove` / `repairApprove` / `sandboxSubmit` / `sandboxApprove`
只注册为 Control UI 操作（`kind: "action"` 且不带 `tool`），需要操作员的 `operator.write`。

## 审批语义

- 页面上的哈希来自 Owner 记录（`proposal_hash` / `approval_hash`），不是模型输入。
- 审批调用原样转发到 sidecar，由 Owner 校验哈希、状态与幂等性。
- 失败不会改变 Owner 状态；错误直接显示在页面上。

## 范围外（PoC）

- 不做事件订阅/推送，页面靠手动 Refresh。
- 不做 job 创建表单（提交走聊天工具）。
- 不做品牌替换，只在 Control UI 内增加一个页面。
- 不做多 Gateway、多用户或远程访问。
