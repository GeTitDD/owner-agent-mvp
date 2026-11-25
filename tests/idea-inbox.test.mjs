// #94 灵感收件箱：表扩展的迁移、无项目条目的存取、状态顺序，以及纯函数视图模型。
// 存储用临时库（照 tests/knowledge-loop.test.mjs 的做法），视图只喂数组、不读库。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { OwnerStore } from '../src/owner-store.mjs';
import { ideaInboxView } from '../src/idea-inbox.mjs';

const TMP_PREFIX = 'owner-idea-inbox-';
const tempDb = (name = 'owner.sqlite') => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  return { root, dbPath: path.join(root, name) };
};
const projectRow = (id) => ({
  id, name: id, root: `C:\\virtual\\${id}`, primary_domain: 'software-engineering',
  domains: '["software-engineering"]', imports: '[]', goal: '', status: 'planned',
  owner_note: '', created_at: '2026-11-20T00:00:00.000Z', updated_at: '2026-11-20T00:00:00.000Z',
  last_event_at: null, root_identity: ''
});

// 旧库只建到 #94 之前的形状：project_id NOT NULL、没有灵感相关的新列。
const createLegacyDb = (dbPath, { withKind = true } = {}) => {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE owner_projects(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE,
        primary_domain TEXT NOT NULL, domains TEXT NOT NULL, imports TEXT NOT NULL,
        goal TEXT NOT NULL, status TEXT NOT NULL, owner_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_event_at TEXT,
        root_identity TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE owner_project_queue(
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES owner_projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('todo','doing','blocked','done','failed')),
        ${withKind ? "kind TEXT NOT NULL DEFAULT 'task'," : ''}
        position INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'owner',
        linked_job_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX owner_project_queue_project
        ON owner_project_queue(project_id,status,position,created_at);
    `);
    const project = projectRow('legacy-project');
    db.prepare(`INSERT INTO owner_projects(
      id,name,root,primary_domain,domains,imports,goal,status,owner_note,
      created_at,updated_at,last_event_at,root_identity
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      project.id, project.name, project.root, project.primary_domain, project.domains,
      project.imports, project.goal, project.status, project.owner_note,
      project.created_at, project.updated_at, project.last_event_at, project.root_identity
    );
    db.prepare(`INSERT INTO owner_project_queue(
      id,project_id,title,body,status,${withKind ? 'kind,' : ''}position,source,linked_job_id,
      created_at,updated_at,completed_at
    ) VALUES(?,?,?,?,?,${withKind ? '?,' : ''}?,?,?,?,?,?)`).run(
      'legacy-idea', project.id, '旧的记下内容', '旧记录正文', 'todo',
      ...(withKind ? ['idea'] : []),
      1, 'owner', null,
      '2026-11-19T00:00:00.000Z', '2026-11-19T00:00:00.000Z', null
    );
  } finally {
    db.close();
  }
};

