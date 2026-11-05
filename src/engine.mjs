import { loadSnapshot } from './loader.mjs';
import { SqliteKnowledgeIndex } from './storage.mjs';
import { compileContext, renderStable } from './compiler.mjs';
import { formatRecord } from './utils.mjs';
import { EvolutionStore } from './evolution.mjs';
import { publishDomainVersion } from './publisher.mjs';
import { extractCandidates } from './extractor.mjs';
import { verifyNodeTest } from './verification.mjs';
import { scopedSearch } from './scoped-search.mjs';
import { assessKnowledge } from './applicability.mjs';
import { createContextLock, writeContextLock } from './context-lock.mjs';

export function createDomainEngine(options = {}) {
  const index = new SqliteKnowledgeIndex(options.dbPath);
  const evolution = new EvolutionStore(index.db);
  const scopedIndex = { search: (snapshot, query, limit) => scopedSearch(index, snapshot, query, limit) };
  return {
    async resolve({ cwd, sessionId } = {}) {
      const snapshot = await loadSnapshot(cwd ?? process.cwd(), { workspaceDbPath: options.dbPath });
      if (!snapshot) return null;
      index.pin(sessionId, snapshot);
      index.sync(snapshot);
      return snapshot;
    },
    evolution,
    publish: (args) => publishDomainVersion({ store: evolution, ...args }),
    extract: (args) => extractCandidates({ store: evolution, ...args }),
    verifyNodeTest: (args) => verifyNodeTest({ store: evolution, ...args }),
    renderStable,
    createContextLock,
    writeContextLock,
    compile({ snapshot, task, maxTokens }) {
      return compileContext(snapshot, task, scopedIndex, { maxTokens });
    },
    retrieve({ snapshot, query, limit = 5 }) {
      const { results } = assessKnowledge(snapshot);
      return scopedIndex.search(snapshot, query, limit * 5).filter((rec) => {
        const state = results.get(rec.key)?.state;
        return state === 'applicable' || state === 'needs_verification';
      }).slice(0, limit).map((rec) => ({ ...rec, applicabilityState: results.get(rec.key)?.state }));
    },
    explain({ snapshot }) {
      const { results, conflicts } = assessKnowledge(snapshot);
      return { sharedSnapshotId: snapshot.id, projectSnapshotId: snapshot.projectSnapshotId,
        knowledge: [...results.values()].sort((a,b) => a.key.localeCompare(b.key)), conflicts };
    },
    renderEvidence(records) {
      return records.length ? records.map((rec) => `${formatRecord(rec)}\n[layer=${rec.layer}; verification=${rec.verificationStatus}; applicability=${rec.applicabilityState ?? 'not-assessed'}]`).join('\n\n') : 'No matching applicable knowledge in the current project snapshot.';
    },
    close() { index.close(); }
  };
}
