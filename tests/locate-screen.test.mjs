// #139 定位屏：关注顺序、待确认归因、未读只读预览、读不到时的「未知」。
//
// 测在模块的公开边界上：src/memory/locate-screen.mjs 只吃项目清单与已经算好的注意力数据，
// src/memory/since-last-seen.mjs 的 previewSinceLastSeen 只读水位。界面（DOM）由 e2e 验收，
// 这里不重复断言渲染代码。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryWatermarkStore } from '../src/memory/watermark.mjs';
import { previewSinceLastSeen } from '../src/memory/since-last-seen.mjs';
import {
  STALE_DAYS,
  pendingCountsOf,
  unreadCountsOf,
  latestDecisionsOf,
  locateScreenView
} from '../src/memory/locate-screen.mjs';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'locate-screen-test-'));

const withDb = async (fn) => {
  const dir = makeTempDir();
  try { return await fn(path.join(dir, 'owner.sqlite')); } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
};

const NOW = '2026-11-26T12:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;

/** 已知的未读计数：total 是三类之和，与 change-window 的口径一致。 */
const unread = (commits, dirty, events) => ({
  commits,
  dirty,
  events,
  total: commits + dirty + events,
  known: true,
  partial: false,
  unknownText: '',
  watermark: { known: true, at: '2026-11-01T00:00:00.000Z' }
});

/** 三类都读不到：计数必须是 null，不能写 0。 */
const UNKNOWN_UNREAD = unreadCountsOf({ probes: {}, counts: {}, watermark: { known: false } });

const project = (id, name = id) => ({ id, name });

const rowOf = (view, id) => view.projects.find((row) => row.projectId === id);

test('关注顺序：待确认 > 有未读 > 超过 7 天未看 > 其余', () => {
  const projects = [project('rest'), project('stale'), project('unread'), project('pending')];
  const pending = { pending: { knowledge: 1, decisions: 1, total: 2 } };
  const attention = {
    rest: { unread: unread(0, 0, 0), lastReadAt: '2026-11-25T12:00:00.000Z', latestDecision: null },
    // 15 天前看过：超过 7 天，属于「陈旧」。
    stale: { unread: unread(0, 0, 0), lastReadAt: '2026-11-11T12:00:00.000Z', latestDecision: null },
    unread: { unread: unread(2, 1, 0), lastReadAt: '2026-11-25T12:00:00.000Z', latestDecision: null },
    pending: { unread: unread(0, 0, 0), lastReadAt: '2026-11-25T12:00:00.000Z', latestDecision: null }
  };

  const view = locateScreenView({ projects, pending, attention, now: NOW });
  assert.deepEqual(view.projects.map((row) => row.projectId), ['pending', 'unread', 'stale', 'rest']);
  assert.equal(rowOf(view, 'pending').tier, 'pending');
  assert.equal(rowOf(view, 'unread').tier, 'unread');
  assert.equal(rowOf(view, 'stale').tier, 'stale');
  assert.equal(rowOf(view, 'rest').tier, 'rest');
  // 行内写清它为什么排在这里。
  assert.match(rowOf(view, 'pending').tierLabel, /待确认/u);
  assert.equal(rowOf(view, 'unread').tierLabel, '有未读');
  assert.match(rowOf(view, 'stale').tierLabel, /天未看/u);
  assert.equal(view.counts.projects, 4);
  assert.equal(view.counts.pendingProjects, 1);
  assert.equal(view.counts.unreadProjects, 1);
  assert.equal(view.counts.staleProjects, 1);
});

test('同级排序确定：待确认多的在前，未读多的在前，陈旧最久的在前', () => {
  const projects = [project('a'), project('b'), project('c')];
  const pending = {
    a: { knowledge: 1, decisions: 0, total: 1 },
    b: { knowledge: 0, decisions: 3, total: 3 },
    c: { knowledge: 1, decisions: 0, total: 1 }
  };
  const attention = {
    a: { unread: unread(1, 0, 0), lastReadAt: '2026-11-01T00:00:00.000Z' },
    b: { unread: unread(0, 0, 0), lastReadAt: '2026-11-02T00:00:00.000Z' },
    c: { unread: unread(5, 0, 0), lastReadAt: '2026-11-03T00:00:00.000Z' }
  };
  const view = locateScreenView({ projects, pending, attention, now: NOW });
  assert.deepEqual(view.projects.map((row) => row.projectId), ['b', 'c', 'a']);
});

