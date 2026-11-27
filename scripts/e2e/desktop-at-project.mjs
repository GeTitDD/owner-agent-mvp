// #124 验收：`@@` →「关联项目」的项目 → 资料层级、互斥、胶囊与发送时的 prompt 段。
//
// 命中真实路径：离屏 Electron + CDP，加载卡片壳 shell.html，临时 userData + 临时库。
// 覆盖：项目列表不含当前项目；点项目就地展开四类资料与计数；「让 Agent 自己找」与
//       指定资料互斥（置灰可见）；一项都没选点「关联」有明确提示；胶囊可逐个移除；
//       发送后 prompt 里有「## 关联项目」两段（项目名 + 来源 · 路径 + 关联资料）。
// 截图：展开态与互斥、胶囊、生成的 prompt 段。
import fs from 'node:fs';
import path from 'node:path';
import { OwnerStore } from '../../src/owner-store.mjs';
import { PersonalKnowledgeStore } from '../../src/personal-store.mjs';
import {
  capture, consoleErrors, createChecker, startApp, sleep, waitFor
} from './lib/cdp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const shotsDir = process.env.SHOTS_DIR
  ?? path.resolve(repoRoot, '..', '..', 'mm-notes', 'shots-124');
const tempBase = process.env.TMP_124 ?? path.resolve(shotsDir, '..', 'tmp-124');
const { check, failures } = createChecker('[AT-PROJECT-#124]');

const typeInput = (panel, text) => panel.evaluate(`(() => {
  const input = document.getElementById('input');
  input.focus();
  input.value = ${JSON.stringify(text)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input.value;
})()`);

const pressEnter = (panel) => panel.evaluate(`(() => {
  const input = document.getElementById('input');
  input.focus();
  const event = new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', bubbles: true, cancelable: true
  });
  input.dispatchEvent(event);
  return event.defaultPrevented;
})()`);

const click = (panel, selector) => panel.evaluate(`(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) return false;
  node.click();
  return true;
})()`);

const createSession = async (panel) => {
  await click(panel, '#sessionToggle');
  await waitFor(panel, "document.getElementById('sessionPopover').hidden === false", 5000);
  await click(panel, '#sessionNew');
  return waitFor(panel, "document.getElementById('input').disabled === false", 8000);
};

const openProjectMethod = async (panel) => {
  await typeInput(panel, '@@');
  await waitFor(panel, "document.getElementById('atPanel').hidden === false", 5000);
  await click(panel, '.at-method[data-at-method="project"]');
  return waitFor(panel, "document.querySelector('.at-project-row')", 5000);
};

const expandProject = async (panel, projectId) => {
  await click(panel, `.at-project-row[data-project="${projectId}"] .at-project-head`);
  return waitFor(panel,
    `document.querySelector('.at-project-row[data-project="${projectId}"] [data-project-material]')`, 10000);
};

const readCard = (panel) => panel.evaluate(`(() => {
  const panelNode = document.getElementById('atPanel');
  const errorNode = document.querySelector('.at-project-error');
  return {
    panelHidden: panelNode.hidden,
    title: document.getElementById('atTitle').textContent.trim(),
    readonly: document.querySelector('.at-project-readonly')?.textContent.trim() ?? '',
    count: document.querySelector('.at-project-count')?.textContent.trim() ?? '',
    error: errorNode && errorNode.hidden === false ? errorNode.textContent.trim() : '',
    rows: [...document.querySelectorAll('.at-project-row')].map((row) => {
      const auto = row.querySelector('[data-project-auto]');
      return {
        id: row.dataset.project,
        name: row.querySelector('.at-project-name')?.textContent.trim() ?? '',
        meta: row.querySelector('.at-project-meta')?.textContent.trim() ?? '',
        expanded: row.querySelector('.at-project-head')?.getAttribute('aria-expanded') === 'true',
        materials: [...row.querySelectorAll('[data-project-material]')].map((input) => ({
          key: input.dataset.projectMaterial,
          count: input.closest('label')?.querySelector('.at-material-count')?.textContent.trim() ?? '',
          checked: input.checked,
          disabled: input.disabled
        })),
        auto: auto ? { checked: auto.checked, disabled: auto.disabled } : null
      };
    }),
    capsules: [...document.querySelectorAll('#projectLinkList .link-capsule')].map((node) => ({
      id: node.dataset.project,
      text: node.querySelector('.link-capsule-text')?.textContent.trim() ?? ''
    })),
    capsulesHidden: document.getElementById('projectLinks').hidden,
    hint: document.getElementById('projectLinksHint')?.textContent.trim() ?? '',
    inputFocused: document.activeElement === document.getElementById('input')
  };
})()`);

