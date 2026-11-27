# 第十三批：动漫图标与 Petdex 前 50 动画内置

日期：2026-11-27。按用户要求更换应用图标、修复桌宠模板入口，并把 Petdex 中文站前 50 的实际桌宠资源放入代码库。

## 用户旅程

打开应用即可看到新的动漫头像图标和 Boba 动画桌宠。
右键桌宠 / 悬停 `▦`，或齿轮 → 外观与桌宠，进入同一个模板选择器：

1. 优先展示 Petdex 安装量快照第 1–50 名，其后保留 10 个 Cindy 模板。
2. 可按名称、排名（如 `#50`）或来源搜索。
3. 点击后立即切换并持久化，重启仍保留；静态图片和动画包有明确标签。
4. 失败保留原模板，读取失败可重试，取消导入不改选择；外观窗口不覆盖会话草稿。
5. 小窗口只滚动内容，关闭、状态与操作区始终可达；原生弹窗 Esc 不会顺手关掉底层配置。

## 原因与修复

原配置固定选中了简化的 `pululu.svg`；已下载的 Cindy PNG 虽然存在，但 `open-skin-picker`
仍向新版没有消费的旧设置入口发通知，无法展示选择网格。隔离复现检查首先因选择器未打开而失败，修复后通过。

默认改为真实下载的 `petdex-01-boba`，恢复完整模板选择器，Cindy 的 10 个既有模板继续保留。
自定义同名资源正确标为导入来源，不再因 ID 恰好与内置同名就被冒充成内置。

## Petdex 下载与入库

站点：`https://petdex.dev/zh`。核对页面和公开查询实现后，采用站点默认 **Most installed（安装量）**，
不是首页推荐条目、最高点赞或最近上传排序。完整清单位于：

`desktop/assets/mascots/petdex-manifest.json`

共 50 个唯一条目，排名 1–50 连续、安装量降序，48 个 v1 包和 2 个 v2 包。
原始图集、原始配置、适配配置、封面与来源记录合计约 **88.2 MiB**，最大单个资源约 2.75 MiB。
每个目录包含：

- `upstream-pet.json`：原 ZIP 内配置，不改写。
- `spritesheet.webp` 或 `spritesheet.png`：下载的实际图集，原像素保留。
- `pet.json`：适配本机唯一 ID、文件引用、实际帧尺寸和集合排名。
- `thumb.png`：由 idle 首帧生成的轻量封面。
- `source.json`：来源页、下载地址、作者、快照时间、ZIP 摘要、许可状态与兼容修正。

所有文件 SHA-256 与体积都写入总清单。所有 50 张首帧都检查为非空。
Spyro 的上游配置声明 `spritesheet.webp`，ZIP 实际提供 `spritesheet.png`；本地仅修正引用并记录，
原配置与原图仍保留，没有替换或跳过这一名次。

下载工具 `scripts/import-petdex.py` 明确限定官方域名、归档路径、数量和体积；不运行包内程序。
已有快照时拒绝自动覆盖。开发者重新导入需要 Python/Pillow；应用运行与离线切换不需要它们。
列表使用小封面，只对当前宠物加载完整动画，避免同时解码 50 张大图。
来源素材按条目保留作者和声明，未声明许可的条目不推定为统一开源许可；未发布到任何远端。

## 应用图标

来源为 Wikipe-tan face，原作 Kasuga、矢量化 Actam，按 CC BY-SA 3.0 保留来源、完整许可和原 SVG。
设计加入深蓝/浅蓝圆角边框并调整构图；提供 1024 PNG、多尺寸 Windows ICO、macOS ICNS 和可编辑 SVG。
文件位于 `desktop/assets/branding/`。

图标接入开发运行时 Dock、窗口、托盘及 Windows/macOS 构建配置。
macOS 目录产物中的 `icon.icns` 与设计文件 SHA-256 一致，已不再使用默认 Electron 图标。
图像派生物沿用其许可，不改变应用代码和其他素材的许可。

## 实际验收

| 检查 | 结果 |
| --- | --- |
| 全量测试 | 1367 项：1362 通过、5 跳过、0 失败 |
| 语法 | 321 个清单内 JS/CJS/MJS 文件通过；下载工具 Python AST 通过 |
| 外观完整旅程 | 30 项通过；含真实 Boba 帧推进、真实第 50 名切换、搜索、保存/重启、取消、失败、草稿保全 |
| 打包资源旅程 | macOS arm64 目录构建成功；用 Electron 加载产物内的主程序及资源，31 项通过 |
| 产物核对 | app.asar 内恰有 50 份 Petdex pet.json；Windows ICO 已包含；macOS 图标与新 ICNS 相同 |
| 动画回归 | spritesheet 帧推进、有效帧边界、静态切换、循环回到动画全部通过 |
| 桌面回归 | card-shell、card-projects、slash、config-box 全部通过 |
| 其他 | 文件摘要、CSS 花括号、文档链接、git diff --check 均通过 |

原动画验收脚本依赖当前未安装的 Playwright；改用已有 CDP 工具，未增加依赖，并将验收网关改为
`127.0.0.1:1`，不接触本机个人 OpenClaw。动画切换测试不再假设下一项必然是静态图片。

关键实际截图已打开检查：

- [应用头像与 Petdex 网格](assets/2026-11-27-appearance/01-templates-light.png)
- [Boba 实际桌宠](assets/2026-11-27-appearance/02a-boba-pet.png)
- [第 50 名按排名搜索并选中](assets/2026-11-27-appearance/02b-rank50-search.png)
- [第 50 名实际桌宠](assets/2026-11-27-appearance/02c-anya-pet.png)
- [失败反馈](assets/2026-11-27-appearance/05-selection-error.png)
- [深色](assets/2026-11-27-appearance/06-templates-dark.png)
- [380×560 小窗口](assets/2026-11-27-appearance/07-small-window.png)
- [全部 50 个首帧概览](assets/2026-11-27-appearance/petdex-top50-contact.png)

## 正常预览与边界

正常预览已重启，实际读回 60 个模板、其中 Petdex 50 个；当前使用 Boba，动漫图标已解码并显示。
用户未发送草稿保留，原 DeepSeek 模型配置保留。本批没有发起任何真实模型调用。

资源实际位于本地 Git 工作区并被构建包含，但未提交、推送或发布；此前的所有未提交工作都保留。
本次未覆盖 Windows 真机、macOS 签名/公证或 50 个角色每一种动作的逐帧播放；已核对全部资源摘要与网格，
实际播放测试覆盖默认包、第 50 名和测试动画包，既有只读/写入权限不受外观调整影响。

本机原始记录：`.verify/petdex-full.log`、`.verify/petdex-packaged/acceptance.json`、
`.verify/appearance-package.log`、`.verify/petdex-mascot-animation.log`。
