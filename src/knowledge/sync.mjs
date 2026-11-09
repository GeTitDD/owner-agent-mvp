// 离线增量同步 v2：完整快照 / 增量 Bundle / 变更事件 / 图感知分类 / 冲突候选。
//
// 原则：
// - 导入前先校验 payload_hash 与 revision_id；损坏、篡改或祖先缺失的条目整条拒绝。
// - 变更事件按 change_id 幂等；同一事件重复导入不产生新修订。
// - 修订按 revision_id + parentRevisionIds 组成 DAG；本地 revision 号只是本地顺序。
// - 远端领先且是本地后代 → 追加；双方分叉 → 保留远端候选，记录冲突，本地 Head 不动。
// - 只有 Owner 显式解决冲突才生成新修订（R4），绝不静默覆盖已采纳知识。
// - 作用域：调用方可传 allowedProjectIds；未授权的项目数据在导入前拒绝。
import { canonical, sha256 } from '../utils.mjs';
import { revisionIdFor } from './sources.mjs';

export const SYNC_CONTRACT = 'knowledge-sync/v2';
export const SYNC_SCHEMA_VERSION = 2;
const LEGACY_CONTRACTS = new Map([['knowledge-sync/v1', 1]]);

const MERGE_FIELDS = [
  'title', 'content', 'kind', 'layer', 'scope', 'projectId',
  'domains', 'tags', 'evidenceRefs', 'verificationStatus', 'relations', 'sourceRef'
];

const same = (a, b) => canonical(a ?? null) === canonical(b ?? null);
const hashOf = (payload) => sha256(canonical(payload));

function bundleVersion(bundle) {
  if (!bundle || typeof bundle !== 'object') throw new Error('Bundle must be an object');
  if (bundle.contract === SYNC_CONTRACT) {
    if (!Number.isSafeInteger(bundle.schemaVersion) || bundle.schemaVersion > SYNC_SCHEMA_VERSION) {
      throw new Error(`Unsupported bundle schema: ${bundle.schemaVersion}`);
    }
    return SYNC_SCHEMA_VERSION;
  }
  const legacy = LEGACY_CONTRACTS.get(bundle.contract);
  if (legacy) return legacy;
  throw new Error(`Unsupported bundle contract: ${bundle?.contract}`);
}

function revisionIdentity(unit, row, knowledgeId) {
  return row.revisionId ?? revisionIdFor({
    knowledgeId,
    contentHash: row.payloadHash ?? hashOf(row.payload),
    parentRevisionIds: row.parentRevisionIds ?? [],
    reason: row.note ?? '',
    actorId: row.actor ?? ''
  });
}

