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
  computeProjectIdentity, deviceId, knowledgeIdFor, revisionIdFor
} from './sources.mjs';

const nowIso = () => new Date().toISOString();
const json = (value) => JSON.stringify(value);
const CHANGE_OPERATIONS = new Set([
  'create', 'revise', 'adopt', 'link-source', 'observe-source',
  'resolve-revalidation', 'conflict', 'resolve-conflict'
]);

export class KnowledgeProvenance {
  constructor({ personalStore, clock = nowIso, device = null } = {}) {
    if (!personalStore?.db) throw new Error('personalStore with an open database is required');
    this.store = personalStore;
    this.db = personalStore.db;
    this.clock = clock;
    this.device = device ?? deviceId();
    this.backfilling = false;
    // 任何修订写完后同步维护不可变索引与变更日志；失败不阻塞知识写入。
    this.store.onRevision = (info) => this.recordRevision(info);
    this.ensureMigration();
  }

  /** 旧库升级：补身份映射、修订索引与缺失列；不改动已有修订内容。 */
  ensureMigration() {
    try {
      const conflictColumns = this.db.prepare('PRAGMA table_info(knowledge_conflicts)').all().map((row) => row.name);
      if (!conflictColumns.includes('candidate_id')) {
        this.db.exec('ALTER TABLE knowledge_conflicts ADD COLUMN candidate_id TEXT');
      }
    } catch { /* 表不存在时由 DDL 负责 */ }
    this.backfilling = true;
    try {
      const units = this.db.prepare('SELECT id FROM personal_units ORDER BY created_at,id').all();
      for (const { id } of units) {
        this.knowledgeIdForUnit(id);
        const rows = this.db.prepare(
          'SELECT revision,payload,payload_hash,actor,note,timestamp FROM personal_revisions WHERE unit_id=? ORDER BY revision ASC'
        ).all(id);
        let previous = null;
        for (const row of rows) {
          const existing = this.db.prepare(
            'SELECT revision_id FROM knowledge_revision_index WHERE knowledge_id=? AND local_revision=?'
          ).get(this.knowledgeIdForUnit(id), row.revision);
          if (existing) { previous = existing.revision_id; continue; }
          const revisionId = this.insertRevisionIndex({
            unitId: id,
            knowledgeId: this.knowledgeIdForUnit(id),
            localRevision: row.revision,
            payload: JSON.parse(row.payload),
            payloadHash: row.payload_hash,
            actor: row.actor,
            note: row.note,
            recordedAt: row.timestamp,
            parentRevisionIds: previous ? [previous] : [],
            emit: false
          });
          previous = revisionId;
        }
      }
    } finally {
      this.backfilling = false;
    }
  }

  // ---- 身份 ----

  /** 本地 unit ↔ 跨设备 knowledgeId 的稳定映射；旧单元默认沿用 unit id。 */
  knowledgeIdForUnit(unitId) {
    const id = String(unitId ?? '');
    if (!id) throw new Error('unitId is required');
    const row = this.db.prepare('SELECT knowledge_id FROM knowledge_identities WHERE unit_id=?').get(id);
    if (row) return row.knowledge_id;
    const knowledgeId = knowledgeIdFor(id);
    this.db.prepare('INSERT OR IGNORE INTO knowledge_identities(knowledge_id,unit_id,created_at) VALUES(?,?,?)')
      .run(knowledgeId, id, this.clock());
    return knowledgeId;
  }

  /** 把远端 knowledgeId 绑定到本地 unit；已绑定时返回现有映射。 */
  bindKnowledgeId({ knowledgeId, unitId }) {
    const existing = this.db.prepare('SELECT unit_id FROM knowledge_identities WHERE knowledge_id=?').get(knowledgeId);
    if (existing) return { knowledgeId, unitId: existing.unit_id, bound: false };
    const byUnit = this.db.prepare('SELECT knowledge_id FROM knowledge_identities WHERE unit_id=?').get(unitId);
    if (byUnit) return { knowledgeId: byUnit.knowledge_id, unitId, bound: false };
    this.db.prepare('INSERT INTO knowledge_identities(knowledge_id,unit_id,created_at) VALUES(?,?,?)')
      .run(knowledgeId, unitId, this.clock());
    return { knowledgeId, unitId, bound: true };
  }

