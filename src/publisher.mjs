import path from 'node:path';
import { mkdir, readdir, readFile, realpath, lstat, writeFile, rename, rm, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { canonical, readJson, requireId, sha256, within } from './utils.mjs';

async function exists(location) { try { await access(location); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }

async function safeCopyDirectory(from, to) {
  const stat = await lstat(from);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe skill directory: ${from}`);
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error(`Unsafe skill entry: ${entry.name}`);
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) await safeCopyDirectory(src, dest);
    else await writeFile(dest, await readFile(src), { flag: 'wx', mode: 0o600 });
  }
}

// The same digest computation used by loadSnapshot, so published source versions stay immutable.
async function hashExistingDomain(domainId, version, base, manifest) {
  const localRecords = [];
  for (const relative of manifest.knowledgeFiles) {
    const rec = await readJson(await within(base, relative));
    if (rec.status !== 'published' || rec.sharing !== 'shared') continue;
    localRecords.push({ key: `${domainId}@${version}:${rec.id}`, contentHash: sha256(canonical(rec)) });
  }
  const skillHashes = [];
  for (const relative of (manifest.skillDirs ?? [])) {
    const target = await within(base, `${relative}/SKILL.md`);
    skillHashes.push({ relative, hash: sha256(await readFile(target)) });
  }
  return sha256(canonical({ manifestHash: sha256(canonical(manifest)), records: localRecords, skillHashes }));
}

export async function publishDomainVersion({ store, domainRoot, domainId, baseVersion, newVersion, candidateIds }) {
  requireId(domainId, 'domain id');
  requireId(baseVersion, 'base version');
  requireId(newVersion, 'new version');
  if (baseVersion === newVersion) throw new Error('New version must differ from base version');
  if (!Array.isArray(candidateIds) || candidateIds.length < 1 || new Set(candidateIds).size !== candidateIds.length) throw new Error('Explicit, unique candidate IDs are required');
  const candidates = candidateIds.map((id) => store.getCandidate(id));
  for (const candidate of candidates) {
    if (!candidate || candidate.status !== 'approved') throw new Error('All candidates must be approved');
    if (candidate.domain_id !== domainId || candidate.base_version !== baseVersion) throw new Error('Candidate is for another domain or base version');
    if (candidate.review?.candidate_hash !== candidate.payload_hash) throw new Error('Candidate changed since review');
    if (!store.readiness(candidate.id).ready) throw new Error(`Candidate no longer ready: ${candidate.id}`);
  }
  const resolvedRoot = await realpath(domainRoot);
  const domainDir = path.join(resolvedRoot, domainId);
  const sourceDir = await realpath(path.join(domainDir, baseVersion));
  if (!sourceDir.startsWith(resolvedRoot + path.sep)) throw new Error('Unsafe domain root');
  const targetDir = path.join(domainDir, newVersion);
  if (await exists(targetDir)) throw new Error('Version already exists; published packages are immutable');
  const manifest = await readJson(await within(sourceDir, 'manifest.json'));
  if (manifest.id !== domainId || manifest.version !== baseVersion) throw new Error('Source manifest mismatch');
  const actualHash = await hashExistingDomain(domainId, baseVersion, sourceDir, manifest);
  const known = store.db.prepare('SELECT content_hash FROM domain_versions WHERE domain_id=? AND version=?').get(domainId, baseVersion);
  if (!known || known.content_hash !== actualHash) throw new Error('Source version is unindexed or modified; resolve original project before publishing');

  const selected = [];
  const sourceIds = new Set();
  for (const relative of manifest.knowledgeFiles) {
    const data = await readJson(await within(sourceDir, relative));
    if (data.status !== 'published' || data.sharing !== 'shared') continue;
    requireId(data.id, 'knowledge id');
    if (sourceIds.has(data.id)) throw new Error(`Duplicate existing knowledge id: ${data.id}`);
    sourceIds.add(data.id);
    selected.push({ relative, data });
  }
  const newIds = new Set();
  for (const c of candidates) {
    const id = c.payload.knowledgeId;
    if (sourceIds.has(id) || newIds.has(id)) throw new Error(`Knowledge ID already exists: ${id}`);
    newIds.add(id);
  }

  const stage = path.join(domainDir, `.${newVersion}.stage-${randomUUID()}`);
  await mkdir(stage, { recursive: false, mode: 0o700 });
  let moved = false;
  try {
    const newFiles = [];
    for (const { relative, data } of selected) {
      const file = path.join(stage, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      newFiles.push(relative);
    }
    for (const c of candidates) {
      const p = c.payload;
      const rec = {
        id: p.knowledgeId, kind: p.kind, title: p.title, claim: p.claim,
        keywords: p.keywords, applicability: p.applicability, exceptions: p.exceptions,
        status: 'published', sharing: 'shared',
        evidenceRefs: p.evidenceIds.map((id) => `evidence:${sha256(id).slice(0, 24)}`),
        review: { approvedBy: c.review.reviewer, reviewedAt: c.review.reviewed_at, candidateHash: c.payload_hash }
      };
      const relative = `knowledge/${p.knowledgeId}.json`;
      await mkdir(path.dirname(path.join(stage, relative)), { recursive: true });
      await writeFile(path.join(stage, relative), JSON.stringify(rec, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      newFiles.push(relative);
    }
    for (const relative of (manifest.skillDirs ?? [])) {
      const from = await within(sourceDir, relative);
      await safeCopyDirectory(from, path.join(stage, relative));
    }
    const nextManifest = { ...manifest, version: newVersion, knowledgeFiles: newFiles };
    await writeFile(path.join(stage, 'manifest.json'), JSON.stringify(nextManifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const packageHash = sha256(canonical({ manifest: nextManifest, records: selected.map((x) => x.data), candidates: candidates.map((c) => c.payload) }));
    if (await exists(targetDir)) throw new Error('Version already exists');
    await rename(stage, targetDir);
    moved = true;
    // Filesystem publish precedes ledger commit. If SQLite commit fails, the published directory remains
    // for explicit reconciliation; we never silently delete a possibly-consumed immutable version.
    store.markPublished(candidateIds, { domainId, version: newVersion, packageHash });
    return { path: targetDir, domainId, version: newVersion, packageHash, candidateIds, knowledgeCount: selected.length + candidates.length };
  } finally {
    if (!moved) await rm(stage, { recursive: true, force: true });
  }
}
