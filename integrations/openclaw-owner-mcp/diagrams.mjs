// 把 Owner 的结构化图数据画成 SVG，再转成 Telegram 能发的 PNG。
//
// 布局逻辑和 Cindy 面板里的 main-view.js 保持一致，只是把主题变量换成固定色，
// 因为 resvg 不解析 CSS 变量。支持：依赖图 / 控制流 / 数据流 / 时序 / 状态机。

import { Resvg } from '@resvg/resvg-js';

const COLORS = {
  bg: '#FFFFFF',
  surface: '#F7F7F5',
  line: '#D8D8D2',
  text: '#1F1F1F',
  muted: '#6B6B6B',
  edge: '#8A8A85',
  danger: '#C0392B',
  start: '#2F8F5B'
};

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

const trim = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const svgText = (x, y, text, { size = 12, fill = COLORS.text, anchor = 'start', weight = 400 } = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}"`
  + ` font-weight="${weight}" font-family="Microsoft YaHei, Segoe UI, Arial">${esc(text)}</text>`;

const DEFS = '<defs><marker id="owner-arrow" viewBox="0 0 10 10" refX="9" refY="5"'
  + ' markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
  + `<path d="M0 0L10 5L0 10z" fill="${COLORS.edge}"/></marker></defs>`;

const edgePoint = (from, to) => {
  const dx = (to.x + to.w / 2) - (from.x + from.w / 2);
  const dy = (to.y + to.h / 2) - (from.y + from.h / 2);
  const angle = Math.atan2(dy, dx);
  const hw = from.w / 2;
  const hh = from.h / 2;
  const cos = Math.abs(Math.cos(angle)) || 1e-6;
  const sin = Math.abs(Math.sin(angle)) || 1e-6;
  const scale = Math.min(hw / cos, hh / sin);
  return {
    x: from.x + from.w / 2 + Math.cos(angle) * scale,
    y: from.y + from.h / 2 + Math.sin(angle) * scale
  };
};

