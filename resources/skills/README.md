# 应用自带技能

此目录是发行资源，不是用户的工具安装目录。首次启动无需下载或扫描个人主目录。
`package.json` 的发行文件清单包含整个 `resources/skills`。

| 技能包 | 上游仓库 | 固定修订 | 技能数 |
| --- | --- | --- | --- |
| pstack | `GeTitDD/pstack-pi` | `c0fad966590d24043d9a74c0fec6a722b1ad121d` | 53 |
| Matt Pocock | `mattpocock/skills` | `6f7f7831a625f040a8e06a0e7954826b87ce775a` | 39 |

每个包保留上游 `skills/`、`README.md` 和 MIT `LICENSE`，正文与辅助文件不翻译、不改写。
`manifest.json` 记录固定修订、相对路径和每个上游文件的 SHA-256；单元测试验证完整性。
本次从上游 Git 提交归档资源，没有复制用户工作区未提交的改动或任何凭据。

更新时显式选择新提交，重新归档相同目录、更新清单摘要，再运行
`node --test tests/bundled-skills.test.mjs` 与 `npm run e2e:desktop:bundled-skills`。
应用运行期间不自动拉取上游，也不执行技能包附带的脚本。

技能提供方法和上下文，仍受 Owner Companion 的只读模型工具边界约束。
提供原版 TDD、安装或实现方法，不意味着本应用已经具备其中要求的写文件、终端、浏览器或子代理能力。
用户明确指定的外部 pstack/matt 路径可覆盖随包来源；个人目录扩展仅显式开启时扫描。
