// Local project knowledge is searched in memory: never persisted to the shared FTS index.
function queryTerms(query) {
  return [...new Set((query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((s) => s.length > 1))].slice(0, 24);
}
export function rankKnowledge(record, query) {
  const terms = queryTerms(query);
  const title = record.title.toLowerCase();
  const words = record.keywords.map((x) => x.toLowerCase());
  const claim = record.claim.toLowerCase();
  return terms.reduce((score, t) => score + (title.includes(t) ? 3 : 0) + (words.some((w) => w.includes(t)) ? 4 : 0) + (claim.includes(t) ? 0.2 : 0), 0);
}
export function scopedSearch(index, snapshot, query, limit = 12) {
  if (typeof query !== 'string' || !query.trim()) return [];
  const shared = index.search(snapshot, query, 100);
  const local = (snapshot.projectRecords ?? []).filter((rec) => rankKnowledge(rec, query) > 0);
  return [...shared, ...local].sort((a, b) => rankKnowledge(b, query) - rankKnowledge(a, query) || a.key.localeCompare(b.key)).slice(0, limit);
}
