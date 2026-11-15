# Relay（Cindy 插件）

把当前任务里**新增的对话原样**转交给另一个任务、伙伴，或在项目里新建一个任务
（可选 Codex / Claude / Pi）。不自动发送：你选好目标、看过引用、点发送才发。

灵感来自 Kenn 的 Kanary Relay；区别是 Relay 只在 Cindy 内部转交，不去接管
Claude / Codex / Cursor 桌面应用。

## 安装

1. `npm run cindy:pack:relay` → `plugins/dist/cindy-relay-<version>.cindy`
2. Cindy → 插件 → 添加插件 → 选 `.cindy`；
3. 安装确认里会列出三项权限：读用户消息、读 AI 回复、给其他任务发消息。都需要你确认；
4. 左侧导航出现 **Relay**，每个任务的右侧栏也会多一个 **Relay** 页签。

## 怎么用

1. 在任务 A 里正常聊；
2. 想换一个 Agent 接手时，打开 Relay 页签（或让 Cindy 调 `relay_open`）；
3. 选择范围：**自上次转交** 或 **全部记录**；
4. 选择目标：
   - **项目**：在 Cindy 已注册的项目目录里新建任务，可以选 Agent / 模型（Codex / Claude / Pi）；
   - **新任务**：不绑定项目，直接建一个新任务，同样可选 Agent / 模型；
   - **任务 / 伙伴**：发给已有任务或 Cindy 伙伴，沿用对方设置；
5. 按需写一句备注，点 **发送**。

发送后，Relay 把「自上次转交以来的消息」作为附带资料、备注作为正文，投递给目标。
「新任务」和「项目」会新建一条任务，标题默认取备注或第一条用户消息。
正文里会带一行 `来源任务：[…](cindy://session/<id>)`，方便对方跳回原任务。

### 图片与文件

**图片**随引用一起转交（最多 4 张、合计约 12 MB，PNG / JPEG / WebP）：

- 钩子只给文本，图片由 Relay 从本机 Cindy 消息库只读查出（`messages.content.images`），
  再从 `cindy-media/blobs` 读字节，交给 Host 的附件通道；
- 只取当前任务、当前范围（自上次转交 / 全部）内的图片；
- 找不到数据库、版本不支持或读取失败时安静跳过，不影响文字转交。

**普通文件**（拖入或 @ 引用的文件）：

- 文档里会多一段 `[引用文件]`，逐个列出绝对路径、文件名与大小；
- 文本类文件（md / txt / json / yaml / 代码等，≤ 64 KB、合计 ≤ 48 KB）会把内容也贴进
  `[文件内容：…]` 代码块，对方不用再读盘；
- 二进制或大文件只给路径，由目标 Agent 自己按需读取；
- 文件名、路径与内容都来自本机，不复制、不上传。

## 权限与边界

- 读消息靠 `will-user-message` / `will-assistant-message` 两个钩子，只旁听，不改写；
- 发送走 `cindy.targets.send`，只有页面里的真实点击会触发；
- Agent 只有 `relay_status` / `relay_open` / `relay_history` 三个只读或准备型工具；
- 只能转交 Cindy 本机的任务/伙伴/项目，不支持手机或远程设备透传；
- 插件启用之前的对话不在记录里；
- 单条消息截断到 2 万字，每个任务保留最近 400 条；转交资料上限 32000 字（超出从最旧截断）。

## 数据

`~/.cindy-relay/relay.json`（可用 `CINDY_RELAY_DIR` 覆盖），原子写入并保留 `.bak`。
里面只有：任务 id、消息文本、转交记录。不上传、不联网。

图片字节不落 Relay 的存储：每次发送时按需从 Cindy 的 `cindy-media/blobs` 读取，
读出来直接交给 Host 的附件通道，不写回 `relay.json`。

## 开发

```text
plugins/cindy-relay/
├── ghost.json          # 清单：hooks / agent.tasks / agent.targets / tools
├── main.js             # 钩子、工具、卡片；页面 ↔ worker 转发
├── bridge.js           # 页面侧 BroadcastChannel + /wake
├── relay.html/css/js   # 页签 UI：范围、目标、备注、发送
└── node/
    ├── worker.cjs      # JSON-RPC stdio
    └── lib/store.mjs   # 本地消息流水与转交记录
```

测试：`node --test tests/plugin-relay.test.mjs`。
