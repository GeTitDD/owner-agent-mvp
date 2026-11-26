// #127 验收：配置箱（顶栏齿轮 → 全窗口覆盖层 → 七个分区）。
//
// 面板层没有单测先例，这里用离屏 Electron + CDP 走真实路径；纯函数（分区数据、来源
// 标注、密钥状态、保存补丁）在 tests/config-box.test.mjs。全程用本 worktree 专属临时
// userData + 临时 owner / 知识库，不碰真实 %APPDATA%。
//   第一次：打开配置箱 → 七个分区齐全且可滚动 → 每行「标签 + 值 + 一句后果」+ 来源
//           → 密钥只显示环境变量名与状态（不回显值、没有输入框）
//           → 取消不改（输入的内容与文件都不变）→ 改两项保存并回读
//           → 技能超 12 个保存被拒且文件不动 → Esc 收起；
//   第二次（同一 userData）：配置箱里仍是保存后的值，来源标「手改」。
// 截图：配置箱上半、下半（含监控与同步）。
import fs from 'node:fs';
import path from 'node:path';
import {
  capture, consoleErrors, createChecker, startApp, waitFor
} from './lib/cdp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const shotsDir = process.env.SHOTS_DIR
  ?? path.resolve(repoRoot, '..', '..', 'mm-notes', 'shots-127');
const tempBase = process.env.TMP_127 ?? path.resolve(shotsDir, '..', 'tmp-127');
const { check, failures } = createChecker('[CONFIG-BOX-#127]');

// 密钥只给状态：这两个值一旦出现在页面里就算回显。
const APPROVAL_TOKEN = 'tok-127-approval';
const SYNC_TOKEN = 'gh-127-token';
// 顶栏七个分区按 issue #127 的顺序。
const SECTION_IDS = ['model', 'paths', 'share', 'skills', 'write', 'watch', 'sync'];
const SECTION_LABELS = ['模型接口', '目录', '分享', '技能', '写入范围', '监控', '同步'];

/** 界面上能断言的形状：入口、覆盖层、七段、每行的值与来源、密钥行。 */
const readUi = (panel) => panel.evaluate(`(() => {
  const box = document.getElementById('configBox');
  const body = document.getElementById('configBody');
  const toggle = document.getElementById('configToggle');
  const statusNode = document.getElementById('configStatus');
  const rect = box.getBoundingClientRect();
  const style = getComputedStyle(box);
  const row = (node) => {
    const input = node.querySelector('input[data-cfg]');
    const secretState = node.querySelector('.cfg-state');
    return {
      id: node.dataset.row,
      kind: node.dataset.kind,
      source: node.dataset.source,
      sourceText: node.querySelector('.cfg-source')?.textContent?.trim() ?? '',
      label: node.querySelector('.cfg-label')?.textContent?.trim() ?? '',
      effect: node.querySelector('.cfg-effect')?.textContent?.trim() ?? '',
      display: (input ? input.value : node.querySelector('.cfg-value')?.textContent ?? '').trim(),
      hasInput: Boolean(input),
      secretState: secretState?.textContent?.trim() ?? '',
      secretOrigin: node.querySelector('.cfg-origin')?.textContent?.trim() ?? ''
    };
  };
  return {
    toggleExists: Boolean(toggle),
    toggleExpanded: toggle?.getAttribute('aria-expanded') ?? '',
    headerSlots: [...document.querySelectorAll('#shellHeader [data-slot]')].map((node) => node.dataset.slot),
    headerCapsules: document.querySelectorAll('#shellHeader .capsule').length,
    headerOtherControls: document.querySelectorAll(
      '#shellHeader > button, #shellHeader > input, #shellHeader > select, #shellHeader > a'
    ).length,
    boxHidden: box.hidden,
    overlayPosition: style.position,
    overlayRect: { width: Math.round(rect.width), height: Math.round(rect.height) },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    sections: [...document.querySelectorAll('#configBody .cfg-group')].map((section) => ({
      id: section.dataset.section,
      label: section.querySelector('.cfg-group-title')?.textContent?.trim() ?? '',
      hint: section.querySelector('.cfg-group-hint')?.textContent?.trim() ?? '',
      rows: [...section.querySelectorAll('.cfg-row')].map(row)
    })),
    status: statusNode.textContent.trim(),
    statusTone: statusNode.dataset.tone ?? '',
    saveDisabled: document.getElementById('configSave').disabled,
    scroll: {
      scrollHeight: body.scrollHeight,
      clientHeight: body.clientHeight,
      scrollTop: body.scrollTop
    },
    bodyText: body.innerText,
    toast: document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent.trim()
  };
})()`);

