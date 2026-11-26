# `@@` 方法

## Sub-features

- 输入 `@@` 打开方法菜单：生成 prompt / 关联项目 / 关联会话 / 分享到飞书
- 点方法进入该方法卡；卡上有返回与关闭
- 菜单是临时提示：正文不再以 `@@` 结尾就收起
- Esc 关闭；单个 `@`、`a@@b`、`@@@` 都不触发

## How to get to it (user POV)

1. 输入框敲 `@@`（两个连续 at）。
2. 输入框上方出现「@@ 要做什么 · 方法菜单」小卡片。
3. 点一行进入方法卡；卡里有自己的标题与控件。
4. 返回回到菜单，关闭或 Esc 收起，正文不变。

## Driving it with CDP

```js
input.value = '@@';
input.dispatchEvent(new Event('input', { bubbles: true }));
await waitFor(panel, "document.getElementById('atPanel') && !document.getElementById('atPanel').hidden", 5000);

const methods = await panel.evaluate(
  "[...document.querySelectorAll('.at-method')].map((n) => n.dataset.atMethod)"
);
// ['prompt', 'project', 'session', 'share']

document.querySelector('.at-method[data-at-method="prompt"]').click();
await waitFor(panel, "document.getElementById('atTitle').textContent.includes('生成 prompt')", 5000);
// 方法内容由方法自己 mount 到 #atBody
const bodyText = await panel.evaluate("document.getElementById('atBody').textContent");
```

断言点：`#atPanel` 可见、方法键顺序固定、进入方法后 `#atTitle` 变成方法名、
`#atBody` 有该方法的控件；正文文本没有被改写（`#input` 仍是 `@@`）。

## Gotchas

- 必须以输入**末尾**的 `@@` 触发；单个 `@` 与邮箱地址不拦。
- 输入以 `/` 开头时 `/` 面板优先，`@@` 面板会收起。
- 菜单没有键盘选中项：在 `@@` 面板里直接回车会关面板并照常发送，不会「吃掉」消息。
- 方法卡是有状态的任务卡，正文变化不会自动关闭它，只能返回 / 关闭 / Esc。
