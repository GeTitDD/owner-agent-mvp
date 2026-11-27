// #121 卡片壳的输入区：输入框、发送、`/` 技能面板、占位文案与锁定。
//
// 边界：这一块只管输入框与挂在它上面的 `/` 面板（数字快捷 + 全部技能 + 别名编辑），
// 以及 `@@` 的触发（#122）：`@@` 面板本身的菜单 / 方法卡由 shell-at.cjs 画，这里只
// 在输入变化时开合它、在按键优先级里排它。发出去以后的消息落库与重画交给装配层的
// refreshThread；顶栏与对话流分别在 shell-header.cjs / shell-stream.cjs。
// 技能目录只认 src/knowledge/skills.mjs 的扫描结果。
// 双份导出：浏览器当普通脚本加载（挂到 window.OwnerShellCompose），Node 测试用 require 读纯函数。
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerShellCompose = api;
})(typeof globalThis === 'undefined' ? null : globalThis, () => {
  // #138 决策改写与 `/记决策` 共用的一张表单：卡片模型与动作分发只在 decision-form.cjs 里。
  // 浏览器里它先于本文件加载；Node 测试直接 require——与 risk-card.cjs 同一套双份导出。
  const decisionFormApi = (typeof module === 'object' && module.exports)
    ? require('./decision-form.cjs')
    : (typeof globalThis === 'undefined' ? null : globalThis.OwnerDecisionForm);
  const recoveryApi = (typeof module === 'object' && module.exports)
    ? require('./chat-recovery.cjs') : globalThis.OwnerChatRecovery;

  const modelQuestionOf = (text, skillId = '', prefix = '') => {
    const value = String(text).trim();
    if (!skillId) return value;
    const body = prefix && value.startsWith(prefix) ? value.slice(prefix.length) : value;
    return `/skill:${skillId} ${body}`;
  };
  const modelFailureReply = (result = {}, context = {}) => ({
    status: 'error',
    text: [String(result.answer || '这次没有完成回答，原问题已保留，可以重试。'),
      result.partial ? `已产出的部分（未完成）：\n${result.partial}` : ''].filter(Boolean).join('\n\n'),
    blocks: [recoveryApi.normalize({ category: result.category, sourceSeq: context.sourceSeq,
      projectId: context.projectId, skillId: context.skillId, skillPrefix: context.skillPrefix })]
  });

  /**
   * 输入框的占位文案：没有会话时锁死；全局模式「能问不能写」；项目下只提示发送。
   * 纯状态迁移：只看「能不能发 + 正在看的项目」，测试不必起窗口。
   */
  const composerPlaceholder = ({ open, viewProjectId }) => {
    if (!open) return '没有会话时不能发消息：先在顶栏新建一个会话。';
    return viewProjectId
      ? '说点什么。/ 技能，@@ 方法'
      : '全局：能问，不读项目文件。/ 技能，@@ 方法';
  };

  /**
   * 输入框按键的状态迁移：把「面板开没开 / 在不在改数字 / 有没有可选项 / 按了什么」
   * 与「该做什么」分开，单测直接喂状态，不必起窗口。
   *
   * 优先级（从高到低）：
   *   1. 改数字时 Enter / Esc：先收掉编辑态，不抢发送、也不关面板；
   *   2. `@@` 方法面板开着时 Esc / Enter：Esc 只关面板；Enter **关面板并照常发送**
   *      ——#122 的约定：菜单没有键盘选中项，普通 Enter 不能被一张小卡吃掉；
   *   3. `/` 面板开着时 Esc：关面板；
   *   4. `/` 面板开着时 ↑↓：移动选中；
   *   5. `/` 面板开着时 Enter：有可选项就执行选中项；**没有可选项时关面板并照常发送**
   *      ——这一条是 #132 的根因修复：`/risk high`、`/记灵感` 本来就没有匹配项，
   *      不能因为面板开着就把 Enter 吃掉；
   *   6. 其余 Enter（面板关着，或 Shift+Enter 换行之外的普通回车）：发送。
   *
   * `/` 与 `@@` 不会同时开（输入区只开一个），这里仍按「`/` 优先」排，
   * 让纯函数在两者都给 true 时也有确定答案。
   * 返回 preventDefault=false 的只有 Shift+Enter（交给浏览器换行）和无关按键。
   */
  const composerKeyAction = ({
    slashOpen, slashCustomizing, itemCount, atOpen = false, key, shiftKey, exactCommand = false
  }) => {
    if (slashOpen && slashCustomizing && (key === 'Enter' || key === 'Escape')) {
      return { action: 'finish-customize', preventDefault: true };
    }
    if (slashOpen) {
      if (key === 'Escape') return { action: 'close-panel', preventDefault: true };
      if (key === 'ArrowDown') return { action: 'move-down', preventDefault: true };
      if (key === 'ArrowUp') return { action: 'move-up', preventDefault: true };
      if (key === 'Enter') {
        // Shift+回车在面板开着时仍然换行，不发送也不调用。
        if (shiftKey) return { action: 'none', preventDefault: false };
        // 已经打完整条内置命令时，回车就是执行这一条：不能让面板默认选中
        // 另一条「描述里也含这几个字」的命令（例如 /经验 被 /提炼经验 抢走）。
        if (exactCommand) return { action: 'close-and-send', preventDefault: true };
        if (itemCount > 0) return { action: 'invoke', preventDefault: true };
        return { action: 'close-and-send', preventDefault: true };
      }
    }
    if (atOpen) {
      if (key === 'Escape') return { action: 'close-at', preventDefault: true };
      // 菜单没有选中项：Enter 收起面板，把这条照常发出去；Shift+Enter 仍换行。
      if (key === 'Enter') {
        if (shiftKey) return { action: 'none', preventDefault: false };
        return { action: 'close-at-and-send', preventDefault: true };
      }
    }
    if (key === 'Enter' && !shiftKey) return { action: 'send', preventDefault: true };
    return { action: 'none', preventDefault: false };
  };

  // ── #111 旧能力在新壳的最小入口 ─────────────────────────────────────
  //
  // 旧壳删掉后，项目库 / 变化窗口 / 发布 / 监控在新壳里各留一条 `/` 命令：
  // 只做「取数 → 一条回复」，不重建旧界面，也不新增持久状态。数据仍走既有主进程通道
  // （card-project-library / since-last-seen / library-draft|publish / config-box）。
  const CAPABILITY_LABELS = Object.freeze({
    library: '项目库',
    since: '变化窗口',
    publish: '发布',
    monitor: '监控',
    memorySync: '记忆同步'
  });

  /**
   * 内置命令：不是技能，也不扫描目录，输入 `/` 就应该能被找到。
   * 参数命令也可发现：选择时只填入前缀，补充并明确发送后才分派。
   * 不把风险样本当成真实能力列出来；命令仍走普通消息的同一条执行路径。
   */
  const BUILTIN_COMMANDS = Object.freeze([
    Object.freeze({ id: '记灵感', text: '/记灵感', insert:'/记灵感 ', description: '写下一条灵感，补充内容后发送；保存在本机' }),
    Object.freeze({ id: '记忆同步', text: '/记忆同步', aliases:Object.freeze(['/同步','/sync']),description: '打开跨设备同步设置：先检查清单，确认后才传输' }),
    Object.freeze({ id: 'setup', text: '/setup', description: '探测本机：逐项判定，一次确认写盘' }),
    Object.freeze({ id: '提炼经验', text: '/提炼经验', description: '把当前项目里未提炼的执行记录提炼成经验' }),
    Object.freeze({ id: '提炼决策', text: '/提炼决策', description: '扫描当前项目的会话，产出决策候选并在流内确认' }),
    Object.freeze({ id: '记决策', text: '/记决策', description: '手写一条决策：现象、选择、放弃的方案与理由，确认后入库' }),
    Object.freeze({ id: '经验', text: '/经验', description: '查看当前项目的经验与待审候选' }),
    Object.freeze({ id: '项目库', text: '/项目库', description: '当前项目的记忆计数与来源分组' }),
    Object.freeze({ id: '变化', text: '/变化', description: '自上次看过之后的变化（首次只记水位）' }),
    Object.freeze({ id: '发布', text: '/发布', description: '生成发布草稿：下一版、草稿条目数' }),
    Object.freeze({ id: '发布确认', text: '/发布 确认', description: '确认发布：写版本、导出、投递；不可回收' }),
    Object.freeze({ id: '监控', text: '/监控', description: '打开配置箱的监控分区' }),
    Object.freeze({ id: '同步到项目', text: '/同步到项目', description: '把文档同步进项目目录：需确认，一次一问' })
  ]);

  /** 输入框里是否已经是一条完整的内置命令；回车时据此跳过面板默认选中项。 */
  const isExactBuiltinCommand = (value) => {
    const text = String(value ?? '').trim();
    return Boolean(text) && BUILTIN_COMMANDS.some((command) => command.text === text || command.aliases?.includes(text));
  };

  /**
   * 面板与消息里只显示技能名：去掉来源前缀（pstack: / matt:分类/ / domain:…@版本:skills/），
   * 取最后一段。来源由徽章表达，不靠 id 前缀。
   */
  const skillNameOf = (id) => String(id ?? '').split(/[:/]/u).filter(Boolean).pop() ?? '';

  /**
   * 把输入框里的一句话解析成 #111 的旧能力命令；认不出返回 null（照常当普通消息）。
   * `/发布` 只生成草稿，`/发布 确认` 才发布：版本号发布后不能回收，所以确认必须
   * 在命令里再写一次，不靠一次误触。
   */
  const parseCapabilityCommand = (input) => {
    const raw = String(input ?? '').trim();
    const publish = /^\/发布(?:\s+(确认))?$/u.exec(raw);
    if (publish) return { kind: 'publish', confirm: publish[1] === '确认' };
    if (raw === '/项目库') return { kind: 'library', confirm: false };
    if (raw === '/变化') return { kind: 'since', confirm: false };
    if (['/记忆同步','/同步','/sync'].includes(raw)) return {kind:'memorySync',confirm:false};
    if (raw === '/监控') return { kind: 'monitor', confirm: false };
    return null;
  };

  /** 项目库回复：计数 + 三个来源分组。条目正文留给 `@@ 关联项目`，这里只给摘要。 */
  const libraryReply = (view) => {
    const counts = view?.counts ?? {};
    const name = String(view?.project?.name || view?.project?.id || '当前项目');
    const groups = Array.isArray(view?.groups) ? view.groups : [];
    const rows = groups.map((group) => [
      String(group?.key ?? '分组'),
      `${Number(group?.count ?? 0)} 条`,
      Array.isArray(group?.kinds) ? [...new Set(group.kinds.map(String).filter(Boolean))].join(' / ') : ''
    ]);
    return {
      text: `项目库（${name}）：共 ${Number(counts.total ?? 0)} 条，已验证 ${Number(counts.verified ?? 0)} 条、观察中 ${Number(counts.observing ?? 0)} 条。`,
      blocks: [
        {
          type: 'kv',
          title: `项目库 · ${name}`,
          rows: [
            ['条目', `${Number(counts.total ?? 0)} 条`],
            ['已验证 / 观察中', `${Number(counts.verified ?? 0)} / ${Number(counts.observing ?? 0)}`],
            ['画像 / 图谱', `${Number(counts.profile ?? 0)} / ${Number(counts.diagrams ?? 0)}`],
            ['版本', '`/发布` 生成草稿，`/发布 确认` 发布']
          ]
        },
        ...(rows.length
          ? [{ type: 'table', title: '条目来源', head: ['分组', '数量', '种类'], rows }]
          : [])
      ]
    };
  };

  /**
   * 变化窗口回复：首次查看不写成「没有变化」；算不全时如实带一句原因。
   * 这条命令会推进水位；普通切换项目不会。正文落进会话，重启后仍可回查。
   */
  const sinceReply = (view) => {
    const counts = view?.counts ?? {};
    const known = view?.watermark?.known === true;
    const status = String(view?.status ?? 'unknown');
    const blocks = Array.isArray(view?.blocks) ? view.blocks : [];
    const rows = blocks
      .filter((block) => Array.isArray(block?.items) && block.items.length > 0)
      .map((block) => [String(block.title ?? '变化'), `${block.items.length} 条`]);
    const detailBlock = (title, items) => ({
      type: 'kv', title,
      rows: items.map((item) => [String(item.shortSha || item.status || '事件'),
        [item.title || item.path || item.id || '无法识别的条目', item.author, item.at].filter(Boolean).join('\n')])
    });
    const details = blocks.filter((block) => block.items?.length)
      .map((block) => detailBlock(`${block.title} · ${block.items.length} 条`, block.items));
    const unknownItems = Array.isArray(view?.unknown?.items) ? view.unknown.items : [];
    const text = !known
      ? '首次查看：还没有上次看过的时间点，从这次开始记水位，下次只看新增的变化。'
      : (status === 'ok' && view?.empty === true
        ? '自上次看过：没有新变化。'
        : `自上次看过：${Number(counts.total ?? 0)} 处变化${status === 'ok' ? '' : '（有类别算不全）'}。`);
    return {
      text,
      blocks: [
        ...(status === 'ok' ? [] : [{
          type: 'kv',
          title: '变化窗口 · 算不全',
          rows: [['原因', String(view?.unknownText ?? '有一类变化读不到，不能当成没有变化。')]]
        }]),
        ...(rows.length
          ? [{ type: 'table', title: '本次变化', head: ['类别', '条目'], rows }]
          : []),
        ...details,
        ...(unknownItems.length ? [detailBlock('无法判断新旧 · 以下内容未计入新增', unknownItems)] : []),
        {
          type: 'kv',
          title: '变化窗口 · 水位',
          rows: [
            ['上次看过', String(view?.previousAt ?? '（没有水位）')],
            ['本次检查', String(view?.checkedAt ?? '')],
            ['范围', '提交与观察员事件各读取最近 50 条；未提交改动列出当前文件。'],
            ['说明', '这次检查已推进水位，下次只看新增。']
          ]
        }
      ]
    };
  };

  /** 发布回复：草稿阶段给「下一版 + 确认方式」，发布阶段给版本、导出与投递结果。 */
  const publishReply = (view, { confirmed = false } = {}) => {
    const snapshot = view?.snapshot ?? {};
    const published = view?.published ?? null;
    if (!published) {
      const draft = snapshot.draft ?? null;
      const next = String(snapshot.nextLabel || `v${Number(snapshot.nextVersion ?? 1)}`);
      return {
        text: `已生成草稿：下一版 ${next}。确认发布请输入 /发布 确认；发布后版本号不能回收。`,
        blocks: [{
          type: 'kv',
          title: '发布草稿',
          rows: [
            ['下一版', next],
            ['草稿条目', `${Number(draft?.counts?.total ?? 0)} 条`],
            ['草稿时间', String(draft?.generatedAt ?? '')],
            ['确认', '/发布 确认']
          ]
        }]
      };
    }
    const exportDir = String(published.export?.dir ?? view?.export?.dir ?? '');
    const delivery = published.delivery ?? null;
    return {
      text: `已发布 ${String(published.label ?? `v${published.version}`)}。`,
      blocks: [{
        type: 'kv',
        title: '发布回执',
        rows: [
          ['版本', String(published.label ?? `v${published.version}`)],
          ['时间', String(published.publishedAt ?? '')],
          ['导出', exportDir || (published.exportError ? `导出失败：${published.exportError}` : '未导出')],
          ['投递', delivery ? String(delivery.detail || delivery.status || '已处理') : '未投递']
        ]
      }]
    };
  };

  /**
   * `/提炼经验` 的回执：只报数，不把每条经验全文塞进对话；
   * 失败逐条给原因，未尝试就说明「没有待提炼」。
   */
  const distillReply = (result) => {
    if (!result || result.ok !== true) {
      return { text: `没提炼成：${result?.reason || '原因未知'}`, blocks: [] };
    }
    if (result.attempted === 0) {
      return { text: '没有待提炼的执行记录。这里仅处理本应用已完成的执行记录，不会把 Git 提交或普通聊天当作执行证据。外部经验可用 /记灵感 粘贴原文，再在回执上整理并确认；已提炼记录不会重复。', blocks: [] };
    }
    const rows = [
      ['尝试', `${result.attempted} 条`],
      ['写入', `${result.created} 条经验`],
      ['推断', `${result.inferred} 条（没有可追溯证据）`],
      ['失败', `${result.failed?.length ?? 0} 条`],
      ['剩余待提炼', `${result.pending} 条`]
    ];
    if (Array.isArray(result.failed) && result.failed.length) {
      rows.push(['失败原因', result.failed.slice(0, 3)
        .map((item) => `${item.recordId}: ${item.reason}`).join('；')]);
    }
    const table = Array.isArray(result.lessons) && result.lessons.length
      ? result.lessons.slice(0, 5).map((lesson) => ({
        type: 'review',
        kind: 'lesson',
        lessonId: String(lesson.id ?? ''),
        title: String(lesson.phenomenon ?? ''),
        rows: [
          ['机制', String(lesson.mechanism ?? '') || '（未记录）'],
          ['对策', String(lesson.countermeasure ?? '') || '（未记录）'],
          ['状态', String(lesson.verificationStatus ?? '')]
        ],
        actions: [{ id: 'promote', label: '审阅并沉淀' }],
        note: '提升只生成候选；接受后才会写进知识库。'
      }))
      : [];
    return {
      text: `提炼了 ${result.created} 条经验（尝试 ${result.attempted}，失败 ${result.failed?.length ?? 0}）。`,
      blocks: [{ type: 'kv', title: '提炼回执', rows }, ...table]
    };
  };

  /**
   * `/经验 [关键词]` 的回复：待审候选在前，经验在后；
   * 每张卡只带一个主操作，查看不跳页。
   */
  const reviewExcerpt = (value, max = 4000) => {
    const text = String(value ?? '');
    return text.length <= max ? text : `${text.slice(0, max)}\n…（补充信息较长，此处为节选，请回查来源记录。）`;
  };
  const candidateReviewBlock = (item = {}) => ({
      type: 'review',
      kind: 'candidate',
      proposalId: String(item.id ?? ''),
      projectId: item.projectId ?? '', projectName:item.projectName ?? '',
      editKind: 'candidate', expectedHash: item.expectedHash ?? '', editValues: item.editValues ?? {title:item.title||'',content:item.content||'',scope:'project',domains:'',applicability:'',exceptions:''},
      title: String(item.title ?? '待审核候选'),
      rows: [
        ['正文', String(item.content ?? item.claim ?? '') || '（未提供正文，请先核对）'],
        ['范围', item.scopeLabel || '未记录范围，请先核对'],
        ['适用/例外', reviewExcerpt([
          `适用：${(item.applicability ?? []).join('；') || '未记录'}`,
          `例外：${(item.exceptions ?? []).join('；') || '未记录'}`
        ].join('\n'))],
        ['证据', reviewExcerpt(item.evidenceText || '未提供可追证据，请先核对', 6000)],
        ['来源', reviewExcerpt(item.sourceLabel || '未记录来源', 2000)],
        ['验证', item.verificationLabel || '待验证'],
        ['事实/推断', reviewExcerpt([
          ...(item.facts ?? []).map((value) => `事实：${value}`),
          ...(item.inferences ?? []).map((value) => `推断：${value}`),
          ...(item.unknowns ?? []).map((value) => `未知：${value}`),
          ...(item.validationSuggestions ?? []).map((value) => `验证建议：${value}`)
        ].join('\n') || '未另外记录')]
      ],
      actions: [{ id: 'approve', label: '确认沉淀知识' }, { id: 'reject', label: '拒绝' }, {id:'cancel-experience',label:'暂不沉淀'}],
      note: '第二次确认：核对正文、适用条件、例外与范围后写入知识。保持待验证，拒绝只留记录。'
    });

  /** 多张完整候选不能挤破单条会话 64 KiB 上限；分条保存，不截断将入库的正文。 */
  const replyParts = (reply, max = 56 * 1024) => {
    const expanded = [];
    for (const block of reply.blocks ?? []) {
      if ((block.type === 'kv' || block.type === 'table') && Array.isArray(block.rows)) {
        let rows = [];
        for (const row of block.rows) {
          if (rows.length && JSON.stringify({ ...block, rows: [...rows, row] }).length > max) {
            expanded.push({ ...block, rows });
            rows = [];
          }
          rows.push(row);
        }
        expanded.push({ ...block, rows });
      } else expanded.push(block);
    }
    const parts = [{ text: reply.text ?? '', blocks: [] }];
    for (const block of expanded) {
      if (JSON.stringify([block]).length > max) throw new Error('单张内容过长，暂时无法保存；请在工作台查看。');
      let part = parts.at(-1);
      if (part.blocks.length && JSON.stringify([...part.blocks, block]).length > max) {
        part = { text: '内容续页', blocks: [] };
        parts.push(part);
      }
      part.blocks.push(block);
    }
    return parts;
  };

  const lessonsReply = ({ lessons = [], memory = null, pending = [], pendingTotal = pending.length, keyword = '' } = {}) => {
    const candidates = (Array.isArray(pending) ? pending : []).map(candidateReviewBlock);
    const cards = (Array.isArray(lessons) ? lessons : []).slice(0, 5).map((lesson) => ({
      type: 'review',
      kind: 'lesson',
      lessonId: String(lesson.id ?? ''),
      title: String(lesson.phenomenon ?? ''),
      rows: [
        ['机制', String(lesson.mechanism ?? '') || '（未记录）'],
        ['对策', String(lesson.countermeasure ?? '') || '（未记录）'],
        ['状态', String(lesson.statusLabel || ({ unverified: '待验证', inferred: '推断', verified: '已验证', disputed: '争议', superseded: '已被取代' })[lesson.verificationStatus] || '未知')]
      ],
      actions: [{ id: 'promote', label: '审阅并沉淀' }],
      note: '提升只生成候选；接受后才会写进知识库。'
    }));
    const references = memory ? (memory.items ?? []).map(item => item.kind === 'lesson'
      ? ({ type: 'review', kind: 'lesson', lessonId: item.id, title: item.title,
        rows: [['正文',item.content],['状态 / 范围',`${item.statusLabel} · ${item.reason}`],['命中',item.matchReason],['引用',`[${item.ref}]`]],
        actions: [{id:'promote',label:'审阅并沉淀'}],note:'只读经验参考；审阅正文和范围后才能确认为知识。' })
      : ({type:'kv',title:item.title,rows:[['类型 / 状态',`知识 · ${item.statusLabel}`],['正文',item.content],['范围',item.reason],['命中',item.matchReason],['引用',`[${item.ref}]`],['证据',item.evidenceRefs.join('；')||'未提供']]})) : cards;
    const empty = !candidates.length && !references.length;
    const text = empty
      ? (keyword
        ? (memory?.reason || `没有匹配「${keyword}」的经验或知识。`)
        : '还没有经验或知识：本应用的已完成执行记录可用 /提炼经验；外部记录可用 /记灵感 粘贴后整理。')
      : `经验 / 知识 ${references.length} 条，待审核候选 ${candidates.length} 条。${pendingTotal > candidates.length ? `候选共 ${pendingTotal} 条，本次显示 ${candidates.length} 条；处理后重新打开可继续。` : ''}`;
    return { text: text + ((memory?.omitted?.length) ? ' 部分正文超过容量，未截断后充当完整依据；请在工作台核对。' : ''), blocks: [...candidates, ...references] };
  };

  /**
   * `/提炼决策` 的候选卡：复用既有 review 块（kind=decision），不新建页面。
   * 卡片模型由 decision-form.cjs 统一出（#138）：现象只读，选择 / 放弃 / 理由可在本卡内改写；
   * 缺理由显式标注，接受时再问一句，跳过也保持「缺理由」。
   */
  const decisionCandidateBlocks = (pending = []) => (Array.isArray(pending) ? pending : [])
    .slice(0, 5)
    .map((item) => decisionFormApi.candidateCard(item));

  /**
   * `/记决策` 的入口卡：与候选卡同一张表单，从空白开始填。
   * 没有选项目时当场说明为什么不能记：项目级决策必须落在项目下面，不在全局里凭空写。
   */
  const decisionComposeReply = ({ projectId = '', projectName = '' } = {}) => {
    if (!String(projectId ?? '').trim()) {
      return {
        text: '先选一个项目，再记决策：决策要落在项目下面，全局模式不写项目记忆。',
        blocks: []
      };
    }
    return {
      text: '填这张卡：现象、选择、放弃的方案、理由；确认后写入当前项目，取消不写任何东西。理由留空会标为「缺理由」。',
      blocks: [decisionFormApi.composeCard({ projectId, projectName })]
    };
  };

  /**
   * `/提炼决策` 的回执：未处理候选优先、空结果要说「没有新的决策」、失败不伪装成功。
   * 新候选直接出卡，人不用再执行一次命令才看到内容。
   */
  const decisionReply = (result = {}) => {
    const mode = String(result?.mode ?? '');
    const receipt = result?.receipt && typeof result.receipt === 'object' ? result.receipt : {};
    if (mode === 'no-project') {
      return { text: '先选一个项目，再提炼决策：全局模式不会扫描会话。', blocks: [] };
    }
    if (mode === 'failed' || receipt.status === 'failed') {
      const why = String(result?.reason ?? receipt.reason ?? '原因未知');
      return { text: `没有扫成：${why}。没有写任何候选。`, blocks: [] };
    }
    const pending = Array.isArray(result?.pending) ? result.pending : [];
    const cards = decisionCandidateBlocks(pending);
    if (mode === 'pending') {
      return {
        text: `还有 ${pending.length} 条未处理的决策候选：先处理这些；处理完再执行 /提炼决策 才会继续扫描。`,
        blocks: cards
      };
    }
    const status = String(receipt.status ?? '');
    const added = Number(receipt.added) || 0;
    const unpaired = Number(receipt.unpaired) || 0;
    const unpairedNote = unpaired > 0
      ? `另有 ${unpaired} 条只有一方说法：助手没有确认，未列入候选。`
      : '';
    if (status === 'empty') {
      // 空就是空：说清扫过、没有新取舍，不给空白回复，也不拿假的候选顶上。
      return { text: `没有新的决策：当前项目的会话里没有出现新的取舍。${unpairedNote}`, blocks: [] };
    }
    const unreadable = Number(receipt.unreadable) || 0;
    const truncated = Number(receipt.truncated) || 0;
    const rows = [
      ['新增候选', `${added} 条`],
      ['未处理', `${pending.length} 条`],
      ['重复', `${Number(receipt.duplicates) || 0} 条`],
      ['已拒绝', `${Number(receipt.suppressed) || 0} 条`]
    ];
    if (truncated > 0) rows.push(['未扫到', `${truncated} 段（超过本次上限）`]);
    if (unreadable > 0) rows.push(['读不出来', `${unreadable} 段`]);
    if (unpaired > 0) rows.push(['未配对', `${unpaired} 条（助手没有确认，未列入候选）`]);
    if (receipt.redactions > 0) rows.push(['脱敏', `${receipt.redactions} 处`]);
    const partial = status === 'partial';
    const base = partial
      ? `扫描完成，但部分会话没读成：新增 ${added} 条候选，共 ${pending.length} 条未处理。`
      : `扫描完成：新增 ${added} 条决策候选，共 ${pending.length} 条未处理。`;
    const text = `${base}${unpairedNote}`;
    return {
      text,
      blocks: added > 0 || pending.length > 0
        ? [{ type: 'kv', title: '提炼决策回执', rows }, ...cards]
        : []
    };
  };

  // 发送时还会附加关联资料等元数据；它们不是草稿，不能阻止清除已发送的正文。
  const sameDraftContent = (current, sent) => ['id','projectId','text','skillId']
    .every(key => (current?.[key] ?? '') === (sent?.[key] ?? ''));

  const create = (ctx) => {
    const threadApi = ctx.threadApi;
    const listApi = ctx.listApi;
    const skillsApi = ctx.skillsApi;
    const atApi = ctx.atApi;
    const blocksApi = ctx.blocksApi;
    const riskApi = ctx.riskApi;
    const store = ctx.store;
    // #122：`@@` 面板的实例由装配层建，输入区只在运行期取（两块互相引用，不锁构造顺序）。
    const panelAt = () => ctx.ui.at ?? null;
    // #124：输入框上方的关联胶囊由 shell-at-project.cjs 持有；发送时只读一次。
    const projectLinks = () => ctx.ui.atProject ?? null;
    // #114：自有目录写入的判定与回执由 src/own-write.mjs 提供，经 own-write-host.mjs
    // 挂到窗口。模块脚本晚于经典脚本，所以不在加载时断言存在，而是在发送时读。
    const ownWrites = () => window.OwnerOwnWrite ?? null;
    // #115：项目目录同步同理（判定 / 清单 / 会话授权在 src/project-write.mjs）。
    const projectSyncs = () => window.OwnerProjectWrite ?? null;
    // #128：`/setup` 的命令解析在 src/setup-probe.mjs（经 setup-probe-host.mjs 挂到窗口）。
    const setupProbes = () => window.OwnerSetupProbe ?? null;

    const $ = (id) => document.getElementById(id);
    const form = $('composer');
    const input = $('input');
    const sendButton = $('send');
    // 流式中的插入方式开关（引导 / 中止）；只在有回答在跑时出现。
    const insertButton = $('insertMode');
    // 已选技能的胶囊（在输入框上方），与问题分开显示。
    const skillChipBar = $('skillChip');
    const skillChipLabel = $('skillChipLabel');
    const skillChipClear = $('skillChipClear');
    // #108 技能面板的节点：面板本身、两段共用的滚动区、页脚提示与冲突提示。
    const slashPanel = $('skillPanel');
    const slashList = $('skillList');
    const slashCount = $('skillCount');
    const slashHint = $('skillHint');
    const slashConflict = $('skillConflict');
    const slashError = $('skillError');
    const slashToggle = $('skillAliasToggle');
    const slashRefresh = $('skillRefresh');
    const slashReset = $('skillAliasReset');
    input.setAttribute('aria-controls','skillList');input.setAttribute('aria-haspopup','listbox');

    /** 当前会话由顶栏持有：输入区只读，不另存一份。 */
    const currentId = () => ctx.ui.header.currentId();
    const report = (label, action) => ctx.report(label, action);
    const appendReply = async (id, reply) => {
      for (const part of replyParts(reply)) await store.append({ id, role: 'assistant', ...part });
    };

    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    // `/` 面板：技能行来自扫描结果；数字别名只存「我改过的那几个」。
    let skillRows = [];
    let skillCatalogEmpty = null;
    let skillReadError = '';
    let skillsLoaded = false;
    let skillsLoading = false;
    let skillsPending = null;
    let resolvingSkill = false;
    let slashOpen = false;
    let slashQuery = '';
    let slashSelection = 0;
    let slashNavigated = false;
    let slashCustomizing = false;
    let builtinExpanded = false;
    let slashFlat = [];
    let busy = false;
    // 进行中的一轮：停止按钮按它来中止，不猜「当前那一轮」。
    let activeTurn = null;
    // 流式中再发一句的两种方式：steer 插入当前回答 / abort 先停再发。
    let insertMode = 'steer';
    let pendingResend = null;
    // 在一轮还没真正开始（例如正在刷新对话流）时点了停止：等 ask 起来后立刻中止。
    let pendingAbort = false;
    // 「已按下发送、ask 还没起来」的短窗口：这期间停止按钮也必须可点。
    let starting = false;
    // 从技能面板选中的技能：显示成胶囊，发送时才拼进消息。
    let pickedSkill = null;

    // 输入区持有自己的绑定，保存时不临时读顶栏，避免切换途中把旧文字写给新项目。
    let draftScope = { id: '', projectId: '' };
    let draftLoading = false;
    let draftLoadFailed = false;
    let draftToken = 0;
    let draftWrites = Promise.resolve();
    let queuedDraft = '';
    const draftStatus = $('draftStatus');
    const draftKey = (scope) => JSON.stringify([scope.id, scope.projectId]);
    const snapshotDraft = () => ({ ...draftScope, text: input.value, skillId: pickedSkill ?? '' });
    const draftNotice = (text, tone = '') => {
      if (!draftStatus) return;
      draftStatus.textContent = text;
      draftStatus.hidden = !text;
      draftStatus.dataset.tone = tone;
    };
    const queueDraft = () => {
      if (!draftScope.id || draftLoading || draftLoadFailed || !store?.saveDraft) return draftWrites;
      const snapshot = snapshotDraft();
      const signature = JSON.stringify(snapshot);
      if (signature === queuedDraft) return draftWrites;
      queuedDraft = signature;
      if (snapshot.text || snapshot.skillId) draftNotice('正在保存草稿…');
      draftWrites = draftWrites.catch(() => {}).then(() => store.saveDraft(snapshot));
      draftWrites.then(() => {
        if (JSON.stringify(snapshotDraft()) === signature) {
          draftNotice(snapshot.text || snapshot.skillId ? '草稿已保存，仅用于当前会话与项目' : '');
        }
      }).catch((error) => {
        if (draftKey(snapshot) !== draftKey(draftScope)) return;
        queuedDraft = '';
        draftNotice(`草稿未保存：${error?.message ?? error}；请重试后再切换`, 'error');
      });
      return draftWrites;
    };
    const saveDraftInBackground = () => { void queueDraft().catch(() => {}); };
    const restoreDraft = async ({ id = '', projectId = '' } = {}) => {
      const target = { id, projectId };
      if (draftKey(target) === draftKey(draftScope) && !draftLoadFailed) return;
      const token = ++draftToken;
      draftScope = target;
      draftLoading = true;
      draftLoadFailed = false;
      input.value = '';
      pickedSkill = null;
      projectLinks()?.clear?.();
      ctx.ui.sessionPoints?.consume?.();
      panelAt()?.close();
      setSlashOpen(false);
      draftNotice(id ? '正在恢复草稿…' : '');
      syncComposer();
      try {
        const draft = id && store?.draft ? await store.draft(target) : {};
        if (token !== draftToken) return;
        input.value = String(draft.text ?? '');
        pickedSkill = draft.skillId || null;
        queuedDraft = JSON.stringify(snapshotDraft());
        draftNotice(input.value || pickedSkill ? '草稿已恢复，仅用于当前会话与项目' : '');
      } catch (error) {
        draftLoadFailed = true;
        draftNotice('草稿读取失败，重新选择会话后重试', 'error');
        throw error;
      } finally {
        if (token === draftToken) {
          draftLoading = false;
          renderSkillChip();
          resizeInput();
          syncComposer();
        }
      }
    };
    const clearSentDraft = async (snapshot) => {
      if (sameDraftContent(snapshotDraft(), snapshot)) {
        input.value = '';
        pickedSkill = null;
        renderSkillChip();
        queuedDraft = JSON.stringify(snapshotDraft());
        draftNotice('');
      }
      // 与输入保存串行；存储层还会比较发送时的正文，不覆盖后来输入的内容。
      draftWrites = draftWrites.catch(() => {}).then(() => store?.clearDraft?.(snapshot));
      await draftWrites;
    };

    /** 本地只存覆盖项；读失败就当没改过，不阻塞面板。 */
    const readAliases = () => {
      try {
        const raw = localStorage.getItem(skillsApi.ALIAS_STORAGE_KEY);
        return skillsApi.normalizeOverrides(raw ? JSON.parse(raw) : {});
      } catch {
        return {};
      }
    };

    let aliasOverrides = readAliases();

    const saveAliases = () => {
      try {
        localStorage.setItem(skillsApi.ALIAS_STORAGE_KEY, JSON.stringify(aliasOverrides));
      } catch {
        // 本地记忆失败不该挡住一次调用；下次打开面板只是回到默认数字。
      }
    };

    const aliasModel = () => skillsApi.mergeAliases({ skills: skillRows, overrides: aliasOverrides });

    /** 输入框高度跟着内容走，上限三行（CSS 里 max-height 兜底）。 */
    const resizeInput = () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 84)}px`;
    };

    // ── `/` 技能面板：数字快捷 + 全部技能 ────────────────────────────
    // 数据只认 src/knowledge/skills.mjs 的扫描结果（经 skills.catalog 带回），
    // 名字与说明照原样显示，不翻译、不在这里另写一份。

    const setSlashError = (message) => {
      slashError.textContent = String(message ?? '');
      slashError.hidden = !slashError.textContent;
    };

    /** 冲突文案只在这个函数里生成，行内标记与页脚提示必须说同一件事。 */
    const syncConflictText = (conflicts) => {
      if (!conflicts.numbers.length) {
        slashConflict.textContent = '';
        slashConflict.hidden = true;
        return;
      }
      const detail = conflicts.numbers.map((number) => {
        const ids = conflicts.byNumber[String(number)] ?? [];
        return `${number}：${ids.map(id=>{const skill=skillRows.find(row=>row.id===id);return `/${skill?.commandName||skillsApi.shortNameOf(id)}（${skill?.sourceLabel||'未知来源'}）`;}).join('、')}`;
      }).join('；');
      slashConflict.textContent = `旧快捷键重复：${detail}。请明确选择、重新分配或恢复默认；不会自动调用。`;
      slashConflict.hidden = false;
    };

    /** 技能目录只在第一次打开面板时读；失败就留在面板上，不写控制台。 */
    const loadSkills = ({refresh=false}={}) => {
      if(skillsLoading)return skillsPending;
      if(skillsLoaded&&!refresh)return Promise.resolve(true);
      const api = window.companion?.skills?.catalog;
      if (!api) {
        setSlashError('技能目录接口不可用：这个窗口没有拿到主进程桥。');
        return Promise.resolve(false);
      }
      skillsLoading = true;skillReadError='';setSlashError('');
      slashCount.textContent = '读取中…';
      skillsPending=Promise.resolve()
        .then(() => api({refresh}))
        .then((data) => {
          skillRows = skillsApi.flattenCatalog(data);
          skillCatalogEmpty = data?.empty ?? null;
          skillsLoaded = true;
          setSlashError('');
          renderSkillChip();
          if (slashOpen) renderSlash();
          return true;
        })
        .catch((error) => {
          skillReadError=String(error?.message??error);
          setSlashError(`读取技能失败，请点重试。`);
          slashError.title=String(error?.message??error);
          if (slashOpen) renderSlash();
          return false;
        })
        .finally(() => {
          skillsLoading = false;
          if (slashOpen) renderSlash();
        });
      if(slashOpen)renderSlash();
      return skillsPending;
    };

    const ensureSkills = () => {
      if (skillsLoaded || skillsLoading || skillReadError) return;
      loadSkills();
    };

    /**
     * 一行技能。数字行与技能行只在左侧号码与记录文案上不同，
     * 名字 / 说明 / 来源徽章完全一样——来源徽章来自扫描，不在这里猜。
     */
    const slashRow = (skill, { kind, index, slot, conflictIds }) => {
      const row = el('div', 'slash-item');
      row.dataset.kind = kind;
      row.dataset.skillRow = skill.id;
      row.dataset.index = String(index);
      row.id=`slash-option-${index}`;row.setAttribute('role','option');row.setAttribute('aria-selected',index===slashSelection?'true':'false');
      if (index === slashSelection) row.classList.add('is-on');
      if (conflictIds.has(skill.id)) row.classList.add('is-conflict');
      row.setAttribute('aria-disabled',skill.callable===false?'true':'false');
      if(skill.callable===false)row.classList.add('is-unavailable');
      row.title=[skill.id,skill.callReason||skill.reason].filter(Boolean).join(' · ');
      if (kind === 'command') {
        if (slashCustomizing) {
          const field = el('input', 'slash-num-input');
          field.type = 'text';
          field.inputMode = 'numeric';
          field.maxLength = 1;
          field.dataset.aliasFor = skill.id;
          field.value = String(slot?.number ?? '');
          field.setAttribute('aria-label', `技能 ${skill.id} 的快捷键数字`);
          if (conflictIds.has(skill.id)) field.classList.add('is-conflict');
          row.append(field);
        } else {
          row.append(el('span', 'slash-num', String(slot?.number ?? '·')));
        }
      } else {
        // 全部技能这一段的行没有数字：留一个空位对齐，不用假数字。
        row.append(el('span', 'slash-num is-empty', '·'));
      }
      // 只显示技能名：来源前缀（pstack: / matt:分类/ / domain:…）不占宽度，
      // 来源由右侧徽章说明；完整 id 留在 title 与 data-skill-row 上。
      const cmd = el('span', 'slash-cmd', `/${skill.commandName||skillNameOf(skill.id)}`);
      cmd.title = skill.id;
      row.append(cmd);
      const text = el('span', 'slash-text');
      // 说明原样显示，不翻译；名称已经包含在 /id 里，不再多占一行。
      text.append(el('span', 'slash-desc', skill.description || '（扫描没有读到说明）'));
      if(skill.distribution==='bundled')text.append(el('span','slash-context',`应用内置 · ${skill.sourceLabel}${skill.origin&&skill.origin!==skill.source?` · ${skill.origin}`:''}`));
      else if(skill.origin&&skill.origin!==skill.source)text.append(el('span','slash-context',`${skill.sourceLabel} · ${skill.origin}`));
      if(skill.callable===false)text.append(el('span','slash-unavailable',skill.callReason||skill.reason||(skill.playbookOnly?'仅供 Playbook 使用，不在对话中执行':'当前不可调用')));
      row.append(text);
      if (skill.missing) row.append(el('span', 'slash-src is-missing', '缺失'));
      row.append(el('span', `slash-src src-${skill.source}`, skill.sourceLabel));
      return row;
    };

    /**
     * 一行内置命令：和技能行长得一样，但没有数字、没有来源目录。
     * 点它只把那句话填进输入框，核对后再发送，走的是普通消息的同一条路。
     */
    const builtinRow = (command, index) => {
      const row = el('div', 'slash-item');
      row.dataset.kind = 'builtin';
      row.dataset.skillRow = command.id;
      row.dataset.index = String(index);
      row.id=`slash-option-${index}`;row.setAttribute('role','option');row.setAttribute('aria-selected',index===slashSelection?'true':'false');
      if (index === slashSelection) row.classList.add('is-on');
      row.append(el('span', 'slash-num is-empty', '·'));
      const cmd = el('span', 'slash-cmd', command.text);
      cmd.title = command.text;
      row.append(cmd);
      const text = el('span', 'slash-text');
      text.append(el('span', 'slash-desc', command.description));
      row.append(text, el('span', 'slash-src src-command', '应用命令'));
      return row;
    };

    const renderSlash = () => {
      if (!slashOpen) return;
      const model = aliasModel();
      const byId = new Map(skillRows.map((skill) => [skill.id, skill]));
      const quickAll = model.slots
        .map((slot) => ({ ...slot, skill: byId.get(slot.id) }))
        .filter((slot) => slot.skill);
      const quick = skillsApi.filterSlots(quickAll, slashQuery);
      const quickIds = new Set(quickAll.map((slot) => slot.id));
      const slotsById = new Map(quickAll.map((slot) => [slot.id, slot]));
      // 纯数字只指数字快捷：这时下半段不再按 id 里的数字捞人，否则打 /2
      // 会把 alpha-12 之类也带出来，和「按数字调用」的语义打架。
      const numericQuery = /^[0-9]+$/u.test(skillsApi.normalizeQuery(slashQuery));
      const conflictIds = new Set(model.conflicts.ids);
      // 内置命令排在最前：打 `/` 先看到「能做什么」，再看到「装了哪些技能」。
      const query = skillsApi.normalizeQuery(slashQuery);
      const builtinMatches = BUILTIN_COMMANDS.filter((command) =>
        !query || command.id.includes(query) || command.text.includes(query)
        || command.description.includes(query) || command.aliases?.some(alias=>alias.includes(query)))
        // 名字前缀命中排在「只是描述里带这几个字」前面：
        // 打 /经验 时，/经验 不能排在 /提炼经验 后面。
        .sort((a, b) => {
          if (!query) return 0;
          const rank = (command) => (command.aliases?.includes(`/${query}`)||command.text===`/${query}`?0:command.text.startsWith(`/${query}`)?1:command.id.startsWith(query)?2:3);
          return rank(a) - rank(b);
        });
      const builtin = query || builtinExpanded ? builtinMatches : [];
      const builtinRows = builtin.map((command) => ({ id: command.id, kind: 'builtin', text: command.insert||command.text }));

      slashList.replaceChildren();
      if(skillsLoaded&&!skillRows.length&&!query)slashList.append(el('p','slash-empty','当前目录没有技能。下方内置命令仍可使用；检查技能目录与声明后点刷新。'));
      if (!query) {
        const toggle=el('button','slash-group slash-command-toggle',`应用命令 · ${builtinMatches.length} · ${builtinExpanded?'收起 ▴':'展开 ▾'}`);
        toggle.type='button';toggle.dataset.builtinToggle='1';toggle.setAttribute('aria-expanded',String(builtinExpanded));
        slashList.append(toggle);
      } else slashList.append(el('div', 'slash-group',`应用内置命令 · ${builtin.length}（已过滤）`));
      builtin.forEach((command, index) => {
        slashList.append(builtinRow(command, index));
      });

      if (query) {
        // 搜索模式：合成一张列表，按相关度排（名字前缀优先）。
        // 不再先摆「数字快捷」——否则打 `ask` 会先看到说明里带 ask 的无关技能。
        const matched = numericQuery
          ? quick.map((slot) => ({ skill: slot.skill, slot }))
          : skillsApi.searchSkills(skillRows, slashQuery)
            .map((skill) => ({ skill, slot: slotsById.get(skill.id) ?? null }));
        slashFlat = [
          ...builtinRows,
          ...matched.map(({ skill, slot }) => ({
            id: skill.id, kind: slot ? 'command' : 'skill'
          }))
        ];
        if (slashSelection >= slashFlat.length) {
          slashSelection = Math.max(0, slashFlat.length - 1);
        }
        slashList.append(el('div', 'slash-group', `匹配 · ${matched.length}（已过滤）`));
        matched.forEach((entry, offset) => {
          slashList.append(slashRow(entry.skill, {
            kind: entry.slot ? 'command' : 'skill',
            index: builtin.length + offset,
            slot: entry.slot,
            conflictIds
          }));
        });
      } else {
        // 空查询：保持两段——数字快捷 + 全部技能。
        const rest = skillRows.filter((skill) => !quickIds.has(skill.id));
        slashFlat = [
          ...builtinRows,
          ...quickAll.map((slot) => ({ id: slot.id, kind: 'command' })),
          ...rest.map((skill) => ({ id: skill.id, kind: 'skill' }))
        ];
        if (slashSelection >= slashFlat.length) {
          slashSelection = Math.max(0, slashFlat.length - 1);
        }
        slashList.append(el('div', 'slash-group',
          `数字快捷 · ${quickAll.length}${slashCustomizing ? '（改数字 1-9，空着回默认）' : ''}`));
        quickAll.forEach((slot, index) => {
          slashList.append(slashRow(slot.skill, {
            kind: 'command', index: builtin.length + index, slot, conflictIds
          }));
        });
        slashList.append(el('div', 'slash-group', `全部技能 · ${rest.length}`));
        rest.forEach((skill, offset) => {
          slashList.append(slashRow(skill, {
            kind: 'skill', index: builtin.length + quickAll.length + offset, slot: null, conflictIds
          }));
        });
      }

      if (slashFlat.length === 0) {
        const message = !skillsLoaded && skillsLoading
          ? '正在读取技能目录…'
          : (skillCatalogEmpty?.detail
            || (skillRows.length
              ? `没有匹配「${skillsApi.normalizeQuery(slashQuery)}」的技能。换个词，或者只打一个 / 看全部。`
              : '扫描没有找到技能：检查本机技能目录、pstack/matt 设置、域包 manifest 或插件 ghost.json。'));
        slashList.append(el('p', 'slash-empty', message));
      }

      if(slashRefresh){slashRefresh.disabled=skillsLoading;slashRefresh.textContent=skillsLoading?'读取中…':(skillReadError?'重试':'刷新');}
      if(slashReset)slashReset.hidden=!slashCustomizing;
      slashCount.textContent = skillsLoaded
        ? `可用 ${skillRows.filter(row=>row.callable!==false).length} / ${skillRows.length} · 快捷 ${model.slots.length}`
        : (slashError.hidden ? '读取中…' : '读取失败');
      slashToggle.textContent = slashCustomizing ? '完成' : '自定义';
      slashToggle.setAttribute('aria-pressed', slashCustomizing ? 'true' : 'false');
      slashHint.textContent = slashCustomizing
        ? '数字 1-9；占用时交换，清空回默认。旧冲突可恢复默认；改完点「完成」。'
        : '↑↓ 选择 · Enter 选中后补充问题 · 技能带来源高亮 · Esc 关闭';
      syncConflictText(model.conflicts);
      // 键盘移动后把选中行带进视野；初始选中第一行时等于不滚动。
      const active=slashList.querySelector('.slash-item.is-on');
      if(active)input.setAttribute('aria-activedescendant',active.id);else input.removeAttribute('aria-activedescendant');
      active?.scrollIntoView({ block: 'nearest' });
    };

    /** 改数字时不重画整段：重画会让输入框丢焦点，只更新冲突标记。 */
    const refreshSlashConflicts = () => {
      const model = aliasModel();
      const conflictIds = new Set(model.conflicts.ids);
      slashList.querySelectorAll('[data-alias-for]').forEach((field) => {
        field.value=String(model.slots.find(slot=>slot.id===field.dataset.aliasFor)?.number||'');
        field.classList.toggle('is-conflict', conflictIds.has(field.dataset.aliasFor));
      });
      slashList.querySelectorAll('.slash-item').forEach((row) => {
        row.classList.toggle('is-conflict', conflictIds.has(row.dataset.skillRow));
      });
      syncConflictText(model.conflicts);
    };

    const setSlashOpen = (open) => {
      if (open === slashOpen) {
        if (open) renderSlash();
        return;
      }
      slashOpen = open;
      slashPanel.hidden = !open;
      input.setAttribute('aria-expanded',open?'true':'false');
      if(!open)input.removeAttribute('aria-activedescendant');
      if (!open) {
        slashCustomizing = false;
        slashSelection = 0;
        slashToggle.setAttribute('aria-pressed', 'false');
        return;
      }
      // 打开技能面板先收起会话浮层：两个浮层不该同时压着。
      ctx.ui.header.closePopoverIfOpen();
      slashSelection = 0;slashNavigated=false;
      builtinExpanded = false;
      if(!skillReadError)setSlashError('');
      slashQuery = input.value.startsWith('/') ? input.value.slice(1) : '';
      ensureSkills();
      renderSlash();
    };

    const closeSlashPanel = () => {
      setSlashOpen(false);
      input.focus();
    };

    const toggleSlashCustomizing = () => {
      if (!slashOpen) return;
      slashCustomizing = !slashCustomizing;
      slashToggle.setAttribute('aria-pressed', slashCustomizing ? 'true' : 'false');
      renderSlash();
      if (slashCustomizing) queueMicrotask(() => slashList.querySelector('[data-alias-for]')?.focus());
      else input.focus();
    };

    const moveSlashSelection = (delta) => {
      if (!slashFlat.length) return;
      slashNavigated=true;
      slashSelection = (slashSelection + delta + slashFlat.length) % slashFlat.length;
      renderSlash();
    };

    /**
     * `/` 面板开关：后面的字都当查询，空查询看全部。
     *
     * 例外：#109 的 `/blocks` 是块全览的临时命令，仍按普通发送走。
     * 它只是样本入口，随 sampleReply 一起删除；删掉后这个例外也一起删。
     */
    const syncSlashFromInput = () => {
      const value = input.value;
      // #116：/外发、/删除、/同步 与 /blocks 一样是整句命令，没有可调用的技能，
      // 不能让 `/` 面板把回车吃掉——否则「有匹配项才调用」会变成「永远调不到」。
      // #128：/setup 同样不塞进技能面板（面板只列技能），否则会被 setup-pstack 之类的技能截走。
      const legacySample = value.trim() === blocksApi.SAMPLE_COMMAND
        || (Boolean(window.OwnerConfirm?.isCommand(value))&&!isExactBuiltinCommand(value))
        || Boolean(window.OwnerSetupProbe?.isCommand?.(value));
      if (!value.startsWith('/') || legacySample) {
        if (slashOpen) setSlashOpen(false);
        return;
      }
      // 技能后面一旦写进空格（`/matt:… 问题`），这一条就是消息而不是搜索：
      // 再匹配技能只会把面板一直顶在对话上。
      if (/\s/u.test(value.slice(1))) {
        if (slashOpen) setSlashOpen(false);
        return;
      }
      if (!slashOpen) {
        setSlashOpen(true);
        return;
      }
      const next = value.slice(1);
      if (next !== slashQuery) {
        slashQuery = next;
        if(!skillReadError)setSlashError('');
        slashSelection = 0;slashNavigated=false;
      }
      renderSlash();
    };

    /**
     * `@@` 面板（#122）：只按「输入末尾有没有 @@」开合，怎么画由 shell-at.cjs 负责。
     *
     * - 草稿以 `/` 开头时 `/` 优先：两个浮层不同时压着，`@@` 面板收起；
     * - 菜单是临时提示：正文不再以 @@ 结尾就收起；
     * - 已经进了方法卡就不跟着正文收起——那是一张有状态的任务卡，只由返回 / 关闭离开。
     */
    const syncAtFromInput = () => {
      const at = panelAt();
      if (!at) return;
      if (input.value.startsWith('/')) {
        if (at.isOpen()) at.close();
        return;
      }
      if (atApi.atTrigger(input.value)) {
        if (slashOpen) setSlashOpen(false);
        at.openMenu();
        return;
      }
      if (at.step() === 'menu') at.close();
    };

    /**
     * 点一行技能：选中成胶囊，输入框只留问题。
     * 技能是「这一问要用的方法」，和问题分开显示才不会混成一句话。
     */
    const renderSkillChip = () => {
      if (!skillChipBar) return;
      skillChipBar.hidden = !pickedSkill;
      if (skillChipLabel) {
        const skill=skillRows.find(row=>row.id===pickedSkill);
        skillChipLabel.textContent = pickedSkill ? `/${skill?.commandName||skillNameOf(pickedSkill)}${skill?` · ${skill.sourceLabel}`:''}` : '';
        skillChipLabel.title=pickedSkill||'';
      }
      if (!pickedSkill) return;
      input.placeholder = '问这个技能要做什么…';
    };

    const composeSkill = (id) => {
      if (!listApi.canCompose(currentId())) return;
      const skill=skillRows.find(row=>row.id===id);
      if(!skill || skill.callable===false){setSlashError(skill?.callReason||skill?.reason||'这条技能当前不可调用，请刷新后重新选择。');return;}
      pickedSkill = String(id ?? '');
      ctx.notify?.clear?.();
      // 面板是用 `/` 搜出来的：选中后把搜索串清掉，输入框只留问题。
      if (input.value.trim().startsWith('/')) {
        input.value = '';
        resizeInput();
      }
      setSlashOpen(false);
      renderSkillChip();
      syncComposer();
      input.placeholder = '问这个技能要做什么…';
      saveDraftInBackground();
      input.focus();
    };

    /** 手输和粘贴也进入同一已选状态；异步目录只能处理原会话中未变化的原文。 */
    const syncTypedSkill = () => {
      const value = input.value;
      if (pickedSkill || !/^\/\S+\s/u.test(value)) return false;
      if (parseCapabilityCommand(value) || isExactBuiltinCommand(value)
        || ownWrites()?.parseCommand(value) || projectSyncs()?.parseCommand?.(value)
        || setupProbes()?.parseCommand?.(value) || window.OwnerConfirm?.isCommand(value)) return false;
      if (!skillsLoaded) {
        const scope = draftKey(draftScope);
        void loadSkills().then(loaded => {
          if (!loaded || resolvingSkill || scope !== draftKey(draftScope) || input.value !== value || pickedSkill) return;
          if (syncTypedSkill()) { resizeInput(); syncComposer(); saveDraftInBackground(); }
        });
        return false;
      }
      const selection = skillsApi.typedSelection(value, skillRows);
      if (!selection) return false;
      pickedSkill = selection.id;
      ctx.notify?.clear?.();
      input.value = selection.question;
      setSlashOpen(false);
      renderSkillChip();
      return true;
    };

    skillChipClear?.addEventListener('click', () => {
      pickedSkill = null;
      renderSkillChip();
      syncComposer();
      saveDraftInBackground();
      input.focus();
    });

    const skillCommandOf = raw => skillsApi.resolveInvocation(raw,skillRows);

    const invokeSlashSelection = ({explicit=false}={}) => {
      if(!explicit&&!slashNavigated&&/^[1-9]$/u.test(slashQuery)&&aliasModel().conflicts.numbers.includes(Number(slashQuery))){setSlashError('数字重复，请点具体技能、用方向键选择或重新分配。');return;}
      const chosen = slashFlat[slashSelection];
      if (!chosen) return;
      // 技能行（数字快捷与全部技能）都是「填进输入框」；内置命令也只填入，避免一次菜单点击就执行有后果的动作。
      if (chosen.kind === 'skill' || chosen.kind === 'command') {
        composeSkill(chosen.id);
        return;
      }
      if (chosen.kind === 'builtin') {
        setSlashOpen(false);
        input.value = chosen.text;
        resizeInput();syncComposer();saveDraftInBackground();input.focus();
        ctx.notify?.('已填入命令，补充或核对后发送');
        return;
      }
    };

    /** 没有会话就锁死输入框：不给「无会话却能发消息」留半截状态。 */
    const syncComposer = () => {
      const open = listApi.canCompose(currentId()) && !draftLoading && !draftLoadFailed;
      const otherTurn = activeTurn && draftKey(activeTurn) !== draftKey(draftScope);
      if (!open && slashOpen) setSlashOpen(false);
      if (!open) panelAt()?.close();
      input.disabled = !open;
      // 全局模式不是「不能说话」，而是「不写项目」：消息仍落本机自有库，所以输入框不锁；
      // 提示里说清落点为空，要写项目先选项目。
      input.placeholder = pickedSkill
        ? '问这个技能要做什么…'
        : (otherTurn ? '另一会话正在回复，可以先写好草稿…' : composerPlaceholder({ open, viewProjectId: ctx.ui.header.viewProjectId() }));
      // 流式中按钮是「停止」：输入框已经清空，但按钮必须可点。
      sendButton.textContent = otherTurn ? '等待' : ((activeTurn || starting) ? '停止' : '发送');
      sendButton.disabled = otherTurn ? true : ((activeTurn || starting) ? false : (!open || !threadApi.canSend(input.value)));
      if (insertButton) insertButton.hidden = !activeTurn || Boolean(otherTurn);
    };

    /**
     * 自有目录写入（#114）：判定 → 执行 → 回执。
     *
     * 这条路不画确认卡：write-gate 对「自有目录 + 不删除」只会给 allow；全局模式也只是
     * 「不写项目」，写自己的库照样放行。若判定不给 allow（调用方声明删除，或将来混进
     * 项目目录 / 外发动作），这里不执行、也不伪造回执，只说清「要确认」——确认卡是
     * #116 的事，不能借这条路偷偷放行。
     */
    const runOwnWriteTurn = async (command, raw) => {
      const sentDraft = snapshotDraft();
      const api = ownWrites();
      if (!api) {
        ctx.ui.header.setError('自有目录写入模块还没加载好，稍等一下再试。');
        return;
      }
      busy = true;
      try {
        // 先把「我要写什么」落进流里：失败时也看得出是哪一句没写成。
        await store.append({ id: sentDraft.id, role: 'user', text: raw });
        const result = await api.run({
          kind: command.kind,
          text: command.text,
          execute: async (payload) => {
            // 注入点只给验收用：用它复现「写失败」，证明失败回执带原因、不静默。
            const injected = window.OwnerOwnWriteExecutor;
            if (typeof injected === 'function') return injected(payload);
            if (!window.companion || typeof window.companion.ownWrite !== 'function') {
              throw new Error('主进程没有提供自有目录写入接口');
            }
            return window.companion.ownWrite({ kind: payload.kind, text: payload.text });
          }
        });
        if (result.receipt) {
          // 回执是一条普通回复：文字 + 键值块，复制与导出沿用 #109 / #110 的能力。
          await store.append({
            id: sentDraft.id,
            role: 'assistant',
            text: result.receipt.text,
            blocks: result.receipt.blocks
          });
        } else {
          ctx.notify(`这个动作不在自有目录免确认范围内：${result.decision?.gate?.reason ?? ''}`, 'error');
        }
        await clearSentDraft(sentDraft);
        resizeInput();
        await ctx.refreshThread();
        input.focus();
      } finally {
        busy = false;
      }
    };

    /**
     * 这次同步要写哪些文档。
     *
     * 默认来源是「这次会话」：整段对话按既有的消息 → Markdown 能力折成一篇笔记，
     * 落到 docs/notes/<标题>.md。window.OwnerProjectSyncDocs 是注入点（e2e 验多文档清单，
     * 将来接项目库草稿也走这里），返回非空数组就按它来。
     */
    const projectSyncDocs = async ({ sessionId, title, messages }) => {
      const api = projectSyncs();
      const injected = window.OwnerProjectSyncDocs;
      if (typeof injected === 'function') {
        const docs = await injected({ sessionId, title, messages });
        if (Array.isArray(docs) && docs.length > 0) return docs;
      }
      const markdown = messages
        .map((message) => ctx.copyApi.messageToMarkdown(message))
        .filter((text) => String(text ?? '').trim())
        .join('\n\n---\n\n');
      return [api.sessionNoteDoc({ sessionId, title, markdown })];
    };

    /**
     * 项目目录同步（#115）：清单 → 判定 → 确认卡 或 直接写入 → 回执。
     *
     * 与自有目录那条路的区别只有一处：项目目录未授权时先出确认卡，不在这里写；
     * 授权是会话级的（project-write-host 记会话 id），换会话就重新确认。
     * 没有选项目时明确说「什么都没写」，不回退到第一个项目。
     */
    const runProjectSyncTurn = async (command, raw) => {
      const sentDraft = snapshotDraft();
      const api = projectSyncs();
      if (!api) {
        ctx.ui.header.setError('项目目录同步模块还没加载好，稍等一下再试。');
        return;
      }
      busy = true;
      try {
        const sessionId = currentId();
        const projectId = ctx.ui.header.viewProjectId();
        const session = ctx.ui.header.currentSession();
        const title = command.title || listApi.titleOf(session);
        // 先算正文再落「我的一句话」：这条命令本身不该被写进同步的笔记里。
        const detail = await store.transcript({ id: sessionId });
        const messages = threadApi.fromStored(detail?.messages);
        const docs = await projectSyncDocs({ sessionId, title, messages });
        await store.append({ id: sessionId, role: 'user', text: raw });
        let reply = null;
        if (!projectId) {
          reply = { text: '同步到项目目录要先在顶栏选一个项目：这次什么都没写。', blocks: [] };
        } else {
          try {
            reply = await api.request({ sessionId, projectId, docs });
          } catch (error) {
            // 算清单失败（路径非法 / 项目不在 / 没接主进程）也要留在流里，不静默。
            reply = { text: `没有同步：${error?.message || '未知原因'}`, blocks: [] };
          }
        }
        await store.append({
          id: sessionId,
          role: 'assistant',
          text: reply?.text ?? '',
          blocks: Array.isArray(reply?.blocks) ? reply.blocks : []
        });
        await clearSentDraft(sentDraft);
        resizeInput();
        await ctx.refreshThread();
        input.focus();
      } finally {
        busy = false;
      }
    };

    /**
     * `/setup`（#128）：探测 → 逐项判定 → 建议写入清单 → 一次确认 → 写入 → 回执。
     *
     * 这里只负责把命令落进流并打开配置箱的探测态；探测与确认都在配置箱里完成。
     * 回执通过 onReceipt 回调回来，作为一条普通回复落库（键值块），与 #114 / #115 同形。
     * 取消 / 直接关闭配置箱也走这条回调，回执会写明「0 处写入」。
     */
    /**
     * `/提炼经验`：显式触发一次蒸馏（执行记录 → Lesson），回执落进流。
     * 不选项目时由主进程拒绝并给出原因；不后台跑、不重复提炼。
     */
    const runDistillTurn = async (raw, limit) => {
      const sentDraft = snapshotDraft();
      const bridge = window.companion?.knowledge;
      if (typeof bridge?.distill !== 'function') {
        ctx.ui.header.setError('这个窗口没有拿到提炼接口（companion.knowledge.distill）。');
        return;
      }
      const sessionId = currentId();
      busy = true;
      try {
        await store.append({ id: sessionId, role: 'user', text: raw });
        await clearSentDraft(sentDraft);
        resizeInput();
        const result = await bridge.distill({
          projectId: ctx.ui.header.viewProjectId(),
          limit
        });
        const reply = distillReply(result);
        await appendReply(sessionId, reply);
        await ctx.refreshThread();
        input.focus();
      } finally {
        busy = false;
      }
    };

    /**
     * `/经验 [关键词]`：显式查看经验。待审候选在前，经验在后；
     * 只出卡片，不跳页；没有经验时给下一步（/提炼经验）。
     */
    const runLessonsTurn = async (raw, keyword) => {
      const sentDraft = snapshotDraft();
      const bridge = window.companion?.knowledge;
      if (typeof bridge?.lessonList !== 'function') {
        ctx.ui.header.setError('这个窗口没有拿到经验接口（companion.knowledge.lessonList）。');
        return;
      }
      const sessionId = currentId();
      const projectId = ctx.ui.header.viewProjectId();
      busy = true;
      try {
        await store.append({ id: sessionId, role: 'user', text: raw });
        await clearSentDraft(sentDraft);
        resizeInput();
        const [memory, pending] = await Promise.all([
          bridge.recall({ projectId, query: keyword, limit: 5 }),
          bridge.pendingProposals?.({ projectId, keyword, limit: 20 }) ?? Promise.resolve({ items: [] })
        ]);
        const reply = lessonsReply({ memory, pending: pending?.items ?? [], pendingTotal: pending?.total, keyword });
        await appendReply(sessionId, reply);
        await ctx.refreshThread();
        input.focus();
      } finally {
        busy = false;
      }
    };

    /** 定位屏读取已有内容，不挪用输入框、不清草稿，也不触发决策扫描。 */
    let openingLocate = false;
    const openFromLocate = async (intent) => {
      if (openingLocate) return;
      const sessionId = currentId();
      const projectId = ctx.ui.header.viewProjectId();
      if (!sessionId || !projectId) throw new Error('先进入一个项目，再查看内容。');
      openingLocate = true;
      const stopNotice = ctx.notify?.(intent === 'since' ? '正在读取具体变化…' : '正在读取已有的待确认内容…');
      try {
        const bridge = window.companion;
        let reply;
        if (intent === 'since') {
          reply = sinceReply(await bridge.sinceLastSeen({ projectId }));
        } else {
          const results = await Promise.allSettled([
            bridge.knowledge.pendingProposals({ projectId, limit: 5 }),
            bridge.memory.pendingDecisions({ projectId })
          ]);
          if (results.every((result) => result.status === 'rejected')) throw new Error('待确认内容读取失败，请返回定位屏重试；未改动任何候选。');
          const knowledge = results[0].status === 'fulfilled' ? results[0].value : null;
          const decisions = results[1].status === 'fulfilled' ? results[1].value?.pending ?? [] : null;
          const items = knowledge?.items ?? [];
          const decisionItems = decisions?.slice(0, 5) ?? [];
          const totals = [
            knowledge ? `知识候选共 ${knowledge.total} 条，本次显示 ${items.length} 条` : '知识候选读取失败，请返回重试',
            decisions ? `决策候选共 ${decisions.length} 条，本次显示 ${decisionItems.length} 条` : '决策候选读取失败，请返回重试'
          ];
          reply = {
            text: `${totals.join('；')}。只展示已有内容，没有扫描新会话。${items.length + decisionItems.length ? '处理后可从定位屏重新打开，继续查看剩余候选。' : ''}`,
            blocks: [...items.map(candidateReviewBlock), ...decisionCandidateBlocks(decisionItems)]
          };
        }
        await store.append({ id: sessionId, role: 'user', text: intent === 'since' ? '查看项目变化' : '查看待确认内容' });
        await appendReply(sessionId, reply);
        await ctx.refreshThread();
        if (currentId() === sessionId && ctx.ui.header.viewProjectId() === projectId) ctx.ui.stream.revealLatestReply();
      } finally {
        openingLocate = false;
        stopNotice?.();
      }
    };

    /**
     * `/提炼决策`（#135）：显式扫描当前项目的会话，产决策候选；
     * 没有候选、扫描失败、还有未处理候选都各给一条明确回执，不调模型、不留后台任务。
     * 未处理候选与拒绝名单由主进程存进 memory-scan.json，壳只显示结果。
     */
    const runDecisionTurn = async (raw) => {
      const sentDraft = snapshotDraft();
      const bridge = window.companion?.memory;
      if (typeof bridge?.scanDecisions !== 'function') {
        ctx.ui.header.setError('这个窗口没有拿到决策扫描接口（companion.memory.scanDecisions）。');
        return;
      }
      const sessionId = currentId();
      busy = true;
      try {
        await store.append({ id: sessionId, role: 'user', text: raw });
        await clearSentDraft(sentDraft);
        resizeInput();
        const projectId = ctx.ui.header.viewProjectId();
        let result;
        if (!projectId) {
          // 全局模式不扫任何项目：明确说清，不拿全机会话凑候选。
          result = { mode: 'no-project' };
        } else {
          try {
            result = await bridge.scanDecisions({ projectId });
          } catch (error) {
            result = { mode: 'failed', reason: error?.message || '扫描请求失败' };
          }
        }
        const reply = decisionReply(result);
        await store.append({
          id: sessionId,
          role: 'assistant',
          text: reply.text,
          blocks: Array.isArray(reply.blocks) ? reply.blocks : []
        });
        await ctx.refreshThread();
        input.focus();
      } finally {
        busy = false;
      }
    };

    /**
     * `/记决策`（#138）：不扫描、不调模型，只在流里放一张与候选卡同一张形状的表单。
     * 确认 / 取消都由审核卡那一个动作落点处理；这里只负责把卡画出来。
     */
    const runComposeDecisionTurn = async (raw) => {
      const sentDraft = snapshotDraft();
      const sessionId = currentId();
      busy = true;
      try {
        await store.append({ id: sessionId, role: 'user', text: raw });
        await clearSentDraft(sentDraft);
        resizeInput();
        const projectId = ctx.ui.header.viewProjectId();
        const project = (ctx.ui.header.projects?.() ?? []).find((item) => item.id === projectId) ?? null;
        const reply = decisionComposeReply({
          projectId,
          projectName: project?.name ?? ''
        });
        await store.append({
          id: sessionId,
          role: 'assistant',
          text: reply.text,
          blocks: Array.isArray(reply.blocks) ? reply.blocks : []
        });
        await ctx.refreshThread();
        input.focus();
      } finally {
        busy = false;
      }
    };

    const runSetupTurn = async (raw, { appendCommand = true } = {}) => {
      const sentDraft = snapshotDraft();
      if (!setupProbes()) {
        ctx.ui.header.setError('探测模块还没加载好，稍等一下再试。');
        return;
      }
      if (!ctx.ui.config?.openProbe) {
        ctx.ui.header.setError('配置箱还没有探测入口，稍等一下再试。');
        return;
      }
      busy = true;
      try {
        const sessionId = currentId();
        // 命令入口记一条用户消息；配置箱里的「探测本机」是同一个方法，但用户没打字，
        // 所以不伪造一条 /setup，只把回执落进流。
        if (appendCommand) await store.append({ id: sessionId, role: 'user', text: raw });
        const opened = await ctx.ui.config.openProbe({
          onReceipt: async (receipt, meta = {}) => {
            if (!receipt) return;
            // 没有会话时（从配置箱点进来）只把回执留在箱子里，不硬塞进一个不存在的会话。
            if (sessionId) {
              await store.append({
                id: sessionId,
                role: 'assistant',
                text: receipt.text ?? '',
                blocks: Array.isArray(receipt.blocks) ? receipt.blocks : []
              });
              await ctx.refreshThread();
            }
            // 取消也刷新：流里要能看到「0 处写入」的回执，而不是静默收起。
            if (meta.cancelled === true) input.focus();
          }
        });
        if (!opened) {
          ctx.ui.header.setError('探测没有完成，配置与目录都没有变化。');
          return;
        }
        if (appendCommand) {
          await clearSentDraft(sentDraft);
          resizeInput();
        }
      } finally {
        busy = false;
      }
    };

    /**
     * #111 旧能力命令：一条用户消息 + 一条普通回复，落库与刷新走与其它回复相同的路径。
     * 失败也留在流里（不静默），并明确说这次没有写成。
     */
    const runCapabilityTurn = async (command, raw) => {
      const sentDraft = snapshotDraft();
      const label = CAPABILITY_LABELS[command.kind] ?? '命令';
      const bridge = window.companion ?? null;
      const projectId = ctx.ui.header.viewProjectId();
      busy = true;
      try {
        const sessionId = currentId();
        await store.append({ id: sessionId, role: 'user', text: raw });
        let reply;
        try {
          if (command.kind === 'monitor'||command.kind === 'memorySync') {
            const opened = ctx.ui.config?.openSection?.(command.kind==='monitor'?'watch':'sync') === true;
            reply = {
              text: opened
                ? '监控在配置箱的「监控」分区：心跳、水位与变更队列只写自有目录。'
                : '监控配置读不到：配置箱没有打开。',
              blocks: [{
                type: 'kv',
                title: '监控',
                rows: [
                  ['入口', '顶栏「监控」状态位 + `/监控`'],
                  ['状态库', '配置箱 · 监控 · 监控状态库'],
                  ['心跳', '显式触发：observerctl 手动跑一次']
                ]
              }]
            };
            if(command.kind==='memorySync')reply={text:opened?'已打开记忆同步设置。检查只生成清单，确认后才传输；没有配置也不影响本机使用。':'同步设置没有打开，请从齿轮进入同步分区。',blocks:[]};
          } else if (!projectId) {
            reply = {
              text: `「${label}」要先在顶栏选一个项目：全局模式只读聚合，不写任何项目。`,
              blocks: []
            };
          } else if (command.kind === 'library') {
            const api = bridge?.cardScope?.projectLibrary;
            if (typeof api !== 'function') throw new Error('项目库接口还没就绪，稍等一下再试。');
            reply = libraryReply(await api({ projectId }));
          } else if (command.kind === 'since') {
            if (typeof bridge?.sinceLastSeen !== 'function') {
              throw new Error('变化窗口接口还没就绪，稍等一下再试。');
            }
            reply = sinceReply(await bridge.sinceLastSeen({ projectId }));
          } else {
            if (typeof bridge?.library?.draft !== 'function') {
              throw new Error('项目库接口还没就绪，稍等一下再试。');
            }
            reply = command.confirm
              ? publishReply(await bridge.library.publish({ projectId }), { confirmed: true })
              : publishReply(await bridge.library.draft({ projectId }));
          }
        } catch (error) {
          reply = { text: `没有完成「${label}」：${error?.message || '未知原因'}`, blocks: [] };
        }
        await appendReply(sessionId, reply);
        await clearSentDraft(sentDraft);
        resizeInput();
        await ctx.refreshThread();
        input.focus();
      } finally {
        busy = false;
      }
    };

    /** 等待回复时仍可编辑草稿；引导或下一次发送由 send 的会话范围检查决定。 */
    const setStreamingUi = (on) => {
      sendButton.textContent = on ? '停止' : '发送';
      input.readOnly = false;
      if (insertButton) {
        insertButton.hidden = !on;
        if (on) renderInsertMode();
      }
      if (!on) sendButton.disabled = !threadApi.canSend(input.value);
    };

    /** 插入方式的按钮文案：只显示当前会用哪一种，点一下切换。 */
    const renderInsertMode = () => {
      if (!insertButton) return;
      insertButton.textContent = insertMode === 'steer' ? '引导' : '中止';
      insertButton.title = insertMode === 'steer'
        ? '流式中发送：把这一句插进当前回答（steer）'
        : '流式中发送：先停止当前回答，再把这一句发出去';
    };

    /**
     * 流式中再发一句。
     * - steer：落库这句话、插进当前对话流，然后让运行中的会话把它当引导（streamingBehavior=steer），
     *          当前那一轮不中止；
     * - abort：记下这句当作待发，停止当前一轮；停止收尾后自动接着发。
     */
    const insertWhileStreaming = async (text) => {
      const sentDraft = snapshotDraft();
      const turn = activeTurn;
      if (!turn) return;
      if (insertMode === 'abort') {
        pendingResend = sentDraft;
        // 停止确认前仍是草稿；保留在原输入框，切换时也能由正常保存路径落库。
        turn.stop();
        return;
      }
      const bridge = window.companion?.chat;
      const sessionId = sentDraft.id;
      // 这句是这一轮的一部分：先落库，再插进流里（不重绘，否则临时气泡会被删掉）。
      await store.append({ id: sessionId, role: 'user', text });
      await clearSentDraft(sentDraft);
      resizeInput();
      ctx.ui.stream.appendSteerMessage?.(text);
      const result = typeof bridge?.steer === 'function'
        ? await bridge.steer(turn.turnId, text)
        : { steered: false, reason: 'unsupported' };
      if (!result?.steered) {
        ctx.notify?.(result?.reason === 'no-active-turn'
          ? '没有插进去：这一轮刚结束，可以直接发送。'
          : '没有插进去：当前回答已结束或模型不支持引导。', 'warn');
      }
    };

    /**
     * 普通消息：交给只读 Pi 会话（read/grep/find/ls）回答，边跑边画。
     *
     * 全局会话也一样——它只是另一条 Pi 会话（工作目录是自有目录），不是「不能问」：
     * 读不到项目文件，但能答通用问题、也能用 prompt 里的关联线索。
     * 没有模型时 pi-chat 返回 no-model，原样把原因给用户，不编答案。
     */
    const askModel = async (raw, questionForModel = raw, context = snapshotDraft()) => {
      const bridge = window.companion?.chat;
      if (typeof bridge?.ask !== 'function') {
        return modelFailureReply({ category: 'session-error', answer: '模型接口暂时不可用，请重新打开应用后重试。' }, context);
      }
      const turnId = globalThis.crypto?.randomUUID?.() ?? `turn-${Date.now()}-${Math.random()}`;
      const stream = ctx.ui.stream;
      const visible = () => draftKey(context) === draftKey(draftScope);
      if (visible()) stream.beginStream();
      const off = typeof bridge.onEvent === 'function'
        ? bridge.onEvent((event) => {
          if (event?.turnId !== turnId) return;
          if (!visible()) return;
          if (event.type === 'delta') stream.appendText(event.text);
          else if (event.type === 'thinking') stream.appendThinking(event.text);
          else if (event.type === 'tool') stream.appendTool(event);
          else if (event.type === 'turn-reset') stream.resetStreamText();
        })
        : () => {};
      activeTurn = { turnId, ...context, stop: () => { void bridge.abort?.(turnId); } };
      setStreamingUi(true);
      let result;
      try {
        // 先把请求发出去，再处理「准备阶段点过停止」——顺序反了会找不到这一轮。
        const request = bridge.ask({
          turnId,
          sessionId: context.id,
          projectId: context.projectId,
          sourceSeq: context.sourceSeq,
          linkedProjects: context.linkedProjects ?? [],
          question: String(questionForModel ?? '')
        });
        if (pendingAbort) {
          pendingAbort = false;
          activeTurn.stop();
        }
        result = await request;
        // 停止：保留已产出的部分，标「已停止」，不伪装成完整回答。
        if (result?.status === 'aborted') {
          const partial = String(result.answer ?? '').trim();
          return {
            text: partial ? `${partial}\n\n（已停止）` : '（已停止：这次没有产出内容）',
            blocks: [],
            aborted: true
          };
        }
        if (result?.ok === false || result?.status === 'error') return modelFailureReply(result, context);
        const text = String(result?.answer ?? '').trim() || '这次没有结论。';
        const cites = Array.isArray(result?.citations) ? result.citations.filter(Boolean) : [];
        const missing = Array.isArray(result?.missingCitations) ? result.missingCitations.filter(Boolean) : [];
        const rows = [];
        if (cites.length) rows.push(['引用', cites.slice(0, 6).join('、')]);
        if (missing.length) rows.push(['未找到', missing.slice(0, 6).join('、')]);
        const refs=(result?.memory?.items??[]).map(item=>[`${item.kind==='knowledge'?'知识':'经验'} · ${item.statusLabel}`,`[${item.ref}] ${item.title}\n${item.reason} · ${item.matchReason}\n${item.content}\n证据：${item.evidenceRefs.join('；')||'未提供'}`]);
        const blocks=rows.length?[{type:'kv',title:'文件引用',rows}]:[];
        blocks.push({type:'kv',title:'本轮经验引用（只读）',rows:refs.length?refs:[['说明',result?.memory?.reason||'本轮没有命中本地经验或知识；不能把通用回答当作已保存经验。']]});
        if (refs.length) blocks.push({ type:'kv', title:'引用计量', rows:[['说明',
          result?.memory?.referenceTracking?.status === 'failed'
            ? result.memory.referenceTracking.reason
            : result?.memory?.referenceTracking?.status === 'recorded'
              ? '已记录本轮完成对话引用；只表示向模型提供了资料，不代表采纳或收益。'
              : '本轮只展示提供的资料，未记录引用次数；不代表采纳或收益。']] });
        if(result?.memory?.omitted?.length)blocks.push({type:'kv',title:'未注入的资料',rows:result.memory.omitted.map(item=>[item.title,item.reason])});
        return { text, blocks };
      } catch {
        return modelFailureReply({ category: 'network-error', answer: '回答连接中断，原问题仍保存在会话中。可以稍后重试。' }, context);
      } finally {
        off();
        stream.endStream();
        activeTurn = null;
        setStreamingUi(false);
      }
    };

    /** 重试按原消息取问题，绕过命令分派，不新增用户消息，也不清空后来编辑的草稿。 */
    const recoverChat = async (card, action) => {
      const sessionId = currentId();
      if (busy || activeTurn || !listApi.canCompose(sessionId)) {
        ctx.notify?.('请等当前回答结束后再操作，草稿已保留。', 'warn');
        return false;
      }
      const projectId = ctx.ui.header.viewProjectId();
      if (projectId !== String(card.projectId ?? '')) {
        ctx.notify?.('这条问题属于原来的项目，请先切回原项目再重试。', 'warn');
        return false;
      }
      const original = await store.message({ id: sessionId, seq: card.sourceSeq });
      if (!original || original.role !== 'user') throw new Error('没有找到原问题，未发出请求；可以从会话历史中重新选择问题。');
      if (currentId() !== sessionId || ctx.ui.header.viewProjectId() !== projectId) {
        ctx.notify?.('会话已切换，未发出请求；返回原问题后可以继续操作。', 'warn');
        return false;
      }
      if (action === 'restore') {
        // 已有草稿时复制原问题，绝不合并或覆盖它。
        if (input.value || pickedSkill) {
          await window.companion.writeClipboard(original.text);
          ctx.notify?.('输入框已有草稿，原问题已复制；可以自行粘贴。');
        } else {
          input.value = original.text;
          saveDraftInBackground();
          resizeInput();
          input.focus();
          ctx.notify?.('原问题已取回，可编辑后发送。');
        }
        return false;
      }
      busy = true;
      starting = true;
      syncComposer();
      const context = { ...snapshotDraft(), id: sessionId, projectId, sourceSeq: card.sourceSeq,
        skillId: card.skillId, skillPrefix: card.skillPrefix };
      try {
        const reply = await askModel(original.text, modelQuestionOf(original.text, card.skillId, card.skillPrefix), context);
        await store.append({ id: sessionId, role: 'assistant', text: reply.text ?? '', blocks: reply.blocks ?? [],
          status: reply.status === 'error' ? 'error' : 'ok' });
        return true;
      } finally {
        busy = false;
        starting = false;
        syncComposer();
      }
    };

    const send = () => report('发送', async () => {
      // 流式中：有字就按当前插入方式处理，没字就是「停止」。
      if (activeTurn) {
        const draft = input.value.trim();
        if (draft && draftKey(activeTurn) !== draftKey(draftScope)) {
          ctx.notify?.('另一会话正在回复，当前草稿已保留；等回复结束后再发送。', 'warn');
          return;
        }
        if (!draft) {
          activeTurn.stop();
          return;
        }
        await insertWhileStreaming(draft);
        return;
      }
      // 这一轮还在准备（刷新流 / 建入口）：先记下「要停」，等 ask 起来立刻中止。
      if (busy) {
        pendingAbort = true;
        return;
      }
      if (!listApi.canCompose(currentId())) return;
      // 会话在发起时固定：流式跑着时切走会话，回答也要落在它自己的会话里。
      const sessionId = currentId();
      const sentDraft = { ...snapshotDraft(), linkedProjects: ctx.ui.atProject?.links?.() ?? [] };
      const draftText = input.value;
      // 选中的技能拼成消息原文（显示与落库都用这一句），输入框本身只放问题。
      // 消息里只写技能名，不带来源前缀。
      const raw = pickedSkill
        ? `/${skillNameOf(pickedSkill)} ${draftText.trim()}`
        : draftText;
      if (!threadApi.canSend(raw)) return;
      // #111 旧能力的最小入口：/项目库、/变化、/发布、/监控 先于普通消息处理。
      if(resolvingSkill)return;
      const localCommand=isExactBuiltinCommand(raw)||ownWrites()?.parseCommand(raw)||projectSyncs()?.parseCommand?.(raw)||setupProbes()?.parseCommand?.(raw)||/^\/(?:经验|提炼经验)(?:\s|$)/u.test(raw)||window.OwnerConfirm?.isCommand(raw)||blocksApi.isSampleCommand(raw)||riskApi.isRiskCommand(raw);
      if((pickedSkill || (raw.startsWith('/')&&!localCommand))&&!skillsLoaded){
        resolvingSkill=true;
        const loaded=await loadSkills();resolvingSkill=false;
        if(!sameDraftContent(snapshotDraft(),sentDraft)){ctx.notify?.('输入已变化，未发送旧内容。');return;}
        if(!loaded&&pickedSkill){ctx.notify?.('技能目录读取失败，请刷新后重试；问题已保留。','error');return;}
      }
      if(pickedSkill){
        const selected=skillRows.find(skill=>skill.id===pickedSkill);
        if(!selected||selected.callable===false){ctx.notify?.(selected?.callReason||'指定技能已不可用，请刷新目录后重新选择；问题已保留。','error');return;}
      }
      const capability = !pickedSkill&&parseCapabilityCommand(raw);
      if (capability) {
        await runCapabilityTurn(capability, raw);
        return;
      }
      // 自有目录写入（/记灵感 等）：直接执行，不弹确认卡。
      const command = !pickedSkill?(ownWrites()?.parseCommand(raw) ?? null):null;
      if(command?.kind==='idea'&&!String(command.text||'').trim()){ctx.notify?.('请在 /记灵感 后写下内容，再发送。','warn');input.focus();return;}
      if (command) {
        await runOwnWriteTurn(command, raw);
        return;
      }
      // 项目目录同步（/同步到项目）：未授权先出确认卡，授权后按会话直接写。
      const syncCommand = !pickedSkill?(projectSyncs()?.parseCommand?.(raw) ?? null):null;
      if (syncCommand) {
        await runProjectSyncTurn(syncCommand, raw);
        return;
      }
      // 技能行：`/matt:xxx/yyy 问题` 交给模型时转成 /skill:<id> <问题>，
      // 让 pi-chat 把技能正文强制带进这一轮；没有问题时把光标留在技能后面。
      const skillCall = pickedSkill
        ? { id: skillRows.find(row=>row.id===pickedSkill)?.callId||pickedSkill, question: draftText.trim(),callable:true }
        : skillCommandOf(raw);
      if(skillCall?.ambiguous){ctx.notify?.('有多个同名技能，请从 / 面板按来源选择具体一项；问题已保留。','warn');return;}
      if(skillCall?.callable===false){ctx.notify?.(skillCall.reason,'error');return;}
      if (skillCall && !skillCall.question) {
        if (!pickedSkill) composeSkill(skillRows.find(row => (row.callId || row.id) === skillCall.id)?.id);
        ctx.notify?.('给这个技能写一句要它做什么，再发送', 'warn');
        renderSkillChip();
        input.focus();
        return;
      }
      // /记决策：手动写一条决策，卡片与候选改写共用同一张表单（不扫描、不调模型）。
      const composeDecision = !skillCall&&/^\/记决策$/u.exec(raw.trim());
      if (composeDecision) {
        await runComposeDecisionTurn(raw);
        return;
      }
      // /提炼决策：只扫当前项目的会话，产决策候选并留在未处理列表（不调模型）。
      const decisionScan = !skillCall&&/^\/提炼决策$/u.exec(raw.trim());
      if (decisionScan) {
        await runDecisionTurn(raw);
        return;
      }
      // /提炼经验：显式蒸馏当前项目里未提炼的执行记录（会调用模型）。
      const distill = !skillCall&&/^\/提炼经验(?:\s+(\d{1,2}))?$/u.exec(raw.trim());
      if (distill) {
        await runDistillTurn(raw, Number(distill[1]) || 5);
        return;
      }
      // /经验 [关键词]：查看当前项目的经验与待审候选（只读，不调模型）。
      const lessons = !skillCall&&/^\/经验(?:\s+(.+))?$/u.exec(raw.trim());
      if (lessons) {
        await runLessonsTurn(raw, lessons[1] ?? '');
        return;
      }
      // /setup：进配置箱的探测态；一次确认后写入，取消一项都不写。
      const setupCommand = !skillCall?(setupProbes()?.parseCommand?.(raw) ?? null):null;
      if (setupCommand) {
        await runSetupTurn(raw);
        return;
      }
      // 还没接模型：普通消息回占位回复；/blocks 块全览；/risk 确认卡；/外发 /删除 走 #116 的确认卡。
      const confirmCommand = !skillCall?(window.OwnerConfirm?.parseCommand(raw) ?? null):null;
      if (!skillCall && !confirmCommand && !blocksApi.isSampleCommand(raw) && !riskApi.isRiskCommand(raw)
        && /^\/[\p{L}\p{N}_:.-]+(?:\s|$)/u.test(raw)) {
        ctx.notify?.(skillsLoaded ? '没有找到这个技能或命令。请从 / 菜单选择；原文已保留。' : '技能目录尚未读到，请打开 / 菜单刷新后重试；原文已保留。', 'warn');
        input.focus();
        return;
      }
      const modelContext = { ...sentDraft, sourceSeq: 0,
        skillId: skillCall ? skillCall.id : '',
        skillPrefix: skillCall ? raw.trim().slice(0, raw.trim().length - skillCall.question.length) : '' };
      const buildReply = async () => {
        if (!skillCall&&blocksApi.isSampleCommand(raw)) return blocksApi.sampleReply();
        if (!skillCall&&riskApi.isRiskCommand(raw)) return await riskApi.buildRiskReply(raw);
        if (confirmCommand) return await window.OwnerConfirm.buildReply(confirmCommand);
        return await askModel(
          raw,
          modelQuestionOf(sentText, modelContext.skillId, modelContext.skillPrefix),
          modelContext
        );
      };
      // #124 与 #125 都只服务这一次发送：先接「## 关联项目」段，再接会话指针段。
      const text = projectLinks()?.withLinks?.(raw) ?? raw;
      const sessionPoints = ctx.ui.sessionPoints;
      const sentText = sessionPoints ? sessionPoints.withPointers(text) : text;
      busy = true;
      starting = true;
      // 从按下的那一刻起就是「停止」，别让人在准备阶段点到一个灰掉的按钮。
      sendButton.textContent = '停止';
      sendButton.disabled = false;
      try {
        const selected = skillCall && skillRows.find(row => (row.callId || row.id) === skillCall.id);
        const marker = skillsApi.selectionBlock(selected);
        const sentMessage = await store.append({ id: sessionId, role: 'user', text: sentText, blocks: marker ? [marker] : [] });
        modelContext.sourceSeq = sentMessage.seq;
        // 输入框立刻清空：模型要跑一阵，不能让旧文字留在框里让人以为没发出去。
        await clearSentDraft(sentDraft);
        resizeInput();
        // 正文已经落库，胶囊与指针完成使命：清空；发送失败则保留，下一次还能再试。
        projectLinks()?.clear?.();
        sessionPoints?.consume?.();
        // 先刷新一次：模型可能要跑几秒，用户至少要立刻看到自己那句话进去了。
        await ctx.refreshThread();
        const reply = await buildReply();
        await store.append({
          id: sessionId,
          role: 'assistant',
          text: reply.text ?? '',
          status: reply.status === 'error' ? 'error' : 'ok',
          blocks: Array.isArray(reply.blocks) ? reply.blocks : []
        });
        await ctx.refreshThread();
        input.focus();
      } finally {
        busy = false;
        starting = false;
        // 本地回执（/risk、/外发 等）不走流式，收尾要把按钮从「停止」还原。
        if (!activeTurn) {
          sendButton.textContent = '发送';
          syncComposer();
        }
        // abort 插入：停止后把等着的这句接上去，用户不用再按一次发送。
        if (pendingResend) {
          const next = pendingResend;
          pendingResend = null;
          if (JSON.stringify(next) === JSON.stringify(snapshotDraft())) {
            void send();
          } else {
            ctx.notify?.('已停止，草稿仍保留在各自的会话中。');
          }
        }
      }
    });

    /** Esc 的输入区一层：`/` 面板开着就收起；返回是否真的关了。 */
    const dismissSlash = () => {
      if (!slashOpen) return false;
      setSlashOpen(false);
      return true;
    };

    /** Esc 的 `@@` 一层：面板开着就收起（焦点在面板里时按约定还回输入框末尾）。 */
    const dismissAt = () => {
      const at = panelAt();
      if (!at || !at.isOpen()) return false;
      return at.close();
    };

    // ── 事件 ──────────────────────────────────────────────────────────

    // `/` 面板也一样：点别处收起，但点输入框本身不算「别处」。
    document.addEventListener('mousedown', (event) => {
      if (!slashOpen) return;
      if (slashPanel.contains(event.target) || form.contains(event.target)) return;
      setSlashOpen(false);
    });

    input.addEventListener('input', (event) => {
      // 组字尚未提交时不搬动正文，避免中文输入法的组合文本被转成标签。
      if (!event.isComposing) syncTypedSkill();
      resizeInput();
      syncComposer();
      syncSlashFromInput();
      syncAtFromInput();
      saveDraftInBackground();
    });

    input.addEventListener('compositionend', () => {
      syncTypedSkill(); resizeInput(); syncComposer(); syncSlashFromInput(); saveDraftInBackground();
    });

    input.addEventListener('keydown', (event) => {
      // 组字中的回车属于输入法，不能当发送。
      if (event.isComposing || event.keyCode === 229) return;
      // #132：按键优先级集中在 composerKeyAction（纯函数，单测覆盖），这里只执行。
      const plan = composerKeyAction({
        slashOpen,
        slashCustomizing,
        itemCount: slashFlat.length,
        atOpen: Boolean(panelAt()?.isOpen()),
        exactCommand: !slashNavigated&&isExactBuiltinCommand(input.value),
        key: event.key,
        shiftKey: event.shiftKey
      });
      if (plan.preventDefault) event.preventDefault();
      switch (plan.action) {
        case 'finish-customize':
          slashCustomizing = false;
          renderSlash();
          return;
        case 'close-panel':
          setSlashOpen(false);
          return;
        case 'close-at':
          panelAt()?.close();
          return;
        case 'close-at-and-send':
          // `@@` 面板没有键盘选中项：和没有面板时等价——先关面板，再把这条发出去。
          panelAt()?.close();
          void send();
          return;
        case 'move-down':
          moveSlashSelection(1);
          return;
        case 'move-up':
          moveSlashSelection(-1);
          return;
        case 'invoke':
          invokeSlashSelection();
          return;
        case 'close-and-send':
          // 没有匹配项：和没有面板时等价——先关面板，再把这条照常发出去。
          setSlashOpen(false);
          void send();
          return;
        case 'send':
          void send();
          return;
        default:
          return;
      }
    });

    // 面板里的点击：改数字 / 关闭 / 点一行调用。改数字时点行不触发调用。
    slashPanel.addEventListener('click', (event) => {
      if(event.target.closest('[data-builtin-toggle]')){builtinExpanded=!builtinExpanded;slashSelection=0;slashNavigated=false;renderSlash();return;}
      if(event.target.closest('#skillRefresh')){loadSkills({refresh:true});return;}
      if(event.target.closest('#skillAliasReset')){aliasOverrides={};saveAliases();renderSlash();return;}
      if (event.target.closest('#skillAliasToggle')) {
        toggleSlashCustomizing();
        return;
      }
      if (event.target.closest('#skillClose')) {
        closeSlashPanel();
        return;
      }
      if (slashCustomizing) return;
      const row = event.target.closest?.('[data-skill-row]');
      if (!row) return;
      // 点行与回车选中走同一套：技能选择与命令填入都不自动发送。
      const index = Number(row.dataset.index);
      if (!Number.isInteger(index) || index < 0) return;
      slashSelection = index;
      invokeSlashSelection({explicit:true});
    });

    // 数字输入就地生效：不重画列表，否则每敲一位就丢焦点。
    slashList.addEventListener('input', (event) => {
      const field = event.target.closest?.('[data-alias-for]');
      if (!field) return;
      const raw = field.value.replace(/[^0-9]/gu, '').slice(0, 1);
      if (field.value !== raw) field.value = raw;
      aliasOverrides = skillsApi.applyAliasEdit(
        aliasOverrides, aliasModel().slots, field.dataset.aliasFor, raw
      );
      saveAliases();
      refreshSlashConflicts();
    });

    // 改数字的输入框里 Enter/Esc 都是「完成」，不把焦点困在面板里。
    slashList.addEventListener('keydown', (event) => {
      if (event.isComposing || !event.target.closest?.('[data-alias-for]')) return;
      if (event.key !== 'Enter' && event.key !== 'Escape') return;
      event.preventDefault();
      slashCustomizing = false;
      renderSlash();
      input.focus();
    });

    insertButton?.addEventListener('click', () => {
      insertMode = insertMode === 'steer' ? 'abort' : 'steer';
      renderInsertMode();
      input.focus();
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      // 流式中：同一个按钮/回车就是「停止」或「插一句」，交给 send() 统一分派。
      if (activeTurn) {
        void send();
        return;
      }
      if (slashOpen) {
        // 已经打完整条内置命令：与 Enter 一致，直接执行这一条，不取默认选中项。
        if (!slashNavigated&&isExactBuiltinCommand(input.value)) {
          setSlashOpen(false);
          void send();
          return;
        }
        // 与 Enter 同一套规则：有可选项执行，没有匹配就关面板照常发送。
        if (slashFlat.length) invokeSlashSelection();
        else {
          setSlashOpen(false);
          void send();
        }
        return;
      }
      // `@@` 面板开着时点发送：与 Enter 同义——收起面板，照常发送。
      panelAt()?.close();
      void send();
    });

    // 撤回：只退最后一条用户消息与它的回复；撤回的原文放回输入框，方便改了再发。
    const rewindLast = async () => {
      if (activeTurn) {
        ctx.notify?.('等这一轮结束再撤回', 'warn');
        return;
      }
      const bridge = window.companion?.chat;
      if (typeof bridge?.rewind !== 'function') return;
      const result = await bridge.rewind({
        sessionId: currentId(),
        projectId: ctx.ui.header.viewProjectId()
      });
      if (!result?.rewound) {
        ctx.notify?.('没有可撤回的一轮', 'warn');
        return;
      }
      await ctx.refreshThread();
      if (!input.value.trim()) {
        input.value = String(result.text ?? '');
        saveDraftInBackground();
        resizeInput();
      } else {
        ctx.notify?.('已撤回；输入框里已有内容，没有覆盖');
      }
      input.focus();
    };
    // 对话流只负责画按钮，撤回动作由输入区持有（它知道当前会话与输入框）。
    ctx.rewindLast = rewindLast;

    return {
      resize: resizeInput,
      sync: syncComposer,
      focus: () => input.focus(),
      flushDraft: queueDraft,
      restoreDraft,
      hasDraft: () => Boolean(input.value || pickedSkill),
      openFromLocate,
      recoverChat,
      dismissSlash,
      dismissAt,
      // 配置箱里的「探测本机」走与 `/setup` 同一条路，只是不伪造一条用户消息。
      runSetupFromUi: () => runSetupTurn('/setup', { appendCommand: false })
    };
  };

  return { composerPlaceholder, composerKeyAction, parseCapabilityCommand, libraryReply, sinceReply, publishReply, distillReply, candidateReviewBlock, replyParts, lessonsReply, decisionCandidateBlocks, decisionComposeReply, decisionReply, isExactBuiltinCommand, BUILTIN_COMMANDS, skillNameOf, modelFailureReply, modelQuestionOf, sameDraftContent, create };
});
