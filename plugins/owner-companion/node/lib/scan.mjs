// 项目扫描模块（Cindy 插件 Node worker 专用，ESM，只用 node 内置模块）。
//
// 目标：在有限时间预算内只读地收集项目“事实”，供 buildQuickBrief 生成快速画像。
// 设计原则：
//   - 目录/文件读取失败一律静默跳过，不向上抛异常；
//   - 全程异步，跑在总时间预算（默认 2000ms）里，超时就带着已收集结果返回；
//   - 单个文件最多只读开头 64KB，避免被大文件或网络盘拖住。
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 扫描时整体跳过的目录名（不进入，也不出现在 topLevel）。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.venv', 'venv', '__pycache__',
  '.next', '.nuxt', 'obj', 'bin', 'coverage', '.pi', '.cache'
]);

/** 计入源码文件数的扩展名。 */
const SOURCE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.cs', '.rs', '.go'
]);

/** README 的优先顺序，找不到时再按大小写不敏感兜底。 */
const README_NAMES = ['README.md', 'readme.md', 'README.txt'];

const MAX_READ_BYTES = 64 * 1024;
const MAX_SOURCE_FILES = 500;
const MAX_TODO_FILES = 60;
const MAX_TOP_LEVEL = 24;
const MAX_TEST_FILES = 10;
const MAX_ENTRY_FILES = 8;
const MAX_README_LINES = 200;
const MAX_SUMMARY_CHARS = 800;
/** 递归深度与遍历次数上限，防止误扫到巨大的目录树。 */
const MAX_WALK_DEPTH = 8;
const MAX_WALK_FILES = 4000;

/** 常见入口文件的相对路径特征。 */
const ENTRY_RE = new RegExp(
  '(?:^|/)(?:main|index|app)\\.(?:js|mjs|cjs|jsx|ts|tsx)$'
  + '|(?:^|/)(?:main|app|__main__)\\.py$'
  + '|(?:^|/)program\\.cs$'
  + '|(?:^|/)manage\\.py$'
  + '|(?:^|/)main\\.go$'
  + '|(?:^|/)main\\.rs$',
  'iu'
);

/** 测试文件的路径特征：tests/ 目录或 *.test.* / *_test.* 等命名。 */
const TEST_PATH_RE = /(?:^|\/)(?:tests?|__tests__|specs?)\//iu;
const TEST_NAME_RE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:py|go)$|(?:^|\/)test_[^/]+\.py$|(?:Tests?|Spec)\.cs$)/iu;

/** TODO/FIXME 计数规则（区分大小写，按出现次数累加）。 */
const TODO_RE = /\b(?:TODO|FIXME)\b/gu;

/** 统一成 POSIX 风格的相对路径，便于跨平台断言与展示。 */
const toPosix = (value) => String(value).split(path.sep).join('/');

/** 预算是否已经用完。 */
const expired = (deadline) => Date.now() >= deadline;

/**
 * 读取文件开头若干字节（默认 64KB），不把整个大文件读进内存。
 * @param {string} file 绝对路径
 * @param {number} [maxBytes] 最多读取的字节数
 * @returns {Promise<string>} 文本内容（按 UTF-8 解码）
 */