const click = (panel, selector) => panel.evaluate(`(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) return false;
  node.click();
  return true;
})()`);

/** 点齿轮打开，等七段画出来。 */
const openBox = async (panel) => {
  await click(panel, '#configToggle');
  const shown = await waitFor(panel,
    "document.getElementById('configBox').hidden === false"
    + " && document.querySelectorAll('#configBody .cfg-group').length === 7", 15000);
  return shown;
};

const setInput = (panel, rowId, value) => panel.evaluate(`(() => {
  const input = document.querySelector('input[data-cfg=' + JSON.stringify(${JSON.stringify(rowId)}) + ']');
  if (!input) return false;
  input.value = ${JSON.stringify(value)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);

const rowsOf = (ui) => ui.sections.flatMap((section) => section.rows);
const rowById = (ui, id) => rowsOf(ui).find((row) => row.id === id) ?? null;

const readConfigFile = (userData) => JSON.parse(
  fs.readFileSync(path.join(userData, 'companion.json'), 'utf8')
);

const firstRun = async ({ userData, ownerDb, knowledgeDb }) => {
  const app = await startApp({
    userData, ownerDb, knowledgeDb,
    env: {
      // 审批令牌「已检测到」、同步令牌「已检测到」、侧车令牌「未配置」：三种状态都由
      // 环境变量固定下来，结果不随开发机上的真实凭据漂移。
      OWNER_AGENT_APPROVAL_TOKEN: APPROVAL_TOKEN,
      GITHUB_TOKEN: SYNC_TOKEN,
      OWNER_AGENT_SIDECAR_TOKEN: '',
      OWNER_AGENT_SIDECAR_TOKEN_FILE: ''
    },
    showPanel: true,
    page: 'shell.html'
  });
  const { panel } = app;
  try {
    check('卡片壳启动后有配置入口',
      await waitFor(panel, "document.querySelector('#configToggle')", 30000));

    // 入口不能把顶栏变成第二个菜单：#106 的「五个状态位 + 两个胶囊」原样保留。
    let ui = await readUi(panel);
    check('配置入口是齿轮按钮，默认收起',
      ui.toggleExists === true && ui.toggleExpanded === 'false' && ui.boxHidden === true,
      `expanded=${ui.toggleExpanded} hidden=${ui.boxHidden}`);
    check('顶栏契约不变：五个状态位 + 两个胶囊 + 没有新的顶栏直系控件',
      ui.headerSlots.join(',') === 'session,project,write,monitor,export'
      && ui.headerCapsules === 2 && ui.headerOtherControls === 0,
      `${ui.headerSlots.join(',')} capsules=${ui.headerCapsules} others=${ui.headerOtherControls}`);

    // ① 打开：全窗口覆盖层 + 七个分区，顺序照 issue。
    check('点齿轮打开配置箱并画出七个分区', await openBox(panel));
    ui = await readUi(panel);
    check('配置箱是全窗口覆盖层（fixed，铺满窗口）',
      ui.overlayPosition === 'fixed'
      && ui.overlayRect.width === ui.viewport.width
      && ui.overlayRect.height === ui.viewport.height,
      `${ui.overlayPosition} ${JSON.stringify(ui.overlayRect)} / ${JSON.stringify(ui.viewport)}`);
    check('七个分区都在，顺序照 issue #127',
      ui.sections.map((section) => section.id).join(',') === SECTION_IDS.join(','),
      ui.sections.map((section) => section.id).join(','));
    check('七个分区的标题也对得上',
      ui.sections.map((section) => section.label).join(',') === SECTION_LABELS.join(','),
      ui.sections.map((section) => section.label).join(','));
    check('每个分区都有小标题与一句说明，且都有行',
      ui.sections.every((section) => section.label && section.hint && section.rows.length > 0),
      ui.sections.map((section) => `${section.id}:${section.rows.length}`).join(' '));

    const rows = rowsOf(ui);
    check('每行都是「标签 + 值 + 一句后果」',
      rows.every((row) => row.label.length > 0 && row.effect.length > 0)
      && rows.every((row) => row.hasInput || row.display.length > 0),
      rows.filter((row) => !row.hasInput && !row.display).map((row) => row.id).join(','));
    check('空值项给占位文案（留空 = 默认）',
      rows.filter((row) => row.hasInput && !row.display)
        .every((row) => row.kind === 'text' || row.kind === 'list'),
      rows.filter((row) => row.hasInput && !row.display).map((row) => row.id).join(','));
    check('每行都标了来源（探测 / 手改）',
      rows.every((row) => ['探测', '手改'].includes(row.sourceText))
      && rows.every((row) => row.source === (row.sourceText === '手改' ? 'manual' : 'probe')),
      rows.map((row) => `${row.id}:${row.sourceText}`).join(' '));
    check('可写行有输入框，只读行没有输入框',
      rows.filter((row) => row.hasInput).map((row) => row.id).join(',')
        === 'model,diagramModel,gatewayUrl,includePaths,chatSkills'
      && rows.filter((row) => row.kind === 'readonly').every((row) => row.hasInput === false),
      rows.filter((row) => row.hasInput).map((row) => row.id).join(','));

    // 来源标注：种子配置里只有 model 偏离默认，其它可写项还是默认值。
    check('来源按「文件里的值 vs 内置默认」判：model 手改、其余探测',
      rowById(ui, 'model')?.sourceText === '手改'
      && rowById(ui, 'diagramModel')?.sourceText === '探测'
      && rowById(ui, 'includePaths')?.sourceText === '探测'
      && rowById(ui, 'userData')?.sourceText === '探测',
      ['model', 'diagramModel', 'includePaths', 'userData']
        .map((id) => `${id}:${rowById(ui, id)?.sourceText}`).join(' '));

    // ② 密钥：只有来源与状态，没有输入框，也没有值。
    const secretRows = rows.filter((row) => row.kind === 'secret');
    check('密钥行共四条，都没有输入框', secretRows.length === 4
      && secretRows.every((row) => row.hasInput === false),
      secretRows.map((row) => row.id).join(','));
    check('密钥行只显示环境变量名 + 状态',
      secretRows.every((row) => /^环境变量 /u.test(row.display))
      && secretRows.every((row) => ['已检测到', '未配置'].includes(row.secretState)),
      secretRows.map((row) => `${row.id}:${row.display}(${row.secretState})`).join(' | '));
    check('审批令牌与同步令牌已检测到，侧车令牌未配置',
      rowById(ui, 'approvalToken')?.secretState === '已检测到'
      && rowById(ui, 'syncCredential')?.secretState === '已检测到'
      && rowById(ui, 'syncCredential')?.display === '环境变量 GITHUB_TOKEN'
      && rowById(ui, 'sidecarToken')?.secretState === '未配置',
      [['approvalToken', 'approval'], ['syncCredential', 'sync'], ['sidecarToken', 'sidecar']]
        .map(([id]) => `${id}:${rowById(ui, id)?.display}/${rowById(ui, id)?.secretState}`).join(' '));
    const leaks = [APPROVAL_TOKEN, SYNC_TOKEN].filter((secret) => ui.bodyText.includes(secret));
    check('密钥值不出现在配置箱里（不回显）', leaks.length === 0, leaks.join(','));

    // ③ 可滚动：七段都在一个滚动容器里；上半 / 下半各截一张。
    check('七个分区共用一个滚动容器，内容比视口高',
      ui.scroll.scrollHeight > ui.scroll.clientHeight,
      `${ui.scroll.scrollHeight} / ${ui.scroll.clientHeight}`);
    await panel.evaluate("document.getElementById('configBody').scrollTop = 0");
    await capture(panel, path.join(shotsDir, 'config-upper.png'));
    await panel.evaluate("(() => { const body = document.getElementById('configBody'); body.scrollTop = body.scrollHeight; })()");
    await waitFor(panel, "document.getElementById('configBody').scrollTop > 0", 5000);
    ui = await readUi(panel);
    check('滚到底时能看到监控与同步两段',
      ui.scroll.scrollTop > 0
      && ui.sections.find((section) => section.id === 'watch')?.rows.length === 3
      && ui.sections.find((section) => section.id === 'sync')?.rows.length === 4,
      `scrollTop=${ui.scroll.scrollTop}`);
    await capture(panel, path.join(shotsDir, 'config-lower.png'));

    // ④ 取消不改：输入框里敲的东西与文件都不变。
    const before = fs.readFileSync(path.join(userData, 'companion.json'), 'utf8');
    check('改一项的值（取消前先敲进去）', await setInput(panel, 'model', 'cancelled-model-127'));
    ui = await readUi(panel);
    check('敲进去的值在输入框里（还没保存）',
      rowById(ui, 'model')?.display === 'cancelled-model-127', rowById(ui, 'model')?.display);
    await click(panel, '#configCancel');
    check('点取消后配置箱收起',
      await waitFor(panel, "document.getElementById('configBox').hidden === true", 5000));
    check('取消不写文件',
      fs.readFileSync(path.join(userData, 'companion.json'), 'utf8') === before);
    check('取消后重开还是原来的值', await openBox(panel));
    ui = await readUi(panel);
    check('重开后输入框回到配置文件里的值',
      rowById(ui, 'model')?.display === 'seed-model-127', rowById(ui, 'model')?.display);

    // ⑤ 保存：改两项 → 写回 companion.json → 可见反馈 → 回读生效。
    check('改主模型', await setInput(panel, 'model', 'saved-model-127'));
    check('改网关地址', await setInput(panel, 'gatewayUrl', 'http://127.0.0.1:19999'));
    await click(panel, '#configSave');
    check('保存后有可见反馈（状态行写清写到哪个文件）',
      await waitFor(panel,
        "document.getElementById('configStatus').textContent.includes('已保存到')"
        + " && document.getElementById('configStatus').textContent.includes('companion.json')", 15000));
    ui = await readUi(panel);
    check('保存回执写着重启后仍然生效',
      /重启后仍然生效/u.test(ui.status) && ui.statusTone === 'ok', `${ui.status} / ${ui.statusTone}`);
    check('保存后也给一条 toast 回执', ui.toast.includes('配置已保存'), ui.toast);
    const saved = readConfigFile(userData);
    check('保存写回同一份 companion.json',
      saved.model === 'saved-model-127' && saved.gatewayUrl === 'http://127.0.0.1:19999',
      `${saved.model} / ${saved.gatewayUrl}`);
    check('保存后这两项改标「手改」',
      rowById(ui, 'model')?.sourceText === '手改' && rowById(ui, 'gatewayUrl')?.sourceText === '手改',
      `${rowById(ui, 'model')?.sourceText} / ${rowById(ui, 'gatewayUrl')?.sourceText}`);

    // ⑥ 技能超限：主进程拒绝保存，文件不动，箱子里能看见原因。
    check('把隐式技能填到 13 个', await setInput(panel, 'chatSkills',
      'a,b,c,d,e,f,g,h,i,j,k,l,m'));
    await click(panel, '#configSave');
    check('超过 12 个技能时保存被拒，并写明原因',
      await waitFor(panel,
        "document.getElementById('configStatus').dataset.tone === 'error'"
        + " && document.getElementById('configStatus').textContent.includes('12')", 15000));
    ui = await readUi(panel);
    check('保存失败时不写文件', readConfigFile(userData).chatSkills.length === 0,
      JSON.stringify(readConfigFile(userData).chatSkills));
    check('保存失败时箱子还开着，输入没被清掉',
      ui.boxHidden === false && rowById(ui, 'chatSkills')?.display.startsWith('a,b,c'));

    // ⑦ Esc 收起，且不写文件。
    await panel.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    check('Esc 收起配置箱',
      await waitFor(panel, "document.getElementById('configBox').hidden === true", 5000));
    check('Esc 收起同样不改文件',
      readConfigFile(userData).chatSkills.length === 0 && readConfigFile(userData).model === 'saved-model-127');

    const errors = consoleErrors(panel);
    check('第一次运行控制台干净', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await app.stop();
  }
};

const secondRun = async ({ userData, ownerDb, knowledgeDb }) => {
  // 第二次不设凭据：密钥状态允许变，但配置值必须还在。
  const app = await startApp({
    userData, ownerDb, knowledgeDb,
    env: {
      OWNER_AGENT_APPROVAL_TOKEN: '',
      OWNER_AGENT_APPROVAL_TOKEN_FILE: '',
      GITHUB_TOKEN: '',
      GH_TOKEN: '',
      OWNER_AGENT_SIDECAR_TOKEN: '',
      OWNER_AGENT_SIDECAR_TOKEN_FILE: ''
    },
    showPanel: true,
    page: 'shell.html'
  });
  const { panel } = app;
  try {
    check('重启后仍是卡片壳', await waitFor(panel, "document.querySelector('#configToggle')", 30000));
    check('重启后配置箱能打开', await openBox(panel));
    let ui = await readUi(panel);
    check('重启后保存的值仍在',
      rowById(ui, 'model')?.display === 'saved-model-127'
      && rowById(ui, 'gatewayUrl')?.display === 'http://127.0.0.1:19999',
      `${rowById(ui, 'model')?.display} / ${rowById(ui, 'gatewayUrl')?.display}`);
    check('重启后这两项仍标「手改」',
      rowById(ui, 'model')?.sourceText === '手改' && rowById(ui, 'gatewayUrl')?.sourceText === '手改',
      `${rowById(ui, 'model')?.sourceText} / ${rowById(ui, 'gatewayUrl')?.sourceText}`);
    check('重启后没配的凭据回到「未配置」',
      rowById(ui, 'sidecarToken')?.secretState === '未配置'
      && rowById(ui, 'syncCredential')?.secretState === '未配置',
      `${rowById(ui, 'sidecarToken')?.secretState} / ${rowById(ui, 'syncCredential')?.secretState}`);
    const leaks = [APPROVAL_TOKEN, SYNC_TOKEN].filter((secret) => ui.bodyText.includes(secret));
    check('重启后也看不到任何密钥值', leaks.length === 0, leaks.join(','));

    const errors = consoleErrors(panel);
    check('重启后控制台干净', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await app.stop();
  }
};

const safeRemove = (target) => {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    console.warn(`[CONFIG-BOX-#127] kept state: ${target}`);
  }
};

