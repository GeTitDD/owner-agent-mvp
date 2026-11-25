// #110 会话导出：路径可预测、上下文头齐全、重复导出幂等。
// 不启动 Electron；落盘用临时目录，正文转换复用 desktop/shell-copy.cjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CONVERSATIONS_DIR,
  conversationExportFiles,
  renderConversationMarkdown,
  writeConversationExport
} from '../src/conversation-exports.mjs';

const context = {
  project: 'Companion Demo',
  session: '把今天的待办整理成三条',
  time: '2026-11-25T10:00:00.000Z',
  model: '未接入（占位回复）'
};

const messages = [
  { role: 'user', text: '把今天的待办整理成三条' },
  { role: 'agent', text: '收到', blocks: [{ type: 'kv', rows: [['待办', '3 条']] }] }
];

const withRoot = (fn) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-export-110-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
};

test('落点：<root>/conversations/<sessionId>.md，可预测', () => {
  const files = conversationExportFiles({ root: 'C:/data', sessionId: 'abc-123' });
  assert.equal(files.dir, path.join('C:/data', CONVERSATIONS_DIR));
  assert.equal(files.filePath, path.join('C:/data', CONVERSATIONS_DIR, 'abc-123.md'));
});

test('会话 id 直接进文件名：路径穿越与空值都被挡住', () => {
  assert.throws(() => conversationExportFiles({ root: 'C:/data', sessionId: '' }), /会话 id/u);
  assert.throws(() => conversationExportFiles({ root: 'C:/data', sessionId: '../evil' }), /会话 id/u);
  assert.throws(() => conversationExportFiles({ root: 'C:/data', sessionId: 'a/b' }), /会话 id/u);
  assert.throws(() => conversationExportFiles({ root: '', sessionId: 'a' }), /根目录/u);
});

test('渲染：正文带项目、会话、时间、模型四个头字段', () => {
  const markdown = renderConversationMarkdown({ context, messages });
  assert.match(markdown, /^- 项目：Companion Demo$/mu);
  assert.match(markdown, /^- 会话：把今天的待办整理成三条$/mu);
  assert.match(markdown, /^- 时间：2026-11-25T10:00:00\.000Z$/mu);
  assert.match(markdown, /^- 模型：未接入（占位回复）$/mu);
  assert.match(markdown, /## 我\n\n把今天的待办整理成三条/u);
  assert.match(markdown, /- 待办：3 条/u);
});

test('渲染拒绝坏输入：上下文必须是对象，消息必须是数组', () => {
  assert.throws(() => renderConversationMarkdown({ context: null, messages }), /上下文/u);
  assert.throws(() => renderConversationMarkdown({ context, messages: 'nope' }), /消息/u);
});

test('落盘：创建固定子目录；重复导出内容不变且不重写', () => {
  withRoot((root) => {
    const first = writeConversationExport({ root, sessionId: 'session-1', context, messages });
    assert.equal(first.path, path.join(root, CONVERSATIONS_DIR, 'session-1.md'));
    assert.equal(first.changed, true);
    assert.ok(fs.existsSync(first.path));
    const before = fs.readFileSync(first.path, 'utf8');
    assert.equal(before, first.markdown);

    const second = writeConversationExport({ root, sessionId: 'session-1', context, messages });
    assert.equal(second.changed, false, '正文没变就不该重写文件');
    assert.equal(fs.readFileSync(second.path, 'utf8'), before, '重复导出必须逐字节一致');

    // 正文变化才重写。
    const third = writeConversationExport({
      root,
      sessionId: 'session-1',
      context,
      messages: [...messages, { role: 'agent', text: '补一句' }]
    });
    assert.equal(third.changed, true);
    assert.notEqual(fs.readFileSync(third.path, 'utf8'), before);
  });
});

test('时间来自会话上下文而不是「现在」：两次调用同一份输入逐字节相同', () => {
  const a = renderConversationMarkdown({ context, messages });
  const b = renderConversationMarkdown({ context, messages });
  assert.equal(a, b);
  assert.match(a, /2026-11-25T10:00:00\.000Z/u);
  assert.equal((a.match(/^- 时间：/gmu) ?? []).length, 1, '头里只写一次时间');
});
