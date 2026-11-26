# 功能地图

每条 drive 都从 `scripts/session.mjs` 的隔离实例出发：临时 userData、一条空会话、一个 `verify-demo` 项目。
功能文档只描述用户路径与可观察结果；实现细节回代码里看。

| 功能 | 入口 | 依赖 | 证据 |
| --- | --- | --- | --- |
| [对话](chat.md) | 输入框 + 回车 | `OWNER_AGENT_CHAT_FAKE=1`（默认开） | 气泡文本、`owner_chat_messages` 两行、输入框清空 |
| [`/` 技能](slash-skills.md) | 输入 `/` | 技能扫描（本机 pstack/matt 目录） | 面板行、技能胶囊、消息数仍为 0 |
| [`@@` 方法](at-methods.md) | 输入 `@@` | 无 | 菜单可见、方法卡标题、正文不变 |
| [配置箱](config-box.md) | 顶栏齿轮 | 假 Pi 目录（默认） | 七个分区、模型下拉、取消不写文件 |
| [写入确认卡](write-confirm.md) | 输入 `/risk high` | 无（本地脚本卡） | 高风险卡、三轴、四个动作、取消无副作用 |

## 通用前置

```powershell
node .cursor/skills/verify-owner-companion/scripts/doctor.mjs
```

隔离实例由 `run-feature.mjs` 自动创建，**不要**手动指向真实 `%APPDATA%\owner-agent-mvp`。

## 写新功能文档

按 `chat.md` 的四个 H2 写：`Sub-features`、`How to get to it (user POV)`、
`Driving it with CDP`、`Gotchas`。加进上面的表，并在 `scripts/drives/` 里放一条能跑的 drive。
