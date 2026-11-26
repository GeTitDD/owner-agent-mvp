// #122 `@@` 方法菜单与小卡片容器：先指认对象、再决定出口的入口。
//
// 边界：
// - 这里只管三件事：`@@` 的触发判定、方法列表（数据）、菜单 ↔ 方法卡的状态迁移；
// - 容器只给「外壳 + 标题 + 返回 / 关闭」；每个方法卡的内容由方法自己注册在
//   AT_CONTENT 里，容器按 key 取内容、不判断 key 是什么——后续加方法只加一行数据与
//   一条内容，不改容器代码；
// - 输入框、发送与按键优先级仍在 shell-compose.cjs（composerKeyAction），对话流在
//   shell-stream.cjs。本模块不落库、不发消息，取消（Esc / 关闭）没有副作用。
// 双份导出：浏览器当普通脚本加载（挂到 window.OwnerShellAt），Node 测试用 require 读纯函数。
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerShellAt = api;
})(typeof globalThis === 'undefined' ? null : globalThis, () => {
  /**
   * `@@` 的触发判定：只有输入末尾的「连续两个 @」才算，且这两个 @ 不是更长 @ 串的一部分。
   *
   * 规则：`@@` 前面必须是行首或非单词字符（不是 ASCII 字母 / 数字 / 下划线 / @），
   * 后面直到结尾不能再出现空白或 @。所以：
   *   - 单个 @（`@某人`、`me@example.com`）不拦；
   *   - 词中的双 @（`a@@b`、`hi@@`）不拦，避免把正文写成半截命令；
   *   - 中文紧跟 `@@`（`帮我@@`）照常触发；
   *   - `@@@` 不算「连续两个」。
   * 纯函数：只看输入值，测试不必起窗口。
   */
  const AT_TRIGGER = /(?:^|[^\w@])@@[^\s@]*$/u;
  const atTrigger = (value) => AT_TRIGGER.test(String(value ?? ''));

  /**
   * 方法列表是数据：菜单按这份数据逐行画，容器不写死任何分支。
   * 形状：{ key, title, desc }；key 同时是内容注册表 AT_CONTENT 的键。
   * 现在有三条（生成 prompt / 关联项目 / 关联会话），分享随后续票接入。
   */
  const AT_METHODS = Object.freeze([
    Object.freeze({
      key: 'prompt',
      title: '生成 prompt',
      desc: '勾选对话内容 + 一句指令，生成一版可复制的 prompt'
    }),
    Object.freeze({
      key: 'project',
      title: '关联项目',
      desc: '选别的项目与资料，发送时带进「## 关联项目」段'
    }),
    Object.freeze({
      key: 'session',
      title: '关联会话',
      desc: '指向别的 Agent 的会话，让 Agent 需要时去那段里检索'
    })
  ]);

  /** 菜单渲染用副本：调用方改返回值不会污染数据本身。 */
  const atMethods = () => AT_METHODS.map((method) => ({ ...method }));

  /** 按 key 取方法；不认识就返回 null，不猜、不兜底成第一条。 */
  const atMethod = (key) => AT_METHODS.find((method) => method.key === String(key ?? '')) ?? null;

  /**
   * 方法卡的内容由方法自己给：容器只画 lead，然后交给方法自己 mount 控件。
   * 没有 mount 的方法退回 todo 占位；有 mount 的方法不再画占位文案。
   */
  const AT_CONTENT = Object.freeze({
    prompt: Object.freeze({
      lead: '在对话流里勾选要引用的内容，再写一句指令。',
      // #123：控件与勾选态由 shell-at-prompt.cjs 注册；脚本未加载时给出可见说明，不画空卡。
      mount: (wrap, tools) => {
        const api = typeof globalThis === 'undefined' ? null : globalThis.OwnerShellAtPrompt;
        if (!api?.mount) {
          wrap.append(document.createTextNode('生成 prompt 模块还没加载好，稍等一下再试。'));
          return null;
        }
        return api.mount(tools.ctx)(wrap, tools);
      }
    }),
    project: Object.freeze({
      lead: '选一个项目，再为它选资料；关联只读，发送时进入「## 关联项目」段。',
      // #124：项目 → 资料的层级与输入框上方的胶囊由 shell-at-project.cjs 注册。
      mount: (wrap, tools) => {
        const api = typeof globalThis === 'undefined' ? null : globalThis.OwnerShellAtProject;
        if (!api?.mount) {
          wrap.append(document.createTextNode('关联项目模块还没加载好，稍等一下再试。'));
          return null;
        }
        return api.mount(tools.ctx)(wrap, tools);
      }
    }),
    session: Object.freeze({
      lead: '指向别的 Agent 的会话；这里只存指针，不导入正文。',
      // #125：来源切换、最近会话、自定义线索与胶囊由 shell-at-session.cjs 注册；
      // 状态挂在装配层的 ui.sessionPoints 上，卡片关掉以后胶囊仍然留在输入框上方。
      mount: (wrap, tools) => {
        const api = typeof globalThis === 'undefined' ? null : globalThis.OwnerShellAtSession;
        const instance = tools?.ctx?.ui?.sessionPoints;
        if (!api || typeof instance?.mount !== 'function') {
          wrap.append(document.createTextNode('关联会话模块还没加载好，稍等一下再试。'));
          return null;
        }
        return instance.mount(wrap, tools);
      }
    })
  });

  /** 按 key 取方法卡内容；没有注册就返回 null（容器给出可见的占位，而不是空白）。 */
  const atContent = (key) => AT_CONTENT[String(key ?? '')] ?? null;

  // ── 容器状态：关 → 菜单 → 方法卡 → 返回菜单 → 关 ────────────────────
  // 纯迁移：状态只有 { open, method } 两个字段，事件只有 open / pick / back / close。
  // 不认识的 key、关着时的 pick 一律原样返回，不产生半截状态。

  const atInitialState = () => ({ open: false, method: null });

  const atTransition = (state, action) => {
    const current = state?.open === true
      ? { open: true, method: state.method ?? null }
      : atInitialState();
    const type = action?.type;
    if (type === 'open') return { open: true, method: null };
    if (type === 'close') return atInitialState();
    if (type === 'back') return current.method ? { open: true, method: null } : current;
    if (type === 'pick') {
      const method = current.open ? atMethod(action.key) : null;
      return method ? { open: true, method: method.key } : current;
    }
    return current;
  };

  /**
   * 把状态翻译成「外壳该画什么」：菜单 / 方法卡 / 关着。
   * 标题、能否返回、内容键都从这里出，渲染函数不再自己判断 step。
   */
  const atView = (state) => {
    if (state?.open !== true) {
      return { open: false, step: 'closed', methodKey: '', title: '', canBack: false };
    }
    const method = state.method ? atMethod(state.method) : null;
    if (!method) {
      return { open: true, step: 'menu', methodKey: '', title: '@@ 要做什么', canBack: false };
    }
    return { open: true, step: 'method', methodKey: method.key, title: method.title, canBack: true };
  };

  /** 建立 `@@` 这一块：查 DOM、绑事件，返回给装配层与输入区用的入口。 */
  const create = (ctx) => {
    const $ = (id) => document.getElementById(id);
    const panel = $('atPanel');
    const titleNode = $('atTitle');
    const subNode = $('atSub');
    const bodyNode = $('atBody');
    const backButton = $('atBack');
    const hintNode = $('atHint');
    const input = $('input');

    let state = atInitialState();
    // 方法自己 mount 的控件可能带监听（#123 的勾选计数）；关 / 返回 / 换方法前统一拆掉。
    let mountCleanup = null;

    const teardownMount = () => {
      if (typeof mountCleanup !== 'function') {
        mountCleanup = null;
        return;
      }
      const cleanup = mountCleanup;
      mountCleanup = null;
      try {
        cleanup();
      } catch {
        // 清理失败不该把面板卡在半开状态；后面的状态迁移照常走。
      }
    };

    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    /** 关闭（或取消）后焦点回到输入框末尾：只有面板确实拿过焦点时才动焦点。 */
    const focusInputEnd = () => {
      if (!input) return;
      input.focus();
      const end = input.value.length;
      try {
        input.setSelectionRange(end, end);
      } catch {
        // 输入框被锁死时 setSelectionRange 会抛；焦点回来就够了。
      }
    };

    /** 菜单：整份方法列表逐行画出来，行携带 key，容器不知道 key 的含义。 */
    const renderMenu = () => {
      bodyNode.replaceChildren();
      atMethods().forEach((method) => {
        const row = el('button', 'at-method');
        row.type = 'button';
        row.dataset.atMethod = method.key;
        const text = el('span', 'at-method-text');
        text.append(el('span', 'at-method-name', method.title));
        text.append(el('span', 'at-method-desc', method.desc));
        row.append(text);
        row.append(el('span', 'at-method-go', '›'));
        bodyNode.append(row);
      });
    };

    /** 方法卡：容器只画 lead，其余控件由方法自己 mount；没有 mount 才画 todo 占位。 */
    const renderMethod = (key) => {
      bodyNode.replaceChildren();
      const content = atContent(key);
      const wrap = el('div', 'at-content');
      if (!content) {
        // 数据里有方法、内容却没注册：说清是缺内容，不画一张空卡糊弄过去。
        wrap.append(el('p', 'at-lead', '这个方法还没有内容。'));
      } else {
        wrap.append(el('p', 'at-lead', content.lead));
        if (typeof content.mount === 'function') {
          const cleanup = content.mount(wrap, { close, ctx });
          if (typeof cleanup === 'function') mountCleanup = cleanup;
        } else if (content.todo) {
          wrap.append(el('p', 'at-todo', content.todo));
        }
      }
      bodyNode.append(wrap);
    };

    const render = () => {
      // 每次状态迁移都先把上一个方法的控件拆掉，避免旧的计数监听挂在新卡片上。
      teardownMount();
      const view = atView(state);
      panel.hidden = !view.open;
      if (!view.open) return;
      titleNode.textContent = view.title;
      backButton.hidden = !view.canBack;
      subNode.textContent = view.step === 'menu' ? '方法菜单' : '方法卡片';
      hintNode.textContent = view.step === 'menu'
        ? '点一个方法进入；Esc 关闭，正文不会变。'
        : '卡片里的动作只影响这一次；返回菜单或关闭，正文不会变。';
      if (view.step === 'menu') renderMenu();
      else renderMethod(view.methodKey);
    };

    /** 重画会把旧节点换掉：下一步再把焦点放到新节点上，别让键盘停在 body。 */
    const focusInPanel = (selector) => {
      queueMicrotask(() => panel.querySelector(selector)?.focus());
    };

    /** 打开菜单：已经在面板里（可能是方法卡）就保持原步，不因输入重画。 */
    const openMenu = () => {
      if (state.open) return;
      // 浮层不同时压两层：顶栏浮层与 `/` 面板先收起。
      ctx.ui.header.closePopoverIfOpen();
      ctx.ui.compose.dismissSlash();
      state = atTransition(state, { type: 'open' });
      render();
    };

    const enterMethod = (key) => {
      const next = atTransition(state, { type: 'pick', key });
      if (next === state) return;
      state = next;
      render();
      // 方法卡拿住焦点：Esc / 关闭后按约定把焦点还给输入框。
      focusInPanel('#atBack');
    };

    const back = () => {
      const next = atTransition(state, { type: 'back' });
      if (next === state) return;
      state = next;
      render();
      focusInPanel('.at-method');
    };

    /** 关闭：只改本地状态，不碰输入框正文、不落库——取消因此没有副作用。 */
    const close = () => {
      if (!state.open) return false;
      const hadFocus = panel.contains(document.activeElement);
      state = atTransition(state, { type: 'close' });
      render();
      if (hadFocus) focusInputEnd();
      return true;
    };

    // ── 事件 ──────────────────────────────────────────────────────────

    panel.addEventListener('click', (event) => {
      const pick = event.target.closest?.('[data-at-method]');
      if (pick) {
        enterMethod(pick.dataset.atMethod);
        return;
      }
      if (event.target.closest?.('#atBack')) {
        back();
        return;
      }
      if (event.target.closest?.('#atClose')) close();
    });

    // 焦点在卡片里时 Esc 也关；不让键盘用户被困在一张小卡上。
    panel.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    });

    // 点别处收起（与 `/` 面板同一条规则）：点输入区本身不算「别处」。
    document.addEventListener('mousedown', (event) => {
      if (!state.open) return;
      if (panel.contains(event.target)) return;
      if (document.getElementById('composer')?.contains(event.target)) return;
      close();
    });

    return {
      openMenu,
      enterMethod,
      back,
      close,
      isOpen: () => state.open,
      step: () => atView(state).step
    };
  };

  return {
    atTrigger,
    atMethods,
    atMethod,
    atContent,
    atInitialState,
    atTransition,
    atView,
    create
  };
});
