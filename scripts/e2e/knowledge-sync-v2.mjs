// 双设备离线同步验收：R1 采纳 → R2/R3 分叉 → 冲突保留 → R4 收敛。
//
// 使用两个独立 SQLite 数据库模拟两台机器；不复制运行中的数据库文件。
// 输出：EVIDENCE_DIR/knowledge-sync-v2.json（默认临时目录）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersonalKnowledgeStore } from '../../src/personal-store.mjs';
import { KnowledgeProvenance } from '../../src/knowledge/provenance.mjs';
import { KnowledgeContextLedger } from '../../src/knowledge/context-ledger.mjs';
import { exportBundle, importBundle } from '../../src/knowledge/sync.mjs';
import { revisionIdFor } from '../../src/knowledge/sources.mjs';
import { canonical, sha256 } from '../../src/utils.mjs';

const failures = [];
const checks = [];
const check = (name, condition, detail = '') => {
  const ok = Boolean(condition);
  checks.push({ name, ok, detail });
  if (!ok) failures.push(name);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-sync-v2-'));
const dbA = path.join(root, 'device-a.sqlite');
const dbB = path.join(root, 'device-b.sqlite');
const evidenceDir = process.env.EVIDENCE_DIR || root;
fs.mkdirSync(evidenceDir, { recursive: true });

const makeUnit = (store) => store.create({
  title: 'Retry bound', content: 'loop with i < attempts', kind: 'claim',
  layer: 'project', scope: 'project', projectId: 'demo',
  domains: ['software-engineering'], tags: ['retry'],
  evidenceRefs: ['legacy:run-a'], verificationStatus: 'unverified'
});

const A = new PersonalKnowledgeStore(dbA);
const B = new PersonalKnowledgeStore(dbB);
const provA = new KnowledgeProvenance({ personalStore: A, device: 'dev-a' });
const provB = new KnowledgeProvenance({ personalStore: B, device: 'dev-b' });

try {
  const unit = makeUnit(A);
  const observed = provA.observeSource({
    sourceType: 'file', namespace: 'local-file', objectId: 'docs/retry.md',
    sourceVersion: 'v1', locator: 'docs/retry.md', contentHash: 'abc123',
    availability: 'available', observedAt: new Date().toISOString(), projectId: 'demo'
  }, { observedBy: 'agent', captureRunId: 'run-1' });
  provA.linkRevision({ unitId: unit.id, revision: 1, observationId: observed.observation.observationId });
  provA.adopt({ unitId: unit.id, revision: 1 });
  const r1 = provA.listRevisions({ unitId: unit.id })[0];
  const ledger = new KnowledgeContextLedger({ personalStore: A, device: 'dev-a' });
  const snapshot = ledger.record({
    projectId: 'demo', sessionId: 'session-1', task: 'first run',
    plan: { compilationHash: 'compile-1', knowledgeRefs: [`workspace:${unit.id}:r1`] }
  });
  check('设备 A 建立 R1、来源与采纳', Boolean(r1?.revisionId) && provA.adoption(unit.id)?.revision === 1);

  const first = exportBundle({ personalStore: A, provenance: provA, all: true, device: 'dev-a' });
  check('导出 v2 Bundle 含修订与事件', first.contract === 'knowledge-sync/v2' && first.events.length >= 2);
  const imported = importBundle({ personalStore: B, provenance: provB, bundle: first, device: 'dev-b' });
  check('设备 B 导入 R1、来源与采纳', imported.imported === 1
    && B.get(unit.id)?.content === 'loop with i < attempts'
    && provB.adoption(unit.id)?.revision === 1
    && provB.linksFor({ unitId: unit.id, revision: 1 }).length === 1);

  B.update(unit.id, { ...B.get(unit.id), content: 'experiment result', tags: ['retry', 'exp'] },
    { expectedRevision: 1, actor: 'agent', note: 'experiment R2' });
  const r2 = provB.listRevisions({ unitId: unit.id })[1];
  check('设备 B 形成 R2 候选但不替代采纳 R1', provB.adoption(unit.id)?.revision === 1);

  A.update(unit.id, { ...A.get(unit.id), content: 'offline edit', tags: ['retry', 'offline'] },
    { expectedRevision: 1, actor: 'owner', note: 'offline R3' });
  const r3 = provA.listRevisions({ unitId: unit.id })[1];
  check('设备 A 离线形成 R3', Boolean(r3?.revisionId));

  const second = exportBundle({ personalStore: A, provenance: provA, all: true, device: 'dev-a' });
  const conflicted = importBundle({ personalStore: B, provenance: provB, bundle: second, device: 'dev-b' });
  check('B 识别共同祖先并保留冲突', conflicted.conflicts.length >= 1 && B.get(unit.id).revision === 2);
  const candidate = provB.listCandidates({ unitId: unit.id })[0];
  const branchIds = new Set(provB.listRevisions({ unitId: unit.id }).map((row) => row.revisionId));
  check('两条分支与来源都被保留', candidate?.revisionId === r3.revisionId
    && branchIds.has(r2.revisionId) && branchIds.has(r3.revisionId));
  check('B 的已采纳版本仍是 R1', provB.adoption(unit.id)?.revision === 1);

  const conflict = provB.listConflicts({ unitId: unit.id })[0];
  const resolved = provB.resolveConflict({ id: conflict.id, decision: 'accept-incoming', actor: 'owner' });
  const r4 = provB.getRevision(resolved.revisionId);
  check('审核后产生双亲 R4', Boolean(r4)
    && r4.parentRevisionIds.includes(r2.revisionId)
    && r4.parentRevisionIds.includes(r3.revisionId));
  check('R4 保留远端来源链接', provB.linksFor({ unitId: unit.id, revision: B.get(unit.id).revision }).length >= 1);
  provB.adopt({ unitId: unit.id, revision: B.get(unit.id).revision });

  const third = exportBundle({ personalStore: B, provenance: provB, all: true, device: 'dev-b' });
  const converged = importBundle({ personalStore: A, provenance: provA, bundle: third, device: 'dev-a' });
  check('R4 同步后 A 收敛且无新冲突', converged.conflicts.length === 0
    && A.get(unit.id).content === 'offline edit');
  const aIds = new Set(provA.listRevisions({ unitId: unit.id }).map((row) => row.revisionId));
  check('A 同时保留 R2/R3/R4', aIds.has(r2.revisionId) && aIds.has(r3.revisionId) && aIds.has(resolved.revisionId));

  const restored = ledger.restore(snapshot.snapshot.snapshotId);
  check('旧 Session 仍引用 R1 并报告漂移', restored.refs[0].revision === 1
    && restored.refs[0].drift === 'revision-changed'
    && restored.refs[0].payloadHash === provA.getRevision(r1.revisionId).payloadHash);

  const before = A.revisions(unit.id).length;
  const again = importBundle({ personalStore: A, provenance: provA, bundle: third, device: 'dev-a' });
  check('重复导入不产生新修订', again.unchanged === 1 && A.revisions(unit.id).length === before
    && again.events.applied === 0);

  const tampered = JSON.parse(JSON.stringify(first));
  tampered.units[0].revisions[0].payload.content = 'tampered';
  const C = new PersonalKnowledgeStore(':memory:');
  const provC = new KnowledgeProvenance({ personalStore: C, device: 'dev-c' });
  const tamperReport = importBundle({ personalStore: C, provenance: provC, bundle: tampered, device: 'dev-c' });
  check('篡改 Bundle 被拒绝', tamperReport.imported === 0 && tamperReport.errors.length >= 1);
  C.close();

  const scoped = JSON.parse(JSON.stringify(first));
  scoped.units[0].revisions = scoped.units[0].revisions.map((row) => {
    const payload = { ...row.payload, projectId: 'secret' };
    const payloadHash = sha256(canonical(payload));
    return {
      ...row,
      payload,
      payloadHash,
      revisionId: revisionIdFor({
        knowledgeId: scoped.units[0].knowledgeId,
        contentHash: payloadHash,
        parentRevisionIds: row.parentRevisionIds ?? [],
        reason: row.note ?? '',
        actorId: row.actor ?? ''
      })
    };
  });
  const D = new PersonalKnowledgeStore(':memory:');
  const provD = new KnowledgeProvenance({ personalStore: D, device: 'dev-d' });
  const scopedReport = importBundle({
    personalStore: D, provenance: provD, bundle: scoped,
    device: 'dev-d', allowedProjectIds: ['demo']
  });
  check('未授权项目数据被同步拒绝', scopedReport.imported === 0 && scopedReport.skippedScope === 1);
  D.close();

  const evidence = {
    at: new Date().toISOString(),
    ok: failures.length === 0,
    checks,
    revisionIds: { r1: r1.revisionId, r2: r2.revisionId, r3: r3.revisionId, r4: resolved.revisionId },
    units: { a: A.get(unit.id).revision, b: B.get(unit.id).revision },
    cursor: third.cursor,
    conflicts: conflicted.conflicts.length,
    events: { exported: first.events.length, duplicatesOnRepeat: again.events.duplicates }
  };
  fs.writeFileSync(path.join(evidenceDir, 'knowledge-sync-v2.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: evidence.ok, evidence: path.join(evidenceDir, 'knowledge-sync-v2.json') }));
  if (failures.length) process.exitCode = 1;
} finally {
  A.close();
  B.close();
  fs.rmSync(root, { recursive: true, force: true });
}
