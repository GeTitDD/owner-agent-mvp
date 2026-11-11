// 补丁提案与测试运行：只在本地应用，必须人工确认。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const ALLOWED_TEST = /^(?:npm (?:run [\w:.-]+|test)|node --test|pytest|python -m pytest|dotnet test|cargo test|go test)\b/u;

/** 校验统一 diff：必须是 git diff 格式，且路径不能逃出项目根目录。 */
export function validateDiff(diff) {
  const text = String(diff ?? '');
  if (!text.trim()) throw new Error('补丁为空');
  if (text.length > 200000) throw new Error('补丁过大（上限 200KB）');
  if (!/^diff --git /mu.test(text)) throw new Error('补丁必须是 git diff 格式');
  for (const line of text.split(/\r?\n/u)) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/u.exec(line);
    if (!match) continue;
    for (const file of [match[1], match[2]]) {
      if (file.startsWith('/') || /^[A-Za-z]:/u.test(file) || file.split('/').includes('..')) {
        throw new Error(`补丁路径不合法：${file}`);
      }
    }
  }
  return text;
}

export function createPatchService({ exec = execFileAsync } = {}) {
  const apply = async (root, diff, { baseCommit = '' } = {}) => {
    const text = validateDiff(diff);
    if (baseCommit) {
      const { stdout } = await exec('git', ['-C', root, 'rev-parse', 'HEAD'], {
        timeout: 5000, windowsHide: true
      });
      if (stdout.trim() !== baseCommit) {
        throw new Error('代码已经变化（base commit 不匹配），请重新生成补丁');
      }
    }
    const file = path.join(os.tmpdir(), `owner-patch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.patch`);
    fs.writeFileSync(file, text);
    try {
      await exec('git', ['-C', root, 'apply', '--check', file], {
        timeout: 20000, windowsHide: true, maxBuffer: 2 * 1024 * 1024
      });
      await exec('git', ['-C', root, 'apply', file], {
        timeout: 20000, windowsHide: true, maxBuffer: 2 * 1024 * 1024
      });
    } finally {
      fs.rmSync(file, { force: true });
    }
    return { ok: true };
  };

  const runTests = async (root, { command = '', timeoutMs = 120000 } = {}) => {
    const raw = String(command ?? '').trim() || 'npm test';
    if (!ALLOWED_TEST.test(raw)) {
      throw new Error('只允许 npm test / npm run <script> / node --test / pytest / dotnet test / cargo test / go test');
    }
    const [bin, ...args] = raw.split(/\s+/u);
    const executable = process.platform === 'win32' && bin === 'npm' ? 'npm.cmd' : bin;
    const started = Date.now();
    // 插件本身也可能在 node --test 里被调用，必须去掉嵌套测试标记，
    // 否则子进程会以“递归运行”为由直接跳过并返回 0。
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    try {
      const { stdout, stderr } = await exec(executable, args, {
        cwd: root,
        timeout: Math.min(300000, Math.max(5000, timeoutMs)),
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env
      });
      return {
        ok: true,
        command: raw,
        durationMs: Date.now() - started,
        output: `${stdout}\n${stderr}`.trim().slice(-8000)
      };
    } catch (error) {
      const output = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`.trim() || String(error?.message ?? error);
      return {
        ok: false,
        command: raw,
        durationMs: Date.now() - started,
        code: Number(error?.code) || 1,
        output: output.slice(-8000)
      };
    }
  };

  return { apply, runTests };
}
