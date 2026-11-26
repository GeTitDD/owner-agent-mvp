// #125 `@@` →「关联会话」：来源切换、最近会话、自定义线索、指针胶囊与发送段。
//
// 边界：
// - 关联的是**指针**，不是正文：这里只保留来源、会话 id、标题、时间、轮数、所属项目；
//   会话正文仍在对方的会话文件里，不读、不缓存、不写进本地库。
// - 两条来路并存：自动列出的最近会话（指针已确认），以及人填的线索
//   （路径 / ID / 关键词；命中也标「来源未确认」，因为匹配是猜的）。
// - 纯函数（线索分类、指针形状、prompt 段组装）可脱离 Electron 断言；
//   卡片 DOM、胶囊与失败落流由 create 负责。
// - 索引由主进程读元信息（src/memory/session-pointer-index.mjs），这里只消费指针。
// 双份导出：浏览器当普通脚本加载（挂到 window.OwnerShellAtSession），Node 测试用 require 读。

(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerShellAtSession = api;
})(typeof globalThis === 'undefined' ? null : globalThis, () => {
  const list = (value) => (Array.isArray(value) ? value : []);
  const str = (value) => (value === undefined || value === null ? '' : String(value));

  const SOURCES = Object.freeze([
    Object.freeze({ key: 'codex', label: 'Codex' }),
    Object.freeze({ key: 'claude', label: 'Claude Code' }),
    Object.freeze({ key: 'opencode', label: 'OpenCode' })
  ]);

  const SOURCE_LABELS = Object.freeze(
    Object.fromEntries(SOURCES.map((source) => [source.key, source.label]))
  );

  /** 指针字段白名单：任何会话正文 / 消息数组都不该穿过这一层。 */
  const POINTER_FIELDS = Object.freeze([
    'source', 'id', 'title', 'at', 'turns', 'project', 'unconfirmed'
  ]);

  const SESSION_SECTION_TITLE = '## 关联会话（指针，不是正文）';
  const SESSION_SECTION_HINT = '需要什么就回这些会话里检索；定位不到就问我，不要猜。';
  const SESSION_SECTION_NOTE = '这里只有指针，没有正文；不要当成已经读过的材料。';

  const sourceLabel = (source) => SOURCE_LABELS[String(source ?? '')] ?? '';

  /**
   * 线索分类：与主进程同一套口径。
   * - id：UUID / OpenCode 的 ses_ id / 显式 `id:`；
   * - keyword：其余含文字或数字的串（路径也走这一类，按 cwd 子串匹配）；
   * - unusable：空、只有符号。
   */
  const classifyClue = (raw) => {
    const value = str(raw).trim();
    if (!value) return { kind: 'unusable', value: '', reason: '线索是空的' };
    const explicit = /^id\s*[:：]\s*(.*)$/iu.exec(value);
    if (explicit) {
      const id = explicit[1].trim();
      if (!id) return { kind: 'unusable', value, reason: 'id: 后面没有内容' };
      return { kind: 'id', value: id };
    }
    if (!/[\p{L}\p{N}]/u.test(value)) {
      return { kind: 'unusable', value, reason: '线索里没有可搜索的字或数字' };
    }
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu.test(value)
      || /^ses_[A-Za-z0-9]{6,}$/u.test(value)) {
      return { kind: 'id', value };
    }
    return { kind: 'keyword', value };
  };

  /** 线索类型的界面提示：只解释能怎么搜，不给「一定找得到」的承诺。 */
  const clueHint = (clue) => {
    if (clue.kind === 'id') return '线索类型：会话 ID（先按 id 精确找）';
    if (clue.kind === 'keyword') return '线索类型：关键词（标题、项目、路径都能搜）';
    return `这条线索用不了：${clue.reason}`;
  };

  /**
   * 把索引条目收成指针：只取白名单字段，正文、消息数组、工具输出一律丢掉。
   * via='clue' 表示是人填线索命中的，标「来源未确认」；via='recent' 表示来自自动列表。
   */
  const pointerOf = (entry, via = 'recent') => {
    if (!entry || typeof entry !== 'object') return null;
    const source = String(entry.source ?? '');
    if (!SOURCE_LABELS[source]) return null;
    const turns = Number(entry.turns);
    const pointer = {
      source,
      id: str(entry.id).trim(),
      title: str(entry.title).trim() || '无标题会话',
      at: str(entry.at).trim(),
      turns: Number.isInteger(turns) && turns > 0 ? turns : 0,
      project: str(entry.project).trim(),
      unconfirmed: via === 'clue'
    };
    // 没有 id 也没有标题的条目定位不到，不造一个空指针。
    if (!pointer.id && !str(entry.title).trim()) return null;
    return pointer;
  };

  const pointerKey = (pointer) => `${str(pointer?.source)}:${str(pointer?.id) || str(pointer?.title)}`;

  const samePointer = (left, right) => pointerKey(left) === pointerKey(right);

  /** 指针上的时间：ISO 转成「YYYY-MM-DD HH:mm」，认不出来就照原样给。 */
  const displayTime = (at) => {
    const value = str(at).trim();
    if (!value) return '';
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/u.exec(value);
    return match ? `${match[1]} ${match[2]}` : value;
  };

  const turnsText = (turns) => `${Number.isInteger(turns) && turns > 0 ? turns : 0} 轮`;

  /** 一条指针的 Markdown 行：来源、标题、时间、轮数、所属项目、id。 */
  const pointerLine = (pointer) => {
    const label = sourceLabel(pointer?.source);
    if (!label) return '';
    const head = pointer.unconfirmed ? `${label}（来源未确认）` : label;
    const parts = [head];
    if (str(pointer.title).trim()) parts.push(`《${str(pointer.title).trim()}》`);
    const time = displayTime(pointer.at);
    if (time) parts.push(time);
    parts.push(turnsText(pointer.turns));
    if (str(pointer.project).trim()) parts.push(`项目：${str(pointer.project).trim()}`);
    if (str(pointer.id).trim()) parts.push(`id：${str(pointer.id).trim()}`);
    return `- ${parts.join(' · ')}`;
  };

  /**
   * 组装「关联会话」段：只有指针行与检索约定，没有正文。
   * 没有指针时整段不出现（空段不该在 prompt 里占位置）。
   */
  const buildSessionSection = (pointers) => {
    const rows = list(pointers)
      .map((pointer) => pointerLine(pointer))
      .filter(Boolean);
    if (rows.length === 0) return '';
    return [
      SESSION_SECTION_TITLE,
      '',
      SESSION_SECTION_HINT,
      SESSION_SECTION_NOTE,
      '',
      rows.join('\n')
    ].join('\n');
  };

  /** 发送时把段接在用户原话后面；没有指针就原样返回，不改一个字。 */
  const composeSendText = (text, pointers) => {
    const base = str(text);
    const section = buildSessionSection(pointers);
    return section ? `${base}\n\n${section}` : base;
  };

  /** 建立「关联会话」这一块：胶囊常驻输入框上方，卡片只在 `@@` 里画。 */
  const create = (ctx) => {
    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    // 胶囊容器在输入框上方（shell.html），卡片关闭后仍留在这里。
    const capsulesNode = document.getElementById('sessionPointers');
    const state = {
      pointers: [],
      source: 'codex',
      items: [],
      via: 'recent',
      loading: false,
      reasons: [],
      clueValue: '',
      clueKind: '',
      request: 0
    };

    const notify = (text, tone = 'ok') => ctx.notify(text, tone);

    /** 调主进程索引；接口不可用时抛出可显示的原因，不静默返回空。 */
    const fetchIndex = async (params) => {
      const injected = typeof window !== 'undefined' ? window.OwnerSessionPointsProvider : null;
      if (typeof injected === 'function') return injected(params);
      const api = window.companion?.memory?.sessionPoints;
      if (typeof api !== 'function') {
        throw new Error('会话索引接口不可用：这个窗口没有拿到主进程桥');
      }
      return api(params);
    };

    const renderCapsules = () => {
      if (!capsulesNode) return;
      capsulesNode.replaceChildren();
      if (state.pointers.length === 0) {
        capsulesNode.hidden = true;
        return;
      }
      state.pointers.forEach((pointer) => {
        const pill = el('span', 'session-pointer');
        pill.dataset.pointerKey = pointerKey(pointer);
        pill.append(el('span', 'session-pointer-src', sourceLabel(pointer.source)));
        pill.append(el('span', 'session-pointer-title', pointer.title));
        pill.append(el('span', 'session-pointer-meta', turnsText(pointer.turns)));
        if (pointer.unconfirmed) {
          pill.append(el('span', 'session-pointer-mark', '来源未确认'));
        }
        const remove = el('button', 'session-pointer-remove', '✕');
        remove.type = 'button';
        remove.dataset.pointerRemove = pointerKey(pointer);
        remove.setAttribute('aria-label', `移除关联会话：${pointer.title}`);
        pill.append(remove);
        capsulesNode.append(pill);
      });
      capsulesNode.hidden = false;
    };

    const hasPointer = (pointer) => state.pointers.some((item) => samePointer(item, pointer));

    const addPointer = (entry, via) => {
      const pointer = pointerOf(entry, via);
      if (!pointer) {
        notify('这条会话没有可用的指针信息，没有关联', 'error');
        return false;
      }
      if (hasPointer(pointer)) {
        notify('这段会话已经关联过了', 'error');
        return false;
      }
      state.pointers.push(pointer);
      renderCapsules();
      const mark = pointer.unconfirmed ? '（来源未确认）' : '';
      notify(`已关联 ${sourceLabel(pointer.source)} 会话${mark}，只存指针`, 'ok');
      return true;
    };

    const removePointer = (key) => {
      const before = state.pointers.length;
      state.pointers = state.pointers.filter((item) => pointerKey(item) !== key);
      if (state.pointers.length === before) return false;
      renderCapsules();
      return true;
    };

    /**
     * 找不到会话时把失败写进对话流：不是空列表、不是一句 toast。
     * 这里落的是失败说明，不含任何会话正文。
     */
    const reportFailure = async (text) => {
      const sessionId = ctx.ui.header.currentId();
      if (!sessionId || !ctx.store) {
        notify(text, 'error');
        return;
      }
      try {
        await ctx.store.append({ id: sessionId, role: 'assistant', text });
        await ctx.refreshThread();
        ctx.ui.compose.focus();
      } catch (error) {
        notify(`失败提示没落进对话流：${error?.message || '未知原因'}`, 'error');
      }
    };

    const failureText = (clue) => {
      if (clue.kind === 'unusable') {
        return `关联会话没有建立：这条线索没法用（${clue.reason}）。填一个会话 ID、路径或标题关键词再试。`;
      }
      return `关联会话没有建立：没找到匹配「${clue.value}」的会话。我查了 Codex / Claude / OpenCode 的会话索引，没有整段读取任何会话；换一个路径、会话 ID 或标题关键词再试。`;
    };

    /** 卡片里的那点 DOM：来源切换 / 最近会话 / 线索输入；关闭后胶囊独立存在。 */
    const mount = (wrap, tools = {}) => {
      const box = el('div', 'at-session');

      const tabs = el('div', 'at-session-sources');
      SOURCES.forEach((source) => {
        const tab = el('button', 'at-session-tab', source.label);
        tab.type = 'button';
        tab.dataset.atSessionSource = source.key;
        tab.setAttribute('aria-pressed', source.key === state.source ? 'true' : 'false');
        tabs.append(tab);
      });
      box.append(tabs);

      const status = el('p', 'at-session-status');
      const rowsNode = el('div', 'at-session-list');
      box.append(status, rowsNode);

      const clueBox = el('div', 'at-session-clue');
      const clueLabel = el('label', 'at-session-clue-label', '找不到？填一条线索');
      clueLabel.htmlFor = 'atSessionClue';
      const clueRow = el('div', 'at-session-clue-row');
      const clueField = el('input', 'at-session-clue-input');
      clueField.id = 'atSessionClue';
      clueField.type = 'text';
      clueField.placeholder = '路径 / 会话 ID / 标题关键词';
      const resolve = el('button', 'at-session-resolve', '按线索找');
      resolve.type = 'button';
      clueRow.append(clueField, resolve);
      const clueKind = el('p', 'at-session-clue-kind');
      clueBox.append(clueLabel, clueRow, clueKind);
      box.append(clueBox);
      wrap.append(box);

      let mounted = true;

      const syncTabs = () => {
        tabs.querySelectorAll('[data-at-session-source]').forEach((tab) => {
          tab.setAttribute(
            'aria-pressed',
            tab.dataset.atSessionSource === state.source ? 'true' : 'false'
          );
        });
      };

      const rowFor = (entry, via) => {
        const pointer = pointerOf(entry, via);
        if (!pointer) return null;
        const row = el('button', 'at-session-row');
        row.type = 'button';
        row.dataset.atSessionRow = '1';
        row.dataset.source = pointer.source;
        row.dataset.sessionId = pointer.id;
        row.dataset.pointerKey = pointerKey(pointer);
        row.append(el('span', 'at-session-row-src', sourceLabel(pointer.source)));
        const text = el('span', 'at-session-row-text');
        text.append(el('span', 'at-session-row-title', pointer.title));
        const meta = [displayTime(pointer.at), turnsText(pointer.turns), pointer.project]
          .filter(Boolean)
          .join(' · ');
        text.append(el('span', 'at-session-row-meta', meta));
        row.append(text);
        if (via === 'clue') row.append(el('span', 'at-session-badge', '来源未确认'));
        if (hasPointer(pointer)) row.append(el('span', 'at-session-added', '已关联'));
        return row;
      };

      const renderRows = () => {
        rowsNode.replaceChildren();
        if (state.loading) {
          status.hidden = true;
          rowsNode.append(el('p', 'at-session-empty', '正在读会话索引…'));
          return;
        }
        if (state.items.length === 0) {
          status.hidden = !state.reasons.length;
          status.textContent = state.reasons.join('；');
          const empty = state.clueValue
            ? `没有匹配「${state.clueValue}」的会话。换个路径、ID 或标题关键词再试。`
            : '没有扫到最近会话。可以在下面填一条线索。';
          rowsNode.append(el('p', 'at-session-empty', empty));
          return;
        }
        status.hidden = !state.reasons.length;
        status.textContent = state.reasons.length ? `另外：${state.reasons.join('；')}` : '';
        state.items.forEach((entry) => {
          const row = rowFor(entry, state.via);
          if (row) rowsNode.append(row);
        });
      };

      const loadSource = async (source) => {
        state.source = String(source);
        state.clueValue = '';
        state.clueKind = '';
        state.via = 'recent';
        state.items = [];
        state.reasons = [];
        state.loading = true;
        syncTabs();
        renderRows();
        const ticket = (state.request += 1);
        try {
          const result = await fetchIndex({ source: state.source, limit: 12 });
          if (!mounted || ticket !== state.request) return;
          state.items = list(result?.items);
          state.reasons = list(result?.reasons).map((item) => str(item)).filter(Boolean);
        } catch (error) {
          if (!mounted || ticket !== state.request) return;
          state.items = [];
          state.reasons = [error?.message || '会话索引读不出来'];
        } finally {
          if (mounted && ticket === state.request) {
            state.loading = false;
            renderRows();
          }
        }
      };

      const resolveClue = async () => {
        if (state.loading) return;
        const clue = classifyClue(clueField.value);
        state.clueValue = clue.value;
        state.clueKind = clue.kind;
        clueKind.textContent = clueHint(clue);
        clueKind.dataset.kind = clue.kind;
        if (clue.kind === 'unusable') {
          await reportFailure(failureText(clue));
          return;
        }
        state.loading = true;
        state.reasons = [];
        renderRows();
        const ticket = (state.request += 1);
        try {
          const result = await fetchIndex({ clue: clue.value, limit: 8 });
          if (!mounted || ticket !== state.request) return;
          state.via = 'clue';
          state.items = list(result?.items);
          state.reasons = list(result?.reasons).map((item) => str(item)).filter(Boolean);
          if (state.items.length === 0) {
            await reportFailure(failureText(clue));
          }
        } catch (error) {
          if (!mounted || ticket !== state.request) return;
          state.items = [];
          state.reasons = [];
          await reportFailure(`关联会话没有建立：${error?.message || '会话索引读不出来'}。`);
        } finally {
          if (mounted && ticket === state.request) {
            state.loading = false;
            renderRows();
          }
        }
      };

      box.addEventListener('click', (event) => {
        const tab = event.target.closest?.('[data-at-session-source]');
        if (tab) {
          void loadSource(tab.dataset.atSessionSource);
          return;
        }
        const row = event.target.closest?.('[data-at-session-row]');
        if (row) {
          const entry = state.items.find((item) => pointerKey(pointerOf(item, state.via)) === row.dataset.pointerKey);
          if (entry && addPointer(entry, state.via)) renderRows();
          return;
        }
        if (event.target.closest?.('.at-session-resolve')) void resolveClue();
      });

      clueField.addEventListener('input', () => {
        const clue = classifyClue(clueField.value);
        clueKind.textContent = clueField.value.trim() ? clueHint(clue) : '';
        clueKind.dataset.kind = clue.kind;
      });

      clueField.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.isComposing) return;
        event.preventDefault();
        void resolveClue();
      });

      syncTabs();
      void loadSource(state.source);

      return () => {
        mounted = false;
        state.request += 1;
      };
    };

    if (capsulesNode) {
      capsulesNode.addEventListener('click', (event) => {
        const button = event.target.closest?.('[data-pointer-remove]');
        if (!button) return;
        removePointer(button.dataset.pointerRemove);
      });
    }
    renderCapsules();

    return {
      mount,
      add: addPointer,
      remove: removePointer,
      hasPointers: () => state.pointers.length > 0,
      pointers: () => state.pointers.map((pointer) => ({ ...pointer })),
      section: () => buildSessionSection(state.pointers),
      withPointers: (text) => composeSendText(text, state.pointers),
      consume: () => {
        state.pointers = [];
        renderCapsules();
      }
    };
  };

  return {
    SOURCES,
    SOURCE_LABELS,
    POINTER_FIELDS,
    SESSION_SECTION_TITLE,
    SESSION_SECTION_HINT,
    SESSION_SECTION_NOTE,
    classifyClue,
    clueHint,
    pointerOf,
    pointerKey,
    samePointer,
    displayTime,
    turnsText,
    pointerLine,
    buildSessionSection,
    composeSendText,
    create
  };
});
