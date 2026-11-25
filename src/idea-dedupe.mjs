// 灵感去重键：来源 + 空白归一后的正文。
//
// 单独一个文件是为了打断循环依赖：owner-store 需要这个键做「同一条不重复入队」，
// 而 idea-entry 的收件箱原文上限又要从 owner-store 导入。键留在 idea-entry 里会让
// 两个模块互相 import；挪到这里之后，依赖是 单向的 idea-entry → owner-store → idea-dedupe。
//
// 只归空白，不折叠大小写、不改标点：同一条应该真的同一段话，
// 而不是「看起来差不多」就被吞掉。

/**
 * 去重键：来源 + 空白归一后的正文。
 * @param {{rawText?: string, captureSource?: string}} [input]
 * @returns {string}
 */
export function ideaDedupeKey({ rawText = '', captureSource = 'paste' } = {}) {
  const text = String(rawText ?? '').replace(/\s+/gu, ' ').trim();
  return `${String(captureSource ?? 'paste')}\u0000${text}`;
}