  unitForKnowledgeId(knowledgeId) {
    const row = this.db.prepare('SELECT unit_id FROM knowledge_identities WHERE knowledge_id=?').get(knowledgeId);
    return row?.unit_id ?? null;
  }

  // ---- 不可变修订索引与变更日志 ----

  /** 写入一条不可变修订；同一 revisionId 幂等。 */
  insertRevisionIndex({
    unitId, knowledgeId, localRevision, payload, payloadHash,
    actor = '', note = '', recordedAt = '', parentRevisionIds = [], emit = true, status = 'active',
    revisionId = null
  }) {
    const contentHash = payloadHash || sha256(canonical(payload));
    const parents = [...new Set(parentRevisionIds.map(String).filter(Boolean))];
    const identity = revisionId ?? revisionIdFor({
      knowledgeId, contentHash, parentRevisionIds: parents, reason: note, actorId: actor
    });
    const stamp = recordedAt || this.clock();
    const body = canonical(payload);
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO knowledge_revision_index
      (revision_id,knowledge_id,unit_id,local_revision,schema_version,parent_revision_ids,reason,actor_id,
       device_id,recorded_at,content_hash,verification_status,payload,payload_hash,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      identity, knowledgeId, unitId, localRevision ?? null, 1, json(parents),
      String(note ?? '').slice(0, 500), String(actor ?? '').slice(0, 80), this.device,
      stamp, contentHash, String(payload?.verificationStatus ?? 'unknown').slice(0, 40),
      body, contentHash, status
    );
    if (inserted.changes === 0 && localRevision !== null && localRevision !== undefined) {
      // 该修订此前作为远端候选（local_revision=NULL）存在，现在正式进入本地历史。
      this.db.prepare(`UPDATE knowledge_revision_index
        SET local_revision=?, unit_id=?, status='active', recorded_at=?
        WHERE revision_id=? AND local_revision IS NULL`).run(localRevision, unitId, stamp, identity);
    }
    if (emit && !this.backfilling) {
      this.appendChange({
        knowledgeId,
        operation: (localRevision ?? 0) > 1 ? 'revise' : 'create',
        baseRevisionId: parents[0] ?? null,
        resultRevisionId: identity,
        actorId: actor,
        occurredAt: stamp,
        payload: { revisionId: identity, localRevision: localRevision ?? null, contentHash, parents }
      });
    }
    return identity;
  }

  /** PersonalKnowledgeStore 修订钩子：维护索引并记录变更事件。 */
  recordRevision({ unitId, revision, payload, payloadHash, actor = '', note = '', timestamp = '', parentRevisionIds = [] }) {
    const knowledgeId = this.knowledgeIdForUnit(unitId);
    let parents = parentRevisionIds.filter(Boolean);
    if (parents.length === 0 && revision > 1) {
      const previous = this.db.prepare(
        'SELECT revision_id FROM knowledge_revision_index WHERE knowledge_id=? AND local_revision=?'
      ).get(knowledgeId, revision - 1);
      if (previous) parents = [previous.revision_id];
    }
    const revisionId = this.insertRevisionIndex({
      unitId, knowledgeId, localRevision: revision, payload, payloadHash,
      actor, note, recordedAt: timestamp || this.clock(), parentRevisionIds: parents
    });
    // 本地单条写入也尽快解析挂起项；失败不阻塞修订。
    try { this.resolvePending({ unitId }); } catch { /* best effort */ }
    return revisionId;
  }

  getRevision(revisionId) {
    const row = this.db.prepare('SELECT * FROM knowledge_revision_index WHERE revision_id=?').get(revisionId);
    if (!row) return null;
    return {
      revisionId: row.revision_id,
      knowledgeId: row.knowledge_id,
      unitId: row.unit_id,
      localRevision: row.local_revision,
      schemaVersion: row.schema_version,
      parentRevisionIds: JSON.parse(row.parent_revision_ids),
      reason: row.reason,
      actorId: row.actor_id,
      deviceId: row.device_id,
      recordedAt: row.recorded_at,
      contentHash: row.content_hash,
      verificationStatus: row.verification_status,
      status: row.status,
      payload: JSON.parse(row.payload),
      payloadHash: row.payload_hash
    };
  }