/** 导出完整快照或增量 Bundle。since 为上次导入的 cursor。 */
export function exportBundle({
  personalStore, provenance = null, projectId = '', all = false,
  since = '', now = new Date().toISOString(), device = 'unknown'
} = {}) {
  if (!personalStore?.db) throw new Error('personalStore is required');
  const incremental = Boolean(since);
  let units = [];
  if (incremental && provenance) {
    const touched = new Set(
      provenance.listChanges({ since, limit: 100000 }).map((change) => change.knowledgeId)
    );
    for (const knowledgeId of touched) {
      const unitId = provenance.unitForKnowledgeId(knowledgeId);
      const unit = unitId ? personalStore.get(unitId) : null;
      if (unit) units.push(unit);
    }
  } else {
    units = all || !projectId
      ? personalStore.list({ limit: 2000 })
      : personalStore.list({ projectId, limit: 2000 });
  }
  const exportedUnits = units.map((unit) => {
    const knowledgeId = provenance ? provenance.knowledgeIdForUnit(unit.id) : unit.id;
    let previousRevisionId = null;
    const revisions = personalStore.revisions(unit.id).slice().reverse().map((row) => {
      const indexed = provenance
        ? provenance.db.prepare(
          'SELECT revision_id FROM knowledge_revision_index WHERE knowledge_id=? AND local_revision=?'
        ).get(knowledgeId, row.revision)?.revision_id
        : null;
      const indexedRow = indexed ? provenance.getRevision(indexed) : null;
      const parents = indexedRow?.parentRevisionIds?.length
        ? indexedRow.parentRevisionIds
        : (previousRevisionId ? [previousRevisionId] : []);
      const revisionId = indexed ?? revisionIdFor({
        knowledgeId, contentHash: row.payload_hash, parentRevisionIds: parents,
        reason: row.note, actorId: row.actor
      });
      previousRevisionId = revisionId;
      return {
        revision: row.revision,
        revisionId,
        parentRevisionIds: parents,
        payload: row.payload,
        payloadHash: row.payload_hash,
        actor: row.actor,
        note: row.note,
        timestamp: row.timestamp
      };
    });
    return {
      id: unit.id, knowledgeId, revision: unit.revision,
      createdAt: unit.createdAt, updatedAt: unit.updatedAt, revisions
    };
  });
  const knowledgeIds = new Set(exportedUnits.map((unit) => unit.knowledgeId));
  const events = provenance
    ? provenance.listChanges({ since, limit: 100000 }).filter((change) => knowledgeIds.has(change.knowledgeId))
    : [];
  const bundle = {
    contract: SYNC_CONTRACT,
    schemaVersion: SYNC_SCHEMA_VERSION,
    exportedAt: now,
    device,
    cursor: {
      since: since || '',
      exportedAt: now,
      lastChangeAppliedAt: events.reduce((max, item) => (item.appliedAt > max ? item.appliedAt : max), since || '')
    },
    project: provenance && projectId ? provenance.getProject(projectId) : null,
    units: exportedUnits,
    events,
    candidates: [],
    sources: [],
    observations: [],
    links: [],
    adoptions: [],
    contextSnapshots: []
  };
  if (!provenance) return bundle;
  const sourceIds = new Set();
  const unitIds = new Set(exportedUnits.map((unit) => unit.id));
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
  if (provenance) {
    for (const unitId of unitIds) {
      for (const candidate of provenance.listCandidates({ unitId, status: 'open', limit: 100 })) {
        bundle.candidates.push(candidate);
      }
    }
  }
  return bundle;
}

/** 兼容 v1：按线性前缀判断单元关系。 */
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

// ---- 图与校验 ----

function buildGraph(provenance, incomingRevisions) {
  const graph = new Map();
  const localIds = new Set();
  for (const row of provenance.db.prepare('SELECT revision_id,parent_revision_ids FROM knowledge_revision_index').all()) {
    let parents = [];
    try { parents = JSON.parse(row.parent_revision_ids); } catch { parents = []; }
    graph.set(row.revision_id, parents);
    localIds.add(row.revision_id);
  }
  for (const revision of incomingRevisions) {
    if (revision.revisionId) graph.set(revision.revisionId, revision.parentRevisionIds ?? []);
  }
  return { graph, localIds };
}

function isAncestor(ancestorId, nodeId, graph) {
  if (!ancestorId || !nodeId) return false;
  if (ancestorId === nodeId) return true;
  const seen = new Set();
  const stack = [nodeId];
  while (stack.length) {
    const id = stack.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    for (const parent of graph.get(id) ?? []) {
      if (parent === ancestorId) return true;
      stack.push(parent);
    }
  }
  return false;
}

function commonAncestor(localHeadId, incomingHeadId, graph) {
  const seen = new Set();
  const stack = [localHeadId];
  while (stack.length) {
    const id = stack.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (isAncestor(id, incomingHeadId, graph)) return id;
    for (const parent of graph.get(id) ?? []) stack.push(parent);
  }
  return null;
}

/** 图感知分类：比线性前缀更可靠，能识别“分叉后的合并修订”。 */
export function classifyGraph({ localHeadId, incomingRevisions, graph, localRevisionIds }) {
  if (!incomingRevisions.length) return { action: 'invalid', reason: 'no-revisions' };
  const incomingHead = incomingRevisions[incomingRevisions.length - 1];
  const known = localRevisionIds ?? new Set();
  if (incomingRevisions.every((row) => known.has(row.revisionId))) {
    return { action: 'unchanged', baseRevisionId: incomingHead.revisionId };
  }
  if (!localHeadId) return { action: 'new', baseRevisionId: null };
  if (isAncestor(localHeadId, incomingHead.revisionId, graph)) {
    return { action: 'fast-forward', baseRevisionId: localHeadId };
  }
  if (isAncestor(incomingHead.revisionId, localHeadId, graph)) {
    return { action: 'local-ahead', baseRevisionId: incomingHead.revisionId };
  }
  const base = commonAncestor(localHeadId, incomingHead.revisionId, graph);
  return base
    ? { action: 'diverged', baseRevisionId: base }
    : { action: 'unrelated', baseRevisionId: null };
}

