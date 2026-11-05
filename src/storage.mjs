import path from 'node:path';
import os from 'node:os';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export function defaultDbPath() {
  return process.env.DOMAIN_CONTEXT_DB || path.join(os.homedir(), '.domain-context', 'index.sqlite');
}

export class SqliteKnowledgeIndex {
  constructor(filename = defaultDbPath()) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS knowledge (
        key TEXT PRIMARY KEY, domain TEXT NOT NULL, version TEXT NOT NULL, id TEXT NOT NULL,
        title TEXT NOT NULL, claim TEXT NOT NULL, keywords TEXT NOT NULL,
        content_hash TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        key UNINDEXED, title, claim, keywords, tokenize='unicode61'
      );
      CREATE TABLE IF NOT EXISTS domain_versions (
        domain_id TEXT NOT NULL, version TEXT NOT NULL, content_hash TEXT NOT NULL,
        PRIMARY KEY(domain_id, version)
      );
      CREATE TABLE IF NOT EXISTS session_pins (
        session_id TEXT NOT NULL, project_id TEXT NOT NULL, project_root TEXT NOT NULL,
        snapshot_id TEXT NOT NULL, PRIMARY KEY(session_id, project_root)
      );
    `);
  }

  sync(snapshot) {
    const get = this.db.prepare('SELECT content_hash FROM knowledge WHERE key = ?');
    const domainGet = this.db.prepare('SELECT content_hash FROM domain_versions WHERE domain_id=? AND version=?');
    const domainInsert = this.db.prepare('INSERT INTO domain_versions(domain_id,version,content_hash) VALUES (?,?,?)');
    const rmFts = this.db.prepare('DELETE FROM knowledge_fts WHERE key = ?');
    const upsert = this.db.prepare(`INSERT INTO knowledge (key,domain,version,id,title,claim,keywords,content_hash)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
      title=excluded.title, claim=excluded.claim, keywords=excluded.keywords, content_hash=excluded.content_hash`);
    const addFts = this.db.prepare('INSERT INTO knowledge_fts (key,title,claim,keywords) VALUES (?,?,?,?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const d of snapshot.domainItems) {
        const prior = domainGet.get(d.id, d.version);
        if (prior && prior.content_hash !== d.domainHash) throw new Error(`Immutable domain package was modified: ${d.id}@${d.version}. Publish a new version.`);
        if (!prior) domainInsert.run(d.id, d.version, d.domainHash);
      }
      for (const rec of snapshot.records) {
        const previous = get.get(rec.key);
        if (previous?.content_hash === rec.contentHash) continue;
        if (previous) throw new Error(`Immutable domain version was modified: ${rec.key}. Publish a new version.`);
        rmFts.run(rec.key);
        upsert.run(rec.key, rec.domain, rec.version, rec.id, rec.title, rec.claim, rec.keywords.join(' '), rec.contentHash);
        addFts.run(rec.key, rec.title, rec.claim, rec.keywords.join(' '));
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  pin(sessionId, snapshot) {
    if (!sessionId) return;
    const sel = this.db.prepare('SELECT project_id,snapshot_id FROM session_pins WHERE session_id=? AND project_root=?');
    const prev = sel.get(sessionId, snapshot.profile.root);
    if (prev && (prev.project_id !== snapshot.profile.id || prev.snapshot_id !== (snapshot.projectSnapshotId ?? snapshot.id))) {
      throw new Error(`Session ${sessionId} was pinned to a different domain snapshot. Start a new session or restore immutable domain files.`);
    }
    if (!prev) this.db.prepare('INSERT INTO session_pins (session_id,project_id,project_root,snapshot_id) VALUES (?,?,?,?)')
      .run(sessionId, snapshot.profile.id, snapshot.profile.root, snapshot.projectSnapshotId ?? snapshot.id);
  }

  search(snapshot, query, limit = 12) {
    const visible = new Set(snapshot.records.map((r) => r.key));
    if (!visible.size) return [];
    const stopwords = new Set(['a','an','the','and','or','for','with','to','in','of','on','at','is','how','why','what','implement','create','make','change','add','using','some','this','that','from','into','new']);
    const terms = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((s) => s.length > 1 && !stopwords.has(s)).slice(0, 12))];
    if (!terms.length) return [];
    // FTS MATCH only uses safely quoted tokens. No arbitrary query syntax is evaluated.
    const match = terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ');
    const placeholders = [...visible].map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT knowledge.key, bm25(knowledge_fts) AS bm
      FROM knowledge_fts JOIN knowledge ON knowledge.key=knowledge_fts.key
      WHERE knowledge_fts MATCH ? AND knowledge.key IN (${placeholders})
      ORDER BY bm ASC, knowledge.key ASC LIMIT ?`)
      .all(match, ...visible, Math.max(1, Math.min(100, limit)));
    const byKey = new Map(snapshot.records.map((r) => [r.key, r]));
    // A domain term in a title or explicit keyword is required, not merely a common word in a long claim.
    const reranked = rows.map((r) => {
      const rec = byKey.get(r.key);
      if (!rec) return null;
      const title = rec.title.toLowerCase();
      const keywords = rec.keywords.map((v) => v.toLowerCase());
      const hitTerms = terms.filter((t) => title.includes(t) || keywords.some((v) => v.includes(t)));
      if (!hitTerms.length) return null;
      const weighted = hitTerms.reduce((score, t) => score + (title.includes(t) ? 3 : 0) + (keywords.some((v) => v.includes(t)) ? 4 : 0), 0);
      return { rec, weighted, bm: r.bm };
    }).filter(Boolean);
    reranked.sort((a, b) => b.weighted - a.weighted || a.bm - b.bm || a.rec.key.localeCompare(b.rec.key));
    return reranked.map(({ rec }) => rec).slice(0, limit);
  }

  close() { this.db.close(); }
}
