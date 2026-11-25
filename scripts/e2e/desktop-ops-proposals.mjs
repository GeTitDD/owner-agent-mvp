// #71 验收：专注页操作区里的「待提炼」提议。
//
// 断言四件事：① 达到阈值的项目出现在操作区并带条数；② 不足阈值的不出现；
// ③ 点「去提炼」到达知识页且定位到该项目；④ 提议与跳转前后库里行数不变。
// 全程用临时 userData + 临时 owner / 知识库，不碰真实 %APPDATA%。
// 截图与探针写到 SHOTS_DIR（缺省为仓库外的 focus-notes/shots-71）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OwnerStore } from '../../src/owner-store.mjs';
import { PersonalKnowledgeStore } from '../../src/personal-store.mjs';
import {
  capture, consoleErrors, createChecker, sleep, startApp, waitFor
} from './lib/cdp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const shotsDir = process.env.SHOTS_DIR
  ?? path.join(repoRoot, '..', 'focus-notes', 'shots-71');
const { check, failures } = createChecker('[OPS-#71]');

/** 逐表行数：提议只读，前后必须一致。 */
const tableCounts = (file) => {
  const db = new DatabaseSync(file);
  try {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map((row) => row.name);
    return Object.fromEntries(names.map((name) => [
      name, db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n
    ]));
  } finally {
    db.close();
  }
};

const snapshotCounts = (ownerDb, knowledgeDb) => ({
  owner: tableCounts(ownerDb),
  knowledge: tableCounts(knowledgeDb)
});

/** 造一个只有「已终态 job」的项目：每个 job 投影成一条执行记录。 */
const seedProject = (owner, { projectId, name, root, jobs }) => {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  // 给最小可扫描的形状：依赖图没有 nodes 时面板会弹一条与本次验收无关的失败提示。
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: projectId, version: '1.0.0' }, null, 2));
  fs.writeFileSync(path.join(root, 'src', 'index.js'), "import { util } from './util.js';\nexport const main = () => util();\n");
  fs.writeFileSync(path.join(root, 'src', 'util.js'), 'export const util = () => 1;\n');
  owner.registerProject({ id: projectId, name, root });
  // 预置依赖图：否则面板会在启动时自动生成一次并写库，干扰「行数不变」的证据。
  owner.saveProjectDiagram({
    projectId,
    kind: 'dependency',
    title: `${name} 依赖图`,
    summary: '验收夹具的依赖图，不重新生成。',
    mermaid: 'flowchart TD\n  a["src/index.js"] --> b["src/util.js"]',
    source: 'fixture'
  });
  const at = new Date().toISOString();
  for (let i = 1; i <= jobs; i += 1) {
    const job = owner.createJob({
      projectId,
      jobType: 'noop',
      title: `${name} 第 ${i} 次冒烟`,
      idempotencyKey: `seed-${projectId}-${i}`
    });
    // 夹具直接落终态：执行记录只投影已终态的 job，不需要跑真实 worker。
    owner.db.prepare("UPDATE owner_jobs SET status='succeeded', finished_at=?, updated_at=? WHERE id=?")
      .run(at, at, job.id);
  }
};

const shot = async (panel, file) => capture(panel, path.join(shotsDir, file));

const makeRoot = (label) => {
  const base = process.env.TMP_71 ?? path.join(os.tmpdir());
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, `ops-proposals-${label}-`));
  const userData = path.join(root, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  return {
    root,
    userData,
    ownerDb: path.join(root, 'owner.sqlite'),
    knowledgeDb: path.join(root, 'knowledge.sqlite')
  };
};

/** Windows 上 Electron 刚退出时 userData 里还有句柄：删不掉就留着，别把验收判失败。 */
const safeRemove = (target) => {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    return true;
  } catch {
    console.warn(`[OPS-#71] kept state: ${target}`);
    return false;
  }
};

const writeCompanionConfig = (userData, projectId) => {
  fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({
    projectId,
    gatewayUrl: 'http://127.0.0.1:18789',
    model: '',
    includePaths: ['package.json'],
    mascotSkin: 'erika'
  }, null, 2));
};

