// 「自上次看过」：把 #83 的变化窗口接到水位上的唯一入口。
//
// 这个文件只做两件事，都是为了让「先算差异、再推水位」这个顺序只有一个出口：
// 1. computeSinceLastSeen：读旧水位 → 用旧水位算 changeWindowView → 算完才写新水位。
//    顺序反了就是 ADR-0008 点名的典型 bug（打开一次什么都看不到），所以推进放在函数末尾，
//    中间不允许任何提前 return。
// 2. sinceSeenSection：把变化窗口视图压成面板要画的一段——首次查看要说「首次查看」而不是
//    「没有变化」，三类全空要压成一行。这里不碰 DOM、不读库，可以纯函数测。
//
// 没有水位时（第一次打开某项目）不变相等价于「全部都是新的」，也不等价于「没有变化」：
// 交给 change-window 的 since=null，那里会把提交与事件标成 unknown，界面照它的说法写。
import { changeWindowView } from './change-window.mjs';

/** 每组最多列这么多条，剩下的只报数：面板高度固定，铺满就看不到下面。 */
const MAX_ITEMS_PER_GROUP = 8;

const FIRST_VIEW_LINE = '首次查看：还没有上次看过的时间点，从这次开始记水位，下次进来只显示新增的变化。';
const EMPTY_FALLBACK = '都看过了，自上次之后没有新变化。';

const asIso = (value) => {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) throw new Error('Invalid time');
    return value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && value.trim() && Number.isFinite(Date.parse(value))) {
    return new Date(Date.parse(value)).toISOString();
  }
  throw new Error('Invalid time');
};

/**
 * 算一次「自上次看过」，并在返回前把水位推到 now。
 *
 * 硬约束：computeSinceLastSeen 必须先读旧水位、用它算差异，最后才 put 新水位。
 * 这个函数是唯一写水位的地方；面板的 2 秒刷新不调用它，只有「进入项目」时才调用，
 * 否则每 2 秒推进一次，差异会被自己吃掉。
 *
 * @param {object} input
 * @param {string} input.projectId 项目 id
 * @param {{get:Function, put:Function}} input.store 水位存储（见 watermark.mjs）
 * @param {Array|null} [input.commits] 提交清单；null 表示读不到（窗口会标未知）
 * @param {Array|null} [input.dirty] 未提交改动清单；null 表示读不到
 * @param {Array|null} [input.events] 观察员事件；null 表示读不到
 * @param {Date|string|number} [input.now] 水位要推到的时刻，默认当前
 * @returns {{view:object, advanced:object, previousAt:string}}
 */
export function computeSinceLastSeen({
  projectId, store, commits, dirty, events, now = new Date()
} = {}) {
  const id = String(projectId ?? '').trim();
  if (!id) throw new Error('缺少项目 id');
  if (!store || typeof store.get !== 'function' || typeof store.put !== 'function') {
    throw new Error('缺少水位存储');
  }

  // ① 先读旧水位。没有就是 null —— 按「首次查看」，不是按「没有变化」。
  const previous = store.get(id);
  const previousAt = previous?.at ?? '';

  // ② 用旧水位算差异。这里之后才能碰水位；中间不 return、不提前推进。
  const view = changeWindowView({
    projectId: id,
    since: previousAt || null,
    commits,
    dirty,
    events
  });

  // ③ 算完了才推进。推进目标取 now，与 view 里用的 since 是两个不同的时刻。
  const at = asIso(now);
  const advanced = store.put(id, at);

  return {
    view: { ...view, checkedAt: at, previousAt },
    advanced,
    previousAt
  };
}