const run = async () => {
  fs.mkdirSync(tempBase, { recursive: true });
  fs.mkdirSync(shotsDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'config-box-127-'));
  const userData = path.join(root, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  // 种一份 companion.json：model 偏离内置默认（→ 手改），其余可写项都是默认值（→ 探测）。
  fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({
    model: 'seed-model-127',
    gatewayUrl: 'http://127.0.0.1:18789',
    includePaths: ['package.json'],
    chatSkills: []
  }, null, 2), 'utf8');
  const files = {
    userData,
    ownerDb: path.join(root, 'owner.sqlite'),
    knowledgeDb: path.join(root, 'knowledge.sqlite')
  };
  try {
    await firstRun(files);
    await secondRun(files);
  } finally {
    if (failures.length === 0) safeRemove(root);
    else console.warn(`[CONFIG-BOX-#127] kept state: ${root}`);
  }
  if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
  console.log(`[CONFIG-BOX-#127] screenshots: ${shotsDir}`);
  console.log('[CONFIG-BOX-#127] PASS');
};

run().catch((error) => {
  console.error(`[CONFIG-BOX-#127] FAIL: ${error.stack ?? error.message}`);
  if (failures.length > 0) console.error(`[CONFIG-BOX-#127] screenshots kept: ${shotsDir}`);
  process.exitCode = 1;
});
