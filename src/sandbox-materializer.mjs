// Bounded, verifiable input snapshot materializer.
//
// Only explicitly approved files (proposal files + Owner --include exact paths) are read
// from the applied worktree. Each path reuses the v0.8 parent-chain/link/UTF-8 checks.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sha256 } from './utils.mjs';
import { inspectSafePath, normalizeRelPath, readSafeMaterial } from './patch-protocol.mjs';
import { SANDBOX_LIMITS, snapshotHash } from './sandbox-protocol.mjs';

export class SandboxMaterializerError extends Error {
  constructor(message, code = 'invalid-snapshot') {
    super(message);
    this.name = 'SandboxMaterializerError';
    this.code = code;
  }
}

const check = (ok, message, code = 'invalid-snapshot') => {
  if (!ok) throw new SandboxMaterializerError(message, code);
};

export function defaultSandboxRoot() {
  return process.env.OWNER_AGENT_SANDBOX_DIR || path.join(os.homedir(), '.owner-agent', 'sandbox');
}

const isWithin = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const chmodDirsReadOnly = (dir) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) chmodDirsReadOnly(path.join(dir, entry.name));
  }
  try {
    fs.chmodSync(dir, 0o555);
  } catch {
    // Windows host can run Fake/materializer tests; container permissions are Linux-only.
  }
};

const makeWritable = (target) => {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    try { fs.chmodSync(target, 0o755); } catch { /* best effort */ }
    for (const entry of fs.readdirSync(target)) makeWritable(path.join(target, entry));
  } else if (stat.isFile()) {
    try { fs.chmodSync(target, 0o644); } catch { /* best effort */ }
  }
};

// Create <sandboxRoot>/<runId>/{input,marker.json}. `snapshotPath` is the run root; the
// provider mounts `<snapshotPath>/input` read-only at /workspace.
export function createInputSnapshot({
  runId,
  workspacePath,
  proposal,
  includePaths = [],
  sandboxRoot = defaultSandboxRoot()
} = {}) {
  check(typeof runId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,88}$/.test(runId), 'invalid run id');
  check(typeof workspacePath === 'string' && workspacePath.length > 0, 'workspace path is required');
  const proposalFiles = Array.isArray(proposal?.files) ? proposal.files : [];
  check(proposalFiles.length > 0, 'proposal has no files');

  const requested = new Map();
  for (const file of proposalFiles) {
    const { norm, lower } = normalizeRelPath(file.path);
    requested.set(lower, { path: norm, expectedSha: file.new_sha });
  }
  for (const raw of includePaths) {
    const { norm, lower } = normalizeRelPath(raw);
    if (!requested.has(lower)) requested.set(lower, { path: norm, expectedSha: null });
  }
  check(requested.size <= SANDBOX_LIMITS.maxIncludeFiles, 'snapshot contains too many files');

  const entries = [];
  let totalBytes = 0;
  for (const { path: rel, expectedSha } of [...requested.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const inspected = inspectSafePath({ worktreeRoot: workspacePath, relPath: rel });
    check(inspected.kind === 'file', `snapshot path is not a regular file: ${rel}`);
    const material = readSafeMaterial(inspected, { maxBytes: SANDBOX_LIMITS.maxSnapshotFileBytes });
    const hash = sha256(material.content);
    if (expectedSha) check(hash === expectedSha, `snapshot content hash mismatch: ${rel}`);
    totalBytes += material.bytes;
    check(totalBytes <= SANDBOX_LIMITS.maxSnapshotTotalBytes, 'snapshot exceeds the total size limit');
    entries.push({ path: rel, content: material.content, sha256: hash, size: material.bytes });
  }

  const baseRoot = path.resolve(sandboxRoot);
  fs.mkdirSync(baseRoot, { recursive: true, mode: 0o700 });
  const runRoot = path.join(baseRoot, runId);
  check(isWithin(baseRoot, runRoot), 'snapshot path escapes the sandbox root');
  check(!fs.existsSync(runRoot), 'snapshot path already exists');
  fs.mkdirSync(runRoot, { recursive: false, mode: 0o700 });
  const inputPath = path.join(runRoot, 'input');
  try {
    fs.mkdirSync(inputPath, { mode: 0o755 });
    for (const entry of entries) {
      const target = path.join(inputPath, entry.path);
      check(isWithin(inputPath, target), 'snapshot file escapes the input root');
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
      fs.writeFileSync(target, entry.content, { encoding: 'utf8', mode: 0o444 });
      check(sha256(fs.readFileSync(target, 'utf8')) === entry.sha256, `snapshot write hash mismatch: ${entry.path}`);
    }
    const manifest = entries.map((entry) => ({ path: entry.path, sha256: entry.sha256, size: entry.size }));
    const hash = snapshotHash(manifest);
    fs.writeFileSync(path.join(runRoot, 'marker.json'), JSON.stringify({ runId, snapshotHash: hash }), {
      encoding: 'utf8',
      mode: 0o444
    });
    chmodDirsReadOnly(inputPath);
    return { snapshotPath: runRoot, inputPath, snapshotHash: hash, manifest, totalBytes };
  } catch (error) {
    try {
      makeWritable(runRoot);
      fs.rmSync(runRoot, { recursive: true, force: true });
    } catch {
      // Best effort cleanup of a path this function just created.
    }
    throw error;
  }
}

