// 删除项目（#93）：先列清单、确认后才删；删库与删文件分开报告，跨项目隔离。
// 只压 src 的纯函数与存储行为：不碰 Electron、不联网、不写真实用户目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OwnerStore } from '../src/owner-store.mjs';
import { ProjectSnapshotStore, SNAPSHOT_FORMAT } from '../src/project-snapshots.mjs';
import { exportFilesOf, exportPublishedVersion } from '../src/project-exports.mjs';
import { deleteProject, projectDeletionPlan, ProjectDeletionError } from '../src/project-deletion.mjs';

const cleanup = (dir) => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 下偶发占用，忽略 */ }
};

const contentOf = (total = 0) => ({
  format: SNAPSHOT_FORMAT,
  project: { id: 'alpha', name: 'Alpha Repo', domains: [] },
  counts: { verified: total, observing: 0, total },
  sections: []
});

/** 两个项目 + 共享连接下的快照存储 + 各自的导出目录。 */
const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-delete-'));
  const owner = new OwnerStore(path.join(dir, 'owner.sqlite'));
  const exportsRoot = path.join(dir, 'exports');
  const roots = {
    alpha: path.join(dir, 'alpha-repo'),
    beta: path.join(dir, 'beta-repo')
  };
  for (const root of Object.values(roots)) fs.mkdirSync(root, { recursive: true });
  owner.registerProject({
    id: 'alpha', name: 'Alpha Repo', root: roots.alpha,
    primaryDomain: 'software-engineering', domains: ['software-engineering']
  });
  owner.registerProject({
    id: 'beta', name: 'Beta Repo', root: roots.beta,
    primaryDomain: 'data-pipeline', domains: ['data-pipeline']
  });
  const snapshots = new ProjectSnapshotStore({ db: owner.db });
  return { dir, owner, snapshots, exportsRoot, roots };
};

/** 发布两版并各自导出，返回导出路径；alpha 额外留一份草稿。 */
const publishAlpha = (fixture) => {
  const { snapshots, exportsRoot } = fixture;
  snapshots.saveDraft({ projectId: 'alpha', content: contentOf(1) });
  snapshots.publish({ projectId: 'alpha', now: '2026-11-24T01:00:00.000Z' });
  snapshots.publish({ projectId: 'alpha', now: '2026-11-24T02:00:00.000Z' });
  // 草稿发布后仍在：删除时必须一起清掉，但不是版本。
  snapshots.saveDraft({ projectId: 'alpha', content: contentOf(2) });
  const paths = [1, 2].map((version) => exportPublishedVersion({
    store: snapshots, root: exportsRoot, projectId: 'alpha', version
  }));
  return paths.map((item) => item.dir);
};

const publishBeta = (fixture) => {
  const { snapshots, exportsRoot } = fixture;
  snapshots.saveDraft({ projectId: 'beta', content: contentOf(3) });
  snapshots.publish({ projectId: 'beta', now: '2026-11-24T03:00:00.000Z' });
  return exportPublishedVersion({ store: snapshots, root: exportsRoot, projectId: 'beta', version: 1 }).dir;
};

const dirExists = (target) => fs.existsSync(target);

const planOf = (fixture) => projectDeletionPlan({
  project: fixture.owner.getProject('alpha'),
  versions: fixture.snapshots.listVersions('alpha'),
  draft: fixture.snapshots.getDraftState('alpha'),
  root: fixture.exportsRoot
});

test('清单：项目名、草稿、版本数、每个导出目录逐条列出，且不删任何东西', () => {
  const fixture = setup();
  try {
    const dirs = publishAlpha(fixture);
    const betaDir = publishBeta(fixture);
    const before = {
      project: Boolean(fixture.owner.getProject('alpha')),
      versions: fixture.snapshots.listVersions('alpha').length,
      draft: Boolean(fixture.snapshots.getDraftState('alpha')),
      dirs: dirs.map(dirExists),
      betaDir: dirExists(betaDir)
    };

    const plan = planOf(fixture);
    assert.equal(plan.projectName, 'Alpha Repo');
    assert.equal(plan.snapshot.count, 2);
    assert.equal(plan.snapshot.hasDraft, true);
    // 逐条：项目、草稿、版本、每个版本的导出目录、项目导出目录。
    const text = plan.items.join('\n');
    assert.match(text, /项目：Alpha Repo（alpha）/u);
    assert.match(text, /快照草稿：1 份/u);
    assert.match(text, /已发布快照：2 个版本（v2、v1）/u);
    for (const dir of dirs) {
      assert.ok(text.includes(`导出目录 v${dir.endsWith('v1') ? 1 : 2}：${dir}`), text);
      assert.ok(plan.dirs.some((item) => item.path === dir && item.exists === true));
    }
    const projectDir = path.dirname(dirs[0]);
    assert.ok(text.includes(`项目导出目录：${projectDir}`), text);
    // 清单是只读的：数据库与文件都没变。
    assert.equal(Boolean(fixture.owner.getProject('alpha')), before.project);
    assert.equal(fixture.snapshots.listVersions('alpha').length, before.versions);
    assert.equal(Boolean(fixture.snapshots.getDraftState('alpha')), before.draft);
    assert.deepEqual(dirs.map(dirExists), before.dirs);
    assert.equal(dirExists(betaDir), before.betaDir);
  } finally {
    fixture.snapshots.close();
    fixture.owner.close();
    cleanup(fixture.dir);
  }
});

