// #120 项目采集器：git 提交清单 + 工作区有没有未提交改动。
// 假 git 执行器：按子命令查表，表里没有的命令直接失败——这样「只跑预期的那几个只读命令」
// 由测试兜住，而不是靠注释。读不到仓库必须返回 error（不是空清单），否则界面会把
// 「没读到」显示成「没有变化」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectProject, PROJECT_COMMIT_LIMIT } from '../src/watch/collect-project.mjs';
import { WatchTargetError } from '../src/watch/target.mjs';

// ASCII 单元分隔符：写成 charCode 而不是 \x1f，免得被任何一层当成转义处理掉。
const FIELD = String.fromCharCode(31);
const HEAD = 'a'.repeat(40);
const target = { type: 'project', projectId: 'alpha', root: 'D:/repos/alpha' };

const commitLine = (sha, at, subject = `提交 ${sha}`) => [sha, 'Owner', at, subject].join(FIELD);

/**
 * 假 git：args[0] 是子命令；rev-parse 用前两个词区分（--is-inside-work-tree / --verify）。
 * 值为字符串就返回，为 Error 就抛出，为函数就调用。
 */
const fakeGit = (table, calls = []) => async ({ root, args }) => {
  calls.push({ root, args });
  const key = args[0] === 'rev-parse' ? `rev-parse ${args[1]}` : args[0];
  if (!(key in table)) throw Object.assign(new Error(`unexpected git ${args.join(' ')}`), { code: 'EUNEXPECTED' });
  const value = table[key];
  if (value instanceof Error) throw value;
  return typeof value === 'function' ? value(args) : value;
};

/** 只读断言：任何一次 git 调用都不该是写型子命令。 */
const WRITE_SUBCOMMANDS = new Set([
  'add', 'commit', 'checkout', 'switch', 'restore', 'reset', 'clean', 'push', 'pull',
  'fetch', 'merge', 'rebase', 'stash', 'apply', 'cherry-pick', 'rm', 'mv', 'init'
]);

const assertReadOnlyCalls = (calls) => {
  for (const call of calls) {
    assert.ok(!WRITE_SUBCOMMANDS.has(call.args[0]), `不该执行写型 git 子命令：${call.args.join(' ')}`);
    assert.equal(call.root, 'D:/repos/alpha');
  }
};

