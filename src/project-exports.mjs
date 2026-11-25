// 项目库导出（#90）：把一份**已发布的快照**写成两个文件，落到可预测的目录。
//
//   <用户配置根>/exports/<projectId>/vN/snapshot.json   机器可读：就是快照本身
//   <用户配置根>/exports/<projectId>/vN/report.html     人读物：由同一份快照渲染
//
// 三条硬约束（issue #90 / 父 spec #80「导出」）：
// 1. 不重新聚合。导出只吃快照：条目、计数、画像与图谱全部来自快照内容，本模块不读库、
//    不读盘、不联网，也不再调用 project-library 的聚合。
// 2. snapshot.json 是**原样字节**。调用方传入库里存的那段 content 文本（store.getVersionRaw
//    回读的 TEXT 列），这里原样落盘；不 JSON.parse 再 stringify，避免数字/键序的细微差异。
//    若调用方给出发布时记录的 content_hash，先校验字节哈希，不符就拒绝导出。
// 3. 幂等。人读物里所有时间都取自快照（generatedAt）与发布记录（publishedAt），
//    没有「导出时间」；重复导出同一份快照得到逐字节相同的两个文件，内容没变时不重写。
//
// 选 HTML 而不是 Markdown：导出物是给「同一批读者」（对方、飞书日报的读者）看的，
// 双击就能在浏览器里读，画像与图谱的「每类一张代表 / 缺的写明缺」能用卡片表达；
// 同时不依赖任何脚本、图片或外部样式，单文件自足，仍然可以逐字节比对。

import fs from 'node:fs';
import path from 'node:path';
import { DIAGRAM_KINDS, DIAGRAM_LABELS } from './project-diagrams.mjs';
import { sha256 } from './utils.mjs';

export const SNAPSHOT_FILE = 'snapshot.json';
export const REPORT_FILE = 'report.html';
/** 导出目录的形状版本：以后改目录布局时读旧导出仍能判断。 */
export const EXPORT_FORMAT = 'project-export/v1';

const PROJECT_ID_MAX = 90;
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export class ExportError extends Error {
  constructor(message, code = 'export_invalid', status = 400) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
    this.status = status;
  }
}

const fail = (message, code = 'export_invalid', status = 400) => {
  throw new ExportError(message, code, status);
};

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const asArray = (value) => (Array.isArray(value) ? value : []);
const text = (value, max = 400) => String(value ?? '').trim().slice(0, max);
const numberOrZero = (value) => (Number.isFinite(value) ? value : 0);

const projectIdOf = (value) => {
  const id = String(value ?? '').trim();
  // 目录名直接来自项目 id：白名单字符与长度上限挡住 "../" 一类的路径穿越。
  if (!id || id.length > PROJECT_ID_MAX || !PROJECT_ID_PATTERN.test(id)) fail('Invalid project id');
  return id;
};

const versionOf = (value) => {
  if (!Number.isSafeInteger(value) || value < 1) fail('Invalid snapshot version');
  return value;
};

/**
 * 导出目录（纯函数）：<root>/<projectId>/vN/。
 * root 由调用方给（桌面端是 userData/exports，测试是临时目录），本模块不猜用户目录。
 */
export function exportFilesOf({ root, projectId, version } = {}) {
  const base = String(root ?? '').trim();
  if (!base) fail('导出根目录不能为空');
  const id = projectIdOf(projectId);
  const n = versionOf(version);
  const dir = path.join(base, id, `v${n}`);
  return {
    dir,
    snapshotPath: path.join(dir, SNAPSHOT_FILE),
    reportPath: path.join(dir, REPORT_FILE)
  };
}

/** 人读物的证据引用：只留「指向哪条记录」，与快照里的形状一致。 */
const evidenceOf = (item) => asArray(item?.evidence)
  .map((entry) => (isObject(entry)
    ? { kind: text(entry.kind, 40) || 'evidence', ref: text(entry.ref, 300) }
    : null))
  .filter((entry) => entry && entry.ref);

const refOf = (item) => {
  const ref = isObject(item?.ref) ? item.ref : {};
  const revision = Number.isSafeInteger(ref.revision) && ref.revision > 0 ? ref.revision : null;
  return {
    kind: text(ref.kind, 40) || 'entry',
    id: text(ref.id, 200),
    ...(revision ? { revision } : {})
  };
};

