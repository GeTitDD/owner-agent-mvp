// Drive：发一条消息，验证「落库 → 回答 → 输入框清空 → 助手消息可读」。
export default async function chat(session) {
  const { panel, waitFor, sleep, shot } = session;
  const count = () => panel.evaluate(
    "document.querySelectorAll('#messages .msg:not([data-streaming])').length"
  );

  const before = await count();
  if (before !== 0) throw new Error(`隔离实例应从一个空会话开始，实际有 ${before} 条`);

  await panel.evaluate(`(() => {
    const input = document.getElementById('input');
    input.focus();
    input.value = '验证：请回答一句';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('composer').requestSubmit();
  })()`);

  await waitFor(panel, "document.querySelectorAll('#messages .msg:not([data-streaming])').length >= 2", 30000);
  await sleep(400);

  const thread = await panel.evaluate(`(() => {
    const items = [...document.querySelectorAll('#messages .msg:not([data-streaming])')];
    return {
      count: items.length,
      texts: items.map((node) => node.querySelector('.bubble')?.textContent ?? ''),
      input: document.getElementById('input').value,
      button: document.getElementById('send').textContent.trim(),
      draft: document.getElementById('input').value
    };
  })()`);

  if (thread.count !== 2) throw new Error(`应有 2 条消息（问 + 答），实际 ${thread.count}`);
  if (!thread.texts[0].includes('验证：请回答一句')) throw new Error(`用户消息不对：${thread.texts[0]}`);
  if (!thread.texts[1].includes('假回答')) throw new Error(`回答不像 fake 流：${thread.texts[1]}`);
  if (thread.input !== '') throw new Error('发送后输入框应清空');
  if (thread.button !== '发送') throw new Error(`发送按钮应恢复「发送」，实际「${thread.button}」`);

  const db = session.ownerDb();
  const rows = db.prepare(
    "SELECT role, text FROM owner_chat_messages ORDER BY seq ASC"
  ).all();
  db.close();
  if (rows.length !== 2) throw new Error(`库里应有 2 条消息，实际 ${rows.length}`);
  if (rows[0].role !== 'user' || rows[1].role !== 'assistant') {
    throw new Error(`库里角色顺序不对：${rows.map((row) => row.role).join(',')}`);
  }

  await shot('chat.png');
  console.log(`chat: ${rows.length} rows, answer=${rows[1].text.slice(0, 20)}…`);
}
