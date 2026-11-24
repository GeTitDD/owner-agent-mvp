import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { OwnerStore } from '../src/owner-store.mjs';
import { ObserverStore } from '../src/observer/store.mjs';
import { createWorkbenchServer } from '../src/workbench-server.mjs';
import { buildBoardViewModel } from '../src/observer/board.mjs';
import { makeRepo, makeTempDir } from './helpers/observer-fixture.mjs';
import { request, requestJson } from './helpers/observer-http.mjs';

const DAY_MS = 86_400_000;

// 观察台是纯 HTTP 能力：测试只经 workbench 端口访问，不启动 Electron、不读本机用户数据。
// 阈值文件显式指向临时目录，避免读到本机 ~/.owner-agent/thresholds.json 造成不确定性。
const withBoard = async (fn) => {
  const dir = makeTempDir('observer-board-');
  const dbPath = path.join(dir, 'board.sqlite');
  const thresholdsPath = path.join(dir, 'thresholds.json');
  const previous = process.env.OWNER_OBSERVER_THRESHOLDS;
  process.env.OWNER_OBSERVER_THRESHOLDS = thresholdsPath;
  const workbench = await createWorkbenchServer({ port: 0, dbPath });
  const { port } = await workbench.listen();
  try {
    return await fn({ base: `http://127.0.0.1:${port}`, dbPath, dir, thresholdsPath });
  } finally {
    await workbench.close();
    if (previous === undefined) delete process.env.OWNER_OBSERVER_THRESHOLDS;
    else process.env.OWNER_OBSERVER_THRESHOLDS = previous;
    await rm(dir, { recursive: true, force: true });
  }
};

