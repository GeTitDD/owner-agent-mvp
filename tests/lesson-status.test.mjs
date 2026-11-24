// 经验状态只存一列（P0-2）：五种状态都写在 knowledge_lessons.verification_status 上，
// payload 里不再存第二份；旧表（两态 CHECK）只在守卫命中时重建一次，且重建可重复执行。
// 只断言外部行为：建模语句造旧库、开关 store、读回来的状态与数据；不联网、不调模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { retrieveLessons } from '../src/knowledge-loop/retrieval.mjs';

const lesson = (overrides = {}) => ({
  projectId: 'p1',
  sourceRecordId: 'sandbox:run1',
  phenomenon: 'retry 循环少跑一次，最后一次重试不执行',
  mechanism: 'for 循环写成 i < attempts - 1',
  countermeasure: '改成 i < attempts，并用同一条断言复跑测试',
  scope: { layer: 'project', projectId: 'p1', domainIds: ['software-engineering'] },
  verificationStatus: 'unverified',
  evidenceRefs: ['sandbox:run1'],
  createdAt: '2026-02-01T00:00:00.000Z',
  ...overrides
});

const evidence = (ref) => [{ ref, recordId: ref, kind: 'record', excerpt: 'test=fail' }];

/** 旧版建表语句：CHECK 只允许 unverified / inferred（P0-2 之前的形态）。 */
const seedLegacyLessonTable = (file) => {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE knowledge_lessons (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_record_id TEXT NOT NULL,
      phenomenon TEXT NOT NULL, scope_layer TEXT NOT NULL CHECK(scope_layer IN ('project','domain')),
      verification_status TEXT NOT NULL CHECK(verification_status IN ('unverified','inferred')),
      dedupe_key TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL
    );
    CREATE INDEX knowledge_lessons_project ON knowledge_lessons(project_id,created_at DESC);
    CREATE INDEX knowledge_lessons_source ON knowledge_lessons(source_record_id);
    CREATE INDEX knowledge_lessons_dedupe ON knowledge_lessons(dedupe_key);
    CREATE TABLE knowledge_lesson_evidence (
      id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL REFERENCES knowledge_lessons(id), record_id TEXT NOT NULL,
      ref TEXT NOT NULL, kind TEXT NOT NULL, excerpt TEXT NOT NULL, content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, UNIQUE(lesson_id,ref)
    );
  `);
  // 旧行：状态同时存了列与 payload 两份（正是本次要消掉的那种形态）。
  const payload = JSON.stringify({
    id: 'lesson_legacy', projectId: 'p1', sourceRecordId: 'sandbox:run1',
    phenomenon: '旧库里的现象', mechanism: 'm', countermeasure: 'c',
    scope: { layer: 'project', projectId: 'p1', domainIds: [] },
    verificationStatus: 'inferred', evidenceRefs: ['sandbox:run1']
  });
  db.prepare(`INSERT INTO knowledge_lessons(id,project_id,source_record_id,phenomenon,scope_layer,verification_status,dedupe_key,created_at,payload,payload_hash)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run('lesson_legacy', 'p1', 'sandbox:run1', '旧库里的现象', 'project',
    'inferred', 'dedupe-legacy', '2026-01-01T00:00:00.000Z', payload, 'hash');
  db.prepare(`INSERT INTO knowledge_lesson_evidence(id,lesson_id,record_id,ref,kind,excerpt,content_hash,created_at)
    VALUES(?,?,?,?,?,?,?,?)`).run('le_legacy', 'lesson_legacy', 'sandbox:run1', 'sandbox:run1', 'record', 'x', 'h',
    '2026-01-01T00:00:00.000Z');
  db.close();
};

const tempDb = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-status-'));
  return { dir, file: path.join(dir, 'knowledge.sqlite') };
};

const tableSql = (store, name = 'knowledge_lessons') =>
  String(store.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)?.sql ?? '');

const rawPayload = (store, id) =>
  JSON.parse(store.db.prepare('SELECT payload FROM knowledge_lessons WHERE id=?').get(id).payload);

test('新库的状态列允许五种状态，且只允许这五种', () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    const sql = tableSql(store);
    for (const status of ['unverified', 'inferred', 'verified', 'disputed', 'superseded']) {
      assert.ok(sql.includes(`'${status}'`), `建表语句必须允许 ${status}`);
    }
    // 新库不需要重建：建表语句里已经含 verified。
    assert.deepEqual(store.lastLessonStatusMigration, { rebuilt: false, reason: 'current', rows: 0 });
    const row = store.addLesson(lesson(), { evidence: evidence('sandbox:run1') });
    assert.throws(
      () => store.db.prepare('UPDATE knowledge_lessons SET verification_status=? WHERE id=?').run('maybe', row.id),
      /CHECK constraint/u,
      '五种之外的状态必须被库拒绝'
    );
  } finally { store.close(); }
});

