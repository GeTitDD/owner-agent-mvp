// #127 配置箱：分区数据结构、来源标注的合并规则、密钥只报状态、保存补丁的形状。
// 界面层（齿轮入口、覆盖层、七段可滚动、保存 / 取消、截图）交给
// scripts/e2e/desktop-config-box.mjs 走真实窗口。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SECRET_LABELS,
  SECTIONS,
  SOURCE,
  SOURCE_LABELS,
  buildRows,
  displayOf,
  editableRows,
  patchForSave,
  resolveSource,
  rowById,
  secretStateOf
} from '../src/config-box.mjs';

const FACTS = Object.freeze({
  paths: {
    userData: 'C:/Users/owner/AppData/Roaming/owner-agent-mvp',
    config: 'C:/Users/owner/AppData/Roaming/owner-agent-mvp/companion.json',
    knowledge: 'C:/Users/owner/.domain-context/index.sqlite',
    watch: 'C:/Users/owner/.owner-agent/watch',
    skills: 'C:/Users/owner/.owner-agent/skills/matt'
  },
  secrets: {
    OWNER_OBSERVER_FEISHU_WEBHOOK: { present: true, origin: 'feishu.json' },
    // 故意多带一个 value 字段：配置箱不该把它带进渲染层。
    OWNER_AGENT_APPROVAL_TOKEN: { present: true, origin: '环境变量', value: 'tok-must-not-leak' },
    OWNER_AGENT_SIDECAR_TOKEN: { present: false, origin: '' }
  },
  sync: { present: true, source: 'GH_TOKEN' },
  sources: { model: 'manual', chatSkills: 'manual' }
});

// ── 分区结构 ────────────────────────────────────────────────────────

test('七个分区齐全，顺序照 issue #127', () => {
  assert.deepEqual(SECTIONS.map((section) => section.id),
    ['model', 'paths', 'share', 'skills', 'write', 'watch', 'sync']);
  assert.deepEqual(SECTIONS.map((section) => section.label),
    ['模型接口', '目录', '分享', '技能', '写入范围', '监控', '同步']);
});

test('每行都有标签与一句后果；后果只有一句、不留空', () => {
  for (const section of SECTIONS) {
    assert.ok(section.rows.length > 0, `${section.id} 没有行`);
    for (const row of section.rows) {
      assert.ok(row.label.trim().length > 0, `${section.id}/${row.id} 缺标签`);
      assert.ok(row.effect.trim().length > 0, `${section.id}/${row.id} 缺后果`);
      // 「一句后果」：不允许换行堆成两句。
      assert.ok(!row.effect.includes('\n'), `${section.id}/${row.id} 的后果不止一行`);
    }
  }
});

test('可写行都有配置键，只读行与密钥行都没有', () => {
  for (const section of SECTIONS) {
    for (const row of section.rows) {
      if (row.kind === 'text' || row.kind === 'list') {
        assert.ok(row.key, `${row.id} 是可写行却没有配置键`);
      } else {
        assert.equal(row.key, undefined, `${row.id} 是只读/密钥行，不该带配置键`);
      }
      if (row.kind === 'secret') assert.ok(row.env || row.credential, `${row.id} 没写来源`);
    }
  }
});

test('可写行只有五个：主模型 / 图谱模型 / 网关 / 快照包含 / 隐式技能', () => {
  assert.deepEqual(editableRows().map((row) => row.id),
    ['model', 'diagramModel', 'gatewayUrl', 'includePaths', 'chatSkills']);
});

// ── 来源标注：探测 vs 手改 ─────────────────────────────────────────

test('可写行按注入的 sources 标来源：默认探测，manual 才手改', () => {
  assert.equal(rowById('model').kind, 'text');
  assert.equal(resolveSource(rowById('model'), FACTS), SOURCE.manual);
  assert.equal(resolveSource(rowById('diagramModel'), FACTS), SOURCE.probe);
  // 没有 sources 字段时一律按「探测」，不猜。
  assert.equal(resolveSource(rowById('model'), {}), SOURCE.probe);
  // 认不出的值也按「探测」。
  assert.equal(resolveSource(rowById('model'), { sources: { model: 'weird' } }), SOURCE.probe);
});

test('只读行与密钥行永远是探测，即使 sources 说手改也不跟着变', () => {
  const facts = { sources: { userData: 'manual', approvalToken: 'manual', allowedPaths: 'manual' } };
  assert.equal(resolveSource(rowById('userData'), facts), SOURCE.probe);
  assert.equal(resolveSource(rowById('approvalToken'), facts), SOURCE.probe);
});

