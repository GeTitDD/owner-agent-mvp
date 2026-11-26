// #115 项目目录写入：判定 → 确认卡 → 按会话授权写入 → 回执（或取消后证明没写）。
//
// ADR-0012：写被观察的项目目录默认禁止，要写就一次一申请；授权与会话绑定，换会话重置。
// 这条规则只有一份（src/write-gate.mjs），本文件不抄第二套判定，只做「这次同步」的
// 四段流水线：
//
//   ① 触发：只有明确的「同步到项目目录」动作才走这条路（命令 /同步到项目），
//      普通聊天与自有目录写入不因此多一次确认；
//   ② 清单：每份文档一条完整路径，逐条列出、不合并、不省略；路径必须落在项目根下；
//   ③ 授权：项目目录的授权按会话记（键是会话 id），换会话就是换了一份入参，
//      新会话查不到授权，于是再次要求确认；
//   ④ 回执：写成给「路径 + 字节数 + 是否进 git 工作区」，取消给「未写入」。
//
// 本文件是纯函数：不读盘、不联网、不读环境变量、不调模型。真正落盘由调用方注入的
// write 完成（桌面端是主进程的 companion:project-sync-write），所以测试不用临时目录。

import { writeGate } from './write-gate.mjs';

export class ProjectWriteError extends Error {
  constructor(message, code = 'project_write_invalid') {
    super(message);
    this.name = 'ProjectWriteError';
    this.code = code;
  }
}

/** 「同步到项目目录」的命令与别名；只有这两个前缀触发写确认。 */
export const PROJECT_SYNC_COMMAND = '/同步到项目';
export const PROJECT_SYNC_ALIAS = '/sync-project';
const COMMAND_PATTERN = /^\/(?:同步到项目|sync-project)(?:\s+([\s\S]*))?$/u;

/** 默认落点：项目里的 docs/notes，不往仓库根目录扔文件。 */
export const PROJECT_NOTE_DIR = 'docs/notes';

const listOf = (value) => (Array.isArray(value) ? value : []);

const stampOf = (value) => String(value ?? '').trim() || new Date().toISOString();

/** UTF-8 字节数：回执里的「字节数」按落盘字节算，不按字符数算。 */
const utf8Bytes = (text) => new TextEncoder().encode(String(text ?? '')).length;

/**
 * 解析「同步到项目目录」命令。
 *
 * 语法：`/同步到项目`，可选跟一句文档标题（写成 `docs/notes/<标题>.md`）。其余输入返回
 * null，所以这条命令不会误吃掉正常聊天，也不会把普通写入变成确认。
 *
 * @param {unknown} input
 * @returns {{kind: 'project-sync', title: string} | null}
 */
export function parseProjectSyncCommand(input) {
  const match = COMMAND_PATTERN.exec(String(input ?? '').trim());
  if (!match) return null;
  return { kind: 'project-sync', title: String(match[1] ?? '').trim() };
}

export const isProjectSyncCommand = (input) => parseProjectSyncCommand(input) !== null;

/**
 * 文件名主体：只去掉路径分隔符与 Windows 不允许的字符，中文保留（文档标题本来就该可读）。
 * 没有标题就用会话 id 的前一段；两者都没有时用固定的 note，绝不返回空串。
 */
export function noteSlugOf({ title, sessionId } = {}) {
  const cleaned = String(title ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 60);
  if (cleaned) return cleaned;
  const id = String(sessionId ?? '').trim().replace(/[^a-zA-Z0-9_-]+/gu, '');
  return id ? id.slice(0, 12) : 'note';
}

/**
 * 这次会话的笔记文档：标题 + 一行来源（会话与时间）+ 正文。
 * 内容由调用方给（桌面端用既有的消息 → Markdown 能力算），这里只决定路径与包装。
 */
export function sessionNoteDoc({ sessionId, title, markdown, at } = {}) {
  const heading = String(title ?? '').trim() || '会话笔记';
  const body = String(markdown ?? '').trim();
  return {
    relativePath: `${PROJECT_NOTE_DIR}/${noteSlugOf({ title, sessionId })}.md`,
    content: `# ${heading}\n\n> 同步自会话 ${String(sessionId ?? '').trim() || '（未知）'} · ${stampOf(at)}\n\n${body}\n`
  };
}

