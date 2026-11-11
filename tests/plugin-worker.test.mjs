// Cindy 插件 worker：自包含数据层（项目 / 画像 / 想法 / 知识 / 依赖图）的 RPC 契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKER = path.join(ROOT, 'plugins', 'owner-companion', 'node', 'worker.cjs');

const setup = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-plugin-'));
  const projectRoot = path.join(dir, 'demo');
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'README.md'), '# Demo\n\nA tiny demo project.\n');
  fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'demo', scripts: { test: 'node --test', dev: 'node src/index.js' }
  }, null, 2));
  fs.writeFileSync(path.join(projectRoot, 'src', 'index.js'), "import './util.js';\n// TODO: add export\n");
  fs.writeFileSync(path.join(projectRoot, 'src', 'util.js'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(projectRoot, 'tests', 'index.test.js'), "import '../src/index.js';\n");

  const child = spawn(process.execPath, [WORKER], {
    env: { ...process.env, OWNER_COMPANION_DIR: path.join(dir, 'plugin') },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const lines = readline.createInterface({ input: child.stdout });
  const waiting = new Map();
  let nextId = 0;
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const entry = waiting.get(message.id);
    if (!entry) return;
    waiting.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });

  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      if (!waiting.has(id)) return;
      waiting.delete(id);
      reject(new Error(`worker timeout: ${method}`));
    }, 20000);
    waiting.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  return {
    dir,
    projectRoot,
    rpc,
    async cleanup() {
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
};

test('worker：项目、画像、想法、知识、依赖图全部自包含', async () => {
  const env = await setup();
  try {
    const status = await env.rpc('owner/status');
    assert.equal(status.ok, true);

    const added = await env.rpc('owner/projects/add', { path: env.projectRoot });
    assert.equal(added.created, true);
    assert.equal(added.project.name, 'demo');

    const duplicate = await env.rpc('owner/projects/add', { path: env.projectRoot });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.project.id, added.project.id);

    const empty = await env.rpc('owner/projects/overview', {});
    assert.equal(empty.activeProjectId, 'demo');
    assert.equal(empty.brief, null);
    assert.equal(empty.nextAction.command, 'brief');

    const briefResult = await env.rpc('owner/brief/refresh', { projectId: 'demo' });
    assert.match(briefResult.brief.oneLiner, /Demo|demo/u);
    assert.ok(briefResult.brief.howToRun.length > 0);

    const withBrief = await env.rpc('owner/projects/overview', { projectId: 'demo' });
    assert.ok(withBrief.brief);
    assert.equal(withBrief.nextAction.command, 'chat');

    const idea = await env.rpc('owner/ideas/add', { projectId: 'demo', title: '加一个导出按钮' });
    assert.equal(idea.status, 'todo');
    const afterIdea = await env.rpc('owner/projects/overview', { projectId: 'demo' });
    assert.equal(afterIdea.nextAction.command, 'ideas');
    const again = await env.rpc('owner/ideas/add', { projectId: 'demo', title: '加一个导出按钮' });
    assert.equal(again.id, idea.id);

    const adopted = await env.rpc('owner/ideas/status', { id: idea.id, status: 'done' });
    assert.equal(adopted.status, 'done');
    const listed = await env.rpc('owner/ideas/list', { projectId: 'demo', status: 'done' });
    assert.equal(listed.ideas.length, 1);

    const knowledge = await env.rpc('owner/knowledge/add', {
      projectId: 'demo', title: '零依赖', tags: ['node']
    });
    assert.equal(knowledge.status, 'unverified');
    const knowledgeList = await env.rpc('owner/knowledge/list', { projectId: 'demo' });
    assert.equal(knowledgeList.items.length, 1);

    const proposed = await env.rpc('owner/knowledge/propose', {
      projectId: 'demo',
      title: '测试命令应该用 node --test',
      body: 'package.json 的 scripts.test 是 node --test',
      evidence: ['package.json:4']
    });
    assert.equal(proposed.status, 'proposed');
    const pending = await env.rpc('owner/knowledge/list', { projectId: 'demo', status: 'proposed' });
    assert.equal(pending.items.length, 1);

    const accepted = await env.rpc('owner/knowledge/review', { id: proposed.id, decision: 'accept' });
    assert.equal(accepted.status, 'unverified');
    const verified = await env.rpc('owner/knowledge/verify', { id: proposed.id });
    assert.equal(verified.status, 'verified');

    const experience = await env.rpc('owner/experiences/add', {
      projectId: 'demo', text: '先跑 node --test 再改代码', outcome: 'success'
    });
    assert.equal(experience.distilled, false);
    const experiences = await env.rpc('owner/experiences/list', { projectId: 'demo' });
    assert.equal(experiences.items.length, 1);

    const tidy = await env.rpc('owner/knowledge/tidy', { projectId: 'demo' });
    assert.deepEqual(tidy.duplicates, []);
    assert.equal(tidy.proposed.length, 0);

    const search = await env.rpc('owner/knowledge/search', { query: '零依赖', projectId: 'demo' });
    assert.equal(search.items.length, 1);

    const patch = await env.rpc('owner/patches/propose', {
      projectId: 'demo',
      title: '把 a.txt 改成 two',
      diff: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n'
    });
    assert.equal(patch.status, 'pending');
    const rejected = await env.rpc('owner/patches/reject', { id: patch.id });
    assert.equal(rejected.status, 'rejected');

    const testRun = await env.rpc('owner/tests/run', { projectId: 'demo', command: 'node --test' });
    assert.equal(typeof testRun.ok, 'boolean');
    assert.ok(testRun.command);

    const github = await env.rpc('owner/github/status', { projectId: 'demo' });
    assert.equal(github.ok, false);

    const diagram = await env.rpc('owner/diagrams/dependency', { projectId: 'demo' });
    assert.equal(diagram.kind, 'dependency');
    assert.match(diagram.mermaid, /flowchart LR/u);
    assert.ok(diagram.version >= 1);

    const removed = await env.rpc('owner/projects/remove', { id: 'demo' });
    assert.equal(removed.removed, true);
    const after = await env.rpc('owner/projects/list');
    assert.equal(after.projects.length, 0);
  } finally {
    await env.cleanup();
  }
});

test('worker：不存在的目录会被拒绝', async () => {
  const env = await setup();
  try {
    await assert.rejects(
      () => env.rpc('owner/projects/add', { path: path.join(env.dir, 'missing') }),
      /目录不存在/u
    );
  } finally {
    await env.cleanup();
  }
});
