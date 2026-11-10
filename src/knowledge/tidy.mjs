// 知识整理：只读扫描重复、需复核、冲突与未验证知识，供用户决定怎么处理。
//
// 不做自动合并/删除；所有修改仍走知识库的 HITL 流程。

const normalize = (value) => String(value ?? '')
  .toLocaleLowerCase()
  .replace(/[\s\p{P}\p{S}]+/gu, '')
  .slice(0, 600);

/** 字符二元组 Jaccard 相似度，对中英文都可用。 */
export function similarity(a, b) {
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const grams = (text) => {
    const set = new Set();
    for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
    return set;
  };
  const setA = grams(left);
  const setB = grams(right);
  if (!setA.size || !setB.size) return 0;
  let overlap = 0;
  for (const gram of setA) if (setB.has(gram)) overlap += 1;
  return overlap / (setA.size + setB.size - overlap);
}

/**
 * @param {object} input
 * @param {import('../personal-store.mjs').PersonalKnowledgeStore} input.personalStore
 * @param {string} input.projectId
 * @param {number} [input.threshold]
 * @param {number} [input.limit]
 */
export function knowledgeTidyFor({
  personalStore,
  projectId = '',
  threshold = 0.72,
  limit = 2000
} = {}) {
  if (!personalStore) throw new Error('知识库尚未初始化。');
  const units = personalStore.list({ projectId, limit });
  const duplicates = [];
  for (let i = 0; i < units.length; i += 1) {
    for (let j = i + 1; j < units.length; j += 1) {
      const a = units[i];
      const b = units[j];
      const score = similarity(`${a.title} ${a.content}`, `${b.title} ${b.content}`);
      if (score >= threshold) {
        duplicates.push({
          score: Number(score.toFixed(2)),
          a: { id: a.id, title: a.title, status: a.verificationStatus },
          b: { id: b.id, title: b.title, status: b.verificationStatus }
        });
      }
    }
  }
  duplicates.sort((a, b) => b.score - a.score);
  const stale = units
    .filter((unit) => unit.verificationStatus === 'needs_reverification')
    .slice(0, 20)
    .map((unit) => ({ id: unit.id, title: unit.title, updatedAt: unit.updatedAt }));
  const conflicts = units
    .filter((unit) => unit.verificationStatus === 'disputed'
      || Object.keys(unit.relations ?? {}).includes('contradicts'))
    .slice(0, 20)
    .map((unit) => ({ id: unit.id, title: unit.title, status: unit.verificationStatus }));
  const unverified = units
    .filter((unit) => unit.verificationStatus === 'unverified')
    .slice(0, 20)
    .map((unit) => ({ id: unit.id, title: unit.title, updatedAt: unit.updatedAt }));
  return {
    projectId,
    threshold,
    counts: {
      total: units.length,
      duplicates: duplicates.length,
      stale: stale.length,
      conflicts: conflicts.length,
      unverified: unverified.length
    },
    duplicates: duplicates.slice(0, 10),
    stale,
    conflicts,
    unverified
  };
}
