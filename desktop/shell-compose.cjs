// #121 卡片壳的输入区：输入框、发送、`/` 技能面板、占位文案与锁定。
//
// 边界：这一块只管输入框与挂在它上面的 `/` 面板（数字快捷 + 全部技能 + 别名编辑），
// 发出去以后的消息落库与重画交给装配层的 refreshThread；顶栏与对话流分别在
// shell-header.cjs / shell-stream.cjs。技能目录只认 src/knowledge/skills.mjs 的扫描结果。
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
      : '全局模式：可以问所有项目的记忆（只读），先选项目再写。回车发送，/ 技能，@@ 方法';
  };

  /**
   * 输入框按键的状态迁移：把「面板开没开 / 在不在改数字 / 有没有可选项 / 按了什么」
   * 与「该做什么」分开，单测直接喂状态，不必起窗口。
   *
   * 优先级（从高到低）：
   *   1. 改数字时 Enter / Esc：先收掉编辑态，不抢发送、也不关面板；
   *   2. 面板开着时 Esc：关面板；
   *   3. 面板开着时 ↑↓：移动选中；
   *   4. 面板开着时 Enter：有可选项就执行选中项；**没有可选项时关面板并照常发送**
   *      ——这一条是 #132 的根因修复：`/risk high`、`/记灵感` 本来就没有匹配项，
   *      不能因为面板开着就把 Enter 吃掉；
   *   5. 其余 Enter（面板关着，或 Shift+Enter 换行之外的普通回车）：发送。
   *
   * 返回 preventDefault=false 的只有 Shift+Enter（交给浏览器换行）和无关按键。
   */
  const composerKeyAction = ({ slashOpen, slashCustomizing, itemCount, key, shiftKey }) => {
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
    if (key === 'Enter' && !shiftKey) return { action: 'send', preventDefault: true };
    return { action: 'none', preventDefault: false };
  };

  /** 建立输入区这一块：查 DOM、绑事件，返回给装配层用的入口。 */
  const create = (ctx) => {
    const threadApi = ctx.threadApi;
    const listApi = ctx.listApi;
    const skillsApi = ctx.skillsApi;
    const blocksApi = ctx.blocksApi;
    const riskApi = ctx.riskApi;
    const store = ctx.store;
    // #114：自有目录写入的判定与回执由 src/own-write.mjs 提供，经 own-write-host.mjs
    // 挂到窗口。模块脚本晚于经典脚本，所以不在加载时断言存在，而是在发送时读。
    const ownWrites = () => window.OwnerOwnWrite ?? null;
    // #115：项目目录同步同理（判定 / 清单 / 会话授权在 src/project-write.mjs）。
    const projectSyncs = () => window.OwnerProjectWrite ?? null;

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
      slashFlat = [
        ...quick.map((slot) => ({ id: slot.id, kind: 'command' })),
        ...rest.map((skill) => ({ id: skill.id, kind: 'skill' }))
      ];
      if (slashSelection >= slashFlat.length) slashSelection = Math.max(0, slashFlat.length - 1);

      slashList.replaceChildren();
      slashList.append(el('div', 'slash-group',
        `数字快捷 · ${quick.length}${slashCustomizing ? '（改数字 1-9，空着回默认）' : ''}`));
      quick.forEach((slot, index) => {
        slashList.append(slashRow(slot.skill, { kind: 'command', index, slot, conflictIds }));
      });
      const filtered = Boolean(skillsApi.normalizeQuery(slashQuery));
      slashList.append(el('div', 'slash-group', `全部技能 · ${rest.length}${filtered ? '（已过滤）' : ''}`));
      rest.forEach((skill, offset) => {
        slashList.append(slashRow(skill, {
          kind: 'skill', index: quick.length + offset, slot: null, conflictIds
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
      const legacySample = value.trim() === blocksApi.SAMPLE_COMMAND;
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
      void invokeSkill(chosen.id, chosen.kind);
    };

    /** 没有会话就锁死输入框：不给「无会话却能发消息」留半截状态。 */
    const syncComposer = () => {
      const open = listApi.canCompose(currentId());
      if (!open && slashOpen) setSlashOpen(false);
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

    const send = () => report('发送', async () => {
      if (busy || !listApi.canCompose(currentId())) return;
      const raw = input.value;
      if (!threadApi.canSend(raw)) return;
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
      // 还没接模型：普通消息回占位回复；/blocks 回块全览；/risk 回一张确认卡（#113）。
      // 三者都是普通消息，先拦住再回，保证同一个入口。
      const reply = blocksApi.isSampleCommand(raw)
        ? blocksApi.sampleReply()
        : riskApi.isRiskCommand(raw)
          ? await riskApi.buildRiskReply(raw)
          : { text: threadApi.placeholderText(raw), blocks: [] };
      busy = true;
      try {
        await store.append({ id: currentId(), role: 'user', text: raw });
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
    });

    input.addEventListener('keydown', (event) => {
      // 组字中的回车属于输入法，不能当发送。
      if (event.isComposing || event.keyCode === 229) return;
      // #132：按键优先级集中在 composerKeyAction（纯函数，单测覆盖），这里只执行。
      const plan = composerKeyAction({
        slashOpen,
        slashCustomizing,
        itemCount: slashFlat.length,
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
      void send();
    });

    return {
      resize: resizeInput,
      sync: syncComposer,
      focus: () => input.focus(),
      dismissSlash
    };
  };

  return { composerPlaceholder, composerKeyAction, create };
});
