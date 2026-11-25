// #119 定时整理：到点判定（纯函数）、把变更队列整理成候选、迟到补跑、失败可重试。
//
// 测的都是接缝：判定只看「当前时间 / 上次整理时间 / 计划时刻」，整理只看「队列进、候选出」。
// 时钟、定时器、提炼器全部注入——不测真实计时、不调模型、不写项目目录。
// 候选落在 personal_proposals 的 pending 上，正式知识条目一条都不该多出来（父 spec #102 第 14 条）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { CANDIDATE_CONTRACT } from '../src/knowledge-loop/contracts.mjs';
import { WatchStateStore, WATCH_DB_NAME } from '../src/watch/store.mjs';
import { nextTidyAt, parseTidySchedule, tidyDecision } from '../src/watch/tidy-schedule.mjs';
import { fallbackDistill, tidyQueue } from '../src/watch/tidy.mjs';
import { runTidy, startTidyScheduler } from '../src/watch/tidy-run.mjs';

const withTemp = async (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-tidy-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
};

/**
 * 本地日历时刻。计划时刻按本机时间算，测试也用本机构造，
 * 这样无论跑在哪个时区，断言比对的都是同一串 ISO 时间。
 */
const localAt = (day, hour, minute) => new Date(2026, 10, day, hour, minute, 0, 0);

const project = (projectId = 'alpha') => ({ type: 'project', projectId });

const T1 = '2026-11-20T10:30:00.000Z';
const T2 = '2026-11-20T10:40:00.000Z';

/** 往队列里放两条变更：一条新增、一条修改。 */
const queueOf = (store, target) => store.appendChanges(target, [
  { kind: 'added', ref: 'src/a.mjs', at: T1, detail: { label: 'aaaaaaaa 补上整理' } },
  { kind: 'modified', ref: 'src/b.mjs', at: T2, detail: { label: 'bbbbbbbb 改掉心跳' } }
]);

/** 假的提炼器：不读内容，只把队列条目拼成一条候选草稿。 */
const fakeDistill = ({ changes }) => [{
  title: `整理出 ${changes.length} 条变更`,
  claim: changes.map((change) => `${change.kind} ${change.ref}`).join('\n'),
  kind: 'pattern',
  confidence: 0.6,
  evidenceRefs: changes.map((change) => `watch:${change.key}:${change.seq}`),
  keywords: ['监控']
}];

/** 两条互不相同的草稿：用来验证「第二条提交失败，重试不重复建第一条」。 */
const twoDrafts = ({ changes }) => [
  { title: '第一条候选', claim: `第一条：看到 ${changes.length} 条变更`, kind: 'pattern' },
  { title: '第二条候选', claim: '第二条：另一条结论', kind: 'hypothesis' }
];

