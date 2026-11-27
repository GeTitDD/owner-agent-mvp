// 目录身份只读采集并保存在应用数据库，登记与验证都不向被观察仓库写文件。
// 旧库仍按原标记校验；不自动清理旧文件，避免修改用户仓库或绕过原有漂移保护。
// 这是尽力而为的漂移检查，不代替操作系统级隔离。
import { statSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { sha256 } from './utils.mjs';

// 出生时间不会因普通文件编辑而改变，并减少目录删除重建后 inode 复用造成的误认。
export const rootIdentityOf = (root) => {
  try {
    const st = statSync(root, { bigint: true });
    if (!st.isDirectory()) return null;
    return `dir-v1:${sha256(`${st.dev}:${st.ino}:${st.birthtimeNs}`).slice(0, 32)}`;
  } catch {
    return null;
  }
};

// 兼容已登记项目；这里只读原标记，缺失时仍按原保护规则拒绝。
const legacyRootIdentityOf = (root) => {
  try {
    const st = statSync(path.join(root, '.owner-root-identity'), { bigint: true });
    return sha256(`${st.dev}:${st.ino}`).slice(0, 32);
  } catch {
    return null;
  }
};

// Canonicalize for comparison. On Windows, `realpathSync.native` expands 8.3 short
// names (e.g. `D:\NAUTIL~1\...`) while the non-native variant does not, which would
// otherwise make a git-reported toplevel look different from a registered temp root.
const comparisonPath = (value) => {
  if (process.platform !== 'win32') return value;
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
};

// Compare two paths using the platform's case rules (Windows is case-insensitive).
export const samePath = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = comparisonPath(a);
  const right = comparisonPath(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
};

// Resolve and verify a registered project root. Never creates anything.
// Returns {ok:true, root} or {ok:false, reason:'project-root-missing'|'project-root-moved'}.
export const verifyProjectRoot = (project) => {
  if (!project || typeof project.root !== 'string' || !project.root) {
    return { ok: false, reason: 'project-root-missing' };
  }
  let root;
  try {
    // Use the native resolver on Windows so callers see the long (non-8.3) canonical
    // path, matching `fs/promises.realpath` and git's reported toplevel.
    root = process.platform === 'win32' ? realpathSync.native(project.root) : realpathSync(project.root);
  } catch {
    return { ok: false, reason: 'project-root-missing' };
  }
  if (!samePath(root, project.root)) return { ok: false, reason: 'project-root-moved' };
  if (project.root_identity) {
    const identity = project.root_identity.startsWith('dir-v1:')
      ? rootIdentityOf(root)
      : legacyRootIdentityOf(root);
    if (identity === null) return { ok: false, reason: 'project-root-missing' };
    if (identity !== project.root_identity) return { ok: false, reason: 'project-root-moved' };
  }
  return { ok: true, root };
};
