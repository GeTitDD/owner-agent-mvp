// Patch protocol: trusted-host validation of model-proposed file changes.
//
// The model is never trusted for paths, old content or authorization. Every proposal is
// re-derived from the isolated worktree by the host: paths are normalized and matched
// against the approved scope, the parent chain is checked for links/escapes, old/new
// hashes are computed here, and the canonical proposal hash binds all of it.
import path from 'node:path';
import fs from 'node:fs';
import { canonical, sha256 } from './utils.mjs';
import { samePath } from './project-identity.mjs';

export const PATCH_LIMITS = {
  maxFiles: 5,
  maxFileBytes: 65536,
  maxTotalBytes: 262144,
  maxPathChars: 200,
  maxAllowedPaths: 5,
  maxMaterialFiles: 20,
  maxMaterialBytes: 262144
};

// Minimal deny-list policy (documented in docs/PATCH_CODING_WORKER.md): git internals,
// Pi runtime files, the owner identity marker, env/secret/credential material and private
// keys are never patchable, even when an owner accidentally allows a broad directory.
const DENY_SEGMENTS = new Set(['.git', '.pi', '.owner-root-identity']);
const DENY_NAMES = new Set([
  '.env', '.gitattributes', '.npmrc', '.pypirc', '.netrc', '.git-credentials',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'
]);
const DENY_SUFFIX = /\.(pem|key|pfx|p12|crt|der|jks|keystore|kdbx)$/i;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export class PatchProtocolError extends Error {
  constructor(message, category = 'invalid-proposal') {
    super(message);
    this.name = 'PatchProtocolError';
    this.category = category;
  }
}

const check = (ok, message) => {
  if (!ok) throw new PatchProtocolError(message);
};

// Case-folded comparison is intentional: a path accepted on Windows must not become a
// different file on Linux (or vice versa). This is a policy decision, not OS behaviour.
export const foldPath = (value) => value.toLowerCase();

// Normalize one repo-relative path. Rejects absolute paths, traversal, Windows device
// aliases, alternate data streams and the minimum deny-list before anything touches disk.
export function normalizeRelPath(raw, { maxPathChars = PATCH_LIMITS.maxPathChars } = {}) {
  check(typeof raw === 'string', 'path must be a string');
  check(raw.length > 0 && raw.length <= maxPathChars, 'invalid path length');
  check(raw === raw.trim(), 'leading/trailing whitespace in path is not allowed');
  // Backslashes are treated as separators on every platform so a Windows-looking path
  // cannot hide a traversal or an absolute path from a POSIX host.
  const p = raw.replaceAll('\\', '/');
  check(!/[\x00-\x1f\x7f]/.test(p), 'control characters in path');
  check(!p.startsWith('/'), 'absolute paths are not allowed');
  check(!/^[a-zA-Z]:/.test(p), 'drive-letter paths are not allowed');
  check(!p.includes('//'), 'empty path segments are not allowed');
  const segments = p.split('/');
  check(segments.length > 0, 'empty path');
  for (const seg of segments) {
    check(seg !== '' && seg !== '.' && seg !== '..', 'path traversal or empty segment rejected');
    check(!seg.endsWith('.') && !seg.endsWith(' '), 'trailing dot/space path aliases are not allowed');
    check(!seg.includes(':'), 'alternate data streams are not allowed');
    check(!WINDOWS_RESERVED.test(seg), 'Windows reserved device names are not allowed');
    const lower = seg.toLowerCase();
    if (DENY_SEGMENTS.has(lower)) throw new PatchProtocolError(`denied path segment: ${lower}`);
    if (lower === '.env' || lower.startsWith('.env.')) throw new PatchProtocolError('environment files are denied');
    if (lower.includes('secret') || lower.includes('credential')) {
      throw new PatchProtocolError('secret/credential paths are denied');
    }
    if (DENY_SUFFIX.test(lower) || DENY_NAMES.has(lower)) {
      throw new PatchProtocolError('private key/credential material is denied');
    }
  }
  return { norm: segments.join('/'), lower: foldPath(segments.join('/')), segments };
}

