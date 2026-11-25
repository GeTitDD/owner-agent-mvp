// #113 写入风险评级与确认卡：评估器原始输出 → 归一化风险 → 卡片模型。
//
// 为什么单独一个文件：ADR-0012 把「风险」定为三轴（影响面 / 可逆性 / 是否离开本机），
// 并规定「评估失败或超时一律按高」。这条降级规则会被确认卡、真实写入（#114–#116）
// 和以后的外发/删除确认反复引用；如果每个调用方自己补一句「缺字段就当低风险」，
// 最后一次误放行就是从这里漏出去的。所以归一化只留这一份纯函数：
// 不读盘、不联网、不读环境变量、不调模型——评估器由调用方注入。
//
// 双份导出：浏览器当普通脚本加载（挂到 window.OwnerRiskCard），Node 测试用 require 读。
// 卡片里的路径、判据、人工改判备注统一过一遍脱敏：确认卡是给人看的，
// 也是会被复制进会话的，不能因为评估器把 token 抄进判据就把它显示出来。
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerRiskCard = api;
})(typeof globalThis === 'undefined' ? null : globalThis, () => {
  // 等级只有三档。未知等级不猜、不夹在中间，一律降为高。
  const LEVELS = ['low', 'medium', 'high'];
  const LEVEL_LABELS = Object.freeze({
    low: '低风险',
    medium: '中风险',
    high: '高风险'
  });
  const LEVEL_RANK = Object.freeze({ low: 0, medium: 1, high: 2 });

  // 三轴的中文称呼与合法值；加值时必须同时改这里和归一化别名，别在渲染层另起一套。
  const IMPACT_LABELS = Object.freeze({
    machine: '本机级',
    project: '项目级',
    'cross-project': '跨项目'
  });
  const REVERSIBILITY_LABELS = Object.freeze({
    reversible: '可逆',
    rebuild: '需重建',
    irreversible: '不可逆'
  });
  const LEAVES_LABELS = Object.freeze({ false: '否', true: '是' });

  const AXIS_ORDER = ['impact', 'reversibility', 'leavesMachine'];
  const AXIS_LABELS = Object.freeze({
    impact: '影响面',
    reversibility: '可逆性',
    leavesMachine: '是否离开本机'
  });

  // 四个动作的名称固定。按钮文案属于验收面，别在别处换同义词。
  const ACTIONS = Object.freeze([
    { id: 'allow-once', label: '允许这一次' },
    { id: 'defer-low', label: '低风险免问' },
    { id: 'override', label: '我的判断不同' },
    { id: 'cancel', label: '取消' }
  ]);

  const RISK_COMMAND = '/risk';
  const COMMAND_KINDS = new Set(['high', 'medium', 'low']);

  // 评估器没给「为什么不是别的等级」时的兜底句：不能空着，也不能因此降档。
  const MISSING_WHY_NOT = '评估器没有给出说明：无法判断为什么不是别的等级，按高风险处理。';

  const isObject = (value) =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

  /** 文本的统一口径：undefined / null 变空串，其余转字符串并去掉首尾空白。 */
  const str = (value) => (value === undefined || value === null ? '' : String(value).trim());

  const list = (value) => (Array.isArray(value) ? value : []);

  /**
   * 判据的统一口径：数组逐条清洗；字符串按换行拆成多条（评估器偶尔会把一段话整块返回）。
   * 其余形状按空判据处理——空判据是降级条件，不能悄悄补成「看起来没问题」。
   */
  const criteriaOf = (value) => {
    if (typeof value === 'string') {
      return value.split(/\r?\n/u).map(str).filter(Boolean);
    }
    // 判据允许写成纯文本，也允许写成 { text } / { reason }：评估器输出不是我们能完全约束的。
    return list(value)
      .map((item) => (isObject(item) ? str(item.text ?? item.reason ?? item.title) : str(item)))
      .filter(Boolean);
  };

  /** 路径允许写成纯文本，也允许写成 { path } / { fullPath }；完整路径一个字都不截。 */
  const pathOf = (value) => (isObject(value)
    ? str(value.path ?? value.fullPath ?? value.value)
    : str(value));

  // ── 脱敏：确认卡不显示密钥或任何凭据 ──────────────────────────────
  //
  // 与 src/memory/redact.mjs 同一类规则，但这里必须是同步、可被经典脚本直接调用的，
  // 所以覆盖确认卡最可能碰到的几类：私钥 / JWT / GitHub / AWS / sk- / Slack / Bearer /
  // URL 密码 / 键值赋值 / 长 hex / 长 base64。
  // 占位符保留前缀，读的人知道「这里原本有个凭据」，而不是被悄悄抹掉。
  const SECRET_RULES = [
    {
      // 私钥块整段换掉；不保留 BEGIN/END，避免「看起来像没脱敏」。
      pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu,
      replace: () => '<redacted:private-key>'
    },
    {
      pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
      replace: () => 'eyJ…<redacted:jwt>'
    },
    {
      pattern: /\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}\b/gu,
      replace: (_match, prefix) => `${prefix}…<redacted:github-token>`
    },
    {
      pattern: /\bAKIA[0-9A-Z]{16}\b/gu,
      replace: () => 'AKIA…<redacted:aws-key>'
    },
    {
      pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/gu,
      replace: () => 'sk-…<redacted:api-key>'
    },
    {
      pattern: /\b(xox[abprs]-)[A-Za-z0-9-]{10,}\b/gu,
      replace: (_match, prefix) => `${prefix}…<redacted:slack-token>`
    },
    {
      pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu,
      replace: () => 'Bearer …<redacted:bearer-token>'
    },
    {
      // URL 里的 user:pass@：保留用户名，只换密码。
      pattern: /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/giu,
      replace: (_match, scheme, user) => `${scheme}${user}:…<redacted:url-password>@`
    },
    {
      pattern: /(\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*)(?:"[^"\r\n]{1,}"|'[^'\r\n]{1,}'|[A-Za-z0-9][A-Za-z0-9._~+/@:-]{5,})/giu,
      replace: (_match, head) => `${head}…<redacted:credential>`
    },
    {
      pattern: /\b[0-9a-fA-F]{32,}\b/gu,
      replace: () => '…<redacted:hex>'
    },
    {
      // 长 base64：40 位以上且同时含大写、小写、数字。
      pattern: /\b(?=[A-Za-z0-9+/]{40,}={0,2}\b)(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[0-9])[A-Za-z0-9+/]{40,}={0,2}\b/gu,
      replace: () => '…<redacted:base64>'
    }
  ];

  /** 一段文本过脱敏；已经存在的占位符再跑一遍也不会变形。 */
  const scrubText = (value) => {
    let text = str(value);
    for (const rule of SECRET_RULES) {
      text = text.replace(rule.pattern, (...args) => rule.replace(...args));
    }
    return text;
  };

  // ── 三轴别名：评估器可以给 key，也可以给中文；未知值一律按缺字段 ──────

  const readLevel = (value) => {
    const key = str(value).toLowerCase().replace(/\s+/gu, '');
    const aliases = {
      low: 'low',
      低: 'low',
      低风险: 'low',
      medium: 'medium',
      mid: 'medium',
      中: 'medium',
      中风险: 'medium',
      high: 'high',
      高: 'high',
      高风险: 'high'
    };
    return aliases[key] ?? null;
  };

  const readImpact = (value) => {
    const key = str(value).toLowerCase().replace(/[\s_-]/gu, '');
    const aliases = {
      machine: 'machine',
      local: 'machine',
      own: 'machine',
      本机: 'machine',
      本机级: 'machine',
      project: 'project',
      项目: 'project',
      项目级: 'project',
      crossproject: 'cross-project',
      cross: 'cross-project',
      跨项目: 'cross-project',
      跨项目级: 'cross-project'
    };
    return aliases[key] ?? null;
  };

  const readReversibility = (value) => {
    const key = str(value).toLowerCase().replace(/\s+/gu, '');
    const aliases = {
      reversible: 'reversible',
      可逆: 'reversible',
      可删: 'reversible',
      rebuild: 'rebuild',
      需重建: 'rebuild',
      可重建: 'rebuild',
      irreversible: 'irreversible',
      不可逆: 'irreversible'
    };
    return aliases[key] ?? null;
  };

  const readLeaves = (value) => {
    if (value === true || value === false) return value;
    const key = str(value).toLowerCase().replace(/\s+/gu, '');
    if (['true', 'yes', '1', '是', '离开', '离开本机'].includes(key)) return true;
    if (['false', 'no', '0', '否', '不离开', '不离开本机'].includes(key)) return false;
    return null;
  };

  /** 三轴的归一化结果；缺值保留 null，让上层能说清「缺的是哪一轴」。 */
  const axisOf = (key, value) => {
    if (key === 'impact') {
      const parsed = readImpact(value);
      return {
        key,
        label: AXIS_LABELS[key],
        value: parsed,
        valueLabel: parsed ? IMPACT_LABELS[parsed] : '未知'
      };
    }
    if (key === 'reversibility') {
      const parsed = readReversibility(value);
      return {
        key,
        label: AXIS_LABELS[key],
        value: parsed,
        valueLabel: parsed ? REVERSIBILITY_LABELS[parsed] : '未知'
      };
    }
    const parsed = readLeaves(value);
    return {
      key,
      label: AXIS_LABELS[key],
      value: parsed,
      valueLabel: parsed === null ? '未知' : LEAVES_LABELS[parsed]
    };
  };

  /** 三轴的最低等级：离开本机 / 跨项目 / 不可逆至少是高；项目/需重建至少是中。 */
  const floorLevel = (axes) => {
    const impact = axes.find((axis) => axis.key === 'impact')?.value ?? null;
    const reversibility = axes.find((axis) => axis.key === 'reversibility')?.value ?? null;
    const leaves = axes.find((axis) => axis.key === 'leavesMachine')?.value ?? null;
    if (leaves === true || impact === 'cross-project' || reversibility === 'irreversible') {
      return 'high';
    }
    if (impact === 'project' || reversibility === 'rebuild') return 'medium';
    return 'low';
  };

  /** 判据展开后的完整列表：原始判据 + 三轴 + 为什么不是别的等级 + 人工改判。 */
  const basisFor = (criteria, axes, whyNot, overrides = []) => {
    const lines = [...criteria];
    axes.forEach((axis) => lines.push(`${axis.label}：${axis.valueLabel}`));
    if (whyNot) lines.push(`为什么不是别的等级：${whyNot}`);
    overrides.forEach((record, index) => lines.push(
      `人工改判 ${index + 1}（${record.at}）：${record.levelLabel}${record.note ? ` —— ${record.note}` : ''}`
    ));
    return lines;
  };

  /**
   * 把评估器原始输出归一化为「等级 + 三轴 + 判据 + 为什么不是别的等级」。
   *
   * 降级规则（与 ADR-0012 一致）：
   * - 超时 / 没有结果 / 不是对象 → 高；
   * - 缺等级、缺任一轴、判据为空、缺「为什么不是别的等级」 → 高；
   * - 未知等级或未知轴值 → 高（不猜、不夹在中间）；
   * - 等级低于三轴允许的最低档 → 抬到最低档（例如声称低风险却「跨项目/不可逆/离开本机」）。
   *
   * @param {unknown} raw 评估器输出
   * @param {{ timeout?: boolean, reason?: string }} [options]
   * @returns {object} 规范化的风险模型（纯数据）
   */
  function normalizeRisk(raw, { timeout = false, reason = '' } = {}) {
    const degrade = (degradedReason, extra = {}) => {
      // 降级不等于把已知信息抹掉：等级按高处理，但评估器给了的轴与判据照原样留下，
      // 人才能判断「是它评错了，还是字段没给全」。
      const axes = AXIS_ORDER.map((key) => axisOf(key, isObject(raw) ? raw[key] : undefined));
      const criteria = isObject(raw) ? criteriaOf(raw.criteria) : [];
      const whyNot = (isObject(raw) ? str(raw.whyNotOthers ?? raw.whyNot) : '') || MISSING_WHY_NOT;
      return {
        level: 'high',
        levelLabel: LEVEL_LABELS.high,
        impact: axes[0].value,
        impactLabel: axes[0].valueLabel,
        reversibility: axes[1].value,
        reversibilityLabel: axes[1].valueLabel,
        leavesMachine: axes[2].value,
        leavesMachineLabel: axes[2].valueLabel,
        axes,
        criteria,
        originalCriteria: [...criteria],
        basis: basisFor(criteria, axes, whyNot),
        whyNotOthers: whyNot,
        degraded: true,
        degradedReason,
        escalated: false,
        escalationReason: '',
        status: 'degraded',
        rawLevel: isObject(raw) ? str(raw.level) : '',
        ...extra
      };
    };

    if (timeout || (isObject(raw)
      && (raw.status === 'timeout' || raw.timedOut === true || raw.timeout === true))) {
      return degrade('评估器超时或没有在时限内返回结果：一律按高风险处理。');
    }
    if (!isObject(raw)) {
      const prefix = str(reason);
      return degrade(prefix
        ? `${prefix}：评估器没有返回可用结果，一律按高风险处理。`
        : '评估器没有返回可用结果：一律按高风险处理。');
    }
    if (raw.error) {
      return degrade(`评估器返回错误（${str(raw.error)}）：一律按高风险处理。`);
    }

    const rawLevelText = str(raw.level);
    const level = readLevel(raw.level);
    const axes = AXIS_ORDER.map((key) => axisOf(key, raw[key]));
    const criteria = criteriaOf(raw.criteria);
    const whyNot = str(raw.whyNotOthers ?? raw.whyNot);

    const missing = [];
    if (!rawLevelText) missing.push('等级');
    axes.forEach((axis) => {
      if (axis.value === null) missing.push(axis.label);
    });
    if (criteria.length === 0) missing.push('判据');
    if (!whyNot) missing.push('为什么不是别的等级');

    const unknownLevel = rawLevelText && !level;
    if (unknownLevel) {
      return degrade(`未知等级「${rawLevelText}」：不猜档位，一律按高风险处理。`, {
        rawLevel: rawLevelText
      });
    }
    if (missing.length > 0) {
      const prefix = str(reason);
      const detail = `评估结果缺字段或字段不可用（${missing.join('、')}）：一律按高风险处理。`;
      return degrade(prefix ? `${prefix}；${detail}` : detail);
    }

    // 到这里等级与三轴都已合法；再做一次「与三轴是否一致」的兜底。
    const floor = floorLevel(axes);
    let finalLevel = level;
    let escalated = false;
    let escalationReason = '';
    if (LEVEL_RANK[level] < LEVEL_RANK[floor]) {
      finalLevel = floor;
      escalated = true;
      escalationReason = `评级与三轴不一致：${axes.map((axis) => `${axis.label} ${axis.valueLabel}`).join(' / ')}，`
        + `至少是${LEVEL_LABELS[floor]}；按更高的一档处理。`;
    }

    const basis = basisFor(criteria, axes, whyNot);
    return {
      level: finalLevel,
      levelLabel: LEVEL_LABELS[finalLevel],
      impact: axes[0].value,
      impactLabel: axes[0].valueLabel,
      reversibility: axes[1].value,
      reversibilityLabel: axes[1].valueLabel,
      leavesMachine: axes[2].value,
      leavesMachineLabel: axes[2].valueLabel,
      axes,
      criteria,
      originalCriteria: [...criteria],
      basis,
      whyNotOthers: whyNot,
      degraded: false,
      degradedReason: '',
      escalated,
      escalationReason,
      status: escalated ? 'escalated' : 'ok',
      rawLevel: rawLevelText
    };
  }

  // ── 动作与卡片模型 ────────────────────────────────────────────────

  /** 四个动作始终都在；「低风险免问」只对低风险可点，其余显示为禁用。 */
  const actionsFor = (level) => ACTIONS.map((action) => {
    if (action.id !== 'defer-low') return { ...action, enabled: true, reason: '' };
    const enabled = level === 'low';
    return {
      ...action,
      enabled,
      reason: enabled ? '' : '只对低风险生效；本次不是低风险，免问不会放开这一档。'
    };
  });

  const defaultConclusion = (risk) => {
    const leaves = risk.leavesMachine === true ? '，且会离开本机' : '';
    return `影响面为${risk.impactLabel}、可逆性为${risk.reversibilityLabel}${leaves}；`
      + `因此按${risk.levelLabel}处理。`;
  };

  /** 从卡片数据里取某一轴：兼容 {axes:[...]} 与扁平字段两种旧形状。 */
  const cardAxis = (data, key) => {
    const source = list(data.axes).find((item) => str(item?.key) === key);
    const fallback = isObject(data.axes) ? data.axes[key] : data[key];
    const raw = source ?? fallback;
    const value = isObject(raw) ? (raw.value ?? raw.key ?? raw.label) : raw;
    return axisOf(key, value);
  };

  /**
   * 卡片字段的结构归一化：存储里读回来的确认卡也要能安全渲染。
   * 这里不重新推断等级（人工改判过的卡片不能被三轴又抬回去），只校验结构与脱敏；
   * 缺等级 / 缺轴 / 空判据仍然降为高——存储坏了也不能显示成低风险。
   *
   * @param {object} data 卡片块（type=risk）
   * @returns {object} 可直接渲染的卡片模型
   */
  function normalizeCardBlock(data = {}) {
    const source = isObject(data) ? data : {};
    const level = readLevel(source.level);
    const axes = AXIS_ORDER.map((key) => cardAxis(source, key));
    const criteria = criteriaOf(source.criteria).map(scrubText);
    const rawWhyNot = scrubText(source.whyNotOthers ?? source.whyNot);
    const overrides = list(source.overrides).map((record) => {
      const recordLevel = readLevel(record?.level) ?? 'high';
      return {
        at: scrubText(record?.at),
        level: recordLevel,
        levelLabel: LEVEL_LABELS[recordLevel],
        note: scrubText(record?.note),
        kind: 'human'
      };
    });

    const missing = [];
    if (!level) missing.push('等级');
    axes.forEach((axis) => {
      if (axis.value === null) missing.push(axis.label);
    });
    if (criteria.length === 0) missing.push('判据');
    if (!rawWhyNot) missing.push('为什么不是别的等级');

    const forced = missing.length > 0;
    const overridden = source.overridden === true || overrides.length > 0;
    // 降级过的卡片若没有人工改判兜底，等级只能是高：存储里写了低也不认。
    const degradedWithoutOverride = source.degraded === true && !overridden && !forced;
    const whyNot = rawWhyNot || (forced ? MISSING_WHY_NOT : '');
    const finalLevel = forced || (degradedWithoutOverride && level !== 'high') ? 'high' : level;
    const degraded = source.degraded === true || forced;
    const missingReason = forced
      ? `卡片数据缺字段或字段不可用（${missing.join('、')}）：一律按高风险处理。`
      : (degradedWithoutOverride && level !== 'high'
        ? '这张卡的原评估已降级：没有人工改判时一律按高风险处理。'
        : '');
    const degradedReason = [scrubText(source.degradedReason), missingReason]
      .filter(Boolean)
      .join('；');

    const basisSource = list(source.basis).map(scrubText).filter(Boolean);
    // 判据展开至少四条（原始判据 + 三轴 + 为什么不是别的等级）；存储里不足就重算。
    const basis = basisSource.length >= 4
      ? basisSource
      : basisFor(criteria, axes, whyNot, overrides);
    // 存储里已有的 basis 可能是在人工改判之前生成的：把改判记录补进去，保证并列可见。
    if (overrides.length > 0) {
      const suffix = overrides.map((record, index) => (
        `人工改判 ${index + 1}（${record.at}）：${record.levelLabel}${record.note ? ` —— ${record.note}` : ''}`
      ));
      suffix.forEach((line) => {
        if (!basis.some((item) => item === line)) basis.push(line);
      });
    }

    return {
      type: 'risk',
      id: scrubText(source.id) || 'risk',
      title: scrubText(source.title) || '写入确认',
      level: finalLevel,
      levelLabel: LEVEL_LABELS[finalLevel],
      conclusion: scrubText(source.conclusion) || defaultConclusion({
        impactLabel: axes[0].valueLabel,
        reversibilityLabel: axes[1].valueLabel,
        leavesMachine: axes[2].value,
        levelLabel: LEVEL_LABELS[finalLevel]
      }),
      degraded,
      degradedReason,
      escalated: source.escalated === true,
      escalationReason: scrubText(source.escalationReason),
      destination: scrubText(source.destination),
      axes,
      paths: list(source.paths).map(pathOf).map(scrubText).filter(Boolean),
      criteria,
      basis,
      whyNotOthers: whyNot,
      originalCriteria: (list(source.originalCriteria).length > 0
        ? list(source.originalCriteria).map(scrubText).filter(Boolean)
        : [...criteria]),
      overrides,
      overridden: source.overridden === true || overrides.length > 0,
      originalLevel: readLevel(source.originalLevel) ?? finalLevel,
      originalLevelLabel: LEVEL_LABELS[readLevel(source.originalLevel) ?? finalLevel],
      actions: actionsFor(finalLevel)
    };
  }

  /**
   * 从归一化风险造一张确认卡。
   *
   * @param {object} risk normalizeRisk 的输出（也接受原始评估器输出，便于测试）
   * @param {object} details 标题、结论、逐条完整路径、目的地、稳定 id
   * @returns {object} type=risk 的块模型
   */
  function riskCardModelOf(risk, {
    id = 'risk',
    title = '写入确认',
    conclusion = '',
    paths = [],
    destination = '',
    overrides = []
  } = {}) {
    const model = isObject(risk) && Array.isArray(risk.axes) ? risk : normalizeRisk(risk);
    const cleanPaths = list(paths).map(pathOf).map(scrubText).filter(Boolean);
    const cleanOverrides = list(overrides).map((record) => {
      const recordLevel = readLevel(record?.level) ?? 'high';
      return {
        at: scrubText(record?.at),
        level: recordLevel,
        levelLabel: LEVEL_LABELS[recordLevel],
        note: scrubText(record?.note),
        kind: 'human'
      };
    });
    return {
      type: 'risk',
      id: scrubText(id) || 'risk',
      title: scrubText(title) || '写入确认',
      level: model.level,
      levelLabel: model.levelLabel,
      conclusion: scrubText(conclusion) || defaultConclusion(model),
      degraded: model.degraded === true,
      degradedReason: scrubText(model.degradedReason),
      escalated: model.escalated === true,
      escalationReason: scrubText(model.escalationReason),
      destination: scrubText(destination),
      axes: list(model.axes).map((axis) => ({ ...axis })),
      paths: cleanPaths,
      criteria: list(model.criteria).map(scrubText),
      basis: basisFor(list(model.criteria), list(model.axes), model.whyNotOthers, cleanOverrides)
        .map(scrubText),
      whyNotOthers: scrubText(model.whyNotOthers),
      originalCriteria: list(model.criteria).map(scrubText),
      overrides: cleanOverrides,
      overridden: cleanOverrides.length > 0,
      originalLevel: model.level,
      originalLevelLabel: model.levelLabel,
      actions: actionsFor(model.level)
    };
  }

  /**
   * 「我的判断不同」：不覆盖原判据，并列追加一条人工记录，并生成一张新卡。
   * 新卡沿用原来的三轴与判据，只把等级换成人工判断，id 换新。
   *
   * @param {object} card 原确认卡
   * @param {{ level?: string, note?: string, at?: string }} [input]
   * @returns {object} 新确认卡
   */
  function applyRiskOverride(card, { level, note = '', at = '' } = {}) {
    const current = normalizeCardBlock(card);
    // 默认往「更宽」的方向退一档：从高改到低是常见的「我看过了」，从低改到中是更谨慎。
    const chosen = readLevel(level) ?? (current.level === 'low' ? 'medium' : 'low');
    const cleanNote = scrubText(note);
    const record = {
      at: str(at) || new Date().toISOString(),
      level: chosen,
      levelLabel: LEVEL_LABELS[chosen],
      note: cleanNote,
      kind: 'human'
    };
    const overrides = [...current.overrides, record];
    // criteria 保持原样；basis 里并列追加人工改判，读的人能同时看到两条依据。
    const basis = basisFor(current.criteria, current.axes, current.whyNotOthers, overrides)
      .map(scrubText);
    return {
      ...current,
      id: `${current.id || 'risk'}-human-${overrides.length}`,
      level: chosen,
      levelLabel: LEVEL_LABELS[chosen],
      conclusion: `人工改判为${LEVEL_LABELS[chosen]}`
        + (cleanNote ? `：${cleanNote}` : '：原判据保留，仅并列追加人工记录。'),
      overridden: true,
      originalLevel: current.originalLevel || current.level,
      originalLevelLabel: LEVEL_LABELS[current.originalLevel || current.level],
      overrides,
      criteria: [...current.criteria],
      basis,
      actions: actionsFor(chosen)
    };
  }

  /**
   * 四个动作的唯一落点：返回要追加进会话的两条消息（我的 + 回复），以及卡片上的回答标记。
   * 不改原帧；新卡由 override 分支附在回复的 blocks 里。
   *
   * @returns {{kind:string, answeredLabel:string, userText:string, reply:object, card?:object}|null}
   */
  function riskAction({ card, action, level, note = '', at = '' } = {}) {
    const current = normalizeCardBlock(card);
    const kind = str(action);
    if (kind === 'allow-once') {
      return {
        kind,
        answeredLabel: '允许这一次',
        userText: '允许这一次',
        reply: {
          text: '已记录「允许这一次」。本轮不执行真实写入；#114–#116 接上后才会按这张卡落盘。'
        }
      };
    }
    if (kind === 'defer-low') {
      // 免问只管低风险。按钮在渲染层已经禁用，这里再守一次，防止旧节点被点到。
      if (current.level !== 'low') return null;
      return {
        kind,
        answeredLabel: '低风险免问',
        userText: '低风险以后不用再问',
        reply: {
          text: '已记录：低风险以后不用再问。这个豁免只作用于低风险，不会放开中/高风险、删除或外发。'
        }
      };
    }
    if (kind === 'override') {
      const next = applyRiskOverride(current, { level, note, at });
      const cleanNote = scrubText(note);
      return {
        kind,
        answeredLabel: `我的判断不同：${next.levelLabel}`,
        userText: `我的判断不同：改为${next.levelLabel}${cleanNote ? ` —— ${cleanNote}` : ''}`,
        reply: {
          text: '已记下你的改判，并生成一张新卡。原判据保留，人工记录并列追加；改判只影响这一张卡。',
          blocks: [next]
        },
        card: next
      };
    }
    if (kind === 'cancel') {
      return {
        kind,
        answeredLabel: '取消',
        userText: '取消',
        reply: { text: '已取消：什么都没写。后台不会偷偷补做这次写入。' }
      };
    }
    return null;
  }

  // ── 评估器注入与脚本化占位 ────────────────────────────────────────

  const TIMEOUT = Symbol('risk-timeout');

  /**
   * 用注入的评估器评一次风险。
   * 评估器是 `(input) => raw | Promise<raw>`；本轮真实实现是规则化占位，
   * 以后接真模型时只换这个参数，归一化与卡片都不用改。
   *
   * @param {{ evaluator?: Function, input?: object, timeoutMs?: number }} [options]
   * @returns {Promise<object>} normalizeRisk 的输出
   */
  async function assessRisk({ evaluator = ruleRiskEvaluator, input = {}, timeoutMs = 8000 } = {}) {
    if (typeof evaluator !== 'function') {
      return normalizeRisk(null, { reason: '没有注入可用的评估器' });
    }
    let timer = null;
    try {
      const pending = Promise.resolve(evaluator(input));
      // timeoutMs <= 0 视为立即超时，测试不用真的等。
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), Math.max(0, Number(timeoutMs) || 0));
      });
      const raw = await Promise.race([pending, timeout]);
      if (raw === TIMEOUT) return normalizeRisk(null, { timeout: true });
      return normalizeRisk(raw);
    } catch (error) {
      return normalizeRisk(null, {
        reason: `评估器失败（${error?.message ?? error}）`
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 规则化占位评估器：按「目的地 + 是否删除」给三轴，不调模型。
   * 它只是把接入点占住；判据写得像人话，是为了让卡片能独立看懂。
   */
  function ruleRiskEvaluator(input = {}) {
    const destination = str(input.destination);
    const deletes = Boolean(input.deletes);
    const external = destination === 'external';
    const level = external || deletes ? 'high' : destination === 'project' ? 'medium' : 'low';
    const impact = external ? 'cross-project' : destination === 'project' ? 'project' : 'machine';
    const reversibility = external || deletes
      ? 'irreversible'
      : destination === 'project' ? 'rebuild' : 'reversible';

    const criteria = [];
    if (destination === 'own') {
      criteria.push('目的地是自有目录：只写本机的库，不碰被观察的项目仓库。');
      criteria.push('写入内容可以由已有快照与索引重建。');
    } else if (destination === 'project') {
      criteria.push('目的地是被观察的项目目录：会出现在别人的仓库里。');
      criteria.push(deletes
        ? '本次包含删除：删掉的内容没有回收站。'
        : '新增文件可以靠回退提交撤掉，但需要重建。');
    } else {
      criteria.push('目的地在本机之外：发出后收不回来。');
      criteria.push('对方是否留存、转发不受本机控制。');
    }
    criteria.push(deletes ? '本次动作包含删除，删除永远逐次确认。' : '本次动作不包含删除。');

    const whyNotOthers = level === 'high'
      ? '因为它涉及删除或离开本机（不可逆）；中风险只覆盖本机或项目内可重建的写入。'
      : level === 'medium'
        ? '因为它会写进项目目录、需要重建才能撤掉；低风险只给自有目录里可逆的写入。'
        : '因为只写自有目录且可逆，够不上中风险的项目影响，更够不上高风险的不可逆。';

    return {
      level,
      impact,
      reversibility,
      leavesMachine: external,
      criteria,
      whyNotOthers
    };
  }

  /** 解析 /risk 命令；不是这条命令返回 null，参数不认识也返回 null。 */
  const parseRiskCommand = (input) => {
    const text = str(input);
    if (text !== RISK_COMMAND && !text.startsWith(`${RISK_COMMAND} `)) return null;
    const kind = str(text.slice(RISK_COMMAND.length)) || 'high';
    return COMMAND_KINDS.has(kind) ? { kind } : null;
  };

  const isRiskCommand = (input) => parseRiskCommand(input) !== null;

  const SAMPLE_INPUTS = Object.freeze({
    high: {
      destination: 'project',
      deletes: true,
      paths: [
        'D:\\work\\integration\\docs\\adr\\0014-export-policy.md',
        'D:\\work\\integration\\docs\\adr\\0013-write-by-destination.md'
      ]
    },
    medium: {
      destination: 'project',
      deletes: false,
      paths: ['D:\\work\\integration\\docs\\adr\\0014-export-policy.md']
    },
    low: {
      destination: 'own',
      deletes: false,
      paths: [
        'C:\\Users\\Owner\\.owner-agent\\knowledge\\snapshots\\2026-11-26T09-30-00.json',
        'C:\\Users\\Owner\\.owner-agent\\knowledge\\exports\\snapshot-index.md'
      ]
    }
  });

  const sampleTitle = (kind) => ({
    high: '删除项目目录里的两份旧 ADR',
    medium: '把一份 ADR 写进项目目录',
    low: '写入自有目录的知识快照'
  })[kind] ?? '写入确认';

  const sampleConclusion = (kind) => ({
    high: '这会删除项目目录里的两份旧 ADR：影响项目、删除后不可逆，但不离开本机。',
    medium: '会在项目目录新增一份 ADR：影响项目、可重建，但不离开本机。',
    low: '只写本机自有目录里的快照：影响只在本机、可删、不离开本机。'
  })[kind] ?? '';

  /**
   * /risk high|medium|low 的脚本化样本：走注入的评估器，不执行真实写入。
   * 卡片刻意用真实的完整路径，验收才能断言「逐条、不合并、不省略」。
   */
  async function buildRiskReply(command, { evaluator = ruleRiskEvaluator, now = '' } = {}) {
    const parsed = parseRiskCommand(command);
    if (!parsed) return null;
    const input = SAMPLE_INPUTS[parsed.kind];
    const risk = await assessRisk({ evaluator, input });
    const card = riskCardModelOf(risk, {
      id: `risk-${parsed.kind}`,
      title: sampleTitle(parsed.kind),
      conclusion: sampleConclusion(parsed.kind),
      paths: input.paths,
      destination: input.destination,
      overrides: []
    });
    // now 只给测试固定时间用；样本本身不显示时间，避免逐次不同。
    void now;
    return {
      text: '这是一张脚本化确认卡：评级由注入的评估器给出（本轮是规则化占位），'
        + '不会执行真实写入。点「我的判断不同」可以改判并生成一张新卡。',
      blocks: [card]
    };
  }

  return {
    LEVELS,
    LEVEL_LABELS,
    ACTIONS,
    RISK_COMMAND,
    normalizeRisk,
    normalizeCardBlock,
    riskCardModelOf,
    applyRiskOverride,
    riskAction,
    assessRisk,
    ruleRiskEvaluator,
    isRiskCommand,
    parseRiskCommand,
    buildRiskReply,
    scrubText
  };
});
