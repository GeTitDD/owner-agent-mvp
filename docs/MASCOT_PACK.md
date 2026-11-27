# 桌宠皮肤包（Mascot Pack v1 + Codex Pet）

桌宠支持两类皮肤：

1. **静态皮肤**：Cindy Agent Island（[makecindy/cindy](https://github.com/makecindy/cindy)，Apache-2.0）的透明 PNG/SVG；
2. **动态皮肤**：Codex Pet 风格的 `pet.json` + spritesheet，按状态播放精灵帧。

换皮肤不需要重启，也不需要改代码。

当前随应用提供 Petdex 中文站默认 **Most installed（安装量）排序前 50** 的真实动画图集，
以及原有 10 个 Cindy 模板。资源、快照排名和摘要实际保存在代码库的 `desktop/assets/mascots/`，
运行时不从网站临时下载，也不要求用户自己寻找模板。

打开方式：**齿轮 → 外观与桌宠**，或桌宠悬停的 `▦` / 右键。可按名称、来源或 `#50` 这样的排名搜索。
选择立即生效并持久化；静态图与动画包明确区分。列表使用小缩略图，只给当前桌宠解码完整精灵图。

## 1. 内置皮肤

| id | 说明 |
| --- | --- |
| `cindy` / `blackcat` / `pululu` / `tarara` / `boli` | Cindy 内置套装 |
| `whitesnow` / `annie` / `chaku` / `muffin` / `erika` | Cindy 内置套装 |

默认皮肤：`petdex-01-boba`（Petdex 安装量快照第 1 位的 Boba 动画）。另保留 10 个 Cindy 模板。
资源位置：`desktop/assets/mascots/`。

## 2. 阶段与动画

| Owner 状态 | Codex 阶段（`data-phase`） | 动态皮肤动画行 | 静态皮肤 |
| --- | --- | --- | --- |
| idle | `idle` | `idle` | 轻微浮动 |
| working | `running` | `running`（拖动时按方向用 `running-left/right`） | 跳动 |
| waiting | `needs-interaction` | `waiting` | 左右摇摆 |
| done | `completed` | 先 `jumping` 一次，再循环 `review` | 跳两下 |
| error | `error` | `failed` | 抖动 |

桌宠窗口不画底板和光环：宠物直接浮在桌面上，只保留贴地阴影，与 Codex 的宠物窗口一致。

### Codex 的 9 个动作分别什么时候用

Codex Pet 的 spritesheet 是「一行一个动作」，行为由会话状态驱动，不是随机播放：

| 行 | 动作 | 触发时机 |
| --- | --- | --- |
| 0 | `idle` | 没有任务，待机呼吸；默认只播 6 帧 |
| 1 / 2 | `running-right` / `running-left` | 宠物被拖动时按左右方向奔跑（本项目的拖动就是这两个） |
| 3 | `waving` | 一次性打招呼：换成该皮肤、宠物上线时播一遍 |
| 4 | `jumping` | 一次性庆祝：任务刚完成时跳一下 |
| 5 | `failed` | 任务失败 / 出错 |
| 6 | `waiting` | 等你审批、补充信息，或需要你点一下 |
| 7 | `running` | 智能体正在干活，循环播放 |
| 8 | `review` | 结果已出、等你查看（本项目 `done` 状态） |

每行固定 8 列，但**有效帧数不同**：idle 6、waving 4、jumping 5、waiting/running/review 6、running-left/right 和 failed 8。行尾未使用的列是透明占位，按 8 帧硬播会出现「宠物闪一下消失」；本项目按 `frames` 只播有效帧。v2（8×11）多出的两行目前不参与状态机。

外部只要提供阶段名就能驱动同一套宠物，与 Cindy `AgentIslandSessionPhase` 一致。

## 3. 动态皮肤：Codex Pet 包

目录结构：

```
%APPDATA%\owner-agent-mvp\mascots\
  └─ my-pet\
      ├─ pet.json
      ├─ spritesheet.webp
      └─ preview.png      # 可选
```

`pet.json`：

```json
{
  "id": "my-pet",
  "displayName": "My Pet",
  "spriteVersionNumber": 1,
  "spritesheetPath": "spritesheet.webp",
  "frameWidth": 192,
  "frameHeight": 208,
  "columns": 8,
  "rows": 9,
  "states": {
    "idle":     { "row": 0, "frames": 6, "durationMs": 160 },
    "waving":   { "row": 3, "frames": 4, "durationMs": 140 },
    "jumping":  { "row": 4, "frames": 5, "durationMs": 120 },
    "waiting":  { "row": 6, "frames": 6, "durationMs": 150 },
    "running":  { "row": 7, "frames": 6, "durationMs": 120 },
    "review":   { "row": 8, "frames": 6, "durationMs": 140 },
    "failed":   { "row": 5, "frames": 8, "durationMs": 140 }
  }
}
```

- 默认 8 列 × 9 行（v1）或 8 列 × 11 行（`spriteVersionNumber: 2`），帧 192×208。
- `states` 可省略；省略时使用 Codex v1 行序：idle / running-right / running-left / waving / jumping / failed / waiting / running / review，并按 Codex 的有效帧数播放（6/8/8/4/5/8/6/6/6）。
- 支持 `animations.states` 或 `animation.states` 写法；`frames` 缺省时用该动作的 Codex 默认帧数，`lastFrameDurationMs` 可单独设置。
- 若某个包的某行用了 8 帧（例如 Kirby），在 `pet.json` 里显式写 `"frames": 8` 即可。

## 4. 一键切换与导入

- **桌宠悬停**：右上角出现 `↻`（一键切到下一个皮肤）、`▦`（打开皮肤选择）、`×`（隐藏）。
- **右键桌宠**：直接打开皮肤选择（不再隐藏）。
- **齿轮 → 外观与桌宠**：点击任意皮肤立即生效；动画包优先使用 `thumb.png` 首帧缩略图，没有时回退到 spritesheet 首帧（lazy），避免一次性解码 100 张大图；底部显示「共 N 个模板」和「刷新」，悬停可看自定义皮肤目录。
- **导入 Codex 宠物…**：选择 `pet.json` 或所在文件夹，复制到用户目录并立即切换。

## 5. 静态皮肤快速替换

把图片放进用户目录即可，无需改仓库：

```
%APPDATA%\owner-agent-mvp\mascots\
  ├─ my-pet.png          # 文件名即皮肤 id：my-pet
  ├─ cindy.png           # 与内置同名 → 覆盖内置
  └─ manifest.json       # 可选：显示名与默认皮肤
```

`manifest.json`：

```json
{
  "default": "my-pet",
  "labels": { "my-pet": "我的宠物", "cindy": "Cindy 自定义" }
}
```

规则：
- 接受 `*.png` / `*.svg` / `*.webp` / `*.gif`；id 由文件名归一化（小写、保留 `a-z0-9._-`）。
- 同名时用户目录覆盖内置；动画包 id 默认取 `pet.json.id`，再回退到目录名。
- 配置里的皮肤不存在时回退到 `manifest.default` → `petdex-01-boba` → 第一个可用皮肤，并在快照里标 `fallback`。
- 不接受路径穿越；`mascots.set` 只允许目录内已存在的 id。
- 动画包缺失 spritesheet、路径越界或 JSON 损坏时忽略，不影响静态皮肤。

## 6. 验收

```powershell
npm run e2e:desktop:mascots
```

覆盖：spritesheet 首帧渲染、idle 帧推进、悬停 ↻ 一键换肤、静态回退、设置页精灵缩略图、设置页一键切回。

## 7. 与 Cindy / Codex Pet 的边界

复用了：
- Cindy 的皮肤 id 集合、阶段命名与设置页网格；
- Codex Pet / Petdex 的 `pet.json + spritesheet` 包格式、状态行约定与“一键导入/切换”体验。

没有引入：
- Cindy 的 React/Tailwind 渲染栈、macOS 原生灵动岛、声音系统、远程会话镜像；
- Codex Pet 的生成技能、在线图库或云端服务。

## 8. 许可

静态皮肤资源与阶段命名来自 `makecindy/cindy`（Apache-2.0）。
Codex Pet 只借鉴公开的包格式约定，不包含其运行时或美术资源。详见 `docs/THIRD_PARTY_NOTICES.md`。



## Petdex 快照与维护

清单：`desktop/assets/mascots/petdex-manifest.json`，逐包保留原始 `upstream-pet.json`、
未改像素的精灵图、适配后的 `pet.json`、`source.json` 和 `thumb.png`。
本批为 48 个 v1 和 2 个 v2 包；Spyro 上游配置中的扩展名与包内文件不符，
本地仅修正引用并记录修复，原始配置仍保留。

显式重新导入工具：`python3 scripts/import-petdex.py`（维护者需要 Pillow）。已有快照时工具拒绝自动覆盖；
更新前需要审阅旧清单并明确安排替换。该维护工具不进入应用运行路径。
来源素材的权利和包内许可逐条保留，不推定站点所有作品采用同一个开源许可。
