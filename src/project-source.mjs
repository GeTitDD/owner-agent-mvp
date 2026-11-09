// 项目来源主机推断。
//
// 面板顶部按“来源主机”给项目分组，但 owner_projects 只存根路径，
// 因此从路径形式判断：
//   - UNC（\\host\share\...）→ share 前的主机；
//   - ssh:// / sftp:// / git:// → URL 中的主机；
//   - 盘符（C:\...）或 POSIX 路径 → 当前主机。
import os from 'node:os';

/** 当前主机名（每次调用，便于测试与容器改名）。 */
export const localHostName = () => os.hostname();

/**
 * 推断项目根路径所属主机。
 * @param {string} root 项目根路径
 * @param {string} [localHost] 当前主机名，默认 os.hostname()
 * @returns {string} 主机名
 */
export function hostOfRoot(root, localHost = localHostName()) {
  const value = String(root ?? '').trim();
  const ssh = /^(?:ssh|sftp|git):\/\/(?:[^@/]+@)?([^/:]+)/iu.exec(value);
  if (ssh) return ssh[1];
  const unc = /^[\\/]{2}([^\\/]+)[\\/]/u.exec(value);
  if (unc) return unc[1];
  return localHost;
}

/**
 * 分组标题：本机带上主机名，远端标注“远程”。
 * @param {string} host 主机名
 * @param {string} [localHost] 当前主机名
 * @returns {string} 显示用分组标题
 */
export function hostLabelOf(host, localHost = localHostName()) {
  return host === localHost ? `本机 · ${localHost}` : `远程 · ${host}`;
}
