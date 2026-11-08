// Knowledge Maintenance & Provenance 的加法式 Schema。
//
// 只新增表与索引，不改动 personal_units / personal_revisions 的既有语义；
// 旧库打开时自动建表，无需手工迁移。所有写入都带 payload_hash，便于跨设备校验
// 与“不静默覆盖”的导入合并。
export const PROVENANCE_SCHEMA_VERSION = 1;

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