/** 假定时器：只记下回调与延时，不真的等。 */
const fakeTimers = () => {
  const pending = new Map();
  let seq = 0;
  return {
    setTimeout(fn, delay) {
      const id = ++seq;
      pending.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    get count() { return pending.size; },
    get delays() { return [...pending.values()].map((timer) => timer.delay); },
    fireNext() {
      const first = pending.entries().next();
      if (first.done) return false;
      pending.delete(first.value[0]);
      first.value[1].fn();
      return true;
    }
  };
};

// ---- 判定：给「当前时间 / 上次整理 / 计划时刻」回答该不该跑、是否迟到 ----

test('定时留空：不启用，也不判迟到（只收集、不整理）', () => {
  for (const schedule of ['', '   ', null, undefined]) {
    const decision = tidyDecision({ now: localAt(20, 10, 0), lastRunAt: localAt(19, 9, 0), schedule });
    assert.equal(decision.enabled, false, `schedule=${JSON.stringify(schedule)}`);
    assert.equal(decision.due, false);
    assert.equal(decision.late, false);
    assert.equal(decision.reason, 'disabled');
    assert.equal(decision.plannedAt, '');
    assert.equal(decision.lateMs, 0);
  }
});

test('未到点不触发：昨天已经跑过，今天还没到计划时刻', () => {
  const decision = tidyDecision({ now: localAt(20, 8, 30), lastRunAt: localAt(19, 9, 0), schedule: '09:00' });
  assert.equal(decision.enabled, true);
  assert.equal(decision.due, false);
  assert.equal(decision.late, false);
  assert.equal(decision.reason, 'not-due');
  // 计划时刻说的是「这个周期的那一次」：还没到点就是昨天那次（已经跑过）。
  assert.equal(decision.plannedAt, localAt(19, 9, 0).toISOString());
  assert.equal(decision.nextAt, localAt(20, 9, 0).toISOString());
});

test('到点触发：恰好在计划时刻，触发但不算迟到', () => {
  const decision = tidyDecision({ now: localAt(20, 9, 0), lastRunAt: localAt(19, 9, 0), schedule: '09:00' });
  assert.equal(decision.due, true);
  assert.equal(decision.late, false);
  assert.equal(decision.reason, 'due');
  assert.equal(decision.plannedAt, localAt(20, 9, 0).toISOString());
  assert.equal(decision.nowAt, localAt(20, 9, 0).toISOString());
  assert.equal(decision.lateMs, 0);
});

test('错过一个周期：补跑并标记迟到，计划时刻与实际时刻都在结果里', () => {
  const decision = tidyDecision({ now: localAt(20, 11, 30), lastRunAt: localAt(19, 9, 0), schedule: '09:00' });
  assert.equal(decision.due, true);
  assert.equal(decision.late, true);
  assert.equal(decision.reason, 'late');
  assert.equal(decision.plannedAt, localAt(20, 9, 0).toISOString());
  assert.equal(decision.nowAt, localAt(20, 11, 30).toISOString());
  assert.equal(decision.lateMs, 2.5 * 60 * 60 * 1000);
});

test('整周期都错过（关机两天）：只按最近一次计划时刻补一次', () => {
  const decision = tidyDecision({ now: localAt(20, 8, 0), lastRunAt: localAt(18, 9, 0), schedule: '09:00' });
  assert.equal(decision.due, true);
  assert.equal(decision.late, true);
  // 最近一次计划时刻是昨天 09:00，不是前天：补跑只补一次。
  assert.equal(decision.plannedAt, localAt(19, 9, 0).toISOString());
  assert.equal(decision.nextAt, localAt(20, 9, 0).toISOString());
});

test('从没整理过：补跑一次，但不算迟到（没有「本该跑的那次」）', () => {
  const decision = tidyDecision({ now: localAt(20, 11, 0), lastRunAt: null, schedule: '09:00' });
  assert.equal(decision.due, true);
  assert.equal(decision.late, false);
  assert.equal(decision.reason, 'first-run');
  assert.equal(decision.plannedAt, localAt(20, 9, 0).toISOString());
});

test('计划时刻解析：HH:MM 与 {hour,minute} 都认，坏的直接报错', () => {
  assert.deepEqual(parseTidySchedule('07:05'), { enabled: true, hour: 7, minute: 5, text: '07:05' });
  assert.deepEqual(parseTidySchedule({ hour: 21, minute: 0 }), { enabled: true, hour: 21, minute: 0, text: '21:00' });
  assert.equal(parseTidySchedule(undefined).enabled, false);
  for (const bad of ['25:00', '9', '9点', '09:60', '09:00:00', 900, true]) {
    assert.throws(() => parseTidySchedule(bad), Error, `bad=${JSON.stringify(bad)}`);
  }
});

test('下一个计划时刻：到点那一刻算下一次，避免同一分钟里连跑', () => {
  assert.equal(nextTidyAt({ now: localAt(20, 8, 30), schedule: '09:00' }).at, localAt(20, 9, 0).toISOString());
  assert.equal(nextTidyAt({ now: localAt(20, 9, 0), schedule: '09:00' }).at, localAt(21, 9, 0).toISOString());
  assert.equal(nextTidyAt({ now: localAt(20, 10, 0), schedule: '09:00' }).at, localAt(21, 9, 0).toISOString());
  assert.equal(nextTidyAt({ now: localAt(20, 10, 0), schedule: '' }), null);
});

// ---- 状态：整理运行记录（计划时刻 / 实际时刻 / 迟到） ----

test('运行记录落进 watch 状态库：计划时刻、实际时刻、迟到都在，目录里仍只有一份库', () => withTemp(async (root) => {
  const dir = path.join(root, 'watch');
  const store = new WatchStateStore({ dir });
  const target = project();
  try {
    assert.equal(store.getTidy(target), null);
    const marked = store.markTidy(target, {
      plannedAt: localAt(20, 9, 0), ranAt: localAt(20, 11, 0), late: true, note: '迟到补跑'
    });
    assert.equal(marked.plannedAt, localAt(20, 9, 0).toISOString());
    assert.equal(marked.ranAt, localAt(20, 11, 0).toISOString());
    assert.equal(marked.late, true);
    assert.equal(marked.note, '迟到补跑');
    assert.deepEqual(store.getTidy(target), marked);
    assert.deepEqual(fs.readdirSync(dir), [WATCH_DB_NAME]);
    // 水位、心跳、队列三张老表不受影响：整理记录是第四张表，不是往旧列里塞。
    const status = store.status(target);
    assert.equal(status.queued, 0);
    assert.equal(status.heartbeat, null);
  } finally { store.close(); }
}));

// ---- 整理：队列 → 待确认候选 ----

test('到点整理：队列变成待确认候选，没有直接入库，运行记录写计划时刻与实际时刻', () => withTemp(async (root) => {
  const store = new WatchStateStore({ dir: path.join(root, 'watch') });
  const personal = new PersonalKnowledgeStore(':memory:');
  const target = project();
  try {
    queueOf(store, target);
    const result = runTidy({
      store, target, personalStore: personal, distill: fakeDistill, schedule: '09:00', now: localAt(20, 9, 0)
    });
    assert.equal(result.ok, true);
    assert.equal(result.ran, true);
    assert.equal(result.late, false);
    assert.equal(result.changes, 2);
    assert.equal(result.plannedAt, localAt(20, 9, 0).toISOString());
    assert.equal(result.ranAt, localAt(20, 9, 0).toISOString());

    const pending = personal.proposals('pending');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, 'pending');
    assert.equal(pending[0].meta.contract, CANDIDATE_CONTRACT);
    assert.equal(pending[0].meta.watch.ref, 'project:alpha');
    assert.equal(pending[0].payload.scope, 'project');
    assert.equal(pending[0].payload.projectId, 'alpha');
    assert.equal(pending[0].payload.verificationStatus, 'unverified');
    // 候选而不是入库：正式知识条目一条都不该多出来。
    assert.deepEqual(personal.list(), []);

    // 成功后队列清空，运行记录落在 watch 库里。
    assert.deepEqual(store.listChanges(target), []);
    const tidy = store.getTidy(target);
    assert.equal(tidy.ranAt, localAt(20, 9, 0).toISOString());
    assert.equal(tidy.plannedAt, localAt(20, 9, 0).toISOString());
    assert.equal(tidy.late, false);
    assert.match(tidy.note, /2 条变更/u);
  } finally { personal.close(); store.close(); }
}));

