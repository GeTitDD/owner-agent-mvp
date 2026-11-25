// 会话扫描：把本机上其他 Agent 留下的会话读成「对话片段」，按会话记录的工作目录
// 匹配到已登记的项目，再交给 decision-draft 产决策候选。
//
// 为什么单独一个文件：会话文件的两种形状、路径匹配规则、去重与计数都是「管道」，
// 与提炼规则分开写才能各自单独测——提炼规则在 decision-draft.mjs 里，这里绝不另写一份。
//
// 边界（写死在这里，免得界面层再猜一遍）：
// - 只接两个来源：Codex（<home>/sessions/YYYY/MM/DD/rollout-*.jsonl，首行 session_meta 带 cwd）
//   与 Claude Code（~/.claude/projects/<压平后的 cwd>/<uuid>.jsonl，行上带 cwd）。
//   OpenCode 的库体量太大，明确留在范围外。
// - 匹配只做「工作目录精确等于项目根，或在其子目录下」，不做模糊匹配；匹配不到就丢弃并计数。
// - 只取对话双方的消息：工具输出、思考块、developer/system 角色都不进正文。
// - 不新增依赖：Codex 新版把 rollout 压成 .jsonl.zst，用 node 内置 zlib 解，不引第三方包。
// - 本文件不写库、不联网、不调真实模型：已扫过的会话键与已有指纹由调用方传入并带回，
//   持久化留在宿主进程；提炼器通过参数注入，缺省时用本文件末尾那个保守占位实现。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { draftDecisions } from './decision-draft.mjs';
import { flatText } from '../utils.mjs';

// 只读开头就能拿到 cwd（Codex 在第 1 行，Claude Code 在前几行），
// 匹配不上的会话不必整份解析——本机单是 Codex 就有上千段会话。
const HEAD_BYTES = 64 * 1024;

const DEFAULTS = {
  maxSessions: 200,
  maxBytes: 16 * 1024 * 1024,
  // 单段会话最多提炼这么多片段：超大会话不该把一次点击拖成十几秒。
  maxFragments: 400,
  // 返回给界面的候选样本上限；counts.candidates 仍是全量条数。
  maxCandidateSample: 60,
  // 丢弃明细最多列这么多条路径；计数本身是完整的。
  maxSkippedFiles: 50
};

/** 丢弃原因的中文标签：界面直接显示，不再各写一份文案。 */
export const DROP_REASON_LABELS = {
  unmatchedCwd: '工作目录不属于任何已登记项目',
  missingCwd: '会话里没有工作目录',
  unreadable: '读不出来（损坏或没有权限）',
  tooLarge: '文件超过本次扫描的大小上限',
  emptyConversation: '只有工具输出，没有对话正文'
};

/**
 * 路径归一：统一分隔符、去掉末尾斜杠、小写。
 * Windows 的盘符大小写不敏感，同一个仓库会以 D:\ 与 d:/ 两种写法出现；
 * 折叠大小写是为了让它们命中同一个项目。这是「归一」，不是模糊匹配：
 * 归一之后仍然要求逐字符相等，或整段以「项目根 + /」开头。
 */
export const pathKey = (value) => String(value ?? '')
  .replace(/\\/gu, '/')
  .replace(/\/+/gu, '/')
  .replace(/\/$/u, '')
  .toLowerCase();

/**
 * 按工作目录匹配项目：精确等于项目根，或在项目根的子目录下。
 * 多个项目嵌套时取根最长（最具体）的那个；匹配不到返回 null，不猜。
 */
export function matchProjectForCwd(cwd, projects = []) {
  const key = pathKey(cwd);
  if (!key) return null;
  let best = null;
  let bestLength = -1;
  for (const project of Array.isArray(projects) ? projects : []) {
    const root = pathKey(project?.root);
    if (!root) continue;
    if (key !== root && !key.startsWith(`${root}/`)) continue;
    if (root.length > bestLength) {
      best = project;
      bestLength = root.length;
    }
  }
  return best;
}

