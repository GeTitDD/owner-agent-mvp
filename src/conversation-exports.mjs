// 会话导出（#110）：把一段对话写成带上下文头的 Markdown，落到自有目录下的固定子目录。
//
//   <用户配置根>/conversations/<sessionId>.md
//
// 三条约束：
// 1. 正文转换只有一份实现：desktop/shell-copy.cjs。它吃的是 shell-blocks 归一化后的模型，
//    与界面上渲染的结构同源；这里不重新拼 Markdown。
// 2. 时间来自会话自己的 startedAt（由渲染层随上下文传入），不取「现在」，
//    所以同一会话重复导出得到逐字节相同的文件，内容没变时也不重写。
// 3. 目录名直接来自 sessionId：白名单字符 + 长度上限挡住 "../" 一类的路径穿越。
import fs from 'node:fs';
import path from 'node:path';
import copy from '../desktop/shell-copy.cjs';

export const CONVERSATIONS_DIR = 'conversations';
export const CONVERSATION_FILE_EXT = '.md';

const SESSION_ID_MAX = 120;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export class ConversationExportError extends Error {
  constructor(message, code = 'conversation_export_invalid', status = 400) {
    super(message);
    this.name = 'ConversationExportError';
    this.code = code;
    this.status = status;
  }
}

const fail = (message, code = 'conversation_export_invalid', status = 400) => {
  throw new ConversationExportError(message, code, status);
};

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const sessionIdOf = (value) => {
  const id = String(value ?? '').trim();
  if (!id || id.length > SESSION_ID_MAX || !SESSION_ID_PATTERN.test(id)) {
    fail('会话 id 不可用：只接受字母数字开头，且不能包含路径分隔符');
  }
  return id;
};

/**
 * 导出落点（纯函数）：<root>/conversations/<sessionId>.md。
 * root 由调用方给（桌面端是 userData，测试是临时目录），本模块不猜用户目录。
 */
export function conversationExportFiles({ root, sessionId } = {}) {
  const base = String(root ?? '').trim();
  if (!base) fail('会话导出根目录不能为空');
  const id = sessionIdOf(sessionId);
  const dir = path.join(base, CONVERSATIONS_DIR);
  return { dir, filePath: path.join(dir, `${id}${CONVERSATION_FILE_EXT}`) };
}

/** 正文渲染（纯函数）：委托给与界面同源的 shell-copy，不在这里重写一遍。 */
export function renderConversationMarkdown({ context, messages } = {}) {
  if (!isObject(context)) fail('会话上下文必须是对象');
  if (!Array.isArray(messages)) fail('会话消息必须是数组');
  return copy.conversationToMarkdown({ context, messages });
}

/** 内容没变就不重写：重复导出不产生新的 mtime，也不碰已经核对过的文件。 */
const writeIfChanged = (file, content) => {
  const next = Buffer.from(content, 'utf8');
  try {
    if (fs.readFileSync(file).equals(next)) return false;
  } catch {
    // 文件不存在或读不了：继续写。
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return true;
};

/** 写出一份会话导出（文件落盘），返回路径、正文与是否真的重写。 */
export function writeConversationExport({ root, sessionId, context, messages } = {}) {
  const files = conversationExportFiles({ root, sessionId });
  const markdown = renderConversationMarkdown({ context, messages });
  const changed = writeIfChanged(files.filePath, markdown);
  return {
    dir: files.dir,
    path: files.filePath,
    markdown,
    changed,
    bytes: Buffer.byteLength(markdown, 'utf8')
  };
}
