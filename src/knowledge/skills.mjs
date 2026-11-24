// 知识模式：技能目录（只读）。
//
// 项目里的「技能」散在三处载体：
//   1. 域包：domains/<id>/<version>/manifest.json 的 skillDirs（与 src/loader.mjs 同一条规则）；
//   2. pstack：外部 skills 目录里的 <id>/SKILL.md（与 playbook 共用 resolvePstackSkillsDir）；
//   3. 插件：plugins/<name>/ghost.json 的 skill.items。
// 这里把三处合并成一份列表并标注来源，只读——不运行技能、不提供编辑入口。
//
// 容错是硬要求：目录不存在、manifest 异常、ghost.json 异常、SKILL.md 缺失都只会让
// 单条（或单个来源）标成「缺失」，不能让整个列表挂掉。

import fs from 'node:fs';
import path from 'node:path';

// 来源顺序即界面上的分组顺序；key 用于视图模型，label 用于展示。
export const SKILL_SOURCES = Object.freeze([
  { key: 'domain', label: '域包' },
  { key: 'pstack', label: 'pstack' },
  { key: 'plugin', label: '插件' }
]);

// 一次扫描结果默认缓存一分钟：切换模式/重复渲染复用，显式刷新才重扫。
export const SKILL_CACHE_TTL_MS = 60_000;
const DEFAULT_GROUP_LIMIT = 12;

const sourceLabel = (key) => SKILL_SOURCES.find((item) => item.key === key)?.label ?? key;

/** 目录/文件是否存在；权限错误等一律当作不存在，扫描不因此中断。 */
const exists = (target) => {
  if (!target) return false;
  try { return fs.existsSync(target); } catch { return false; }
};

/** 读并解析 JSON；失败返回 { ok:false, error }，由调用方降级成「缺失」条目。 */
const readJsonSafe = (file) => {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
};

/** 读一个目录下的子目录名；读不到就返回空数组（目录不存在不算错误）。 */
const listDirs = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
};

/**
 * 解析 SKILL.md 顶部 front-matter 的 name/description。
 * 只认最简单的 `key: value` 行；格式不对就当作没有元数据，不抛错。
 */
