// 离线增量同步：导出 / 导入 / 三方合并。
//
// 原则：
// - 导入前先校验 payload_hash，损坏或伪造的条目整条拒绝。
// - 本地领先 → 跳过；远端领先 → fast-forward 追加修订（不改写历史）。
// - 双方分叉 → 逐字段三方合并；任何字段冲突都保留本地 Head、记录 conflict，
//   绝不静默覆盖 Owner 已采纳的知识。
// - 所有写入都经过 PersonalKnowledgeStore 现有校验，不绕过 normalize。
import { canonical, sha256 } from '../utils.mjs';

export const SYNC_CONTRACT = 'knowledge-sync/v1';
export const SYNC_SCHEMA_VERSION = 1;

const MERGE_FIELDS = [
  'title', 'content', 'kind', 'layer', 'scope', 'projectId',
  'domains', 'tags', 'evidenceRefs', 'verificationStatus', 'relations', 'sourceRef'
];

const same = (a, b) => canonical(a ?? null) === canonical(b ?? null);
const hashOf = (payload) => sha256(canonical(payload));

export function exportBundle({ personalStore, provenance = null, projectId = '', all = false, now = new Date().toISOString(), device = 'unknown' } = {}) {
  if (!personalStore?.db) throw new Error('personalStore is required');
  const units = all || !projectId
    ? personalStore.list({ limit: 2000 })
    : personalStore.list({ projectId, limit: 2000 });
  const unitIds = new Set(units.map((unit) => unit.id));
  const exportedUnits = units.map((unit) => {
    const revisions = personalStore.revisions(unit.id).slice().reverse().map((row) => ({
      revision: row.revision,
      payload: row.payload,
      payloadHash: row.payload_hash,
      actor: row.actor,
      note: row.note,
      timestamp: row.timestamp
    }));
    return { id: unit.id, revision: unit.revision, createdAt: unit.createdAt, updatedAt: unit.updatedAt, revisions };
  });
  const bundle = {
    contract: SYNC_CONTRACT,
    schemaVersion: SYNC_SCHEMA_VERSION,
    exportedAt: now,
    device,
    project: provenance && projectId ? provenance.getProject(projectId) : null,
    units: exportedUnits,
    sources: [],
    observations: [],
    links: [],
    adoptions: [],
    contextSnapshots: []
  };
  if (!provenance) return bundle;
  const sourceIds = new Set();
  for (const unit of exportedUnits) {
    for (const revision of unit.revisions) {
      for (const link of provenance.linksFor({ unitId: unit.id, revision: revision.revision })) {
        sourceIds.add(link.sourceId);
        bundle.links.push({
          unitId: unit.id, revision: revision.revision,
          observationId: link.observationId, relation: link.relation,
          createdAt: link.createdAt, createdBy: link.createdBy
        });
      }
    }
    const adoption = provenance.adoption(unit.id);
    if (adoption) {
      bundle.adoptions.push({
        unitId: unit.id, revision: adoption.revision, adoptedAt: adoption.adoptedAt,
        actor: adoption.actor, note: adoption.note, payloadHash: adoption.payloadHash
      });
    }
  }
  for (const sourceId of sourceIds) {
    const source = provenance.getSource(sourceId);
    if (source) bundle.sources.push(source);
    for (const observation of provenance.listObservations({ sourceId, limit: 1000 })) {
      bundle.observations.push(observation);
    }
  }
  if (projectId) {
    const rows = personalStore.db.prepare(
      'SELECT * FROM knowledge_context_snapshots WHERE project_id=? ORDER BY created_at DESC LIMIT 200'
    ).all(projectId);
    bundle.contextSnapshots = rows.map((row) => JSON.parse(row.payload));
  }
  return bundle;
}

