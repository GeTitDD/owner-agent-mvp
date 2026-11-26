// #125 会话指针索引：给「关联会话」列出最近会话、按线索找会话。
//
// 边界（写死在这里，界面层不再猜）：
// - 只出**指针元信息**：来源、会话 id、标题、时间、轮数、所属项目、工作目录。
//   本文件从不返回、也不缓存会话正文：读的是文件头（或数据库里的元信息列），
//   不是整段会话。Codex 的 .jsonl.zst 用流式解压只取开头，超大文件不整段展开。
// - 三个来源：Codex（<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]）、
//   Claude Code（~/.claude/projects/<压平后的 cwd>/<uuid>.jsonl）、
//   OpenCode（<XDG_DATA_HOME>/opencode/opencode.db，只读查询 session + 计数）。
//   OpenCode 的库体量大，这里只查元信息列与条数，不读消息正文。
// - 线索分三类：可解析的会话 id（UUID / ses_ 开头）、可搜索关键词（标题 / 项目 /
//   路径 / id 的子串都能搜）、不可用（空或只有符号）。分类规则与界面同一套口径。
// - 读不出来的来源不抛错，回一条可显示的原因；界面据此给出「不是空，是读不出来」。
// - 不新增依赖：zstd 用 node:zlib，OpenCode 库用 node:sqlite（拿不到就降级）。
// - 本文件不写库、不联网：只读本机会话文件与数据库。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { matchProjectForCwd } from './session-scan.mjs';

const require = createRequire(import.meta.url);

// 只读开头就够拿元信息；轮数也按这个窗口统计（界面会标明不是全文统计）。
const HEAD_BYTES = 96 * 1024;
// 压缩文件先读一段压缩流再解压：够拿到开头，又不把 200MB 的会话整份展开。
const COMPRESSED_HEAD_BYTES = 1024 * 1024;
const DECOMPRESS_TIMEOUT_MS = 1500;

const DEFAULTS = {
  limit: 12,
  maxScan: 80,
  headBytes: HEAD_BYTES,
  maxClueMatches: 8
};

export const POINTER_SOURCES = Object.freeze(['codex', 'claude', 'opencode']);

export const SOURCE_LABELS = Object.freeze({
  codex: 'Codex',
  claude: 'Claude Code',
  opencode: 'OpenCode'
});

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;
const OPENCODE_ID = /^ses_[A-Za-z0-9]{6,}$/u;

/**
 * 线索分类：与界面同一套口径。
 * - id：UUID 或 OpenCode 的 ses_ id（也接受显式 `id:` 前缀）；
 * - keyword：其余含文字 / 数字的串；路径不是单独一类，按关键词去匹配 cwd / 路径；
 * - unusable：空、只有符号、去掉 `id:` 后为空。
 */
export function classifyClue(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return { kind: 'unusable', value: '', reason: '线索是空的' };
  const explicitId = /^id\s*[:：]\s*(.*)$/iu.exec(value);
  if (explicitId) {
    const id = explicitId[1].trim();
    if (!id) return { kind: 'unusable', value, reason: 'id: 后面没有内容' };
    return { kind: 'id', value: id };
  }
  if (!/[\p{L}\p{N}]/u.test(value)) {
    return { kind: 'unusable', value, reason: '线索里没有可搜索的字或数字' };
  }
  if (UUID.test(value) || OPENCODE_ID.test(value)) return { kind: 'id', value };
  return { kind: 'keyword', value };
}

/** 归一：分隔符统一、大小写折叠；用于关键词 / 路径匹配，不做模糊编辑距离。 */
const norm = (value) => String(value ?? '').replace(/\\/gu, '/').toLowerCase();

const baseName = (target) => {
  const clean = String(target ?? '').replace(/[\\/]+$/u, '');
  if (!clean) return '';
  const parts = clean.split(/[\\/]/u);
  return parts[parts.length - 1] ?? '';
};

