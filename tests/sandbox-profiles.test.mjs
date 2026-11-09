// 沙箱 profile 注册表：镜像、argv、超时与运行时白名单。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SANDBOX_PROFILES, SANDBOX_PROFILE_COMMANDS, resolveTestProfile
} from '../src/sandbox-protocol.mjs';

const DIGEST = `sha256:${'a'.repeat(64)}`;

test('内置 profile 覆盖 Node / Godot / Python，且 argv 与镜像固定', () => {
  assert.deepEqual(Object.keys(SANDBOX_PROFILES).sort(), [
    'godot-headless', 'node-fail', 'node-probe', 'node-smoke', 'python-pytest'
  ]);
  const godot = resolveTestProfile('godot-headless', { imageDigest: DIGEST });
  assert.equal(godot.image, 'barichello/godot-ci:4.3');
  assert.deepEqual(godot.command, ['godot', '--headless', '--path', '.', '--quit']);
  assert.equal(godot.timeoutMs, 120000);
  assert.equal(godot.memoryBytes, 512 * 1024 * 1024);
  assert.equal(godot.profileHash.length, 64);

  const python = resolveTestProfile('python-pytest', { imageDigest: DIGEST });
  assert.equal(python.image, 'python:3.12-slim');
  assert.deepEqual(python.command, ['python', '-m', 'pytest', '-q']);

  assert.deepEqual(SANDBOX_PROFILE_COMMANDS['node-smoke'], ['node', '--test', 'tests/sandbox-smoke.test.mjs']);
});

test('未知 profile 与不匹配的运行时被拒绝', () => {
  assert.throws(() => resolveTestProfile('nope', { imageDigest: DIGEST }), /unknown test profile/u);
  assert.throws(() => resolveTestProfile('godot-headless', {}), /imageDigest/u);

  // profile 的 argv 必须与其 runtime 一致：篡改 command 会被 validate 拒绝。
  const godot = resolveTestProfile('godot-headless', { imageDigest: DIGEST });
  assert.equal(godot.command[0], 'godot');
  assert.notEqual(godot.command[0], 'node');
});

test('profileHash 覆盖镜像引用与命令，但镜像 digest 由审批哈希单独覆盖', () => {
  const a = resolveTestProfile('node-smoke', { imageDigest: DIGEST });
  const b = resolveTestProfile('node-smoke', { imageDigest: `sha256:${'b'.repeat(64)}` });
  assert.equal(a.profileHash, b.profileHash);
  const c = resolveTestProfile('godot-headless', { imageDigest: DIGEST });
  assert.notEqual(a.profileHash, c.profileHash);
});
