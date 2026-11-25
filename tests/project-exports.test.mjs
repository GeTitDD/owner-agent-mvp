// 项目库导出（#90）：给一份已发布的快照，写出机器可读的 snapshot.json 与一份人读物。
//
// 只测纯函数与文件落盘（临时目录）：不碰 Electron、不联网、不写真实用户目录。
// 三条硬约束各有一组测试：
// 1. 不重新聚合：导出只吃快照内容，报告里的条目逐条来自快照 sections；
// 2. 缺图写明缺，不静默留白、不现画；
// 3. 重复导出逐字节相同（时间只取快照 / 发布记录里的，不取当前时间）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ExportError,
  REPORT_FILE,
  SNAPSHOT_FILE,
  exportFilesOf,
  renderReportHtml,
  reportModelOf,
  writeExport
} from '../src/project-exports.mjs';
import { ProjectSnapshotStore, snapshotContentOf } from '../src/project-snapshots.mjs';
import { projectLibraryView } from '../src/project-library.mjs';
import { DIAGRAM_KINDS } from '../src/project-diagrams.mjs';
import { sha256 } from '../src/utils.mjs';

const PROJECT = {
  id: 'p1',
  name: '演示项目',
  primaryDomain: 'software-engineering',
  domains: ['software-engineering']
};

const lesson = ({ id, title = `现象 ${id}`, status = 'verified' } = {}) => ({
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

const unit = ({ id, title = `知识 ${id}`, status = 'verified' } = {}) => ({
  id,
  revision: 2,
  title,
  content: `内容 ${id}`,
  kind: 'claim',
  scope: 'domain',
  layer: 'applied',
  domains: ['software-engineering'],
  verificationStatus: status,
  evidenceRefs: [`evidence:${id}`],
  updatedAt: '2026-11-21T00:00:00.000Z'
});

const contentOf = ({ lessons = [], knowledge = [], diagrams = undefined, profile = undefined, limit = 50 } = {}) => {
  const view = projectLibraryView({
    project: PROJECT,
    lessons,
    knowledge,
    profile: profile === undefined
      ? {
          oneLiner: '一个用于演示项目库的零依赖项目',
          whatItIs: '演示项目',
          basedOnCommit: 'abc1234',
          generatedAt: '2026-11-22T00:00:00.000Z'
        }
      : profile,
    diagrams: diagrams === undefined
      ? [{ kind: 'dependency', title: '依赖图', summary: '三个模块互相依赖', basedOnCommit: 'abc1234' }]
      : diagrams,
    limit
  });
  return snapshotContentOf(view, { generatedAt: '2026-11-23T00:00:00.000Z' });
};

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'owner-exports-'));
const cleanup = (dir) => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 下偶发占用，忽略 */ }
};

test('路径：按「项目 / 版本」可预测，非法 id 与版本被拒绝（不拼出目录穿越）', () => {
  const root = path.join('C:', 'tmp', 'exports');
  const files = exportFilesOf({ root, projectId: 'p1', version: 3 });
  assert.equal(files.dir, path.join(root, 'p1', 'v3'));
  assert.equal(files.snapshotPath, path.join(root, 'p1', 'v3', SNAPSHOT_FILE));
  assert.equal(files.reportPath, path.join(root, 'p1', 'v3', REPORT_FILE));
  assert.equal(path.basename(files.snapshotPath), 'snapshot.json');
  assert.equal(path.basename(files.reportPath), 'report.html');
  for (const bad of ['../evil', 'a/b', '', 'p 1', '.hidden', 'py;rm', 'x'.repeat(91)]) {
    assert.throws(() => exportFilesOf({ root, projectId: bad, version: 1 }), ExportError, bad);
  }
  for (const bad of [0, -1, 1.5, '1', Number.NaN]) {
    assert.throws(() => exportFilesOf({ root, projectId: 'p1', version: bad }), ExportError, String(bad));
  }
  assert.throws(() => exportFilesOf({ root: '', projectId: 'p1', version: 1 }), ExportError);
});

