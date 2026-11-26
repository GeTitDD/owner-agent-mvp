// #127 配置箱：顶栏的 ⚙ 打开一个全窗口覆盖层，七个分区可滚动；
// 每行是「标签 + 值 + 一句后果」，并标注这一项来自「探测」还是「手改」。
//
// 边界：
// - 这一块只管画与读草稿；分区数据、来源规则、补丁收束全在 src/config-box.mjs
//   （经 config-box-host.mjs 挂到 window.OwnerConfigBox），不在这里抄第二份。
// - 保存走既有存储：window.companion.settings.set → 主进程写 companion.json，与旧设置页
//   同一个文件、同一条 IPC；取消不调用 set，一个字节都不改。
// - 密钥行只画来源（环境变量名）与状态（已检测到 / 未配置），没有输入框，也不持有值。
// - 真实探测在 #128；这一轮的事实来自主进程 settings.get 的 configBox 字段。
// 双份导出：浏览器当普通脚本加载（挂到 window.OwnerShellConfig），Node 测试用 require。
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerShellConfig = api;
})(typeof globalThis === 'undefined' ? null : globalThis, () => {
  /** 建立配置箱：查 DOM、绑事件，返回给装配层用的入口。 */
  const create = (ctx = {}) => {
    const $ = (id) => document.getElementById(id);
    const toggle = $('configToggle');
    const backdrop = $('configBox');
    const bodyNode = $('configBody');
    const statusNode = $('configStatus');
    const saveButton = $('configSave');
    const cancelButton = $('configCancel');
    const closeButton = $('configClose');

    const settings = window.companion?.settings ?? null;
    // 数据与规则模块是 ESM，晚于本脚本执行；打开那一刻再取，读不到就明说。
    const data = () => window.OwnerConfigBox ?? null;

    // 本轮注入的事实：paths / secrets / sync / sources。打开时整份换掉，不增量合并。
    let facts = {};
    let values = {};
    let rows = [];
    let busy = false;
    // 每次打开/重载自增：慢回来的旧响应不能覆盖新状态。
    let loadToken = 0;

    const setStatus = (message, tone = '') => {
      statusNode.textContent = String(message ?? '');
      statusNode.dataset.tone = tone;
      statusNode.hidden = !statusNode.textContent;
    };

    const setBusy = (next) => {
      busy = Boolean(next);
      saveButton.disabled = busy;
      cancelButton.disabled = busy;
      closeButton.disabled = busy;
      backdrop.dataset.busy = busy ? 'true' : 'false';
    };

    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    const sourceTag = (row) => {
      const tag = el('span', 'cfg-source', row.sourceLabel);
      tag.dataset.source = row.source;
      tag.title = row.source === 'manual'
        ? '手改：配置文件里的值偏离内置默认，执行时以它为准'
        : '探测：系统读到或默认值，配置箱没有改过';
      return tag;
    };

    /** 一行的「值」：可写行给输入框，只读行给文字，密钥行给来源 + 状态。 */
    const fieldOf = (row) => {
      const field = el('span', 'cfg-field');
      if (row.kind === 'text' || row.kind === 'list') {
        const input = el('input', 'cfg-input');
        input.type = 'text';
        input.id = `cfg-${row.id}`;
        input.dataset.cfg = row.id;
        input.value = row.display;
        input.placeholder = row.placeholder;
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.setAttribute('aria-label', row.label);
        field.append(input);
        return field;
      }
      const valueNode = el('span', row.kind === 'secret' ? 'cfg-value cfg-secret' : 'cfg-value', row.display);
      valueNode.dataset.cfg = row.id;
      field.append(valueNode);
      if (row.kind === 'secret') {
        const state = el('span', 'cfg-state', row.state);
        state.dataset.state = row.secret?.present ? 'present' : 'missing';
        field.append(state);
        if (row.origin && row.origin !== '环境变量') {
          field.append(el('span', 'cfg-origin', `来自 ${row.origin}`));
        }
      }
      return field;
    };

    const renderRow = (row) => {
      const node = el('div', 'cfg-row');
      node.dataset.row = row.id;
      node.dataset.kind = row.kind;
      node.dataset.source = row.source;
      node.append(
        el('span', 'cfg-label', row.label),
        fieldOf(row),
        sourceTag(row),
        el('p', 'cfg-effect', row.effect)
      );
      return node;
    };

    const renderSection = (section, sectionRows) => {
      const node = el('section', 'cfg-group');
      node.dataset.section = section.id;
      node.append(el('h3', 'cfg-group-title', section.label));
      if (section.hint) node.append(el('p', 'cfg-group-hint', section.hint));
      node.append(...sectionRows.map(renderRow));
      return node;
    };

    const render = () => {
      const api = data();
      if (!api) {
        bodyNode.replaceChildren();
        setStatus('配置数据模块未加载（config-box-host.mjs），先刷新窗口重试。', 'error');
        return;
      }
      rows = api.buildRows({ values, facts });
      bodyNode.replaceChildren(...api.SECTIONS.map((section) => renderSection(
        section,
        rows.filter((row) => row.section === section.id)
      )));
    };

    /** 读一遍配置与事实；失败也把箱子留着，并写清为什么没读成。 */
    const load = async () => {
      const api = data();
      if (!api) {
        render();
        return false;
      }
      const token = (loadToken += 1);
      setBusy(true);
      setStatus('正在读取配置…');
      try {
        if (!settings?.get) throw new Error('这个窗口没有拿到主进程接口（companion.settings）');
        const payload = await settings.get() ?? {};
        if (token !== loadToken) return false;
        values = payload;
        facts = payload.configBox && typeof payload.configBox === 'object' ? payload.configBox : {};
        render();
        setStatus('');
        return true;
      } catch (error) {
        if (token !== loadToken) return false;
        values = {};
        facts = {};
        render();
        setStatus(`读取配置失败：${error?.message ?? error}`, 'error');
        return false;
      } finally {
        if (token === loadToken) setBusy(false);
      }
    };

    /** 当前输入框里的草稿：只收可写行，id 与数据模块一致。 */
    const readDraft = () => {
      const draft = {};
      for (const input of bodyNode.querySelectorAll('input[data-cfg]')) {
        draft[input.dataset.cfg] = input.value;
      }
      return draft;
    };

    const save = async () => {
      const api = data();
      if (!api) return false;
      if (!settings?.set) {
        setStatus('这个窗口没有拿到主进程接口，改不了配置。', 'error');
        return false;
      }
      if (busy) return false;
      const patch = api.patchForSave(readDraft());
      setBusy(true);
      setStatus('正在保存…');
      try {
        await settings.set(patch);
        // 重读：来源标注按保存后的值重算（改回默认值就会变回「探测」）。
        const reloaded = await load();
        if (!reloaded) return false;
        const where = facts.paths?.config || 'companion.json';
        setStatus(`已保存到 ${where}；重启后仍然生效。`, 'ok');
        ctx.notify?.('配置已保存', 'ok');
        return true;
      } catch (error) {
        setStatus(`保存失败：${error?.message ?? error}`, 'error');
        ctx.notify?.('配置没保存上', 'error');
        return false;
      } finally {
        setBusy(false);
      }
    };

    /** 打开：先把箱子露出来，再读配置。先露出来是为了让「读取中」也是可见的。 */
    const open = () => {
      if (!backdrop) return false;
      backdrop.hidden = false;
      toggle?.setAttribute('aria-expanded', 'true');
      setStatus('');
      void load();
      return true;
    };

    /** 关掉：不写任何东西，草稿随 DOM 一起丢掉，下次打开重新读文件。 */
    const close = () => {
      if (!backdrop) return;
      backdrop.hidden = true;
      toggle?.setAttribute('aria-expanded', 'false');
      bodyNode.replaceChildren();
      setStatus('');
      rows = [];
    };

    // Esc 的一层：配置箱开着就关它，返回 true 由装配层决定还要不要往下走。
    const dismiss = () => {
      if (!backdrop || backdrop.hidden) return false;
      close();
      return true;
    };

    const isOpen = () => Boolean(backdrop) && backdrop.hidden === false;

    toggle?.addEventListener('click', () => {
      if (isOpen()) close();
      else open();
    });
    closeButton?.addEventListener('click', close);
    cancelButton?.addEventListener('click', close);
    // 点背板等于取消：取消不改任何东西。
    backdrop?.addEventListener('click', (event) => {
      if (event.target === backdrop) close();
    });
    saveButton?.addEventListener('click', () => void save());
    // 输入框里回车不提交表单（这一块不在 form 里），但别让回车丢焦点。
    bodyNode?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault();
    });

    return {
      open,
      close,
      dismiss,
      isOpen,
      load,
      save,
      render,
      rows: () => rows,
      facts: () => facts,
      values: () => values
    };
  };

  return { create };
});
