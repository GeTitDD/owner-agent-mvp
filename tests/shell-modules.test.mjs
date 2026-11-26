// #121 壳骨架拆分：三块界面各自的纯函数 / 状态迁移。
//
// 界面本身（DOM、事件、真实窗口）仍由 8 条 desktop-* e2e 验收；这里只锁「搬出来以后
// 边界上的判定没有走样」：顶栏的项目范围归一化、输入区的占位文案、对话流的空态与导出头。
// 纯搬运的渲染代码不在这里重复断言（理由见任务报告）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const header = require('../desktop/shell-header.cjs');
const compose = require('../desktop/shell-compose.cjs');
const stream = require('../desktop/shell-stream.cjs');

// ── 顶栏：正在看的项目要按「已登记项目」校验 ──────────────────────

test('knownScope 把已删除项目的旧视图退回全局', () => {
  const projects = [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }];
  assert.equal(header.knownScope(projects, 'beta'), 'beta');
  // 指向已删除项目的旧记录：退回全局，而不是把顶栏写成不存在的项目。
  assert.equal(header.knownScope(projects, 'gone'), '');
  // 空串就是全局，原样返回。
  assert.equal(header.knownScope(projects, ''), '');
  assert.equal(header.knownScope(projects, null), '');
});

test('knownScope 在项目表还没读到时保持原值', () => {
  // boot 先读项目再读会话；项目表为空时不否认证，避免把已登记项目误判成全局。
  assert.equal(header.knownScope([], 'alpha'), 'alpha');
  assert.equal(header.knownScope(undefined, 'alpha'), 'alpha');
});

test('knownScope 去掉首尾空白后再比对', () => {
  const projects = [{ id: 'alpha', name: 'Alpha' }];
  assert.equal(header.knownScope(projects, ' alpha '), 'alpha');
  assert.equal(header.knownScope(projects, '   '), '');
});

// ── 输入区：文案只由「能不能发 + 正在看的项目」决定 ────────────────

test('同步输入区：没有会话时锁死并给出去处', () => {
  const text = compose.composerPlaceholder({ open: false, viewProjectId: '' });
  assert.equal(text, '没有会话时不能发消息：先在顶栏新建一个会话。');
  // 没有会话时就算视图里还留着旧项目，也不该提示「能写」。
  assert.equal(
    compose.composerPlaceholder({ open: false, viewProjectId: 'alpha' }),
    '没有会话时不能发消息：先在顶栏新建一个会话。'
  );
});

test('同步输入区：全局模式说清只读，项目下只提示发送', () => {
  assert.equal(
    compose.composerPlaceholder({ open: true, viewProjectId: '' }),
    '全局模式：可以问所有项目的记忆（只读），先选项目再写。回车发送，/ 技能，@@ 方法'
  );
  assert.equal(
    compose.composerPlaceholder({ open: true, viewProjectId: 'alpha' }),
    '说点什么，/ 技能，@@ 方法。回车发送，Shift+回车换行'
  );
});

// ── 对话流：空态两种、导出头的项目与时间 ──────────────────────────

test('对话流空态分「没有会话」与「会话还没消息」两种', () => {
  const noSessionHint = '还没有会话。点顶栏的「会话」新建一个。';
  assert.equal(
    stream.emptyHint({ currentId: '', count: 0, noSessionHint }),
    noSessionHint
  );
  assert.equal(
    stream.emptyHint({ currentId: '', count: 3, noSessionHint }),
    noSessionHint
  );
  assert.equal(
    stream.emptyHint({ currentId: 's1', count: 0, noSessionHint }),
    '这个会话还没有消息，发第一句开始。'
  );
  assert.equal(stream.emptyHint({ currentId: 's1', count: 1, noSessionHint }), '');
});

test('导出上下文头：项目归属照实写，标题由调用方给', () => {
  assert.deepEqual(
    stream.sessionContext(
      { projectId: 'alpha', createdAt: '2026-01-02T03:04:05.000Z' },
      '今天的会话'
    ),
    {
      project: 'alpha',
      session: '今天的会话',
      time: '2026-01-02T03:04:05.000Z',
      model: '未接入（占位回复）'
    }
  );
  // 全局会话如实写「未选项目」；没有会话时标题是空串。
  assert.deepEqual(stream.sessionContext(null, ''), {
    project: '全局（未选项目）',
    session: '',
    time: '',
    model: '未接入（占位回复）'
  });
});

// ── #111 撤旧壳：启动页只有 shell.html，旧壳文件与开关都不在了 ──────────

