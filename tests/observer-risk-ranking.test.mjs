import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { buildBoardViewModel, renderBoardPage } from '../src/observer/board.mjs';
import { ObserverStore } from '../src/observer/store.mjs';
import { OwnerStore } from '../src/owner-store.mjs';
import { createWorkbenchServer } from '../src/workbench-server.mjs';
import { makeRepo, makeTempDir } from './helpers/observer-fixture.mjs';
import { request, requestJson } from './helpers/observer-http.mjs';

const DETECTED = '2026-11-24T09:30:00+08:00';
const DAY_MS = 86_400_000;

// 观察台视图模型是纯函数：这里直接喂审计库里的事件行，不经 git、不碰网络。
const event = (overrides = {}) => ({
  id: `e-${overrides.type ?? 'stale'}-${overrides.projectId ?? 'p'}`,
  type: 'stale',
  projectId: 'p',
  projectName: 'P',
  branch: 'main',
  branchLabel: 'main',
  head: 'a'.repeat(40),
  lastCommitAt: null,
  daysStale: 0,
  trunkRef: null,
  behindTrunk: 0,
  uncommittedFiles: 0,
  detectedAt: DETECTED,
  ...overrides
});

// 验收走真实 HTTP：登记项目、写审计库、刷新页面，确认排序不是只在纯函数里成立。
const withBoard = async (fn) => {
  const dir = makeTempDir('observer-risk-');
  const dbPath = path.join(dir, 'board.sqlite');
  const previous = process.env.OWNER_OBSERVER_THRESHOLDS;
  process.env.OWNER_OBSERVER_THRESHOLDS = path.join(dir, 'thresholds.json');
  const workbench = await createWorkbenchServer({ port: 0, dbPath });
  const { port } = await workbench.listen();
  try {
    return await fn({ base: `http://127.0.0.1:${port}`, dbPath, dir });
  } finally {
    await workbench.close();
    if (previous === undefined) delete process.env.OWNER_OBSERVER_THRESHOLDS;
    else process.env.OWNER_OBSERVER_THRESHOLDS = previous;
    await rm(dir, { recursive: true, force: true });
  }
};

const register = (dbPath, projects) => {
  const owner = new OwnerStore(dbPath);
  try {
    for (const project of projects) owner.registerProject(project);
  } finally {
    owner.close();
  }
};

const recordEvents = (dbPath, events) => {
  const store = new ObserverStore(dbPath);
  try {
    for (const item of events) store.recordEvent(item);
  } finally {
    store.close();
  }
};

test('漂移与积压事件各有自己的徽章，不再显示原始类型名或「未知」', () => {
  const view = buildBoardViewModel({
    projects: [
      { id: 'p-drift', name: '漂移项目' },
      { id: 'p-backlog', name: '积压项目' }
    ],
    events: [
      event({
        type: 'drift', projectId: 'p-drift', projectName: '漂移项目', branch: 'feature',
        branchLabel: 'feature', trunkRef: 'main', behindTrunk: 12
      }),
      event({ type: 'backlog', projectId: 'p-backlog', projectName: '积压项目', uncommittedFiles: 25 })
    ]
  });

  const drift = view.projects.find((project) => project.id === 'p-drift');
  assert.equal(drift.lastEvent.typeLabel, '漂移');
  assert.equal(drift.risk.level, 'drift');
  assert.equal(drift.risk.label, '漂移');
  assert.equal(drift.risk.badge, '漂移 12 提交');

  const backlog = view.projects.find((project) => project.id === 'p-backlog');
  assert.equal(backlog.lastEvent.typeLabel, '积压');
  assert.equal(backlog.risk.level, 'backlog');
  assert.equal(backlog.risk.badge, '积压 25 文件');
  // 卡片不能只看「最近事件」：漂移与积压各自成一条风险信号。
  assert.deepEqual(backlog.risk.signals.map((signal) => signal.type), ['backlog']);
});

