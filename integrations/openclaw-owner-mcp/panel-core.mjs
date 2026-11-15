// 面板里与 Telegram 无关的纯逻辑：分页、状态流转、回调解析、补丁摘要。
//
// 单独拆出来是为了能跑单元测试（node --test），不用连 Telegram。

export const PAGE_SIZE = 5;

/** 分页：把列表切成一页，并给出翻页信息。页码从 0 开始，越界会自动夹紧。 */
export const paginate = (items, page = 0, perPage = PAGE_SIZE) => {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Number(perPage) || PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(list.length / size));
  const current = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  const start = current * size;
  return {
    items: list.slice(start, start + size),
    page: current,
    pages,
    total: list.length,
    hasPrev: current > 0,
    hasNext: current < pages - 1
  };
};

/** 想法的状态循环：点一下切到下一个。 */
export const IDEA_STATUS_CYCLE = ['todo', 'doing', 'blocked', 'done'];

export const nextIdeaStatus = (status) => {
  const index = IDEA_STATUS_CYCLE.indexOf(String(status || ''));
  if (index < 0) return IDEA_STATUS_CYCLE[0];
  return IDEA_STATUS_CYCLE[(index + 1) % IDEA_STATUS_CYCLE.length];
};

/** 解析 `owner:<action>:<剩余参数>`；剩余参数里可以继续带冒号。 */
export const parseCallback = (callback) => {
  const text = String(callback || '').trim();
  if (!text.startsWith('owner:')) return { action: '', arg: '' };
  const parts = text.split(':');
  return { action: parts[1] || '', arg: parts.slice(2).join(':') };
};

/** 二次确认的有效期：2 分钟内没点就失效，避免误点历史按钮。 */
export const CONFIRM_TTL_MS = 120000;

export const isConfirmFresh = (confirm, now = Date.now()) => {
  if (!confirm || typeof confirm !== 'object') return false;
  if (!confirm.type || !confirm.at) return false;
  return now - Number(confirm.at) <= CONFIRM_TTL_MS;
};

/**
 * 从 git diff 里抽出文件列表和增删行数，供二次确认时展示。
 * 只做展示，不判断补丁能不能打。
 */
export const summarizeDiff = (diff) => {
  const text = String(diff || '');
  const files = [];
  let added = 0;
  let removed = 0;
  for (const line of text.split(/\r?\n/u)) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/u.exec(line);
    if (head) {
      // 重命名时两个路径不同，取后者作为展示名。
      files.push(head[2]);
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return {
    files,
    fileCount: files.length,
    added,
    removed,
    preview: text.length > 2600 ? `${text.slice(0, 2599)}…` : text
  };
};

/** 把 diff 里涉及的文件名压成一行，太长就省略。 */
export const formatFileList = (files, max = 5) => {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return '（无文件）';
  const shown = list.slice(0, max).join('、');
  return list.length > max ? `${shown} 等 ${list.length} 个文件` : shown;
};

/**
 * 找出这一轮需要提醒的新知识候选。
 *
 * - `baseline` 为 true（首次运行、没有历史记录）时只建立基线，不提醒，
 *   否则第一次启动会把所有历史候选一次性推给你；
 * - 返回的 `nextSeen` 里只保留当前仍是候选的 id，已处理掉的会自动淘汰，
 *   免得记录文件越来越大。
 */
export const selectNewCandidates = (proposed, seenIds = [], { baseline = false } = {}) => {
  const items = Array.isArray(proposed) ? proposed.filter((item) => item && item.id) : [];
  const seen = new Set(Array.isArray(seenIds) ? seenIds : []);
  const nextSeen = items.map((item) => item.id);
  if (baseline) return { items: [], nextSeen };
  return {
    items: items.filter((item) => !seen.has(item.id)),
    nextSeen
  };
};

