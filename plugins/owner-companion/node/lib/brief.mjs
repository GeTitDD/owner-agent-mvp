// 快速画像模块（Cindy 插件 Node worker 专用，ESM，只用 node 内置模块）。
//
// 纯函数：输入 scanProject 的结果，输出一份普通用户也能读懂的项目画像。
// 这里不读文件、不联网，方便在 worker 里随时调用与单测。

/** 各技术栈识别不出脚本时的兜底运行命令。 */
const ECOSYSTEM_RUN = {
  node: ['npm install', 'npm test'],
  python: ['python -m pip install -r requirements.txt', 'python -m pytest'],
  dotnet: ['dotnet restore', 'dotnet test'],
  rust: ['cargo build', 'cargo test'],
  go: ['go build ./...', 'go test ./...'],
  unknown: ['先阅读 README 与入口文件，再决定运行命令']
};

/** 各技术栈的验证命令（用于 verify.commands）。 */
const ECOSYSTEM_VERIFY = {
  node: ['npm test'],
  python: ['python -m pytest'],
  dotnet: ['dotnet test'],
  rust: ['cargo test'],
  go: ['go test ./...'],
  unknown: []
};

/** 顶层目录的常见职责，用于给 modules 写一句人话说明。 */
const TOP_LEVEL_HINTS = {
  src: '源代码',
  app: '应用代码',
  apps: '子应用/包',
  packages: '内部包',
  lib: '库代码',
  server: '服务端代码',
  client: '客户端代码',
  web: '前端资源',
  desktop: '桌面端代码',
  mobile: '移动端代码',
  docs: '文档',
  doc: '文档',
  test: '测试',
  tests: '测试',
  scripts: '脚本与工具',
  config: '配置',
  public: '静态资源',
  static: '静态资源',
  assets: '静态资源',
  examples: '示例',
  migrations: '数据库迁移',
  adapters: '适配层',
  domains: '领域实现',
  bin: '可执行入口'
};

const asArray = (value) => (Array.isArray(value) ? value : []);

/** 顶层条目的一句话说明。 */
function describeTopLevel(name) {
  const hint = TOP_LEVEL_HINTS[String(name).toLowerCase()];
  return hint ? `顶层目录：${hint}` : '顶层条目，快速了解项目时可先看一眼';
}

/**
 * 取第一段/第一句话作为一句话介绍。
 * 英文句点必须后跟空白或结尾才算断句，避免把 v1.0.0 切断。
 * @param {string} text 已压缩成一行的摘要
 * @returns {string} 最多 120 字的一句话
 */
function firstParagraph(text) {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (!value) return '';
  const sentence = value.split(/(?<=[。！？])\s*|(?<=[.!?])\s+/u)[0] ?? value;
  return sentence.trim().slice(0, 120);
}

/**
 * 由扫描结果生成快速画像。
 *
 * 入参缺失或字段类型异常时按空值处理，保证 worker 侧永远拿得到完整结构。
 *
 * @param {object} scan scanProject 的返回值
 * @returns {{
 *   oneLiner: string,
 *   whatItIs: string,
 *   howToRun: string[],
 *   modules: Array<{path: string, title: string, detail: string}>,
 *   verify: {commands: string[], criteria: string[]},
 *   risks: string[],
 *   evidence: string[],
 *   generatedAt: string,
 *   basedOnCommit: string,
 *   source: 'local-scan'
 * }}
 */
export function buildQuickBrief(scan) {
  const input = scan && typeof scan === 'object' ? scan : {};
  const name = String(input.name ?? '').trim() || '项目';
  const ecosystem = typeof input.ecosystem === 'string' && input.ecosystem
    ? input.ecosystem
    : 'unknown';
  const readme = input.readme && typeof input.readme === 'object' ? input.readme : null;
  const summary = String(readme?.summary ?? '').trim();
  const packageJson = input.packageJson && typeof input.packageJson === 'object'
    ? input.packageJson
    : null;
  const scripts = asArray(packageJson?.scripts)
    .map((line) => String(line).trim())
    .filter(Boolean);
  const topLevel = asArray(input.topLevel).map((item) => String(item)).filter(Boolean);
  const testFiles = asArray(input.testFiles).map((item) => String(item)).filter(Boolean);
  const entryFiles = asArray(input.entryFiles).map((item) => String(item)).filter(Boolean);
  const sourceCount = Number(input.sourceCount) || 0;
  const todoCount = Number(input.todoCount) || 0;
  const git = input.git && typeof input.git === 'object' ? input.git : null;
  const fallbackRun = ECOSYSTEM_RUN[ecosystem] ?? ECOSYSTEM_RUN.unknown;

  const oneLiner = firstParagraph(summary) || `${name}：${ecosystem} 项目`;
  const whatItIs = summary
    ? summary.slice(0, 1200)
    : `${name} 是一个 ${ecosystem} 项目，暂未提供可读的 README，建议先看入口文件与顶层目录。`;

  // 有 package scripts 就直接给脚本命令，否则按技术栈给通用命令。
  const howToRun = scripts.length ? scripts.slice(0, 6) : fallbackRun.slice(0, 6);

  const modules = topLevel.slice(0, 8).map((item) => ({
    path: item,
    title: item,
    detail: describeTopLevel(item)
  }));

  const commands = (ECOSYSTEM_VERIFY[ecosystem] ?? []).slice(0, 4);
  const criteria = [
    commands.length ? `验证命令通过（退出码 0）：${commands.join(' 或 ')}` : '',
    testFiles.length
      ? `回归范围至少覆盖 ${testFiles[0]}`
      : '补一个最小回归测试，再改动关键逻辑',
    '关键入口能正常加载，主流程没有新增 TODO/FIXME'
  ].filter(Boolean).slice(0, 6);

  const risks = [];
  if (!readme) risks.push('README 缺失');
  else if (!summary) risks.push('README 内容为空');
  if (!testFiles.length) risks.push('没有检测到测试文件');
  if (todoCount > 0) risks.push(`有 ${todoCount} 个 TODO/FIXME`);
  if (!git) risks.push('不是 Git 仓库或读不到提交信息');
  if (sourceCount === 0) risks.push('没有检测到常见源码文件');
  if (ecosystem === 'unknown') risks.push('没能识别技术栈，运行方式需要确认');

  // 证据按“文档 → 清单 → 入口 → 测试 → 顶层条目”排序，前面的信息量最高。
  const evidence = [...new Set([
    readme ? String(readme.path ?? 'README.md') : '',
    packageJson ? 'package.json' : '',
    ...entryFiles,
    ...testFiles.slice(0, 4),
    ...topLevel.slice(0, 4)
  ].filter(Boolean))].slice(0, 12);

  return {
    oneLiner,
    whatItIs,
    howToRun,
    modules,
    verify: { commands, criteria },
    risks,
    evidence,
    generatedAt: new Date().toISOString(),
    basedOnCommit: git ? String(git.head ?? '') : '',
    source: 'local-scan'
  };
}
