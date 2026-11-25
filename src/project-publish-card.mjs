// 项目库发布卡片（#91）：发布成功后把「这一版项目库长什么样」发进飞书群。
//
// 复用 #31 建好的单一 webhook 通道（src/observer/feishu.mjs）：只发文本卡片，不做图片
// 上传（那需要 image_key），不新增依赖，也不另开第二条通道。本模块只做两件事：
// 1. 把**已发布的快照内容**压成一条能独立读懂的消息：项目名、一句话现状、
//    四个计数（知识 / 经验 / 观察中 / 共几条）、本地导出路径、版本号；
// 2. 把发送结果落到一张独立的投递账本（成功 / 未发送 + 原因），供人点「重新发送」。
//
// 为什么发送状态不写回 project_snapshot_versions：已发布版本由 #89 的触发器钉死为不可变，
// 而投递结果是「这一次发送」，写进版本行会破坏不可变承诺。所以单独一张
// project_publish_deliveries 表，按 (project_id, version) 记最近一次投递结果。
//
// 失败时快照与导出都保持原样：本模块只发一条消息、只记一行状态，没有回滚、没有删除。
// 不自动重试、不做定时发送：deliverPublishCard 每次调用只投一次，重试只能由人触发。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deliverFeishu } from './observer/feishu.mjs';
import { defaultDbPath } from './storage.mjs';

/** 投递结果只有两种：发出去了，或者没发出去（带原因）。 */
export const CARD_STATUS = Object.freeze({ sent: 'sent', unsent: 'unsent' });

/** 没配 webhook 时的固定提示：不静默成功，也不静默失败。 */
export const NO_WEBHOOK_HINT = '没配 webhook：设置 OWNER_OBSERVER_FEISHU_WEBHOOK 或 ~/.owner-agent/feishu.json 的 webhook 字段后，点「重新发送」。';

const PROJECT_ID_MAX = 90;
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const ONE_LINER_MAX = 120;
const DETAIL_MAX = 500;

const stamp = () => new Date().toISOString();
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const numberOrNull = (value) => (Number.isFinite(value) ? value : null);
const oneLine = (value, max = ONE_LINER_MAX) => String(value ?? '')
  .replace(/\s+/gu, ' ')
  .trim()
  .slice(0, max);

const projectIdOf = (value) => {
  const id = String(value ?? '').trim();
  // 与快照 / 导出同一套白名单：账本键也只接受可预测的项目 id。
  if (!id || id.length > PROJECT_ID_MAX || !PROJECT_ID_PATTERN.test(id)) {
    throw new Error('Invalid project id');
  }
  return id;
};

const versionOf = (value) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid snapshot version');
  return value;
};

/**
 * 卡片上的四个计数（纯函数）。
 *
 * 知识 = 所属领域知识 + 本项目升上去的知识；经验 = 本项目经验；观察中取快照的分节计数；
 * 共几条取条目总数（恒等于已验证 + 观察中）。老快照缺某个分类时给 null，
 * 卡片写「缺」，不冒充 0——与导出的人读物同一口径。
 */
export function cardCountsOf(counts = {}) {
  const source = isObject(counts) ? counts : {};
  const domain = numberOrNull(source.domainKnowledge);
  const contributed = numberOrNull(source.contributedKnowledge);
  return {
    knowledge: domain === null || contributed === null ? null : domain + contributed,
    experiences: numberOrNull(source.experiences),
    observing: numberOrNull(source.observing),
    total: numberOrNull(source.total)
  };
}

/**
 * 卡片的模型（纯函数）。
 * content 必须是一份快照内容（project-snapshot/v1）；这里只读，不重新聚合库。
 */
export function publishCardModelOf(content, {
  version,
  exportDir = '',
  exportError = '',
  publishedAt = ''
} = {}) {
  if (!isObject(content)) throw new Error('快照内容必须是一个对象');
  const n = versionOf(version);
  const profile = isObject(content.assets?.profile) ? content.assets.profile : null;
  const oneLiner = profile?.available === true
    ? (oneLine(profile.oneLiner) || '缺：项目画像里没有一句话现状')
    : '缺：还没有生成项目画像';
  return {
    projectId: String(content.project?.id ?? ''),
    projectName: oneLine(content.project?.name, 160) || String(content.project?.id ?? '') || '未命名项目',
    version: n,
    label: `v${n}`,
    oneLiner,
    counts: cardCountsOf(content.counts),
    exportDir: String(exportDir ?? ''),
    exportError: oneLine(exportError, 200),
    generatedAt: content.generatedAt ?? null,
    publishedAt: String(publishedAt ?? ''),
    note: oneLine(content.note, 200)
  };
}

const countText = (label, value) => `${label} ${value === null ? '缺' : `${value} 条`}`;

/**
 * 卡片正文（纯函数）：内容完全由模型决定，不含当前时间与随机量，
 * 所以同一份快照重新发送得到逐字相同的文本。
 */
