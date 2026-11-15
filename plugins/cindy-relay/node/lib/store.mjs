// Relay 插件的本地数据：每个任务的消息流、上次转交位置、转交历史。
//
// 数据落在 ~/.cindy-relay/relay.json（可用 CINDY_RELAY_DIR 覆盖），
// 原子写入并保留 .bak，单文件便于备份。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const SCHEMA_VERSION = 1;
const MAX_MESSAGES_PER_SESSION = 400;
const MAX_SESSIONS = 40;
const MAX_RELAYS = 200;
const MAX_TEXT = 20000;

export const dataDir = () => (process.env.CINDY_RELAY_DIR
  ? path.resolve(process.env.CINDY_RELAY_DIR)
  : path.join(os.homedir(), '.cindy-relay'));

const emptyState = () => ({
  version: SCHEMA_VERSION,
  sessions: {},
  relays: [],
  prefs: {}
});

const clip = (value, max) => {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const labelFor = (sessionId, messages) => {
  const first = messages.find((message) => message.role === 'user' && message.text.trim());
  const line = first ? first.text.trim().split(/\r?\n/u)[0] : '';
  if (line) return clip(line, 40);
  return `会话 ${String(sessionId).slice(0, 8)}`;
};

/** 打开（或创建）Relay 数据文件。 */
export function openStore(dir = dataDir()) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'relay.json');
  let state = emptyState();

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') {
      state = { ...emptyState(), ...raw };
      state.sessions = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
      state.relays = Array.isArray(raw.relays) ? raw.relays : [];
      state.prefs = raw.prefs && typeof raw.prefs === 'object' ? raw.prefs : {};
    }
  } catch { /* 首次运行或文件损坏时从空状态开始 */ }

  const persist = () => {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    try { fs.copyFileSync(file, `${file}.bak`); } catch { /* 首次没有旧文件 */ }
    fs.renameSync(tmp, file);
  };

  const now = () => new Date().toISOString();

  const sessionOf = (sessionId, create = false) => {
    const key = String(sessionId || '');
    if (!key) return null;
    if (!state.sessions[key] && create) {
      state.sessions[key] = {
        id: key,
        label: '',
        messages: [],
        lastRelayAt: '',
        lastRelayMessageId: '',
        updatedAt: now()
      };
    }
    return state.sessions[key] ?? null;
  };

  const trimSessions = () => {
    const ids = Object.keys(state.sessions);
    if (ids.length <= MAX_SESSIONS) return;
    ids
      .map((id) => ({ id, at: state.sessions[id].updatedAt || '' }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(MAX_SESSIONS)
      .forEach(({ id }) => { delete state.sessions[id]; });
  };

  const pendingOf = (session) => {
    if (!session) return [];
    const messages = session.messages;
    if (!session.lastRelayMessageId) return messages;
    const index = messages.findIndex((message) => message.id === session.lastRelayMessageId);
    return index < 0 ? messages : messages.slice(index + 1);
  };

  return {
    dir,
    file,

    /** 追加一条消息；同一个 messageId 只记一次（钩子重试时幂等）。 */
    appendMessage({ sessionId, role, text, model = '', messageId = '' }) {
      const session = sessionOf(sessionId, true);
      if (!session) return { ok: false, reason: '缺少 sessionId' };
      const content = String(text ?? '').trim();
      if (!content) return { ok: false, reason: '空消息' };
      if (messageId && session.messages.some((message) => message.messageId === messageId)) {
        return { ok: true, duplicated: true, count: session.messages.length };
      }
      session.messages.push({
        id: crypto.randomUUID(),
        messageId: String(messageId || ''),
        role: role === 'assistant' ? 'assistant' : 'user',
        text: clip(content, MAX_TEXT),
        model: String(model || ''),
        at: now()
      });
      if (session.messages.length > MAX_MESSAGES_PER_SESSION) {
        session.messages = session.messages.slice(-MAX_MESSAGES_PER_SESSION);
      }
      if (!session.label) session.label = labelFor(sessionId, session.messages);
      session.updatedAt = now();
      trimSessions();
      persist();
      return { ok: true, count: session.messages.length };
    },

    /** 任务当前的待转交内容与最近一次转交。 */
    getSessionState(sessionId) {
      const session = sessionOf(sessionId);
      if (!session) {
        return { sessionId: String(sessionId || ''), exists: false, pending: [], pendingChars: 0, lastRelayAt: '' };
      }
      const pending = pendingOf(session);
      return {
        sessionId: session.id,
        exists: true,
        label: session.label,
        total: session.messages.length,
        pending,
        pendingChars: pending.reduce((sum, message) => sum + message.text.length, 0),
        lastRelayAt: session.lastRelayAt || '',
        lastRelayMessageId: session.lastRelayMessageId || ''
      };
    },

    /** 转交成功后落一条记录，并把游标推到当前最后一条。 */
    markRelayed({ sessionId, target = null, note = '', chars = 0, taskId = '', requestKey = '' }) {
      const session = sessionOf(sessionId, true);
      if (!session) return { ok: false, reason: '缺少 sessionId' };
      const last = session.messages[session.messages.length - 1];
      session.lastRelayMessageId = last?.id ?? session.lastRelayMessageId;
      session.lastRelayAt = now();
      session.updatedAt = now();
      const relay = {
        id: crypto.randomUUID(),
        sessionId: session.id,
        sessionLabel: session.label,
        target,
        note: clip(note, 2000),
        chars: Number(chars) || 0,
        taskId: String(taskId || ''),
        requestKey: String(requestKey || ''),
        createdAt: session.lastRelayAt
      };
      state.relays.unshift(relay);
      state.relays = state.relays.slice(0, MAX_RELAYS);
      persist();
      return { ok: true, relay };
    },

    listRelays(limit = 20) {
      return state.relays.slice(0, Math.max(1, Math.min(200, Number(limit) || 20)));
    },

    /** 任务保留的全部消息（「全部记录」范围用）。 */
    listMessages(sessionId) {
      const session = sessionOf(sessionId);
      return session ? session.messages.map((message) => ({ ...message })) : [];
    },

    listSessions() {
      return Object.values(state.sessions)
        .map((session) => ({
          id: session.id,
          label: session.label || `会话 ${session.id.slice(0, 8)}`,
          total: session.messages.length,
          pending: pendingOf(session).length,
          lastRelayAt: session.lastRelayAt || '',
          updatedAt: session.updatedAt || ''
        }))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },

    clearSession(sessionId) {
      const session = sessionOf(sessionId);
      if (!session) return { ok: false };
      session.messages = [];
      session.lastRelayMessageId = '';
      session.lastRelayAt = '';
      session.updatedAt = now();
      persist();
      return { ok: true };
    },

    getPrefs() {
      return { ...state.prefs };
    },

    setPrefs(patch = {}) {
      state.prefs = { ...state.prefs, ...patch };
      persist();
      return { ...state.prefs };
    },

    stats() {
      return {
        sessions: Object.keys(state.sessions).length,
        messages: Object.values(state.sessions).reduce((sum, s) => sum + s.messages.length, 0),
        relays: state.relays.length,
        dataFile: file
      };
    }
  };
}
