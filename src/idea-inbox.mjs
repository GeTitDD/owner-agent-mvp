// #94 灵感收件箱的纯函数视图模型：输入条目数组，输出「收件箱 / 已整理」两段。
//
// 为什么分两段而不是按四个状态各分一段：收件箱只关心「还没处理的有哪些」；
// 已采纳、已丢弃都是整理之后的去向，仍留在「已整理」里可查回，但不再占据收件箱。
// 两段按状态互斥且覆盖全部条目，计数直接来自分好组的数组，不另算口径。
//
// 这里不读库、不联网、不碰面板：调用方把 owner-store 的 listIdeaInbox() 结果原样传入，
// 或传任何带 ideaStatus 的条目数组即可。空段给一句提示，避免界面出现一片空白。

import { flatText } from './utils.mjs';

const DEFAULT_LIMIT = 100;
const STATUS_LABELS = {
  inbox: '收件箱',
  sorted: '已整理',
  adopted: '已采纳',
  discarded: '已丢弃'
};
const SOURCE_LABELS = { paste: '粘贴', link: '链接' };

// 状态 → 段。未知状态归入收件箱，至少让人看见它，而不是悄悄消失。
const sectionOf = (status) => (status === 'sorted' || status === 'adopted' || status === 'discarded'
  ? 'sorted'
  : 'inbox');

const SECTION_DEFS = [
  {
    key: 'inbox',
    label: '收件箱',
    hint: '收件箱是空的。把想到的点子或链接粘进来，先不用想它属于哪个项目。'
  },
  {
    key: 'sorted',
    label: '已整理',
    hint: '还没有已整理的条目。整理后的灵感会移到这里；已采纳和已丢弃也留在这里可查回。'
  }
];

const oneLine = (value, max = 200) => flatText(value, max);
const valueOf = (row, camel, snake, fallback = '') => row?.[camel] ?? row?.[snake] ?? fallback;

// 时间倒序；时间相同按 id 兜底，保证同一份数据每次渲染顺序一致。
const newestFirst = (a, b) =>
  String(b.at ?? '').localeCompare(String(a.at ?? '')) || String(a.id).localeCompare(String(b.id));

/**
 * 组装灵感收件箱视图模型。
 *
 * @param {object} input
 * @param {object[]} [input.items] 灵感条目；接受 owner-store 的驼峰形状，也接受数据库下划线列名
 * @param {number} [input.limit] 每段最多渲染多少条（计数仍按全量）
 * @returns {object} 两段分组、计数与空态文案
 */
export function ideaInboxView({ items = [], limit = DEFAULT_LIMIT } = {}) {
  const cap = Math.max(1, Number.isSafeInteger(limit) ? limit : DEFAULT_LIMIT);
  const rows = (Array.isArray(items) ? items : [])
    // 任务条目也在这张表里；只认 kind=idea，没写 kind 的合成条目按灵感处理。
    .filter((row) => row && (row.kind === undefined || row.kind === null || row.kind === 'idea'))
    .map((row, index) => {
      const status = String(valueOf(row, 'ideaStatus', 'idea_status', 'inbox'));
      const rawText = String(valueOf(row, 'rawText', 'raw_text', ''));
      const captureSource = String(valueOf(row, 'captureSource', 'capture_source', 'paste'));
      const projectId = valueOf(row, 'projectId', 'project_id', null) || null;
      const title = oneLine(row.title) || oneLine(rawText) || '未命名灵感';
      const at = valueOf(row, 'createdAt', 'created_at', valueOf(row, 'at', 'at', null)) || null;
      return {
        id: String(row.id ?? `row-${index}`),
        title,
        // 列表只显示一行正文，原文完整保留在 rawText 里供对照。
        text: oneLine(rawText || valueOf(row, 'body', 'body', title), 300),
        rawText,
        status,
        statusLabel: STATUS_LABELS[status] ?? status,
        badge: STATUS_LABELS[status] ?? status,
        section: sectionOf(status),
        source: captureSource,
        sourceLabel: SOURCE_LABELS[captureSource] ?? captureSource,
        link: String(valueOf(row, 'link', 'link_url', '')),
        projectId,
        // 全局收件箱的条目不属于任何项目：显示「未归属」，不要露出 null。
        projectLabel: projectId ?? '未归属',
        sorted: row.sorted ?? null,
        sortedAt: valueOf(row, 'sortedAt', 'sorted_at', null) || null,
        at
      };
    });

  const groups = SECTION_DEFS.map((def) => {
    const all = rows.filter((item) => item.section === def.key).sort(newestFirst);
    return {
      key: def.key,
      label: def.label,
      count: all.length,
      shown: Math.min(all.length, cap),
      truncated: all.length > cap,
      items: all.slice(0, cap),
      // 空段不造假条目：只给标记与提示，面板据此显示一行说明。
      empty: all.length === 0,
      emptyHint: def.hint
    };
  });

  const counts = {
    inbox: groups.find((group) => group.key === 'inbox').count,
    sorted: groups.find((group) => group.key === 'sorted').count,
    all: rows.length
  };

  return {
    counts,
    groups,
    emptySections: groups.filter((group) => group.empty).map((group) => group.key),
    // 整张收件箱都没有内容时，给一句「为什么空」，而不是留给界面自己拼。
    empty: counts.all === 0
      ? {
          kind: 'no-ideas',
          title: '收件箱是空的',
          detail: '把想到的点子或链接粘进来；整理之前不需要决定它属于哪个项目。'
        }
      : null
  };
}