/** 判断单元在本地 / 远端之间的相对关系。 */
export function classifyImport(localHashes, incomingHashes) {
  if (incomingHashes.length === 0) return { action: 'invalid', reason: 'no-revisions' };
  if (localHashes.length === 0) return { action: 'new', baseIndex: -1 };
  const min = Math.min(localHashes.length, incomingHashes.length);
  let common = 0;
  while (common < min && localHashes[common] === incomingHashes[common]) common += 1;
  if (common === localHashes.length && common === incomingHashes.length) return { action: 'unchanged', baseIndex: common - 1 };
  if (common === localHashes.length) return { action: 'fast-forward', baseIndex: common - 1 };
  if (common === incomingHashes.length) return { action: 'local-ahead', baseIndex: common - 1 };
  return { action: 'diverged', baseIndex: common - 1 };
}

/** 逐字段三方合并；冲突只报告，不替 Owner 选择。 */
export function mergePayloads({ base, local, incoming }) {
  const merged = {};
  const conflicts = [];
  for (const field of MERGE_FIELDS) {
    const b = base?.[field] ?? null;
    const l = local?.[field] ?? null;
    const i = incoming?.[field] ?? null;
    if (same(l, i)) { merged[field] = l; continue; }
    if (same(l, b)) { merged[field] = i; continue; }
    if (same(i, b)) { merged[field] = l; continue; }
    conflicts.push({ field, base: b, local: l, incoming: i });
    merged[field] = l;
  }
  return { merged, conflicts };
}

const revisionHashes = (revisions) => revisions.map((row) => row.payloadHash);

function validateUnit(unit) {
  if (!unit || typeof unit.id !== 'string' || !Array.isArray(unit.revisions) || unit.revisions.length === 0) {
    throw new Error('Invalid unit entry');
  }
  unit.revisions.forEach((row, index) => {
    if (row.revision !== index + 1) throw new Error(`Non-sequential revision in ${unit.id}`);
    if (row.payloadHash !== hashOf(row.payload)) throw new Error(`Payload hash mismatch in ${unit.id} r${row.revision}`);
  });
}

