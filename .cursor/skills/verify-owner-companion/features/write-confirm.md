# 写入确认卡

## Sub-features

- `/risk high` / `/risk low`：本地脚本化确认卡，不调模型、不执行真实写入
- 卡上四块：等级、三轴（影响面 / 可逆性 / 是否离开本机）、逐条完整路径、可折叠判据
- 四个动作：允许这一次 / 低风险免问（仅低风险可用）/ 我的判断不同 / 取消
- 「我的判断不同」展开等级与理由，提交后原判据保留、并列追加人工改判
- 取消：什么都不写，回执写明「取消」

## How to get to it (user POV)

1. 输入框敲 `/risk high`，回车。
2. 对话流出现一张高风险确认卡，列出将被写入的完整路径。
3. 点「我的判断不同」可以改判；点「允许这一次」会回一张脚本回执（本轮不执行真实写入）。
4. 点「取消」：卡被标记为已取消，没有文件被改动。

## Driving it with CDP

```js
// 发命令（本地分派，不走模型）
input.value = '/risk high';
input.dispatchEvent(new Event('input', { bubbles: true }));
document.getElementById('composer').requestSubmit();

await waitFor(panel, "document.querySelector('.block.type-risk')", 8000);

const card = await panel.evaluate(`(() => {
  const node = document.querySelector('.block.type-risk');
  return {
    text: node.textContent,
    actions: [...node.querySelectorAll('[data-risk-action]')].map((b) => b.dataset.riskAction)
  };
})()`);
// actions 应包含 allow / prefer-low / override / cancel

document.querySelector('.block.type-risk [data-risk-action="cancel"]').click();
```

副作用断言：取消前后临时 userData 里的文件系统快照一致；
`owner_chat_messages` 只多出「命令 + 回执」两条，没有写入记录。

## Gotchas

- 这是脚本卡：评估器仍是规则占位（按目的地 + 是否删除），判据文案不代表真实模型评估。
- 「低风险免问」在高风险卡上是禁用状态；外发与删除永远没有免问（见 `confirm-cards`）。
- 卡片的已答状态写在消息的 `answers` 里，不覆盖原消息文本。
- 真实写入路径（自有目录 / 项目目录 / 外发 / 删除）另见 `write-gate` 与 `project-write`；本 drive 只验卡片本身。
