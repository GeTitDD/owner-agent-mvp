// 旧经验表退役（#62）：新库不再建表；旧库的空表在初始化时删除；非空不删并留下明确日志。
// 重复初始化必须幂等——删过的表再进来只是「不存在」，不是错误。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';

const TABLE = 'knowledge_experiences';

const tempDb = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'experience-retirement-'));
  return { dir, file: path.join(dir, 'index.sqlite') };
};

const tableExists = (store, name = TABLE) =>
  Boolean(store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name));

const indexExists = (store, name) =>
  Boolean(store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
    .get(name));

/** 按旧版 schema 造一张 knowledge_experiences：验证「旧库」的初始化路径。 */
const seedLegacyTable = (file, { rows = [] } = {}) => {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE knowledge_experiences (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT,
      source_run_id TEXT NOT NULL, outcome TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL
    );
    CREATE INDEX knowledge_experiences_project ON knowledge_experiences(project_id,created_at DESC);
  `);
  const insert = db.prepare(`INSERT INTO knowledge_experiences(id,project_id,task_id,source_run_id,outcome,dedupe_key,created_at,payload,payload_hash)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  for (const row of rows) {
    insert.run(row.id, row.projectId, null, row.sourceRunId, 'succeeded', `dedupe-${row.id}`,
      '2026-01-01T00:00:00.000Z', JSON.stringify({ id: row.id }), 'hash');
  }
  db.close();
};

/** 只收集警告的假 logger：断言「非空不删」留下了可读日志，同时不污染测试输出。 */
const fakeLogger = () => {
  const lines = [];
  return {
    lines,
    info: (message) => lines.push(String(message)),
    warn: (message) => lines.push(String(message)),
    error: (message) => lines.push(String(message))
  };
};

test('新库初始化后没有 knowledge_experiences 表，旧读写方法也不再存在', () => {
  const store = new PersonalKnowledgeStore(':memory:');
  try {
    assert.equal(tableExists(store), false);
    assert.equal(indexExists(store, 'knowledge_experiences_project'), false);
    assert.deepEqual(store.lastExperienceRetirement, { dropped: false, reason: 'absent', rows: 0 });
    // 停写在存储层就是「没有入口」：旧方法整体消失，调用方无处可写。
    for (const method of ['addExperience', 'getExperience', 'experienceByDedupe', 'listExperiences']) {
      assert.equal(typeof store[method], 'undefined', `${method} 应已随旧表退役`);
    }
  } finally {
    store.close();
  }
});

test('旧库里空的 knowledge_experiences 在初始化时被删除，重复初始化幂等', () => {
  const { dir, file } = tempDb();
  try {
    seedLegacyTable(file);
    const first = new PersonalKnowledgeStore(file);
    let second;
    try {
      assert.equal(tableExists(first), false);
      assert.equal(indexExists(first, 'knowledge_experiences_project'), false);
      assert.deepEqual(first.lastExperienceRetirement, { dropped: true, reason: 'empty', rows: 0 });
    } finally {
      first.close();
    }
    // 第二次初始化：表已不存在，仍然是成功的空操作，不报错、不重建。
    second = new PersonalKnowledgeStore(file);
    try {
      assert.equal(tableExists(second), false);
      assert.deepEqual(second.lastExperienceRetirement, { dropped: false, reason: 'absent', rows: 0 });
    } finally {
      second.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('旧经验表非空时不删，保留数据并留下明确日志', () => {
  const { dir, file } = tempDb();
  const logger = fakeLogger();
  try {
    seedLegacyTable(file, { rows: [{ id: 'exp_1', projectId: 'p1', sourceRunId: 'run_1' }] });
    const store = new PersonalKnowledgeStore(file, { logger });
    try {
      assert.equal(tableExists(store), true, '有数据的旧表必须原样保留');
      const rows = store.db.prepare('SELECT id FROM knowledge_experiences').all();
      assert.deepEqual(rows.map((row) => row.id), ['exp_1']);
      assert.equal(store.lastExperienceRetirement.dropped, false);
      assert.equal(store.lastExperienceRetirement.reason, 'not-empty');
      assert.equal(store.lastExperienceRetirement.rows, 1);
      // 日志必须点明「有几行」「保留」「不删」，方便人决定是否导出后手动清理。
      const message = logger.lines.join('\n');
      assert.match(message, /knowledge_experiences/u);
      assert.match(message, /1 行/u);
      assert.match(message, /保留/u);
      assert.match(message, /不删/u);
    } finally {
      store.close();
    }
    // 再次初始化仍不删：幂等的是「判定」，不是「删掉」。
    const again = new PersonalKnowledgeStore(file, { logger: fakeLogger() });
    try {
      assert.equal(tableExists(again), true);
      assert.equal(again.lastExperienceRetirement.reason, 'not-empty');
    } finally {
      again.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('退役旧表不影响新链路：同一库仍可写经验（lesson）与知识', () => {
  const { dir, file } = tempDb();
  try {
    seedLegacyTable(file);
    const store = new PersonalKnowledgeStore(file);
    try {
      const unit = store.create({
        title: 'Retry loop bound', content: 'Use i < attempts so the last retry runs.',
        kind: 'claim', layer: 'project', scope: 'project', projectId: 'p1',
        domains: [], tags: [], evidenceRefs: ['evidence:run-a'], verificationStatus: 'unverified'
      });
      const lesson = store.addLesson({
        projectId: 'p1', sourceRecordId: 'sandbox:run-a',
        phenomenon: 'retry loop dropped the last attempt',
        mechanism: 'loop bound was exclusive',
        countermeasure: 'use i < attempts',
        scope: { layer: 'project', projectId: 'p1', domainIds: [] },
        verificationStatus: 'unverified', evidenceRefs: ['evidence:run-a']
      }, { evidence: [{ ref: 'evidence:run-a', recordId: 'run-a', kind: 'log', excerpt: 'attempt 3 missing' }] });
      assert.equal(store.get(unit.id).title, 'Retry loop bound');
      assert.equal(store.getLesson(lesson.id).phenomenon, 'retry loop dropped the last attempt');
      assert.equal(tableExists(store), false);
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('文件库重复初始化不重复建旧表', () => {
  const { dir, file } = tempDb();
  try {
    for (let index = 0; index < 2; index += 1) {
      const store = new PersonalKnowledgeStore(file);
      try {
        assert.equal(tableExists(store), false, `第 ${index + 1} 次初始化后不应有旧表`);
      } finally {
        store.close();
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
