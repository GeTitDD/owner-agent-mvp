# 桌宠皮肤包（Mascot Pack v1 + Codex Pet）

桌宠支持两类皮肤：

1. **静态皮肤**：Cindy Agent Island（[makecindy/cindy](https://github.com/makecindy/cindy)，Apache-2.0）的透明 PNG/SVG；
2. **动态皮肤**：Codex Pet 风格的 `pet.json` + spritesheet，按状态播放精灵帧。

换皮肤不需要重启，也不需要改代码。

## 1. 内置皮肤

| id | 说明 |
| --- | --- |
| `cindy` / `blackcat` / `pululu` / `tarara` / `boli` | Cindy 内置套装 |
| `whitesnow` / `annie` / `chaku` / `muffin` / `erika` | Cindy 内置套装 |

默认皮肤：`pululu`（与 Cindy 的 `DEFAULT_AGENT_ISLAND_MASCOT_SKIN` 一致）。
资源位置：`desktop/assets/mascots/`。

## 2. 阶段与动画

| Owner 状态 | Codex 阶段（`data-phase`） | 动态皮肤动画行 | 静态皮肤 |
| --- | --- | --- | --- |
| idle | `idle` | `idle` | 轻微浮动 |
| working | `running` | `running` / `running-right` | 跳动 |
| waiting | `needs-interaction` | `waiting` / `review` | 左右摇摆 |
| done | `completed` | `review` / `waving` | 跳两下 |
| error | `error` | `failed` | 抖动 |

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
    "idle":     { "row": 0, "durationMs": 160 },
    "running":  { "row": 7, "durationMs": 120 },
    "waiting":  { "row": 6, "durationMs": 160 },
    "review":   { "row": 8, "durationMs": 140 },
    "failed":   { "row": 5, "durationMs": 150 }
  }
}
```

- 默认 8 列 × 9 行（v1）或 8 列 × 11 行（`spriteVersionNumber: 2`），帧 192×208。
- `states` 可省略；省略时使用 Codex v1 行序：idle / running-right / running-left / waving / jumping / failed / waiting / running / review。
- 支持 `animations.states` 或 `animation.states` 写法；`frames` 默认等于列数，`lastFrameDurationMs` 可单独设置。

## 4. 一键切换与导入

- **桌宠悬停**：右上角出现 `↻`（一键切到下一个皮肤）、`▦`（打开皮肤选择）、`×`（隐藏）。
- **右键桌宠**：直接打开皮肤选择（不再隐藏）。
- **设置 → 桌宠皮肤**：点击任意皮肤立即生效；动画包显示首帧缩略图。
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
- 配置里的皮肤不存在时回退到 `manifest.default` → `pululu` → 第一个可用皮肤，并在快照里标 `fallback`。
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

