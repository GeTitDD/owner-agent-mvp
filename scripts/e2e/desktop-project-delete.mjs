// 删除项目验收（#93）：先列清单、取消不删、确认删干净、跨项目隔离、文件删不掉时明确报告。
//
// 用 scripts/e2e/lib/cdp.mjs 的共用客户端：本 worktree 专属临时 userData + 临时 owner 库，
// 导出根就是 <临时 userData>/exports，不碰真实 %APPDATA%。
// 「文件被占用」用 PowerShell 以 FileShare.None 打开一个导出文件来模拟，删目录会拿到 EBUSY；
// 这比在界面里注入假实现更接近真实失败。
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OwnerStore } from '../../src/owner-store.mjs';
import { ProjectSnapshotStore, SNAPSHOT_FORMAT } from '../../src/project-snapshots.mjs';
import { exportFilesOf, exportPublishedVersion } from '../../src/project-exports.mjs';
import { capture, consoleErrors, createChecker, sleep, startApp, waitFor } from './lib/cdp.mjs';

const { check, failures } = createChecker('[DELETE]');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const snapshotOf = (project) => ({
  format: SNAPSHOT_FORMAT,
  project: { id: project.id, name: project.name, domains: [] },
  counts: { verified: 0, observing: 0, total: 0 },
  sections: []
});

/** 采集一个项目的快照与导出：drafts 份草稿、versions 个已发布版本。 */
const seedSnapshots = (ownerDb, root, project, versions) => {
  const store = new ProjectSnapshotStore(ownerDb);
  try {
    store.saveDraft({ projectId: project.id, content: snapshotOf(project) });
    const dirs = [];
    for (let version = 1; version <= versions; version += 1) {
      store.publish({ projectId: project.id, now: `2026-11-24T0${version}:00:00.000Z` });
      dirs.push(exportPublishedVersion({
        store, root, projectId: project.id, version
      }).dir);
    }
    return dirs;
  } finally {
    store.close();
  }
};

/** 只读查询：主进程仍开着库，WAL 下另开只读连接取断言用的事实。 */
const query = (file, sql, params = []) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=3000');
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
};
const count = (file, sql, params = []) => Number(query(file, sql, params)[0]?.n ?? NaN);
const projectCount = (file, id) => count(file, 'SELECT COUNT(*) AS n FROM owner_projects WHERE id=?', [id]);
const versionCount = (file, id) => count(file, 'SELECT COUNT(*) AS n FROM project_snapshot_versions WHERE project_id=?', [id]);
const draftCount = (file, id) => count(file, 'SELECT COUNT(*) AS n FROM project_snapshot_drafts WHERE project_id=?', [id]);

const focusProject = async (panel, projectId) => {
  await waitFor(panel, `typeof window.companion?.snapshot === 'function'`);
  const focusShown = await waitFor(panel, `(() => {
    document.querySelector('#modeBar button[data-mode="focus"]')?.click();
    const mode = document.getElementById('modeA');
    return mode && !mode.hidden;
  })()`);
  if (!focusShown) throw new Error('focus mode did not open');
  const tabbed = await waitFor(panel, `document.querySelector('#fdTabs .fd-tab[data-project="${projectId}"]')`);
  if (!tabbed) throw new Error(`project tab ${projectId} not found`);
  await panel.evaluate(`document.querySelector('#fdTabs .fd-tab[data-project="${projectId}"]').click()`);
  // 标签的 on 类只在快照回来、视图项目真的切过去之后才出现：等它，别拿上一个项目的库当就绪。
  const selected = await waitFor(panel, `document.querySelector('#fdTabs .fd-tab[data-project="${projectId}"].on')`);
  if (!selected) throw new Error(`project ${projectId} did not become the active tab`);
  const ready = await waitFor(panel, `(() => {
    const section = document.getElementById('librarySection');
    return section && !section.hidden && document.getElementById('libraryDeleteProject');
  })()`);
  if (!ready) throw new Error(`library section did not render for ${projectId}`);
  await panel.evaluate("document.getElementById('librarySection').scrollIntoView({ block: 'center' })");
  await sleep(300);
};

/** 打开删除确认框并取回标题与逐条清单。 */
const openDeleteDialog = async (panel) => {
  await panel.evaluate("document.getElementById('libraryDeleteProject').click()");
  const shown = await waitFor(panel, `!document.getElementById('modal').hidden`);
  if (!shown) throw new Error('delete dialog did not open');
  await sleep(200);
  return panel.evaluate(`(() => ({
    title: document.getElementById('modalTitle').textContent.trim(),
    items: [...document.querySelectorAll('#modalBody .delete-plan-list li')].map((node) => node.textContent.trim()),
    warning: document.querySelector('#modalBody .delete-warning')?.textContent?.trim() ?? ''
  }))()`);
};

const clickModalButton = (panel, label) => panel.evaluate(`(() => {
  const button = [...document.querySelectorAll('#modalFoot button')]
    .find((node) => node.textContent.trim() === ${JSON.stringify(label)});
  if (!button) return false;
  button.click();
  return true;
})()`);

