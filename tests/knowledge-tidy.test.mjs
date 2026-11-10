// 知识整理：重复、需复核、冲突与未验证的只读扫描。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { knowledgeTidyFor, similarity } from '../src/knowledge/tidy.mjs';

test('相似度对相同内容为 1，对无关内容很低', () => {
  assert.equal(similarity('重试循环少执行一次', '重试循环少执行一次'), 1);
  assert.ok(similarity('重试循环少执行一次', '完全无关的数据库迁移说明') < 0.3);
});

test('扫描重复、需复核、冲突和未验证知识', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidy-'));
  const store = new PersonalKnowledgeStore(path.join(root, 'knowledge.sqlite'));
  try {
    const base = {
      kind: 'claim', layer: 'project', scope: 'project', projectId: 'p1',
      domains: ['software-engineering'], tags: ['retry'], evidenceRefs: [], sourceRef: 'test'
    };
    store.create({ ...base, title: 'Retry loop bound', content: 'Use i < attempts so the final retry executes.', verificationStatus: 'verified', evidenceRefs: ['sandbox:r1'] });
    store.create({ ...base, title: 'Retry loop bound', content: 'Use i < attempts so the final retry executes.', verificationStatus: 'unverified' });
    store.create({ ...base, title: 'Old sandbox note', content: '这个结论需要重新验证。', verificationStatus: 'needs_reverification' });
    store.create({ ...base, title: 'Conflicting note', content: '与现有结论冲突。', verificationStatus: 'disputed' });
    const report = knowledgeTidyFor({ personalStore: store, projectId: 'p1' });
    assert.equal(report.counts.total, 4);
    assert.equal(report.counts.duplicates, 1);
    assert.equal(report.counts.stale, 1);
    assert.equal(report.counts.conflicts, 1);
    assert.equal(report.counts.unverified, 1);
    assert.equal(report.duplicates[0].a.title, 'Retry loop bound');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
