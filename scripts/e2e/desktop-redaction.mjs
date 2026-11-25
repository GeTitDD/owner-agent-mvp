// #98 验收：会话扫描在候选进入存储前脱敏。
//
// 面板层没有自动化测试，这里用离屏 Electron + CDP 走真实路径：
//   ① 含 6 种秘密的 Codex 会话扫描后，候选里只有占位符，原文秘密不出现；
//   ② 界面固定显示「本次脱敏 N 处」，N 与扫描结果一致；
//   ③ OpenCode 不在范围内这句话可见；
//   ④ 确认一条候选后，知识库文件（含 WAL）里搜不到任何原文秘密；
//   ⑤ 同一段会话不会被重复提炼（会话键落盘，再点一次只算已扫过）；
//   ⑥ 控制台无报错。
// 全程用本 worktree 专属临时 userData + 临时 owner / 知识库 + 临时 CODEX_HOME，
// 不碰真实 %APPDATA%、真实知识库与真实会话目录。
import fs from 'node:fs';
import path from 'node:path';
import { OwnerStore } from '../../src/owner-store.mjs';
import { PersonalKnowledgeStore } from '../../src/personal-store.mjs';
import {
  capture, consoleErrors, createChecker, sleep, startApp, waitFor
} from './lib/cdp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const shotsDir = process.env.SHOTS_DIR
  ?? path.resolve(repoRoot, '..', '..', 'mm-notes', 'shots-98');
const tempBase = process.env.TMP_98 ?? path.resolve(shotsDir, '..', 'tmp-98');
const { check, failures } = createChecker('[REDACT-#98]');

const AT = '2026-11-25T10:00:00.000Z';

const SECRETS = {
  openai: `sk-proj-${'a1B2c3D4'.repeat(3)}`,
  github: `ghp_${'A1b2C3d4'.repeat(4)}`,
  password: 'hunter233',
  urlPassword: 'letmein',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  privateKeyBody: 'MIIEowIBAAKCAQEA'
};

/** 面板固定 440×640：先临时抬高视口，再截「知识」整段（扫描块 + 知识列表）。 */
const shotTall = async (panel, file, height = 1500) => {
  await panel.send('Emulation.setDeviceMetricsOverride', {
    width: 440, height, deviceScaleFactor: 1, mobile: false
  });
  await sleep(400);
  await capture(panel, path.join(shotsDir, file));
  await panel.send('Emulation.clearDeviceMetricsOverride');
  await sleep(200);
};

const makeRoot = () => {
  fs.mkdirSync(tempBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'redact-98-'));
  const userData = path.join(root, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  return {
    root,
    userData,
    ownerDb: path.join(root, 'owner.sqlite'),
    knowledgeDb: path.join(root, 'knowledge.sqlite'),
    projectRoot: path.join(root, 'project'),
    codexHome: path.join(root, 'codex-home')
  };
};

const safeRemove = (target) => {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    console.warn(`[REDACT-#98] kept state: ${target}`);
  }
};

const writeCodexSession = (codexHome, projectRoot) => {
  const file = path.join(codexHome, 'sessions', '2026', '11', '25', 'rollout-t98.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = (role, text) => ({
    timestamp: AT,
    type: 'response_item',
    payload: {
      type: 'message',
      role,
      content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }]
    }
  });
  const user = [
    '部署不要再写死密钥，统一改成环境变量',
    `OpenAI 用 ${SECRETS.openai}`,
    `GitHub 用 ${SECRETS.github}`,
    `数据库 password=${SECRETS.password}`,
    `仓库 https://deploy:${SECRETS.urlPassword}@example.com/repo`,
    `JWT ${SECRETS.jwt}`,
    `私钥 -----BEGIN RSA PRIVATE KEY-----\n${SECRETS.privateKeyBody}\n-----END RSA PRIVATE KEY-----`
  ].join('；');
  const lines = [
    { timestamp: AT, type: 'session_meta', payload: { id: 't98-session', cwd: projectRoot } },
    row('user', user),
    row('assistant', '好，这些都从文档里删掉，只保留占位符')
  ];
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
};

const readPanel = (panel) => panel.evaluate(`(() => ({
  total: document.getElementById('kbTotal')?.textContent ?? '',
  summary: document.getElementById('kbScanSummary')?.textContent ?? '',
  redactions: document.getElementById('kbScanRedactions')?.textContent ?? '',
  redactionsAttr: document.getElementById('kbScan')?.dataset.redactions ?? '',
  hint: document.querySelector('#kbScan .kb-scan-hint')?.textContent ?? '',
  candidates: [...document.querySelectorAll('#kbScanCandidates .kb-scan-item')].map((row) => ({
    fingerprint: row.dataset.fingerprint ?? '',
    quote: row.querySelector('.kb-scan-quote')?.textContent ?? '',
    hasConfirm: Boolean(row.querySelector('[data-role="decision-confirm"]'))
  }))
}))()`);

const clickScan = (panel) => panel.evaluate("document.getElementById('kbScanSessions').click()");

const confirmCandidate = (panel, fingerprint) => panel.evaluate(`(() => {
  const row = [...document.querySelectorAll('#kbScanCandidates .kb-scan-item')]
    .find((item) => item.dataset.fingerprint === ${JSON.stringify(fingerprint)});
  if (!row) return 'missing-row';
  row.querySelector('[data-role="decision-confirm"]').click();
  return 'clicked';
})()`);

