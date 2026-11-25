// #67 操作区视图模型：给定待办、非终态执行、提炼提议三份数据，输出两段与三段块的固定顺序。
// 只断言模型，不断言 DOM；也不碰 Electron 与真实库。
import test from 'node:test';
import assert from 'node:assert/strict';
import { focusOpsView } from '../src/focus-ops.mjs';

const BLOCK_KEYS = ['pending', 'running', 'proposing'];
const BLOCK_TITLES = ['待办', '运行中', '待提炼'];
const ZONE_KEYS = ['decide', 'know'];
const ZONE_TITLES = ['需要决定', '需要知道'];

// 待办条目按快照里的形状给（toPending 的产物）：分组与排序已由上游决定，模型原样接收。
const pendingItem = ({ id, projectId = 'alpha', projectName = `${projectId} 项目` }) => ({
  kind: 'job',
  id,
  hash: '',
  title: `批准 ${id}`,
  summary: '等你批准后才会开始',
  tier: 'write',
  projectId,
  projectName
});

const execution = ({ id, kind = 'job', status = 'running', projectId = 'alpha', title = '' }) => ({
  id,
  kind,
  status,
  projectId,
  title: title || `执行 ${id}`,
  updated_at: '2026-11-25T00:00:00.000Z'
});

const proposal = ({ projectId = 'alpha', count = 3, projectName = '' }) => ({ projectId, count, projectName });

const blocksByKey = (view) => Object.fromEntries(view.blocks.map((block) => [block.key, block]));
const sectionsByKey = (view) => Object.fromEntries(view.sections.map((section) => [section.key, section]));
/** 两段展开后的块顺序：固定顺序的验收点。 */
const flattenedKeys = (view) => view.sections.flatMap((section) => section.blocks.map((block) => block.key));
const populatedKeys = (view) => view.blocks.filter((block) => !block.empty).map((block) => block.key);

test('三类都为空：明确空态，不产出占位条目', () => {
  const view = focusOpsView();
  assert.equal(view.empty, true);
  assert.equal(view.emptyText, '没有要你处理的事');
  // 三段块与两段都在，但不带任何条目：空的东西消失，只留标记与说明。
  assert.deepEqual(view.blocks.map((block) => block.key), BLOCK_KEYS);
  assert.deepEqual(view.sections.map((section) => section.key), ZONE_KEYS);
  for (const block of view.blocks) {
    assert.equal(block.empty, true);
    assert.deepEqual(block.items, []);
    assert.equal(block.count, 0);
    assert.deepEqual(block.counts, { project: 0, all: 0 });
    assert.ok(block.emptyHint);
  }
  for (const section of view.sections) {
    assert.equal(section.empty, true);
    assert.equal(section.count, 0);
    assert.ok(section.emptyHint);
  }
  assert.deepEqual(populatedKeys(view), []);
  // 空态不是「一类占位条目」：三段加起来条目数为 0。
  assert.equal(view.blocks.reduce((sum, block) => sum + block.items.length, 0), 0);
});

test('只有待办：运行中与提议不出现', () => {
  const view = focusOpsView({ pending: [pendingItem({ id: 'j1' }), pendingItem({ id: 'j2' })] });
  assert.deepEqual(populatedKeys(view), ['pending']);
  assert.equal(blocksByKey(view).pending.count, 2);
  assert.equal(blocksByKey(view).running.empty, true);
  assert.equal(blocksByKey(view).proposing.empty, true);
  assert.deepEqual(blocksByKey(view).running.items, []);
  assert.deepEqual(blocksByKey(view).proposing.items, []);
  assert.equal(sectionsByKey(view).decide.empty, false);
  assert.equal(sectionsByKey(view).know.empty, true);
  assert.equal(view.empty, false);
  assert.equal(view.emptyText, '');
});

test('只有运行中：待办与提议不出现', () => {
  const view = focusOpsView({ executions: [execution({ id: 'r1' })] });
  assert.deepEqual(populatedKeys(view), ['running']);
  assert.deepEqual(blocksByKey(view).running.items.map((item) => item.id), ['r1']);
  assert.equal(blocksByKey(view).pending.empty, true);
  assert.equal(blocksByKey(view).proposing.empty, true);
  // 运行中归「需要知道」：这一段有内容，另一段为空。
  assert.equal(sectionsByKey(view).know.empty, false);
  assert.equal(sectionsByKey(view).decide.empty, true);
});

test('只有提议：待办与运行中不出现，条目带「已积 N 条」', () => {
  const view = focusOpsView({ proposals: [proposal({ projectId: 'alpha', count: 5 })] });
  assert.deepEqual(populatedKeys(view), ['proposing']);
  const [item] = blocksByKey(view).proposing.items;
  assert.equal(item.projectId, 'alpha');
  assert.equal(item.count, 5);
  assert.match(item.title, /已积 5 条未提炼/u);
  // 0 条的提议不是提议：阈值判定在 on-demand.mjs，模型不自己造信号。
  const quiet = focusOpsView({ proposals: [proposal({ projectId: 'alpha', count: 0 })] });
  assert.deepEqual(quiet.blocks.map((block) => block.key), BLOCK_KEYS);
  assert.deepEqual(populatedKeys(quiet), []);
  assert.equal(quiet.empty, true);
});

