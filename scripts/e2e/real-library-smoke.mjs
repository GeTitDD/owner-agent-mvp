// 真实库冒烟：把真实 %APPDATA% 的 owner.sqlite 与知识库**复制**到临时目录，只读地跑一次项目库，
// 生成一份草稿并截图。不碰真实库、不发布（发布会给飞书发卡片）。
//
// 用法：node scripts/e2e/real-library-smoke.mjs
// 输出：EVIDENCE_DIR（默认 .tmp 下）里的截图与一份 probe JSON。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capture, consoleErrors, createChecker, sleep, startApp, waitFor } from './lib/cdp.mjs';

const { check, failures } = createChecker('[REAL]');

const REAL_APPDATA = path.join(process.env.APPDATA ?? '', 'owner-agent-mvp');
const REAL_KNOWLEDGE = path.join(process.env.USERPROFILE ?? '', '.domain-context', 'index.sqlite');

const copySqlite = (from, to) => {
  // WAL 模式下必须连 -wal/-shm 一起复制，否则复制出来的库可能缺最近提交。
  for (const suffix of ['', '-wal', '-shm']) {
    const src = from + suffix;
    if (fs.existsSync(src)) fs.copyFileSync(src, to + suffix);
  }
};

const libraryState = (panel) => panel.evaluate(`(() => {
  const section = document.getElementById('librarySection');
  const blockOf = (block) => ({
    label: block.querySelector('.library-block-name')?.textContent?.trim() ?? '',
    count: block.querySelector('.library-block-count')?.textContent?.trim() ?? '',
    empty: block.querySelector('.library-block-empty')?.textContent?.trim() ?? '',
    items: [...block.querySelectorAll('.library-item-title')].map((node) => node.textContent.trim())
  });
  return {
    hidden: Boolean(section?.hidden),
    badge: document.getElementById('libraryBadge')?.textContent?.trim() ?? '',
    blocks: [...document.querySelectorAll('#librarySections .library-block')].map(blockOf),
    emptyShown: document.getElementById('libraryEmpty') ? !document.getElementById('libraryEmpty').hidden : false,
    emptyText: document.getElementById('libraryEmpty')?.textContent?.trim() ?? '',
    assets: document.getElementById('libraryAssets')?.textContent?.trim() ?? '',
    status: document.getElementById('libraryStatus')?.textContent?.trim() ?? '',
    publishLabel: document.getElementById('libraryPublish')?.textContent?.trim() ?? '',
    versions: [...document.querySelectorAll('#libraryVersions .library-version')].map((n) => n.textContent.trim())
  };
})()`);

const shot = async (panel, file, target) => {
  await panel.evaluate(`(() => {
    const el = document.getElementById('${target}');
    const container = document.querySelector('.a-wrap');
    if (el && container) container.scrollTop += el.getBoundingClientRect().top - container.getBoundingClientRect().top - 58;
    const toast = document.getElementById('toast'); if (toast) toast.hidden = true;
  })()`);
  await sleep(350);
  await capture(panel, file);
};