// 事件登记沿用 #27 的 ObserverStore：#31 只读，不另建一套事件表。
const recordStaleEvent = (dbPath, overrides = {}) => {
  const store = new ObserverStore(dbPath);
  try {
    return store.recordEvent({
      type: 'stale',
      fingerprint: 'a'.repeat(64),
      projectId: 'obs-alpha',
      projectName: 'Alpha 仓库',
      branch: 'main',
      branchLabel: 'main',
      head: 'b'.repeat(40),
      lastCommitAt: new Date(Date.now() - 4 * DAY_MS).toISOString(),
      daysStale: 4,
      detectedAt: new Date().toISOString(),
      ...overrides
    });
  } finally {
    store.close();
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

test('观察台首屏返回全部已登记项目的卡片，每张含最近事件与风险徽章', () => withBoard(async ({ base, dbPath, dir }) => {
  const alphaRoot = makeRepo({ root: path.join(dir, 'alpha') });
  const betaRoot = makeRepo({ root: path.join(dir, 'beta') });
  register(dbPath, [
    { id: 'obs-alpha', name: 'Alpha 仓库', root: alphaRoot },
    { id: 'obs-beta', name: 'Beta 仓库', root: betaRoot }
  ]);
  recordStaleEvent(dbPath);

  const page = await request(base, '/observer');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  const html = page.body;
  // 首屏 HTML 自带卡片，不靠客户端再发一次请求（T5「首屏渲染不含阻塞请求」）。
  assert.match(html, /Alpha 仓库/);
  assert.match(html, /Beta 仓库/);
  assert.match(html, /obs-alpha/);
  assert.match(html, /停滞/, '有停滞事件的项目要显示风险徽章');
  assert.match(html, /未观测/, '没有事件的项目要明确标成未观测而不是假装健康');
  assert.match(html, /今日事件/);
  // 样式与页面分开走静态路由，CSP 不允许内联脚本，页面本身不发外部请求。
  assert.match(page.headers['content-security-policy'], /style-src 'self'/);
  const css = await request(base, '/observer.css');
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);

  const board = await requestJson(base, '/api/observer/board');
  assert.equal(board.projects.length, 2);
  assert.match(board.date, /^\d{4}-\d{2}-\d{2}$/);

  const alpha = board.projects.find((p) => p.id === 'obs-alpha');
  assert.equal(alpha.name, 'Alpha 仓库');
  assert.match(alpha.root, /alpha$/i);
  assert.equal(alpha.branch, 'main');
  assert.equal(alpha.risk.level, 'stale');
  assert.equal(alpha.risk.label, '停滞');
  assert.equal(alpha.lastEvent.type, 'stale');
  assert.equal(alpha.lastEvent.typeLabel, '停滞');
  assert.equal(alpha.lastEvent.daysStale, 4);
  assert.equal(alpha.daysStale, 4);

  const beta = board.projects.find((p) => p.id === 'obs-beta');
  assert.equal(beta.branch, '');
  assert.equal(beta.lastEvent, null);
  assert.equal(beta.risk.level, 'unknown');

  // 最危险的项目排最前，支撑「10 秒内指出最危险项目」。
  assert.equal(board.projects[0].id, 'obs-alpha');

  assert.equal(board.events.length, 1);
  assert.equal(board.events[0].projectId, 'obs-alpha');
  assert.equal(board.events[0].typeLabel, '停滞');
  assert.equal(board.events[0].projectName, 'Alpha 仓库');
}));

test('事件流按发生时间倒序且只含当天；卡片仍用最近一次事件，不受当天过滤影响', () => withBoard(async ({ base, dbPath, dir }) => {
  const alphaRoot = makeRepo({ root: path.join(dir, 'alpha') });
  const gammaRoot = makeRepo({ root: path.join(dir, 'gamma') });
  register(dbPath, [
    { id: 'obs-alpha', name: 'Alpha 仓库', root: alphaRoot },
    { id: 'obs-gamma', name: 'Gamma 仓库', root: gammaRoot }
  ]);
  const now = Date.now();
  recordStaleEvent(dbPath, {
    fingerprint: '1'.repeat(64), branch: 'main', branchLabel: 'main', head: 'c'.repeat(40),
    daysStale: 5, detectedAt: new Date(now - 60_000).toISOString()
  });
  recordStaleEvent(dbPath, {
    fingerprint: '2'.repeat(64), branch: 'release', branchLabel: 'release', head: 'd'.repeat(40),
    daysStale: 9, detectedAt: new Date(now).toISOString()
  });
  // 昨天的历史事件：不进「当天事件流」，但仍然是该项目卡片上最近的事实。
  recordStaleEvent(dbPath, {
    fingerprint: '3'.repeat(64), projectId: 'obs-gamma', projectName: 'Gamma 仓库',
    daysStale: 12, detectedAt: new Date(now - DAY_MS).toISOString()
  });

  const board = await requestJson(base, '/api/observer/board');
  assert.deepEqual(board.events.map((e) => e.daysStale), [9, 5], '当天事件按时间倒序');
  const alpha = board.projects.find((p) => p.id === 'obs-alpha');
  assert.equal(alpha.branch, 'release', '卡片用最近一次事件的分支');
  assert.equal(alpha.daysStale, 9);
  const gamma = board.projects.find((p) => p.id === 'obs-gamma');
  assert.equal(gamma.risk.level, 'stale', '昨天的事件仍会驱动卡片风险徽章');
  assert.equal(gamma.daysStale, 12);
}));

test('空库时观察台给出空状态而不是报错或伪造项目', () => withBoard(async ({ base }) => {
  const page = await request(base, '/observer');
  assert.equal(page.status, 200);
  const html = page.body;
  assert.match(html, /还没有登记项目/);
  assert.match(html, /今日暂无事件/);
  assert.doesNotMatch(html, /<article class="card/);

  const board = await requestJson(base, '/api/observer/board');
  assert.deepEqual(board.projects, []);
  assert.deepEqual(board.events, []);
}));

test('风险徽章按阈值对比审计库里的停滞天数，不另做一套判断', () => {
  const events = [{
    id: 'e1', projectId: 'obs-alpha', projectName: 'Alpha 仓库', type: 'stale',
    branchLabel: 'main', daysStale: 4, detectedAt: new Date().toISOString()
  }];
  const projects = [{ id: 'obs-alpha', name: 'Alpha 仓库', root: '/tmp/alpha', status: 'active' }];

  const strict = buildBoardViewModel({ projects, events, thresholdDays: 3 });
  assert.equal(strict.projects[0].risk.level, 'stale');
  const loose = buildBoardViewModel({ projects, events, thresholdDays: 7 });
  assert.equal(loose.projects[0].risk.level, 'watch');
  assert.equal(loose.projects[0].risk.label, '关注');
  assert.throws(() => buildBoardViewModel({ projects, events, thresholdDays: -1 }), /Invalid stale threshold/);
});

test('观察台阈值与命令行同源：改 thresholds.json 后徽章与页面同步变化', () => withBoard(async ({
  base, dbPath, dir, thresholdsPath
}) => {
  register(dbPath, [{ id: 'obs-alpha', name: 'Alpha 仓库', root: makeRepo({ root: path.join(dir, 'alpha') }) }]);
  recordStaleEvent(dbPath);

  let board = await requestJson(base, '/api/observer/board');
  assert.equal(board.projects[0].risk.level, 'stale', '默认阈值 3 天时 4 天算停滞');
  assert.equal(board.thresholds.staleDays, 3);

  // 配置文件抬高阈值：页面不是固定在 3/10/20，而是与 CLI 读同一份配置。
  fs.writeFileSync(thresholdsPath, JSON.stringify({ staleDays: 7 }));
  board = await requestJson(base, '/api/observer/board');
  assert.equal(board.thresholds.staleDays, 7);
  assert.equal(board.projects[0].risk.level, 'watch');
  assert.equal(board.projects[0].risk.label, '关注');

  const html = (await request(base, '/observer')).body;
  assert.match(html, /阈值 7 天/);
  assert.match(html, /badge badge-watch/);
}));

test('登记新项目后重新打开页面就能看到，观察台不缓存结论', () => withBoard(async ({ base, dbPath, dir }) => {
  const firstRoot = makeRepo({ root: path.join(dir, 'first') });
  register(dbPath, [{ id: 'obs-first', name: 'First', root: firstRoot }]);
  let board = await requestJson(base, '/api/observer/board');
  assert.equal(board.projects.length, 1);

  const secondRoot = makeRepo({ root: path.join(dir, 'second') });
  register(dbPath, [{ id: 'obs-second', name: 'Second', root: secondRoot }]);
  board = await requestJson(base, '/api/observer/board');
  assert.deepEqual(board.projects.map((p) => p.id).sort(), ['obs-first', 'obs-second']);
}));
