// #106 会话入口的列表逻辑：纯函数，不碰 DOM、不读库、不发请求。
//
// 为什么单独一个文件：胶囊上写着哪条会话、搜索后剩几条、删完落到哪一条，
// 这三件事决定了「会话是对话流唯一容器」是否成立，必须能脱离 Electron 验证。
// 双份导出：浏览器当普通脚本加载（挂到 window.OwnerShellSessions），Node 测试用 require 读。
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerShellSessions = api;
})(typeof globalThis === 'undefined' ? null : globalThis, () => {
  // 与 chat-sessions.mjs 的 DEFAULT_CHAT_TITLE 对齐：标题空着时界面也要有话说。
  const DEFAULT_TITLE = '新会话';
  const EMPTY_SESSION_HINT = '还没有会话。点顶栏的「会话」新建一个——删光了也一样，没有会话就不能发消息。';

  /** 标题：压掉多余空白；空标题退回默认名，不让列表出现一行空白。 */
  const titleOf = (session) => {
    const text = String(session?.title ?? '').replace(/\s+/gu, ' ').trim();
    return text || DEFAULT_TITLE;
  };

  /** 胶囊上的字：没有当前会话时直说没有，不要显示一个假标题。 */
  const sessionLabel = (session) => (session ? titleOf(session) : '还没有会话');

  /** ISO 时间串直接比大小即可；缺时间排在后面。 */
  const timeOf = (session) => String(session?.updatedAt ?? '');

  /**
   * 列表顺序：置顶在前，其余按最近更新，同一时间用 id 兜底保证稳定。
   * 返回新数组——调用方可以留着上一帧做比较。
   */
  const sortSessions = (list) => [...(Array.isArray(list) ? list : [])].sort((a, b) => {
    const pin = Number(Boolean(b?.pinned)) - Number(Boolean(a?.pinned));
    if (pin !== 0) return pin;
    const left = timeOf(a);
    const right = timeOf(b);
    if (left !== right) return left < right ? 1 : -1;
    return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
  });

  const normalizeQuery = (query) => String(query ?? '').trim().toLowerCase();

  /** 搜索：只按标题过滤，忽略大小写与首尾空白；空查询原样返回（不复制）。 */
  const filterSessions = (list, query) => {
    const items = Array.isArray(list) ? list : [];
    const needle = normalizeQuery(query);
    if (!needle) return items;
    return items.filter((session) => titleOf(session).toLowerCase().includes(needle));
  };

  /**
   * 列表空态：一条会话都没有 vs 搜索没匹配，是两种不同的空。
   * 返回空串表示「有内容可显示」。
   */
  const listHint = (list, query) => {
    const items = Array.isArray(list) ? list : [];
    const trimmed = String(query ?? '').trim();
    if (!items.length) return EMPTY_SESSION_HINT;
    if (trimmed && !filterSessions(items, trimmed).length) {
      return `没有匹配「${trimmed}」的会话。换个词，或者新建一个。`;
    }
    return '';
  };

  /**
   * 删除后的落点：删的是当前会话就落到第一条；删的不是当前就不动；
   * 一条不剩返回空串——界面据此进入「没有会话」的空态，输入框同时锁上。
   */
  const landingAfterDelete = (list, deletedId, currentId) => {
    const items = Array.isArray(list) ? list : [];
    if (String(currentId ?? '') !== String(deletedId ?? '')) return String(currentId ?? '');
    const rest = items.filter((session) => session?.id !== deletedId);
    return rest.length ? String(rest[0].id) : '';
  };

  /** 重命名：压掉多余空白；空串表示取消，调用方据此不发请求。 */
  const normalizeRename = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();

  /** 能不能发消息：只看有没有当前会话（正文判定在 shell-thread.cjs）。 */
  const canCompose = (sessionId) => String(sessionId ?? '').trim().length > 0;

  /**
   * 启动时选哪条：上次打开过的那条（last_opened_at 最新）；
   * 都没打开过就选列表第一条；一条都没有返回空串（进入空态，输入框锁上）。
   */
  const pickInitialSession = (list) => {
    const items = Array.isArray(list) ? list : [];
    let picked = '';
    let newest = '';
    for (const session of items) {
      const at = String(session?.lastOpenedAt ?? '');
      if (!at || at <= newest) continue;
      newest = at;
      picked = String(session.id);
    }
    return picked || String(items[0]?.id ?? '');
  };

  /** 归档入口的字：没有已删除的会话时也不隐藏，保持入口位置稳定。 */
  const archiveLabel = (count) => `已删除 ${Math.max(0, Number(count) || 0)}`;

  return {
    DEFAULT_TITLE,
    EMPTY_SESSION_HINT,
    titleOf,
    sessionLabel,
    sortSessions,
    filterSessions,
    listHint,
    landingAfterDelete,
    normalizeRename,
    canCompose,
    pickInitialSession,
    archiveLabel
  };
});
