// GitHub 只读查询与 Draft PR 创建：用假 exec 锁定参数与安全分支。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithub } from '../plugins/owner-companion/node/lib/github.mjs';

const makeExec = () => {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const joined = `${cmd} ${args.join(' ')}`;
    if (joined.includes('show-toplevel')) return { stdout: 'D:/demo\n' };
    if (joined.includes('remote.origin.url')) return { stdout: 'https://github.com/acme/demo.git\n' };
    if (joined.includes('issue list')) {
      return { stdout: JSON.stringify([{ number: 3, title: 'Bug', state: 'OPEN', author: { login: 'a' }, updatedAt: 'now', url: 'u' }]) };
    }
    if (joined.includes('pr list')) {
      return { stdout: JSON.stringify([{ number: 9, title: 'Feat', state: 'OPEN', isDraft: true, author: { login: 'b' }, updatedAt: 'now', url: 'u' }]) };
    }
    if (joined.includes('rev-parse --abbrev-ref')) return { stdout: 'feat/x\n' };
    if (joined.includes('status --porcelain')) return { stdout: '' };
    if (joined.includes('diff --stat')) return { stdout: ' a.txt | 2 +-\n' };
    if (joined.includes('rev-list --count')) return { stdout: '2\n' };
    if (joined.includes('push -u origin HEAD')) return { stdout: '' };
    if (joined.includes('pr create')) return { stdout: 'https://github.com/acme/demo/pull/10\n' };
    return { stdout: '' };
  };
  return { exec, calls };
};

test('detectRepo 解析 HTTPS 与 SSH 远端', async () => {
  const { exec } = makeExec();
  const github = createGithub({ exec });
  assert.deepEqual(await github.detectRepo('D:/demo'), { owner: 'acme', repo: 'demo' });

  const ssh = createGithub({
    exec: async (cmd, args) => ({
      stdout: args.includes('--show-toplevel') ? 'D:/demo\n' : 'git@github.com:acme/other.git\n'
    })
  });
  assert.deepEqual(await ssh.detectRepo('D:/demo'), { owner: 'acme', repo: 'other' });
});

test('issues 与 PR 读取会带上 repo 与 limit', async () => {
  const { exec, calls } = makeExec();
  const github = createGithub({ exec });
  const issues = await github.listIssues('D:/demo', { limit: 5 });
  assert.equal(issues[0].number, 3);
  assert.ok(calls.some((call) => call.join(' ').includes('issue list --repo acme/demo')));
  const prs = await github.listPrs('D:/demo');
  assert.equal(prs[0].draft, true);
});

test('创建 Draft PR 必须显式确认，且只推当前分支', async () => {
  const { exec, calls } = makeExec();
  const github = createGithub({ exec });
  await assert.rejects(
    () => github.createDraftPr('D:/demo', { base: 'main', title: 'x' }),
    /显式确认/u
  );
  const result = await github.createDraftPr('D:/demo', {
    base: 'main', title: 'Owner change', confirm: true
  });
  assert.equal(result.url, 'https://github.com/acme/demo/pull/10');
  const joined = calls.map((call) => call.join(' ')).join('\n');
  assert.match(joined, /push -u origin HEAD/u);
  assert.match(joined, /pr create --repo acme\/demo --draft/u);
});

test('工作区不干净时拒绝创建 PR', async () => {
  const exec = async (cmd, args) => {
    const joined = `${cmd} ${args.join(' ')}`;
    if (joined.includes('show-toplevel')) return { stdout: 'D:/demo\n' };
    if (joined.includes('remote.origin.url')) return { stdout: 'https://github.com/acme/demo.git' };
    if (joined.includes('rev-parse --abbrev-ref')) return { stdout: 'feat/x' };
    if (joined.includes('status --porcelain')) return { stdout: ' M a.txt\n' };
    if (joined.includes('diff --stat')) return { stdout: '' };
    return { stdout: '' };
  };
  const github = createGithub({ exec });
  await assert.rejects(
    () => github.createDraftPr('D:/demo', { base: 'main', confirm: true }),
    /未提交改动/u
  );
});
