// #110 复制与导出：把「屏幕上已经渲染的那份结构」写成 Markdown。
//
// 为什么不另写一份生成器：DOM 与 Markdown 都从 shell-blocks 归一化后的模型出发。
// 这个文件只吃 normalizeReply / normalizeBlock 的产物（也就是 shell-blocks-view.js
// 用来画 DOM 的同一份模型），不再重新解释原始块字段，避免两边口径悄悄分叉。
// 双份导出：浏览器当普通脚本加载（挂到 window.OwnerShellCopy），Node 测试用 require 读。
(function attach(root, factory) {
  const blocks = typeof module === 'object' && module.exports
    ? require('./shell-blocks.cjs')
    : (root ? root.OwnerShellBlocks : null);
  if (!blocks) throw new Error('shell-blocks.cjs 未加载');
  const api = factory(blocks);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerShellCopy = api;
})(typeof globalThis === 'undefined' ? null : globalThis, (blocks) => {
  const ROLE_LABELS = Object.freeze({ user: '我', agent: 'Companion' });

  const str = (value) => (value === undefined || value === null ? '' : String(value).trim());
  const list = (value) => (Array.isArray(value) ? value : []);
  const oneLine = (value) => str(value).replace(/\s+/gu, ' ');

  /** 角色名：不认识的角色不猜，写成「未知」；导出正文里也不丢这条消息。 */
  const roleLabel = (role) => ROLE_LABELS[str(role)] ?? '未知';

  /**
   * 统一收尾：去掉行尾空白与首尾空行，连续的中间空行压成一行。
   * 不 trim 每行缩进——代码块与 diff 的缩进是内容的一部分。
   */
  const finish = (lines) => {
    const out = [];
    lines.forEach((line) => {
      const text = String(line ?? '').replace(/[ \t]+$/u, '');
      if (text === '' && (out.length === 0 || out[out.length - 1] === '')) return;
      out.push(text);
    });
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    return out.join('\n');
  };

  /** 表格单元格：竖线要转义，换行用 <br>，否则一行会被拆成两行。 */
  const cell = (value) => str(value).replace(/\|/gu, '\\|').replace(/\n+/gu, '<br>');

  /**
   * 围栏：代码里已有连续反引号时，围栏要比它更长，否则内容会把围栏提前关掉。
   * 语言为空就只写围栏本身。
   */
  const fence = (code, lang = '') => {
    const runs = String(code).match(/`+/gu) ?? [];
    const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
    const marker = '`'.repeat(Math.max(3, longest + 1));
    return `${marker}${lang}\n${code}\n${marker}`;
  };

  const heading = (title, level = 3) => (title ? `${'#'.repeat(level)} ${title}` : '');

  const emptyNote = (text) => `_（${text}）_`;

  /** 卡片：标题 + 每个分组一条列表；空分组用分组自己的空态文案，不假装没这组。 */
  const cardMarkdown = (model) => {
    const lines = [];
    if (model.title) lines.push(`${heading(model.title)}${model.badge ? `（${model.badge}）` : ''}`);
    if (model.sub) lines.push('', model.sub);
    if (model.sections.length === 0) lines.push('', emptyNote('这个卡片没有分组'));
    model.sections.forEach((section) => {
      lines.push('', `**${section.label || '未命名分组'}**${section.count ? `（${section.count}）` : ''}`);
      if (section.items.length === 0) {
        lines.push(`- ${section.empty || '这一组还没有条目'}`);
        return;
      }
      section.items.forEach((item) => {
        const tags = item.tags
          .map((tag) => str(tag.text))
          .filter(Boolean)
          .map((text) => `\`${text}\``);
        lines.push(`- ${item.title || '未命名条目'}${tags.length ? ` · ${tags.join(' ')}` : ''}`);
      });
    });
    if (model.foot?.note) lines.push('', `_${model.foot.note}_`);
    return finish(lines);
  };

  /**
   * 表格：标准管道表。列数取头行与所有数据行的最大值，短行补空；
   * 没有头行时留空表头，不把第一行数据冒充成表头。
   */
  const tableMarkdown = (model) => {
    const width = Math.max(
      model.head.length,
      ...model.rows.map((row) => row.length),
      0
    );
    const lines = [];
    if (model.title) lines.push(heading(model.title));
    if (width === 0) {
      lines.push('', emptyNote('这个表格没有数据'));
      return finish(lines);
    }
    const head = Array.from({ length: width }, (_unused, index) => model.head[index] ?? '');
    lines.push('', `| ${head.map(cell).join(' | ')} |`, `|${' --- |'.repeat(width)}`);
    model.rows.forEach((row) => {
      const cells = Array.from({ length: width }, (_unused, index) => cell(row[index] ?? ''));
      lines.push(`| ${cells.join(' | ')} |`);
    });
    if (model.rows.length === 0) lines.push('', emptyNote('这个表格没有数据行'));
    return finish(lines);
  };

  /** 指标卡：每个指标一行，保留单位与涨跌；没有 delta 时不硬补一个 0。 */
  const kpiMarkdown = (model) => {
    const lines = [];
    if (model.title) lines.push(heading(model.title));
    if (model.items.length === 0) {
      lines.push('', emptyNote('还没有可看的指标'));
      return finish(lines);
    }
    model.items.forEach((item) => {
      const unit = item.unit ? ` ${item.unit}` : '';
      const arrow = item.direction === 'up' ? '↑' : item.direction === 'down' ? '↓' : '';
      const delta = item.deltaText ? `（${arrow}${arrow ? ' ' : ''}${item.deltaText}）` : '';
      lines.push(`- **${item.label || '未命名指标'}**：${item.value || '—'}${unit}${delta}`);
    });
    return finish(lines);
  };

  /** 折线：图表退化成数据行，每个点都保留；不画图也不丢数字。 */
  const lineMarkdown = (model) => {
    const lines = [];
    if (model.title) lines.push(heading(model.title));
    lines.push('', `- 图表：折线${model.points.length ? `，${model.points.length} 个数据点` : ''}`);
    if (model.points.length === 0) {
      lines.push(`- ${emptyNote('没有数据点')}`);
      return finish(lines);
    }
    model.points.forEach((value, index) => {
      lines.push(`- 第 ${index + 1} 点：${value}${model.unit}`);
    });
    return finish(lines);
  };

  /** 环形：按渲染层同一份几何算占比；总量为 0 时退回原始分项，不丢数字。 */
  const donutMarkdown = (model) => {
    const lines = [];
    if (model.title) lines.push(heading(model.title));
    const geometry = blocks.donutGeometry(model.items);
    if (!geometry.ok) {
      if (model.items.length === 0) lines.push('', emptyNote('没有分项'));
      model.items.forEach((item) => lines.push(`- ${item.label || '未命名'}：${item.value}`));
      return finish(lines);
    }
    geometry.arcs.forEach((arc) => {
      lines.push(`- ${arc.label || '未命名'}：${arc.value}（${arc.percent}%）`);
    });
    return finish(lines);
  };

  /** 时间线：一条步骤一行；时间与说明分开写，不合并成一串。 */
  const timelineMarkdown = (model) => {
    const lines = [];
    if (model.title) lines.push(heading(model.title));
    if (model.steps.length === 0) {
      lines.push('', emptyNote('这条时间线还没有步骤'));
      return finish(lines);
    }
    model.steps.forEach((step) => {
      const when = step.at ? `${step.at} · ` : '';
      const meta = step.meta ? ` — ${step.meta}` : '';
      lines.push(`- ${when}${step.title || '未命名步骤'}${meta}`);
    });
    return finish(lines);
  };

  /** 键值：一行一个字段。值为空时保留「键：」，不把空值读成没有这个键。 */
  const kvMarkdown = (model) => {
    const lines = [];
    if (model.title) lines.push(heading(model.title));
    if (model.rows.length === 0) {
      lines.push('', emptyNote('这里没有要列出的字段'));
      return finish(lines);
    }
    model.rows.forEach((row) => lines.push(`- ${row.key || '（空键）'}：${row.value}`));
    return finish(lines);
  };

  /** 代码：围栏里保留原始缩进与行；空代码块不画一对空围栏。 */
  const codeMarkdown = (model) => {
    const lines = [];
    if (model.title || model.lang) lines.push(heading(model.title || '代码'));
    if (model.lines.length === 0) {
      lines.push('', emptyNote('这个代码块是空的'));
      return finish(lines);
    }
    lines.push('', fence(model.lines.join('\n'), model.lang || ''));
    return finish(lines);
  };

  /** diff：围栏语言写 diff，行首用 + / - / 空格；与屏幕上的增删一致。 */
  const diffMarkdown = (model) => {
    const lines = [];
    if (model.title) lines.push(heading(model.title));
    if (model.rows.length === 0) {
      lines.push('', emptyNote('这个 diff 没有行'));
      return finish(lines);
    }
    const body = model.rows
      .map((row) => `${row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}${row.text}`)
      .join('\n');
    lines.push('', fence(body, 'diff'));
    return finish(lines);
  };

  /** 工具调用：调用签名一行，输出进围栏（输出本来就是一段文本，不是表格）。 */
  const toolMarkdown = (model) => {
    const lines = [`**调用 ${model.name}(${model.arg})**${model.status ? `（${model.status}）` : ''}`];
    if (model.output) lines.push('', fence(model.output, 'text'));
    else lines.push('', emptyNote('这次调用没有输出'));
    return finish(lines);
  };

  /** 徽章墙：一行一个状态；色调是数据的一部分，原样留下。 */
  const badgesMarkdown = (model) => {
    const lines = [];
    if (model.title) lines.push(heading(model.title));
    if (model.items.length === 0) {
      lines.push('', emptyNote('这里还没有状态'));
      return finish(lines);
    }
    model.items.forEach((item) => {
      lines.push(`- ${item.text || '未命名'}${item.tone ? `（${item.tone}）` : ''}`);
    });
    return finish(lines);
  };

  /** 提问块：问题、原因、试过什么、选项与跳过都写清楚；已回答的保留结论。 */
  const askMarkdown = (model) => {
    const lines = [`### ${model.question}`];
    if (model.why) lines.push('', model.why);
    if (model.tried.length > 0) {
      lines.push('', '已经试过：');
      model.tried.forEach((item) => lines.push(`- ${item}`));
    }
    if (model.answered) {
      lines.push('', `已记录：${model.answered}`);
      return finish(lines);
    }
    if (model.options.length > 0) {
      lines.push('', '选项：');
      model.options.forEach((option) => lines.push(`- ${option}`));
    }
    const skip = model.skip?.label ? `- 也可以：${model.skip.label}` : '';
    if (skip) lines.push('', skip);
    return finish(lines);
  };

  /**
   * 审核卡（经验 / 候选）：标题、几行事实、说明；动作按钮不进 Markdown，
   * 但「已选择」要留下。
   */
  const reviewMarkdown = (model) => {
    const lines = [heading(model.title || (model.kind === 'candidate' ? '待审核候选' : '经验'))];
    model.rows.forEach((row) => lines.push(`- ${row[0]}：${row.slice(1).join(' ')}`));
    if (model.answered) lines.push('', `已记录：${model.answered}`);
    if (model.note) lines.push('', `_${model.note}_`);
    return finish(lines);
  };

  /**
   * 外发 / 删除确认卡（#116）：硬约束、逐条对象、说明、已选项一个都不省。
   * 动作按钮不进 Markdown（它只是交互入口），但「已选择」要留下。
   */
  const confirmMarkdown = (model) => {
    const lines = [];
    if (model.title) lines.push(heading(`${model.title}${model.badge ? `（${model.badge}）` : ''}`));
    if (model.headline) lines.push('', `**${model.headline}**`);
    if (model.sequence) lines.push('', `_${model.sequence}_`);
    if (model.target) lines.push('', `- 目的地：${model.target}`);
    if (model.conclusion) lines.push('', model.conclusion);
    lines.push('', model.kind === 'delete' ? '将删除的对象：' : '将要发出的内容：');
    if (model.items.length === 0) lines.push('- （这张卡没有列出对象）');
    model.items.forEach((item) => {
      const path = item.path ? `：${item.path}` : '';
      const note = item.note ? ` — ${item.note}` : '';
      lines.push(`- ${item.label}${path}${note}`);
    });
    model.notices.forEach((notice) => lines.push('', `- ${notice}`));
    if (model.answered) lines.push('', `已选择：${model.answered}`);
    return finish(lines);
  };

  const RENDERERS = {
    card: cardMarkdown,
    table: tableMarkdown,
    kpi: kpiMarkdown,
    line: lineMarkdown,
    donut: donutMarkdown,
    timeline: timelineMarkdown,
    kv: kvMarkdown,
    code: codeMarkdown,
    diff: diffMarkdown,
    tool: toolMarkdown,
    badges: badgesMarkdown,
    ask: askMarkdown,
    review: reviewMarkdown,
    confirm: confirmMarkdown
  };

  /**
   * 单个块 → Markdown。入参必须是 shell-blocks 归一化后的模型（带 type），
   * 与 shell-blocks-view.js 吃的是同一份数据；不认识就退回模型自己的文字。
   */
  const blockToMarkdown = (model) => {
    if (!model || typeof model !== 'object') return '';
    if (model.type === 'unknown') return finish([model.text || emptyNote('无法识别的块')]);
    const render = RENDERERS[model.type];
    if (!render) return finish([emptyNote('这个块没有可复制的内容')]);
    return render(model);
  };

  /**
   * 一条消息 → Markdown：正文在前，块按原顺序接在后面，块之间恰好一个空行。
   * 消息形状与消息流一致（{ role, text, blocks? }），归一化交给 shell-blocks。
   */
  const messageToMarkdown = (message) => {
    const model = blocks.normalizeReply(message);
    const parts = [];
    if (model.text) parts.push(model.text);
    model.blocks.forEach((block) => {
      const text = blockToMarkdown(block);
      if (text) parts.push(text);
    });
    return parts.join('\n\n');
  };

  /** 上下文头的四个字段：缺的给稳定默认值，不写 undefined。 */
  const contextOf = (context) => ({
    project: oneLine(context?.project) || '全局（未选项目）',
    session: oneLine(context?.session) || '当前会话',
    time: oneLine(context?.time) || '未记录',
    model: oneLine(context?.model) || '未接入'
  });

  /**
   * 整个会话导出：上下文头（项目 / 会话 / 时间 / 模型）+ 逐条消息。
   * 时间来自会话自己的 startedAt，不取「现在」，所以同一会话重复导出逐字节一致。
   */
  const conversationToMarkdown = ({ context, messages } = {}) => {
    const ctx = contextOf(context);
    const lines = [
      `# 会话导出 · ${ctx.session}`,
      '',
      `- 项目：${ctx.project}`,
      `- 会话：${ctx.session}`,
      `- 时间：${ctx.time}`,
      `- 模型：${ctx.model}`,
      '',
      '---'
    ];
    list(messages).forEach((message) => {
      const body = messageToMarkdown(message);
      lines.push('', `## ${roleLabel(message?.role)}`, '', body || emptyNote('这条消息没有内容'));
    });
    return `${finish(lines)}\n`;
  };

  return {
    ROLE_LABELS,
    roleLabel,
    blockToMarkdown,
    messageToMarkdown,
    conversationToMarkdown
  };
});
