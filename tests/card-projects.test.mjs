// #107 项目与全局模式：状态机（纯函数）+ 全局聚合（纯函数）+ 写入判定（纯函数）
// + 会话上的「正在看的项目」（存储层，临时库）。
// 界面层（项目胶囊、确认四条、两个出口、跨项目标、全局只读区）交给
// scripts/e2e/desktop-card-projects.mjs 走真实窗口。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { ChatSessionStore } from '../src/chat-sessions.mjs';
import { projectLibraryView } from '../src/project-library.mjs';
import { globalLibraryView } from '../src/global-library.mjs';
import { globalWriteOutcome, writeScopeText, GLOBAL_WRITE_DENIED } from '../src/global-write.mjs';

const require = createRequire(import.meta.url);
const scope = require('../desktop/shell-projects.cjs');

// ── 夹具：两个项目、一份共享的领域知识 ────────────────────────────

const sharedKnowledge = {
  id: 'k-shared',
  title: '共享的领域知识',
  kind: 'claim',
  domains: ['software-engineering'],
  verificationStatus: 'unverified'
};

const alphaLibrary = projectLibraryView({
  project: { id: 'alpha', name: 'Alpha Repo', domains: ['software-engineering'] },
  lessons: [{
    id: 'l-alpha',
    phenomenon: 'Alpha 的已验证经验',
    scope: { layer: 'project', projectId: 'alpha' },
    verificationStatus: 'verified'
  }],
  knowledge: [
    sharedKnowledge,
    {
      id: 'k-alpha',
      title: 'Alpha 贡献的知识',
      kind: 'claim',
      domains: ['release-notes'],
      originProjectId: 'alpha',
      verificationStatus: 'verified'
    }
  ]
});

const betaLibrary = projectLibraryView({
  project: { id: 'beta', name: 'Beta Repo', domains: ['software-engineering'] },
  lessons: [{
    id: 'l-beta',
    phenomenon: 'Beta 的观察中经验',
    scope: { layer: 'project', projectId: 'beta' },
    verificationStatus: 'inferred'
  }],
  knowledge: [sharedKnowledge]
});

const libraries = [
  { project: { id: 'alpha', name: 'Alpha Repo' }, library: alphaLibrary },
  { project: { id: 'beta', name: 'Beta Repo' }, library: betaLibrary }
];

// ── 全局聚合：复用库视图口径，只做去重与分节 ──────────────────────

test('全局聚合：同一份领域知识只算一次，并记下出现在哪些项目', () => {
  const view = globalLibraryView({ libraries });
  assert.equal(view.readOnly, true, '全局视图永远是只读');
  assert.equal(view.scope, 'global');
  assert.equal(view.projectCount, 2);
  // 两项目各 3 / 2 条，共享那条合并后是 4 条。
  assert.equal(alphaLibrary.counts.total, 3);
  assert.equal(betaLibrary.counts.total, 2);
  assert.equal(view.counts.total, 4);
  assert.equal(view.counts.shared, 1, '被两个项目同时读到的条目只记一条');
  const shared = view.entries.find((entry) => entry.id === 'k-shared');
  assert.ok(shared, '共享条目应该出现在合并结果里');
  assert.deepEqual(shared.projectIds.sort(), ['alpha', 'beta']);
  assert.match(shared.projectLabel, /Alpha Repo/u);
  assert.match(shared.projectLabel, /Beta Repo/u);
});

test('全局聚合：两节沿用条目自己的 section，合计恒等于去重后的总数', () => {
  const view = globalLibraryView({ libraries });
  assert.equal(view.counts.verified + view.counts.observing, view.counts.total);
  assert.equal(view.counts.verified, 2, 'l-alpha + k-alpha');
  assert.equal(view.counts.observing, 2, 'k-shared + l-beta');
  assert.deepEqual(view.sections.map((section) => section.key), ['verified', 'observing']);
});

test('全局聚合：每项目另给一份不去重的原始计数，标成本项目口径', () => {
  const view = globalLibraryView({ libraries });
  const alpha = view.projects.find((project) => project.id === 'alpha');
  const beta = view.projects.find((project) => project.id === 'beta');
  assert.equal(alpha.counts.total, 3);
  assert.equal(beta.counts.total, 2);
  // 两项目之和比全局多 1，多出来的就是共享条目。
  assert.equal(alpha.counts.total + beta.counts.total, view.counts.total + view.counts.shared);
});

test('全局聚合：limit 只截断列表，计数仍按全量', () => {
  const view = globalLibraryView({ libraries, limit: 2 });
  assert.equal(view.entries.length, 2);
  assert.equal(view.truncated, true);
  assert.equal(view.counts.total, 4);
  assert.equal(globalLibraryView({ libraries, limit: 1 }).entries.length, 1);
});

