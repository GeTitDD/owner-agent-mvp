// 沙箱测试计划：全局默认 + 按项目覆盖 + 生态探测。
//
// 现状只有 node-smoke 一个真实 profile。其它生态（Godot / Python / Rust / Go）
// 先明确标为“无可用 profile”，不弹警告、静默降级为人工验证；新增真实 profile
// 时只需扩展 resolveSandboxPlan。
import fs from 'node:fs';
import path from 'node:path';

export const SANDBOX_MODES = ['auto', 'off', 'node-smoke'];

export function normalizeSandboxMode(value, fallback = 'auto') {
  return SANDBOX_MODES.includes(String(value ?? '')) ? String(value) : fallback;
}

/** 全局默认 + 项目覆盖；项目值优先。 */
export function effectiveSandboxMode({ globalMode = 'auto', projectMode = '' } = {}) {
  const global = normalizeSandboxMode(globalMode, 'auto');
  if (!projectMode) return global;
  return normalizeSandboxMode(projectMode, global);
}

const ECOSYSTEM_FILES = [
  ['node', ['package.json']],
  ['godot', ['project.godot']],
  ['python', ['pyproject.toml', 'requirements.txt', 'setup.py']],
  ['rust', ['Cargo.toml']],
  ['go', ['go.mod']]
];

export function detectEcosystem(root, exists = fs.existsSync) {
  if (!root) return 'unknown';
  for (const [ecosystem, files] of ECOSYSTEM_FILES) {
    if (files.some((file) => exists(path.join(root, file)))) return ecosystem;
  }
  return 'unknown';
}

/**
 * 解析一次沙箱计划。
 * - off：显式跳过，不提示缺失。
 * - auto：Node 项目或测试文件已存在时启用 node-smoke；其它生态视为无 profile。
 * - node-smoke：强制启用（缺失文件时给出可执行的缺失列表）。
 */
export function resolveSandboxPlan({ root = '', mode = 'auto', includePaths = [], exists = fs.existsSync } = {}) {
  const required = [...new Set(['tests/sandbox-smoke.test.mjs', ...includePaths])]
    .map((item) => String(item).replace(/\\/gu, '/').replace(/^\.\//u, ''))
    .filter(Boolean);
  const normalizedMode = normalizeSandboxMode(mode, 'auto');
  if (!root) {
    return {
      enabled: false, ok: false, profile: null, mode: normalizedMode,
      ecosystem: 'unknown', required, missing: [], reason: 'no-project'
    };
  }
  const ecosystem = detectEcosystem(root, exists);
  if (normalizedMode === 'off') {
    return {
      enabled: false, ok: false, profile: null, mode: normalizedMode,
      ecosystem, required, missing: [], reason: 'disabled'
    };
  }
  const missing = required.filter((rel) => !exists(path.join(root, rel)));
  const shouldEnable = normalizedMode === 'node-smoke' || ecosystem === 'node' || missing.length === 0;
  if (!shouldEnable) {
    return {
      enabled: false, ok: false, profile: null, mode: normalizedMode,
      ecosystem, required, missing, reason: 'no-profile'
    };
  }
  return {
    enabled: true,
    ok: missing.length === 0,
    profile: 'node-smoke',
    mode: normalizedMode,
    ecosystem,
    required,
    missing,
    reason: missing.length === 0 ? 'ready' : 'missing-files'
  };
}

/** 给面板的一句话说明；不包含命令细节。 */
export function describeSandboxPlan(plan) {
  if (!plan) return '';
  if (plan.reason === 'ready') return `沙箱测试可用（node-smoke）`;
  if (plan.reason === 'missing-files') return `测试配置缺少 ${plan.missing.join(', ')}；补丁应用后无法创建沙箱。`;
  if (plan.reason === 'disabled') return '已按设置跳过沙箱测试；补丁只做人工验证。';
  if (plan.reason === 'no-profile') return `当前项目是 ${plan.ecosystem === 'unknown' ? '未知生态' : plan.ecosystem}，没有可用沙箱 profile；补丁只做人工验证。`;
  if (plan.reason === 'no-project') return '还没有选择项目。';
  return '';
}
