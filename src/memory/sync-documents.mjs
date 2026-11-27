// 当前实现从 SQLite 读取本机记忆并生成传输投影，不代表跨设备冲突时本机永远优先。
// ADR-0002 的表示分工与现状有差异，待议澄清见 ADR-0016；这里不改变归属或冲突政策。
import { canonical, sha256 } from '../utils.mjs';
import { rejectObviousSecrets } from '../evolution.mjs';
import { SYNC_DOCUMENT_PREFIX, SYNC_FILE_MAX } from './sync-git.mjs';

const FORMAT = 'owner-memory/v1';
const FIELDS = Object.freeze({ knowledge: [['title', '标题'], ['content', '内容']],
  lesson: [['phenomenon', '现象'], ['mechanism', '机制'], ['countermeasure', '对策']] });
const LOCAL_KEYS = new Set(['sessionPath', 'cwd', 'root', 'rootPath', 'absolutePath', 'hostname']);
const RUNTIME_KEYS = new Set(['id', 'revision', 'createdAt', 'updatedAt', 'payloadHash', 'status', 'syncArchivedAt']);
const REFERENCE_KEYS = new Set(['ref', 'sourceRef', 'evidenceRefs']);
const absolute = (value) => /^(?:[A-Za-z]:[\\/]|\/|\\\\)/u.test(value);
const fail = message => { const error = new Error(message); error.code = 'sync-document-invalid'; throw error; };

/** 只处理结构化本机路径；记忆正文与已选证据摘录仍保持原文，供同步前预览确认。 */
const portable = (value, key = '', depth = 0) => {
  if (depth > 32) fail('记忆结构过深，无法生成同步文档。');
  if (Array.isArray(value)) return value.map(item => portable(item, key, depth + 1));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [name, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(name)) fail('同步文档含有无效字段。');
      if (/^(?:password|secret|api[_-]?key|access[_-]?token|authorization|credentials?|webhook)$/iu.test(name)
        && typeof item === 'string' && item.trim() && !/^<redacted:[a-z-]+>$/u.test(item)) fail('同步条目含有疑似凭据字段，请先脱敏。');
      if (!LOCAL_KEYS.has(name) && item !== undefined) output[name] = portable(item, name, depth + 1);
    }
    return output;
  }
  if (typeof value === 'string') rejectObviousSecrets(value);
  return typeof value === 'string' && REFERENCE_KEYS.has(key) && absolute(value)
    ? `local-reference:${sha256(value)}` : value;
};

export function syncRecordOf(kind, row) {
  if (!FIELDS[kind] || !row || typeof row !== 'object') fail('无法识别同步条目类型。');
  const id = String(row.id ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(id)) fail('同步条目的身份无效。');
  const payload = Object.fromEntries(Object.entries(row).filter(([key]) => !RUNTIME_KEYS.has(key)));
  if (kind === 'lesson') {
    if (payload.mechanism === undefined) payload.mechanism = '';
    if (payload.countermeasure === undefined) payload.countermeasure = '';
  }
  if (kind === 'lesson' && Array.isArray(payload.evidence)) {
    payload.evidence = payload.evidence.map(({ recordId, ref, kind: evidenceKind, excerpt, contentHash }) =>
      ({ recordId, ref, kind: evidenceKind, excerpt, contentHash }));
  }
  const projected = portable(payload);
  rejectObviousSecrets(projected);
  return { kind, id, payload: projected, createdAt: String(row.createdAt ?? ''), updatedAt: String(row.updatedAt ?? row.createdAt ?? '') };
}

export function syncDocumentVersion(record) {
  return sha256(canonical({ kind: record.kind, id: record.id, payload: record.payload }));
}
export function syncDocumentPath(record) {
  if (!FIELDS[record?.kind] || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(record?.id ?? '')) fail('同步文档身份无效。');
  return `${SYNC_DOCUMENT_PREFIX}${record.kind}/${record.id}.md`;
}