/** 递归收集临时目录里的数据库与状态文件，逐个按字节搜原文秘密（含 WAL）。 */
const filesUnder = (dir) => {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
};

const run = async () => {
  const { root, userData, ownerDb, knowledgeDb, projectRoot, codexHome } = makeRoot();
  fs.mkdirSync(shotsDir, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  writeCodexSession(codexHome, projectRoot);

  const owner = new OwnerStore(ownerDb);
  try {
    owner.registerProject({
      id: 'demo', name: 'Demo', root: projectRoot, primaryDomain: 'software-engineering'
    });
  } finally { owner.close(); }
  fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({
    projectId: 'demo', gatewayUrl: 'http://127.0.0.1:18789', model: '', includePaths: ['package.json']
  }, null, 2));

  let app = null;
  let failed = true;
  try {
    app = await startApp({
      userData,
      ownerDb,
      knowledgeDb,
      env: { CODEX_HOME: codexHome, HOME: root, USERPROFILE: root },
      showPanel: true
    });
    const { panel } = app;
    await waitFor(panel, "document.getElementById('kbScanSessions')");
    await waitFor(panel, "!document.getElementById('modeB').hidden");

    await clickScan(panel);
    check('扫描出候选', await waitFor(panel, "document.querySelectorAll('#kbScanCandidates .kb-scan-item').length === 1"));

    const afterScan = await readPanel(panel);
    check('界面显示「本次脱敏 6 处」', afterScan.redactions === '本次脱敏 6 处', afterScan.redactions);
    check('计数同时落在 dataset 上（e2e 不用解析文案）', afterScan.redactionsAttr === '6', afterScan.redactionsAttr);
    check('OpenCode 不在范围内这句话可见',
      /OpenCode 的会话库体量太大，不在扫描范围内/u.test(afterScan.hint), afterScan.hint);
    check('扫描仍不写库', afterScan.total === '0', afterScan.total);

    const candidate = afterScan.candidates[0];
    check('候选里只有占位符', Boolean(candidate) && [
      'sk-…<redacted:api-key>',
      'ghp_…<redacted:github-token>',
      'password=…<redacted:credential>',
      'deploy:…<redacted:url-password>@example.com',
      'eyJ…<redacted:jwt>',
      '<redacted:private-key>'
    ].every((placeholder) => candidate.quote.includes(placeholder)), candidate?.quote);
    check('候选里搜不到任何原文秘密',
      Boolean(candidate) && Object.values(SECRETS).every((secret) => !candidate.quote.includes(secret)));
    await shotTall(panel, 'scan-redaction.png');

    const clicked = await confirmCandidate(panel, candidate.fingerprint);
    check('找到候选并点了确认', clicked === 'clicked', clicked);
    check('确认后入库一条', await waitFor(panel, "document.getElementById('kbTotal').textContent === '1'"));
    await shotTall(panel, 'scan-redaction-confirmed.png');

    // 再点一次：同一段会话已扫过，脱敏计数是 0；0 是结论，必须照常显示而不是藏起来。
    await clickScan(panel);
    check('已扫过时仍显示「本次脱敏 0 处」',
      await waitFor(panel, "document.getElementById('kbScanRedactions').textContent === '本次脱敏 0 处'"));
    check('0 处那一行没有隐藏',
      await panel.evaluate("document.getElementById('kbScanRedactions').hidden === false"));
    await shotTall(panel, 'scan-redaction-zero.png');

    const errors = consoleErrors(panel);
    check('控制台无报错', errors.length === 0, errors.join(' | ').slice(0, 400));

    if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
    failed = false;
  } finally {
    if (failed && app?.panel) {
      try { await capture(app.panel, path.join(shotsDir, 'scan-redaction-failure.png')); } catch { /* best effort */ }
    }
    if (app) await app.stop();

    if (!failed) {
      // 原始字节搜索：排除造会话的 codex-home（那里本来就该有原文），其余文件都算「库/状态」。
      const files = filesUnder(root)
        .filter((file) => !path.resolve(file).startsWith(path.resolve(codexHome)))
        .filter((file) => /\.(?:sqlite|sqlite-wal|sqlite-shm|json)$/u.test(file));
      const leaked = [];
      for (const file of files) {
        const bytes = fs.readFileSync(file);
        for (const secret of Object.values(SECRETS)) {
          if (bytes.includes(Buffer.from(secret, 'utf8'))) leaked.push(`${path.basename(file)}:${secret.slice(0, 10)}`);
        }
      }
      check('临时库与状态文件里按字节搜不到原文秘密', leaked.length === 0, leaked.join(', '));

      const store = new PersonalKnowledgeStore(knowledgeDb, { logger: null });
      try {
        const decisions = store.listDecisions({ includeEnded: true });
        check('临时库里只有一条决策', decisions.length === 1, String(decisions.length));
        const serialized = JSON.stringify(decisions);
        check('决策正文与引用里没有原文秘密',
          Object.values(SECRETS).every((secret) => !serialized.includes(secret)));
        check('决策里保留了占位符', /<redacted:api-key>/u.test(serialized));
      } finally { store.close(); }
    }
    if (failed || failures.length > 0) {
      console.error(`[REDACT-#98] kept state: ${root}`);
    } else {
      safeRemove(root);
      console.log(`[REDACT-#98] PASS; shots → ${shotsDir}`);
    }
    if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
    console.log(`[REDACT-#98] PASS; shots → ${shotsDir}`);
  }
};

run().catch((error) => {
  console.error(`[REDACT-#98] FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
