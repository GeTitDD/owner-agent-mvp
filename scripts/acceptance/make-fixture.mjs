// v1.1 端到端验收 fixture 生成器。
//
// 设计要点（与 #14 一致）：
// - bug 与失败测试都提交在 base：repair 的 Worktree 从原 base 创建，源补丁引入的 bug
//   不会存在于新 Worktree，只有 base 上的 bug 才能被真实修复。
// - 测试文件不在 repair scope 内：修复只能改 src/，不能把测试改弱。
// - 纯 Node 内置模块、零依赖：沙箱无网络、不安装 node_modules。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sha256 } from '../../src/utils.mjs';

export const FIXTURE_TEST_PATH = 'tests/sandbox-smoke.test.mjs';
export const FIXTURE_BUG_PATH = 'src/retry.js';

const BUGGY_RETRY = `export function withRetry(fn, { attempts = 3 } = {}) {
  let lastError;
  // 验收用真实 bug：off-by-one，只尝试 attempts - 1 次。
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

const FIXED_RETRY = `export function withRetry(fn, { attempts = 3 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
`;

const TEST_CONTENT = `import test from 'node:test';
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

const FORMAT_CONTENT = `export const format = (value) => String(value);
`;

const PACKAGE_JSON = JSON.stringify({
  name: 'owner-agent-acceptance-fixture',
  private: true,
  type: 'module',
  description: 'v1.1 acceptance fixture: dependency-free Node project with a real failing test'
}, null, 2) + '\n';

const GITIGNORE = 'node_modules/\n.owner-root-identity\n';

const git = (cwd, args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
}).trim();

// 创建一个干净的 Git 仓库，HEAD 就是验收 base SHA。
export function makeAcceptanceFixture({ root } = {}) {
  if (typeof root !== 'string' || !root) throw new Error('fixture root is required');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), PACKAGE_JSON, 'utf8');
  fs.writeFileSync(path.join(root, '.gitignore'), GITIGNORE, 'utf8');
  fs.writeFileSync(path.join(root, FIXTURE_BUG_PATH), BUGGY_RETRY, 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'format.js'), FORMAT_CONTENT, 'utf8');
  fs.writeFileSync(path.join(root, FIXTURE_TEST_PATH), TEST_CONTENT, 'utf8');

  git(root, ['init', '-q', '-b', 'main']);
  // Windows 默认 core.autocrlf=true 会在 worktree 检出时把 LF 改成 CRLF，导致
  // "base 版本"与容器内实际文件 hash 不一致。验收仓库固定按字节比较，禁用转换。
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'user.email', 'acceptance@example.invalid']);
  git(root, ['config', 'user.name', 'Acceptance Fixture']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'acceptance base: buggy retry + failing test']);

  return {
    repo: root,
    base: git(root, ['rev-parse', 'HEAD']),
    // 用提交后实际落盘的内容计算，避免换行/编码差异造成假阴性。
    testSha256: sha256(fs.readFileSync(path.join(root, FIXTURE_TEST_PATH), 'utf8')),
    buggyRetry: BUGGY_RETRY,
    fixedRetry: FIXED_RETRY
  };
}

// 源补丁：只给 buggy retry 加一行注释，保持 bug 不变，且不触碰测试。
export const sourcePatchFiles = () => [{
  path: FIXTURE_BUG_PATH,
  action: 'modify',
  content: `${BUGGY_RETRY}\n// touched by acceptance source patch\n`
}];

// L1 确定性修复提案：真正修掉 off-by-one。
export const fixedRetryFiles = () => [{
  path: FIXTURE_BUG_PATH,
  action: 'modify',
  content: FIXED_RETRY
}];
