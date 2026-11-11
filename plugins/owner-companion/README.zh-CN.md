# Owner Companion（Cindy 插件）

一个自包含的 Cindy 插件：项目画像、想法池、知识笔记、依赖图。
数据与计算全在插件自己的 Node worker 里，不需要桥、不需要第二个客户端、也不依赖我们的桌面端。

## 安装

1. 打包：`npm run cindy:pack` → `plugins/dist/owner-companion-<version>.cindy`；
2. 在 Cindy 打开 **插件 → 添加插件**，选择 `.cindy` 文件（或直接拖入）；
3. 从左侧导航打开 **Owner**，点 **添加项目**，填一个本机目录。

已在 **Cindy 0.1.124（Windows）** 实测：安装、启用、主视图、想法新增/采纳/删除、依赖扫描、Agent 工具。

## 数据与权限

- 数据文件：`~/.owner-companion/owner.json`（原子写入，保留 `.bak`）；
- 不写项目文件；除想法与知识笔记（只写插件自己的 JSON）外，所有工具只读；
- 声明了 Node worker 和 `mainView` / `panel` / `settingsHtml` / 手机投影；
  页面与 `main.js` 没有直连网络和文件系统，读取与扫描都在 worker 里完成。

## Agent 工具

| 工具 | 用途 |
| --- | --- |
| `owner_projects` | 列出已登记项目 |
| `owner_project_overview` | 画像、下一步、想法与图谱摘要 |
| `owner_brief_refresh` | 重新扫描并生成画像 |
| `owner_ideas` / `owner_idea_add` / `owner_idea_status` | 想法池 |
| `owner_knowledge` / `owner_knowledge_add` / `owner_knowledge_propose` | 知识列表 / 直接记录 / 提交候选 |
| `owner_knowledge_tidy` / `owner_knowledge_search` | 整理报告 / 关键词搜索 |
| `owner_experience_add` | 记录原始经验 |
| `owner_github_status` | 仓库、Issues、PR 与分支状态 |
| `owner_patch_propose` | 提交 git diff 候选 |
| `owner_test_run` | 运行白名单测试命令 |
| `owner_diagram` | 扫描依赖并返回 Mermaid |

应用补丁与创建 Draft PR 只开放给 UI，且都要勾选确认，Agent 不能直接调用。

## 知识流

```text
对话
  ├─ owner_experience_add      原始经验
  └─ owner_knowledge_propose   候选（status: proposed）
         │
         ├─ 接受 → unverified ── 标记已验证 → verified
         └─ 拒绝 → rejected（保留审计）
```

「整理」只报告重复、过短、未验证与待审核条目，不会自动合并或删除；接受候选不等于已验证。

## GitHub / 补丁 / 测试

- `owner_github_status` 走本机 `gh` CLI：仓库、最近 5 个 Issue、5 个 PR、当前分支与工作区状态；
  当前 gh 账号看不到的仓库会返回可读错误。
- 创建 Draft PR 仅 UI：需勾选确认；工作区不干净或分支等于 base 会拒绝；只推当前分支，不合并。
- `owner_patch_propose` 接收 `git diff`（路径必须在项目内）；应用仅 UI：勾选确认 + 校验 base commit + `git apply`。
- `owner_test_run` 只允许 `npm test`、`npm run <script>`、`node --test`、`pytest`、`python -m pytest`、
  `dotnet test`、`cargo test`、`go test`。
- 不做 Docker 沙箱与自动合并；更大的代码改动交给 Cindy 自己的 Agent 与权限模型。


## 开发

```text
plugins/owner-companion/
├── ghost.json          # schemaVersion 3 清单 + tools
├── main.js             # 沙箱电子脑：页面 ↔ worker，工具调用
├── bridge.js           # 页面侧 BroadcastChannel + /wake
├── main-view.html/css/js
├── settings.html/js
├── node/worker.cjs     # JSON-RPC stdio
└── node/lib/
    ├── store.mjs       # 项目 / 想法 / 画像 / 图谱 / 知识
    ├── scan.mjs        # 有界项目扫描
    ├── brief.mjs       # 本地快速画像
    └── diagrams.mjs    # 依赖扫描 + Mermaid
```

测试：`tests/plugin-worker.test.mjs`、`tests/plugin-scan.test.mjs`、`tests/plugin-diagrams.test.mjs`。

打包用 JSZip，确保 zip 条目是 `/` 分隔（Windows 的 `Compress-Archive` 会写成 `\`，Cindy 会拒装）。