test('取消：confirm 不是 true 时什么都不删（数据库与文件前后一致）', () => {
  const fixture = setup();
  try {
    const dirs = publishAlpha(fixture);
    const betaDir = publishBeta(fixture);
    const before = {
      projects: fixture.owner.listProjects().map((project) => project.id).sort(),
      versions: fixture.snapshots.listVersions('alpha').length,
      draft: Boolean(fixture.snapshots.getDraftState('alpha'))
    };

    // 不传 confirm 与显式 false 都不能删。
    for (const confirm of [undefined, false]) {
      const result = deleteProject({
        store: fixture.owner,
        snapshotStore: fixture.snapshots,
        projectId: 'alpha',
        root: fixture.exportsRoot,
        confirm
      });
      assert.equal(result.confirmed, false);
      assert.equal(result.ok, true);
      assert.equal(result.database, null);
      assert.match(result.message, /没有删除/u);
    }

    assert.deepEqual(fixture.owner.listProjects().map((project) => project.id).sort(), before.projects);
    assert.equal(fixture.snapshots.listVersions('alpha').length, before.versions);
    assert.equal(Boolean(fixture.snapshots.getDraftState('alpha')), before.draft);
    assert.ok(dirs.every(dirExists) && dirExists(betaDir));
  } finally {
    fixture.snapshots.close();
    fixture.owner.close();
    cleanup(fixture.dir);
  }
});