const scenarioWithProposals = async (probe) => {
  const { root, userData, ownerDb, knowledgeDb } = makeRoot('yes');
  const owner = new OwnerStore(ownerDb);
  try {
    seedProject(owner, {
      projectId: 'alpha', name: 'Alpha Repo', root: path.join(root, 'alpha'), jobs: 4
    });
    // beta 只有 1 条：不足阈值，操作区里不该出现。
    seedProject(owner, {
      projectId: 'beta', name: 'Beta Repo', root: path.join(root, 'beta'), jobs: 1
    });
  } finally {
    owner.close();
  }
  const personal = new PersonalKnowledgeStore(knowledgeDb);
  personal.close();
  writeCompanionConfig(userData, 'alpha');

  const before = snapshotCounts(ownerDb, knowledgeDb);
  const app = await startApp({ ownerDb, knowledgeDb, userData, showPanel: true });
  const { panel } = app;
  try {
    await waitFor(panel, "document.querySelector('#modeBar button[data-mode=\"focus\"]')");
    await waitFor(panel, 'window.OwnerFocusOps');
    await panel.evaluate("document.querySelector('#modeBar button[data-mode=\"focus\"]').click()");
    const appeared = await waitFor(panel,
      "document.querySelector('#proposeSection') && !document.querySelector('#proposeSection').hidden");
    check('操作区出现待提炼块', appeared);
    // 快照到达后项目名才会替换掉原始 id：等文案稳定再截图与断言。
    await waitFor(panel,
      "(document.querySelector('#proposeList .proposal-title')?.textContent ?? '').includes('Alpha Repo')");
    await sleep(300);
    const dom = await panel.evaluate(`(() => ({
      visible: !document.getElementById('proposeSection').hidden,
      title: document.getElementById('opsProposeTitle').textContent,
      badge: document.getElementById('proposeBadge').textContent,
      rows: [...document.querySelectorAll('#proposeList .proposal-card')].map((row) => ({
        text: row.querySelector('.proposal-title')?.textContent ?? '',
        project: row.querySelector('.proposal-go')?.dataset.project ?? '',
        action: row.querySelector('.proposal-go')?.textContent ?? ''
      })),
      opsEmptyHidden: document.getElementById('opsEmpty').hidden
    }))()`);
    probe.withProposals = dom;
    probe.projects = await panel.evaluate(`(async () => {
      const snapshot = await window.companion.snapshot({});
      return {
        fromSnapshot: (snapshot.projects ?? []).map((project) => ({ id: project.id, name: project.name })),
        fromSwitcher: [...document.querySelectorAll('#fdTabs .fd-tab')]
          .map((tab) => ({ id: tab.dataset.project, name: tab.textContent }))
      };
    })()`);
    check('提议带项目与条数', dom.rows.length === 1
      && dom.rows[0].project === 'alpha'
      && /Alpha Repo/u.test(dom.rows[0].text)
      && /已积 4 条未提炼/u.test(dom.rows[0].text), JSON.stringify(dom.rows));
    check('不足阈值的项目不出现', !dom.rows.some((row) => row.project === 'beta'));
    check('有提议时操作区不是空态', dom.opsEmptyHidden === true);
    check('每条提议只有「去提炼」一个动作', dom.rows.every((row) => row.action === '去提炼'));
    await sleep(3000);
    probe.withProposalsLate = await panel.evaluate(
      "document.querySelector('#proposeList .proposal-title')?.textContent ?? ''");
    await shot(panel, 'focus-ops-proposals.png');

    await panel.evaluate("document.querySelector('#proposeList .proposal-go').click()");
    const landed = await waitFor(panel, "!document.getElementById('modeB').hidden");
    check('点「去提炼」切到知识页', landed);
    const jump = await waitFor(panel, `(() => {
      const on = document.querySelector('#kbFilters .kb-chip.on');
      const groups = document.getElementById('kbGroups')?.innerText ?? '';
      return Boolean(on) && on.textContent.includes('Alpha Repo') && groups.includes('这个项目还没有知识条目');
    })()`);
    const knowledge = await panel.evaluate(`(() => ({
      modeB: !document.getElementById('modeB').hidden,
      modeA: !document.getElementById('modeA').hidden,
      activeChip: document.querySelector('#kbFilters .kb-chip.on')?.textContent ?? '',
      groups: (document.getElementById('kbGroups')?.innerText ?? '').slice(0, 200)
    }))()`);
    probe.jump = knowledge;
    check('知识页定位到该项目（筛选与空态都指向项目）', jump, JSON.stringify(knowledge));
    check('跳转后专注页已隐藏', knowledge.modeA === false && knowledge.modeB === true);
    await shot(panel, 'knowledge-located-alpha.png');

    const errors = consoleErrors(panel);
    probe.consoleErrors = errors;
    check('控制台无错误', errors.length === 0, errors.join(' | ').slice(0, 300));
  } finally {
    await app.stop();
  }
  await sleep(500);
  const after = snapshotCounts(ownerDb, knowledgeDb);
  probe.counts = { before, after };
  // 应用启动会补建自己的表（例如对话会话表）：新增的空表不算写数据，
  // 只要求既有表的行数完全一致、新增表都是 0 行。
  const compareCounts = (beforeCounts, afterCounts) => {
    const added = Object.keys(afterCounts).filter((name) => !(name in beforeCounts));
    const changed = Object.keys(beforeCounts)
      .filter((name) => beforeCounts[name] !== afterCounts[name]);
    const addedNonEmpty = added.filter((name) => afterCounts[name] !== 0);
    return { same: changed.length === 0 && addedNonEmpty.length === 0, changed, added };
  };
  const ownerDiff = compareCounts(before.owner, after.owner);
  const knowledgeDiff = compareCounts(before.knowledge, after.knowledge);
  probe.countDiff = { owner: ownerDiff, knowledge: knowledgeDiff };
  check('提议与跳转前后 owner 库行数不变', ownerDiff.same, JSON.stringify(ownerDiff));
  check('提议与跳转前后知识库行数不变', knowledgeDiff.same, JSON.stringify(knowledgeDiff));
  safeRemove(root);
};

