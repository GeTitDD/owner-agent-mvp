// 保守记录成功完成对话中已提供的引用；与任务执行 Usage 分离，不能据此推断采纳或收益。
import { canonical, sha256 } from '../utils.mjs';

export function recordCompletedChatReferences({ personalStore, memory, result, turnId, sessionId, projectId = '' } = {}) {
  if (!result?.ok || result.status !== 'ok') return { status: 'not-recorded', count: 0 };
  const items = memory?.items ?? [];
  if (!items.length) return { status: 'empty', count: 0 };
  try {
    const references = items.map(({ id, kind, revision }) => ({ id, kind, revision: revision ?? null }));
    const receipt = personalStore.recordChatReferences({ turnId, sessionId, projectId,
      contextHash: sha256(canonical({ text: memory.text, references })), items: references });
    return { status: 'recorded', count: receipt.count };
  } catch {
    // 回答已完成，计量故障不能把它改成模型失败；由调用方向人明确报告未保存。
    return { status: 'failed', count: 0, reason: '本轮引用记录未保存；回答仍保留，不计入引用次数。' };
  }
}
