// 同步执行器（#130）：只测注入假实现下的行为，不碰真仓库、不碰网络、不读真环境。
//
// 断言四件事：先拉后推的顺序；有冲突就停在确认且不推送；四种选择各自的结果；
// 「未解决」标记能列出且下次仍会提示。失败形状（缺凭证 / 拉取失败 / 推送失败）单独断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { syncPlan } from '../src/memory/sync-plan.mjs';
import {
  SYNC_CHOICES,
  SYNC_CHOICE_LABELS,
  listUnresolved,
  mergeConflictText,
  pendingOf,
  runSync,
  syncCredential
} from '../src/memory/sync-run.mjs';

const DEFAULT_AT = '2026-11-20T00:00:00.000Z';
const AT = '2026-11-26T10:00:00.000Z';
const ENV = Object.freeze({ GITHUB_TOKEN: 'env-token' });

const doc = (id, version, updatedAt = DEFAULT_AT, extra = {}) => ({ id, version, updatedAt, ...extra });
const idsOf = (list) => list.map((entry) => entry.id);
const flow = (calls) => calls.filter(([name]) => name === 'pull' || name === 'push').map(([name]) => name);

/** 假 deps：记录每次调用与每次写入，测试断言的正是这些副作用。 */
const makeDeps = ({
  localDocs = {},
  remoteDocs = {},
  unresolved = [],
  env = ENV,
  failOn = '',
  pullResult,
  pushResult,
  loadThrows = false,
  saveThrows = false
} = {}) => {
  const calls = [];
  const writes = [];
  const saved = [];
  const deps = {
    env,
    async pull(payload) {
      calls.push(['pull', payload]);
      if (failOn === 'pull') throw new Error('network unreachable');
      return pullResult ?? { ok: true, pulled: [...payload.pull, ...payload.archived] };
    },
    async push(payload) {
      calls.push(['push', payload]);
      if (failOn === 'push') throw new Error('remote rejected: non-fast-forward');
      return pushResult ?? { ok: true, pushed: payload.ids };
    },
    async readLocal(id) {
      calls.push(['readLocal', id]);
      return localDocs[id];
    },
    async readRemote(id) {
      calls.push(['readRemote', id]);
      return remoteDocs[id];
    },
    async writeLocal(id, content) {
      calls.push(['writeLocal', id]);
      writes.push({ id, content });
    },
    async loadUnresolved() {
      calls.push(['loadUnresolved']);
      if (loadThrows) throw new Error('unresolved store corrupt');
      return unresolved;
    },
    async saveUnresolved(list) {
      calls.push(['saveUnresolved']);
      if (saveThrows) throw new Error('disk full');
      saved.push(list);
    }
  };
  return { deps, calls, writes, saved };
};

/** 一份含四类变化的计划：冲突 1、新增 1、待拉取 1、归档 1。 */
const mixedPlan = () => syncPlan({
  local: [doc('conf', 1, DEFAULT_AT, { dirty: true }), doc('mine', 1), doc('pulled', 1)],
  remote: [doc('conf', 2, DEFAULT_AT, { dirty: true }), doc('arch', 1), doc('pulled', 2, DEFAULT_AT, { dirty: true })]
});

const twoConflictsPlan = () => syncPlan({
  local: [
    doc('confA', 1, DEFAULT_AT, { dirty: true }),
    doc('confB', 1, DEFAULT_AT, { dirty: true }),
    doc('mine', 1)
  ],
  remote: [
    doc('confA', 2, DEFAULT_AT, { dirty: true }),
    doc('confB', 2, DEFAULT_AT, { dirty: true })
  ]
});

test('顺序：先拉后推，拉取参数只含待拉与归档，推送参数只含待推', async () => {
  const plan = mixedPlan();
  const { deps, calls } = makeDeps({ remoteDocs: { conf: '远端版本' } });
  const result = await runSync({ plan, choices: { conf: 'remote' }, deps, at: AT });

  assert.equal(result.status, 'ok');
  assert.deepEqual(flow(calls), ['pull', 'push'], '拉取必须发生在推送之前');
  const pull = calls.find(([name]) => name === 'pull')[1];
  assert.deepEqual(pull.pull, ['pulled']);
  assert.deepEqual(pull.archived, ['arch']);
  const push = calls.find(([name]) => name === 'push')[1];
  assert.deepEqual(push.ids, ['mine'], '远端覆盖的冲突篇不进推送');
  assert.deepEqual(result.pulled, ['arch', 'pulled']);
  assert.deepEqual(result.pushed, ['mine']);
  assert.equal(result.text, '同步完成：拉取 2 篇，推送 1 篇，处置冲突 1 篇。');
});

