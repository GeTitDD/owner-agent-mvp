// #116 外发与删除的确认卡：两种卡片模型、归一化、动作与回执。
//
// 为什么单独一个文件：ADR-0012 把「外发」与「删除」从普通写入里分出来——
// 外发离开本机、发出即收不回；删除是横切动作、永远逐次确认。这两种卡不能套用
// #113 的四个动作：那里有「低风险免问」，而外发与删除都不允许免问、也不允许批量。
// 如果把它们硬塞进 type=risk，只会在渲染层到处补「这一档不给免问」的例外；最后
// 某一条路径漏补，就会冒出一个本不该存在的「以后不用问」。
//
// 所以这里是独立块 type=confirm：
//   kind=external  外发卡——强调「发出即收不回」，只有「发出这一次 / 取消」；
//   kind=delete    删除卡——逐条列出对象，每项一个按钮，没有批量放行，删完给回执。
//
// 判定不在这里：外发恒 confirm、删除恒 confirm 都由 src/confirm-plan.mjs 复用
// write-gate 得出；本文件只吃计划、出卡片与回执。归一化会重算动作表，存储里若混进
// 「免问」或「批量删除」也不会被画出来。
//
// 双份导出：浏览器当普通脚本加载（挂到 window.OwnerConfirmCards），Node 测试用 require 读。

