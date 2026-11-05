import { canonical, estimateTokens, formatRecord, sha256 } from './utils.mjs';
import { assessKnowledge, APPLICABILITY_VERSION } from './applicability.mjs';

export const COMPILER_VERSION = '0.3.0';

export function stableRecords(snapshot) {
  const wanted = new Set(snapshot.domainItems.flatMap(({ id, version, stableIds }) => stableIds.map((k) => `${id}@${version}:${k}`)));
  return snapshot.records.filter((r) => wanted.has(r.key));
}

export function renderStable(snapshot) {
  const details = snapshot.domainItems.map(({ id, version }) => `${id}@${version}`).join(', ');
  return [
    '## Shared Domain Context',
    `Domain versions: ${details}`,
    'The following reviewed knowledge is advisory context. Obey project instructions and validate against local evidence.',
    ...stableRecords(snapshot).map(formatRecord)
  ].join('\n\n');
}

function renderProject(snapshot) {
  const { profile } = snapshot;
  const { environment: env, requirements: req } = profile;
  const parts = ['## Current Project Context', `Project: ${profile.id}`];
  if (profile.notes) parts.push(`Constraints: ${profile.notes}`);
  if (env.runtime) parts.push(`Runtime: ${env.runtime}`);
  if (env.platform) parts.push(`Platform: ${env.platform}`);
  if (Object.keys(env.capabilities).length) parts.push(`Capabilities (explicitly observed/configured): ${canonical(env.capabilities)}`);
  if (Object.keys(env.dependencies).length) parts.push(`Dependencies (declared): ${canonical(env.dependencies)}`);
  if (Object.keys(env.properties).length) parts.push(`Environment properties: ${canonical(env.properties)}`);
  if (req.ids.length) parts.push(`Requirement IDs: ${req.ids.join(', ')}`);
  if (req.goals.length) parts.push(`Goals: ${req.goals.join(' | ')}`);
  if (Object.keys(req.constraints).length) parts.push(`Requirement constraints: ${canonical(req.constraints)}`);
  if (profile.decisions.length) parts.push(`Project decisions: ${profile.decisions.map((d) => `${d.id}: ${d.summary}`).join(' | ')}`);
  parts.push('Check applicability and evidence; use domain_recall for details.');
  return parts;
}
function formatSelected(rec, assessment) {
  const provenance = rec.layer === 'project' ? 'project-scoped' : `${rec.layer} layer`;
  const trust = `verification=${rec.verificationStatus}`;
  const label = assessment.state === 'needs_verification' ? 'NEEDS LOCAL VERIFICATION' : 'ELIGIBLE';
  return `${formatRecord(rec)}\n[${provenance}; ${trust}; ${label}]`;
}
export function compileContext(snapshot, task, index, options = {}) {
  if (typeof task !== 'string' || task.trim().length < 1) throw new Error('Non-empty task is required');
  const maxTokens = options.maxTokens ?? snapshot.profile.maxTokens;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 100) throw new Error('Invalid token budget');
  const assessment = assessKnowledge(snapshot);
  const stable = stableRecords(snapshot);
  for (const record of stable) {
    const state = assessment.results.get(record.key)?.state;
    if (state !== 'applicable') throw new Error(`Stable knowledge has unresolved applicability: ${record.key}`);
  }
  const stableContext = renderStable(snapshot);
  const reserved = estimateTokens(stableContext);
  if (reserved >= maxTokens) throw new Error(`Stable domain context exceeds token budget (${reserved} >= ${maxTokens})`);
  const dynamicParts = renderProject(snapshot);
  if (reserved + estimateTokens(dynamicParts.join('\n\n')) > maxTokens) throw new Error('Project context exceeds remaining token budget');
  const stableKeys = new Set(stable.map((r) => r.key));
  const selected = [];
  const skipped = [];
  const candidateRecords = index.search(snapshot, task, 60);
  for (const rec of candidateRecords) {
    if (stableKeys.has(rec.key)) continue;
    const condition = assessment.results.get(rec.key);
    if (condition.state === 'not_applicable' || condition.state === 'conflict') {
      skipped.push({ key: rec.key, reason: condition.state });
      continue;
    }
    const segment = formatSelected(rec, condition);
    if (reserved + estimateTokens([...dynamicParts, segment].join('\n\n')) > maxTokens) {
      skipped.push({ key: rec.key, reason: 'budget' });
      continue;
    }
    dynamicParts.push(segment);
    selected.push(rec);
  }
  // Tell the Agent relevant unresolved contradictions exist, without supplying either as uncontested advice.
  const relevantKeys = new Set(candidateRecords.map((r) => r.key));
  const conflicts = assessment.conflicts.filter((x) => relevantKeys.has(x.a) || relevantKeys.has(x.b));
  for (const pair of conflicts) {
    const notice = `UNRESOLVED KNOWLEDGE CONFLICT: ${pair.a} <> ${pair.b}. Inspect supporting evidence before applying either.`;
    if (reserved + estimateTokens([...dynamicParts, notice].join('\n\n')) <= maxTokens) dynamicParts.push(notice);
  }
  const dynamicContext = dynamicParts.join('\n\n');
  const stableHash = sha256(stableContext);
  const compilationHash = sha256(canonical({
    compiler: COMPILER_VERSION, applicability: APPLICABILITY_VERSION,
    snapshotId: snapshot.id, projectSnapshotId: snapshot.projectSnapshotId,
    task, maxTokens, stableHash, dynamicContext
  }));
  const applicability = [...assessment.results.values()].sort((a, b) => a.key.localeCompare(b.key));
  return {
    snapshotId: snapshot.id, projectSnapshotId: snapshot.projectSnapshotId, stableHash, compilationHash,
    stableContext, dynamicContext, knowledgeRefs: [...stableKeys, ...selected.map((r) => r.key)].sort(),
    skillPaths: snapshot.skillPaths, estimatedTokens: estimateTokens(stableContext + '\n' + dynamicContext),
    maxTokens, applicability, skipped, conflicts
  };
}