test('有冲突且没给选择：停在确认，只完成拉取，不推送任何东西', async () => {
  const plan = mixedPlan();
  const { deps, calls } = makeDeps();
  const result = await runSync({ plan, deps, at: AT });

  assert.equal(result.status, 'conflict');
  assert.equal(result.code, 'awaiting-choice');
  assert.deepEqual(flow(calls), ['pull'], '有冲突时一次都不推');
  assert.deepEqual(result.pulled, ['arch', 'pulled'], '已完成的拉取保留');
  assert.deepEqual(result.pushed, []);
  assert.deepEqual(result.missing, ['conf']);
  assert.deepEqual(idsOf(result.pending), ['conf']);
  assert.equal(result.pending[0].reason, 'both-changed');
  assert.equal(result.pending[0].local.version, '1');
  assert.equal(result.pending[0].remote.version, '2');
  assert.match(result.text, /停在冲突确认/u);
});

test('选择不完整：一篇都不处置，也不推送', async () => {
  const plan = twoConflictsPlan();
  const { deps, calls, writes } = makeDeps({ remoteDocs: { confA: '远端 A' } });
  const result = await runSync({ plan, choices: { confA: 'remote' }, deps, at: AT });

  assert.equal(result.status, 'conflict');
  assert.deepEqual(result.missing, ['confB']);
  assert.deepEqual(flow(calls), ['pull']);
  assert.equal(writes.length, 0, '缺选择时不先写一半');
});

test('选择「远端覆盖本地」：本地文件替换为远端内容，这篇不推送，标记清除', async () => {
  const plan = mixedPlan();
  const { deps, calls, writes, saved } = makeDeps({ remoteDocs: { conf: '# 远端版本\n\n远端补充' } });
  const result = await runSync({ plan, choices: { conf: 'remote' }, deps, at: AT });

  assert.equal(result.status, 'ok');
  assert.deepEqual(writes, [{ id: 'conf', content: '# 远端版本\n\n远端补充' }]);
  assert.deepEqual(calls.find(([name]) => name === 'push')[1].ids, ['mine']);
  assert.equal(result.records[0].choice, 'remote');
  assert.match(result.records[0].summary, /远端覆盖本地/u);
  assert.deepEqual(saved, [[]], '处置完的冲突不再留未解决标记');
  assert.equal(calls.filter(([name]) => name === 'readLocal').length, 0);
});

test('选择「本地覆盖远端」：不读不写本地，排进本次推送', async () => {
  const plan = mixedPlan();
  const { deps, calls, writes, saved } = makeDeps();
  const result = await runSync({ plan, choices: { conf: 'local' }, deps, at: AT });

  assert.equal(result.status, 'ok');
  assert.deepEqual(writes, [], '本地覆盖不改本地文件');
  assert.equal(calls.filter(([name]) => name === 'readRemote' || name === 'readLocal').length, 0);
  assert.deepEqual(calls.find(([name]) => name === 'push')[1].ids, ['conf', 'mine']);
  assert.deepEqual(result.resolved, [{ id: 'conf', choice: 'local', queued: true }]);
  assert.deepEqual(saved, [[]]);
});

test('选择「两段都留着」：按块拼接、相同块只留一份、差异块标注来源，并推送', async () => {
  const plan = mixedPlan();
  const { deps, calls, writes } = makeDeps({
    localDocs: { conf: '# 共同标题\n\n本地补充' },
    remoteDocs: { conf: '# 共同标题\n\n远端补充' }
  });
  const result = await runSync({ plan, choices: { conf: 'both' }, deps, at: AT });

  assert.equal(result.status, 'ok');
  assert.equal(writes.length, 1);
  const merged = writes[0].content;
  assert.ok(merged.includes('来源：本地 开始'), '本地段落要标注来源');
  assert.ok(merged.includes('来源：远端 开始'), '远端段落要标注来源');
  assert.ok(merged.includes('本地补充'));
  assert.ok(merged.includes('远端补充'));
  assert.equal(merged.split('# 共同标题').length - 1, 1, '相同块只留一份');
  assert.deepEqual(calls.find(([name]) => name === 'push')[1].ids, ['conf', 'mine']);
  assert.equal(result.records[0].choice, 'both');
});

