// Owner 的 Telegram 面板：把 Cindy 里的 Owner 页签做成聊天内可点的面板。
//
// 设计：
// - 面板消息由本模块直接用 Bot API 发送/编辑（和 OpenClaw 共用同一个 bot，
//   发送消息不会和它的 getUpdates 轮询冲突）；
// - 按钮的 callback_data 统一是 `owner:<action>:<arg>`；OpenClaw 收到
//   callback_query 后会把它转成一条 `callback_data: owner:...` 的文本消息，
//   由 Agent 调 owner_panel({callback}) 回到这里；
// - 数据仍然来自本机 worker / owner.json，不复制、不上传。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { renderPng } from './diagrams.mjs';
import { renderMermaidPng } from './mermaid.mjs';

const MAX_TEXT = 3800;

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
  } catch (error) {
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
  try {
    await callApi('deleteMessage', { chat_id: chatId, message_id: messageId });
  } catch {
    // 过期或已删除时忽略。
  }
};

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

const DIAGRAM_LABEL = {
  dependency: '依赖图', control: '控制流', dataflow: '数据流', sequence: '时序图', state: '状态机'
};

const statusLabel = (status) => ({
  todo: '待讨论', doing: '进行中', blocked: '受阻', done: '已完成', failed: '失败',
  proposed: '待审核', unverified: '未验证', verified: '已验证', rejected: '已拒绝'
}[status] || status);

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

const projectButtons = (overview) => {
  const id = overview?.project?.id || '';
  return [
    [{ text: '概览', callback_data: `owner:overview:${id}` }, { text: '想法', callback_data: `owner:ideas:${id}` }, { text: '知识', callback_data: `owner:knowledge:${id}` }],
    [{ text: '图表', callback_data: `owner:diagrams:${id}` }, { text: 'GitHub', callback_data: `owner:github:${id}` }, { text: '测试', callback_data: `owner:tests:${id}` }],
    [{ text: '重新扫描', callback_data: `owner:scan:${id}` }, { text: '补丁', callback_data: `owner:patches:${id}` }, { text: '切换项目', callback_data: 'owner:menu' }]
  ];
};

const projectText = (overview) => `${formatOverview(overview)}\n\n点下面的按钮切换：`;

