// #138 决策改写与 `/记决策` 共用的一张表单。
//
// 为什么单独一个文件：同一张卡要在两个入口出现——
//   · `/提炼决策` 的候选：点「改写」后编辑选择 / 放弃的方案 / 理由，现象只读；
//   · `/记决策`：从空白开始填现象 / 选择 / 放弃 / 理由。
// 如果各写一套字段名与动作 id，很快就会一边能改写、另一边漏字段。所以卡片模型、
// 字段归一与「点了什么动作 → 接下来做什么」都收在这里，渲染层只画、对话流只执行。
//
// 三条边界写死在这里：
// 1. 改写只动 intent / abandoned / reason；现象是只读的，也是指纹来源，不能跟着改；
// 2. 取消（取消改写 / 取消记决策）不产生任何写入，也不标记这张卡「已选择」以外的状态；
// 3. 理由空着就是「缺理由」，不填「未说明」这类占位词。
//
// 双份导出：浏览器当普通脚本加载（挂到 window.OwnerDecisionForm），Node 测试用 require 读。
// 入库不在这里：候选改写接受走 decision-scan 的 acceptPendingCandidate，
// `/记决策` 走 decision-confirm 的 confirmDecisionCandidate——同一个确认 API，不另开写路径。

(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerDecisionForm = api;
})(typeof globalThis === 'undefined' ? null : globalThis, () => {
  // 与 src/memory/decision-scan.mjs / decision-confirm.mjs 的上限保持一致：
  // 界面先截一次，入库时服务端还会按同一组上限再截一次。
  const LIMITS = Object.freeze({
    phenomenon: 500,
    intent: 2000,
    abandoned: 2000,
    reason: 2000
  });

  const str = (value) => (value === undefined || value === null ? '' : String(value).trim());

  /** 字段归一：去掉 NUL、把换行与连续空白折成一个空格，按上限截断（与 flatText 同口径）。 */
  const flat = (value, max) => str(value)
    .replace(/\u0000/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, max);

  /** 表单四字段：现象 + 三个可编辑字段。缺哪个就是空串，不猜默认值。 */
  const formValues = (input = {}) => {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    return {
      phenomenon: flat(source.phenomenon, LIMITS.phenomenon),
      intent: flat(source.intent, LIMITS.intent),
      abandoned: flat(source.abandoned, LIMITS.abandoned),
      reason: flat(source.reason, LIMITS.reason)
    };
  };

  /** 理由为空即缺理由：界面、回执与入库共用这一条判断。 */
  const reasonMissingOf = (values) => str(values?.reason) === '';

  /**
   * 候选卡（`/提炼决策`）：先按行展示，点「改写」在本卡内展开同一张表单。
   * 现象留在卡上只读；三个可编辑字段的初值就是候选当前值，未改时接受仍按原内容。
   */
  const candidateCard = (item = {}) => {
    const values = formValues(item);
    const missingReason = item?.missingReason === true || reasonMissingOf(values);
    const source = [str(item?.source), str(item?.sessionId)].filter(Boolean).join(' · ');
    return {
      type: 'review',
      kind: 'decision',
      mode: 'candidate',
      // editable 是「这张卡有表单」的开关；mode 决定现象是否可改、动作是哪两个。
      editable: true,
      fingerprint: str(item?.fingerprint),
      projectId: str(item?.projectId),
      phenomenon: values.phenomenon,
      missingReason,
      values,
      title: values.phenomenon || '待确认决策',
      rows: [
        ['现象', values.phenomenon || '（没有原话）'],
        ['选择', values.intent || '（未记录）'],
        ['放弃的方案', values.abandoned || '（未记录）'],
        ['理由', missingReason ? '缺理由（接受时可补一句）' : values.reason],
        ['来源', source || '会话扫描']
      ],
      actions: [
        { id: 'accept', label: '接受' },
        { id: 'rewrite', label: '改写' },
        { id: 'reject', label: '拒绝' }
      ],
      formActions: [
        { id: 'save-accept', label: '保存并接受' },
        { id: 'cancel-edit', label: '取消改写' }
      ],
      note: missingReason
        ? '缺理由：接受时会问一句，可跳过；跳过就保持「缺理由」。改写后保存并接受，写入的是改后的内容。'
        : '接受会写入知识库；改写后保存并接受，写入的是改后的内容。拒绝只记指纹，以后不再提。'
    };
  };

  /**
   * 记决策卡（`/记决策`）：与候选卡同一形状，只是从空白开始填、现象也可写。
   * 动作只有「确认写入 / 取消」；取消由对话流回一条「没有写入」，这里不预置任何假内容。
   */
  const composeCard = ({ projectId = '', projectName = '' } = {}) => ({
    type: 'review',
    kind: 'decision',
    mode: 'compose',
    editable: true,
    projectId: str(projectId),
    projectName: str(projectName),
    phenomenon: '',
    missingReason: true,
    values: { phenomenon: '', intent: '', abandoned: '', reason: '' },
    title: '记一条决策',
    rows: [
      ['项目', str(projectName) || str(projectId) || '（未选项目）'],
      ['来源', '手动填写']
    ],
    actions: [
      { id: 'confirm', label: '确认写入' },
      { id: 'cancel', label: '取消' }
    ],
    // 记决策的动作就在卡片底部，不另起一套表单动作。
    formActions: [],
    note: '现象、选择、放弃的方案、理由都可以填；理由留空会标为「缺理由」，不填占位词。取消不写任何东西。'
  });

  /**
   * 表单 → 一条手动候选（纯数据）。指纹不在这里算：decision-confirm 会按
   * 「项目 + 现象」补指纹，同一现象重复确认走幂等路径，不写第二条。
   * 来源固定 manual：没有会话可回查，就不冒充 session-scan。
   */
  const composeCandidate = ({ projectId = '', projectName = '', fields = {} } = {}) => {
    const values = formValues(fields);
    return {
      projectId: str(projectId),
      projectName: str(projectName),
      phenomenon: values.phenomenon,
      intent: values.intent,
      abandoned: values.abandoned,
      source: 'manual',
      sourceKind: 'manual'
    };
  };

  /**
   * 「点了什么动作 → 接下来做什么」的唯一分发（纯函数）。
   *
   * 返回的 type：
   *   expand / collapse  候选卡展开 / 收起改写表单，不写任何东西；
   *   accept             候选接受；edits 为改写值（未改写时 null），reason 为理由；
   *   ask-reason         缺理由的普通接受，先追问一句（#135 原行为）；
   *   reject             拒绝候选；
   *   confirm            记决策确认；fields 是四个字段；
   *   cancel            取消记决策：不写任何东西；
   *   invalid            表单不完整（目前只有「现象为空」），不写入；
   *   none               不认识的动作，调用方不动作。
   *
   * @param {object} input
   * @param {'candidate'|'compose'} [input.mode] 卡片模式
   * @param {string} [input.action] 按钮上的 data-review-action
   * @param {object} [input.card] 卡片模型（读 missingReason / values.reason）
   * @param {object|null} [input.fields] 表单里读出的四个字段（只在改写 / 记决策时给）
   */
  const reviewIntent = ({ mode = 'candidate', action = '', card = null, fields = null } = {}) => {
    const kind = mode === 'compose' ? 'compose' : 'candidate';
    if (kind === 'candidate') {
      if (action === 'rewrite') return { type: 'expand' };
      if (action === 'cancel-edit') return { type: 'collapse' };
      if (action === 'reject') return { type: 'reject' };
      if (action === 'save-accept') {
        const edited = formValues(fields ?? {});
        // 现象不在 edits 里：保存并接受只改三项，指纹与现象仍取原候选。
        return {
          type: 'accept',
          edits: { intent: edited.intent, abandoned: edited.abandoned, reason: edited.reason },
          reason: edited.reason
        };
      }
      if (action === 'accept') {
        const reason = flat(card?.values?.reason, LIMITS.reason);
        // 原本就缺理由、这次也没补：先问一句；跳过仍写库但保持「缺理由」。
        if (card?.missingReason === true && reason === '') return { type: 'ask-reason' };
        return { type: 'accept', edits: null, reason };
      }
      return { type: 'none' };
    }
    if (action === 'cancel') return { type: 'cancel' };
    if (action === 'confirm') {
      const values = formValues(fields ?? {});
      // 没有现象就没有「当时发生了什么」，不能靠选择与理由拼一条决策。
      if (!values.phenomenon) return { type: 'invalid', message: '现象不能为空：先写清当时发生了什么。' };
      return { type: 'confirm', fields: values };
    }
    return { type: 'none' };
  };

  return {
    DECISION_FORM_LIMITS: LIMITS,
    formValues,
    reasonMissingOf,
    candidateCard,
    composeCard,
    composeCandidate,
    reviewIntent
  };
});
