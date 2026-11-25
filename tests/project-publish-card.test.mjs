// 项目库发布卡片（#91）：发布成功后发一条飞书文本卡片，发送结果落到投递账本上。
//
// 全部用注入的假 fetch 断言，不真联网、不启动 Electron：
// 1. 请求体是现有通道的 msg_type=text，卡片文案含项目名、一句话现状、四个计数与导出路径；
// 2. 失败时记「未发送」并给原因，快照与导出文件都还在；
// 3. 只有再调一次才会重发（没有自动重试）；
// 4. 未配 webhook 时一次 fetch 都不发，状态写明「没配 webhook」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CARD_STATUS,
  NO_WEBHOOK_HINT,
  PublishCardStore,
  cardCountsOf,
  deliverPublishCard,
  formatPublishCard,
  publishCardModelOf,
  publishCardTextOf
} from '../src/project-publish-card.mjs';
import { ProjectSnapshotStore, snapshotContentOf } from '../src/project-snapshots.mjs';
import { exportPublishedVersion } from '../src/project-exports.mjs';
import { projectLibraryView } from '../src/project-library.mjs';

const PROJECT = {
  id: 'p1',
  name: '演示项目',
  primaryDomain: 'software-engineering',
  domains: ['software-engineering']
};

const lesson = (id, status) => ({
  id,
  projectId: PROJECT.id,
  phenomenon: `现象 ${id}`,
  mechanism: `机制 ${id}`,
  countermeasure: `对策 ${id}`,
  scope: { layer: 'project', projectId: PROJECT.id, domainIds: ['software-engineering'] },
  verificationStatus: status,
  evidence: [{ ref: `sandbox:${id}`, kind: 'record' }],
  lastMergedAt: '2026-11-20T00:00:00.000Z'
});

const unit = (id, status) => ({
  id,
  revision: 1,
  title: `知识 ${id}`,
  content: `内容 ${id}`,
  kind: 'claim',
  layer: 'applied',
  scope: 'domain',
  domains: ['software-engineering'],
  verificationStatus: status,
  evidenceRefs: [`evidence:${id}`],
  updatedAt: '2026-11-21T00:00:00.000Z'
});

/** 一份完整的库视图快照：2 条经验 + 2 条领域知识，其中 2 条待验证 → 观察中 2。 */
const contentOf = ({ profile = undefined } = {}) => snapshotContentOf(projectLibraryView({
  project: PROJECT,
  lessons: [lesson('l1', 'verified'), lesson('l2', 'unverified')],
  knowledge: [unit('k1', 'verified'), unit('k2', 'unverified')],
  profile: profile === undefined
    ? {
        oneLiner: '一个用于演示发布卡片的零依赖项目',
        basedOnCommit: 'abc1234',
        generatedAt: '2026-11-22T00:00:00.000Z'
      }
    : profile,
  diagrams: [],
  limit: 50
}), { generatedAt: '2026-11-23T00:00:00.000Z' });

const EXPORT_DIR = path.join('C:', 'tmp', 'exports', 'p1', 'v2');

/** 假 fetch：记录每次调用，返回飞书 webhook 的成功 / 失败响应。 */
const fakeFetch = ({ ok = true, status = 200, body = { code: 0, msg: 'success' }, error = null } = {}) => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (error) throw error;
    return { ok, status, text: async () => JSON.stringify(body) };
  };
  return { impl, calls };
};

const payloadOf = (call) => JSON.parse(call.init.body);

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'owner-publish-card-'));
const cleanup = (dir) => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 下偶发占用，忽略 */ }
};

test('卡片文案：项目名、一句话现状、四个计数、导出路径与版本号都能独立说清', () => {
  const text = publishCardTextOf(JSON.stringify(contentOf()), {
    version: 2,
    exportDir: EXPORT_DIR
  });

  assert.match(text, /【项目库发布】演示项目 v2/u);
  assert.match(text, /现状：一个用于演示发布卡片的零依赖项目/u);
  assert.match(text, /知识 2 条/u);
  assert.match(text, /经验 2 条/u);
  assert.match(text, /观察中 2 条/u);
  assert.match(text, /共 4 条/u);
  assert.ok(text.includes(`本地导出：${EXPORT_DIR}`), text);
});

test('卡片文案：同一份快照重复生成逐字相同（不含当前时间与随机量）', () => {
  const first = publishCardTextOf(JSON.stringify(contentOf()), { version: 1, exportDir: EXPORT_DIR });
  const second = publishCardTextOf(JSON.stringify(contentOf()), { version: 1, exportDir: EXPORT_DIR });
  assert.equal(first, second);
});