const itemOf = (item) => ({
  ref: refOf(item),
  title: String(item?.title ?? ''),
  status: String(item?.status ?? ''),
  badge: String(item?.badge ?? ''),
  detail: String(item?.detail ?? ''),
  at: item?.at ?? null,
  evidence: evidenceOf(item)
});

const SECTION_META = Object.freeze([
  { key: 'verified', label: '已验证', emptyHint: '这个项目还没有已验证的条目。' },
  { key: 'observing', label: '观察中', emptyHint: '没有观察中的条目。' }
]);

/** 两节固定顺序与固定标签；快照里缺某一节时给空节，不让它凭空消失。 */
const sectionsOf = (content) => {
  const rows = asArray(content?.sections);
  return SECTION_META.map((meta) => {
    const row = rows.find((section) => String(section?.key ?? '') === meta.key);
    const items = asArray(row?.items).map(itemOf);
    return {
      key: meta.key,
      label: meta.label,
      emptyHint: meta.emptyHint,
      count: items.length,
      empty: items.length === 0,
      items
    };
  });
};

/**
 * 图谱：每类固定给一条，缺的写明缺。
 * 只用快照里的引用（kind / label / title / summary / basedOnCommit / generatedAt / stale），
 * 不重新生成一张，也不因为缺就留白。
 */
const diagramsOf = (content) => {
  const rows = asArray(content?.assets?.diagrams).filter(isObject);
  const missing = new Set(asArray(content?.assets?.missingDiagrams).map((kind) => String(kind ?? '')));
  const byKind = new Map();
  for (const row of rows) {
    const kind = text(row.kind, 40);
    if (!kind) continue;
    // 同类多张时快照已按「最新」选过一张；这里仍以第一张为准，不重新排序。
    if (!byKind.has(kind)) byKind.set(kind, row);
  }
  return DIAGRAM_KINDS.map((kind) => {
    const label = text(DIAGRAM_LABELS[kind], 60) || kind;
    const row = byKind.get(kind);
    const available = Boolean(row) && row.available === true && !missing.has(kind);
    if (!available) {
      return { kind, label, available: false, missing: true, missingText: `缺：还没有生成${label}` };
    }
    return {
      kind,
      label,
      available: true,
      missing: false,
      title: text(row.title, 200) || label,
      summary: text(row.summary, 500),
      basedOnCommit: row.basedOnCommit ?? null,
      generatedAt: row.generatedAt ?? null,
      stale: row.stale === true
    };
  });
};

const profileOf = (content) => {
  const profile = isObject(content?.assets?.profile) ? content.assets.profile : null;
  const available = Boolean(profile) && profile.available === true;
  if (!available) return { available: false, title: '项目画像', missing: true };
  return {
    available: true,
    missing: false,
    title: text(profile.title, 120) || '项目画像',
    oneLiner: text(profile.oneLiner, 300),
    basedOnCommit: profile.basedOnCommit ?? null,
    generatedAt: profile.generatedAt ?? null,
    stale: profile.stale === true
  };
};

/**
 * 人读物的数据模型（纯函数）。
 * 不改写快照里的条目内容，也不重新分节：两节直接按快照 sections 取，计数并列写出，
 * 对不上时标 consistent=false，由渲染层显式提示而不是悄悄抹平。
 */