test('人读物分节：两节互斥、合计等于总数，条目逐条等于快照（标题 / 徽章 / 证据引用）', () => {
  const content = contentOf({
    lessons: [lesson({ id: 'l-ok' }), lesson({ id: 'l-watch', status: 'unverified' })],
    knowledge: [unit({ id: 'k-ok' }), unit({ id: 'k-watch', status: 'unverified' })]
  });
  const model = reportModelOf(content, {
    version: 2,
    publishedAt: '2026-11-24T01:00:00.000Z',
    contentHash: 'a'.repeat(64)
  });

  assert.equal(model.version, 2);
  assert.equal(model.label, 'v2');
  assert.equal(model.publishedAt, '2026-11-24T01:00:00.000Z');
  assert.equal(model.projectName, '演示项目');
  assert.equal(model.oneLiner, '一个用于演示项目库的零依赖项目');
  assert.deepEqual(model.sections.map((section) => section.key), ['verified', 'observing']);
  assert.deepEqual(model.sections.map((section) => section.label), ['已验证', '观察中']);
  assert.equal(model.sections[0].items.length, content.sections[0].items.length);
  assert.equal(model.sections[1].items.length, content.sections[1].items.length);
  assert.equal(model.sections[0].count + model.sections[1].count, content.counts.total);
  // 互斥：同一条引用不会同时出现在两节。
  const ids = (section) => section.items.map((item) => `${item.ref.kind}:${item.ref.id}`);
  assert.equal(new Set([...ids(model.sections[0]), ...ids(model.sections[1])]).size, content.counts.total);
  // 逐条核对（不是只看条数）：标题、徽章、明细与证据引用都照快照写。
  const snapshotFirst = content.sections[0].items[0];
  const reportFirst = model.sections[0].items[0];
  assert.equal(reportFirst.title, snapshotFirst.title);
  assert.equal(reportFirst.badge, snapshotFirst.badge);
  assert.equal(reportFirst.detail, snapshotFirst.detail);
  assert.deepEqual(reportFirst.evidence, snapshotFirst.evidence);
  assert.equal(reportFirst.at, snapshotFirst.at);
  // 四类计数：经验 / 领域知识 / 升上去的知识 / 画像与图谱。
  assert.deepEqual(model.classes.map((entry) => entry.key),
    ['experiences', 'domainKnowledge', 'contributedKnowledge', 'assets']);
  assert.equal(model.classes[0].value, content.counts.experiences);
  assert.equal(model.classes[1].value, content.counts.domainKnowledge);
  assert.equal(model.classes[2].value, content.counts.contributedKnowledge);
  assert.equal(model.classes[3].value, content.counts.profile + content.counts.diagrams);
  assert.equal(model.totals.verified + model.totals.observing, model.totals.total);
});

test('画像与图谱：每类一张代表，缺的显式写「缺」，不现画也不留白', () => {
  const content = contentOf({
    lessons: [lesson({ id: 'l1' })],
    // 只给依赖图：其余四类必须逐类写明缺。
    diagrams: [{ kind: 'dependency', title: '依赖图', summary: '三个模块互相依赖', basedOnCommit: 'abc1234' }]
  });
  const model = reportModelOf(content, { version: 1, publishedAt: '2026-11-24T00:00:00.000Z' });
  assert.deepEqual(model.diagrams.map((diagram) => diagram.kind), [...DIAGRAM_KINDS]);
  assert.equal(model.diagrams.find((diagram) => diagram.kind === 'dependency').available, true);
  const missing = model.diagrams.filter((diagram) => !diagram.available);
  assert.equal(missing.length, DIAGRAM_KINDS.length - 1);
  for (const diagram of missing) {
    assert.equal(diagram.missing, true);
    assert.match(diagram.missingText, /缺/u);
    assert.match(diagram.missingText, new RegExp(diagram.label, 'u'));
  }
  // 缺图不多不少，正好等于快照的 missingDiagrams。
  assert.deepEqual(missing.map((diagram) => diagram.kind).sort(), [...content.assets.missingDiagrams].sort());

  const html = renderReportHtml(model);
  for (const diagram of missing) {
    assert.match(html, new RegExp(`data-diagram="${diagram.kind}" data-available="false"`, 'u'));
    assert.ok(html.includes(diagram.missingText), diagram.missingText);
  }
  // 有图的那类给的是快照里的引用（标题 / 摘要 / 基于提交），不是现画。
  assert.match(html, /data-diagram="dependency" data-available="true"/u);
  assert.ok(html.includes('三个模块互相依赖'));
  assert.ok(html.includes('abc1234'));

  // 没有画像：一句话现状写「缺」，不静默留白。
  const noProfile = reportModelOf(contentOf({ profile: null, diagrams: [] }), { version: 1 });
  assert.equal(noProfile.profile.available, false);
  assert.match(noProfile.oneLiner, /缺/u);
});

test('快照 JSON 原样写出：字节等于库里存的那份文本，哈希等于发布记录', () => {
  const root = tempRoot();
  const dbFile = path.join(root, 'owner.sqlite');
  const store = new ProjectSnapshotStore(dbFile);
  try {
    store.saveDraft({
      projectId: PROJECT.id,
      content: contentOf({ lessons: [lesson({ id: 'l1' })] })
    });
    const published = store.publish({ projectId: PROJECT.id, now: '2026-11-24T01:00:00.000Z' });
    const raw = store.getVersionRaw(PROJECT.id, published.version);
    assert.equal(typeof raw.contentText, 'string');

    const result = writeExport({
      root: path.join(root, 'exports'),
      projectId: PROJECT.id,
      version: raw.version,
      contentText: raw.contentText,
      contentHash: raw.contentHash,
      publishedAt: raw.publishedAt,
      note: raw.note
    });
    const bytes = fs.readFileSync(result.snapshotPath);
    // 原样字节：不做 JSON.parse → stringify 的往返，也不补尾换行。
    assert.equal(bytes.toString('utf8'), raw.contentText);
    assert.equal(bytes.toString('utf8'), JSON.stringify(store.getVersion(PROJECT.id, raw.version).content));
    assert.equal(sha256(bytes), raw.contentHash);
    assert.equal(result.snapshotHash, raw.contentHash);
    // 人读物与机器可读物都存在，且同一份快照渲染。
    assert.equal(fs.existsSync(result.reportPath), true);
    assert.equal(result.reportHash, sha256(fs.readFileSync(result.reportPath)));
  } finally {
    store.close();
    cleanup(root);
  }
});

