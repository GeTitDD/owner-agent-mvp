// #128 /setup 探测与写盘确认的纯函数测试。
// 真实文件系统与窗口走 scripts/e2e/desktop-setup-probe.mjs；这里只喂注入的假 env / 假 io。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_KEY_ENVS,
  SETUP_COMMAND,
  SETUP_PATH_KEYS,
  VERDICT,
  VERDICT_LABELS,
  applySetup,
  countSkillDirs,
  isSetupCommand,
  parseSetupCommand,
  planSetupWrites,
  probeSetup,
  setupCancelReceipt,
  setupReceipt,
  setupValueSource,
  summarizeProbe
} from '../src/setup-probe.mjs';

const PATHS = Object.freeze({
  codexSessions: 'C:/home/.codex/sessions',
  opencodeData: 'C:/home/.local/share/opencode',
  exportRoot: 'C:/app/exports',
  pstackSkills: 'D:/pstack/skills',
  mattSkills: 'C:/home/.owner-agent/skills/matt'
});

const stat = (overrides = {}) => ({
  exists: true, isDir: true, readable: true, writable: true, ...overrides
});

/** 可变的假文件系统：apply 建完目录后，重新探测能看到它。 */
const makeIo = ({ stats = {}, dirs = {} } = {}) => {
  const state = {
    stats: { ...stats },
    dirs: { ...dirs }
  };
  return {
    state,
    stat: (target) => state.stats[target] ?? { exists: false, isDir: false, readable: false, writable: false },
    listDirs: (target) => state.dirs[target] ?? [],
    mkdir: async (target) => {
      state.stats[target] = stat();
      state.dirs[target] = state.dirs[target] ?? [];
    }
  };
};

/** 默认这一份本机：Codex 只读、OpenCode 缺失、导出根需新建、pstack 空、matt 两个技能。 */
const defaultIo = () => makeIo({
  stats: {
    [PATHS.codexSessions]: stat({ writable: false }),
    [PATHS.pstackSkills]: stat(),
    [PATHS.mattSkills]: stat()
  },
  dirs: {
    [PATHS.pstackSkills]: [],
    [PATHS.mattSkills]: ['engineering', 'deprecated'],
    'C:/home/.owner-agent/skills/matt/engineering': ['tdd', 'plan'],
    'C:/home/.owner-agent/skills/matt/deprecated': ['old-skill']
  }
});

// ── 命令解析 ────────────────────────────────────────────────────────

test('/setup 是整句命令，不吞掉同前缀的技能命令', () => {
  assert.equal(SETUP_COMMAND, '/setup');
  assert.deepEqual(parseSetupCommand('/setup'), { kind: 'setup', arg: '' });
  assert.deepEqual(parseSetupCommand('  /setup 重新看一下 '), { kind: 'setup', arg: '重新看一下' });
  assert.equal(parseSetupCommand('/setup-pstack'), null);
  assert.equal(parseSetupCommand('/setups'), null);
  assert.equal(isSetupCommand('/setup'), true);
  assert.equal(isSetupCommand('/记灵感 随便'), false);
});

// ── 四档判定 ────────────────────────────────────────────────────────

test('六类探测项都在，四档判定各出现一次以上', () => {
  const probe = probeSetup({
    env: { DEEPSEEK_API_KEY: 'sk-128-secret' },
    paths: PATHS,
    io: defaultIo()
  });
  assert.deepEqual(probe.items.map((item) => item.id), [
    'modelKey', 'codexSessions', 'opencodeData', 'exportRoot', 'pstackSkills', 'mattSkills'
  ]);
  const verdicts = Object.fromEntries(probe.items.map((item) => [item.id, item.verdict]));
  assert.equal(verdicts.modelKey, VERDICT.ok);
  assert.equal(verdicts.codexSessions, VERDICT.readonly);
  assert.equal(verdicts.opencodeData, VERDICT.missing);
  assert.equal(verdicts.exportRoot, VERDICT.create);
  assert.equal(verdicts.pstackSkills, VERDICT.readonly);
  assert.equal(verdicts.mattSkills, VERDICT.ok);
  for (const item of probe.items) {
    assert.equal(item.verdictLabel, VERDICT_LABELS[item.verdict]);
  }
  assert.equal(probe.counts.ok, 2);
  assert.equal(probe.counts.readonly, 2);
  assert.equal(probe.counts.missing, 1);
  assert.equal(probe.counts.create, 1);
  assert.match(summarizeProbe(probe).text, /可用 2 · 只读 2 · 缺失 1 · 需新建 1/u);
});