test('缺画像与旧快照缺分类计数：写「缺」，不冒充 0', () => {
  const content = contentOf({ profile: null });
  delete content.counts.experiences;
  delete content.counts.contributedKnowledge;
  const model = publishCardModelOf(content, { version: 3, exportDir: EXPORT_DIR });
  assert.equal(model.oneLiner, '缺：还没有生成项目画像');
  assert.equal(model.counts.experiences, null);
  const text = formatPublishCard(model);
  assert.match(text, /经验 缺/u);
  assert.match(text, /知识 缺/u);
});

test('导出没完成：卡片写明「本地导出：未完成」与原因，不给出假路径', () => {
  const text = publishCardTextOf(JSON.stringify(contentOf()), {
    version: 1,
    exportError: '磁盘只读'
  });
  assert.match(text, /本地导出：未完成（磁盘只读）/u);
});

test('发送成功：请求体是现有通道的文本消息，账本记为 sent', async () => {
  const root = tempRoot();
  const deliveries = new PublishCardStore(path.join(root, 'deliveries.sqlite'));
  try {
    const { impl, calls } = fakeFetch();
    const result = await deliverPublishCard({
      deliveries,
      projectId: PROJECT.id,
      version: 2,
      content: contentOf(),
      exportDir: EXPORT_DIR,
      webhookUrl: 'http://127.0.0.1:9/open-apis/bot/v2/hook/test',
      fetchImpl: impl,
      now: '2026-11-24T00:00:00.000Z'
    });

    assert.equal(result.status, CARD_STATUS.sent);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, 'POST');
    const payload = payloadOf(calls[0]);
    assert.equal(payload.msg_type, 'text');
    assert.equal(payload.content.text, result.text);
    assert.match(payload.content.text, /知识 2 条 · 经验 2 条 · 观察中 2 条 · 共 4 条/u);
    assert.ok(payload.content.text.includes(EXPORT_DIR));

    // 账本：按 (项目, 版本) 记一行，面板读得到状态与原因。
    const stored = deliveries.get(PROJECT.id, 2);
    assert.equal(stored.status, 'sent');
    assert.equal(stored.text, result.text);
    assert.equal(stored.attemptedAt, '2026-11-24T00:00:00.000Z');
    assert.equal(deliveries.getLatest(PROJECT.id).version, 2);

    // 不自动重试：等待一小段时间，fetch 仍然只有一次。
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(calls.length, 1);
  } finally {
    deliveries.close();
    cleanup(root);
  }
});

test('发送失败：fast fail 记为未发送，快照与导出文件都保留', async () => {
  const root = tempRoot();
  const dbPath = path.join(root, 'owner.sqlite');
  const snapshots = new ProjectSnapshotStore(dbPath);
  const deliveries = new PublishCardStore({ db: snapshots.db });
  try {
    snapshots.saveDraft({ projectId: PROJECT.id, content: contentOf() });
    const published = snapshots.publish({ projectId: PROJECT.id });
    const exported = exportPublishedVersion({
      store: snapshots, root: path.join(root, 'exports'), projectId: PROJECT.id, version: published.version
    });

    const { impl, calls } = fakeFetch({ error: new Error('getaddrinfo ENOTFOUND open.feishu.cn') });
    const result = await deliverPublishCard({
      deliveries,
      projectId: PROJECT.id,
      version: published.version,
      contentText: snapshots.getVersionRaw(PROJECT.id, published.version).contentText,
      exportDir: exported.dir,
      publishedAt: published.publishedAt,
      webhookUrl: 'http://127.0.0.1:9/open-apis/bot/v2/hook/test',
      fetchImpl: impl
    });

    assert.equal(calls.length, 1);
    assert.equal(result.status, CARD_STATUS.unsent);
    assert.match(result.detail, /ENOTFOUND/u);

    // 快照还在、导出文件还在：发送失败只影响「发没发出去」。
    assert.ok(snapshots.getVersionRaw(PROJECT.id, published.version)?.contentText);
    assert.ok(fs.existsSync(exported.snapshotPath));
    assert.ok(fs.existsSync(exported.reportPath));

    const stored = deliveries.get(PROJECT.id, published.version);
    assert.equal(stored.status, 'unsent');
    assert.match(stored.detail, /ENOTFOUND/u);
    assert.match(stored.text, /本地导出：/u);
  } finally {
    deliveries.close();
    snapshots.close();
    cleanup(root);
  }
});

