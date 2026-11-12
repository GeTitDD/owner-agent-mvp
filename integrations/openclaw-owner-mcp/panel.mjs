// Owner 的 Telegram 面板：把原来 Cindy 里的 Owner 页签全部搬到聊天里。
//
// 设计：
// - 面板消息由本模块直接用 Bot API 发送/编辑（和 OpenClaw 共用同一个 bot，
//   发送消息不会和它的 getUpdates 轮询冲突）；
// - 按钮的 callback_data 统一是 `owner:<action>:<arg>`；OpenClaw 收到
//   callback_query 后会把它转成一条 `callback_data: owner:...` 的文本消息，
//   由 Agent 调 owner_panel({callback}) 回到这里；
// - 需要输入文本的地方（新增想法、加项目、自定义测试命令）走「等输入」状态：
//   面板记下 pending，Agent 把用户下一条文本用 owner_panel({text}) 传回来；
// - 应用补丁、创建 PR 这类危险操作要二次确认，确认按钮带 2 分钟有效期；
// - 数据仍然来自本机 worker / owner.json，不复制、不上传。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { renderPng } from './diagrams.mjs';
import { renderMermaidPng } from './mermaid.mjs';
import {
  isConfirmFresh,
  nextIdeaStatus,
  paginate,
  parseCallback,
  summarizeDiff,
  formatFileList
} from './panel-core.mjs';

const MAX_TEXT = 3800;
const IDEAS_PER_PAGE = 5;
const KNOWLEDGE_PER_PAGE = 4;
const PATCHES_PER_PAGE = 3;
const PENDING_TTL_MS = 2 * 60 * 1000;

const panelDir = process.env.OWNER_COMPANION_DIR || path.join(os.homedir(), '.owner-companion');
const stateFile = path.join(panelDir, 'telegram-panel.json');

// WSL 启动 Windows exe 时不会自动继承环境变量；优先读同目录下的 telegram.json。
const fileConfig = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(panelDir, 'telegram.json'), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
})();

const BOT_TOKEN = String(process.env.OWNER_TELEGRAM_BOT_TOKEN || fileConfig.botToken || '').trim();
const DEFAULT_CHAT_ID = String(process.env.OWNER_TELEGRAM_CHAT_ID || fileConfig.chatId || '').trim();
const PROXY = String(process.env.OWNER_TELEGRAM_PROXY || fileConfig.proxy || '').trim();
const API = 'https://api.telegram.org';

const clip = (value, max = MAX_TEXT) => {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const nowIso = () => new Date().toISOString();

// ---- 状态文件 ----

const readState = () => {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return raw && typeof raw === 'object' ? raw : { chats: {} };
  } catch {
    return { chats: {} };
  }
};

const writeState = (state) => {
  try {
    fs.mkdirSync(panelDir, { recursive: true });
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  } catch {
    // 面板状态写失败不影响消息本身。
  }
};

// ---- Telegram Bot API ----

const runCurlOnce = (args) => new Promise((resolve, reject) => {
  const full = ['-sS', '-m', '25', ...(PROXY ? ['-x', PROXY] : []), ...args];
  execFile('curl.exe', full, { windowsHide: true }, (error, stdout, stderr) => {
    if (error) {
      reject(new Error(String(stderr || error.message).slice(0, 300)));
      return;
    }
    resolve(stdout);
  });
});

// Clash 偶发 TLS 握手失败：失败后隔 700ms 重试一次。
const runCurl = async (args) => {
  try {
    return await runCurlOnce(args);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 700));
    return runCurlOnce(args);
  }
};

const callApi = async (method, fields) => {
  const args = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    args.push('--data-urlencode', `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
  const output = await runCurl([...args, `${API}/bot${BOT_TOKEN}/${method}`]);
  let data = null;
  try { data = JSON.parse(output); } catch { throw new Error(`Telegram 返回异常：${output.slice(0, 200)}`); }
  if (!data.ok) throw new Error(data.description || 'Telegram 调用失败');
  return data.result;
};

const replyKeyboard = (rows) => ({ inline_keyboard: rows });

const sendPanel = async (chatId, text, rows) => {
  const result = await callApi('sendMessage', {
    chat_id: chatId,
    text: clip(text),
    disable_web_page_preview: true,
    reply_markup: replyKeyboard(rows)
  });
  return result.message_id;
};

const editPanel = async (chatId, messageId, text, rows) => {
  try {
    await callApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: clip(text),
      disable_web_page_preview: true,
      reply_markup: replyKeyboard(rows)
    });
    return messageId;
  } catch (error) {
    if (/not modified/i.test(String(error.message))) return messageId;
    // 消息太旧或不可编辑时重新发一条。
    return sendPanel(chatId, text, rows);
  }
};

const sendPhoto = async (chatId, pngBuffer, caption, rows) => {
  const dir = path.join(os.tmpdir(), 'owner-companion');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `diagram-${chatId}-${Date.now()}.png`);
  fs.writeFileSync(file, pngBuffer);
  try {
    const args = [
      '-F', `chat_id=${chatId}`,
      '-F', `photo=@${file}`,
      '-F', `caption=${clip(caption, 900)}`
    ];
    if (rows) args.push('-F', `reply_markup=${JSON.stringify(replyKeyboard(rows))}`);
    const output = await runCurl([...args, `${API}/bot${BOT_TOKEN}/sendPhoto`]);
    const data = JSON.parse(output);
    if (!data.ok) throw new Error(data.description || '发送图片失败');
    return data.result.message_id;
  } finally {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
};

const sendMediaGroup = async (chatId, items) => {
  if (!items.length) return [];
  const dir = path.join(os.tmpdir(), 'owner-companion');
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  const media = [];
  try {
    items.slice(0, 10).forEach((item, index) => {
      const file = path.join(dir, `diagram-${chatId}-${Date.now()}-${index}.png`);
      fs.writeFileSync(file, item.png);
      files.push(file);
      media.push({
        type: 'photo',
        media: `attach://photo${index}`,
        caption: clip(item.caption || '', 900)
      });
    });
    const args = ['-F', `chat_id=${chatId}`, '-F', `media=${JSON.stringify(media)}`];
    files.forEach((file, index) => args.push('-F', `photo${index}=@${file}`));
    const output = await runCurl([...args, `${API}/bot${BOT_TOKEN}/sendMediaGroup`]);
    const data = JSON.parse(output);
    if (!data.ok) throw new Error(data.description || '发送图片组失败');
    return (data.result || []).map((message) => message.message_id).filter(Boolean);
  } finally {
    files.forEach((file) => { try { fs.unlinkSync(file); } catch { /* ignore */ } });
  }
};

