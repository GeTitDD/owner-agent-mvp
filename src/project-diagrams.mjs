// 项目图谱：依赖扫描、图数据校验与 Mermaid 生成。
//
// 模型只产出结构化 nodes/edges/states/messages，这里统一生成 Mermaid，
// 避免模型直接写 Mermaid 造成语法错误或注入。
import fs from 'node:fs';
import path from 'node:path';

export const DIAGRAM_KINDS = Object.freeze(['dependency', 'control', 'dataflow', 'state', 'sequence']);

export const DIAGRAM_LABELS = Object.freeze({
  dependency: '依赖图',
  control: '控制流图',
  dataflow: '数据流图',
  state: '状态图',
  sequence: '时序图'
});

const clean = (value, max = 120) => String(value ?? '')
  .replace(/\s+/gu, ' ')
  .replace(/["`|[\]]/gu, "'")
  .trim()
  .slice(0, max);

const unique = (items) => [...new Set(items.filter(Boolean))];

const flowMermaid = (data, direction = 'LR') => {
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  const edges = Array.isArray(data.edges) ? data.edges : [];
  const idMap = new Map();
  const lines = [`flowchart ${direction}`];
  nodes.forEach((node, index) => {
    const id = `n${index}`;
    idMap.set(String(node.id), id);
    lines.push(`  ${id}["${clean(node.label ?? node.id, 80)}"]`);
  });
  for (const edge of edges) {
    const from = idMap.get(String(edge.from));
    const to = idMap.get(String(edge.to));
    if (!from || !to) continue;
    const label = edge.label ? `|"${clean(edge.label, 40)}"|` : '';
    lines.push(`  ${from} -->${label} ${to}`);
  }
  return lines.join('\n');
};

const stateMermaid = (data) => {
  const states = Array.isArray(data.states) ? data.states : [];
  const transitions = Array.isArray(data.transitions) ? data.transitions : [];
  const ids = new Map();
  const lines = ['stateDiagram-v2'];
  states.forEach((state, index) => {
    const id = `s${index}`;
    ids.set(String(state.id), id);
    lines.push(`  state "${clean(state.label ?? state.id, 80)}" as ${id}`);
  });
  for (const transition of transitions) {
    const from = ids.get(String(transition.from));
    const to = ids.get(String(transition.to));
    if (!from || !to) continue;
    const label = transition.trigger ? ` : ${clean(transition.trigger, 50)}` : '';
    lines.push(`  ${from} --> ${to}${label}`);
  }
  return lines.join('\n');
};

const sequenceMermaid = (data) => {
  const participants = Array.isArray(data.participants) ? data.participants : [];
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const ids = new Map();
  const lines = ['sequenceDiagram'];
  participants.forEach((participant, index) => {
    const id = `P${index}`;
    ids.set(String(participant.id), id);
    lines.push(`  participant ${id} as ${clean(participant.label ?? participant.id, 60)}`);
  });
  for (const message of messages) {
    const from = ids.get(String(message.from));
    const to = ids.get(String(message.to));
    if (!from || !to) continue;
    const arrow = message.kind === 'return' ? '-->>' : message.kind === 'async' ? '-)' : '->>';
    lines.push(`  ${from}${arrow}${to}: ${clean(message.text, 120)}`);
  }
  return lines.join('\n');
};

/** 由结构化数据生成 Mermaid；不信任模型给的 Mermaid。 */
export function toMermaid(kind, data) {
  if (kind === 'state') return stateMermaid(data);
  if (kind === 'sequence') return sequenceMermaid(data);
  return flowMermaid(data, kind === 'dependency' || kind === 'dataflow' ? 'LR' : 'TD');
}

/** 校验并归一化模型/扫描结果；返回可直接存储的图数据。 */
export function normalizeDiagram(kind, raw = {}) {
  const summary = clean(raw.summary ?? raw.title ?? '', 600);
  if (kind === 'state') {
    const states = (Array.isArray(raw.states) ? raw.states : []).slice(0, 24)
      .map((state, index) => ({
        id: clean(state.id ?? `state${index}`, 60),
        label: clean(state.label ?? state.id ?? `状态 ${index + 1}`, 80),
        kind: state.kind === 'start' || state.kind === 'end' ? state.kind : 'state',
        evidence: unique((state.evidence ?? []).map((item) => clean(item, 200))).slice(0, 6)
      })).filter((state) => state.id);
    if (!states.length) throw new Error('状态图没有 states。');
    const known = new Set(states.map((state) => state.id));
    const transitions = (Array.isArray(raw.transitions) ? raw.transitions : [])
      .filter((item) => known.has(clean(item.from, 60)) && known.has(clean(item.to, 60)))
      .slice(0, 40)
      .map((item) => ({
        from: clean(item.from, 60),
        to: clean(item.to, 60),
        trigger: clean(item.trigger ?? '', 80),
        evidence: unique((item.evidence ?? []).map((ref) => clean(ref, 200))).slice(0, 6)
      }));
    return { summary, states, transitions, unknowns: arrayText(raw.unknowns), confidence: confidenceOf(raw.confidence) };
  }
  if (kind === 'sequence') {
    const participants = (Array.isArray(raw.participants) ? raw.participants : []).slice(0, 12)
      .map((item, index) => ({
        id: clean(item.id ?? `p${index}`, 60),
        label: clean(item.label ?? item.id ?? `参与者 ${index + 1}`, 80),
        kind: clean(item.kind ?? 'service', 30),
        evidence: unique((item.evidence ?? []).map((ref) => clean(ref, 200))).slice(0, 6)
      })).filter((item) => item.id);
    if (!participants.length) throw new Error('时序图没有 participants。');
    const known = new Set(participants.map((item) => item.id));
    const messages = (Array.isArray(raw.messages) ? raw.messages : [])
      .filter((item) => known.has(clean(item.from, 60)) && known.has(clean(item.to, 60)))
      .slice(0, 40)
      .map((item) => ({
        from: clean(item.from, 60),
        to: clean(item.to, 60),
        text: clean(item.text ?? item.label ?? '', 160),
        kind: ['sync', 'async', 'return'].includes(item.kind) ? item.kind : 'sync',
        evidence: unique((item.evidence ?? []).map((ref) => clean(ref, 200))).slice(0, 6)
      }));
    return { summary, participants, messages, unknowns: arrayText(raw.unknowns), confidence: confidenceOf(raw.confidence) };
  }
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).slice(0, 40)
    .map((node, index) => ({
      id: clean(node.id ?? `node${index}`, 60),
      label: clean(node.label ?? node.id ?? `节点 ${index + 1}`, 80),
      type: clean(node.type ?? 'module', 30),
      evidence: unique((node.evidence ?? []).map((ref) => clean(ref, 200))).slice(0, 6)
    })).filter((node) => node.id);
  if (!nodes.length) throw new Error('图没有 nodes。');
  const known = new Set(nodes.map((node) => node.id));
  const edges = (Array.isArray(raw.edges) ? raw.edges : [])
    .filter((edge) => known.has(clean(edge.from, 60)) && known.has(clean(edge.to, 60)))
    .slice(0, 80)
    .map((edge) => ({
      from: clean(edge.from, 60),
      to: clean(edge.to, 60),
      label: clean(edge.label ?? '', 50),
      evidence: unique((edge.evidence ?? []).map((ref) => clean(ref, 200))).slice(0, 6)
    }));
  return { summary, nodes, edges, unknowns: arrayText(raw.unknowns), confidence: confidenceOf(raw.confidence) };
}

const arrayText = (values) => (Array.isArray(values) ? values : [])
  .map((item) => clean(item, 200)).filter(Boolean).slice(0, 12);

const confidenceOf = (value) => ['high', 'medium', 'low'].includes(value) ? value : 'medium';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.venv', 'venv', 'coverage',
  '.next', '.nuxt', 'obj', 'bin', '.pi', '.cache'
]);
const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.cs']);

