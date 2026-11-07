# Owner Agent × OpenClaw plugin（PoC）

OpenClaw Feature Plugin：在**原版 Control UI** 里展示 Owner Agent 的 Job、补丁提案、沙箱运行与修复周期，并由**操作员浏览器**携带独立审批令牌完成哈希绑定的审批。

Owner Agent 仍是唯一权威：插件不写数据库、不做状态迁移、不缓存业务数据，也不持有审批令牌。

## 前置

1. Owner sidecar 运行在 loopback：

   ```bash
   node bin/ownerctl.mjs serve --port 47830
   # 读取令牌：<db 目录>/sidecar.token（插件后端使用）
   # 审批令牌：<db 目录>/approval.token（只给操作员）
   ```

2. OpenClaw `2026.11.1`（宿主需要 Node `>=24.16`）。

## 构建与安装

```bash
cd integrations/openclaw-plugin
npm ci
npm run build
openclaw plugins install . --force --accept-capabilities
openclaw plugins inspect owner-agent --runtime
```

配置（启动 Gateway 的环境变量；Feature Plugin 的 `configSchema` 由宿主生成）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `OWNER_AGENT_SIDECAR_URL` | `http://127.0.0.1:47830` | sidecar 地址，必须是 loopback |
| `OWNER_AGENT_SIDECAR_TOKEN_FILE` | `~/.domain-context/sidecar.token` | 读取令牌文件 |
| `OWNER_AGENT_OPERATOR_ID` | `owner` | 审计里的操作员标识 |

```bash
export OWNER_AGENT_SIDECAR_URL=http://127.0.0.1:47830
openclaw plugins enable owner-agent
openclaw gateway
```

用户安装插件的原生 UI 还需要在 profile 配置里显式打开（OpenClaw `2026.11.1` 的
`isControlUiPluginAllowed` 只对 bundled 插件默认放行）：

```json5
{
  gateway: {
    controlUi: {
      experimental: { customPlugins: true }
    }
  }
}
```

设置后重启 Gateway；否则插件已加载，但不会出现在 Control UI 的「页面」菜单里。

## 使用

1. 打开 Control UI → 侧边栏 **Owner**。
2. 在页面顶部粘贴 `approval.token` 的内容，点 **Save**（只存当前标签的 `sessionStorage`）。
3. 点任意 **Review**：
   - 补丁：展示完整 ID、base、proposal/approval hash、路径与**冻结 Diff**；
   - 沙箱：展示 profile、image digest、profile/testPlan/snapshot hash、includePaths；
   - 修复：展示 source run、source base、scope、context hash。
4. 勾选“已审阅”后才可确认。
5. 补丁是两步：**Approve patch (no apply)** → 再次 Review → **Apply approved patch**。

审批令牌不经过 Gateway：页面直接 `fetch` 到 sidecar。

## 模型可见的工具

| 工具 | 作用 |
| --- | --- |
| `owner_status` | 读取 Owner 汇总计数 |
| `owner_jobs_list` | 列出 Job |
| `owner_job_submit` | 提交 Job（进入 `pending_approval`，不会自动执行） |

没有审批工具。`approve` / `apply` 不在 feature contract 里，浏览器直接调用 sidecar 并要求审批令牌。

## 安全边界

- 决策接口只认 `X-Owner-Approval-Token`；读取令牌（插件后端持有）不能审批。
- 每次决策写入 `owner_decision_audit`，与状态变更在同一事务；审计失败即回滚。
- `X-Owner-Origin` 必填，但标记为 `claimed`，不当作已验证身份。
- 建议的 OpenClaw 工具策略（纵深防御）：

  ```json5
  {
    tools: {
      deny: ["exec", "process", "read", "write", "edit", "apply_patch", "browser"]
    }
  }
  ```

  这会阻止模型读取 `~/.domain-context` 下的文件。即使读到读取令牌，也无法审批。

## 浏览器 E2E

```bash
OPENCLAW_RUNTIME=/path/to/openclaw-runtime \
OPENCLAW_NODE=/path/to/node24/bin/node \
OPENCLAW_PROFILE=ownerpoc \
npm run e2e:openclaw:ui
```

脚本会：

1. 用真实产品 API 造出 Job → Patch → Sandbox(fail) → Repair(pending)；
2. 启动真实 Gateway 与 sidecar；
3. 用 Playwright 打开 Control UI，进入「页面 → Owner」；
4. 审批 Job、查看补丁 Diff、审批 Repair，并断言状态与提示；
5. 输出截图（`EVIDENCE_DIR`，默认临时目录）。

另有不依赖浏览器的冒烟：`npm run e2e:openclaw`。

## 范围外（PoC）

- 不做事件订阅/推送，页面靠手动 Refresh。
- 不做 job 创建表单（提交走聊天工具）。
- 不做品牌替换，只在 Control UI 内增加一个页面。
- 浏览器直连要求 loopback HTTP；HTTPS Gateway 需要额外方案。
- 非关键的审计/隔离加固记录在 `docs/TECH_DEBT.md`。