test('全局聚合：没有项目与库为空是两种空态', () => {
  const noProject = globalLibraryView({ libraries: [] });
  assert.equal(noProject.counts.projects, 0);
  assert.equal(noProject.empty?.kind, 'no-project');
  const emptyLibrary = projectLibraryView({ project: { id: 'gamma', name: 'Gamma' } });
  const empty = globalLibraryView({
    libraries: [{ project: { id: 'gamma', name: 'Gamma' }, library: emptyLibrary }]
  });
  assert.equal(empty.counts.projects, 1);
  assert.equal(empty.counts.total, 0);
  assert.equal(empty.empty?.kind, 'empty-global');
});

// ── 写入判定：全局只读，写项目目录先选项目 ────────────────────────

test('全局模式：写项目目录被拒绝，并要求先选项目', () => {
  const denied = globalWriteOutcome({ viewProjectId: '', destination: 'project' });
  assert.equal(denied.outcome, 'deny');
  assert.equal(denied.scope, 'global');
  assert.equal(denied.reason, GLOBAL_WRITE_DENIED);
  assert.match(denied.reason, /先选一个项目/u);
  // 删除也不能绕过去：前置判定在分级之前。
  assert.equal(globalWriteOutcome({
    viewProjectId: '', destination: 'project', deletes: true, granted: { project: true }
  }).outcome, 'deny');
});

test('全局模式：写自有目录仍按 ADR-0012 放行（会话消息不能因此存不下来）', () => {
  const own = globalWriteOutcome({ viewProjectId: '', destination: 'own' });
  assert.equal(own.outcome, 'allow');
  assert.equal(own.scope, 'own');
  assert.equal(globalWriteOutcome({ viewProjectId: '', destination: 'own', deletes: true }).outcome, 'confirm');
  assert.equal(globalWriteOutcome({ viewProjectId: '', destination: 'external' }).outcome, 'confirm');
  assert.equal(globalWriteOutcome({ viewProjectId: '', destination: 'nowhere' }).outcome, 'deny');
});

test('选了项目之后：写项目目录回到 ADR-0012 的分级（未授权确认 / 已授权放行 / 删除确认）', () => {
  const base = { viewProjectId: 'alpha', destination: 'project' };
  assert.equal(globalWriteOutcome(base).outcome, 'confirm');
  assert.equal(globalWriteOutcome({ ...base, granted: { project: true } }).outcome, 'allow');
  assert.equal(globalWriteOutcome({ ...base, granted: { project: true }, deletes: true }).outcome, 'confirm');
  assert.equal(globalWriteOutcome({ ...base, destination: 'external', granted: { project: true } }).outcome, 'confirm');
});

test('写范围文案：全局是独立形态「只读·全局」，项目下沿用 ADR-0012 的两句话', () => {
  const global = writeScopeText({ viewProjectId: '' });
  assert.equal(global.label, '只读·全局');
  assert.equal(global.scope, 'global');
  assert.match(global.hint, /先选项目/u);
  const project = writeScopeText({ viewProjectId: 'alpha' });
  assert.equal(project.label, '写·自有');
  assert.equal(project.scope, 'own');
  assert.equal(writeScopeText({ viewProjectId: 'alpha', granted: { project: true } }).label, '项目目录已授权');
});

// ── 状态机：全局 / 具体项目 / 跨项目标 / 两个出口 ─────────────────

const projects = [
  { id: 'alpha', name: 'Alpha Repo' },
  { id: 'beta', name: 'Beta Repo' }
];

const boundSession = (projectId, viewProjectId) => ({
  id: 'chat_1', projectId, viewProjectId, title: '一条会话'
});

test('视图范围：空串是全局，有项目就是项目名；旧记录退回绑定项目', () => {
  assert.equal(scope.scopeLabel(projects, ''), '全局');
  assert.equal(scope.scopeLabel(projects, 'alpha'), 'Alpha Repo');
  assert.equal(scope.scopeLabel(projects, 'gone'), 'gone', '未知 id 原样显示，方便排查');
  // 有 viewProjectId 字段就按它（空串 = 明确选了全局）；没有这个字段才是旧数据。
  assert.equal(scope.viewProjectIdOf({ projectId: 'alpha' }), 'alpha');
  assert.equal(scope.viewProjectIdOf({ projectId: 'alpha', viewProjectId: '' }), '');
  assert.equal(scope.viewProjectIdOf(null), '');
});

