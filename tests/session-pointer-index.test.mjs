// #125 会话指针索引：只读元信息、来源边界、线索匹配与「正文不穿过索引」。
// 用临时目录造 Codex / Claude 的会话文件；不碰本机真实会话，也不起 Electron。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  classifyClue,
  idFromFileName,
  listSessionPointers,
  readClaudeIndex,
  readCodexIndex,
  sessionPointerRoots
} from '../src/memory/session-pointer-index.mjs';

const CODEX_ID = '01a1a3bc-a07b-76d0-9532-e942ded4731e';
const CLAUDE_ID = 'ce930107-64d0-4abe-915b-09087f2db30f';
const MARKER = 'BODY_MARKER_不该出现在指针里';

const rows = (items) => `${items.map((item) => JSON.stringify(item)).join('\n')}\n`;

const codexText = (extra = []) => rows([
  {
    timestamp: '2026-11-26T08:00:00.000Z',
    type: 'session_meta',
    payload: { id: CODEX_ID, cwd: 'D:\\demo\\proj', timestamp: '2026-11-26T08:00:00.000Z' }
  },
  {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }]
    }
  },
  {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '关于 B 方案的取舍' }]
    }
  },
  {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '先补测试，再换实现。' }]
    }
  },
  ...extra
]);

const claudeText = (extra = []) => rows([
  { type: 'queue-operation', sessionId: CLAUDE_ID },
  {
    type: 'user',
    cwd: 'D:\\demo\\proj\\sub',
    slug: 'architecture-audit',
    sessionId: CLAUDE_ID,
    timestamp: '2026-11-25T09:10:00.000Z',
    message: { role: 'user', content: '请检查架构图的边界' }
  },
  {
    type: 'assistant',
    cwd: 'D:\\demo\\proj\\sub',
    sessionId: CLAUDE_ID,
    message: { role: 'assistant', content: [{ type: 'text', text: '边界在适配层。' }] }
  },
  {
    type: 'user',
    cwd: 'D:\\demo\\proj\\sub',
    sessionId: CLAUDE_ID,
    isSidechain: true,
    message: { role: 'user', content: '子代理往来不该计数' }
  },
  ...extra
]);

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'owner-session-points-'));

const writeFile = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return file;
};

const fixture = () => {
  const root = tempRoot();
  const codexDir = path.join(root, 'codex', 'sessions', '2026', '11', '26');
  const codexFile = path.join(codexDir, `rollout-2026-11-26T08-00-00-${CODEX_ID}.jsonl`);
  writeFile(codexFile, codexText());
  const claudeDir = path.join(root, 'claude', 'projects', 'D--demo-proj');
  const claudeFile = path.join(claudeDir, `${CLAUDE_ID}.jsonl`);
  writeFile(claudeFile, claudeText());
  return {
    root,
    roots: {
      codex: path.join(root, 'codex', 'sessions'),
      claude: path.join(root, 'claude', 'projects'),
      opencodeDb: path.join(root, 'missing', 'opencode.db')
    }
  };
};

test('readCodexIndex：只取 id / cwd / 标题 / 轮数，环境说明不当标题', () => {
  const meta = readCodexIndex(codexText());
  assert.equal(meta.id, CODEX_ID);
  assert.equal(meta.cwd, 'D:\\demo\\proj');
  assert.equal(meta.title, '关于 B 方案的取舍');
  assert.equal(meta.turns, 2);
  assert.ok(!('text' in meta));
  assert.ok(!JSON.stringify(meta).includes('environment_context'));
});

test('readClaudeIndex：slug 可兜底标题，sidechain 不计数', () => {
  const meta = readClaudeIndex(claudeText());
  assert.equal(meta.id, CLAUDE_ID);
  assert.equal(meta.cwd, 'D:\\demo\\proj\\sub');
  assert.equal(meta.title, '请检查架构图的边界');
  assert.equal(meta.turns, 2);
  // 没有首条对话时用 slug 当标题，比空着好定位。
  const slugOnly = readClaudeIndex(rows([
    { type: 'attachment', cwd: 'D:\\demo\\proj', slug: 'only-slug', sessionId: CLAUDE_ID }
  ]));
  assert.equal(slugOnly.title, 'only-slug');
  assert.equal(slugOnly.turns, 0);
});

test('idFromFileName：Claude 认 uuid 文件名，Codex 认 rollout 名里的 uuid', () => {
  assert.equal(idFromFileName('claude', `${CLAUDE_ID}.jsonl`), CLAUDE_ID);
  assert.equal(
    idFromFileName('codex', `rollout-2026-11-26T08-00-00-${CODEX_ID}.jsonl.zst`),
    CODEX_ID
  );
  assert.equal(idFromFileName('claude', 'agent-abc.jsonl'), '');
});

