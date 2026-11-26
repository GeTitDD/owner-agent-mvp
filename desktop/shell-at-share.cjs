// #126 `@@` →「分享到飞书」：目标只有飞书，勾选沿用 #123 的流内勾选；发送先过 #116 的外发确认。
//
// 边界：
// - 卡片只有两样控件：目标选择 + 发送。勾选在对话流里点（shell-stream 的勾选态，与「生成
//   prompt」是同一份），这里只读计数与下标，不另存一份选中集合。
// - 纯函数（目标状态、原文 + 出处组装、确认卡输入、回执块、一次投递）可脱离 Electron 断言；
//   卡片 DOM、落流与确认卡接线由 create 负责。
// - 外发授权不持久化（ADR-0012）：发送一定先出外发确认卡；取消与失败都不丢内容，
//   重试由人点，而且重试也会重新过一次确认卡——本模块没有自动重试、没有定时器。
// - webhook 未配置：读 #127 配置箱「分享」分区的状态（只看配没配，不回显值），
//   直接给「未配置 + 去配哪里」的提示；不出确认卡、不调发送。
// 双份导出：浏览器当普通脚本加载（挂到 window.OwnerShellAtShare），Node 测试用 require 读。
(function attach(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerShellAtShare = api;
})(typeof globalThis === 'undefined' ? null : globalThis, (root) => {
  // 出处与引用沿用 #123「生成 prompt」的同一套纯函数（引用标签 / 引用符 / 上下文三行 / 计数文案），
  // 不在这里抄第二份。浏览器里 shell-at-prompt.cjs 先于本文件加载，Node 测试里直接 require。
  const promptApi = (typeof module === 'object' && module.exports)
    ? require('./shell-at-prompt.cjs')
    : (root ? root.OwnerShellAtPrompt : null);

  const list = (value) => (Array.isArray(value) ? value : []);
  const str = (value) => (value === undefined || value === null ? '' : String(value));
  const oneLine = (value, max = 60) => str(value).replace(/\s+/gu, ' ').trim().slice(0, max);

  /** 飞书 webhook 的配置来源：与 #127 配置箱「分享」分区同一个环境变量，值永不进渲染层。 */
  const FEISHU_ENV = 'OWNER_OBSERVER_FEISHU_WEBHOOK';

  /**
   * 目标列表是数据：飞书可选，其它平台照常列出来但置灰、写明「暂不支持」。
   * 只支持飞书是这一票的验收面，不在别处偷偷放开第二个平台。
   */
  const TARGETS = Object.freeze([
    Object.freeze({ key: 'feishu', label: '飞书', supported: true, note: '' }),
    Object.freeze({ key: 'wecom', label: '企业微信', supported: false, note: '暂不支持' }),
    Object.freeze({ key: 'slack', label: 'Slack', supported: false, note: '暂不支持' })
  ]);

  const FEISHU = 'feishu';

  /** 菜单 / 卡片渲染用副本：调用方改返回值不会污染数据本身。 */
  const shareTargets = () => TARGETS.map((target) => ({ ...target }));

  /** 按 key 取目标；不认识就返回 null，不猜、不兜底成飞书。 */
  const targetOf = (key) => TARGETS.find((target) => target.key === str(key)) ?? null;

  /**
   * 目标选择（纯状态）：只接受已支持的平台；点到置灰项、或手里是不认识的目标，
   * 都退回飞书——选择永远停在一个能真的发出去的值上，不产生半截状态。
   */
  const selectTarget = (current, key) => {
    const next = targetOf(key);
    if (next?.supported === true) return next.key;
    const kept = targetOf(current);
    return kept?.supported === true ? kept.key : FEISHU;
  };

  /** 计数文案只有数字与单位，与 #123 同一句。 */
  const countText = (count) => (typeof promptApi?.countText === 'function'
    ? promptApi.countText(count)
    : `已选 ${Number.isInteger(count) && count > 0 ? count : 0} 条`);

  /** 引用标签：我的提问与助手的回复各自独立编号（复用 #123）。 */
  const labelsOf = (messages) => (typeof promptApi?.referenceLabels === 'function'
    ? promptApi.referenceLabels(messages)
    : list(messages).map((_message, index) => `第 ${index + 1} 条`));

  /** 原文引用：逐行加引用符，不改写、不摘要（复用 #123）。 */
  const quoteOf = (text) => (typeof promptApi?.blockquote === 'function'
    ? promptApi.blockquote(text)
    : str(text));

  /** 出处三行：项目 / 会话 / 时间，缺哪行少哪行（复用 #123）。 */
  const contextLinesOf = (context) => (typeof promptApi?.contextLines === 'function'
    ? promptApi.contextLines(context)
    : []);

  /** 勾选序号收顺：只要消息序列里的有效下标，且原文非空（与 #123 的勾选口径一致）。 */
  const pickedIndexes = (messages, selected) => {
    const rows = list(messages);
    return [...(selected instanceof Set ? selected : list(selected))]
      .map((index) => Number(index))
      .filter((index) => Number.isInteger(index) && index >= 0 && index < rows.length)
      .filter((index) => str(rows[index]?.text).trim().length > 0)
      .sort((left, right) => left - right);
  };

  /**
   * 组装分享正文：出处 + 原文。
   *
   *   【分享自 Companion】
   *   - 项目：…            ← 出处三行（缺的整行不出现）
   *   - 会话：…
   *   - 时间：…
   *
   *   **我的第 1 句**        ← 每条勾选消息一段：标签 + 原文引用
   *   > 原文…
   *
   * 只发原文，不改写、不摘要、不加指令；没有可分享的原文时只留下处，调用方拦住空发送。
   */
  const buildShareText = ({ context, messages, selected } = {}) => {
    const rows = list(messages);
    const labels = labelsOf(rows);
    const picked = pickedIndexes(rows, selected);
    const head = ['【分享自 Companion】', ...contextLinesOf(context)].join('\n');
    if (picked.length === 0) return head;
    const quotes = picked.map((index) => `**${labels[index]}**\n\n${quoteOf(rows[index].text)}`);
    return `${head}\n\n${quotes.join('\n\n')}`;
  };

  /**
   * 分享草稿：发送那一刻把「会话 + 勾选内容 + 组装好的正文」定下来。
   * 之后关卡片、刷新流、重开窗口里的选择都不影响它——失败与取消后内容不丢靠的就是这份草稿。
   * 没有可分享的原文返回 null，不造一份空草稿。
   */
  const draftOf = ({
    id = '',
    target = FEISHU,
    sessionId = '',
    session = '',
    project = '',
    time = '',
    messages = [],
    selected = [],
    at = ''
  } = {}) => {
    const rows = list(messages);
    const labels = labelsOf(rows);
    const picked = pickedIndexes(rows, selected);
    if (picked.length === 0) return null;
    const entries = picked.map((index) => ({
      index,
      label: labels[index],
      text: str(rows[index].text)
    }));
    return {
      id: str(id),
      target: selectTarget(FEISHU, target),
      sessionId: str(sessionId),
      session: str(session),
      project: str(project),
      time: str(time),
      count: entries.length,
      indexes: picked,
      entries,
      text: buildShareText({ context: { project, session, time }, messages: rows, selected: picked }),
      at: str(at)
    };
  };

  /** 确认卡输入（纯数据）：交给 #116 的 externalCardModelOf，不在这里另造卡型。 */
  const confirmSpecOf = (draft, { id = '' } = {}) => ({
    id: str(id) || `share-feishu-${str(draft?.id) || 'draft'}`,
    target: targetOf(draft?.target)?.label ?? '飞书',
    items: list(draft?.entries).map((entry) => ({
      label: entry.label,
      note: oneLine(entry.text) ? `原文：${oneLine(entry.text)}` : '原文'
    })),
    sequence: '第 1 次确认 / 共 1 次：外发单独一档'
  });

  const STATUSES = new Set(['sent', 'failed', 'cancelled']);

  /**
   * 回执块（纯数据）：会话、条数、结果与失败原因都在这张卡里；失败 / 取消带草稿 id，
   * 渲染层据此给人一个「重试」按钮。成功不再提供重试，避免重复发。
   */
  const receiptBlockOf = ({
    status = 'failed',
    target = FEISHU,
    session = '',
    count = 0,
    detail = '',
    at = '',
    draftId = ''
  } = {}) => {
    const state = STATUSES.has(str(status)) ? str(status) : 'failed';
    const total = Number.isInteger(Number(count)) && Number(count) > 0 ? Number(count) : 0;
    return {
      type: 'share',
      status: state,
      title: '分享回执 · 飞书',
      target: targetOf(target)?.label ?? '飞书',
      session: str(session),
      count: total,
      detail: str(detail),
      at: str(at),
      draftId: str(draftId),
      canRetry: state !== 'sent' && Boolean(str(draftId))
    };
  };

  /** 回执正文：成功说清会话与条数；失败带原因；取消说清「什么都没发、内容还在」。 */
  const receiptTextOf = ({ status, session = '', count = 0, detail = '' } = {}) => {
    const where = `会话《${str(session) || '未命名'}》`;
    if (status === 'sent') return `已分享 ${count} 条原文到飞书（${where}）。`;
    if (status === 'cancelled') {
      return `已取消：什么都没发。${count} 条原文还留着（${where}），要发再点「重试」；重试会重新过一次外发确认。`;
    }
    return `分享到飞书失败：${str(detail) || '未知原因'}。${count} 条原文还留着（${where}），点「重试」重发；不会自动重试。`;
  };

  const DELIVER_FAILED = '发送失败，没有给出原因';

  /**
   * 一次确认卡动作（纯逻辑，投递函数注入）。
   * - send-once：调一次 deliver，最多一次，不重试、不循环；
   * - cancel：一次都不调，草稿原样保留；
   * - 卡片过期（草稿已不在）：一次都不调，只说明要重新勾选。
   *
   * @returns {{kind:string, answeredLabel:string, userText:string, effects:string[],
   *   clearDraft:boolean, reply:{text:string, blocks:object[]}} | null}
   */
  const actShare = async ({ action, draft = null, deliver = null, at = '' } = {}) => {
    const id = str(action);
    if (id === 'cancel') {
      const count = Number.isInteger(draft?.count) ? draft.count : 0;
      const receipt = receiptBlockOf({
        status: 'cancelled',
        target: draft?.target ?? FEISHU,
        session: draft?.session ?? '',
        count,
        at,
        draftId: draft?.id ?? ''
      });
      return {
        kind: 'cancel',
        answeredLabel: '取消',
        userText: '取消',
        effects: [],
        clearDraft: false,
        reply: { text: receiptTextOf({ status: 'cancelled', session: draft?.session ?? '', count }), blocks: [receipt] }
      };
    }

    if (id !== 'send-once') return null;

    if (!draft) {
      // 草稿只活在本进程里：重开窗口后点到旧卡，如实说清要重新勾选，不假装发过。
      return {
        kind: 'expired',
        answeredLabel: '已过期',
        userText: '发出这一次',
        effects: [],
        clearDraft: false,
        reply: {
          text: '这张分享卡已经过期：重开窗口后草稿不再保留，这次没有发出任何内容。请重新用 @@ → 分享到飞书 勾选后再发。',
          blocks: []
        }
      };
    }

    let result = null;
    if (typeof deliver !== 'function') {
      result = { status: 'failed', detail: '分享接口不可用：这个窗口没有拿到投递入口' };
    } else {
      try {
        result = await deliver({ target: draft.target, text: draft.text });
      } catch (error) {
        result = { status: 'failed', detail: `发送接口抛错：${error?.message ?? error}` };
      }
    }

    const sent = result?.status === 'sent';
    const receipt = receiptBlockOf({
      status: sent ? 'sent' : 'failed',
      target: draft.target,
      session: draft.session,
      count: draft.count,
      detail: sent ? (str(result?.detail) || 'feishu code 0') : (str(result?.detail) || DELIVER_FAILED),
      at,
      draftId: draft.id
    });
    return {
      kind: sent ? 'sent' : 'failed',
      answeredLabel: '发出这一次',
      userText: '发出这一次',
      effects: [],
      // 成功才丢草稿：失败把正文原样留着，重试还能再发同一份内容。
      clearDraft: sent,
      reply: {
        text: receiptTextOf({
          status: sent ? 'sent' : 'failed',
          session: draft.session,
          count: draft.count,
          detail: sent ? '' : receipt.detail
        }),
        blocks: [receipt]
      }
    };
  };

  /** 未配置 webhook 的固定提示：说清「未配置」与去哪儿配，不静默失败。 */
  const NO_WEBHOOK_TEXT = '飞书 webhook 未配置：设置环境变量 OWNER_OBSERVER_FEISHU_WEBHOOK'
    + '（或 ~/.owner-agent/feishu.json 的 webhook 字段）后再分享。';

  /**
   * 配置状态 → 提示文案。空串表示「可以发」。
   * ok=false 是「读不到状态」，同样要看得见；不把「读不到」当成「配好了」。
   */
  const unconfiguredHint = (state) => {
    const env = str(state?.env) || FEISHU_ENV;
    if (state?.ok !== true) {
      return `读不到飞书 webhook 配置${state?.reason ? `（${state.reason}）` : ''}：`
        + `先确认这个窗口能读到主进程设置；配置项是环境变量 ${env}。`;
    }
    if (state.configured === true) return '';
    return NO_WEBHOOK_TEXT.replace(FEISHU_ENV, env);
  };

  /** 建立「分享到飞书」这一块：草稿与确认卡映射留在装配层，卡片关掉后仍能重试。 */
  const create = (ctx = {}) => {
    const ui = ctx.ui ?? {};
    // 草稿：draftId → draft；confirmCards：确认卡 id → draftId。两张表都只活在本进程。
    const drafts = new Map();
    const confirmCards = new Map();
    let draftSeq = 0;
    let cardSeq = 0;
    let target = FEISHU;

    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    /** 配置箱「分享」分区里的环境变量名；模块未加载时退回本文件的常量。 */
    const feishuEnv = () => {
      const row = root?.OwnerConfigBox?.rowById?.('feishuWebhook');
      return str(row?.env) || FEISHU_ENV;
    };

    /** 读「配没配」：先看注入的 provider（e2e / 测试），再走 #127 配置箱的 settings.get。 */
    const readStatus = async () => {
      const injected = root?.OwnerShareStatusProvider;
      if (typeof injected === 'function') {
        try {
          const value = await injected();
          return value && typeof value === 'object'
            ? value
            : { ok: false, configured: false, env: feishuEnv(), reason: '状态接口没有给出结果' };
        } catch (error) {
          return { ok: false, configured: false, env: feishuEnv(), reason: error?.message || '状态接口抛错' };
        }
      }
      const settings = root?.companion?.settings;
      if (typeof settings?.get !== 'function') {
        return { ok: false, configured: false, env: feishuEnv(), reason: '这个窗口没有拿到主进程接口' };
      }
      try {
        const payload = await settings.get();
        const secret = payload?.configBox?.secrets?.[feishuEnv()] ?? null;
        return {
          ok: true,
          configured: secret?.present === true,
          env: feishuEnv(),
          origin: str(secret?.origin)
        };
      } catch (error) {
        return { ok: false, configured: false, env: feishuEnv(), reason: error?.message ?? String(error) };
      }
    };

    /** 真正投递：先看注入的实现（测试用假实现，不读真网络），再走主进程桥。 */
    const deliver = async ({ target: picked, text }) => {
      const injected = root?.OwnerShareDeliver;
      if (typeof injected === 'function') return injected({ target: picked, text });
      const bridge = root?.companion?.share;
      if (typeof bridge?.feishu !== 'function') {
        throw new Error('分享接口不可用：这个窗口没有拿到主进程桥');
      }
      return bridge.feishu({ text });
    };

    /** 按草稿造一张 #116 外发确认卡；确认卡模块没加载就不出卡（宁可发不出）。 */
    const confirmCardOf = (draft) => {
      const cards = root?.OwnerConfirmCards ?? root?.OwnerConfirm;
      if (typeof cards?.externalCardModelOf !== 'function') return null;
      cardSeq += 1;
      return cards.externalCardModelOf(confirmSpecOf(draft, {
        id: `share-feishu-${draft.id}-${cardSeq}`
      }));
    };

    const contextOf = () => {
      const session = typeof ui.header?.currentSession === 'function' ? ui.header.currentSession() : null;
      if (typeof promptApi?.contextOf === 'function') return promptApi.contextOf(ctx, session);
      return {
        project: '',
        session: session && typeof ctx.listApi?.titleOf === 'function' ? ctx.listApi.titleOf(session) : '',
        time: str(session?.createdAt).trim()
      };
    };

    /** 卡片里的那点 DOM：目标选择 + 计数 + 未配置提示 + 发送；勾选在流里点。 */
    const mount = (wrap, tools = {}) => {
      const stream = ui.stream;
      if (typeof stream?.setSelectMode !== 'function') {
        wrap.append(document.createTextNode('对话流还没准备好，稍等一下再进这个方法。'));
        return null;
      }

      const box = el('div', 'at-share');

      const targetBox = el('div', 'at-share-targets');
      targetBox.append(el('span', 'at-share-label', '目标'));
      shareTargets().forEach((item) => {
        const button = el(
          'button',
          `at-share-target${item.supported ? '' : ' is-disabled'}`,
          item.supported ? item.label : `${item.label} · ${item.note}`
        );
        button.type = 'button';
        button.dataset.shareTarget = item.key;
        button.disabled = !item.supported;
        button.setAttribute('aria-pressed', item.key === target ? 'true' : 'false');
        if (!item.supported) button.title = `${item.label}：暂不支持，这一票只支持飞书`;
        targetBox.append(button);
      });
      box.append(targetBox);

      const count = el('p', 'at-share-count', countText(stream.selectionCount()));
      const status = el('p', 'at-share-status');
      status.hidden = true;
      const actions = el('div', 'at-share-actions');
      const send = el('button', 'at-share-send', '发送');
      send.type = 'button';
      send.disabled = stream.selectionCount() === 0;
      actions.append(send);
      box.append(count, status, actions);
      wrap.append(box);

      let busy = false;

      const setStatus = (text, tone = '') => {
        status.textContent = str(text);
        status.dataset.tone = str(tone);
        status.hidden = !status.textContent;
      };

      /** 勾选变化只改计数与按钮可用性，不重画方法卡。 */
      const sync = () => {
        const total = stream.selectionCount();
        count.textContent = countText(total);
        send.disabled = busy || total === 0;
      };

      const unsubscribe = stream.onSelectionChange(sync);
      // 进入方法就进勾选态：与「生成 prompt」是同一份勾选态与同一套点击落点。
      stream.setSelectMode(true);
      sync();

      targetBox.addEventListener('click', (event) => {
        const button = event.target.closest?.('[data-share-target]');
        if (!button || button.disabled) return;
        target = selectTarget(target, button.dataset.shareTarget);
        targetBox.querySelectorAll('[data-share-target]').forEach((node) => {
          node.setAttribute('aria-pressed', node.dataset.shareTarget === target ? 'true' : 'false');
        });
        setStatus('');
      });

      /**
       * 发送：先查「配没配」，再组装草稿，最后落一张外发确认卡。
       * 这一步不发送任何东西；真正投递只在确认卡的「发出这一次」里发生。
       */
      const requestConfirm = async () => {
        if (busy) return false;
        const picked = stream.selectedIndexes();
        if (picked.length === 0) {
          ctx.notify?.('先在对话流里勾选要分享的原文', 'error');
          return false;
        }
        const sessionId = typeof ui.header?.currentId === 'function' ? ui.header.currentId() : '';
        if (!sessionId) {
          ctx.notify?.('没有当前会话，先新建一个', 'error');
          return false;
        }
        if (!ctx.store) {
          ctx.notify?.('会话存储不可用，回执没法落进对话流', 'error');
          return false;
        }

        busy = true;
        sync();
        let created = false;
        // 装配层给了 report 就走它（错误落到顶栏）；没有就把动作直接跑一遍，不静默吞掉。
        const run = typeof ctx.report === 'function'
          ? (action) => ctx.report('分享到飞书', action)
          : (action) => action();
        try {
          await run(async () => {
            const state = await readStatus();
            const hint = unconfiguredHint(state);
            if (hint) {
              // 未配置：选择与正文都还在，关掉卡片前也不动它们。
              setStatus(hint, 'error');
              ctx.notify?.(hint, 'error');
              return;
            }

            const context = contextOf();
            draftSeq += 1;
            const shared = draftOf({
              id: `share-${draftSeq}`,
              target,
              sessionId,
              session: context.session,
              project: context.project,
              time: context.time,
              messages: stream.messages(),
              selected: picked,
              at: new Date().toISOString()
            });
            if (!shared) {
              const text = '勾选的消息里没有可分享的原文';
              setStatus(text, 'error');
              ctx.notify?.(text, 'error');
              return;
            }
            const card = confirmCardOf(shared);
            if (!card) {
              const text = '确认卡模块还没加载好，稍等一下再试。';
              setStatus(text, 'error');
              ctx.notify?.(text, 'error');
              return;
            }

            drafts.set(shared.id, shared);
            confirmCards.set(card.id, shared.id);
            await ctx.store.append({
              id: sessionId,
              role: 'assistant',
              text: `准备把 ${shared.count} 条原文分享到飞书；先确认，允许才发出。`,
              blocks: [card]
            });
            created = true;
            // 卡片收起来，勾选态退出；草稿已经在上面定下来，关掉不丢内容。
            if (typeof tools.close === 'function') tools.close();
            else stream.setSelectMode(false);
            await ctx.refreshThread?.();
            ui.compose?.focus?.();
          });
        } finally {
          busy = false;
          sync();
        }
        return created;
      };

      send.addEventListener('click', () => { void requestConfirm(); });

      return () => {
        unsubscribe();
        stream.setSelectMode(false);
      };
    };

    /** 确认卡的动作落点：shell-stream 的 actConfirm 调这里，不自己判定外发。 */
    const act = async ({ cardId, action, at = '' } = {}) => {
      const id = str(cardId);
      const draftId = confirmCards.get(id) ?? '';
      const draft = draftId ? drafts.get(draftId) ?? null : null;
      const outcome = await actShare({ action, draft, deliver, at });
      if (!outcome) return null;
      if (outcome.clearDraft && draftId) {
        drafts.delete(draftId);
        confirmCards.delete(id);
      }
      return outcome;
    };

    /** 回执上的「重试」：用同一份草稿再出一张外发确认卡；不直接发送、不绕过确认。 */
    const retry = ({ draftId } = {}) => {
      const draft = drafts.get(str(draftId)) ?? null;
      if (!draft) {
        return {
          text: '这份分享草稿已经不在（重开窗口后不保留）；请重新用 @@ → 分享到飞书 勾选后再发。',
          blocks: []
        };
      }
      const card = confirmCardOf(draft);
      if (!card) {
        return { text: '确认卡模块还没加载好，稍等一下再试。', blocks: [] };
      }
      confirmCards.set(card.id, draft.id);
      return {
        text: `重试：${draft.count} 条原文仍按原样准备发到飞书；再确认一次，允许才发出。`,
        blocks: [card]
      };
    };

    /** 这张卡是不是本模块出的：重开窗口后映射丢了，靠 id 前缀也认得出来。 */
    const isShareCard = (cardId) => str(cardId).startsWith('share-feishu-')
      || confirmCards.has(str(cardId));

    const knowsCard = (cardId) => isShareCard(cardId);

    return {
      mount,
      act,
      retry,
      knowsCard,
      isShareCard,
      target: () => target,
      draft: (draftId) => {
        const draft = drafts.get(str(draftId));
        return draft ? { ...draft } : null;
      },
      drafts: () => drafts.size
    };
  };

  return {
    FEISHU_ENV,
    TARGETS,
    NO_WEBHOOK_TEXT,
    shareTargets,
    targetOf,
    selectTarget,
    countText,
    buildShareText,
    draftOf,
    confirmSpecOf,
    receiptBlockOf,
    receiptTextOf,
    actShare,
    unconfiguredHint,
    create
  };
});