(function attach(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerConfirmCards = api;
})(typeof globalThis === 'undefined' ? null : globalThis, (root) => {
  // 脱敏沿用 #113 的唯一一份规则（risk-card.cjs）：确认卡会被复制进会话与导出，
  // 不能因为这里的标题或路径里带了 token 就把它显示出来。
  const riskApi = (typeof module === 'object' && module.exports)
    ? require('./risk-card.cjs')
    : (root ? root.OwnerRiskCard : null);

  const scrub = (value) => (riskApi?.scrubText ? riskApi.scrubText(value) : String(value ?? '').trim());

  const KINDS = new Set(['external', 'delete']);

  const str = (value) => (value === undefined || value === null ? '' : String(value).trim());
  const list = (value) => (Array.isArray(value) ? value : []);
  const isObject = (value) => Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value);

  /** 外发卡的两个动作：没有「以后不用问」，这是验收面，别在别处补第三个。 */
  const EXTERNAL_ACTIONS = Object.freeze([
    Object.freeze({ id: 'send-once', label: '发出这一次', primary: true, cancel: false }),
    Object.freeze({ id: 'cancel', label: '取消', primary: false, cancel: true })
  ]);

  /** 删除卡只允许「逐项删」和「取消」；没有 delete-all / 批量之类的 id。 */
  const CANCEL_ACTION = Object.freeze({ id: 'cancel', label: '取消', primary: false, cancel: true });

  const EXTERNAL_NOTICES = Object.freeze([
    '发出即收不回：发出后本机无法撤回、无法编辑，对方可以保存与转发。',
    '没有「以后不用问」：外发授权不持久化，每次都要确认。',
    '取消不改变本地状态：不排队、不重试，草稿仍留在原处。'
  ]);

  const DELETE_NOTICES = Object.freeze([
    '没有批量放行：一次只能删一项，逐条确认。',
    '删除后不可恢复；每删一项都会给回执：删了什么、剩下什么。'
  ]);

  const KIND_META = Object.freeze({
    external: Object.freeze({
      title: '外发确认',
      badge: '不可逆',
      headline: '发出即收不回',
      notices: EXTERNAL_NOTICES
    }),
    delete: Object.freeze({
      title: '删除确认',
      badge: '逐条确认',
      headline: '删除后不可恢复，需逐条确认',
      notices: DELETE_NOTICES
    })
  });

  /** 一行待发 / 待删对象：label 给人看，path 是完整路径（一个字都不截）。 */
  const itemOf = (value, index) => {
    const entry = isObject(value) ? value : { path: value };
    const path = str(entry.path ?? entry.fullPath);
    return {
      index,
      label: str(entry.label ?? entry.name) || path || `第 ${index + 1} 项`,
      path,
      note: str(entry.note)
    };
  };

  /** 外发卡的动作表：恒定两项，与等级、授权、存储内容都无关。 */
  const actionsFor = (kind, items) => {
    if (kind === 'external') return EXTERNAL_ACTIONS.map((action) => ({ ...action }));
    if (kind === 'delete') {
      return [
        ...items.map((item, index) => ({
          id: 'delete-item',
          index,
          label: `删除第 ${index + 1} 项`,
          primary: false,
          cancel: false
        })),
        { ...CANCEL_ACTION }
      ];
    }
    // 看不懂的卡片不给任何动作：宁可什么都不做，也不给一个能点下去的按钮。
    return [];
  };

  /** 通知行去重并按固定顺序：外发/删除的硬约束永远排在最前面。 */
  const noticesFor = (kind, value) => {
    const required = KIND_META[kind]?.notices ?? [];
    const extra = list(value).map(str).filter(Boolean);
    const merged = [...required, ...extra];
    return merged.filter((line, index) => merged.indexOf(line) === index);
  };

  /**
   * 外发卡模型（纯数据）。
   *
   * @param {object} input
   * @param {string} [input.id]
   * @param {string} [input.title]
   * @param {string} [input.target] 发到哪里（飞书群、远端仓库……）
   * @param {Array<object|string>} [input.items] 逐条列出的待发内容
   * @param {string} [input.conclusion]
   * @param {string} [input.sequence] 例如「第 2 次确认 / 共 2 次：先写后发」
   * @returns {object} type=confirm / kind=external 的块模型
   */
  function externalCardModelOf({
    id = 'external',
    title = '',
    target = '',
    items = [],
    conclusion = '',
    sequence = ''
  } = {}) {
    const clean = list(items).map(itemOf).filter((item) => item.label);
    const meta = KIND_META.external;
    return {
      type: 'confirm',
      kind: 'external',
      id: str(id) || 'external',
      title: scrub(title) || meta.title,
      badge: meta.badge,
      headline: meta.headline,
      conclusion: scrub(conclusion) || `这会把 ${clean.length} 项内容发到本机之外${target ? `（${scrub(target)}）` : ''}：发出即收不回，本机无法撤回。`,
      target: scrub(target),
      sequence: scrub(sequence),
      items: clean,
      notices: noticesFor('external'),
      actions: actionsFor('external', clean)
    };
  }

  /**
   * 删除卡模型（纯数据）：逐条列出将删对象，每项一个按钮。
   *
   * @param {object} input
   * @param {string} [input.id]
   * @param {string} [input.title]
   * @param {Array<object|string>} [input.items] 将删对象（逐条，不合并）
   * @param {string} [input.conclusion]
   * @param {string} [input.sequence]
   * @returns {object} type=confirm / kind=delete 的块模型
   */
  function deleteCardModelOf({
    id = 'delete',
    title = '',
    items = [],
    conclusion = '',
    sequence = ''
  } = {}) {
    const clean = list(items).map(itemOf).filter((item) => item.label);
    const meta = KIND_META.delete;
    return {
      type: 'confirm',
      kind: 'delete',
      id: str(id) || 'delete',
      title: scrub(title) || meta.title,
      badge: meta.badge,
      headline: meta.headline,
      conclusion: scrub(conclusion) || `这会删除 ${clean.length} 项：删除后不可恢复，必须逐项确认。`,
      target: '',
      sequence: scrub(sequence),
      items: clean,
      notices: noticesFor('delete'),
      actions: actionsFor('delete', clean)
    };
  }

  /**
   * 把存储里读回来的确认卡归一化为可安全渲染的模型。
   *
   * 关键防线：动作表不信任存储内容，按 kind 与条目数重算。即使旧数据里混进了
   * defer-low（以后不用问）或 delete-all（批量删除），这里也不会把它画出来。
   *
   * @param {unknown} data 卡片块
   * @returns {object} type=confirm 的渲染模型
   */
  function normalizeConfirmCard(data = {}) {
    const source = isObject(data) ? data : {};
    const kind = KINDS.has(str(source.kind)) ? str(source.kind) : 'unknown';
    const items = list(source.items).map(itemOf).filter((item) => item.label);
    if (kind === 'unknown') {
      return {
        type: 'confirm',
        kind,
        id: scrub(source.id) || 'confirm-unknown',
        title: '无法识别的确认卡',
        badge: '不放行',
        headline: '看不懂的确认卡一律不放行',
        conclusion: '这张卡的类型不认识：没有可点的动作，也不会执行任何写入、删除或外发。',
        target: '',
        sequence: '',
        items: list(source.items).map(itemOf),
        notices: ['确认卡类型未知：按最保守的方式处理，什么都不做。'],
        actions: [],
        answered: str(source.answered) && scrub(source.answered)
      };
    }
    const meta = KIND_META[kind];
    const model = kind === 'external' ? externalCardModelOf(source) : deleteCardModelOf(source);
    return {
      ...model,
      // 标题与结论允许存储里覆盖，但类型自带的硬约束（badge/headline/notices/actions）不覆盖。
      title: scrub(source.title) || model.title,
      conclusion: scrub(source.conclusion) || model.conclusion,
      items: items.length > 0 ? items : model.items,
      // 重新按归一化后的条目算：外发恒两项，删除恒「每项一个 + 取消」。
      actions: actionsFor(kind, items.length > 0 ? items : model.items),
      // badge 是类型自带的硬约束（不可逆 / 逐条确认），存储内容不能改写。
      badge: meta.badge,
      answered: str(source.answered) ? scrub(source.answered) : ''
    };
  }

  /** 回执的键值块：删除/外发共用一套形状，失败与取消也要看得见。 */
  const receiptBlockOf = ({ kind, result, deleted = [], remaining = [], at = '' } = {}) => {
    const rows = [];
    if (kind === 'external') {
      rows.push(['动作', '外发']);
      rows.push(['结果', result === 'cancelled' ? '未发出（0 处）' : '已发出（脚本化，不会真的发送）']);
      rows.push(['本地状态', '未变（不排队、不重试，草稿仍在原处）']);
    } else {
      rows.push(['动作', '删除']);
      rows.push(['结果', result === 'cancelled' ? '未删除（0 处）' : `已删除 ${deleted.length} 项`]);
      rows.push(['已删除', deleted.length ? deleted.map((item) => item.path || item.label).join('；') : '无']);
      rows.push(['剩余', `${remaining.length} 项`]);
      remaining.forEach((item, index) => {
        rows.push([`剩余 ${index + 1}`, item.path || item.label]);
      });
    }
    if (at) rows.push(['时间', str(at)]);
    return {
      type: 'kv',
      title: kind === 'external' ? '外发回执' : '删除回执',
      rows
    };
  };

  /**
   * 确认卡动作的唯一落点：返回要追加进会话的两条消息与「有没有副作用」。
   *
   * `effects` 是本动作真正会改变的状态清单。取消恒为空数组——取消不是「稍后执行」，
   * 而是根本不排队；调用方据此可以断言「取消后本地状态不变」。
   *
   * @param {object} input
   * @param {object} input.card 卡片块
   * @param {string} input.action 动作 id
   * @param {number} [input.index] 删除卡的动作序号（delete-item 必填）
   * @param {string} [input.at] 时间（测试可固定）
   * @returns {{kind:string, answeredLabel:string, userText:string, effects:string[],
   *   reply:{text:string, blocks?:object[]}} | null}
   */
  function confirmAction({ card, action, index = -1, at = '' } = {}) {
    const current = normalizeConfirmCard(card);
    const actionId = str(action);
    const target = current.actions.find((item) => item.id === actionId
      && (actionId !== 'delete-item' || item.index === index));

    // 不在归一化动作表里的动作一律不产生消息：旧节点、伪造参数都到这里为止。
    if (!target) return null;

    if (actionId === 'cancel') {
      const remaining = current.kind === 'delete' ? current.items : [];
      return {
        kind: 'cancel',
        answeredLabel: '取消',
        userText: '取消',
        effects: [],
        reply: {
          text: current.kind === 'external'
            ? '已取消：没有发出任何内容，本地状态不变——不排队、不重试，草稿仍在原处。'
            : `已取消：没有删除任何东西，${remaining.length} 项原样保留。`,
          blocks: [receiptBlockOf({
            kind: current.kind, result: 'cancelled', remaining, at
          })]
        }
      };
    }

    if (actionId === 'send-once') {
      // 本轮不接真实外发：与 #113 的「允许这一次」同一口径，只说清记录了什么。
      return {
        kind: 'send-once',
        answeredLabel: '发出这一次',
        userText: '发出这一次',
        effects: [],
        reply: {
          text: '已记录「发出这一次」。本轮是脚本化确认卡，不会真的发出；外发接入后才会按这张卡发送。'
        }
      };
    }

    if (actionId === 'delete-item') {
      const item = current.items[index];
      if (!item) return null;
      const remaining = current.items.filter((_entry, position) => position !== index);
      const blocks = [receiptBlockOf({
        kind: 'delete', result: 'deleted', deleted: [item], remaining, at
      })];
      // 逐条删除：还有剩余就再给一张只含剩余项的卡，下一项仍要单独确认。
      if (remaining.length > 0) {
        blocks.push(deleteCardModelOf({
          id: `${current.id}-rest-${remaining.length}`,
          title: current.title,
          items: remaining,
          sequence: `${current.sequence ? `${current.sequence}；` : ''}还剩 ${remaining.length} 项，逐条确认`
        }));
      }
      return {
        kind: 'delete-item',
        answeredLabel: `已删除：${item.label}`,
        userText: `删除：${item.path || item.label}`,
        effects: [item.path || item.label],
        reply: {
          text: `已删除 1 项：${item.label}${item.path ? `（${item.path}）` : ''}；还剩 ${remaining.length} 项。`,
          blocks
        }
      };
    }

    return null;
  }

  const EXTERNAL_COMMAND = /^\/(?:外发|send)(?:\s+([\s\S]*))?$/u;
  const DELETE_COMMAND = /^\/(?:删除|delete)(?:\s+([\s\S]*))?$/u;

  /**
   * 解析外发 / 删除的脚本化命令。
   * 其余输入返回 null（走普通消息），所以这两条命令不会误吃正常聊天。
   *
   * @param {unknown} input
   * @returns {{kind:'external'|'delete', arg:string} | null}
   */
  function parseCommand(input) {
    const text = str(input);
    const external = EXTERNAL_COMMAND.exec(text);
    if (external) return { kind: 'external', arg: str(external[1]) };
    const remove = DELETE_COMMAND.exec(text);
    if (remove) return { kind: 'delete', arg: str(remove[1]) };
    return null;
  }

  const isCommand = (input) => parseCommand(input) !== null;

  return {
    KIND_META,
    EXTERNAL_ACTIONS,
    externalCardModelOf,
    deleteCardModelOf,
    normalizeConfirmCard,
    receiptBlockOf,
    confirmAction,
    parseCommand,
    isCommand
  };
});