test('同一天再跑：已经整理过就不再整理，队列与候选都不动', () => withTemp(async (root) => {
  const store = new WatchStateStore({ dir: path.join(root, 'watch') });
  const personal = new PersonalKnowledgeStore(':memory:');
  const target = project();
  try {
    queueOf(store, target);
    const args = { store, target, personalStore: personal, distill: fakeDistill, schedule: '09:00' };
    const first = runTidy({ ...args, now: localAt(20, 9, 0) });
    assert.equal(first.ran, true);
    queueOf(store, target);
    const second = runTidy({ ...args, now: localAt(20, 10, 0) });
    assert.equal(second.ok, true);
    assert.equal(second.ran, false);
    assert.equal(second.reason, 'not-due');
    assert.equal(store.listChanges(target).length, 2, '未到点不该动队列');
    assert.equal(personal.proposals('pending').length, 1);
    assert.equal(store.getTidy(target).ranAt, localAt(20, 9, 0).toISOString());
  } finally { personal.close(); store.close(); }
}));

test('迟到补跑：结果与运行记录都标「迟到」，并同时留下计划时刻与实际时刻', () => withTemp(async (root) => {
  const store = new WatchStateStore({ dir: path.join(root, 'watch') });
  const personal = new PersonalKnowledgeStore(':memory:');
  const target = project();
  try {
    store.markTidy(target, { plannedAt: localAt(19, 9, 0), ranAt: localAt(19, 9, 0) });
    queueOf(store, target);
    const result = runTidy({
      store, target, personalStore: personal, distill: fakeDistill, schedule: '09:00', now: localAt(20, 11, 0)
    });
    assert.equal(result.ok, true);
    assert.equal(result.ran, true);
    assert.equal(result.late, true);
    assert.equal(result.plannedAt, localAt(20, 9, 0).toISOString());
    assert.equal(result.ranAt, localAt(20, 11, 0).toISOString());
    const tidy = store.getTidy(target);
    assert.equal(tidy.late, true);
    assert.equal(tidy.plannedAt, localAt(20, 9, 0).toISOString());
    assert.equal(tidy.ranAt, localAt(20, 11, 0).toISOString());
    assert.match(tidy.note, /迟到/u);
    assert.equal(personal.proposals('pending').length, 1);
  } finally { personal.close(); store.close(); }
}));

