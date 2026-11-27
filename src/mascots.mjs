// 桌宠皮肤（mascot）注册表：兼容 Cindy 静态皮肤与 Codex Pet 动画包。
//
// 支持两类皮肤：
//   1. 静态：userDir / builtinDir 下的 png/svg/webp/gif；
//   2. 动画：子目录中的 pet.json + spritesheet（Codex v1 8x9 / v2 8x11）。
//
// 只复用 Codex Pet 的“状态 → 精灵行”约定，不引入其运行时。
import fs from 'node:fs';
import path from 'node:path';

/** 与 Cindy AgentIslandMascotSkin 对齐的内置皮肤顺序。 */
export const MASCOT_SKINS = Object.freeze([
  'cindy', 'blackcat', 'pululu', 'tarara', 'boli',
  'whitesnow', 'annie', 'chaku', 'muffin', 'erika'
]);
export const DEFAULT_MASCOT_SKIN = 'petdex-01-boba';
const BUILTIN_LABELS = Object.freeze({cindy:'Cindy',blackcat:'黑猫',pululu:'Pululu（简约）',tarara:'Tarara',boli:'Boli',whitesnow:'白雪',annie:'Annie',chaku:'Chaku',muffin:'Muffin',erika:'Erika'});

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

export const MASCOT_FILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,40}\.(png|svg|webp|gif)$/iu;
const IMAGE_PATTERN = MASCOT_FILE_PATTERN;
const PET_MANIFEST = 'pet.json';
// Codex 9 行动作的默认帧数来自 hatch-pet 规范：每行固定 8 列，但只用前 N 帧，
// 其余列是透明占位。若按 8 帧播放，idle 会出现 2 帧空白（宠物闪烁/消失），
// 这也是社区 spritesheet 最常见的问题。
const DEFAULT_CODEX_STATES = Object.freeze({
  idle: { row: 0, frames: 6, durationMs: 160, loop: true },
  'running-right': { row: 1, frames: 8, durationMs: 110, loop: true },
  'running-left': { row: 2, frames: 8, durationMs: 110, loop: true },
  waving: { row: 3, frames: 4, durationMs: 140, loop: false },
  jumping: { row: 4, frames: 5, durationMs: 120, loop: false },
  failed: { row: 5, frames: 8, durationMs: 140, loop: false },
  waiting: { row: 6, frames: 6, durationMs: 150, loop: true },
  running: { row: 7, frames: 6, durationMs: 120, loop: true },
  review: { row: 8, frames: 6, durationMs: 140, loop: true }
});

const sanitizeId = (value) => String(value ?? '')
  .trim()
  .replace(/\.(png|svg|webp|gif)$/iu, '')
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

/** 解析 Codex Pet 的 pet.json；非法包返回 null，不进入目录。 */
export function readMascotPackage(dir) {
  if (!dir) return null;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, PET_MANIFEST), 'utf8'));
  } catch {
    return null;
  }
  if (!manifest || typeof manifest !== 'object') return null;
  const id = sanitizeId(manifest.id || path.basename(dir));
  if (!id) return null;
  const sheetName = String(
    manifest.spritesheetPath ?? manifest.spritesheet ?? manifest.file ?? ''
  ).replace(/\\/gu, '/');
  if (!sheetName || path.isAbsolute(sheetName) || sheetName.split('/').includes('..')) return null;
  const sheet = path.join(dir, sheetName);
  if (!fs.existsSync(sheet)) return null;
  const version = Number(manifest.spriteVersionNumber ?? manifest.version ?? 1) || 1;
  const columns = Math.max(1, Math.min(32, Number(manifest.columns) || 8));
  const rows = Math.max(1, Math.min(32, Number(manifest.rows) || (version >= 2 ? 11 : 9)));
  const frameWidth = Math.max(1, Number(manifest.frameWidth) || 192);
  const frameHeight = Math.max(1, Number(manifest.frameHeight) || 208);
  const rawStates = manifest.states
    ?? manifest.animations?.states
    ?? manifest.animation?.states
    ?? {};
  const states = Object.fromEntries(
    Object.entries(DEFAULT_CODEX_STATES).map(([name, value]) => [name, { ...value }])
  );
  for (const [name, value] of Object.entries(rawStates)) {
    if (!value || typeof value !== 'object') continue;
    const row = Number(value.row);
    if (!Number.isSafeInteger(row) || row < 0 || row >= rows) continue;
    // 自定义状态若同名，用该状态的 Codex 默认值兜底，避免把 jumping 的循环属性写错。
    const base = states[name] ?? {};
    const durationMs = Math.max(20, Number(value.durationMs ?? value.duration ?? base.durationMs ?? 150));
    const frames = Math.max(1, Math.min(columns, Number(value.frames) || base.frames || columns));
    states[name] = {
      row,
      durationMs,
      lastFrameDurationMs: Math.max(20, Number(value.lastFrameDurationMs ?? durationMs)),
      frames,
      loop: (value.loop ?? base.loop) !== false
    };
  }
  for (const state of Object.values(states)) {
    state.frames = Math.max(1, Math.min(columns, state.frames ?? columns));
    state.lastFrameDurationMs = state.lastFrameDurationMs ?? state.durationMs;
    state.loop = state.loop !== false;
  }
  return {
    id,
    label: String(manifest.displayName ?? manifest.name ?? id).slice(0, 80),
    kind: 'sprite',
    source: 'custom',
    dir,
    file: sheet,
    sheetName,
    version,
    collection: manifest.collection === 'petdex' ? 'petdex' : '',
    rank: Number.isSafeInteger(manifest.rank) && manifest.rank > 0 ? manifest.rank : null,
    sprite: {
      frameWidth,
      frameHeight,
      columns,
      rows,
      states,
      version
    }
  };
}

