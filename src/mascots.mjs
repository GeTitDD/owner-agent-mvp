// 桌宠皮肤（mascot）与 Codex 会话阶段映射。
//
// 约定来自 Cindy 的 Agent Island（makecindy/cindy，Apache-2.0）：
//   - 皮肤 id 固定（cindy / blackcat / pululu / ...），资源为透明 PNG 或 SVG；
//   - 会话阶段使用 running / needs-interaction / completed / error 四态，另有 idle；
//   - 用户可以把自定义 PNG 放进 userDir 直接替换，不需要改代码。
//
// 本项目只复用“皮肤 + 阶段”的约定，不引入 Cindy 的 React/原生岛实现。
import fs from 'node:fs';
import path from 'node:path';

/** 与 Cindy AgentIslandMascotSkin 对齐的内置皮肤顺序。 */
export const MASCOT_SKINS = Object.freeze([
  'cindy', 'blackcat', 'pululu', 'tarara', 'boli',
  'whitesnow', 'annie', 'chaku', 'muffin', 'erika'
]);
export const DEFAULT_MASCOT_SKIN = 'pululu';

/** Codex / Agent Island 会话阶段（用于与外部会话快照对接）。 */
export const SESSION_PHASES = Object.freeze([
  'idle', 'running', 'needs-interaction', 'completed', 'error'
]);

/** Owner 的五态映射到 Codex 阶段；外部只要给 phase 就能驱动同一套宠物。 */
export const STATE_TO_PHASE = Object.freeze({
  idle: 'idle',
  working: 'running',
  waiting: 'needs-interaction',
  done: 'completed',
  error: 'error'
});

export const MASCOT_FILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,40}\.(png|svg)$/iu;

const sanitizeId = (value) => String(value ?? '')
  .trim()
  .replace(/\.(png|svg)$/iu, '')
  .toLowerCase()
  .replace(/[^a-z0-9._-]+/gu, '-')
  .replace(/^-+|-+$/gu, '')
  .slice(0, 40);

/** 读取可选 manifest.json：允许自定义显示名与默认皮肤。 */
function readManifest(userDir) {
  if (!userDir) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(userDir, 'manifest.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function scanDir(dir, source) {
  if (!dir) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => MASCOT_FILE_PATTERN.test(name))
    .map((name) => ({
      id: sanitizeId(name),
      label: sanitizeId(name),
      source,
      file: path.join(dir, name)
    }));
}

/**
 * 列出可用皮肤：内置在前，自定义在后；同名时自定义覆盖内置（方便快速替换）。
 * 返回项包含绝对路径，调用方负责转成 file:// URL。
 */
export function listMascots({ builtinDir = '', userDir = '' } = {}) {
  const byId = new Map();
  for (const item of scanDir(builtinDir, 'builtin')) byId.set(item.id, item);
  for (const item of scanDir(userDir, 'custom')) byId.set(item.id, item);
  const manifest = readManifest(userDir);
  const labels = manifest.labels && typeof manifest.labels === 'object' ? manifest.labels : {};
  const ordered = [
    ...MASCOT_SKINS.filter((id) => byId.has(id)).map((id) => ({ ...byId.get(id), label: labels[id] ?? id, builtin: MASCOT_SKINS.includes(id) })),
    ...[...byId.values()]
      .filter((item) => !MASCOT_SKINS.includes(item.id))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((item) => ({ ...item, label: labels[item.id] ?? item.label, builtin: false }))
  ];
  return {
    skins: ordered,
    default: sanitizeId(manifest.default) || DEFAULT_MASCOT_SKIN
  };
}

/** 解析当前皮肤；配置无效或文件丢失时回退到默认皮肤，再回退到第一个可用项。 */
export function resolveMascot({ builtinDir = '', userDir = '', skin = '' } = {}) {
  const catalog = listMascots({ builtinDir, userDir });
  const wanted = sanitizeId(skin);
  const found = catalog.skins.find((item) => item.id === wanted)
    ?? catalog.skins.find((item) => item.id === catalog.default && catalog.skins.some((entry) => entry.id === catalog.default))
    ?? catalog.skins.find((item) => item.id === DEFAULT_MASCOT_SKIN)
    ?? catalog.skins[0]
    ?? null;
  return {
    skin: found?.id ?? '',
    label: found?.label ?? '',
    file: found?.file ?? '',
    builtin: found?.builtin ?? false,
    fallback: Boolean(skin) && (found?.id ?? '') !== wanted,
    skins: catalog.skins
  };
}

/** 仅接受已存在的皮肤 id 或目录内文件名，避免路径穿越。 */
export function isValidMascotSelection({ builtinDir = '', userDir = '', skin = '' } = {}) {
  const wanted = sanitizeId(skin);
  if (!wanted) return false;
  return listMascots({ builtinDir, userDir }).skins.some((item) => item.id === wanted);
}

/** 五态 → Codex 阶段；未知状态按 idle 处理。 */
export function phaseForState(state) {
  return STATE_TO_PHASE[state] ?? 'idle';
}