test('选择「跳过」：只跳过这一篇，其余照常推送，本地留未解决标记', async () => {
  const plan = twoConflictsPlan();
  const { deps, calls, saved } = makeDeps({
    remoteDocs: { confA: '远端 A', confB: '远端 B' }
  });
  const result = await runSync({ plan, choices: { confA: 'skip', confB: 'remote' }, deps, at: AT });

  assert.equal(result.status, 'ok');
  assert.deepEqual(calls.find(([name]) => name === 'push')[1].ids, ['mine']);
  assert.deepEqual(result.pushed, ['mine']);
  assert.deepEqual(idsOf(result.unresolved), ['confA']);
  const marker = result.unresolved[0];
  assert.equal(marker.reason, 'conflict-skipped');
  assert.equal(marker.attempts, 1);
  assert.equal(marker.since, AT);
  assert.deepEqual(marker.local.version, '1');
  assert.deepEqual(marker.remote.version, '2');
  assert.deepEqual(saved, [result.unresolved], '标记交给注入的存储落盘');
});

test('listUnresolved：只归一化本地清单，按 id 排序、丢弃认不出的条目', async () => {
  const { deps } = makeDeps({
    unresolved: [
      { id: 'b', attempts: 2, reason: 'conflict-skipped' },
      { nope: true },
      { id: 'a', attempts: '1' }
    ]
  });
  const list = await listUnresolved({ deps });
  assert.deepEqual(idsOf(list), ['a', 'b']);
  assert.equal(list[0].attempts, 1);
  assert.equal(list[0].reason, 'conflict-skipped');
  assert.deepEqual(await listUnresolved({ deps: {} }), [], '没有存储实现时给空清单，不抛错');
});

test('未解决标记可列出，且下次同步仍会提示——即使这次计划里已不判冲突', async () => {
  const plan = syncPlan({ local: [doc('mine', 1)], remote: [] });
  const marker = {
    id: 'conf',
    reason: 'conflict-skipped',
    since: AT,
    attempts: 1,
    local: { version: '1', updatedAt: DEFAULT_AT, dirty: true },
    remote: { version: '2', updatedAt: DEFAULT_AT, dirty: true }
  };
  const { deps, calls } = makeDeps({ unresolved: [marker] });
  const result = await runSync({ plan, deps, at: AT });

  assert.equal(plan.conflicts.length, 0, '前提：本次计划没有冲突');
  assert.equal(result.status, 'conflict');
  assert.deepEqual(result.missing, ['conf']);
  assert.equal(result.pending[0].reason, 'conflict-skipped');
  assert.equal(result.pending[0].attempts, 1, '次数带出来，界面可以说「第 2 次未解决」');
  assert.deepEqual(flow(calls), ['pull'], '旧标记也拦住推送');
});

test('pendingOf 合并计划冲突与旧标记：计划优先，标记只补漏，按 id 排序', () => {
  const plan = { conflicts: [{ id: 'b', reason: 'both-changed', local: { version: '2' }, remote: { version: '3' } }] };
  const pending = pendingOf(plan, [
    { id: 'a', attempts: 2, local: { version: '1' }, remote: { version: '1' } },
    { id: 'b', attempts: 1, local: { version: '9' }, remote: { version: '9' } },
    { nope: true }
  ]);
  assert.deepEqual(idsOf(pending), ['a', 'b']);
  assert.equal(pending[1].local.version, '2', '计划里的摘要优先于旧标记');
  assert.equal(pending[1].attempts, 1, '次数从旧标记保留');
  assert.equal(pending[0].attempts, 2);
});

test('再次跳过同一篇：未解决次数累加，不重置', async () => {
  const plan = mixedPlan();
  const { deps, saved } = makeDeps({
    unresolved: [{
      id: 'conf', reason: 'conflict-skipped', since: DEFAULT_AT, attempts: 1,
      local: { version: '1' }, remote: { version: '2' }
    }]
  });
  const result = await runSync({ plan, choices: { conf: 'skip' }, deps, at: AT });

  assert.equal(result.status, 'ok');
  assert.equal(result.unresolved[0].attempts, 2);
  assert.deepEqual(saved[0], result.unresolved);
});