const deleteMessages = async (chatId, messageIds) => {
  if (!messageIds?.length) return;
  try {
    await callApi('deleteMessages', { chat_id: chatId, message_ids: JSON.stringify(messageIds) });
  } catch {
    // 过期或已删除时忽略。
  }
};

const deleteMessage = async (chatId, messageId) => {
  if (!messageId) return;
  try {
    await callApi('deleteMessage', { chat_id: chatId, message_id: messageId });
  } catch {
    // 同上。
  }
};

// ---- 文案 ----

const STATUS_LABEL = {
  todo: '待讨论', doing: '进行中', blocked: '受阻', done: '已完成', failed: '失败',
  proposed: '待审核', unverified: '未验证', verified: '已验证', rejected: '已拒绝',
  pending: '待审核', applied: '已应用'
};

const DIAGRAM_LABEL = {
  dependency: '依赖图', control: '控制流', dataflow: '数据流', sequence: '时序图', state: '状态机'
};

const statusLabel = (status) => STATUS_LABEL[status] || status || '未知';

const formatOverview = (overview) => {
  const project = overview.project || {};
  const counts = overview.knowledge || {};
  const lines = [];
  lines.push(`📁 ${project.name || project.id || '项目'}`);
  if (overview.brief?.oneLiner) lines.push(clip(overview.brief.oneLiner, 220));
  if (overview.nextAction?.title) {
    lines.push('');
    lines.push(`👉 下一步：${overview.nextAction.title}`);
    if (overview.nextAction.detail) lines.push(`   ${clip(overview.nextAction.detail, 120)}`);
  }
  lines.push('');
  lines.push(`想法 ${overview.ideas?.length ?? 0} · 知识 ${counts.knowledge ?? 0} · 待审核 ${counts.candidates ?? 0}`);
  if (overview.brief?.stale) lines.push('⚠️ 画像有更新，建议「重新扫描」');
  return lines.join('\n');
};

const backRow = (projectId, extra = []) => [
  ...extra,
  { text: '返回', callback_data: `owner:overview:${projectId}` }
];

// 这些动作的参数不是项目 id（是页码或条目 id），不能拿来当项目用。
const NON_PROJECT_ARG = new Set([
  'ideaspage', 'kpage', 'patchpage',
  'ideacycle', 'ideadel',
  'kaccept', 'kreject', 'kverify',
  'dselect', 'patch', 'papply', 'papplyreject'
]);

// ---- 面板 ----