async function readHead(file, maxBytes = MAX_READ_BYTES) {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * 把 Markdown / 纯文本压成一行摘要。
 * 只处理前 200 行，去掉代码块、图片、HTML 注释与 Markdown 记号。
 * @param {string} raw 原始文本
 * @returns {string} 最多 800 字的单行摘要
 */
function summarizeReadme(raw) {
  const text = String(raw ?? '')
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .slice(0, MAX_README_LINES)
    .join('\n')
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]*/gmu, '')
    .replace(/^[ \t]*[-*+][ \t]+/gmu, '')
    .replace(/^[ \t]*>[ \t]?/gmu, '')
    .replace(/[`*_~|]/gu, ' ')
    .replace(/[ \t]+/gu, ' ');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, MAX_SUMMARY_CHARS);
}

/** 从顶层条目里挑一个 README 文件名（相对 root）。 */
function pickReadme(entries) {
  const files = entries.filter((entry) => entry.isFile());
  for (const name of README_NAMES) {
    const hit = files.find((entry) => entry.name === name);
    if (hit) return hit.name;
  }
  const loose = files.find((entry) => /^readme(?:\.(?:md|txt|markdown))?$/iu.test(entry.name));
  return loose ? loose.name : null;
}

/**
 * 判断技术栈：优先看顶层标记文件，识别不出时交给扩展名统计兜底。
 * @param {import('node:fs').Dirent[]} entries 顶层条目
 * @returns {'node'|'dotnet'|'python'|'rust'|'go'|'unknown'} 技术栈
 */
function detectEcosystem(entries) {
  const names = new Set(entries.map((entry) => entry.name.toLowerCase()));
  const has = (name) => names.has(name);
  if (has('package.json')) return 'node';
  if (entries.some((entry) => entry.isFile() && /\.(?:csproj|sln|fsproj|vbproj)$/iu.test(entry.name))) {
    return 'dotnet';
  }
  if (['pyproject.toml', 'requirements.txt', 'setup.py', 'manage.py', 'pipfile'].some(has)) {
    return 'python';
  }
  if (has('cargo.toml')) return 'rust';
  if (has('go.mod')) return 'go';
  return 'unknown';
}

/**
 * 按源码扩展名数量推断技术栈（仅在标记文件缺失时使用）。
 * @param {Map<string, number>} counts 扩展名 → 文件数
 */
function ecosystemFromExts(counts) {
  const sum = (...exts) => exts.reduce((total, ext) => total + (counts.get(ext) ?? 0), 0);
  const ranked = [
    ['node', sum('.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx')],
    ['python', sum('.py')],
    ['dotnet', sum('.cs')],
    ['rust', sum('.rs')],
    ['go', sum('.go')]
  ];
  const best = ranked.reduce((left, right) => (right[1] > left[1] ? right : left), ['unknown', 0]);
  return best[1] > 0 ? best[0] : 'unknown';
}

/** 是否为测试文件（只看相对路径）。 */
function isTestFile(rel) {
  return TEST_PATH_RE.test(rel) || TEST_NAME_RE.test(rel);
}

/**
 * 异步遍历项目目录，收集源码/测试/入口/顶层条目。
 * 用显式栈做 DFS，逐个目录 await，超时或达到上限就停在已完成的部分。
 * @param {string} root 项目根目录（绝对路径）
 * @param {number} deadline 时间预算截止时间戳
 * @returns {Promise<{topLevel: string[], sourceFiles: string[], testFiles: string[], entryFiles: string[], extCounts: Map<string, number>}>}
 */
async function walkTree(root, deadline) {
  const topLevel = [];
  const sourceFiles = [];
  const testFiles = [];
  const entryFiles = [];
  const extCounts = new Map();
  const stack = [{ abs: root, rel: '', depth: 0 }];
  let fileCount = 0;

  while (stack.length && !expired(deadline) && fileCount < MAX_WALK_FILES) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

    for (const entry of entries) {
      if (expired(deadline)) break;
      const name = entry.name;
      // 点文件/点目录（.git、.env、.github 等）统一忽略。
      if (name.startsWith('.')) continue;
      const rel = dir.rel ? `${dir.rel}/${name}` : name;
      const abs = path.join(dir.abs, name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        if (dir.depth === 0) topLevel.push({ name, isDir: true });
        if (dir.depth + 1 <= MAX_WALK_DEPTH) {
          stack.push({ abs, rel, depth: dir.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;

      fileCount += 1;
      if (dir.depth === 0) topLevel.push({ name, isDir: false });
      const ext = path.extname(name).toLowerCase();
      if (!SOURCE_EXTS.has(ext)) continue;

      extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
      if (sourceFiles.length < MAX_SOURCE_FILES) sourceFiles.push(abs);
      if (testFiles.length < MAX_TEST_FILES && isTestFile(rel)) testFiles.push(rel);
      if (entryFiles.length < MAX_ENTRY_FILES && ENTRY_RE.test(rel)) entryFiles.push(rel);
    }
  }

  // 顶层条目：目录在前、文件在后，各自按名称排序，最多 24 个。
  const orderedTopLevel = topLevel
    .sort((left, right) => (
      Number(right.isDir) - Number(left.isDir)
      || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    ))
    .map((entry) => entry.name)
    .slice(0, MAX_TOP_LEVEL);

  // 入口文件按“越浅越靠前”排序，根目录的 index/main 优先。
  entryFiles.sort((left, right) => (
    left.split('/').length - right.split('/').length
    || (left < right ? -1 : left > right ? 1 : 0)
  ));

  return {
    topLevel: orderedTopLevel,
    sourceFiles,
    testFiles: testFiles.slice(0, MAX_TEST_FILES),
    entryFiles: entryFiles.slice(0, MAX_ENTRY_FILES),
    extCounts
  };
}

/**
 * 统计前若干个源码文件里的 TODO/FIXME 次数。
 * 小并发（6 个）读取，每个文件只看开头 64KB。
 * @param {string[]} files 源码文件绝对路径
 * @param {number} deadline 时间预算截止时间戳
 * @returns {Promise<number>} 出现次数
 */
async function countTodos(files, deadline) {
  let total = 0;
  let index = 0;
  const workerCount = Math.min(6, files.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (index < files.length && !expired(deadline)) {
      const file = files[index];
      index += 1;
      try {
        const text = await readHead(file);
        const matches = text.match(TODO_RE);
        if (matches) total += matches.length;
      } catch {
        // 单个文件读失败不影响整体统计。
      }
    }
  });
  await Promise.all(workers);
  return total;
}

/**
 * 读取 git 分支与 HEAD；不是仓库、没装 git 或超时都返回 null。
 * @param {string} root 项目根目录
 * @param {number} deadline 时间预算截止时间戳
 * @returns {Promise<{branch: string, head: string} | null>}
 */
async function readGit(root, deadline) {
  const remaining = deadline - Date.now();
  if (remaining < 150) return null;
  const timeout = Math.min(remaining, 1500);
  const run = (args) => execFileAsync('git', args, { windowsHide: true, timeout })
    .then(({ stdout }) => String(stdout ?? '').trim())
    .catch(() => '');
  const [head, branch] = await Promise.all([
    run(['-C', root, 'rev-parse', 'HEAD']),
    run(['-C', root, 'branch', '--show-current'])
  ]);
  if (!head) return null;
  return { branch, head };
}

/** 读取 README，失败返回 null。 */
async function readReadme(absPath, relPath) {
  try {
    const raw = await readHead(absPath);
    return { path: relPath, summary: summarizeReadme(raw) };
  } catch {
    return null;
  }
}

/**
 * 读取 package.json：返回名称与可读的脚本列表（形如 "npm run dev: vite"）。
 * 解析失败返回 null。
 */
async function readPackageJson(absPath) {
  try {
    const raw = await readHead(absPath);
    const data = JSON.parse(raw);
    const scripts = data && typeof data.scripts === 'object' && data.scripts !== null
      ? Object.entries(data.scripts)
        .filter(([, value]) => typeof value === 'string' && value.trim())
        .map(([key, value]) => `npm run ${key}: ${String(value).trim().slice(0, 80)}`)
      : [];
    return {
      name: typeof data?.name === 'string' ? data.name : '',
      scripts
    };
  } catch {
    return null;
  }
}

/**
 * 扫描一个本地项目目录，收集画像所需的事实。
 *
 * 全程只读、带总时间预算；超时、目录不可读或文件损坏时都返回已收集到的部分，
 * 不抛异常，调用方可以放心把它当成“尽力而为”的结果。
 *
 * @param {string} root 项目根目录
 * @param {{timeoutMs?: number}} [options] timeoutMs：总时间预算，默认 2000ms
 * @returns {Promise<{
 *   name: string,
 *   root: string,
 *   readme: {path: string, summary: string} | null,
 *   packageJson: {name: string, scripts: string[]} | null,
 *   ecosystem: 'node'|'dotnet'|'python'|'rust'|'go'|'unknown',
 *   topLevel: string[],
 *   sourceCount: number,
 *   testFiles: string[],
 *   entryFiles: string[],
 *   todoCount: number,
 *   git: {branch: string, head: string} | null
 * }>}
 */
export async function scanProject(root, { timeoutMs = 2000 } = {}) {
  const budget = Number(timeoutMs);
  const deadline = Date.now() + (Number.isFinite(budget) && budget > 0 ? budget : 2000);
  const absRoot = path.resolve(String(root ?? ''));
  const result = {
    name: path.basename(absRoot) || absRoot,
    root: absRoot,
    readme: null,
    packageJson: null,
    ecosystem: 'unknown',
    topLevel: [],
    sourceCount: 0,
    testFiles: [],
    entryFiles: [],
    todoCount: 0,
    git: null
  };

  let entries;
  try {
    entries = await fsp.readdir(absRoot, { withFileTypes: true });
  } catch {
    // 根目录都读不了（不存在/无权限/网络断）：只尽量补一个 git 信息后返回。
    result.git = await readGit(absRoot, deadline);
    return result;
  }

  result.ecosystem = detectEcosystem(entries);

  // README 与 package.json 都是小文件，并行读取。
  const readmeName = pickReadme(entries);
  const pkgEntry = entries.find(
    (entry) => entry.isFile() && entry.name.toLowerCase() === 'package.json'
  );
  const [readme, packageJson] = await Promise.all([
    readmeName ? readReadme(path.join(absRoot, readmeName), readmeName) : Promise.resolve(null),
    pkgEntry ? readPackageJson(path.join(absRoot, pkgEntry.name)) : Promise.resolve(null)
  ]);
  result.readme = readme;
  result.packageJson = packageJson;

  const tree = await walkTree(absRoot, deadline);
  result.topLevel = tree.topLevel;
  result.sourceCount = tree.sourceFiles.length;
  result.testFiles = tree.testFiles;
  result.entryFiles = tree.entryFiles;
  if (result.ecosystem === 'unknown') {
    result.ecosystem = ecosystemFromExts(tree.extCounts);
  }

  result.todoCount = await countTodos(tree.sourceFiles.slice(0, MAX_TODO_FILES), deadline);
  result.git = await readGit(absRoot, deadline);
  return result;
}