  listRevisions({ unitId = '', knowledgeId = '', limit = 500 } = {}) {
    const where = [];
    const params = [];
    if (unitId) { where.push('unit_id=?'); params.push(unitId); }
    if (knowledgeId) { where.push('knowledge_id=?'); params.push(knowledgeId); }
    const rows = this.db.prepare(`SELECT revision_id FROM knowledge_revision_index
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY recorded_at ASC, local_revision ASC LIMIT ?`).all(...params, limit);
    return rows.map(({ revision_id }) => this.getRevision(revision_id));
  }

  /** 记录不可变变更事件；重复 changeId + 同 hash 幂等，不同 hash 视为篡改。 */
  appendChange({
    changeId = '', knowledgeId, operation, baseRevisionId = null, resultRevisionId = null,
    actorId = '', originSystem = 'owner', originDevice = null, occurredAt = '', payload = {}
  }) {
    if (!knowledgeId) throw new Error('knowledgeId is required');
    if (!CHANGE_OPERATIONS.has(operation)) throw new Error(`Unknown change operation: ${operation}`);
    const id = changeId || `chg_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const stamp = occurredAt || this.clock();
    const body = canonical(payload);
    const payloadHash = sha256(body);
    const device = originDevice ?? this.device;
    const existing = this.db.prepare('SELECT payload_hash FROM knowledge_changes WHERE change_id=?').get(id);
    if (existing) {
      if (existing.payload_hash !== payloadHash) throw new Error(`Change ${id} replayed with a different payload`);
      return { changeId: id, duplicate: true };
    }
    this.db.prepare(`INSERT INTO knowledge_changes
      (change_id,schema_version,knowledge_id,operation,base_revision_id,result_revision_id,
       actor_id,origin_system,origin_device,occurred_at,payload_hash,payload,applied_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, 1, knowledgeId, operation, baseRevisionId, resultRevisionId,
      String(actorId ?? '').slice(0, 80), String(originSystem ?? 'owner').slice(0, 40),
      String(device).slice(0, 120), stamp, payloadHash, body, this.clock()
    );
    return { changeId: id, duplicate: false, payloadHash };
  }

  getChange(changeId) {
    const row = this.db.prepare('SELECT * FROM knowledge_changes WHERE change_id=?').get(changeId);
    if (!row) return null;
    return {
      changeId: row.change_id, schemaVersion: row.schema_version, knowledgeId: row.knowledge_id,
      operation: row.operation, baseRevisionId: row.base_revision_id, resultRevisionId: row.result_revision_id,
      actorId: row.actor_id, originSystem: row.origin_system, originDevice: row.origin_device,
      occurredAt: row.occurred_at, payloadHash: row.payload_hash, payload: JSON.parse(row.payload),
      appliedAt: row.applied_at
    };
  }

  listChanges({ since = '', knowledgeId = '', limit = 500 } = {}) {
    const where = [];
    const params = [];
    if (since) { where.push('applied_at > ?'); params.push(since); }
    if (knowledgeId) { where.push('knowledge_id=?'); params.push(knowledgeId); }
    const rows = this.db.prepare(`SELECT change_id FROM knowledge_changes
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY applied_at ASC, rowid ASC LIMIT ?`).all(...params, limit);
    return rows.map(({ change_id }) => this.getChange(change_id));
  }

  // ---- 挂起的来源/采纳（目标修订尚未落地） ----

  localRevisionFor(unitId, revisionId) {
    const row = this.db.prepare(
      'SELECT local_revision FROM knowledge_revision_index WHERE unit_id=? AND revision_id=?'
    ).get(unitId, revisionId);
    return row?.local_revision ?? null;
  }