/**
 * 只读预览「自上次看过」：读旧水位 → 用旧水位算差异 → 返回，**不写水位**。
 *
 * 定位屏（#139）每行都要显示未读数，但浏览定位屏不是「看过内容」：这里再调
 * computeSinceLastSeen 就会逐行推进水位，未读全被自己吃掉（ADR-0014）。
 * 所以预览只要求 store.get，连 put 都不碰；清零点仍只有 `/变化`（computeSinceLastSeen）
 * 与后续票的「标记已读」。
 *
 * @param {object} input
 * @param {string} input.projectId 项目 id
 * @param {{get:Function}} input.store 水位存储（只要 get；测试里可以给只读替身）
 * @param {Array|null} [input.commits] 提交清单；null 表示读不到
 * @param {Array|null} [input.dirty] 未提交改动清单；null 表示读不到
 * @param {Array|null} [input.events] 观察员事件；null 表示读不到
 * @returns {{view:object, previousAt:string, lastReadAt:string}}
 */
export function previewSinceLastSeen({ projectId, store, commits, dirty, events } = {}) {
  const id = String(projectId ?? '').trim();
  if (!id) throw new Error('缺少项目 id');
  if (!store || typeof store.get !== 'function') throw new Error('缺少水位存储');

  // 只读：没有水位就是「首次查看」，交给 change-window 标未知，不拿当前时间补一个。
  const previous = store.get(id);
  const previousAt = previous?.at ?? '';
  const view = changeWindowView({
    projectId: id,
    since: previousAt || null,
    commits,
    dirty,
    events
  });
  return { view, previousAt, lastReadAt: previousAt };
}

const textOf = (item) => {
  const kind = String(item?.kind ?? '');
  if (kind === 'commit') return [item.shortSha || item.sha, item.title].filter(Boolean).join(' ');
  return String(item?.title ?? item?.path ?? item?.type ?? '');
};

/**
 * 把变化窗口视图压成面板要画的内容。
 *
 * 三种形态：
 * - 首次查看：headline 写「首次查看」，line 解释为什么要从现在开始记；不写「没有变化」。
 *   未提交改动不需要水位就能算，所以首次查看也照常列（它是当下的工作区，不是「新变化」）。
 * - 三类全空：compressed=true，只给一句 compactLine，面板不画卡片、不占块。
 * - 有变化或算不全：给非空分组；算不全时把 change-window 的 unknownText 原样带上。
 *
 * @param {object} view changeWindowView 的输出（或 IPC 回来的同一形状）
 * @returns {{firstView:boolean, compressed:boolean, headline:string, since:string,
 *   line:string, note:string, compactLine:string, total:number,
 *   groups:Array<{key:string,title:string,count:number,more:number,
 *     items:Array<{id:string,text:string,at:string}>}>}}
 */
export function sinceSeenSection(view = {}) {
  const source = view && typeof view === 'object' ? view : {};
  const blocks = Array.isArray(source.blocks) ? source.blocks : [];
  const firstView = source.watermark?.known !== true;
  const status = String(source.status ?? 'unknown');
  const counts = source.counts ?? {};
  const total = Number.isFinite(Number(counts.total)) ? Number(counts.total) : 0;

  // 只有「三类都真的查过、且都为空」才压成一行；算不全时不能这么说。
  const compressed = !firstView && status === 'ok' && source.empty === true;

  const groups = compressed
    ? []
    : blocks
      .filter((block) => Array.isArray(block?.items) && block.items.length > 0)
      .map((block) => {
        const items = block.items.slice(0, MAX_ITEMS_PER_GROUP).map((item) => ({
          id: String(item?.id ?? ''),
          text: textOf(item),
          at: String(item?.at ?? '')
        }));
        return {
          key: String(block.key ?? ''),
          title: String(block.title ?? ''),
          count: block.items.length,
          more: Math.max(0, block.items.length - items.length),
          items
        };
      })
      .filter((group) => group.items.length > 0);

  const line = firstView
    ? FIRST_VIEW_LINE
    : compressed
      ? String(source.emptyText ?? '') || EMPTY_FALLBACK
      : '';

  return {
    firstView,
    compressed,
    headline: firstView ? '首次查看' : '自上次看过',
    since: firstView ? '' : String(source.since ?? ''),
    line,
    // 首次查看由 line 解释，不再叠一段「算不全」；其余算不全的情形原样保留原因。
    note: firstView ? '' : (status === 'ok' ? '' : String(source.unknownText ?? '')),
    compactLine: compressed ? `自上次看过 · ${line}` : '',
    total,
    groups
  };
}