const scenarioWithoutProposals = async (probe) => {
  const { root, userData, ownerDb, knowledgeDb } = makeRoot('no');
  const owner = new OwnerStore(ownerDb);
  try {
    // 只有 2 条：低于阈值，整块不该出现。
    seedProject(owner, {
      projectId: 'solo', name: 'Solo Repo', root: path.join(root, 'solo'), jobs: 2
    });
  } finally {
    owner.close();
  }
  const personal = new PersonalKnowledgeStore(knowledgeDb);
  personal.close();
  writeCompanionConfig(userData, 'solo');

  const app = await startApp({ ownerDb, knowledgeDb, userData });
  const { panel } = app;
  try {
    await waitFor(panel, "document.querySelector('#modeBar button[data-mode=\"focus\"]')");
    await waitFor(panel, 'window.OwnerFocusOps');
    await panel.evaluate("document.querySelector('#modeBar button[data-mode=\"focus\"]').click()");
    await waitFor(panel, "!document.getElementById('modeA').hidden");
    // 等快照到齐（项目切换标签出现）再看提议：否则截图会停在还没取到数的空壳上。
    await waitFor(panel, "document.querySelector('#fdTabs .fd-tab')");
    // 等提议取数跑完一轮（TTL 之内不会重复读）。
    await sleep(2000);
    const dom = await panel.evaluate(`(() => ({
      sectionHidden: document.getElementById('proposeSection').hidden,
      rows: document.querySelectorAll('#proposeList .proposal-card').length,
      opsEmpty: !document.getElementById('opsEmpty').hidden,
      opsEmptyText: document.getElementById('opsEmpty').textContent,
      opsBodyHidden: document.getElementById('opsBody').hidden
    }))()`);
    probe.withoutProposals = dom;
    check('无提议时整段消失', dom.sectionHidden === true && dom.rows === 0, JSON.stringify(dom));
    check('三类全空时操作区压成一行',
      dom.opsEmpty === true && dom.opsBodyHidden === true, dom.opsEmptyText);
    await shot(panel, 'focus-ops-no-proposals.png');
    const errors = consoleErrors(panel);
    check('无提议场景控制台无错误', errors.length === 0, errors.join(' | ').slice(0, 300));
  } finally {
    await app.stop();
  }
  safeRemove(root);
};

const run = async () => {
  fs.mkdirSync(shotsDir, { recursive: true });
  const probe = { shotsDir };
  await scenarioWithProposals(probe);
  await scenarioWithoutProposals(probe);
  fs.writeFileSync(path.join(shotsDir, 'ops-proposals-probe.json'), JSON.stringify(probe, null, 2));
  if (failures.length) throw new Error(`${failures.length} assertion(s) failed`);
  console.log('[OPS-#71] PASS');
};

run().catch((error) => {
  console.error(`[OPS-#71] FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