test('7 天阈值：正好 7 天不算陈旧，超过 1 秒才算', () => {
  assert.equal(STALE_DAYS, 7);
  const sevenDays = new Date(Date.parse(NOW) - 7 * DAY).toISOString();
  const overSeven = new Date(Date.parse(NOW) - 7 * DAY - 1000).toISOString();
  const view = locateScreenView({
    projects: [project('exact'), project('over')],
    attention: {
      exact: { unread: unread(0, 0, 0), lastReadAt: sevenDays },
      over: { unread: unread(0, 0, 0), lastReadAt: overSeven }
    },
    now: NOW
  });
  assert.equal(rowOf(view, 'exact').tier, 'rest');
  assert.equal(rowOf(view, 'over').tier, 'stale');
  assert.equal(rowOf(view, 'over').stale, true);
  assert.equal(rowOf(view, 'exact').stale, false);
});

test('从未看过按陈旧处理，但行内写「从未看过」而不是假装看过', () => {
  const view = locateScreenView({
    projects: [project('fresh')],
    attention: { fresh: { unread: unread(0, 0, 0), lastReadAt: '' } },
    now: NOW
  });
  const row = rowOf(view, 'fresh');
  assert.equal(row.tier, 'stale');
  assert.equal(row.lastReadLabel, '从未看过');
  assert.equal(row.lastReadAt, '');
});

test('待确认归因：知识候选按项目或来源经验归到项目，决策候选走 #135 的待办摘要', () => {
  const lessons = [
    { id: 'lesson-a', projectId: 'alpha' },
    { id: 'lesson-b', projectId: 'beta' }
  ];
  const proposals = [
    // 项目层候选：payload 自带项目。
    { id: 'p1', status: 'pending', payload: { projectId: 'alpha' }, meta: { contract: 'knowledge-candidate/v1', sourceLessonIds: ['lesson-a'] } },
    // 应用层候选：没有 payload.projectId，靠来源经验归因。
    { id: 'p2', status: 'pending', payload: { projectId: null, layer: 'applied' }, meta: { contract: 'knowledge-candidate/v1', sourceLessonIds: ['lesson-b'] } },
    // 域级候选，没有来源经验：不归到任何项目，也不能把它算到第一个项目头上。
    { id: 'p3', status: 'pending', payload: { projectId: null, layer: 'domain' }, meta: { contract: 'knowledge-candidate/v1', sourceLessonIds: [] } },
    // 动作级确认不是记忆候选：不进「待确认」。
    { id: 'a1', status: 'pending', payload: { projectId: 'alpha' }, meta: { contract: 'write-confirm/v1' } },
    // 已审过的不算待确认。
    { id: 'p4', status: 'approved', payload: { projectId: 'alpha' }, meta: { contract: 'knowledge-candidate/v1' } }
  ];
  const decisionSummary = {
    total: 1,
    projects: [{ projectId: 'beta', count: 1, items: [{ fingerprint: 'd1', title: '重试上限' }] }]
  };

  const { byProject } = pendingCountsOf({ proposals, lessons, decisionSummary });
  assert.deepEqual(byProject.alpha, { knowledge: 1, decisions: 0, total: 1 });
  assert.deepEqual(byProject.beta, { knowledge: 1, decisions: 1, total: 2 });
  // 域级候选没有归属：不凭空落到某个项目。
  assert.equal(byProject.gamma, undefined);
});

test('一条候选被多个项目的经验共同支撑时，每个项目各记一条待确认', () => {
  const lessons = [{ id: 'la', projectId: 'alpha' }, { id: 'lb', projectId: 'beta' }];
  const proposals = [{
    id: 'shared', status: 'pending', payload: { projectId: null, layer: 'applied' },
    meta: { contract: 'knowledge-candidate/v1', sourceLessonIds: ['la', 'lb'] }
  }];
  const { byProject } = pendingCountsOf({ proposals, lessons, decisionSummary: null });
  assert.equal(byProject.alpha.knowledge, 1);
  assert.equal(byProject.beta.knowledge, 1);
});

test('最近一条决策：项目自己的决策优先，没有时才用域级决策兜底', () => {
  const decisions = [
    { id: 'd-domain', scope: 'domain', projectId: null, title: '同步冲突交人', updatedAt: '2026-11-26T00:00:00.000Z' },
    { id: 'd-alpha', scope: 'project', projectId: 'alpha', title: '重试上限 7 次', updatedAt: '2026-11-20T00:00:00.000Z' }
  ];
  const latest = latestDecisionsOf({ decisions, projects: [project('alpha'), project('beta')] });
  assert.equal(latest.alpha.title, '重试上限 7 次');
  // beta 没有自己的决策：域级决策对它同样生效，照实显示。
  assert.equal(latest.beta.title, '同步冲突交人');
  assert.equal(latest.beta.id, 'd-domain');
});