test('项目胶囊：全局永远第一项，当前项只标正在看的那一个', () => {
  const options = scope.projectOptions(projects, '');
  assert.equal(options[0].id, '');
  assert.equal(options[0].label, '全局');
  assert.equal(options[0].current, true);
  assert.deepEqual(options.slice(1).map((option) => option.id), ['alpha', 'beta']);
  const alphaOptions = scope.projectOptions(projects, 'alpha');
  assert.equal(alphaOptions.find((option) => option.id === 'alpha').current, true);
  assert.equal(alphaOptions[0].current, false);
});

test('跨项目标：绑定与正在看的不一致就打标（两个方向都算）', () => {
  assert.equal(scope.isCrossProject(boundSession('alpha', 'alpha')), false);
  assert.equal(scope.isCrossProject(boundSession('alpha', 'beta')), true);
  assert.equal(scope.isCrossProject(boundSession('', 'beta')), true, '全局起家切去项目也算跨过界');
  assert.equal(scope.isCrossProject(boundSession('alpha', '')), true, '项目会话切去全局也算');
  assert.equal(scope.isCrossProject(boundSession('', '')), false);
  assert.equal(scope.isCrossProject(null), false);
});

test('确认四条：顺序固定，目标项目点名，跨项目记号按切换后的关系算', () => {
  const plan = scope.switchConsequences({
    session: boundSession('alpha', 'alpha'), projects, targetId: 'beta'
  });
  assert.deepEqual(plan.items.map((item) => item.key), ['history', 'read', 'write', 'cross']);
  assert.deepEqual(plan.items.map((item) => item.label), ['历史归属', '读取来源', '写入落点', '跨项目记号']);
  assert.equal(plan.target.label, 'Beta Repo');
  assert.equal(plan.from.label, 'Alpha Repo');
  assert.equal(plan.crossProject, true);
  // 四条都要点名目标或说明落点，不能只有标题。
  for (const item of plan.items) assert.ok(item.text.length > 6, item.key);
  assert.match(plan.items[0].text, /Alpha Repo/u);
  assert.match(plan.items[1].text, /Beta Repo/u);
  assert.match(plan.items[2].text, /Beta Repo/u);
  assert.match(plan.items[3].text, /跨项目/u);

  // 切回自己：不打标，读取来源还是本项目。
  const same = scope.switchConsequences({
    session: boundSession('beta', 'beta'), projects, targetId: 'beta'
  });
  assert.equal(same.crossProject, false);
  assert.doesNotMatch(same.items[3].text, /会话绑定「Beta Repo」≠/u);

  // 切去全局：写入落点写明「无」。
  const global = scope.switchConsequences({
    session: boundSession('alpha', 'alpha'), projects, targetId: ''
  });
  assert.equal(global.target.label, '全局');
  assert.match(global.items[2].text, /无/u);
  assert.equal(global.crossProject, true);
});

test('两个出口：在本会话只改视图，新开会话改绑定', () => {
  const session = boundSession('alpha', 'alpha');
  const inSession = scope.exitPlan({ session, targetId: 'beta', exit: scope.EXITS.inSession });
  assert.equal(inSession.kind, 'in-session');
  assert.equal(inSession.projectId, 'alpha', '历史归属不动');
  assert.equal(inSession.viewProjectId, 'beta');

  const fresh = scope.exitPlan({ session, targetId: 'beta', exit: scope.EXITS.newSession });
  assert.equal(fresh.kind, 'new-session');
  assert.equal(fresh.projectId, 'beta');
  assert.equal(fresh.viewProjectId, 'beta');

  assert.equal(scope.exitPlan({ session, targetId: 'beta', exit: 'other' }), null);
});

test('切换说明：点名历史归属与之后的算法，全局目标写明不写项目', () => {
  const note = scope.switchNote({
    session: boundSession('alpha', 'alpha'), projects, targetId: 'beta'
  });
  assert.match(note, /历史属于「Alpha Repo」/u);
  assert.match(note, /按「Beta Repo」读、按「Beta Repo」写/u);
  const globalNote = scope.switchNote({
    session: boundSession('alpha', 'beta'), projects, targetId: ''
  });
  assert.match(globalNote, /历史属于「Alpha Repo」/u);
  assert.match(globalNote, /按关注顺序列出全部项目，只读/u);

  const block = scope.switchNoteBlock({
    session: boundSession('alpha', 'alpha'), projects, targetId: 'beta'
  });
  assert.equal(block.type, 'kv');
  assert.deepEqual(block.rows.map((row) => row.key), ['历史归属', '读取来源', '写入落点', '跨项目记号']);
  assert.match(block.rows[3].value, /跨项目/u);
});