/** 长度信息只负责划分段落，任意 Markdown 标题与分隔线都能原样往返。 */
export function encodeSyncDocument(record) {
  const file = syncDocumentPath(record);
  if (!record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload)) fail('同步条目正文结构无效。');
  const payload = portable(record.payload);
  rejectObviousSecrets(payload);
  const metadata = { ...payload }; const sections = []; const parts = [];
  for (const [key, label] of FIELDS[record.kind]) {
    if (typeof payload[key] !== 'string') fail(`同步文档缺少「${label}」。`);
    const value = payload[key]; delete metadata[key];
    sections.push([key, value.length]); parts.push(`## ${label}\n${value}\n\n`);
  }
  const normalized = { ...record, payload };
  const project = String(payload.projectId ?? '');
  const status = String(payload.kind === 'decision' ? payload.decisionStatus : payload.verificationStatus ?? '');
  const header = { format: FORMAT, id: record.id, kind: record.kind, project, status,
    version: syncDocumentVersion(normalized), createdAt: record.createdAt || '', updatedAt: record.updatedAt || '',
    metadata, sections };
  const content = `---\n${Object.entries(header).map(([key, value]) => `${key}: ${canonical(value)}`).join('\n')}\n---\n${parts.join('')}`;
  if (Buffer.byteLength(content) > SYNC_FILE_MAX) fail('单篇记忆超过同步文档限制，未截断正文。');
  return { path: file, content, version: header.version, id: `${record.kind}:${record.id}`, record: normalized };
}

export function decodeSyncDocument({ path, content } = {}) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > SYNC_FILE_MAX || !content.startsWith('---\n')) fail('同步文档格式无效。');
  const close = content.indexOf('\n---\n', 4);
  if (close < 0) fail('同步文档缺少完整的元数据。');
  const header = Object.create(null);
  try {
    for (const line of content.slice(4, close).split('\n')) {
      const split = line.indexOf(': '); const key = line.slice(0, split);
      if (split < 1 || Object.hasOwn(header, key) || ['__proto__','constructor','prototype'].includes(key)) fail('同步元数据有重复或非法字段。');
      header[key] = JSON.parse(line.slice(split + 2));
    }
  } catch { fail('同步元数据无法解析。'); }
  if (header.format !== FORMAT || !FIELDS[header.kind] || !header.metadata || typeof header.metadata !== 'object' || Array.isArray(header.metadata)) fail('同步文档版本或类型不受支持。');
  const keys = ['format','id','kind','project','status','version','createdAt','updatedAt','metadata','sections'];
  if (Object.keys(header).some(key => !keys.includes(key)) || !Array.isArray(header.sections) || header.sections.length !== FIELDS[header.kind].length) fail('同步文档字段不完整或包含未知数据。');
  const payload = portable(header.metadata); const body = content.slice(close + 5); let offset = 0;
  for (let index = 0; index < FIELDS[header.kind].length; index += 1) {
    const [key, label] = FIELDS[header.kind][index]; const section = header.sections[index]; const prefix = `## ${label}\n`;
    if (!Array.isArray(section) || section[0] !== key || !Number.isSafeInteger(section[1]) || section[1] < 0
      || Object.hasOwn(payload, key) || body.slice(offset, offset + prefix.length) !== prefix) fail('同步正文结构不完整。');
    offset += prefix.length; payload[key] = body.slice(offset, offset + section[1]); offset += section[1];
    if (body.slice(offset, offset + 2) !== '\n\n') fail('同步正文被截断。');
    offset += 2;
  }
  if (offset !== body.length) fail('同步正文包含未声明的内容。');
  const record = { kind: header.kind, id: header.id, payload, createdAt: header.createdAt, updatedAt: header.updatedAt };
  const encoded = encodeSyncDocument(record);
  if (encoded.path !== path || encoded.version !== header.version || encoded.content !== content) fail('同步文档的身份或内容校验不一致，请重新检查来源。');
  return encoded;
}

/** 接收时保留本机专属来源路径；跨机器指针无法解析时仍保留稳定引用，不猜测另一台机器的路径。 */
export function restoreSyncLocalFields(incoming, existing) {
  const references = new Map();
  const index = (value) => {
    if (typeof value === 'string' && absolute(value)) references.set(`local-reference:${sha256(value)}`, value);
    else if (Array.isArray(value)) value.forEach(index);
    else if (value && typeof value === 'object') Object.values(value).forEach(index);
  };
  index(existing);
  const restore = (value, prior) => {
    if (typeof value === 'string') return references.get(value) ?? value;
    if (Array.isArray(value)) return value.map((item, at) => restore(item, prior?.[at]));
    if (!value || typeof value !== 'object') return value;
    const output = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restore(item, prior?.[key])]));
    for (const key of LOCAL_KEYS) if (prior && Object.hasOwn(prior, key)) output[key] = prior[key];
    return output;
  };
  return restore(incoming, existing);
}