function validateUnit(unit, version) {
  if (!unit || typeof unit.id !== 'string' || !Array.isArray(unit.revisions) || unit.revisions.length === 0) {
    throw new Error('Invalid unit entry');
  }
  unit.revisions.forEach((row, index) => {
    if (version === 1 && row.revision !== index + 1) throw new Error(`Non-sequential revision in ${unit.id}`);
    if (!row.payload || typeof row.payload !== 'object') throw new Error(`Missing payload in ${unit.id} r${row.revision}`);
    const expected = row.payloadHash ?? hashOf(row.payload);
    if (expected !== hashOf(row.payload)) throw new Error(`Payload hash mismatch in ${unit.id} r${row.revision}`);
    if (version >= 2 && row.revisionId) {
      const recomputed = revisionIdFor({
        knowledgeId: unit.knowledgeId ?? unit.id,
        contentHash: expected,
        parentRevisionIds: row.parentRevisionIds ?? [],
        reason: row.note ?? '',
        actorId: row.actor ?? ''
      });
      if (recomputed !== row.revisionId) throw new Error(`Revision id mismatch in ${unit.id} r${row.revision}`);
    }
  });
}

function scopeOfUnit(unit) {
  const payload = unit.revisions[unit.revisions.length - 1]?.payload ?? {};
  return { projectId: payload.projectId ?? '', scope: payload.scope ?? '' };
}

function scopeAllowed({ allowedProjectIds, unit }) {
  if (!allowedProjectIds || allowedProjectIds.size === 0) return true;
  const { projectId, scope } = scopeOfUnit(unit);
  if (!projectId) return scope !== 'project';
  return allowedProjectIds.has(projectId);
}

