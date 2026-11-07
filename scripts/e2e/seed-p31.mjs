// P3.1 E2E 数据准备：只创建一个待审批的 code-patch Job，其余全部由 Worker 推进。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { OwnerStore } from '../../src/owner-store.mjs';

const BUGGY = `export function withRetry(fn, { attempts = 3 } = {}) {
  let lastError;
  // 真实 bug：off-by-one，只尝试 attempts - 1 次。
  for (let i = 0; i < attempts - 1; i += 1) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
`;

const TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../src/retry.js';

test('withRetry uses all attempts', () => {
  let calls = 0;
  const result = withRetry(() => {
    calls += 1;
    if (calls < 3) throw new Error('flaky');
    return 'ok';
  }, { attempts: 3 });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});
`;

const git = (cwd, args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
}).trim();

const makeFixture = (root) => {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'),
    '{"name":"p31-fixture","private":true,"type":"module"}\n', 'utf8');
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.owner-root-identity\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'retry.js'), BUGGY, 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'format.js'),
    'export const format = (value) => String(value);\n', 'utf8');
  fs.writeFileSync(path.join(root, 'tests', 'sandbox-smoke.test.mjs'), TEST, 'utf8');
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'user.email', 'p31@example.invalid']);
  git(root, ['config', 'user.name', 'P31 Fixture']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'p31 base: buggy retry']);
  return git(root, ['rev-parse', 'HEAD']);
};

const run = () => {
  const dbPath = process.env.OWNER_AGENT_DB;
  if (!dbPath) throw new Error('OWNER_AGENT_DB is required');
  const root = process.env.OWNER_E2E_ROOT ?? path.join(path.dirname(dbPath), 'p31');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const base = fs.existsSync(path.join(repo, '.git'))
    ? git(repo, ['rev-parse', 'HEAD'])
    : makeFixture(repo);

  const store = new OwnerStore(dbPath);
  try {
    if (!store.getProject('p31')) {
      store.registerProject({
        id: 'p31',
        name: 'P3.1 Fixture',
        root: repo,
        primaryDomain: 'software-engineering'
      });
    }
    const task = store.createTask({
      projectId: 'p31',
      title: 'Fix the failing retry test'
    });
    const job = store.createJob({
      projectId: 'p31',
      jobType: 'code-patch',
      title: 'Add a clarifying comment to retry.js',
      payload: {
        baseSha: base,
        allowedPaths: 'src/retry.js',
        focus: 'Only add a comment. Do not change behavior.'
      },
      idempotencyKey: 'p31-job-1',
      ownerTaskId: task.id
    });
    console.log(JSON.stringify({
      projectId: 'p31',
      taskId: task.id,
      jobId: job.id,
      baseSha: base,
      jobStatus: job.status
    }, null, 2));
  } finally {
    store.close();
  }
};

run();
