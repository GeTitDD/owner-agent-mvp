// 完整工作台的经验浏览（#136）：只读、按项目与状态筛选、证据可追溯。
//
// 断言只走两个公共边界：HTTP 路由（/api/lessons、/lessons）与视图模型
// （buildLessonsView）。不直接读 SQLite 的内部列，避免测试绑死在存储实现上。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { createWorkbenchServer } from '../src/workbench-server.mjs';
import { buildLessonsView, EVIDENCE_EMPTY_NOTE } from '../src/knowledge/lessons-view.mjs';
import { request, requestJson } from './helpers/observer-http.mjs';

/** 一条项目级经验的最小原料；各用例只改自己关心的字段。 */
const lessonDraft = (overrides = {}) => ({
  projectId: 'alpha',
  sourceRecordId: 'rec-alpha-1',
  phenomenon: '改动迁移脚本后没有重跑本地库',
  mechanism: '启动只执行一次迁移，旧连接缓存了表结构',
  countermeasure: '改 schema 前先断开缓存连接再迁移',
  scope: { layer: 'project', projectId: 'alpha', domainIds: ['pi-sdk'] },
  verificationStatus: 'inferred',
  ...overrides
});

/**
 * 起一个只在 127.0.0.1 上监听的工作台，先落三条有代表性的经验：
 * - 有证据的待验证（alpha）
 * - 完全没有证据的推断（alpha）
 * - 另一个项目的待验证（beta）
 * - 历史脏数据：状态列写着已验证但一条证据行都没有（alpha）
 */
async function withWorkbench(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'workbench-lessons-'));
  const dbPath = path.join(dir, 'knowledge.sqlite');
  const store = new PersonalKnowledgeStore(dbPath);
  const ids = {};
  try {
    ids.withEvidence = store.addLesson(
      lessonDraft({ verificationStatus: 'unverified', evidenceRefs: ['execution:rec-alpha-1:log'] }),
      { evidence: [{ ref: 'execution:rec-alpha-1:log', recordId: 'rec-alpha-1', kind: 'log', excerpt: '迁移在执行前失败：no such column' }] }
    ).id;
    ids.noEvidence = store.addLesson(lessonDraft({
      sourceRecordId: 'rec-alpha-2',
      phenomenon: '同一句报错在另一台机器上复现',
      mechanism: '两台机器的本地库停在不同的迁移版本',
      countermeasure: '先把本地库版本对齐再复现',
      verificationStatus: 'inferred'
    })).id;
    ids.beta = store.addLesson(lessonDraft({
      projectId: 'beta',
      sourceRecordId: 'rec-beta-1',
      phenomenon: 'beta 项目的构建缓存每次都失效',
      mechanism: 'beta 的构建脚本把时间戳写进了缓存键',
      countermeasure: '缓存键只用内容哈希，不用时间戳',
      scope: { layer: 'project', projectId: 'beta', domainIds: ['pi-sdk'] },
      verificationStatus: 'unverified',
      evidenceRefs: ['execution:rec-beta-1:log']
    }), { evidence: [{ ref: 'execution:rec-beta-1:log', recordId: 'rec-beta-1', kind: 'log', excerpt: 'cache miss on every build' }] }).id;
    ids.staleVerified = store.addLesson(lessonDraft({
      sourceRecordId: 'rec-alpha-3',
      phenomenon: '旧版经验被标成已验证却没有任何证据',
      mechanism: '状态列被人工改过，证据表里没有对应行',
      countermeasure: '看状态之前先看证据',
      verificationStatus: 'inferred'
    })).id;
    // 只在测试里伪造历史脏数据：状态列写 verified，证据表空着。
    store.db.prepare('UPDATE knowledge_lessons SET verification_status=? WHERE id=?').run('verified', ids.staleVerified);
  } finally { store.close(); }
  const workbench = await createWorkbenchServer({ port: 0, dbPath });
  const { port } = await workbench.listen();
  try {
    return await fn({ base: `http://127.0.0.1:${port}`, dbPath, ids });
  } finally {
    await workbench.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('经验 JSON 带出现象、机制、对策、来源项目与证据，并标明只读', () => withWorkbench(async ({ base, ids }) => {
  const view = await requestJson(base, '/api/lessons');
  assert.equal(view.readOnly, true);

  const item = view.lessons.find((x) => x.id === ids.withEvidence);
  assert.ok(item, '有证据的经验必须出现在默认视图里');
  assert.equal(item.phenomenon, '改动迁移脚本后没有重跑本地库');
  assert.equal(item.mechanism, '启动只执行一次迁移，旧连接缓存了表结构');
  assert.equal(item.countermeasure, '改 schema 前先断开缓存连接再迁移');
  assert.equal(item.projectId, 'alpha');
  assert.deepEqual(item.projectIds, ['alpha']);
  assert.equal(item.status, 'unverified');
  assert.equal(item.statusLabel, '待验证');
  assert.equal(item.evidenceEmpty, false);
  assert.deepEqual(item.evidence.map((e) => e.ref), ['execution:rec-alpha-1:log']);
  assert.equal(item.evidence[0].excerpt, '迁移在执行前失败：no such column');

  // 状态与项目的可选项由数据推导，供页面直接渲染筛选条。
  assert.deepEqual(view.statuses.map((s) => s.value), ['unverified', 'inferred', 'verified', 'disputed', 'superseded']);
  assert.deepEqual(view.statuses.map((s) => s.label), ['待验证', '推断', '已验证', '争议', '已被取代']);
  assert.deepEqual(view.projects.map((p) => p.id).sort(), ['alpha', 'beta']);
}));

test('经验可以按项目与状态筛选，未知状态直接报错', () => withWorkbench(async ({ base, ids }) => {
  const alpha = await requestJson(base, '/api/lessons?projectId=alpha');
  assert.deepEqual(alpha.lessons.map((x) => x.id).sort(), [ids.withEvidence, ids.noEvidence, ids.staleVerified].sort());
  assert.equal(alpha.filter.projectId, 'alpha');

  const beta = await requestJson(base, '/api/lessons?projectId=beta');
  assert.deepEqual(beta.lessons.map((x) => x.id), [ids.beta]);

  const inferred = await requestJson(base, '/api/lessons?status=inferred');
  assert.equal(inferred.lessons.length > 0, true);
  assert.equal(inferred.lessons.every((x) => x.status === 'inferred'), true);
  // 没证据的「已验证」历史行也归到推断：状态筛选不能把它留在已验证。
  assert.equal(inferred.lessons.some((x) => x.id === ids.staleVerified), true);
  assert.equal(inferred.lessons.some((x) => x.id === ids.withEvidence), false);

  const both = await requestJson(base, '/api/lessons?projectId=beta&status=unverified');
  assert.deepEqual(both.lessons.map((x) => x.id), [ids.beta]);

  const unknown = await request(base, '/api/lessons?status=might-be-verified');
  assert.equal(unknown.status, 400, '未知状态不能被当成「全部」静默放过');
}));

test('没有证据的经验写明「没有可追溯证据」，不会显示成待验证或已验证', () => withWorkbench(async ({ base, ids }) => {
  const view = await requestJson(base, '/api/lessons');

  const known = view.lessons.find((x) => x.id === ids.noEvidence);
  assert.equal(known.evidenceEmpty, true);
  assert.equal(known.evidenceNote, EVIDENCE_EMPTY_NOTE);
  assert.equal(known.evidenceNote, '没有可追溯证据');
  assert.deepEqual(known.evidence, []);
  assert.equal(known.status, 'inferred');
  assert.equal(known.statusLabel, '推断');

  const stale = view.lessons.find((x) => x.id === ids.staleVerified);
  assert.equal(stale.evidenceEmpty, true);
  assert.notEqual(stale.status, 'verified');
  assert.notEqual(stale.statusLabel, '已验证');
  assert.equal(stale.status, 'inferred');
}));

test('经验页按项目与状态筛选，展开机制、对策与证据引用，保持只读', () => withWorkbench(async ({ base }) => {
  const page = await request(base, '/lessons');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.headers['content-security-policy'], /style-src 'self'/);
  const html = page.body;

  // 现象、机制、对策、来源项目、证据引用与摘要都在页面上。
  assert.match(html, /改动迁移脚本后没有重跑本地库/u);
  assert.match(html, /启动只执行一次迁移，旧连接缓存了表结构/u);
  assert.match(html, /改 schema 前先断开缓存连接再迁移/u);
  assert.match(html, /execution:rec-alpha-1:log/u);
  assert.match(html, /迁移在执行前失败：no such column/u);
  assert.match(html, /没有可追溯证据/u);
  assert.match(html, /alpha/u);
  // 筛选是链接，不靠表单提交：只读页面不放表单、输入框与脚本。
  assert.match(html, /href="\/lessons\?projectId=beta"/u);
  assert.match(html, /href="\/lessons\?status=verified"/u);
  assert.doesNotMatch(html, /<form/iu);
  assert.doesNotMatch(html, /<input/iu);
  assert.doesNotMatch(html, /<textarea/iu);
  assert.doesNotMatch(html, /<script/iu);

  const css = await request(base, '/lessons.css');
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);

  // 工作台首页给出入口，经验浏览不要求用户背地址。
  const home = await request(base, '/');
  assert.equal(home.status, 200);
  assert.match(home.body, /href="\/lessons"/u);
}));

