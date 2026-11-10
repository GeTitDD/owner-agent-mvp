// pstack Playbook 子进程：把模型会话隔离在主进程之外，避免长任务拖死 UI。
//
// 主进程通过 fork + IPC 发送一次 run 请求；结果/错误通过 IPC 返回。
import { PlaybookRunner } from '../src/pstack/playbook-runner.mjs';

// 等待 IPC 消息真正写出后再退出：结果里带 diagram/text 时体积较大，
// 直接 process.exit 可能把还没 flush 的消息丢掉（父进程会看到“子进程退出（0）”）。
const send = (payload) => new Promise((resolve) => {
  try {
    process.send(payload, () => resolve());
  } catch {
    resolve();
  }
});

process.on('message', async (message) => {
  if (!message || message.type !== 'run') return;
  try {
    const runner = new PlaybookRunner({
      model: message.model || '',
      timeoutMs: Number(message.timeoutMs) || 240000,
      // 只读分析不需要 Monty/Python；关闭它可以避免额外弹出控制台进程。
      python: false
    });
    const result = await runner.run({
      playbookId: message.playbookId,
      project: message.project,
      task: message.task || '',
      digest: message.digest || ''
    });
    await send({ type: 'result', result });
  } catch (error) {
    await send({ type: 'error', error: String(error?.stack ?? error?.message ?? error) });
  } finally {
    // 给 IPC 一点时间把结果送出，再退出。
    setTimeout(() => process.exit(0), 200);
  }
});

// 父进程等到 ready 再发 run，避免 IPC 消息早于监听器注册。
process.send?.({ type: 'ready' });
