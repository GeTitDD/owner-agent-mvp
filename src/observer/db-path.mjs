// Owner 审计库位置解析（观察台与命令行共用）。
//
// 独立性启动（不经 Electron）时，观察台原先读 ~/.domain-context/index.sqlite，
// 而桌面端把项目登记写进 %APPDATA%\owner-agent-mvp\owner.sqlite，结果就是空观察台。
// 这里给出确定性的优先级：
//   1. OWNER_OBSERVER_DB（观察员专用覆盖）
//   2. OWNER_AGENT_DB（Owner 通用覆盖，桌面端也用这个变量）
//   3. 桌面端 userData 的 owner.sqlite（只有存在时才用，避免凭空造空库）
//   4. 现有默认路径 defaultDbPath()
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultDbPath } from '../storage.mjs';

/** 与 desktop/main.cjs 的 app.setPath('userData', ...) 保持一致。 */
const DESKTOP_DIR_NAME = 'owner-agent-mvp';

/**
 * Electron 的 appData 目录（userData 的父目录）。
 * @param {{env?:object, platform?:string, homeDir?:string}} [options]
 * @returns {string}
 */
export function desktopAppDataDir({ env = process.env, platform = process.platform, homeDir = os.homedir() } = {}) {
  const read = (value) => (typeof value === 'string' ? value.trim() : '');
  if (platform === 'win32') {
    return read(env.APPDATA) || path.join(homeDir, 'AppData', 'Roaming');
  }
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support');
  }
  return read(env.XDG_CONFIG_HOME) || path.join(homeDir, '.config');
}

/**
 * 桌面端 userData 目录。
 * @param {{env?:object, platform?:string, homeDir?:string}} [options]
 * @returns {string}
 */
export function desktopUserDataDir(options = {}) {
  return path.join(desktopAppDataDir(options), DESKTOP_DIR_NAME);
}

/**
 * 解析观察员应使用的审计库路径。
 * @param {{env?:object, platform?:string, homeDir?:string, exists?:Function,
 *   fallback?:string}} [options]
 * @returns {string}
 */
export function resolveObserverDbPath({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
  exists = fs.existsSync,
  fallback = defaultDbPath()
} = {}) {
  const read = (value) => (typeof value === 'string' ? value.trim() : '');
  const explicit = read(env?.OWNER_OBSERVER_DB) || read(env?.OWNER_AGENT_DB);
  if (explicit) return explicit;

  const desktopDb = path.join(desktopUserDataDir({ env, platform, homeDir }), 'owner.sqlite');
  if (exists(desktopDb)) return desktopDb;
  return fallback;
}