// Allowed entries are exact files or directory prefixes. Entries themselves pass the same
// normalization/deny-list, so an owner cannot authorize `.git` or `.env` by accident.
export function normalizeAllowedEntries(rawAllowedPaths) {
  check(Array.isArray(rawAllowedPaths), 'allowedPaths must be an array');
  check(rawAllowedPaths.length >= 1 && rawAllowedPaths.length <= PATCH_LIMITS.maxAllowedPaths,
    `allowedPaths must contain 1-${PATCH_LIMITS.maxAllowedPaths} entries`);
  const out = [];
  const byLower = new Map();
  for (const raw of rawAllowedPaths) {
    check(typeof raw === 'string', 'allowed path must be a string');
    // A trailing slash explicitly denotes a directory; it is not an empty segment.
    const cleaned = raw.replaceAll('\\', '/').replace(/\/+$/, '');
    const { norm, lower } = normalizeRelPath(cleaned);
    check(norm !== '.', 'the project root cannot be an allowed path');
    const prior = byLower.get(lower);
    if (prior) {
      // Same case-folded entry with different spelling is ambiguous on Windows.
      check(prior.norm === norm, 'allowed paths contain a case-folding collision');
      continue;
    }
    byLower.set(lower, { norm, lower });
    out.push({ norm, lower });
  }
  return out;
}

// Match a normalized proposal path against the normalized allowed entries.
export function matchAllowed(normPath, allowedEntries) {
  const lower = foldPath(normPath);
  for (const entry of allowedEntries) {
    if (lower === entry.lower) return { allowed: true, exact: true, entry };
    if (lower.startsWith(entry.lower + '/')) return { allowed: true, exact: false, entry };
  }
  return { allowed: false };
}

// Re-check a stored proposal path without touching disk (used by the store/apply path).
export function matchAllowedStill(normPath, rawAllowedPaths) {
  return matchAllowed(normPath, normalizeAllowedEntries(rawAllowedPaths));
}

const isWithin = (rootReal, candidate) => {
  if (samePath(candidate, rootReal)) return true;
  const sep = path.sep;
  const a = process.platform === 'win32' ? rootReal.toLowerCase() : rootReal;
  const b = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  return b.startsWith(a.endsWith(sep) ? a : a + sep);
};

const listNames = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    throw new PatchProtocolError('cannot read parent directory in the worktree');
  }
};

// Resolve and validate a worktree root once. Symlinked roots are refused: callers must
// pass the already-contained worktree path, not a link to somewhere else.
export const worktreeRootReal = (worktreeRoot) => {
  check(typeof worktreeRoot === 'string' && worktreeRoot.length > 0, 'worktree root is required');
  let rootStat;
  try {
    rootStat = fs.lstatSync(worktreeRoot);
  } catch {
    throw new PatchProtocolError('worktree is missing');
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new PatchProtocolError('worktree root is not a real directory');
  }
  return fs.realpathSync(worktreeRoot);
};

// Require that every existing parent segment is a real directory whose on-disk spelling
// matches the proposal exactly. This blocks symlink/junction escapes and case aliases
// (Windows/APFS) without relying on the host filesystem's case sensitivity.
export const assertSafeParentChain = (rootReal, segments) => {
  let current = rootReal;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const next = path.join(current, segment);
    if (!fs.existsSync(next)) throw new PatchProtocolError('parent directory does not exist in the worktree');
    const st = fs.lstatSync(next);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new PatchProtocolError('symbolic link or non-directory in the parent path chain');
    }
    const real = fs.realpathSync(next);
    if (!samePath(real, next) || !isWithin(rootReal, real)) {
      throw new PatchProtocolError('parent path escapes or aliases the worktree');
    }
    const names = listNames(current);
    if (!names.includes(segment)) {
      const folded = names.find((name) => name.toLowerCase() === segment.toLowerCase());
      if (folded) throw new PatchProtocolError('case-alias path segment rejected');
      throw new PatchProtocolError('parent directory spelling does not match the worktree');
    }
    current = next;
  }
  return current;
};

