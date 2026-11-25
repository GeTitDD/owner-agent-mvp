// #109 生成式 UI 块的模型层：块数据进、规范化后的渲染模型出。
//
// 为什么单独一个文件：回复由「文字 + 块序列」组成，而「字段缺了怎么办、
// 类型不认识怎么办、图表数据点怎么变成坐标」这些规则必须能脱离 Electron
// 用 node --test 直接断言。DOM 只认这份模型，不自己再判定一遍。
// 双份导出：浏览器当普通脚本加载（挂到 window.OwnerShellBlocks），Node 测试用 require 读。
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerShellBlocks = api;
})(typeof globalThis === 'undefined' ? null : globalThis, () => {
  // 十二种块。#109 的清单，也是样本回复里的顺序，e2e 按这个顺序断言。
  const BLOCK_TYPES = [
    'card', 'table', 'kpi', 'line', 'donut', 'timeline',
    'kv', 'code', 'diff', 'tool', 'badges', 'ask'
  ];

  // 提问块最多给四个选项：再多就不是「问一句」而是表单了。
  const ASK_OPTION_LIMIT = 4;

  // 块全览的临时入口。真模型接入时连同 sampleReply 一起删掉（与占位回复同一批）。
  const SAMPLE_COMMAND = '/blocks';

  // 颜色只有这几种语义，其余一律按普通标签处理：不认识的 tone 不能变成无效 class。
  const TONES = new Set(['ok', 'warn', 'error', 'pending']);
  const DIFF_KINDS = new Set(['add', 'del', 'ctx']);

  const isObject = (value) =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

  /** 文本字段的统一口径：undefined / null 变空串，其余转字符串并去掉首尾空白。 */
  const str = (value) => (value === undefined || value === null ? '' : String(value).trim());

  /** 数字字段：转不成有限数就返回 null，让调用方决定是「没有」还是「按 0 算」。 */
  const num = (value) => {
    // null / undefined / 空串不是 0：null 会变成 0，正是这里最容易出错的地方。
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const list = (value) => (Array.isArray(value) ? value : []);

  const tone = (value) => {
    const normalized = str(value).toLowerCase();
    return TONES.has(normalized) ? normalized : '';
  };

  /** 无法归类的块也要有可读的落点：先找最能说明内容的字段，再退到 JSON。 */
  const describe = (value) => {
    if (value === null) return 'null';
    if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 120)}…` : value;
    try {
      const json = JSON.stringify(value);
      if (json === undefined) return String(value);
      return json.length > 120 ? `${json.slice(0, 120)}…` : json;
    } catch {
      return String(value);
    }
  };

  const describeBlock = (block) => {
    const hint = ['title', 'text', 'summary', 'label']
      .map((key) => str(block[key]))
      .find(Boolean);
    return hint ? `：${hint}` : `：${describe(block)}`;
  };

  const normalizeTag = (value) =>
    isObject(value)
      ? { text: str(value.text), tone: tone(value.tone) }
      : { text: str(value), tone: '' };

  /** 卡片：一个标题 + 若干分组；分组没有条目时用分组自己的空态文案。 */
  const normalizeCard = (data) => ({
    type: 'card',
    title: str(data.title),
    badge: str(data.badge),
    sub: str(data.sub),
    sections: list(data.sections).map((section) => {
      const entry = isObject(section) ? section : { items: section };
      return {
        label: str(entry.label),
        count: str(entry.count),
        empty: str(entry.empty),
        items: list(entry.items).map((item) => {
          const row = isObject(item) ? item : { title: item };
          return { title: str(row.title), tags: list(row.tags).map(normalizeTag) };
        })
      };
    }),
    // 只留说明文字：#109 的块内按钮只有提问块一处，卡片的动作留给后续票。
    foot: isObject(data.foot) ? { note: str(data.foot.note) } : null
  });

  const normalizeTable = (data) => {
    const head = list(data.head).map(str);
    const rows = list(data.rows).map((row) => list(row).map((cell) =>
      isObject(cell) ? str(cell.text) : str(cell)));
    // 短行补空单元格，表格才不会缺格；多出来的单元格原样保留，宁可错位也不丢数据。
    if (head.length > 0) {
      rows.forEach((row) => {
        while (row.length < head.length) row.push('');
      });
    }
    return { type: 'table', title: str(data.title), head, rows };
  };

  const normalizeKpi = (data) => ({
    type: 'kpi',
    title: str(data.title),
    items: list(data.items).map((item) => {
      const entry = isObject(item) ? item : { value: item };
      const delta = num(entry.delta);
      return {
        label: str(entry.label),
        value: str(entry.value),
        unit: str(entry.unit),
        delta,
        deltaText: str(entry.deltaText) || (delta === null ? '' : `${delta > 0 ? '+' : ''}${delta}`),
        direction: delta === null ? 'flat' : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'
      };
    })
  });

  const normalizeLine = (data) => ({
    type: 'line',
    title: str(data.title),
    points: list(data.points).map(num).filter((value) => value !== null),
    labels: list(data.labels).map(str),
    unit: str(data.unit)
  });

  /**
   * 折线的几何：把数据点映射到 0..100 × 0..34 的 viewBox。
   * 全平时给一条水平中线（span 兜底 1），不除零；不足两点由渲染层降级成文字。
   */
  const lineGeometry = (points) => {
    const values = list(points).map(num).filter((value) => value !== null);
    if (values.length < 2) {
      return {
        ok: false,
        reason: '至少要有两个数据点才画得出折线',
        values,
        coords: [],
        min: values.length ? values[0] : null,
        max: values.length ? values[0] : null,
        last: values.length ? values[values.length - 1] : null
      };
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(max - min, 1);
    const stepX = 100 / (values.length - 1);
    const coords = values.map((value, index) => ({
      x: Number((index * stepX).toFixed(2)),
      y: Number((30 - ((value - min) / span) * 26 - 2).toFixed(2))
    }));
    return { ok: true, values, coords, min, max, last: values[values.length - 1] };
  };

  const normalizeDonut = (data) => ({
    type: 'donut',
    title: str(data.title),
    items: list(data.items).map((item) => {
      const entry = isObject(item) ? item : { value: item };
      return { label: str(entry.label), value: Math.max(num(entry.value) ?? 0, 0) };
    })
  });

  /**
   * 环形的几何：每段算出占圆周的百分比与偏移。
   * 总量为 0 时没有可画的弧，交给渲染层降级成文字（数据本身不丢）。
   */
  const donutGeometry = (items) => {
    const entries = list(items).map((item) => ({
      label: str(item?.label),
      value: Math.max(num(item?.value) ?? 0, 0)
    }));
    const total = entries.reduce((sum, entry) => sum + entry.value, 0);
    if (total <= 0) {
      return { ok: false, reason: '所有分项都是 0，画不出环形', items: entries, total: 0, arcs: [] };
    }
    let offset = 0;
    const arcs = entries.map((entry, index) => {
      const percent = (entry.value / total) * 100;
      const arc = {
        label: entry.label,
        value: entry.value,
        percent: Number(percent.toFixed(1)),
        tone: index % 4,
        dasharray: `${percent.toFixed(2)} ${(100 - percent).toFixed(2)}`,
        dashoffset: (-offset).toFixed(2)
      };
      offset += percent;
      return arc;
    });
    return { ok: true, items: entries, total, arcs };
  };

  const normalizeTimeline = (data) => ({
    type: 'timeline',
    title: str(data.title),
    steps: list(data.steps).map((step) => {
      const entry = isObject(step) ? step : { title: step };
      return { title: str(entry.title), meta: str(entry.meta), at: str(entry.at), tone: tone(entry.tone) };
    })
  });

  const normalizeKv = (data) => ({
    type: 'kv',
    title: str(data.title),
    // 两种写法都收：[键, 值] 与 { key, value }。
    rows: list(data.rows).map((row) => (Array.isArray(row)
      ? { key: str(row[0]), value: str(row[1]) }
      : { key: str(row?.key), value: str(row?.value) }))
  });

  const normalizeCode = (data) => {
    const code = String(data.code ?? '')
      .replace(/\r\n?/gu, '\n')
      .replace(/\n+$/u, '');
    return {
      type: 'code',
      title: str(data.title),
      lang: str(data.lang),
      lines: code ? code.split('\n') : []
    };
  };

  const normalizeDiff = (data) => ({
    type: 'diff',
    title: str(data.title),
    rows: list(data.rows).map((row) => {
      const entry = isObject(row) ? row : { text: row };
      const kind = str(entry.kind).toLowerCase();
      return { kind: DIFF_KINDS.has(kind) ? kind : 'ctx', text: str(entry.text) };
    })
  });

  const normalizeTool = (data) => ({
    type: 'tool',
    name: str(data.name) || '未命名工具',
    arg: str(data.arg),
    output: str(data.output),
    status: str(data.status)
  });

  const normalizeBadges = (data) => ({
    type: 'badges',
    title: str(data.title),
    items: list(data.items).map(normalizeTag)
  });

  const normalizeAsk = (data) => {
    const free = isObject(data.free) ? data.free : {};
    const skip = isObject(data.skip) ? data.skip : {};
    return {
      type: 'ask',
      // 问题缺了就补一句占位：提问块没有问题时仍然要能看懂、能点。
      question: str(data.question) || '需要你确认一下',
      why: str(data.why),
      tried: list(data.tried).map(str).filter(Boolean),
      options: list(data.options).map(str).filter(Boolean).slice(0, ASK_OPTION_LIMIT),
      free: {
        label: str(free.label) || '自由回答',
        placeholder: str(free.placeholder) || '直接写你的答案'
      },
      skip: {
        label: str(skip.label) || '跳过，按你的判断来',
        note: str(skip.note) || '跳过之后，结论会标成「推断」，不算已验证。'
      }
    };
  };

  const NORMALIZERS = {
    card: normalizeCard,
    table: normalizeTable,
    kpi: normalizeKpi,
    line: normalizeLine,
    donut: normalizeDonut,
    timeline: normalizeTimeline,
    kv: normalizeKv,
    code: normalizeCode,
    diff: normalizeDiff,
    tool: normalizeTool,
    badges: normalizeBadges,
    ask: normalizeAsk
  };

  /**
   * 单个块的归一化。未知类型降级成一段纯文本，而不是整条消失：
   * 原类型名与最能说明内容的字段都要留在文字里，读的人才知道少了什么。
   */
  const normalizeBlock = (block, index = 0) => {
    if (!isObject(block)) {
      return {
        type: 'unknown',
        index,
        sourceType: '',
        text: `无法识别的块（第 ${index + 1} 个）：不是对象（${describe(block)}）`
      };
    }
    const type = str(block.type).toLowerCase();
    const normalizer = NORMALIZERS[type];
    if (!normalizer) {
      return {
        type: 'unknown',
        index,
        sourceType: type,
        text: `未知块（类型：${type || '缺失'}）${describeBlock(block)}`
      };
    }
    return { ...normalizer(block), index };
  };

  /**
   * 回复归一化：`{ text?, blocks? }`，只有文字、只有块、两者都有都合法。
   * 也接受一段裸字符串（当成只有文字的回复），其余形状按空回复处理。
   * `answers` 是「这个回复里第几个提问块已经被回答」，重新渲染时据此收起按钮。
   */
  const normalizeReply = (reply) => {
    if (typeof reply === 'string') return { text: reply.trim(), blocks: [] };
    if (!isObject(reply)) return { text: '', blocks: [] };
    const answers = isObject(reply.answers) ? reply.answers : {};
    const blocks = list(reply.blocks).map((block, index) => {
      const model = normalizeBlock(block, index);
      const answer = answers[index];
      if (model.type === 'ask' && answer !== undefined) model.answered = str(answer);
      return model;
    });
    return { text: str(reply.text), blocks };
  };

  /**
   * 提问块的点选结果 → 下一轮要追加的两条消息。
   * 本轮是脚本化响应：只回一句「收到」，不执行任何动作；
   * 返回 null 表示这次点击不该产生消息（例如自由回答是空的）。
   */
  const askAction = (input) => {
    const question = str(input?.question);
    const kind = str(input?.kind);
    if (kind === 'skip') {
      return {
        kind,
        answeredLabel: '跳过',
        userText: '跳过，按你的判断来',
        reply: {
          text: `已跳过${question ? `「${question}」` : ''}。按推断继续，结论会标成「推断」，不算已验证。`
        }
      };
    }
    if (kind === 'free') {
      const answer = str(input?.value);
      if (!answer) return null;
      return {
        kind,
        answeredLabel: answer,
        userText: answer,
        reply: { text: `收到你的补充：「${answer}」。这是脚本化响应：真模型接入前，回答只会回这一句。` }
      };
    }
    if (kind === 'option') {
      const choice = str(input?.value);
      if (!choice) return null;
      return {
        kind,
        answeredLabel: choice,
        userText: `选择：${choice}`,
        reply: { text: `好，按「${choice}」继续。这是脚本化响应：真模型接入前，选择只会回这一句，不会执行别的动作。` }
      };
    }
    return null;
  };

  /** 块全览的临时入口：输入 /blocks 时替代占位回复，用来看十二种块长什么样。 */
  const isSampleCommand = (input) => str(input) === SAMPLE_COMMAND;

  /** 十二种块各一条的脚本化样本。数据写死，不连模型、不发请求。 */
  const sampleReply = () => ({
    text: '这是块全览的脚本化样本：十二种块各一条，数据写死，不连模型。',
    blocks: [
      {
        type: 'card',
        title: '项目库概览',
        badge: '3',
        sub: '每个分组只留一行摘要；空的那组不占位。',
        sections: [
          {
            label: '已验证',
            count: '1 条',
            items: [{
              title: 'Retry loop 的等待上限改成显式配置',
              tags: [{ text: '已验证', tone: 'ok' }, { text: 'Companion Demo' }]
            }]
          },
          {
            label: '观察中',
            count: '1 条',
            items: [{
              title: '块渲染要能长进对话流，不另建一条管线',
              tags: [{ text: '待验证', tone: 'warn' }, { text: '卡片' }]
            }]
          },
          { label: '待整理', count: '0 条', items: [], empty: '这一组还没有条目。' }
        ],
        foot: { note: '样本数据：水位不会推进，也不会写进任何项目。' }
      },
      {
        type: 'table',
        title: '最近三条提交',
        head: ['提交', '说明', '时间'],
        rows: [
          ['7ccbe10', 'Merge branch feat/card-shell', '11:42'],
          ['abc70c6', 'test(shell): e2e 成功时清掉临时目录', '11:08'],
          ['d87b0ec', 'docs(glossary): 对齐写入口径', '10:55']
        ]
      },
      {
        type: 'kpi',
        title: '本周活动',
        items: [
          { label: '提交', value: 12, delta: 3, unit: '次' },
          { label: '会话', value: 5, delta: -1, unit: '轮' },
          { label: '知识条目', value: 8, delta: 2, unit: '条' },
          { label: '阻塞', value: 1, delta: 0, unit: '项' }
        ]
      },
      {
        type: 'line',
        title: '近 7 次构建耗时',
        points: [42, 39, 44, 41, 37, 35, 33],
        unit: 's',
        labels: ['第 1 次', '第 7 次']
      },
      {
        type: 'donut',
        title: '知识来源',
        items: [
          { label: '域包', value: 6 },
          { label: '项目经验', value: 4 },
          { label: '外部会话', value: 2 }
        ]
      },
      {
        type: 'timeline',
        title: '发布快照',
        steps: [
          { title: '拍快照', meta: '把当前库压成一份只读快照', at: '14:02', tone: 'ok' },
          { title: '校验', meta: '条目数与引用都核对过', at: '14:03', tone: 'ok' },
          { title: '导出 Markdown', meta: '等复制与导出（#110）接上', at: '—', tone: 'pending' }
        ]
      },
      {
        type: 'kv',
        title: '当前环境',
        rows: [
          ['项目', 'Companion Demo'],
          ['写范围', '只读：不写项目目录'],
          ['模型', '未接入'],
          ['库', '临时库 · 校验用']
        ]
      },
      {
        type: 'code',
        title: '块渲染的入口',
        lang: 'js',
        code: [
          'const reply = { text, blocks };',
          'const model = normalizeReply(reply);',
          'for (const block of model.blocks) {',
          '  thread.append(renderBlock(block));',
          '}'
        ].join('\n')
      },
      {
        type: 'diff',
        title: 'diff · shell.js',
        rows: [
          { kind: 'ctx', text: 'function renderMessage(message) {' },
          { kind: 'del', text: '  item.append(who, el("p", "bubble", message.text));' },
          { kind: 'add', text: '  item.append(who);' },
          { kind: 'add', text: '  if (message.text) item.append(el("p", "bubble", message.text));' },
          { kind: 'add', text: '  item.append(blocks.renderReply(message));' },
          { kind: 'ctx', text: '}' }
        ]
      },
      {
        type: 'tool',
        name: 'knowledge.search',
        arg: '"retry 上限"',
        output: '2 条命中：\n· Retry loop bound（已验证）\n· 等待上限要能被配置（观察中）'
      },
      {
        type: 'badges',
        title: '十二种块的状态',
        items: [
          { text: '卡片', tone: 'ok' },
          { text: '表格', tone: 'ok' },
          { text: '指标卡', tone: 'ok' },
          { text: '折线', tone: 'ok' },
          { text: '环形', tone: 'ok' },
          { text: '时间线', tone: 'ok' },
          { text: '键值', tone: 'ok' },
          { text: '代码', tone: 'ok' },
          { text: 'diff', tone: 'ok' },
          { text: '工具调用', tone: 'ok' },
          { text: '状态徽章墙', tone: 'ok' },
          { text: '提问', tone: 'warn' }
        ]
      },
      {
        type: 'ask',
        question: '这条经验要归到哪个项目？',
        why: '它同时符合两个项目的描述，写错了会把结论放到错的地方。',
        tried: ['按提交信息匹配到 Companion Demo', '按会话来源匹配到 cultivation-agent'],
        options: ['Companion Demo', 'cultivation-agent', '先不归属'],
        free: { label: '自由回答', placeholder: '也可以直接写别的项目名' },
        skip: { label: '跳过，按你的判断来', note: '跳过之后，结论会标成「推断」，不算已验证。' }
      }
    ]
  });

  return {
    BLOCK_TYPES,
    ASK_OPTION_LIMIT,
    SAMPLE_COMMAND,
    normalizeReply,
    normalizeBlock,
    lineGeometry,
    donutGeometry,
    askAction,
    isSampleCommand,
    sampleReply
  };
});