/** 用 PowerShell 以 FileShare.None 打开文件：Windows 上这会挡住删除（EBUSY）。 */
const lockFile = async (file) => {
  const quoted = file.replace(/'/gu, "''");
  const script = `$handle=[System.IO.File]::Open('${quoted}','Open','Read','None'); Start-Sleep -Seconds 120; $handle.Close()`;
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'ignore', windowsHide: true
  });
  await sleep(2500);
  return child;
};

const run = async () => {
  const base = process.env.TMP_EXPORT ?? os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'companion-delete-'));
  const userData = path.join(root, 'userdata');
  const ownerDb = path.join(root, 'owner.sqlite');
  const knowledgeDb = path.join(root, 'knowledge.sqlite');
  const exportsRoot = path.join(userData, 'exports');
  const evidence = process.env.EVIDENCE_DIR ?? path.join(root, 'evidence');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });

  const projects = {
    alpha: { id: 'alpha', name: 'Alpha Repo', root: path.join(root, 'alpha-repo') },
    beta: { id: 'beta', name: 'Beta Repo', root: path.join(root, 'beta-repo') },
    gamma: { id: 'gamma', name: 'Gamma Repo', root: path.join(root, 'gamma-repo') }
  };
  const alphaDirs = [];
  const betaDirs = [];
  const gammaDirs = [];
  const owner = new OwnerStore(ownerDb);
  try {
    for (const project of Object.values(projects)) {
      fs.mkdirSync(project.root, { recursive: true });
      owner.registerProject({
        id: project.id,
        name: project.name,
        root: project.root,
        primaryDomain: 'software-engineering',
        domains: ['software-engineering']
      });
    }
  } finally {
    owner.close();
  }
  // alpha 两版 + 一份草稿；beta / gamma 各一版。
  alphaDirs.push(...seedSnapshots(ownerDb, exportsRoot, projects.alpha, 2));
  betaDirs.push(...seedSnapshots(ownerDb, exportsRoot, projects.beta, 1));
  gammaDirs.push(...seedSnapshots(ownerDb, exportsRoot, projects.gamma, 1));
  // 草稿在发布后仍保留：确认清单里要写「1 份」。
  {
    const store = new ProjectSnapshotStore(ownerDb);
    try {
      for (const project of [projects.beta, projects.gamma]) {
        store.saveDraft({ projectId: project.id, content: snapshotOf(project) });
      }
    } finally {
      store.close();
    }
  }

  fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({
    pet: { x: 240, y: 190 }, projectId: 'alpha', mascotSkin: 'erika',
    gatewayUrl: 'http://127.0.0.1:18789', model: '', includePaths: ['package.json']
  }, null, 2));

  const betaFilesBefore = betaDirs.map((dir) => fs.readdirSync(dir).sort().join(','));
  const betaReportHash = sha256(path.join(betaDirs[0], 'report.html'));

  let app = await startApp({ ownerDb, knowledgeDb, userData, showPanel: true });
  let panel = app.panel;
  const shots = [];
  let locked = null;
  let failed = true;
  try {
    await focusProject(panel, 'alpha');

    // 1) 点删除 → 确认框逐条列出项目、草稿、版本与每个导出目录；此时什么都没删。
    const dialog = await openDeleteDialog(panel);
    const listText = dialog.items.join('\n');
    check('确认框标题写明删除哪个项目', dialog.title.includes('Alpha Repo'), dialog.title);
    check('清单写明项目名与项目 id', listText.includes('项目：Alpha Repo（alpha）'), listText);
    check('清单写明草稿会一起删', listText.includes('快照草稿：1 份'), listText);
    check('清单写明快照版本数', listText.includes('已发布快照：2 个版本（v2、v1）'), listText);
    check('清单逐条列出每个版本的导出目录',
      alphaDirs.every((dir) => listText.includes(dir)), listText);
    check('清单列出项目导出目录',
      listText.includes(`项目导出目录：${path.dirname(alphaDirs[0])}`), listText);
    check('清单说明源码目录不受影响、飞书旧路径会失效',
      dialog.warning.includes('源码目录') && dialog.warning.includes('飞书'), dialog.warning);
    const alphaBefore = {
      project: projectCount(ownerDb, 'alpha'),
      versions: versionCount(ownerDb, 'alpha'),
      drafts: draftCount(ownerDb, 'alpha'),
      files: alphaDirs.map((dir) => fs.existsSync(dir))
    };
    check('打开确认框本身不删数据库', alphaBefore.project === 1 && alphaBefore.versions === 2
      && alphaBefore.drafts === 1, JSON.stringify(alphaBefore));
    check('打开确认框本身不删文件', alphaBefore.files.every(Boolean));
    await capture(panel, path.join(evidence, '01-delete-confirm.png'));
    shots.push('01-delete-confirm.png');

    // 2) 取消：数据库与文件都没变（逐项前后对比）。
    await clickModalButton(panel, '取消');
    const closed = await waitFor(panel, `document.getElementById('modal').hidden`);
    check('取消后确认框关闭', closed);
    await sleep(400);
    check('取消后项目行仍在', projectCount(ownerDb, 'alpha') === alphaBefore.project);
    check('取消后快照版本仍在', versionCount(ownerDb, 'alpha') === alphaBefore.versions);
    check('取消后草稿仍在', draftCount(ownerDb, 'alpha') === alphaBefore.drafts);
    check('取消后导出文件仍在', alphaDirs.every((dir) => fs.existsSync(dir)));

    // 3) 确认：项目、快照、导出目录都没了；另一个项目的数据完好。
    await openDeleteDialog(panel);
    const confirmedClick = await clickModalButton(panel, '确认删除');
    check('确认按钮存在并点下', confirmedClick);
    const alphaGone = await waitFor(panel, `!document.querySelector('#fdTabs .fd-tab[data-project="alpha"]')`);
    check('确认后项目从视图里消失', alphaGone);
    check('确认后项目行删除', projectCount(ownerDb, 'alpha') === 0, String(projectCount(ownerDb, 'alpha')));
    check('确认后快照版本删除', versionCount(ownerDb, 'alpha') === 0, String(versionCount(ownerDb, 'alpha')));
    check('确认后草稿删除', draftCount(ownerDb, 'alpha') === 0, String(draftCount(ownerDb, 'alpha')));
    check('确认后导出目录（含 v1/v2）删除', alphaDirs.every((dir) => !fs.existsSync(dir)));
    check('确认后项目导出父目录删除', !fs.existsSync(path.dirname(alphaDirs[0])));
    check('项目源码目录未被删除（只删导出物）', fs.existsSync(projects.alpha.root));

    // 跨项目隔离：删除前后各查一次 beta。
    check('beta 项目行仍在并指向原目录',
      projectCount(ownerDb, 'beta') === 1 && fs.existsSync(projects.beta.root));
    check('beta 快照与草稿仍在',
      versionCount(ownerDb, 'beta') === 1 && draftCount(ownerDb, 'beta') === 1,
      `${versionCount(ownerDb, 'beta')}/${draftCount(ownerDb, 'beta')}`);
    check('beta 导出文件完好', betaDirs.every((dir) => fs.existsSync(dir))
      && betaDirs.map((dir) => fs.readdirSync(dir).sort().join(',')).join('|') === betaFilesBefore.join('|'));
    check('beta 导出内容未被改动', sha256(path.join(betaDirs[0], 'report.html')) === betaReportHash);
    await sleep(500);
    await capture(panel, path.join(evidence, '02-after-delete.png'));
    shots.push('02-after-delete.png');

    // 4) 文件被占用：库里已删，但界面逐条列出没删掉的路径，不报「已删除」。
    const lockedFile = path.join(gammaDirs[0], 'report.html');
    locked = await lockFile(lockedFile);
    await focusProject(panel, 'gamma');
    await openDeleteDialog(panel);
    check('失败场景确认框同样列出 gamma 的导出目录',
      (await panel.evaluate("document.querySelector('#modalBody').textContent")).includes(gammaDirs[0]));
    await clickModalButton(panel, '确认删除');
    const failureShown = await waitFor(panel, `(() => {
      const modal = document.getElementById('modal');
      return modal && !modal.hidden
        && document.getElementById('modalTitle').textContent.includes('删除未完成');
    })()`);
    check('删不掉时弹出「删除未完成」而不是成功提示', failureShown);
    const failureReport = await panel.evaluate(`(() => ({
      title: document.getElementById('modalTitle').textContent.trim(),
      failed: [...document.querySelectorAll('#modalBody .delete-failed li')].map((node) => node.textContent.trim()),
      body: document.getElementById('modalBody').textContent
    }))()`);
    check('报告里逐条写明没删掉的导出路径',
      failureReport.failed.some((line) => line.includes(gammaDirs[0])), failureReport.failed.join(' | '));
    check('报告里给出删不掉的原因（不假装成功）',
      /EBUSY|busy|占用|EPERM/iu.test(failureReport.body), failureReport.body);
    check('gamma 已从库里删除（先删库、后删文件）', projectCount(ownerDb, 'gamma') === 0);
    check('被占用的导出文件仍在磁盘上', fs.existsSync(lockedFile));
    await capture(panel, path.join(evidence, '03-delete-failed.png'));
    shots.push('03-delete-failed.png');
    await clickModalButton(panel, '知道了');
    check('失败报告可关闭', await waitFor(panel, `document.getElementById('modal').hidden`));

    const errors = consoleErrors(panel);
    check('控制台无报错', errors.length === 0, errors.slice(0, 3).join(' | '));

    if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
    failed = false;
    console.log(`[DELETE] PASS screenshots: ${shots.join(', ')}`);
    console.log(`[DELETE] evidence dir: ${evidence}`);
  } finally {
    if (failed && panel) {
      try { await capture(panel, path.join(evidence, 'failure.png')); } catch { /* best effort */ }
    }
    if (locked) { try { locked.kill(); } catch { /* best effort */ } }
    await sleep(800);
    try { await app.stop(); } catch { /* best effort */ }
    if (failed || failures.length > 0) console.error(`[DELETE] kept state: ${root}`);
    else {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 下偶发占用，留给系统清理 */ }
    }
  }
};

run().catch((error) => {
  console.error(`[DELETE] FAIL: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
