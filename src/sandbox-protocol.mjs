// Sandboxed Test Runner protocol (v0.9).
//
// The host never executes project code. This module only freezes/validates Owner-side
// profiles, run specs, snapshot manifests and bounded evidence. Container argv is built by
// the trusted provider from these values, never from free-form CLI strings.
import { canonical, sha256 } from './utils.mjs';
import { normalizeRelPath } from './patch-protocol.mjs';

export const SANDBOX_LIMITS = {
  maxIncludeFiles: 50,
  maxSnapshotFileBytes: 262144,
  maxSnapshotTotalBytes: 2 * 1024 * 1024,
  maxStdoutBytes: 65536,
  maxStderrBytes: 65536,
  maxLogLines: 2000,
  minTimeoutMs: 1000,
  maxTimeoutMs: 300000,
  maxMemoryBytes: 1024 * 1024 * 1024,
  maxPids: 512,
  maxCpus: 4,
  maxTmpfsBytes: 128 * 1024 * 1024
};

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export class SandboxProtocolError extends Error {
  constructor(message, category = 'invalid-sandbox-spec') {
    super(message);
    this.name = 'SandboxProtocolError';
    this.category = category;
  }
}

const check = (ok, message) => {
  if (!ok) throw new SandboxProtocolError(message);
};

// 每个 profile 绑定一个可信镜像与固定 argv；argv 只允许此表内的 runtime。
export const SANDBOX_PROFILES = Object.freeze({
  'node-smoke': {
    image: 'node:22-alpine', runtime: 'node',
    command: ['node', '--test', 'tests/sandbox-smoke.test.mjs'],
    includePaths: ['tests/sandbox-smoke.test.mjs', 'package.json']
  },
  'node-fail': {
    image: 'node:22-alpine', runtime: 'node',
    command: ['node', '--test', 'tests/sandbox-fail.test.mjs'],
    includePaths: ['tests/sandbox-fail.test.mjs', 'package.json']
  },
  'node-probe': {
    image: 'node:22-alpine', runtime: 'node',
    command: ['node', '--test', 'tests/sandbox-probe.test.mjs'],
    includePaths: ['tests/sandbox-probe.test.mjs', 'package.json']
  },
  'godot-headless': {
    image: 'barichello/godot-ci:4.3', runtime: 'godot',
    command: ['godot', '--headless', '--path', '.', '--quit'],
    timeoutMs: 120000, memoryBytes: 512 * 1024 * 1024,
    includePaths: ['project.godot']
  },
  'python-pytest': {
    image: 'python:3.12-slim', runtime: 'python',
    command: ['python', '-m', 'pytest', '-q'],
    timeoutMs: 120000, memoryBytes: 512 * 1024 * 1024,
    includePaths: ['pyproject.toml', 'requirements.txt']
  }
});

export const SANDBOX_PROFILE_COMMANDS = Object.freeze(Object.fromEntries(
  Object.entries(SANDBOX_PROFILES).map(([id, def]) => [id, [...def.command]])
));

const ALLOWED_RUNTIMES = new Set(Object.values(SANDBOX_PROFILES).map((def) => def.runtime));

const BASE_PROFILE = {
  version: 1,
  timeoutMs: 30000,
  memoryBytes: 128 * 1024 * 1024,
  cpus: 1,
  pidsLimit: 64,
  tmpfsBytes: 32 * 1024 * 1024,
  stdoutBytes: SANDBOX_LIMITS.maxStdoutBytes,
  stderrBytes: SANDBOX_LIMITS.maxStderrBytes,
  network: false,
  readOnlyRootfs: true,
  user: '65534:65534',
  workdir: '/workspace'
};

const validateCommand = (command, runtime = 'node') => {
  check(Array.isArray(command) && command.length >= 1 && command.length <= 8, 'invalid test command');
  check(command.every((part) => typeof part === 'string' && part.length > 0 && part.length <= 300 && !/[\x00\r\n]/.test(part)),
    'invalid test command argument');
  check(ALLOWED_RUNTIMES.has(runtime), 'unsupported test runtime');
  check(command[0] === runtime, `test command must start with the allowlisted runtime: ${runtime}`);
  return [...command];
};

const validateProfile = (profile) => {
  check(profile && typeof profile === 'object', 'test profile is required');
  check(typeof profile.id === 'string' && /^[a-z0-9][a-z0-9-]{0,60}$/.test(profile.id), 'invalid profile id');
  check(Number.isSafeInteger(profile.version) && profile.version >= 1, 'invalid profile version');
  check(DIGEST_RE.test(profile.imageDigest), 'test profile requires a sha256 image digest');
  check(typeof profile.image === 'string' && /^[a-z0-9][a-z0-9./:_-]{0,120}$/i.test(profile.image), 'invalid profile image');
  const def = SANDBOX_PROFILES[profile.id];
  check(def && def.runtime, `unknown test profile: ${profile.id}`);
  validateCommand(profile.command, def.runtime);
  check(Number.isSafeInteger(profile.timeoutMs)
    && profile.timeoutMs >= SANDBOX_LIMITS.minTimeoutMs
    && profile.timeoutMs <= SANDBOX_LIMITS.maxTimeoutMs, 'invalid timeout');
  check(Number.isSafeInteger(profile.memoryBytes)
    && profile.memoryBytes >= 16 * 1024 * 1024
    && profile.memoryBytes <= SANDBOX_LIMITS.maxMemoryBytes, 'invalid memory limit');
  check(typeof profile.cpus === 'number' && profile.cpus >= 0.1 && profile.cpus <= SANDBOX_LIMITS.maxCpus, 'invalid cpu limit');
  check(Number.isSafeInteger(profile.pidsLimit) && profile.pidsLimit >= 8 && profile.pidsLimit <= SANDBOX_LIMITS.maxPids,
    'invalid pids limit');
  check(Number.isSafeInteger(profile.tmpfsBytes) && profile.tmpfsBytes >= 1024 * 1024
    && profile.tmpfsBytes <= SANDBOX_LIMITS.maxTmpfsBytes, 'invalid tmpfs limit');
  check(profile.network === false, 'sandbox network must be disabled');
  check(profile.readOnlyRootfs === true, 'sandbox rootfs must be read-only');
  check(profile.user === '65534:65534', 'sandbox user must be the non-root nobody uid/gid');
  check(profile.workdir === '/workspace', 'sandbox workdir must be /workspace');
  return profile;
};

