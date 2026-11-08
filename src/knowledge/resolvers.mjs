// 可运行的来源解析器：Git / 本地文件 / GitHub / Owner Run / Pi Session。
//
// 约定：
// - 解析失败不返回“猜测的版本”，而是抛出带 reason 的 SourceResolveError；
//   调用方可以把来源标为 unavailable，但不得写入伪造的 commit / hash。
// - 所有 objectId 都以项目身份为前缀，不使用本地绝对路径，避免跨设备漂移。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { canonical } from '../utils.mjs';
import { computeProjectIdentity, sourceIdFor } from './sources.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const posix = (value) => String(value).replaceAll('\\', '/').replace(/^\.\//u, '');
// Windows 下 mkdtemp 可能返回 8.3 短路径，而 git 返回长路径；统一到真实路径再求相对路径。
const canonicalPath = (value) => {
  try {
    return process.platform === 'win32' ? realpathSync.native(value) : realpathSync(value);
  } catch {
    return value;
  }
};

export class SourceResolveError extends Error {
  constructor(reason, message) {
    super(message ?? reason);
    this.name = 'SourceResolveError';
    this.reason = reason;
  }
}

const git = (root, args) => execFileSync('git', args, {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000
}).trim();

const gitMeta = (root) => {
  try {
    const topLevel = git(root, ['rev-parse', '--show-toplevel']);
    const head = git(root, ['rev-parse', 'HEAD']);
    let remoteUrl = '';
    try { remoteUrl = git(root, ['remote', 'get-url', 'origin']); } catch { /* 无 remote 是允许的 */ }
    return { topLevel, head, remoteUrl };
  } catch {
    return null;
  }
};

const identityFor = ({ root, remoteUrl = '', firstCommit = '' }) => {
  if (remoteUrl || firstCommit) return computeProjectIdentity({ root, remoteUrl, firstCommit });
  // 没有 remote、也没有根提交时只能退到本地根身份；这是诚实的“仅本机可识别”。
  const canonicalRoot = canonicalPath(root);
  return computeProjectIdentity({ root: canonicalRoot, rootIdentity: sha(canonicalRoot) });
};

/** Git 跟踪文件的来源：版本 = commit SHA，内容哈希 = blob SHA。 */
export function resolveGitFileSource({ root, relPath, projectId = null, projectIdentity = '', captureRunId = '', observedAt } = {}) {
  const meta = gitMeta(canonicalPath(root));
  if (!meta) throw new SourceResolveError('not-a-git-repository', `${root} is not a git repository`);
  const file = posix(path.relative(canonicalPath(meta.topLevel), path.resolve(canonicalPath(root), relPath)));
  if (!file || file.startsWith('..')) throw new SourceResolveError('outside-repository', `outside-repository: ${relPath}`);
  let blobSha;
  try {
    blobSha = git(meta.topLevel, ['rev-parse', `HEAD:${file}`]);
  } catch {
    throw new SourceResolveError('not-tracked', `${file} is not tracked at HEAD`);
  }
  let firstCommit = '';
  try {
    firstCommit = git(meta.topLevel, ['rev-list', '--max-parents=0', 'HEAD']).split(/\r?\n/u).filter(Boolean).sort()[0] ?? '';
  } catch { /* 浅克隆可能没有根提交 */ }
  const { projectIdentity: identity, identityKind } = projectIdentity
    ? { projectIdentity, identityKind: 'provided' }
    : identityFor({ root: meta.topLevel, remoteUrl: meta.remoteUrl, firstCommit });
  return {
    projectIdentity: identity,
    identityKind,
    descriptor: {
      sourceType: 'git',
      namespace: `git:${identity}`,
      objectId: `${identity}:${file}`,
      sourceVersion: meta.head,
      locator: file,
      contentHash: blobSha,
      captureRunId,
      observedAt,
      availability: 'available',
      projectId
    }
  };
}

/** 未跟踪或非 Git 文件的来源：版本 = 内容哈希（内容寻址，跨设备稳定）。 */
export function resolveLocalFileSource({ root, relPath, projectId = null, projectIdentity = '', captureRunId = '', observedAt } = {}) {
  const realRoot = canonicalPath(root);
  const absolute = path.resolve(realRoot, relPath);
  if (!absolute.startsWith(realRoot)) throw new SourceResolveError('outside-project', `outside-project: ${relPath}`);
  if (!existsSync(absolute)) throw new SourceResolveError('file-missing', `file-missing: ${relPath}`);
  const stats = statSync(absolute);
  if (!stats.isFile()) throw new SourceResolveError('not-a-file', `not-a-file: ${relPath}`);
  const contentHash = sha(readFileSync(absolute));
  const file = posix(path.relative(realRoot, absolute));
  const { projectIdentity: identity, identityKind } = projectIdentity
    ? { projectIdentity, identityKind: 'provided' }
    : identityFor({ root });
  return {
    projectIdentity: identity,
    identityKind,
    descriptor: {
      sourceType: 'file',
      namespace: `file:${identity}`,
      objectId: `${identity}:${file}`,
      sourceVersion: `sha256:${contentHash}`,
      locator: file,
      contentHash,
      captureRunId,
      observedAt,
      availability: 'available',
      projectId
    }
  };
}