/** 一组会话的默认落点；只给路径，不检查存在（不存在按 0 条处理并说明）。 */
export function sessionPointerRoots({ home = os.homedir(), env = process.env } = {}) {
  const codexHome = env?.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
  const dataHome = env?.XDG_DATA_HOME
    ? path.resolve(env.XDG_DATA_HOME)
    : path.join(home, '.local', 'share');
  return {
    codex: path.join(codexHome, 'sessions'),
    claude: path.join(home, '.claude', 'projects'),
    opencodeDb: env?.OPENCODE_DB
      ? path.resolve(env.OPENCODE_DB)
      : path.join(dataHome, 'opencode', 'opencode.db')
  };
}

const isSessionFile = (name) => /\.jsonl$/u.test(name) || /\.jsonl\.zst$/u.test(name);

/** 列出会话文件；Claude 的 subagents 是子代理往来，不是 Owner 的主会话，跳过。 */
const listSessionFiles = async (dir, source) => {
  const found = [];
  const walk = async (current) => {
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      return found;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (source === 'claude' && entry.name === 'subagents') continue;
        await walk(full);
        continue;
      }
      if (entry.isFile() && isSessionFile(entry.name)) found.push(full);
    }
    return found;
  };
  return walk(dir);
};

/** 从文件名就能拿到的 id：Claude 是无后缀 uuid，Codex 的 rollout 名里也带 uuid。 */
export function idFromFileName(source, file) {
  const name = path.basename(String(file ?? ''));
  if (source === 'claude') {
    const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu.exec(name);
    return match ? match[1].toLowerCase() : '';
  }
  if (source === 'codex') {
    const ids = [...name.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu)];
    return ids[0]?.[0]?.toLowerCase() ?? '';
  }
  return '';
}

/** 一行一个 JSON；坏行跳过，不让写到一半的行作废整个头部。 */
function* rowsOf(text) {
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed);
    } catch { /* 半行跳过 */ }
  }
}

/** 读普通文件的头：只读固定字节数，不整段读。 */
const readPlainHead = async (file, bytes) => {
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
};

/**
 * 流式解压 zstd 的头部：只读一段压缩流，解出够用的开头就停。
 * 这是「大文件不整段读」的关键：不把整份 .jsonl.zst 读进内存再解压。
 */
const readCompressedHead = (file, bytes) => new Promise((resolve) => {
  if (typeof zlib.createZstdDecompress !== 'function') {
    resolve('');
    return;
  }
  let source = null;
  let inflater = null;
  let done = false;
  let text = '';
  const finish = (value) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { source?.destroy(); } catch { /* 已关 */ }
    try { inflater?.destroy(); } catch { /* 已关 */ }
    resolve(String(value ?? '').slice(0, bytes));
  };
  const timer = setTimeout(() => finish(text), DECOMPRESS_TIMEOUT_MS);
  try {
    source = fs.createReadStream(file, {
      start: 0,
      end: Math.max(0, Math.min(COMPRESSED_HEAD_BYTES, 8 * 1024 * 1024) - 1)
    });
    inflater = zlib.createZstdDecompress();
  } catch {
    finish('');
    return;
  }
  source.on('error', () => finish(text));
  inflater.on('error', () => finish(text));
  inflater.on('data', (chunk) => {
    text += chunk.toString('utf8');
    if (text.length >= bytes) finish(text);
  });
  inflater.on('end', () => finish(text));
  source.pipe(inflater);
});

const readHead = async (file, bytes) => (
  /\.zst$/iu.test(file) ? readCompressedHead(file, bytes) : readPlainHead(file, bytes)
);

const clip = (text, limit = 64) => {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (!flat) return '';
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
};

const textOfBlocks = (content, { textTypes } = {}) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (typeof block?.text !== 'string') continue;
    const type = String(block?.type ?? '');
    if (type && !textTypes.includes(type) && !/text$/u.test(type)) continue;
    parts.push(block.text);
  }
  return parts.join('\n');
};