test('三类都有：顺序固定为 待办 → 运行中 → 提议', () => {
  const view = focusOpsView({
    pending: [pendingItem({ id: 'j1' })],
    executions: [execution({ id: 'r1' })],
    proposals: [proposal({ projectId: 'alpha', count: 3 })]
  });
  assert.deepEqual(view.blocks.map((block) => block.key), BLOCK_KEYS);
  assert.deepEqual(view.blocks.map((block) => block.title), BLOCK_TITLES);
  // 两段按固定顺序展开后仍是同一顺序：段只分组，不重排。
  assert.deepEqual(view.sections.map((section) => section.key), ZONE_KEYS);
  assert.deepEqual(view.sections.map((section) => section.title), ZONE_TITLES);
  assert.deepEqual(flattenedKeys(view), BLOCK_KEYS);
  assert.deepEqual(populatedKeys(view), BLOCK_KEYS);
  // 两段持有的是同一批块对象，不会出现两套文案。
  assert.equal(sectionsByKey(view).decide.blocks[0], blocksByKey(view).pending);
  assert.equal(sectionsByKey(view).know.blocks[1], blocksByKey(view).proposing);
  assert.equal(view.empty, false);
});

test('计数与条目数一致，两个口径各自正确', () => {
  const view = focusOpsView({
    projectId: 'alpha',
    pending: [
      pendingItem({ id: 'a1', projectId: 'alpha' }),
      pendingItem({ id: 'a2', projectId: 'alpha' }),
      pendingItem({ id: 'b1', projectId: 'beta' })
    ],
    executions: [
      execution({ id: 'r1', projectId: 'alpha' }),
      execution({ id: 'r2', projectId: 'beta' })
    ],
    proposals: [proposal({ projectId: 'alpha', count: 3 }), proposal({ projectId: 'beta', count: 4 })]
  });
  const pending = blocksByKey(view).pending;
  assert.equal(pending.count, 3);
  assert.equal(pending.items.length, 3);
  assert.deepEqual(pending.counts, { project: 2, all: 3 });
  const running = blocksByKey(view).running;
  assert.equal(running.count, 2);
  assert.deepEqual(running.counts, { project: 1, all: 2 });
  const proposing = blocksByKey(view).proposing;
  assert.equal(proposing.count, 2);
  assert.deepEqual(proposing.counts, { project: 1, all: 2 });
  // 两段各自求和，不是把三段拼成一个数。
  assert.deepEqual(sectionsByKey(view).decide.counts, { project: 2, all: 3 });
  assert.deepEqual(sectionsByKey(view).know.counts, { project: 2, all: 4 });
  assert.equal(view.filter.projectId, 'alpha');

  // 没选项目时「当前项目」就是「全部项目」，两个口径相等而不是报 0。
  const all = focusOpsView({ pending: [pendingItem({ id: 'a1' }), pendingItem({ id: 'b1', projectId: 'beta' })] });
  assert.deepEqual(blocksByKey(all).pending.counts, { project: 2, all: 2 });
  assert.equal(all.filter.projectId, '');
});

test('终态执行不进操作区，卡住的非终态照常进', () => {
  const view = focusOpsView({
    executions: [
      execution({ id: 'done-job', kind: 'job', status: 'succeeded' }),
      execution({ id: 'applied-patch', kind: 'patch', status: 'applied' }),
      execution({ id: 'done-run', kind: 'sandbox', status: 'completed' }),
      execution({ id: 'passed-cycle', kind: 'cycle', status: 'tested_pass' }),
      execution({ id: 'rejected-run', kind: 'sandbox', status: 'rejected' })
    ]
  });
  assert.equal(blocksByKey(view).running.empty, true);
  assert.equal(view.empty, true);

  const stuck = focusOpsView({
    executions: [
      execution({ id: 'stuck', kind: 'job', status: 'needs_reconciliation' }),
      execution({ id: 'applying', kind: 'patch', status: 'applying' }),
      execution({ id: 'cycle-applied', kind: 'cycle', status: 'applied' }),
      execution({ id: 'provisioning', kind: 'run', status: 'provisioning' })
    ]
  });
  // 补丁的 applying / 修复周期的 applied 不是终态：还在场内。
  assert.deepEqual(blocksByKey(stuck).running.items.map((item) => item.id), ['stuck', 'applying', 'cycle-applied', 'provisioning']);
  assert.deepEqual(blocksByKey(stuck).running.items.map((item) => item.kind), ['job', 'patch', 'cycle', 'sandbox']);
  // 模型把相位交给面板：卡住与运行中在数据上就已经分开，不靠面板猜状态。
  assert.deepEqual(
    blocksByKey(stuck).running.items.map((item) => item.phase),
    ['stuck', 'running', 'running', 'running']
  );
});