test('合并规则：同一项既有探测又有人改过，显示手改（以配置文件为准）', () => {
  const rows = buildRows({ values: { model: 'deepseek-v4.1-flash' }, facts: FACTS });
  const model = rows.find((row) => row.id === 'model');
  const gateway = rows.find((row) => row.id === 'gatewayUrl');
  assert.equal(model.source, 'manual');
  assert.equal(model.sourceLabel, SOURCE_LABELS.manual);
  assert.equal(gateway.source, 'probe');
  assert.equal(gateway.sourceLabel, SOURCE_LABELS.probe);
});

// ── 密钥：只报来源与状态 ──────────────────────────────────────────

test('密钥只给环境变量名与状态，值一个字段都不带', () => {
  const approval = secretStateOf(rowById('approvalToken'), FACTS);
  assert.equal(approval.present, true);
  assert.equal(approval.label, SECRET_LABELS.present);
  assert.equal(approval.envText, '环境变量 OWNER_AGENT_APPROVAL_TOKEN');
  assert.equal(approval.origin, '环境变量');
  // 注入里带的 value 不会被搬进状态对象。
  assert.ok(!('value' in approval));
  assert.ok(!JSON.stringify(approval).includes('tok-must-not-leak'));

  const sidecar = secretStateOf(rowById('sidecarToken'), FACTS);
  assert.equal(sidecar.present, false);
  assert.equal(sidecar.label, SECRET_LABELS.missing);
});

test('飞书 webhook 从配置文件读到时写明来源是 feishu.json', () => {
  const feishu = secretStateOf(rowById('feishuWebhook'), FACTS);
  assert.equal(feishu.present, true);
  assert.equal(feishu.origin, 'feishu.json');
  assert.equal(feishu.envText, '环境变量 OWNER_OBSERVER_FEISHU_WEBHOOK');
});

test('同步令牌沿用 #130 的口径：报命中的变量名，不报值', () => {
  const sync = secretStateOf(rowById('syncCredential'), FACTS);
  assert.equal(sync.present, true);
  assert.equal(sync.envText, '环境变量 GH_TOKEN');
  const missing = secretStateOf(rowById('syncCredential'), { sync: { present: false, source: '' } });
  assert.equal(missing.label, SECRET_LABELS.missing);
  assert.equal(missing.envText, '环境变量 GITHUB_TOKEN / GH_TOKEN');
});

// ── 值：可写行给值，只读行给事实或写死的文案 ─────────────────────

test('列表类配置在输入框里是逗号分隔，读回来还能拆开', () => {
  const row = rowById('chatSkills');
  assert.equal(displayOf(row, { chatSkills: ['plan', 'tdd'] }), 'plan, tdd');
  assert.equal(displayOf(row, { chatSkills: [] }), '');
});

test('只读行先看注入的事实，没有事实就用写死的文案', () => {
  assert.equal(displayOf(rowById('configFile'), {}, FACTS), FACTS.paths.config);
  assert.equal(displayOf(rowById('configFile'), {}, {}), '—');
  assert.equal(displayOf(rowById('skillCap'), {}, FACTS), '12 个');
});

test('buildRows 的 24 行都挂对分区，输入框只给可写行', () => {
  const rows = buildRows({ values: {}, facts: FACTS });
  assert.equal(rows.length, 24);
  for (const row of rows) {
    assert.ok(SECTIONS.some((section) => section.id === row.section), `${row.id} 分区不认识`);
    if (row.kind === 'text' || row.kind === 'list') assert.equal(row.input, true, `${row.id} 应有输入框`);
    else assert.equal(row.input, false, `${row.id} 不该有输入框`);
    assert.ok([SOURCE.probe, SOURCE.manual].includes(row.source));
  }
  // 密钥行全都没有输入框；只读行也没有。
  const secretRows = rows.filter((row) => row.kind === 'secret');
  assert.equal(secretRows.length, 4);
  assert.ok(secretRows.every((row) => row.input === false));
});

// ── 保存补丁 ─────────────────────────────────────────────────────

test('保存补丁只收可写行，列表类拆成数组，文本类去首尾空白', () => {
  const patch = patchForSave({
    model: '  deepseek-v4.1-flash  ',
    includePaths: 'package.json，README.md; docs/*.md',
    chatSkills: 'plan\n tdd ',
    diagramModel: '',
    // 只读行与密钥行即使被塞进来也要丢掉。
    userData: 'C:/evil',
    approvalToken: 'tok'
  });
  assert.deepEqual(patch, {
    model: 'deepseek-v4.1-flash',
    diagramModel: '',
    includePaths: ['package.json', 'README.md', 'docs/*.md'],
    chatSkills: ['plan', 'tdd']
  });
});

test('草稿里没有的行不进补丁：保存不会顺手把别的项写一遍', () => {
  assert.deepEqual(patchForSave({ model: 'x' }), { model: 'x' });
  assert.deepEqual(patchForSave({}), {});
});