test('未读预览用旧水位算差异，且绝不写新水位', () => withDb(async (dbPath) => {
  const store = new MemoryWatermarkStore({ dbPath });
  try {
    const OLD = '2026-11-01T00:00:00.000Z';
    store.put('alpha', OLD);
    // 只给 get 的存储：预览如果偷偷调 put 会直接报错。
    const readOnly = {
      get: (id) => store.get(id),
      put: () => { throw new Error('预览不能推进水位'); }
    };
    const commits = [
      { sha: 'old', subject: '看过了', at: '2026-10-20T00:00:00.000Z' },
      { sha: 'new1', subject: '新的提交', at: '2026-11-05T00:00:00.000Z' }
    ];
    const dirty = [{ path: 'src/a.mjs', status: 'M' }];
    const events = [{ id: 'e1', type: 'stale', detectedAt: '2026-11-06T00:00:00.000Z', projectId: 'alpha' }];

    const first = previewSinceLastSeen({ projectId: 'alpha', store: readOnly, commits, dirty, events });
    assert.equal(first.previousAt, OLD);
    assert.equal(first.view.counts.commits, 1);
    assert.equal(first.view.counts.dirty, 1);
    assert.equal(first.view.counts.events, 1);

    // 再算一次仍是同一批变化：没有推进水位，差异不会被自己吃掉。
    const second = previewSinceLastSeen({ projectId: 'alpha', store: readOnly, commits, dirty, events });
    assert.deepEqual(second.view.counts, first.view.counts);
    assert.equal(store.get('alpha').at, OLD);
    assert.deepEqual(store.list().map((row) => row.at), [OLD]);
  } finally { store.close(); }
}));

test('没有水位时未读是「未知」，不是 0；已有水位时按三类计数', () => withDb(async (dbPath) => {
  const store = new MemoryWatermarkStore({ dbPath });
  try {
    const first = previewSinceLastSeen({
      projectId: 'alpha', store, commits: [], dirty: [], events: []
    });
    const unknown = unreadCountsOf(first.view);
    assert.equal(unknown.commits, null);
    assert.equal(unknown.dirty, 0);
    assert.equal(unknown.events, null);
    assert.equal(unknown.total, null);
    assert.equal(unknown.known, false);
    assert.match(unknown.unknownText, /水位/u);
  } finally { store.close(); }
}));

test('读不到变化的项目标「未知」，不写成 0，也不拖垮整屏', () => {
  // 提交与事件读不到、改动读得到：未知的那两类写「未知」，已知的 0 照常是 0。
  const partialUnknown = unreadCountsOf({
    probes: { commits: { ok: false }, dirty: { ok: true }, events: { ok: false } },
    counts: { commits: 0, dirty: 0, events: 0 },
    watermark: { known: false }
  });
  const view = locateScreenView({
    projects: [project('broken'), project('quiet')],
    attention: {
      broken: { unread: partialUnknown, lastReadAt: '2026-11-25T00:00:00.000Z' },
      quiet: { unread: unread(0, 0, 0), lastReadAt: '2026-11-25T00:00:00.000Z' }
    },
    now: NOW
  });
  assert.equal(view.projects.length, 2, '一行读不到不能把列表折叠掉');
  const broken = rowOf(view, 'broken');
  assert.equal(broken.unread.commits, null);
  assert.equal(broken.unread.total, null);
  assert.match(broken.unreadLabel, /未知/u);
  assert.doesNotMatch(broken.unreadLabel, /0 提交/u);
  assert.match(broken.unreadLabel, /0 改动/u, '读得到的类别照常显示');
  assert.equal(rowOf(view, 'quiet').unreadLabel, '没有未读变化');
});

