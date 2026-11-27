// 首次使用的信任边界：登记不碰项目；草稿按会话和视图项目隔离，重启后仍在。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { OwnerStore } from '../src/owner-store.mjs';
import { ChatSessionStore } from '../src/chat-sessions.mjs';
import { rootIdentityOf, verifyProjectRoot } from '../src/project-identity.mjs';
import { sha256 } from '../src/utils.mjs';

const fixture = (run) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-first-use-'));
  const file = path.join(dir, 'data', 'owner.sqlite');
  const owner = new OwnerStore(file);
  const a = path.join(dir, 'project-a');
  const b = path.join(dir, 'project-b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  try { return run({ dir, file, owner, a, b }); } finally {
    owner.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('登记干净 Git 仓库不新增文件，不改内容和 Git 状态', () => fixture(({ owner, a }) => {
  execFileSync('git', ['init', '--quiet'], { cwd: a });
  const before = fs.readdirSync(a);
  const status = () => execFileSync('git', ['status', '--porcelain'], { cwd: a, encoding: 'utf8' });
  assert.equal(status(), '');
  const project = owner.registerProject({ id: 'a', name: '演示项目', root: a });
  assert.deepEqual(fs.readdirSync(a), before);
  assert.equal(status(), '');
  assert.match(project.root_identity, /^dir-v1:/u);
  assert.equal(verifyProjectRoot(project).ok, true);
}));

test('目录身份在普通编辑后不变，替换目录仍会被拒绝', () => fixture(({ dir, owner, a }) => {
  const project = owner.registerProject({ id: 'a', name: 'A', root: a });
  fs.writeFileSync(path.join(a, 'README.md'), '普通编辑');
  assert.equal(rootIdentityOf(a), project.root_identity);
  assert.equal(verifyProjectRoot(project).ok, true);
  const backup = path.join(dir, 'backup');
  fs.renameSync(a, backup);
  assert.equal(rootIdentityOf(backup), project.root_identity);
  fs.mkdirSync(a);
  assert.deepEqual(verifyProjectRoot(project), { ok: false, reason: 'project-root-moved' });
}));

test('旧项目仍能只读校验原标记，打开时不重写或删除它', () => fixture(({ a }) => {
  const marker = path.join(a, '.owner-root-identity');
  fs.writeFileSync(marker, '历史标记');
  const stat = fs.statSync(marker, { bigint: true });
  const project = { root: fs.realpathSync(a), root_identity: sha256(`${stat.dev}:${stat.ino}`).slice(0, 32) };
  assert.equal(verifyProjectRoot(project).ok, true);
  assert.equal(fs.readFileSync(marker, 'utf8'), '历史标记');
  fs.unlinkSync(marker);
  assert.equal(verifyProjectRoot(project).ok, false);
}));

test('草稿保留空白，按会话与项目隔离，不生成消息或改变项目范围', () => fixture(({ owner, a, b }) => {
  owner.registerProject({ id: 'a', name: 'A', root: a });
  owner.registerProject({ id: 'b', name: 'B', root: b });
  const chats = new ChatSessionStore({ db: owner.db });
  const first = chats.createSession({ projectId: 'a' });
  const second = chats.createSession({ projectId: 'b' });
  const text = '  仅发给 A 的草稿\n第二行  ';
  chats.saveDraft({ id: first.id, projectId: 'a', text, skillId: 'domain:retries' });
  assert.equal(chats.getDraft({ id: second.id, projectId: 'b' }).text, '');
  assert.equal(chats.getDraft({ id: first.id, projectId: 'b' }).text, '');
  assert.equal(chats.getDraft({ id: first.id, projectId: 'a' }).text, text);
  chats.saveDraft({ id: first.id, projectId: 'a', text: '发送期间写的新草稿' });
  assert.equal(chats.clearDraft({ id: first.id, projectId: 'a', text, skillId: 'domain:retries' }).cleared, false);
  assert.equal(chats.getDraft({ id: first.id, projectId: 'a' }).text, '发送期间写的新草稿');
  chats.saveDraft({ id: first.id, projectId: 'a', text, skillId: 'domain:retries' });
  assert.equal(chats.getSession(first.id).messageCount, 0);
  assert.equal(chats.getSession(first.id).viewProjectId, 'a');
  const reopened = new OwnerStore(owner.dbPath);
  try {
    const again = new ChatSessionStore({ db: reopened.db });
    assert.equal(again.getDraft({ id: first.id, projectId: 'a' }).text, text);
    assert.equal(again.getDraft({ id: first.id, projectId: 'a' }).skillId, 'domain:retries');
  } finally { reopened.close(); }
  chats.saveDraft({ id: first.id, projectId: 'a', text: '' });
  assert.equal(chats.getDraft({ id: first.id, projectId: 'a' }).text, '');
}));

test('草稿拒绝未知会话、未知项目、非法字符和过长内容', () => fixture(({ owner }) => {
  const chats = new ChatSessionStore({ db: owner.db });
  const session = chats.createSession();
  assert.throws(() => chats.saveDraft({ id: 'missing', text: 'x' }), /会话不存在/u);
  assert.throws(() => chats.saveDraft({ id: session.id, projectId: 'missing', text: 'x' }), /项目不存在/u);
  assert.throws(() => chats.saveDraft({ id: session.id, text: '\u0000' }), /非法字符/u);
  assert.throws(() => chats.saveDraft({ id: session.id, text: 'x'.repeat(16001) }), /最多/u);
  assert.equal(chats.getDraft({ id: session.id }).text, '');
}));

test('首次选项目复用空会话；任何已有输入或自定义会话均保留', () => fixture(({ owner, a }) => {
  owner.registerProject({ id: 'a', name: 'A', root: a });
  const chats = new ChatSessionStore({ db: owner.db });
  const empty = chats.createSession();
  const reused = chats.createSession({ projectId: 'a', reuseEmptyGlobalId: empty.id });
  assert.equal(reused.id, empty.id);
  assert.equal(reused.projectId, 'a');
  for (const variant of ['draft', 'message', 'title', 'pin']) {
    const current = chats.createSession();
    if (variant === 'draft') chats.saveDraft({ id: current.id, text: '保留我的输入' });
    if (variant === 'message') chats.appendMessage({ sessionId: current.id, role: 'user', text: '保留我的消息' });
    if (variant === 'title') chats.renameSession(current.id, '自己命名的会话');
    if (variant === 'pin') chats.setPinned(current.id, true);
    const created = chats.createSession({ projectId: 'a', reuseEmptyGlobalId: current.id });
    assert.notEqual(created.id, current.id, variant);
    assert.equal(chats.getSession(current.id).projectId, '');
  }
}));
