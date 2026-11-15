// Monty 运行器：真实 Python 子集执行、worktree 挂载与资源边界。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMontyRunner, montyAvailable } from '../src/monty-runner.mjs';

const available = await montyAvailable();

test('Monty 执行 Python 并挂载 worktree（读写）', { skip: !available }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monty-runner-'));
  const runner = await createMontyRunner({ cwd: dir });
  try {
    const sum = await runner.run('sum(range(10))');
    assert.equal(sum.result, '45');

    const run = await runner.run([
      'from pathlib import Path',
      "Path('notes.txt').write_text('hello monty')",
      "print(Path('notes.txt').read_text().upper())"
    ].join('\n'));
    assert.match(run.output, /HELLO MONTY/u);
    assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'hello monty');
  } finally {
    await runner.close();
  }
});

test('只读挂载拒绝写入', { skip: !available }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monty-readonly-'));
  const runner = await createMontyRunner({ cwd: dir, mode: 'read-only' });
  try {
    await assert.rejects(
      () => runner.run("from pathlib import Path\nPath('blocked.txt').write_text('no')"),
      /read.only|denied|permission|OSError|EROFS/iu
    );
    assert.equal(fs.existsSync(path.join(dir, 'blocked.txt')), false);
  } finally {
    await runner.close();
  }
});

test('Monty 拒绝网络/子进程模块', { skip: !available }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monty-block-'));
  const runner = await createMontyRunner({ cwd: dir });
  try {
    await assert.rejects(() => runner.run('import socket'), /socket|ModuleNotFound|ImportError/u);
    await assert.rejects(() => runner.run('import subprocess'), /subprocess|ModuleNotFound|ImportError/u);
  } finally {
    await runner.close();
  }
});

test('Monty 资源限制会中止死循环', { skip: !available }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monty-limit-'));
  const runner = await createMontyRunner({ cwd: dir, limits: { maxFeedDurationSecs: 1 } });
  try {
    await assert.rejects(() => runner.run('while True:\n    pass'), /time|duration|limit|Runtime/u);
  } finally {
    await runner.close();
  }
});
