// #86 会话扫描：读本机 Codex / Claude Code 的会话，按工作目录匹配到已登记项目，
// 再交给 decision-draft 产候选。这里用临时目录造两种格式的样例会话，
// 断言「扫了多少、匹配上多少、丢了多少」以及「同一段会话不被重复提炼」。
// 不联网、不调真实模型、不读真实用户的会话目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  scanSessions,
  matchProjectForCwd,
  sessionRootsFrom,
  heuristicExtract
} from '../src/memory/session-scan.mjs';
import { decisionFingerprint } from '../src/memory/decision-draft.mjs';

const AT = '2026-11-25T10:00:00.000Z';

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'session-scan-'));

/** 写一份 JSONL；Codex 新版会把 rollout 压成 .jsonl.zst，这里一并覆盖。 */
const writeLines = (file, rows, { zstd = false } = {}) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  if (zstd) fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(body, 'utf8')));
  else fs.writeFileSync(file, body, 'utf8');
};

/** Codex 会话行：首行 session_meta 带 cwd，对话在 response_item 的 message 里。 */
const codex = {
  meta: (cwd, id = 'codex-session-1') => ({ timestamp: AT, type: 'session_meta', payload: { id, cwd } }),
  user: (text, at = AT) => ({
    timestamp: at,
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
  }),
  assistant: (text, at = AT) => ({
    timestamp: at,
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
  }),
  // 工具输出：不是对话正文，应被跳过。
  tool: () => ({ timestamp: AT, type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } }),
  // developer 角色是注入的权限说明，不参与配对。
  developer: () => ({
    timestamp: AT,
    type: 'response_item',
    payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>' }] }
  })
};

/** Claude Code 会话行：type 为 user / assistant，cwd 写在行上。 */
const claude = {
  user: (text, cwd, sessionId = 'claude-session-1') => ({
    type: 'user',
    cwd,
    sessionId,
    timestamp: AT,
    isSidechain: false,
    message: { role: 'user', content: text }
  }),
  assistant: (blocks, cwd, sessionId = 'claude-session-1') => ({
    type: 'assistant',
    cwd,
    sessionId,
    timestamp: AT,
    isSidechain: false,
    message: { role: 'assistant', content: blocks }
  })
};

/** 假的提炼器：只回显传进来的原文，不猜字段。 */
const echoExtract = (pair) => ({
  phenomenon: pair.user.text,
  intent: pair.assistant ? pair.assistant.text : '',
  abandoned: '',
  reason: ''
});

const seedProjects = (root) => {
  const alpha = path.join(root, 'work', 'alpha');
  const beta = path.join(root, 'work', 'beta');
  fs.mkdirSync(alpha, { recursive: true });
  fs.mkdirSync(beta, { recursive: true });
  return {
    alpha,
    beta,
    projects: [
      { id: 'alpha', name: 'Alpha 项目', root: alpha },
      { id: 'beta', name: 'Beta 项目', root: beta }
    ]
  };
};