function insertUnitRaw(db, unit) {
  const first = unit.revisions[0];
  const last = unit.revisions[unit.revisions.length - 1];
  const stamp = first.timestamp ?? new Date().toISOString();
  db.prepare('INSERT INTO personal_units(id,revision,payload,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(unit.id, last.revision, canonical(last.payload), stamp, last.timestamp ?? stamp);
  for (const row of unit.revisions) {
    db.prepare(`INSERT INTO personal_revisions(unit_id,revision,payload,actor,note,timestamp,payload_hash)
      VALUES(?,?,?,?,?,?,?)`).run(
      unit.id, row.revision, canonical(row.payload), row.actor ?? 'sync', row.note ?? 'Imported',
      row.timestamp ?? stamp, row.payloadHash
    );
  }
}

function importProvenance({ provenance, bundle, unitIds }) {
  const db = provenance.db;
  let sources = 0;
  let observations = 0;
  let links = 0;
  let adoptions = 0;
  for (const source of bundle.sources ?? []) {
    if (!source?.sourceId) continue;
    const existing = provenance.getSource(source.sourceId);
    if (!existing) {
      const payload = { ...source };
      delete payload.payloadHash;
      const body = canonical(payload);
      db.prepare(`INSERT OR IGNORE INTO knowledge_sources
        (source_id,source_type,namespace,object_id,project_id,locator,availability,first_seen_at,last_seen_at,payload,payload_hash)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        source.sourceId, source.sourceType, source.namespace, source.objectId,
        source.projectId ?? null, source.locator, source.availability ?? 'unknown',
        source.firstSeenAt ?? bundle.exportedAt, source.lastSeenAt ?? bundle.exportedAt,
        body, sha256(body)
      );
      sources += 1;
    }
  }
  for (const observation of bundle.observations ?? []) {
    if (!observation?.observationId || !provenance.getSource(observation.sourceId)) continue;
    if (provenance.getObservation(observation.observationId)) continue;
    const payload = { ...observation };
    delete payload.payloadHash;
    const body = canonical(payload);
    db.prepare(`INSERT OR IGNORE INTO knowledge_source_observations
      (observation_id,source_id,source_version,content_hash,locator,observed_at,capture_run_id,observed_by,availability,payload,payload_hash)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      observation.observationId, observation.sourceId, observation.sourceVersion,
      observation.contentHash ?? '', observation.locator, observation.observedAt,
      observation.captureRunId ?? '', observation.observedBy ?? 'sync',
      observation.availability ?? 'unknown', body, sha256(body)
    );
    observations += 1;
  }
  for (const link of bundle.links ?? []) {
    if (!unitIds.has(link.unitId) || !provenance.getObservation(link.observationId)) continue;
    // 合并后修订号可能变化：只接受本地真实存在的修订，避免悬挂链接。
    const revisionExists = db.prepare('SELECT 1 AS hit FROM personal_revisions WHERE unit_id=? AND revision=?')
      .get(link.unitId, link.revision);
    if (!revisionExists) continue;
    const exists = db.prepare(`SELECT 1 AS hit FROM knowledge_source_links
      WHERE unit_id=? AND revision=? AND observation_id=? AND relation=?`)
      .get(link.unitId, link.revision, link.observationId, link.relation);
    if (exists) continue;
    const stamp = link.createdAt ?? bundle.exportedAt;
    const payload = { contract: 'knowledge-source-link/v1', ...link, createdAt: stamp };
    db.prepare(`INSERT OR IGNORE INTO knowledge_source_links
      (unit_id,revision,observation_id,relation,created_at,created_by,payload,payload_hash)
      VALUES(?,?,?,?,?,?,?,?)`).run(
      link.unitId, link.revision, link.observationId, link.relation,
      stamp, link.createdBy ?? 'sync', canonical(payload), sha256(canonical(payload))
    );
    links += 1;
  }
  for (const adoption of bundle.adoptions ?? []) {
    if (!unitIds.has(adoption.unitId)) continue;
    if (provenance.adoption(adoption.unitId)) continue; // 本地已采纳：不覆盖 Owner 的决定
    const row = db.prepare('SELECT payload_hash FROM personal_revisions WHERE unit_id=? AND revision=?')
      .get(adoption.unitId, adoption.revision);
    if (!row) continue;
    provenance.adopt({ unitId: adoption.unitId, revision: adoption.revision, actor: adoption.actor ?? 'sync', note: adoption.note ?? 'Imported adoption' });
    adoptions += 1;
  }
  for (const snapshot of bundle.contextSnapshots ?? []) {
    if (!snapshot?.snapshotId) continue;
    const body = canonical(snapshot);
    db.prepare(`INSERT OR IGNORE INTO knowledge_context_snapshots
      (snapshot_id,project_id,session_id,compilation_hash,task,created_at,payload,payload_hash)
      VALUES(?,?,?,?,?,?,?,?)`).run(
      snapshot.snapshotId, snapshot.projectId, snapshot.sessionId ?? '',
      snapshot.compilationHash ?? '', snapshot.task ?? '', snapshot.createdAt ?? bundle.exportedAt,
      body, sha256(body)
    );
  }
  return { sources, observations, links, adoptions };
}

/**
 * 导入同步包。
 * apply=false 时只做计划与校验，不写任何数据（用于 CLI --dry-run）。
 */
export function importBundle({ personalStore, provenance = null, bundle, actor = 'sync', apply = true, device = 'unknown' } = {}) {
  if (!bundle || bundle.contract !== SYNC_CONTRACT) throw new Error(`Unsupported bundle contract: ${bundle?.contract}`);
  if (!Number.isSafeInteger(bundle.schemaVersion) || bundle.schemaVersion > SYNC_SCHEMA_VERSION) {
    throw new Error(`Unsupported bundle schema: ${bundle.schemaVersion}`);
  }
  const report = {
    contract: SYNC_CONTRACT, device, applied: apply,
    imported: 0, fastForwarded: 0, merged: 0, unchanged: 0, localAhead: 0,
    conflicts: [], errors: [], provenance: null
  };
  const importedIds = new Set();
  for (const unit of bundle.units ?? []) {
    try {
      validateUnit(unit);
    } catch (error) {
      report.errors.push({ unitId: unit?.id ?? null, error: error.message });
      continue;
    }
    const local = personalStore.get(unit.id);
    if (!local) {
      if (apply) {
        personalStore.db.exec('BEGIN IMMEDIATE');
        try {
          insertUnitRaw(personalStore.db, unit);
          personalStore.db.exec('COMMIT');
        } catch (error) {
          personalStore.db.exec('ROLLBACK');
          report.errors.push({ unitId: unit.id, error: `insert-failed: ${error.message}` });
          continue;
        }
      }
      report.imported += 1;
      importedIds.add(unit.id);
      continue;
    }
    const localRevisions = personalStore.revisions(unit.id).slice().reverse();
    const localHashes = localRevisions.map((row) => row.payload_hash);
    const incomingHashes = revisionHashes(unit.revisions);
    const classification = classifyImport(localHashes, incomingHashes);
    if (classification.action === 'unchanged') { report.unchanged += 1; importedIds.add(unit.id); continue; }
    if (classification.action === 'local-ahead') { report.localAhead += 1; importedIds.add(unit.id); continue; }
    if (classification.action === 'fast-forward') {
      const missing = unit.revisions.slice(localHashes.length);
      if (apply) {
        let failed = null;
        for (const row of missing) {
          const current = personalStore.get(unit.id);
          const nextRevision = current.revision + 1;
          const body = canonical(row.payload);
          personalStore.db.exec('BEGIN IMMEDIATE');
          try {
            personalStore.db.prepare('UPDATE personal_units SET revision=?,payload=?,updated_at=? WHERE id=?')
              .run(nextRevision, body, row.timestamp ?? new Date().toISOString(), unit.id);
            personalStore.db.prepare(`INSERT INTO personal_revisions(unit_id,revision,payload,actor,note,timestamp,payload_hash)
              VALUES(?,?,?,?,?,?,?)`).run(
              unit.id, nextRevision, body, row.actor ?? actor, `${row.note ?? ''} [sync:${device}]`.trim(),
              row.timestamp ?? new Date().toISOString(), sha256(body)
            );
            personalStore.db.exec('COMMIT');
          } catch (error) {
            personalStore.db.exec('ROLLBACK');
            failed = error;
            break;
          }
        }
        if (failed) {
          report.errors.push({ unitId: unit.id, error: `fast-forward-failed: ${failed.message}` });
          continue;
        }
      }
      report.fastForwarded += 1;
      importedIds.add(unit.id);
      continue;
    }
    if (classification.action === 'diverged') {
      const baseIndex = classification.baseIndex;
      const basePayload = baseIndex >= 0 ? localRevisions[baseIndex]?.payload ?? null : null;
      const incomingHeadPayload = unit.revisions[unit.revisions.length - 1].payload;
      const { merged, conflicts } = mergePayloads({ base: basePayload, local: local, incoming: incomingHeadPayload });
      if (conflicts.length) {
        if (apply && provenance) {
          for (const conflict of conflicts) {
            provenance.addConflict({
              unitId: unit.id, field: conflict.field,
              baseValue: conflict.base, localValue: conflict.local, incomingValue: conflict.incoming,
              localRevision: local.revision,
              incomingRevision: unit.revisions[unit.revisions.length - 1].revision,
              incomingOrigin: `${device}:${bundle.device ?? 'unknown'}`
            });
          }
        }
        report.conflicts.push({ unitId: unit.id, fields: conflicts.map((item) => item.field), keptRevision: local.revision });
        importedIds.add(unit.id);
        continue;
      }
      if (apply) {
        try {
          personalStore.update(unit.id, merged, {
            expectedRevision: local.revision,
            actor: 'sync-merge',
            note: `Three-way merge from ${bundle.device ?? 'unknown'}`
          });
        } catch (error) {
          report.errors.push({ unitId: unit.id, error: `merge-rejected: ${error.message}` });
          importedIds.add(unit.id);
          continue;
        }
      }
      report.merged += 1;
      importedIds.add(unit.id);
      continue;
    }
    report.errors.push({ unitId: unit.id, error: `Unsupported action: ${classification.action}` });
  }
  if (provenance) {
    if (apply) {
      report.provenance = importProvenance({ provenance, bundle, unitIds: importedIds });
    } else {
      report.provenance = { sources: 0, observations: 0, links: 0, adoptions: 0, skipped: 'dry-run' };
    }
  }
  return report;
}