export const createPanel = ({ callWorker }) => {
  const chatState = (chatId) => {
    const state = readState();
    state.chats ||= {};
    state.chats[chatId] ||= {};
    return { state, entry: state.chats[chatId] };
  };

  const saveEntry = (state, chatId, entry) => {
    state.chats ||= {};
    state.chats[chatId] = entry;
    writeState(state);
  };

  const resolveProject = async (chatId, projectId) => {
    if (projectId) return projectId;
    const { state, entry } = chatState(chatId);
    if (entry.projectId) return entry.projectId;
    const list = await callWorker('owner/projects/list', {}, 15000);
    const first = list.projects?.[0]?.id || '';
    if (first) {
      entry.projectId = first;
      saveEntry(state, chatId, entry);
    }
    return first;
  };

  /** 图：先 Mermaid CLI，再自绘 SVG，都失败返回 null。 */
  const renderDiagram = async (diagram, kind) => {
    const png = (await renderMermaidPng(diagram.mermaid)) || renderPng(diagram.kind || kind, diagram.data);
    return png || null;
  };

  /** 后台跑测试：先回一句「已开始」，跑完再单发结果。 */
  const startTestRun = async (chatId, projectId, command) => {
    const { state, entry } = chatState(chatId);
    if (entry.testRunning) return { started: false, error: '上一次测试还在运行' };
    entry.testRunning = { command, at: nowIso() };
    saveEntry(state, chatId, entry);

    const label = command || 'npm test';
    callWorker('owner/tests/run', { projectId, command: command || '' }, 240000)
      .then(async (result) => {
        const head = result.ok ? '✅ 测试通过' : '❌ 测试失败';
        const body = clip(String(result.output || '').split('\n').slice(-12).join('\n'), 1200);
        await sendPanel(
          chatId,
          `${head}\n${result.command} · ${result.durationMs}ms\n\n\`\`\`\n${body}\n\`\`\``,
          [[{ text: '🧪 返回测试页', callback_data: `owner:tests:${projectId}` }]]
        );
      })
      .catch(async (error) => {
        await sendPanel(chatId, `⚠️ 测试没跑起来：${clip(error?.message ?? error, 300)}`, [
          [{ text: '🧪 返回测试页', callback_data: `owner:tests:${projectId}` }]
        ]).catch(() => {});
      })
      .finally(() => {
        const fresh = chatState(chatId);
        delete fresh.entry.testRunning;
        saveEntry(fresh.state, chatId, fresh.entry);
      });

    return { started: true, command: label };
  };

  const show = async (chatId, action, arg) => {
    const { state, entry } = chatState(chatId);
    // 只要这次是「点按钮」而不是在等输入，就认为上一条输入提示已经作废，
    // 免得旧状态把后面一句普通聊天当成想法存进去。
    if (entry.pending) {
      entry.pending = null;
      saveEntry(state, chatId, entry);
    }
    const update = async (text, rows) => {
      const messageId = entry.messageId
        ? await editPanel(chatId, entry.messageId, text, rows)
        : await sendPanel(chatId, text, rows);
      entry.messageId = messageId;
      saveEntry(state, chatId, entry);
      return messageId;
    };

    // ---- 通用二次确认 ----
    if (action === 'cancel') {
      entry.confirm = null;
      saveEntry(state, chatId, entry);
      return show(chatId, 'overview', entry.projectId);
    }

    if (action === 'confirmok') {
      const confirm = entry.confirm;
      entry.confirm = null;
      saveEntry(state, chatId, entry);
      if (!isConfirmFresh(confirm)) {
        await update('确认已超时，请重新点一次。', [
          [{ text: '返回', callback_data: `owner:overview:${entry.projectId || ''}` }]
        ]);
        return { ok: false, error: '确认已超时' };
      }
      if (confirm.type === 'apply') {
        // 应用补丁可能比较慢，后台跑，避免 MCP 调用超时把结果吞掉。
        await update('⏳ 正在应用补丁…', []);
        callWorker('owner/patches/apply', { id: confirm.id }, 180000)
          .then(async () => {
            await sendPanel(chatId, `✅ 补丁已应用：${clip(confirm.title || confirm.id, 80)}`, []);
            await show(chatId, 'patches', confirm.projectId);
          })
          .catch(async (error) => {
            await sendPanel(chatId, `❌ 应用失败：${clip(error?.message ?? error, 300)}`, []).catch(() => {});
            await show(chatId, 'patches', confirm.projectId).catch(() => {});
          });
        return { ok: true, screen: 'applying' };
      }
      if (confirm.type === 'ideadel') {
        await callWorker('owner/ideas/remove', { id: confirm.id }, 30000);
        return show(chatId, 'ideas', confirm.projectId);
      }
      if (confirm.type === 'projdel') {
        await callWorker('owner/projects/remove', { id: confirm.id }, 30000);
        return show(chatId, 'menu');
      }
      if (confirm.type === 'pr') {
        // 推分支 + 建 PR 也可能是几十秒，同样后台跑。
        await update('⏳ 正在创建草稿 PR…', []);
        callWorker('owner/github/pr/create', {
          projectId: confirm.projectId,
          base: confirm.base || 'main',
          title: confirm.title || '',
          body: confirm.body || '',
          confirm: true
        }, 180000)
          .then(async (result) => {
            await sendPanel(chatId, `🌿 草稿 PR 已创建\n${clip(result.url || '', 300)}`, []);
            await show(chatId, 'github', confirm.projectId);
          })
          .catch(async (error) => {
            await sendPanel(chatId, `❌ 创建 PR 失败：${clip(error?.message ?? error, 300)}`, []).catch(() => {});
            await show(chatId, 'github', confirm.projectId).catch(() => {});
          });
        return { ok: true, screen: 'creating-pr' };
      }
      return show(chatId, 'overview', entry.projectId);
    }

    // ---- 项目列表 ----
    if (action === 'menu' || !action) {
      const list = await callWorker('owner/projects/list', {}, 15000);
      const projects = list.projects || [];
      if (!projects.length) {
        await update('还没有登记项目。点下面添加一个项目目录。', [
          [{ text: '➕ 添加项目', callback_data: 'owner:projadd' }],
          [{ text: '🔄 刷新', callback_data: 'owner:menu' }]
        ]);
        return { ok: true, screen: 'menu' };
      }
      const rows = [];
      for (let index = 0; index < projects.length; index += 2) {
        rows.push(projects.slice(index, index + 2).map((project) => ({
          text: project.name || project.id,
          callback_data: `owner:open:${project.id}`
        })));
      }
      rows.push([{ text: '➕ 添加项目', callback_data: 'owner:projadd' }, { text: '🔄 刷新', callback_data: 'owner:menu' }]);
      await update(`Owner · 共 ${projects.length} 个项目\n选一个项目：`, rows);
      return { ok: true, screen: 'menu' };
    }

    if (action === 'open') {
      entry.projectId = String(arg || '');
      entry.messageId = 0;
      entry.ideaPage = 0;
      entry.knowledgePage = 0;
      entry.patchPage = 0;
      entry.selected = [];
      saveEntry(state, chatId, entry);
      return show(chatId, 'overview', entry.projectId);
    }

    const projectId = await resolveProject(chatId, NON_PROJECT_ARG.has(action) ? '' : arg);
    if (!projectId) return show(chatId, 'menu');
    entry.projectId = projectId;
    saveEntry(state, chatId, entry);

    // ---- 概览 ----
    if (action === 'overview') {
      const overview = await callWorker('owner/projects/overview', { projectId }, 20000);
      const rows = [
        [
          { text: '想法', callback_data: `owner:ideas:${projectId}` },
          { text: '知识', callback_data: `owner:knowledge:${projectId}` },
          { text: '图表', callback_data: `owner:diagrams:${projectId}` }
        ],
        [
          { text: 'GitHub', callback_data: `owner:github:${projectId}` },
          { text: '测试', callback_data: `owner:tests:${projectId}` },
          { text: '补丁', callback_data: `owner:patches:${projectId}` }
        ],
        [
          { text: '重新扫描', callback_data: `owner:scan:${projectId}` },
          { text: '项目', callback_data: 'owner:projects' },
          { text: '切换项目', callback_data: 'owner:menu' }
        ]
      ];
      await update(`${formatOverview(overview)}\n\n点下面的按钮切换：`, rows);
      return { ok: true, screen: 'overview' };
    }

    if (action === 'scan') {
      // 扫描可能很慢，先回「进行中」，扫完再刷新概览。
      await update('⏳ 正在重新扫描项目…', []);
      callWorker('owner/brief/refresh', { projectId }, 240000)
        .then(() => show(chatId, 'overview', projectId))
        .catch(async (error) => {
          await update(`扫描失败：${clip(error?.message ?? error, 200)}`, [backRow(projectId)]).catch(() => {});
        });
      return { ok: true, screen: 'scanning' };
    }

    // ---- 想法 ----
    if (action === 'ideas' || action === 'ideaspage') {
      const page = action === 'ideaspage' ? Number(arg) || 0 : 0;
      entry.ideaPage = page;
      saveEntry(state, chatId, entry);
      const list = await callWorker('owner/ideas/list', { projectId }, 15000);
      const all = list.ideas || [];
      const slice = paginate(all, page, IDEAS_PER_PAGE);
      const lines = all.length
        ? [`💡 想法 ${slice.total} 条 · 第 ${slice.page + 1}/${slice.pages} 页`, '']
        : ['💡 还没有想法。点「➕ 新增」后直接发消息。'];
      for (const idea of slice.items) {
        lines.push(`• ${clip(idea.title, 60)} · ${statusLabel(idea.status)}`);
      }
      if (all.length) lines.push('', '点标题切换状态，🗑 删除。');
      const rows = slice.items.map((idea) => ([
        { text: `• ${clip(idea.title, 22)} · ${statusLabel(idea.status)}`, callback_data: `owner:ideacycle:${idea.id}` },
        { text: '🗑', callback_data: `owner:ideadel:${idea.id}` }
      ]));
      const nav = [];
      if (slice.hasPrev) nav.push({ text: '◀', callback_data: `owner:ideaspage:${slice.page - 1}` });
      nav.push({ text: '➕ 新增', callback_data: 'owner:ideaadd' });
      if (slice.hasNext) nav.push({ text: '▶', callback_data: `owner:ideaspage:${slice.page + 1}` });
      rows.push(nav, backRow(projectId));
      await update(lines.join('\n'), rows);
      return { ok: true, screen: 'ideas', page: slice.page, pages: slice.pages };
    }

    if (action === 'ideacycle') {
      const list = await callWorker('owner/ideas/list', { projectId }, 15000);
      const idea = (list.ideas || []).find((item) => item.id === String(arg || ''));
      if (idea) {
        await callWorker('owner/ideas/status', { id: idea.id, status: nextIdeaStatus(idea.status) }, 15000);
      }
      return show(chatId, 'ideaspage', String(entry.ideaPage || 0));
    }

    if (action === 'ideadel') {
      const list = await callWorker('owner/ideas/list', { projectId }, 15000);
      const idea = (list.ideas || []).find((item) => item.id === String(arg || ''));
      entry.confirm = { type: 'ideadel', id: String(arg || ''), projectId, title: idea?.title || '', at: Date.now() };
      saveEntry(state, chatId, entry);
      await update(`⚠️ 删除这条想法？\n${clip(idea?.title || arg, 120)}`, [
        [{ text: '✅ 确认删除', callback_data: 'owner:confirmok' }, { text: '取消', callback_data: 'owner:cancel' }]
      ]);
      return { ok: true, screen: 'confirm' };
    }

    // ---- 知识 ----
    if (action === 'knowledge' || action === 'kpage') {
      const page = action === 'kpage' ? Number(arg) || 0 : 0;
      entry.knowledgePage = page;
      saveEntry(state, chatId, entry);
      const list = await callWorker('owner/knowledge/list', { projectId }, 15000);
      const items = list.items || [];
      const proposed = items.filter((item) => item.status === 'proposed');
      const unverified = items.filter((item) => item.status === 'unverified');
      const verified = items.filter((item) => item.status === 'verified');
      // 待审核排最前，方便直接处理。
      const ordered = [...proposed, ...unverified, ...verified];
      const slice = paginate(ordered, page, KNOWLEDGE_PER_PAGE);
      const lines = [
        `📚 知识 · 待审核 ${proposed.length} · 未验证 ${unverified.length} · 已验证 ${verified.length}`,
        `第 ${slice.page + 1}/${slice.pages} 页`
      ];
      if (!items.length) lines.push('还没有知识。点「➕ 新增」或让 Agent 提炼候选。');
      const rows = [];
      for (const item of slice.items) {
        if (item.status === 'proposed') {
          lines.push(`• [待审核] ${clip(item.title, 60)}`);
          rows.push([
            { text: `✅ ${clip(item.title, 18)}`, callback_data: `owner:kaccept:${item.id}` },
            { text: '❌', callback_data: `owner:kreject:${item.id}` }
          ]);
        } else if (item.status === 'unverified') {
          lines.push(`• [未验证] ${clip(item.title, 60)}`);
          rows.push([
            { text: `✔ 验证 ${clip(item.title, 18)}`, callback_data: `owner:kverify:${item.id}` }
          ]);
        } else {
          lines.push(`• [已验证] ${clip(item.title, 60)}`);
        }
      }
      const nav = [];
      if (slice.hasPrev) nav.push({ text: '◀', callback_data: `owner:kpage:${slice.page - 1}` });
      nav.push({ text: '🔍 搜索', callback_data: 'owner:ksearch' });
      if (slice.hasNext) nav.push({ text: '▶', callback_data: `owner:kpage:${slice.page + 1}` });
      rows.push(nav);
      rows.push([
        { text: '🧹 整理', callback_data: `owner:ktidy:${projectId}` },
        { text: '➕ 新增', callback_data: 'owner:kadd' }
      ]);
      rows.push(backRow(projectId));
      await update(lines.join('\n'), rows);
      return { ok: true, screen: 'knowledge', page: slice.page, pages: slice.pages };
    }

    if (action === 'kaccept' || action === 'kreject') {
      if (arg) {
        await callWorker('owner/knowledge/review', {
          id: String(arg),
          decision: action === 'kaccept' ? 'accept' : 'reject'
        }, 15000);
      }
      return show(chatId, 'kpage', String(entry.knowledgePage || 0));
    }

    if (action === 'kverify') {
      if (arg) await callWorker('owner/knowledge/verify', { id: String(arg) }, 15000);
      return show(chatId, 'kpage', String(entry.knowledgePage || 0));
    }

    if (action === 'ktidy') {
      const result = await callWorker('owner/knowledge/tidy', { projectId }, 30000);
      const merged = result?.merged ?? result?.removed ?? 0;
      await sendPanel(chatId, `🧹 整理完成：合并/清理 ${merged} 条`, []);
      return show(chatId, 'knowledge', projectId);
    }

    // ---- 图表 ----
    if (action === 'diagrams') {
      entry.selected ||= [];
      saveEntry(state, chatId, entry);
      const list = await callWorker('owner/diagrams/list', { projectId }, 15000);
      const items = list.items || [];
      if (!items.length) {
        await update('还没有图。点「重新扫描」生成依赖图。', [backRow(projectId)]);
        return { ok: true, screen: 'diagrams' };
      }
      const selected = new Set(entry.selected);
      const lines = [`🗺 图表（${items.length}）`, '点名字勾选，可一次发多张：'];
      const rows = items.map((item) => ([{
        text: `${selected.has(item.kind) ? '☑' : '☐'} ${DIAGRAM_LABEL[item.kind] || item.kind} · v${item.version}`,
        callback_data: `owner:dselect:${item.kind}`
      }, {
        text: '单张',
        callback_data: `owner:draw:${item.kind}:${projectId}`
      }]));
      const actions = [];
      if (selected.size) actions.push({ text: `🖼 发送已选（${selected.size}）`, callback_data: 'owner:drawsel' });
      actions.push({ text: '🖼 全部', callback_data: `owner:drawall:${projectId}` });
      rows.push(actions, backRow(projectId));
      await update(lines.join('\n'), rows);
      return { ok: true, screen: 'diagrams', selected: [...selected] };
    }

    if (action === 'dselect') {
      const kind = String(arg || '');
      entry.selected ||= [];
      entry.selected = entry.selected.includes(kind)
        ? entry.selected.filter((item) => item !== kind)
        : [...entry.selected, kind];
      saveEntry(state, chatId, entry);
      return show(chatId, 'diagrams', projectId);
    }

    if (action === 'draw') {
      const [kind, ...rest] = String(arg || '').split(':');
      const target = rest.join(':') || projectId;
      const diagram = await callWorker('owner/diagrams/get', { projectId: target, kind: kind || 'dependency' }, 20000);
      const png = await renderDiagram(diagram, kind);
      if (!png) {
        const text = `🗺 ${DIAGRAM_LABEL[diagram.kind] || diagram.kind}（无法预览）\n${diagram.summary || ''}\n\n\`\`\`mermaid\n${clip(diagram.mermaid, 2500)}\n\`\`\``;
        await update(text, [backRow(target)]);
        return { ok: true, screen: 'diagram-text' };
      }
      await deleteMessages(chatId, entry.albumMessageIds);
      entry.albumMessageIds = [];
      if (entry.photoMessageId) await deleteMessage(chatId, entry.photoMessageId);
      const photoId = await sendPhoto(
        chatId,
        png,
        `${DIAGRAM_LABEL[diagram.kind] || diagram.kind} · v${diagram.version}\n${diagram.summary || ''}`,
        [[
          { text: '刷新', callback_data: `owner:draw:${diagram.kind || kind}:${target}` },
          { text: '返回', callback_data: `owner:diagrams:${target}` }
        ]]
      );
      entry.photoMessageId = photoId;
      saveEntry(state, chatId, entry);
      return { ok: true, screen: 'diagram', kind: diagram.kind || kind, photoMessageId: photoId };
    }

    if (action === 'drawsel' || action === 'drawall') {
      const target = String(arg || '') || projectId;
      const list = await callWorker('owner/diagrams/list', { projectId: target }, 15000);
      const all = list.items || [];
      const wanted = action === 'drawsel'
        ? all.filter((item) => (entry.selected || []).includes(item.kind))
        : all;
      const media = [];
      for (const item of wanted.slice(0, 10)) {
        try {
          const diagram = await callWorker('owner/diagrams/get', { projectId: target, kind: item.kind }, 20000);
          const png = await renderDiagram(diagram, item.kind);
          if (!png) continue;
          media.push({
            png,
            caption: `${DIAGRAM_LABEL[diagram.kind] || item.kind} · v${diagram.version}\n${clip(diagram.summary || '', 120)}`
          });
        } catch {
          // 单张失败不影响其它图。
        }
      }
      if (!media.length) {
        await update('这些图暂时没有可预览的结构化数据。', [backRow(target)]);
        return { ok: true, screen: 'diagram-text' };
      }
      await deleteMessages(chatId, entry.albumMessageIds);
      entry.albumMessageIds = [];
      if (entry.photoMessageId) {
        await deleteMessage(chatId, entry.photoMessageId);
        entry.photoMessageId = 0;
      }
      const ids = await sendMediaGroup(chatId, media);
      entry.albumMessageIds = ids;
      saveEntry(state, chatId, entry);
      await update(`🗺 已发送 ${ids.length} 张图（见上方）`, [
        [
          { text: '重发', callback_data: action === 'drawsel' ? 'owner:drawsel' : `owner:drawall:${target}` },
          { text: '返回', callback_data: `owner:diagrams:${target}` }
        ]
      ]);
      return { ok: true, screen: 'diagrams', count: ids.length, albumMessageIds: ids };
    }

    // ---- GitHub ----
    if (action === 'github') {
      const result = await callWorker('owner/github/status', { projectId }, 30000);
      if (!result.ok) {
        await update(`GitHub 不可用：${clip(result.error, 200)}`, [backRow(projectId)]);
        return { ok: true, screen: 'github' };
      }
      const lines = [`🐙 ${result.repo}`, `分支 ${result.preview?.branch || '?'} · ${result.preview?.clean ? '工作区干净' : '有未提交改动'}`];
      if (result.issues?.length) {
        lines.push('', 'Issues：');
        for (const issue of result.issues.slice(0, 5)) lines.push(`#${issue.number} ${clip(issue.title, 60)} · ${issue.state}`);
      }
      if (result.prs?.length) {
        lines.push('', 'PR：');
        for (const pr of result.prs.slice(0, 5)) lines.push(`#${pr.number} ${clip(pr.title, 60)}${pr.draft ? ' · Draft' : ''} · ${pr.state}`);
      }
      await update(lines.join('\n'), [
        [
          { text: '🔄 刷新', callback_data: `owner:github:${projectId}` },
          { text: '🌿 创建草稿 PR', callback_data: `owner:prconfirm:${projectId}` }
        ],
        backRow(projectId)
      ]);
      return { ok: true, screen: 'github' };
    }

    if (action === 'prconfirm' || action === 'prtitle') {
      if (action === 'prtitle') {
        entry.pending = { kind: 'prtitle', projectId, at: Date.now() };
        saveEntry(state, chatId, entry);
        await update('请直接发消息，给出 PR 标题（或点取消）。', [
          [{ text: '取消', callback_data: 'owner:cancel' }]
        ]);
        return { ok: true, screen: 'pending' };
      }
      const result = await callWorker('owner/github/status', { projectId }, 30000);
      if (!result.ok) {
        await update(`GitHub 不可用：${clip(result.error, 200)}`, [backRow(projectId)]);
        return { ok: true, screen: 'github' };
      }
      const branch = result.preview?.branch || '';
      const clean = result.preview?.clean;
      entry.confirm = {
        type: 'pr',
        projectId,
        base: 'main',
        title: entry.prTitle || '',
        at: Date.now()
      };
      saveEntry(state, chatId, entry);
      const lines = [
        '⚠️ 创建草稿 PR',
        `仓库：${result.repo}`,
        `分支：${branch || '?'} → main`,
        `工作区：${clean ? '干净' : '有未提交改动（会失败）'}`,
        `标题：${entry.prTitle || `Draft: ${branch}`}`,
        '',
        '会先推当前分支到 origin，再建 Draft PR。'
      ];
      await update(lines.join('\n'), [
        [{ text: '✅ 确认创建', callback_data: 'owner:confirmok' }],
        [{ text: '✏️ 改标题', callback_data: `owner:prtitle:${projectId}` }, { text: '取消', callback_data: 'owner:cancel' }]
      ]);
      return { ok: true, screen: 'confirm' };
    }

    // ---- 测试 ----
    if (action === 'tests') {
      const list = await callWorker('owner/tests/list', { projectId }, 15000);
      const tests = list.items || [];
      const lines = ['🧪 最近测试'];
      if (entry.testRunning) lines.push(`⏳ 正在运行：${entry.testRunning.command || 'npm test'}`);
      if (!tests.length) lines.push('还没有运行记录。');
      for (const test of tests.slice(0, 5)) {
        lines.push(`${test.ok ? '✅' : '❌'} ${test.command} · ${Math.round((test.durationMs || 0) / 100) / 10}s · ${String(test.at || '').slice(0, 16)}`);
      }
      const rows = [];
      if (!entry.testRunning) rows.push([{ text: '▶ 运行 npm test', callback_data: `owner:run:${projectId}` }]);
      rows.push([{ text: '✏️ 自定义命令', callback_data: 'owner:runcmd' }]);
      rows.push(backRow(projectId));
      await update(lines.join('\n'), rows);
      return { ok: true, screen: 'tests' };
    }

    if (action === 'run') {
      const started = await startTestRun(chatId, projectId, '');
      if (!started.started) {
        await update(started.error, [backRow(projectId)]);
        return { ok: false, error: started.error };
      }
      return show(chatId, 'tests', projectId);
    }

    if (action === 'runcmd') {
      entry.pending = { kind: 'testcmd', projectId, at: Date.now() };
      saveEntry(state, chatId, entry);
      await update('请直接发消息，给出测试命令（例如 pytest -q、npm test）。', [
        [{ text: '取消', callback_data: 'owner:cancel' }]
      ]);
      return { ok: true, screen: 'pending' };
    }

    // ---- 补丁 ----
    if (action === 'patches' || action === 'patchpage') {
      const page = action === 'patchpage' ? Number(arg) || 0 : 0;
      entry.patchPage = page;
      saveEntry(state, chatId, entry);
      const list = await callWorker('owner/patches/list', { projectId, status: 'pending' }, 15000);
      const items = (list.items || []).filter((item) => item.status === 'pending');
      const slice = paginate(items, page, PATCHES_PER_PAGE);
      const lines = items.length
        ? [`🩹 待审核补丁 ${slice.total} 条 · 第 ${slice.page + 1}/${slice.pages} 页`]
        : ['🩹 没有待审核补丁。'];
      const rows = [];
      for (const patch of slice.items) {
        const summary = summarizeDiff(patch.diff);
        lines.push(`• ${clip(patch.title, 60)} · ${summary.fileCount} 个文件 +${summary.added} -${summary.removed}`);
        rows.push([{ text: `👁 ${clip(patch.title, 24)}`, callback_data: `owner:patch:${patch.id}` }]);
        rows.push([
          { text: '✅ 应用', callback_data: `owner:papply:${patch.id}` },
          { text: '❌ 拒绝', callback_data: `owner:papplyreject:${patch.id}` }
        ]);
      }
      const nav = [];
      if (slice.hasPrev) nav.push({ text: '◀', callback_data: `owner:patchpage:${slice.page - 1}` });
      if (slice.hasNext) nav.push({ text: '▶', callback_data: `owner:patchpage:${slice.page + 1}` });
      if (nav.length) rows.push(nav);
      rows.push([{ text: '📥 从工作区改动提案', callback_data: `owner:ppropose:${projectId}` }]);
      rows.push(backRow(projectId));
      await update(lines.join('\n'), rows);
      return { ok: true, screen: 'patches', page: slice.page, pages: slice.pages };
    }

    if (action === 'patch') {
      const list = await callWorker('owner/patches/list', { projectId, status: 'pending' }, 15000);
      const patch = (list.items || []).find((item) => item.id === String(arg || ''));
      if (!patch) {
        await update('这条补丁不存在或已处理。', [backRow(projectId)]);
        return { ok: false, error: '补丁不存在' };
      }
      const summary = summarizeDiff(patch.diff);
      const text = [
        `🩹 ${patch.title}`,
        `文件：${formatFileList(summary.files)}`,
        `+${summary.added} -${summary.removed}`,
        '',
        '```diff',
        summary.preview,
        '```'
      ].join('\n');
      await update(text, [
        [
          { text: '✅ 应用', callback_data: `owner:papply:${patch.id}` },
          { text: '❌ 拒绝', callback_data: `owner:papplyreject:${patch.id}` }
        ],
        [{ text: '返回补丁列表', callback_data: `owner:patches:${projectId}` }]
      ]);
      return { ok: true, screen: 'patch' };
    }

    if (action === 'papply') {
      const list = await callWorker('owner/patches/list', { projectId, status: 'pending' }, 15000);
      const patch = (list.items || []).find((item) => item.id === String(arg || ''));
      if (!patch) {
        await update('这条补丁不存在或已处理。', [backRow(projectId)]);
        return { ok: false, error: '补丁不存在' };
      }
      const summary = summarizeDiff(patch.diff);
      entry.confirm = { type: 'apply', id: patch.id, projectId, title: patch.title, at: Date.now() };
      saveEntry(state, chatId, entry);
      await update([
        '⚠️ 确认应用补丁？',
        clip(patch.title, 120),
        `文件：${formatFileList(summary.files)}`,
        `+${summary.added} -${summary.removed}`,
        '',
        '会直接改工作区文件，不会自动撤销。'
      ].join('\n'), [
        [{ text: '✅ 确认应用', callback_data: 'owner:confirmok' }],
        [{ text: '取消', callback_data: 'owner:cancel' }]
      ]);
      return { ok: true, screen: 'confirm' };
    }

    if (action === 'papplyreject') {
      await callWorker('owner/patches/reject', { id: String(arg || ''), note: 'telegram' }, 30000);
      return show(chatId, 'patches', projectId);
    }

    if (action === 'ppropose') {
      try {
        const patch = await callWorker('owner/patches/propose-worktree', { projectId }, 60000);
        const summary = summarizeDiff(patch.diff);
        await sendPanel(chatId, `📥 已从工作区生成提案：${clip(patch.title, 80)}\n${formatFileList(summary.files)} +${summary.added} -${summary.removed}`, []);
      } catch (error) {
        await sendPanel(chatId, `没有生成提案：${clip(error?.message ?? error, 300)}`, []);
      }
      return show(chatId, 'patches', projectId);
    }

    // ---- 项目 ----
    if (action === 'projects') {
      const list = await callWorker('owner/projects/list', {}, 15000);
      const projects = list.projects || [];
      const lines = [`📁 共 ${projects.length} 个项目`];
      for (const project of projects) lines.push(`• ${project.name || project.id}\n   ${clip(project.root || '', 80)}`);
      const rows = projects.map((project) => ([
        { text: project.name || project.id, callback_data: `owner:open:${project.id}` },
        { text: '🗑', callback_data: `owner:projdel:${project.id}` }
      ]));
      rows.push([{ text: '➕ 添加项目', callback_data: 'owner:projadd' }]);
      rows.push([{ text: '返回', callback_data: `owner:overview:${projectId}` }]);
      await update(lines.join('\n'), rows);
      return { ok: true, screen: 'projects' };
    }

    if (action === 'projdel') {
      const list = await callWorker('owner/projects/list', {}, 15000);
      const project = (list.projects || []).find((item) => item.id === String(arg || ''));
      entry.confirm = { type: 'projdel', id: String(arg || ''), title: project?.name || '', at: Date.now() };
      saveEntry(state, chatId, entry);
      await update(`⚠️ 从 Owner 移除这个项目？\n${clip(project?.name || arg, 120)}\n（只删登记，不动磁盘文件）`, [
        [{ text: '✅ 确认移除', callback_data: 'owner:confirmok' }],
        [{ text: '取消', callback_data: 'owner:cancel' }]
      ]);
      return { ok: true, screen: 'confirm' };
    }

    return show(chatId, 'overview', projectId);
  };

  // ---- 等输入处理：面板提示后收到的文本 ----
  const handleInput = async (chatId, text) => {
    const { state, entry } = chatState(chatId);
    const pending = entry.pending;
    const fresh = pending && Date.now() - Number(pending.at || 0) <= PENDING_TTL_MS;
    if (!fresh) {
      entry.pending = null;
      saveEntry(state, chatId, entry);
      return { ok: false, error: '面板当前没有等待输入' };
    }
    entry.pending = null;
    saveEntry(state, chatId, entry);

    const projectId = pending.projectId || entry.projectId || (await resolveProject(chatId, ''));
    const value = clip(String(text || '').trim(), 600);
    if (!value) return { ok: false, error: '内容为空' };

    if (pending.kind === 'idea') {
      await callWorker('owner/ideas/add', { projectId, title: value }, 15000);
      await show(chatId, 'ideas', projectId);
      return { ok: true, screen: 'ideas', added: value };
    }
    if (pending.kind === 'knowledge') {
      await callWorker('owner/knowledge/add', { projectId, title: value }, 15000);
      await show(chatId, 'knowledge', projectId);
      return { ok: true, screen: 'knowledge', added: value };
    }
    if (pending.kind === 'ksearch') {
      const result = await callWorker('owner/knowledge/search', { query: value, projectId }, 20000);
      const items = result.items || [];
      const lines = [`🔍 「${clip(value, 40)}」命中 ${items.length} 条`];
      for (const item of items.slice(0, 8)) lines.push(`• [${statusLabel(item.status)}] ${clip(item.title, 60)}`);
      if (!items.length) lines.push('没有匹配的知识。');
      await sendPanel(chatId, lines.join('\n'), [
        [{ text: '返回知识', callback_data: `owner:knowledge:${projectId}` }]
      ]);
      return { ok: true, screen: 'ksearch', count: items.length };
    }
    if (pending.kind === 'projectadd') {
      const result = await callWorker('owner/projects/add', { path: value }, 20000);
      await sendPanel(chatId, `📁 已登记：${clip(result.project?.name || value, 80)}`, []);
      await show(chatId, 'menu');
      return { ok: true, screen: 'menu', added: value };
    }
    if (pending.kind === 'testcmd') {
      const started = await startTestRun(chatId, projectId, value);
      if (!started.started) return { ok: false, error: started.error };
      await show(chatId, 'tests', projectId);
      return { ok: true, screen: 'tests', started: value };
    }
    if (pending.kind === 'prtitle') {
      const next = chatState(chatId);
      next.entry.prTitle = value;
      saveEntry(next.state, chatId, next.entry);
      await show(chatId, 'prconfirm', projectId);
      return { ok: true, screen: 'confirm', title: value };
    }
    return { ok: false, error: `未知的输入类型：${pending.kind}` };
  };

  const handle = async (params = {}) => {
    if (!BOT_TOKEN) return { ok: false, error: '未配置 OWNER_TELEGRAM_BOT_TOKEN' };
    const chatId = String(params.chatId || DEFAULT_CHAT_ID || '').trim();
    if (!chatId) return { ok: false, error: '未配置 OWNER_TELEGRAM_CHAT_ID' };

    try {
      // 文本输入优先级最高：面板在等输入时，Agent 把用户这句话传进来。
      if (params.text) return await handleInput(chatId, String(params.text));

      let action = String(params.action || '').trim();
      let arg = String(params.projectId || params.id || '').trim();
      const callback = String(params.callback || '').trim();
      if (callback) {
        const parsed = parseCallback(callback);
        action = parsed.action || action;
        arg = parsed.arg || arg;
      }

      // 输入类按钮先进入「等输入」状态，下一条文本由 handleInput 消费。
      const promptFor = async (kind, text) => {
        const { state, entry } = chatState(chatId);
        entry.pending = { kind, projectId: arg || entry.projectId || '', at: Date.now() };
        saveEntry(state, chatId, entry);
        const rows = [[{ text: '取消', callback_data: 'owner:cancel' }]];
        entry.messageId = entry.messageId
          ? await editPanel(chatId, entry.messageId, text, rows)
          : await sendPanel(chatId, text, rows);
        saveEntry(state, chatId, entry);
        return { ok: true, screen: 'pending' };
      };
      if (action === 'ideaadd') {
        return await promptFor('idea', '请直接发消息，写下想法内容（一句话即可）。');
      }
      if (action === 'kadd') {
        return await promptFor('knowledge', '请直接发消息，写下这条知识（一句话即可，之后可以再补充）。');
      }
      if (action === 'ksearch') {
        return await promptFor('ksearch', '请直接发消息，给出搜索关键词。');
      }
      if (action === 'projadd') {
        return await promptFor('projectadd', '请直接发消息，给出项目目录的绝对路径（例如 D:\\work\\my-app）。');
      }
      if (!action) action = 'menu';
      const result = await show(chatId, action, arg);
      return { ok: true, ...result, chatId };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  };

  return { handle };
};
