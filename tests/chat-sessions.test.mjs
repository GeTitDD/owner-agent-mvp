// 对话会话持久化：绑定项目、自动命名/重命名、重启后历史仍在、删除不碰项目数据。
// 全部使用临时库与内存库，不联网、不调用真实模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ChatSessionStore,
  DEFAULT_CHAT_TITLE,
  titleFromQuestion
} from '../src/chat-sessions.mjs';

/** 建一个只含项目表的最小库，验证会话存储只依赖 owner_projects。 */
const makeDb = ({ file = ':memory:' } = {}) => {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS owner_projects(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE,
      primary_domain TEXT NOT NULL, domains TEXT NOT NULL, imports TEXT NOT NULL,
      goal TEXT NOT NULL, status TEXT NOT NULL, owner_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_event_at TEXT
    );`);
  return db;
};

const insertProject = (db, id, name = id) => {
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO owner_projects(
    id,name,root,primary_domain,domains,imports,goal,status,owner_note,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, name, `D:\\demo\\${id}`, 'software-engineering', '[]', '[]', '', 'active', '', at, at
  );
};

let clock = 0;
const now = () => `2026-11-24T10:00:${String(clock++).padStart(2, '0')}.000Z`;

test('新建会话：绑项目时必须是已登记项目，不绑项目就是全局会话', () => {
  const db = makeDb();
  insertProject(db, 'alpha');
  const store = new ChatSessionStore({ db, now });
  // #106 起会话可以不绑项目（全局会话），但传了项目就必须是真的。
  assert.throws(() => store.createSession({ projectId: 'missing' }), /项目不存在/u);
  const global = store.createSession({ projectId: '' });
  assert.equal(global.projectId, '');
  assert.equal(global.title, DEFAULT_CHAT_TITLE);
  assert.equal(global.messageCount, 0);
  const session = store.createSession({ projectId: 'alpha' });
  assert.equal(session.projectId, 'alpha');
  assert.equal(session.title, DEFAULT_CHAT_TITLE);
  assert.equal(session.messageCount, 0);
  assert.equal(session.pinned, false);
  assert.equal(session.deletedAt, '');
});

test('列表带项目字段，可按项目过滤；组内按最近更新排序', () => {
  clock = 0;
  const db = makeDb();
  insertProject(db, 'alpha');
  insertProject(db, 'beta');
  const store = new ChatSessionStore({ db, now });
  const a = store.createSession({ projectId: 'alpha', title: 'A 项目对话' });
  const b = store.createSession({ projectId: 'beta', title: 'B 项目对话' });
  store.createSession({ projectId: 'alpha', title: 'A 项目第二个' });
  store.appendMessage({ sessionId: a.id, role: 'user', text: '先看 A' });

  const all = store.listSessions();
  assert.equal(all.length, 3);
  assert.deepEqual(new Set(all.map((item) => item.projectId)), new Set(['alpha', 'beta']));
  // 刚追加过消息的 A 会话应该排在最前。
  assert.equal(all[0].id, a.id);
  assert.equal(all[0].messageCount, 1);
  assert.equal(store.listSessions({ projectId: 'beta' }).length, 1);
  assert.equal(store.listSessions({ projectId: 'beta' })[0].id, b.id);
});

test('首个问题自动命名，之后可重命名且不会被覆盖', () => {
  clock = 0;
  const db = makeDb();
  insertProject(db, 'alpha');
  const store = new ChatSessionStore({ db, now });
  const session = store.createSession({ projectId: 'alpha' });
  const question = '这个项目为什么卡住？'.repeat(6);
  const appended = store.appendMessage({ sessionId: session.id, role: 'user', text: question });
  assert.equal(appended.title, titleFromQuestion(question));
  assert.ok(appended.title.endsWith('…'));
  assert.ok(appended.title.length <= 25);

  const renamed = store.renameSession(session.id, '  手动起的标题  ');
  assert.equal(renamed.title, '手动起的标题');
  store.appendMessage({ sessionId: session.id, role: 'user', text: '第二个问题' });
  assert.equal(store.getSession(session.id).title, '手动起的标题');
  assert.throws(() => store.renameSession(session.id, '   '), /标题不能为空/u);
});

test('重启后（重新打开同一个库）历史消息仍在', () => {
  clock = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-sessions-'));
  const file = path.join(dir, 'owner.sqlite');
  let db = makeDb({ file });
  insertProject(db, 'alpha');
  const first = new ChatSessionStore({ db, now });
  const session = first.createSession({ projectId: 'alpha', title: '重启验证' });
  first.appendMessage({ sessionId: session.id, role: 'user', text: '为什么卡住？' });
  first.appendMessage({
    sessionId: session.id,
    role: 'assistant',
    text: '因为重试循环少跑了一次。',
    citations: [{ path: 'src/retry.js', line: 4 }]
  });
  db.close();

  db = makeDb({ file });
  const second = new ChatSessionStore({ db, now });
  const restored = second.getSession(session.id);
  assert.equal(restored.title, '重启验证');
  assert.equal(restored.messages.length, 2);
  assert.equal(restored.messages[0].role, 'user');
  assert.deepEqual(restored.messages[1].citations, [{ path: 'src/retry.js', line: 4 }]);
  assert.equal(second.listSessions().length, 1);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('删除会话只删自己与消息，项目数据不受影响', () => {
  clock = 0;
  const db = makeDb();
  insertProject(db, 'alpha');
  insertProject(db, 'beta');
  const store = new ChatSessionStore({ db, now });
  const keep = store.createSession({ projectId: 'alpha', title: '保留' });
  const drop = store.createSession({ projectId: 'alpha', title: '删除' });
  store.appendMessage({ sessionId: keep.id, role: 'user', text: '保留的问题' });
  store.appendMessage({ sessionId: drop.id, role: 'user', text: '要删的问题' });

  assert.deepEqual(store.deleteSession(drop.id), { id: drop.id, deleted: true });
  assert.equal(store.listSessions().length, 1);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM owner_chat_messages WHERE session_id=?').get(drop.id).n,
    0
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM owner_projects').get().n, 2);
  assert.ok(db.prepare('SELECT id FROM owner_projects WHERE id=?').get('alpha'));
  assert.equal(store.getSession(keep.id).messages.length, 1);
  assert.throws(() => store.deleteSession(drop.id), /会话不存在/u);
});

test('续聊上下文只取最近几轮成功消息', () => {
  clock = 0;
  const db = makeDb();
  insertProject(db, 'alpha');
  const store = new ChatSessionStore({ db, now });
  const session = store.createSession({ projectId: 'alpha' });
  store.appendMessage({ sessionId: session.id, role: 'user', text: '问题一' });
  store.appendMessage({ sessionId: session.id, role: 'assistant', text: '额度已用尽', status: 'error' });
  store.appendMessage({ sessionId: session.id, role: 'user', text: '问题二' });
  store.appendMessage({ sessionId: session.id, role: 'assistant', text: '答案二' });
  const history = store.historyForPrompt(session.id, { limit: 10 });
  assert.deepEqual(history.map((item) => item.text), ['问题一', '问题二', '答案二']);
  assert.equal(store.historyForPrompt(session.id, { limit: 1 }).length, 1);
  const questionTwo = store.getSession(session.id).messages.find((message) => message.text === '问题二');
  assert.deepEqual(store.historyForPrompt(session.id, { beforeSeq: questionTwo.seq }).map((item) => item.text), ['问题一']);
});

test('旧库平滑升级：只新增会话表，旧表与旧数据保持原样', () => {
  clock = 0;
  const db = makeDb();
  insertProject(db, 'alpha');
  db.exec('CREATE TABLE owner_tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL)');
  db.prepare('INSERT INTO owner_tasks(id,project_id,title) VALUES(?,?,?)').run('task-1', 'alpha', '旧任务');
  const beforeColumns = db.prepare('PRAGMA table_info(owner_projects)').all().map((c) => c.name);

  new ChatSessionStore({ db, now });

  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    .map((row) => row.name));
  assert.ok(tables.has('owner_chat_sessions'));
  assert.ok(tables.has('owner_chat_messages'));
  assert.ok(tables.has('owner_projects'));
  assert.deepEqual(
    db.prepare('PRAGMA table_info(owner_projects)').all().map((c) => c.name),
    beforeColumns
  );
  assert.equal(db.prepare('SELECT title FROM owner_tasks WHERE id=?').get('task-1').title, '旧任务');
});

test('撤回上一轮：只删最后一条用户消息及其回复，返回原文', () => {
  const db = makeDb();
  const store = new ChatSessionStore({ db, now: () => new Date().toISOString() });
  const session = store.createSession({ projectId: '' });
  store.appendMessage({ sessionId: session.id, role: 'user', text: '第一问' });
  store.appendMessage({ sessionId: session.id, role: 'assistant', text: '第一答' });
  store.appendMessage({ sessionId: session.id, role: 'user', text: '第二问' });
  store.appendMessage({ sessionId: session.id, role: 'assistant', text: '第二答' });

  const removed = store.removeLastTurn({ sessionId: session.id });
  assert.equal(removed.text, '第二问');
  const rest = store.getSession(session.id).messages.map((message) => message.text);
  assert.deepEqual(rest, ['第一问', '第一答']);
  // 再撤一次退掉第一轮；其后没有用户消息就返回 null，不误删助手消息。
  assert.equal(store.removeLastTurn({ sessionId: session.id }).text, '第一问');
  assert.equal(store.removeLastTurn({ sessionId: session.id }), null);
});