const isoAt = (value, fallback) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    try { return new Date(value).toISOString(); } catch { /* 落到兜底 */ }
  }
  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
    return value.trim();
  }
  if (typeof fallback === 'number' && Number.isFinite(fallback)) {
    try { return new Date(fallback).toISOString(); } catch { /* 下面兜底 */ }
  }
  return '';
};

/**
 * 读 Codex 头部：session_meta 给 id / cwd / 时间，前几条对话给标题与轮数。
 * 返回的字段全是元信息，没有 body。
 */
export function readCodexIndex(text) {
  let meta = null;
  let title = '';
  let turns = 0;
  for (const row of rowsOf(text)) {
    if (row?.type === 'session_meta' && row.payload && !meta) {
      meta = {
        id: String(row.payload.id ?? row.payload.session_id ?? ''),
        cwd: String(row.payload.cwd ?? ''),
        at: row.payload.timestamp ?? row.timestamp
      };
      continue;
    }
    if (row?.type !== 'response_item' || !row.payload) continue;
    if (row.payload.type !== 'message') continue;
    const role = String(row.payload.role ?? '').toLowerCase();
    if (role !== 'user' && role !== 'assistant') continue;
    const body = clip(textOfBlocks(row.payload.content, { textTypes: ['text', 'input_text', 'output_text'] }));
    if (!body) continue;
    // 首条 user 往往是环境说明（<environment_context>），不算一轮、也不当标题。
    if (body.startsWith('<')) continue;
    turns += 1;
    if (role === 'user' && !title) title = body;
  }
  if (!meta || !meta.cwd) return null;
  return { ...meta, title, turns };
}

/** 读 Claude Code 头部：cwd / sessionId / slug 在行上，前几条对话给出标题与轮数。 */
export function readClaudeIndex(text) {
  let id = '';
  let cwd = '';
  let slug = '';
  let at = '';
  let title = '';
  let turns = 0;
  for (const row of rowsOf(text)) {
    if (!row || typeof row !== 'object') continue;
    // 子代理往来不是 Owner 的主会话。
    if (row.isSidechain === true) continue;
    if (!id && row.sessionId) id = String(row.sessionId);
    if (!cwd && row.cwd) cwd = String(row.cwd);
    if (!slug && row.slug) slug = String(row.slug);
    if (!at && row.timestamp) at = row.timestamp;
    if (row.type !== 'user' && row.type !== 'assistant') continue;
    const body = clip(textOfBlocks(row.message?.content, { textTypes: ['text'] }));
    if (!body) continue;
    turns += 1;
    if (row.type === 'user' && !title) title = body;
  }
  if (!cwd) return null;
  // slug 是人类可读的会话名；没有首条对话时拿它兜底，比空标题好定位。
  return { id, cwd, slug, at, title: title || clip(slug), turns };
}

/** 项目名：先按已登记项目匹配工作目录，匹配不到就用目录名。 */
const projectLabel = (cwd, projects) => {
  const matched = matchProjectForCwd(cwd, projects);
  if (matched?.name) return String(matched.name);
  return baseName(cwd);
};

const makeItem = ({ source, id, file, meta, mtimeMs, projects }) => {
  const finalId = String(meta?.id || id || '').trim();
  const cwd = String(meta?.cwd ?? '').trim();
  if (!finalId && !cwd) return null;
  const at = isoAt(meta?.at, mtimeMs);
  const fallback = baseName(cwd) ? `无标题会话 · ${baseName(cwd)}` : '无标题会话';
  return {
    source,
    id: finalId,
    title: clip(meta?.title) || fallback,
    at,
    turns: Number.isInteger(meta?.turns) && meta.turns > 0 ? meta.turns : 0,
    project: projectLabel(cwd, projects),
    // 只在后端匹配时用；界面拿到的指针不含工作目录之外的正文。
    cwd
  };
};