// Check the final target and its exact spelling in the parent directory.
const inspectTarget = (parent, segment, rootReal) => {
  const full = path.join(parent, segment);
  const names = listNames(parent);
  const exact = names.includes(segment);
  const folded = exact ? null : names.find((name) => name.toLowerCase() === segment.toLowerCase());
  if (!exact && folded) throw new PatchProtocolError('case-alias path rejected');
  let stat = null;
  try {
    stat = fs.lstatSync(full);
  } catch {
    return { full, exists: false, stat: null };
  }
  if (stat.isSymbolicLink()) throw new PatchProtocolError('symbolic links cannot be patched');
  if (!stat.isFile()) throw new PatchProtocolError('target is not a regular file');
  const real = fs.realpathSync(full);
  if (!samePath(real, full) || !isWithin(rootReal, real)) {
    throw new PatchProtocolError('target escapes the worktree');
  }
  if (stat.nlink > 1) throw new PatchProtocolError('hard-linked files cannot be patched');
  return { full, exists: true, stat };
};

const readTextFile = (full, maxBytes) => {
  const buffer = fs.readFileSync(full);
  if (buffer.length > maxBytes) throw new PatchProtocolError('existing file exceeds the per-file size limit');
  if (buffer.includes(0)) throw new PatchProtocolError('binary files cannot be patched');
  return buffer.toString('utf8');
};

// Inspect one approved-material path with the SAME parent-chain/link/case rules as the
// patch validator. Unlike `inspectTarget`, directories are allowed and a missing leaf is
// reported (material for an `add` target legitimately does not exist yet). Any unsafe
// component in the parent chain throws before the caller can read through it.
export function inspectSafePath({ worktreeRoot, relPath } = {}) {
  const { norm, segments } = normalizeRelPath(relPath);
  const rootReal = worktreeRootReal(worktreeRoot);
  const parent = assertSafeParentChain(rootReal, segments);
  const segment = segments[segments.length - 1];
  const full = path.join(parent, segment);
  const names = listNames(parent);
  const exact = names.includes(segment);
  if (!exact) {
    const folded = names.find((name) => name.toLowerCase() === segment.toLowerCase());
    if (folded) throw new PatchProtocolError('case-alias material path rejected');
    return { path: norm, full, kind: 'missing', stat: null };
  }
  const stat = fs.lstatSync(full);
  if (stat.isSymbolicLink()) throw new PatchProtocolError('symbolic link material path rejected');
  const real = fs.realpathSync(full);
  if (!samePath(real, full) || !isWithin(rootReal, real)) {
    throw new PatchProtocolError('material path escapes the worktree');
  }
  if (stat.isDirectory()) return { path: norm, full, kind: 'directory', stat };
  if (!stat.isFile()) throw new PatchProtocolError('material path is not a regular file');
  if (stat.nlink > 1) throw new PatchProtocolError('hard-linked material path rejected');
  return { path: norm, full, kind: 'file', stat };
}

// Decode bounded, regular-file material as strict UTF-8. Rejects NUL/binary/oversized
// files instead of handing lossy decoded bytes to the model.
export function readSafeMaterial(inspected, { maxBytes = PATCH_LIMITS.maxFileBytes } = {}) {
  check(inspected && inspected.kind === 'file', 'material is not a regular file');
  if (inspected.stat.size > maxBytes) throw new PatchProtocolError('material file exceeds the size limit');
  const buffer = fs.readFileSync(inspected.full);
  if (buffer.length > maxBytes) throw new PatchProtocolError('material file exceeds the size limit');
  if (buffer.includes(0)) throw new PatchProtocolError('binary material is not allowed');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new PatchProtocolError('material is not valid UTF-8');
  }
  return { path: inspected.path, content: text, bytes: buffer.length };
}

export function canonicalProposalHash(files) {
  // Sorted, stable metadata only: path + action + host-computed hashes. Model text is
  // never part of the hash; any change to any file invalidates a prior approval.
  const sorted = files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256(canonical(sorted.map((f) => ({
    path: f.path,
    action: f.action,
    old_sha: f.old_sha ?? null,
    new_sha: f.new_sha
  }))));
}

