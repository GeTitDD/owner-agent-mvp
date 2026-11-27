// 长会话必须先看到最新回复；历史按稳定消息序号分批读，不以提高上限掩盖截断。
import test from 'node:test';
import assert from 'node:assert/strict';
import { OwnerStore } from '../src/owner-store.mjs';
import { ChatSessionStore } from '../src/chat-sessions.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportStoredConversation } from '../src/conversation-exports.mjs';

const fixture = (count = 520) => {
  const owner = new OwnerStore(':memory:');
  const chats = new ChatSessionStore({ db: owner.db });
  const session = chats.createSession({ title: '长会话' });
  const ids = [];
  owner.db.exec('BEGIN');
  try {
    for (let index = 0; index < count; index += 1) ids.push(chats.appendMessage({ sessionId: session.id,
      role: index % 2 ? 'assistant' : 'user', text: `消息 ${index}` }).seq);
    owner.db.exec('COMMIT');
  } catch (error) { owner.db.exec('ROLLBACK'); throw error; }
  return { owner, chats, session, ids };
};

test('超过 500 条的会话默认显示最新消息，已保存的新回复不能从界面消失', () => {
  const { owner, chats, session } = fixture();
  try {
    const view = chats.getSession(session.id);
    assert.equal(view.messages.at(-1).text, '消息 519');
    assert.equal(view.messages.length, 500);
    assert.equal(view.messageCount, 520);
    assert.equal(view.page.hasMore, true);
  } finally { owner.close(); }
});

test('历史按 beforeSeq 向前翻页，期间新增消息也不会造成重复、缺失或串会话', () => {
  const { owner, chats, session, ids } = fixture(520);
  try {
    const foreign = chats.createSession({ title: '另一会话' });
    chats.appendMessage({ sessionId: foreign.id, role: 'user', text: '不属于这条历史' });
    const newest = chats.getSession(session.id, { limit: 100 });
    chats.appendMessage({ sessionId: session.id, role: 'user', text: '翻页期间新增' });
    const pages = [newest.messages];
    let page = newest.page;
    while (page.hasMore) {
      const older = chats.getSession(session.id, { limit: 100, beforeSeq: page.nextBeforeSeq });
      pages.unshift(older.messages);
      page = older.page;
    }
    const loaded = pages.flat();
    assert.deepEqual(loaded.map((message) => message.seq), ids);
    assert.equal(new Set(loaded.map((message) => message.seq)).size, 520);
    assert.equal(loaded.some((message) => message.text === '不属于这条历史'), false);
  } finally { owner.close(); }
});

test('空会话、单页边界和无效游标不会造成无限翻页', () => {
  const { owner, chats, session } = fixture(0);
  try {
    assert.deepEqual(chats.getSession(session.id).page, { hasMore: false, nextBeforeSeq: null });
    for (const cursor of [-1, 1.1, '坏游标', Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => chats.getSession(session.id, { beforeSeq: cursor }), /游标无效/);
    }
    for (let i = 0; i < 3; i += 1) chats.appendMessage({ sessionId: session.id, role: 'user', text: `${i}` });
    const page = chats.getSession(session.id, { limit: 3 });
    assert.equal(page.page.hasMore, false);
    assert.equal(chats.getSession(session.id, { beforeSeq: page.page.nextBeforeSeq }).messages.length, 0);
    assert.equal(chats.getSession(session.id, { limit: 1.8 }).messages.length, 1);
    assert.equal(chats.getSession(session.id, { limit: Infinity }).messages.length, 3);
  } finally { owner.close(); }
});

test('翻页期间撤回末轮，较早的游标仍可取到全部剩余旧消息', () => {
  const { owner, chats, session, ids } = fixture(8);
  try {
    const latest = chats.getSession(session.id, { limit: 2 });
    chats.removeLastTurn({ sessionId: session.id });
    const older = chats.getSession(session.id, { limit: 8, beforeSeq: latest.page.nextBeforeSeq });
    assert.deepEqual(older.messages.map(m => m.seq), ids.slice(0, 6));
  } finally { owner.close(); }
});

test('原问题点查不依赖页窗口，拒绝其他会话的消息序号', () => {
  const { owner, chats, session, ids } = fixture();
  try {
    const foreign = chats.createSession({ title: '另一条历史' });
    assert.equal(chats.getSession(session.id).messages.some(m => m.seq === ids[0]), false);
    assert.equal(chats.getMessage(session.id, ids[0]).text, '消息 0');
    assert.equal(chats.getMessage(foreign.id, ids[0]), null);
    for (const seq of [0, -1, 0.5, '1', NaN]) assert.throws(() => chats.getMessage(session.id, seq), /消息序号无效/);
    assert.throws(() => chats.getMessage('missing', ids[0]), /会话不存在/);
  } finally { owner.close(); }
});

test('完整导出与完整同步正文不受界面页窗口影响，重复导出逐字节一致', () => {
  const { owner, chats, session } = fixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-history-export-'));
  try {
    const foreign = chats.createSession({ title: '不能导出此会话' });
    chats.appendMessage({ sessionId: foreign.id, role: 'user', text: '另一会话的私有内容' });
    assert.equal(chats.getTranscript(session.id).messages.length, 520);
    const input = { store: chats, root, sessionId: session.id, context: { session: session.title, time: session.createdAt } };
    const first = exportStoredConversation(input);
    assert.equal((first.markdown.match(/^## (?:我|Companion)$/gm) ?? []).length, 520);
    assert.match(first.markdown, /消息 0\n/);
    assert.match(first.markdown, /消息 519/);
    assert.doesNotMatch(first.markdown, /私有内容/);
    const second = exportStoredConversation(input);
    assert.equal(first.markdown, second.markdown);
    assert.equal(second.changed, false);
  } finally { owner.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