  addPendingLink({ unitId, revisionId, observationId, relation, createdBy = 'sync', createdAt = '' }) {
    const stamp = createdAt || this.clock();
    const payload = { contract: 'knowledge-pending-link/v1', unitId, revisionId, observationId, relation, createdAt: stamp, createdBy };
    const body = canonical(payload);
    this.db.prepare(`INSERT OR IGNORE INTO knowledge_pending_links
      (unit_id,revision_id,observation_id,relation,created_at,created_by,payload,payload_hash)
      VALUES(?,?,?,?,?,?,?,?)`).run(
      unitId, revisionId, observationId, relation, stamp, createdBy, body, sha256(body)
    );
    return true;
  }

  addPendingAdoption({ unitId, revisionId, actor = 'sync', note = '', createdAt = '' }) {
    const stamp = createdAt || this.clock();
    const payload = { contract: 'knowledge-pending-adoption/v1', unitId, revisionId, actor, note, createdAt: stamp };
    const body = canonical(payload);
    this.db.prepare(`INSERT OR IGNORE INTO knowledge_pending_adoptions
      (unit_id,revision_id,actor,note,created_at,payload_hash)
      VALUES(?,?,?,?,?,?)`).run(unitId, revisionId, actor, String(note ?? '').slice(0, 500), stamp, sha256(body));
    return true;
  }

  listPendingLinks({ unitId = '', limit = 200 } = {}) {
    const rows = unitId
      ? this.db.prepare('SELECT * FROM knowledge_pending_links WHERE unit_id=? ORDER BY created_at ASC LIMIT ?').all(unitId, limit)
      : this.db.prepare('SELECT * FROM knowledge_pending_links ORDER BY created_at ASC LIMIT ?').all(limit);
    return rows.map((row) => ({
      unitId: row.unit_id, revisionId: row.revision_id, observationId: row.observation_id,
      relation: row.relation, createdAt: row.created_at, createdBy: row.created_by
    }));
  }

  listPendingAdoptions({ unitId = '', limit = 200 } = {}) {
    const rows = unitId
      ? this.db.prepare('SELECT * FROM knowledge_pending_adoptions WHERE unit_id=? ORDER BY created_at ASC LIMIT ?').all(unitId, limit)
      : this.db.prepare('SELECT * FROM knowledge_pending_adoptions ORDER BY created_at ASC LIMIT ?').all(limit);
    return rows.map((row) => ({
      unitId: row.unit_id, revisionId: row.revision_id, actor: row.actor,
      note: row.note, createdAt: row.created_at
    }));
  }

  /** 目标修订落地后，把挂起的来源与采纳显式解析到本地 revision。 */
  resolvePending({ unitId = '' } = {}) {
    let links = 0;
    let adoptions = 0;
    for (const item of this.listPendingLinks({ unitId })) {
      const localRevision = this.localRevisionFor(item.unitId, item.revisionId);
      if (localRevision === null) continue;
      if (!this.getObservation(item.observationId)) continue;
      const exists = this.db.prepare(`SELECT 1 AS hit FROM knowledge_source_links
        WHERE unit_id=? AND revision=? AND observation_id=? AND relation=?`)
        .get(item.unitId, localRevision, item.observationId, item.relation);
      if (!exists) {
        const payload = {
          contract: 'knowledge-source-link/v1', unitId: item.unitId, revision: localRevision,
          observationId: item.observationId, relation: item.relation,
          createdAt: item.createdAt, createdBy: item.createdBy
        };
        const body = canonical(payload);
        this.db.prepare(`INSERT OR IGNORE INTO knowledge_source_links
          (unit_id,revision,observation_id,relation,created_at,created_by,payload,payload_hash)
          VALUES(?,?,?,?,?,?,?,?)`).run(
          item.unitId, localRevision, item.observationId, item.relation,
          item.createdAt, item.createdBy, body, sha256(body)
        );
        links += 1;
      }
      this.db.prepare('DELETE FROM knowledge_pending_links WHERE unit_id=? AND revision_id=? AND observation_id=? AND relation=?')
        .run(item.unitId, item.revisionId, item.observationId, item.relation);
    }
    for (const item of this.listPendingAdoptions({ unitId })) {
      const localRevision = this.localRevisionFor(item.unitId, item.revisionId);
      if (localRevision === null) continue;
      const row = this.db.prepare('SELECT payload_hash FROM personal_revisions WHERE unit_id=? AND revision=?')
        .get(item.unitId, localRevision);
      if (!row) continue;
      if (!this.adoption(item.unitId)) {
        this.adopt({ unitId: item.unitId, revision: localRevision, actor: item.actor, note: item.note });
        adoptions += 1;
      }
      this.db.prepare('DELETE FROM knowledge_pending_adoptions WHERE unit_id=? AND revision_id=?')
        .run(item.unitId, item.revisionId);
    }
    return { links, adoptions };
  }

