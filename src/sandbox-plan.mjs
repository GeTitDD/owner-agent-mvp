// 沙箱测试计划：全局默认 + 按项目覆盖 + 生态探测。
//
// profile 定义以 sandbox-protocol.mjs 为准（镜像、argv、includePaths）。
// 目前内置：node-smoke / godot-headless / python-pytest；没有对应镜像时会明确报错，
// 不会伪造测试结果。
import fs from 'node:fs';
import path from 'node:path';
import { SANDBOX_PROFILES } from './sandbox-protocol.mjs';

export const SANDBOX_MODES = ['auto', 'off', ...Object.keys(SANDBOX_PROFILES)];

const ECOSYSTEM_PROFILE = {
  node: 'node-smoke',
  godot: 'godot-headless',
  python: 'python-pytest'
};

export function normalizeSandboxMode(value, fallback = 'auto') {
  const mode = String(value ?? '');
  if (SANDBOX_MODES.includes(mode)) return mode;
  return SANDBOX_MODES.includes(fallback) ? fallback : 'auto';
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

const normalizeList = (values) => [...new Set(values
  .map((item) => String(item ?? '').replace(/\\/gu, '/').replace(/^\.\//u, ''))
  .filter(Boolean))];

/**
 * 解析一次沙箱计划。
 * - off：显式跳过，不提示缺失。
 * - auto：按生态选择 profile；未知生态视为无 profile。
 * - 强制模式：任何项目都按该 profile 预检。
 */
export function resolveSandboxPlan({ root = '', mode = 'auto', includePaths = [], exists = fs.existsSync } = {}) {
  const normalizedMode = normalizeSandboxMode(mode, 'auto');
  const fallbackRequired = normalizeList(['tests/sandbox-smoke.test.mjs', ...includePaths]);
  if (!root) {
    return {
      enabled: false, ok: false, profile: null, mode: normalizedMode,
      ecosystem: 'unknown', required: fallbackRequired, missing: [], reason: 'no-project', image: ''
    };
  }
  const ecosystem = detectEcosystem(root, exists);
  if (normalizedMode === 'off') {
    return {
      enabled: false, ok: false, profile: null, mode: normalizedMode,
      ecosystem, required: fallbackRequired, missing: [], reason: 'disabled', image: ''
    };
  }
  const profileId = normalizedMode === 'auto' ? ECOSYSTEM_PROFILE[ecosystem] : normalizedMode;
  const def = profileId ? SANDBOX_PROFILES[profileId] : null;
  if (!def) {
    return {
      enabled: false, ok: false, profile: null, mode: normalizedMode,
      ecosystem, required: fallbackRequired, missing: [], reason: 'no-profile', image: ''
    };
  }
  const required = normalizeList([
    ...(def.includePaths ?? []),
    // 额外快照文件只对 Node 系列生效；Godot/Python 的全局 package.json 不应变成假缺失。
    ...(profileId.startsWith('node-') ? includePaths : [])
  ]);
  const missing = required.filter((rel) => !exists(path.join(root, rel)));
  return {
    enabled: true,
    ok: missing.length === 0,
    profile: profileId,
    mode: normalizedMode,
    ecosystem,
    required,
    missing,
    image: def.image,
    reason: missing.length === 0 ? 'ready' : 'missing-files'
  };
}

/** 给面板的一句话说明；不包含命令细节。 */
export function describeSandboxPlan(plan) {
  if (!plan) return '';
  if (plan.reason === 'ready') return `沙箱测试可用（${plan.profile}）`;
  if (plan.reason === 'missing-files') return `测试配置缺少 ${plan.missing.join(', ')}；补丁应用后无法创建沙箱。`;
  if (plan.reason === 'disabled') return '已按设置跳过沙箱测试；补丁只做人工验证。';
  if (plan.reason === 'no-profile') return `当前项目是 ${plan.ecosystem === 'unknown' ? '未知生态' : plan.ecosystem}，没有可用沙箱 profile；补丁只做人工验证。`;
  if (plan.reason === 'no-project') return '还没有选择项目。';
  return '';
}