// Validate the raw model output against the isolated worktree. Returns transient file
// objects including content (the caller stores content ONLY in the private artifact
// table) plus the canonical proposal hash.
export function validateProposal({
  worktreeRoot,
  allowedPaths,
  rawFiles,
  maxFiles = PATCH_LIMITS.maxFiles,
  maxFileBytes = PATCH_LIMITS.maxFileBytes,
  maxTotalBytes = PATCH_LIMITS.maxTotalBytes
} = {}) {
  const rootReal = worktreeRootReal(worktreeRoot);
  const entries = normalizeAllowedEntries(allowedPaths);
  check(Array.isArray(rawFiles), 'files must be an array');
  check(rawFiles.length >= 1 && rawFiles.length <= maxFiles, `proposal must contain 1-${maxFiles} files`);

  const out = [];
  const seen = new Set();
  let totalBytes = 0;
  for (const raw of rawFiles) {
    check(raw && typeof raw === 'object' && !Array.isArray(raw), 'each file entry must be an object');
    const { norm, segments } = normalizeRelPath(raw.path);
    const lower = foldPath(norm);
    check(!seen.has(lower), `duplicate path in proposal: ${norm}`);
    seen.add(lower);
    const match = matchAllowed(norm, entries);
    check(match.allowed, `path outside the allowed scope: ${norm}`);
    const action = raw.action;
    check(action === 'add' || action === 'modify', 'action must be add or modify');
    check(typeof raw.content === 'string', 'file content must be a string');
    check(!raw.content.includes('\u0000'), 'binary content cannot be patched');
    const bytes = Buffer.byteLength(raw.content, 'utf8');
    check(bytes <= maxFileBytes, `file exceeds the per-file size limit: ${norm}`);
    totalBytes += bytes;
    check(totalBytes <= maxTotalBytes, 'total patch exceeds the size limit');
    const parent = assertSafeParentChain(rootReal, segments);
    const target = inspectTarget(parent, segments[segments.length - 1], rootReal);
    if (action === 'add') {
      check(!target.exists, `add target already exists: ${norm}`);
    } else {
      check(target.exists, `modify target does not exist: ${norm}`);
    }
    let old_sha = null;
    if (action === 'modify') {
      const oldText = readTextFile(target.full, maxFileBytes);
      old_sha = sha256(oldText);
      check(old_sha !== sha256(raw.content), `modify produces no change: ${norm}`);
    }
    out.push({
      path: norm,
      action,
      old_sha,
      new_sha: sha256(raw.content),
      bytes,
      content: raw.content
    });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    files: out,
    proposalHash: canonicalProposalHash(out),
    totalBytes,
    entries
  };
}

// Public metadata shape stored in the proposal row (never includes file content).
export const proposalMetadata = (files) => files.map((f) => ({
  path: f.path,
  action: f.action,
  old_sha: f.old_sha ?? null,
  new_sha: f.new_sha,
  bytes: f.bytes ?? Buffer.byteLength(f.content ?? '', 'utf8')
}));

// Parse a stored artifact back into validated metadata + content. Used by apply only.
export function readProposalArtifact(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PatchProtocolError('stored proposal artifact is not valid JSON');
  }
  check(parsed && typeof parsed === 'object' && Array.isArray(parsed.files), 'stored proposal artifact is malformed');
  const files = parsed.files.map((f) => {
    check(f && typeof f === 'object', 'stored proposal file entry is malformed');
    check(typeof f.path === 'string' && typeof f.action === 'string' && typeof f.content === 'string',
      'stored proposal file entry is incomplete');
    check(typeof f.new_sha === 'string' && /^[0-9a-f]{64}$/.test(f.new_sha), 'stored new hash is invalid');
    check(f.old_sha === null || (typeof f.old_sha === 'string' && /^[0-9a-f]{64}$/.test(f.old_sha)),
      'stored old hash is invalid');
    return { path: f.path, action: f.action, old_sha: f.old_sha ?? null, new_sha: f.new_sha, content: f.content };
  });
  return { files, base_sha: typeof parsed.base_sha === 'string' ? parsed.base_sha : '', allowed_paths: parsed.allowed_paths };
}