test('有提交：只留水位之后的提交，工作区干净也作为一条事实返回', async () => {
  const calls = [];
  const git = fakeGit({
    'rev-parse --is-inside-work-tree': 'true\n',
    'rev-parse --verify': `${HEAD}\n`,
    log: `${commitLine('c1', '2026-11-01T00:00:00+08:00')}\n${commitLine('c2', '2026-11-02T00:00:00+08:00', '第二个')}\n`,
    status: ''
  }, calls);

  const result = await collectProject(target, {
    since: '2026-11-01T00:00:00.000Z',
    now: new Date('2026-11-03T00:00:00.000Z'),
    deps: { git }
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.type, 'project');
  assert.equal(result.ref, 'project:alpha');
  assert.equal(result.error, null);
  assert.equal(result.cursor, '2026-11-03T00:00:00.000Z');
  // c1 早于水位，只看 c2；时间是 UTC ISO，不是 git 给的带时区原样。
  assert.deepEqual(result.items, [
    { kind: 'commit', sha: 'c2', author: 'Owner', at: '2026-11-01T16:00:00.000Z', subject: '第二个' },
    { kind: 'workingTree', dirty: false }
  ]);
  // 提交清单按上限取，不整库读。
  const logCall = calls.find((call) => call.args[0] === 'log');
  assert.deepEqual(logCall.args, ['log', `--max-count=${PROJECT_COMMIT_LIMIT}`,
    `--format=%H${FIELD}%an${FIELD}%aI${FIELD}%s`]);
  assertReadOnlyCalls(calls);
});

test('无提交：空仓库不算错误，返回没有提交 + 工作区状态', async () => {
  const git = fakeGit({
    'rev-parse --is-inside-work-tree': 'true\n',
    // 空仓库上 rev-parse --verify HEAD 非零退出：正常状态，不是探针错误。
    'rev-parse --verify': Object.assign(new Error('fatal: Needed a single revision'), { status: 128 }),
    status: '?? README.md\n'
  });

  const result = await collectProject(target, {
    now: new Date('2026-11-03T00:00:00.000Z'),
    deps: { git }
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.error, null);
  assert.deepEqual(result.items, [{ kind: 'workingTree', dirty: true }]);
});

test('工作区脏：只回答有没有，不把文件路径或内容带进结果', async () => {
  const git = fakeGit({
    'rev-parse --is-inside-work-tree': 'true\n',
    'rev-parse --verify': `${HEAD}\n`,
    log: `${commitLine('c1', '2026-11-01T00:00:00+08:00')}\n`,
    status: ' M src/app.js\n?? docs/秘密.md\n'
  });

  const result = await collectProject(target, {
    since: '2026-11-05T00:00:00.000Z',
    now: new Date('2026-11-06T00:00:00.000Z'),
    deps: { git }
  });

  const tree = result.items.find((item) => item.kind === 'workingTree');
  assert.deepEqual(tree, { kind: 'workingTree', dirty: true });
  // 水位之后没有提交：提交条目一个都不返回，但「脏」仍是事实。
  assert.equal(result.items.filter((item) => item.kind === 'commit').length, 0);
  const serialised = JSON.stringify(result.items);
  assert.ok(!serialised.includes('app.js'), '结果里不该出现被改文件路径');
  assert.ok(!serialised.includes('秘密'), '结果里不该出现文件名正文');
});

test('git 不可用：返回错误与原因，不返回空清单', async () => {
  const git = async () => {
    throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
  };

  const result = await collectProject(target, { deps: { git } });

  assert.equal(result.status, 'error');
  assert.deepEqual(result.items, []);
  assert.equal(result.cursor, null, '没读到就不给游标，水位不能前进');
  assert.equal(result.error.code, 'git-unavailable');
  assert.match(result.error.message, /git/u);
  assert.match(result.error.message, /alpha/u);
});

test('项目根不是 git 工作区：明确指出，不假装没有变化', async () => {
  const git = fakeGit({ 'rev-parse --is-inside-work-tree': 'false\n' });

  const result = await collectProject(target, { deps: { git } });

  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'not-a-work-tree');
  assert.match(result.error.message, /D:\/repos\/alpha/u);
  assert.deepEqual(result.items, []);
});

test('git 读到一半失败：原因带上是哪一步', async () => {
  const git = fakeGit({
    'rev-parse --is-inside-work-tree': 'true\n',
    'rev-parse --verify': `${HEAD}\n`,
    log: `${commitLine('c1', '2026-11-01T00:00:00+08:00')}\n`,
    status: Object.assign(new Error('fatal: index file smaller than expected'), { code: 'EGIT' })
  });

  const result = await collectProject(target, { deps: { git } });

  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'git-failed');
  assert.match(result.error.message, /index file smaller than expected/u);
});

test('没有登记项目根：直接说明缺什么，不去猜目录', async () => {
  let called = false;
  const git = async () => {
    called = true;
    return '';
  };

  const result = await collectProject({ type: 'project', projectId: 'beta' }, { deps: { git } });

  assert.equal(called, false, '没有根就不该调用 git');
  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'project-root-missing');
  assert.match(result.error.message, /beta/u);
});

test('采集器只接受自己那类对象：传错类型明确拒绝', async () => {
  await assert.rejects(
    () => collectProject({ type: 'session', source: 'codex', sessionId: 's1' }, {}),
    (error) => {
      assert.ok(error instanceof WatchTargetError);
      assert.equal(error.code, 'target-type-mismatch');
      assert.match(error.message, /project/u);
      return true;
    }
  );
});