const materialOf = (row, key) => row?.materials.find((material) => material.key === key) ?? null;

// Markdown 标记会被渲染成标题与列表；发给模型的原文必须从真实会话读取，不能拿 textContent 冒充。
const readFirstUserText = (panel) => panel.evaluate(`(async () => {
  const id = document.querySelector('#sessionList .session-row[data-current="true"]')?.dataset.id;
  const detail = await window.companion.cardSessions.get({ id });
  return detail?.messages?.find(message => message.role === 'user')?.text ?? '';
})()`);

const seedData = ({ root, ownerDb, knowledgeDb }) => {
  const alphaRoot = path.join(root, 'alpha');
  const betaRoot = path.join(root, 'beta');
  for (const dir of [alphaRoot, betaRoot]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: path.basename(dir), private: true, type: 'module', scripts: { test: 'node --test' }
    }, null, 2), 'utf8');
  }
  const owner = new OwnerStore(ownerDb);
  try {
    owner.registerProject({
      id: 'alpha', name: 'Alpha Repo', root: alphaRoot,
      primaryDomain: 'alpha-domain', domains: ['alpha-domain']
    });
    owner.registerProject({
      id: 'beta', name: 'Beta Repo', root: betaRoot,
      primaryDomain: 'beta-domain', domains: ['beta-domain']
    });
    owner.saveProjectBrief({
      projectId: 'alpha',
      payload: { oneLiner: 'Alpha 一句话', whatItIs: 'Alpha 是这次关联要读的第一个项目。' }
    });
    owner.saveProjectBrief({
      projectId: 'beta',
      payload: { oneLiner: 'Beta 一句话', whatItIs: 'Beta 是这次关联要读的第二个项目。' }
    });
    owner.saveProjectDiagram({
      projectId: 'alpha', kind: 'dependency', title: 'Alpha 依赖图',
      summary: 'Alpha 的模块依赖。', data: { nodes: [{ id: 'a', label: 'Alpha' }], edges: [] }
    });
    owner.saveProjectDiagram({
      projectId: 'beta', kind: 'control', title: 'Beta 控制流图',
      summary: 'Beta 的控制流。', data: { nodes: [{ id: 'b', label: 'Beta' }], edges: [] }
    });
  } finally {
    owner.close();
  }
  const personal = new PersonalKnowledgeStore(knowledgeDb);
  try {
    // Alpha：一条经验 + 一条生效中的决策；Beta 故意不给这两类，用来验「暂无」置灰。
    personal.recordLesson({
      projectId: 'alpha',
      sourceRecordId: 'lesson-alpha-124',
      phenomenon: 'Alpha 换方案时丢了回归测试',
      mechanism: '先改实现再补测试',
      countermeasure: '先补一条回归测试再换方案',
      scope: { layer: 'project', projectId: 'alpha', domainIds: ['alpha-domain'] },
      verificationStatus: 'inferred'
    }, { evidence: [{ ref: 'lesson-alpha-124', recordId: 'lesson-alpha-124', kind: 'record' }] });
    personal.create({
      title: 'Alpha 先补测试再换方案',
      content: '换方案前先补一条回归测试，避免丢掉已有的边界用例。',
      kind: 'decision', layer: 'project', scope: 'project', projectId: 'alpha',
      domains: ['alpha-domain'], tags: ['decision'],
      decision: {
        reason: '避免换方案时丢掉已有的边界用例',
        source: { kind: 'session', projectName: 'Alpha Repo' },
        decidedAt: '2026-11-25T00:00:00.000Z'
      },
      evidenceRefs: ['session:alpha-124'],
      verificationStatus: 'verified'
    });
  } finally {
    personal.close();
  }
};