test('经验浏览不引入写路由：POST / PATCH / DELETE 都不改库', () => withWorkbench(async ({ base, ids }) => {
  const headers = { 'content-type': 'application/json', 'x-workbench-request': '1' };
  const attempts = [
    ['POST', '/api/lessons'],
    ['POST', '/api/lessons/review'],
    ['PATCH', `/api/lessons/${ids.withEvidence}`],
    ['DELETE', `/api/lessons/${ids.withEvidence}`]
  ];
  for (const [method, pathname] of attempts) {
    const res = await request(base, pathname, { method, headers, body: JSON.stringify({ countermeasure: '被改写的对策' }) });
    assert.equal(res.status, 404, `${method} ${pathname} 不应被工作台处理`);
  }

  const view = await requestJson(base, '/api/lessons');
  assert.equal(view.lessons.length, 4, '写请求没有增删经验');
  const item = view.lessons.find((x) => x.id === ids.withEvidence);
  assert.equal(item.countermeasure, '改 schema 前先断开缓存连接再迁移');
}));

test('来源台账里的项目也能命中它自己的筛选条件', () => {
  // 跨项目复现后经验行只挂在最早的项目下，第二个项目靠 payload.sources 反查。
  const view = buildLessonsView({
    projectId: 'beta',
    lessons: [{
      id: 'lesson-1',
      projectId: 'alpha',
      phenomenon: '同一现象在两个项目复现',
      mechanism: '同一条去重键',
      countermeasure: '同一条对策',
      scope: { layer: 'project', projectId: 'alpha' },
      sources: [{ projectId: 'alpha' }, { projectId: 'beta' }],
      verificationStatus: 'inferred',
      evidence: []
    }]
  });
  assert.deepEqual(view.lessons.map((x) => x.id), ['lesson-1']);
  assert.deepEqual(view.lessons[0].projectIds, ['alpha', 'beta']);
});