test('运行中的相位：排队 / 执行中 / 停止中 各有值，detail 原样带出', () => {
  const view = focusOpsView({
    executions: [
      { id: 'q1', kind: 'job', status: 'queued' },
      { id: 'r1', kind: 'job', status: 'running', detail: 'code-patch' },
      { id: 's1', kind: 'job', status: 'cancel_requested' },
      { id: 'k1', kind: 'sandbox', status: 'needs_reconciliation' }
    ]
  });
  const items = blocksByKey(view).running.items;
  assert.deepEqual(items.map((item) => item.phase), ['queued', 'running', 'stopping', 'stuck']);
  assert.equal(items[1].detail, 'code-patch');
  assert.equal(items[0].detail, '');
});

test('租约过期的执行在操作区模型里也归到卡住', () => {
  const now = Date.parse('2026-11-25T01:00:00.000Z');
  const view = focusOpsView({
    now,
    executions: [
      {
        id: 'lease-expired', kind: 'job', status: 'running',
        leaseUntil: '2026-11-25T00:30:00.000Z'
      },
      {
        id: 'lease-ok', kind: 'job', status: 'running',
        lease_until: '2026-11-25T01:10:00.000Z'
      }
    ]
  });
  const items = blocksByKey(view).running.items;
  assert.deepEqual(items.map((item) => item.id), ['lease-expired', 'lease-ok']);
  assert.deepEqual(items.map((item) => item.phase), ['stuck', 'running']);
});

test('等你批准的执行不算运行中：不会在待办之外再画一遍', () => {
  const view = focusOpsView({
    executions: [
      execution({ id: 'job-wait', kind: 'job', status: 'pending_approval' }),
      execution({ id: 'patch-proposed', kind: 'patch', status: 'proposed' }),
      execution({ id: 'patch-approved', kind: 'patch', status: 'approved' }),
      execution({ id: 'run-wait', kind: 'sandbox', status: 'pending_approval' }),
      execution({ id: 'cycle-ready', kind: 'cycle', status: 'proposal_ready' })
    ]
  });
  assert.equal(blocksByKey(view).running.empty, true);
  // 同一批事在待办里只出现一次。
  const withPending = focusOpsView({
    pending: [pendingItem({ id: 'job-wait' })],
    executions: [execution({ id: 'job-wait', kind: 'job', status: 'pending_approval' })]
  });
  assert.deepEqual(withPending.blocks.flatMap((block) => block.items.map((item) => item.id)), ['job-wait']);
});

test('不重排也不改写输入：待办与执行的顺序原样保留', () => {
  const pending = [pendingItem({ id: 'p2' }), pendingItem({ id: 'p1' })];
  const executions = [
    execution({ id: 'r3', status: 'queued' }),
    execution({ id: 'r1', status: 'running' }),
    execution({ id: 'r2', status: 'needs_reconciliation' })
  ];
  const view = focusOpsView({ pending, executions });
  assert.deepEqual(blocksByKey(view).pending.items.map((item) => item.id), ['p2', 'p1']);
  assert.deepEqual(blocksByKey(view).running.items.map((item) => item.id), ['r3', 'r1', 'r2']);
  // 输入数组未被排序或增删。
  assert.deepEqual(pending.map((item) => item.id), ['p2', 'p1']);
  assert.deepEqual(executions.map((item) => item.id), ['r3', 'r1', 'r2']);
});

test('缺字段与异常输入：不猜状态，缺项目 id 仍能分组计数', () => {
  const view = focusOpsView({
    projectId: '',
    pending: [null, { id: 'no-project' }],
    executions: [
      { id: 'no-status', kind: 'job' },
      { id: 'no-project-run', kind: 'sandbox', status: 'running' },
      'not-an-object'
    ],
    proposals: [null, { count: 2 }]
  });
  // 没有状态的一律不猜；缺 projectId 的待办与执行仍进各自的块，落在空项目下。
  assert.deepEqual(blocksByKey(view).running.items.map((item) => item.id), ['no-project-run']);
  assert.equal(blocksByKey(view).running.items[0].projectId, '');
  assert.deepEqual(blocksByKey(view).pending.items.map((item) => item.id), ['no-project']);
  assert.equal(blocksByKey(view).pending.items[0].projectId, '');
  assert.equal(blocksByKey(view).proposing.items[0].id, 'distill:');
  assert.equal(blocksByKey(view).proposing.items[0].count, 2);

  for (const input of [undefined, null, {}, { pending: null, executions: 'x', proposals: 1 }]) {
    const empty = focusOpsView(input);
    assert.equal(empty.empty, true);
    assert.deepEqual(empty.blocks.map((block) => block.key), BLOCK_KEYS);
  }
});