test('#139 部分可读也算未读：已知一类 > 0、另一类未知时进「有未读」档', () => {
  // 提交读得到 2 条，知识（观察员事件）读不到：total 仍是 null，但已经有确定的未读。
  const partial = unreadCountsOf({
    probes: { commits: { ok: true }, dirty: { ok: true }, events: { ok: false } },
    counts: { commits: 2, dirty: 0, events: 0 },
    watermark: { known: true, at: '2026-11-01T00:00:00.000Z' }
  });
  assert.equal(partial.total, null);
  assert.equal(partial.commits, 2);
  assert.equal(partial.events, null);

  const view = locateScreenView({
    projects: [project('partial'), project('quiet'), project('few')],
    attention: {
      partial: { unread: partial, lastReadAt: '2026-11-25T12:00:00.000Z' },
      quiet: { unread: unread(0, 0, 0), lastReadAt: '2026-11-25T12:00:00.000Z' },
      // 三类都读得到、共 3 条：与 partial 同级，按「已知三类之和」比大小。
      few: { unread: unread(1, 1, 1), lastReadAt: '2026-11-25T12:00:00.000Z' }
    },
    now: NOW
  });
  const partialRow = rowOf(view, 'partial');
  assert.equal(partialRow.tier, 'unread', '已知提交 > 0 就足以算有未读，不能被未知的知识压回陈旧');
  assert.match(partialRow.unreadLabel, /2 提交/u);
  assert.match(partialRow.unreadLabel, /未知 知识/u);
  assert.equal(rowOf(view, 'quiet').tier, 'rest');
  // 同级排序用已知计数之和：2 > 3 不成立，所以 few（3）在前，partial（2，未知部分不计）在后。
  assert.deepEqual(
    view.projects.filter((row) => row.tier === 'unread').map((row) => row.projectId),
    ['few', 'partial']
  );
});

test('切换项目不清零：重复取同一次注意力数据，未读与水位都不变', () => withDb(async (dbPath) => {
  const store = new MemoryWatermarkStore({ dbPath });
  try {
    const OLD = '2026-11-01T00:00:00.000Z';
    store.put('alpha', OLD);
    store.put('beta', OLD);
    const commits = [{ sha: 'new1', subject: '新的提交', at: '2026-11-05T00:00:00.000Z' }];
    const attention = {};
    for (const id of ['alpha', 'beta']) {
      const { view } = previewSinceLastSeen({
        projectId: id, store, commits, dirty: [], events: []
      });
      attention[id] = { unread: unreadCountsOf(view), lastReadAt: OLD };
    }
    const before = locateScreenView({
      projects: [project('alpha'), project('beta')], attention, now: NOW
    });
    // 「切到 alpha」只是界面状态：再取一次同一份数据，A/B 的未读都必须原样。
    const after = locateScreenView({
      projects: [project('alpha'), project('beta')], attention, now: NOW
    });
    assert.deepEqual(after.projects, before.projects);
    assert.equal(rowOf(after, 'alpha').unread.total, 1);
    assert.equal(rowOf(after, 'beta').unread.total, 1);
    assert.deepEqual(store.list().map((row) => row.at), [OLD, OLD]);
  } finally { store.close(); }
}));

test('空态：没有项目与全部安静都读得懂', () => {
  const none = locateScreenView({ projects: [], now: NOW });
  assert.equal(none.empty.kind, 'no-project');
  assert.match(none.empty.title, /还没有登记项目/u);
  assert.deepEqual(none.projects, []);

  const quiet = locateScreenView({
    projects: [project('alpha', 'Alpha')],
    attention: { alpha: { unread: unread(0, 0, 0), lastReadAt: '2026-11-25T12:00:00.000Z', latestDecision: null } },
    now: NOW
  });
  assert.equal(quiet.empty, null);
  const row = rowOf(quiet, 'alpha');
  assert.equal(row.pendingLabel, '没有待确认');
  assert.equal(row.unreadLabel, '没有未读变化');
  assert.equal(row.decisionLabel, '最近决策：没有决策记录');
  assert.equal(row.lastReadLabel, '昨天看过');
});

test('未选项目的主内容已改为定位屏：旧的全局聚合通道不再接到主进程', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const main = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'desktop/preload.cjs'), 'utf8');
  const header = fs.readFileSync(path.join(root, 'desktop/shell-header.cjs'), 'utf8');
  assert.match(main, /companion:locate-attention/u);
  assert.match(main, /previewSinceLastSeen/u, '主进程只能用只读预览算未读');
  assert.equal(main.includes('companion:card-global-library'), false, '全局聚合通道应随聚合屏一起撤掉');
  assert.match(preload, /locate: Object\.freeze\(\{[\s\S]*?companion:locate-attention/u);
  assert.equal(preload.includes('card-global-library'), false);
  assert.match(header, /loadLocate/u);
  assert.equal(header.includes('globalLibrary'), false, '定位屏不能再读聚合');
  assert.equal(header.includes('sinceLastSeen'), false, '切换项目不能碰推进水位的通道');
});