test('两个来源都能读：Codex 的 session_meta.cwd 与 Claude 行内 cwd 都按项目匹配', async () => {
  const root = tempRoot();
  try {
    const { alpha, beta, projects } = seedProjects(root);
    // Codex：工作目录是项目子目录，仍然算命中。
    writeLines(path.join(root, 'codex', 'sessions', '2026', '11', '25', 'rollout-1.jsonl'), [
      codex.meta(path.join(alpha, 'src')),
      codex.developer(),
      codex.user('构建太慢了，换掉 tsc'),
      codex.tool(),
      codex.assistant('那就用 esbuild 打包，tsc 只留类型检查')
    ]);
    // Claude Code：工作目录精确等于项目根。
    writeLines(path.join(root, 'claude', 'projects', 'flat-cwd', 'uuid-1.jsonl'), [
      claude.user('日志里别打 token', beta),
      claude.assistant([{ type: 'text', text: '好，日志统一改成脱敏输出' }], beta)
    ]);

    const result = await scanSessions({
      roots: [
        { source: 'codex', dir: path.join(root, 'codex', 'sessions') },
        { source: 'claude', dir: path.join(root, 'claude', 'projects') }
      ],
      projects,
      extract: echoExtract
    });

    assert.equal(result.counts.files, 2);
    assert.equal(result.counts.matched, 2);
    assert.equal(result.counts.dropped, 0);
    assert.equal(result.counts.alreadyScanned, 0);
    // 工具输出与 developer 角色都没有混进对话正文。
    assert.equal(result.counts.skipped.tools, 1);
    assert.equal(result.counts.skipped.nonConversation, 1);

    const byProject = new Map(result.sessions.map((session) => [session.projectId, session]));
    assert.equal(byProject.get('alpha').fragments, 2);
    assert.equal(byProject.get('alpha').source, 'codex');
    assert.equal(byProject.get('alpha').projectName, 'Alpha 项目');
    assert.equal(byProject.get('beta').fragments, 2);
    assert.equal(byProject.get('beta').source, 'claude');

    assert.equal(result.candidates.length, 2);
    // 两个来源各产一条；顺序按文件修改时间，不假设谁先谁后。
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.projectId).sort(),
      ['alpha', 'beta']
    );
    for (const candidate of result.candidates) assert.equal(candidate.status, 'proposed');
    assert.equal(result.empty, false);
    // 计数自洽：扫过的每一段会话都落在「匹配 / 已扫过 / 丢弃」三者之一。
    assert.equal(
      result.counts.files,
      result.counts.matched + result.counts.alreadyScanned + result.counts.dropped
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('匹配规则：精确等于项目根或在子目录下；只有前缀相似不算命中', () => {
  const projects = [
    { id: 'alpha', root: 'D:\\work\\alpha' },
    { id: 'beta', root: '/srv/beta' }
  ];
  assert.equal(matchProjectForCwd('D:\\work\\alpha', projects)?.id, 'alpha');
  assert.equal(matchProjectForCwd('d:/work/alpha/src/deep', projects)?.id, 'alpha');
  assert.equal(matchProjectForCwd('/srv/beta', projects)?.id, 'beta');
  assert.equal(matchProjectForCwd('/srv/beta/pkg', projects)?.id, 'beta');
  // 末尾斜杠不该影响命中。
  assert.equal(matchProjectForCwd('/srv/beta/', projects)?.id, 'beta');
  // 前缀相似不是子目录：不猜。
  assert.equal(matchProjectForCwd('D:\\work\\alpha-extra', projects), null);
  assert.equal(matchProjectForCwd('/srv/betamax', projects), null);
  assert.equal(matchProjectForCwd('', projects), null);
  assert.equal(matchProjectForCwd('D:\\work\\alpha', []), null);
});

test('匹配不到的会话丢弃并计数，缺工作目录单独计数', async () => {
  const root = tempRoot();
  try {
    const { projects } = seedProjects(root);
    writeLines(path.join(root, 'codex', 'sessions', '2026', '11', '25', 'rollout-other.jsonl'), [
      codex.meta(path.join(root, 'elsewhere')),
      codex.user('这个项目里要不要删掉缓存目录'),
      codex.assistant('先留着')
    ]);
    // Claude 会话没有 cwd：不猜，直接丢弃并计数。
    writeLines(path.join(root, 'claude', 'projects', 'no-cwd', 'uuid-2.jsonl'), [
      { type: 'user', sessionId: 'claude-no-cwd', timestamp: AT, message: { role: 'user', content: '这里没有工作目录' } }
    ]);

    const result = await scanSessions({
      roots: [
        { source: 'codex', dir: path.join(root, 'codex', 'sessions') },
        { source: 'claude', dir: path.join(root, 'claude', 'projects') }
      ],
      projects,
      extract: echoExtract
    });

    assert.equal(result.counts.files, 2);
    assert.equal(result.counts.matched, 0);
    assert.equal(result.counts.dropped, 2);
    assert.equal(result.dropped.unmatchedCwd, 1);
    assert.equal(result.dropped.missingCwd, 1);
    assert.equal(result.candidates.length, 0);
    assert.equal(result.empty, true);
    // 原因带可读标签，界面不用自己再翻一遍键名。
    const labels = result.droppedReasons.map((reason) => `${reason.key}:${reason.label}`);
    assert.ok(labels.some((line) => line.startsWith('unmatchedCwd:') && line.includes('项目')));
    assert.ok(labels.some((line) => line.startsWith('missingCwd:') && line.includes('工作目录')));
    assert.equal(result.skippedFiles.length, 2);
    assert.equal(
      result.counts.files,
      result.counts.matched + result.counts.alreadyScanned + result.counts.dropped
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('工具输出与注入块都不算候选', async () => {
  const root = tempRoot();
  try {
    const { alpha, projects } = seedProjects(root);
    writeLines(path.join(root, 'codex', 'sessions', '2026', '11', '25', 'rollout-inject.jsonl'), [
      codex.meta(alpha),
      { timestamp: AT, type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'ls -la' } },
      codex.user('环境上下文：你运行在一个沙箱里，工作目录是 D:\\work\\alpha'),
      codex.user('日志里别打 token，统一脱敏'),
      codex.assistant('好，日志改成脱敏输出')
    ]);

    const result = await scanSessions({
      roots: [{ source: 'codex', dir: path.join(root, 'codex', 'sessions') }],
      projects,
      extract: echoExtract
    });

    assert.equal(result.counts.matched, 1);
    // 注入块被 decision-draft 挡下，算跳过而不是候选。
    assert.equal(result.counts.skipped.injected, 1);
    assert.equal(result.counts.skipped.tools, 1);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].quote.user, '日志里别打 token，统一脱敏');
    assert.equal(result.sessions[0].fragments, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('重复扫描不重复提炼：已扫过的会话键在第二次扫描里单独计数', async () => {
  const root = tempRoot();
  try {
    const { alpha, projects } = seedProjects(root);
    writeLines(path.join(root, 'codex', 'sessions', '2026', '11', '25', 'rollout-once.jsonl'), [
      codex.meta(alpha, 'codex-once'),
      codex.user('构建太慢，改成 esbuild 打包'),
      codex.assistant('好，换 esbuild')
    ]);
    const roots = [{ source: 'codex', dir: path.join(root, 'codex', 'sessions') }];

    const first = await scanSessions({ roots, projects, extract: echoExtract });
    assert.equal(first.counts.matched, 1);
    assert.equal(first.candidates.length, 1);
    assert.equal(first.scannedKeys.length, 1);

    const second = await scanSessions({
      roots,
      projects,
      extract: echoExtract,
      seenSessions: first.scannedKeys,
      fingerprints: first.fingerprints
    });
    assert.equal(second.counts.files, 1);
    assert.equal(second.counts.matched, 0);
    assert.equal(second.counts.alreadyScanned, 1);
    assert.equal(second.candidates.length, 0);
    assert.equal(
      second.counts.files,
      second.counts.matched + second.counts.alreadyScanned + second.counts.dropped
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('同内容按指纹去重：两段会话说同一句话只出一条候选', async () => {
  const root = tempRoot();
  try {
    const { alpha, projects } = seedProjects(root);
    for (const id of ['codex-a', 'codex-b']) {
      writeLines(path.join(root, 'codex', 'sessions', '2026', '11', '25', `rollout-${id}.jsonl`), [
        codex.meta(alpha, id),
        codex.user('统一用 esbuild，不再用 tsc 打包'),
        codex.assistant('好，tsc 只做类型检查')
      ]);
    }

    const result = await scanSessions({
      roots: [{ source: 'codex', dir: path.join(root, 'codex', 'sessions') }],
      projects,
      extract: echoExtract
    });

    assert.equal(result.counts.matched, 2);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.counts.skipped.existing, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('会话原文先脱敏再成候选：六类秘密不落库，占位符与计数都在', async () => {
  const root = tempRoot();
  try {
    const { alpha, projects } = seedProjects(root);
    const secrets = {
      openai: `sk-proj-${'a1B2c3D4'.repeat(3)}`,
      github: `ghp_${'A1b2C3d4'.repeat(4)}`,
      password: 'hunter2',
      url: 'https://bob:letmein@example.com/repo',
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'
    };
    const userText = [
      '部署别写死密钥',
      `OpenAI 用 ${secrets.openai}`,
      `GitHub 用 ${secrets.github}`,
      `数据库 password=${secrets.password}`,
      `仓库 ${secrets.url}`,
      `JWT ${secrets.jwt}`,
      secrets.privateKey
    ].join('；');

    writeLines(path.join(root, 'codex', 'sessions', '2026', '11', '25', 'rollout-secrets.jsonl'), [
      codex.meta(alpha, 'codex-secrets'),
      codex.user(userText),
      codex.assistant('好，这些都从文档里删掉，改成占位符')
    ]);

    const result = await scanSessions({
      roots: [{ source: 'codex', dir: path.join(root, 'codex', 'sessions') }],
      projects,
      extract: echoExtract
    });

    assert.equal(result.redactions, 6);
    assert.equal(result.candidates.length, 1);
    const candidate = result.candidates[0];
    // 原文秘密一个都不在候选里：库里 / 界面拿到的只有占位符。
    for (const raw of [secrets.openai, secrets.github, secrets.password, 'letmein', secrets.jwt, 'MIIEowIBAAKCAQEA']) {
      assert.equal(JSON.stringify(candidate).includes(raw), false, `原文仍留在候选：${raw.slice(0, 12)}`);
    }
    assert.match(candidate.quote.user, /sk-…<redacted:api-key>/u);
    assert.match(candidate.quote.user, /ghp_…<redacted:github-token>/u);
    assert.match(candidate.quote.user, /password=…<redacted:credential>/u);
    assert.match(candidate.quote.user, /bob:…<redacted:url-password>@example\.com/u);
    assert.match(candidate.quote.user, /eyJ…<redacted:jwt>/u);
    assert.match(candidate.quote.user, /<redacted:private-key>/u);
    // 指纹基于脱敏后的用户原话，不是原文。
    assert.equal(
      candidate.fingerprint,
      decisionFingerprint({ projectId: 'alpha', text: candidate.quote.user })
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('指纹基于脱敏后文本：同一句话换一个密钥仍只出一条候选', async () => {
  const root = tempRoot();
  try {
    const { alpha, projects } = seedProjects(root);
    for (const [id, key] of [['codex-key-a', 'a'.repeat(20)], ['codex-key-b', 'b'.repeat(20)]]) {
      writeLines(path.join(root, 'codex', 'sessions', '2026', '11', '25', `rollout-${id}.jsonl`), [
        codex.meta(alpha, id),
        codex.user(`统一用 sk-${key} 这一个密钥，别再换`),
        codex.assistant('好，只保留这一个')
      ]);
    }

    const result = await scanSessions({
      roots: [{ source: 'codex', dir: path.join(root, 'codex', 'sessions') }],
      projects,
      extract: echoExtract
    });

    assert.equal(result.counts.matched, 2);
    assert.equal(result.redactions, 2);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.fingerprints.length, 1);
    assert.equal(result.counts.skipped.existing, 1);
    assert.match(result.candidates[0].quote.user, /sk-…<redacted:api-key>/u);
    // 两个不同的原文密钥都被换成了同一段占位符，所以指纹相同；否则会是两条候选。
    assert.equal(JSON.stringify(result.candidates).includes('a'.repeat(20)), false);
    assert.equal(JSON.stringify(result.candidates).includes('b'.repeat(20)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('只有工具输出的会话单独计数，不混进匹配成功的数字', async () => {
  const root = tempRoot();
  try {
    const { alpha, projects } = seedProjects(root);
    writeLines(path.join(root, 'codex', 'sessions', '2026', '11', '25', 'rollout-tools.jsonl'), [
      codex.meta(alpha, 'codex-tools'),
      codex.tool(),
      codex.tool()
    ]);

    const result = await scanSessions({
      roots: [{ source: 'codex', dir: path.join(root, 'codex', 'sessions') }],
      projects,
      extract: echoExtract
    });

    assert.equal(result.counts.matched, 0);
    assert.equal(result.counts.dropped, 1);
    assert.equal(result.dropped.emptyConversation, 1);
    assert.equal(result.counts.skipped.tools, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('扫描上限：超出的会话单独计数，既不算匹配也不算丢弃', async () => {
  const root = tempRoot();
  try {
    const { alpha, projects } = seedProjects(root);
    for (const id of ['codex-1', 'codex-2', 'codex-3']) {
      writeLines(path.join(root, 'codex', 'sessions', '2026', '11', '25', `rollout-${id}.jsonl`), [
        codex.meta(alpha, id),
        codex.user(`第 ${id} 段：这个目录保留，不合并`)
      ]);
    }

    const result = await scanSessions({
      roots: [{ source: 'codex', dir: path.join(root, 'codex', 'sessions') }],
      projects,
      extract: echoExtract,
      maxSessions: 1
    });

    assert.equal(result.counts.files, 1);
    assert.equal(result.counts.truncated, 2);
    assert.equal(result.truncated, 2);
    assert.equal(result.counts.matched + result.counts.alreadyScanned + result.counts.dropped, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex 压缩会话（.jsonl.zst）也能读', {
  skip: typeof zlib.zstdCompressSync !== 'function' ? '当前 node 没有 zstd' : false
}, async () => {
  const root = tempRoot();
  try {
    const { alpha, projects } = seedProjects(root);
    writeLines(path.join(root, 'codex', 'sessions', '2026', '11', '25', 'rollout-z.jsonl.zst'), [
      codex.meta(alpha, 'codex-zstd'),
      codex.user('这个模块保留，别再拆'),
      codex.assistant('好，保持单文件')
    ], { zstd: true });

    const result = await scanSessions({
      roots: [{ source: 'codex', dir: path.join(root, 'codex', 'sessions') }],
      projects,
      extract: echoExtract
    });

    assert.equal(result.counts.matched, 1);
    assert.equal(result.candidates.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('默认提炼器只在像决策的原话上产候选（没有模型时的保守占位）', () => {
  // 纯提问不是决策。
  assert.equal(heuristicExtract({ user: { text: '这个函数是干什么的？' }, assistant: null }), null);
  // 有取舍的原话才算候选，理由一律留空交给确认时补。
  const fields = heuristicExtract({ user: { text: '构建太慢，改成 esbuild 打包' }, assistant: null });
  assert.ok(fields);
  assert.equal(fields.phenomenon, '构建太慢，改成 esbuild 打包');
  assert.equal(fields.intent, '');
  assert.equal(fields.abandoned, '');
  assert.equal(fields.reason, '');
  assert.equal(heuristicExtract({ user: { text: '短句' } }), null);
});

test('默认会话根目录：CODEX_HOME 覆盖 Codex 的 home，Claude Code 固定在 ~/.claude', () => {
  // 平台无关路径：源码对 CODEX_HOME 做 path.resolve，硬编码盘符在 Linux CI 上必红。
  const home = path.join(os.tmpdir(), 'session-home');
  const codex = path.join(os.tmpdir(), 'session-codex');
  const roots = sessionRootsFrom({ home, env: { CODEX_HOME: codex } });
  assert.deepEqual(roots.map((root) => root.source), ['codex', 'claude']);
  assert.equal(roots[0].dir, path.join(path.resolve(codex), 'sessions'));
  assert.equal(roots[1].dir, path.join(home, '.claude', 'projects'));
  const fallback = sessionRootsFrom({ home, env: {} });
  assert.equal(fallback[0].dir, path.join(home, '.codex', 'sessions'));
});

// #98 扫描入口脱敏：候选的引用、字段与指纹都只该看见占位符。
// #98 扫描入口脱敏：候选的引用、字段与指纹都只该看见占位符。
test('会话原文先脱敏再成候选：六类秘密不落库，占位符与计数都在', async () => {
  const root = tempRoot();
  try {
    const { alpha, projects } = seedProjects(root);
    const secrets = {
      openai: `sk-proj-${'a1B2c3D4'.repeat(3)}`,
      github: `ghp_${'A1b2C3d4'.repeat(4)}`,
      password: 'hunter2',
      url: 'https://bob:letmein@example.com/repo',
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'
    };
    const userText = [
      '部署别写死密钥',
      `OpenAI 用 ${secrets.openai}`,
      `GitHub 用 ${secrets.github}`,
      `数据库 password=${secrets.password}`,
      `仓库 ${secrets.url}`,
      `JWT ${secrets.jwt}`,
      secrets.privateKey
    ].join('；');

    writeLines(path.join(root, 'codex', 'sessions', '2026', '11', '25', 'rollout-secrets.jsonl'), [
      codex.meta(alpha, 'codex-secrets'),
      codex.user(userText),
      codex.assistant('好，这些都从文档里删掉，改成占位符')
    ]);

    const result = await scanSessions({
      roots: [{ source: 'codex', dir: path.join(root, 'codex', 'sessions') }],
      projects,
      extract: echoExtract
    });

    assert.equal(result.redactions, 6);
    assert.equal(result.candidates.length, 1);
    const candidate = result.candidates[0];
    // 原文秘密一个都不在候选里：库里 / 界面拿到的只有占位符。
    for (const raw of [secrets.openai, secrets.github, secrets.password, 'letmein', secrets.jwt, 'MIIEowIBAAKCAQEA']) {
      assert.equal(JSON.stringify(candidate).includes(raw), false, `原文仍留在候选：${raw.slice(0, 12)}`);
    }
    assert.match(candidate.quote.user, /sk-…<redacted:api-key>/u);
    assert.match(candidate.quote.user, /ghp_…<redacted:github-token>/u);
    assert.match(candidate.quote.user, /password=…<redacted:credential>/u);
    assert.match(candidate.quote.user, /bob:…<redacted:url-password>@example\.com/u);
    assert.match(candidate.quote.user, /eyJ…<redacted:jwt>/u);
    assert.match(candidate.quote.user, /<redacted:private-key>/u);
    // 指纹基于脱敏后的用户原话，不是原文。
    assert.equal(
      candidate.fingerprint,
      decisionFingerprint({ projectId: 'alpha', text: candidate.quote.user })
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('指纹基于脱敏后文本：同一句话换一个密钥仍只出一条候选', async () => {
  const root = tempRoot();
  try {
    const { alpha, projects } = seedProjects(root);
    for (const [id, key] of [['codex-key-a', 'a'.repeat(20)], ['codex-key-b', 'b'.repeat(20)]]) {
      writeLines(path.join(root, 'codex', 'sessions', '2026', '11', '25', `rollout-${id}.jsonl`), [
        codex.meta(alpha, id),
        codex.user(`统一用 sk-${key} 这一个密钥，别再换`),
        codex.assistant('好，只保留这一个')
      ]);
    }

    const result = await scanSessions({
      roots: [{ source: 'codex', dir: path.join(root, 'codex', 'sessions') }],
      projects,
      extract: echoExtract
    });

    assert.equal(result.counts.matched, 2);
    assert.equal(result.redactions, 2);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.fingerprints.length, 1);
    assert.equal(result.counts.skipped.existing, 1);
    assert.match(result.candidates[0].quote.user, /sk-…<redacted:api-key>/u);
    // 两个不同的原文密钥都被换成了同一段占位符，所以指纹相同；否则会是两条候选。
    assert.equal(JSON.stringify(result.candidates).includes('a'.repeat(20)), false);
    assert.equal(JSON.stringify(result.candidates).includes('b'.repeat(20)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 界面接线：预加载桥与主进程处理器必须对上。#111 撤旧壳后旧面板的扫描入口不再断言，
// 等新卡给「扫描会话」一个入口时再补界面那一层。
test('会话扫描从预加载桥到主进程是一条完整的线', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');
  const preload = read('desktop/preload.cjs');
  const main = read('desktop/main.cjs');

  assert.match(preload, /scanSessions:\s*\(\)\s*=>\s*invoke\('companion:session-scan'\)/u);
  assert.match(main, /ipcMain\.handle\('companion:session-scan'/u);
  // 扫描必须是显式动作：没有定时器把它挂在轮询里。
  assert.equal(/setInterval\([^)]*sessionScan/u.test(main), false);
});
