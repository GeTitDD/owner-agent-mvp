# Owner Companion MCP（OpenClaw / Telegram）

把 Cindy 里的 Owner 工具和面板搬到 OpenClaw：

- `server.mjs`：stdio MCP 服务，把现有 `plugins/owner-companion/node/worker.cjs` 的 20 个工具暴露给 OpenClaw；
- `panel.mjs`：Telegram 按钮面板（项目 / 概览 / 想法 / 知识 / 图表 / GitHub / 测试 / 补丁）；
- `diagrams.mjs`：自绘 SVG 兜底（resvg 转 PNG）；
- `mermaid.mjs`：优先用 Mermaid CLI（开源）渲染专业布局的 PNG；
- `puppeteer-config.json`：复用系统 Edge，避免再下载 Chromium。

## 为什么跑在 Windows

OpenClaw 在 WSL，但 Owner 数据和项目都在 Windows（`C:\...`、`D:\...`）。
OpenClaw 通过 WSL interop 启动 `C:\nvm4w\nodejs\node.exe`，MCP 进程直接看 Windows 文件系统，
不需要路径翻译。

## OpenClaw 配置

```json5
{
  mcp: {
    servers: {
      "owner-companion": {
        enabled: true,
        transport: "stdio",
        command: "/mnt/c/nvm4w/nodejs/node.exe",
        args: ["D:/.../integrations/openclaw-owner-mcp/server.mjs"],
        env: { "OWNER_COMPANION_DIR": "C:\\Users\\<you>\\.owner-companion" }
      }
    }
  },
  channels: {
    telegram: {
      botToken: "...",
      dmPolicy: "pairing",
      capabilities: { inlineButtons: "dm" }
    }
  }
}
```

`env` 里的变量不会自动传给 Windows exe，所以面板配置放在
`%USERPROFILE%\.owner-companion\telegram.json`：

```json
{
  "botToken": "123456:ABC...",
  "chatId": "你的 Telegram 数字 id",
  "proxy": "http://127.0.0.1:7897"
}
```

`proxy` 只在 WSL/Windows 直连 Telegram 失败时需要（Clash 等）。

## 图

- 优先 `mmdc`（Mermaid CLI，MIT）渲染：flowchart / sequence / stateDiagram；
- 失败时退回 `diagrams.mjs` 的自绘 SVG，再失败才发 Mermaid 源码；
- 单张用 `sendPhoto`，多张用 `sendMediaGroup`（相册），旧的图会先删除。

## 工具

`owner_projects`、`owner_project_overview`、`owner_brief_refresh`、`owner_ideas`、
`owner_idea_add`、`owner_idea_status`、`owner_knowledge*`、`owner_experience_*`、
`owner_diagram(s)`、`owner_github_status`、`owner_patches`、`owner_patch_propose`、
`owner_test_run`、`owner_panel`（Telegram 面板）。

审批/应用补丁仍然只能在 Cindy 的 Owner 面板里做；Telegram 里只能查看、提案、接受/拒绝知识候选。
