// 删除项目（#93）：项目行、该项目的快照、以及本地导出目录一起删掉。
//
// 语义来自 ADR-0009 的后果一节：「已发布的东西随项目一起消失」是选定语义，不是疏漏。
// 因此这里不做归档、不做软删除，删除前必须把将删的东西逐条列出来，由人确认。
//
// 三条硬约束（issue #93）：
// 1. 先列清单、后删除。listProjectDeletion 只读；deleteProject 只有 confirm === true
//    才动手，其余情况原样返回「什么都没删」。
// 2. 顺序固定：一个事务删数据库（快照 + 项目行及其子表），提交成功后才删文件。
//    数据库失败就回滚，文件一个都不碰；文件删不掉时逐条报告，不假装成功。
// 3. 导出目录路径只能来自 project-exports 的 exportFilesOf：删除和写入用同一个拼接
//    函数，才不会出现「删的地方和写的地方对不上」。项目目录由它推出的版本目录取父级，
//    同样不另拼一遍。
//
// 只删我们写出的导出目录，绝不动项目源码目录（owner_projects.root）。

import fs from 'node:fs';
import path from 'node:path';
import { exportFilesOf } from './project-exports.mjs';

export class ProjectDeletionError extends Error {
  constructor(message, code = 'delete_invalid', status = 400) {
    super(message);
    this.name = 'ProjectDeletionError';
    this.code = code;
    this.status = status;
  }
}

const fail = (message, code = 'delete_invalid', status = 400) => {
  throw new ProjectDeletionError(message, code, status);
};

const asArray = (value) => (Array.isArray(value) ? value : []);
const labelOf = (version) => `v${version}`;
const defaultExists = (target) => fs.existsSync(target);
const defaultRemove = (target) => fs.rmSync(target, { recursive: true, force: true });

/**
 * 导出项目目录：由 exportFilesOf 推出的 v1 目录取父级（<root>/<projectId>）。
 * 不在这里写 path.join(root, projectId)，保证与写入方完全同一口径。
 */
const projectExportDirOf = ({ root, projectId }) =>
  path.dirname(exportFilesOf({ root, projectId, version: 1 }).dir);

/**
 * 一个项目的全部版本目录（从新到旧）。
 *
 * 版本号有两个来源，取并集：
 * - 库里已发布的版本（正常情况，导出只可能来自发布）；
 * - 磁盘上已有的 vN 目录（防止旧版本行被别的手段删掉后留下孤儿目录）。
 * 两个来源都只给版本号，路径一律交给 exportFilesOf 拼接。
 */
const versionDirectoriesOf = ({ root, projectId, versions, readdir }) => {
  const numbers = new Set(
    asArray(versions)
      .filter((item) => Number.isSafeInteger(item?.version) && item.version > 0)
      .map((item) => item.version)
  );
  const projectDir = projectExportDirOf({ root, projectId });
  try {
    for (const entry of readdir(projectDir)) {
      if (!entry?.isDirectory?.()) continue;
      const match = /^v(\d+)$/u.exec(String(entry.name ?? ''));
      if (!match) continue;
      const version = Number(match[1]);
      if (Number.isSafeInteger(version) && version > 0) numbers.add(version);
    }
  } catch {
    // 项目导出目录还不存在：只按库里的版本列，不需要额外报错。
  }
  return [...numbers]
    .sort((a, b) => b - a)
    .map((version) => ({
      version,
      label: labelOf(version),
      dir: exportFilesOf({ root, projectId, version }).dir
    }));
};

/**
 * 删除清单（只读）。给面板逐条展示：项目名、快照版本、导出目录。
 *
 * @param {object} input
 * @param {{id:string,name?:string,root?:string}} input.project owner 项目行
 * @param {Array<{version:number,publishedAt?:string,note?:string}>} [input.versions] 已发布版本
 * @param {{generatedAt?:string}|null} [input.draft] 草稿摘要（有就说明会一起删）
 * @param {string} input.root 导出根（桌面端是 <userData>/exports）
 */
export function projectDeletionPlan({
  project,
  versions = [],
  draft = null,
  root,
  exists = defaultExists,
  readdir = (target) => fs.readdirSync(target, { withFileTypes: true })
} = {}) {
  const projectId = String(project?.id ?? '').trim();
  const rows = asArray(versions)
    .filter((item) => Number.isSafeInteger(item?.version) && item.version > 0)
    .sort((a, b) => b.version - a.version);
  const versionDirs = versionDirectoriesOf({ root, projectId, versions: rows, readdir });
  const projectDir = projectExportDirOf({ root, projectId });
  const dirs = versionDirs.map((item) => ({
    version: item.version,
    label: item.label,
    path: item.dir,
    // 库里没有这一版却存在目录：说明是孤儿导出目录，清单里写清来源。
    published: rows.some((row) => row.version === item.version),
    exists: Boolean(exists(item.dir))
  }));
  dirs.push({ version: 0, label: '项目导出目录', path: projectDir, published: null, exists: Boolean(exists(projectDir)) });

  const items = [
    `项目：${String(project?.name ?? projectId)}（${projectId}）`,
    draft ? '快照草稿：1 份（该项目的草稿会一起删除）' : '快照草稿：没有',
    rows.length
      ? `已发布快照：${rows.length} 个版本（${rows.map((row) => labelOf(row.version)).join('、')}）`
      : '已发布快照：没有',
    ...dirs.map((item) => {
      if (item.version === 0) {
        return `项目导出目录：${item.path}${item.exists ? '' : '（不存在，跳过）'}`;
      }
      return `导出目录 ${item.label}：${item.path}`
        + (item.exists ? '' : '（不存在，跳过）')
        + (item.published ? '' : '（库里没有这一版，只存在于磁盘）');
    })
  ];

  return {
    projectId,
    projectName: String(project?.name ?? projectId),
    // 只用于展示「删的是哪个项目」；删除动作不会碰这个目录。
    projectRoot: String(project?.root ?? ''),
    snapshot: {
      hasDraft: Boolean(draft),
      count: rows.length,
      versions: rows.map((row) => ({
        version: row.version,
        label: labelOf(row.version),
        publishedAt: row.publishedAt ?? null
      }))
    },
    dirs,
    items
  };
}