test('凭证：缺 GITHUB_TOKEN / GH_TOKEN 时说「未开始」，一次依赖都不调用', async () => {
  const plan = mixedPlan();
  const { deps, calls } = makeDeps({ env: {} });
  const result = await runSync({ plan, deps, at: AT });

  assert.equal(result.status, 'unconfigured');
  assert.equal(result.code, 'auth-missing');
  assert.match(result.message, /GITHUB_TOKEN/u);
  assert.equal(calls.length, 0, '没凭证不碰 git、不读写任何文件');
  assert.deepEqual(idsOf(result.pending), ['conf'], '仍可先把要问的列出来');
});

test('凭证：GH_TOKEN 可作为回退，返回值不回显 token', () => {
  assert.deepEqual(syncCredential({ env: { GH_TOKEN: 'x' } }), { configured: true, source: 'GH_TOKEN' });
  assert.deepEqual(syncCredential({ env: { GITHUB_TOKEN: 'x', GH_TOKEN: 'y' } }), {
    configured: true,
    source: 'GITHUB_TOKEN'
  });
  assert.deepEqual(syncCredential({ env: { GITHUB_TOKEN: '  ' } }), { configured: false, source: '' });
  assert.deepEqual(Object.keys(syncCredential({ env: { GITHUB_TOKEN: 'secret' } })), ['configured', 'source']);
});

test('拉取网络失败：带原因停下，不推送', async () => {
  const plan = mixedPlan();
  const { deps, calls } = makeDeps({ failOn: 'pull' });
  const result = await runSync({ plan, choices: { conf: 'local' }, deps, at: AT });

  assert.equal(result.status, 'error');
  assert.equal(result.step, 'pull');
  assert.equal(result.code, 'pull-failed');
  assert.match(result.message, /network unreachable/u);
  assert.deepEqual(flow(calls), ['pull']);
  assert.deepEqual(result.pushed, []);
});

test('拉取返回鉴权失败：原因码与说明原样带回，不伪装成成功', async () => {
  const plan = mixedPlan();
  const { deps } = makeDeps({ pullResult: { ok: false, code: 'auth-rejected', message: 'bad credentials' } });
  const result = await runSync({ plan, deps, at: AT });

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'auth-rejected');
  assert.equal(result.message, 'bad credentials');
});

test('推送失败：已完成的拉取与处置保留，失败原因写明', async () => {
  const plan = mixedPlan();
  const { deps, saved } = makeDeps({ failOn: 'push' });
  const result = await runSync({ plan, choices: { conf: 'local' }, deps, at: AT });

  assert.equal(result.status, 'error');
  assert.equal(result.step, 'push');
  assert.equal(result.code, 'push-failed');
  assert.match(result.message, /non-fast-forward/u);
  assert.deepEqual(result.pulled, ['arch', 'pulled']);
  assert.deepEqual(idsOf(result.records), ['conf']);
  assert.deepEqual(saved, [[]]);
});

test('「未解决」清单读不到：整场停下，不推送（不能把跳过当成已解决）', async () => {
  const plan = mixedPlan();
  const { deps, calls } = makeDeps({ loadThrows: true });
  const result = await runSync({ plan, choices: { conf: 'local' }, deps, at: AT });

  assert.equal(result.status, 'error');
  assert.equal(result.step, 'unresolved');
  assert.equal(result.code, 'unresolved-load-failed');
  assert.deepEqual(flow(calls), []);
});

test('「未解决」清单写不进：跳过不能装作记下了', async () => {
  const plan = mixedPlan();
  const { deps, calls } = makeDeps({ saveThrows: true });
  const result = await runSync({ plan, choices: { conf: 'skip' }, deps, at: AT });

  assert.equal(result.status, 'error');
  assert.equal(result.step, 'unresolved');
  assert.equal(result.code, 'unresolved-save-failed');
  assert.deepEqual(flow(calls), ['pull'], '写不进标记就不推送');
});

