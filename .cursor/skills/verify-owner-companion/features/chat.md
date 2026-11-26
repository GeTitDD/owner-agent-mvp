# 对话

## Sub-features

- 发送普通消息（回车或点发送）
- 流式回答：`生成中` 临时气泡 → 助手消息落库
- 停止：流式中按钮变「停止」，停下保留已产出部分并标「已停止」
- 引导 / 中止：流式中再发一句的两种插入方式（输入框左上的 `#insertMode`）
- 撤回上一轮：最后一条助手消息悬停出现「撤回」，问题原文回到输入框
- 思考过程：默认折叠，不写入会话

## How to get to it (user POV)

1. 顶栏「会话」里已有当前会话（隔离实例已建好一条，也可以点「新建」）。
2. 在底部输入框写一句，按回车。
3. 回答逐字出现；此时按钮是「停止」，输入框已清空。

## Driving it with CDP

```powershell
node .cursor/skills/verify-owner-companion/scripts/run-feature.mjs .cursor/skills/verify-owner-companion/scripts/drives/chat.mjs
```

drive 里做了四件事：

```js
// 发送（等价回车）
input.value = '验证：请回答一句';
input.dispatchEvent(new Event('input', { bubbles: true }));
document.getElementById('composer').requestSubmit();

// 等落库后的消息（排除流式临时节点）
await waitFor(panel, "document.querySelectorAll('#messages .msg:not([data-streaming])').length >= 2", 30000);

// 副作用：库里正好两行，user 在前
db.prepare('SELECT role, text FROM owner_chat_messages ORDER BY seq').all();

// 截图
await shot('chat.png');
```

停止与撤回没有放进默认 drive（会拉长验证时间），需要时照同样的路径做：
点 `#send`（流式中）→ 等 `#send` 文本回到「发送」→ 断言气泡含「已停止」；
点 `.rewind-affordance` → 断言消息数减 2 且 `#input` 里是被撤回的问题。

## Gotchas

- 默认 `OWNER_AGENT_CHAT_FAKE=1`，回答固定是 `（假回答）…`；要验证真实模型需自己提供凭据并把 `fakeChat` 关掉，**不要**在提交的 drive 里调真模型。
- 流式节点带 `data-streaming="true"`，任何「消息条数」断言都要排除它。
- 全局会话（未选项目）不读项目文件；验证项目上下文要先选项目。
- 停止是从按下发送那一刻就生效的：准备阶段（刷新对话流）点停止会记 `pendingAbort`，请求一发出立刻中止。
- 撤回只对「最后一条助手消息」出现，且流式中不可用。