// Recompute a snapshot's manifest hash from the materialized files. This is called before
// approval and before starting a container, so a modified snapshot file invalidates the
// frozen approval instead of silently changing test input.
export function verifyInputSnapshot({ snapshotPath, manifest, snapshotHash: expectedHash } = {}) {
  const target = path.resolve(snapshotPath);
  const inputPath = path.join(target, 'input');
  check(Array.isArray(manifest) && manifest.length > 0, 'snapshot manifest is required');
  check(typeof expectedHash === 'string' && /^[0-9a-f]{64}$/.test(expectedHash), 'snapshot hash is required');

  // Snapshot approval binds an exact tree, not just the listed files. Enumerate the
  // actual input tree and reject extras/links/special files before any bind mount.
  const targetStat = fs.lstatSync(target);
  check(!targetStat.isSymbolicLink() && targetStat.isDirectory(), 'snapshot root is not a real directory');
  const inputStat = fs.lstatSync(inputPath);
  check(!inputStat.isSymbolicLink() && inputStat.isDirectory(), 'snapshot input is not a real directory');
  const actualFiles = new Set();
  const actualDirs = new Set();
  const walk = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new SandboxMaterializerError(`snapshot contains a symlink: ${rel}`, 'snapshot-extra-content');
      if (stat.isDirectory()) {
        actualDirs.add(rel);
        walk(full, rel);
      } else if (stat.isFile()) {
        check(stat.nlink === 1, `snapshot contains a hard-linked file: ${rel}`, 'snapshot-extra-content');
        actualFiles.add(rel);
      } else {
        throw new SandboxMaterializerError(`snapshot contains a special file: ${rel}`, 'snapshot-extra-content');
      }
    }
  };
  walk(inputPath);
  const expectedFiles = new Set();
  const expectedDirs = new Set();
  for (const entry of manifest) {
    const { norm } = normalizeRelPath(entry.path);
    check(!expectedFiles.has(norm), 'snapshot manifest contains duplicate paths');
    expectedFiles.add(norm);
    const parts = norm.split('/');
    for (let i = 1; i < parts.length; i++) expectedDirs.add(parts.slice(0, i).join('/'));
  }
  const sorted = (set) => [...set].sort();
  check(JSON.stringify(sorted(actualFiles)) === JSON.stringify(sorted(expectedFiles)),
    'snapshot input contains unapproved files', 'snapshot-extra-content');
  check(JSON.stringify(sorted(actualDirs)) === JSON.stringify(sorted(expectedDirs)),
    'snapshot input contains unapproved directories', 'snapshot-extra-content');

  const entries = [];
  for (const entry of manifest) {
    const inspected = inspectSafePath({ worktreeRoot: inputPath, relPath: entry.path });
    check(inspected.kind === 'file', `snapshot file is missing: ${entry.path}`);
    const material = readSafeMaterial(inspected, { maxBytes: SANDBOX_LIMITS.maxSnapshotFileBytes });
    check(material.bytes === entry.size, `snapshot size mismatch: ${entry.path}`);
    check(sha256(material.content) === entry.sha256, `snapshot hash mismatch: ${entry.path}`);
    entries.push({ path: entry.path, sha256: entry.sha256, size: entry.size });
  }
  const actual = snapshotHash(entries);
  check(actual === expectedHash, 'snapshot manifest hash mismatch');
  return { ok: true, snapshotHash: actual };
}

// Remove a snapshot only when its owner marker matches the run and hash. A path replaced
// by unrelated data is refused rather than recursively deleted.
export function cleanupInputSnapshot({ snapshotPath, runId, snapshotHash: hash, sandboxRoot = defaultSandboxRoot() } = {}) {
  const baseRoot = path.resolve(sandboxRoot);
  const target = path.resolve(snapshotPath);
  check(isWithin(baseRoot, target), 'snapshot cleanup path escapes the sandbox root');
  if (!fs.existsSync(target)) return { cleaned: true, missing: true };
  const stat = fs.lstatSync(target);
  check(!stat.isSymbolicLink() && stat.isDirectory(), 'snapshot cleanup target is not a real directory');
  const markerPath = path.join(target, 'marker.json');
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    throw new SandboxMaterializerError('snapshot marker is missing; refusing to remove', 'snapshot-identity');
  }
  check(marker.runId === runId && marker.snapshotHash === hash,
    'snapshot marker does not match the run; refusing to remove', 'snapshot-identity');
  makeWritable(target);
  fs.rmSync(target, { recursive: true, force: true });
  return { cleaned: true, missing: false };
}