test('定时留空：只收集不整理，队列与候选一条都不动', () => withTemp(async (root) => {
  const store = new WatchStateStore({ dir: path.join(root, 'watch') });
  const personal = new PersonalKnowledgeStore(':memory:');
  const target = project();
  try {
    queueOf(store, target);
    const result = runTidy({
      store, target, personalStore: personal, distill: fakeDistill, schedule: '', now: localAt(20, 9, 0)
    });
    assert.equal(result.ok, true);
    assert.equal(result.ran, false);
    assert.equal(result.reason, 'disabled');
    assert.equal(store.listChanges(target).length, 2);
    assert.deepEqual(personal.proposals('pending'), []);
    assert.equal(store.getTidy(target), null);
  } finally { personal.close(); store.close(); }
}));

test('提炼失败：队列一条不少、不记运行、可以再试', () => withTemp(async (root) => {
  const store = new WatchStateStore({ dir: path.join(root, 'watch') });
  const personal = new PersonalKnowledgeStore(':memory:');
  const target = project();
  try {
    queueOf(store, target);
    let attempts = 0;
    const flaky = ({ changes }) => {
      attempts += 1;
      if (attempts === 1) throw new Error('提炼器没回话');
      return fakeDistill({ changes });
    };
    const first = runTidy({
      store, target, personalStore: personal, distill: flaky, schedule: '09:00', now: localAt(20, 9, 0)
    });
    assert.equal(first.ok, false);
    assert.equal(first.code, 'distill');
    assert.equal(first.queueKept, true);
    assert.match(first.reason, /提炼器没回话/u);
    assert.equal(store.listChanges(target).length, 2);
    assert.equal(store.getTidy(target), null);
    assert.deepEqual(personal.proposals('pending'), []);

    const retry = runTidy({
      store, target, personalStore: personal, distill: fakeDistill, schedule: '09:00', now: localAt(20, 9, 1)
    });
    assert.equal(retry.ok, true);
    assert.equal(retry.ran, true);
    assert.equal(retry.late, false);
    assert.deepEqual(store.listChanges(target), []);
    assert.equal(personal.proposals('pending').length, 1);
  } finally { personal.close(); store.close(); }
}));

test('提交候选失败：队列不动，重试不把已经建好的候选再建一遍', () => withTemp(async (root) => {
  const store = new WatchStateStore({ dir: path.join(root, 'watch') });
  const personal = new PersonalKnowledgeStore(':memory:');
  const target = project();
  try {
    queueOf(store, target);
    let calls = 0;
    const flakyPersonal = {
      proposals: (...args) => personal.proposals(...args),
      submitProposal: (input) => {
        calls += 1;
        if (calls === 2) throw new Error('候选库写不进去');
        return personal.submitProposal(input);
      }
    };
    const first = runTidy({
      store, target, personalStore: flakyPersonal, distill: twoDrafts, schedule: '09:00', now: localAt(20, 9, 0)
    });
    assert.equal(first.ok, false);
    assert.equal(first.code, 'candidate');
    assert.equal(first.queueKept, true);
    assert.equal(store.listChanges(target).length, 2, '队列一条不少');
    assert.equal(personal.proposals('pending').length, 1, '第一条已经落成候选');
    assert.equal(store.getTidy(target), null);

    const retry = runTidy({
      store, target, personalStore: personal, distill: twoDrafts, schedule: '09:00', now: localAt(20, 9, 5)
    });
    assert.equal(retry.ok, true);
    assert.equal(retry.skipped, 1, '第一条不该重复提交');
    assert.equal(personal.proposals('pending').length, 2);
    assert.deepEqual(store.listChanges(target), []);
  } finally { personal.close(); store.close(); }
}));

