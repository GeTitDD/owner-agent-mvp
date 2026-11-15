// GitHub PR 规则：分支白名单、Draft PR 文案、预览哈希。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSafeHeadBranch, buildPrDraft, prPreviewHash } from '../src/github-pr.mjs';

test('只允许 owner/ 分支，拒绝 main/master 与路径穿越', () => {
  assert.equal(isSafeHeadBranch('owner/job-abc-a1'), true);
  assert.equal(isSafeHeadBranch('owner/pr-cycle-123'), true);
  assert.equal(isSafeHeadBranch('main'), false);
  assert.equal(isSafeHeadBranch('owner/main'), false);
  assert.equal(isSafeHeadBranch('feature/x'), false);
  assert.equal(isSafeHeadBranch('owner/../x'), false);
  assert.equal(isSafeHeadBranch(''), false);
});

test('PR 文案包含任务、周期、文件与“不合并”声明', () => {
  const draft = buildPrDraft({
    taskTitle: 'Fix retry off-by-one',
    projectName: 'demo',
    cycleId: 'cycle-1',
    proposalId: 'patch-1',
    runId: 'run-1',
    files: ['src/retry.js', 'src/retry.js', 'tests/a.test.mjs'],
    base: 'main',
    head: 'owner/job-1-a1'
  });
  assert.equal(draft.title, '[Owner] Fix retry off-by-one');
  assert.match(draft.body, /复测通过/u);
  assert.match(draft.body, /src\/retry\.js/u);
  assert.match(draft.body, /不会自动合并/u);
  assert.match(draft.commitMessage, /^owner: \[Owner\]/u);
  // 文件去重且排序
  assert.equal(draft.body.match(/src\/retry\.js/gu).length, 1);
});

test('预览哈希对文件顺序不敏感，但会随内容变化', () => {
  const base = {
    repo: 'o/r', base: 'main', head: 'owner/x',
    files: ['b.js', 'a.js'], proposalHash: 'h', commitMessage: 'm', cycleId: 'c'
  };
  assert.equal(prPreviewHash(base), prPreviewHash({ ...base, files: ['a.js', 'b.js'] }));
  assert.notEqual(prPreviewHash(base), prPreviewHash({ ...base, base: 'dev' }));
  assert.notEqual(prPreviewHash(base), prPreviewHash({ ...base, files: ['a.js'] }));
});
