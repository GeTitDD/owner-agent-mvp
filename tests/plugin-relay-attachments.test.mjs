// Relay 图片附件：从本机 Cindy 消息库只读查找当前任务的图片并读取字节。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { listAttachments, readAttachments } from '../plugins/cindy-relay/node/lib/attachments.mjs';

const HASH = 'a'.repeat(64);
const SESSION = 'session-images';

test('relay 附件：从 Cindy 消息库和 blobs 读取图片', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-attach-'));
  const profile = path.join(root, 'CindyTest');
  const previous = process.env.LOCALAPPDATA;
  try {
    fs.mkdirSync(path.join(profile, 'cindy-media', 'blobs', HASH.slice(0, 2)), { recursive: true });
    const blob = path.join(profile, 'cindy-media', 'blobs', HASH.slice(0, 2), `${HASH}.png`);
    const bytes = Buffer.from('fake-png-bytes');
    fs.writeFileSync(blob, bytes);

    const db = new DatabaseSync(path.join(profile, 'cindy-local-v1.db'));
    db.exec('CREATE TABLE messages (session_id TEXT, role TEXT, content TEXT, created_at INTEGER)');
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?)').run(
      SESSION,
      'user',
      JSON.stringify({
        text: '看图',
        images: [{ url: `cindy-media://blobs/${HASH}.png`, mimeType: 'image/png', originalName: 'shot.png' }]
      }),
      Date.now()
    );
    const noteFile = path.join(root, 'note.md');
    fs.writeFileSync(noteFile, '# 说明\n第二行');
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?)').run(
      SESSION,
      'user',
      JSON.stringify({ text: '看文件', images: [], files: [{ name: 'note.md', path: noteFile }] }),
      Date.now() + 1000
    );
    db.close();

    process.env.LOCALAPPDATA = root;
    const listed = await listAttachments({ sessionId: SESSION });
    assert.equal(listed.supported, true);
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].name, 'shot.png');
    assert.equal(listed.items[0].bytes, bytes.length);

    assert.equal(listed.files.length, 1);
    assert.equal(listed.files[0].name, 'note.md');
    assert.equal(listed.files[0].text, true);

    const read = await readAttachments({ sessionId: SESSION });
    assert.equal(read.attachments.length, 1);
    assert.equal(Buffer.from(read.attachments[0].base64, 'base64').toString(), 'fake-png-bytes');
    assert.equal(read.files.length, 1);
    assert.match(read.files[0].content, /# 说明/u);

    // 时间过滤：更晚的 since 不应返回旧图片。
    const later = await listAttachments({ sessionId: SESSION, since: new Date(Date.now() + 60_000).toISOString() });
    assert.equal(later.items.length, 0);

    // 别的任务没有图片。
    const other = await listAttachments({ sessionId: 'another-session' });
    assert.equal(other.items.length, 0);
  } finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