const matchesClue = (item, clue) => {
  if (clue.kind === 'id') {
    return String(item.id).toLowerCase() === clue.value.toLowerCase();
  }
  if (clue.kind !== 'keyword') return false;
  const needle = norm(clue.value);
  const haystack = [item.id, item.title, item.project, item.cwd]
    .map(norm)
    .join('\n');
  return haystack.includes(needle);
};

/** 一个来源的落地目录不存在时也回一条原因：空列表与「读不出来」要能区分。 */
const readFileSource = async ({ source, dir, projects, clue, limit, maxScan, headBytes }) => {
  const items = [];
  const reasons = [];
  const files = await listSessionFiles(dir, source);
  if (files.length === 0) {
    reasons.push(`${SOURCE_LABELS[source]} 没有扫到会话（${dir}）`);
    return { items, reasons };
  }
  const entries = [];
  for (const file of files) {
    try {
      const info = await fs.promises.stat(file);
      entries.push({
        file,
        id: idFromFileName(source, file),
        mtime: info.mtimeMs,
        size: info.size
      });
    } catch {
      // 单个文件读不到不影响整批；原因在空列表时统一给。
    }
  }
  entries.sort((a, b) => (b.mtime - a.mtime) || a.file.localeCompare(b.file));

  // id 线索优先用文件名过滤：命中再读头，不为一个 id 扫全库。
  const idFiltered = clue.kind === 'id'
    ? entries.filter((entry) => String(entry.id).toLowerCase() === clue.value.toLowerCase())
    : entries;
  const candidates = idFiltered.slice(0, clue.kind === 'id' ? Math.min(maxScan, 20) : maxScan);
  if (clue.kind === 'id' && candidates.length === 0) return { items, reasons };

  const wanted = clue.kind === 'keyword' ? Math.min(maxScan, limit * 4) : limit;
  for (const entry of candidates) {
    const text = await readHead(entry.file, headBytes);
    if (!text) continue;
    const meta = source === 'codex' ? readCodexIndex(text) : readClaudeIndex(text);
    if (!meta) continue;
    const item = makeItem({ source, id: entry.id, file: entry.file, meta, mtimeMs: entry.mtime, projects });
    if (!item) continue;
    if (clue.value && !matchesClue(item, clue)) continue;
    items.push(item);
    if (items.length >= wanted) break;
  }
  return { items, reasons };
};

/** OpenCode：只读查 session 元信息 + 计数，不碰消息正文。拿不到 sqlite 就降级说明。 */
const readOpenCodeSource = ({ dbPath, projects, clue, limit, maxScan }) => {
  const items = [];
  const reasons = [];
  if (!dbPath || !fs.existsSync(dbPath)) {
    reasons.push(`OpenCode 会话库不在本机（${dbPath || '未配置'}）`);
    return { items, reasons };
  }
  let DatabaseSync = null;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    reasons.push('这个运行时没有 node:sqlite，读不了 OpenCode 会话库；仍可用线索让 Agent 去检索');
    return { items, reasons };
  }
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const hasV2 = Boolean(db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='session_v2'"
    ).get());
    const table = hasV2 ? 'session_v2' : 'session';
    const hasSessionMessage = Boolean(db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='session_message'"
    ).get());
    const turnsExpr = hasSessionMessage
      ? "(SELECT COUNT(*) FROM session_message m WHERE m.session_id=s.id AND m.type IN ('user','assistant'))"
      : "(SELECT COUNT(*) FROM message m WHERE m.session_id=s.id)";
    const where = clue.kind === 'id' ? 'AND s.id=?' : '';
    const sql = `
      SELECT s.id, s.title, s.directory, s.time_updated, ${turnsExpr} AS turns
      FROM ${table} s
      WHERE s.parent_id IS NULL ${where}
      ORDER BY s.time_updated DESC
      LIMIT ?
    `;
    const scanLimit = clue.kind === 'id' ? Math.min(maxScan, 20) : maxScan;
    const args = clue.kind === 'id' ? [clue.value, scanLimit] : [scanLimit];
    const rows = db.prepare(sql).all(...args);
    for (const row of rows) {
      const item = makeItem({
        source: 'opencode',
        id: row.id,
        file: '',
        meta: {
          id: row.id,
          cwd: row.directory,
          title: row.title,
          at: row.time_updated,
          turns: Number(row.turns) || 0
        },
        mtimeMs: row.time_updated,
        projects
      });
      if (!item) continue;
      if (clue.value && !matchesClue(item, clue)) continue;
      items.push(item);
      const cap = clue.kind === 'keyword' ? Math.min(maxScan, limit * 4) : limit;
      if (items.length >= cap) break;
    }
  } catch (error) {
    reasons.push(`OpenCode 会话库读不出来：${error?.message || '未知原因'}`);
  } finally {
    try { db?.close(); } catch { /* 已关 */ }
  }
  return { items, reasons };
};

