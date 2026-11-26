// 对话气泡的 Markdown 解析：块与行内两层，纯数据，不碰 DOM。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseMarkdown, parseInline } = require('../desktop/shell-markdown.cjs');

const textOf = (inline) => inline.map((token) => {
  if (token.type === 'text' || token.type === 'code') return token.text;
  if (token.children) return textOf(token.children);
  if (token.type === 'link') return token.text;
  return '';
}).join('');

test('标题 / 段落 / 分隔线：块类型正确，文字不丢', () => {
  const blocks = parseMarkdown('## 小节\n\n第一段。\n\n---\n');
  assert.deepEqual(blocks.map((block) => block.type), ['heading', 'paragraph', 'rule']);
  assert.equal(blocks[0].level, 2);
  assert.equal(textOf(blocks[0].inline), '小节');
  assert.equal(textOf(blocks[1].inline), '第一段。');
});

test('行内：粗体 / 斜体 / 行内代码 / 安全链接', () => {
  const inline = parseInline('这是 **粗**、*斜*、`code` 和 [链接](https://example.com)。');
  assert.deepEqual(inline.map((token) => token.type), ['text', 'strong', 'text', 'em', 'text', 'code', 'text', 'link', 'text']);
  assert.equal(textOf(inline.filter((token) => token.type === 'strong')), '粗');
  assert.equal(inline.find((token) => token.type === 'link').href, 'https://example.com');
});

test('不安全的链接不变成链接，原样当文字', () => {
  const inline = parseInline('[点我](javascript:alert(1))');
  assert.equal(inline.some((token) => token.type === 'link'), false);
  assert.match(textOf(inline), /点我/u);
});

test('围栏代码保留原文与语言，未闭合也照样收下', () => {
  const closed = parseMarkdown('```js\nconst a = 1;\n```');
  assert.equal(closed[0].type, 'code');
  assert.equal(closed[0].lang, 'js');
  assert.equal(closed[0].text, 'const a = 1;');
  const open = parseMarkdown('```\n没闭合');
  assert.equal(open[0].type, 'code');
  assert.equal(open[0].text, '没闭合');
});

test('列表与引用：有序 / 无序分开，引用递归解析', () => {
  const blocks = parseMarkdown('- 一\n- 二\n\n1. 甲\n2. 乙\n\n> 引用 **重点**\n');
  assert.deepEqual(blocks.map((block) => block.type), ['list', 'list', 'quote']);
  assert.equal(blocks[0].ordered, false);
  assert.equal(blocks[1].ordered, true);
  assert.equal(blocks[2].blocks[0].type, 'paragraph');
  assert.equal(textOf(blocks[2].blocks[0].inline), '引用 重点');
});

test('没有 Markdown 语法的长文本原样保留（不吞换行）', () => {
  const source = '第一行\n第二行';
  const blocks = parseMarkdown(source);
  assert.equal(blocks.length, 1);
  assert.equal(textOf(blocks[0].inline), '第一行\n第二行');
});
