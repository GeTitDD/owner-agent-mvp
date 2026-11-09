// Knowledge Maintenance & Provenance 的加法式 Schema。
//
// 只新增表与索引，不改动 personal_units / personal_revisions 的既有语义；
// 旧库打开时自动建表，无需手工迁移。所有写入都带 payload_hash，便于跨设备校验
// 与“不静默覆盖”的导入合并。
export const PROVENANCE_SCHEMA_VERSION = 2;

export const PROVENANCE_DDL = `
  CREATE TABLE IF NOT EXISTS knowledge_projects (
    project_id TEXT PRIMARY KEY,
    project_identity TEXT NOT NULL,
    identity_kind TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    payload_hash TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS knowledge_projects_identity
    ON knowledge_projects(project_identity);

  CREATE TABLE IF NOT EXISTS knowledge_sources (
    source_id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    namespace TEXT NOT NULL,
    object_id TEXT NOT NULL,
    project_id TEXT,
    locator TEXT NOT NULL,
    availability TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    UNIQUE(namespace, source_type, object_id)
  );
  CREATE INDEX IF NOT EXISTS knowledge_sources_project
    ON knowledge_sources(project_id, last_seen_at DESC);

  CREATE TABLE IF NOT EXISTS knowledge_source_observations (
    observation_id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES knowledge_sources(source_id),
    source_version TEXT NOT NULL,
    content_hash TEXT NOT NULL DEFAULT '',
    locator TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    capture_run_id TEXT NOT NULL DEFAULT '',
    observed_by TEXT NOT NULL,
    availability TEXT NOT NULL,
    payload TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    UNIQUE(source_id, source_version, content_hash, capture_run_id)
  );
  CREATE INDEX IF NOT EXISTS knowledge_observations_source
    ON knowledge_source_observations(source_id, observed_at DESC);

  CREATE TABLE IF NOT EXISTS knowledge_source_links (
    unit_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    observation_id TEXT NOT NULL REFERENCES knowledge_source_observations(observation_id),
    relation TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    payload_hash TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(unit_id, revision, observation_id, relation)
  );
  CREATE INDEX IF NOT EXISTS knowledge_links_observation
    ON knowledge_source_links(observation_id);

  CREATE TABLE IF NOT EXISTS knowledge_adoptions (
    unit_id TEXT PRIMARY KEY,
    adopted_revision INTEGER NOT NULL,
    adopted_at TEXT NOT NULL,
    actor TEXT NOT NULL,
    note TEXT NOT NULL,
    payload_hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS knowledge_revalidations (
    id TEXT PRIMARY KEY,
    unit_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    source_id TEXT NOT NULL,
    from_observation_id TEXT NOT NULL DEFAULT '',
    to_observation_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    resolved_by TEXT,
    resolution_note TEXT,
    payload TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    UNIQUE(unit_id, revision, source_id, to_observation_id, reason)
  );
  CREATE INDEX IF NOT EXISTS knowledge_revalidations_status
    ON knowledge_revalidations(status, created_at DESC);

  CREATE TABLE IF NOT EXISTS knowledge_conflicts (
    id TEXT PRIMARY KEY,
    unit_id TEXT NOT NULL,
    field TEXT NOT NULL,
    base_value TEXT,
    local_value TEXT,
    incoming_value TEXT,
    local_revision INTEGER,
    incoming_revision INTEGER,
    incoming_origin TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    payload_hash TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS knowledge_conflicts_unit
    ON knowledge_conflicts(unit_id, status);

  CREATE TABLE IF NOT EXISTS knowledge_context_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    compilation_hash TEXT NOT NULL,
    task TEXT NOT NULL,
    created_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    payload_hash TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS knowledge_context_snapshots_project
    ON knowledge_context_snapshots(project_id, created_at DESC);

  -- v2：跨设备稳定的逻辑身份 ↔ 本地 unit 的映射。旧库首次打开时按 unit id 补齐。
  CREATE TABLE IF NOT EXISTS knowledge_identities (
    knowledge_id TEXT PRIMARY KEY,
    unit_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS knowledge_identities_unit ON knowledge_identities(unit_id);

  -- v2：不可变修订索引。local_revision 为 NULL 表示来自其他设备的祖先修订。
  CREATE TABLE IF NOT EXISTS knowledge_revision_index (
    revision_id TEXT PRIMARY KEY,
    knowledge_id TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    local_revision INTEGER,
    schema_version INTEGER NOT NULL,
    parent_revision_ids TEXT NOT NULL DEFAULT '[]',
    reason TEXT NOT NULL DEFAULT '',
    actor_id TEXT NOT NULL DEFAULT '',
    device_id TEXT NOT NULL DEFAULT '',
    recorded_at TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    verification_status TEXT NOT NULL DEFAULT 'unknown',
    payload TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    UNIQUE(knowledge_id, local_revision)
  );
  CREATE INDEX IF NOT EXISTS knowledge_revision_index_unit
    ON knowledge_revision_index(unit_id, local_revision);
  CREATE INDEX IF NOT EXISTS knowledge_revision_index_knowledge
    ON knowledge_revision_index(knowledge_id, recorded_at);

  -- v2：跨设备变更日志。change_id 是操作身份；重复导入不产生新修订。
  CREATE TABLE IF NOT EXISTS knowledge_changes (
    change_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    knowledge_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    base_revision_id TEXT,
    result_revision_id TEXT,
    actor_id TEXT NOT NULL DEFAULT '',
    origin_system TEXT NOT NULL DEFAULT '',
    origin_device TEXT NOT NULL DEFAULT '',
    occurred_at TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    payload TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    UNIQUE(change_id)
  );
  CREATE INDEX IF NOT EXISTS knowledge_changes_knowledge
    ON knowledge_changes(knowledge_id, occurred_at);
  CREATE INDEX IF NOT EXISTS knowledge_changes_applied
    ON knowledge_changes(applied_at);

  -- v2：分叉时保留远端分支修订（候选），不直接改本地 Head。
  CREATE TABLE IF NOT EXISTS knowledge_candidates (
    candidate_id TEXT PRIMARY KEY,
    knowledge_id TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    base_revision_id TEXT,
    revision_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    source_bundle TEXT NOT NULL DEFAULT '{}',
    origin_device TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    resolved_revision_id TEXT,
    UNIQUE(knowledge_id, revision_id)
  );
  CREATE INDEX IF NOT EXISTS knowledge_candidates_unit
    ON knowledge_candidates(unit_id, status, created_at DESC);

  -- v2：同步游标（按来源设备记录最后处理的 change/applied 时间）。
  CREATE TABLE IF NOT EXISTS knowledge_sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

/** 在既有 PersonalKnowledgeStore 连接上安装新表；幂等。 */
export function installProvenanceSchema(db) {
  db.exec(PROVENANCE_DDL);
  return PROVENANCE_SCHEMA_VERSION;
}

/** 读取表是否存在；用于导入/兼容性检查。 */
export function hasProvenanceSchema(db) {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_sources'"
  ).get();
  return Boolean(row);
}
