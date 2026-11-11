// 读取当前任务消息里的图片附件（best-effort）。
//
// 钩子只给文本，图片在 Cindy 的消息库里：messages.content.images 存
// `cindy-media://blobs/<hash>.<ext>`，实际字节在 <profile>/cindy-media/blobs/<前两位>/<hash>.<ext>。
// 这里只读、只取当前任务、只取最近一段时间的图片；数据库路径找不到就安静地跳过。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_IMAGES = 4;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;

let cachedProfile = null;

const candidates = () => {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  try {
    return fs.readdirSync(base)
      .filter((name) => name.startsWith('Cindy'))
      .map((name) => path.join(base, name))
      .filter((dir) => fs.existsSync(path.join(dir, 'cindy-local-v1.db')));
  } catch {
    return [];
  }
};

/** 找到包含该任务的 Cindy profile；结果缓存。 */
const profileFor = async (sessionId) => {
  if (cachedProfile && fs.existsSync(path.join(cachedProfile, 'cindy-local-v1.db'))) return cachedProfile;
  let sqlite = null;
  try { sqlite = await import('node:sqlite'); } catch { return null; }
  const DatabaseSync = sqlite.DatabaseSync;
  const dirs = candidates().sort((a, b) => {
    try {
      return fs.statSync(path.join(b, 'cindy-local-v1.db')).mtimeMs
        - fs.statSync(path.join(a, 'cindy-local-v1.db')).mtimeMs;
    } catch {
      return 0;
    }
  });
  for (const dir of dirs) {
    let db = null;
    try {
      db = new DatabaseSync(path.join(dir, 'cindy-local-v1.db'), { readOnly: true });
      const row = db.prepare('SELECT 1 AS ok FROM messages WHERE session_id = ? LIMIT 1').get(String(sessionId));
      if (row?.ok === 1) {
        cachedProfile = dir;
        return dir;
      }
    } catch {
      // 打不开就试下一个 profile。
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }
  return null;
};

const blobPath = (profile, url) => {
  const match = /^cindy-media:\/\/blobs\/([a-f0-9]+)\.([a-z0-9]+)$/iu.exec(String(url ?? ''));
  if (!match) return null;
  const [, hash, ext] = match;
  return path.join(profile, 'cindy-media', 'blobs', hash.slice(0, 2), `${hash}.${ext}`);
};

/** 列出某任务在 since 之后消息里的图片（元数据，不含字节）。 */
export const listAttachments = async ({ sessionId, since = '' }) => {
  const profile = await profileFor(sessionId);
  if (!profile) return { supported: false, items: [] };
  const sqlite = await import('node:sqlite');
  const DatabaseSync = sqlite.DatabaseSync;
  const sinceMs = Number(new Date(since)) || 0;
  let db = null;
  try {
    db = new DatabaseSync(path.join(profile, 'cindy-local-v1.db'), { readOnly: true });
    const rows = db.prepare(
      'SELECT role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC'
    ).all(String(sessionId));
    const items = [];
    for (const row of rows) {
      if (sinceMs && Number(row.created_at) + 1000 < sinceMs) continue;
      let content = null;
      try { content = JSON.parse(row.content); } catch { continue; }
      const images = Array.isArray(content?.images) ? content.images : [];
      for (const image of images) {
        const file = blobPath(profile, image?.url);
        if (!file || !fs.existsSync(file)) continue;
        const stat = fs.statSync(file);
        items.push({
          hash: path.basename(file).split('.')[0],
          name: String(image?.originalName || path.basename(file)).slice(0, 80),
          mime: String(image?.mimeType || 'image/png'),
          bytes: stat.size,
          path: file,
          role: row.role === 'assistant' ? 'assistant' : 'user'
        });
      }
    }
    return { supported: true, items: items.slice(0, MAX_IMAGES) };
  } catch {
    return { supported: false, items: [] };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
};

/** 读取图片字节并转成 Host 需要的 base64 数组。 */
export const readAttachments = async ({ sessionId, since = '' }) => {
  const listed = await listAttachments({ sessionId, since });
  const picked = [];
  let total = 0;
  for (const item of listed.items) {
    const size = item.bytes;
    if (!size || total + size > MAX_TOTAL_BYTES) continue;
    try {
      const base64 = fs.readFileSync(item.path).toString('base64');
      picked.push({ base64, name: item.name, mime: item.mime });
      total += size;
    } catch {
      // 单张读失败不影响其它图片。
    }
  }
  return { supported: listed.supported, attachments: picked, bytes: total };
};
