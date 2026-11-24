// 观察事件阈值配置（单一来源）。
//
// 停滞（天数）、漂移（落后提交数）、积压（未提交文件数）三类事件共用这一份配置，
// 判定函数只接收数值，不各自读取环境变量或文件。
// 优先级：调用方显式传入 > 环境变量 > ~/.owner-agent/thresholds.json > 默认值。
// 阈值只影响「是否越线」，不参与指纹派生。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 默认阈值：第一版经验值，后续按误报率校准（见 OBSERVER_V0_1_PLAN 风险节）。 */
export const DEFAULT_THRESHOLDS = Object.freeze({
  staleDays: 3,
  driftCommits: 10,
  backlogFiles: 20
});

/** 阈值字段 → 环境变量名。 */
const ENV_KEYS = {
  staleDays: 'OWNER_OBSERVER_STALE_DAYS',
  driftCommits: 'OWNER_OBSERVER_DRIFT_COMMITS',
  backlogFiles: 'OWNER_OBSERVER_BACKLOG_FILES'
};

/** 阈值字段 → 报错用的可读名称。 */
const LABELS = {
  staleDays: 'stale threshold',
  driftCommits: 'drift threshold',
  backlogFiles: 'backlog threshold'
};

/** 默认阈值文件位置：与 Owner 其余本机配置同目录。 */
export const defaultThresholdsConfigPath = () => path.join(os.homedir(), '.owner-agent', 'thresholds.json');

const fields = Object.keys(DEFAULT_THRESHOLDS);

/** 校验单个阈值：必须是有限的非负数。 */
const assertThreshold = (value, field) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${LABELS[field]}`);
  }
  return value;
};

/**
 * 合并默认值与调用方覆盖值，并逐字段校验。所有「先合并再判定」的地方都走这里，
 * 避免三处各写一份 `{...DEFAULT_THRESHOLDS, ...}` 而校验口径不一致。
 * @param {object} [overrides]
 * @returns {{staleDays:number, driftCommits:number, backlogFiles:number}}
 */
export function mergeThresholds(overrides = {}) {
  const input = overrides !== null && typeof overrides === 'object' && !Array.isArray(overrides)
    ? overrides : {};
  const merged = { ...DEFAULT_THRESHOLDS, ...input };
  const resolved = {};
  for (const field of fields) resolved[field] = assertThreshold(merged[field], field);
  return resolved;
}

/** 从文件对象与环境变量里各取一次覆盖值。 */
const readFileOverrides = (configPath) => {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    // 文件不存在、不可读或不是合法 JSON 都按“未配置”处理，阈值退回默认值。
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const overrides = {};
  for (const field of fields) {
    if (parsed[field] !== undefined && parsed[field] !== null) overrides[field] = parsed[field];
  }
  return overrides;
};

const readEnvOverrides = (env) => {
  const overrides = {};
  for (const field of fields) {
    const raw = env?.[ENV_KEYS[field]];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    overrides[field] = Number(String(raw).trim());
  }
  return overrides;
};

/**
 * 解析三类事件的阈值。
 * @param {{env?:object, configPath?:string}} [options]
 * @returns {{staleDays:number, driftCommits:number, backlogFiles:number}}
 */
export function resolveThresholds({ env = process.env, configPath = defaultThresholdsConfigPath() } = {}) {
  return mergeThresholds({
    ...readFileOverrides(configPath),
    ...readEnvOverrides(env)
  });
}

/**
 * 命令行与观察台共用的解析入口：OWNER_OBSERVER_THRESHOLDS 可以指定阈值文件路径，
 * 其余优先级交给 resolveThresholds。观察台每次请求都调用，改配置文件后徽章立即同步。
 * @param {{env?:object, configPath?:string}} [options]
 * @returns {{staleDays:number, driftCommits:number, backlogFiles:number}}
 */
export function resolveThresholdsFromEnvironment({ env = process.env, configPath } = {}) {
  const fromEnvPath = typeof env?.OWNER_OBSERVER_THRESHOLDS === 'string'
    ? env.OWNER_OBSERVER_THRESHOLDS.trim()
    : '';
  const resolvedPath = configPath === undefined ? fromEnvPath : configPath;
  return resolvedPath
    ? resolveThresholds({ env, configPath: resolvedPath })
    : resolveThresholds({ env });
}
