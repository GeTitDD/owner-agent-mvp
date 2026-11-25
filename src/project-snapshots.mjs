// 项目库快照存储（#89）：草稿一份可覆盖，发布按项目分配 v1..vN，发布后不可修改。
//
// 与「库是视图」一致（ADR-0009）：快照不是第四份事实存储，而是把某一刻的聚合视图
// 按 JSON 固化成一份只读副本；内容只含结论与证据引用，不存 HTML、图片或任何二进制。
//
// 两张表分工：
// - project_snapshot_drafts：每个项目一行，重复生成走 UPSERT 覆盖，没有版本号；
// - project_snapshot_versions：每个项目每个版本一行，只插入不更新——UPDATE 由触发器
//   直接 ABORT，任何绕过本类的写法也会失败，不依赖调用方自觉。
// 版本号在发布事务里按 MAX(version)+1 分配，所以同一项目单调递增，不同项目各自从 v1 开始。
//
// 本张票不做删除项目；删除连坐（ADR-0009）留给删除项目那张票，这里不提供删版本的公开方法，
// 也保证保存草稿、发布新版本都不会动到已有版本。

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { defaultDbPath } from './storage.mjs';
import { sha256 } from './utils.mjs';

/** 快照 JSON 的形状版本：以后改结构时读旧快照仍能按它判断。 */
export const SNAPSHOT_FORMAT = 'project-snapshot/v1';
/** 修改已发布版本时的错误码：调用方据此区分「不可变」与其他校验失败。 */
export const SNAPSHOT_IMMUTABLE_CODE = 'snapshot_immutable';

const PROJECT_ID_MAX = 90;
const NOTE_MAX = 500;
const CONTENT_MAX = 2 * 1024 * 1024;
const MAX_DEPTH = 12;
const MAX_ARRAY = 5000;
const DEFAULT_VERSION_LIMIT = 50;

const stamp = () => new Date().toISOString();
const asArray = (value) => (Array.isArray(value) ? value : []);
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export class SnapshotError extends Error {
  constructor(message, status = 400, code = 'snapshot_invalid') {
    super(message);
    this.name = 'SnapshotError';
    this.status = status;
    this.code = code;
  }
}

const fail = (message, status = 400, code = 'snapshot_invalid') => {
  throw new SnapshotError(message, status, code);
};

const projectIdOf = (value) => {
  const id = String(value ?? '').trim();
  if (!id || id.length > PROJECT_ID_MAX || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
    fail('Invalid project id');
  }
  return id;
};

const noteOf = (value) => {
  const note = String(value ?? '');
  if (note.length > NOTE_MAX) fail(`快照说明最多 ${NOTE_MAX} 字`);
  return note;
};

/**
 * 只接受可 JSON 化的纯数据：拒绝 Buffer、TypedArray、函数、undefined 与循环引用。
 * 这一层保证快照里不会混进二进制；超长/过深的数据也会在这里被挡下。
 */
const assertJsonOnly = (value, depth = 0, pathLabel = 'content') => {
  if (depth > MAX_DEPTH) fail(`快照内容嵌套过深：${pathLabel}`);
  if (value === null) return;
  const type = typeof value;
  if (type === 'string') {
    if (value.length > 100000) fail(`快照内容里的字符串过长：${pathLabel}`);
    return;
  }
  if (type === 'number') {
    if (!Number.isFinite(value)) fail(`快照内容里的数字非法：${pathLabel}`);
    return;
  }
  if (type === 'boolean') return;
  if (type !== 'object') fail(`快照内容只能是 JSON 数据：${pathLabel}`);
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) fail(`快照不存二进制：${pathLabel}`);
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) fail(`快照内容里的数组过长：${pathLabel}`);
    value.forEach((item, index) => assertJsonOnly(item, depth + 1, `${pathLabel}[${index}]`));
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(`快照内容只能包含纯对象：${pathLabel}`);
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) fail(`快照内容含 undefined：${pathLabel}.${key}`);
    assertJsonOnly(item, depth + 1, `${pathLabel}.${key}`);
  }
};

const serializedContent = (content) => {
  if (!isObject(content)) fail('快照内容必须是一个对象');
  assertJsonOnly(content);
  const body = JSON.stringify(content);
  if (body.length > CONTENT_MAX) fail('快照内容过大');
  return body;
};

