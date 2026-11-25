// 项目切换验收（#73 之后）：项目切换在工作区顶部 #workProjectBar，添加项目在切换行尾。
//
// 原脚本验的是「按来源主机分组的项目查找页」；那个页面与 #projectList / #projectSearch
// 已随 #73 删除，旧断言全部失效。这里按新结构重写，只保留仍然成立的事实：
//   ① 工作区顶部写明项目名，多项目时才出现切换标签；
//   ② 「添加项目」挂在切换行尾（与设置里的入口并存）；
//   ③ 切换标签只改视图项目，不碰交办目标（ADR-0006）；
//   ④ 四个入口的计数跟着视图项目换；
//   ⑤ 全局项目清单仍可用（交办菜单里能选到所有项目）。
// 用 scripts/e2e/lib/cdp.mjs 的共用客户端：临时 userData + 临时库，不碰真实 %APPDATA%。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OwnerStore } from '../../src/owner-store.mjs';
import { PersonalKnowledgeStore } from '../../src/personal-store.mjs';
import { createSyntheticProject } from '../knowledge-loop/fixtures.mjs';
import { capture, consoleErrors, createChecker, sleep, startApp, waitFor } from './lib/cdp.mjs';

const { check, failures } = createChecker('[PROJECTS]');

const run = async () => {
  const base = process.env.TMP_PROJECTS ?? path.join(os.tmpdir());
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'companion-projects-'));
  const userData = path.join(root, 'userdata');
  const ownerDb = path.join(root, 'owner.sqlite');
  const knowledgeDb = path.join(root, 'knowledge.sqlite');
  const evidence = process.env.EVIDENCE_DIR ?? path.join(root, 'evidence');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });

  // 两个项目：alpha 带画像与一条已验证知识，beta 是干净项目（计数应为 0）。
  const owner = new OwnerStore(ownerDb);
  try {
    const alphaSeed = createSyntheticProject({
      store: owner, root: path.join(root, 'alpha'), projectId: 'alpha', name: 'Alpha Repo'
    });
    owner.saveProjectBrief({
      projectId: 'alpha',
      basedOnCommit: alphaSeed.baseSha,
      sourceRunId: 'pb_test',
      payload: {
        oneLiner: '一个用于验收的零依赖 Node 项目',
        whatItIs: 'Alpha Repo 是测试夹具，包含 format 与 retry 两个模块。',
        howToRun: ['npm test'],
        modules: [{ name: 'retry', role: '重试循环', paths: ['src/retry.js'] }],
        conventions: ['写操作先提案'],
        verify: { commands: ['npm test'], criteria: ['退出码为 0'] },
        risks: ['没有 CI'],
        unknowns: [],
        evidence: ['package.json', 'src/retry.js'],
        confidence: '中'
      }
    });
    createSyntheticProject({
      store: owner, root: path.join(root, 'beta'), projectId: 'beta', name: 'Beta Repo'
    });
  } finally { owner.close(); }

  const personal = new PersonalKnowledgeStore(knowledgeDb);
  try {
    personal.create({
      title: 'Retry loop bound',
      content: 'Use i < attempts so the final retry executes.',
      kind: 'claim', layer: 'project', scope: 'project', projectId: 'alpha',
      domains: ['software-engineering'], tags: ['retry', 'off-by-one'],
      evidenceRefs: ['sandbox:run-a'], verificationStatus: 'verified', sourceRef: 'test'
    });
  } finally { personal.close(); }

  fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({
    pet: { x: 240, y: 190 }, projectId: 'alpha', mascotSkin: 'erika',
    gatewayUrl: 'http://127.0.0.1:18789', model: '', includePaths: ['package.json']
  }, null, 2));

  const app = await startApp({ ownerDb, knowledgeDb, userData, showPanel: true });
  const { panel } = app;
  try {
    await waitFor(panel, "document.querySelector('#modeBar button[data-mode=\"focus\"]')");
    await panel.evaluate("document.querySelector('#modeBar button[data-mode=\"focus\"]').click()");
    const ready = await waitFor(panel, `(() => {
      const bar = document.getElementById('workProjectBar');
      return bar && !bar.hidden && document.querySelectorAll('#fdTabs .fd-tab').length >= 2;
    })()`);
    check('工作区顶部出现项目条与切换标签', ready);
    await sleep(800);

    const bar = await panel.evaluate(`(() => {
      const node = document.getElementById('workProjectBar');
      const add = document.getElementById('addProjectTop');
      return {
        name: document.getElementById('workProjectName')?.textContent?.trim() ?? '',
        tabs: [...document.querySelectorAll('#fdTabs .fd-tab')].map((tab) => ({
          project: tab.dataset.project,
          text: tab.textContent.trim(),
          on: tab.classList.contains('on'),
          selected: tab.getAttribute('aria-selected')
        })),
        addInBar: Boolean(add && node?.contains(add)),
        addVisible: add ? add.getBoundingClientRect().height > 0 : false,
        addLabel: add?.textContent?.trim() ?? '',
        legacyList: Boolean(document.getElementById('projectList') || document.getElementById('projectSearch')),
        entries: [...document.querySelectorAll('#workEntries .work-entry')].map((entry) => ({
          key: entry.dataset.entry,
          count: entry.querySelector('.work-entry-count')?.textContent ?? '',
          note: entry.querySelector('.work-entry-note')?.textContent ?? ''
        })),
        entriesVisible: !document.getElementById('workEntries').hidden
      };
    })()`);
    const initialId = bar.tabs.find((tab) => tab.on)?.project ?? '';
    const expected = await panel.evaluate(`(async () => {
      const snapshot = await window.companion.snapshot({ projectId: '${initialId}' });
      const knowledge = snapshot.knowledge?.counts ?? {};
      return {
        id: snapshot.config?.projectId ?? '',
        name: (snapshot.projects ?? []).find((item) => item.id === snapshot.config?.projectId)?.name ?? '',
        knowledge: knowledge.knowledge ?? 0
      };
    })()`);
    check('工作区顶部写着当前项目', bar.name === expected.name, `${bar.name} vs ${expected.name}`);
    check('两个项目都出现在切换标签里',
      bar.tabs.length === 2 && bar.tabs.some((tab) => tab.project === 'alpha')
      && bar.tabs.some((tab) => tab.project === 'beta'), bar.tabs.map((tab) => tab.text).join(' / '));
    check('当前项目在标签里高亮',
      bar.tabs.find((tab) => tab.on)?.selected === 'true',
      bar.tabs.find((tab) => tab.on)?.project ?? 'none');
    check('「添加项目」挂在切换行尾',
      bar.addInBar && bar.addVisible && bar.addLabel === '添加项目', bar.addLabel);
    check('旧的搜索 + 项目列表已删除', bar.legacyList === false);
    check('四个入口按 知识 / 测试 / 补丁 / 运行 排列且可见',
      bar.entriesVisible
      && JSON.stringify(bar.entries.map((entry) => entry.key))
        === JSON.stringify(['knowledge', 'tests', 'patches', 'runs']),
      bar.entries.map((entry) => entry.key).join(','));
    check('知识入口计数与快照一致',
      Number(bar.entries.find((entry) => entry.key === 'knowledge')?.count) === expected.knowledge,
      `${bar.entries.find((entry) => entry.key === 'knowledge')?.count} vs ${expected.knowledge}`);
    await panel.evaluate("document.getElementById('toast').hidden = true");
    await capture(panel, path.join(evidence, 'panel-work-project-bar.png'));

    // 交办目标不受视图项目影响：切标签只换视图，底部仍写「未选项目」。
    const handoffBefore = await panel.evaluate(
      "document.getElementById('handoffTargetName')?.textContent?.trim() ?? ''");
    const otherId = initialId === 'alpha' ? 'beta' : 'alpha';
    const otherName = await panel.evaluate(`(async () => {
      const snapshot = await window.companion.snapshot({ projectId: '${otherId}' });
      return (snapshot.projects ?? []).find((item) => item.id === '${otherId}')?.name ?? '';
    })()`);
    await panel.evaluate(`document.querySelector('#fdTabs .fd-tab[data-project="${otherId}"]').click()`);
    const switchedName = await waitFor(panel,
      `document.getElementById('workProjectName')?.textContent?.trim() === '${otherName}'`);
    await sleep(900);
    const switched = await panel.evaluate(`(() => ({
      name: document.getElementById('workProjectName')?.textContent?.trim() ?? '',
      selected: document.querySelector('#fdTabs .fd-tab.on')?.dataset.project ?? '',
      handoff: document.getElementById('handoffTargetName')?.textContent?.trim() ?? '',
      knowledge: document.querySelector('#workEntries .work-entry[data-entry="knowledge"] .work-entry-count')?.textContent ?? ''
    }))()`);
    check('点切换标签后工作区换成另一个项目',
      Boolean(switchedName) && switched.name === otherName && switched.selected === otherId,
      JSON.stringify(switched));
    check('切视图不改交办目标', switched.handoff === handoffBefore, `${switched.handoff} vs ${handoffBefore}`);
    check('切项目后知识计数换成另一个项目的数字',
      Number(switched.knowledge) === (otherId === 'alpha' ? 1 : 0), switched.knowledge);
    await capture(panel, path.join(evidence, 'panel-work-switched.png'));

    // 全局项目清单仍在：交办菜单里两个项目都能选到。
    await panel.evaluate("document.getElementById('handoffTarget').click()");
    const menuOpen = await waitFor(panel,
      "document.querySelectorAll('#handoffTargetMenu .composer-project-option').length >= 2");
    const options = await panel.evaluate(
      `[...document.querySelectorAll('#handoffTargetMenu .composer-project-option')].map((o) => o.dataset.project)`);
    check('交办菜单仍能列出全部项目',
      menuOpen && options.includes('alpha') && options.includes('beta'), options.join(','));
    await panel.evaluate("document.getElementById('handoffTarget').click()");

    // 设置里仍有添加项目入口（与切换行尾并存）。
    const settingsAdd = await panel.evaluate(
      "Boolean(document.querySelector('#settings #addProject'))");
    check('设置面板保留添加项目入口', settingsAdd === true);

    const errors = consoleErrors(panel);
    check('控制台无错误', errors.length === 0, errors.join(' | ').slice(0, 300));
    if (failures.length) throw new Error(`${failures.length} assertion(s) failed`);
    console.log('[PROJECTS] PASS');
  } finally {
    await app.stop();
    if (!failures.length) {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } else {
      console.error(`[PROJECTS] kept state: ${root}`);
    }
  }
};

run().catch((error) => {
  console.error(`[PROJECTS] FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
