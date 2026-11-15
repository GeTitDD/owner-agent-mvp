// 依赖图扫描与 Mermaid 生成（Cindy 插件 Node worker 的自包含模块）。
//
// 只依赖 Node 内置模块，不调用模型、不读环境变量：
// 先在本地解析源码里的 import/require/using，产出结构化 nodes/edges，
// 再由本地代码生成 Mermaid —— 避免模型直接写 Mermaid 造成语法错误或注入。
import { promises as fsp } from 'node:fs';
import path from 'node:path';

/** 扫描时跳过的目录；隐藏目录另有统一过滤。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.venv', 'venv', '__pycache__',
  '.next', '.nuxt', 'obj', 'bin', 'coverage', '.pi', '.cache'
]);

/** 参与扫描的源文件扩展名。 */
const SOURCE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.cs', '.rs', '.go'
]);

const JS_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);

/** 单文件读取上限：超过就跳过，避免超大产物文件拖垮扫描。 */
const MAX_FILE_BYTES = 200 * 1024;

/** 节点数超过该值后按顶层目录折叠。 */
const FOLD_THRESHOLD = 30;

const MAX_EVIDENCE = 6;
const NODE_LABEL_MAX = 80;
const EDGE_LABEL_MAX = 50;

/** 外部包节点 id 前缀；label 会去掉这个前缀。 */
const EXTERNAL_PREFIX = '外部:';

/** 补全本地相对路径时依次尝试的扩展名。 */
const RESOLVE_SUFFIXES = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py'];

/** 目录形式的模块入口文件。 */
const INDEX_FILES = [
  'index.js', 'index.mjs', 'index.cjs', 'index.ts', 'index.tsx', 'index.jsx', '__init__.py'
];

/**
 * Mermaid 标签清洗：把换行压成空格，去掉会破坏语法的字符（替换成单引号），并按长度截断。
 */
const cleanLabel = (value, max) => String(value ?? '')
  .replace(/\s+/gu, ' ')
  .replace(/["`|[\]]/gu, "'")
  .trim()
  .slice(0, max);

const unique = (items) => [...new Set(items.filter(Boolean))];

/** 按顶层目录分组；外部节点保持独立。 */
const groupId = (id) => (id.startsWith(EXTERNAL_PREFIX) ? id : (id.split('/')[0] || id));

/**
 * 异步遍历收集源文件绝对路径。
 * 用栈做深度优先，目录项按名称排序，保证同一份代码每次扫描结果稳定。
 */
const walkSources = async (root, limit) => {
  const files = [];
  const stack = [root];
  while (stack.length && files.length < limit) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 无权限或目录已消失，跳过
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    // 目录倒序入栈，出栈顺序即正序
    const dirs = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        dirs.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SOURCE_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      files.push(full);
      if (files.length >= limit) break;
    }
    for (let index = dirs.length - 1; index >= 0; index -= 1) stack.push(dirs[index]);
  }
  return files;
};

/** 读取源文件；超过 200KB 或读失败返回 null（调用方据此跳过）。 */
const readSource = async (file) => {
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) return null;
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
};

/** Python 相对导入的点号转换成路径：`.` → `./`、`..pkg.mod` → `../pkg/mod`。 */
const pyRelative = (spec) => {
  const match = /^(\.+)([\w.]*)$/u.exec(spec);
  if (!match) return spec;
  const ups = match[1].length - 1;
  const rest = match[2].replace(/\./gu, '/');
  return `${ups ? '../'.repeat(ups) : './'}${rest}`;
};

/**
 * 从文件内容里抽取依赖说明符；按扩展名走不同的解析规则。
 * 说明符原样返回，是否本地文件由 resolveModule 决定。
 */
