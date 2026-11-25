// 项目库快照（#89）：草稿可覆盖、发布分配递增版本、已发布不可改、重启后仍在。
// 只压存储行为与纯函数的组装；不碰 Electron、不联网、不写真实用户目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ProjectSnapshotStore,
  SNAPSHOT_FORMAT,
  SNAPSHOT_IMMUTABLE_CODE,
  SnapshotError,
  snapshotContentOf,
  snapshotStateOf
} from '../src/project-snapshots.mjs';
import { projectLibraryView } from '../src/project-library.mjs';

const tempDb = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-snapshots-'));
  return { dir, file: path.join(dir, 'owner.sqlite') };
};

const cleanup = (dir) => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 下偶发占用，忽略 */ }
};

const PROJECT = {
  id: 'p1',
  name: '演示项目',
  primaryDomain: 'software-engineering',
  domains: ['software-engineering']
};

const lesson = ({ id, status = 'verified', title = `现象 ${id}` } = {}) => ({
  id,
  projectId: PROJECT.id,
  phenomenon: title,
  mechanism: `机制 ${id}`,
  countermeasure: `对策 ${id}`,
  scope: { layer: 'project', projectId: PROJECT.id, domainIds: ['software-engineering'] },
  verificationStatus: status,
  evidence: [{ ref: `sandbox:${id}`, recordId: `sandbox:${id}`, kind: 'record' }],
  createdAt: '2026-11-20T00:00:00.000Z'
});

const unit = ({ id, status = 'verified', at = '2026-11-21T00:00:00.000Z', projectId = null } = {}) => ({
  id,
  revision: 3,
  title: `知识 ${id}`,
  content: `内容 ${id}`,
  kind: 'claim',
  scope: projectId ? 'project' : 'domain',
  layer: projectId ? 'project' : 'applied',
  projectId,
  domains: ['software-engineering'],
  verificationStatus: status,
  evidenceRefs: [`evidence:${id}`],
  updatedAt: at
});

const viewOf = ({ limit = 50, lessons = [], knowledge = [] } = {}) => projectLibraryView({
  project: PROJECT,
  lessons,
  knowledge,
  profile: {
    oneLiner: '一个演示项目',
    whatItIs: '用来演示项目库',
    basedOnCommit: 'abc1234',
    generatedAt: '2026-11-22T00:00:00.000Z'
  },
  diagrams: [{ kind: 'dependency', title: '依赖图', basedOnCommit: 'abc1234' }],
  limit
});

const contentOf = (options) => snapshotContentOf(viewOf(options), {
  generatedAt: '2026-11-23T00:00:00.000Z'
});

test('草稿：反复生成只有一份，覆盖旧内容，没有版本号', () => {
  const { dir, file } = tempDb();
  const store = new ProjectSnapshotStore(file);
  try {
    const first = store.saveDraft({
      projectId: 'p1',
      content: { format: SNAPSHOT_FORMAT, counts: { verified: 1, observing: 0, total: 1 }, sections: [] }
    });
    const second = store.saveDraft({
      projectId: 'p1',
      content: { format: SNAPSHOT_FORMAT, counts: { verified: 2, observing: 1, total: 3 }, sections: [] }
    });
    assert.equal(first.contentHash.length, 64);
    assert.deepEqual(second.counts, { verified: 2, observing: 1, total: 3 });
    assert.equal('version' in second, false);
    assert.equal(store.getDraft('p1').content.counts.total, 3);
    // 草稿表每个项目一行：第二次是覆盖，不是追加。
    const rows = store.db.prepare('SELECT COUNT(*) AS n FROM project_snapshot_drafts WHERE project_id=?').get('p1');
    assert.equal(Number(rows.n), 1);
    assert.deepEqual(store.listVersions('p1'), []);
  } finally {
    store.close();
    cleanup(dir);
  }
});

test('发布：按项目单调递增，v1 起步，草稿仍保留且没有版本号', () => {
  const { dir, file } = tempDb();
  const store = new ProjectSnapshotStore(file);
  try {
    store.saveDraft({ projectId: 'p1', content: contentOf({ lessons: [lesson({ id: 'l1' })] }) });
    const v1 = store.publish({ projectId: 'p1', now: '2026-11-24T01:00:00.000Z' });
    assert.equal(v1.version, 1);
    assert.equal(v1.publishedAt, '2026-11-24T01:00:00.000Z');
    const v2 = store.publish({ projectId: 'p1', now: '2026-11-24T02:00:00.000Z' });
    assert.equal(v2.version, 2);
    // 另一个项目从自己的 v1 开始，不共享计数器。
    store.saveDraft({ projectId: 'p2', content: contentOf({}) });
    assert.equal(store.publish({ projectId: 'p2' }).version, 1);
    // 草稿不是版本：发布后仍只有一份草稿。
    assert.equal(store.getDraft('p1').content.sections.length, 2);
    assert.deepEqual(store.listVersions('p1').map((item) => item.version), [2, 1]);
    // 没有草稿时发布明确失败，不现拍一份。
    assert.throws(() => store.publish({ projectId: 'p3' }), /还没有草稿/u);
  } finally {
    store.close();
    cleanup(dir);
  }
});

