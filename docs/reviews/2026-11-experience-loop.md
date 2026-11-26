# 经验闭环：交接说明（2026-11）

## 状态

六张票（#135–#140）已完成、通过 code review 修复并关闭。

```text
分支    integration/experience-loop
基线    feat/card-shell @ 63ab7a1
代码 tip fd45eff
文档 tip 见分支最新提交
```

## 启动

```powershell
git fetch origin
git switch integration/experience-loop
npm install
npm run check
npm test
```

## 这批票做了什么

| 票 | 内容 |
| --- | --- |
| #135 | `/提炼决策`：只扫当前项目会话，候选持久化，接受才写决策，拒绝记指纹 |
| #136 | 完整工作台按项目 / 状态浏览经验与证据，只读 |
| #137 | `/记灵感` 回执上「提升为 Lesson」，重复提升不重复写 |
| #138 | 决策候选改写 + `/记决策`，共用一张表单，现象只读 |
| #139 | 定位屏替换全局聚合，按关注顺序排列，未读只读预览 |
| #140 | 定位屏行内「标记已读」，只推进一个项目的水位 |

每张票的验收证据与边界在对应 GitHub issue 的关闭评论里。

## 关键约束（改动前先读）

- `docs/DIRECTION.md`：方向与经验链。
- `docs/adr/0014-locate-screen.md`：关注顺序、待确认定义、7 天阈值、未读语义。
- `docs/adr/0015-experience-view-by-invocation.md`：卡片壳不设经验库，浏览归工作台。
- `GLOSSARY.md`：「候选」与「待办」不可混用；「定位屏」「标记已读」「缺理由」等以它为准。
- `AGENTS.md`：中文注释；业务在 `services` / `src`，视图只画；卡片壳单入口。

## 验证基线

```text
npm run check   272 项通过
npm test        1233 / 1229 pass / 0 fail / 4 skipped
专项            51/51
e2e             card-projects / card-shell / slash / own-write PASS
```

`config-box` e2e 在四个套件连续运行时曾出现一次环境性失败，单独重跑 exit 0、全部 OK；后续改动如涉及配置箱，建议单独跑它。

## Code review

两轴分开执行：

- Standards（GLM）：发现「待办 / 候选」术语漂移、`decision-scan` 重复代码、LIMITS 漂移风险、check-files 漏登记。
- Spec（DeepSeek）：发现 partial 决策候选可被误接受、部分可读未读未进排序档、跨项目经验只显示首个项目等。

全部在 `68cdb22` 修复，合并为 `fd45eff`。新增测试：

```text
tests/decision-form-limits.test.mjs
tests/locate-mark-read.test.mjs（含真实 ChatSessionStore 切换）
tests/decision-scan.test.mjs（partial / unpaired / limits）
tests/locate-screen.test.mjs（部分可读）
```

## 已知缺口 / 后续

- `src/global-library.mjs` 已无生产入口，可单独删除；`tests/card-projects.test.mjs` 仍覆盖它。
- `desktop/shell.html`、`shell-header.cjs`、`shell-compose.cjs`、`src/global-write.mjs` 等处仍有少量「全局聚合」旧文案，未在本次 review 范围内清理。
- `#137` 的 UI 点击未加独立 Electron e2e；现有覆盖是模型 + 源码接线 + `own-write` e2e。
- `#135` 的扫描是启发式：自动只带现象，选择 / 放弃 / 理由标「（待补）」，由改写补齐。
- 版本浏览 #92、删除项目 #93、风险评估器 #133 仍未做。

## 合并路径

当前分支基于 `feat/card-shell`，而 `feat/card-shell` 已由 PR #134 指向 `main`。两种走法：

1. 把 `integration/experience-loop` 合入 `feat/card-shell`，让 PR #134 带上这批提交；
2. 单独开 `integration/experience-loop → main` 的 PR，并关闭 / 取代 #134。

选择前先确认 #104、#98、#134 的合并顺序，避免把三批未合并的工作混成一个 PR。