test('线索分类与主进程口径一致：id / 关键词 / 不可用', () => {
  assert.equal(classifyClue(CODEX_ID).kind, 'id');
  assert.equal(classifyClue('ses_nNGitSepMqB0bckkSmhfwoZmwW').kind, 'id');
  assert.equal(classifyClue('D:\\demo\\proj').kind, 'keyword');
  assert.equal(classifyClue('架构 审计').kind, 'keyword');
  assert.equal(classifyClue('').kind, 'unusable');
  assert.equal(classifyClue('!!!').kind, 'unusable');
});

test('列最近会话：只回指针元信息，正文标记不穿过索引', async () => {
  const { root, roots } = fixture();
  try {
    const result = await listSessionPointers({
      roots,
      projects: [{ id: 'p1', name: '示例项目', root: 'D:\\demo\\proj' }],
      source: 'codex',
      limit: 5
    });
    assert.equal(result.items.length, 1);
    const [item] = result.items;
    assert.equal(item.source, 'codex');
    assert.equal(item.id, CODEX_ID);
    assert.equal(item.title, '关于 B 方案的取舍');
    assert.equal(item.turns, 2);
    assert.equal(item.project, '示例项目');
    assert.equal(item.at, '2026-11-26T08:00:00.000Z');
    assert.ok(!('text' in item));
    assert.ok(!('messages' in item));
    assert.ok(!JSON.stringify(result).includes(MARKER));
    // 只列 codex 时不去读 OpenCode，也不报 OpenCode 的原因。
    assert.ok(!result.reasons.some((reason) => reason.includes('OpenCode')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('按线索找会话：id 精确命中，关键词 / 路径按 cwd 与标题搜', async () => {
  const { root, roots } = fixture();
  try {
    const byId = await listSessionPointers({ roots, clue: CODEX_ID });
    assert.equal(byId.clueKind, 'id');
    assert.deepEqual(byId.items.map((item) => item.id), [CODEX_ID]);

    const byTitle = await listSessionPointers({ roots, clue: '架构' });
    assert.equal(byTitle.clueKind, 'keyword');
    assert.ok(byTitle.items.some((item) => item.id === CLAUDE_ID && item.source === 'claude'));

    const byPath = await listSessionPointers({ roots, clue: 'D:\\demo\\proj\\sub' });
    assert.ok(byPath.items.some((item) => item.id === CLAUDE_ID));

    // 关键词跨来源找：Codex 与 Claude 都能命中。
    const both = await listSessionPointers({ roots, clue: 'demo' });
    assert.deepEqual(new Set(both.items.map((item) => item.source)), new Set(['codex', 'claude']));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('找不到 / 线索不可用：回空列表与原因，不抛错也不编一条', async () => {
  const { root, roots } = fixture();
  try {
    const miss = await listSessionPointers({ roots, clue: '不存在的标题-xyz' });
    assert.deepEqual(miss.items, []);
    assert.equal(miss.clueKind, 'keyword');

    const unusable = await listSessionPointers({ roots, clue: '   ' });
    assert.deepEqual(unusable.items, []);
    assert.equal(unusable.clueKind, 'unusable');
    assert.ok(unusable.reasons.length > 0);

    const opencode = await listSessionPointers({ roots, source: 'opencode' });
    assert.deepEqual(opencode.items, []);
    assert.ok(opencode.reasons.some((reason) => reason.includes('OpenCode')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('大文件只读头部：正文后半段不会出现在结果里', async () => {
  const root = tempRoot();
  try {
    // 头部之后塞 200KB 再放标记：默认只读 96KB，标记不该被读到。
    const filler = 'x'.repeat(200 * 1024);
    const file = path.join(root, 'codex', 'sessions', '2026', '11', '26',
      `rollout-2026-11-26T08-00-00-${CODEX_ID}.jsonl`);
    writeFile(file, `${codexText()}${rows([
      { type: 'response_item', payload: { type: 'message', role: 'user',
        content: [{ type: 'input_text', text: `${MARKER}${filler}` }] } }
    ])}`);
    const result = await listSessionPointers({
      roots: { codex: path.join(root, 'codex', 'sessions') },
      source: 'codex'
    });
    assert.equal(result.items.length, 1);
    assert.ok(!JSON.stringify(result).includes(MARKER));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sessionPointerRoots：OWNER_SESSION_HOME / CODEX_HOME / XDG_DATA_HOME 都按配置走', () => {
  const roots = sessionPointerRoots({
    home: 'D:\\fixture-home',
    env: {
      CODEX_HOME: 'D:\\fixture-codex',
      XDG_DATA_HOME: 'D:\\fixture-data'
    }
  });
  assert.equal(roots.codex, path.join('D:\\fixture-codex', 'sessions'));
  assert.equal(roots.claude, path.join('D:\\fixture-home', '.claude', 'projects'));
  assert.equal(roots.opencodeDb, path.join('D:\\fixture-data', 'opencode', 'opencode.db'));
});
