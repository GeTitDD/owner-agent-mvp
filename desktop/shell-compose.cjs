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
  /**
   * 输入框的占位文案：没有会话时锁死；全局模式「能问不能写」；项目下只提示发送。
   * 纯状态迁移：只看「能不能发 + 正在看的项目」，测试不必起窗口。
   */
  const composerPlaceholder = ({ open, viewProjectId }) => {
    if (!open) return '没有会话时不能发消息：先在顶栏新建一个会话。';
    return viewProjectId
      ? '说点什么，/ 技能，@@ 方法。回车发送，Shift+回车换行'
      : '全局只读：能问不能写。/ 技能，@@ 方法';
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
    slashOpen, slashCustomizing, itemCount, atOpen = false, key, shiftKey
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
    monitor: '监控'
  });

  /**
   * 内置命令：不是技能，也不扫描目录，输入 `/` 就应该能被找到。
   * 只列「单独执行就有意义」的：需要接参数的（`/记灵感 <内容>`）不列，避免点一下就发半句。
   * 文本是最终发出去的那一句，执行仍走普通消息的同一条路（命令分派在下面）。
   */
  const BUILTIN_COMMANDS = Object.freeze([
    Object.freeze({ id: 'setup', text: '/setup', description: '探测本机：逐项判定，一次确认写盘' }),
    Object.freeze({ id: '项目库', text: '/项目库', description: '当前项目的记忆计数与来源分组' }),
    Object.freeze({ id: '变化', text: '/变化', description: '自上次看过之后的变化（首次只记水位）' }),
    Object.freeze({ id: '发布', text: '/发布', description: '生成发布草稿：下一版、草稿条目数' }),
    Object.freeze({ id: '发布确认', text: '/发布 确认', description: '确认发布：写版本、导出、投递；不可回收' }),
    Object.freeze({ id: '监控', text: '/监控', description: '打开配置箱的监控分区' }),
    Object.freeze({ id: '同步到项目', text: '/同步到项目', description: '把文档同步进项目目录：需确认，一次一问' })
  ]);

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
   * 这条命令会推进水位（进入项目即「看过了」），在回复里明说，避免下次看不到同一批变化时误判。
   */
  const sinceReply = (view) => {
    const counts = view?.counts ?? {};
    const known = view?.watermark?.known === true;
    const status = String(view?.status ?? 'unknown');
    const blocks = Array.isArray(view?.blocks) ? view.blocks : [];
    const rows = blocks
      .filter((block) => Array.isArray(block?.items) && block.items.length > 0)
      .map((block) => [String(block.title ?? '变化'), `${block.items.length} 条`]);
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
        {
          type: 'kv',
          title: '变化窗口 · 水位',
          rows: [
            ['上次看过', String(view?.previousAt ?? '（没有水位）')],
            ['本次检查', String(view?.checkedAt ?? '')],
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
    // #108 技能面板的节点：面板本身、两段共用的滚动区、页脚提示与冲突提示。
    const slashPanel = $('skillPanel');
    const slashList = $('skillList');
    const slashCount = $('skillCount');
    const slashHint = $('skillHint');
    const slashConflict = $('skillConflict');
    const slashError = $('skillError');
    const slashToggle = $('skillAliasToggle');

    /** 当前会话由顶栏持有：输入区只读，不另存一份。 */
    const currentId = () => ctx.ui.header.currentId();
    const report = (label, action) => ctx.report(label, action);

    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    // `/` 面板：技能行来自扫描结果；数字别名只存「我改过的那几个」。
    let skillRows = [];
    let skillCatalogEmpty = null;
    let skillsLoaded = false;
    let skillsLoading = false;
    let slashOpen = false;
    let slashQuery = '';
    let slashSelection = 0;
    let slashCustomizing = false;
    let slashFlat = [];
    let busy = false;

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
        return `${number}（${ids.join('、')}）`;
      }).join('；');
      slashConflict.textContent = `数字冲突：${detail}。两个命令用了同一个数字，按数字会命中排在前面的那个。`;
      slashConflict.hidden = false;
    };

    /** 技能目录只在第一次打开面板时读；失败就留在面板上，不写控制台。 */
    const loadSkills = () => {
      if (skillsLoaded || skillsLoading) return;
      const api = window.companion?.skills?.catalog;
      if (!api) {
        setSlashError('技能目录接口不可用：这个窗口没有拿到主进程桥。');
        return;
      }
      skillsLoading = true;
      slashCount.textContent = '读取中…';
      void Promise.resolve()
        .then(() => api({}))
        .then((data) => {
          skillRows = skillsApi.flattenCatalog(data);
          skillCatalogEmpty = data?.empty ?? null;
          skillsLoaded = true;
          setSlashError('');
          if (slashOpen) renderSlash();
        })
        .catch((error) => {
          setSlashError(`读取技能失败：${error?.message ?? error}`);
          if (slashOpen) renderSlash();
        })
        .finally(() => {
          skillsLoading = false;
          if (slashOpen) renderSlash();
        });
    };

    const ensureSkills = () => {
      if (skillsLoaded || skillsLoading) return;
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
      if (index === slashSelection) row.classList.add('is-on');
      if (conflictIds.has(skill.id)) row.classList.add('is-conflict');
      if (skill.missing) row.title = skill.reason || '扫描缺失';
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
      const cmd = el('span', 'slash-cmd', `/${skill.id}`);
      // 长 id（域包带版本）在行内会截断；悬停仍能看到完整 id。
      cmd.title = skill.id;
      row.append(cmd);
      const text = el('span', 'slash-text');
      // 说明原样显示，不翻译；名称已经包含在 /id 里，不再多占一行。
      text.append(el('span', 'slash-desc', skill.description || '（扫描没有读到说明）'));
      row.append(text);
      if (skill.missing) row.append(el('span', 'slash-src is-missing', '缺失'));
      row.append(el('span', `slash-src src-${skill.source}`, skill.sourceLabel));
      return row;
    };

    /**
     * 一行内置命令：和技能行长得一样，但没有数字、没有来源目录。
     * 点它等于把那句话打进输入框再发送，走的是普通消息的同一条路。
     */
    const builtinRow = (command, index) => {
      const row = el('div', 'slash-item');
      row.dataset.kind = 'builtin';
      row.dataset.skillRow = command.id;
      row.dataset.index = String(index);
      if (index === slashSelection) row.classList.add('is-on');
      row.append(el('span', 'slash-num is-empty', '·'));
      const cmd = el('span', 'slash-cmd', command.text);
      cmd.title = command.text;
      row.append(cmd);
      const text = el('span', 'slash-text');
      text.append(el('span', 'slash-desc', command.description));
      row.append(text, el('span', 'slash-src src-command', '内置'));
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
      // 纯数字只指数字快捷：这时下半段不再按 id 里的数字捞人，否则打 /2
      // 会把 alpha-12 之类也带出来，和「按数字调用」的语义打架。
      const numericQuery = /^[0-9]+$/u.test(skillsApi.normalizeQuery(slashQuery));
      // 两段合起来覆盖扫描到的每一条技能：数字快捷里的不再在下面重复一遍。
      const rest = numericQuery ? [] : skillsApi.searchSkills(
        skillRows.filter((skill) => !quickIds.has(skill.id)),
        slashQuery
      );
      const conflictIds = new Set(model.conflicts.ids);
      // 内置命令排在最前：打 `/` 先看到「能做什么」，再看到「装了哪些技能」。
      const query = skillsApi.normalizeQuery(slashQuery);
      const builtin = BUILTIN_COMMANDS.filter((command) =>
        !query || command.id.includes(query) || command.text.includes(query)
        || command.description.includes(query));
      const builtinRows = builtin.map((command) => ({ id: command.id, kind: 'builtin', text: command.text }));
      slashFlat = [
        ...builtinRows,
        ...quick.map((slot) => ({ id: slot.id, kind: 'command' })),
        ...rest.map((skill) => ({ id: skill.id, kind: 'skill' }))
      ];
      if (slashSelection >= slashFlat.length) slashSelection = Math.max(0, slashFlat.length - 1);

      slashList.replaceChildren();
      slashList.append(el('div', 'slash-group',
        `命令 · ${builtin.length}${query ? '（已过滤）' : ''}`));
      builtin.forEach((command, index) => {
        slashList.append(builtinRow(command, index));
      });
      slashList.append(el('div', 'slash-group',
        `数字快捷 · ${quick.length}${slashCustomizing ? '（改数字 1-9，空着回默认）' : ''}`));
      quick.forEach((slot, index) => {
        slashList.append(slashRow(slot.skill, {
          kind: 'command', index: builtin.length + index, slot, conflictIds
        }));
      });
      const filtered = Boolean(query);
      slashList.append(el('div', 'slash-group',
        `全部技能 · ${rest.length}${filtered ? '（已过滤）' : ''}`));
      rest.forEach((skill, offset) => {
        slashList.append(slashRow(skill, {
          kind: 'skill', index: builtin.length + quick.length + offset, slot: null, conflictIds
        }));
      });

      if (slashFlat.length === 0) {
        const message = !skillsLoaded && skillsLoading
          ? '正在读取技能目录…'
          : (skillCatalogEmpty?.detail
            || (skillRows.length
              ? `没有匹配「${skillsApi.normalizeQuery(slashQuery)}」的技能。换个词，或者只打一个 / 看全部。`
              : '扫描没有找到技能：检查 PSTACK_DIR / MATT_SKILLS_DIR / 域包 manifest / 插件 ghost.json。'));
        slashList.append(el('p', 'slash-empty', message));
      }

      slashCount.textContent = skillsLoaded
        ? `共 ${skillRows.length} 个技能 · ${model.slots.length} 个数字快捷`
        : (slashError.hidden ? '读取中…' : '读取失败');
      slashToggle.textContent = slashCustomizing ? '完成' : '自定义';
      slashToggle.setAttribute('aria-pressed', slashCustomizing ? 'true' : 'false');
      slashHint.textContent = slashCustomizing
        ? '数字只认 1-9；改成默认数字或清空即回到默认。改完点「完成」。'
        : '↑↓ 选择 · Enter 调用 · 没有匹配时 Enter 直接发送 · 点任意一行即调用 · Esc 关闭';
      syncConflictText(model.conflicts);
      // 键盘移动后把选中行带进视野；初始选中第一行时等于不滚动。
      slashList.querySelector('.slash-item.is-on')?.scrollIntoView({ block: 'nearest' });
    };

    /** 改数字时不重画整段：重画会让输入框丢焦点，只更新冲突标记。 */
    const refreshSlashConflicts = () => {
      const model = aliasModel();
      const conflictIds = new Set(model.conflicts.ids);
      slashList.querySelectorAll('[data-alias-for]').forEach((field) => {
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
      if (!open) {
        slashCustomizing = false;
        slashSelection = 0;
        slashToggle.setAttribute('aria-pressed', 'false');
        return;
      }
      // 打开技能面板先收起会话浮层：两个浮层不该同时压着。
      ctx.ui.header.closePopoverIfOpen();
      slashSelection = 0;
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
        || Boolean(window.OwnerConfirm?.isCommand(value))
        || Boolean(window.OwnerSetupProbe?.isCommand?.(value));
      if (!value.startsWith('/') || legacySample) {
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
        slashSelection = 0;
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
     * 点一行 / 按 Enter：数字行是「命令」，技能行是「调用技能」，
     * 两条都按普通消息落库，所以切走再回来记录与结果卡都还在。
     */
    const invokeSkill = (id, kind) => report('调用技能', async () => {
      const skill = skillRows.find((item) => item.id === id);
      if (!skill || !listApi.canCompose(currentId())) return;
      const model = aliasModel();
      const slot = model.slots.find((item) => item.id === id);
      const number = kind === 'command' ? (slot?.number ?? null) : null;
      const record = skillsApi.invocationFor(skill, { kind, number });
      await store.append({ id: currentId(), role: 'user', text: record.userText });
      await store.append({
        id: currentId(),
        role: 'assistant',
        text: record.reply.text,
        blocks: Array.isArray(record.reply.blocks) ? record.reply.blocks : []
      });
      input.value = threadApi.draftAfterSend();
      resizeInput();
      setSlashOpen(false);
      await ctx.refreshThread();
      input.focus();
    });

    const invokeSlashSelection = () => {
      const chosen = slashFlat[slashSelection];
      if (!chosen) return;
      // 内置命令：收起面板，把整句放进输入框，走与手打完全相同的发送路径。
      if (chosen.kind === 'builtin') {
        setSlashOpen(false);
        input.value = chosen.text;
        resizeInput();
        void send();
        return;
      }
      void invokeSkill(chosen.id, chosen.kind);
    };

    /** 没有会话就锁死输入框：不给「无会话却能发消息」留半截状态。 */
    const syncComposer = () => {
      const open = listApi.canCompose(currentId());
      if (!open && slashOpen) setSlashOpen(false);
      if (!open) panelAt()?.close();
      input.disabled = !open;
      // 全局模式不是「不能说话」，而是「不写项目」：消息仍落本机自有库，所以输入框不锁；
      // 提示里说清落点为空，要写项目先选项目。
      input.placeholder = composerPlaceholder({ open, viewProjectId: ctx.ui.header.viewProjectId() });
      sendButton.disabled = !open || !threadApi.canSend(input.value);
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
      const api = ownWrites();
      if (!api) {
        ctx.ui.header.setError('自有目录写入模块还没加载好，稍等一下再试。');
        return;
      }
      busy = true;
      try {
        // 先把「我要写什么」落进流里：失败时也看得出是哪一句没写成。
        await store.append({ id: currentId(), role: 'user', text: raw });
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
            id: currentId(),
            role: 'assistant',
            text: result.receipt.text,
            blocks: result.receipt.blocks
          });
        } else {
          ctx.notify(`这个动作不在自有目录免确认范围内：${result.decision?.gate?.reason ?? ''}`, 'error');
        }
        input.value = threadApi.draftAfterSend();
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
      const api = projectSyncs();
      if (!api) {
        ctx.ui.header.setError('项目目录同步模块还没加载好，稍等一下再试。');
        return;
      }
      busy = true;
      try {
        const sessionId = currentId();
        // 先算正文再落「我的一句话」：这条命令本身不该被写进同步的笔记里。
        const detail = await store.get({ id: sessionId });
        const messages = threadApi.fromStored(detail?.messages);
        const session = ctx.ui.header.currentSession();
        const title = command.title || listApi.titleOf(session);
        const docs = await projectSyncDocs({ sessionId, title, messages });
        await store.append({ id: sessionId, role: 'user', text: raw });
        const projectId = ctx.ui.header.viewProjectId();
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
        input.value = threadApi.draftAfterSend();
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
    const runSetupTurn = async (raw, { appendCommand = true } = {}) => {
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
          input.value = threadApi.draftAfterSend();
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
      const label = CAPABILITY_LABELS[command.kind] ?? '命令';
      const bridge = window.companion ?? null;
      const projectId = ctx.ui.header.viewProjectId();
      busy = true;
      try {
        const sessionId = currentId();
        await store.append({ id: sessionId, role: 'user', text: raw });
        let reply;
        try {
          if (command.kind === 'monitor') {
            const opened = ctx.ui.config?.openSection?.('watch') === true;
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
        await store.append({
          id: sessionId,
          role: 'assistant',
          text: reply.text ?? '',
          blocks: Array.isArray(reply.blocks) ? reply.blocks : []
        });
        input.value = threadApi.draftAfterSend();
        resizeInput();
        await ctx.refreshThread();
        input.focus();
      } finally {
        busy = false;
      }
    };

    const send = () => report('发送', async () => {
      if (busy || !listApi.canCompose(currentId())) return;
      const raw = input.value;
      if (!threadApi.canSend(raw)) return;
      // #111 旧能力的最小入口：/项目库、/变化、/发布、/监控 先于普通消息处理。
      const capability = parseCapabilityCommand(raw);
      if (capability) {
        await runCapabilityTurn(capability, raw);
        return;
      }
      // 自有目录写入（/记灵感 等）：直接执行，不弹确认卡。
      const command = ownWrites()?.parseCommand(raw) ?? null;
      if (command) {
        await runOwnWriteTurn(command, raw);
        return;
      }
      // 项目目录同步（/同步到项目）：未授权先出确认卡，授权后按会话直接写。
      const syncCommand = projectSyncs()?.parseCommand?.(raw) ?? null;
      if (syncCommand) {
        await runProjectSyncTurn(syncCommand, raw);
        return;
      }
      // /setup：进配置箱的探测态；一次确认后写入，取消一项都不写。
      const setupCommand = setupProbes()?.parseCommand?.(raw) ?? null;
      if (setupCommand) {
        await runSetupTurn(raw);
        return;
      }
      // 还没接模型：普通消息回占位回复；/blocks 块全览；/risk 确认卡；/外发 /删除 走 #116 的确认卡。
      const confirmCommand = window.OwnerConfirm?.parseCommand(raw) ?? null;
      const reply = blocksApi.isSampleCommand(raw)
        ? blocksApi.sampleReply()
        : riskApi.isRiskCommand(raw)
          ? await riskApi.buildRiskReply(raw)
          : confirmCommand
            ? await window.OwnerConfirm.buildReply(confirmCommand)
            : { text: threadApi.placeholderText(raw), blocks: [] };
      // #124 与 #125 都只服务这一次发送：先接「## 关联项目」段，再接会话指针段。
      const text = projectLinks()?.withLinks?.(raw) ?? raw;
      const sessionPoints = ctx.ui.sessionPoints;
      const sentText = sessionPoints ? sessionPoints.withPointers(text) : text;
      busy = true;
      try {
        await store.append({ id: currentId(), role: 'user', text: sentText });
        // 正文已经落库，胶囊与指针完成使命：清空；发送失败则保留，下一次还能再试。
        projectLinks()?.clear?.();
        sessionPoints?.consume?.();
        await store.append({
          id: currentId(),
          role: 'assistant',
          text: reply.text ?? '',
          blocks: Array.isArray(reply.blocks) ? reply.blocks : []
        });
        input.value = threadApi.draftAfterSend();
        resizeInput();
        await ctx.refreshThread();
        input.focus();
      } finally {
        busy = false;
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

    input.addEventListener('input', () => {
      resizeInput();
      syncComposer();
      syncSlashFromInput();
      syncAtFromInput();
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
      void invokeSkill(row.dataset.skillRow, row.dataset.kind === 'command' ? 'command' : 'skill');
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

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (slashOpen) {
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

    return {
      resize: resizeInput,
      sync: syncComposer,
      focus: () => input.focus(),
      dismissSlash,
      dismissAt,
      // 配置箱里的「探测本机」走与 `/setup` 同一条路，只是不伪造一条用户消息。
      runSetupFromUi: () => runSetupTurn('/setup', { appendCommand: false })
    };
  };

  return { composerPlaceholder, composerKeyAction, parseCapabilityCommand, libraryReply, sinceReply, publishReply, BUILTIN_COMMANDS, create };
});