test('启动只加载 shell.html：不认 OWNER_AGENT_SHELL / --shell，也没有旧面板兜底', () => {
  const main = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
  assert.match(main, /const SHELL_PAGE = 'shell\.html';/u);
  assert.match(main, /panel\.loadFile\(path\.join\(__dirname, SHELL_PAGE\)\);/u);
  for (const token of ['OWNER_AGENT_SHELL', "'--shell'", 'panelPage', "'panel.html'"]) {
    assert.equal(main.includes(token), false, `main.cjs 仍引用 ${token}`);
  }
  const html = fs.readFileSync(path.join(root, 'desktop/shell.html'), 'utf8');
  assert.equal(html.includes('panel.css'), false);
  assert.equal(html.includes('panel.js'), false);
  assert.equal(html.includes('panel.html'), false);
  // 旧壳三个文件已删除：不是靠开关绕开，而是没有可加载的旧页。
  for (const legacy of ['desktop/panel.html', 'desktop/panel.js', 'desktop/panel.css']) {
    assert.equal(fs.existsSync(path.join(root, legacy)), false, `${legacy} 应该已删除`);
  }
});

// ── #111 旧能力在新壳的最小入口：四条 `/` 命令与两条回复 ──────────────

test('#111 旧能力命令：项目库 / 变化 / 发布分两步 / 监控', () => {
  assert.deepEqual(compose.parseCapabilityCommand('/项目库'), { kind: 'library', confirm: false });
  assert.deepEqual(compose.parseCapabilityCommand('  /变化 '), { kind: 'since', confirm: false });
  assert.deepEqual(compose.parseCapabilityCommand('/监控'), { kind: 'monitor', confirm: false });
  // 发布必须先出草稿；只有命令里再写一次「确认」才真的发布。
  assert.deepEqual(compose.parseCapabilityCommand('/发布'), { kind: 'publish', confirm: false });
  assert.deepEqual(compose.parseCapabilityCommand('/发布 确认'), { kind: 'publish', confirm: true });
  // 认不出的输入不能被吃掉：照常当普通消息。
  assert.equal(compose.parseCapabilityCommand('/项目库 全部'), null);
  assert.equal(compose.parseCapabilityCommand('发布'), null);
});

test('#111 项目库回复：计数与三个来源分组都在块里', () => {
  const reply = compose.libraryReply({
    project: { id: 'alpha', name: 'Alpha' },
    counts: { total: 3, verified: 1, observing: 2, profile: 1, diagrams: 0 },
    groups: [
      { key: 'experiences', count: 1, kinds: ['lesson'] },
      { key: 'domainKnowledge', count: 1, kinds: ['knowledge'] },
      { key: 'contributedKnowledge', count: 1, kinds: ['knowledge'] }
    ]
  });
  assert.match(reply.text, /Alpha/u);
  assert.equal(reply.blocks[0].type, 'kv');
  assert.deepEqual(reply.blocks[0].rows[0], ['条目', '3 条']);
  assert.equal(reply.blocks[1].type, 'table');
  assert.deepEqual(reply.blocks[1].rows[0], ['experiences', '1 条', 'lesson']);
});

test('#111 变化窗口：首次查看不写成「没有变化」，算不全要带原因', () => {
  const first = compose.sinceReply({
    status: 'ok',
    empty: false,
    counts: { total: 0 },
    watermark: { known: false },
    blocks: [],
    previousAt: '',
    checkedAt: '2026-01-02T00:00:00.000Z'
  });
  assert.match(first.text, /首次查看/u);
  assert.equal(first.text.includes('没有新变化'), false);

  const unknown = compose.sinceReply({
    status: 'unknown',
    counts: { total: 1 },
    watermark: { known: true },
    blocks: [{ key: 'commits', title: '提交', items: [{ id: 'c1' }] }],
    unknownText: '观察员事件读不到',
    previousAt: '2026-01-01T00:00:00.000Z',
    checkedAt: '2026-01-02T00:00:00.000Z'
  });
  assert.match(unknown.text, /算不全/u);
  assert.ok(unknown.blocks.some((block) => block.type === 'kv' && block.rows[0][1].includes('读不到')));
  assert.ok(unknown.blocks.some((block) => block.type === 'table' && block.rows[0][0] === '提交'));
});

test('#111 发布回复：草稿要求再确认，发布后给版本与导出', () => {
  const draft = compose.publishReply({
    snapshot: { nextLabel: 'v3', draft: { generatedAt: '2026-01-02T00:00:00.000Z', counts: { total: 4 } } }
  });
  assert.match(draft.text, /\/发布 确认/u);
  assert.deepEqual(draft.blocks[0].rows[0], ['下一版', 'v3']);
  assert.deepEqual(draft.blocks[0].rows[3], ['确认', '/发布 确认']);

  const published = compose.publishReply({
    published: {
      version: 3,
      label: 'v3',
      publishedAt: '2026-01-02T00:00:00.000Z',
      export: { dir: 'D:/owner/exports/alpha/v3' },
      delivery: { status: 'sent', detail: '已发送飞书卡片' }
    }
  });
  assert.match(published.text, /v3/u);
  const rows = published.blocks[0].rows;
  assert.deepEqual(rows[0], ['版本', 'v3']);
  assert.deepEqual(rows[2], ['导出', 'D:/owner/exports/alpha/v3']);
  assert.deepEqual(rows[3], ['投递', '已发送飞书卡片']);
});