/** 流程类图：按层级自上而下分行，一行最多 4 个。 */
const flowSvg = (data) => {
  const nodes = (data?.nodes ?? []).filter((node) => node && node.id);
  if (!nodes.length) return '';
  const edges = (data?.edges ?? []).filter((edge) => edge && edge.from && edge.to);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const out = new Map(nodes.map((node) => [node.id, []]));
  const indeg = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    out.get(edge.from).push(edge.to);
    indeg.set(edge.to, (indeg.get(edge.to) ?? 0) + 1);
  }
  const level = new Map();
  const roots = nodes.filter((node) => (indeg.get(node.id) ?? 0) === 0).map((node) => node.id);
  const queue = roots.length ? [...roots] : [nodes[0].id];
  for (const id of queue) level.set(id, 0);
  let guard = 0;
  while (queue.length && guard < nodes.length * 10 + 50) {
    const id = queue.shift();
    guard += 1;
    const base = level.get(id) ?? 0;
    for (const next of out.get(id) ?? []) {
      if ((level.get(next) ?? -1) < base + 1) {
        level.set(next, base + 1);
        queue.push(next);
      }
    }
  }
  for (const node of nodes) if (!level.has(node.id)) level.set(node.id, 0);

  const columns = [];
  for (const node of nodes) {
    const index = level.get(node.id) ?? 0;
    (columns[index] ??= []).push(node);
  }
  const rows = [];
  for (const column of columns.filter(Boolean)) {
    for (let start = 0; start < column.length; start += 4) rows.push(column.slice(start, start + 4));
  }

  const labelOf = (node) => String(node.label || node.id);
  const boxW = 170;
  const boxH = 40;
  const gapX = 18;
  const gapY = 46;
  const pad = 24;
  const rowWidths = rows.map((row) => row.length * boxW + (row.length - 1) * gapX);
  const W = Math.max(...rowWidths, 360) + pad * 2;
  const pos = new Map();
  let y = pad;
  rows.forEach((row, index) => {
    let x = (W - rowWidths[index]) / 2;
    for (const node of row) {
      pos.set(node.id, { x, y, w: boxW, h: boxH });
      x += boxW + gapX;
    }
    y += boxH + gapY;
  });
  const H = y - gapY + pad;

  const parts = [];
  for (const edge of edges) {
    const a = pos.get(edge.from);
    const b = pos.get(edge.to);
    if (!a || !b || edge.from === edge.to) continue;
    let d;
    let labelX;
    let labelY;
    if (Math.abs(a.y - b.y) < 1) {
      const sx = a.x + a.w;
      const sy = a.y + a.h / 2;
      const tx = b.x;
      const ty = b.y + b.h / 2;
      const lift = 28;
      d = `M${sx} ${sy} C${sx + 26} ${sy - lift} ${tx - 26} ${ty - lift} ${tx} ${ty}`;
      labelX = (sx + tx) / 2;
      labelY = sy - lift * 0.7;
    } else {
      const forward = b.y > a.y;
      const sx = a.x + a.w / 2;
      const sy = forward ? a.y + a.h : a.y;
      const tx = b.x + b.w / 2;
      const ty = forward ? b.y : b.y + b.h;
      const bend = Math.max(20, Math.abs(ty - sy) / 2);
      d = forward
        ? `M${sx} ${sy} C${sx} ${sy + bend} ${tx} ${ty - bend} ${tx} ${ty}`
        : `M${sx} ${sy} C${sx + 80} ${sy} ${tx + 80} ${ty} ${tx} ${ty}`;
      labelX = (sx + tx) / 2;
      labelY = (sy + ty) / 2 - 6;
    }
    parts.push(`<path d="${d}" fill="none" stroke="${COLORS.edge}" stroke-width="1.4" marker-end="url(#owner-arrow)"/>`);
    if (edge.label) {
      parts.push(`<text x="${labelX}" y="${labelY}" font-size="10" fill="${COLORS.muted}" text-anchor="middle"`
        + ` paint-order="stroke" stroke="${COLORS.surface}" stroke-width="3" font-family="Microsoft YaHei, Arial">`
        + `${esc(trim(edge.label, 20))}</text>`);
    }
  }
  for (const node of nodes) {
    const box = pos.get(node.id);
    if (!box) continue;
    const dashed = node.type === 'decision' ? ' stroke-dasharray="4 3"' : '';
    parts.push('<g>');
    parts.push(`<title>${esc(labelOf(node))}</title>`);
    parts.push(`<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="10"`
      + ` fill="${COLORS.surface}" stroke="${COLORS.line}"${dashed}/>`);
    parts.push(svgText(box.x + box.w / 2, box.y + box.h / 2 + 4, trim(labelOf(node), 22), { anchor: 'middle' }));
    parts.push('</g>');
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`
    + `<rect width="${W}" height="${H}" fill="${COLORS.bg}"/>${DEFS}${parts.join('')}</svg>`;
};

/** 时序图：参与者竖线 + 横向消息。 */
const sequenceSvg = (data) => {
  const participants = (data?.participants ?? []).filter((item) => item && item.id);
  const messages = (data?.messages ?? []).filter((item) => item && item.from && item.to);
  if (!participants.length) return '';
  const pad = 24;
  const gap = 30;
  const headH = 40;
  const rowH = 34;
  let cursor = pad;
  const columns = [];
  const pos = new Map();
  for (const participant of participants) {
    const width = Math.min(220, Math.max(120, String(participant.label || participant.id).length * 7 + 24));
    columns.push({ participant, x: cursor, w: width });
    pos.set(participant.id, { x: cursor, w: width });
    cursor += width + gap;
  }
  const W = Math.max(380, cursor - gap + pad);
  const top = 20;
  const H = top + headH + 34 + messages.length * rowH + 20;
  const parts = [];
  for (const column of columns) {
    const cx = column.x + column.w / 2;
    parts.push(`<line x1="${cx}" y1="${top + headH}" x2="${cx}" y2="${H - 14}" stroke="${COLORS.line}" stroke-dasharray="4 4"/>`);
    parts.push(`<rect x="${column.x}" y="${top}" width="${column.w}" height="${headH}" rx="9" fill="${COLORS.surface}" stroke="${COLORS.line}"/>`);
    parts.push(svgText(cx, top + headH / 2 + 4, trim(column.participant.label || column.participant.id, 20), { anchor: 'middle' }));
  }
  messages.forEach((message, index) => {
    const a = pos.get(message.from);
    const b = pos.get(message.to);
    if (!a || !b) return;
    const y = top + headH + 34 + index * rowH;
    const ax = a.x + a.w / 2;
    const bx = b.x + b.w / 2;
    if (message.from === message.to) {
      parts.push(`<path d="M${ax} ${y} h20 v20 h-20" fill="none" stroke="${COLORS.edge}" stroke-width="1.4" marker-end="url(#owner-arrow)"/>`);
      parts.push(svgText(ax + 30, y + 6, trim(message.text, 28), { size: 10.5 }));
    } else {
      parts.push(`<line x1="${ax}" y1="${y}" x2="${bx}" y2="${y}" stroke="${COLORS.edge}" stroke-width="1.4" marker-end="url(#owner-arrow)"/>`);
      parts.push(svgText((ax + bx) / 2, y - 7, trim(message.text, 32), { anchor: 'middle', size: 10.5 }));
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`
    + `<rect width="${W}" height="${H}" fill="${COLORS.bg}"/>${DEFS}${parts.join('')}</svg>`;
};