test('同时停滞与积压的项目排第一位，顶部给出项目名与一句原因', () => {
  const view = buildBoardViewModel({
    projects: [
      { id: 'p-stale', name: '单停滞项目' },
      { id: 'p-both', name: '双信号项目' },
      { id: 'p-clean', name: '未观测项目' }
    ],
    events: [
      event({
        id: 'e-stale', type: 'stale', projectId: 'p-stale', projectName: '单停滞项目',
        daysStale: 30, lastCommitAt: '2026-10-25T09:00:00+08:00',
        detectedAt: '2026-11-24T08:00:00+08:00'
      }),
      // 双信号项目的最近一条事件是积压，停滞更早：只看「最近事件」会漏掉停滞。
      event({
        id: 'e-both-stale', type: 'stale', projectId: 'p-both', projectName: '双信号项目',
        daysStale: 4, lastCommitAt: '2026-11-20T09:00:00+08:00',
        detectedAt: '2026-11-24T09:00:00+08:00'
      }),
      event({
        id: 'e-both-backlog', type: 'backlog', projectId: 'p-both', projectName: '双信号项目',
        uncommittedFiles: 25, detectedAt: '2026-11-24T09:15:00+08:00'
      })
    ]
  });

  assert.deepEqual(view.projects.map((project) => project.id), ['p-both', 'p-stale', 'p-clean']);
  const both = view.projects[0];
  assert.equal(both.risk.level, 'critical');
  assert.equal(both.risk.score, 2);
  assert.equal(both.risk.badge, '停滞 4 天 · 积压 25 文件');
  // 多个信号同时存在时，停滞天数不能被「最近那条积压」覆盖成 0。
  assert.equal(both.daysStale, 4);

  assert.equal(view.headline.kind, 'risk');
  assert.equal(view.headline.projectId, 'p-both');
  assert.equal(view.headline.projectName, '双信号项目');
  assert.equal(view.headline.reason, '同时停滞 4 天、积压 25 个未提交文件');
  assert.equal(view.riskCount, 2);
});

test('页面顶部渲染结论卡片，无风险时渲染明确的空状态', () => {
  const risky = buildBoardViewModel({
    projects: [
      { id: 'p-both', name: '双信号项目' },
      { id: 'p-backlog', name: '积压项目' }
    ],
    events: [
      event({ type: 'stale', projectId: 'p-both', projectName: '双信号项目', daysStale: 4 }),
      event({
        type: 'backlog', projectId: 'p-both', projectName: '双信号项目', uncommittedFiles: 25,
        detectedAt: '2026-11-24T09:40:00+08:00'
      }),
      event({
        type: 'backlog', projectId: 'p-backlog', projectName: '积压项目', uncommittedFiles: 25
      })
    ]
  });
  const html = renderBoardPage(risky);
  assert.match(html, /最该看的项目/);
  assert.match(html, /双信号项目/);
  assert.match(html, /同时停滞 4 天、积压 25 个未提交文件/);
  assert.match(html, /badge badge-critical/);
  // 事件流里漂移 / 积压不再套用「未知」样式。
  assert.match(html, /badge badge-backlog/);
  assert.match(html, /25 文件/);

  const clean = buildBoardViewModel({
    projects: [{ id: 'p-clean', name: '未观测项目' }],
    events: []
  });
  const cleanHtml = renderBoardPage(clean);
  assert.match(cleanHtml, /最该看的项目/);
  assert.match(cleanHtml, /当前没有越过阈值的风险项目/);
  assert.match(cleanHtml, /另有 1 个项目从未观测/);
  assert.doesNotMatch(cleanHtml, /attention-name/);
});

test('排序规则：风险分相同则按等级、停滞天数、名称依次决定', () => {
  const view = buildBoardViewModel({
    projects: [
      { id: 'p-a', name: 'Alpha' },
      { id: 'p-b', name: 'Beta' },
      { id: 'p-c', name: 'Gamma' },
      { id: 'p-d', name: 'Delta' },
      { id: 'p-e', name: 'Epsilon' },
      { id: 'p-f', name: 'Zeta' }
    ],
    events: [
      event({ id: 'e-a', projectId: 'p-a', projectName: 'Alpha', daysStale: 4 }),
      event({ id: 'e-b', projectId: 'p-b', projectName: 'Beta', daysStale: 4 }),
      event({ id: 'e-c', projectId: 'p-c', projectName: 'Gamma', daysStale: 30 }),
      event({ id: 'e-d', type: 'backlog', projectId: 'p-d', projectName: 'Delta', uncommittedFiles: 25 }),
      // 停在阈值以下：有观测但未越线，排在越线项目之后、未观测之前。
      event({ id: 'e-f', projectId: 'p-f', projectName: 'Zeta', daysStale: 1 })
    ]
  });

  assert.deepEqual(view.projects.map((project) => project.name),
    ['Gamma', 'Alpha', 'Beta', 'Delta', 'Zeta', 'Epsilon']);
  assert.deepEqual(view.projects.map((project) => project.risk.level),
    ['stale', 'stale', 'stale', 'backlog', 'watch', 'unknown']);
  assert.deepEqual(view.projects.map((project) => project.risk.score), [1, 1, 1, 1, 0, 0]);
});

