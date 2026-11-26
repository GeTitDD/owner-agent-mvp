# 贡献指南

这是一个自用的本地工具，按「够用、可验证、不过度设计」的标准维护。提交前请先读完本页。

## 环境

- Windows（客户端的窗口、托盘、路径行为都以 Windows 为准）
- Node.js ≥ 22.13
- 可选：可用的 Pi 凭据（只有真实模型对话需要；测试不需要）

```powershell
npm install
npm test
npm run check
npm run desktop
```

## 提交前必须通过

```powershell
npm test          # 全量单元测试；不联网、不调模型
npm run check     # 语法检查（scripts/check-files.json 清单驱动）
```

改到桌面壳（`desktop/shell*.cjs`）或 IPC 时，再跑对应的 e2e：

```powershell
npm run e2e:desktop:card-shell
npm run e2e:desktop:card-projects
npm run e2e:desktop:slash
npm run e2e:desktop:config-box
```

对话相关用例使用 `OWNER_AGENT_CHAT_FAKE=1` 的假流，**不要**在测试里调真实模型或真实网络。

## 代码约定

- **注释一律中文**；模块/函数写清「为什么」，不复述代码。
- `views` 保持薄：事件绑定与 DOM 在 `desktop/`，判定与业务规则放 `src/`。
- 新增可执行文件（`.mjs/.cjs/.js`）必须加入 `scripts/check-files.json`，否则 `npm run check` 不覆盖它。
- CSS 合并后检查花括号深度（编辑器不一定报错，后续规则会被静默吞掉）。
- 不引入新依赖前先说明理由；能用 SDK 已有的能力就不要自己拼。

## 方向性约束

这些是已经写进 ADR 的决定，改动需要在 issue 里先讨论：

- 观察层只读；写入按目的地分级（`docs/adr/0012-write-by-destination.md`）；
- 同一条事实只存一处，另一处只存指针（`docs/adr/0002-single-source-of-truth.md`）；
- 同步不宣告真相源，冲突交人（`docs/adr/0013-sync-conflict-hitl.md`）；
- 单入口卡片，不恢复多档位/多区面板（`docs/adr/0011-single-entry-card.md`）。

## 提交与 PR

- 一个 PR 做一件事；标题写「做了什么」，正文写「为什么」。
- 必须给出证据：测试输出、e2e 结果，或改动前后的截图。
- 涉及删除型改动（删文件、删能力）时，附上引用核对结果。
- 不要在 PR 里提交 `owner.sqlite`、`companion.json`、截图之外的本地状态或任何密钥。

## 报问题

用仓库的 issue 模板：

- Bug：复现步骤、期望/实际、环境、日志（**先删掉密钥与项目路径中的隐私**）；
- Feature：要解决的问题，而不是直接给实现方案；
- 安全漏洞：不要开公开 issue，见 [SECURITY.md](SECURITY.md)。