/** 状态机：状态排成一圈，转移画箭头。 */
const stateSvg = (data) => {
  const states = (data?.states ?? []).filter((item) => item && item.id);
  const transitions = (data?.transitions ?? []).filter((item) => item && item.from && item.to);
  if (!states.length) return '';
  const count = states.length;
  const W = 860;
  const radius = Math.max(160, Math.min(300, 60 + count * 26));
  const cx = W / 2;
  const cy = radius * 0.92 + 40;
  const H = cy * 2 + 30;
  const boxW = 140;
  const boxH = 42;
  const pos = new Map();
  states.forEach((state, index) => {
    const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
    pos.set(state.id, {
      x: cx + Math.cos(angle) * radius - boxW / 2,
      y: cy + Math.sin(angle) * radius * 0.82 - boxH / 2,
      w: boxW,
      h: boxH
    });
  });
  const parts = [];
  for (const transition of transitions) {
    const a = pos.get(transition.from);
    const b = pos.get(transition.to);
    if (!a || !b) continue;
    if (transition.from === transition.to) {
      const x = a.x + a.w / 2;
      const y = a.y;
      parts.push(`<path d="M${x - 10} ${y} c-6 -30 26 -30 20 0" fill="none" stroke="${COLORS.edge}" stroke-width="1.4" marker-end="url(#owner-arrow)"/>`);
      continue;
    }
    const start = edgePoint(a, b);
    const end = edgePoint(b, a);
    parts.push(`<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" stroke="${COLORS.edge}" stroke-width="1.4" marker-end="url(#owner-arrow)"/>`);
    if (transition.trigger) {
      parts.push(`<text x="${(start.x + end.x) / 2}" y="${(start.y + end.y) / 2 - 6}" font-size="10"`
        + ` fill="${COLORS.muted}" text-anchor="middle" paint-order="stroke" stroke="${COLORS.bg}" stroke-width="3"`
        + ` font-family="Microsoft YaHei, Arial">${esc(trim(transition.trigger, 22))}</text>`);
    }
  }
  for (const state of states) {
    const box = pos.get(state.id);
    const isStart = state.kind === 'start';
    const isEnd = state.kind === 'end';
    parts.push('<g>');
    parts.push(`<title>${esc(state.label || state.id)}</title>`);
    parts.push(`<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="${isStart || isEnd ? 21 : 10}"`
      + ` fill="${COLORS.surface}" stroke="${isEnd ? COLORS.danger : isStart ? COLORS.start : COLORS.line}"/>`);
    parts.push(svgText(box.x + box.w / 2, box.y + box.h / 2 + 4, trim(state.label || state.id, 18), { anchor: 'middle' }));
    parts.push('</g>');
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`
    + `<rect width="${W}" height="${H}" fill="${COLORS.bg}"/>${DEFS}${parts.join('')}</svg>`;
};

export const renderSvg = (kind, data) => {
  if (kind === 'sequence') return sequenceSvg(data);
  if (kind === 'state') return stateSvg(data);
  return flowSvg(data);
};

export const renderPng = (kind, data, { width = 1400 } = {}) => {
  const svg = renderSvg(kind, data);
  if (!svg) return null;
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    background: COLORS.bg,
    font: { loadSystemFonts: true, defaultFontFamily: 'Microsoft YaHei' }
  });
  const png = resvg.render().asPng();
  if (!png.length || png.length > 9 * 1024 * 1024) return null;
  return png;
};