const walk = (root, limit = 500) => {
  const files = [];
  const stack = [root];
  while (stack.length && files.length < limit) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) stack.push(full);
      } else if (entry.isFile() && SOURCE_EXT.has(path.extname(entry.name).toLowerCase())) {
        files.push(full);
        if (files.length >= limit) break;
      }
    }
  }
  return files;
};

const importsOf = (content, ext) => {
  const refs = new Set();
  if (['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'].includes(ext)) {
    for (const regex of [
      /import\s+(?:[^'"]+?\s+from\s+)?["']([^"']+)["']/gu,
      /require\(\s*["']([^"']+)["']\s*\)/gu,
      /import\(\s*["']([^"']+)["']\s*\)/gu
    ]) {
      for (const match of content.matchAll(regex)) refs.add(match[1]);
    }
  } else if (ext === '.py') {
    for (const line of content.split(/\r?\n/u)) {
      const from = /^\s*from\s+([.\w]+)\s+import\s+/u.exec(line);
      if (from) { refs.add(from[1]); continue; }
      const simple = /^\s*import\s+([.\w]+)/u.exec(line);
      if (simple) refs.add(simple[1]);
    }
  } else if (ext === '.cs') {
    for (const match of content.matchAll(/^\s*using\s+([\w.]+)\s*;/gmu)) refs.add(match[1]);
  }
  return [...refs];
};

const resolveModule = (root, fromFile, spec) => {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.ts`, `${base}.tsx`, `${base}.jsx`,
    path.join(base, 'index.js'), path.join(base, 'index.ts'), path.join(base, 'index.tsx')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
};

/**
 * 本地扫描依赖图：不调用模型，解析 import/require/using。
 * 节点过多时按顶层目录折叠。
 */
export function scanDependencyGraph(root, { limit = 400 } = {}) {
  const files = walk(root, limit);
  const nodes = new Map();
  const edges = [];
  const rel = (file) => path.relative(root, file).replace(/\\/gu, '/');
  for (const file of files) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const from = rel(file);
    nodes.set(from, { id: from, label: from, type: 'module', evidence: [from] });
    for (const spec of importsOf(content, path.extname(file).toLowerCase())) {
      const local = resolveModule(root, file, spec);
      if (local && local.startsWith(root)) {
        const to = rel(local);
        nodes.set(to, { id: to, label: to, type: 'module', evidence: [from] });
        edges.push({ from, to, label: 'imports', evidence: [from] });
      } else if (!spec.startsWith('.')) {
        const id = `外部:${spec.split('/')[0]}`;
        nodes.set(id, { id, label: id.replace(/^外部:/u, ''), type: 'external', evidence: [from] });
        edges.push({ from, to: id, label: 'imports', evidence: [from] });
      }
    }
  }
  let listNodes = [...nodes.values()];
  let listEdges = edges;
  if (listNodes.length > 30) {
    const group = (id) => id.startsWith('外部:') ? id : (id.split('/')[0] || 'root');
    const groups = new Map();
    for (const node of listNodes) {
      const id = group(node.id);
      if (!groups.has(id)) groups.set(id, { id, label: id.replace(/^外部:/u, ''), type: id.startsWith('外部:') ? 'external' : 'module', evidence: [] });
      groups.get(id).evidence.push(...node.evidence);
    }
    listNodes = [...groups.values()].map((node) => ({ ...node, evidence: unique(node.evidence).slice(0, 6) }));
    const seen = new Set();
    listEdges = [];
    for (const edge of edges) {
      const from = group(edge.from);
      const to = group(edge.to);
      if (from === to) continue;
      const key = `${from}->${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      listEdges.push({ from, to, label: 'imports', evidence: unique(edge.evidence).slice(0, 4) });
    }
  }
  const data = normalizeDiagram('dependency', {
    summary: `${files.length} 个源文件、${listEdges.length} 条依赖关系`,
    nodes: listNodes,
    edges: listEdges,
    unknowns: files.length >= limit ? [`扫描上限 ${limit} 个文件，结果可能不完整`] : [],
    confidence: 'high'
  });
  return {
    kind: 'dependency',
    scope: 'project',
    title: '项目依赖图',
    data,
    mermaid: toMermaid('dependency', data),
    source: 'local-scan'
  };
}
