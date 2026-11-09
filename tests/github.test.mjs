// GitHub 远端解析：https / ssh / scp 三种写法与非法地址。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGitHubRemote } from '../src/github.mjs';

test('解析 https 与 .git 后缀', () => {
  assert.deepEqual(parseGitHubRemote('https://github.com/GeTitDD/owner-agent-mvp.git'), {
    owner: 'GeTitDD', repo: 'owner-agent-mvp',
    nameWithOwner: 'GeTitDD/owner-agent-mvp',
    url: 'https://github.com/GeTitDD/owner-agent-mvp'
  });
  assert.equal(parseGitHubRemote('https://github.com/a/b/').nameWithOwner, 'a/b');
});

test('解析 scp 风格与 ssh URL', () => {
  assert.equal(parseGitHubRemote('git@github.com:huangchao939-cmd/cultivation-agent.git').nameWithOwner,
    'huangchao939-cmd/cultivation-agent');
  assert.equal(parseGitHubRemote('ssh://git@github.com/owner/repo.git').nameWithOwner, 'owner/repo');
  assert.equal(parseGitHubRemote('github.com:owner/repo').nameWithOwner, 'owner/repo');
});

test('忽略 www，拒绝非 GitHub 与非法地址', () => {
  assert.equal(parseGitHubRemote('https://www.github.com/owner/repo').nameWithOwner, 'owner/repo');
  assert.equal(parseGitHubRemote('https://gitlab.com/owner/repo.git'), null);
  assert.equal(parseGitHubRemote('https://github.com/owner'), null);
  assert.equal(parseGitHubRemote('not a url'), null);
  assert.equal(parseGitHubRemote(''), null);
});
