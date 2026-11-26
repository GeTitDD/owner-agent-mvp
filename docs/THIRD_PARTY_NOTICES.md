# Third-party notices

本项目包含来自以下开源项目的代码或资源。原始许可证与版权归原作者所有。

## Cindy (makecindy/cindy)

- 来源：https://github.com/makecindy/cindy
- 许可：Apache License 2.0
- 使用范围：
  - `desktop/assets/mascots/`：Agent Island 皮肤资源（Cindy 的 `native/agent-island/mascots` 与 `renderer/assets/agent-island-pululu.svg`）。
  - 会话阶段命名（`running` / `needs-interaction` / `completed` / `error`）与皮肤 id 集合，用于 `src/mascots.mjs`。
  - `desktop/shell.css`、`desktop/pet.css` 中的部分颜色与圆角取值，取自 Cindy 的语义设计令牌。
  - `desktop/shell.html` / `shell.js` / `shell-stream.cjs` 的活动流与 Composer 卡片结构参考其
    `ComposerCard.tsx`、`ListComposerTextarea.tsx` 与 Agent Island 活动行模型。
- 未使用：Cindy 的 React 渲染栈、macOS 原生灵动岛实现、声音系统与远程会话同步。

## Codex Pet / Petdex package convention

- 参考：Codex Pet 社区包格式（`pet.json` + spritesheet，8×9 / 8×11）与 Petdex 的“导入/一键切换”体验。
- 使用范围：仅借鉴公开的包字段与状态行命名；`src/mascots.mjs`、`desktop/pet.js` 中的解析与动画逻辑为本项目实现。
- 未包含：Codex Pet / Petdex 的代码、运行时、在线图库或美术资源。

Apache License 2.0 全文：https://www.apache.org/licenses/LICENSE-2.0

```
Copyright 2025 XD Inc. and Cindy contributors
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```