test('老库升级：旧队列项仍在，且归入收件箱、来源为粘贴', () => {
  const { root, dbPath } = tempDb();
  createLegacyDb(dbPath);
  const store = new OwnerStore(dbPath);
  try {
    const item = store.getProjectQueueItem('legacy-idea');
    assert.ok(item, '旧队列项必须保留');
    assert.equal(item.title, '旧的记下内容');
    assert.equal(item.projectId, 'legacy-project');
    assert.equal(item.ideaStatus, 'inbox');
    assert.equal(item.captureSource, 'paste');
    assert.equal(item.link, '');
    assert.equal(item.sorted, null);
    // 升级后旧库也要能放「不属于任何项目」的条目：project_id 已放宽为可空。
    const global = store.addIdeaItem({
      title: '还没想好属于谁', rawText: '还没想好属于谁的灵感', captureSource: 'paste'
    });
    assert.equal(global.projectId, null);
    assert.equal(store.getProjectQueueItem('legacy-idea').projectId, 'legacy-project');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('迁移可重复执行：再开一次库不重建、不丢条目', () => {
  const { root, dbPath } = tempDb();
  createLegacyDb(dbPath);
  const first = new OwnerStore(dbPath);
  first.close();
  const store = new OwnerStore(dbPath);
  try {
    const item = store.getProjectQueueItem('legacy-idea');
    assert.ok(item);
    assert.equal(item.ideaStatus, 'inbox');
    assert.equal(store.listIdeaInbox().length, 1);
    const global = store.addIdeaItem({ title: '第二次打开后再记一条', rawText: '重复打开' });
    assert.equal(global.projectId, null);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('没升级过 kind 列的老库同样能迁移并保住旧项', () => {
  const { root, dbPath } = tempDb();
  createLegacyDb(dbPath, { withKind: false });
  const store = new OwnerStore(dbPath);
  try {
    const item = store.getProjectQueueItem('legacy-idea');
    assert.ok(item);
    // 缺 kind 的旧库沿用既有补列规则：默认 task，不会被误当成灵感。
    assert.equal(item.kind, 'task');
    assert.equal(item.ideaStatus, 'inbox');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('项目为空能存能读：原文、来源、链接与时间都在', () => {
  const { root, dbPath } = tempDb();
  const store = new OwnerStore(dbPath);
  try {
    const idea = store.addIdeaItem({
      title: '给收件箱加一条提示',
      rawText: '收件箱空的时候应该有一句提示，而不是一片空白。',
      captureSource: 'paste'
    });
    assert.equal(idea.projectId, null);
    assert.equal(idea.kind, 'idea');
    assert.equal(idea.ideaStatus, 'inbox');
    assert.equal(idea.rawText, '收件箱空的时候应该有一句提示，而不是一片空白。');
    assert.equal(idea.captureSource, 'paste');
    assert.equal(idea.link, '');
    assert.ok(idea.createdAt);
    assert.ok(idea.updatedAt);

    const link = store.addIdeaItem({
      title: '链接灵感', rawText: '', captureSource: 'link', link: 'https://example.com/post'
    });
    assert.equal(link.rawText, '链接灵感');
    assert.equal(link.captureSource, 'link');
    assert.equal(link.link, 'https://example.com/post');

    const listed = store.listIdeaInbox();
    assert.deepEqual(listed.map((item) => item.id).sort(), [idea.id, link.id].sort());
    // 有项目的旧想法与新收件箱条目同处一张表；列表是全局的。
    store.registerProject({ id: 'p1', name: 'P1', root });
    const assigned = store.addIdeaItem({
      title: '属于某项目', rawText: '属于某项目的灵感', projectId: 'p1'
    });
    assert.equal(store.getIdeaItem(assigned.id).projectId, 'p1');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('状态只能按 收件箱 → 已整理 → 已采纳/已丢弃 前进', () => {
  const { root, dbPath } = tempDb();
  const store = new OwnerStore(dbPath);
  try {
    const idea = store.addIdeaItem({ title: '状态流转', rawText: '状态流转' });
    assert.equal(idea.ideaStatus, 'inbox');
    // 不能跳过「已整理」。
    assert.throws(() => store.setIdeaStatus(idea.id, 'adopted'), /cannot move/i);
    assert.throws(() => store.setIdeaStatus(idea.id, 'discarded'), /cannot move/i);
    assert.throws(() => store.setIdeaStatus(idea.id, 'unknown'), /Invalid idea status/i);

    const sorted = store.setIdeaStatus(idea.id, 'sorted');
    assert.equal(sorted.ideaStatus, 'sorted');
    assert.ok(sorted.sortedAt);
    const adopted = store.setIdeaStatus(idea.id, 'adopted');
    assert.equal(adopted.ideaStatus, 'adopted');
    assert.equal(adopted.sortedAt, sorted.sortedAt, '已采纳保留整理时间');
    // 终态不再前进。
    assert.throws(() => store.setIdeaStatus(idea.id, 'discarded'), /cannot move/i);

    const second = store.addIdeaItem({ title: '丢弃路径', rawText: '丢弃路径' });
    store.setIdeaStatus(second.id, 'sorted');
    assert.equal(store.setIdeaStatus(second.id, 'discarded').ideaStatus, 'discarded');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('视图两段互斥且计数正确：已采纳/已丢弃都留在已整理', () => {
  const items = [
    { id: 'a', title: '未整理', kind: 'idea', ideaStatus: 'inbox', captureSource: 'paste', createdAt: '2026-11-20T01:00:00.000Z' },
    { id: 'b', title: '已整理', kind: 'idea', ideaStatus: 'sorted', captureSource: 'link', link: 'https://example.com/a', createdAt: '2026-11-20T02:00:00.000Z' },
    { id: 'c', title: '已采纳', kind: 'idea', ideaStatus: 'adopted', createdAt: '2026-11-20T03:00:00.000Z' },
    { id: 'd', title: '已丢弃', kind: 'idea', ideaStatus: 'discarded', createdAt: '2026-11-20T04:00:00.000Z' }
  ];
  const view = ideaInboxView({ items });
  const [inbox, sorted] = view.groups;
  assert.equal(view.groups.length, 2);
  assert.equal(inbox.key, 'inbox');
  assert.equal(inbox.count, 1);
  assert.equal(sorted.key, 'sorted');
  assert.equal(sorted.count, 3);
  assert.deepEqual(view.counts, { inbox: 1, sorted: 3, all: 4 });
  assert.deepEqual(inbox.items.map((item) => item.id), ['a']);
  assert.deepEqual(sorted.items.map((item) => item.id), ['d', 'c', 'b']);
  const seen = [...inbox.items, ...sorted.items].map((item) => item.id);
  assert.equal(new Set(seen).size, seen.length, '同一条不能出现在两段里');
  assert.equal(seen.length, 4);
  // 已整理的徽章要能区分「已整理 / 已采纳 / 已丢弃」。
  assert.equal(sorted.items.find((item) => item.id === 'c').statusLabel, '已采纳');
  assert.equal(sorted.items.find((item) => item.id === 'd').statusLabel, '已丢弃');
  assert.equal(sorted.items.find((item) => item.id === 'b').sourceLabel, '链接');
});

test('空收件箱给提示而不是空白；全空另有说明', () => {
  const onlySorted = ideaInboxView({
    items: [{ id: 's', title: '整理过了', ideaStatus: 'sorted' }]
  });
  const inbox = onlySorted.groups[0];
  assert.equal(inbox.empty, true);
  assert.equal(inbox.items.length, 0);
  assert.match(inbox.emptyHint, /收件箱是空的/);
  assert.equal(onlySorted.groups[1].empty, false);

  const empty = ideaInboxView({ items: [] });
  assert.equal(empty.counts.inbox, 0);
  assert.equal(empty.counts.sorted, 0);
  assert.ok(empty.empty);
  assert.match(empty.empty.title, /收件箱/);
  assert.ok(empty.empty.detail.length > 0);
});

test('无项目条目在视图里显示为未归属，不显示 null', () => {
  const view = ideaInboxView({
    items: [{ id: 'x', title: '全球灵感', ideaStatus: 'inbox', projectId: null }]
  });
  const item = view.groups[0].items[0];
  assert.equal(item.projectId, null);
  assert.equal(item.projectLabel, '未归属');
});