/**
 * 执行删除。
 *
 * @param {object} input
 * @param {object} input.store OwnerStore（需要 getProject / deleteProjectInTx）
 * @param {object} input.snapshotStore ProjectSnapshotStore（需要 listVersions / purgeProjectData）
 * @param {string} input.projectId
 * @param {string} input.root 导出根
 * @param {boolean} [input.confirm] 必须严格等于 true 才删
 * @param {Function} [input.remove] 删目录的函数；测试用它模拟「文件被占用删不掉」
 */
export function deleteProject({
  store,
  snapshotStore = null,
  projectId,
  root,
  confirm = false,
  remove = defaultRemove
} = {}) {
  if (!store || typeof store.getProject !== 'function' || typeof store.deleteProjectInTx !== 'function') {
    fail('项目存储不可用', 'delete_store_missing', 503);
  }
  // 没有快照存储就拒绝删除：否则项目行没了、快照表还留着孤儿行，正好是删除连坐要避免的状态。
  if (!snapshotStore || typeof snapshotStore.purgeProjectData !== 'function'
    || typeof snapshotStore.listVersions !== 'function') {
    fail('快照存储不可用，不能删除项目', 'delete_snapshots_missing', 503);
  }
  const id = String(projectId ?? '').trim();
  if (!id) fail('Invalid project id');
  const project = store.getProject(id);
  if (!project) fail('项目不存在或已被删除', 'project_missing', 404);

  const listVersions = () => snapshotStore.listVersions(id, { limit: 200 });
  const purge = () => snapshotStore.purgeProjectData(id);

  const plan = projectDeletionPlan({
    project,
    versions: listVersions(),
    draft: snapshotStore?.getDraftState?.(id) ?? null,
    root
  });

  // 未确认：清单照给，数据库与文件都不动。
  if (confirm !== true) {
    return {
      confirmed: false,
      plan,
      database: null,
      files: { removed: [], failed: [] },
      ok: true,
      message: '未确认，没有删除任何东西。'
    };
  }

  // 1) 数据库：快照与项目行在同一个事务里，失败整体回滚。
  // 快照表没有到 owner_projects 的外键（它们先于项目删除功能存在），所以显式清。
  let database;
  const db = store.db;
  db.exec('BEGIN IMMEDIATE');
  try {
    const snapshots = purge();
    const removed = store.deleteProjectInTx(id);
    db.exec('COMMIT');
    database = {
      projectId: id,
      project: 1,
      drafts: Number(snapshots.drafts ?? 0),
      versions: Number(snapshots.versions ?? 0),
      rows: removed?.rows ?? removed?.removed ?? 0
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }

  // 2) 文件：数据库已经删干净，这里只删导出目录。先逐版本删，最后删项目目录；
  // 有任何一个版本目录没删掉时不再强删项目目录（否则可能把「报告为失败」的路径顺手删掉，
  // 报告就不准了），而是把项目目录标成「因上面失败而保留」。
  const removedPaths = [];
  const failed = [];
  const versionDirs = plan.dirs.filter((item) => item.version > 0);
  const projectDir = plan.dirs.find((item) => item.version === 0);
  for (const item of versionDirs) {
    if (!item.exists || !fs.existsSync(item.path)) continue;
    try {
      remove(item.path);
      removedPaths.push(item.path);
    } catch (error) {
      failed.push({ path: item.path, reason: String(error?.message ?? error) });
    }
  }
  if (projectDir?.exists && fs.existsSync(projectDir.path)) {
    if (failed.length === 0) {
      try {
        remove(projectDir.path);
        removedPaths.push(projectDir.path);
      } catch (error) {
        failed.push({ path: projectDir.path, reason: String(error?.message ?? error) });
      }
    } else {
      failed.push({
        path: projectDir.path,
        reason: `因上面 ${failed.length} 个路径没删掉，项目导出目录也按原样保留`
      });
    }
  }

  const ok = failed.length === 0;
  return {
    confirmed: true,
    plan,
    database,
    files: { removed: removedPaths, failed },
    ok,
    message: ok
      ? `已删除项目「${project.name}」：快照 ${database.versions} 个版本、${removedPaths.length} 个目录。`
      : `项目「${project.name}」已从库里删除，但有 ${failed.length} 个路径没删掉，见清单。`
  };
}