test('缺注入实现：说清楚缺哪一步，不假装做过', async () => {
  const plan = mixedPlan();
  const missingPull = await runSync({ plan, deps: { env: ENV, push: async () => ({}) }, at: AT });
  assert.equal(missingPull.status, 'error');
  assert.equal(missingPull.code, 'missing-dependency');
  assert.equal(missingPull.step, 'pull');

  const missingPush = await runSync({ plan, deps: { env: ENV, pull: async () => ({}) }, at: AT });
  assert.equal(missingPush.status, 'error');
  assert.equal(missingPush.step, 'push');

  const { deps } = makeDeps({ localDocs: {}, remoteDocs: {} });
  delete deps.writeLocal;
  const missingWrite = await runSync({ plan, choices: { conf: 'remote' }, deps, at: AT });
  assert.equal(missingWrite.status, 'error');
  assert.equal(missingWrite.code, 'missing-dependency');
  assert.equal(missingWrite.step, 'choice');
});

test('跳过却没有「未解决」存储：在拉取之前就停下，不产生任何副作用', async () => {
  const plan = mixedPlan();
  const { deps, calls } = makeDeps();
  delete deps.saveUnresolved;
  const result = await runSync({ plan, choices: { conf: 'skip' }, deps, at: AT });

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'missing-dependency');
  assert.equal(result.step, 'unresolved');
  assert.deepEqual(flow(calls), []);
});

test('没有「未解决」要记时，缺存储实现不妨碍正常同步', async () => {
  const plan = mixedPlan();
  const { deps } = makeDeps({ remoteDocs: { conf: '远端版本' } });
  delete deps.loadUnresolved;
  delete deps.saveUnresolved;
  const result = await runSync({ plan, choices: { conf: 'remote' }, deps, at: AT });

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.pushed, ['mine']);
  assert.deepEqual(result.unresolved, []);
});

test('计划不可用：直接返回原因，不跑拉取', async () => {
  const unavailable = syncPlan({ local: [doc('a', 1)] });
  const { deps, calls } = makeDeps();
  const result = await runSync({ plan: unavailable, deps, at: AT });

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'plan-unavailable');
  assert.equal(calls.length, 0);

  const nothing = await runSync({ deps, at: AT });
  assert.equal(nothing.code, 'invalid-plan');
});

test('没有要同步的内容：拉一次即可，不调用推送', async () => {
  const plan = syncPlan({ local: [], remote: [] });
  const { deps, calls } = makeDeps();
  const result = await runSync({ plan, deps, at: AT });

  assert.equal(result.status, 'ok');
  assert.deepEqual(flow(calls), ['pull']);
  assert.deepEqual(calls.find(([name]) => name === 'pull')[1], { pull: [], archived: [] });
  assert.equal(result.text, '同步完成：拉取 0 篇，推送 0 篇。');
});

test('认不出的选择：在任何副作用之前拒绝', async () => {
  const plan = mixedPlan();
  const { deps, calls } = makeDeps();
  const result = await runSync({ plan, choices: { conf: 'merge-both' }, deps, at: AT });

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'invalid-choice');
  assert.equal(calls.length, 0);
  assert.deepEqual([...SYNC_CHOICES], ['remote', 'local', 'both', 'skip']);
  assert.deepEqual(Object.keys(SYNC_CHOICE_LABELS), [...SYNC_CHOICES]);
});

test('四选一每个选择都有非空的人读说明（会话记录用）', async () => {
  for (const choice of SYNC_CHOICES) {
    const plan = mixedPlan();
    const { deps } = makeDeps({ localDocs: { conf: '本地' }, remoteDocs: { conf: '远端' } });
    const result = await runSync({ plan, choices: { conf: choice }, deps, at: AT });
    assert.equal(result.status, 'ok', choice);
    const record = result.records.find((entry) => entry.id === 'conf');
    assert.ok(record, choice);
    assert.ok(record.summary.length > 0, choice);
  }
});

test('mergeConflictText：没有差异时只留一份正文', () => {
  const merged = mergeConflictText({ id: 'x', local: '# 标题\n\n正文', remote: '# 标题\n\n正文' });
  assert.equal(merged.split('# 标题').length - 1, 1);
  assert.equal(merged.split('正文').length - 1, 1);
  assert.ok(merged.includes('两段都留'));
});

test('mergeConflictText：两边都空时返回空串，不生出占位正文', () => {
  assert.equal(mergeConflictText({ id: 'x', local: '', remote: '' }), '');
  assert.equal(mergeConflictText(), '');
});
