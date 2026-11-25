// #120 只读边界与统一入口：
// 1. 三个采集器的源码里不出现任何写文件的 API，也不出现写型 git 子命令（静态断言）；
// 2. 用真实 git 仓库与真实会话文件跑一遍，前后整棵目录/文件快照完全一致（运行期断言）；
// 3. collect() 按对象类型分派，三件实现返回同一个形状。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { collect, COLLECT_STATUS } from '../src/watch/collect.mjs';
import { collectProject } from '../src/watch/collect-project.mjs';
import { collectSession } from '../src/watch/collect-session.mjs';
import { collectGithub } from '../src/watch/collect-github.mjs';
import { WatchTargetError } from '../src/watch/target.mjs';

const WATCH_SRC = path.join(process.cwd(), 'src', 'watch');
const COLLECTOR_FILES = [
  'collect.mjs',
  'collect-result.mjs',
  'collect-project.mjs',
  'collect-session.mjs',
  'collect-github.mjs'
];
const sources = new Map(COLLECTOR_FILES.map((name) => [name, fs.readFileSync(path.join(WATCH_SRC, name), 'utf8')]));

/** 写文件的 API：采集器一个都不许出现（注释里也不该有，免得下一个人照着抄）。 */
const WRITE_APIS = /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync|mkdtemp|rmSync|unlinkSync|renameSync|copyFileSync|truncateSync|chmodSync|utimes|openSync)\b/u;

/** 只读 git 子命令词表：项目采集器只该跑这三类查询。 */
const READ_ONLY_SUBCOMMANDS = ['log', 'rev-parse', 'status'];

test('静态：采集器源码里没有任何写文件 API', () => {
  for (const [name, source] of sources) {
    const hit = WRITE_APIS.exec(source);
    assert.equal(hit, null, `${name} 不该出现写文件的 API：${hit?.[0] ?? ''}`);
  }
  assert.deepEqual([...COLLECT_STATUS], ['ok', 'unconfigured', 'error']);
});

test('静态：项目采集器只跑只读 git 子命令，且带 --no-optional-locks', () => {
  const source = sources.get('collect-project.mjs');
  // 源码里所有交给 git 执行器的 args 都以字面量开头：把它们抽出来，词表之外的一个都不许有。
  const invoked = [...source.matchAll(/attempt\(\[\s*'([^']+)'/gu)].map((match) => match[1]);
  assert.deepEqual([...new Set(invoked)].sort(), READ_ONLY_SUBCOMMANDS);
  assert.match(source, /--no-optional-locks/u);
  assert.match(source, /GIT_OPTIONAL_LOCKS/u);
});

const makeRepo = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-collect-repo-'));
  fs.writeFileSync(path.join(root, 'README.md'), '# demo\n');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'export const a = 1;\n');
  const git = (args) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'user.email', 'watch@example.invalid']);
  git(['config', 'user.name', 'Watch Fixture']);
  git(['add', '.']);
  git(['commit', '-qm', 'init']);
  return root;
};

/** 整棵目录的快照：相对路径 + 大小 + 修改时间 + 内容哈希。任何写操作都会让它变。 */
const snapshotTree = (root) => {
  const rows = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const info = fs.statSync(full);
      rows.push({
        path: path.relative(root, full).split(path.sep).join('/'),
        size: info.size,
        mtimeMs: info.mtimeMs,
        hash: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
      });
    }
  };
  walk(root);
  return rows.sort((a, b) => a.path.localeCompare(b.path));
};

test('运行期：真实仓库采集前后整棵树一致（干净工作区）', async () => {
  const root = makeRepo();
  const before = snapshotTree(root);

  const result = await collectProject({ type: 'project', projectId: 'alpha', root }, {
    since: '2020-01-01T00:00:00.000Z',
    now: new Date('2026-11-03T00:00:00.000Z')
  });

  assert.equal(result.status, 'ok');
  assert.ok(result.items.some((item) => item.kind === 'commit'), '真实 git 应读出提交');
  assert.deepEqual(result.items.find((item) => item.kind === 'workingTree'), { kind: 'workingTree', dirty: false });
  assert.deepEqual(snapshotTree(root), before, '采集不得改动被观察仓库（含 .git）');
});

test('运行期：真实仓库采集前后一致（工作区脏，含未跟踪文件）', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'notes.txt'), 'draft\n');
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'export const a = 2;\n');
  const before = snapshotTree(root);

  const result = await collectProject({ type: 'project', projectId: 'alpha', root });

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.items.find((item) => item.kind === 'workingTree'), { kind: 'workingTree', dirty: true });
  assert.deepEqual(snapshotTree(root), before, '读取「脏」也不能顺手碰文件（不改 index、不动工作区）');
});

test('运行期：真实会话文件采集前后字节、大小、修改时间都不变', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-collect-home-'));
  const dir = path.join(home, '.codex', 'sessions', '2026', '11', '25');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'rollout-2026-11-25T10-00-00-s9.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'response_item', timestamp: '2026-11-25T02:00:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-11-25T02:00:05.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '在' }] } })
  ].join('\n'));

  const before = snapshotTree(home);

  const result = await collectSession({ type: 'session', source: 'codex', sessionId: 's9' }, {
    since: '2026-11-25T00:00:00.000Z',
    now: new Date('2026-11-25T03:00:00.000Z'),
    deps: { homeDir: home, env: {} }
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.items.length, 2);
  assert.deepEqual(snapshotTree(home), before, '会话采集只读：不改写对方会话，也不留临时文件');
});

test('collect() 按类型分派，三件实现返回同一个形状', async () => {
  const projectGit = async ({ args }) => {
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n';
    if (args[0] === 'rev-parse' && args[1] === '--verify') return `${'b'.repeat(40)}\n`;
    if (args[0] === 'log') return `${['sha9', 'Owner', '2026-11-02T00:00:00.000Z', '提交'].join(String.fromCharCode(31))}\n`;
    if (args[0] === 'status') return '';
    throw new Error(`unexpected ${args.join(' ')}`);
  };

  const project = await collect(
    { type: 'project', projectId: 'alpha', root: 'D:/repos/alpha' },
    { deps: { git: projectGit } }
  );
  const session = await collect(
    { type: 'session', source: 'codex', sessionId: 'abc123' },
    {
      deps: {
        findSessionFile: async () => ({ file: '/sessions/rollout-abc123.jsonl' }),
        readFile: async () => ''
      }
    }
  );
  const github = await collect(
    { type: 'github', owner: 'o', repo: 'r', focus: ['commits'] },
    { deps: { token: '', env: {} } }
  );

  for (const result of [project, session, github]) {
    assert.deepEqual(Object.keys(result), ['type', 'ref', 'status', 'items', 'cursor', 'error']);
    assert.ok(COLLECT_STATUS.includes(result.status));
    assert.ok(Array.isArray(result.items));
  }
  assert.equal(project.ref, 'project:alpha');
  assert.equal(session.ref, 'session:codex:abc123');
  assert.equal(github.ref, 'github:o/r');
  assert.equal(github.status, 'unconfigured');
});

test('collect() 对坏描述符仍然明确拒绝（不兜底猜测）', async () => {
  await assert.rejects(() => collect({ type: 'repo', projectId: 'alpha' }, {}), WatchTargetError);
  await assert.rejects(() => collect({ type: 'github', owner: 'o', repo: 'r', focus: [] }, {}), WatchTargetError);
});