test('不可变：改已发布版本明确失败，连直接 UPDATE 也被触发器拒绝', () => {
  const { dir, file } = tempDb();
  const store = new ProjectSnapshotStore(file);
  try {
    store.saveDraft({ projectId: 'p1', content: contentOf({ lessons: [lesson({ id: 'l1' })] }) });
    const published = store.publish({ projectId: 'p1' });
    assert.throws(
      () => store.amendPublished({ projectId: 'p1', version: published.version }),
      (thrown) => thrown instanceof SnapshotError
        && thrown.code === SNAPSHOT_IMMUTABLE_CODE
        && /不可修改/u.test(thrown.message)
    );
    // 绕过类直接写库也必须失败：不可变不是调用约定，是表结构的一部分。
    assert.throws(() => store.db.prepare(
      'UPDATE project_snapshot_versions SET content=? WHERE project_id=? AND version=?'
    ).run('{"format":"tampered"}', 'p1', published.version), /immutable/u);
    assert.equal(store.getVersion('p1', published.version).content.counts.total, 1);
  } finally {
    store.close();
    cleanup(dir);
  }
});

test('复制而非引用：发布后源数据再变，版本内容不变', () => {
  const { dir, file } = tempDb();
  const store = new ProjectSnapshotStore(file);
  try {
    const source = contentOf({ lessons: [lesson({ id: 'l1', title: '原始结论' })] });
    store.saveDraft({ projectId: 'p1', content: source });
    const published = store.publish({ projectId: 'p1' });
    // 模拟之后知识被改：同名对象与条目都变，但已发布版本只认当时那份 JSON。
    source.sections[0].items[0].title = '改过的结论';
    source.counts.total = 99;
    const reread = store.getVersion('p1', published.version);
    assert.equal(reread.content.sections[0].items[0].title, '原始结论');
    assert.equal(reread.content.counts.total, 1);
    // 重新生成草稿也不动已有版本。
    store.saveDraft({ projectId: 'p1', content: contentOf({ lessons: [lesson({ id: 'l2' })] }) });
    assert.equal(store.getVersion('p1', published.version).contentHash, published.contentHash);
    assert.equal(store.listVersions('p1').length, 1);
  } finally {
    store.close();
    cleanup(dir);
  }
});

test('重启保留：关掉再开，草稿与版本都还在', () => {
  const { dir, file } = tempDb();
  try {
    const first = new ProjectSnapshotStore(file);
    first.saveDraft({ projectId: 'p1', content: contentOf({ lessons: [lesson({ id: 'l1' })] }) });
    first.publish({ projectId: 'p1', now: '2026-11-24T00:00:00.000Z' });
    first.close();

    const second = new ProjectSnapshotStore(file);
    try {
      assert.equal(second.getDraft('p1').counts.total, 1);
      assert.equal(second.listVersions('p1')[0].version, 1);
      assert.equal(second.listVersions('p1')[0].publishedAt, '2026-11-24T00:00:00.000Z');
      // 重启后版本号接着上次的往下发，不回到 v1。
      second.publish({ projectId: 'p1' });
      assert.deepEqual(second.listVersions('p1').map((item) => item.version), [2, 1]);
    } finally {
      second.close();
    }
  } finally {
    cleanup(dir);
  }
});

test('不误删：更换草稿、发布别的项目、读版本都不会删掉已有快照', () => {
  const { dir, file } = tempDb();
  const store = new ProjectSnapshotStore(file);
  try {
    store.saveDraft({ projectId: 'p1', content: contentOf({}) });
    store.publish({ projectId: 'p1' });
    store.saveDraft({ projectId: 'p1', content: contentOf({ lessons: [lesson({ id: 'l1' })] }) });
    store.saveDraft({ projectId: 'p2', content: contentOf({}) });
    store.publish({ projectId: 'p2' });
    store.listVersions('p1');
    store.getVersion('p1', 1);
    assert.deepEqual(store.listVersions('p1').map((item) => item.version), [1]);
    assert.equal(store.getDraft('p2').projectId, 'p2');
    // 本张票不提供删版本的公开入口；删除连坐留给「删除项目」那张票。
    assert.equal(typeof store.deleteProjectSnapshots, 'undefined');
  } finally {
    store.close();
    cleanup(dir);
  }
});

