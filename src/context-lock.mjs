import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonical, sha256 } from './utils.mjs';
import { assessKnowledge } from './applicability.mjs';
import { COMPILER_VERSION } from './compiler.mjs';
import { APPLICABILITY_VERSION } from './applicability.mjs';

// A content-addressed, task-independent description of knowledge available to a project.
// This manifest is not a provider KV-cache key and does not preserve the complete source files.
export function createContextLock(snapshot) {
  const { results, conflicts } = assessKnowledge(snapshot);
  const records = [...snapshot.records, ...(snapshot.projectRecords ?? [])].map((r) => ({
    key: r.key, layer: r.layer, contentHash: r.contentHash,
    verificationStatus: r.verificationStatus, applicability: results.get(r.key)?.state,
    evidenceRefs: [...(r.evidenceRefs ?? [])]
  })).sort((a,b)=>a.key.localeCompare(b.key));
  const body = {
    formatVersion: '1.0.0', compilerVersion: COMPILER_VERSION, applicabilityVersion: APPLICABILITY_VERSION,
    sharedSnapshotId: snapshot.id, projectSnapshotId: snapshot.projectSnapshotId,
    project: (({root, ...portable}) => portable)(snapshot.profile),
    imports: snapshot.domainItems.map(({id,version,profiles,domainHash,stableIds})=>({id,version,profiles,domainHash,stableIds})),
    records, conflicts
  };
  return { ...body, lockHash: sha256(canonical(body)) };
}
export async function writeContextLock(file, lock) {
  const target = path.resolve(file);
  const body = JSON.stringify(lock,null,2)+'\n';
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    await writeFile(target, body, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readFile(target,'utf8');
    if (existing !== body) throw new Error(`Lock file already exists with different contents: ${target}. Choose a new filename; existing locks are immutable.`);
  }
  return { path: target, lockHash: lock.lockHash };
}