test('确认：项目行、子表、草稿、全部快照版本与导出目录都删掉', () => {
  const fixture = setup();
  try {
    const dirs = publishAlpha(fixture);
    const projectDir = path.dirname(dirs[0]);
    const task = fixture.owner.createTask({ projectId: 'alpha', title: '把一个想法做完' });
    fixture.owner.addProjectQueueItem({ projectId: 'alpha', title: '队列条目' });
    fixture.owner.recordEvent({ projectId: 'alpha', kind: 'run_started', sessionId: 's1' });
    fixture.owner.createJob({
      projectId: 'alpha', jobType: 'noop', title: '空任务', idempotencyKey: 'alpha-job-1', ownerTaskId: task.id
    });

    const result = deleteProject({
      store: fixture.owner,
      snapshotStore: fixture.snapshots,
      projectId: 'alpha',
      root: fixture.exportsRoot,
      confirm: true
    });

    assert.equal(result.confirmed, true);
    assert.equal(result.ok, true, JSON.stringify(result.files.failed));
    assert.equal(result.database.versions, 2);
    assert.equal(result.database.drafts, 1);
    assert.equal(fixture.owner.getProject('alpha'), null);
    assert.deepEqual(fixture.snapshots.listVersions('alpha'), []);
    assert.equal(fixture.snapshots.getDraft('alpha'), null);
    // 导出目录连同子目录一起没了；项目源码目录不在删除范围内。
    assert.ok(dirs.every((dir) => !dirExists(dir)));
    assert.equal(dirExists(projectDir), false);
    assert.equal(dirExists(fixture.roots.alpha), true);
    // 子表不再有指向已删项目的行（事件 / 运行 / 任务 / Job / 队列）。
    for (const [table, column] of [
      ['owner_events', 'project_id'],
      ['owner_runs', 'project_id'],
      ['owner_tasks', 'project_id'],
      ['owner_jobs', 'project_id'],
      ['owner_project_queue', 'project_id']
    ]) {
      const row = fixture.owner.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=?`).get('alpha');
      assert.equal(Number(row.n), 0, `${table} 仍有 alpha 的行`);
    }
  } finally {
    fixture.snapshots.close();
    fixture.owner.close();
    cleanup(fixture.dir);
  }
});

test('跨项目隔离：删 alpha 后 beta 的项目行、快照与导出目录完好', () => {
  const fixture = setup();
  try {
    const dirs = publishAlpha(fixture);
    const betaDir = publishBeta(fixture);
    const betaBefore = {
      project: fixture.owner.getProject('beta'),
      versions: fixture.snapshots.listVersions('beta'),
      draft: fixture.snapshots.getDraft('beta'),
      files: fs.readdirSync(path.join(betaDir))
    };

    deleteProject({
      store: fixture.owner,
      snapshotStore: fixture.snapshots,
      projectId: 'alpha',
      root: fixture.exportsRoot,
      confirm: true
    });

    assert.deepEqual(fixture.owner.getProject('beta'), betaBefore.project);
    assert.deepEqual(fixture.snapshots.listVersions('beta'), betaBefore.versions);
    assert.deepEqual(fixture.snapshots.getDraft('beta'), betaBefore.draft);
    assert.deepEqual(fs.readdirSync(path.join(betaDir)), betaBefore.files);
    assert.ok(betaBefore.files.includes('snapshot.json') && betaBefore.files.includes('report.html'));
    assert.ok(dirs.every((dir) => !dirExists(dir)));
  } finally {
    fixture.snapshots.close();
    fixture.owner.close();
    cleanup(fixture.dir);
  }
});

test('文件删不掉：库里已删，但逐条报告没删掉的路径，不假装成功', () => {
  const fixture = setup();
  try {
    const [v1, v2] = publishAlpha(fixture);
    const projectDir = path.dirname(v1);
    const locked = path.join(v1, 'snapshot.json');
    // 模拟「文件被占用」：只让 v1 目录删不掉，其余照常删。
    const remove = (target) => {
      if (target === v1) throw new Error(`EBUSY: resource busy or locked, unlink '${locked}'`);
      fs.rmSync(target, { recursive: true, force: true });
    };

    const result = deleteProject({
      store: fixture.owner,
      snapshotStore: fixture.snapshots,
      projectId: 'alpha',
      root: fixture.exportsRoot,
      confirm: true,
      remove
    });

    assert.equal(result.ok, false);
    assert.equal(result.database.versions, 2);
    // 数据库照删（先删库、后删文件），文件失败单独报告。
    assert.equal(fixture.owner.getProject('alpha'), null);
    assert.match(result.message, /没删掉/u);
    const paths = result.files.failed.map((item) => item.path);
    assert.ok(paths.includes(v1), paths.join(' | '));
    // 有失败时不再强删项目目录，把它作为「因上面失败而保留」报告。
    assert.ok(paths.includes(projectDir), paths.join(' | '));
    assert.ok(result.files.failed.some((item) => /EBUSY/u.test(item.reason)));
    // 没失败的 v2 已经删掉。
    assert.equal(dirExists(v2), false);
    assert.equal(dirExists(v1), true);
  } finally {
    fixture.snapshots.close();
    fixture.owner.close();
    cleanup(fixture.dir);
  }
});

test('孤儿导出目录：库里没有版本、磁盘上仍有 vN 时也列进清单并删掉', () => {
  const fixture = setup();
  try {
    // 不发布任何版本，只手工造一个导出目录（模拟旧版本行已被别的手段删掉）。
    const orphan = exportFilesOf({ root: fixture.exportsRoot, projectId: 'alpha', version: 9 });
    fs.mkdirSync(orphan.dir, { recursive: true });
    fs.writeFileSync(orphan.snapshotPath, '{"format":"project-snapshot/v1"}');

    const plan = planOf(fixture);
    assert.ok(plan.items.join('\n').includes(`导出目录 v9：${orphan.dir}`), plan.items.join('\n'));
    assert.ok(plan.items.join('\n').includes('库里没有这一版，只存在于磁盘'));

    const result = deleteProject({
      store: fixture.owner,
      snapshotStore: fixture.snapshots,
      projectId: 'alpha',
      root: fixture.exportsRoot,
      confirm: true
    });
    assert.equal(result.ok, true, JSON.stringify(result.files.failed));
    assert.equal(dirExists(path.dirname(orphan.dir)), false);
  } finally {
    fixture.snapshots.close();
    fixture.owner.close();
    cleanup(fixture.dir);
  }
});

test('快照存储不可用：拒绝删除，不让项目行先没了、快照变孤儿', () => {
  const fixture = setup();
  try {
    publishAlpha(fixture);
    assert.throws(
      () => deleteProject({
        store: fixture.owner,
        snapshotStore: null,
        projectId: 'alpha',
        root: fixture.exportsRoot,
        confirm: true
      }),
      (error) => error instanceof ProjectDeletionError && error.code === 'delete_snapshots_missing'
    );
    assert.ok(fixture.owner.getProject('alpha'));
    assert.equal(fixture.snapshots.listVersions('alpha').length, 2);
  } finally {
    fixture.snapshots.close();
    fixture.owner.close();
    cleanup(fixture.dir);
  }
});

test('项目不存在：明确失败，不留下半删状态', () => {
  const fixture = setup();
  try {
    assert.throws(
      () => deleteProject({
        store: fixture.owner,
        snapshotStore: fixture.snapshots,
        projectId: 'missing',
        root: fixture.exportsRoot,
        confirm: true
      }),
      (error) => error instanceof ProjectDeletionError && error.code === 'project_missing'
    );
    assert.deepEqual(fixture.owner.listProjects().map((project) => project.id).sort(), ['alpha', 'beta']);
  } finally {
    fixture.snapshots.close();
    fixture.owner.close();
    cleanup(fixture.dir);
  }
});
