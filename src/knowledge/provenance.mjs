// Knowledge Provenance 服务：来源登记、观察、修订绑定、Owner 采纳与重验证队列。
//
// 直接复用 PersonalKnowledgeStore 的同一个 SQLite 连接（store.db），
// 事务与个人知识修订保持一致；不引入第二套存储或分布式依赖。
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { canonical, sha256 } from '../utils.mjs';
import {
  normalizeObservation, normalizeRelation, normalizeSourceDescriptor,
  computeProjectIdentity, deviceId
} from './sources.mjs';

const nowIso = () => new Date().toISOString();
const json = (value) => JSON.stringify(value);

export class KnowledgeProvenance {
  constructor({ personalStore, clock = nowIso, device = null } = {}) {
    if (!personalStore?.db) throw new Error('personalStore with an open database is required');
    this.store = personalStore;
    this.db = personalStore.db;
    this.clock = clock;
    this.device = device ?? deviceId();
  }

  // ---- 项目身份 ----

  /** 登记项目身份（幂等）；同一 identity 只能对应一个 projectId。 */
  ensureProject({ projectId, identity, identityKind, aliases = [] }) {
    if (!projectId) throw new Error('projectId is required');
    if (!identity) throw new Error('project identity is required');
    const existing = this.getProject(projectId);
    if (existing) {
      if (existing.projectIdentity !== identity) {
        throw new Error(`Project ${projectId} already bound to a different identity`);
      }
      return existing;
    }
    const byIdentity = this.getProjectByIdentity(identity);
    if (byIdentity && byIdentity.projectId !== projectId) {
      // 同一仓库在不同机器上注册了不同 projectId：记录别名，不合并数据。
      const merged = [...new Set([...(byIdentity.aliases ?? []), projectId])];
      this.updateAliases(byIdentity.projectId, merged);
      return { ...byIdentity, aliases: merged, aliasOf: byIdentity.projectId };
    }
    const stamp = this.clock();
    const payload = {
      contract: 'project-identity/v1',
      projectId, projectIdentity: identity, identityKind,
      aliases: [...new Set([projectId, ...aliases])], createdAt: stamp
    };
    const body = canonical(payload);
    this.db.prepare(`INSERT INTO knowledge_projects
      (project_id,project_identity,identity_kind,aliases,created_at,payload,payload_hash)
      VALUES(?,?,?,?,?,?,?)`).run(
      projectId, identity, identityKind, json(payload.aliases), stamp, body, sha256(body)
    );
    return this.getProject(projectId);
  }

  /** 从本地仓库推导并登记项目身份；有 git remote 时优先使用。 */
  ensureProjectFromRoot({ projectId, root, identity, identityKind, aliases = [] }) {
    let resolved = { projectIdentity: identity, identityKind };
    if (!identity) {
      const git = this.gitIdentity(root);
      if (git.remoteUrl || git.firstCommit) {
        resolved = computeProjectIdentity({
          root, remoteUrl: git.remoteUrl, firstCommit: git.firstCommit, rootIdentity: git.rootIdentity
        });
      } else {
        // 非 git 目录：只能退到本地根身份，并明确标记为仅本机可识别。
        resolved = computeProjectIdentity({ root, rootIdentity: sha256(String(path.resolve(root))) });
      }
    }
    return this.ensureProject({ projectId, identity: resolved.projectIdentity, identityKind: resolved.identityKind, aliases });
  }

  getProject(projectId) {
    const row = this.db.prepare('SELECT * FROM knowledge_projects WHERE project_id=?').get(projectId);
    return row ? { ...JSON.parse(row.payload), payloadHash: row.payload_hash } : null;
  }

  getProjectByIdentity(identity) {
    const row = this.db.prepare('SELECT * FROM knowledge_projects WHERE project_identity=?').get(identity);
    return row ? { ...JSON.parse(row.payload), payloadHash: row.payload_hash } : null;
  }

  updateAliases(projectId, aliases) {
    const current = this.getProject(projectId);
    if (!current) throw new Error('Project identity not found');
    const payload = { ...current, aliases: [...new Set(aliases)] };
    delete payload.payloadHash;
    const body = canonical(payload);
    this.db.prepare('UPDATE knowledge_projects SET aliases=?,payload=?,payload_hash=? WHERE project_id=?')
      .run(json(payload.aliases), body, sha256(body), projectId);
    return this.getProject(projectId);
  }