/**
 * 列出 / 搜索会话指针。
 * @param {object} input
 * @param {{codex?: string, claude?: string, opencodeDb?: string}} [input.roots] 三个来源的落点
 * @param {Array<{id:string,name:string,root:string}>} [input.projects] 已登记项目（用于「所属项目」）
 * @param {string} [input.source] 只看一个来源；空串表示全部
 * @param {string} [input.clue] 自定义线索（id / 关键词 / 路径）
 * @param {number} [input.limit] 返回条数上限
 * @param {number} [input.maxScan] 最多读多少个文件头
 * @param {number} [input.headBytes] 头部窗口大小
 */
export async function listSessionPointers({
  roots = {},
  projects = [],
  source = '',
  clue = '',
  limit = DEFAULTS.limit,
  maxScan = DEFAULTS.maxScan,
  headBytes = DEFAULTS.headBytes
} = {}) {
  const clueInfo = classifyClue(clue);
  const hasClue = clue !== undefined && clue !== null && String(clue).length > 0;
  const wanted = POINTER_SOURCES.filter((key) => !source || key === source);
  // 线索是无效的：不去读盘，直接让调用方给明确失败（没填线索不是无效，是列最近会话）。
  if (hasClue && clueInfo.kind === 'unusable') {
    return { items: [], reasons: [clueInfo.reason], clueKind: clueInfo.kind, counts: {} };
  }
  const filter = hasClue ? clueInfo : { kind: 'recent', value: '' };
  const safeLimit = Math.min(Math.max(1, Number(limit) || DEFAULTS.limit), 50);
  const safeScan = Math.min(Math.max(1, Number(maxScan) || DEFAULTS.maxScan), 500);
  const safeHead = Math.min(Math.max(4 * 1024, Number(headBytes) || HEAD_BYTES), 512 * 1024);
  const items = [];
  const reasons = [];
  const counts = {};

  for (const key of wanted) {
    if (key === 'opencode') {
      const result = readOpenCodeSource({
        dbPath: roots.opencodeDb,
        projects,
        clue: filter,
        limit: safeLimit,
        maxScan: safeScan
      });
      counts.opencode = result.items.length;
      items.push(...result.items);
      reasons.push(...result.reasons);
      continue;
    }
    const result = await readFileSource({
      source: key,
      dir: roots[key] ?? '',
      projects,
      clue: filter,
      limit: safeLimit,
      maxScan: safeScan,
      headBytes: safeHead
    });
    counts[key] = result.items.length;
    items.push(...result.items);
    reasons.push(...result.reasons);
  }

  // 去重：同一来源同一个会话只留一条（多个来源同 id 也不合并，来源不同就是不同指针）。
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const key = `${item.source}:${item.id || item.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  unique.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const cap = filter.value ? Math.min(safeLimit, DEFAULTS.maxClueMatches) : safeLimit;
  return {
    items: unique.slice(0, cap),
    reasons,
    clueKind: hasClue ? clueInfo.kind : '',
    counts
  };
}