  // ---- 分叉候选（不直接改本地 Head） ----
  addCandidate({
    knowledgeId, unitId, baseRevisionId = null, revisionId, payload, payloadHash,
    sourceBundle = {}, originDevice = ''
  }) {
    const contentHash = payloadHash || sha256(canonical(payload));
    const candidateId = `cand_${sha256(canonical({ knowledgeId, revisionId })).slice(0, 24)}`;
    this.db.prepare(`INSERT OR IGNORE INTO knowledge_candidates
      (candidate_id,knowledge_id,unit_id,base_revision_id,revision_id,payload,payload_hash,
       source_bundle,origin_device,created_at,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      candidateId, knowledgeId, unitId, baseRevisionId, revisionId,
      canonical(payload), contentHash, canonical(sourceBundle),
      String(originDevice ?? '').slice(0, 120), this.clock(), 'open'
    );
    return this.getCandidate(candidateId);
  }

  getCandidate(candidateId) {
    const row = this.db.prepare('SELECT * FROM knowledge_candidates WHERE candidate_id=?').get(candidateId);
    if (!row) return null;
    return {
      candidateId: row.candidate_id, knowledgeId: row.knowledge_id, unitId: row.unit_id,
      baseRevisionId: row.base_revision_id, revisionId: row.revision_id,
      payload: JSON.parse(row.payload), payloadHash: row.payload_hash,
      sourceBundle: JSON.parse(row.source_bundle), originDevice: row.origin_device,
      createdAt: row.created_at, status: row.status, resolvedRevisionId: row.resolved_revision_id
    };
  }

  listCandidates({ unitId = '', status = 'open', limit = 100 } = {}) {
    const where = [];
    const params = [];
    if (unitId) { where.push('unit_id=?'); params.push(unitId); }
    if (status) { where.push('status=?'); params.push(status); }
    const rows = this.db.prepare(`SELECT candidate_id FROM knowledge_candidates
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC LIMIT ?`).all(...params, limit);
    return rows.map(({ candidate_id }) => this.getCandidate(candidate_id));
  }

  // ---- 同步游标 ----

  getSyncState(key = 'default') {
    const row = this.db.prepare('SELECT value,updated_at FROM knowledge_sync_state WHERE key=?').get(key);
    return row ? { key, value: row.value, updatedAt: row.updated_at } : null;
  }

  setSyncState(key, value) {
    const stamp = this.clock();
    this.db.prepare(`INSERT INTO knowledge_sync_state(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .run(String(key), String(value), stamp);
    return { key, value: String(value), updatedAt: stamp };
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
  observeSource(input, { observedBy = 'agent', captureRunId = '', sessionId = '' } = {}) {
    const { descriptor, observation } = normalizeObservation({
      ...input,
      observedBy,
      captureRunId,
      sessionId,
      deviceId: this.device,
      actorId: observedBy,
      runId: captureRunId || input.runId || ''
    });
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

  /** 显式标记来源不可访问：只排队重验证，不改知识内容或验证状态。 */
  markSourceUnavailable({ sourceId, note = '' }) {
    const source = this.getSource(sourceId);
    if (!source) throw new Error('Source not found');
    const latest = this.listObservations({ sourceId, limit: 1 })[0] ?? null;
    const payload = { ...source, availability: 'unavailable', lastSeenAt: this.clock(), note };
    delete payload.payloadHash;
    const body = canonical(payload);
    this.db.prepare('UPDATE knowledge_sources SET availability=?,last_seen_at=?,payload=?,payload_hash=? WHERE source_id=?')
      .run('unavailable', this.clock(), body, sha256(body), sourceId);
    if (!latest) return { source: this.getSource(sourceId), revalidations: [] };
    const rows = this.db.prepare(`SELECT l.unit_id, l.revision, o.observation_id
      FROM knowledge_source_links l
      JOIN knowledge_source_observations o ON o.observation_id = l.observation_id
      WHERE o.source_id = ?`).all(sourceId);
    const created = [];
    const seen = new Set();
    for (const row of rows) {
      const key = `${row.unit_id}:${row.revision}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const item = this.createRevalidation({
        unitId: row.unit_id, revision: row.revision, sourceId,
        fromObservationId: row.observation_id, toObservationId: latest.observationId,
        reason: 'source_unavailable'
      });
      if (item) created.push(item);
    }
    return { source: this.getSource(sourceId), revalidations: created };
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
    const insertResult = this.db.prepare(`INSERT OR IGNORE INTO knowledge_source_links
      (unit_id,revision,observation_id,relation,created_at,created_by,payload,payload_hash)
      VALUES(?,?,?,?,?,?,?,?)`).run(unitId, revision, observationId, normalizedRelation, stamp, by, body, sha256(body));
    if (insertResult.changes > 0) {
      const revisionRow = this.db.prepare(
        'SELECT revision_id FROM knowledge_revision_index WHERE knowledge_id=? AND local_revision=?'
      ).get(this.knowledgeIdForUnit(unitId), revision);
      this.appendChange({
        knowledgeId: this.knowledgeIdForUnit(unitId),
        operation: 'link-source',
        baseRevisionId: revisionRow?.revision_id ?? null,
        resultRevisionId: revisionRow?.revision_id ?? null,
        actorId: by,
        payload: { unitId, revision, observationId, relation: normalizedRelation }
      });
    }
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
    const revisionRow = this.db.prepare(
      'SELECT revision_id FROM knowledge_revision_index WHERE knowledge_id=? AND local_revision=?'
    ).get(this.knowledgeIdForUnit(unitId), target);
    this.appendChange({
      knowledgeId: this.knowledgeIdForUnit(unitId),
      operation: 'adopt',
      resultRevisionId: revisionRow?.revision_id ?? null,
      actorId: actor,
      payload: { unitId, revision: target, note: note.slice(0, 500) }
    });
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
    this.appendChange({
      knowledgeId: this.knowledgeIdForUnit(item.unitId),
      operation: 'resolve-revalidation',
      resultRevisionId: this.db.prepare(
        'SELECT revision_id FROM knowledge_revision_index WHERE knowledge_id=? AND local_revision=?'
      ).get(this.knowledgeIdForUnit(item.unitId), item.revision)?.revision_id ?? null,
      actorId: actor,
      payload: { revalidationId: id, decision, unitId: item.unitId, revision: item.revision }
    });
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
    const knowledgeId = this.knowledgeIdForUnit(unitId);
    const indexRows = this.db.prepare(
      'SELECT revision_id,local_revision,parent_revision_ids,schema_version FROM knowledge_revision_index WHERE unit_id=? ORDER BY local_revision ASC'
    ).all(unitId);
    const revisionIds = new Map(indexRows.map((row) => [row.local_revision, row.revision_id]));
    const adopted = this.adoption(unitId);
    const revisions = revisionHashes.map((item) => ({
      ...item,
      revisionId: revisionIds.get(item.revision) ?? null,
      links: this.linksFor({ unitId, revision: item.revision })
    }));
    return {
      unitId,
      knowledgeId,
      schemaVersion: 2,
      headRevision: unit.revision,
      headRevisionId: revisionIds.get(unit.revision) ?? null,
      adoptedRevision: adopted?.revision ?? null,
      adoptedRevisionId: adopted ? revisionIds.get(adopted.revision) ?? null : null,
      adoptionDrift: adopted?.drift ?? null,
      verificationStatus: unit.verificationStatus,
      evidenceRefs: unit.evidenceRefs ?? [],
      revisions,
      changes: this.listChanges({ knowledgeId, limit: 200 }),
      candidates: this.listCandidates({ unitId, status: 'open' }),
      sources: this.listSources({ projectId: unit.projectId ?? '' }).filter((source) =>
        revisions.some((rev) => rev.links.some((link) => link.sourceId === source.sourceId))),
      pendingRevalidations: this.listRevalidations({ status: 'pending', unitId }),
      conflicts: this.listConflicts({ unitId, status: 'open' })
    };
  }

  /** 把候选分支携带的来源导入并挂到新修订上（R4 仍保留来源证据）。 */
  importCandidateProvenance(candidate, { unitId, revision, by = 'sync' }) {
    const bundle = candidate?.sourceBundle ?? {};
    for (const source of bundle.sources ?? []) {
      if (!source?.sourceId || this.getSource(source.sourceId)) continue;
      const payload = { ...source };
      delete payload.payloadHash;
      const body = canonical(payload);
      this.db.prepare(`INSERT OR IGNORE INTO knowledge_sources
        (source_id,source_type,namespace,object_id,project_id,locator,availability,first_seen_at,last_seen_at,payload,payload_hash)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        source.sourceId, source.sourceType, source.namespace, source.objectId,
        source.projectId ?? null, source.locator, source.availability ?? 'unknown',
        source.firstSeenAt ?? this.clock(), source.lastSeenAt ?? this.clock(),
        body, sha256(body)
      );
    }
    for (const observation of bundle.observations ?? []) {
      if (!observation?.observationId || !this.getSource(observation.sourceId)) continue;
      if (this.getObservation(observation.observationId)) continue;
      const payload = { ...observation };
      delete payload.payloadHash;
      const body = canonical(payload);
      this.db.prepare(`INSERT OR IGNORE INTO knowledge_source_observations
        (observation_id,source_id,source_version,content_hash,locator,observed_at,capture_run_id,observed_by,availability,payload,payload_hash)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        observation.observationId, observation.sourceId, observation.sourceVersion,
        observation.contentHash ?? '', observation.locator, observation.observedAt,
        observation.captureRunId ?? '', observation.observedBy ?? 'sync',
        observation.availability ?? 'unknown', body, sha256(body)
      );
    }
    for (const link of bundle.links ?? []) {
      if (!link?.observationId || !this.getObservation(link.observationId)) continue;
      try { this.linkRevision({ unitId, revision, observationId: link.observationId, relation: link.relation, by }); }
      catch { /* 关系非法或修订不匹配时跳过，不阻塞冲突解决 */ }
    }
    return { links: this.linksFor({ unitId, revision }) };
  }

  // ---- 冲突（供 sync 使用） ----

  addConflict({
    unitId, field, baseValue, localValue, incomingValue,
    localRevision, incomingRevision, incomingOrigin, candidateId = null
  }) {
    const id = `conflict_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const stamp = this.clock();
    const payload = {
      contract: 'knowledge-conflict/v1', id, unitId, field,
      baseValue: baseValue ?? null, localValue: localValue ?? null, incomingValue: incomingValue ?? null,
      localRevision, incomingRevision, incomingOrigin, candidateId, status: 'open', createdAt: stamp
    };
    const body = canonical(payload);
    this.db.prepare(`INSERT INTO knowledge_conflicts
      (id,unit_id,field,base_value,local_value,incoming_value,local_revision,incoming_revision,incoming_origin,status,created_at,payload,payload_hash,candidate_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, unitId, field, json(baseValue ?? null), json(localValue ?? null), json(incomingValue ?? null),
      localRevision, incomingRevision, incomingOrigin, 'open', stamp, body, sha256(body), candidateId
    );
    this.appendChange({
      knowledgeId: this.knowledgeIdForUnit(unitId),
      operation: 'conflict',
      baseRevisionId: null,
      resultRevisionId: null,
      actorId: 'sync',
      payload: { conflictId: id, unitId, field, localRevision, incomingRevision, candidateId }
    });
    return this.getConflict(id);
  }

  getConflict(id) {
    const row = this.db.prepare('SELECT * FROM knowledge_conflicts WHERE id=?').get(id);
    if (!row) return null;
    return {
      ...JSON.parse(row.payload),
      baseValue: JSON.parse(row.base_value), localValue: JSON.parse(row.local_value),
      incomingValue: JSON.parse(row.incoming_value), status: row.status,
      candidateId: row.candidate_id ?? JSON.parse(row.payload).candidateId ?? null
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

  /**
   * Owner 处理同步冲突。只有显式决定才会产生新修订（R4），绝不自动覆盖：
   * - accept-local：保留本地 Head，候选标记 rejected；
   * - accept-incoming：以候选内容生成新修订；
   * - merge：用调用方给出的合并内容生成新修订；
   * - dismiss：只关闭冲突提示。
   */
  resolveConflict({ id, decision = 'dismiss', payload = null, actor = 'owner', note = '' }) {
    if (!['accept-local', 'accept-incoming', 'merge', 'dismiss'].includes(decision)) {
      throw new Error('Invalid conflict decision');
    }
    const conflict = this.getConflict(id);
    if (!conflict) throw new Error('Conflict not found');
    if (conflict.status !== 'open') throw new Error('Conflict already resolved');
    const unit = this.store.get(conflict.unitId);
    if (!unit) throw new Error('Knowledge unit not found');
    const knowledgeId = this.knowledgeIdForUnit(unit.id);
    const headRow = this.db.prepare(
      'SELECT revision_id FROM knowledge_revision_index WHERE knowledge_id=? AND local_revision=?'
    ).get(knowledgeId, unit.revision);
    const candidate = conflict.candidateId ? this.getCandidate(conflict.candidateId) : null;
    let resolvedRevisionId = null;
    let resolved = null;
    if (decision === 'accept-incoming' || decision === 'merge') {
      if (decision === 'accept-incoming' && !candidate) throw new Error('No candidate revision for this conflict');
      const nextPayload = decision === 'merge' ? payload : candidate.payload;
      if (!nextPayload) throw new Error('Merged payload is required');
      const parents = [headRow?.revision_id, candidate?.revisionId].filter(Boolean);
      resolved = this.store.update(unit.id, nextPayload, {
        expectedRevision: unit.revision,
        actor,
        note: note || `Resolved sync conflict ${id} (${decision})`,
        parents
      });
      resolvedRevisionId = this.db.prepare(
        'SELECT revision_id FROM knowledge_revision_index WHERE knowledge_id=? AND local_revision=?'
      ).get(knowledgeId, resolved.revision)?.revision_id ?? null;
      if (candidate) {
        this.importCandidateProvenance(candidate, { unitId: unit.id, revision: resolved.revision, by: actor });
        this.db.prepare('UPDATE knowledge_candidates SET status=?,resolved_revision_id=? WHERE candidate_id=?')
          .run(decision === 'merge' ? 'merged' : 'adopted', resolvedRevisionId, candidate.candidateId);
      }
    } else if (candidate) {
      this.db.prepare('UPDATE knowledge_candidates SET status=? WHERE candidate_id=?')
        .run(decision === 'accept-local' ? 'rejected' : 'dismissed', candidate.candidateId);
    }
    const stamp = this.clock();
    this.db.prepare('UPDATE knowledge_conflicts SET status=? WHERE id=?').run('resolved', id);
    if (candidate && decision !== 'dismiss') {
      this.db.prepare('UPDATE knowledge_conflicts SET status=? WHERE candidate_id=? AND status=?')
        .run('resolved', candidate.candidateId, 'open');
    }
    const nextPayload = {
      ...conflict, status: 'resolved', decision, resolvedAt: stamp,
      resolvedBy: actor, resolutionNote: note, resolvedRevisionId
    };
    delete nextPayload.baseValue; delete nextPayload.localValue; delete nextPayload.incomingValue;
    const body = canonical(nextPayload);
    this.db.prepare('UPDATE knowledge_conflicts SET payload=?,payload_hash=? WHERE id=?').run(body, sha256(body), id);
    this.appendChange({
      knowledgeId,
      operation: 'resolve-conflict',
      resultRevisionId: resolvedRevisionId,
      actorId: actor,
      payload: { conflictId: id, decision, unitId: unit.id, resolvedRevisionId }
    });
    return {
      conflict: this.getConflict(id),
      revision: resolved,
      revisionId: resolvedRevisionId
    };
  }
}
