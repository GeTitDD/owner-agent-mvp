import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function requireId(id, label = 'id') {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(id) || id === '.' || id === '..') {
    throw new Error(`Invalid ${label}: ${JSON.stringify(id)}`);
  }
  return id;
}

export function validateRelativeFile(value) {
  if (typeof value !== 'string' || value.startsWith('/') || value.includes('\\') || value.split('/').some((x) => !x || x === '.' || x === '..')) {
    throw new Error(`Invalid relative path: ${JSON.stringify(value)}`);
  }
  return value;
}

export async function within(root, relative) {
  validateRelativeFile(relative);
  const base = await realpath(root);
  const target = await realpath(path.join(root, relative));
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error(`Path escapes domain root: ${relative}`);
  return target;
}

export async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new Error(`Cannot read JSON ${file}: ${error.message}`); }
}

/**
 * 压平文本：去掉 NUL、把换行与连续空白折成一个空格、去首尾空白，超长按字符截断。
 * 展示、关键词匹配、证据摘要原本各写一份，现在共用这一份；各自的截断长度作为参数传进来。
 * 只处理文本，不做 HTML 清洗——需要时另加。
 */
export function flatText(value, max = 0) {
  const flat = String(value ?? '').replace(/\u0000/gu, '').replace(/\s+/gu, ' ').trim();
  return max > 0 ? flat.slice(0, max) : flat;
}

// Conservative heuristic only, NOT model tokenizer accounting. Provider usage is the ground truth.
export function estimateTokens(text) {
  const wideChars = (text.match(/[\u2e80-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const asciiBytes = Buffer.byteLength(text, 'utf8') - wideChars * 3;
  return Math.max(1, Math.ceil(wideChars * 1.4 + asciiBytes / 3));
}

export function formatRecord(rec) {
  return `[${rec.key ?? `${rec.domain}@${rec.version}:${rec.id}`}] ${rec.title}\n${rec.claim}`;
}
