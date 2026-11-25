// 会话采集器（#120）：只从水位之后数新消息，只读会话文件、不改写对方会话。
//
// 复用现有实现，不另写一套 JSONL 解析：会话两种形状（Codex 的 rollout / Claude Code 的
// projects）与「哪些行算对话正文」的规则都在 memory/session-scan.mjs 里，这里只做三件事：
// 找到文件、整份读出、按水位筛片段。
//
// 为什么不把正文带进结果：采集的职责是「取到什么」（父 spec），心跳只关心水位之后多了
// 几条消息；把正文搬进状态库等于顺手存档，那需要另外的确认与脱敏路径。所以 item 只有
// 角色与时间，条数就是 items.length。
//
// 只读：用 fs.promises 的 readdir / stat / readFile，没有写、没有临时文件、没有改名。
// 会话文件是别的 Agent 正在追加的活文件，读完字节与 mtime 必须原样（测试用整棵树快照断言）。
//
// 依赖注入：deps.findSessionFile({source, sessionId}) 与 deps.readFile(file)。
// 缺省时用真实文件系统；测试注入假实现，也可以注入 deps.homeDir / deps.env / deps.roots
// 让真实读取发生在临时目录里。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { readSessionFragments, sessionRootsFrom } from '../memory/session-scan.mjs';
import { normalizeWatchTarget, WatchTargetError } from './target.mjs';
import { failedResult, isAfter, isoOf, okResult, toMillis } from './collect-result.mjs';

/** 会话根下最多往下翻几层：Codex 是 sessions/YYYY/MM/DD/file，Claude 是 projects/<cwd>/file。 */
export const SESSION_SCAN_DEPTH = 6;

const isSessionFile = (name) => /\.jsonl$/u.test(name) || /\.jsonl\.zst$/u.test(name);

/** 错误压成一行：路径与 errno 说明留着，换行去掉。 */
const describe = (error) => String(error?.message ?? error ?? '').trim().split(/\r?\n/u)[0].trim();

/**
 * 在会话根下找「文件名里带会话 id」的那一个文件。
 * 多个命中（同一会话被复制过）取修改时间最新的那个；一个都没有返回 null——
 * 不按日期猜路径，也不退回最近改动过的会话。
 *
 * @param {{source:string, sessionId:string, roots?:Array<{source:string,dir:string}>,
 *   maxDepth?:number}} input
 * @returns {Promise<{file:string, mtimeMs:number, size:number}|null>}
 */
export async function findSessionFile({
  source,
  sessionId,
  roots = sessionRootsFrom(),
  maxDepth = SESSION_SCAN_DEPTH
} = {}) {
  const id = String(sessionId ?? '').trim();
  if (!id) return null;
  const root = (Array.isArray(roots) ? roots : []).find((entry) => entry?.source === source)?.dir;
  if (!root) return null;

  const matches = [];
  const walk = async (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      // 目录不存在或没权限：按「这个来源下没有」处理，另一个来源照常找。
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isSessionFile(entry.name) || !entry.name.includes(id)) continue;
      const info = await fs.promises.stat(full).catch(() => null);
      matches.push({ file: full, mtimeMs: info?.mtimeMs ?? 0, size: info?.size ?? 0 });
    }
  };
  await walk(String(root), 1);

  matches.sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.file.localeCompare(b.file));
  return matches[0] ?? null;
}

/**
 * 缺省读取器：整份读出会话文件。Codex 新版把 rollout 压成 .jsonl.zst，用 node 内置 zlib 解，
 * 不新增依赖（与 session-scan.mjs 同一做法）。
 *
 * @param {string} file
 * @returns {Promise<string>}
 */
export const defaultReadSession = async (file) => {
  const buffer = await fs.promises.readFile(file);
  if (!/\.zst$/u.test(file)) return buffer.toString('utf8');
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('当前 Node 不支持 zstd，读不了压缩会话');
  }
  return zlib.zstdDecompressSync(buffer).toString('utf8');
};

/**
 * 采一个会话对象。
 *
 * @param {object} target 监控对象描述符（type 必须是 session）
 * @param {{since?:string|number|Date|null, now?:Date|number|string,
 *   deps?:{findSessionFile?:Function, readFile?:Function, roots?:Array, homeDir?:string, env?:object}} [options]
 * @returns {Promise<object>} 统一结果形状（见 collect-result.mjs）
 */
export async function collectSession(target, { since = null, now = new Date(), deps = {} } = {}) {
  const { type, ref, source, sessionId } = normalizeWatchTarget(target);
  if (type !== 'session') {
    throw new WatchTargetError(`会话采集器只接受 session 对象，收到 ${type}`, 'target-type-mismatch');
  }

  // roots 在缺省查找器里才算：注入 findSessionFile 时不必也不该去碰磁盘。
  const roots = deps.roots ?? sessionRootsFrom({ home: deps.homeDir, env: deps.env });
  const find = deps.findSessionFile ?? ((query) => findSessionFile({ ...query, roots }));
  const read = deps.readFile ?? defaultReadSession;

  let entry;
  try {
    entry = await find({ source, sessionId });
  } catch (error) {
    return failedResult({
      type, ref,
      code: 'session-lookup-failed',
      message: `查找 ${source} 会话 ${sessionId} 时出错：${describe(error)}`
    });
  }
  const file = typeof entry === 'string' ? entry : entry?.file;
  if (!file) {
    return failedResult({
      type, ref,
      code: 'session-not-found',
      message: `找不到 ${source} 会话 ${sessionId} 的文件`
    });
  }

  let text;
  try {
    text = await read(file);
  } catch (error) {
    return failedResult({
      type, ref,
      code: 'session-unreadable',
      message: `读不到 ${source} 会话 ${sessionId} 的文件：${describe(error)}`
    });
  }
  if (typeof text !== 'string') {
    return failedResult({
      type, ref,
      code: 'session-unreadable',
      message: `读不到 ${source} 会话 ${sessionId} 的文件：读出来的不是文本`
    });
  }

  // 半行（写到一半）由 readSessionFragments 跳过；这里只按水位留新消息。
  const sinceMs = toMillis(since);
  const items = readSessionFragments(source, text)
    .filter((fragment) => isAfter(fragment.at, sinceMs))
    .map((fragment) => ({
      kind: 'message',
      role: fragment.role,
      // 行上没有时间戳时留空串：item 说得出「不知道什么时候」，而不是假装一个时间。
      at: isoOf(toMillis(fragment.at)) ?? ''
    }));

  return okResult({ type, ref, items, now });
}
