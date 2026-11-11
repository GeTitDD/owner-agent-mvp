# Owner Companion（Cindy 插件）

把 Owner Companion 的项目视图带进 Cindy：项目画像、想法池、知识计数、图谱版本，
以及和 Agent 的只读讨论。

插件本身不存项目数据，只连本机 Owner Companion 桌面端的局域网桥
（默认 `http://127.0.0.1:47831`）。

## 安装

1. 在同一台电脑上安装并启动 Owner Companion；
2. 桌面端打开 **设置 → 手机连接**，记下地址和 6 位配对码；
3. 在 Cindy 里打开本插件的设置，填地址和配对码，点 **连接**。
   插件只保存设备令牌，不保存配对码（`~/.owner-companion/plugin.json`，0600）；
4. 从 Cindy 左侧导航打开 **Owner**（或插件卡片 → 管理 → 使用）。

打包产物：`plugins/dist/owner-companion-0.1.1.cindy`（zip 根目录即 `ghost.json`），
用 Cindy 插件页的「添加插件」导入。

已在 **Cindy 0.1.124（Windows）** 实测：安装、启用、主视图、设置、想法新增/采纳/删除，
以及一次真实的 27 秒聊天往返。

## 能做什么

| 区域 | 行为 |
| --- | --- |
| 项目 | 切换已登记项目，各自加载自己的数据 |
| 画像 | 一句话、怎么跑、风险、过期提示 |
| 想法 | 新增 / 采纳 / 搁置 / 重开 / 删除，或带回聊天继续讨论 |
| 知识 | 经验 / 知识 / 候选计数，图谱版本 |
| 聊天 | 通过桌面端只读分析讨论进度与改进意见 |

## 权限与边界

- 只声明 Node worker（`node/worker.cjs`）。页面和 `main.js` 没有直连网络，
  由 worker 访问本机回环地址；
- 不能写项目文件、不能审批、不能执行 Job。聊天里需要改代码时，
  Owner Companion 会生成待审批请求，必须回电脑上批准；
- 设备令牌保存在当前用户目录，删除 `~/.owner-companion/plugin.json` 即可解绑。

## 开发

```text
plugins/owner-companion/
├── ghost.json          # schemaVersion 3 清单
├── main.js             # 沙箱电子脑：页面 ↔ Node worker
├── bridge.js           # 页面侧工具（BroadcastChannel + /wake）
├── main-view.html/css/js
├── settings.html/js
└── node/worker.cjs     # JSON-RPC stdio → 本机 HTTP
```

worker 的契约测试在 `tests/owner-companion-plugin.test.mjs`。