  /** 本地 git 元数据；不是 git 仓库时返回空值，由调用方回退。 */
  gitIdentity(root) {
    try {
      const run = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const remoteUrl = (() => { try { return run(['remote', 'get-url', 'origin']); } catch { return ''; } })();
      const firstCommit = (() => {
        try {
          const list = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
          return list.split(/\r?\n/u).filter(Boolean).sort()[0] ?? '';
        } catch { return ''; }
      })();
      return { remoteUrl, firstCommit, rootIdentity: '' };
    } catch {
      return { remoteUrl: '', firstCommit: '', rootIdentity: '' };
    }
  }

  // ---- 来源与观察 ----

  /** 登记来源身份（幂等）；返回当前来源记录。 */
  registerSource(input) {
    const descriptor = normalizeSourceDescriptor(input);
    const stamp = this.clock();
    const existing = this.getSource(descriptor.sourceId);
    if (existing) {
      const payload = {
        ...existing, locator: descriptor.locator, availability: descriptor.availability,
        lastSeenAt: stamp, projectId: existing.projectId ?? null
      };
      delete payload.payloadHash;
      const body = canonical(payload);
      this.db.prepare(`UPDATE knowledge_sources SET locator=?,availability=?,last_seen_at=?,payload=?,payload_hash=?
        WHERE source_id=?`).run(descriptor.locator, descriptor.availability, stamp, body, sha256(body), descriptor.sourceId);
      return this.getSource(descriptor.sourceId);
    }
    const payload = {
      contract: descriptor.contract,
      sourceId: descriptor.sourceId,
      sourceType: descriptor.sourceType,
      namespace: descriptor.namespace,
      objectId: descriptor.objectId,
      projectId: input.projectId ?? null,
      locator: descriptor.locator,
      availability: descriptor.availability,
      firstSeenAt: stamp,
      lastSeenAt: stamp
    };
    const body = canonical(payload);
    this.db.prepare(`INSERT INTO knowledge_sources
      (source_id,source_type,namespace,object_id,project_id,locator,availability,first_seen_at,last_seen_at,payload,payload_hash)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      descriptor.sourceId, descriptor.sourceType, descriptor.namespace, descriptor.objectId,
      input.projectId ?? null, descriptor.locator, descriptor.availability, stamp, stamp, body, sha256(body)
    );
    return this.getSource(descriptor.sourceId);
  }

  getSource(sourceId) {
    const row = this.db.prepare('SELECT * FROM knowledge_sources WHERE source_id=?').get(sourceId);
    return row ? { ...JSON.parse(row.payload), availability: row.availability, lastSeenAt: row.last_seen_at, payloadHash: row.payload_hash } : null;
  }

  listSources({ projectId = '', limit = 100 } = {}) {
    const rows = projectId
      ? this.db.prepare('SELECT source_id FROM knowledge_sources WHERE project_id=? ORDER BY last_seen_at DESC LIMIT ?').all(projectId, limit)
      : this.db.prepare('SELECT source_id FROM knowledge_sources ORDER BY last_seen_at DESC LIMIT ?').all(limit);
    return rows.map(({ source_id }) => this.getSource(source_id));
  }

  /**
   * 记录一次来源观察；同一 (source, version, hash, captureRun) 幂等。
   * 若该来源此前被知识修订引用且版本变化，则生成 pending 重验证项——
   * 只提示，不修改 Owner 已采纳的知识。
   */
  observeSource(input, { observedBy = 'agent', captureRunId = '' } = {}) {
    const { descriptor, observation } = normalizeObservation({ ...input, observedBy, captureRunId });
    this.registerSource({ ...descriptor, projectId: input.projectId ?? null });
    const stamp = this.clock();
    const existing = this.getObservation(observation.observationId);
    if (existing) return { observation: existing, created: false, revalidations: [] };

    const payload = { contract: observation.contract, ...observation, device: this.device };
    const body = canonical(payload);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO knowledge_source_observations
        (observation_id,source_id,source_version,content_hash,locator,observed_at,capture_run_id,observed_by,availability,payload,payload_hash)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        observation.observationId, observation.sourceId, observation.sourceVersion,
        observation.contentHash, observation.locator, observation.observedAt,
        observation.captureRunId, observation.observedBy, observation.availability, body, sha256(body)
      );
      const revalidations = this.detectStaleLinks(observation);
      this.db.exec('COMMIT');
      return { observation: this.getObservation(observation.observationId), created: true, revalidations };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getObservation(observationId) {
    const row = this.db.prepare('SELECT * FROM knowledge_source_observations WHERE observation_id=?').get(observationId);
    return row ? { ...JSON.parse(row.payload), payloadHash: row.payload_hash } : null;
  }

  listObservations({ sourceId = '', limit = 100 } = {}) {
    const rows = sourceId
      ? this.db.prepare('SELECT observation_id FROM knowledge_source_observations WHERE source_id=? ORDER BY observed_at DESC LIMIT ?').all(sourceId, limit)
      : this.db.prepare('SELECT observation_id FROM knowledge_source_observations ORDER BY observed_at DESC LIMIT ?').all(limit);
    return rows.map(({ observation_id }) => this.getObservation(observation_id));
  }

  /** 新版本出现后，给所有引用旧版本的修订建 pending 重验证项。 */
  detectStaleLinks(observation) {
    const rows = this.db.prepare(`SELECT l.unit_id, l.revision, o.observation_id, o.source_version
      FROM knowledge_source_links l
      JOIN knowledge_source_observations o ON o.observation_id = l.observation_id
      WHERE o.source_id = ?`).all(observation.sourceId);
    const created = [];
    const seen = new Set();
    for (const row of rows) {
      if (row.source_version === observation.sourceVersion) continue;
      const key = `${row.unit_id}:${row.revision}:${row.observation_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const item = this.createRevalidation({
        unitId: row.unit_id, revision: row.revision, sourceId: observation.sourceId,
        fromObservationId: row.observation_id, toObservationId: observation.observationId,
        reason: 'source_changed'
      });
      if (item) created.push(item);
    }
    return created;
  }

  // ---- 修订 ↔ 来源绑定 ----

  linkRevision({ unitId, revision, observationId, relation = 'supports', by = 'user' }) {
    const unit = this.store.get(unitId);
    if (!unit) throw new Error('Knowledge unit not found');
    if (unit.revision !== revision) throw new Error(`Revision mismatch: head is ${unit.revision}`);
    const revisionRow = this.db.prepare('SELECT payload_hash FROM personal_revisions WHERE unit_id=? AND revision=?').get(unitId, revision);
    if (!revisionRow) throw new Error('Knowledge revision not found');
    const observation = this.getObservation(observationId);
    if (!observation) throw new Error('Source observation not found');
    const normalizedRelation = normalizeRelation(relation);
    const stamp = this.clock();
    const payload = { contract: 'knowledge-source-link/v1', unitId, revision, observationId, relation: normalizedRelation, createdAt: stamp, createdBy: by };
    const body = canonical(payload);
    this.db.prepare(`INSERT OR IGNORE INTO knowledge_source_links
      (unit_id,revision,observation_id,relation,created_at,created_by,payload,payload_hash)
      VALUES(?,?,?,?,?,?,?,?)`).run(unitId, revision, observationId, normalizedRelation, stamp, by, body, sha256(body));
    return this.linksFor({ unitId, revision })
      .find((item) => item.observationId === observationId && item.relation === normalizedRelation) ?? null;
  }

  linksFor({ unitId, revision }) {
    const rows = this.db.prepare(`SELECT l.*, o.source_id, o.source_version, o.content_hash, o.availability, o.observed_at,
        s.source_type, s.namespace, s.object_id, s.locator
      FROM knowledge_source_links l
      JOIN knowledge_source_observations o ON o.observation_id = l.observation_id
      JOIN knowledge_sources s ON s.source_id = o.source_id
      WHERE l.unit_id=? AND l.revision=?
      ORDER BY l.created_at DESC`).all(unitId, revision);
    return rows.map((row) => ({
      unitId: row.unit_id, revision: row.revision, observationId: row.observation_id,
      relation: row.relation, createdAt: row.created_at, createdBy: row.created_by,
      sourceId: row.source_id, sourceType: row.source_type, namespace: row.namespace,
      objectId: row.object_id, locator: row.locator, sourceVersion: row.source_version,
      contentHash: row.content_hash, availability: row.availability, observedAt: row.observed_at
    }));
  }

  /** 全部来源证据；旧字符串 evidenceRefs 以 legacy 形式附在末尾，不伪造版本。 */
  evidenceFor({ unitId, revision }) {
    const unit = this.store.get(unitId);
    if (!unit) throw new Error('Knowledge unit not found');
    const targetRevision = revision ?? unit.revision;
    return {
      unitId, revision: targetRevision,
      links: this.linksFor({ unitId, revision: targetRevision }),
      legacyRefs: (unit.evidenceRefs ?? []).map((ref) => ({ kind: 'legacy', value: ref }))
    };
  }

  // ---- Owner 采纳 ----

  /** 记录 Owner 当前采纳的修订；不改变内容，也不自动验证。 */
  adopt({ unitId, revision, actor = 'owner', note = '' }) {
    const unit = this.store.get(unitId);
    if (!unit) throw new Error('Knowledge unit not found');
    const target = revision ?? unit.revision;
    const row = this.db.prepare('SELECT payload_hash FROM personal_revisions WHERE unit_id=? AND revision=?').get(unitId, target);
    if (!row) throw new Error('Knowledge revision not found');
    const stamp = this.clock();
    this.db.prepare(`INSERT INTO knowledge_adoptions(unit_id,adopted_revision,adopted_at,actor,note,payload_hash)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(unit_id) DO UPDATE SET adopted_revision=excluded.adopted_revision,
        adopted_at=excluded.adopted_at, actor=excluded.actor, note=excluded.note, payload_hash=excluded.payload_hash`)
      .run(unitId, target, stamp, actor, note.slice(0, 500), row.payload_hash);
    return this.adoption(unitId);
  }

  adoption(unitId) {
    const row = this.db.prepare('SELECT * FROM knowledge_adoptions WHERE unit_id=?').get(unitId);
    if (!row) return null;
    const unit = this.store.get(unitId);
    return {
      unitId, revision: row.adopted_revision, adoptedAt: row.adopted_at,
      actor: row.actor, note: row.note, payloadHash: row.payload_hash,
      drift: unit ? unit.revision !== row.adopted_revision : true
    };
  }

  // ---- 重验证队列 ----

  createRevalidation({ unitId, revision, sourceId, fromObservationId = '', toObservationId, reason, status = 'pending' }) {
    const id = `reval_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const stamp = this.clock();
    const payload = {
      contract: 'knowledge-revalidation/v1', id, unitId, revision, sourceId,
      fromObservationId, toObservationId, reason, status, createdAt: stamp
    };
    const body = canonical(payload);
    try {
      this.db.prepare(`INSERT INTO knowledge_revalidations
        (id,unit_id,revision,source_id,from_observation_id,to_observation_id,reason,status,created_at,payload,payload_hash)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, unitId, revision, sourceId, fromObservationId, toObservationId, reason, status, stamp, body, sha256(body)
      );
    } catch (error) {
      if (/UNIQUE constraint/u.test(error.message)) return null;
      throw error;
    }
    return this.getRevalidation(id);
  }

  getRevalidation(id) {
    const row = this.db.prepare('SELECT * FROM knowledge_revalidations WHERE id=?').get(id);
    return row ? { ...JSON.parse(row.payload), status: row.status, resolvedAt: row.resolved_at, resolvedBy: row.resolved_by, resolutionNote: row.resolution_note } : null;
  }

  listRevalidations({ status = 'pending', unitId = '', limit = 100 } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push('status=?'); params.push(status); }
    if (unitId) { where.push('unit_id=?'); params.push(unitId); }
    const rows = this.db.prepare(`SELECT id FROM knowledge_revalidations ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC LIMIT ?`).all(...params, limit);
    return rows.map(({ id }) => this.getRevalidation(id));
  }

  /**
   * Owner 处理重验证项。
   * accepted：把当前 Head 的 verificationStatus 改为 needs_reverification（新增修订，不静默改）。
   * dismissed：保留原知识，仅关闭提示。
   */
  resolveRevalidation({ id, decision, actor = 'owner', note = '' }) {
    if (!['accepted', 'dismissed'].includes(decision)) throw new Error('Invalid revalidation decision');
    const item = this.getRevalidation(id);
    if (!item) throw new Error('Revalidation not found');
    if (item.status !== 'pending') throw new Error('Revalidation already resolved');
    // update() 自带事务；这里不能再包一层 BEGIN。
    if (decision === 'accepted') {
      const unit = this.store.get(item.unitId);
      if (unit) {
        this.store.update(item.unitId, { ...unit, verificationStatus: 'needs_reverification' }, {
          expectedRevision: unit.revision,
          actor,
          note: `Revalidation ${id}: ${note || 'source changed'}`
        });
      }
    }
    const stamp = this.clock();
    this.db.prepare('UPDATE knowledge_revalidations SET status=?,resolved_at=?,resolved_by=?,resolution_note=? WHERE id=?')
      .run(decision, stamp, actor, note.slice(0, 500), id);
    const payload = { ...item, status: decision, resolvedAt: stamp, resolvedBy: actor, resolutionNote: note };
    const body = canonical(payload);
    this.db.prepare('UPDATE knowledge_revalidations SET payload=?,payload_hash=? WHERE id=?').run(body, sha256(body), id);
    return this.getRevalidation(id);
  }

  // ---- 解释 ----

  /** 回答“这条知识来自哪里、采纳了哪个修订、证据对应哪个来源版本”。 */
  explain(unitId) {
    const unit = this.store.get(unitId);
    if (!unit) return null;
    const revisionHashes = this.store.revisions(unitId).map((row) => ({
      revision: row.revision, payloadHash: row.payload_hash, actor: row.actor, note: row.note, timestamp: row.timestamp
    }));
    const adopted = this.adoption(unitId);
    const revisions = revisionHashes.map((item) => ({
      ...item,
      links: this.linksFor({ unitId, revision: item.revision })
    }));
    return {
      unitId,
      headRevision: unit.revision,
      adoptedRevision: adopted?.revision ?? null,
      adoptionDrift: adopted?.drift ?? null,
      verificationStatus: unit.verificationStatus,
      evidenceRefs: unit.evidenceRefs ?? [],
      revisions,
      sources: this.listSources({ projectId: unit.projectId ?? '' }).filter((source) =>
        revisions.some((rev) => rev.links.some((link) => link.sourceId === source.sourceId))),
      pendingRevalidations: this.listRevalidations({ status: 'pending', unitId }),
      conflicts: this.listConflicts({ unitId, status: 'open' })
    };
  }

  // ---- 冲突（供 sync 使用） ----

  addConflict({ unitId, field, baseValue, localValue, incomingValue, localRevision, incomingRevision, incomingOrigin }) {
    const id = `conflict_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const stamp = this.clock();
    const payload = {
      contract: 'knowledge-conflict/v1', id, unitId, field,
      baseValue: baseValue ?? null, localValue: localValue ?? null, incomingValue: incomingValue ?? null,
      localRevision, incomingRevision, incomingOrigin, status: 'open', createdAt: stamp
    };
    const body = canonical(payload);
    this.db.prepare(`INSERT INTO knowledge_conflicts
      (id,unit_id,field,base_value,local_value,incoming_value,local_revision,incoming_revision,incoming_origin,status,created_at,payload,payload_hash)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, unitId, field, json(baseValue ?? null), json(localValue ?? null), json(incomingValue ?? null),
      localRevision, incomingRevision, incomingOrigin, 'open', stamp, body, sha256(body)
    );
    return this.getConflict(id);
  }

  getConflict(id) {
    const row = this.db.prepare('SELECT * FROM knowledge_conflicts WHERE id=?').get(id);
    if (!row) return null;
    return {
      ...JSON.parse(row.payload),
      baseValue: JSON.parse(row.base_value), localValue: JSON.parse(row.local_value),
      incomingValue: JSON.parse(row.incoming_value), status: row.status
    };
  }

  listConflicts({ unitId = '', status = 'open', limit = 100 } = {}) {
    const where = [];
    const params = [];
    if (unitId) { where.push('unit_id=?'); params.push(unitId); }
    if (status) { where.push('status=?'); params.push(status); }
    const rows = this.db.prepare(`SELECT id FROM knowledge_conflicts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC LIMIT ?`).all(...params, limit);
    return rows.map(({ id }) => this.getConflict(id));
  }

  resolveConflict({ id, actor = 'owner' }) {
    const conflict = this.getConflict(id);
    if (!conflict) throw new Error('Conflict not found');
    this.db.prepare('UPDATE knowledge_conflicts SET status=? WHERE id=?').run('resolved', id);
    const payload = { ...conflict, status: 'resolved', resolvedAt: this.clock(), resolvedBy: actor };
    delete payload.baseValue; delete payload.localValue; delete payload.incomingValue;
    const body = canonical(payload);
    this.db.prepare('UPDATE knowledge_conflicts SET payload=?,payload_hash=? WHERE id=?').run(body, sha256(body), id);
    return this.getConflict(id);
  }
}
