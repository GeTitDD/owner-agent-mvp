// #106 会话入口：列表逻辑（纯函数）+ 会话存储（临时库）。
// 纯函数在 desktop/shell-sessions.cjs，存储仍是 src/chat-sessions.mjs 那两张表；
// 界面层（胶囊、搜索框、删除确认）交给 scripts/e2e/desktop-card-shell.mjs 走真实窗口。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { ChatSessionStore, DEFAULT_CHAT_TITLE } from '../src/chat-sessions.mjs';

const require = createRequire(import.meta.url);
const lists = require('../desktop/shell-sessions.cjs');
const thread = require('../desktop/shell-thread.cjs');

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

const insertProject = (db, id) => {
  const at = '2026-11-24T09:00:00.000Z';
  db.prepare(`INSERT INTO owner_projects(
    id,name,root,primary_domain,domains,imports,goal,status,owner_note,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, id, `D:\\demo\\${id}`, 'software-engineering', '[]', '[]', '', 'active', '', at, at
  );
};

let clock = 0;
const now = () => `2026-11-24T10:00:${String(clock++).padStart(2, '0')}.000Z`;

const session = (id, extra = {}) => ({
  id,
  projectId: '',
  title: id,
  createdAt: '2026-11-24T09:00:00.000Z',
  updatedAt: '2026-11-24T09:00:00.000Z',
  pinned: false,
  deletedAt: '',
  messageCount: 0,
  turnCount: 0,
  ...extra
});

// ── 纯函数：列表怎么排、怎么搜、删完落到哪 ──────────────────────────

test('列表排序：置顶在前，其余按最近更新，同时间按 id', () => {
  const list = [
    session('old', { updatedAt: '2026-11-24T09:00:00.000Z' }),
    session('fresh', { updatedAt: '2026-11-24T10:00:00.000Z' }),
    session('pinned', { updatedAt: '2026-11-23T09:00:00.000Z', pinned: true })
  ];
  const sorted = lists.sortSessions(list);
  assert.deepEqual(sorted.map((item) => item.id), ['pinned', 'fresh', 'old']);
  // 纯函数：原数组顺序不动。
  assert.deepEqual(list.map((item) => item.id), ['old', 'fresh', 'pinned']);
});

test('搜索：按标题过滤，忽略大小写与首尾空白，空查询原样返回', () => {
  const list = [session('a', { title: 'Weekly Review' }), session('b', { title: '周报整理' })];
  assert.deepEqual(lists.filterSessions(list, 'weekly').map((item) => item.id), ['a']);
  assert.deepEqual(lists.filterSessions(list, '  周报 ').map((item) => item.id), ['b']);
  assert.equal(lists.filterSessions(list, '   '), list, '空查询不该复制一份新数组');
  assert.deepEqual(lists.filterSessions(list, '没有这个'), []);
});

test('列表空态：没有会话与搜索无匹配是两句话', () => {
  const noSession = lists.listHint([], '');
  assert.match(noSession, /还没有会话/u);
  const emptySearch = lists.listHint([session('a')], '找不到');
  assert.match(emptySearch, /找不到/u, '搜索空态要把搜索词说出来');
  assert.equal(lists.listHint([session('a')], ''), '', '有会话且不搜索时不该有提示');
});

test('删除后的落点：删当前就落到第一条，删别的就不动，全删就落空', () => {
  const list = [session('one'), session('two'), session('three')];
  assert.equal(lists.landingAfterDelete(list, 'one', 'one'), 'two');
  assert.equal(lists.landingAfterDelete(list, 'two', 'one'), 'one', '删的不是当前，当前不动');
  assert.equal(lists.landingAfterDelete([session('one')], 'one', 'one'), '');
  assert.equal(lists.landingAfterDelete([], 'gone', ''), '');
});

test('重命名：空标题视为取消（返回空串），多余空白压掉', () => {
  assert.equal(lists.normalizeRename('  新 名字  '), '新 名字');
  assert.equal(lists.normalizeRename('   '), '');
  assert.equal(lists.normalizeRename(undefined), '');
});

test('没有会话就不能发消息：能不能发只看有没有当前会话', () => {
  assert.equal(lists.canCompose('chat_1'), true);
  assert.equal(lists.canCompose(''), false);
  assert.equal(lists.canCompose(undefined), false);
});

test('启动时选哪条：上次打开过的优先，否则第一条，没有就是空', () => {
  const list = [
    session('one', { lastOpenedAt: '2026-11-24T09:00:00.000Z' }),
    session('two', { lastOpenedAt: '2026-11-24T11:00:00.000Z' }),
    session('three')
  ];
  assert.equal(lists.pickInitialSession(list), 'two');
  assert.equal(lists.pickInitialSession([session('one'), session('two')]), 'one', '都没打开过就选第一条');
  assert.equal(lists.pickInitialSession([]), '');
  assert.equal(lists.pickInitialSession(undefined), '');
});

test('胶囊标题：标题空时退回「新会话」，没有会话时直说没有', () => {
  assert.equal(lists.sessionLabel(session('a', { title: '周报' })), '周报');
  assert.equal(lists.sessionLabel(session('a', { title: '  ' })), DEFAULT_CHAT_TITLE);
  assert.equal(lists.sessionLabel(null), '还没有会话');
});

test('重放历史：库里的消息行转回渲染用的流，占位回复按正文前缀认', () => {
  const stored = [
    { role: 'user', text: '第一句' },
    { role: 'assistant', text: '（占位回复）收到「第一句」。' },
    { role: 'assistant', text: '真的回复' }
  ];
  const restored = thread.fromStored(stored);
  assert.deepEqual(restored.map((item) => item.role), ['user', 'agent', 'agent']);
  assert.equal(thread.isPlaceholder(restored[1]), true);
  assert.equal(thread.isPlaceholder(restored[2]), false);
  assert.equal(thread.isPlaceholderText('（占位回复）收到「x」。'), true);
  assert.equal(thread.isPlaceholderText('占位回复'), false);
  assert.deepEqual(thread.fromStored(undefined), []);
});

// ── 存储：复用 owner_chat_sessions，不另造表 ───────────────────────

test('新建全局会话：项目留空也能建，传了项目就必须已登记', () => {
  const db = makeDb();
  insertProject(db, 'alpha');
  const store = new ChatSessionStore({ db, now });
  assert.throws(() => store.createSession({ projectId: 'missing' }), /项目不存在/u);
  const global = store.createSession({});
  assert.equal(global.projectId, '');
  assert.equal(global.title, DEFAULT_CHAT_TITLE);
  assert.equal(global.pinned, false);
  assert.equal(global.deletedAt, '');
  const bound = store.createSession({ projectId: 'alpha', title: '绑项目的会话' });
  assert.equal(bound.projectId, 'alpha');
  // 全局会话与项目会话同一张表、同一个列表，靠 projectId 区分。
  assert.equal(store.listSessions().length, 2);
});

test('重命名：显式命名覆盖自动命名，之后聊天不再改名', () => {
  clock = 0;
  const db = makeDb();
  const store = new ChatSessionStore({ db, now });
  const created = store.createSession({});
  const appended = store.appendMessage({ sessionId: created.id, role: 'user', text: '先看会话列表' });
  assert.equal(appended.title, '先看会话列表');
  const renamed = store.renameSession(created.id, '  我起的名字  ');
  assert.equal(renamed.title, '我起的名字');
  store.appendMessage({ sessionId: created.id, role: 'user', text: '第二句' });
  assert.equal(store.getSession(created.id).title, '我起的名字');
  assert.throws(() => store.renameSession(created.id, '   '), /标题不能为空/u);
});

test('置顶：置顶项排在最前；取消置顶后回到时间序', () => {
  clock = 0;
  const db = makeDb();
  const store = new ChatSessionStore({ db, now });
  const first = store.createSession({ title: '先建的' });
  const second = store.createSession({ title: '后建的' });
  assert.deepEqual(store.listSessions().map((item) => item.id), [second.id, first.id]);

  store.setPinned(first.id, true);
  assert.deepEqual(store.listSessions().map((item) => item.id), [first.id, second.id]);
  assert.equal(store.listSessions()[0].pinned, true);

  store.setPinned(first.id, false);
  assert.deepEqual(store.listSessions().map((item) => item.id), [second.id, first.id]);
  assert.throws(() => store.setPinned('gone', true), /会话不存在/u);
});

test('轮数：只数我问过几句', () => {
  clock = 0;
  const db = makeDb();
  const store = new ChatSessionStore({ db, now });
  const created = store.createSession({});
  store.appendMessage({ sessionId: created.id, role: 'user', text: '问题一' });
  store.appendMessage({ sessionId: created.id, role: 'assistant', text: '回答一' });
  const listed = store.listSessions()[0];
  assert.equal(listed.turnCount, 1);
  assert.equal(listed.messageCount, 2);
});

test('软删除：列表消失、记录还在、能按 id 找回；删完不能再追加消息', () => {
  clock = 0;
  const db = makeDb();
  const store = new ChatSessionStore({ db, now });
  const keep = store.createSession({ title: '留着' });
  const drop = store.createSession({ title: '删掉' });
  store.appendMessage({ sessionId: drop.id, role: 'user', text: '这句也要留着' });

  const result = store.softDeleteSession(drop.id);
  assert.equal(result.soft, true);
  assert.ok(result.deletedAt);
  // 默认列表看不到，消息也没被删。
  assert.deepEqual(store.listSessions().map((item) => item.id), [keep.id]);
  const archived = store.listSessions({ includeDeleted: true });
  assert.deepEqual(archived.map((item) => item.id).sort(), [keep.id, drop.id].sort());
  assert.equal(store.getSession(drop.id).messages.length, 1);
  assert.throws(
    () => store.appendMessage({ sessionId: drop.id, role: 'user', text: '还想接着说' }),
    /请先找回/u
  );

  const restored = store.restoreSession(drop.id);
  assert.equal(restored.deletedAt, '');
  assert.deepEqual(new Set(store.listSessions().map((item) => item.id)), new Set([keep.id, drop.id]));
  // 重复删除/找回都是幂等的，不报错也不重复写。
  assert.equal(store.softDeleteSession(drop.id).soft, true);
  assert.equal(store.softDeleteSession(drop.id).soft, true);
  assert.equal(store.restoreSession(drop.id).deletedAt, '');
  assert.throws(() => store.softDeleteSession('gone'), /会话不存在/u);
});

test('跨重启保留：标题、置顶、删除标记、当前选择与消息都在', () => {
  clock = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-sessions-'));
  const file = path.join(dir, 'owner.sqlite');
  let db = makeDb({ file });
  const first = new ChatSessionStore({ db, now });
  const pinned = first.createSession({ title: '置顶那条' });
  const dropped = first.createSession({ title: '删掉那条' });
  const active = first.createSession({ title: '留着那条' });
  first.appendMessage({ sessionId: active.id, role: 'user', text: '重启后还要在' });
  first.setPinned(pinned.id, true);
  first.softDeleteSession(dropped.id);
  first.markOpened(active.id);
  db.close();

  db = makeDb({ file });
  const second = new ChatSessionStore({ db, now });
  const listed = second.listSessions();
  assert.deepEqual(listed.map((item) => item.id), [pinned.id, active.id]);
  assert.equal(listed[0].pinned, true);
  assert.equal(second.getSession(active.id).messages[0].text, '重启后还要在');
  // 当前选择：last_opened_at 记在库里，重启后纯函数仍能选出同一条。
  assert.equal(second.listSessions().find((item) => item.id === active.id).lastOpenedAt.length > 0, true);
  assert.equal(lists.pickInitialSession(second.listSessions()), active.id);
  assert.equal(second.listSessions({ includeDeleted: true })
    .find((item) => item.id === dropped.id).deletedAt.length > 0, true);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('老库迁移：project_id NOT NULL 被放宽，旧行与消息一条不丢', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-sessions-old-'));
  const file = path.join(dir, 'owner.sqlite');
  const db = makeDb({ file });
  insertProject(db, 'alpha');
  // 复刻 #106 之前的形状：project_id NOT NULL，没有 pinned / deleted_at。
  db.exec(`
    CREATE TABLE owner_chat_sessions(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES owner_projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE owner_chat_messages(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES owner_chat_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ok' CHECK(status IN ('ok','error')),
      citations TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    INSERT INTO owner_chat_sessions(id,project_id,title,created_at,updated_at)
      VALUES('chat_old','alpha','迁移前的会话','2026-11-20T10:00:00.000Z','2026-11-20T10:00:00.000Z');
    INSERT INTO owner_chat_messages(session_id,role,text,status,citations,created_at)
      VALUES('chat_old','user','迁移前的问题','ok','[]','2026-11-20T10:00:00.000Z');
  `);

  const store = new ChatSessionStore({ db, now });
  const columns = db.prepare('PRAGMA table_info(owner_chat_sessions)').all();
  assert.equal(columns.find((column) => column.name === 'project_id').notnull, 0);
  assert.ok(columns.some((column) => column.name === 'pinned'));
  assert.ok(columns.some((column) => column.name === 'deleted_at'));
  assert.ok(columns.some((column) => column.name === 'last_opened_at'));

  const old = store.getSession('chat_old');
  assert.equal(old.title, '迁移前的会话');
  assert.equal(old.messages[0].text, '迁移前的问题');
  assert.equal(old.pinned, false);
  assert.equal(old.deletedAt, '');
  // 迁移后才能写全局会话；外键也还认得旧会话。
  const global = store.createSession({ title: '迁移后的全局会话' });
  assert.equal(global.projectId, '');
  assert.equal(store.appendMessage({ sessionId: 'chat_old', role: 'user', text: '迁移后的问题' }).seq > 0, true);
  const fk = db.prepare('PRAGMA foreign_key_check').all();
  assert.deepEqual(fk, []);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