test('阈值仍然说了算：抬高漂移 / 积压阈值后徽章退回关注，不另做一套判定', () => {
  const events = [
    event({ type: 'drift', projectId: 'p-drift', behindTrunk: 12, trunkRef: 'main' }),
    event({ type: 'backlog', projectId: 'p-backlog', uncommittedFiles: 25 })
  ];
  const projects = [{ id: 'p-drift', name: 'Drift' }, { id: 'p-backlog', name: 'Backlog' }];

  const raised = buildBoardViewModel({
    projects,
    events,
    thresholds: { driftCommits: 20, backlogFiles: 30 }
  });
  assert.equal(raised.projects.find((p) => p.id === 'p-drift').risk.level, 'watch');
  assert.equal(raised.projects.find((p) => p.id === 'p-backlog').risk.level, 'watch');
  assert.equal(raised.riskCount, 0);
  assert.throws(() => buildBoardViewModel({ projects, events, thresholds: { backlogFiles: -1 } }),
    /Invalid backlog threshold/);
});

test('刷新观察台：同时停滞与积压的项目排第一位，顶部直接点名', () => withBoard(async ({
  base, dbPath, dir
}) => {
  const now = Date.now();
  register(dbPath, [
    { id: 'p-both', name: '双信号项目', root: makeRepo({ root: path.join(dir, 'both') }) },
    { id: 'p-stale', name: '单停滞项目', root: makeRepo({ root: path.join(dir, 'stale') }) },
    { id: 'p-clean', name: '未观测项目', root: makeRepo({ root: path.join(dir, 'clean') }) }
  ]);
  recordEvents(dbPath, [
    {
      type: 'stale', fingerprint: '1'.repeat(64), projectId: 'p-both', projectName: '双信号项目',
      branch: 'main', branchLabel: 'main', head: 'a'.repeat(40),
      lastCommitAt: new Date(now - 4 * DAY_MS).toISOString(), daysStale: 4,
      detectedAt: new Date(now - 3_600_000).toISOString()
    },
    {
      type: 'backlog', fingerprint: '2'.repeat(64), projectId: 'p-both', projectName: '双信号项目',
      branch: 'main', branchLabel: 'main', head: 'a'.repeat(40), uncommittedFiles: 25,
      detectedAt: new Date(now - 60_000).toISOString()
    },
    {
      type: 'stale', fingerprint: '3'.repeat(64), projectId: 'p-stale', projectName: '单停滞项目',
      branch: 'main', branchLabel: 'main', head: 'b'.repeat(40),
      lastCommitAt: new Date(now - 30 * DAY_MS).toISOString(), daysStale: 30,
      detectedAt: new Date(now - 7_200_000).toISOString()
    }
  ]);

  const board = await requestJson(base, '/api/observer/board');
  assert.deepEqual(board.projects.map((project) => project.id), ['p-both', 'p-stale', 'p-clean']);
  assert.deepEqual(board.projects[0].risk.signals.map((signal) => signal.type), ['stale', 'backlog']);
  assert.equal(board.headline.projectName, '双信号项目');
  assert.match(board.headline.reason, /同时停滞 4 天/);
  assert.match(board.headline.reason, /积压 25 个未提交文件/);

  // 刷新一次仍然是同一个结论：观察台不缓存结论，也不靠客户端再排一次序。
  const html = (await request(base, '/observer')).body;
  assert.match(html, /<p class="attention-name">双信号项目<\/p>/);
  assert.match(html, /同时停滞 4 天、积压 25 个未提交文件/);
  assert.ok(html.indexOf('双信号项目') < html.indexOf('单停滞项目'), '最危险的项目排在其他项目前面');
}));