function insertUnitRaw(db, unit, knowledgeId, provenance) {
  const first = unit.revisions[0];
  const last = unit.revisions[unit.revisions.length - 1];
  const stamp = first.timestamp ?? new Date().toISOString();
  db.prepare('INSERT INTO personal_units(id,revision,payload,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(unit.id, last.revision, canonical(last.payload), stamp, last.timestamp ?? stamp);
  for (const row of unit.revisions) {
    db.prepare(`INSERT INTO personal_revisions(unit_id,revision,payload,actor,note,timestamp,payload_hash)
      VALUES(?,?,?,?,?,?,?)`).run(
      unit.id, row.revision, canonical(row.payload), row.actor ?? 'sync', row.note ?? 'Imported',
      row.timestamp ?? stamp, row.payloadHash ?? hashOf(row.payload)
    );
    if (provenance) {
      provenance.insertRevisionIndex({
        unitId: unit.id, knowledgeId, localRevision: row.revision,
        payload: row.payload, payloadHash: row.payloadHash ?? hashOf(row.payload),
        actor: row.actor ?? 'sync', note: row.note ?? 'Imported', recordedAt: row.timestamp ?? stamp,
        parentRevisionIds: row.parentRevisionIds ?? [], emit: false,
        revisionId: row.revisionId
      });
    }
  }
  if (provenance) provenance.bindKnowledgeId({ knowledgeId, unitId: unit.id });
}

function appendRevisions({ personalStore, provenance, unit, knowledgeId, missing, device = 'unknown' }) {
  const db = personalStore.db;
  let current = personalStore.get(unit.id);
  if (!current) throw new Error('Unit disappeared during import');
  for (const row of missing) {
    const next = current.revision + 1;
    const body = canonical(row.payload);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE personal_units SET revision=?,payload=?,updated_at=? WHERE id=?')
        .run(next, body, row.timestamp ?? new Date().toISOString(), unit.id);
      db.prepare(`INSERT INTO personal_revisions(unit_id,revision,payload,actor,note,timestamp,payload_hash)
        VALUES(?,?,?,?,?,?,?)`).run(
        unit.id, next, body, row.actor ?? 'sync', `${row.note ?? ''} [sync:${device}]`.trim(),
        row.timestamp ?? new Date().toISOString(), hashOf(row.payload)
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (provenance) {
      provenance.insertRevisionIndex({
        unitId: unit.id, knowledgeId, localRevision: next,
        payload: row.payload, payloadHash: hashOf(row.payload),
        actor: row.actor ?? 'sync', note: row.note ?? 'Imported',
        recordedAt: row.timestamp ?? new Date().toISOString(),
        parentRevisionIds: row.parentRevisionIds ?? [], emit: false,
        revisionId: row.revisionId
      });
    }
    current = personalStore.get(unit.id);
  }
}

function importProvenance({ provenance, bundle, unitIds, unitIdMap, allowedProjectIds }) {
  const db = provenance.db;
  const counts = { sources: 0, observations: 0, links: 0, adoptions: 0, skippedScope: 0 };
  const sourceProject = new Map();
  for (const source of bundle.sources ?? []) {
    if (!source?.sourceId) continue;
    if (allowedProjectIds && allowedProjectIds.size > 0 && source.projectId && !allowedProjectIds.has(source.projectId)) {
      counts.skippedScope += 1;
      continue;
    }
    sourceProject.set(source.sourceId, source.projectId ?? null);
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
      counts.sources += 1;
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
    counts.observations += 1;
  }
  for (const link of bundle.links ?? []) {
    const localUnitId = unitIdMap.get(link.unitId) ?? link.unitId;
    if (!unitIds.has(localUnitId) || !provenance.getObservation(link.observationId)) continue;
    const revisionExists = db.prepare('SELECT 1 AS hit FROM personal_revisions WHERE unit_id=? AND revision=?')
      .get(localUnitId, link.revision);
    if (!revisionExists) continue;
    const exists = db.prepare(`SELECT 1 AS hit FROM knowledge_source_links
      WHERE unit_id=? AND revision=? AND observation_id=? AND relation=?`)
      .get(localUnitId, link.revision, link.observationId, link.relation);
    if (exists) continue;
    const stamp = link.createdAt ?? bundle.exportedAt;
    const payload = { contract: 'knowledge-source-link/v1', ...link, unitId: localUnitId, createdAt: stamp };
    db.prepare(`INSERT OR IGNORE INTO knowledge_source_links
      (unit_id,revision,observation_id,relation,created_at,created_by,payload,payload_hash)
      VALUES(?,?,?,?,?,?,?,?)`).run(
      localUnitId, link.revision, link.observationId, link.relation,
      stamp, link.createdBy ?? 'sync', canonical(payload), sha256(canonical(payload))
    );
    counts.links += 1;
  }
  for (const adoption of bundle.adoptions ?? []) {
    const localUnitId = unitIdMap.get(adoption.unitId) ?? adoption.unitId;
    if (!unitIds.has(localUnitId)) continue;
    if (provenance.adoption(localUnitId)) continue; // 本地已采纳：不覆盖 Owner 的决定
    const row = db.prepare('SELECT payload_hash FROM personal_revisions WHERE unit_id=? AND revision=?')
      .get(localUnitId, adoption.revision);
    if (!row) continue;
    provenance.adopt({ unitId: localUnitId, revision: adoption.revision, actor: adoption.actor ?? 'sync', note: adoption.note ?? 'Imported adoption' });
    counts.adoptions += 1;
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
  return counts;
}

function importEvents({ provenance, events, device, report }) {
  let applied = 0;
  let duplicates = 0;
  for (const event of events ?? []) {
    if (!event?.changeId || !event.knowledgeId || !event.operation) {
      report.errors.push({ eventId: event?.changeId ?? null, error: 'invalid-event' });
      continue;
    }
    const expected = hashOf(event.payload ?? {});
    if (event.payloadHash && event.payloadHash !== expected) {
      report.errors.push({ eventId: event.changeId, error: 'payload-hash-mismatch' });
      continue;
    }
    try {
      const result = provenance.appendChange({
        changeId: event.changeId,
        knowledgeId: event.knowledgeId,
        operation: event.operation,
        baseRevisionId: event.baseRevisionId ?? null,
        resultRevisionId: event.resultRevisionId ?? null,
        actorId: event.actorId ?? '',
        originSystem: event.originSystem ?? 'unknown',
        originDevice: event.originDevice ?? device,
        occurredAt: event.occurredAt,
        payload: event.payload ?? {}
      });
      if (result.duplicate) duplicates += 1; else applied += 1;
    } catch (error) {
      report.errors.push({ eventId: event.changeId, error: error.message });
    }
  }
  report.events = { applied, duplicates };
}

/** 把 Bundle 写成 JSONL：第一行 header，其余每行一个单元/事件/来源。 */
export function bundleToJsonl(bundle) {
  if (!bundle || typeof bundle !== 'object') throw new Error('Bundle must be an object');
  const { units = [], events = [], sources = [], observations = [], links = [], adoptions = [], contextSnapshots = [], candidates = [], ...header } = bundle;
  const lines = [{ type: 'header', ...header }];
  for (const unit of units) lines.push({ type: 'unit', ...unit });
  for (const event of events) lines.push({ type: 'event', ...event });
  for (const source of sources) lines.push({ type: 'source', ...source });
  for (const observation of observations) lines.push({ type: 'observation', ...observation });
  for (const link of links) lines.push({ type: 'link', ...link });
  for (const adoption of adoptions) lines.push({ type: 'adoption', ...adoption });
  for (const candidate of candidates) lines.push({ type: 'candidate', ...candidate });
  for (const snapshot of contextSnapshots) lines.push({ type: 'contextSnapshot', ...snapshot });
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

/** 从 JSONL 还原 Bundle；坏行整包拒绝，避免部分导入造成静默缺口。 */
export function bundleFromJsonl(text) {
  const lines = String(text ?? '').split(/\r?\n/u).filter((line) => line.trim());
  const parsed = [];
  for (let index = 0; index < lines.length; index += 1) {
    try { parsed.push(JSON.parse(lines[index])); }
    catch { throw new Error(`Malformed JSONL at line ${index + 1}`); }
  }
  const headerLine = parsed.find((line) => line.type === 'header');
  if (!headerLine) throw new Error('JSONL header is required');
  const { type: _headerType, ...header } = headerLine;
  const take = (type) => parsed.filter((line) => line.type === type).map(({ type: _type, ...value }) => value);
  return {
    ...header,
    units: take('unit'),
    events: take('event'),
    sources: take('source'),
    observations: take('observation'),
    links: take('link'),
    adoptions: take('adoption'),
    candidates: take('candidate'),
    contextSnapshots: take('contextSnapshot')
  };
}

/**
 * 导入同步包。apply=false 时只做计划与校验，不写任何数据。
 * allowedProjectIds 为空表示不限制；提供时拒绝未授权项目的数据。
 */
export function importBundle({
  personalStore, provenance = null, bundle, actor = 'sync', apply = true,
  device = 'unknown', allowedProjectIds = null
} = {}) {
  const version = bundleVersion(bundle);
  const allowed = allowedProjectIds ? new Set(allowedProjectIds) : null;
  const report = {
    contract: bundle.contract, schemaVersion: version, device, applied: apply,
    imported: 0, fastForwarded: 0, merged: 0, unchanged: 0, localAhead: 0,
    diverged: 0, unrelated: 0, events: { applied: 0, duplicates: 0 },
    conflicts: [], candidates: [], errors: [], provenance: null, project: null,
    skippedScope: 0, cursor: null
  };
  if (provenance && bundle.project?.projectIdentity) {
    try {
      const registered = provenance.ensureProject({
        projectId: bundle.project.projectId,
        identity: bundle.project.projectIdentity,
        identityKind: bundle.project.identityKind ?? 'unknown',
        aliases: bundle.project.aliases ?? []
      });
      report.project = registered?.aliasOf ? `alias-of:${registered.aliasOf}` : 'registered';
    } catch (error) {
      report.project = `skipped: ${error.message}`;
    }
  }
  if (provenance && version >= 2) importEvents({ provenance, events: bundle.events, device, report });
  const importedIds = new Set();
  const unitIdMap = new Map();
  for (const unit of bundle.units ?? []) {
    try {
      validateUnit(unit, version);
    } catch (error) {
      report.errors.push({ unitId: unit?.id ?? null, error: error.message });
      continue;
    }
    if (!scopeAllowed({ allowedProjectIds: allowed, unit })) {
      report.skippedScope += 1;
      report.errors.push({ unitId: unit.id, error: 'scope-not-allowed' });
      continue;
    }
    const knowledgeId = unit.knowledgeId ?? unit.id;
    const mappedUnitId = provenance ? provenance.unitForKnowledgeId(knowledgeId) : null;
    const targetId = mappedUnitId ?? unit.id;
    unitIdMap.set(unit.id, targetId);
    const local = personalStore.get(targetId);
    if (!local) {
      if (apply) {
        personalStore.db.exec('BEGIN IMMEDIATE');
        try {
          insertUnitRaw(personalStore.db, { ...unit, id: targetId }, knowledgeId, provenance);
          personalStore.db.exec('COMMIT');
        } catch (error) {
          personalStore.db.exec('ROLLBACK');
          report.errors.push({ unitId: unit.id, error: `insert-failed: ${error.message}` });
          continue;
        }
        if (provenance) {
          provenance.appendChange({
            knowledgeId, operation: 'create', resultRevisionId: unit.revisions[unit.revisions.length - 1].revisionId ?? null,
            actorId: actor, originSystem: 'sync', originDevice: device,
            payload: { unitId: targetId, imported: true }
          });
        }
      }
      report.imported += 1;
      importedIds.add(targetId);
      continue;
    }
    if (version === 1) {
      const localRevisions = personalStore.revisions(targetId).slice().reverse();
      const classification = classifyImport(
        localRevisions.map((row) => row.payload_hash),
        unit.revisions.map((row) => row.payloadHash ?? hashOf(row.payload))
      );
      if (classification.action === 'unchanged') { report.unchanged += 1; importedIds.add(targetId); continue; }
      if (classification.action === 'local-ahead') { report.localAhead += 1; importedIds.add(targetId); continue; }
      if (classification.action === 'fast-forward') {
        const missing = unit.revisions.slice(localRevisions.length);
        if (apply) {
          try { appendRevisions({ personalStore, provenance, unit: { ...unit, id: targetId }, knowledgeId, missing, device }); }
          catch (error) { report.errors.push({ unitId: unit.id, error: `fast-forward-failed: ${error.message}` }); continue; }
        }
        report.fastForwarded += 1; importedIds.add(targetId); continue;
      }
      if (classification.action === 'diverged') {
        report.diverged += 1;
        report.conflicts.push({ unitId: targetId, fields: ['payload'], keptRevision: local.revision });
        importedIds.add(targetId);
        continue;
      }
      report.errors.push({ unitId: unit.id, error: `Unsupported action: ${classification.action}` });
      continue;
    }
    // v2：图感知分类；没有 provenance 时退回线性前缀判断。
    if (!provenance) {
      const localRevisions = personalStore.revisions(targetId).slice().reverse();
      const classification = classifyImport(
        localRevisions.map((row) => row.payload_hash),
        unit.revisions.map((row) => row.payloadHash ?? hashOf(row.payload))
      );
      if (classification.action === 'unchanged') { report.unchanged += 1; importedIds.add(targetId); continue; }
      if (classification.action === 'local-ahead') { report.localAhead += 1; importedIds.add(targetId); continue; }
      if (classification.action === 'fast-forward') {
        const missing = unit.revisions.slice(localRevisions.length);
        if (apply) {
          try { appendRevisions({ personalStore, provenance: null, unit: { ...unit, id: targetId }, knowledgeId, missing, device }); }
          catch (error) { report.errors.push({ unitId: unit.id, error: `fast-forward-failed: ${error.message}` }); continue; }
        }
        report.fastForwarded += 1; importedIds.add(targetId);
        continue;
      }
      if (classification.action === 'diverged') {
        report.diverged += 1;
        report.conflicts.push({ unitId: targetId, fields: ['payload'], keptRevision: local.revision });
        importedIds.add(targetId);
        continue;
      }
      report.errors.push({ unitId: unit.id, error: `Unsupported action: ${classification.action}` });
      continue;
    }
    const { graph, localIds } = buildGraph(provenance, unit.revisions);
    const localHeadRow = provenance.db.prepare(
      'SELECT revision_id FROM knowledge_revision_index WHERE knowledge_id=? AND local_revision=?'
    ).get(knowledgeId, local.revision);
    const incomingHead = unit.revisions[unit.revisions.length - 1];
    const classification = classifyGraph({
      localHeadId: localHeadRow?.revision_id ?? null,
      incomingRevisions: unit.revisions,
      graph,
      localRevisionIds: localIds
    });
    if (classification.action === 'unchanged') { report.unchanged += 1; importedIds.add(targetId); continue; }
    if (classification.action === 'local-ahead') { report.localAhead += 1; importedIds.add(targetId); continue; }
    if (classification.action === 'fast-forward') {
      const known = new Set(
        provenance.db.prepare('SELECT revision_id FROM knowledge_revision_index WHERE knowledge_id=?')
          .all(knowledgeId).map((row) => row.revision_id)
      );
      const missing = unit.revisions.filter((row) => !known.has(row.revisionId));
      if (apply) {
        try { appendRevisions({ personalStore, provenance, unit: { ...unit, id: targetId }, knowledgeId, missing, device }); }
        catch (error) { report.errors.push({ unitId: unit.id, error: `fast-forward-failed: ${error.message}` }); continue; }
      }
      report.fastForwarded += 1; importedIds.add(targetId);
      continue;
    }
    // diverged / unrelated：先尝试安全的元数据合并；正文/验证/采纳冲突进入审查队列。
    report.diverged += classification.action === 'diverged' ? 1 : 0;
    report.unrelated += classification.action === 'unrelated' ? 1 : 0;
    const baseRevisionId = classification.baseRevisionId ?? null;
    const baseRevision = baseRevisionId ? provenance.getRevision(baseRevisionId) : null;
    const { merged, conflicts } = mergePayloads({
      base: baseRevision?.payload ?? null,
      local,
      incoming: incomingHead.payload
    });
    if (classification.action === 'diverged' && conflicts.length === 0) {
      if (apply) {
        const parents = [localHeadRow?.revision_id, incomingHead.revisionId].filter(Boolean);
        try {
          personalStore.update(targetId, merged, {
            expectedRevision: local.revision,
            actor: 'sync-merge',
            note: `Three-way merge from ${bundle.device ?? 'unknown'}`,
            parents
          });
        } catch (error) {
          report.errors.push({ unitId: unit.id, error: `merge-rejected: ${error.message}` });
          importedIds.add(targetId);
          continue;
        }
      }
      report.merged += 1;
      importedIds.add(targetId);
      continue;
    }
    const fields = conflicts.length
      ? conflicts
      : [{ field: 'payload', base: baseRevision?.payload ?? null, local, incoming: incomingHead.payload }];
    let candidate = null;
    if (apply) {
      candidate = provenance.addCandidate({
        knowledgeId, unitId: targetId, baseRevisionId,
        revisionId: incomingHead.revisionId, payload: incomingHead.payload,
        payloadHash: incomingHead.payloadHash ?? hashOf(incomingHead.payload),
        sourceBundle: { sources: bundle.sources ?? [], observations: bundle.observations ?? [], links: (bundle.links ?? []).filter((link) => link.unitId === unit.id) },
        originDevice: bundle.device ?? device
      });
      // 远端分支的修订也进入不可变索引（local_revision=NULL），保证两条分支都可见。
      for (const revision of unit.revisions) {
        if (localIds.has(revision.revisionId)) continue;
        provenance.insertRevisionIndex({
          unitId: targetId, knowledgeId, localRevision: null,
          payload: revision.payload, payloadHash: revision.payloadHash ?? hashOf(revision.payload),
          actor: revision.actor ?? 'sync', note: revision.note ?? 'Remote branch',
          recordedAt: revision.timestamp, parentRevisionIds: revision.parentRevisionIds ?? [],
          emit: false, revisionId: revision.revisionId, status: 'candidate'
        });
      }
      for (const conflict of fields) {
        provenance.addConflict({
          unitId: targetId, field: conflict.field,
          baseValue: conflict.base, localValue: conflict.local, incomingValue: conflict.incoming,
          localRevision: local.revision, incomingRevision: incomingHead.revision,
          incomingOrigin: `${device}:${bundle.device ?? 'unknown'}`,
          candidateId: candidate?.candidateId ?? null
        });
      }
    }
    report.candidates.push({ unitId: targetId, candidateId: candidate?.candidateId ?? null, revisionId: incomingHead.revisionId });
    report.conflicts.push({ unitId: targetId, fields: fields.map((item) => item.field), keptRevision: local.revision });
    importedIds.add(targetId);
  }
  if (provenance) {
    if (apply) {
      report.provenance = importProvenance({
        provenance, bundle, unitIds: importedIds, unitIdMap, allowedProjectIds: allowed
      });
    } else {
      report.provenance = { sources: 0, observations: 0, links: 0, adoptions: 0, skipped: 'dry-run' };
    }
    if (apply && bundle.cursor?.lastChangeAppliedAt) {
      const cursor = provenance.setSyncState('last-import', bundle.cursor.lastChangeAppliedAt);
      report.cursor = cursor;
    }
  }
  return report;
}
