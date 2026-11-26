---
name: verify-owner-companion
description: Drive the Owner Companion Electron desktop app (single card shell) end to end: launch an isolated instance, exercise chat, slash skills, @@ methods, config or a write-confirmation card, capture screenshots and DB evidence. Use when verifying a change to desktop/shell*, IPC, write gates, or any user-facing flow in this repo.
---

# Verify Owner Companion

Owner Companion 是一个 Windows Electron 桌面应用：一个无边框窗口，`/` 调技能、`@@` 选方法、普通文本走只读 Pi 会话。
本 skill 只驱动**这个桌面壳**；`bin/workbench.mjs`、`bin/mobile-server` 与 sidecar HTTP 不在验证范围。

## Launch

隔离启动一条命令（临时 userData / SQLite / demo 项目 / 假 Pi 目录 + 假对话流）：

```powershell
cd <repo>
node .cursor/skills/verify-owner-companion/scripts/run-feature.mjs .cursor/skills/verify-owner-companion/scripts/drives/chat.mjs
```

`run-feature.mjs` 内部用 `scripts/e2e/lib/cdp.mjs` 的 `startApp`：

- 用 `mkdtemp` 建临时根，`--user-data-dir` 指向它，**不碰** `%APPDATA%\owner-agent-mvp`；
- 起一个已登记项目 `verify-demo` 与一条当前会话（空消息）；
- 写 `OWNER_AGENT_PI_HOME` 到假目录（模型下拉只有 `demo-provider/fast-model`）；
- 默认 `OWNER_AGENT_CHAT_FAKE=1`：回答是 `（假回答）…`，不调真模型；
- 端口由 harness 取空闲口，可并行跑多个实例。

**Ready 判定**：`await waitFor(panel, "document.getElementById('shellHeader')")` 之后再过 1.2s，
让顶栏把会话/项目读出来。只看进程存在不算就绪。

Teardown 由 `run-feature.mjs` 的 `finally` 调用 `session.stop()`：`app.stop()` 关本次 Electron，
再删本次临时根。

## Doctor

任何「起不来 / 不确定」先跑：

```powershell
node .cursor/skills/verify-owner-companion/scripts/doctor.mjs
```

检查项：Node ≥ 22.13、`electron` 可执行文件、CDP harness、`scripts/check-files.json`、
harness 导出、`scripts/check-syntax.mjs`。只读，不启动窗口。

## Drive

从零写一条 drive：新建 `.mjs`，`export default async function (session)`，然后用：

```js
export default async function myFeature({ panel, waitFor, sleep, shot, ownerDb }) {
  // 1) 真实用户路径：写 input → 派发 input 事件 → requestSubmit（等价回车）
  await panel.evaluate(`(() => {
    const input = document.getElementById('input');
    input.focus();
    input.value = '你好';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('composer').requestSubmit();
  })()`);

  // 2) 等可见结果，不等固定时间
  await waitFor(panel, "document.querySelectorAll('#messages .msg:not([data-streaming])').length >= 2", 30000);
  await sleep(300);

  // 3) 同时验现象与副作用
  const answer = await panel.evaluate(
    "document.querySelector('#messages .msg:not([data-streaming]):last-child .bubble')?.textContent ?? ''"
  );
  const db = ownerDb();
  const rows = db.prepare('SELECT role, text FROM owner_chat_messages ORDER BY seq').all();
  db.close();

  await shot('my-feature.png');
  if (!answer.includes('假回答')) throw new Error(answer);
  if (rows.length !== 2) throw new Error(`db rows ${rows.length}`);
}
```

运行任意 drive：

```powershell
node .cursor/skills/verify-owner-companion/scripts/run-feature.mjs .cursor/skills/verify-owner-companion/scripts/drives/<name>.mjs
```

稳定句柄（不要用坐标）：

| 目标 | 选择器 |
| --- | --- |
| 输入 / 发送 | `#input`、`#composer`、`#send` |
| 技能面板 | `#skillPanel`、`#skillList .slash-item[data-kind="skill"]`、`#skillChipLabel` |
| `@@` 菜单 | `#atPanel`、`.at-method[data-at-method="prompt"]` |
| 顶栏 | `#sessionToggle`、`#projectToggle`、`#writeScope`、`#syncState` |
| 配置箱 | `#configToggle`、`#configBox`、`.cfg-group[data-section]` |
| 写入确认卡 | `.block.type-risk` |
| 会话浮层 | `#sessionPopover`、`#sessionNew`、`#sessionList` |

## Evidence

每次运行写到一个**不会被清理**的目录：

```text
.verify/evidence/<UTC时间戳>-<drive名>/
├─ result.json      PASS/FAIL、耗时、错误栈、evidenceDir
├─ <drive>.png      该 drive 自己 shot() 的截图
└─ failure.png      失败时自动补一张
```

证据标准：

- 走真实用户路径（DOM 事件 / `requestSubmit` / 点击），不调内部 setter；
- 现象与副作用一起验：DOM 文本 + SQLite 行 + （需要时）文件是否存在；
- 假对话是**验收注入**（`OWNER_AGENT_CHAT_FAKE`），只用于聊天的「落库 + 渲染」；
  验证技能、配置、确认卡这类不依赖模型的功能时不要依赖它；
- 截图要包含动作后的状态，不要只截最终空屏。

## Cleanup

- 每个 drive 跑完都会 `app.stop()` + 删临时根；证据目录保留。
- **不要按进程名杀 Electron**：你自己的窗口可能也开着。只结束 `session.app` 启动的那个进程。
- 失败时 `run-feature.mjs` 仍会清临时实例并保留 `failure.png`；先看证据再重跑。
- `.verify/` 已在 `.gitignore` 里，不要提交。

## Helpers

| 文件 | 作用 | 调用 |
| --- | --- | --- |
| `scripts/doctor.mjs` | 只读体检 | `node …/doctor.mjs` |
| `scripts/session.mjs` | 起隔离实例，导出 `panel / shot / ownerDb / stop` | 由 run-feature 使用 |
| `scripts/run-feature.mjs` | 跑一个 drive 并写证据 | `node …/run-feature.mjs <drive>` |
| `scripts/drives/chat.mjs` | 已证明的示例：发消息 → 落库 → 回复 → 输入框清空 | 见 Launch |

功能地图在 `features/`：先读 `features/README.md`，再按要验的入口打开对应文件。
