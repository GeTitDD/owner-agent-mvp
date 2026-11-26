// #107 项目与全局模式的选择状态机：纯函数，不碰 DOM、不读库、不发请求。
//
// 为什么单独一个文件：这一票真正的规则不是「顶栏多一个胶囊」，而是
// 「不选项目 = 全局（只读）」「切项目要先看四条后果」「两个出口各自留下什么」。
// 这些判定必须能脱离 Electron 验证，否则界面会自己长出一套说法。
// 双份导出：浏览器当普通脚本加载（挂到 window.OwnerShellProjects），Node 测试用 require 读。
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerShellProjects = api;
})(typeof globalThis === 'undefined' ? null : globalThis, () => {
  // 不选项目时的名字。顶栏、确认弹窗、说明条共用同一个词，避免「全局 / 全部 / 无项目」三种叫法。
  const GLOBAL_LABEL = '全局';
  const GLOBAL_READ = '不选项目时按关注顺序列出全部项目（有待确认候选 > 有未读变化 > 超过 7 天未看 > 其余），只读';
  const GLOBAL_WRITE = '无——全局模式只读：任何写项目目录都会被拦下，要求先选项目';
  // 两个出口的固定标识：界面按钮与状态迁移共用，别在 DOM 里另写字符串。
  const EXITS = Object.freeze({ inSession: 'in-session', newSession: 'new-session' });

  const normalizeId = (value) => String(value ?? '').trim();

  /** 项目名：缺名字就退回 id；都没有就是空串（由调用方决定怎么显示）。 */
  const nameOf = (projects, id) => {
    const key = normalizeId(id);
    if (!key) return '';
    const found = (Array.isArray(projects) ? projects : []).find((project) => normalizeId(project?.id) === key);
    return String(found?.name ?? '').replace(/\s+/gu, ' ').trim() || key;
  };

  /**
   * 这条会话正在看的项目：空串 = 全局。
   * 以库里的 viewProjectId 为准；老记录没有这一列时退回绑定项目（那时还没有视图状态）。
   */
  const viewProjectIdOf = (session) => {
    if (!session) return '';
    const view = normalizeId(session.viewProjectId);
    if (view) return view;
    // 明确写了空串（全局）与「没有这个字段」要区分开：前者是选择，后者是旧数据。
    if (Object.prototype.hasOwnProperty.call(session, 'viewProjectId')) return '';
    return normalizeId(session.projectId);
  };

  /** 会话的「历史归属」：绑定项目；没绑定就是全局起家。 */
  const historyLabelOf = (session, projects) => {
    const bound = normalizeId(session?.projectId);
    return bound ? nameOf(projects, bound) : GLOBAL_LABEL;
  };

  /** 视图范围标签：全局或项目名。 */
  const scopeLabel = (projects, viewProjectId) => {
    const view = normalizeId(viewProjectId);
    return view ? nameOf(projects, view) : GLOBAL_LABEL;
  };

  /**
   * 跨项目标：会话绑定与正在看的项目不一致。两个方向都算——
   * 项目会话切去全局、全局会话切去项目，都留下过界的痕迹。
   */
  const isCrossProject = (session) => {
    if (!session) return false;
    const bound = normalizeId(session.projectId);
    return bound !== viewProjectIdOf(session);
  };

  /**
   * 顶栏项目胶囊的下拉项：全局永远在第一项，之后是已登记项目。
   * `current` 只标正在看的那一个，不标「上次看过」。
   */
  const projectOptions = (projects, viewProjectId) => {
    const view = normalizeId(viewProjectId);
    const items = [{ id: '', label: GLOBAL_LABEL, hint: GLOBAL_READ, current: view === '' }];
    for (const project of Array.isArray(projects) ? projects : []) {
      const id = normalizeId(project?.id);
      if (!id) continue;
      items.push({
        id,
        label: nameOf([project], id),
        hint: '只读这个项目的记忆；写入落到它，按 ADR-0012 分级',
        current: view === id
      });
    }
    return items;
  };

  /**
   * 切换前的四条后果。顺序固定：历史归属 / 读取来源 / 写入落点 / 跨项目记号。
   * 文案里点名目标项目，用户不用回头再看胶囊上写的是哪一个。
   */
  const switchConsequences = ({ session, projects, targetId } = {}) => {
    const target = normalizeId(targetId);
    const targetLabel = scopeLabel(projects, target);
    const history = historyLabelOf(session, projects);
    const bound = normalizeId(session?.projectId);
    const sameAsBinding = bound === target;

    const items = [
      {
        key: 'history',
        label: '历史归属',
        text: bound
          ? `已发生的消息仍属于「${history}」；切换只改「正在看」，不改写历史。`
          : `这条会话是全局起家的，没有绑定项目；已发生的消息仍属于「${GLOBAL_LABEL}」。`
      },
      {
        key: 'read',
        label: '读取来源',
        text: target
          ? `之后读取「${targetLabel}」的项目记忆（本项目视角，不再是跨项目聚合）。`
          : `之后${GLOBAL_READ}。`
      },
      {
        key: 'write',
        label: '写入落点',
        text: target
          ? `之后的写入落到「${targetLabel}」的项目目录；仍按 ADR-0012 一次一申请。交办目标另设，不受这次切换影响。`
          : GLOBAL_WRITE
      },
      {
        key: 'cross',
        label: '跨项目记号',
        text: sameAsBinding
          ? `会话绑定与正在看的项目一致（都是「${targetLabel}」），顶栏不会打「跨项目」标。`
          : (bound
            ? `会话绑定「${history}」≠ 正在看「${targetLabel}」，会话胶囊会打「跨项目」标。`
            : `会话没有绑定项目，切到「${targetLabel}」后顶栏会打「跨项目」标。`)
      }
    ];

    return {
      target: { id: target, label: targetLabel },
      from: { id: normalizeId(viewProjectIdOf(session)), label: scopeLabel(projects, viewProjectIdOf(session)) },
      history: { id: bound, label: history },
      items,
      crossProject: bound !== target
    };
  };

  /**
   * 两个出口各自要改什么：
   * - 在本会话切换：只改视图范围，会话绑定（历史归属）不动；
   * - 新开会话并切换：新会话绑定目标项目，视图范围跟着它，所以不会有跨项目标。
   * 返回 null 表示出口不认识——调用方据此不动任何状态。
   */
  const exitPlan = ({ session, targetId, exit } = {}) => {
    const target = normalizeId(targetId);
    if (exit === EXITS.newSession) {
      return { kind: EXITS.newSession, projectId: target, viewProjectId: target, rebind: true };
    }
    if (exit === EXITS.inSession) {
      return {
        kind: EXITS.inSession,
        // 绑定不动：这是「历史属谁」的唯一真相。
        projectId: normalizeId(session?.projectId),
        viewProjectId: target,
        rebind: false
      };
    }
    return null;
  };

  /**
   * 在本会话切换后追加到流里的那条说明：历史属谁、之后按谁算。
   * 它是一条普通消息（落库），所以切走、重启后还看得到，不靠内存里的临时提示。
   */
  const switchNote = ({ session, projects, targetId } = {}) => {
    const target = normalizeId(targetId);
    const targetLabel = scopeLabel(projects, target);
    const history = historyLabelOf(session, projects);
    const after = target
      ? `从现在起按「${targetLabel}」读、按「${targetLabel}」写`
      : '从现在起按全局算：不选项目时按关注顺序列出全部项目，只读，不写入任何项目';
    return `（切换项目）这条会话的历史属于「${history}」；${after}。`;
  };

  /** 在本会话切换后紧跟着的键值块：与说明同源，供流里结构化展示。 */
  const switchNoteBlock = ({ session, projects, targetId } = {}) => {
    const target = normalizeId(targetId);
    const targetLabel = scopeLabel(projects, target);
    return {
      type: 'kv',
      title: '切换后的归属',
      rows: [
        { key: '历史归属', value: historyLabelOf(session, projects) },
        { key: '读取来源', value: target ? `${targetLabel}（本项目视角）` : GLOBAL_READ },
        { key: '写入落点', value: target ? `${targetLabel}（按 ADR-0012 分级）` : GLOBAL_WRITE },
        { key: '跨项目记号', value: isCrossProjectAfter(session, target) ? '已打「跨项目」标' : '不打标' }
      ]
    };
  };

  /** 切换「之后」会不会打标：绑定不变，范围换成目标。 */
  const isCrossProjectAfter = (session, targetId) =>
    normalizeId(session?.projectId) !== normalizeId(targetId);

  /** 没有会话时的提示：这时选项目不是「切换」，而是开一条绑定它的新会话。 */
  const NO_SESSION_HINT = '还没有会话：这时选项目会新开一条绑定它的会话；不选项目就是全局。';

  return {
    GLOBAL_LABEL,
    GLOBAL_READ,
    GLOBAL_WRITE,
    EXITS,
    NO_SESSION_HINT,
    nameOf,
    viewProjectIdOf,
    historyLabelOf,
    scopeLabel,
    isCrossProject,
    isCrossProjectAfter,
    projectOptions,
    switchConsequences,
    exitPlan,
    switchNote,
    switchNoteBlock
  };
});