export const createPanel = ({ callWorker }) => {
  const chatState = (chatId) => {
    const state = readState();
    state.chats ||= {};
    state.chats[chatId] ||= {};
    return { state, entry: state.chats[chatId] };
  };

  const saveEntry = (state, chatId, entry) => {
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

  const show = async (chatId, action, arg) => {
    const { state, entry } = chatState(chatId);
    const update = async (text, rows) => {
      const messageId = entry.messageId
        ? await editPanel(chatId, entry.messageId, text, rows)
        : await sendPanel(chatId, text, rows);
      entry.messageId = messageId;
      saveEntry(state, chatId, entry);
      return messageId;
    };

    if (action === 'menu' || !action) {
      const list = await callWorker('owner/projects/list', {}, 15000);
      const projects = list.projects || [];
      if (!projects.length) {
        await update('还没有登记项目。先在 Owner 设置里添加一个项目目录。', [[{ text: '刷新', callback_data: 'owner:menu' }]]);
        return { ok: true, screen: 'menu' };
      }
      const rows = [];
      for (let index = 0; index < projects.length; index += 2) {
        rows.push(projects.slice(index, index + 2).map((project) => ({
          text: project.name || project.id,
          callback_data: `owner:open:${project.id}`
        })));
      }
      rows.push([{ text: '🔄 刷新', callback_data: 'owner:menu' }]);
      await update(`Owner · 共 ${projects.length} 个项目\n选一个项目：`, rows);
      return { ok: true, screen: 'menu' };
    }

    if (action === 'open') {
      entry.projectId = String(arg || '');
      entry.messageId = 0;
      saveEntry(state, chatId, entry);
      return show(chatId, 'overview', entry.projectId);
    }

    if (action === 'drawall') {
      const target = String(arg || '') || (await resolveProject(chatId, ''));
      if (!target) return show(chatId, 'menu');
      const list = await callWorker('owner/diagrams/list', { projectId: target }, 15000);
      const items = (list.items || []).slice(0, 10);
      const media = [];
      for (const item of items) {
        try {
          const diagram = await callWorker('owner/diagrams/get', { projectId: target, kind: item.kind }, 20000);
          const png = (await renderMermaidPng(diagram.mermaid)) || renderPng(diagram.kind || item.kind, diagram.data);
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
        await update('这些图暂时没有可预览的结构化数据。', [[{ text: '返回', callback_data: `owner:overview:${target}` }]]);
        return { ok: true, screen: 'diagram-text' };
      }
      await deleteMessages(chatId, entry.albumMessageIds);
      if (entry.photoMessageId) {
        await deleteMessage(chatId, entry.photoMessageId);
        entry.photoMessageId = 0;
      }
      const ids = await sendMediaGroup(chatId, media);
      entry.projectId = target;
      entry.albumMessageIds = ids;
      saveEntry(state, chatId, entry);
      await update(`🗺 已发送 ${ids.length} 张图（见上方）`, [[
        { text: '刷新全部', callback_data: `owner:drawall:${target}` },
        { text: '返回', callback_data: `owner:overview:${target}` }
      ]]);
      return { ok: true, screen: 'diagrams', count: ids.length, albumMessageIds: ids };
    }

    if (action === 'draw') {
      const [kind, ...rest] = String(arg || '').split(':');
      const target = rest.join(':') || (await resolveProject(chatId, ''));
      if (!target) return show(chatId, 'menu');
      const diagram = await callWorker('owner/diagrams/get', { projectId: target, kind: kind || 'dependency' }, 20000);
      const png = (await renderMermaidPng(diagram.mermaid)) || renderPng(diagram.kind || kind, diagram.data);
      if (!png) {
        const text = `🗺 ${DIAGRAM_LABEL[diagram.kind] || diagram.kind}（无法预览）\n${diagram.summary || ''}\n\n\`\`\`mermaid\n${clip(diagram.mermaid, 2500)}\n\`\`\``;
        await update(text, [[{ text: '返回', callback_data: `owner:overview:${target}` }]]);
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
          { text: '返回', callback_data: `owner:overview:${target}` }
        ]]
      );
      entry.projectId = target;
      entry.photoMessageId = photoId;
      saveEntry(state, chatId, entry);
      return { ok: true, screen: 'diagram', kind: diagram.kind || kind, photoMessageId: photoId };
    }

    if (action === 'kaccept' || action === 'kreject') {
      if (arg) {
        await callWorker('owner/knowledge/review', {
          id: String(arg),
          decision: action === 'kaccept' ? 'accept' : 'reject'
        }, 15000);
      }
      const current = await resolveProject(chatId, '');
      return show(chatId, 'knowledge', current);
    }

    const projectId = await resolveProject(chatId, arg);
    if (!projectId) {
      return show(chatId, 'menu');
    }
    entry.projectId = projectId;
    saveEntry(state, chatId, entry);

    if (action === 'scan') {
      await callWorker('owner/brief/refresh', { projectId }, 60000);
      return show(chatId, 'overview', projectId);
    }

    if (action === 'overview') {
      const overview = await callWorker('owner/projects/overview', { projectId }, 20000);
      await update(projectText(overview), projectButtons(overview));
      return { ok: true, screen: 'overview' };
    }

    if (action === 'ideas') {
      const list = await callWorker('owner/ideas/list', { projectId }, 15000);
      const ideas = list.ideas || [];
      const lines = [`💡 ${ideas.length ? `想法（${ideas.length}）` : '还没有想法'}`];
      for (const idea of ideas.slice(0, 12)) {
        lines.push(`• ${clip(idea.title, 80)} · ${statusLabel(idea.status)}`);
      }
      await update(lines.join('\n'), [
        [{ text: '刷新', callback_data: `owner:ideas:${projectId}` }, { text: '返回', callback_data: `owner:overview:${projectId}` }]
      ]);
      return { ok: true, screen: 'ideas' };
    }

    if (action === 'knowledge') {
      const list = await callWorker('owner/knowledge/list', { projectId }, 15000);
      const items = list.items || [];
      const proposed = items.filter((item) => item.status === 'proposed');
      const verified = items.filter((item) => item.status === 'verified');
      const unverified = items.filter((item) => item.status === 'unverified');
      const lines = [`📚 知识：待审核 ${proposed.length} · 未验证 ${unverified.length} · 已验证 ${verified.length}`];
      for (const item of proposed.slice(0, 5)) {
        lines.push(`• ${clip(item.title, 70)}`);
      }
      if (!proposed.length) lines.push('没有待审核候选。');
      const rows = [];
      for (const item of proposed.slice(0, 3)) {
        rows.push([
          { text: `✅ ${clip(item.title, 18)}`, callback_data: `owner:kaccept:${item.id}` },
          { text: '❌', callback_data: `owner:kreject:${item.id}` }
        ]);
      }
      rows.push([{ text: '刷新', callback_data: `owner:knowledge:${projectId}` }, { text: '返回', callback_data: `owner:overview:${projectId}` }]);
      await update(lines.join('\n'), rows);
      return { ok: true, screen: 'knowledge' };
    }

    if (action === 'diagrams') {
      const list = await callWorker('owner/diagrams/list', { projectId }, 15000);
      const items = list.items || [];
      if (!items.length) {
        await update('还没有图。点「重新扫描」生成依赖图。', [[{ text: '返回', callback_data: `owner:overview:${projectId}` }]]);
        return { ok: true, screen: 'diagrams' };
      }
      const rows = items.map((item) => [{
        text: `${DIAGRAM_LABEL[item.kind] || item.kind} · v${item.version}`,
        callback_data: `owner:draw:${item.kind}:${projectId}`
      }]);
      rows.push([{ text: '🖼 全部图表', callback_data: `owner:drawall:${projectId}` }]);
      rows.push([{ text: '返回', callback_data: `owner:overview:${projectId}` }]);
      await update(`🗺 图表（${items.length}）\n选一张，或一次看全部：`, rows);
      return { ok: true, screen: 'diagrams' };
    }

    if (action === 'diagram') {
      const [kind, ...rest] = String(arg || '').split(':');
      return show(chatId, 'draw', `${kind || 'dependency'}:${rest.join(':') || projectId}`);
    }

    if (action === 'github') {
      const result = await callWorker('owner/github/status', { projectId }, 30000);
      if (!result.ok) {
        await update(`GitHub 不可用：${clip(result.error, 200)}`, [[{ text: '返回', callback_data: `owner:overview:${projectId}` }]]);
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
      await update(lines.join('\n'), [[{ text: '刷新', callback_data: `owner:github:${projectId}` }, { text: '返回', callback_data: `owner:overview:${projectId}` }]]);
      return { ok: true, screen: 'github' };
    }

    if (action === 'tests') {
      const list = await callWorker('owner/tests/list', { projectId }, 15000);
      const tests = list.items || [];
      const lines = ['🧪 最近测试'];
      if (!tests.length) lines.push('还没有运行记录。');
      for (const test of tests.slice(0, 5)) {
        lines.push(`${test.ok ? '✅' : '❌'} ${test.command} · ${test.durationMs}ms · ${String(test.at || '').slice(0, 16)}`);
      }
      await update(lines.join('\n'), [[{ text: '刷新', callback_data: `owner:tests:${projectId}` }, { text: '返回', callback_data: `owner:overview:${projectId}` }]]);
      return { ok: true, screen: 'tests' };
    }

    if (action === 'patches') {
      const list = await callWorker('owner/patches/list', { projectId, status: 'pending' }, 15000);
      const patches = list.items || [];
      const lines = ['🩹 待审核补丁'];
      if (!patches.length) lines.push('没有待审核补丁。');
      for (const patch of patches.slice(0, 8)) lines.push(`• ${clip(patch.title, 70)}`);
      lines.push('', '应用补丁仍然只能在 Owner 面板里做。');
      await update(lines.join('\n'), [[{ text: '刷新', callback_data: `owner:patches:${projectId}` }, { text: '返回', callback_data: `owner:overview:${projectId}` }]]);
      return { ok: true, screen: 'patches' };
    }

    return show(chatId, 'overview', projectId);
  };

  const handle = async (params = {}) => {
    if (!BOT_TOKEN) return { ok: false, error: '未配置 OWNER_TELEGRAM_BOT_TOKEN' };
    const chatId = String(params.chatId || DEFAULT_CHAT_ID || '').trim();
    if (!chatId) return { ok: false, error: '未配置 OWNER_TELEGRAM_CHAT_ID' };
    let action = String(params.action || '').trim();
    let arg = String(params.projectId || params.id || '').trim();
    const callback = String(params.callback || '').trim();
    if (callback.startsWith('owner:')) {
      const parts = callback.split(':');
      action = parts[1] || '';
      arg = parts.slice(2).join(':');
    }
    if (!action) action = 'menu';
    try {
      const result = await show(chatId, action, arg);
      return { ok: true, ...result, chatId };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  };

  return { handle };
};