export function parseSkillFrontMatter(text) {
  const raw = String(text ?? '').replace(/\r\n/gu, '\n');
  if (!raw.startsWith('---\n')) return {};
  const end = raw.indexOf('\n---', 4);
  if (end < 0) return {};
  const meta = {};
  for (const line of raw.slice(4, end).split('\n')) {
    const match = /^([A-Za-z0-9_-]{1,40}):\s*(.*)$/u.exec(line.trim());
    if (!match) continue;
    const value = match[2].trim().replace(/^["']|["']$/gu, '').trim();
    if (value) meta[match[1]] = value;
  }
  return meta;
}

/** front-matter 没写 description 时，退到正文第一段可读文字。 */
function bodySummary(text) {
  const raw = String(text ?? '').replace(/\r\n/gu, '\n');
  const withoutMeta = raw.startsWith('---\n') ? raw.replace(/^---\n[\s\S]*?\n---\n?/u, '') : raw;
  for (const line of withoutMeta.split('\n')) {
    const value = line.trim();
    if (!value || value.startsWith('#') || value.startsWith('```') || value.startsWith('|')) continue;
    return value.length > 160 ? `${value.slice(0, 160)}…` : value;
  }
  return '';
}

/** 读某个技能的 SKILL.md；缺文件/读失败返回 ok:false 与原因。 */
function readSkillFile(file, fallbackName = '') {
  if (!file) {
    return { ok: false, name: fallbackName, description: '', reason: '没有可用的技能目录' };
  }
  if (!exists(file)) {
    return { ok: false, name: fallbackName, description: '', reason: 'SKILL.md 缺失' };
  }
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const meta = parseSkillFrontMatter(raw);
    return {
      ok: true,
      name: meta.name || fallbackName,
      description: meta.description || bodySummary(raw),
      reason: ''
    };
  } catch (error) {
    return {
      ok: false,
      name: fallbackName,
      description: '',
      reason: `SKILL.md 读取失败：${String(error?.message ?? error)}`
    };
  }
}

const makeEntry = ({ key, id, name, skillPath, description, missing, reason, origin }) => ({
  id,
  source: key,
  sourceLabel: sourceLabel(key),
  name: name || '未命名技能',
  path: skillPath || '',
  description: description || '',
  missing: Boolean(missing),
  reason: missing ? String(reason || '缺失') : '',
  origin: origin || ''
});

/**
 * 域包技能：遍历 domains/<id>/<version>/manifest.json 的 skillDirs。
 * manifest 读不到/格式不对时产出一条「缺失」条目，而不是跳过整个域包。
 */
export function scanDomainSkills({ domainRoot } = {}) {
  const items = [];
  if (!exists(domainRoot)) return items;
  for (const domainId of listDirs(domainRoot)) {
    const versionRoot = path.join(domainRoot, domainId);
    for (const version of listDirs(versionRoot)) {
      const base = path.join(versionRoot, version);
      const origin = `${domainId}@${version}`;
      const manifestPath = path.join(base, 'manifest.json');
      if (!exists(manifestPath)) {
        items.push(makeEntry({
          key: 'domain', id: `domain:${origin}:manifest`, name: origin, skillPath: manifestPath,
          missing: true, reason: 'manifest.json 缺失', origin
        }));
        continue;
      }
      const manifest = readJsonSafe(manifestPath);
      if (!manifest.ok) {
        items.push(makeEntry({
          key: 'domain', id: `domain:${origin}:manifest`, name: origin, skillPath: manifestPath,
          missing: true, reason: `manifest 解析失败：${manifest.error}`, origin
        }));
        continue;
      }
      const dirs = manifest.value?.skillDirs;
      // skillDirs 缺省表示这个域包没有技能；只有类型不对才算 manifest 异常。
      if (dirs === undefined) continue;
      if (!Array.isArray(dirs)) {
        items.push(makeEntry({
          key: 'domain', id: `domain:${origin}:manifest`, name: origin, skillPath: manifestPath,
          missing: true, reason: 'manifest.skillDirs 格式异常', origin
        }));
        continue;
      }
      for (const relative of dirs) {
        if (typeof relative !== 'string' || !relative.trim()) {
          items.push(makeEntry({
            key: 'domain', id: `domain:${origin}:invalid`, name: origin, skillPath: manifestPath,
            missing: true, reason: 'skillDirs 里有非字符串条目', origin
          }));
          continue;
        }
        const dir = path.join(base, relative);
        const skillPath = path.join(dir, 'SKILL.md');
        const meta = readSkillFile(skillPath, path.basename(dir));
        items.push(makeEntry({
          key: 'domain',
          id: `domain:${origin}:${relative}`,
          name: meta.name,
          skillPath,
          description: meta.description,
          missing: !meta.ok,
          reason: meta.reason,
          origin
        }));
      }
    }
  }
  return items;
}

/**
 * pstack 技能：扫描外部 skills 目录里的子目录；目录解析不到时按已知 playbook id
 * 逐个标「缺失」，让来源仍然出现在列表里。
 */
export function scanPstackSkills({ skillsDir, expectedIds = [] } = {}) {
  const items = [];
  const ids = [...new Set(expectedIds.filter((id) => typeof id === 'string' && id))];
  if (!exists(skillsDir)) {
    for (const id of ids) {
      items.push(makeEntry({
        key: 'pstack', id: `pstack:${id}`, name: id, skillPath: '',
        missing: true, reason: '未找到 pstack skills 目录；设置 PSTACK_DIR 后刷新', origin: 'pstack'
      }));
    }
    return items;
  }
  const found = new Set();
  for (const name of listDirs(skillsDir)) {
    found.add(name);
    const skillPath = path.join(skillsDir, name, 'SKILL.md');
    const meta = readSkillFile(skillPath, name);
    items.push(makeEntry({
      key: 'pstack', id: `pstack:${name}`, name: meta.name, skillPath,
      description: meta.description, missing: !meta.ok, reason: meta.reason, origin: 'pstack'
    }));
  }
  // 面板按钮认识、磁盘上没有的 skill 也要列出来，否则用户看不出哪一颗缺了。
  for (const id of ids) {
    if (found.has(id)) continue;
    items.push(makeEntry({
      key: 'pstack', id: `pstack:${id}`, name: id,
      skillPath: path.join(skillsDir, id, 'SKILL.md'),
      missing: true, reason: 'SKILL.md 缺失', origin: 'pstack'
    }));
  }
  return items;
}

/**
 * 插件技能：读 plugins/<name>/ghost.json 的 skill.items，按 dir 找 SKILL.md。
 * 没有 ghost.json 的目录不是技能载体，直接忽略；ghost.json 坏掉才算「缺失」。
 */
export function scanPluginSkills({ pluginsDir } = {}) {
  const items = [];
  if (!exists(pluginsDir)) return items;
  for (const pluginId of listDirs(pluginsDir)) {
    const pluginDir = path.join(pluginsDir, pluginId);
    const ghostPath = path.join(pluginDir, 'ghost.json');
    if (!exists(ghostPath)) continue;
    const ghost = readJsonSafe(ghostPath);
    if (!ghost.ok) {
      items.push(makeEntry({
        key: 'plugin', id: `plugin:${pluginId}:ghost`, name: pluginId, skillPath: ghostPath,
        missing: true, reason: `ghost.json 解析失败：${ghost.error}`, origin: pluginId
      }));
      continue;
    }
    const declared = ghost.value?.skill?.items;
    if (declared === undefined) continue;
    if (!Array.isArray(declared)) {
      items.push(makeEntry({
        key: 'plugin', id: `plugin:${pluginId}:items`, name: pluginId, skillPath: ghostPath,
        missing: true, reason: 'skill.items 格式异常', origin: pluginId
      }));
      continue;
    }
    for (const [index, item] of declared.entries()) {
      const relative = typeof item?.dir === 'string' ? item.dir.trim() : '';
      const declaredName = typeof item?.name === 'string' ? item.name.trim() : '';
      const fallback = declaredName || (relative ? path.basename(relative) : pluginId);
      const skillPath = relative ? path.join(pluginDir, relative, 'SKILL.md') : '';
      const meta = readSkillFile(skillPath, fallback);
      const declaredDescription = typeof item?.description === 'string' ? item.description.trim() : '';
      items.push(makeEntry({
        key: 'plugin',
        id: `plugin:${pluginId}:${index}`,
        name: meta.name || fallback,
        skillPath,
        description: declaredDescription || meta.description,
        // 没有 dir 就找不到 SKILL.md，同样按缺失处理，并说明是声明本身缺字段。
        missing: !meta.ok,
        reason: relative ? meta.reason : 'skill.items 条目缺少 dir',
        origin: pluginId
      }));
    }
  }
  return items;
}

/**
 * 组装技能目录视图模型（纯函数）。
 *
 * 每组内「缺失」排在最前，这样即便条目被截断，缺失也不会被藏起来。
 */
export function skillCatalogView({ items = [], scannedAt = null, limit = DEFAULT_GROUP_LIMIT } = {}) {
  const cap = Math.max(1, Number.isSafeInteger(limit) ? limit : DEFAULT_GROUP_LIMIT);
  const groups = SKILL_SOURCES.map(({ key, label }) => {
    const all = items.filter((item) => item.source === key);
    const ordered = [...all].sort((a, b) =>
      Number(b.missing) - Number(a.missing) || String(a.name).localeCompare(String(b.name)));
    const shown = ordered.slice(0, cap);
    return {
      key,
      label,
      count: all.length,
      missing: all.filter((item) => item.missing).length,
      shown: shown.length,
      truncated: all.length > shown.length,
      items: shown
    };
  });
  const missing = items.filter((item) => item.missing).length;
  const totals = {
    all: items.length,
    missing,
    present: items.length - missing,
    domain: groups.find((group) => group.key === 'domain')?.count ?? 0,
    pstack: groups.find((group) => group.key === 'pstack')?.count ?? 0,
    plugin: groups.find((group) => group.key === 'plugin')?.count ?? 0
  };
  // 全空时说明「为什么空」，而不是留一片空白。
  const empty = items.length
    ? null
    : {
        kind: 'no-skills',
        title: '三处都没有找到技能',
        detail: '域包看 domains/*/*/manifest.json 的 skillDirs，pstack 看 PSTACK_DIR，插件看 ghost.json 的 skill.items；确认目录后点刷新。'
      };
  return { scannedAt, totals, groups, empty };
}

/**
 * 扫一遍三处来源并组装视图模型。
 *
 * 路径由调用方注入（Electron 主进程知道应用根目录与 PSTACK_DIR），
 * 这样纯函数部分可以在 node --test 里用临时目录覆盖。
 */
export function skillCatalogFor({
  domainRoot = '',
  pluginsDir = '',
  pstackSkillsDir = '',
  pstackSkillIds = [],
  limit = DEFAULT_GROUP_LIMIT,
  scannedAt = new Date().toISOString()
} = {}) {
  const items = [
    ...scanDomainSkills({ domainRoot }),
    ...scanPstackSkills({ skillsDir: pstackSkillsDir, expectedIds: pstackSkillIds }),
    ...scanPluginSkills({ pluginsDir })
  ];
  return { ...skillCatalogView({ items, scannedAt, limit }), scannedAt };
}

/**
 * 扫描结果缓存：TTL 内复用，refresh:true 强制重扫。
 * 只扫三个已知根目录，不做全盘遍历；面板重复渲染不会重复读盘。
 */
export function createSkillCatalogCache({ scan, ttlMs = SKILL_CACHE_TTL_MS, now = () => Date.now() } = {}) {
  if (typeof scan !== 'function') throw new Error('skill catalog cache needs a scan function');
  let cached = null;
  return {
    read({ refresh = false } = {}) {
      const at = now();
      if (!refresh && cached && at - cached.at < ttlMs) {
        return { ...cached.value, cached: true, ttlMs };
      }
      const value = scan();
      cached = { at, value };
      return { ...value, cached: false, ttlMs };
    },
    clear() { cached = null; }
  };
}