test('空队列按时整理：记一次运行，不产生候选，也不算失败', () => withTemp(async (root) => {
  const store = new WatchStateStore({ dir: path.join(root, 'watch') });
  const personal = new PersonalKnowledgeStore(':memory:');
  const target = project();
  try {
    const result = runTidy({
      store, target, personalStore: personal, distill: fakeDistill, schedule: '09:00', now: localAt(20, 9, 0)
    });
    assert.equal(result.ok, true);
    assert.equal(result.ran, true);
    assert.equal(result.changes, 0);
    assert.equal(result.empty, true);
    assert.deepEqual(personal.proposals('pending'), []);
    assert.equal(store.getTidy(target).ranAt, localAt(20, 9, 0).toISOString());
  } finally { personal.close(); store.close(); }
}));

test('没有提炼器也不静默丢队列：兜底只列清单、标成记录，仍走候选入口', () => withTemp(async (root) => {
  const store = new WatchStateStore({ dir: path.join(root, 'watch') });
  const personal = new PersonalKnowledgeStore(':memory:');
  const target = project();
  try {
    queueOf(store, target);
    const result = tidyQueue({ store, target, personalStore: personal, at: localAt(20, 9, 0) });
    assert.equal(result.ok, true);
    assert.equal(result.drafts, 1);
    assert.equal(result.submitted.length, 1);
    const [proposal] = personal.proposals('pending');
    // 兜底不解释内容：只说「这段时间看到了什么」，因此是记录而不是结论。
    assert.equal(proposal.payload.kind, 'note');
    assert.match(proposal.payload.content, /新增 1 \/ 修改 1 \/ 删除 0/u);
    assert.match(proposal.payload.content, /src\/a\.mjs/u);
    assert.deepEqual(personal.list(), []);
  } finally { personal.close(); store.close(); }
}));

test('兜底提炼器只认队列条目：三类计数、清单与证据引用都在', () => {
  const target = { type: 'project', ref: 'project:alpha', projectId: 'alpha' };
  const changes = [
    { seq: 1, key: 'project:alpha', kind: 'added', ref: 'src/a.mjs', at: T1, detail: {} },
    { seq: 2, key: 'project:alpha', kind: 'deleted', ref: 'src/b.mjs', at: T2, detail: {} }
  ];
  const [draft] = fallbackDistill({ target, changes, at: localAt(20, 9, 0) });
  assert.equal(draft.kind, 'note');
  assert.equal(draft.proposedLayer, 'project');
  assert.match(draft.claim, /新增 1 \/ 修改 0 \/ 删除 1/u);
  assert.deepEqual(draft.evidenceRefs, ['watch:project:alpha:1', 'watch:project:alpha:2']);
  assert.ok(draft.title.length <= 160);
});

// ---- 调度：注入时钟与定时器，启动即补跑，到点再跑 ----

test('调度器：启动即补跑漏掉的那次（标迟到），然后等下一个计划时刻', () => withTemp(async (root) => {
  const store = new WatchStateStore({ dir: path.join(root, 'watch') });
  const personal = new PersonalKnowledgeStore(':memory:');
  const target = project();
  try {
    store.markTidy(target, { plannedAt: localAt(19, 9, 0), ranAt: localAt(19, 9, 0) });
    queueOf(store, target);
    let now = localAt(20, 11, 0);
    const timers = fakeTimers();
    const results = [];
    const scheduler = startTidyScheduler({
      schedule: '09:00',
      clock: () => now,
      timers,
      runOnce: (at) => runTidy({
        store, target, personalStore: personal, distill: fakeDistill, schedule: '09:00', now: at
      }),
      onResult: (result) => results.push(result)
    });
    assert.equal(scheduler.active, true);
    assert.equal(results.length, 1, '启动就补跑一次');
    assert.equal(results[0].ran, true);
    assert.equal(results[0].late, true);
    assert.equal(results[0].plannedAt, localAt(20, 9, 0).toISOString());
    assert.equal(results[0].ranAt, localAt(20, 11, 0).toISOString());
    // 下一次是明天 09:00：今天的已经补过了，不会同一分钟里反复跑。
    assert.deepEqual(timers.delays, [localAt(21, 9, 0).getTime() - localAt(20, 11, 0).getTime()]);

    now = localAt(21, 9, 0);
    assert.equal(timers.fireNext(), true);
    assert.equal(results.length, 2);
    assert.equal(results[1].ran, true);
    assert.equal(results[1].late, false);
    assert.equal(results[1].plannedAt, localAt(21, 9, 0).toISOString());
    assert.equal(timers.count, 1, '跑完继续等下一个周期');
    scheduler.stop();
    assert.equal(timers.count, 0);
    assert.equal(scheduler.active, false);
  } finally { personal.close(); store.close(); }
}));

