import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { probeProject } from '../src/observer/probe.mjs';
import { git, makeRepo, makeTempDir, statusText, treeDigest, writeFiles } from './helpers/observer-fixture.mjs';

const withDir = async (fn) => {
  const dir = makeTempDir();
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

test('探针读取干净仓库的 HEAD、分支与最后提交时间，且不修改被观察仓库', () => withDir(async (dir) => {
  const root = makeRepo({ root: path.join(dir, 'clean'), commitAt: '2026-11-20T09:00:00+08:00' });
  const beforeTree = treeDigest(root);
  const beforeStatus = statusText(root);

  const snapshot = probeProject({ projectId: 'obs-clean', projectName: 'Clean', root });

  assert.equal(snapshot.projectId, 'obs-clean');
  assert.equal(snapshot.branch, 'main');
  assert.equal(snapshot.detached, false);
  assert.equal(snapshot.hasCommits, true);
  assert.match(snapshot.head, /^[0-9a-f]{40}$/);
  assert.equal(snapshot.lastCommitAt, '2026-11-20T09:00:00+08:00');
  assert.equal(snapshot.uncommittedFiles, 0);
  assert.equal(snapshot.hasRemote, false);

  assert.equal(statusText(root), beforeStatus);
  assert.equal(treeDigest(root), beforeTree);
}));

test('探针在有未提交改动的仓库上统计改动文件数', () => withDir(async (dir) => {
  const root = makeRepo({ root: path.join(dir, 'dirty'), commitAt: '2026-11-20T09:00:00+08:00' });
  fs.writeFileSync(path.join(root, 'a'), 'changed\n');
  writeFiles(root, { 'new-file.txt': 'untracked\n' });

  const snapshot = probeProject({ projectId: 'obs-dirty', root });

  assert.equal(snapshot.uncommittedFiles, 2);
  assert.equal(snapshot.hasCommits, true);
}));

test('探针在无 remote 的仓库上报告未配置远端', () => withDir(async (dir) => {
  const root = makeRepo({ root: path.join(dir, 'no-remote'), commitAt: '2026-11-20T09:00:00+08:00' });
  const withRemote = makeRepo({
    root: path.join(dir, 'with-remote'),
    commitAt: '2026-11-20T09:00:00+08:00',
    remote: 'https://example.invalid/observer.git'
  });

  assert.equal(probeProject({ projectId: 'obs-no-remote', root }).hasRemote, false);
  assert.equal(probeProject({ projectId: 'obs-with-remote', root: withRemote }).hasRemote, true);
}));

test('探针在 detached HEAD 上不崩溃，并保留最后提交信息', () => withDir(async (dir) => {
  const root = makeRepo({ root: path.join(dir, 'detached'), commitAt: '2026-11-20T09:00:00+08:00' });
  git(root, ['checkout', '-q', '--detach', 'HEAD']);

  const snapshot = probeProject({ projectId: 'obs-detached', root });

  assert.equal(snapshot.detached, true);
  assert.equal(snapshot.branch, null);
  assert.equal(snapshot.hasCommits, true);
  assert.equal(snapshot.lastCommitAt, '2026-11-20T09:00:00+08:00');
}));

test('探针在无提交历史的仓库上不崩溃', () => withDir(async (dir) => {
  const root = path.join(dir, 'empty');
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init', '-q', '-b', 'main']);

  const snapshot = probeProject({ projectId: 'obs-empty', root });

  assert.equal(snapshot.hasCommits, false);
  assert.equal(snapshot.head, null);
  assert.equal(snapshot.lastCommitAt, null);
  assert.equal(snapshot.branch, 'main');
  assert.equal(snapshot.uncommittedFiles, 0);
}));

test('探针在多包仓库上不崩溃', () => withDir(async (dir) => {
  const root = makeRepo({
    root: path.join(dir, 'monorepo'),
    commitAt: '2026-11-20T09:00:00+08:00',
    files: {
      'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
      'packages/a/package.json': JSON.stringify({ name: 'a' }),
      'packages/b/package.json': JSON.stringify({ name: 'b' })
    }
  });

  const snapshot = probeProject({ projectId: 'obs-monorepo', root });

  assert.equal(snapshot.branch, 'main');
  assert.equal(snapshot.hasCommits, true);
  assert.equal(snapshot.uncommittedFiles, 0);
}));