export function reportModelOf(content, { version, publishedAt = '', contentHash = '', note = '' } = {}) {
  if (!isObject(content)) fail('快照内容必须是一个对象');
  const n = versionOf(version);
  const sections = sectionsOf(content);
  const profile = profileOf(content);
  const diagrams = diagramsOf(content);
  const counts = isObject(content.counts) ? content.counts : {};
  const declared = Object.fromEntries(
    Object.entries(counts).map(([key, value]) => [key, numberOrZero(value)])
  );
  const sectionTotal = sections.reduce((sum, section) => sum + section.count, 0);
  const total = Number.isFinite(declared.total) ? declared.total : sectionTotal;
  const profileCount = profile.available ? 1 : 0;
  const diagramCount = diagrams.filter((diagram) => diagram.available).length;
  const consistent = total === sectionTotal
    && numberOrZero(declared.verified) === sections[0].count
    && numberOrZero(declared.observing) === sections[1].count;

  const oneLiner = profile.available
    ? (profile.oneLiner || '缺：项目画像里没有一句话现状')
    : '缺：还没有生成项目画像';

  const evidence = sections.flatMap((section) => section.items.flatMap((item) => (
    item.evidence.map((ref) => ({
      kind: ref.kind,
      ref: ref.ref,
      itemTitle: item.title,
      sectionKey: section.key,
      sectionLabel: section.label
    }))
  )));

  return {
    format: EXPORT_FORMAT,
    snapshotFormat: String(content.format ?? ''),
    projectId: String(content.project?.id ?? ''),
    projectName: text(content.project?.name, 200) || String(content.project?.id ?? '') || '未命名项目',
    domains: asArray(content.project?.domains).map((domain) => String(domain ?? '')).filter(Boolean),
    version: n,
    label: `v${n}`,
    publishedAt: String(publishedAt ?? ''),
    generatedAt: content.generatedAt ?? null,
    note: String(note ?? '') || String(content.note ?? ''),
    contentHash: String(contentHash ?? ''),
    oneLiner,
    profile,
    diagrams,
    sections,
    evidence,
    counts: {
      verified: numberOrZero(declared.verified),
      observing: numberOrZero(declared.observing),
      total,
      experiences: numberOrZero(declared.experiences),
      domainKnowledge: numberOrZero(declared.domainKnowledge),
      contributedKnowledge: numberOrZero(declared.contributedKnowledge),
      profile: profileCount,
      diagrams: diagramCount
    },
    // 四类计数：三个条目来源 + 画像与图谱（父 spec 的「四类」）。
    // 老快照可能没有记分类计数：给 null 并标 missing，渲染成「缺」，不冒充 0。
    classes: [
      ...['experiences', 'domainKnowledge', 'contributedKnowledge'].map((key) => ({
        key,
        label: { experiences: '本项目经验', domainKnowledge: '所属领域知识', contributedKnowledge: '本项目升上去的知识' }[key],
        value: Number.isFinite(declared[key]) ? declared[key] : null,
        missing: !Number.isFinite(declared[key])
      })),
      { key: 'assets', label: '画像与图谱', value: profileCount + diagramCount, missing: false }
    ],
    totals: { verified: numberOrZero(declared.verified), observing: numberOrZero(declared.observing), total },
    consistent,
    empty: isObject(content.empty)
      ? { title: text(content.empty.title, 200) || '这个项目的库还是空的' }
      : null
  };
}