test('调度器：未到点不乱跑，到点才触发一次整理', () => withTemp(async (root) => {
  const store = new WatchStateStore({ dir: path.join(root, 'watch') });
  const personal = new PersonalKnowledgeStore(':memory:');
  const target = project();
  try {
    store.markTidy(target, { plannedAt: localAt(19, 9, 0), ranAt: localAt(19, 9, 0) });
    queueOf(store, target);
    let now = localAt(20, 8, 0);
    const timers = fakeTimers();
    const results = [];
    startTidyScheduler({
      schedule: '09:00',
      clock: () => now,
      timers,
      runOnce: (at) => runTidy({
        store, target, personalStore: personal, distill: fakeDistill, schedule: '09:00', now: at
      }),
      onResult: (result) => results.push(result)
    });
    assert.equal(results.length, 1, '启动时还是会问一次该不该跑');
    assert.equal(results[0].ran, false);
    assert.equal(results[0].reason, 'not-due');
    assert.equal(store.listChanges(target).length, 2);
    assert.deepEqual(personal.proposals('pending'), []);
    assert.deepEqual(timers.delays, [localAt(20, 9, 0).getTime() - localAt(20, 8, 0).getTime()]);

    now = localAt(20, 9, 0);
    assert.equal(timers.fireNext(), true);
    assert.equal(results.length, 2);
    assert.equal(results[1].ran, true);
    assert.equal(results[1].late, false);
    assert.equal(personal.proposals('pending').length, 1);
    assert.deepEqual(store.listChanges(target), []);
  } finally { personal.close(); store.close(); }
}));

test('调度器：定时留空就不排期，队列继续只收集', () => withTemp(async (root) => {
  const store = new WatchStateStore({ dir: path.join(root, 'watch') });
  const personal = new PersonalKnowledgeStore(':memory:');
  const target = project();
  try {
    queueOf(store, target);
    const timers = fakeTimers();
    const results = [];
    const scheduler = startTidyScheduler({
      schedule: '',
      clock: () => localAt(20, 9, 0),
      timers,
      runOnce: (at) => runTidy({
        store, target, personalStore: personal, distill: fakeDistill, schedule: '', now: at
      }),
      onResult: (result) => results.push(result)
    });
    assert.equal(scheduler.active, false);
    assert.equal(timers.count, 0);
    assert.equal(results.length, 0, '留空就一次也不整理');
    assert.equal(store.listChanges(target).length, 2);
    assert.deepEqual(personal.proposals('pending'), []);
  } finally { personal.close(); store.close(); }
}));

test('调度器：一次整理失败不打断排期，下一次照样来', () => withTemp(async (root) => {
  const store = new WatchStateStore({ dir: path.join(root, 'watch') });
  const personal = new PersonalKnowledgeStore(':memory:');
  const target = project();
  try {
    queueOf(store, target);
    const timers = fakeTimers();
    const results = [];
    startTidyScheduler({
      schedule: '09:00',
      clock: () => localAt(20, 9, 0),
      timers,
      runOnce: () => { throw new Error('定时器里的异常不该吃掉下一轮'); },
      onResult: (result) => results.push(result)
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    assert.equal(results[0].code, 'run-error');
    assert.equal(store.listChanges(target).length, 2, '队列还在，可以重试');
    assert.equal(timers.count, 1, '排期没有被异常打断');
  } finally { personal.close(); store.close(); }
}));
