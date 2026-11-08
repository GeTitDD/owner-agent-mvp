# 桌宠皮肤包（Mascot Pack v1）

桌宠采用 **Cindy Agent Island**（[makecindy/cindy](https://github.com/makecindy/cindy)，Apache-2.0）的皮肤与阶段约定：
一套透明 PNG/SVG + 五个会话阶段。换皮肤不需要改代码。

## 1. 内置皮肤

| id | 说明 |
| --- | --- |
| `cindy` / `blackcat` / `pululu` / `tarara` / `boli` | Cindy 内置套装 |
| `whitesnow` / `annie` / `chaku` / `muffin` / `erika` | Cindy 内置套装 |

默认皮肤：`pululu`（与 Cindy 的 `DEFAULT_AGENT_ISLAND_MASCOT_SKIN` 一致）。
资源位置：`desktop/assets/mascots/`。

## 2. 阶段（与 Codex / Agent Island 对齐）

| Owner 状态 | Codex 阶段（`data-phase`） | 视觉 |
| --- | --- | --- |
| idle | `idle` | 静态，灰点 |
| working | `running` | 旋转环 |
| waiting | `needs-interaction` | 橙色呼吸环 |
| done | `completed` | 绿色环 |
| error | `error` | 红色呼吸环 |

外部只要提供阶段名（`running / needs-interaction / completed / error`）就能驱动同一套宠物；
这与 Cindy `AgentIslandSessionPhase` 和 Codex 会话快照的取值一致。

## 3. 快速替换

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

打开「设置 → 桌宠皮肤」即可看到新皮肤并一键切换；配置写入 `companion.json` 的 `mascotSkin`。

规则：
- 只接受 `*.png` / `*.svg`，id 由文件名归一化（小写、保留 `a-z0-9._-`）。
- 同名时用户目录覆盖内置。
- 配置里的皮肤不存在时回退到 `manifest.default` → `pululu` → 第一个可用皮肤，并在快照里标 `fallback`。
- 不接受路径穿越；`mascots.set` 只允许目录内已存在的 id。

## 4. 与 Cindy 的边界

复用了：
- 皮肤 id 集合与资源；
- 会话阶段命名与「阶段 → 动画」的表达；
- 设置页的皮肤网格交互。

没有引入：
- Cindy 的 React/Tailwind 渲染栈、macOS 原生灵动岛、声音系统、远程会话镜像。

## 5. 许可

皮肤资源与阶段命名来自 `makecindy/cindy`（Apache-2.0）。详见 `docs/THIRD_PARTY_NOTICES.md`。
