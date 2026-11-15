// 极简 Markdown 渲染器：审核中心的提案正文由 Agent 生成，人类阅读需要排版。
//
// 安全边界：先整体转义 HTML，再在转义后的文本上做格式化，因此不会注入标签；
// 只允许 http/https/mailto 链接；不执行任何脚本。
const escapeHtml = (value) => String(value ?? '')
  .replace(/&/gu, '&amp;')
  .replace(/</gu, '&lt;')
  .replace(/>/gu, '&gt;')
  .replace(/"/gu, '&quot;')
  .replace(/'/gu, '&#39;');

/** 行内格式：代码 → 粗体 → 斜体 → 链接。 */
const inline = (text) => {
  const codes = [];
  let output = text.replace(/`([^`]+)`/gu, (_, code) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  output = output
    .replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>')
    .replace(/__([^_]+)__/gu, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/gu, '$1<em>$2</em>');
  output = output.replace(/\[([^\]]+)\]\(([^)\s]+)\)/gu, (match, label, href) => {
    if (!/^(https?:|mailto:)/iu.test(href)) return match;
    return `<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>`;
  });
  return output.replace(/\u0000(\d+)\u0000/gu, (_, index) => codes[Number(index)] ?? '');
};

const paragraph = (lines) => `<p>${inline(lines.join(' '))}</p>`;

/** 把 Markdown 文本渲染成安全 HTML。 */
export function renderMarkdown(source) {
  const text = escapeHtml(String(source ?? '').replace(/\r\n?/gu, '\n'));
  if (!text.trim()) return '';
  const lines = text.split('\n');
  const html = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (/^\s*```/u.test(line)) {
      const language = line.trim().slice(3).trim();
      const body = [];
      index += 1;
      while (index < lines.length && !/^\s*```/u.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      html.push(`<pre><code${language ? ` class="language-${language}"` : ''}>${body.join('\n')}</code></pre>`);
      continue;
    }

    if (!line.trim()) { index += 1; continue; }

    const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (heading) {
      const level = heading[1].length <= 2 ? 3 : heading[1].length <= 4 ? 4 : 5;
      html.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*(?:---|\*\*\*|___)\s*$/u.test(line)) {
      html.push('<hr>');
      index += 1;
      continue;
    }

    if (/^\s*>\s?/u.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>\s?/u.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/u, ''));
        index += 1;
      }
      html.push(`<blockquote>${paragraph(quote)}</blockquote>`);
      continue;
    }

    const bullet = /^\s*[-*+]\s+/u;
    const ordered = /^\s*\d+[.)]\s+/u;
    if (bullet.test(line) || ordered.test(line)) {
      const isOrdered = ordered.test(line);
      const items = [];
      while (index < lines.length && (isOrdered ? ordered : bullet).test(lines[index])) {
        items.push(lines[index].replace(isOrdered ? ordered : bullet, ''));
        index += 1;
        // 续行（缩进但不是新条目）并入当前条目
        while (index < lines.length && lines[index].trim() && !bullet.test(lines[index]) && !ordered.test(lines[index])) {
          items[items.length - 1] += ` ${lines[index].trim()}`;
          index += 1;
        }
      }
      const tagName = isOrdered ? 'ol' : 'ul';
      html.push(`<${tagName}>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</${tagName}>`);
      continue;
    }

    const plain = [];
    while (index < lines.length && lines[index].trim()
      && !/^\s*```/u.test(lines[index])
      && !/^#{1,6}\s+/u.test(lines[index])
      && !/^\s*>\s?/u.test(lines[index])
      && !bullet.test(lines[index]) && !ordered.test(lines[index])) {
      plain.push(lines[index].trim());
      index += 1;
    }
    if (plain.length) html.push(paragraph(plain));
    else index += 1;
  }

  return html.join('\n');
}