const run = async () => {
  fs.mkdirSync(tempBase, { recursive: true });
  fs.mkdirSync(shotsDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'at-project-124-'));
  const userData = path.join(root, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({
    projectId: '', gatewayUrl: 'http://127.0.0.1:1', model: '', includePaths: ['package.json']
  }, null, 2));
  const ownerDb = path.join(root, 'owner.sqlite');
  const knowledgeDb = path.join(root, 'knowledge.sqlite');
  seedData({ root, ownerDb, knowledgeDb });

  const app = await startApp({
    userData, ownerDb, knowledgeDb,
    showPanel: true,
    page: 'shell.html'
  });
  const { panel } = app;
  try {
    check('card shell loads', await waitFor(panel, "document.querySelector('#shellHeader')", 30000));
    check('a session exists before typing @@', await createSession(panel));

    // ① 进方法：项目列表不含当前项目（这里是全局，所以两个都在）。
    check('entering the project method mounts the project list', await openProjectMethod(panel));
    let card = await readCard(panel);
    check('the card is the project method', card.panelHidden === false && card.title === '关联项目',
      card.title);
    check('the project list is the registered projects (current excluded)',
      card.rows.map((row) => row.id).sort().join(',') === 'alpha,beta',
      card.rows.map((row) => row.id).join(','));
    check('the read-only rule is written on the card',
      card.readonly.includes('跨项目只读') && card.readonly.includes('不改变写入落点'),
      card.readonly);

    // ② 一项都没选就点「关联」：明确提示，不产生胶囊。
    check('clicking 关联 with nothing selected', await click(panel, '.at-project-link'));
    card = await readCard(panel);
    check('nothing selected gives an inline message', card.error.includes('一项都没选'), card.error);
    check('nothing selected shows a visible toast', await waitFor(panel,
      "document.getElementById('toast').textContent.includes('一项都没选')", 5000));
    check('nothing selected creates no capsule', card.capsules.length === 0 && card.capsulesHidden === true,
      JSON.stringify(card.capsules));
    // 等回执条自己收起再继续：展开态的截图里不该压着上一步的错误提示。
    check('the no-selection toast clears on its own',
      await waitFor(panel, "document.getElementById('toast').hidden === true", 6000));

    // ③ 点 Alpha 就地展开：四类资料计数来自 Alpha 的项目库视图。
    check('expanding Alpha reads its library materials', await expandProject(panel, 'alpha'));
    card = await readCard(panel);
    let alpha = card.rows.find((row) => row.id === 'alpha');
    check('Alpha expands in place (no page jump)', alpha?.expanded === true);
    check('Alpha shows all four material types',
      alpha?.materials.map((material) => material.key).join(',') === 'diagrams,experience,decisions,profile',
      JSON.stringify(alpha?.materials));
    check('Alpha 经验 count comes from its lessons',
      materialOf(alpha, 'experience')?.count === '1 条' && materialOf(alpha, 'experience')?.disabled === false,
      JSON.stringify(materialOf(alpha, 'experience')));
    check('Alpha 决策 count comes from the decision entry',
      materialOf(alpha, 'decisions')?.count === '1 条' && materialOf(alpha, 'decisions')?.disabled === false,
      JSON.stringify(materialOf(alpha, 'decisions')));
    check('Alpha 图谱 / 画像 are available',
      materialOf(alpha, 'diagrams')?.count === '1 张' && materialOf(alpha, 'profile')?.count === '有画像',
      JSON.stringify([materialOf(alpha, 'diagrams'), materialOf(alpha, 'profile')]));

    check('selecting 经验 for Alpha', await click(panel,
      '.at-project-row[data-project="alpha"] [data-project-material="experience"]'));
    card = await readCard(panel);
    alpha = card.rows.find((row) => row.id === 'alpha');
    check('Alpha row says one material is selected', alpha?.meta.includes('已选 1 类资料'), alpha?.meta);
    check('the footer counts one selected project', card.count === '已选 1 个项目', card.count);

    // ④ 点 Beta 就地展开：没有经验 / 决策的类型置灰并写「暂无」。
    check('expanding Beta reads its library materials', await expandProject(panel, 'beta'));
    card = await readCard(panel);
    let beta = card.rows.find((row) => row.id === 'beta');
    check('Beta expands while Alpha collapses (one at a time)', beta?.expanded === true
      && card.rows.find((row) => row.id === 'alpha')?.expanded === false);
    check('Beta has no 经验 / 决策 and shows why',
      materialOf(beta, 'experience')?.count === '暂无'
      && materialOf(beta, 'experience')?.disabled === true
      && materialOf(beta, 'decisions')?.count === '暂无'
      && materialOf(beta, 'decisions')?.disabled === true,
      JSON.stringify(beta?.materials));
    check('Beta still has 图谱 / 画像',
      materialOf(beta, 'diagrams')?.disabled === false && materialOf(beta, 'profile')?.disabled === false,
      JSON.stringify(beta?.materials));

    // ⑤ 勾「让 Agent 自己找」：四类资料置灰；再点取消即恢复。
    check('checking 让 Agent 自己找 for Beta', await click(panel,
      '.at-project-row[data-project="beta"] [data-project-auto]'));
    card = await readCard(panel);
    beta = card.rows.find((row) => row.id === 'beta');
    check('auto search is on', beta?.auto?.checked === true);
    check('all four material types are greyed out while auto is on',
      beta?.materials.every((material) => material.disabled === true), JSON.stringify(beta?.materials));
    await capture(panel, path.join(shotsDir, 'at-project-expanded.png'));
    check('unchecking auto re-enables the types', await click(panel,
      '.at-project-row[data-project="beta"] [data-project-auto]'));
    card = await readCard(panel);
    beta = card.rows.find((row) => row.id === 'beta');
    check('material types are selectable again',
      beta?.auto?.checked === false
      && materialOf(beta, 'diagrams')?.disabled === false
      && materialOf(beta, 'profile')?.disabled === false);

    check('selecting 图谱 for Beta', await click(panel,
      '.at-project-row[data-project="beta"] [data-project-material="diagrams"]'));
    card = await readCard(panel);
    check('the footer now counts two projects', card.count === '已选 2 个项目', card.count);

    // ⑥ 提交：卡片关闭，输入框上方出现两个胶囊。
    check('committing the draft', await click(panel, '.at-project-link'));
    check('the method card closes after committing', await waitFor(panel,
      "document.getElementById('atPanel').hidden === true", 5000));
    check('two capsules appear above the composer', await waitFor(panel,
      "document.querySelectorAll('#projectLinkList .link-capsule').length === 2", 5000));
    card = await readCard(panel);
    const labels = card.capsules.map((capsule) => capsule.text);
    check('capsule text is 项目名 · 已选资料',
      labels.includes('Alpha Repo · 经验') && labels.includes('Beta Repo · 架构图/图谱'),
      labels.join(' | '));
    check('the capsule bar carries the read-only rule',
      card.hint.includes('跨项目只读') && card.hint.includes('已关联 2 个项目'), card.hint);
    // 等成功回执收起再截图：胶囊旁那一句只读提示要看得见。
    check('the commit toast clears before the screenshot',
      await waitFor(panel, "document.getElementById('toast').hidden === true", 6000));
    await capture(panel, path.join(shotsDir, 'at-project-capsules.png'));

    // ⑦ 胶囊可逐个移除：去掉 Beta，再把它作为「让 Agent 自己找」加回来。
    check('removing the Beta capsule', await click(panel,
      '.link-capsule[data-project="beta"] .link-capsule-remove'));
    check('one capsule is left', await waitFor(panel,
      "document.querySelectorAll('#projectLinkList .link-capsule').length === 1", 5000));
    card = await readCard(panel);
    check('the remaining capsule is Alpha', card.capsules[0]?.id === 'alpha',
      JSON.stringify(card.capsules));

    check('reopening the method for Beta', await openProjectMethod(panel));
    check('expanding Beta again', await expandProject(panel, 'beta'));
    check('checking auto for Beta again', await click(panel,
      '.at-project-row[data-project="beta"] [data-project-auto]'));
    check('committing Beta as auto search', await click(panel, '.at-project-link'));
    check('two capsules again', await waitFor(panel,
      "document.querySelectorAll('#projectLinkList .link-capsule').length === 2", 5000));
    card = await readCard(panel);
    check('Beta capsule says 让 Agent 自己找',
      card.capsules.some((capsule) => capsule.id === 'beta'
        && capsule.text === 'Beta Repo · 让 Agent 自己找'),
      JSON.stringify(card.capsules));

    // ⑧ 发送：关联信息进入 prompt 的「## 关联项目」段；胶囊清空。
    const MESSAGE = '这两个项目都看一下，再给结论';
    await typeInput(panel, MESSAGE);
    await pressEnter(panel);
    check('the message lands in the stream', await waitFor(panel,
      "document.querySelectorAll('#messages .msg').length === 2", 8000));
    const text = await readFirstUserText(panel);
    check('the flow renders the linked-project heading and list', await panel.evaluate(`(() => {
      const bubble=document.querySelector('#messages .msg[data-role="user"] .bubble');
      return [...(bubble?.querySelectorAll('h2,h3,h4') ?? [])].some(node=>node.textContent==='关联项目')
        && [...(bubble?.querySelectorAll('li') ?? [])].some(node=>node.textContent.startsWith('Alpha Repo'));
    })()`));
    check('the sent prompt starts with the message', text.startsWith(MESSAGE), text.slice(0, 40));
    check('the prompt has the 关联项目 section', text.includes('## 关联项目'), text.slice(0, 200));
    check('Alpha is written as 项目名（来源 · 路径）',
      text.includes(`- Alpha Repo（项目库 · ${path.join(root, 'alpha')}）`), text);
    check('Beta is written as 项目名（来源 · 路径）',
      text.includes(`- Beta Repo（项目库 · ${path.join(root, 'beta')}）`), text);
    check('Alpha materials are listed', text.includes('关联资料：经验'), text);
    check('Beta auto search is listed', text.includes('关联资料：让 Agent 自己找'), text);
    check('the prompt keeps the read-only rule',
      text.includes('跨项目只读：以上关联只影响读取，不改变写入落点'), text);
    card = await readCard(panel);
    check('capsules are consumed by the send', card.capsules.length === 0 && card.capsulesHidden === true,
      JSON.stringify(card.capsules));
    await sleep(150);
    check('the send toast clears before the screenshot',
      await waitFor(panel, "document.getElementById('toast').hidden === true", 6000));
    await capture(panel, path.join(shotsDir, 'at-project-prompt.png'));

    const errors = consoleErrors(panel);
    check('console is clean', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await app.stop();
    if (failures.length === 0) {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      } catch { /* 删不掉不影响结论 */ }
    } else {
      console.warn(`[AT-PROJECT-#124] kept state: ${root}`);
    }
  }
  if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
  console.log(`[AT-PROJECT-#124] screenshots: ${shotsDir}`);
  console.log('[AT-PROJECT-#124] PASS');
};

run().catch((error) => {
  console.error(`[AT-PROJECT-#124] FAIL: ${error.stack ?? error.message}`);
  if (failures.length > 0) console.error(`[AT-PROJECT-#124] screenshots kept: ${shotsDir}`);
  process.exitCode = 1;
});