const importsOf = (content, ext) => {
  const refs = new Set();
  if (JS_EXT.has(ext)) {
    for (const regex of [
      /import\s+(?:[^'"]+?\s+from\s+)?["']([^"']+)["']/gu, // import x from 'a' / import 'a'
      /export\s+[^'"]*?\s+from\s+["']([^"']+)["']/gu, // export { x } from 'a'
      /require\(\s*["']([^"']+)["']\s*\)/gu, // CommonJS
      /import\(\s*["']([^"']+)["']\s*\)/gu // 动态 import()
    ]) {
      for (const match of content.matchAll(regex)) refs.add(match[1]);
    }
  } else if (ext === '.py') {
    for (const line of content.split(/\r?\n/u)) {
      const from = /^\s*from\s+([.\w]+)\s+import\s+/u.exec(line);
      if (from) {
        refs.add(pyRelative(from[1]));
        continue;
      }
      const simple = /^\s*import\s+([.\w]+)/u.exec(line);
      if (simple) refs.add(simple[1]);
    }
  } else if (ext === '.cs') {
    for (const match of content.matchAll(/^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gmu)) {
      refs.add(match[1]);
    }
  } else if (ext === '.go') {
    // Go：单行 import "fmt" 与 import ( ... ) 块里的字符串字面量
    for (const match of content.matchAll(/^\s*import\s+["'`]([^"'`]+)["'`]/gmu)) refs.add(match[1]);
    for (const block of content.matchAll(/import\s*\(([\s\S]*?)\)/gu)) {
      for (const inner of block[1].matchAll(/["'`]([^"'`]+)["'`]/gu)) refs.add(inner[1]);
    }
  } else if (ext === '.rs') {
    // Rust：只取 use 的首段；crate/self/super 是工程内部路径，跳过避免误判成外部包
    for (const match of content.matchAll(/^\s*(?:pub\s+)?use\s+(?:::)?([A-Za-z_]\w*)/gmu)) {
      if (['crate', 'self', 'super'].includes(match[1])) continue;
      refs.add(match[1]);
    }
  }
  return [...refs];
};

/**
 * 把说明符解析成真实文件路径。
 * 只处理相对路径（`.` 开头）；补扩展名与 index/__init__ 入口。
 */
const resolveModule = async (fromFile, spec) => {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base];
  for (const suffix of RESOLVE_SUFFIXES) candidates.push(`${base}${suffix}`);
  for (const name of INDEX_FILES) candidates.push(path.join(base, name));
  for (const candidate of candidates) {
    try {
      if ((await fsp.stat(candidate)).isFile()) return candidate;
    } catch {
      // 候选不存在，继续尝试下一个
    }
  }
  return null;
};

/** 非相对说明符取包名：react → react、react-dom/client → react-dom、app.services → app。 */
const externalName = (spec) => {
  const name = String(spec ?? '').trim();
  if (!name) return '';
  return name.split(/[/.]/u)[0] || name;
};

/** 折叠后的边：重写两端 id、去重并按 evidence 合并。 */
const foldEdges = (edges) => {
  const merged = new Map();
  for (const edge of edges) {
    const from = groupId(edge.from);
    const to = groupId(edge.to);
    if (from === to) continue;
    const key = `${from}->${to}`;
    if (!merged.has(key)) merged.set(key, { from, to, label: edge.label, evidence: [] });
    merged.get(key).evidence.push(...edge.evidence);
  }
  return [...merged.values()].map((edge) => ({
    ...edge,
    evidence: unique(edge.evidence).slice(0, MAX_EVIDENCE)
  }));
};

/** 由结构化数据生成 Mermaid：节点 id 统一 n0/n1…，边标签放在 |"…"| 里。 */
const buildMermaid = (nodes, edges) => {
  const ids = new Map();
  const lines = ['flowchart LR'];
  nodes.forEach((node, index) => {
    const id = `n${index}`;
    ids.set(String(node.id), id);
    lines.push(`  ${id}["${cleanLabel(node.label ?? node.id, NODE_LABEL_MAX)}"]`);
  });
  for (const edge of edges) {
    const from = ids.get(String(edge.from));
    const to = ids.get(String(edge.to));
    if (!from || !to) continue;
    const label = edge.label ? `|"${cleanLabel(edge.label, EDGE_LABEL_MAX)}"|` : '';
    lines.push(`  ${from} -->${label} ${to}`);
  }
  return lines.join('\n');
};

/**
 * 扫描项目依赖图：不调用模型，解析 import/require/import()、Python from/import、C# using。
 * 节点超过 30 个时按顶层目录折叠（外部节点保留），边去重。
 */
export async function scanDependencyGraph(root, { limit = 400 } = {}) {
  const base = path.resolve(root);
  const files = await walkSources(base, limit);
  const relOf = (file) => path.relative(base, file).replace(/\\/gu, '/');

  const nodeMap = new Map();
  const edgeMap = new Map();
  let skipped = 0;

  const addNode = (id, type, evidence) => {
    const current = nodeMap.get(id);
    if (!current) {
      nodeMap.set(id, {
        id,
        label: id.startsWith(EXTERNAL_PREFIX) ? id.slice(EXTERNAL_PREFIX.length) : id,
        type,
        evidence: new Set(evidence)
      });
      return;
    }
    for (const item of evidence) current.evidence.add(item);
  };

  const addEdge = (from, to, evidence) => {
    const key = `${from}->${to}`;
    const current = edgeMap.get(key);
    if (!current) {
      edgeMap.set(key, { from, to, label: 'imports', evidence: new Set(evidence) });
      return;
    }
    for (const item of evidence) current.evidence.add(item);
  };

  // 按相对路径排序后再解析，保证输出稳定
  const ordered = files.map((file) => ({ file, rel: relOf(file) }))
    .sort((a, b) => a.rel.localeCompare(b.rel));

  for (const { file, rel } of ordered) {
    const content = await readSource(file);
    if (content === null) {
      skipped += 1; // 空文件或超过 200KB：不参与依赖解析
      continue;
    }
    addNode(rel, 'module', [rel]);
    for (const spec of importsOf(content, path.extname(file).toLowerCase())) {
      const local = await resolveModule(file, spec);
      const localRel = local ? path.relative(base, local) : '';
      if (localRel && !localRel.startsWith('..') && !path.isAbsolute(localRel)) {
        const to = localRel.replace(/\\/gu, '/');
        addNode(to, 'module', [rel]);
        addEdge(rel, to, [rel]);
        continue;
      }
      if (spec.startsWith('.')) continue; // 相对路径解析不到真实文件，不臆造节点
      const pkg = externalName(spec);
      if (!pkg) continue;
      const id = `${EXTERNAL_PREFIX}${pkg}`;
      addNode(id, 'external', [rel]);
      addEdge(rel, id, [rel]);
    }
  }

  let listNodes = [...nodeMap.values()].map((node) => ({
    id: node.id,
    label: node.label,
    type: node.type,
    evidence: unique([...node.evidence]).slice(0, MAX_EVIDENCE)
  }));
  let listEdges = [...edgeMap.values()].map((edge) => ({
    from: edge.from,
    to: edge.to,
    label: edge.label,
    evidence: unique([...edge.evidence]).slice(0, MAX_EVIDENCE)
  }));

  if (listNodes.length > FOLD_THRESHOLD) {
    const groups = new Map();
    for (const node of listNodes) {
      const id = groupId(node.id);
      if (!groups.has(id)) {
        groups.set(id, {
          id,
          label: id.startsWith(EXTERNAL_PREFIX) ? id.slice(EXTERNAL_PREFIX.length) : id,
          type: id.startsWith(EXTERNAL_PREFIX) ? 'external' : 'module',
          evidence: []
        });
      }
      groups.get(id).evidence.push(...node.evidence);
    }
    listNodes = [...groups.values()].map((node) => ({
      ...node,
      evidence: unique(node.evidence).slice(0, MAX_EVIDENCE)
    }));
    listEdges = foldEdges(listEdges);
  }

  // 模块在前、外部包在后，各自按 id 排序
  listNodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'external' ? 1 : -1;
    return a.id.localeCompare(b.id);
  });
  listEdges.sort((a, b) => `${a.from}->${a.to}`.localeCompare(`${b.from}->${b.to}`));

  const unknowns = [];
  if (files.length >= limit) unknowns.push(`扫描上限 ${limit} 个文件，结果可能不完整`);
  if (skipped) unknowns.push(`已跳过 ${skipped} 个空文件或超过 200KB 的源文件`);

  const summary = `${files.length} 个源文件、${listEdges.length} 条依赖关系`;
  const data = {
    nodes: listNodes,
    edges: listEdges,
    unknowns,
    confidence: 'high'
  };

  return {
    kind: 'dependency',
    title: '项目依赖图',
    summary,
    mermaid: buildMermaid(listNodes, listEdges),
    data,
    stats: { files: files.length, edges: listEdges.length }
  };
}
