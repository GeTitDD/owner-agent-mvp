// 知识身份与来源协议（纯函数）。
//
// 身份分层：
//   knowledgeId  —— 知识单元身份，跨设备同步时原样保留，不改写。
//   projectId    —— 本地项目注册 ID；跨设备由 Project Identity 做别名映射。
//   sourceId     —— 来源身份，由 (namespace, sourceType, objectId) 决定，不含本地路径。
//   observationId—— 一次来源观察，绑定 sourceVersion + contentHash + captureRunId。
//
// 旧数据里的 evidenceRefs / sourceRef 是“Legacy Source Ref”：只作为字符串保留，
// 不猜测其 commit、版本或哈希。
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { canonical } from '../utils.mjs';

const SOURCE_TYPES = new Set([
  'git', 'github', 'file', 'document', 'session', 'run', 'experiment', 'manual'
]);
const AVAILABILITY = new Set(['available', 'unavailable', 'unknown']);
const RELATIONS = new Set(['supports', 'contradicts', 'derived_from', 'validates']);
const ID_PATTERN = /^[a-z][a-z0-9]*_[a-z0-9]{8,64}$/u;

const sha = (value) => createHash('sha256').update(String(value)).digest('hex');
const clean = (value, max = 500) => {
  const text = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '').trim();
  if (!text) throw new Error('Empty source field');
  return text.slice(0, max);
};

/** 来源身份：稳定、可跨系统复算，不含本地绝对路径。 */
export function sourceIdFor({ namespace, sourceType, objectId }) {
  return `src_${sha(canonical({
    namespace: clean(namespace, 300),
    sourceType: clean(sourceType, 40),
    objectId: clean(objectId, 500)
  })).slice(0, 24)}`;
}

/** 观察身份：同一来源的不同版本/不同采集运行得到不同 ID，便于幂等重放。 */
export function observationIdFor({ sourceId, sourceVersion, contentHash = '', captureRunId = '' }) {
  return `obs_${sha(canonical({
    sourceId: clean(sourceId, 120),
    sourceVersion: clean(sourceVersion, 300),
    contentHash: String(contentHash ?? ''),
    captureRunId: String(captureRunId ?? '')
  })).slice(0, 24)}`;
}

export function projectIdentityId(kind, value) {
  return `prj_${sha(canonical({ kind: clean(kind, 40), value: clean(value, 500) })).slice(0, 24)}`;
}

/** 规范化 SourceDescriptor；缺字段就报错，绝不补造版本或哈希。 */
export function normalizeSourceDescriptor(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Source descriptor must be an object');
  }
  const sourceType = clean(input.sourceType, 40);
  if (!SOURCE_TYPES.has(sourceType)) throw new Error(`Unknown source type: ${sourceType}`);
  const availability = input.availability ?? 'unknown';
  if (!AVAILABILITY.has(availability)) throw new Error('Invalid availability');
  const namespace = clean(input.namespace, 300);
  const objectId = clean(input.objectId, 500);
  const sourceVersion = clean(input.sourceVersion, 300);
  const locator = clean(input.locator, 500);
  const descriptor = {
    contract: 'source-descriptor/v1',
    sourceId: input.sourceId ?? sourceIdFor({ namespace, sourceType, objectId }),
    sourceType,
    namespace,
    objectId,
    sourceVersion,
    locator,
    contentHash: input.contentHash ? clean(input.contentHash, 128) : '',
    observedAt: input.observedAt ?? new Date().toISOString(),
    captureRunId: input.captureRunId ? clean(input.captureRunId, 120) : '',
    availability
  };
  if (!ID_PATTERN.test(descriptor.sourceId)) throw new Error('Invalid sourceId');
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(descriptor.observedAt)) throw new Error('Invalid observedAt');
  return descriptor;
}

/** 观察记录：source identity + 版本 + 内容哈希 + 采集运行。 */
export function normalizeObservation(input) {
  const descriptor = normalizeSourceDescriptor(input);
  const observation = {
    contract: 'source-observation/v1',
    observationId: input.observationId ?? observationIdFor({
      sourceId: descriptor.sourceId,
      sourceVersion: descriptor.sourceVersion,
      contentHash: descriptor.contentHash,
      captureRunId: descriptor.captureRunId
    }),
    sourceId: descriptor.sourceId,
    sourceVersion: descriptor.sourceVersion,
    contentHash: descriptor.contentHash,
    locator: descriptor.locator,
    observedAt: descriptor.observedAt,
    captureRunId: descriptor.captureRunId,
    observedBy: clean(input.observedBy ?? 'agent', 80),
    availability: descriptor.availability
  };
  if (!ID_PATTERN.test(observation.observationId)) throw new Error('Invalid observationId');
  return { descriptor, observation };
}

/** 旧 evidenceRefs 的兼容解析：只识别前缀，不推断版本。 */
export function parseLegacyRef(ref) {
  const text = String(ref ?? '').trim();
  if (!text) return null;
  const match = /^(experience|job|sandbox|patch|eval|usage|knowledge|git|github|file|session|run):(.+)$/u.exec(text);
  if (!match) return { kind: 'legacy', value: text.slice(0, 500), version: '' };
  return { kind: match[1], value: match[2].slice(0, 500), version: '' };
}

const DEVICE_FILE = path.join(os.homedir(), '.domain-context', 'device-id');

/** 设备 ID：跨会话稳定；测试可注入环境变量避免污染用户目录。 */
export function deviceId({ file = process.env.OWNER_DEVICE_ID_FILE || DEVICE_FILE } = {}) {
  if (process.env.OWNER_DEVICE_ID) return String(process.env.OWNER_DEVICE_ID).slice(0, 64);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (ID_PATTERN.test(existing)) return existing;
  } catch { /* 首次运行：创建 */ }
  const created = `dev_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${created}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch { /* 只读环境退回内存 ID */ }
  return created;
}

/** 项目 Identity：优先 git remote（跨设备稳定），其次首个 commit，最后本地根路径。 */
export function computeProjectIdentity({ root, remoteUrl = '', firstCommit = '', rootIdentity = '' } = {}) {
  const normalizeRemote = (value) => String(value).trim()
    .replace(/^git@([^:]+):/u, 'https://$1/')
    .replace(/\.git$/u, '')
    .replace(/\/+$/u, '')
    .toLowerCase();
  if (remoteUrl) {
    return { projectIdentity: projectIdentityId('git-remote', normalizeRemote(remoteUrl)), identityKind: 'git-remote' };
  }
  if (firstCommit) {
    return { projectIdentity: projectIdentityId('git-first-commit', firstCommit), identityKind: 'git-first-commit' };
  }
  if (rootIdentity) {
    return { projectIdentity: projectIdentityId('local-root', rootIdentity), identityKind: 'local-root' };
  }
  throw new Error('Project identity requires remoteUrl, firstCommit or rootIdentity');
}

/** 关系校验：链接只能是这四种，避免自由文本污染来源图。 */
export function normalizeRelation(value) {
  const relation = String(value ?? 'supports');
  if (!RELATIONS.has(relation)) throw new Error(`Unknown source relation: ${relation}`);
  return relation;
}

export const SOURCE_CONTRACT = 'source-descriptor/v1';
export const OBSERVATION_CONTRACT = 'source-observation/v1';
export const LINK_RELATIONS = [...RELATIONS];