const defaultGhRunner = (args) => {
  const output = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
  return JSON.parse(output);
};

/**
 * GitHub 来源。kind: commit | pr | issue。
 * 版本必须是不可变标识：commit/PR head SHA；issue 只有 updated_at，明确标为不可变性较弱。
 */
export function resolveGitHubSource({ repo, kind = 'commit', ref, projectId = null, captureRunId = '', observedAt, runner = defaultGhRunner } = {}) {
  if (!repo || !/^[\w.-]+\/[\w.-]+$/u.test(repo)) throw new SourceResolveError('invalid-repository', String(repo));
  if (!ref) throw new SourceResolveError('missing-ref', 'GitHub ref is required');
  const base = `repos/${repo}`;
  let data;
  let sourceVersion;
  let locator;
  let objectId;
  try {
    if (kind === 'commit') {
      data = runner(['api', `${base}/commits/${encodeURIComponent(ref)}`]);
      sourceVersion = data.sha;
      objectId = `${repo}@commit:${sourceVersion}`;
      locator = `${data.html_url ?? `https://github.com/${repo}/commit/${sourceVersion}`}`;
    } else if (kind === 'pr') {
      data = runner(['api', `${base}/pulls/${encodeURIComponent(ref)}`]);
      sourceVersion = data.head?.sha;
      if (!sourceVersion) throw new SourceResolveError('missing-version', 'PR head SHA missing');
      objectId = `${repo}@pr:${ref}`;
      locator = data.html_url ?? `https://github.com/${repo}/pull/${ref}`;
    } else if (kind === 'issue') {
      data = runner(['api', `${base}/issues/${encodeURIComponent(ref)}`]);
      if (!data.updated_at) throw new SourceResolveError('missing-version', 'Issue updated_at missing');
      sourceVersion = `updated:${data.updated_at}`;
      objectId = `${repo}@issue:${ref}`;
      locator = data.html_url ?? `https://github.com/${repo}/issues/${ref}`;
    } else {
      throw new SourceResolveError('unsupported-kind', `Unsupported GitHub kind: ${kind}`);
    }
  } catch (error) {
    if (error instanceof SourceResolveError) throw error;
    throw new SourceResolveError('github-unavailable', error.message);
  }
  return {
    descriptor: {
      sourceType: 'github',
      namespace: `github:${repo}`,
      objectId,
      sourceVersion,
      locator,
      contentHash: '',
      captureRunId,
      observedAt,
      availability: 'available',
      projectId
    }
  };
}

/** Owner 终态 Run：版本 = Run ID，内容哈希覆盖终态证据字段。 */
export function resolveOwnerRunSource({ ownerStore, runId, observedAt, captureRunId = '' } = {}) {
  const run = ownerStore?.getSandboxRun?.(runId);
  if (!run) throw new SourceResolveError('run-not-found', `Sandbox run ${runId} not found`);
  const terminal = ['completed', 'failed', 'cancelled', 'rejected'].includes(run.status);
  const evidence = {
    runId: run.id, projectId: run.project_id, jobId: run.job_id,
    status: run.status, executionStatus: run.execution_status, testStatus: run.test_status,
    baseSha: run.base_sha ?? '', profileId: run.profile_id ?? '',
    stdoutHash: run.stdout_hash ?? '', stderrHash: run.stderr_hash ?? ''
  };
  return {
    descriptor: {
      sourceType: 'run',
      namespace: 'owner-store',
      objectId: `${run.project_id}:run:${run.id}`,
      sourceVersion: run.id,
      locator: `owner://project/${run.project_id}/sandbox-run/${run.id}`,
      contentHash: sha(canonical(evidence)),
      captureRunId,
      observedAt,
      availability: terminal ? 'available' : 'unknown',
      projectId: run.project_id
    },
    evidence
  };
}

/** Pi Session：只有拿到 transcript 哈希时才认为内容可校验，否则显式标 unknown。 */
export function resolveSessionSource({ sessionId, transcriptHash = '', namespace = 'pi', projectId = null, observedAt, captureRunId = '' } = {}) {
  if (!sessionId) throw new SourceResolveError('missing-session', 'sessionId is required');
  return {
    descriptor: {
      sourceType: 'session',
      namespace,
      objectId: `${namespace}:session:${sessionId}`,
      sourceVersion: transcriptHash ? `sha256:${transcriptHash}` : `session:${sessionId}`,
      locator: `${namespace}://session/${sessionId}`,
      contentHash: transcriptHash,
      captureRunId,
      observedAt,
      availability: transcriptHash ? 'available' : 'unknown',
      projectId
    }
  };
}

/** 统一入口：按 kind 选择解析器；未知类型返回明确的扩展契约错误。 */
export function resolveSource({ kind, ...options } = {}) {
  switch (kind) {
    case 'git': return resolveGitFileSource(options);
    case 'file': return resolveLocalFileSource(options);
    case 'github': return resolveGitHubSource(options);
    case 'run': return resolveOwnerRunSource(options);
    case 'session': return resolveSessionSource(options);
    default: throw new SourceResolveError('unsupported-kind', `No resolver for source kind: ${kind}`);
  }
}

export { sourceIdFor };
