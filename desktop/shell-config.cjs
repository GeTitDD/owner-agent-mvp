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
    // #128 /setup 探测态的节点；缺任何一个都不阻塞 #127 的配置箱本体。
    const probePanel = $('configProbePanel');
    const probeSummary = $('configProbeSummary');
    const probeItemsNode = $('configProbeItems');
    const probeWritesNode = $('configProbeWrites');
    const probeSkipsNode = $('configProbeSkips');
    const probeReceiptNode = $('configProbeReceipt');
    const probeReceiptRows = $('configProbeReceiptRows');
    const probeEntry = $('configProbeEntry');
    const probeRecheck = $('configProbeRecheck');
    const probeApply = $('configProbeApply');
    const probeCancel = $('configProbeCancel');

    const settings = window.companion?.settings ?? null;
    // #128 探测与写入走单独的 IPC：探测只读，写入必须一次确认（allow=true）。
    const setupBridge = window.companion?.setup ?? null;
    // 数据与规则模块是 ESM，晚于本脚本执行；打开那一刻再取，读不到就明说。
    const data = () => window.OwnerConfigBox ?? null;
    // 判定文案与取消回执只认 src/setup-probe.mjs 这一份（经 setup-probe-host.mjs）。
    const probeApi = () => window.OwnerSetupProbe ?? null;

    // 本轮注入的事实：paths / secrets / sync / sources。打开时整份换掉，不增量合并。
    let facts = {};
    let values = {};
    let rows = [];
    let busy = false;
    // 每次打开/重载自增：慢回来的旧响应不能覆盖新状态。
    let loadToken = 0;
    // #128 探测态：probeView = { probe, plan }；receipt 是本次确认 / 取消的回执。
    let probeView = null;
    let probeReceipt = null;
    let probeBusy = false;
    // `/setup` 打开时登记的回调：确认或取消后把回执落到对话流。配置箱自己关闭算取消。
    let probeOnReceipt = null;

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

    // ── #128 /setup 探测态 ────────────────────────────────────────────
    // 探测结果、建议写入清单与回执全部由主进程算好；这里只画，并按一次确认调用 apply。
    // 取消不调用任何 IPC，所以「取消 = 文件系统前后一致」不靠界面自觉。

    const setProbeBusy = (next) => {
      probeBusy = Boolean(next);
      if (probeEntry) probeEntry.disabled = probeBusy;
      if (probeRecheck) probeRecheck.disabled = probeBusy;
      if (probeCancel) probeCancel.disabled = probeBusy;
      if (probeApply) {
        probeApply.disabled = probeBusy || !(probeView?.plan?.entries?.length > 0);
      }
    };

    const sourceTagFor = (item) => {
      const tag = el('span', 'cfg-probe-source', item.sourceLabel || '探测');
      tag.dataset.source = item.source === 'manual' ? 'manual' : 'probe';
      return tag;
    };

    /** 一行判定：标签 + 值 + 判定徽章 + 来源；空目录与说明另起一行。 */
    const renderProbeItem = (item) => {
      const node = el('li', 'cfg-probe-item');
      node.dataset.probeItem = item.id;
      node.dataset.verdict = item.verdict;
      // 0 个技能是「存在但为空」：保留判定（可用 / 只读），另用 data-empty 标出来。
      node.dataset.empty = item.empty === true ? 'true' : 'false';
      const badge = el('span', 'cfg-probe-badge', item.verdictLabel || item.verdict);
      badge.dataset.verdict = item.verdict;
      node.append(
        el('span', 'cfg-probe-label', item.label),
        el('span', 'cfg-probe-value', item.value || '—'),
        badge,
        sourceTagFor(item)
      );
      if (item.empty === true) node.append(el('span', 'cfg-probe-empty', '存在但为空'));
      if (item.detail) node.append(el('span', 'cfg-probe-detail', item.detail));
      return node;
    };

    /** 建议写入清单：只画 plan.entries（会写盘的项）；手改跳过单独写一行，不算写入项。 */
    const renderProbeWrites = () => {
      if (!probeWritesNode) return;
      const plan = probeView?.plan ?? null;
      const entries = Array.isArray(plan?.entries) ? plan.entries : [];
      const nodes = [];
      const skipNodes = [];
      if (entries.length === 0) {
        nodes.push(el('li', 'cfg-probe-nowrite', '没有会写盘的项：探测结果可以直接用。'));
      }
      for (const entry of entries) {
        const row = el('li', 'cfg-probe-write');
        row.dataset.writeEntry = entry.id;
        row.dataset.writeKind = (entry.writes ?? []).map((write) => write.kind).join(',');
        row.append(el('span', 'cfg-probe-write-label', entry.label));
        for (const write of Array.isArray(entry.writes) ? entry.writes : []) {
          row.append(el('span', 'cfg-probe-write-line', write.kind === 'mkdir'
            ? `新建目录 ${write.path}`
            : `写入配置 ${write.key} = ${write.value}`));
        }
        row.append(el('span', 'cfg-probe-write-to', `写到 ${entry.writeTo || 'companion.json'}`));
        nodes.push(row);
      }
      for (const skip of Array.isArray(plan?.skipped) ? plan.skipped : []) {
        const row = el('li', 'cfg-probe-skip', `跳过 ${skip.label}：${skip.reason}`);
        row.dataset.skipEntry = skip.itemId;
        skipNodes.push(row);
      }
      probeWritesNode.replaceChildren(...nodes);
      if (probeSkipsNode) {
        probeSkipsNode.replaceChildren(...skipNodes);
        probeSkipsNode.hidden = skipNodes.length === 0;
      }
      if (probeApply) probeApply.disabled = probeBusy || entries.length === 0;
    };

    const renderProbeSummary = () => {
      if (!probeSummary) return;
      const api = probeApi();
      const summary = api?.summarize?.(probeView?.probe)
        ?? { text: probeView?.probe?.items?.length ? `共 ${probeView.probe.items.length} 项` : '' };
      probeSummary.textContent = summary.text;
    };

    const renderProbeReceipt = () => {
      if (!probeReceiptNode) return;
      const receipt = probeReceipt;
      probeReceiptNode.textContent = receipt?.text ?? '';
      probeReceiptNode.dataset.tone = receipt ? (receipt.tone || 'ok') : '';
      probeReceiptNode.hidden = !receipt?.text;
      if (!probeReceiptRows) return;
      const block = Array.isArray(receipt?.blocks) ? receipt.blocks[0] : null;
      const rows = Array.isArray(block?.rows) ? block.rows : [];
      probeReceiptRows.replaceChildren(...rows.map((row) => {
        const line = el('li');
        line.append(el('b', '', String(row?.[0] ?? '')));
        line.append(el('span', '', String(row?.[1] ?? '')));
        return line;
      }));
      probeReceiptRows.hidden = rows.length === 0;
    };

    const renderProbe = () => {
      if (!probePanel) return;
      if (!probeView) {
        probePanel.hidden = true;
        return;
      }
      probePanel.hidden = false;
      renderProbeSummary();
      const items = Array.isArray(probeView.probe?.items) ? probeView.probe.items : [];
      probeItemsNode?.replaceChildren(...items.map(renderProbeItem));
      renderProbeWrites();
      renderProbeReceipt();
    };

    /** 探测一次：只读；失败也把面板留着，并写清为什么没探成。 */
    const runProbe = async ({ clearReceipt = true } = {}) => {
      if (!setupBridge?.probe) {
        setStatus('这个窗口没有拿到探测接口（companion.setup），无法探测本机。', 'error');
        return false;
      }
      if (clearReceipt) probeReceipt = null;
      setProbeBusy(true);
      setStatus('正在探测本机…');
      try {
        const payload = await setupBridge.probe();
        if (!payload?.probe) throw new Error('主进程没有返回探测结果');
        probeView = { probe: payload.probe, plan: payload.plan ?? null };
        renderProbe();
        setStatus('');
        return true;
      } catch (error) {
        setStatus(`探测失败：${error?.message ?? error}`, 'error');
        return false;
      } finally {
        setProbeBusy(false);
      }
    };

    /** 一次确认覆盖整张清单：成功与失败都给回执；失败不伪装成已写入。 */
    const applyProbe = async () => {
      if (!setupBridge?.apply) {
        setStatus('这个窗口没有拿到写入接口（companion.setup），一项都没写。', 'error');
        return false;
      }
      const count = probeView?.plan?.entries?.length ?? 0;
      if (count === 0) {
        setStatus('清单里没有会写盘的项，不用确认。', '');
        return false;
      }
      if (probeBusy) return false;
      setProbeBusy(true);
      setStatus('正在按清单写入…');
      try {
        const result = await setupBridge.apply({ allow: true });
        // 写到哪、跳过什么都由主进程的回执回答；这里只把它画出来并落到对话流。
        probeReceipt = {
          ...(result?.receipt ?? {}),
          tone: result?.ok ? 'ok' : 'error'
        };
        // 重读配置与探测：新建的目录与新写入的路径要立刻反映在判定上。
        await load();
        await runProbe({ clearReceipt: false });
        renderProbeReceipt();
        setStatus(result?.ok
          ? '已按清单写入；回执见上方。'
          : '写入没有完成，回执里有原因。', result?.ok ? 'ok' : 'error');
        const callback = probeOnReceipt;
        probeOnReceipt = null;
        await callback?.(result?.receipt ?? null, { cancelled: false });
        ctx.notify?.(result?.ok ? '已按清单写入' : '写入清单没有完成', result?.ok ? 'ok' : 'error');
        return Boolean(result?.ok);
      } catch (error) {
        setStatus(`写入失败：${error?.message ?? error}`, 'error');
        ctx.notify?.('写入清单没有完成', 'error');
        return false;
      } finally {
        setProbeBusy(false);
      }
    };

    /**
     * 取消：不调用写入 IPC。回执由纯函数按同一份清单算出，证明「0 处写入」。
     * 取消不是「稍后执行」，所以这里也不排队、不重试。
     */
    const cancelProbe = ({ notifyBridge = true } = {}) => {
      const api = probeApi();
      const receipt = api?.cancelReceipt
        ? api.cancelReceipt({ plan: probeView?.plan ?? null })
        : { text: '已取消：一项都没写。', blocks: [] };
      probeReceipt = { ...receipt, tone: 'ok' };
      renderProbe();
      setStatus('已取消：清单里所有写入都跳过了。', '');
      const callback = probeOnReceipt;
      probeOnReceipt = null;
      if (notifyBridge) void callback?.(receipt, { cancelled: true });
      return true;
    };

    /** 打开探测态：先露箱子读配置，再探测。`/setup` 与页脚的「探测本机」共用。 */
    const openProbe = async ({ onReceipt } = {}) => {
      if (!backdrop) return false;
      reveal();
      resetProbe();
      probeOnReceipt = typeof onReceipt === 'function' ? onReceipt : null;
      const loaded = await load();
      const probed = await runProbe();
      // 读配置失败也要把探测结果画出来：判定不依赖配置，只有手改合并依赖它。
      return loaded || probed;
    };

    /** 清空探测态：关闭箱子、重开配置箱时都不该留着上一轮的结果。 */
    const resetProbe = () => {
      probeView = null;
      probeReceipt = null;
      probeOnReceipt = null;
      if (probePanel) probePanel.hidden = true;
      probeItemsNode?.replaceChildren();
      probeWritesNode?.replaceChildren();
      probeSkipsNode?.replaceChildren();
      if (probeSkipsNode) probeSkipsNode.hidden = true;
      probeReceiptRows?.replaceChildren();
      if (probeReceiptNode) {
        probeReceiptNode.textContent = '';
        probeReceiptNode.hidden = true;
      }
      if (probeSummary) probeSummary.textContent = '';
      setProbeBusy(false);
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
    const reveal = () => {
      if (!backdrop) return false;
      backdrop.hidden = false;
      toggle?.setAttribute('aria-expanded', 'true');
      return true;
    };

    const open = () => {
      if (!reveal()) return false;
      // 齿轮入口只看配置本体：上一轮的探测结果（含回执）随关闭一起清掉。
      resetProbe();
      setStatus('');
      void load();
      return true;
    };

    /** 关掉：不写任何东西，草稿随 DOM 一起丢掉，下次打开重新读文件。 */
    const close = () => {
      if (!backdrop) return;
      // `/setup` 探测后还没确认就关闭，等同取消：补一条「0 处写入」回执，绝不偷偷落盘。
      if (probeView && probeOnReceipt) {
        const api = probeApi();
        const receipt = api?.cancelReceipt
          ? api.cancelReceipt({ plan: probeView.plan ?? null })
          : { text: '已取消：一项都没写。', blocks: [] };
        const callback = probeOnReceipt;
        probeOnReceipt = null;
        void callback(receipt, { cancelled: true });
      }
      resetProbe();
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
    // #128 探测入口：齿轮打开后点「探测本机」进入探测态；结果仍留在同一个配置箱里。
    probeEntry?.addEventListener('click', () => void openProbe());
    probeRecheck?.addEventListener('click', () => void runProbe());
    probeApply?.addEventListener('click', () => void applyProbe());
    probeCancel?.addEventListener('click', () => cancelProbe());
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
      values: () => values,
      // #128：`/setup` 与页脚入口共用；回执通过 onReceipt 落回对话流。
      openProbe,
      probeNow: runProbe,
      applyProbe,
      cancelProbe,
      probe: () => probeView
    };
  };

  return { create };
});
