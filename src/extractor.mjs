// Provider-independent extraction port. A model may suggest candidates, but NEVER approves or publishes them.
// Send only explicitly share-consented evidence summaries, never full Pi traces, prompts or tool results.
export async function extractCandidates({ store, domainId, baseVersion, evidenceIds, extractor }) {
  if (typeof extractor !== 'function') throw new Error('An extractor callback is required');
  if (!Array.isArray(evidenceIds) || !evidenceIds.length) throw new Error('Evidence IDs are required');
  const evidence = evidenceIds.map((id) => store.getEvidence(id));
  if (evidence.some((e) => !e || e.sharing_consent !== 1 || store.getRun(e.run_id)?.status !== 'settled')) {
    throw new Error('Only share-consented evidence from settled runs can be extracted');
  }
  const sanitized = evidence.map((e) => Object.freeze({
    id: e.id, kind: e.kind, outcome: e.outcome, summary: e.summary
  }));
  const drafts = await extractor(Object.freeze({ domainId, baseVersion, evidence: Object.freeze(sanitized) }));
  if (!Array.isArray(drafts) || drafts.length > 10) throw new Error('Extractor must return at most 10 candidate drafts');
  return drafts.map((draft) => store.propose({
    ...draft,
    // The caller chooses the evidence scope, never the external model.
    domainId, baseVersion, evidenceIds
  }));
}
