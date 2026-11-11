// 读取当前任务消息里的图片附件（best-effort）。
//
// 钩子只给文本，图片在 Cindy 的消息库里：messages.content.images 存
// `cindy-media://blobs/<hash>.<ext>`，实际字节在 <profile>/cindy-media/blobs/<前两位>/<hash>.<ext>。
// 这里只读、只取当前任务、只取最近一段时间的图片；数据库路径找不到就安静地跳过。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_IMAGES = 4;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_FILES = 10;
const MAX_FILE_TEXT = 64 * 1024;
const MAX_FILE_TEXT_TOTAL = 48000;
const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.csv', '.tsv', '.log',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.ps1', '.sh', '.bat', '.cmd', '.css',
  '.html', '.htm', '.xml', '.sql', '.ini', '.cfg', '.conf', '.env'
]);

const localPath = (value) => {
  const raw = String(value ?? '');
  if (/^[a-z]:[\\/]/iu.test(raw)) return raw;
  if (raw.startsWith('file://')) {
    try { return fileURLToPath(raw); } catch { return ''; }
  }
  return '';
};

const isTextFile = (file) => TEXT_EXT.has(path.extname(file).toLowerCase());

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
    const files = [];
    const seenFiles = new Set();
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
      const attached = Array.isArray(content?.files) ? content.files : [];
      for (const entry of attached) {
        const file = localPath(entry?.path) || localPath(entry?.url);
        if (!file || seenFiles.has(file) || !fs.existsSync(file)) continue;
        let stat = null;
        try { stat = fs.statSync(file); } catch { continue; }
        if (!stat.isFile()) continue;
        seenFiles.add(file);
        files.push({
          name: String(entry?.name || entry?.originalName || path.basename(file)).slice(0, 80),
          path: file,
          bytes: stat.size,
          text: isTextFile(file) && stat.size <= MAX_FILE_TEXT
        });
      }
    }
    return { supported: true, items: items.slice(0, MAX_IMAGES), files: files.slice(0, MAX_FILES) };
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
  let textTotal = 0;
  const files = [];
  for (const file of listed.files ?? []) {
    const entry = { name: file.name, path: file.path, bytes: file.bytes, text: false, content: '' };
    if (file.text && textTotal < MAX_FILE_TEXT_TOTAL) {
      try {
        const content = fs.readFileSync(file.path, 'utf8').slice(0, MAX_FILE_TEXT);
        entry.content = content.slice(0, MAX_FILE_TEXT_TOTAL - textTotal);
        entry.text = true;
        textTotal += entry.content.length;
      } catch {
        // 读不了就当二进制文件，只给路径。
      }
    }
    files.push(entry);
  }
  return { supported: listed.supported, attachments: picked, files, bytes: total };
};
