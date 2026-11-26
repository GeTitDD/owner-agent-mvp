// 对话气泡的轻量 Markdown：标题、粗体、斜体、行内代码、围栏代码、列表、引用、分隔线、链接。
//
// 为什么自己写而不是用 marked：渲染必须直接建 DOM，不能把模型输出塞进 innerHTML。
// 这里只做「够聊天看」的子集，未识别的语法原样当文字，不会丢内容。
// 双份导出：浏览器挂到 window.OwnerShellMarkdown，Node 测试直接 require 解析函数。
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerShellMarkdown = api;
})(typeof globalThis === 'undefined' ? null : globalThis, () => {
  const FENCE = /^```([\w+-]*)\s*$/u;
  const HEADING = /^(#{1,6})\s+(.+)$/u;
  const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/u;
  const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.+)$/u;
  const QUOTE = /^>\s?(.*)$/u;

  /** 行内：先切代码与链接，再处理粗体/斜体；不做 HTML 解析。 */
  const parseInline = (text) => {
    const source = String(text ?? '');
    const tokens = [];
    let buffer = '';
    const flush = () => {
      if (buffer) { tokens.push({ type: 'text', text: buffer }); buffer = ''; }
    };
    let index = 0;
    while (index < source.length) {
      const char = source[index];
      if (char === '`') {
        const end = source.indexOf('`', index + 1);
        if (end > index + 1) {
          flush();
          tokens.push({ type: 'code', text: source.slice(index + 1, end) });
          index = end + 1;
          continue;
        }
      }
      if (char === '[') {
        const close = source.indexOf(']', index + 1);
        const open = close >= 0 ? source.indexOf('(', close) : -1;
        const end = open >= 0 ? source.indexOf(')', open) : -1;
        if (close > index && open === close + 1 && end > open) {
          const href = source.slice(open + 1, end).trim();
          if (/^(?:https?:|mailto:)/iu.test(href)) {
            flush();
            tokens.push({ type: 'link', href, text: source.slice(index + 1, close) });
            index = end + 1;
            continue;
          }
        }
      }
      if (source.startsWith('**', index)) {
        const end = source.indexOf('**', index + 2);
        if (end > index + 2) {
          flush();
          tokens.push({ type: 'strong', children: parseInline(source.slice(index + 2, end)) });
          index = end + 2;
          continue;
        }
      }
      if (char === '*' && source[index + 1] !== '*') {
        const end = source.indexOf('*', index + 1);
        if (end > index + 1) {
          flush();
          tokens.push({ type: 'em', children: parseInline(source.slice(index + 1, end)) });
          index = end + 1;
          continue;
        }
      }
      buffer += char;
      index += 1;
    }
    flush();
    return tokens;
  };

  /**
   * 把 Markdown 切成块。返回纯数据，渲染层再建 DOM。
   * 支持：围栏代码、标题、分隔线、引用、列表、段落（段内换行保留为软换行）。
   */
  const parseMarkdown = (text) => {
    const lines = String(text ?? '').replace(/\r\n?/gu, '\n').split('\n');
    const blocks = [];
    let index = 0;

    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) { index += 1; continue; }

      const fence = FENCE.exec(line);
      if (fence) {
        const lang = fence[1] || '';
        index += 1;
        const body = [];
        while (index < lines.length && !FENCE.test(lines[index])) {
          body.push(lines[index]);
          index += 1;
        }
        index += 1; // 跳过收尾围栏（没闭合就到结尾）
        blocks.push({ type: 'code', lang, text: body.join('\n') });
        continue;
      }

      const heading = HEADING.exec(line);
      if (heading) {
        blocks.push({ type: 'heading', level: heading[1].length, inline: parseInline(heading[2]) });
        index += 1;
        continue;
      }

      if (RULE.test(line.trim())) {
        blocks.push({ type: 'rule' });
        index += 1;
        continue;
      }

      if (QUOTE.test(line)) {
        const body = [];
        while (index < lines.length && QUOTE.test(lines[index])) {
          body.push(QUOTE.exec(lines[index])[1]);
          index += 1;
        }
        blocks.push({ type: 'quote', blocks: parseMarkdown(body.join('\n')) });
        continue;
      }

      if (LIST.test(line)) {
        const ordered = /^\d/u.test(LIST.exec(line)[2]);
        const items = [];
        while (index < lines.length && LIST.test(lines[index])) {
          const match = LIST.exec(lines[index]);
          items.push({ inline: parseInline(match[3]) });
          index += 1;
        }
        blocks.push({ type: 'list', ordered, items });
        continue;
      }

      // 段落：连续非空、且不是其他块起始的行。
      const body = [];
      while (index < lines.length) {
        const current = lines[index];
        if (!current.trim()) break;
        if (FENCE.test(current) || HEADING.test(current) || RULE.test(current.trim())
          || QUOTE.test(current) || LIST.test(current)) break;
        body.push(current);
        index += 1;
      }
      if (body.length) {
        blocks.push({ type: 'paragraph', inline: parseInline(body.join('\n')) });
      }
    }
    return blocks;
  };

  /** 浏览器渲染：只用 createElement/textContent，链接只放行 http(s)/mailto。 */
  const renderInto = (node, text) => {
    if (!node || typeof document === 'undefined') return node;
    node.replaceChildren();
    const renderInline = (parent, tokens) => {
      for (const token of tokens) {
        if (token.type === 'text') {
          const parts = token.text.split('\n');
          parts.forEach((part, position) => {
            if (position > 0) parent.append(document.createElement('br'));
            if (part) parent.append(document.createTextNode(part));
          });
        } else if (token.type === 'code') {
          parent.append(Object.assign(document.createElement('code'), { textContent: token.text }));
        } else if (token.type === 'strong') {
          const strong = document.createElement('strong');
          renderInline(strong, token.children);
          parent.append(strong);
        } else if (token.type === 'em') {
          const em = document.createElement('em');
          renderInline(em, token.children);
          parent.append(em);
        } else if (token.type === 'link') {
          const link = document.createElement('a');
          link.href = token.href;
          link.target = '_blank';
          link.rel = 'noreferrer noopener';
          link.textContent = token.text;
          parent.append(link);
        }
      }
    };
    const renderBlocks = (parent, blocks) => {
      for (const block of blocks) {
        if (block.type === 'heading') {
          const heading = document.createElement(`h${Math.min(4, Math.max(2, block.level + 1))}`);
          renderInline(heading, block.inline);
          parent.append(heading);
        } else if (block.type === 'paragraph') {
          const paragraph = document.createElement('p');
          renderInline(paragraph, block.inline);
          parent.append(paragraph);
        } else if (block.type === 'code') {
          const pre = document.createElement('pre');
          const code = document.createElement('code');
          if (block.lang) code.dataset.lang = block.lang;
          code.textContent = block.text;
          pre.append(code);
          parent.append(pre);
        } else if (block.type === 'list') {
          const list = document.createElement(block.ordered ? 'ol' : 'ul');
          for (const item of block.items) {
            const li = document.createElement('li');
            renderInline(li, item.inline);
            list.append(li);
          }
          parent.append(list);
        } else if (block.type === 'quote') {
          const quote = document.createElement('blockquote');
          renderBlocks(quote, block.blocks);
          parent.append(quote);
        } else if (block.type === 'rule') {
          parent.append(document.createElement('hr'));
        }
      }
    };
    renderBlocks(node, parseMarkdown(text));
    return node;
  };

  return { parseMarkdown, parseInline, renderInto };
});