/**
 * 默认会话根目录：Codex 跟随 CODEX_HOME（缺省 ~/.codex），Claude Code 固定在 ~/.claude。
 * 只给目录，不检查存在——不存在的目录按 0 段会话处理，界面照常显示计数。
 */
export function sessionRootsFrom({ home = os.homedir(), env = process.env } = {}) {
  const codexHome = env?.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
  return [
    { source: 'codex', dir: path.join(codexHome, 'sessions') },
    { source: 'claude', dir: path.join(home, '.claude', 'projects') }
  ];
}

/** 一行一个 JSON；坏行（写到一半、被截断）跳过，不让整段会话作废。 */
function* rowsOf(text) {
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed);
    } catch { /* 半行跳过 */ }
  }
}

/**
 * 只认对话双方的文本块。
 * Codex 的 content 是 [{type:'input_text'|'output_text', text}]，Claude 的是
 * [{type:'text'|'tool_use'|'tool_result'|'thinking', ...}]；两边形状不同，但规则一致：
 * 只留 text 类块，工具输出与思考块只是计数。
 */
const textBlocks = (content, skipped) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    const type = String(block?.type ?? '');
    if (typeof block?.text === 'string' && (type === '' || type === 'text' || /text$/u.test(type))) {
      parts.push(block.text);
      continue;
    }
    if (type === 'tool_use' || type === 'tool_result') {
      skipped.tools++;
      continue;
    }
    if (type === 'thinking' || type === 'redacted_thinking') {
      skipped.reasoning++;
      continue;
    }
    // 图片、附件等其它块不参与对话正文，也不单独计数。
  }
  return parts.join('\n');
};

/**
 * 只读会话元信息：工作目录 + 会话 id。
 * Codex 认首行 session_meta 的 payload.cwd；Claude Code 认任意一行上的 cwd。
 * 认不出来返回 null，由调用方按「没有工作目录」丢弃——不拿目录名去反推 cwd。
 */
export function readSessionMeta(source, text) {
  if (source === 'codex') {
    for (const row of rowsOf(text)) {
      if (row?.type !== 'session_meta' || !row.payload) continue;
      const cwd = flatText(row.payload.cwd);
      if (!cwd) continue;
      return { cwd, sessionId: String(row.payload.id ?? row.payload.session_id ?? '') };
    }
    return null;
  }
  for (const row of rowsOf(text)) {
    if (typeof row?.cwd !== 'string' || !flatText(row.cwd)) continue;
    return { cwd: row.cwd, sessionId: String(row.sessionId ?? '') };
  }
  return null;
}

/**
 * 读整段会话的对话片段：{ role, text, at }，形状与 decision-draft 的入口一致。
 * 角色只收 user / assistant；工具输出、注入的权限说明、思考块各自计数后丢弃。
 */
export function readSessionFragments(source, text, skipped = { tools: 0, reasoning: 0, nonConversation: 0 }) {
  const fragments = [];
  for (const row of rowsOf(text)) {
    if (!row || typeof row !== 'object') continue;
    if (source === 'codex') {
      if (row.type !== 'response_item' || !row.payload) continue;
      const payload = row.payload;
      if (payload.type !== 'message') {
        // function_call / function_call_output / custom_tool_call 都是工具往来。
        if (typeof payload.type === 'string' && /tool|function/u.test(payload.type)) skipped.tools++;
        continue;
      }
      const role = String(payload.role ?? '').toLowerCase();
      if (role !== 'user' && role !== 'assistant') {
        skipped.nonConversation++;
        continue;
      }
      const body = flatText(textBlocks(payload.content, skipped));
      if (!body) continue;
      fragments.push({ role, text: body, at: String(row.timestamp ?? '') });
      continue;
    }
    // Claude Code：type 直接就是 user / assistant，其余（attachment / ai-title / last-prompt 等）跳过。
    if (row.type !== 'user' && row.type !== 'assistant') continue;
    // 子代理（isSidechain）的往来不是 Owner 与主对话的取舍，跳过避免把委派细则当决策。
    if (row.isSidechain === true) {
      skipped.nonConversation++;
      continue;
    }
    const body = flatText(textBlocks(row.message?.content, skipped));
    if (!body) continue;
    fragments.push({ role: row.type, text: body, at: String(row.timestamp ?? '') });
  }
  return fragments;
}

