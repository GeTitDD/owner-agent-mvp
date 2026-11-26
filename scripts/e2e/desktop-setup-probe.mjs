// #128 验收：`/setup` 探测 → 逐项判定 → 建议写入清单 → 一次确认 → 回执；取消零写入。
//
// 面板层没有单测先例，这里用离屏 Electron + CDP 走真实路径（真实的 companion.setup IPC、
// 真实的目录创建与 companion.json 写入）；纯函数（四档判定、0 ≠ 缺失、手改合并、取消回执）
// 在 tests/setup-probe.test.mjs。
//
// 全程用本 worktree 专属临时 userData + 临时 Codex / OpenCode / pstack / matt 路径：
// 不碰真实 %APPDATA%、不碰真实的技能目录，也不联网。
//   第一次：建会话 → 敲 /setup → 六项判定齐全（四档都出现）→ 密钥不回显 →
//           matt 0 个技能显示「存在但为空」→ 建议清单只列写盘项 → 取消：文件系统前后一致；
//           再跑一次 → 一次确认 → 回执 → 目录与 companion.json 都写入 → 重新探测清单收敛；
//           手改 exportRoot 后重探：值保留、跳过、不代建。
// 截图：探测结果、建议清单、写入回执。
import fs from 'node:fs';
import path from 'node:path';
import { capture, consoleErrors, createChecker, startApp, waitFor } from './lib/cdp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const shotsDir = process.env.SHOTS_DIR ?? path.resolve(repoRoot, '..', '..', 'mm-notes', 'shots-128');
const tempBase = process.env.TMP_128 ?? path.resolve(shotsDir, '..', 'tmp-128');
const { check, failures } = createChecker('[SETUP-PROBE-#128]');

// 这两个值一旦出现在页面里就算回显。
const MODEL_SECRET = 'sk-128-model-must-not-leak';

const readProbeUi = (panel) => panel.evaluate(`(() => {
  const box = document.getElementById('configBox');
  const probePanel = document.getElementById('configProbePanel');
  const text = (node, selector) => node?.querySelector(selector)?.textContent?.trim() ?? '';
  const receiptNode = document.getElementById('configProbeReceipt');
  return {
    boxHidden: box.hidden,
    probeHidden: probePanel.hidden,
    summary: document.getElementById('configProbeSummary').textContent.trim(),
    items: [...document.querySelectorAll('#configProbeItems .cfg-probe-item')].map((node) => ({
      id: node.dataset.probeItem,
      verdict: node.dataset.verdict,
      badge: text(node, '.cfg-probe-badge'),
      empty: node.dataset.empty,
      value: text(node, '.cfg-probe-value'),
      detail: text(node, '.cfg-probe-detail'),
      source: text(node, '.cfg-probe-source'),
      emptyLabel: text(node, '.cfg-probe-empty')
    })),
    writes: [...document.querySelectorAll('#configProbeWrites [data-write-entry]')].map((node) => ({
      id: node.dataset.writeEntry,
      kind: node.dataset.writeKind,
      text: node.textContent.trim()
    })),
    skips: [...document.querySelectorAll('#configProbeSkips [data-skip-entry]')].map((node) => ({
      id: node.dataset.skipEntry,
      text: node.textContent.trim()
    })),
    writeListCount: document.querySelectorAll('#configProbeWrites > li').length,
    writeListWriteCount: document.querySelectorAll('#configProbeWrites [data-write-entry]').length,
    receipt: receiptNode.textContent.trim(),
    receiptTone: receiptNode.dataset.tone ?? '',
    applyDisabled: document.getElementById('configProbeApply').disabled,
    status: document.getElementById('configStatus').textContent.trim(),
    bodyText: box.innerText
  };
})()`);

const click = (panel, selector) => panel.evaluate(`(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) return false;
  node.click();
  return true;
})()`);

