// Monty 代码执行器：给 WriterAgent 的 own_python 工具提供受限 Python 运行时。
//
// 隔离边界：
// - 只有 worktree 被挂载到 /workspace（可读写），沙箱内没有环境变量与网络；
// - 每次 generate 一个 pool，每次工具调用一个 session，调用结束即关闭；
// - 资源上限：内存、单次执行时长、递归深度、输出字节。
import { CollectString, Monty } from '@pydantic/monty';
import { MountDir } from '@pydantic/monty/node';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const requireFromHere = createRequire(import.meta.url);

/** 解析 Monty worker 二进制；Electron 打包后需要指向 app.asar.unpacked。 */
export function resolveMontyBinaryPath() {
  if (process.env.MONTY_BIN) return process.env.MONTY_BIN;
  try {
    let nodeModules;
    try {
      const pkg = requireFromHere.resolve('@pydantic/monty/package.json');
      nodeModules = path.dirname(path.dirname(pkg));
    } catch {
      // 包可能不允许从 exports 里取 package.json：退回主入口定位。
      const entry = requireFromHere.resolve('@pydantic/monty');
      nodeModules = path.resolve(path.dirname(entry), '..', '..', '..');
    }
    const scopeDir = path.join(nodeModules, '@pydantic');
    const names = fs.readdirSync(scopeDir).filter((name) => name.startsWith('monty-'));
    const binName = process.platform === 'win32' ? 'monty.exe' : 'monty';
    for (const name of names) {
      const raw = path.join(scopeDir, name, binName);
      const unpacked = raw.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
      if (unpacked !== raw && fs.existsSync(unpacked)) return unpacked;
      if (fs.existsSync(raw)) return raw;
    }
  } catch { /* fall through to Monty's own resolution */ }
  return null;
}

const MAX_OUTPUT_BYTES = 256 * 1024;
const RESULT_TEXT_CHARS = 20000;

const toText = (value) => {
  if (value === undefined) return '';
  try {
    const text = JSON.stringify(value, (_key, item) => {
      if (item instanceof Map) return Object.fromEntries(item);
      if (item instanceof Set) return [...item];
      if (typeof Buffer !== 'undefined' && Buffer.isBuffer(item)) return `<${item.length} bytes>`;
      if (typeof item === 'bigint') return `${item}n`;
      return item;
    });
    return text ?? String(value);
  } catch {
    return String(value);
  }
};

/** 检测当前平台是否装了可用的 Monty 原生包。 */
export async function montyAvailable() {
  try {
    await import('@pydantic/monty');
    await import('@pydantic/monty/node');
    return true;
  } catch {
    return false;
  }
}

/**
 * 为一个 worktree 创建执行器。
 * @param {{cwd: string, limits?: object}} options
 */
export async function createMontyRunner({ cwd, mode = 'read-write', limits = {} } = {}) {
  if (!cwd) throw new Error('cwd is required');
  const binaryPath = resolveMontyBinaryPath();
  const pool = await Monty.create({
    minProcesses: 1,
    maxProcesses: 1,
    ...(binaryPath ? { binaryPath } : {})
  });
  const mount = new MountDir({ hostPath: cwd, virtualPath: '/workspace', mode });
  const session = await pool.checkout({
    limits: {
      maxMemory: limits.maxMemory ?? 128 * 1024 * 1024,
      maxFeedDurationSecs: limits.maxFeedDurationSecs ?? 8,
      maxRecursionDepth: limits.maxRecursionDepth ?? 200
    }
  });
  let closed = false;
  return {
    /** 执行一段 Python；返回 stdout 与末尾表达式结果（JSON 文本）。 */
    async run(code, { inputs = {} } = {}) {
      if (closed) throw new Error('monty runner is closed');
      const source = String(code ?? '');
      if (!source.trim()) throw new Error('empty python code');
      if (source.length > 200000) throw new Error('python code is too large');
      const collector = new CollectString(MAX_OUTPUT_BYTES);
      const value = await session.feedRun(source, { mount, inputs, printCallback: collector });
      const output = String(collector.output ?? '').slice(0, RESULT_TEXT_CHARS);
      const result = toText(value).slice(0, RESULT_TEXT_CHARS);
      return { output, result };
    },
    async close() {
      if (closed) return;
      closed = true;
      try { await session.close(); } catch { /* best effort */ }
      try { await pool.close(); } catch { /* best effort */ }
      try { mount.close(); } catch { /* best effort */ }
    }
  };
}