/**
 * 没有模型时的保守占位提炼器：只在原话像「做了取舍」时产候选。
 * 这是 decision-draft 的注入点，不是第二套提炼规则——配对、去重、注入过滤仍由那边做。
 * 真正的提炼器（会话 → 现象 / 意图 / 放弃的方案）随后接入；在那之前，
 * 宁可少提议，也不要把每句提问都摊成一条候选。
 */
const DECISION_MARKERS =
  /(?:不要|不用|不再|别再|放弃|改用|换成|改成|统一|决定|就按|保留|删掉|去掉|拆开|合并|采用|不引入|不加|不做|只要|只留)/u;

export function heuristicExtract(pair) {
  const text = flatText(pair?.user?.text);
  if (text.length < 4) return null;
  // 提问不是取舍：句末问号直接排除。
  if (/[?？]$/u.test(text)) return null;
  if (!DECISION_MARKERS.test(text)) return null;
  // 理由不从这里挖：取样里只有约一成原话自带理由，缺理由由确认时补。
  return { phenomenon: text, intent: '', abandoned: '', reason: '' };
}

const isSessionFile = (name) => /\.jsonl$/u.test(name) || /\.jsonl\.zst$/u.test(name);

/** 递归列出会话文件；目录不存在或不可读时按 0 段处理，不抛错。 */
const listSessionFiles = async (dir) => {
  const found = [];
  const walk = async (current) => {
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.isFile() && isSessionFile(entry.name)) found.push(full);
    }
  };
  await walk(dir);
  return found;
};

/** 读出文件开头；压缩文件没法只读开头，返回 null 由调用方整份解。 */
const readHead = async (file, bytes) => {
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
};

const TOO_LARGE = Symbol('too large');

/**
 * 整份读出会话文件。
 * .jsonl.zst 用 node 内置 zstd 解压；解压结果仍要受大小上限约束，
 * 压缩比很高的文件不能靠几 KB 的压缩体积绕过上限。
 */
const readWhole = async (file, maxBytes) => {
  const buffer = await fs.promises.readFile(file);
  if (!/\.zst$/u.test(file)) return buffer.toString('utf8');
  if (typeof zlib.zstdDecompressSync !== 'function') return TOO_LARGE;
  try {
    return zlib.zstdDecompressSync(buffer, { maxOutputLength: maxBytes * 8 }).toString('utf8');
  } catch (error) {
    if (error?.code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError) return TOO_LARGE;
    throw error;
  }
};

/**
 * 一段会话的会话键：来源 + 会话 id（或文件路径）+ 文件大小。
 * 带上大小是因为正在进行的会话还在往同一个文件里追加：内容变了就是新的一段，
 * 同一份内容才不重复提炼；重复问答由决策指纹兜第二层。
 */
const sessionKeyOf = (source, meta, entry) =>
  `${source}:${meta.sessionId || entry.file}@${entry.size}`;

/**
 * 扫描会话：读 → 匹配 → 提炼。
 *
 * @param {object} input
 * @param {{source: string, dir: string}[]} [input.roots] 会话根目录（见 sessionRootsFrom）
 * @param {{id: string, name?: string, root: string}[]} [input.projects] 已登记项目
 * @param {(pair: object) => object|null} [input.extract] 注入的提炼器；传 null 表示只要原话
 * @param {Iterable<string>} [input.seenSessions] 之前扫过的会话键，命中即跳过
 * @param {Iterable<string>} [input.fingerprints] 已有决策指纹，命中即跳过
 * @returns {Promise<object>} 计数、丢弃原因、匹配到的会话、候选样本与回写用的键
 */
