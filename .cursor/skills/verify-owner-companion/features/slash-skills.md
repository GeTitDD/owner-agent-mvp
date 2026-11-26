# `/` 技能

## Sub-features

- 输入 `/` 打开技能面板：内置命令 / 数字快捷 / 全部技能
- 过滤：名字前缀优先（打 `ask` 先出 `ask-matt`），空格之后视为消息、不再是搜索
- 选中技能：输入框上方出现 `#skillChip` 胶囊，输入框只留问题
- 数字别名：`自定义` 可改 1-9，冲突当场提示
- 调用：胶囊 + 问题发送后，消息以技能名开头（`/ask-matt …`）

## How to get to it (user POV)

1. 输入框敲 `/`。
2. 面板从底部弹出，列出命令与技能。
3. 点一行（或 ↑↓ + 回车）：面板收起，输入框上方出现技能胶囊，输入框清空。
4. 写问题，回车。消息里显示 `/技能名 问题`。

## Driving it with CDP

```js
// 打开并过滤
input.value = '/ask';
input.dispatchEvent(new Event('input', { bubbles: true }));
await waitFor(panel, "document.querySelectorAll('#skillList .slash-item').length > 0", 20000);

// 点第一行技能
document.querySelector('#skillList .slash-item[data-kind="skill"]').click();
await waitFor(panel, "document.getElementById('skillPanel').hidden === true", 5000);

// 胶囊在输入框上方，输入框为空
document.getElementById('skillChipLabel').textContent;
document.getElementById('input').value;
```

断言点：

- `#skillChip` 的 `hidden === false`，文本是 `/技能名`（不带 `pstack:` 等来源前缀）；
- `#messages .msg` 数量不变（点击不发送、不落库）；
- 接着输入问题再回车，用户消息文本以 `/技能名 ` 开头。

## Gotchas

- 技能来自本机扫描（`PSTACK_DIR` / `MATT_SKILLS_DIR` / 域包 / 插件）。机器上没有技能时面板显示空态，不是功能坏了。
- 面板行的 `data-skill-row` 是完整 id（`matt:engineering/ask-matt`），显示名是最后一段；断言显示名时用 `#skillChipLabel`。
- playbook-only 技能（例如 `diagram-control`）会列出，但对话白名单不收，发送后会得到「没有这个技能」——这是预期。
- 打字里一旦出现空格，面板不再打开：`/发布 确认` 这类整句命令本来就该直接发送。
- 数字别名只影响数字快捷段，不改变技能名。
