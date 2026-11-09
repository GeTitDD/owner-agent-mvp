// WriterAgent：隔离 worktree 内的受控写入与变更采集。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WriterAgent } from '../src/writer-agent.mjs';

const makeRepo = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-agent-'));
  fs.writeFileSync(path.join(root, 'README.md'), '# demo\n');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'export const a = 1;\n');
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'user.email', 'w@example.invalid']);
  git(['config', 'user.name', 'Writer Fixture']);
  git(['add', '.']);
  git(['commit', '-qm', 'init']);
  return root;
};

const factoryThat = (mutate) => ({
  async create({ cwd }) {
    return {
      prompt: async () => { mutate(cwd); },
      abort: () => {},
      getLastText: () => '',
      dispose: () => {}
    };
  }
});

test('采集新增与修改文件，返回相对路径与内容', async () => {
  const root = makeRepo();
  const agent = new WriterAgent({
    model: 'fake/model',
    sessionFactory: factoryThat((cwd) => {
      fs.writeFileSync(path.join(cwd, 'docs.md'), '# docs\n');
      fs.writeFileSync(path.join(cwd, 'src', 'app.js'), 'export const a = 2;\n');
    })
  });
  const result = await agent.generate({ cwd: root, taskTitle: 'add docs' });
  assert.equal(result.model, 'fake/model');
  const byPath = Object.fromEntries(result.files.map((file) => [file.path, file.content]));
  assert.equal(byPath['docs.md'], '# docs\n');
  assert.equal(byPath['src/app.js'], 'export const a = 2;\n');
});

test('没有改动时返回 empty-write，不伪造补丁', async () => {
  const root = makeRepo();
  const agent = new WriterAgent({ sessionFactory: factoryThat(() => {}) });
  await assert.rejects(
    () => agent.generate({ cwd: root, taskTitle: 'noop' }),
    (error) => error.category === 'empty-write'
  );
});

test('删除或重命名被拒绝', async () => {
  const root = makeRepo();
  const agent = new WriterAgent({
    sessionFactory: factoryThat((cwd) => { fs.rmSync(path.join(cwd, 'README.md')); })
  });
  await assert.rejects(
    () => agent.generate({ cwd: root, taskTitle: 'delete' }),
    (error) => error.category === 'unsafe-change'
  );
});

test('文件数量上限阻止过大提案', async () => {
  const root = makeRepo();
  const agent = new WriterAgent({
    maxFiles: 1,
    sessionFactory: factoryThat((cwd) => {
      fs.writeFileSync(path.join(cwd, 'a.md'), 'a\n');
      fs.writeFileSync(path.join(cwd, 'b.md'), 'b\n');
    })
  });
  await assert.rejects(
    () => agent.generate({ cwd: root, taskTitle: 'too many' }),
    (error) => error.category === 'invalid-proposal'
  );
});