export async function scanSessions({
  roots = [],
  projects = [],
  extract = heuristicExtract,
  seenSessions = [],
  fingerprints = [],
  maxSessions = DEFAULTS.maxSessions,
  maxBytes = DEFAULTS.maxBytes,
  maxFragments = DEFAULTS.maxFragments,
  maxCandidateSample = DEFAULTS.maxCandidateSample,
  maxSkippedFiles = DEFAULTS.maxSkippedFiles
} = {}) {
  const seen = new Set(seenSessions instanceof Set ? seenSessions : Array.from(seenSessions ?? []));
  const known = new Set(fingerprints instanceof Set ? fingerprints : Array.from(fingerprints ?? []));
  const skipped = { tools: 0, reasoning: 0, nonConversation: 0, injected: 0, duplicate: 0, existing: 0 };
  const dropped = {
    unmatchedCwd: 0,
    missingCwd: 0,
    unreadable: 0,
    tooLarge: 0,
    emptyConversation: 0
  };
  const counts = {
    files: 0,
    matched: 0,
    alreadyScanned: 0,
    dropped: 0,
    truncated: 0,
    fragments: 0,
    candidates: 0,
    skipped
  };
  const sessions = [];
  const skippedFiles = [];
  const candidates = [];
  const scannedKeys = [];

  const drop = (entry, reason) => {
    dropped[reason]++;
    counts.dropped++;
    if (skippedFiles.length < maxSkippedFiles) {
      skippedFiles.push({
        source: entry.source,
        path: entry.file,
        reason,
        label: DROP_REASON_LABELS[reason] ?? reason
      });
    }
  };

  // 先把所有来源的文件摊平并按修改时间倒序：最近改过的会话先扫，
  // 这样「上限」截断时丢掉的是最不新鲜的，而不是随机的一半。
  const discovered = [];
  for (const root of Array.isArray(roots) ? roots : []) {
    const source = String(root?.source ?? '');
    if (source !== 'codex' && source !== 'claude') continue;
    for (const file of await listSessionFiles(String(root?.dir ?? ''))) {
      try {
        const info = await fs.promises.stat(file);
        discovered.push({ source, file, size: info.size, mtime: info.mtimeMs });
      } catch {
        discovered.push({ source, file, size: 0, mtime: 0, unreadable: true });
      }
    }
  }
  discovered.sort((a, b) => (b.mtime - a.mtime) || a.file.localeCompare(b.file));
  const considered = discovered.slice(0, Math.max(0, maxSessions));
  counts.truncated = discovered.length - considered.length;

  for (const entry of considered) {
    counts.files++;
    if (entry.unreadable) {
      drop(entry, 'unreadable');
      continue;
    }
    if (entry.size > maxBytes) {
      drop(entry, 'tooLarge');
      continue;
    }

    const compressed = /\.zst$/u.test(entry.file);
    let text = null;
    let whole = null;
    try {
      // 压缩文件必须整份解；普通 JSONL 先只读开头，匹配不上就不必读正文。
      if (compressed) {
        whole = await readWhole(entry.file, maxBytes);
        if (whole === TOO_LARGE) {
          drop(entry, 'tooLarge');
          continue;
        }
        text = whole;
      } else {
        text = await readHead(entry.file, Math.min(HEAD_BYTES, Math.max(maxBytes, 1)));
      }
    } catch {
      drop(entry, 'unreadable');
      continue;
    }

    let meta = readSessionMeta(entry.source, text);
    // 开头里没找到 cwd：只有未压缩、且文件比开头更长时才回退读整份。
    if (!meta && !compressed && entry.size > Buffer.byteLength(text, 'utf8')) {
      try {
        whole = await readWhole(entry.file, maxBytes);
        if (whole === TOO_LARGE) {
          drop(entry, 'tooLarge');
          continue;
        }
        text = whole;
        meta = readSessionMeta(entry.source, text);
      } catch {
        drop(entry, 'unreadable');
        continue;
      }
    }
    if (!meta) {
      drop(entry, 'missingCwd');
      continue;
    }

    const project = matchProjectForCwd(meta.cwd, projects);
    if (!project) {
      drop(entry, 'unmatchedCwd');
      continue;
    }

    const key = sessionKeyOf(entry.source, meta, entry);
    if (seen.has(key)) {
      counts.alreadyScanned++;
      continue;
    }

    // 开头就读到了整份文件（文件小于一个 header）时不必再读一次。
    if (!whole && entry.size <= Buffer.byteLength(text, 'utf8')) whole = text;

    // 读正文成功后才记「扫过」：读失败（太大、被锁住）的会话下次还该重试，
    // 会话文件还在追加时大小会变，键也随之变，所以不会把后续内容漏掉。
    if (!whole) {
      try {
        whole = await readWhole(entry.file, maxBytes);
        if (whole === TOO_LARGE) {
          drop(entry, 'tooLarge');
          continue;
        }
        text = whole;
      } catch {
        drop(entry, 'unreadable');
        continue;
      }
    }
    seen.add(key);
    scannedKeys.push(key);

    const fragments = readSessionFragments(entry.source, text, skipped);
    if (fragments.length === 0) {
      drop(entry, 'emptyConversation');
      continue;
    }
    const used = fragments.slice(0, Math.max(1, maxFragments));

    // 提炼规则全在 decision-draft.mjs：这里只给项目、片段、已有指纹和注入的提炼器。
    const draft = draftDecisions({
      projectId: String(project.id ?? ''),
      sessionId: meta.sessionId,
      fragments: used,
      fingerprints: known,
      extract
    });
    skipped.injected += draft.skipped.injected;
    skipped.duplicate += draft.skipped.duplicate;
    skipped.existing += draft.skipped.existing;

    // 真正参与配对的片段数：注入块与非对话条目在提炼层被挡下，不该算进「读到多少正文」。
    const refined = Math.max(0, used.length - draft.skipped.injected - draft.skipped.ignored);
    counts.fragments += refined;

    for (const candidate of draft.candidates) {
      // 同一轮里也去重：指纹进 known，后一段会话说同一句话不会再多出一条。
      known.add(candidate.fingerprint);
      candidates.push({
        ...candidate,
        source: entry.source,
        sessionPath: entry.file,
        projectName: String(project.name ?? '')
      });
    }

    counts.matched++;
    sessions.push({
      key,
      source: entry.source,
      sessionId: meta.sessionId,
      projectId: String(project.id ?? ''),
      projectName: String(project.name ?? ''),
      cwd: meta.cwd,
      path: entry.file,
      fragments: refined,
      candidates: draft.candidates.length
    });
  }

  counts.candidates = candidates.length;
  const droppedReasons = Object.entries(dropped)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => ({ key, count, label: DROP_REASON_LABELS[key] ?? key }))
    .sort((a, b) => b.count - a.count);

  return {
    counts,
    dropped,
    droppedReasons,
    sessions,
    skippedFiles,
    // 界面只预览前若干条；条数以 counts.candidates 为准。
    candidates: candidates.slice(0, Math.max(0, maxCandidateSample)),
    candidatesTruncated: candidates.length > maxCandidateSample,
    fingerprints: candidates.map((candidate) => candidate.fingerprint),
    scannedKeys,
    truncated: counts.truncated,
    // 空 = 这一轮一条候选都没有（扫出 0 条时界面要能解释，而不是像坏了）。
    empty: candidates.length === 0
  };
}
