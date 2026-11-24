// #70 执行状态的唯一判定 + 跨项目在场执行列表。
// 只断言纯函数；不碰 Electron、不读库。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TERMINAL,
  WAITING_APPROVAL,
  executionPhase,
  isInFlight,
  isTerminal,
  isWaitingApproval,
  listInFlightExecutions
} from '../src/execution-status.mjs';

test('终态按主体分表：四种主体各自认自己的结束状态', () => {
  for (const status of ['succeeded', 'failed', 'cancelled', 'rejected']) {
    assert.equal(isTerminal('job', status), true, `job ${status}`);
  }
  for (const status of ['applied', 'rejected', 'apply_failed']) {
    assert.equal(isTerminal('patch', status), true, `patch ${status}`);
  }
  for (const status of ['completed', 'failed', 'cancelled', 'rejected']) {
    assert.equal(isTerminal('sandbox', status), true, `sandbox ${status}`);
  }
  for (const status of ['tested_pass', 'tested_fail', 'failed', 'cancelled', 'rejected']) {
    assert.equal(isTerminal('cycle', status), true, `cycle ${status}`);
  }
  // 非终态的典型值：还在场内。
  assert.equal(isTerminal('job', 'running'), false);
  assert.equal(isTerminal('sandbox', 'needs_reconciliation'), false);
  // 未知主体退回并集：不认识的 kind 也要能挡住明显结束的状态。
  assert.equal(isTerminal('unknown', 'succeeded'), true);
  assert.equal(isTerminal('job', ''), false);
  // 大小写与空白不改变判定。
  assert.equal(isTerminal('job', 'SUCCEEDED'), true);
});

test('审批态属于待办，不属于运行中', () => {
  assert.equal(isWaitingApproval('job', 'pending_approval'), true);
  assert.equal(isWaitingApproval('patch', 'proposed'), true);
  assert.equal(isWaitingApproval('patch', 'approved'), true);
  assert.equal(isWaitingApproval('sandbox', 'pending_approval'), true);
  assert.equal(isWaitingApproval('cycle', 'proposal_ready'), true);
  assert.equal(isWaitingApproval('cycle', 'test_pending'), false);
  assert.equal(isWaitingApproval('job', 'queued'), false);
});

test('在场判定：终态、审批态、无状态都不算在场', () => {
  assert.equal(isInFlight('job', 'queued'), true);
  assert.equal(isInFlight('job', 'running'), true);
  assert.equal(isInFlight('job', 'needs_reconciliation'), true);
  assert.equal(isInFlight('job', 'pending_approval'), false);
  assert.equal(isInFlight('patch', 'approved'), false);
  assert.equal(isInFlight('sandbox', 'completed'), false);
  assert.equal(isInFlight('job', ''), false);
  assert.equal(isInFlight('job', undefined), false);
});

test('相位：卡住与运行中分开，排队与停止中各有名字', () => {
  assert.equal(executionPhase('job', 'needs_reconciliation'), 'stuck');
  assert.equal(executionPhase('patch', 'needs_reconciliation'), 'stuck');
  assert.equal(executionPhase('job', 'running'), 'running');
  assert.equal(executionPhase('sandbox', 'provisioning'), 'running');
  assert.equal(executionPhase('cycle', 'test_pending'), 'running');
  assert.equal(executionPhase('job', 'cancel_requested'), 'stopping');
  assert.equal(executionPhase('job', 'queued'), 'queued');
  // 不在场的不该有相位，调用方不该渲染。
  assert.equal(executionPhase('job', 'succeeded'), '');
  assert.equal(executionPhase('job', 'pending_approval'), '');
});