test('自有目录存在但不可写是「只读」，不是「可用」', () => {
  const io = defaultIo();
  io.state.stats[PATHS.mattSkills] = stat({ writable: false });
  const probe = probeSetup({ env: {}, paths: PATHS, io });
  const matt = probe.items.find((item) => item.id === 'mattSkills');
  assert.equal(matt.verdict, VERDICT.readonly);
  assert.match(matt.detail, /不可写/u);
});

// ── 密钥：只看存在，不回显值 ────────────────────────────────────────

test('模型密钥只报环境变量名与状态，值不进返回值', () => {
  const secret = 'sk-128-must-not-leak';
  const probe = probeSetup({ env: { DEEPSEEK_API_KEY: secret }, paths: PATHS, io: defaultIo() });
  const model = probe.items.find((item) => item.id === 'modelKey');
  assert.equal(model.verdict, VERDICT.ok);
  assert.equal(model.value, '环境变量 DEEPSEEK_API_KEY');
  assert.equal(model.envName, 'DEEPSEEK_API_KEY');
  assert.ok(!JSON.stringify(probe).includes(secret));
  // 候选名单里每个名字都来自 Pi 的提供方凭据，不是随手拼的。
  assert.ok(MODEL_KEY_ENVS.includes('DEEPSEEK_API_KEY'));
  assert.ok(MODEL_KEY_ENVS.includes('OPENAI_API_KEY'));

  const missing = probeSetup({ env: {}, paths: PATHS, io: defaultIo() })
    .items.find((item) => item.id === 'modelKey');
  assert.equal(missing.verdict, VERDICT.missing);
  assert.equal(missing.value, '未配置');
});

// ── 技能数量 0 ≠ 缺失 ───────────────────────────────────────────────

test('技能目录数量为 0 是「存在但为空」，仍保留只读 / 可用判定', () => {
  const probe = probeSetup({ env: {}, paths: PATHS, io: defaultIo() });
  const pstack = probe.items.find((item) => item.id === 'pstackSkills');
  assert.notEqual(pstack.verdict, VERDICT.missing);
  assert.equal(pstack.verdict, VERDICT.readonly);
  assert.equal(pstack.count, 0);
  assert.equal(pstack.empty, true);
  assert.match(pstack.detail, /存在但为空/u);

  const matt = probe.items.find((item) => item.id === 'mattSkills');
  assert.equal(matt.count, 2);
  assert.equal(matt.empty, false);

  // 目录真的不存在时才是「缺失」：与 0 个技能必须能分开。
  const missingIo = defaultIo();
  delete missingIo.state.stats[PATHS.pstackSkills];
  const missing = probeSetup({ env: {}, paths: PATHS, io: missingIo })
    .items.find((item) => item.id === 'pstackSkills');
  assert.equal(missing.verdict, VERDICT.missing);
  assert.equal(missing.count, null);
  assert.equal(missing.empty, false);
});

test('matt 只数「分类/技能」两级，deprecated 整组跳过', () => {
  const io = defaultIo();
  assert.equal(countSkillDirs(io, PATHS.mattSkills, 'nested'), 2);
  assert.equal(countSkillDirs(io, PATHS.pstackSkills, 'flat'), 0);
  assert.equal(countSkillDirs(io, '', 'flat'), 0);
});

// ── 建议写入清单 ────────────────────────────────────────────────────

test('建议清单只含会写盘的项：需新建的目录 + 可用的探测路径', () => {
  const probe = probeSetup({ env: {}, paths: PATHS, io: defaultIo() });
  const plan = planSetupWrites({ probe, config: {}, probed: {} });
  assert.deepEqual(plan.entries.map((entry) => entry.id),
    ['codexSessions', 'exportRoot', 'pstackSkills', 'mattSkills']);
  // 每个条目至少一处写入，且写到哪里说得清。
  for (const entry of plan.entries) {
    assert.ok(entry.writes.length > 0);
    assert.ok(String(entry.writeTo).length > 0);
  }
  const flat = plan.entries.flatMap((entry) => entry.writes);
  assert.deepEqual(flat.filter((write) => write.kind === 'mkdir').map((write) => write.path),
    [PATHS.exportRoot]);
  assert.equal(plan.mkdirCount, 1);
  assert.equal(plan.configCount, 4);
  // 缺失的外部目录与密钥不写盘：清单里没有它们。
  assert.ok(!plan.entries.some((entry) => ['opencodeData', 'modelKey'].includes(entry.id)));
  assert.equal(plan.skipped.length, 0);
});