export function resolveTestProfile(id, { imageDigest } = {}) {
  check(typeof id === 'string' && id.length > 0, 'test profile id is required');
  const def = SANDBOX_PROFILES[id];
  check(!!def, `unknown test profile: ${id}`);
  check(typeof imageDigest === 'string' && DIGEST_RE.test(imageDigest), 'imageDigest must be sha256:<64 hex>');
  const profile = validateProfile({
    ...BASE_PROFILE,
    ...(Number.isSafeInteger(def.timeoutMs) ? { timeoutMs: def.timeoutMs } : {}),
    ...(Number.isSafeInteger(def.memoryBytes) ? { memoryBytes: def.memoryBytes } : {}),
    id,
    image: def.image,
    imageDigest,
    command: [...def.command]
  });
  return {
    ...profile,
    profileHash: profileHash(profile),
    testPlanHash: testPlanHash(profile)
  };
}

export function profileHash(profile) {
  return sha256(canonical({
    id: profile.id,
    version: profile.version,
    image: profile.image,
    command: profile.command,
    timeoutMs: profile.timeoutMs,
    memoryBytes: profile.memoryBytes,
    cpus: profile.cpus,
    pidsLimit: profile.pidsLimit,
    tmpfsBytes: profile.tmpfsBytes,
    stdoutBytes: profile.stdoutBytes,
    stderrBytes: profile.stderrBytes,
    network: profile.network,
    readOnlyRootfs: profile.readOnlyRootfs,
    user: profile.user,
    workdir: profile.workdir
  }));
}

export function testPlanHash(profile) {
  return sha256(canonical({
    profileHash: profile.profileHash ?? profileHash(profile),
    imageDigest: profile.imageDigest
  }));
}

export function normalizeIncludePaths(paths) {
  check(Array.isArray(paths), 'includePaths must be an array');
  check(paths.length <= SANDBOX_LIMITS.maxIncludeFiles, 'too many include paths');
  const out = [];
  const seen = new Set();
  for (const raw of paths) {
    const { norm, lower } = normalizeRelPath(raw);
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(norm);
  }
  return out.sort();
}

export function approvalHash(spec) {
  return sha256(canonical({
    projectId: spec.projectId,
    workspaceId: spec.workspaceId,
    proposalId: spec.proposalId,
    approvedHash: spec.approvedHash,
    baseSha: spec.baseSha,
    profileId: spec.profile.id,
    profileHash: spec.profile.profileHash ?? profileHash(spec.profile),
    testPlanHash: spec.profile.testPlanHash ?? testPlanHash(spec.profile),
    imageDigest: spec.profile.imageDigest,
    snapshotHash: spec.snapshotHash,
    includePaths: spec.includePaths
  }));
}

export function snapshotHash(manifest) {
  return sha256(canonical(manifest.map((entry) => ({
    path: entry.path,
    sha256: entry.sha256,
    size: entry.size
  })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))));
}

const REDACT_PATTERNS = [
  [/((?:api[_-]?key|access[_-]?token|token|secret|password|passwd|authorization)\s*[:=]\s*)([^\s"'`]+)/gi, '$1[REDACTED]'],
  [/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]']
];

// Sanitize bounded stdout/stderr. The returned text is what may be stored in the private
// evidence artifact; raw child output is never written to Job/Event/oplog tables.
export function sanitizeLog(input, { maxBytes = SANDBOX_LIMITS.maxStdoutBytes, maxLines = SANDBOX_LIMITS.maxLogLines } = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ''), 'utf8');
  const originalBytes = buffer.length;
  let truncated = originalBytes > maxBytes;
  let slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
  let text = new TextDecoder('utf-8', { fatal: false }).decode(slice);
  for (const [pattern, replacement] of REDACT_PATTERNS) text = text.replace(pattern, replacement);
  const lines = text.split(/\r?\n/);
  if (lines.length > maxLines) {
    text = `${lines.slice(0, maxLines).join('\n')}\n[truncated:lines]`;
    truncated = true;
  }
  return {
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    originalBytes,
    truncated,
    contentHash: sha256(text)
  };
}

export const SANDBOX_STATUSES = new Set([
  'pending_approval', 'queued', 'provisioning', 'running', 'collecting',
  'completed', 'failed', 'cancelled', 'rejected', 'needs_reconciliation'
]);
export const ACTIVE_SANDBOX_STATUSES = ['queued', 'provisioning', 'running', 'collecting'];
export const UNRESOLVED_SANDBOX_STATUSES = ['provisioning', 'running', 'collecting', 'needs_reconciliation'];
