// #105 卡片壳的消息流：纯函数，不碰 DOM、不发请求、不读配置。
//
// 为什么单独一个文件：壳的第一件事是「发一条话，流里出现什么」。
// 这条规则要能脱离 Electron 验证，所以把「能不能发」「发完流长什么样」
// 「哪一条是占位回复」都放在这里；shell.js 只负责把这些结果画出来。
// 双份导出：浏览器当普通脚本加载（挂到 window.OwnerShellThread），Node 测试用 require 读。
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerShellThread = api;
})(typeof globalThis === 'undefined' ? null : globalThis, () => {
  // 占位回复的标记：以后接真模型时，删掉这一条路径即可，不必改渲染。
  const PLACEHOLDER_SOURCE = 'placeholder';
  const PLACEHOLDER_PREFIX = '占位回复';
  // 占位回复里引用原话的上限：太长就截断，避免把整段再抄一遍。
  const QUOTE_LIMIT = 40;

  /** 空会话：一条消息都没有。数组本身就是状态，不额外包一层。 */
  const createThread = () => [];

  /** 正文判定：只有空白（含换行、制表）不算正文。IME 组字中的处理在渲染层，不放这里。 */
  const canSend = (text) => String(text ?? '').trim().length > 0;

  /** 发送前的清洗：去掉首尾空白，句中的换行原样保留。 */
  const normalize = (text) => String(text ?? '').trim();

  const quote = (text) => {
    const flat = normalize(text).replace(/\s+/gu, ' ');
    return flat.length > QUOTE_LIMIT ? `${flat.slice(0, QUOTE_LIMIT)}…` : flat;
  };

  /** 我的消息：role=user。渲染层据此决定气泡靠右、标注「我」。 */
  const addUserMessage = (messages, text) => {
    if (!canSend(text)) return messages;
    return [...messages, { role: 'user', text: normalize(text) }];
  };

  /**
   * 占位回复：内容自己说明来源，界面再挂一个「占位」徽章。
   * 双层标注是为了「复制出去也不被当成真回复」。
   */
  const placeholderText = (text) =>
    `（${PLACEHOLDER_PREFIX}）收到「${quote(text)}」。这条不是模型回的：单窗口骨架本轮只验证发送与排布。`;

  const addPlaceholderReply = (messages, text) => {
    if (!canSend(text)) return messages;
    return [...messages, {
      role: 'agent',
      text: placeholderText(text),
      placeholder: true,
      source: PLACEHOLDER_SOURCE
    }];
  };

  /** 一次发送 = 我的一条 + 一条占位回复。空输入返回原数组（渲染层据此不重画）。 */
  const sendTurn = (messages, text) => addPlaceholderReply(addUserMessage(messages, text), text);

  /** 判断某条消息是不是占位回复；渲染与测试共用同一个口径。 */
  const isPlaceholder = (message) =>
    Boolean(message) && message.placeholder === true && message.source === PLACEHOLDER_SOURCE;

  /**
   * 库里只有一段文本、没有 placeholder 标记（消息按角色与正文落库），
   * 所以「是不是占位回复」从正文开头的固定前缀认。#106 起会话切换要重放历史消息，
   * 判定口径必须和发送时写进去的那一句完全一致。
   */
  const isPlaceholderText = (text) => String(text ?? '').startsWith(`（${PLACEHOLDER_PREFIX}）`);

  /**
   * 把库里取回的消息行（role user/assistant）转成渲染用的消息：
   * assistant 在界面上叫 agent，占位回复补回标记，其余原样。
   */
  const fromStored = (rows) => (Array.isArray(rows) ? rows : []).map((row) => {
    const text = String(row?.text ?? '');
    const message = { role: row?.role === 'user' ? 'user' : 'agent', text };
    if (isPlaceholderText(text)) {
      message.placeholder = true;
      message.source = PLACEHOLDER_SOURCE;
    }
    return message;
  });

  /** 发送后输入框回到空；单列成函数是为了渲染层不各写一份清空逻辑。 */
  const draftAfterSend = () => '';

  return {
    PLACEHOLDER_SOURCE,
    PLACEHOLDER_PREFIX,
    createThread,
    canSend,
    addUserMessage,
    addPlaceholderReply,
    placeholderText,
    sendTurn,
    isPlaceholder,
    isPlaceholderText,
    fromStored,
    draftAfterSend
  };
});
