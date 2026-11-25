import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { probeProject, readCommitList, readWorkingTreeChanges } from '../src/observer/probe.mjs';
import { git, makeRepo, makeTempDir, statusText, treeDigest, writeFiles } from './helpers/observer-fixture.mjs';

const withDir = async (fn) => {
  const dir = makeTempDir();
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

test('探针读取干净仓库的 HEAD、分支、最后提交时间与 Manifest 摘要，且不修改被观察仓库', () => withDir(async (dir) => {
  const root = makeRepo({
    root: path.join(dir, 'clean'),
    commitAt: '2026-11-20T09:00:00+08:00',
    files: {
      'package.json': JSON.stringify({
        name: 'observer-clean',
        dependencies: { left: '1.0.0' },
        devDependencies: { right: '2.0.0' },
        scripts: { test: 'node --test', build: 'node build.mjs' }
      })
    }
  });
  const beforeTree = treeDigest(root);
  const beforeStatus = statusText(root);

  const snapshot = probeProject({ projectId: 'obs-clean', projectName: 'Clean', root });

  assert.equal(snapshot.projectId, 'obs-clean');
  assert.equal(snapshot.branch, 'main');
  assert.equal(snapshot.hasCommits, true);
  assert.match(snapshot.head, /^[0-9a-f]{40}$/);
  assert.equal(snapshot.lastCommitAt, '2026-11-20T09:00:00+08:00');
  assert.equal(snapshot.uncommittedFiles, 0);
  assert.deepEqual(snapshot.manifest, {
    packageName: 'observer-clean',
    isWorkspace: false,
    dependencyCount: 2,
    scriptNames: ['build', 'test']
  });

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

test('Manifest 摘要：workspace 仓库、缺失或损坏的 package.json 都不报错', () => withDir(async (dir) => {
  const monorepo = makeRepo({
    root: path.join(dir, 'monorepo'),
    commitAt: '2026-11-20T09:00:00+08:00',
    files: {
      'package.json': JSON.stringify({
        name: 'root',
        workspaces: ['packages/*'],
        scripts: { lint: 'eslint .' },
        dependencies: { a: '1.0.0', b: '1.0.0' },
        devDependencies: { c: '1.0.0' }
      })
    }
  });
  const plain = makeRepo({ root: path.join(dir, 'no-manifest'), commitAt: '2026-11-20T09:00:00+08:00' });
  const broken = makeRepo({
    root: path.join(dir, 'broken-manifest'),
    commitAt: '2026-11-20T09:00:00+08:00',
    files: { 'package.json': '{not json' }
  });

  assert.deepEqual(probeProject({ projectId: 'obs-mono', root: monorepo }).manifest, {
    packageName: 'root',
    isWorkspace: true,
    dependencyCount: 3,
    scriptNames: ['lint']
  });
  const empty = { packageName: null, isWorkspace: false, dependencyCount: 0, scriptNames: [] };
  assert.deepEqual(probeProject({ projectId: 'obs-no-manifest', root: plain }).manifest, empty);
  assert.deepEqual(probeProject({ projectId: 'obs-broken-manifest', root: broken }).manifest, empty);
}));

test('探针在 detached HEAD 上不崩溃，并保留最后提交信息', () => withDir(async (dir) => {
  const root = makeRepo({ root: path.join(dir, 'detached'), commitAt: '2026-11-20T09:00:00+08:00' });
  git(root, ['checkout', '-q', '--detach', 'HEAD']);

  const snapshot = probeProject({ projectId: 'obs-detached', root });

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
  assert.equal(snapshot.manifest.isWorkspace, true);
}));

// ---- #84：变化窗口需要的两份清单（probeProject 只有计数与最后提交时间，回答不了「哪几条 / 哪些文件」）----

test('#84 提交清单：逐条给 sha / 作者 / 时间 / 标题，最新在前', () => withDir(async (dir) => {
  const root = makeRepo({ root: path.join(dir, 'commits'), commitAt: '2026-11-20T09:00:00+08:00' });
  fs.writeFileSync(path.join(root, 'a'), 'second\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', '第二条提交'], { GIT_AUTHOR_DATE: '2026-11-21T10:00:00+08:00', GIT_COMMITTER_DATE: '2026-11-21T10:00:00+08:00' });

  const commits = readCommitList({ root });

  assert.equal(commits.length, 2);
  assert.equal(commits[0].subject, '第二条提交');
  assert.equal(commits[0].at, '2026-11-21T10:00:00+08:00');
  assert.match(commits[0].sha, /^[0-9a-f]{40}$/);
  assert.equal(commits[0].author, 'Observer Test');
  assert.equal(commits[1].subject, 'init');
  // 只读：读清单不改仓库。
  assert.equal(statusText(root), '');
}));

test('#84 提交清单读不到时返回 null（无提交历史 / 目录不存在），不返回空清单', () => withDir(async (dir) => {
  const unborn = path.join(dir, 'unborn');
  fs.mkdirSync(unborn, { recursive: true });
  git(unborn, ['init', '-q', '-b', 'main']);
  assert.equal(readCommitList({ root: unborn }), null);
  // 目录不存在时 git 直接失败：同样按「读不到」而不是「没有提交」处理。
  assert.equal(readCommitList({ root: path.join(dir, 'missing-repo') }), null);
}));

test('#84 未提交改动清单：按文件给状态码与路径，读不到时返回 null', () => withDir(async (dir) => {
  const root = makeRepo({ root: path.join(dir, 'working'), commitAt: '2026-11-20T09:00:00+08:00' });
  fs.writeFileSync(path.join(root, 'a'), 'changed\n');
  writeFiles(root, { 'src/new-file.txt': 'untracked\n' });

  const changes = readWorkingTreeChanges({ root });

  assert.deepEqual(changes.map((item) => item.path).sort(), ['a', 'src/new-file.txt']);
  assert.deepEqual(changes.map((item) => item.status).sort(), ['??', 'M']);
  assert.equal(readWorkingTreeChanges({ root: path.join(dir, 'missing-worktree') }), null);
}));