test('跨项目在场列表：滤掉终态与审批态，补齐项目名与相位', () => {
  const names = new Map([['alpha', 'Alpha 项目'], ['beta', 'Beta 项目']]);
  const items = listInFlightExecutions({
    jobs: [
      { id: 'job-run', project_id: 'alpha', title: '生成补丁', job_type: 'code-patch', status: 'running', updated_at: '2026-11-25T01:00:00.000Z' },
      { id: 'job-done', project_id: 'alpha', title: '已完成', job_type: 'code-patch', status: 'succeeded', updated_at: '2026-11-25T02:00:00.000Z' },
      { id: 'job-wait', project_id: 'alpha', title: '等你批准', status: 'pending_approval' }
    ],
    patches: [
      { id: 'patch-1', project_id: 'beta', files: [{ path: 'src/retry.js' }], status: 'applying', updated_at: '2026-11-25T00:30:00.000Z' }
    ],
    sandboxes: [
      { id: 'run-1', project_id: 'beta', profile: { id: 'node-smoke' }, status: 'needs_reconciliation', updated_at: '2026-11-25T00:10:00.000Z' },
      { id: 'run-2', project_id: 'beta', profile: { id: 'node-smoke' }, status: 'completed', test_status: 'pass' }
    ],
    repairs: [
      { id: 'cycle-1', project_id: 'alpha', repairScope: ['src/retry.js'], status: 'queued', updated_at: '2026-11-25T00:50:00.000Z' }
    ]
  }, { projectNames: names });

  // 相位优先：卡住的排最前，其次是运行中 / 排队；终态与审批态一条都不出现。
  assert.deepEqual(items.map((item) => item.id), ['run-1', 'job-run', 'patch-1', 'cycle-1']);
  assert.deepEqual(items.map((item) => item.phase), ['stuck', 'running', 'running', 'queued']);
  assert.deepEqual(items.map((item) => item.kind), ['sandbox', 'job', 'patch', 'cycle']);
  assert.equal(items[0].projectName, 'Beta 项目');
  assert.equal(items[1].projectName, 'Alpha 项目');
  assert.equal(items[2].title, 'src/retry.js');
  assert.equal(items[3].detail, '有界修复');

  // 输入数组不被排序改写。
  assert.deepEqual(
    listInFlightExecutions({ jobs: [{ id: 'a', status: 'queued' }, { id: 'b', status: 'running' }] })
      .map((item) => item.id),
    ['b', 'a']
  );
});

test('租约过期也算卡住；未来租约或没有租约仍是运行中', () => {
  const now = Date.parse('2026-11-25T01:00:00.000Z');
  assert.equal(executionPhase('job', 'running', { leaseUntil: '2026-11-25T00:59:59.000Z', now }), 'stuck');
  assert.equal(executionPhase('job', 'leased', { leaseUntil: '2026-11-25T00:59:59.000Z', now }), 'stuck');
  assert.equal(executionPhase('job', 'running', { leaseUntil: '2026-11-25T01:00:01.000Z', now }), 'running');
  // 没有租约或时间戳读不出来时不猜，按「还活着」处理。
  assert.equal(executionPhase('job', 'running', { leaseUntil: '', now }), 'running');
  assert.equal(executionPhase('job', 'running', { leaseUntil: 'not-a-date', now }), 'running');
  // needs_reconciliation 不依赖租约：即使租约字段被清空也仍是卡住。
  assert.equal(executionPhase('job', 'needs_reconciliation', { leaseUntil: '', now }), 'stuck');
});

test('跨项目在场列表：租约过期的排到卡住一档，租约原样带出', () => {
  const now = Date.parse('2026-11-25T01:00:00.000Z');
  const items = listInFlightExecutions({
    jobs: [
      { id: 'alive', status: 'running', lease_until: '2026-11-25T01:05:00.000Z', updated_at: '2026-11-25T00:50:00.000Z' },
      { id: 'expired', status: 'running', lease_until: '2026-11-25T00:55:00.000Z', updated_at: '2026-11-25T00:40:00.000Z' }
    ]
  }, { now });
  assert.deepEqual(items.map((item) => item.id), ['expired', 'alive']);
  assert.equal(items[0].phase, 'stuck');
  assert.equal(items[0].leaseUntil, '2026-11-25T00:55:00.000Z');
  assert.equal(items[1].phase, 'running');
});

test('跨项目在场列表：同级按最近更新，limit 截断，缺字段不猜', () => {
  const items = listInFlightExecutions({
    jobs: [
      { id: 'old', status: 'running', updated_at: '2026-11-25T00:00:00.000Z' },
      { id: 'new', status: 'running', updated_at: '2026-11-25T03:00:00.000Z' },
      { id: 'no-status' },
      { id: 'no-id', status: 'queued' }
    ]
  }, { limit: 2 });
  assert.deepEqual(items.map((item) => item.id), ['new', 'old']);
  // 没项目名时仍能读，不抛错。
  assert.equal(items[0].projectName, '');
  // 默认上限覆盖四张表的取数窗口。
  assert.equal(listInFlightExecutions({}).length, 0);
});