test('快照内容：结论 + 证据引用，两节互斥不丢，条目不因面板 limit 被截断', () => {
  const content = contentOf({
    // 面板一屏只显示 1 条，快照必须仍是全量。
    limit: 1,
    lessons: [
      lesson({ id: 'l-verified' }),
      lesson({ id: 'l-observing', status: 'unverified' })
    ],
    knowledge: [
      unit({ id: 'k-domain' }),
      unit({ id: 'k-observing', status: 'unverified' }),
      unit({ id: 'k-contributed', projectId: PROJECT.id })
    ]
  });

  assert.equal(content.format, SNAPSHOT_FORMAT);
  assert.deepEqual(content.sections.map((section) => section.key), ['verified', 'observing']);
  assert.deepEqual(content.sections.map((section) => section.label), ['已验证', '观察中']);
  assert.equal(content.sections[0].count + content.sections[1].count, content.counts.total);
  assert.equal(content.counts.total, 5);
  assert.equal(content.sections[0].items.length, 3);
  assert.equal(content.sections[1].items.length, 2);
  // 条目只有结论与引用，没有正文摘录，也没有 HTML/图片。
  const lessonItem = content.sections[0].items.find((item) => item.ref.id === 'l-verified');
  assert.deepEqual(Object.keys(lessonItem).sort(), ['at', 'badge', 'detail', 'evidence', 'ref', 'status', 'title']);
  assert.equal(lessonItem.ref.kind, 'lesson');
  assert.deepEqual(lessonItem.evidence, [{ kind: 'record', ref: 'sandbox:l-verified' }]);
  // 贡献知识带 revision，能指回当时是哪一版。
  const contributed = content.sections[0].items.find((item) => item.ref.id === 'k-contributed');
  assert.equal(contributed.ref.revision, 3);
  assert.deepEqual(contributed.evidence, [{ kind: 'evidence', ref: 'evidence:k-contributed' }]);
  // 画像与图谱以只读摘要进快照，缺的类别在 missingDiagrams 里写明。
  assert.equal(content.assets.profile.available, true);
  assert.equal(content.assets.diagrams.find((item) => item.kind === 'dependency').available, true);
  assert.ok(content.assets.missingDiagrams.includes('control'));
});

test('快照拒绝二进制/函数等非 JSON 数据', () => {
  const { dir, file } = tempDb();
  const store = new ProjectSnapshotStore(file);
  try {
    assert.throws(
      () => store.saveDraft({ projectId: 'p1', content: { format: SNAPSHOT_FORMAT, image: Buffer.from('png') } }),
      /不存二进制/u
    );
    assert.throws(
      () => store.saveDraft({ projectId: 'p1', content: { format: SNAPSHOT_FORMAT, fn: () => 1 } }),
      /JSON/u
    );
    assert.equal(store.getDraft('p1'), null);
  } finally {
    store.close();
    cleanup(dir);
  }
});

test('面板摘要：草稿、版本、下一版号只从纯函数算', () => {
  const draft = {
    generatedAt: '2026-11-24T00:00:00.000Z',
    note: '给同事看',
    content: { counts: { verified: 2, observing: 1, total: 3 } }
  };
  const versions = [
    { version: 2, publishedAt: '2026-11-25T00:00:00.000Z', contentHash: 'b', counts: { verified: 2, observing: 1, total: 3 } },
    { version: 1, publishedAt: '2026-11-24T00:00:00.000Z', contentHash: 'a', counts: { verified: 1, observing: 0, total: 1 } }
  ];
  const state = snapshotStateOf({ draft, versions });
  assert.equal(state.hasDraft, true);
  assert.equal(state.draft.counts.total, 3);
  assert.deepEqual(state.versions.map((item) => item.label), ['v2', 'v1']);
  assert.equal(state.latestVersion, 2);
  assert.equal(state.nextVersion, 3);
  assert.equal(state.nextLabel, 'v3');
  // 空库：没有草稿时下一版仍是 v1，发布按钮由调用方据此禁用。
  const empty = snapshotStateOf({});
  assert.equal(empty.hasDraft, false);
  assert.equal(empty.nextLabel, 'v1');
  assert.deepEqual(empty.versions, []);
});