const countsOf = (content) => {
  const counts = isObject(content?.counts) ? content.counts : {};
  const out = {};
  for (const [key, value] of Object.entries(counts)) {
    out[key] = Number.isFinite(value) ? value : 0;
  }
  return out;
};

const rowToDraft = (row) => (row
  ? {
      projectId: row.project_id,
      content: JSON.parse(row.content),
      contentHash: row.content_hash,
      counts: safeParse(row.counts_json, {}),
      note: row.note ?? '',
      generatedAt: row.generated_at
    }
  : null);

const rowToVersion = (row) => (row
  ? {
      projectId: row.project_id,
      version: row.version,
      content: JSON.parse(row.content),
      contentHash: row.content_hash,
      counts: safeParse(row.counts_json, {}),
      note: row.note ?? '',
      publishedAt: row.published_at
    }
  : null);

function safeParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** 证据引用只留「指向哪条记录」，正文与摘录不复制进快照。 */
const evidenceRefOf = (ref) => {
  if (typeof ref === 'string') {
    const text = ref.trim().slice(0, 300);
    return text ? { kind: 'evidence', ref: text } : null;
  }
  if (!isObject(ref)) return null;
  const text = String(ref.ref ?? ref.id ?? '').trim().slice(0, 300);
  if (!text) return null;
  return { kind: String(ref.kind ?? 'evidence').slice(0, 40), ref: text };
};

const conclusionOf = (item) => {
  const evidence = asArray(item?.evidenceRefs).map(evidenceRefOf).filter(Boolean);
  const revision = Number.isSafeInteger(item?.revision) ? item.revision : null;
  return {
    ref: {
      kind: String(item?.kind ?? 'entry'),
      id: String(item?.id ?? ''),
      ...(revision ? { revision } : {})
    },
    title: String(item?.title ?? ''),
    status: String(item?.status ?? ''),
    badge: String(item?.badge ?? ''),
    detail: String(item?.detail ?? ''),
    at: item?.at ?? null,
    // 分节只在快照构建时用；写进内容前会被剥掉。
    section: item?.section === 'verified' ? 'verified' : 'observing',
    evidence
  };
};

/** 快照内的顺序必须稳定：时间倒序，时间相同按 ref.id 兜底（与视图模型同一规则）。 */
const newestFirst = (a, b) =>
  String(b.at ?? '').localeCompare(String(a.at ?? '')) || String(a.ref.id).localeCompare(String(b.ref.id));

/**
 * 把项目库视图固化成快照内容（纯函数）。
 *
 * 用 groups 而不是 sections 取条目：sections 是面板的渲染窗口，items 受 limit 截断；
 * groups 里的条目是全量，快照不能因为面板一屏只显示几条就少存。每条目自带的 section
 * 字段已经由 projectLibraryView 判好，这里只做一次 partition，不再重新决定归属。
 */
export function snapshotContentOf(view, { generatedAt = stamp(), note = '' } = {}) {
  const entries = asArray(view?.groups)
    .flatMap((group) => asArray(group?.items))
    .map(conclusionOf);
  const verified = entries.filter((entry) => entry.section !== 'observing').sort(newestFirst);
  const observing = entries.filter((entry) => entry.section === 'observing').sort(newestFirst);
  // section 字段只用于分节，不重复写进条目：条目本身不记录「当时在哪一节」以外的状态。
  const strip = ({ section: _section, ...entry }) => entry;
  const counts = {
    ...countsOf(view?.counts),
    verified: verified.length,
    observing: observing.length,
    total: entries.length
  };
  const profile = view?.assets?.profile;
  const diagrams = asArray(view?.assets?.diagrams).map((diagram) => ({
    kind: String(diagram?.kind ?? ''),
    label: String(diagram?.label ?? ''),
    available: diagram?.available === true,
    title: String(diagram?.title ?? ''),
    summary: String(diagram?.summary ?? ''),
    basedOnCommit: diagram?.basedOnCommit ?? null,
    generatedAt: diagram?.generatedAt ?? null,
    stale: diagram?.stale === true
  }));
  const content = {
    format: SNAPSHOT_FORMAT,
    project: {
      id: String(view?.project?.id ?? ''),
      name: String(view?.project?.name ?? ''),
      domains: asArray(view?.project?.domains).map(String)
    },
    generatedAt,
    note: noteOf(note),
    counts,
    sections: [
      {
        key: 'verified',
        label: '已验证',
        count: verified.length,
        items: verified.map(strip)
      },
      {
        key: 'observing',
        label: '观察中',
        count: observing.length,
        items: observing.map(strip)
      }
    ],
    assets: {
      profile: profile
        ? {
            available: profile.available === true,
            title: String(profile.title ?? ''),
            oneLiner: String(profile.oneLiner ?? ''),
            basedOnCommit: profile.basedOnCommit ?? null,
            generatedAt: profile.generatedAt ?? null,
            stale: profile.stale === true
          }
        : { available: false },
      diagrams,
      missingDiagrams: asArray(view?.assets?.missingDiagrams).map(String)
    },
    empty: view?.empty ? { kind: String(view.empty.kind ?? ''), title: String(view.empty.title ?? '') } : null
  };
  // 先按存储同样的规则校验一次：坏的快照不允许进库。
  serializedContent(content);
  return content;
}

