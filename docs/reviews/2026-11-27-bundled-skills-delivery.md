# 第十二批：自带技能与 slash 指定身份

日期：2026-11-27。用户要求技能按来源高亮并实际调用，并进一步明确 pstack/Matt Pocock 应随应用分发，不依赖本机另行安装。

## 用户旅程与修复

打开应用 → 输入 `/` → 优先看真实技能；中文应用命令默认折叠，可以展开或按名字直接搜索。
输入名称、点击或回车选中 → 蓝色来源标签与问题分开 → 明确发送 → 消息仍保留指定技能标签。
手输/粘贴 `/技能名 `、制表符或换行也走相同绑定流程，保留多行正文。

复现并修复两个根因：

- 输入 `/reliable-retries ` 后没有任何已选高亮；以前只在菜单点击时设置选中状态，手输只在发送阶段解析。
- 冷目录中刚输入就发送，草稿检查把附加的关联元数据也纳入比较，误报「输入已变化」；现在只比草稿实际字段，并避免目录响应在发送中改写输入。

未知命令保留原文并说明原因，不静默作为普通模型问答。
同名技能保留完整来源身份，短名歧义时必须明确选择；禁用条目不伪装成可调用。
中文输入法组字期间不搬动文本；取消标签、错误、会话切换和重启均保留原有草稿边界。
有效选择撤下上一个技能错误提示，失败目录保留原位重试，不因重新打开菜单而悄悄吞掉错误。

## 随应用分发

资源位于 `resources/skills/`：

| 来源 | 固定修订 | 可读技能 |
| --- | --- | --- |
| pstack | `c0fad966590d24043d9a74c0fec6a722b1ad121d` | 53 |
| Matt Pocock | `6f7f7831a625f040a8e06a0e7954826b87ce775a` | 39 |

保留原版正文、辅助参考、README 和 MIT 许可证，清单记录每个文件的摘要。
默认目录指向应用资源；发行配置显式包含该资源，不复制个人 API 配置、Pi 登录或本机路径。
应用启动不克隆仓库，不自动扫描 `.agents/skills` 或 Codex 技能目录；外部目录只是显式扩展。
目录、模型会话与消息标签共用完整身份，显示 pstack / Matt Pocock 与「应用内置」。

## 验收与证据

- `npm test`：1362 项，1357 通过、5 跳过、0 失败。
- `npm run check`：317 个清单文件通过；包含随包的上游 CJS 辅助文件，但仅检查语法、不执行。
- `npm run e2e:desktop:skill-invocation`：49 项检查，5 张截图。含冷目录立即发送、真实 SDK 请求正文、中文组字事件、同名隔离、取消、重启、会话草稿与 380×560 窗口。
- `npm run e2e:desktop:bundled-skills`：30 项检查、7 张截图。在没有个人技能安装的隔离 HOME 中启动，验证两套随包来源、选择、实际 SDK 请求和标签。
- 桌面回归、发行包加载和最终截图结果见本报告末尾的最终读回记录。

模型返回值来自本机 HTTP/SSE 夹具；应用、原生 IPC、SQLite、Git 资源、已安装 SDK 和请求构造均走真实路径。
本批未追加真实模型调用，不声称固定回复证明了真实模型的语义采纳质量。

截图已经实际打开检查浅色、深色、同名来源、长技能名、小窗口、取消按钮和发送后标签：

- [手输后高亮](assets/2026-11-27-skill-invocation/01-typed-skill-light.png)
- [深色高亮](assets/2026-11-27-skill-invocation/02-typed-skill-dark.png)
- [小窗口长技能名](assets/2026-11-27-skill-invocation/05-small-window-long-name.png)
- [技能优先的菜单](assets/2026-11-27-bundled-skills/01-commands-and-skills.png)
- [两个来源的 tdd](assets/2026-11-27-bundled-skills/02-sources-same-name.png)
- [Matt 选中状态](assets/2026-11-27-bundled-skills/04-matt-selected.png)
- [Matt 深色状态](assets/2026-11-27-bundled-skills/05-matt-dark.png)

## 边界

内置的是技能方法包，不是安装 Pi 扩展。当前仍是只读模型会话，不会因为选中 TDD、实现或安装技能而自动获得写文件、执行终端、浏览器或子代理能力。
超过现有 6000 字上限的正文仍会明确标注截断，未扩展为无限上下文。
原中文应用命令保持为应用能力，未批量伪造新技能。既有历史消息不会仅凭 slash 文本被追认为实际技能调用。
macOS 验收不等于 Windows 真机或签名发行验收；本地改动未提交或推送，整体体验迭代继续进行。

## 最终读回记录

- 新 slash 旅程：49 项通过；随包默认旅程：30 项通过；旧技能发现旅程：80 项通过。
- slash、card-shell、card-projects、config-box 四套必跑回归全部通过，进程均正常退出。
- macOS arm64 目录构建成功，使用本机 Electron 加载产物 `app.asar`，在隔离 HOME 下完成 31 项检查；pstack/Matt 正文实际从 `app.asar/resources/skills` 读取并进入两次本机 SDK 请求。不是仅检查发行文件列表。
- 这次目录构建未签名，不代表 Windows 发行或安装器验收。构建日志仍有已有的默认图标和依赖去重提示。
- 12 张新旅程截图及正常预览截图已实际打开检查；增加蓝色标签后重新捕获截图，并检查默认收起中文命令的菜单。
- 正常预览已经重启到新代码，主模型仍为用户指定的 DeepSeek 配置；实际目录读回 pstack 53、Matt Pocock 39、本机自动扫描 0，两套默认来源均标记为应用内置。
- 用户未发送的输入原样保留；撤下了此前由本轮演示选择的旧本机技能标签，菜单已打开为随应用提供的来源，没有代替用户发送消息。
- 未提交、推送、发布或追加真实模型调用。保留此前全部未提交工作。

本机验收原始结果：`.verify/final-packaged/acceptance.json`、`.verify/final-discovery/acceptance.json`、
`.verify/skill-final-full.log`、`.verify/skills-package-final.log`。
可归档截图和新旅程结果位于本报告引用的 `assets/2026-11-27-*skills*` 与 `assets/2026-11-27-skill-invocation/`。