const typeDraft = (panel, value) => panel.evaluate(`(() => {
  const input = document.getElementById('input');
  input.value = ${JSON.stringify(value)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);

/** 回车发送；返回 preventDefault（被面板吃掉时为 false）。 */
const pressEnter = (panel) => panel.evaluate(`(() => {
  const input = document.getElementById('input');
  const event = new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', bubbles: true, cancelable: true
  });
  input.dispatchEvent(event);
  return event.defaultPrevented;
})()`);

const sendLine = async (panel, text) => {
  await typeDraft(panel, text);
  const swallowed = await pressEnter(panel);
  return swallowed;
};

const readMessages = (panel) => panel.evaluate(`(() => [...document.querySelectorAll('#messages .msg')].map((item) => ({
  role: item.dataset.role ?? '',
  text: item.querySelector('.bubble')?.textContent ?? '',
  block: item.querySelector('[data-block]')?.dataset.block ?? '',
  rows: [...(item.querySelectorAll('[data-block="kv"] .block-kv > div') ?? [])].map((row) => [
    row.querySelector('dt')?.textContent ?? '',
    row.querySelector('dd')?.textContent ?? ''
  ])
})))()`);

const messageCount = (panel) => panel.evaluate("document.querySelectorAll('#messages .msg').length");
const waitMessages = (panel, count) => waitFor(
  panel, `document.querySelectorAll('#messages .msg').length === ${count}`, 15000
);

const itemOf = (ui, id) => ui.items.find((item) => item.id === id) ?? null;

const readConfigFile = (userData) => JSON.parse(
  fs.readFileSync(path.join(userData, 'companion.json'), 'utf8')
);

const firstRun = async ({ userData, ownerDb, knowledgeDb, roots }) => {
  const app = await startApp({
    userData, ownerDb, knowledgeDb,
    env: {
      // 模型密钥「已检测到」；值只用来证明页面不回显。
      DEEPSEEK_API_KEY: MODEL_SECRET,
      OPENAI_API_KEY: '',
      // Codex 会话目录与 OpenCode 数据目录都不建：判定应为「缺失」，也不该被写进清单。
      CODEX_HOME: roots.codexHome,
      XDG_DATA_HOME: roots.dataHome,
      // pstack 指向临时目录（1 个技能）；matt 指向已存在的空目录（0 个 = 存在但为空）。
      PSTACK_DIR: roots.pstack,
      MATT_SKILLS_DIR: roots.matt
    },
    showPanel: true,
    page: 'shell.html'
  });
  const { panel } = app;
  try {
    check('卡片壳启动后有输入框', await waitFor(panel, "document.getElementById('input')", 30000));
    // 探测命令解析模块是 ESM，晚于经典脚本；发送前等它就位。
    check('探测模块已加载', await waitFor(panel, 'window.OwnerSetupProbe', 15000));

    // 开一条会话：/setup 与普通消息一样落库，没有会话时输入框是锁死的。
    await panel.evaluate("document.getElementById('sessionToggle').click()");
    await waitFor(panel, "document.getElementById('sessionPopover').hidden === false", 5000);
    await panel.evaluate("document.getElementById('sessionNew').click()");
    check('新会话可输入', await waitFor(panel, "document.getElementById('input').disabled === false", 10000));

    // ── ① 敲 /setup：逐项判定可见 ────────────────────────────────────
    const swallowed = await sendLine(panel, '/setup');
    check('/setup 不被 / 技能面板吃掉（回车照常发送）', swallowed === true);
    check('配置箱以探测态打开，六项判定都画出来', await waitFor(panel,
      "document.getElementById('configBox').hidden === false"
      + " && document.querySelectorAll('#configProbeItems .cfg-probe-item').length === 6", 20000));

    let ui = await readProbeUi(panel);
    check('探测态面板可见', ui.probeHidden === false);
    check('摘要写清四档计数',
      ui.summary.includes('共 6 项') && ui.summary.includes('可用') && ui.summary.includes('只读')
      && ui.summary.includes('缺失') && ui.summary.includes('需新建'),
      ui.summary);
    check('四档判定都出现', ['ok', 'readonly', 'missing', 'create']
      .every((verdict) => ui.items.some((item) => item.verdict === verdict)),
      ui.items.map((item) => `${item.id}:${item.badge}`).join(' '));
    check('模型密钥可用，只显示环境变量名',
      itemOf(ui, 'modelKey')?.verdict === 'ok'
      && itemOf(ui, 'modelKey')?.value === '环境变量 DEEPSEEK_API_KEY',
      `${itemOf(ui, 'modelKey')?.value} / ${itemOf(ui, 'modelKey')?.badge}`);
    check('密钥值不出现在配置箱里（不回显）', !ui.bodyText.includes(MODEL_SECRET));
    check('Codex / OpenCode 目录缺失', itemOf(ui, 'codexSessions')?.verdict === 'missing'
      && itemOf(ui, 'opencodeData')?.verdict === 'missing',
      `${itemOf(ui, 'codexSessions')?.badge} / ${itemOf(ui, 'opencodeData')?.badge}`);
    check('导出根需新建', itemOf(ui, 'exportRoot')?.verdict === 'create',
      itemOf(ui, 'exportRoot')?.badge);
    check('matt 0 个技能：存在但为空，不是缺失',
      itemOf(ui, 'mattSkills')?.verdict !== 'missing'
      && itemOf(ui, 'mattSkills')?.empty === 'true'
      && itemOf(ui, 'mattSkills')?.detail.includes('0 个')
      && itemOf(ui, 'mattSkills')?.emptyLabel === '存在但为空',
      `${itemOf(ui, 'mattSkills')?.badge} / ${itemOf(ui, 'mattSkills')?.detail}`);
    check('pstack 只读且数到 1 个技能',
      itemOf(ui, 'pstackSkills')?.verdict === 'readonly'
      && itemOf(ui, 'pstackSkills')?.detail.includes('1 个技能'),
      itemOf(ui, 'pstackSkills')?.detail);
    await capture(panel, path.join(shotsDir, 'setup-probe-results.png'));

    // ── ② 建议写入清单：只列写盘项 ──────────────────────────────────
    check('建议清单只列会写盘的项',
      ui.writes.length > 0 && ui.writes.every((row) => row.kind.length > 0)
      && ui.writeListCount === ui.writeListWriteCount,
      `${ui.writes.map((row) => row.id).join(',')} (li=${ui.writeListCount}/${ui.writeListWriteCount})`);
    check('清单包含导出根（新建目录 + 写配置）与两类技能目录（写配置）',
      ['exportRoot', 'pstackSkills', 'mattSkills'].every((id) => ui.writes.some((row) => row.id === id)),
      ui.writes.map((row) => `${row.id}:${row.kind}`).join(' '));
    check('缺失的 Codex / OpenCode 与密钥不在清单里',
      !ui.writes.some((row) => ['codexSessions', 'opencodeData', 'modelKey'].includes(row.id)),
      ui.writes.map((row) => row.id).join(','));
    check('每条清单项都写清写到哪里', ui.writes.every((row) => row.text.includes('写到 ')));
    check('导出根的重建项写明新建目录',
      ui.writes.find((row) => row.id === 'exportRoot')?.text.includes('新建目录'),
      ui.writes.find((row) => row.id === 'exportRoot')?.text);
    await panel.evaluate("(() => { const node = document.getElementById('configProbePanel'); node.scrollTop = node.scrollHeight; })()");
    await capture(panel, path.join(shotsDir, 'setup-probe-write-list.png'));

    // ── ③ 取消：一项都不写（文件系统前后一致）───────────────────────
    const configBefore = fs.readFileSync(path.join(userData, 'companion.json'), 'utf8');
    const exportsBefore = fs.existsSync(path.join(userData, 'exports'));
    check('取消前导出根还不存在', exportsBefore === false);
    check('点取消', await click(panel, '#configProbeCancel'));
    check('取消后有可见回执', await waitFor(panel,
      "document.getElementById('configProbeReceipt').textContent.includes('一个都没做')", 8000));
    ui = await readProbeUi(panel);
    check('取消回执行写着 0 处写入', ui.receipt.includes('0 处') || ui.receipt.includes('一个都没做'), ui.receipt);
    check('取消不改 companion.json',
      fs.readFileSync(path.join(userData, 'companion.json'), 'utf8') === configBefore);
    check('取消不新建导出根', fs.existsSync(path.join(userData, 'exports')) === exportsBefore);
    check('取消回执也落进对话流（2 条消息）', await waitMessages(panel, 2));
    let messages = await readMessages(panel);
    check('流里的取消回执是 kv 块，写着「未写入（0 处）」',
      messages[1]?.block === 'kv'
      && messages[1].rows.some((row) => String(row[1]).includes('未写入（0 处）')),
      JSON.stringify(messages[1]?.rows?.slice(0, 3)));

    // 关掉配置箱，再跑一次 /setup（取消后的新一轮：清单必须重新探测）。
    await panel.evaluate("document.getElementById('configClose').click()");
    await waitFor(panel, "document.getElementById('configBox').hidden === true", 5000);
    await sendLine(panel, '/setup');
    check('第二次探测仍在同一入口打开', await waitFor(panel,
      "document.getElementById('configBox').hidden === false"
      + " && document.querySelectorAll('#configProbeItems .cfg-probe-item').length === 6", 20000));

    // ── ④ 一次确认：整张清单一起写 ─────────────────────────────────
    check('清单非空时确认按钮可点', await panel.evaluate(
      "document.getElementById('configProbeApply').disabled === false"
    ));
    check('点一次「按清单写入」', await click(panel, '#configProbeApply'));
    check('写入后箱内回执出现', await waitFor(panel,
      "document.getElementById('configProbeReceipt').textContent.includes('写入回执')", 20000));
    ui = await readProbeUi(panel);
    check('回执写明新建目录与配置数量',
      ui.receipt.includes('新建 1 个目录') && ui.receipt.includes('写入 3 项配置'), ui.receipt);
    check('导出根已建出来', fs.existsSync(path.join(userData, 'exports')));
    let config = readConfigFile(userData);
    check('companion.json 写入探测到的路径',
      config.exportRoot === path.join(userData, 'exports')
      && config.pstackSkills === path.join(roots.pstack, 'skills')
      && config.mattSkills === roots.matt,
      JSON.stringify({ exportRoot: config.exportRoot, pstack: config.pstackSkills, matt: config.mattSkills }));
    check('缺失的 Codex / OpenCode 路径没有被写进配置',
      !config.codexSessions && !config.opencodeData,
      JSON.stringify({ codex: config.codexSessions, opencode: config.opencodeData }));
    check('探测写入值记在 setupProbed 里', config.setupProbed?.exportRoot === path.join(userData, 'exports'));
    check('重探后导出根变成可用，清单收敛为空',
      await waitFor(panel,
        "document.querySelector('#configProbeItems [data-probe-item=\"exportRoot\"]').dataset.verdict === 'ok'", 8000));
    ui = await readProbeUi(panel);
    check('重探后没有会写盘的项，确认按钮禁用',
      ui.writes.length === 0 && ui.applyDisabled === true,
      `writes=${ui.writes.length} disabled=${ui.applyDisabled}`);
    await capture(panel, path.join(shotsDir, 'setup-probe-receipt.png'));

    check('写入回执落进对话流（4 条消息）', await waitMessages(panel, 4));
    messages = await readMessages(panel);
    const receipt = messages[3];
    check('流里的写入回执逐条列出写了什么',
      receipt?.block === 'kv'
      && receipt.rows.some((row) => row[0] === '新建目录' && String(row[1]).includes('exports'))
      && receipt.rows.some((row) => row[0] === '配置' && String(row[1]).includes('exportRoot =')),
      JSON.stringify(receipt?.rows?.slice(0, 5)));

    // 重新探测不改文件：清单收敛只发生在内存里。
    const configAfterApply = fs.readFileSync(path.join(userData, 'companion.json'), 'utf8');
    check('重新探测', await click(panel, '#configProbeRecheck'));
    await waitFor(panel, "document.getElementById('configProbeSummary').textContent.includes('共 6 项')", 8000);
    check('重新探测不写 companion.json',
      fs.readFileSync(path.join(userData, 'companion.json'), 'utf8') === configAfterApply);

    // ── ⑤ 手改优先：exportRoot 手改后重探不覆盖、不代建 ─────────────
    const manualRoot = path.join(roots.root, 'my-own-exports');
    const saved = await panel.evaluate(
      `window.companion.settings.set({ exportRoot: ${JSON.stringify(manualRoot)} })`
    );
    check('手改 exportRoot 已保存', saved?.exportRoot === manualRoot, saved?.exportRoot);
    check('再次探测', await click(panel, '#configProbeRecheck'));
    await waitFor(panel,
      "document.querySelector('#configProbeItems [data-probe-item=\"exportRoot\"]').dataset.source === 'manual'", 8000);
    ui = await readProbeUi(panel);
    check('手改的导出根值保留，并标「手改」',
      itemOf(ui, 'exportRoot')?.value === manualRoot
      && itemOf(ui, 'exportRoot')?.source === '手改',
      `${itemOf(ui, 'exportRoot')?.value} / ${itemOf(ui, 'exportRoot')?.source}`);
    check('手改项不进写入清单，只进跳过说明',
      !ui.writes.some((row) => row.id === 'exportRoot')
      && ui.skips.some((row) => row.id === 'exportRoot' && row.text.includes('手改值保留')),
      `writes=${ui.writes.map((row) => row.id).join(',')} skips=${ui.skips.map((row) => row.id).join(',')}`);
    check('手改值不会被代建目录', fs.existsSync(manualRoot) === false);
    check('手改值仍在配置文件里', readConfigFile(userData).exportRoot === manualRoot);

    const errors = consoleErrors(panel);
    check('控制台干净', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await app.stop();
  }
};

const safeRemove = (target) => {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    console.warn(`[SETUP-PROBE-#128] kept state: ${target}`);
  }
};

