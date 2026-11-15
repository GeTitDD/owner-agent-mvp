// 沙箱计划：全局默认 / 项目覆盖 / 生态探测。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SANDBOX_MODES, normalizeSandboxMode, effectiveSandboxMode,
  detectEcosystem, detectProject, resolveSandboxPlan, describeSandboxPlan
} from '../src/sandbox-plan.mjs';

const project = (files) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-plan-'));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
};

test('模式规范化与优先级：项目覆盖 > 全局', () => {
  assert.deepEqual(SANDBOX_MODES, ['auto', 'off', 'node-smoke', 'node-fail', 'node-probe', 'godot-headless', 'python-pytest']);
  assert.equal(normalizeSandboxMode('nope', 'auto'), 'auto');
  assert.equal(normalizeSandboxMode('off'), 'off');
  assert.equal(effectiveSandboxMode({ globalMode: 'auto', projectMode: 'off' }), 'off');
  assert.equal(effectiveSandboxMode({ globalMode: 'off', projectMode: 'auto' }), 'auto');
  assert.equal(effectiveSandboxMode({ globalMode: 'node-smoke' }), 'node-smoke');
});

test('生态探测：node / godot / python / rust / go / unknown', () => {
  assert.equal(detectEcosystem(project({ 'package.json': '{}' })), 'node');
  assert.equal(detectEcosystem(project({ 'project.godot': '' })), 'godot');
  assert.equal(detectEcosystem(project({ 'pyproject.toml': '' })), 'python');
  assert.equal(detectEcosystem(project({ 'Cargo.toml': '' })), 'rust');
  assert.equal(detectEcosystem(project({ 'go.mod': '' })), 'go');
  assert.equal(detectEcosystem(project({ 'README.md': '' })), 'unknown');
  assert.equal(detectEcosystem(''), 'unknown');
});

test('子目录项目：根目录没有标记时探测一层子目录并生成 projectDir', () => {
  const root = project({
    'Program.cs': '',
    'godot-project/project.godot': 'config_version=5\n'
  });
  const detected = detectProject({ root });
  assert.equal(detected.ecosystem, 'godot');
  assert.equal(detected.projectDir, 'godot-project');

  const plan = resolveSandboxPlan({ root, mode: 'auto', includePaths: ['package.json'] });
  assert.equal(plan.enabled, true);
  assert.equal(plan.profile, 'godot-headless');
  assert.equal(plan.projectDir, 'godot-project');
  assert.deepEqual(plan.required, ['godot-project/project.godot']);
  assert.equal(plan.ok, true);

  // 显式覆盖优先于自动探测
  const overridden = resolveSandboxPlan({ root, mode: 'auto', projectDir: 'godot-project', includePaths: [] });
  assert.equal(overridden.projectDir, 'godot-project');
});

test('auto：Node 项目启用并按缺失文件给出 actionable 计划', () => {
  const ready = project({ 'package.json': '{}', 'tests/sandbox-smoke.test.mjs': '' });
  const ok = resolveSandboxPlan({ root: ready, mode: 'auto', includePaths: ['package.json'] });
  assert.equal(ok.enabled, true);
  assert.equal(ok.ok, true);
  assert.equal(ok.profile, 'node-smoke');
  assert.equal(ok.reason, 'ready');

  const missing = project({ 'package.json': '{}' });
  const plan = resolveSandboxPlan({ root: missing, mode: 'auto', includePaths: ['package.json'] });
  assert.equal(plan.enabled, true);
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.missing, ['tests/sandbox-smoke.test.mjs']);
  assert.match(describeSandboxPlan(plan), /测试配置缺少/u);
});

test('auto：非 Node 生态按 profile 映射（Godot / Python），未知生态才降级', () => {
  const godot = project({ 'project.godot': '', 'tests': '' });
  const godotPlan = resolveSandboxPlan({ root: godot, mode: 'auto', includePaths: ['package.json'] });
  assert.equal(godotPlan.enabled, true);
  assert.equal(godotPlan.profile, 'godot-headless');
  assert.equal(godotPlan.ecosystem, 'godot');
  assert.equal(godotPlan.ok, true);
  assert.equal(godotPlan.image, 'barichello/godot-ci:4.3');

  const python = project({ 'pyproject.toml': '', 'tests/test_app.py': '' });
  const pythonPlan = resolveSandboxPlan({ root: python, mode: 'auto', includePaths: [] });
  assert.equal(pythonPlan.enabled, true);
  assert.equal(pythonPlan.profile, 'python-pytest');

  const unknown = project({ 'README.md': '' });
  const plan = resolveSandboxPlan({ root: unknown, mode: 'auto', includePaths: ['package.json'] });
  assert.equal(plan.enabled, false);
  assert.equal(plan.profile, null);
  assert.equal(plan.ecosystem, 'unknown');
  assert.equal(plan.reason, 'no-profile');
  assert.match(describeSandboxPlan(plan), /没有可用沙箱 profile/u);
});

test('off：任何项目都跳过，不提示缺失文件', () => {
  const node = project({ 'package.json': '{}' });
  const plan = resolveSandboxPlan({ root: node, mode: 'off', includePaths: ['package.json'] });
  assert.equal(plan.enabled, false);
  assert.equal(plan.missing.length, 0);
  assert.equal(plan.reason, 'disabled');
  assert.match(describeSandboxPlan(plan), /跳过沙箱测试/u);
});

test('node-smoke 强制模式：非 Node 项目也按 Node 预检', () => {
  const godot = project({ 'project.godot': '' });
  const plan = resolveSandboxPlan({ root: godot, mode: 'node-smoke', includePaths: ['package.json'] });
  assert.equal(plan.enabled, true);
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.missing.sort(), ['package.json', 'tests/sandbox-smoke.test.mjs']);
});
