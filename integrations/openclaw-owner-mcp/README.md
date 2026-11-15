# Owner Companion MCP（OpenClaw / Telegram）

把 Cindy 里的 Owner 能力搬到 OpenClaw：手机端只用 Telegram，不再依赖 Cindy 账号或 Tailscale。
Cindy 面板已按「弃用」处理，本目录是日常入口。

- `server.mjs`：stdio MCP 服务，把 `plugins/owner-companion/node/worker.cjs` 暴露给 OpenClaw（31 个工具）；
- `panel.mjs`：Telegram 按钮面板（项目 / 概览 / 想法 / 知识 / 图表 / GitHub / 测试 / 补丁 / 项目管理）；
- `panel-core.mjs`：面板的纯逻辑（分页、状态流转、回调解析、补丁摘要），带单元测试；
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

## 面板怎么走

```text
Telegram 按钮
  → callback_data: owner:overview:cultivation-agent
  → OpenClaw 把未识别的 callback 转成文本消息
  → Agent 调 owner_panel({ callback })
  → 面板直接调 Bot API（经代理）编辑同一条消息
```

- 面板状态存在 `~/.owner-companion/telegram-panel.json`：当前项目、消息 id、分页、
  已勾选的图、待输入状态、待确认操作；
- 需要输入的地方（新增想法 / 知识 / 搜关键词 / 加项目 / 自定义测试命令）走「等输入」：
  面板记下 `pending`，用户下一条文本由 Agent 传 `owner_panel({ text })` 消费，
  2 分钟不输入自动失效；
- 点任意按钮都会作废旧输入状态，避免把普通聊天误存成想法。

## 面板功能

| 页面 | 能做什么 |
| --- | --- |
| 项目 | 切换、添加（发路径）、移除（二次确认，只删登记） |
| 概览 | 一句话画像、下一步建议、计数、重新扫描（后台跑完自动刷新） |
| 想法 | 分页、点标题循环状态、新增、删除（确认） |
| 知识 | 分页、接受/拒绝候选、标记已验证、整理、搜索、新增 |
| 图表 | 勾选多张一起发（相册）、单张、全部；渲染失败退回 Mermaid 源码 |
| GitHub | 仓库/分支/Issues/PR、创建草稿 PR（二次确认后后台执行） |
| 测试 | 最近记录、运行 `npm test`、自定义命令；结果异步单发消息 |
| 补丁 | 列表/预览 diff、应用（二次确认）、拒绝、从工作区改动生成提案 |

危险操作（应用补丁、创建 PR）都要点一次确认按钮，且确认 2 分钟内有效；MCP 工具层
还会再校验一次 `confirm: true`。

## 知识候选提醒

有新候选时不用自己点进去看，bot 会主动推一条：

```text
🔔 新的知识候选（1）

• [cultivation-agent] 复盘：为什么重试要放在队列层

[✅ 复盘：为什么重试要放在…] [❌]
[打开知识面板]
```

- 每 60 秒轮询一次本地数据；**任何工具调用之后也会立刻检查一次**（5 秒防抖），
  所以 Agent 刚生成的候选马上就能收到；
- 只推「这一轮新出现的 `proposed`」；第一次运行只建基线，不会把历史候选一次性倒给你；
- 提醒消息里的按钮就是面板的知识审核按钮，点了直接接受/拒绝；
- 菜单里有 `🔔 候选通知：开 / 关`，状态存在 `~/.owner-companion/telegram-notify.json`；
- 同一个文件里还留着 `lastCheck`（本轮总数/新增数/是否基线）和
  `lastAlert`（时间、条数、是否发送成功），排查「为什么没提醒」时直接看它。

## Agent 规则（写进 OpenClaw 的 `AGENTS.md`）

面板能不能用，一半取决于 Agent 是否守规矩。当前工作区里用的是这套：

```text
- 用户说「打开 Owner 面板」→ owner_panel({ action: "menu" })
- 用户消息以 `callback_data: owner:` 开头 → 把整串传给 owner_panel({ callback })
- 面板说「请直接发消息」→ 把用户下一条文本传给 owner_panel({ text })
- 写操作（想法 / 知识 / 项目 / 测试）→ 调对应工具，然后 owner_panel 刷新面板
- 应用补丁、创建 PR → 只有用户明确说「确认」才传 confirm: true
```

## 图

- 优先 `mmdc`（Mermaid CLI，MIT）渲染：flowchart / sequence / stateDiagram；
- 失败时退回 `diagrams.mjs` 的自绘 SVG，再失败才发 Mermaid 源码；
- 单张用 `sendPhoto`，多张用 `sendMediaGroup`（相册，最多 10 张），旧图会先删除；
- 慢操作（扫描、测试、应用补丁、建 PR）都在后台跑，完成后再单发消息，避免 MCP 调用超时。

## 测试

```powershell
node --test integrations/openclaw-owner-mcp/panel-core.test.mjs
node --check integrations/openclaw-owner-mcp/panel.mjs
```

## 工具

`owner_projects`、`owner_project_add`、`owner_project_remove`、`owner_project_overview`、
`owner_brief_refresh`、`owner_ideas`、`owner_idea_add`、`owner_idea_status`、`owner_idea_remove`、
`owner_knowledge`、`owner_knowledge_add`、`owner_knowledge_propose`、`owner_knowledge_review`、
`owner_knowledge_verify`、`owner_knowledge_tidy`、`owner_knowledge_search`、
`owner_experience_add`、`owner_experience_list`、`owner_diagram`、`owner_diagrams`、
`owner_github_status`、`owner_github_pr`、`owner_patches`、`owner_patch_propose`、
`owner_patch_propose_worktree`、`owner_patch_apply`、`owner_patch_reject`、
`owner_tests`、`owner_test_run`、`owner_panel`。
