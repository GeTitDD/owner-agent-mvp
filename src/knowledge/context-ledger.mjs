// 会话上下文台账：把“这次用了哪些知识、哪个修订、编译哈希”持久化，
// 便于新会话恢复、审计与漂移检测。只读记录，不改动编译结果。
import { randomUUID } from 'node:crypto';
import { canonical, sha256 } from '../utils.mjs';
import { deviceId } from './sources.mjs';

const workspaceRef = /^workspace:([^:]+):r(\d+)$/u;

export function refsFromPlan(plan) {
  return (plan?.knowledgeRefs ?? []).map((key) => {
    const match = workspaceRef.exec(key);
    return match ? { key, knowledgeId: match[1], revision: Number(match[2]) } : null;
  }).filter(Boolean);
}

export class KnowledgeContextLedger {
  constructor({ personalStore, clock = () => new Date().toISOString(), device = null } = {}) {
    if (!personalStore?.db) throw new Error('personalStore with an open database is required');
    this.store = personalStore;
    this.db = personalStore.db;
    this.clock = clock;
    this.device = device ?? deviceId();
  }

  /** 记录一次编译结果；同一 compilationHash + session 幂等。 */
  record({ projectId, sessionId = '', task, plan }) {
    if (!projectId) throw new Error('projectId is required');
    if (!plan) throw new Error('Compilation plan is required');
    const compilationHash = plan.compilationHash ?? plan.snapshotId ?? '';
    if (!compilationHash) throw new Error('Plan has no compilation hash');
    const snapshotId = `ctx_${sha256(canonical({ projectId, sessionId, compilationHash })).slice(0, 24)}`;
    const existing = this.get(snapshotId);
    if (existing) return { snapshot: existing, created: false };
    const refs = refsFromPlan(plan).map((ref) => {
      const revisionRow = this.db.prepare('SELECT payload,payload_hash FROM personal_revisions WHERE unit_id=? AND revision=?')
        .get(ref.knowledgeId, ref.revision);
      let verificationStatus = 'missing';
      if (revisionRow) {
        try { verificationStatus = JSON.parse(revisionRow.payload).verificationStatus ?? 'unknown'; }
        catch { verificationStatus = 'unknown'; }
      }
      return {
        key: ref.key,
        knowledgeId: ref.knowledgeId,
        revision: ref.revision,
        payloadHash: revisionRow?.payload_hash ?? '',
        verificationStatus
      };
    });
    const stamp = this.clock();
    const payload = {
      contract: 'knowledge-context/v1',
      snapshotId,
      projectId,
      sessionId,
      task: String(task ?? '').slice(0, 2000),
      compilationHash,
      refs,
      device: this.device,
      createdAt: stamp
    };
    const body = canonical(payload);
    this.db.prepare(`INSERT INTO knowledge_context_snapshots
      (snapshot_id,project_id,session_id,compilation_hash,task,created_at,payload,payload_hash)
      VALUES(?,?,?,?,?,?,?,?)`).run(
      snapshotId, projectId, sessionId, compilationHash, payload.task, stamp, body, sha256(body)
    );
    return { snapshot: this.get(snapshotId), created: true };
  }

  get(snapshotId) {
    const row = this.db.prepare('SELECT * FROM knowledge_context_snapshots WHERE snapshot_id=?').get(snapshotId);
    return row ? { ...JSON.parse(row.payload), payloadHash: row.payload_hash } : null;
  }

  latest({ projectId, sessionId = '' } = {}) {
    const row = sessionId
      ? this.db.prepare(`SELECT snapshot_id FROM knowledge_context_snapshots
          WHERE project_id=? AND session_id=? ORDER BY created_at DESC LIMIT 1`).get(projectId, sessionId)
      : this.db.prepare(`SELECT snapshot_id FROM knowledge_context_snapshots
          WHERE project_id=? ORDER BY created_at DESC LIMIT 1`).get(projectId);
    return row ? this.get(row.snapshot_id) : null;
  }

  /**
   * 恢复上下文：返回当时的选择与当前漂移。
   * drift: same | revision-changed | verification-changed | missing
   */
  restore(snapshotId) {
    const snapshot = this.get(snapshotId);
    if (!snapshot) return null;
    const refs = snapshot.refs.map((ref) => {
      const unit = this.store.get(ref.knowledgeId);
      if (!unit) return { ...ref, drift: 'missing', currentRevision: null };
      if (unit.revision !== ref.revision) {
        return { ...ref, drift: 'revision-changed', currentRevision: unit.revision };
      }
      if (unit.verificationStatus !== ref.verificationStatus) {
        return { ...ref, drift: 'verification-changed', currentRevision: unit.revision, currentVerification: unit.verificationStatus };
      }
      return { ...ref, drift: 'same', currentRevision: unit.revision };
    });
    return {
      snapshot,
      refs,
      drifted: refs.filter((ref) => ref.drift !== 'same').length,
      usable: refs.filter((ref) => ref.drift !== 'missing')
    };
  }
}
