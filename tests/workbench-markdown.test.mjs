// 审核中心 Markdown 预览：排版正确且不执行/注入 HTML。
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../web/workbench/markdown.js';

test('渲染标题、列表、行内代码与代码块', () => {
  const html = renderMarkdown([
    '## 结论',
    '- 第一点 `withRetry`',
    '- 第二点 **重点**',
    '',
    '```js',
    'const a = 1 < 2;',
    '```'
  ].join('\n'));
  assert.match(html, /<h3>结论<\/h3>/u);
  assert.match(html, /<ul><li>第一点 <code>withRetry<\/code><\/li>/u);
  assert.match(html, /<strong>重点<\/strong>/u);
  assert.match(html, /<pre><code class="language-js">const a = 1 &lt; 2;<\/code><\/pre>/u);
});

test('转义 HTML 并拒绝 javascript 链接', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n[官网](https://example.com)');
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/u);
  assert.ok(!html.includes('href="javascript:'));
  assert.match(html, /href="https:\/\/example\.com"/u);
});

test('空内容返回空字符串，段落之间独立', () => {
  assert.equal(renderMarkdown(''), '');
  const html = renderMarkdown('第一段\n\n第二段');
  assert.equal(html, '<p>第一段</p>\n<p>第二段</p>');
});