// ── 存储：正在看的项目跟着会话，重启后还在 ────────────────────────

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
const now = () => `2026-11-25T10:00:${String(clock++).padStart(2, '0')}.000Z`;

test('新建会话的视图范围：绑项目就跟项目，全局就是空', () => {
  const db = makeDb();
  insertProject(db, 'alpha');
  const store = new ChatSessionStore({ db, now });
  const bound = store.createSession({ projectId: 'alpha' });
  assert.equal(bound.projectId, 'alpha');
  assert.equal(bound.viewProjectId, 'alpha', '新会话正在看的就是它绑定的项目');
  assert.equal(scope.isCrossProject(bound), false);
  const global = store.createSession({});
  assert.equal(global.projectId, '');
  assert.equal(global.viewProjectId, '');
  assert.equal(scope.isCrossProject(global), false);
});

test('在本会话切换：绑定不动、视图改掉、列表排队不重排', () => {
  clock = 0;
  const db = makeDb();
  insertProject(db, 'alpha');
  insertProject(db, 'beta');
  const store = new ChatSessionStore({ db, now });
  const session = store.createSession({ projectId: 'alpha' });
  const before = store.listSessions()[0];

  const changed = store.setViewProject(session.id, 'beta');
  assert.equal(changed.projectId, 'alpha', '历史归属仍是 alpha');
  assert.equal(changed.viewProjectId, 'beta');
  assert.equal(scope.isCrossProject(changed), true);
  // 视图状态不是「刚聊过」：updated_at 不变，列表顺序不动。
  assert.equal(changed.updatedAt, before.updatedAt);

  // 切回全局：绑定还在，视图为空。
  const global = store.setViewProject(session.id, '');
  assert.equal(global.projectId, 'alpha');
  assert.equal(global.viewProjectId, '');
  assert.equal(globalWriteOutcome({
    viewProjectId: global.viewProjectId, destination: 'project'
  }).outcome, 'deny');

  // 不能指向没登记的项目，也不静默退回全局。
  assert.throws(() => store.setViewProject(session.id, 'missing'), /项目不存在/u);
  assert.throws(() => store.setViewProject('gone', ''), /会话不存在/u);
});

test('正在看的项目跨重启保留：同一条会话回来还是同一个范围', () => {
  clock = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-projects-'));
  const file = path.join(dir, 'owner.sqlite');
  let db = makeDb({ file });
  insertProject(db, 'alpha');
  insertProject(db, 'beta');
  let store = new ChatSessionStore({ db, now });
  const session = store.createSession({ projectId: 'alpha', title: '切过界的会话' });
  store.setViewProject(session.id, 'beta');
  store.markOpened(session.id);
  db.close();

  db = makeDb({ file });
  store = new ChatSessionStore({ db, now });
  const reloaded = store.getSession(session.id);
  assert.equal(reloaded.projectId, 'alpha');
  assert.equal(reloaded.viewProjectId, 'beta');
  assert.equal(scope.isCrossProject(reloaded), true);
  assert.equal(scope.viewProjectIdOf(reloaded), 'beta');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('老库补 view_project_id：旧会话读出来是全局，绑定与消息不丢', () => {
  const db = makeDb();
  insertProject(db, 'alpha');
  // 复刻 #107 之前的形状：有 project_id / pinned / deleted_at / last_opened_at，没有 view_project_id。
  db.exec(`
    CREATE TABLE owner_chat_sessions(
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES owner_projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      last_opened_at TEXT
    );
    CREATE TABLE owner_chat_messages(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES owner_chat_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ok' CHECK(status IN ('ok','error')),
      citations TEXT NOT NULL DEFAULT '[]',
      blocks TEXT NOT NULL DEFAULT '[]',
      answers TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    INSERT INTO owner_chat_sessions(id,project_id,title,created_at,updated_at)
      VALUES('chat_old','alpha','升级前的会话','2026-11-20T10:00:00.000Z','2026-11-20T10:00:00.000Z');
  `);
  const store = new ChatSessionStore({ db, now });
  const columns = db.prepare('PRAGMA table_info(owner_chat_sessions)').all();
  assert.ok(columns.some((column) => column.name === 'view_project_id'));
  const old = store.getSession('chat_old');
  assert.equal(old.projectId, 'alpha');
  assert.equal(old.viewProjectId, '', '升级前没有视图状态：按全局算，用户看不到假的项目范围');
  // 升级后可以正常切换。
  assert.equal(store.setViewProject('chat_old', 'alpha').viewProjectId, 'alpha');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});
