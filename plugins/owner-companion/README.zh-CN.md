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
| `owner_ideas` | 按状态列出想法 |
| `owner_idea_add` | 记一条改进想法 |
| `owner_idea_status` | todo / doing / blocked / done |
| `owner_knowledge` | 列出知识笔记 |
| `owner_knowledge_add` | 记一条知识笔记 |
| `owner_diagram` | 扫描依赖并返回 Mermaid |

聊天与改代码都交给 Cindy 自己的 Agent，本插件只提供项目上下文与采集入口。

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
