// Shared, best-effort project-root identity checks (v0.7 marker reused by v0.8).
//
// The marker file `.owner-root-identity` is created inside the registered project root
// at registration time. Its dev/ino hash pins the directory identity: a deleted and
// recreated directory, or a root swapped for a link to another directory, has a different
// identity. This is NOT adversarial OS fencing (inode reuse after deletion is possible);
// it is a deterministic drift check shared by every worker that touches a project root.
import { statSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { sha256 } from './utils.mjs';

// Hash of the marker file's dev/ino pair. Returns null when the marker is missing.
export const rootIdentityOf = (root) => {
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
    const identity = rootIdentityOf(root);
    if (identity === null) return { ok: false, reason: 'project-root-missing' };
    if (identity !== project.root_identity) return { ok: false, reason: 'project-root-moved' };
  }
  return { ok: true, root };
};