/**
 * 草稿与版本给面板看的摘要（纯函数）。版本按从新到旧，nextVersion 永远按项目递增。
 * draft 的 content 不在这里返回——摘要只用计数与时间，打开版本详情是下一张票。
 */
export function snapshotStateOf({ draft = null, versions = [] } = {}) {
  const list = asArray(versions)
    .filter((item) => Number.isSafeInteger(item?.version) && item.version > 0)
    .sort((a, b) => b.version - a.version);
  const latest = list[0] ?? null;
  const nextVersion = (latest?.version ?? 0) + 1;
  return {
    hasDraft: Boolean(draft),
    draft: draft
      ? {
          generatedAt: draft.generatedAt ?? null,
          counts: countsOf(draft.content ?? { counts: draft.counts }),
          note: draft.note ?? ''
        }
      : null,
    versions: list.map((item) => ({
      version: item.version,
      label: `v${item.version}`,
      publishedAt: item.publishedAt ?? null,
      note: item.note ?? '',
      contentHash: item.contentHash ?? '',
      counts: countsOf(item.content ?? { counts: item.counts })
    })),
    latestVersion: latest?.version ?? 0,
    nextVersion,
    nextLabel: `v${nextVersion}`
  };
}

export class ProjectSnapshotStore {
  /**
   * @param {string|{db: import('node:sqlite').DatabaseSync}} source 临时库路径（测试），
   *   或 `{ db }` 复用 owner store 已有连接（桌面主进程）。
   */
  constructor(source = defaultDbPath()) {
    const shared = isObject(source);
    this.db = shared ? source.db : new DatabaseSync(source);
    this.ownsDb = !shared;
    if (!shared && source !== ':memory:') {
      mkdirSync(path.dirname(source), { recursive: true, mode: 0o700 });
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_snapshot_drafts(
        project_id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        counts_json TEXT NOT NULL DEFAULT '{}',
        note TEXT NOT NULL DEFAULT '',
        generated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_snapshot_versions(
        project_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version > 0),
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        counts_json TEXT NOT NULL DEFAULT '{}',
        note TEXT NOT NULL DEFAULT '',
        published_at TEXT NOT NULL,
        PRIMARY KEY(project_id, version)
      );
      CREATE INDEX IF NOT EXISTS project_snapshot_versions_project
        ON project_snapshot_versions(project_id, version DESC);
    `);
    // 与 owner-store 相同的补列方式：只加缺的列，已有列不动，老库可重复升级。
    const existing = new Set(
      this.db.prepare('PRAGMA table_info(project_snapshot_versions)').all().map((column) => column.name)
    );
    for (const [name, ddl] of [
      ['counts_json', `TEXT NOT NULL DEFAULT '{}'`],
      ['note', `TEXT NOT NULL DEFAULT ''`]
    ]) {
      if (!existing.has(name)) {
        this.db.exec(`ALTER TABLE project_snapshot_versions ADD COLUMN ${name} ${ddl}`);
      }
    }
    // 不可变的最后一道闸：即使以后有人直接写 SQL，UPDATE 也会被 SQLite 拒绝。
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS project_snapshot_versions_immutable
      BEFORE UPDATE ON project_snapshot_versions
      BEGIN
        SELECT RAISE(ABORT, 'published snapshot is immutable');
      END;
    `);
  }

