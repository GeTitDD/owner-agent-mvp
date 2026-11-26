// #123 `@@` →「生成 prompt」：流内勾选、计数、指令、组装四段、结果落流。
//
// 边界：这一块只管该方法自己的两件事——
//   1) 纯函数：勾选集合的增删、引用标签的编号、prompt 的分段组装（可脱离 Electron 断言）；
//   2) 卡片里的那点 DOM：计数、指令框、生成按钮，以及和对话流的勾选态联动。
// 方法菜单 / 方法卡外壳仍归 shell-at.cjs；消息渲染与勾选落点归 shell-stream.cjs。
// 生成结果按普通消息落库（一条带 code 块的回复），复制沿用 #110 的块复制。
// 双份导出：浏览器当普通脚本加载（挂到 window.OwnerShellAtPrompt），Node 测试用 require 读。
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerShellAtPrompt = api;
})(typeof globalThis === 'undefined' ? null : globalThis, () => {
  const list = (value) => (Array.isArray(value) ? value : []);
  const str = (value) => (value === undefined || value === null ? '' : String(value));

  /**
   * 这条消息能不能被勾选：引用的是「原文」，没有文字的消息（只有块）没有可引用的正文。
   * 视觉上不拦、不置灰，只是点了不进入勾选集合——避免生成出空引用。
   */
  const isSelectable = (message) => str(message?.text).trim().length > 0;

  /** 空勾选集合：每次进方法都从零开始，不带上一次的残留。 */
  const emptySelection = () => new Set();

  /**
   * 勾选 / 取消一条：返回新集合，不改入参。
   * 下标必须是消息序列里的非负整数；不合法就原样返回一份副本，不产生半截状态。
   */
  const toggleSelection = (selected, index) => {
    const next = new Set(selected instanceof Set ? selected : []);
    const key = Number(index);
    if (!Number.isInteger(key) || key < 0) return next;
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  /**
   * 引用标签：我的提问与助手的回复各自独立编号。
   *   - 第 1 条用户消息 →「我的第 1 句」
   *   - 第 1 条助手消息 →「第 1 条回复」（不因为中间夹了提问而顺延）
   * 返回与消息序列等长的数组，未选中的下标也有标签，调用方按需取。
   */
  const referenceLabels = (messages) => {
    let mine = 0;
    let replies = 0;
    return list(messages).map((message) => (
      message?.role === 'user' ? `我的第 ${(mine += 1)} 句` : `第 ${(replies += 1)} 条回复`
    ));
  };

  /**
   * 上下文三行：项目 / 会话 / 时间。缺哪行就少哪行，全缺时整段省略。
   * 值只做首尾空白清理，不在中间改写（时间、标题都按会话记录原样给出）。
   */
  const contextLines = (context) => {
    const rows = [
      ['项目', str(context?.project).trim()],
      ['会话', str(context?.session).trim()],
      ['时间', str(context?.time).trim()]
    ];
    return rows.filter(([, value]) => value).map(([key, value]) => `- ${key}：${value}`);
  };

  /** 原文引用：逐行加引用符，行内容一个字符都不动；换行统一成 \n 只是表达形式。 */
  const blockquote = (text) => str(text)
    .replace(/\r\n?/gu, '\n')
    .replace(/\n+$/u, '')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

  /**
   * 组装 prompt：四段，按固定顺序；空段整段不出现。
   *
   *   # 指令                      ← 指令原文（trim 后为空就不出现）
   *   # 上下文                    ← 项目 / 会话 / 时间（三行都空就不出现）
   *   ## 引用对话（原文）          ← 勾选的消息，逐条「标签 + 引用」，顺序按消息序列
   *   # 我需要你                  ← 收尾复述同一句指令（指令为空就不出现）
   *
   * 「我需要你」只复述、不扩写：这一票只有一个指令输入，票面又要求填了指令后四段都在；
   * 复述同一句话既满足结构，也不替用户编造意图。引用一律原文，不改写、不摘要。
   */
  const buildPrompt = ({ instruction, context, messages, selected } = {}) => {
    const ask = str(instruction).trim();
    const rows = list(messages);
    const labels = referenceLabels(rows);
    const picked = [...(selected instanceof Set ? selected : list(selected))]
      .map((index) => Number(index))
      .filter((index) => Number.isInteger(index) && index >= 0 && index < rows.length)
      .filter((index) => isSelectable(rows[index]))
      .sort((a, b) => a - b);

    const sections = [];
    if (ask) sections.push(`# 指令\n\n${ask}`);

    const contextRows = contextLines(context);
    if (contextRows.length) sections.push(`# 上下文\n\n${contextRows.join('\n')}`);

    const quotes = picked.map((index) => (
      `**${labels[index]}**\n\n${blockquote(rows[index].text)}`
    ));
    if (quotes.length) sections.push(`## 引用对话（原文）\n\n${quotes.join('\n\n')}`);

    if (ask) sections.push(`# 我需要你\n\n${ask}`);
    return sections.join('\n\n');
  };

  /** 卡片上的计数文案：只报数字与单位，不写「请选择」之类的额外句子。 */
  const countText = (count) => `已选 ${Number.isInteger(count) && count > 0 ? count : 0} 条`;

  /** 组装前从会话与顶栏取上下文；项目名走 shell-projects 的同一份叫法。 */
  const contextOf = (ctx, session) => {
    const viewProjectId = ctx.ui.header.viewProjectId();
    const projects = typeof ctx.ui.header.projects === 'function' ? ctx.ui.header.projects() : [];
    return {
      project: ctx.projectsApi.scopeLabel(projects, viewProjectId),
      session: session ? ctx.listApi.titleOf(session) : '',
      time: str(session?.createdAt).trim()
    };
  };

  /**
   * 在方法卡里挂上 prompt 的控件：计数、指令、生成。
   * 返回清理函数：收起勾选态、退订计数监听——关闭 / 返回都走这一条，没有副作用。
   */
  const mount = (ctx) => (wrap, tools = {}) => {
    const stream = ctx.ui.stream;
    if (!stream) {
      wrap.append(document.createTextNode('对话流还没准备好，稍等一下再进这个方法。'));
      return null;
    }

    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    const box = el('div', 'at-prompt');
    const count = el('p', 'at-prompt-count', countText(stream.selectionCount()));
    const label = el('label', 'at-prompt-label', '指令（可空）');
    label.htmlFor = 'atPromptInstruction';
    const field = el('textarea', 'at-prompt-input');
    field.id = 'atPromptInstruction';
    field.rows = 2;
    field.placeholder = '例如：把这段对话整理成决策记录';
    const actions = el('div', 'at-prompt-actions');
    const generate = el('button', 'at-prompt-generate', '生成');
    generate.type = 'button';
    generate.disabled = stream.selectionCount() === 0;
    actions.append(generate);
    box.append(count, label, field, actions);
    wrap.append(box);

    let busy = false;

    /** 勾选变化只改计数与按钮可用性，不重画方法卡。 */
    const sync = () => {
      const total = stream.selectionCount();
      count.textContent = countText(total);
      generate.disabled = busy || total === 0;
    };

    const unsubscribe = stream.onSelectionChange(sync);
    // 进入方法就进勾选态；选中的消息在流里点，卡片不拦（mousedown 由对话流自己处理）。
    stream.setSelectMode(true);
    sync();

    const build = () => {
      const messages = stream.messages();
      return buildPrompt({
        instruction: field.value,
        context: contextOf(ctx, ctx.ui.header.currentSession()),
        messages,
        selected: new Set(stream.selectedIndexes())
      });
    };

    const generatePrompt = async () => {
      if (busy) return;
      const picked = stream.selectedIndexes();
      if (picked.length === 0) {
        ctx.notify('先在对话流里勾选要引用的消息', 'error');
        return;
      }
      if (!ctx.store) {
        ctx.notify('会话存储不可用，生成结果没法落进对话流', 'error');
        return;
      }
      const sessionId = ctx.ui.header.currentId();
      if (!sessionId) {
        ctx.notify('没有当前会话，先新建一个', 'error');
        return;
      }
      busy = true;
      sync();
      try {
        const prompt = build();
        await ctx.report('生成 prompt', async () => {
          // 结果是一条普通回复：正文为空，只有一个 code 块，复制按钮来自 #110。
          await ctx.store.append({
            id: sessionId,
            role: 'assistant',
            text: '',
            blocks: [{ type: 'code', title: '生成的 prompt', lang: 'markdown', code: prompt }]
          });
          // 生成后退出勾选态、收卡片、焦点回输入框：顺序固定，先关再刷新。
          if (typeof tools.close === 'function') tools.close();
          else stream.setSelectMode(false);
          await ctx.refreshThread();
          ctx.ui.compose.focus();
          ctx.notify('已生成 prompt，落进对话流，可一键复制', 'ok');
        });
      } finally {
        busy = false;
        sync();
      }
    };

    generate.addEventListener('click', () => { void generatePrompt(); });

    return () => {
      unsubscribe();
      stream.setSelectMode(false);
    };
  };

  return {
    isSelectable,
    emptySelection,
    toggleSelection,
    referenceLabels,
    buildPrompt,
    countText,
    contextOf,
    mount
  };
});