const run = async () => {
  if (!fs.existsSync(path.join(REAL_APPDATA, 'owner.sqlite'))) throw new Error('找不到真实 owner.sqlite');

  const base = process.env.TMP_REAL ?? path.join('D:', 'nautilus_trader', '.tmp', 'opencode');
  const root = fs.mkdtempSync(path.join(base, 'real-run-'));
  const userData = path.join(root, 'userdata');
  const ownerDb = path.join(root, 'owner.sqlite');
  const knowledgeDb = path.join(root, 'knowledge.sqlite');
  const evidence = process.env.EVIDENCE_DIR ?? path.join(root, 'evidence');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });

  copySqlite(path.join(REAL_APPDATA, 'owner.sqlite'), ownerDb);
  if (fs.existsSync(REAL_KNOWLEDGE)) copySqlite(REAL_KNOWLEDGE, knowledgeDb);
  else fs.writeFileSync(knowledgeDb, '');

  // companion.json 照抄，但去掉飞书 webhook：这次绝不发卡片，配置也不该有能力发。
  const companionPath = path.join(REAL_APPDATA, 'companion.json');
  const companion = fs.existsSync(companionPath)
    ? JSON.parse(fs.readFileSync(companionPath, 'utf8'))
    : {};
  delete companion.observerFeishuWebhook;
  delete companion.feishuWebhook;
  if (companion.observer) delete companion.observer.feishuWebhook;
  fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify(companion, null, 2));

  let app = await startApp({ ownerDb, knowledgeDb, userData, showPanel: true });
  const panel = app.panel;
  const probe = { root, projects: [], consoleErrors: [] };
  try {
    await waitFor(panel, "document.querySelector('#modeBar button[data-mode=\"focus\"]')");
    await panel.evaluate("document.querySelector('#modeBar button[data-mode=\"focus\"]').click()");
    // 视图是主进程推过来的：等它真的有项目名，再读标签，别按固定 sleep 猜。
    const loaded = await waitFor(panel, "(() => { const n = document.getElementById('workProjectName'); return n && n.textContent.trim().length > 0; })()", 20000);
    if (!loaded) {
      const diag = await panel.evaluate(`(async () => ({
        modeAVisible: !document.getElementById('modeA')?.hidden,
        workProjectName: document.getElementById('workProjectName')?.textContent?.trim() ?? '',
        tabsHtml: document.getElementById('fdTabs')?.innerHTML?.slice(0, 200) ?? '',
        snapshot: await window.companion.snapshot().catch((e) => ({ error: String(e) }))
      }))()`);
      console.error('[REAL] 视图没加载出来: ' + JSON.stringify(diag, null, 2).slice(0, 1200));
      console.error('[REAL] 应用日志:\n' + (app.log ?? []).join('').slice(-2000));
      throw new Error('view did not load');
    }

    let projectIds = await panel.evaluate(
      "[...document.querySelectorAll('#fdTabs .fd-tab')].map((tab) => ({ id: tab.dataset.project, name: tab.textContent.trim() }))"
    );
    // 只有一个项目时面板不生成切换标签（没有第二个可切），这时直接问当前视图项目是谁。
    if (projectIds.length === 0) {
      const current = await panel.evaluate(
        "(async () => { const snap = await window.companion.snapshot(); return { id: snap?.config?.projectId ?? '', name: document.getElementById('workProjectName')?.textContent?.trim() ?? '' }; })()"
      );
      if (current.id) projectIds = [current];
    }
    probe.projectsInPanel = projectIds;
    console.log(`[REAL] 面板里的项目: ${JSON.stringify(projectIds)}`);

    for (const project of projectIds) {
      await panel.evaluate(`document.querySelector('#fdTabs .fd-tab[data-project="${project.id}"]').click()`);
      // 切项目后的刷新是异步的：等**这个项目自己的**画像/图谱落到 DOM 上，再断言与截图。
      // 只等「库段可见」不够——上一个项目的库段本来就可见，会把旧数据当成新的读。
      const expected = await panel.evaluate(`(async () => {
        const snap = await window.companion.snapshot({ projectId: '${project.id}' });
        const assets = snap?.library?.assets ?? {};
        const diagrams = assets.diagrams ?? [];
        return {
          diagramsText: '图谱：' + diagrams.filter((d) => d.available).length + '/' + (diagrams.length || 0) + ' 类',
          profileMissing: !(assets.profile?.available),
          projectId: snap?.config?.projectId ?? ''
        };
      })()`);
      const ready = await waitFor(panel, `(() => {
        const section = document.getElementById('librarySection');
        if (!section || section.hidden) return false;
        const text = document.getElementById('libraryAssets')?.textContent ?? '';
        if (!text.includes(${JSON.stringify(expected.diagramsText)})) return false;
        return ${expected.profileMissing} ? text.includes('画像：还没有生成') : !text.includes('画像：还没有生成');
      })()`, 20000);
      check(`${project.name}: 库段渲染的是它自己的画像与图谱`, ready, expected.diagramsText);
      console.log(`[REAL] ${project.name}: 期望 ${expected.diagramsText}，实际 ${String((await panel.evaluate("document.getElementById('libraryAssets')?.textContent ?? ''")).slice(0, 40))}`);

      const before = await libraryState(panel);
      check(`${project.name}: 两节都在`, before.blocks.map((b) => b.label).join('/') === '已验证/观察中',
        before.blocks.map((b) => `${b.label}${b.count}`).join(' '));
      check(`${project.name}: 合计等于徽章`, Number(before.badge.replace(/\D/gu, '')) ===
        before.blocks.reduce((sum, b) => sum + Number(b.count.replace(/\D/gu, '')), 0), `badge=${before.badge}`);
      check(`${project.name}: 画像与图谱有摘要`, /画像：/u.test(before.assets) && /图谱：/u.test(before.assets), before.assets);

      await shot(panel, path.join(evidence, `real-library-${project.id}.png`), 'librarySection');

      await panel.evaluate("document.getElementById('libraryDraft').click()");
      const draft = await waitFor(panel,
        "(!document.getElementById('libraryPublish')?.disabled) && /草稿：/u.test(document.getElementById('libraryStatus')?.textContent ?? '')",
        20000);
      check(`${project.name}: 生成草稿成功`, draft);

      const after = await libraryState(panel);
      check(`${project.name}: 草稿写明两节计数且无版本号`, /已验证 \d+ 条 · 观察中 \d+ 条/u.test(after.status) && /没有版本号/u.test(after.status), after.status);
      check(`${project.name}: 生成草稿不产生版本`, after.versions.length === 0, after.versions.join(','));
      await shot(panel, path.join(evidence, `real-draft-${project.id}.png`), 'libraryStatus');

      probe.projects.push({ id: project.id, name: project.name, before, after });
    }

    const errors = consoleErrors(panel);
    probe.consoleErrors = errors;
    check('控制台无报错', errors.length === 0, errors.slice(0, 3).join(' | '));

    fs.writeFileSync(path.join(evidence, 'real-library-probe.json'), JSON.stringify(probe, null, 2));
    console.log(`[REAL] 证据目录: ${evidence}`);
    if (failures.length > 0) throw new Error(`${failures.length} 条断言失败`);
    console.log('[REAL] PASS');
  } finally {
    try { await capture(panel, path.join(evidence, 'real-failure.png')); } catch { /* 尽力而为 */ }
    try { await app.stop(); } catch { /* 尽力而为 */ }
  }
};

run().catch((error) => {
  console.error(`[REAL] FAIL: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