export function formatPublishCard(model) {
  if (!isObject(model)) throw new Error('卡片模型不能为空');
  const counts = model.counts ?? {};
  const exportLine = model.exportDir
    ? `本地导出：${model.exportDir}`
    : `本地导出：未完成${model.exportError ? `（${model.exportError}）` : ''}`;
  return [
    `【项目库发布】${model.projectName} ${model.label}`,
    `现状：${model.oneLiner}`,
    [
      countText('知识', counts.knowledge ?? null),
      countText('经验', counts.experiences ?? null),
      countText('观察中', counts.observing ?? null),
      countText('共', counts.total ?? null)
    ].join(' · '),
    exportLine,
    model.note ? `这一版说明：${model.note}` : '',
    model.generatedAt ? `快照生成于 ${model.generatedAt}` : '',
    '发送失败不影响这一版快照与本地导出；由人点「重新发送」重试，不自动重发。'
  ].filter(Boolean).join('\n');
}

/** 只给一段快照文本的便捷入口（发布 / 重新发送都从这里进）。 */
export function publishCardTextOf(contentText, options = {}) {
  let content;
  try {
    content = typeof contentText === 'string' ? JSON.parse(contentText) : contentText;
  } catch {
    throw new Error('快照文本不是合法 JSON');
  }
  return formatPublishCard(publishCardModelOf(content, options));
}

/**
 * 投递账本：每个 (项目, 版本) 一行，记录最近一次发送结果。
 * 与快照版本表分开：版本不可变，投递状态会随每次重试变化。
 */
export class PublishCardStore {
  /**
   * @param {string|{db: import('node:sqlite').DatabaseSync}} source 临时库路径（测试），
   *   或 `{ db }` 复用桌面主进程已有的连接。
   */
  constructor(source = defaultDbPath()) {
    const shared = isObject(source);
    this.db = shared ? source.db : new DatabaseSync(source);
    this.ownsDb = !shared;
    if (!shared && source !== ':memory:') {
      fs.mkdirSync(path.dirname(source), { recursive: true, mode: 0o700 });
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_publish_deliveries(
        project_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version > 0),
        status TEXT NOT NULL CHECK(status IN ('sent', 'unsent')),
        detail TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL DEFAULT '',
        attempted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(project_id, version)
      );
    `);
  }

  close() {
    if (this.ownsDb) this.db.close();
  }

  /** 记一次投递结果：同一个版本被重试时覆盖上一次（只保留最近一次，不攒历史）。 */
  record({ projectId, version, status, detail = '', text = '', now = stamp() } = {}) {
    const id = projectIdOf(projectId);
    const n = versionOf(version);
    const state = status === CARD_STATUS.sent ? CARD_STATUS.sent : CARD_STATUS.unsent;
    this.db.prepare(`
      INSERT INTO project_publish_deliveries(
        project_id, version, status, detail, text, attempted_at, updated_at
      ) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(project_id, version) DO UPDATE SET
        status=excluded.status, detail=excluded.detail, text=excluded.text,
        attempted_at=excluded.attempted_at, updated_at=excluded.updated_at
    `).run(id, n, state, oneLine(detail, DETAIL_MAX), String(text ?? ''),
      String(now), String(now));
    return this.get(id, n);
  }

  get(projectId, version) {
    return this.#rowToDelivery(this.db.prepare(
      'SELECT * FROM project_publish_deliveries WHERE project_id=? AND version=?'
    ).get(projectIdOf(projectId), versionOf(version)));
  }

  /** 面板显示用：这个项目最新一版的投递状态。 */
  getLatest(projectId) {
    return this.#rowToDelivery(this.db.prepare(
      'SELECT * FROM project_publish_deliveries WHERE project_id=? ORDER BY version DESC LIMIT 1'
    ).get(projectIdOf(projectId)));
  }

  #rowToDelivery(row) {
    return row
      ? {
          projectId: row.project_id,
          version: row.version,
          label: `v${row.version}`,
          status: row.status,
          detail: row.detail ?? '',
          text: row.text ?? '',
          attemptedAt: row.attempted_at,
          updatedAt: row.updated_at
        }
      : null;
  }
}

/**
 * 发一条发布卡片并记录结果。每次调用最多投递一次——没有重试循环、没有定时器。
 *
 * @returns {Promise<{status:'sent'|'unsent', detail:string, text:string, attemptedAt:string, delivery:object|null}>}
 */
export async function deliverPublishCard({
  deliveries,
  projectId,
  version,
  content,
  contentText = '',
  exportDir = '',
  exportError = '',
  publishedAt = '',
  webhookUrl = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
  now = stamp()
} = {}) {
  if (!deliveries || typeof deliveries.record !== 'function') {
    throw new Error('投递账本不可用');
  }
  const id = projectIdOf(projectId);
  const n = versionOf(version);
  const text = contentText
    ? publishCardTextOf(contentText, { version: n, exportDir, exportError, publishedAt })
    : formatPublishCard(publishCardModelOf(content, { version: n, exportDir, exportError, publishedAt }));

  const configured = String(webhookUrl ?? '').trim();
  let status = CARD_STATUS.unsent;
  let detail = '';
  if (!configured) {
    // 未配置：一次 fetch 都不发，状态与原因都要能被人看到。
    detail = NO_WEBHOOK_HINT;
  } else {
    const result = await deliverFeishu({ webhookUrl: configured, text, fetchImpl, timeoutMs });
    if (result.status === 'sent') {
      status = CARD_STATUS.sent;
      detail = result.detail || 'feishu code 0';
    } else {
      status = CARD_STATUS.unsent;
      detail = result.detail || 'feishu delivery failed';
    }
  }

  const delivery = deliveries.record({ projectId: id, version: n, status, detail, text, now });
  return { status, detail, text, attemptedAt: String(now), delivery };
}