function scanDir(dir, source) {
  if (!dir) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const items = [];
  for (const entry of entries) {
    if (entry.isFile() && IMAGE_PATTERN.test(entry.name)) {
      items.push({
        id: sanitizeId(entry.name),
        label: sanitizeId(entry.name),
        source,
        kind: 'static',
        file: path.join(dir, entry.name)
      });
    } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const pkg = readMascotPackage(path.join(dir, entry.name));
      if (pkg) items.push({ ...pkg, source });
    }
  }
  return items;
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
  const petdex = [...byId.values()].filter(item=>item.source==='builtin'&&item.collection==='petdex')
    .sort((a,b)=>(a.rank??999)-(b.rank??999)||a.id.localeCompare(b.id));
  const petdexIds = new Set(petdex.map(item=>item.id));
  const ordered = [
    ...petdex.map(item=>({...item,label:labels[item.id]??item.label,builtin:true})),
    ...MASCOT_SKINS.filter((id) => byId.has(id)).map((id) => ({
      ...byId.get(id), label: labels[id] ?? BUILTIN_LABELS[id] ?? byId.get(id).label, builtin: byId.get(id).source === 'builtin'
    })),
    ...[...byId.values()]
      .filter((item) => !MASCOT_SKINS.includes(item.id)&&!petdexIds.has(item.id))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((item) => ({ ...item, label: labels[item.id] ?? item.label, builtin: item.source === 'builtin' }))
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
    kind: found?.kind ?? 'static',
    file: found?.file ?? '',
    sprite: found?.sprite ?? null,
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

/**
 * 导入一个 Codex Pet 包到 userDir。
 * sourcePath 可以是包含 pet.json 的目录、pet.json 本身，或 spritesheet 路径。
 * 只复制 pet.json、spritesheet 与可选 preview，不复制整个仓库。
 */
export function importMascot({ sourcePath = '', userDir = '' } = {}) {
  if (!sourcePath || !userDir) throw new Error('皮肤来源与用户目录必填');
  let dir = sourcePath;
  try {
    if (fs.statSync(sourcePath).isFile()) dir = path.dirname(sourcePath);
  } catch {
    throw new Error('皮肤路径不存在');
  }
  const pkg = readMascotPackage(dir);
  if (!pkg) throw new Error('不是有效的 Codex Pet 包：需要 pet.json 与 spritesheet');
  const target = path.join(userDir, pkg.id);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(path.join(dir, PET_MANIFEST), path.join(target, PET_MANIFEST));
  const sheetTarget = path.join(target, pkg.sheetName);
  fs.mkdirSync(path.dirname(sheetTarget), { recursive: true });
  fs.copyFileSync(pkg.file, sheetTarget);
  for (const extra of ['preview.png', 'preview.webp', 'preview.gif', 'preview.jpg']) {
    const source = path.join(dir, extra);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(target, extra));
  }
  return { skin: pkg.id, label: pkg.label, dir: target };
}

/** 五态 → Codex 阶段；未知状态按 idle 处理。 */
export function phaseForState(state) {
  return STATE_TO_PHASE[state] ?? 'idle';
}

/** 阶段 → 动画行；优先 Codex 状态名，找不到时回退 idle。 */
export function animationForPhase(phase, states = {}) {
  const map = {
    idle: 'idle',
    running: 'running',
    'needs-interaction': states.waiting ? 'waiting' : 'review',
    completed: states.review ? 'review' : 'waving',
    error: 'failed'
  };
  const wanted = map[phase] ?? 'idle';
  if (states[wanted]) return { name: wanted, ...states[wanted] };
  if (states.idle) return { name: 'idle', ...states.idle };
  return null;
}