  close() {
    if (this.ownsDb) this.db.close();
  }

  /** 生成/覆盖草稿：每个项目只有一行，没有版本号。 */
  saveDraft({ projectId, content, note = '', now = stamp() } = {}) {
    const id = projectIdOf(projectId);
    const body = serializedContent(content);
    const counts = countsOf(content);
    const noteText = noteOf(note);
    this.db.prepare(`
      INSERT INTO project_snapshot_drafts(project_id, content, content_hash, counts_json, note, generated_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET
        content=excluded.content, content_hash=excluded.content_hash, counts_json=excluded.counts_json,
        note=excluded.note, generated_at=excluded.generated_at
    `).run(id, body, sha256(body), JSON.stringify(counts), noteText, String(now));
    return this.getDraft(id);
  }

  getDraft(projectId) {
    const id = projectIdOf(projectId);
    return rowToDraft(this.db.prepare('SELECT * FROM project_snapshot_drafts WHERE project_id=?').get(id));
  }

  /** 面板摘要用的草稿元数据：不解析正文，轮询时不整份 JSON.parse。 */
  getDraftState(projectId) {
    const id = projectIdOf(projectId);
    const row = this.db.prepare('SELECT * FROM project_snapshot_drafts WHERE project_id=?').get(id);
    return row
      ? {
          projectId: row.project_id,
          contentHash: row.content_hash,
          counts: safeParse(row.counts_json, {}),
          note: row.note ?? '',
          generatedAt: row.generated_at
        }
      : null;
  }

  /**
   * 发布：把当前草稿固化成新版本。内容按草稿那一刻的 JSON 原样写入，之后再改知识
   * 或重新生成草稿都不会影响它。没有草稿时明确失败，不偷偷现拍一份。
   */
  publish({ projectId, note = '', now = stamp() } = {}) {
    const id = projectIdOf(projectId);
    const draft = this.getDraft(id);
    if (!draft) fail('还没有草稿；先生成草稿再发布', 409, 'snapshot_no_draft');
    const noteText = noteOf(note) || draft.note || '';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const latest = this.db.prepare(
        'SELECT COALESCE(MAX(version), 0) AS version FROM project_snapshot_versions WHERE project_id=?'
      ).get(id);
      const version = Number(latest?.version ?? 0) + 1;
      this.db.prepare(`
        INSERT INTO project_snapshot_versions(
          project_id, version, content, content_hash, counts_json, note, published_at
        ) VALUES(?,?,?,?,?,?,?)
      `).run(id, version, JSON.stringify(draft.content), draft.contentHash,
        JSON.stringify(draft.counts), noteText, String(now));
      this.db.exec('COMMIT');
      return this.getVersion(id, version);
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    }
  }

  getVersion(projectId, version) {
    const id = projectIdOf(projectId);
    if (!Number.isSafeInteger(version) || version < 1) fail('Invalid snapshot version');
    return rowToVersion(this.db.prepare(
      'SELECT * FROM project_snapshot_versions WHERE project_id=? AND version=?'
    ).get(id, version));
  }

  /** 版本列表按从新到旧；不返回正文，版本详情留给下一张票。 */
  listVersions(projectId, { limit = DEFAULT_VERSION_LIMIT } = {}) {
    const id = projectIdOf(projectId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('Invalid version limit');
    return this.db.prepare(`
      SELECT * FROM project_snapshot_versions WHERE project_id=? ORDER BY version DESC LIMIT ?
    `).all(id, limit).map((row) => ({
      projectId: row.project_id,
      version: row.version,
      contentHash: row.content_hash,
      counts: safeParse(row.counts_json, {}),
      note: row.note ?? '',
      publishedAt: row.published_at
    }));
  }

  /**
   * 修改已发布的版本必须明确失败：不提供任何更新入口，调用这个也只会拿到不可变错误。
   * 表上另有 BEFORE UPDATE 触发器兜底。
   */
  amendPublished({ projectId, version } = {}) {
    projectIdOf(projectId);
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) fail('Invalid snapshot version');
    fail('已发布的快照不可修改：要改内容请发布新版本', 409, SNAPSHOT_IMMUTABLE_CODE);
  }
}