test('重复导出幂等：snapshot.json 与人读物逐字节相同，第二次不重写文件', () => {
  const root = tempRoot();
  try {
    const content = contentOf({
      lessons: [lesson({ id: 'l1' }), lesson({ id: 'l2', status: 'inferred' })],
      knowledge: [unit({ id: 'k1' })]
    });
    const contentText = JSON.stringify(content);
    const options = {
      root: path.join(root, 'exports'),
      projectId: PROJECT.id,
      version: 1,
      contentText,
      contentHash: sha256(contentText),
      publishedAt: '2026-11-24T01:00:00.000Z',
      note: '给同事看这一版'
    };
    const first = writeExport(options);
    const firstSnapshot = fs.readFileSync(first.snapshotPath);
    const firstReport = fs.readFileSync(first.reportPath);
    const firstStat = fs.statSync(first.reportPath).mtimeMs;

    const second = writeExport(options);
    assert.deepEqual([...fs.readFileSync(second.snapshotPath)].length, firstSnapshot.length);
    assert.equal(sha256(fs.readFileSync(second.snapshotPath)), sha256(firstSnapshot));
    assert.equal(sha256(fs.readFileSync(second.reportPath)), sha256(firstReport));
    assert.equal(second.snapshotHash, first.snapshotHash);
    assert.equal(second.reportHash, first.reportHash);
    // 内容一致时不重写：时间戳不动，重复导出只是读一遍比对。
    assert.equal(fs.statSync(second.reportPath).mtimeMs, firstStat);
    assert.deepEqual(second.changed, []);
    assert.deepEqual(first.changed, [SNAPSHOT_FILE, REPORT_FILE]);
  } finally {
    cleanup(root);
  }
});

test('哈希不符的快照字节拒绝导出：不把被改过的内容当成那一版', () => {
  const root = tempRoot();
  try {
    const contentText = JSON.stringify(contentOf({ lessons: [lesson({ id: 'l1' })] }));
    const tampered = contentText.replace('现象 l1', '改过的结论');
    assert.throws(() => writeExport({
      root: path.join(root, 'exports'),
      projectId: PROJECT.id,
      version: 1,
      contentText: tampered,
      contentHash: sha256(contentText),
      publishedAt: '2026-11-24T01:00:00.000Z'
    }), (error) => error instanceof ExportError && error.code === 'export_hash_mismatch');
    // 失败不留半份文件。
    assert.equal(fs.existsSync(path.join(root, 'exports', PROJECT.id, 'v1')), false);
  } finally {
    cleanup(root);
  }
});

test('人读物含版本号、发布时间、两节清单与证据引用', () => {
  const content = contentOf({
    lessons: [lesson({ id: 'l-ok', title: '重试循环少跑一次' })],
    knowledge: [unit({ id: 'k-watch', title: '抖动的阈值还没定', status: 'unverified' })]
  });
  const html = renderReportHtml(reportModelOf(content, {
    version: 4,
    publishedAt: '2026-11-24T09:30:00.000Z',
    contentHash: 'b'.repeat(64),
    note: '这一版加了重试经验'
  }));
  assert.match(html, /^<!doctype html>/u);
  assert.ok(html.includes('演示项目'));
  assert.ok(html.includes('v4'));
  assert.ok(html.includes('2026-11-24T09:30:00.000Z'));
  assert.ok(html.includes('重试循环少跑一次'));
  assert.ok(html.includes('抖动的阈值还没定'));
  assert.match(html, /data-section="verified"/u);
  assert.match(html, /data-section="observing"/u);
  assert.match(html, /data-section="evidence"/u);
  assert.ok(html.includes('sandbox:l-ok'));
  assert.ok(html.includes('evidence:k-watch'));
  assert.ok(html.includes('这一版加了重试经验'));
  assert.ok(html.includes('一个用于演示项目库的零依赖项目'));
  assert.equal((html.match(/data-count="experiences"/gu) ?? []).length, 1);
  // 不含「当前时间」：同一份快照渲染两次完全相同。
  assert.equal(renderReportHtml(reportModelOf(content, { version: 4, publishedAt: '2026-11-24T09:30:00.000Z' })),
    renderReportHtml(reportModelOf(content, { version: 4, publishedAt: '2026-11-24T09:30:00.000Z' })));
});

test('人读物转义：条目里的 HTML 不会被当成标签执行', () => {
  const content = contentOf({
    lessons: [lesson({ id: 'l1', title: '<img src=x onerror=alert(1)>' })],
    knowledge: [unit({ id: 'k1', title: 'a & b < c' })]
  });
  const html = renderReportHtml(reportModelOf(content, { version: 1 }));
  assert.equal(html.includes('<img src=x onerror=alert(1)>'), false);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('a &amp; b &lt; c'));
});