test('状态只存一列：payload 里没有第二份 verificationStatus，也没有 dispute.status', () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    const first = store.addLesson(lesson(), { evidence: evidence('sandbox:run1') });
    assert.equal(rawPayload(store, first.id).verificationStatus, undefined, 'payload 不存状态');
    assert.equal(store.getLesson(first.id).verificationStatus, 'unverified', '状态从列读回');

    // 争议：状态写在列上，payload.dispute 只留裁决过程与争议前状态。
    const second = store.recordLessonOrDispute(lesson({
      sourceRecordId: 'sandbox:run2',
      countermeasure: '改成 while 循环直到成功，并加最大尝试次数上限'
    }), { evidence: evidence('sandbox:run2') });
    const disputedRow = store.db.prepare('SELECT verification_status FROM knowledge_lessons WHERE id=?').get(second.id);
    assert.equal(disputedRow.verification_status, 'disputed', '争议状态写进那一列');
    const disputedPayload = rawPayload(store, second.id);
    assert.equal(disputedPayload.verificationStatus, undefined);
    assert.equal(disputedPayload.dispute?.status, undefined, '裁决过程不再重复存当前状态');
    assert.equal(disputedPayload.dispute?.priorStatus, 'unverified', '只留「争议前是什么状态」，供裁决恢复');
    assert.equal(store.lessonStatus(second.id), 'disputed');
    assert.equal(store.lessonDispute(second.id).status, 'disputed');

    // 裁决：赢家回到争议前的状态，输家写 superseded。
    const resolved = store.resolveLessonDispute(first.id, second.id, { note: '以第一次复跑为准' });
    assert.equal(store.lessonStatus(first.id), 'unverified', '裁决不等于验证');
    assert.equal(store.lessonStatus(second.id), 'superseded');
    assert.equal(resolved.loser.verificationStatus, 'superseded');
    assert.equal(store.lessonDispute(first.id).status, 'resolved');
    // 输家的 payload 里也没有第二份状态。
    assert.equal(rawPayload(store, second.id).verificationStatus, undefined);
  } finally { store.close(); }
});

test('「已验证优先」不再空转：列上的 verified 会被检索排到最前', () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    const verified = store.addLesson(lesson({ phenomenon: '已验证的现象' }), { evidence: evidence('sandbox:run1') });
    const pending = store.addLesson(lesson({
      phenomenon: '待验证的现象', sourceRecordId: 'sandbox:run2', evidenceRefs: ['sandbox:run2']
    }), { evidence: evidence('sandbox:run2') });
    const inferred = store.addLesson(lesson({
      phenomenon: '推断的现象', sourceRecordId: 'sandbox:run3',
      verificationStatus: 'inferred', evidenceRefs: []
    }), { evidence: [] });
    // 目前没有「人点一下升为已验证」的入口（属于后续票），测试直接写那一列模拟人工确认。
    store.db.prepare('UPDATE knowledge_lessons SET verification_status=? WHERE id=?').run('verified', verified.id);

    const result = retrieveLessons({ personalStore: store, projectId: 'p1' });
    assert.deepEqual(result.items.map((item) => item.verificationStatus), ['verified', 'unverified', 'inferred']);
    assert.equal(result.items[0].statusLabel, '已验证');
    assert.deepEqual(result.items.map((item) => item.id), [verified.id, pending.id, inferred.id]);
  } finally { store.close(); }
});

test('旧库（两态 CHECK）在初始化时按守卫重建一次，数据与索引都保留', () => {
  const { dir, file } = tempDb();
  try {
    seedLegacyLessonTable(file);
    const first = new PersonalKnowledgeStore(file);
    try {
      assert.equal(first.lastLessonStatusMigration.rebuilt, true);
      assert.equal(first.lastLessonStatusMigration.reason, 'legacy-check');
      assert.equal(first.lastLessonStatusMigration.rows, 1);
      assert.ok(tableSql(first).includes("'verified'"), '重建后建表语句允许 verified');
      // 数据与证据行原样保留，状态仍从列读。
      const row = first.getLesson('lesson_legacy');
      assert.equal(row.phenomenon, '旧库里的现象');
      assert.equal(row.verificationStatus, 'inferred');
      assert.equal(row.evidence.length, 1);
      // 索引随表重建一起回来。
      const indexes = first.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='knowledge_lessons'").all()
        .map((item) => item.name);
      for (const name of ['knowledge_lessons_project', 'knowledge_lessons_source', 'knowledge_lessons_dedupe']) {
        assert.ok(indexes.includes(name), `索引 ${name} 必须重建`);
      }
      // 升级之后五种状态都能写。
      first.db.prepare('UPDATE knowledge_lessons SET verification_status=? WHERE id=?').run('disputed', 'lesson_legacy');
      assert.equal(first.lessonStatus('lesson_legacy'), 'disputed');
    } finally { first.close(); }

    // 重复初始化是空操作：不再重建，数据不动。
    const second = new PersonalKnowledgeStore(file);
    try {
      assert.deepEqual(second.lastLessonStatusMigration, { rebuilt: false, reason: 'current', rows: 0 });
      assert.equal(second.getLesson('lesson_legacy').evidence.length, 1);
      assert.equal(second.lessonStatus('lesson_legacy'), 'disputed');
    } finally { second.close(); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
