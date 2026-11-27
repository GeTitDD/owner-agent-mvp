// #108 `/` 技能面板的选择规则：纯函数，不碰 DOM、不读库、不发请求。
//
// 为什么单独一个文件：面板里三件容易出错的事——「搜索按 id 还是说明命中」
// 「数字快捷现在指向谁」「两个技能抢同一个数字」——都必须能脱离 Electron
// 用 node --test 直接断言。shell.js 只负责把这份模型画出来。
//
// 数据来源只有一处：src/knowledge/skills.mjs 的扫描结果（域包 / pstack /
// matt / 插件），这里不放任何写死的技能名。
// 双份导出：浏览器当普通脚本加载（挂到 window.OwnerShellSkills），Node 测试用 require 读。
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerShellSkills = api;
})(typeof globalThis === 'undefined' ? null : globalThis, () => {
  // 数字快捷键只有 1-9 九个，和语言无关，也不随技能数量变化。
  const SLOT_COUNT = 9;
  const SLOT_MIN = 1;
  const SLOT_MAX = 9;
  // 数字别名存在渲染进程的 localStorage：它只是「我习惯按几」，不是项目数据。
  // 键名带版本，形状变了可以另起一份而不误读旧值。
  const ALIAS_STORAGE_KEY = 'ownerShell.skillAliases.v1';
  // 来源顺序与 src/knowledge/skills.mjs 的 SKILL_SOURCES 一致。
  const SOURCE_ORDER = ['domain', 'pstack', 'matt', 'plugin', 'local'];

  const str = (value) => (value === undefined || value === null ? '' : String(value));

  /** 查询串：去掉输入框里开头的 `/`，压掉首尾空白；匹配时统一小写。 */
  const normalizeQuery = (raw) => str(raw).replace(/^\//u, '').trim();

  const sourceRank = (source) => {
    const index = SOURCE_ORDER.indexOf(str(source));
    return index < 0 ? SOURCE_ORDER.length : index;
  };

  /**
   * 扫描结果 → 一行一条技能。
   *
   * 优先用主进程带回的完整 items（#108 起 `skills.catalog` 会带）；
   * 老响应只有分组时退回分组，保证面板不会因为字段缺失而空白。
   * 同名 id 只留第一条：扫描本身按来源分开，id 不会重，但输入不该假设这一点。
   */
  const flattenCatalog = (data) => {
    const raw = Array.isArray(data?.items)
      ? data.items
      : (Array.isArray(data?.groups)
        ? data.groups.flatMap((group) => (Array.isArray(group?.items) ? group.items : []))
        : []);
    const seen = new Set();
    const rows = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const id = str(item.id).trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rows.push({
        id,
        name: str(item.name).trim() || id,
        description: str(item.description).trim(),
        source: str(item.source).trim() || 'unknown',
        sourceLabel: str(item.sourceLabel).trim() || str(item.source).trim() || '未知',
        missing: item.missing === true,
        playbookOnly: item.playbookOnly === true,
        reason: str(item.reason).trim(),
        commandName: str(item.commandName).trim() || shortNameOf(id),
        callId: str(item.callId).trim() || id,
        callable: item.callable!==false && item.missing!==true && item.playbookOnly!==true,
        callReason: str(item.callReason || item.reason).trim(),
        origin: str(item.origin).trim(),
        distribution: item.distribution === 'bundled' ? 'bundled' : 'external'
      });
    }
    return rows.sort((a, b) =>
      sourceRank(a.source) - sourceRank(b.source)
      || Number(a.missing) - Number(b.missing)
      || a.name.localeCompare(b.name)
      || a.id.localeCompare(b.id));
  };

  /** 合法的数字快捷只认一位的 1-9；空串、0、10、字母都表示「回到默认」。 */
  const parseSlotNumber = (value) => {
    const text = str(value).trim();
    return /^[1-9]$/u.test(text) ? Number(text) : null;
  };

  /**
   * 默认数字快捷：取扫描结果里前 9 个可用技能，按 1..9 排。
   * 「可用」= 读到了 SKILL.md 且不是只有 playbook 声明；缺失技能不占数字，
   * 否则按 1 会调用到一个根本读不到正文的条目。
   */
  const defaultSlots = (skills, count = SLOT_COUNT) => {
    const cap = Math.min(Math.max(1, Number(count) || SLOT_COUNT), SLOT_MAX);
    const usable = (Array.isArray(skills) ? skills : [])
      .filter((skill) => skill && skill.id && !skill.missing && !skill.playbookOnly && skill.callable!==false);
    return usable.slice(0, cap).map((skill, index) => ({
      id: skill.id,
      number: index + 1,
      defaultNumber: index + 1
    }));
  };

  /** 持久化里的别名形状清洗：只留 1-9，坏键直接丢掉，不让旧数据拖坏界面。 */
  const normalizeOverrides = (raw) => {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [id, value] of Object.entries(raw)) {
      const key = str(id).trim();
      const number = parseSlotNumber(value);
      if (!key || number === null) continue;
      out[key] = number;
    }
    return out;
  };

  /** 排序：数字小的在前；同号时按默认顺序，保证冲突时「排在前面的那个」稳定。 */
  const sortSlots = (slots) => [...(Array.isArray(slots) ? slots : [])].sort((a, b) =>
    a.number - b.number
    || a.defaultNumber - b.defaultNumber
    || str(a.id).localeCompare(str(b.id)));

  /**
   * 数字冲突：同一个数字被两条以上技能占用。
   * 返回可序列化的形状，界面直接据此给行加标记、给页脚写提示。
   */
  const aliasConflicts = (slots) => {
    const byNumber = new Map();
    for (const slot of Array.isArray(slots) ? slots : []) {
      if (!slot || !slot.id) continue;
      const number = Number(slot.number);
      if (!Number.isInteger(number)) continue;
      byNumber.set(number, [...(byNumber.get(number) ?? []), slot.id]);
    }
    const numbers = [...byNumber.keys()]
      .filter((number) => byNumber.get(number).length > 1)
      .sort((a, b) => a - b);
    return {
      numbers,
      ids: [...new Set(numbers.flatMap((number) => byNumber.get(number)))],
      byNumber: Object.fromEntries(numbers.map((number) => [String(number), byNumber.get(number)]))
    };
  };

  /**
   * 默认数字 + 持久化别名合并成当前数字快捷。
   *
   * 合并规则（也是「持久化合并」的唯一口径）：
   *   1. 先按扫描顺序给前 9 个可用技能默认 1..9；
   *   2. 持久化里仍然存在的技能 id 覆盖默认数字；
   *   3. 已经不在扫描结果里的 id、非法数字、与默认相同的值都不再保留；
   *   4. 不替用户消解冲突——两个技能同号就如实返回冲突，由界面标出来。
   */
  const mergeAliases = ({ skills = [], overrides = {}, count = SLOT_COUNT } = {}) => {
    const defaults = defaultSlots(skills, count);
    const stored = normalizeOverrides(overrides);
    const effective = {};
    const slots = defaults.map((slot) => {
      const chosen = Object.prototype.hasOwnProperty.call(stored, slot.id) ? stored[slot.id] : null;
      const number = chosen ?? slot.defaultNumber;
      if (chosen !== null && chosen !== slot.defaultNumber) effective[slot.id] = chosen;
      return { id: slot.id, number, defaultNumber: slot.defaultNumber };
    });
    const sorted = sortSlots(slots);
    return { slots: sorted, overrides: effective, conflicts: aliasConflicts(sorted) };
  };

  /**
   * 改一个数字之后的新持久化映射（纯函数）。
   * 改成默认值或清空 = 删掉覆盖；非法输入原样不动，等用户继续敲。
   */
  const applyAliasEdit = (overrides, slots, id, value) => {
    const next = normalizeOverrides(overrides);
    const slot = (Array.isArray(slots) ? slots : []).find((item) => item.id === id);
    if (!slot) return next;
    const number = parseSlotNumber(value) ?? slot.defaultNumber;
    const previous=slot.number;
    const peers=(Array.isArray(slots)?slots:[]).filter(item=>item.id!==id&&item.number===number);
    for(const peer of peers){if(previous===peer.defaultNumber)delete next[peer.id];else next[peer.id]=previous;}
    if(number===slot.defaultNumber)delete next[id];else next[id]=number;
    return next;
  };

  /** 技能显示名：去掉来源前缀，取最后一段（与面板显示一致）。 */
  const shortNameOf = (id) => str(id).split(/[:/]/u).filter(Boolean).pop() ?? '';

  /**
   * 搜索相关度：名字前缀 > 名字包含 > 完整 id 包含 > 说明包含。
   * -1 表示不命中。名字优先是补全的核心：打 `ask` 应该先出 `ask-matt`，
   * 而不是说明里恰好有 "ask" 的无关技能。
   */
  const rankSkill = (skill, query) => {
    const id = str(skill?.id).toLowerCase();
    const name = str(skill?.commandName||shortNameOf(id)).toLowerCase();
    const display = str(skill?.name).toLowerCase();
    if (!query) return 0;
    if (name.startsWith(query) || display.startsWith(query)) return 0;
    if (name.includes(query) || display.includes(query)) return 1;
    if (id.includes(query)) return 2;
    if (str(skill?.description).toLowerCase().includes(query)) return 3;
    return -1;
  };

  /** 全部技能搜索：命中后按相关度排，同分按 id；空查询原样返回。 */
  const searchSkills = (skills, rawQuery) => {
    const items = Array.isArray(skills) ? skills : [];
    const query = normalizeQuery(rawQuery).toLowerCase();
    if (!query) return items;
    return items
      .map((skill) => ({ skill, rank: rankSkill(skill, query) }))
      .filter((entry) => entry.rank >= 0)
      .sort((a, b) => a.rank - b.rank
        || str(a.skill?.id).localeCompare(str(b.skill?.id)))
      .map((entry) => entry.skill);
  };

  /**
   * 数字快捷的过滤：纯数字按「数字前缀」找（打 /1 能定位 1），
   * 其余按同一套相关度（名字前缀优先）。
   */
  const filterSlots = (slots, rawQuery) => {
    const items = Array.isArray(slots) ? slots : [];
    const query = normalizeQuery(rawQuery);
    if (!query) return items;
    if (/^[0-9]+$/u.test(query)) {
      return items.filter((slot) => str(slot?.number).startsWith(query));
    }
    const lower = query.toLowerCase();
    return items
      .map((slot) => ({ slot, rank: rankSkill(slot?.skill ?? {}, lower) }))
      .filter((entry) => entry.rank >= 0)
      .sort((a, b) => a.rank - b.rank
        || str(a.slot?.skill?.id).localeCompare(str(b.slot?.skill?.id)))
      .map((entry) => entry.slot);
  };

  /**
   * 点一行之后的记录与结果卡（脚本化占位）。
   *
   * 数字行与普通技能行走两条不同的记录文案：前者是「命令」，
   * 后者是「调用技能」；两条都带同一张键值卡，让人一眼核对来源与说明。
   * 这里只产出数据，落库与刷新仍由 shell.js 做。
   */
  const invocationFor = (skill, { kind = 'skill', number = null } = {}) => {
    const id = str(skill?.id).trim();
    const name = str(skill?.name).trim() || id;
    const sourceLabel = str(skill?.sourceLabel).trim() || str(skill?.source).trim() || '未知';
    const description = str(skill?.description).trim();
    const missing = skill?.missing === true;
    const isCommand = kind === 'command';
    const userText = isCommand ? `命令 ${number ?? '·'} · /${id}` : `调用技能 /${id}`;
    const status = missing
      ? `缺失：${str(skill?.reason) || '扫描没有给出原因'}`
      : '扫描到技能定义（本轮不执行）';
    const text = missing
      ? `/${id} 这一条在扫描里是缺失的（${str(skill?.reason) || '原因未记录'}）。${
        isCommand ? `数字快捷 ${number ?? '·'} ` : ''
      }仍然照常记录，脚本化结果不作数。`
      : `已${isCommand ? '执行命令' : '调用技能'} /${id}（来源：${sourceLabel}）。本轮是脚本化结果：真技能接入前只回这张卡。`;
    return {
      userText,
      reply: {
        text,
        blocks: [{
          type: 'kv',
          title: name || id,
          rows: [
            ['技能', `/${id}`],
            ...(name !== id ? [['名称', name]] : []),
            ['来源', sourceLabel],
            ['说明', description || '（扫描没有读到说明）'],
            ['调用', isCommand ? `数字快捷 ${number ?? '·'}` : '从全部技能点选'],
            ['状态', status],
            ['执行', '脚本化占位：不运行真实技能，不写项目目录']
          ]
        }]
      }
    };
  };

  const resolveInvocation = (raw,skills=[]) => {
    const text=str(raw).trim();if(!text.startsWith('/'))return null;
    const matches=[];
    for(const skill of skills){for(const token of new Set([skill.id,skill.commandName||shortNameOf(skill.id)])){
      if(token&&(text===`/${token}`||(text.startsWith(`/${token}`)&&/\s/u.test(text[token.length+1]||''))))matches.push({skill,token});
    }}
    if(!matches.length)return null;
    const max=Math.max(...matches.map(match=>match.token.length));const best=matches.filter(match=>match.token.length===max);
    if(best.length!==1)return {ambiguous:true,ids:best.map(match=>match.skill.id)};
    const {skill,token}=best[0];return {id:skill.callId||skill.id,question:text.slice(token.length+1).trim(),callable:skill.callable!==false&&!skill.missing&&!skill.playbookOnly,reason:skill.callReason||skill.reason||'这条技能当前不能用于对话。'};
  };

  /** 输入确认分隔符后才绑定；保留问题原文，不把搜索中的半个名字当技能。 */
  const typedSelection = (raw, skills = []) => {
    const value = str(raw);
    const prefix = /^\/([^\s]+)\s/u.exec(value);
    if (!prefix) return null;
    const call = resolveInvocation(value, skills);
    if (!call || call.ambiguous || !call.callable) return null;
    const skill = skills.find(item => (item.callId || item.id) === call.id);
    return skill ? { id: skill.id, question: value.slice(prefix[0].length) } : null;
  };

  /** 用已有消息块保存指定身份；重放时不根据可能已变动的目录猜技能。 */
  const selectionBlock = (skill) => skill ? {
    type: 'kv', title: '本轮指定技能', rows: [
      ['技能', skill.callId || skill.id],
      ['名称', `/${skill.commandName || shortNameOf(skill.id)}`],
      ['来源', skill.sourceLabel || skill.source || '未知']
    ]
  } : null;

  const messageSelection = (message) => {
    if (message?.role !== 'user') return null;
    const block = message.blocks?.find(item => item.type === 'kv' && item.title === '本轮指定技能');
    const rows = new Map((block?.rows || []).filter(row => Array.isArray(row) && row.length === 2));
    const id = rows.get('技能'); const name = rows.get('名称');
    if (typeof id !== 'string' || typeof name !== 'string' || !name.startsWith('/')) return null;
    const text = str(message.text);
    const body = text.startsWith(name) && /\s/u.test(text[name.length] || '') ? text.slice(name.length + 1) : text;
    return { id, name, source: rows.get('来源') || '未知', body, block };
  };

  return {
    typedSelection,
    selectionBlock,
    messageSelection,
    resolveInvocation,
    SLOT_COUNT,
    SLOT_MIN,
    SLOT_MAX,
    ALIAS_STORAGE_KEY,
    normalizeQuery,
    flattenCatalog,
    parseSlotNumber,
    defaultSlots,
    normalizeOverrides,
    sortSlots,
    aliasConflicts,
    mergeAliases,
    applyAliasEdit,
    searchSkills,
    filterSlots,
    rankSkill,
    shortNameOf,
    invocationFor
  };
});
