// #121 壳骨架拆分：三块界面各自的纯函数 / 状态迁移。
//
// 界面本身（DOM、事件、真实窗口）仍由 8 条 desktop-* e2e 验收；这里只锁「搬出来以后
// 边界上的判定没有走样」：顶栏的项目范围归一化、输入区的占位文案、对话流的空态与导出头。
// 纯搬运的渲染代码不在这里重复断言（理由见任务报告）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
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