/**
 * 相对路径 → 项目根下的完整路径。
 *
 * 只接受项目内的相对路径：绝对路径、盘符与 `..` 一律拒绝——确认卡上写的路径必须就是
 * 落盘的位置，不能让「看起来在项目里」的路径写到外面去。
 *
 * @param {string} root 项目根目录
 * @param {string} relativePath 项目内相对路径（`\` 与 `/` 都接受）
 * @returns {string} 完整路径（分隔符跟随 root）
 */
export function resolveUnderRoot(root, relativePath) {
  const base = String(root ?? '').trim();
  if (!base) throw new ProjectWriteError('项目根目录为空：不知道要同步到哪里。', 'root_missing');
  const rel = String(relativePath ?? '').trim().replace(/\\/gu, '/');
  if (!rel) throw new ProjectWriteError('有一份文档没有目标路径：不能猜一个位置写进去。', 'path_missing');
  if (rel.startsWith('/') || /^[a-zA-Z]:/u.test(rel)) {
    throw new ProjectWriteError(`目标路径必须是项目内的相对路径：${rel}`, 'path_absolute');
  }
  const parts = rel.split('/').filter((part) => part && part !== '.');
  if (parts.length === 0) throw new ProjectWriteError(`目标路径为空：${rel}`, 'path_missing');
  if (parts.includes('..')) {
    throw new ProjectWriteError(`目标路径不能跳出项目目录：${rel}`, 'path_escape');
  }
  const sep = base.includes('\\') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/u, '')}${sep}${parts.join(sep)}`;
}

/**
 * 写入清单：每份文档一条，完整路径逐条保留。
 *
 * @param {object} input
 * @param {string} input.projectId
 * @param {string} [input.projectName]
 * @param {string} input.projectRoot
 * @param {Array<{relativePath?: string, path?: string, content?: string}>} input.docs
 * @returns {{projectId: string, projectName: string, root: string,
 *   files: Array<{relativePath: string, fullPath: string, bytes: number, content: string}>,
 *   paths: string[], totalBytes: number}}
 */
export function planProjectSync({ projectId, projectName = '', projectRoot, docs } = {}) {
  const root = String(projectRoot ?? '').trim();
  if (!root) throw new ProjectWriteError('项目根目录为空：不知道要同步到哪里。', 'root_missing');
  const files = [];
  const seen = new Set();
  for (const doc of listOf(docs)) {
    const relativePath = String(doc?.relativePath ?? doc?.path ?? '').trim().replace(/\\/gu, '/');
    const fullPath = resolveUnderRoot(root, relativePath);
    // 同一个目标写两次会互相覆盖：这属于「清单有问题」，在确认卡之前就拒绝。
    const key = fullPath.toLowerCase();
    if (seen.has(key)) throw new ProjectWriteError(`目标路径重复：${fullPath}`, 'path_duplicate');
    seen.add(key);
    const content = String(doc?.content ?? '');
    files.push({ relativePath, fullPath, bytes: utf8Bytes(content), content });
  }
  if (files.length === 0) {
    throw new ProjectWriteError('没有要写入的文档：这次不写任何文件。', 'docs_empty');
  }
  return {
    projectId: String(projectId ?? '').trim(),
    projectName: String(projectName ?? '').trim(),
    root,
    files,
    paths: files.map((file) => file.fullPath),
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0)
  };
}

// ── 会话授权 ────────────────────────────────────────────────────────
//
// 授权存成「会话 id → true」的普通对象，由调用方持有。重置不需要额外的 API：
// 换会话就是换 sessionId，查不到就是未授权；要显式收紧时用 resetProjectGrant。

/**
 * 这个会话有没有项目目录授权。只认严格 true，'true' / 1 之类不算（宁可多一次确认）。
 */
export function sessionHasGrant({ grants, sessionId } = {}) {
  const id = String(sessionId ?? '').trim();
  if (!id) return false;
  return grants?.[id] === true;
}

/** 记下「本次会话允许写项目目录」，返回新对象；不改原对象。 */
export function grantProject({ grants = {}, sessionId } = {}) {
  const id = String(sessionId ?? '').trim();
  if (!id) return { ...grants };
  return { ...grants, [id]: true };
}

/** 收回某个会话的授权（取消或显式重置时用），返回新对象。 */
export function resetProjectGrant({ grants = {}, sessionId } = {}) {
  const rest = { ...grants };
  delete rest[String(sessionId ?? '').trim()];
  return rest;
}

/**
 * 「这次同步要不要确认」——单一判定，复用 write-gate 的项目目录一行。
 *
 * @param {object} [input]
 * @param {string} [input.sessionId] 当前会话
 * @param {Record<string, boolean>} [input.grants] 会话授权表
 * @param {boolean} [input.deletes] 调用方声明本次是否含删除（默认不含）
 * @returns {{allowed: boolean, needsConfirm: boolean, denied: boolean, granted: boolean,
 *   gate: {outcome: 'allow'|'confirm'|'deny', reason: string, scope: string}}}
 */
export function projectWriteDecision({ sessionId, grants = {}, deletes = false } = {}) {
  const granted = sessionHasGrant({ grants, sessionId });
  const gate = writeGate({ destination: 'project', deletes, granted: { project: granted } });
  return {
    allowed: gate.outcome === 'allow',
    needsConfirm: gate.outcome === 'confirm',
    denied: gate.outcome === 'deny',
    granted,
    gate
  };
}

// ── 确认卡 ──────────────────────────────────────────────────────────

/**
 * 把写入清单与风险模型拼成一张确认卡（块模型与 #113 同一份：type=risk）。
 * 路径只从清单来，逐条完整传出，渲染层不再拆分或省略。
 *
 * @param {object} input
 * @param {object} input.plan planProjectSync 的输出
 * @param {object} input.risk risk-card 的 normalizeRisk / assessRisk 输出
 * @param {object} input.riskCard desktop/risk-card.cjs 的 API
 * @param {string} [input.id] 卡片 id（同一次同步固定，用于找回写入清单）
 * @param {string} [input.title]
 * @param {string} [input.conclusion]
 */
export function buildProjectSyncCard({ plan, risk, riskCard, id = 'project-sync', title, conclusion } = {}) {
  const paths = listOf(plan?.paths);
  if (paths.length === 0) throw new ProjectWriteError('没有可确认的目标路径。', 'paths_empty');
  if (!riskCard?.riskCardModelOf) {
    throw new ProjectWriteError('确认卡模块（desktop/risk-card.cjs）未加载。', 'risk_card_missing');
  }
  const name = plan?.projectName || plan?.projectId || '项目';
  return riskCard.riskCardModelOf(risk, {
    id,
    title: String(title ?? '').trim() || '同步文档到项目目录',
    conclusion: String(conclusion ?? '').trim()
      || `会把 ${paths.length} 份文档写进「${name}」的项目目录：影响项目级、可重建，但不离开本机。`,
    paths,
    destination: 'project',
    overrides: []
  });
}

// ── 回执 ────────────────────────────────────────────────────────────

/** git 工作区的三种回答；回执只回答「这次写的文件在不在里面」，不做别的推断。 */
const gitLabelOf = (git) => {
  if (!git) return '未检查';
  if (git.repo === false) return '否（不是 git 仓库）';
  const files = listOf(git.files);
  if (files.length === 0) return '否（git status 里没有这次写的文件）';
  return `是（${files.length} 个文件出现在 git status）`;
};

const destinationOf = (plan) => `项目目录 · ${plan?.projectName || plan?.projectId || '未命名项目'}`;

/**
 * 写入回执：成功给「路径 + 字节数 + git 工作区」，失败给原因（不只一句「失败」）。
 * 失败时也列出本来要写哪些路径，读者能对上范围。
 *
 * @returns {{text: string, blocks: object[]}}
 */
export function projectWriteReceipt({ plan, ok, writes = [], git = null, reason = '', at } = {}) {
  const stampText = stampOf(at);
  const files = listOf(ok ? writes : []);
  const totalBytes = files.reduce((sum, file) => sum + Number(file?.bytes ?? 0), 0);
  const rows = [
    ['目的地', destinationOf(plan)],
    ['判定', ok ? '项目目录 · 本次会话已授权 → 放行' : '项目目录 · 未写入'],
    ['写入', ok ? `${files.length} 个文件 · ${totalBytes} 字节` : '未写入（0 处）']
  ];
  if (ok) {
    // 逐条完整路径：不合并、不省略（验收面）。
    files.forEach((file, index) => {
      rows.push([
        `路径 ${index + 1}`,
        `${file?.fullPath ?? file?.relativePath ?? ''}（${Number(file?.bytes ?? 0)} 字节）`
      ]);
    });
    rows.push(['git 工作区', gitLabelOf(git)]);
    rows.push(['结果', '成功']);
  } else {
    listOf(plan?.paths).forEach((fullPath, index) => rows.push([`路径 ${index + 1}`, fullPath]));
    rows.push(['结果', '失败']);
    rows.push(['原因', String(reason ?? '').trim() || '没有给出原因']);
  }
  rows.push(['时间', stampText]);
  const detail = ok ? `已写入 ${files.length} 个文件（${totalBytes} 字节）` : '没有写成';
  return {
    text: ok
      ? `写入回执（项目目录）：${detail}到${destinationOf(plan)}；${gitLabelOf(git)}。`
      : `写入回执（项目目录）：${detail}：${String(reason ?? '').trim() || '没有给出原因'}`,
    blocks: [{
      type: 'kv',
      title: ok ? '写入回执 · 同步到项目目录' : '写入回执 · 同步到项目目录（失败）',
      rows
    }]
  };
}

/**
 * 取消回执：写「未写入 0 处」并逐条列出没写的路径，避免「后台偷偷做了」的怀疑。
 * 文件系统前后一致由调用方（e2e 用目录快照）证明，回执只把范围说清楚。
 */
export function projectCancelReceipt({ plan, paths = [], at } = {}) {
  const targets = listOf(plan?.paths?.length ? plan.paths : paths);
  const rows = [
    ['目的地', destinationOf(plan)],
    ['写入', '未写入（0 处）'],
    ...targets.map((fullPath, index) => [`路径 ${index + 1}`, fullPath]),
    ['结果', '已取消 · 文件系统没有变化'],
    ['时间', stampOf(at)]
  ];
  return {
    text: `已取消：${targets.length} 个目标路径一个都没写，项目目录保持原样。`,
    blocks: [{ type: 'kv', title: '未写入 · 同步到项目目录', rows }]
  };
}

// ── 统一入口 ────────────────────────────────────────────────────────

/**
 * 判定 → 写入 → 回执。
 *
 * 三种结局：
 * - 未授权 / 声明删除：`blocked: true`、`receipt: null`，交给确认卡，不在这里执行；
 * - 已授权：调用注入的 write，成功与失败都留回执；
 * - 清单为空或缺写入实现：不写，也给失败回执（不静默）。
 *
 * @param {object} input
 * @param {string} [input.sessionId]
 * @param {Record<string, boolean>} [input.grants]
 * @param {object} input.plan planProjectSync 的输出
 * @param {(payload: {projectId: string, projectRoot: string, files: object[]}) => Promise<object>} [input.write]
 * @param {string} [input.at] 时间（测试可固定）
 */
export async function runProjectSync({ sessionId, grants = {}, plan, write, at } = {}) {
  const decision = projectWriteDecision({ sessionId, grants, deletes: false });
  const base = {
    ok: false,
    blocked: !decision.allowed,
    needsConfirm: decision.needsConfirm,
    decision,
    receipt: null
  };
  if (!decision.allowed) return base;

  const fail = (reason) => ({
    ...base,
    blocked: false,
    receipt: projectWriteReceipt({ plan, ok: false, reason, at })
  });
  if (listOf(plan?.files).length === 0) return fail('没有要写入的文档，这次什么都没写。');
  if (typeof write !== 'function') return fail('没有可用的写入实现，这次什么都没写。');

  try {
    const outcome = await write({
      projectId: plan.projectId,
      projectRoot: plan.root,
      files: plan.files
    });
    // 实际字节数从写入结果取；结果没给就退回清单里的值，避免回执里出现 0 字节。
    const actual = listOf(outcome?.files);
    const writes = plan.files.map((file) => {
      const hit = actual.find((item) => String(item?.relativePath ?? '').replace(/\\/gu, '/')
        === file.relativePath);
      return {
        relativePath: file.relativePath,
        fullPath: hit?.fullPath ?? file.fullPath,
        bytes: Number.isFinite(Number(hit?.bytes)) ? Number(hit.bytes) : file.bytes
      };
    });
    return {
      ...base,
      ok: true,
      receipt: projectWriteReceipt({ plan, ok: true, writes, git: outcome?.git ?? null, at })
    };
  } catch (error) {
    // 失败必须带原因回到流里：不吞异常，也不假装写成功。
    return fail(String(error?.message ?? error ?? '').trim() || '未知原因');
  }
}