test('配置里已有同一个值时不重复写：清单只留真正的变化', () => {
  const probe = probeSetup({ env: {}, paths: PATHS, io: defaultIo() });
  const plan = planSetupWrites({
    probe,
    config: {
      codexSessions: PATHS.codexSessions,
      pstackSkills: PATHS.pstackSkills,
      mattSkills: PATHS.mattSkills
    },
    probed: {
      codexSessions: PATHS.codexSessions,
      pstackSkills: PATHS.pstackSkills,
      mattSkills: PATHS.mattSkills
    }
  });
  assert.deepEqual(plan.entries.map((entry) => entry.id), ['exportRoot']);
  assert.equal(plan.configCount, 1);
});

test('重新探测会更新探测类字段：环境变了，旧探测值不算手改', () => {
  const config = { codexSessions: 'C:/old/sessions' };
  const probed = { codexSessions: 'C:/old/sessions' };
  const io = makeIo({ stats: { 'C:/new/sessions': stat({ writable: false }) } });
  const probe = probeSetup({
    env: {}, paths: { ...PATHS, codexSessions: 'C:/new/sessions' }, io, config, probed
  });
  const codex = probe.items.find((item) => item.id === 'codexSessions');
  assert.equal(codex.source, 'probe');
  assert.equal(codex.value, 'C:/new/sessions');
  const plan = planSetupWrites({ probe, config, probed });
  const entry = plan.entries.find((item) => item.id === 'codexSessions');
  assert.ok(entry?.writes.some((write) => write.kind === 'config'
    && write.value === 'C:/new/sessions'));
});

// ── 手改优先 ────────────────────────────────────────────────────────

test('来源判定：空值 / 等于上次探测 = 探测，其余 = 手改', () => {
  assert.equal(setupValueSource({ key: 'exportRoot', config: {}, probed: {} }), 'probe');
  assert.equal(setupValueSource({
    key: 'exportRoot', config: { exportRoot: 'C:/probe' }, probed: { exportRoot: 'C:/probe' }
  }), 'probe');
  assert.equal(setupValueSource({
    key: 'exportRoot', config: { exportRoot: 'C:/mine' }, probed: { exportRoot: 'C:/probe' }
  }), 'manual');
});

test('重新探测不覆盖手改：值保留，清单跳过，目录也不代建', async () => {
  const config = { exportRoot: 'C:/my-own-exports' };
  const probed = { exportRoot: PATHS.exportRoot };
  const io = defaultIo();
  const probe = probeSetup({ env: {}, paths: PATHS, io, config, probed });
  const exportRoot = probe.items.find((item) => item.id === 'exportRoot');
  assert.equal(exportRoot.source, 'manual');
  assert.equal(exportRoot.value, 'C:/my-own-exports');
  assert.match(exportRoot.detail, /手改值保留/u);

  const plan = planSetupWrites({ probe, config, probed });
  assert.ok(!plan.entries.some((entry) => entry.id === 'exportRoot'));
  const skip = plan.skipped.find((item) => item.itemId === 'exportRoot');
  assert.equal(skip.value, 'C:/my-own-exports');
  assert.match(skip.reason, /手改值保留/u);

  const result = await applySetup({ plan, config, probed, confirm: true, mkdir: io.mkdir });
  assert.equal(result.ok, true);
  assert.ok(!('exportRoot' in result.patch));
  // 手改的目录不会被代建。
  assert.equal(io.state.stats['C:/my-own-exports'], undefined);
});

// ── 取消：零写入 ────────────────────────────────────────────────────

test('取消不调用 mkdir、不产生补丁，回执写明 0 处', async () => {
  const probe = probeSetup({ env: {}, paths: PATHS, io: defaultIo() });
  const plan = planSetupWrites({ probe, config: {}, probed: {} });
  let created = 0;
  const result = await applySetup({
    plan,
    config: {},
    probed: {},
    confirm: false,
    mkdir: async () => { created += 1; }
  });
  assert.equal(created, 0);
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.written, []);
  assert.deepEqual(result.patch, {});
  assert.match(result.receipt.text, /一个都没做/u);
  assert.ok(result.receipt.blocks[0].rows.some((row) => row.join('').includes('未写入（0 处）')));
});

test('取消回执逐条列出被取消的写入（不合并、不省略）', () => {
  const probe = probeSetup({ env: {}, paths: PATHS, io: defaultIo() });
  const plan = planSetupWrites({ probe, config: {}, probed: {} });
  const receipt = setupCancelReceipt({ plan, at: '2026-11-26T00:00:00.000Z' });
  const rows = receipt.blocks[0].rows;
  const total = plan.entries.reduce((sum, entry) => sum + entry.writes.length, 0);
  assert.match(receipt.text, new RegExp(`${total} 处写入`, 'u'));
  assert.ok(rows.some((row) => row[1] === PATHS.exportRoot));
  assert.ok(rows.some((row) => String(row[1]).includes('exportRoot =')));
});