const run = async () => {
  fs.mkdirSync(tempBase, { recursive: true });
  fs.mkdirSync(shotsDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'setup-128-'));
  const userData = path.join(root, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  // 种子配置：model 偏离默认（只是为了让配置箱里有一项「手改」），探测路径全留空。
  fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({
    model: 'seed-model-128'
  }, null, 2), 'utf8');

  // 临时外部路径：Codex / OpenCode 都不建（缺失），pstack 1 个技能，matt 空目录。
  const roots = {
    root,
    codexHome: path.join(root, 'codex-home'),
    dataHome: path.join(root, 'data'),
    pstack: path.join(root, 'pstack'),
    matt: path.join(root, 'skills', 'matt')
  };
  fs.mkdirSync(path.join(roots.pstack, 'skills', 'poteto-mode'), { recursive: true });
  fs.writeFileSync(path.join(roots.pstack, 'skills', 'poteto-mode', 'SKILL.md'), '# 测试技能\n', 'utf8');
  fs.mkdirSync(roots.matt, { recursive: true });

  const files = {
    userData,
    ownerDb: path.join(root, 'owner.sqlite'),
    knowledgeDb: path.join(root, 'knowledge.sqlite'),
    roots
  };
  try {
    await firstRun(files);
  } finally {
    if (failures.length === 0) safeRemove(root);
    else console.warn(`[SETUP-PROBE-#128] kept state: ${root}`);
  }
  if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
  console.log(`[SETUP-PROBE-#128] screenshots: ${shotsDir}`);
  console.log('[SETUP-PROBE-#128] PASS');
};

run().catch((error) => {
  console.error(`[SETUP-PROBE-#128] FAIL: ${error.stack ?? error.message}`);
  if (failures.length > 0) console.error(`[SETUP-PROBE-#128] screenshots kept: ${shotsDir}`);
  process.exitCode = 1;
});