test('HTTP 500 也记为未发送，原因带上状态码', async () => {
  const root = tempRoot();
  const deliveries = new PublishCardStore(path.join(root, 'deliveries.sqlite'));
  try {
    const { impl } = fakeFetch({ ok: false, status: 500, body: { code: 500, msg: 'boom' } });
    const result = await deliverPublishCard({
      deliveries,
      projectId: PROJECT.id,
      version: 1,
      content: contentOf(),
      exportDir: EXPORT_DIR,
      webhookUrl: 'http://127.0.0.1:9/open-apis/bot/v2/hook/test',
      fetchImpl: impl
    });
    assert.equal(result.status, CARD_STATUS.unsent);
    assert.match(result.detail, /feishu http 500/u);
    assert.equal(deliveries.get(PROJECT.id, 1).status, 'unsent');
  } finally {
    deliveries.close();
    cleanup(root);
  }
});

test('只有人再点一次才重发：第一次失败、第二次成功，文案逐字相同', async () => {
  const root = tempRoot();
  const deliveries = new PublishCardStore(path.join(root, 'deliveries.sqlite'));
  try {
    const failing = fakeFetch({ ok: false, status: 502, body: {} });
    const first = await deliverPublishCard({
      deliveries,
      projectId: PROJECT.id,
      version: 2,
      content: contentOf(),
      exportDir: EXPORT_DIR,
      webhookUrl: 'http://127.0.0.1:9/open-apis/bot/v2/hook/test',
      fetchImpl: failing.impl,
      now: '2026-11-24T00:00:00.000Z'
    });
    assert.equal(first.status, CARD_STATUS.unsent);
    // 失败之后没有自动重发：调用方不再调用就只有这一次。
    assert.equal(failing.calls.length, 1);
    assert.equal(deliveries.get(PROJECT.id, 2).status, 'unsent');

    const ok = fakeFetch();
    const second = await deliverPublishCard({
      deliveries,
      projectId: PROJECT.id,
      version: 2,
      content: contentOf(),
      exportDir: EXPORT_DIR,
      webhookUrl: 'http://127.0.0.1:9/open-apis/bot/v2/hook/test',
      fetchImpl: ok.impl,
      now: '2026-11-24T01:00:00.000Z'
    });
    assert.equal(ok.calls.length, 1);
    assert.equal(second.status, CARD_STATUS.sent);
    assert.equal(second.text, first.text);
    const stored = deliveries.get(PROJECT.id, 2);
    assert.equal(stored.status, 'sent');
    assert.equal(stored.attemptedAt, '2026-11-24T01:00:00.000Z');
  } finally {
    deliveries.close();
    cleanup(root);
  }
});

test('未配 webhook：一次 fetch 都不发，状态写明「没配 webhook」', async () => {
  const root = tempRoot();
  const deliveries = new PublishCardStore(path.join(root, 'deliveries.sqlite'));
  try {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; throw new Error('不应该被调用'); };
    const result = await deliverPublishCard({
      deliveries,
      projectId: PROJECT.id,
      version: 1,
      content: contentOf(),
      exportDir: EXPORT_DIR,
      webhookUrl: '',
      fetchImpl
    });

    assert.equal(calls, 0);
    assert.equal(result.status, CARD_STATUS.unsent);
    assert.equal(result.detail, NO_WEBHOOK_HINT);
    assert.match(result.detail, /没配 webhook/u);
    // 不是静默成功：账本上明明白白记着未发送与原因。
    const stored = deliveries.get(PROJECT.id, 1);
    assert.equal(stored.status, 'unsent');
    assert.match(stored.detail, /没配 webhook/u);
    assert.match(stored.text, /【项目库发布】演示项目 v1/u);
  } finally {
    deliveries.close();
    cleanup(root);
  }
});

test('四个计数：知识 = 领域知识 + 本项目贡献知识；缺字段给 null', () => {
  assert.deepEqual(
    cardCountsOf({ domainKnowledge: 3, contributedKnowledge: 2, experiences: 4, observing: 1, total: 9 }),
    { knowledge: 5, experiences: 4, observing: 1, total: 9 }
  );
  assert.deepEqual(cardCountsOf({}), { knowledge: null, experiences: null, observing: null, total: null });
});

test('账本拒绝非法项目 id 与版本号（键与快照同一套白名单）', () => {
  const root = tempRoot();
  const deliveries = new PublishCardStore(path.join(root, 'deliveries.sqlite'));
  try {
    assert.throws(() => deliveries.record({ projectId: '../evil', version: 1, status: 'sent' }), /Invalid project id/u);
    assert.throws(() => deliveries.record({ projectId: 'p1', version: 0, status: 'sent' }), /Invalid snapshot version/u);
  } finally {
    deliveries.close();
    cleanup(root);
  }
});