// ── 一次确认覆盖多项 ────────────────────────────────────────────────

test('一次确认写入整张清单：多目录 + 多配置，回执逐条列出', async () => {
  const probe = probeSetup({ env: {}, paths: PATHS, io: defaultIo() });
  const plan = planSetupWrites({ probe, config: {}, probed: {} });
  const io = defaultIo();
  const result = await applySetup({
    plan, config: {}, probed: {}, confirm: true, mkdir: io.mkdir, at: '2026-11-26T00:00:00.000Z'
  });
  assert.equal(result.ok, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.written.length, plan.totalWrites);
  assert.deepEqual(result.patch, {
    codexSessions: PATHS.codexSessions,
    exportRoot: PATHS.exportRoot,
    pstackSkills: PATHS.pstackSkills,
    mattSkills: PATHS.mattSkills
  });
  assert.equal(io.state.stats[PATHS.exportRoot]?.exists, true);
  assert.deepEqual(result.probed, result.patch);
  assert.match(result.receipt.text, /新建 1 个目录/u);
  assert.match(result.receipt.text, /写入 4 项配置/u);
  const rows = result.receipt.blocks[0].rows;
  assert.ok(rows.some((row) => row[0] === '新建目录' && row[1] === PATHS.exportRoot));
  assert.ok(rows.some((row) => row[0] === '配置' && row[1] === `exportRoot = ${PATHS.exportRoot}`));
});

test('写入失败不伪装成成功：回执带原因，已写的项照实列出', async () => {
  const probe = probeSetup({ env: {}, paths: PATHS, io: defaultIo() });
  const plan = planSetupWrites({ probe, config: {}, probed: {} });
  const result = await applySetup({
    plan,
    config: {},
    probed: {},
    confirm: true,
    mkdir: async () => { throw new Error('磁盘只读'); }
  });
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, false);
  assert.match(result.receipt.text, /没有完成/u);
  assert.ok(result.receipt.blocks[0].rows.some((row) => row[0] === '原因' && row[1].includes('磁盘只读')));
});

// ── 探测后重探：值变成探测类，清单收敛 ─────────────────────────────

test('写入后重探：配置值算探测类，清单不再重复写', async () => {
  const io = defaultIo();
  const first = probeSetup({ env: {}, paths: PATHS, io, config: {}, probed: {} });
  const plan = planSetupWrites({ probe: first, config: {}, probed: {} });
  const applied = await applySetup({ plan, config: {}, probed: {}, confirm: true, mkdir: io.mkdir });
  const config = { ...applied.patch };
  const probed = { ...applied.probed };

  const again = probeSetup({ env: {}, paths: PATHS, io, config, probed });
  for (const id of ['exportRoot', 'pstackSkills', 'mattSkills']) {
    const item = again.items.find((entry) => entry.id === id);
    assert.equal(item.source, 'probe', `${id} 应仍是探测`);
    assert.equal(item.manual, false);
  }
  // 导出根已经建出来：判定从「需新建」变成「可用」。
  assert.equal(again.items.find((item) => item.id === 'exportRoot').verdict, VERDICT.ok);
  const next = planSetupWrites({ probe: again, config, probed });
  assert.deepEqual(next.entries, []);
  assert.equal(next.totalWrites, 0);
});

test('SETUP_PATH_KEYS 与六类探测项的配置键一致', () => {
  const probe = probeSetup({ env: {}, paths: PATHS, io: defaultIo() });
  const keys = probe.items.map((item) => item.configKey).filter(Boolean);
  assert.deepEqual([...SETUP_PATH_KEYS].sort(), keys.sort());
});

test('回执是普通回复形状：text + kv 块，键值行是两元组', () => {
  const receipt = setupReceipt({
    plan: { entries: [] },
    written: [{ kind: 'config', key: 'exportRoot', value: 'C:/app/exports' }],
    skipped: [{ label: 'matt 技能目录', reason: '手改值保留，不覆盖' }],
    at: '2026-11-26T00:00:00.000Z'
  });
  assert.equal(typeof receipt.text, 'string');
  assert.equal(receipt.blocks[0].type, 'kv');
  for (const row of receipt.blocks[0].rows) {
    assert.equal(row.length, 2);
    assert.equal(typeof row[0], 'string');
  }
  assert.ok(receipt.blocks[0].rows.some((row) => row[0] === '跳过'));
});