const ESCAPES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });
/** 人读物里的所有动态文本一律转义：条目标题/证据引用可能来自外部记录。 */
const esc = (value) => String(value ?? '').replace(/[&<>"']/gu, (ch) => ESCAPES[ch]);

const refLabel = (ref) => {
  const base = `${ref.kind}:${ref.id}`;
  return ref.revision ? `${base}（修订 ${ref.revision}）` : base;
};

const momentary = (value) => {
  const raw = String(value ?? '').trim();
  return raw || '未记录';
};

const diagramHtml = (diagram) => {
  const head = `<h3>${esc(diagram.label)}</h3>`;
  if (!diagram.available) {
    return [
      `<article class="asset diagram missing" data-diagram="${esc(diagram.kind)}" data-available="false">`,
      head,
      `<p class="missing">${esc(diagram.missingText)}</p>`,
      '</article>'
    ].join('\n');
  }
  const meta = [
    diagram.basedOnCommit ? `基于 ${esc(String(diagram.basedOnCommit).slice(0, 12))}` : '未记录基于哪个提交',
    `生成于 ${esc(momentary(diagram.generatedAt))}`,
    diagram.stale ? '已过期' : ''
  ].filter(Boolean).join(' · ');
  return [
    `<article class="asset diagram" data-diagram="${esc(diagram.kind)}" data-available="true">`,
    head,
    `<p class="asset-title">${esc(diagram.title)}</p>`,
    diagram.summary ? `<p class="asset-summary">${esc(diagram.summary)}</p>` : '<p class="asset-summary muted">（快照里没有这张图的摘要）</p>',
    `<p class="asset-meta">${meta}</p>`,
    '</article>'
  ].join('\n');
};

const profileHtml = (profile) => {
  if (!profile.available) {
    return [
      '<article class="asset profile missing" data-profile="false">',
      '<h3>项目画像</h3>',
      '<p class="missing">缺：还没有生成项目画像</p>',
      '</article>'
    ].join('\n');
  }
  const meta = [
    profile.basedOnCommit ? `基于 ${esc(String(profile.basedOnCommit).slice(0, 12))}` : '未记录基于哪个提交',
    `生成于 ${esc(momentary(profile.generatedAt))}`,
    profile.stale ? '已过期' : ''
  ].filter(Boolean).join(' · ');
  return [
    '<article class="asset profile" data-profile="true">',
    '<h3>项目画像</h3>',
    profile.oneLiner ? `<p class="asset-title">${esc(profile.oneLiner)}</p>` : '',
    `<p class="asset-meta">${meta}</p>`,
    '</article>'
  ].filter(Boolean).join('\n');
};

const itemHtml = (item) => {
  const meta = [
    item.badge ? `<span class="badge">${esc(item.badge)}</span>` : '',
    item.status && item.status !== item.badge ? `<span class="status">${esc(item.status)}</span>` : '',
    item.detail ? `<span class="detail">${esc(item.detail)}</span>` : '',
    item.at ? `<span class="at">${esc(momentary(item.at))}</span>` : ''
  ].filter(Boolean).join('');
  const evidence = item.evidence.length
    ? `<ul class="evidence">${item.evidence.map((ref) => (
      `<li>${esc(ref.kind)} · ${esc(ref.ref)}</li>`)).join('')}</ul>`
    : '<p class="evidence-empty">没有证据引用。</p>';
  return [
    `<li class="item" data-ref="${esc(refLabel(item.ref))}">`,
    `<p class="item-title">${esc(item.title) || '未命名条目'}</p>`,
    `<p class="item-meta">${meta}</p>`,
    `<p class="item-ref">引用 ${esc(refLabel(item.ref))}</p>`,
    evidence,
    '</li>'
  ].join('\n');
};

const sectionHtml = (section) => [
  `<section class="report-section" data-section="${esc(section.key)}">`,
  `<h2>${esc(section.label)} <span class="count" data-section-count="${esc(section.key)}">${section.count} 条</span></h2>`,
  section.empty
    ? `<p class="section-empty">${esc(section.emptyHint)}</p>`
    : `<ol class="items">${section.items.map(itemHtml).join('\n')}</ol>`,
  '</section>'
].join('\n');

const evidenceHtml = (model) => {
  const body = model.evidence.length
    ? [
        '<table>',
        '<thead><tr><th>类型</th><th>引用</th><th>所属条目</th><th>所在节</th></tr></thead>',
        '<tbody>',
        ...model.evidence.map((entry) => (
          `<tr><td>${esc(entry.kind)}</td><td><code>${esc(entry.ref)}</code></td>` +
          `<td>${esc(entry.itemTitle)}</td><td>${esc(entry.sectionLabel)}</td></tr>`
        )),
        '</tbody>',
        '</table>'
      ].join('\n')
    : '<p class="section-empty">这一版没有证据引用。</p>';
  return [
    '<section class="report-section" data-section="evidence">',
    `<h2>证据引用 <span class="count">${model.evidence.length} 条</span></h2>`,
    '<p class="section-sub">只指向记录，不复制证据正文；条目里的引用与这里一一对应。</p>',
    body,
    '</section>'
  ].join('\n');
};

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 32px 20px 56px; font: 15px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background: #fafafa; color: #1d1d1f; }
.report { max-width: 860px; margin: 0 auto; background: #fff; border: 1px solid #e4e4e7; border-radius: 14px; padding: 28px 32px 36px; }
.kicker { margin: 0; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #6b7280; }
h1 { margin: 4px 0 6px; font-size: 26px; line-height: 1.25; }
h2 { margin: 0 0 10px; font-size: 17px; }
h3 { margin: 0 0 4px; font-size: 14px; }
.version-line { margin: 0; color: #4b5563; font-size: 13px; }
.version-line .version { display: inline-block; padding: 0 8px; border-radius: 999px; background: #eef2ff; color: #3730a3; font-weight: 600; }
.note { margin: 8px 0 0; padding: 8px 10px; border-left: 3px solid #c7d2fe; background: #f5f7ff; font-size: 13px; }
.hash { margin: 6px 0 0; color: #6b7280; font-size: 11px; word-break: break-all; }
.report-section { margin-top: 26px; padding-top: 20px; border-top: 1px solid #ececef; }
.section-sub { margin: -4px 0 10px; color: #6b7280; font-size: 12px; }
.count { font-size: 12px; font-weight: 400; color: #6b7280; }
.one-liner { margin: 0 0 14px; font-size: 16px; }
.counts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.count-cell { border: 1px solid #e4e4e7; border-radius: 10px; padding: 10px 12px; }
.count-cell .label { display: block; font-size: 12px; color: #6b7280; }
.count-cell .value { display: block; font-size: 22px; font-weight: 600; }
.totals { margin: 12px 0 0; font-size: 13px; color: #4b5563; }
.warn { margin: 8px 0 0; padding: 8px 10px; border-left: 3px solid #f59e0b; background: #fffbeb; font-size: 12px; color: #92400e; }
.empty-library { margin: 10px 0 0; padding: 10px 12px; border: 1px dashed #d4d4d8; border-radius: 10px; color: #6b7280; font-size: 13px; }
.diagrams { display: grid; gap: 8px; margin-top: 10px; }
.asset { border: 1px solid #e4e4e7; border-radius: 10px; padding: 10px 12px; margin: 0; }
.asset-title { margin: 0; font-size: 14px; font-weight: 600; }
.asset-summary { margin: 2px 0 0; font-size: 13px; }
.asset-meta { margin: 4px 0 0; font-size: 11px; color: #6b7280; }
.asset.missing { border-style: dashed; background: #fcfcfd; }
.missing { margin: 0; font-size: 13px; color: #b45309; }
.muted { color: #9ca3af; }
.items { margin: 0; padding-left: 0; list-style: none; display: grid; gap: 8px; }
.item { border: 1px solid #ececef; border-radius: 10px; padding: 10px 12px; }
.item-title { margin: 0 0 4px; font-size: 14px; font-weight: 600; }
.item-meta { margin: 0; display: flex; flex-wrap: wrap; gap: 8px; font-size: 11px; color: #6b7280; }
.badge { padding: 0 7px; border: 1px solid #d4d4d8; border-radius: 999px; }
.item-ref { margin: 4px 0 0; font-size: 11px; color: #6b7280; }
.evidence { margin: 4px 0 0; padding-left: 18px; font-size: 12px; }
.evidence-empty { margin: 4px 0 0; font-size: 12px; color: #9ca3af; }
.section-empty { margin: 0; color: #6b7280; font-size: 13px; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ececef; vertical-align: top; }
th { color: #6b7280; font-weight: 600; }
code { font: 12px/1.4 ui-monospace, "Cascadia Mono", Consolas, monospace; }
footer { margin-top: 26px; padding-top: 14px; border-top: 1px solid #ececef; color: #9ca3af; font-size: 11px; }
@media print { body { background: #fff; padding: 0; } .report { border: 0; border-radius: 0; } }
`.trim();

/**
 * 渲染人读物（纯函数）。字符串完全由 model 决定，不含当前时间与随机量，
 * 所以同一份快照渲染两次逐字节相同。
 */
export function renderReportHtml(model) {
  if (!isObject(model)) fail('报告模型不能为空');
  const versionLine = [
    `<span class="version">${esc(model.label)}</span>`,
    `发布于 <time datetime="${esc(model.publishedAt)}">${esc(momentary(model.publishedAt))}</time>`,
    `快照生成于 ${esc(momentary(model.generatedAt))}`
  ].join(' · ');
  const title = `项目库快照 · ${model.projectName} · ${model.label}`;
  const counts = model.classes.map((entry) => [
    `<div class="count-cell" data-count="${esc(entry.key)}">`,
    `<span class="label">${esc(entry.label)}</span>`,
    `<span class="value">${esc(entry.missing ? '缺' : entry.value)}</span>`,
    '</div>'
  ].join('')).join('\n');

  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${esc(title)}</title>`,
    `<style>\n${STYLE}\n</style>`,
    '</head>',
    '<body>',
    '<main class="report">',
    '<header class="report-head">',
    '<p class="kicker">项目库快照 · 可预测目录里的本地导出</p>',
    `<h1>${esc(model.projectName)}</h1>`,
    `<p class="version-line">${versionLine}</p>`,
    model.note ? `<p class="note">这一版说明：${esc(model.note)}</p>` : '',
    model.contentHash ? `<p class="hash">内容哈希 sha256:${esc(model.contentHash)}</p>` : '',
    '</header>',
    '<section class="report-section" data-section="summary">',
    '<h2>一句话现状</h2>',
    `<p class="one-liner">${esc(model.oneLiner)}</p>`,
    '<div class="counts">',
    counts,
    '</div>',
    `<p class="totals">已验证 ${model.totals.verified} 条 · 观察中 ${model.totals.observing} 条 · 合计 ${model.totals.total} 条</p>`,
    model.consistent ? '' : '<p class="warn">快照的分节计数与合计对不上；这里照快照原样写出，不替它改数。</p>',
    model.empty ? `<p class="empty-library">${esc(model.empty.title)}</p>` : '',
    '</section>',
    '<section class="report-section" data-section="assets">',
    '<h2>画像与图谱</h2>',
    '<p class="section-sub">只读资产：每类图谱给一张代表，缺的写明缺。</p>',
    profileHtml(model.profile),
    '<div class="diagrams">',
    model.diagrams.map(diagramHtml).join('\n'),
    '</div>',
    '</section>',
    model.sections.map(sectionHtml).join('\n'),
    evidenceHtml(model),
    '<footer>',
    `导出布局 ${esc(model.format)} · 快照格式 ${esc(model.snapshotFormat || '未知')} · ` +
      `${esc(model.projectName)} ${esc(model.label)}`,
    '</footer>',
    '</main>',
    '</body>',
    '</html>',
    ''
  ].filter((line) => line !== '').join('\n');
}

/** 内容没变就不重写：重复导出不产生新的 mtime，也不碰已经核对过的文件。 */
const writeIfChanged = (file, content) => {
  const next = Buffer.from(content, 'utf8');
  try {
    if (fs.readFileSync(file).equals(next)) return false;
  } catch {
    // 文件不存在或读不了：继续写。
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return true;
};

/**
 * 写出一份导出（文件落盘）。
 *
 * contentText 必须是库里存的那段快照文本；contentHash 是发布时记录的 hash。给了 hash 就先
 * 校验字节，避免把被改过或不是同一版的文本署名成这一版。
 */
export function writeExport({
  root,
  projectId,
  version,
  contentText,
  contentHash = '',
  publishedAt = '',
  note = ''
} = {}) {
  const files = exportFilesOf({ root, projectId, version });
  if (typeof contentText !== 'string' || !contentText) fail('快照文本不能为空');
  let content;
  try {
    content = JSON.parse(contentText);
  } catch {
    fail('快照文本不是合法 JSON');
  }
  if (!isObject(content)) fail('快照内容必须是一个对象');
  const expectedHash = String(contentHash ?? '').trim();
  const actualHash = sha256(Buffer.from(contentText, 'utf8'));
  if (expectedHash && expectedHash !== actualHash) {
    fail('快照字节与发布记录的哈希不一致：拒绝导出被改过的内容', 'export_hash_mismatch', 409);
  }

  const model = reportModelOf(content, {
    version,
    publishedAt,
    contentHash: expectedHash || actualHash,
    note
  });
  const report = renderReportHtml(model);

  const changed = [];
  if (writeIfChanged(files.snapshotPath, contentText)) changed.push(SNAPSHOT_FILE);
  if (writeIfChanged(files.reportPath, report)) changed.push(REPORT_FILE);

  return {
    format: EXPORT_FORMAT,
    projectId: String(projectId),
    version,
    label: `v${version}`,
    dir: files.dir,
    snapshotPath: files.snapshotPath,
    reportPath: files.reportPath,
    snapshotHash: actualHash,
    reportHash: sha256(Buffer.from(report, 'utf8')),
    changed
  };
}

/**
 * 从快照存储直接导出一个已发布版本：回读库里那段原样文本，再走 writeExport。
 * 找不到版本时明确失败，不现场聚合一份新的。
 */
export function exportPublishedVersion({ store, root, projectId, version } = {}) {
  if (!store || typeof store.getVersionRaw !== 'function') fail('快照存储不可用', 'export_store_missing', 503);
  const raw = store.getVersionRaw(projectId, version);
  if (!raw) fail('没有这个已发布版本', 'export_version_missing', 404);
  return writeExport({
    root,
    projectId: raw.projectId,
    version: raw.version,
    contentText: raw.contentText,
    contentHash: raw.contentHash,
    publishedAt: raw.publishedAt,
    note: raw.note
  });
}
