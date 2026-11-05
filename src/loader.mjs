import path from 'node:path';
import { access, readFile, realpath } from 'node:fs/promises';
import { canonical, readJson, requireId, sha256, within } from './utils.mjs';
import { validateProjectProfile, validateKnowledgeApplicability } from './applicability.mjs';
import { applyWorkspaceOverlay } from './workspace-overlay.mjs';

const CONFIG_NAME = 'domain-context.json';
const LAYERS = new Set(['domain', 'applied', 'project']);

export async function discoverConfig(cwd) {
  let dir = path.resolve(cwd);
  while (true) {
    const candidate = path.join(dir, CONFIG_NAME);
    try { await access(candidate); return candidate; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function normalizeRecord(rec, { domain, version, key, project = false }) {
  requireId(rec.id, 'knowledge id');
  if (typeof rec.title !== 'string' || typeof rec.claim !== 'string' || !Array.isArray(rec.keywords) || rec.keywords.some((x) => typeof x !== 'string')) throw new Error(`Invalid knowledge entry: ${rec.id}`);
  const layer = rec.layer ?? (project ? 'project' : rec.kind === 'invariant' ? 'domain' : 'applied');
  if (!LAYERS.has(layer) || project && layer !== 'project' || !project && layer === 'project') throw new Error(`Invalid layer for ${rec.id}`);
  validateKnowledgeApplicability(rec);
  const relations = rec.relations ?? {};
  if (relations === null || typeof relations !== 'object' || Array.isArray(relations)) throw new Error(`Invalid relations for ${rec.id}`);
  for (const [kind, values] of Object.entries(relations)) {
    if (!['depends_on', 'specializes', 'implements', 'validated_by', 'contradicts', 'related_to'].includes(kind) || !Array.isArray(values) || values.some((x) => typeof x !== 'string' || x.length > 200)) throw new Error(`Invalid relation for ${rec.id}`);
  }
  const verificationStatus = rec.verification?.status ?? 'unverified';
  if (!['verified', 'unverified', 'needs_reverification', 'disputed'].includes(verificationStatus)) throw new Error(`Invalid verification status for ${rec.id}`);
  return { ...rec, layer, relations, verificationStatus, domain, version, key, contentHash: sha256(canonical(rec)) };
}

export async function loadSnapshot(cwd, { workspaceDbPath } = {}) {
  const configPath = await discoverConfig(cwd);
  if (!configPath) return null;
  const projectRoot = path.dirname(configPath);
  const config = await readJson(configPath);
  const validated = validateProjectProfile(config.project);
  if (!Array.isArray(config.domains) || config.domains.length < 1) throw new Error('Project needs at least one domain');
  const domainRoot = await realpath(path.resolve(projectRoot, config.domainRoot || './domains'));
  const maxTokens = config.context?.maxTokens ?? 2000;
  const captureMode = config.evolution?.capture ?? 'off';
  if (!['off', 'metadata'].includes(captureMode)) throw new Error('Invalid evolution.capture setting');
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 100 || maxTokens > 500000) throw new Error('Invalid maxTokens');

  const packages = new Map();
  const visiting = [];
  async function visit(request) {
    const id = requireId(request.id, 'domain id');
    const version = requireId(request.version, 'domain version');
    const profile = request.profile ?? 'all';
    requireId(profile, 'knowledge profile');
    if (visiting.includes(id)) throw new Error(`Circular domain dependency: ${[...visiting, id].join(' -> ')}`);
    let pkg = packages.get(id);
    if (pkg && pkg.version !== version) throw new Error(`Incompatible domain versions for ${id}: ${pkg.version} vs ${version}`);
    if (!pkg) {
      const base = await realpath(path.join(domainRoot, id, version));
      if (!base.startsWith(domainRoot + path.sep)) throw new Error(`Domain escapes configured root: ${id}`);
      const manifest = await readJson(await within(base, 'manifest.json'));
      if (manifest.id !== id || manifest.version !== version) throw new Error(`Domain manifest mismatch: ${id}@${version}`);
      if (!Array.isArray(manifest.knowledgeFiles) || !Array.isArray(manifest.stableKnowledgeIds)) throw new Error('Invalid manifest knowledge lists');
      if (new Set(manifest.stableKnowledgeIds).size !== manifest.stableKnowledgeIds.length) throw new Error('Duplicate stableKnowledgeIds');
      const records = [];
      const ids = new Set();
      for (const file of manifest.knowledgeFiles) {
        const entry = await readJson(await within(base, file));
        requireId(entry.id, 'knowledge id');
        if (ids.has(entry.id)) throw new Error(`Duplicate knowledge ID in package: ${id}/${entry.id}`);
        ids.add(entry.id);
        if (entry.status !== 'published' || entry.sharing !== 'shared') continue;
        records.push(normalizeRecord(entry, { domain: id, version, key: `${id}@${version}:${entry.id}` }));
      }
      const presentIds = new Set(records.map((x) => x.id));
      for (const stableId of manifest.stableKnowledgeIds) {
        if (!presentIds.has(stableId)) throw new Error(`Missing published stable knowledge: ${stableId}`);
      }
      const skills = [], skillHashes = [];
      for (const relative of (manifest.skillDirs ?? [])) {
        const absolute = await within(base, relative);
        skills.push(absolute);
        skillHashes.push({ relative, hash: sha256(await readFile(await within(base, `${relative}/SKILL.md`))) });
      }
      const manifestHash = sha256(canonical(manifest));
      const domainHash = sha256(canonical({ manifestHash, records: records.map(({ key, contentHash }) => ({ key, contentHash })), skillHashes }));
      pkg = { id, version, manifest, records, skills, manifestHash, domainHash, presentIds, selectedIds: new Set(), stableIds: new Set(), profiles: new Set() };
      packages.set(id, pkg);
    }
    if (pkg.profiles.has(profile)) return;
    pkg.profiles.add(profile);
    visiting.push(id);
    try {
      let selected, stable;
      if (profile === 'all') {
        selected = pkg.records.map((x) => x.id);
        stable = pkg.manifest.stableKnowledgeIds;
      } else {
        const p = pkg.manifest.profiles?.[profile];
        if (!p || !Array.isArray(p.knowledgeIds)) throw new Error(`Unknown knowledge profile ${profile} for ${id}@${version}`);
        selected = p.knowledgeIds;
        stable = p.stableKnowledgeIds ?? [];
        for (const dep of p.dependencies ?? []) await visit(dep);
      }
      for (const name of selected) {
        if (!pkg.presentIds.has(name)) throw new Error(`Profile ${profile} references missing published knowledge: ${id}:${name}`);
        pkg.selectedIds.add(name);
      }
      for (const name of stable) {
        if (!pkg.selectedIds.has(name)) throw new Error(`Stable knowledge outside selected profile: ${id}:${name}`);
        pkg.stableIds.add(name);
      }
      for (const dep of pkg.manifest.dependencies ?? []) await visit(dep);
    } finally { visiting.pop(); }
  }
  for (const request of config.domains) await visit(request);
  const domainItems = [...packages.values()].sort((a, b) => a.id.localeCompare(b.id)).map((pkg) => ({
    id: pkg.id, version: pkg.version, stableIds: [...pkg.stableIds].sort(),
    profiles: [...pkg.profiles].sort(), skills: pkg.skills, manifestHash: pkg.manifestHash, domainHash: pkg.domainHash
  }));
  const records = [...packages.values()].flatMap((pkg) => pkg.records.filter((r) => pkg.selectedIds.has(r.id)));
  records.sort((a, b) => a.key.localeCompare(b.key));
  // Stable blocks are intentionally environment-independent; otherwise cross-project cache reuse could apply unsafe rules.
  const stableSet = new Set(domainItems.flatMap((d) => d.stableIds.map((name) => `${d.id}@${d.version}:${name}`)));
  for (const record of records.filter((r) => stableSet.has(r.key))) {
    if (record.applicability && !Array.isArray(record.applicability) && (record.applicability.requires?.length || record.applicability.excludes?.length)) {
      throw new Error(`Conditional knowledge cannot be stable: ${record.key}`);
    }
  }
  const projectRecords = [];
  if (config.projectKnowledgeFiles !== undefined && !Array.isArray(config.projectKnowledgeFiles)) throw new Error('Invalid projectKnowledgeFiles');
  const seenProjectIds = new Set();
  for (const relative of config.projectKnowledgeFiles ?? []) {
    const rec = await readJson(await within(projectRoot, relative));
    if (rec.status !== 'published') continue;
    if (rec.sharing && rec.sharing !== 'project') throw new Error(`Project knowledge cannot be shared automatically: ${relative}`);
    requireId(rec.id, 'project knowledge id');
    if (seenProjectIds.has(rec.id)) throw new Error(`Duplicate project knowledge id: ${rec.id}`);
    seenProjectIds.add(rec.id);
    projectRecords.push(normalizeRecord(rec, { domain: validated.id, version: 'local', key: `project:${validated.id}:${rec.id}`, project: true }));
  }
  projectRecords.sort((a, b) => a.key.localeCompare(b.key));
  const snapshotId = sha256(canonical({
    domains: domainItems.map(({ id, version, stableIds, profiles, manifestHash, domainHash }) => ({ id, version, stableIds, profiles, manifestHash, domainHash })),
    records: records.map(({ key, contentHash }) => ({ key, contentHash }))
  }));
  const profileData = { ...validated, root: projectRoot, maxTokens, captureMode };
  const projectSnapshotId = sha256(canonical({ snapshotId, profile: { ...validated, maxTokens, captureMode }, projectRecords: projectRecords.map((r) => ({ key: r.key, hash: r.contentHash })) }));
  return applyWorkspaceOverlay({
    id: snapshotId, projectSnapshotId, profile: profileData, domainRoot, domainItems,
    records, projectRecords, skillPaths: [...new Set(domainItems.flatMap((d) => d.skills))].sort(), configPath
  }, { config: config.workspace, dbPath: workspaceDbPath });
}
