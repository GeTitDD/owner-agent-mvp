// 补丁校验、应用与测试运行：只在受控路径与允许的命令下工作。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPatchService, validateDiff } from '../plugins/owner-companion/node/lib/patch.mjs';

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

const makeRepo = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-patch-'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  return root;
};

const diffFor = (root, file, content) => {
  fs.writeFileSync(path.join(root, file), content);
  return git(root, ['diff', '--', file]);
};

test('validateDiff 拒绝越界路径与非 git diff', () => {
  assert.throws(() => validateDiff('hello'), /git diff/u);
  assert.throws(() => validateDiff('diff --git a/../etc/passwd b/../etc/passwd\n'), /路径不合法/u);
  assert.throws(() => validateDiff('diff --git a/C:/x b/C:/x\n'), /路径不合法/u);
  const ok = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n';
  assert.equal(validateDiff(ok), ok);
});

test('apply 会应用补丁，baseCommit 不匹配时拒绝', async () => {
  const source = makeRepo();
  const target = makeRepo();
  try {
    const diff = diffFor(source, 'a.txt', 'two\n');
    const base = git(target, ['rev-parse', 'HEAD']).trim();
    const service = createPatchService();

    await assert.rejects(
      () => service.apply(target, diff, { baseCommit: 'deadbeef' }),
      /base commit 不匹配/u
    );
    await service.apply(target, diff, { baseCommit: base });
    assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8').replace(/\r\n/gu, '\n'), 'two\n');
    assert.equal(git(target, ['status', '--porcelain']).trim(), 'M a.txt');
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('runTests 只允许白名单命令，并返回通过/失败', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-test-'));
  const service = createPatchService();
  try {
    fs.writeFileSync(path.join(root, 'ok.test.mjs'), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('ok', () => assert.equal(1, 1));"
    ].join('\n'));
    const ok = await service.runTests(root, { command: 'node --test ok.test.mjs' });
    assert.equal(ok.ok, true);

    fs.writeFileSync(path.join(root, 'bad.test.mjs'), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('bad', () => assert.equal(1, 2));"
    ].join('\n'));
    const bad = await service.runTests(root, { command: 'node --test bad.test.mjs' });
    assert.equal(bad.ok, false, JSON.stringify({ code: bad.code, out: bad.output.slice(-300) }));

    await assert.rejects(
      () => service.runTests(root, { command: 'rm -rf /' }),
      /只允许/u
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
